// T-U5/T-U6/T-U7/T-U8/T-U1..T-U4：传输层（401 重认证 + 重试一次）、超时分档、v2 逐字 args 键、探测三态。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ok, fail } from '../lib/result.js';
import { createTransport, TIMEOUT_DEFAULT_MS, TIMEOUT_PROMPT_MS } from '../lib/protocol/transport.js';
import { createDetector } from '../lib/protocol/detect.js';
import { createV2 } from '../lib/protocol/v2.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, countUnknown: () => {}, registerSecret: () => {}, fingerprint: () => 'fp' };

/** 起一个真实 HTTP 端点来验 fetch/状态码/信封语义（不联网，只在本机回环）。 */
async function withServer(handler, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      seen.push({ url: req.url, method: req.method, headers: req.headers, body });
      handler(req, res, body, seen);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await fn({ port, base: `http://127.0.0.1:${port}`, seen });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function stubAuth() {
  let cookie = 'cookie-1';
  let refreshes = 0;
  return {
    ensure: async (force) => {
      if (force) { refreshes += 1; cookie = `cookie-${refreshes + 1}`; }
      return ok(cookie);
    },
    get: () => cookie,
    refreshes: () => refreshes,
  };
}

test('正常响应：result.ok=true → ok(value)', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'server-response', result: { ok: true, value: { items: [] } } }));
  }, async ({ base, seen }) => {
    const transport = createTransport({ auth: stubAuth(), dshUrl: base, log: quiet });
    const result = await transport.call('session/list', { _request: {} });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { items: [] });
    // 信封逐字：method 必须等于 URL 里的 endpoint，payload 恰为 {args}
    assert.equal(seen[0].url, '/api/session/list');
    assert.equal(seen[0].body.type, 'client-request');
    assert.equal(seen[0].body.method, 'session/list');
    assert.deepEqual(Object.keys(seen[0].body.payload), ['args']);
    assert.equal(typeof seen[0].body.rpcId, 'string');
  });
});

test('业务错误恒为 HTTP 200 + body 里带 code → reason=rejected 且保留 code', async () => {
  await withServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: { ok: false, error: { code: 'gateway/arguments-invalid', message: 'missing "request"' } } }));
  }, async ({ base }) => {
    const transport = createTransport({ auth: stubAuth(), dshUrl: base, log: quiet });
    const result = await transport.call('session/prompt', { request: {} });
    assert.equal(result.reason, 'rejected');
    assert.equal(result.code, 'gateway/arguments-invalid');
  });
});

test('404 → not-found（真实宿主对未知方法就是 404 纯文本，无 code）', async () => {
  await withServer((req, res) => { res.writeHead(404); res.end('not found'); }, async ({ base }) => {
    const transport = createTransport({ auth: stubAuth(), dshUrl: base, log: quiet });
    const result = await transport.call('session/nope', {});
    assert.equal(result.reason, 'not-found');
  });
});

test('401：强制重认证一次并原样重试（requestId 必须复用，A13）', async () => {
  let calls = 0;
  await withServer((req, res) => {
    calls += 1;
    if (calls === 1) { res.writeHead(401); res.end('unauthorized'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: { ok: true, value: { accepted: true } } }));
  }, async ({ base, seen }) => {
    const auth = stubAuth();
    const transport = createTransport({ auth, dshUrl: base, log: quiet });
    const request = { requestId: 'fixed-request-id', sessionId: 's1', mode: 'queue', content: [] };
    const result = await transport.call('session/prompt', { request }, { timeoutMs: TIMEOUT_PROMPT_MS });
    assert.equal(result.ok, true);
    assert.equal(auth.refreshes(), 1, '必须重取一次 cookie');
    assert.equal(seen.length, 2);
    assert.equal(seen[0].body.payload.args.request.requestId, seen[1].body.payload.args.request.requestId);
    assert.deepEqual(seen[1].headers.cookie, 'cookie-2');
  });
});

test('超时按方法分档：默认 15s，session/prompt 60s（D7）', async () => {
  assert.equal(TIMEOUT_DEFAULT_MS, 15000);
  assert.equal(TIMEOUT_PROMPT_MS, 60000);
  await withServer((req, res) => {
    setTimeout(() => { res.writeHead(200); res.end('{}'); }, 300);
  }, async ({ base }) => {
    const transport = createTransport({ auth: stubAuth(), dshUrl: base, log: quiet });
    const result = await transport.call('session/list', { _request: {} }, { timeoutMs: 80 });
    assert.equal(result.reason, 'timeout');
  });
});

test('探测三态：v2 / v1 / 协议事实不符（arguments-invalid 不回退 v1）', async () => {
  const v2 = createDetector({
    transport: { call: async (endpoint, args) => (endpoint === 'session/list' && '_request' in args ? ok({ items: [] }) : fail('not-found')) },
    log: quiet,
  });
  assert.deepEqual(await v2.detect(), ok('v2'));

  const v1 = createDetector({
    transport: { call: async (endpoint) => (endpoint === 'session.list' ? ok({ items: [] }) : fail('not-found', 'http-404', 'not found')) },
    log: quiet,
  });
  assert.deepEqual(await v1.detect(), ok('v1'));

  const attempted = [];
  const mismatch = createDetector({
    transport: {
      call: async (endpoint) => {
        attempted.push(endpoint);
        return fail('rejected', 'gateway/arguments-invalid', 'args fields do not match the descriptor');
      },
    },
    log: quiet,
  });
  const result = await mismatch.detect();
  assert.equal(result.reason, 'protocol-mismatch');
  assert.deepEqual(attempted, ['session/list'], '绝不回退 v1（回退会让 v2 上的事件通道静默死掉）');
});

test('探测两协议都失败 → protocol-mismatch 且带两次探测原因', async () => {
  const detector = createDetector({ transport: { call: async () => fail('not-found', 'http-404', 'not found') }, log: quiet });
  const result = await detector.detect();
  assert.equal(result.reason, 'protocol-mismatch');
  assert.match(result.message, /v2:/);
  assert.match(result.message, /v1:/);
  assert.equal(detector.current(), null);
});

test('v2 方法映射：args 键逐字，prompt 用 60s 预算（T-U6/T-U8）', async () => {
  const calls = [];
  const transport = { call: async (endpoint, args, options) => { calls.push({ endpoint, args, options }); return ok({}); } };
  const client = createV2({ transport, mux: {}, log: quiet });
  await client.list();
  await client.create({ a: 1 });
  await client.prompt({ requestId: 'r1' });
  await client.page({ throughSeq: 1 });
  await client.postEventResult({ clientId: 'c1', eventId: 'e1', outcome: { kind: 'result', value: 'allowed-once' } });
  assert.deepEqual(calls.map((call) => [call.endpoint, Object.keys(call.args).join(',')]), [
    ['session/list', '_request'],
    ['session/create', 'request'],
    ['session/prompt', 'request'],
    ['session/page', 'request'],
    ['$events/result', 'clientId,eventId,outcome'],
  ]);
  assert.equal(calls[2].options.timeoutMs, TIMEOUT_PROMPT_MS);
  assert.equal(calls[0].options, undefined, '未显式给预算的方法走 transport 的默认档（15s）');
});

test('$events/result 没有 clientId 时本地拒绝，不发出半截请求', async () => {
  const calls = [];
  const client = createV2({ transport: { call: async () => { calls.push(1); return ok({}); } }, mux: {}, log: quiet });
  const result = await client.postEventResult({ clientId: null, eventId: 'e', outcome: { kind: 'result' } });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'no-client-id');
  assert.equal(calls.length, 0);
});

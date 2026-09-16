// T-S4/T-S5：两处"重启相关"的 v1 → v2 回归修复。
//   T-S4：同一个 QQ 来源跨重启复用同一个电脑端会话（不再每次重启新建对话）。
//   T-S5：另一个活实例持锁时，本实例待机（不连 QQ 网关、不连 DSH）—— v1 的 qq-channel.lock 语义。
//
// 清理纪律：所有 mock 服务器/通道都经 once() 包裹并挂到 t.after —— 断言失败时也必须收干净，
// 否则残留的 http server 会让测试进程不退出（整个 runner 挂到超时）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqv2-restart-'));
const STORAGE = path.join(TMP, 'storages');

/**
 * `$DSH_HOME` 隔离。注意：`--test-isolation=none` 下所有测试文件共享同一个进程，
 * 而 integration.test.js 也在模块顶层设置 DSH_HOME —— 两个文件会互相覆盖，所以这里
 * **每个用例内部**设置并在用例结束后恢复（`storageRoot()` 是在建通道时读的，来得及）。
 */
function useOwnHome(t) {
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = TMP;
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
  });
}

const plugin = await import('../lib/index.js');
const { makeFakeCtx } = await import('./helpers/fake-ctx.mjs');
const { startMockDsh } = await import('./helpers/mock-dsh.mjs');
const { startMockQQ } = await import('./helpers/mock-qq.mjs');
const { sessionIdForSource } = await import('../lib/session/source-session.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 幂等化：同一个清理动作在 inline 与 t.after 里各调一次也不会重复执行。 */
function once(fn) {
  let done = false;
  return () => {
    if (done) return undefined;
    done = true;
    return fn();
  };
}

async function waitFor(fn, label, ms = 12000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`timeout (${ms}ms) waiting for ${label}`);
    await sleep(100);
  }
}

function readLog() {
  try {
    return fs.readFileSync(path.join(STORAGE, 'qq-channel.log'), 'utf8');
  } catch {
    return '';
  }
}

function makeConfig(qq, overrides = {}) {
  return {
    enabled: true,
    appId: '1000',
    clientSecret: 'mock-secret',
    token: '',
    tokenUrl: qq.tokenUrl,
    gatewayUrl: qq.gatewayUrl,
    apiBase: qq.apiBase,
    sessionId: 'session-mock-1',
    allowedGroups: [],
    allowedUsers: ['USER-A'],
    groupMembers: [],
    ack: false,
    markdown: false,
    perSourceSessions: true,
    keyboardApprovals: false,
    maxChunk: 2000,
    maxReplyChunks: 4,
    ...overrides,
  };
}

function applyChannel(dsh, qq, overrides = {}) {
  const logs = [];
  const config = makeConfig(qq, overrides);
  const fake = makeFakeCtx({ port: dsh.port, config, logs, token: 'MOCK-LAUNCH-TOKEN' });
  plugin.apply(fake.ctx, config);
  return fake;
}

async function bootChannel(dsh, qq, overrides = {}) {
  const fake = applyChannel(dsh, qq, overrides);
  await waitFor(() => qq.state.identifies.length > 0, 'QQ IDENTIFY', 15000);
  return fake;
}

test('T-S4：同一来源跨重启复用同一会话身份，且复用时不重放历史', async (t) => {
  useOwnHome(t);
  const dsh = await startMockDsh();
  const qq1 = await startMockQQ();
  const qq2 = await startMockQQ();
  const closeDsh = once(() => dsh.close());
  const closeQq1 = once(() => qq1.close());
  const closeQq2 = once(() => qq2.close());
  let disposeFirst = () => {};
  let disposeSecond = () => {};
  t.after(async () => {
    await sleep(80);
    disposeSecond();
    disposeFirst();
    closeQq2();
    closeQq1();
    closeDsh();
  });

  const expected = sessionIdForSource('c2c:USER-A');

  // —— 第一次启动：新建会话 ——
  const first = await bootChannel(dsh, qq1);
  disposeFirst = once(() => first.dispose());
  qq1.c2c('第一次');
  const prompt = await waitFor(() => dsh.state.prompts[0], '第一次 prompt');
  assert.equal(prompt.sessionId, expected, 'QQ 来源必须落到算出来的身份上');
  assert.ok(dsh.state.creates.some((c) => c.requested === expected), 'session/create 必须带上算出来的身份（宿主据此 resume/新建）');
  await waitFor(() => readLog().includes('per-source session resolved'), 'resolved 日志');
  assert.match(readLog(), /via=created/);

  // —— 模拟重启：同一个来源必须复用同一身份 ——
  disposeFirst();
  await sleep(100);
  closeQq1();
  const sessionsAfterFirst = dsh.state.sessions.size;
  const mark = readLog().length;

  const second = await bootChannel(dsh, qq2);
  disposeSecond = once(() => second.dispose());
  qq2.c2c('重启之后');
  const prompts = await waitFor(() => (dsh.state.prompts.length >= 2 ? dsh.state.prompts : null), '第二次 prompt');
  assert.equal(prompts[1].sessionId, expected, '重启后必须还是同一个身份');
  assert.equal(dsh.state.sessions.size, sessionsAfterFirst, '重启后不得新建会话');
  const tail = readLog().slice(mark);
  assert.match(tail, /via=adopted/);
  assert.match(tail, new RegExp(`follow stream attached session=${expected} baseline=skip-history`), '复用已有会话必须跳历史，否则会把历史回复灌进 QQ');
});

test('T-S5：另一个活实例持锁时本实例待机——不连 QQ 网关，也不碰 DSH', async (t) => {
  useOwnHome(t);
  const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  const dsh = await startMockDsh();
  const qq = await startMockQQ();
  const closeDsh = once(() => dsh.close());
  const closeQq = once(() => qq.close());
  const lockFile = path.join(STORAGE, 'qq-channel.lock');
  const dropLock = once(() => fs.rmSync(lockFile, { force: true }));
  let dispose = () => {};
  t.after(async () => {
    await sleep(80);
    dispose();
    try { holder.kill(); } catch { /* 已经退了 */ }
    closeQq();
    closeDsh();
    dropLock();
  });

  fs.mkdirSync(STORAGE, { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: holder.pid, at: Date.now() }));
  const mark = readLog().length;

  const fake = applyChannel(dsh, qq);
  dispose = once(() => fake.dispose());
  await waitFor(() => readLog().slice(mark).includes('channel idle: another dsh instance holds the QQ channel lock'), 'idle 日志');
  assert.equal(qq.state.identifies.length, 0, '持锁时一个 IDENTIFY 都不许发');
  assert.equal(dsh.state.http.length, 0, '持锁时不得和 DSH 建任何连接');
  assert.equal(dsh.state.creates.length, 0, '持锁时不得建会话');
});

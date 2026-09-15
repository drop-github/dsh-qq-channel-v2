// PROVENANCE: copied verbatim from E:\DSHWorkspace\qq-channel-verify\mock-qq.mjs (read-only reference rig)
// at 2026-09-15T20:51:09.105Z; source fingerprint = 158 lines. Do NOT edit the original.
// Any behaviour change belongs in this copy (and must be noted in docs/ROUND-2-REPORT.md).
// Mock QQ bot platform: token endpoint + REST send/interaction/upload + gateway WS.
// Faithful to what the plugin expects (verified against v1.2.4 connectQQ/handleQQDispatch):
//   - POST {tokenUrl}            -> {access_token, expires_in}
//   - WS   {gatewayUrl}          -> {op:10,d:{heartbeat_interval}} then READY after IDENTIFY/RESUME
//   - POST {apiBase}/v2/users/{openid}/messages  | /v2/groups/{gid}/messages
//   - PUT  {apiBase}/interactions/{id}
import http from 'node:http';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';

// A real (decodable) PNG for inbound-attachment scenarios, plus a degenerate 1x1 that the
// live host rejects with session/attachment-invalid (verified against DSH 0.1.5-rc.2).
const GOOD_PNG = fs.existsSync('E:\\DSHWorkspace\\qq-dsh-bridge\\test-ocr.png')
  ? fs.readFileSync('E:\\DSHWorkspace\\qq-dsh-bridge\\test-ocr.png')
  : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

export async function startMockQQ() {
  const state = {
    sent: [],            // outbound messages
    interactions: [],    // interaction ACKs
    identifies: [],      // op2/op6 payloads
    uploads: [],
    partFinishes: [],    // upload_part_finish bodies
    prepares: [],        // upload_prepare bodies
    attachmentFetches: [], // inbound attachment downloads (url + Authorization header)
    tokenCalls: 0,
    sockets: new Set(),
    lastSeq: 100,
  };

  const readBody = async (req) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
  };
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const body = await readBody(req);
    if (url.pathname === '/app/getAppAccessToken') {
      state.tokenCalls += 1;
      if (body.appId === '0' || body.clientSecret === 'bad') { json(res, 401, { error: 'invalid appid or secret' }); return; }
      json(res, 200, { access_token: 'mock-access-token', expires_in: 7200 });
      return;
    }
    if (url.pathname === '/interactions/' + url.pathname.split('/').pop() && req.method === 'PUT') {
      state.interactions.push({ id: url.pathname.split('/').pop(), code: body.code, at: Date.now() });
      json(res, 200, {});
      return;
    }
    let m = url.pathname.match(/^\/v2\/(users|groups)\/([^/]+)\/messages$/);
    if (m && req.method === 'POST') {
      const entry = { target: { kind: m[1], openid: m[2] }, ...body, at: Date.now() };
      state.sent.push(entry);
      json(res, 200, { id: `out-${state.sent.length}`, timestamp: Date.now() });
      return;
    }
    m = url.pathname.match(/^\/v2\/users\/([^/]+)\/upload_prepare$/);
    if (m && req.method === 'POST') {
      state.prepares.push(body);
      const size = Number(body.file_size ?? 0);
      const parts = size > 0 ? [{ index: 1, block_size: size, presigned_url: `http://127.0.0.1:${server.address().port}/put/0` }] : [];
      json(res, 200, { upload_id: 'mock-upload', block_size: size, parts });
      return;
    }
    if (url.pathname.startsWith('/put/') && req.method === 'PUT') { res.writeHead(200); res.end(''); return; }
    // inbound attachment bytes (the plugin downloads these with Authorization: QQBot …)
    if (url.pathname.startsWith('/attach/')) {
      state.attachmentFetches.push({ path: url.pathname, auth: String(req.headers.authorization ?? ''), at: Date.now() });
      const body = url.pathname.endsWith('tiny.png') ? TINY_PNG : GOOD_PNG;
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length });
      res.end(body);
      return;
    }
    m = url.pathname.match(/^\/v2\/users\/([^/]+)\/upload_part_finish$/);
    if (m && req.method === 'POST') { state.partFinishes.push(body); json(res, 200, {}); return; }
    m = url.pathname.match(/^\/v2\/users\/([^/]+)\/files$/);
    if (m && req.method === 'POST') { state.uploads.push(body); json(res, 200, {}); return; }
    json(res, 404, { message: `mock-qq: no route for ${req.method} ${url.pathname}` });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/websocket') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    state.sockets.add(ws);
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 } }));
    ws.on('message', (data) => {
      let msg; try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg.op === 2 || msg.op === 6) {
        state.identifies.push(msg);
        state.lastSeq += 1;
        ws.send(JSON.stringify({
          op: 0, s: state.lastSeq, t: 'READY',
          d: { session_id: 'mock-gw-session', user: { id: 'bot-openid', username: 'MockBot' }, shard: [0, 1] },
        }));
      }
    });
    ws.on('close', () => state.sockets.delete(ws));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  return {
    port,
    state,
    tokenUrl: `http://127.0.0.1:${port}/app/getAppAccessToken`,
    gatewayUrl: `ws://127.0.0.1:${port}/websocket`,
    apiBase: `http://127.0.0.1:${port}`,
    /** push a gateway dispatch (C2C_MESSAGE_CREATE / GROUP_AT_MESSAGE_CREATE / INTERACTION_CREATE) */
    dispatch(t, d) {
      state.lastSeq += 1;
      const frame = JSON.stringify({ op: 0, s: state.lastSeq, t, d });
      for (const ws of state.sockets) ws.send(frame);
    },
    c2c(text, { openid = 'USER-A', id = `MSG-${Math.random().toString(16).slice(2, 8)}`, attachments } = {}) {
      const d = { id, content: text, author: { user_openid: openid }, timestamp: Date.now() };
      if (attachments) d.attachments = attachments;
      this.dispatch('C2C_MESSAGE_CREATE', d);
      return id;
    },
    /** inbound image attachment descriptor pointing at this mock's byte endpoint */
    imageAttachment({ kind = 'tiny', filename = 'photo.png', contentType = 'image/png' } = {}) {
      return { url: `http://127.0.0.1:${port}/attach/${kind}.png`, content_type: contentType, filename };
    },
    click(buttonData, { openid = 'USER-A', id = `INT-${Math.random().toString(16).slice(2, 8)}` } = {}) {
      this.dispatch('INTERACTION_CREATE', {
        id,
        user_openid: openid,
        data: { resolved: { button_data: buttonData, user_id: openid } },
        timestamp: Date.now(),
      });
      return id;
    },
    textsTo(openid = 'USER-A') {
      return state.sent.filter((s) => s.target.openid === openid).map((s) => s.markdown?.content ?? s.content ?? '');
    },
    /** force a gateway disconnect so the plugin has to re-identify/resume */
    dropGateway(code = 4009) {
      let n = 0;
      for (const ws of state.sockets) { try { ws.close(code); n += 1; } catch { /* ignore */ } }
      return n;
    },
    close() {
      for (const ws of state.sockets) { try { ws.close(); } catch { /* ignore */ } }
      wss.close();
      server.close();
    },
  };
}

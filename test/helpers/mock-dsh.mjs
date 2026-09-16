// PROVENANCE: copied verbatim from E:\DSHWorkspace\qq-channel-verify\mock-dsh.mjs (read-only reference rig)
// at 2026-09-15T20:51:09.105Z; source fingerprint = 343 lines. Do NOT edit the original.
// Any behaviour change belongs in this copy (and must be noted in docs/ROUND-2-REPORT.md).
// Mock DSH host (typert gateway + browserAuth + remote.mux streams).
// Mirrors the semantics we verified in the real host source:
//   - /api/<slash-method>, body {type:'client-request',rpcId,method,payload:{args}}
//   - exact argument keys (session/list -> _request, others -> request)
//   - browserAuth: GET /?token=... -> 303 + Set-Cookie, /api without cookie -> 401
//   - session/page: message-aligned backwards window (cut/hasMore) + "past cursor" error
//   - remote.mux: {type:'item'|'end'|'error'} frames, $events ready/cancel/emit/waterfall
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'node:crypto';

const MESSAGE_TYPES = new Set(['user/message', 'assistant/message']);
const COOKIE = 'dsh_mock_auth=ok';

// Faithful port of the host's paginate(): message-aligned window ending at `end`.
function paginate(log, beforeSeq, maxMessages, throughSeq) {
  const end = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1);
  let count = 0;
  let cut = 0;
  for (let index = end - 1; index >= 0; index--) {
    const event = log[index];
    if (!event) continue;
    if (!MESSAGE_TYPES.has(event.type) || event.surfaceOp !== 'append') continue;
    count++;
    const sources = event.sourceEventSeqs;
    let groupStart = event.seq;
    if (sources !== undefined) for (const s of sources) if (s < groupStart) groupStart = s;
    if (count >= maxMessages) { cut = groupStart; break; }
  }
  return { events: log.slice(cut, end), hasMore: cut > 0 };
}

export async function startMockDsh(opts = {}) {
  const {
    protocol = 'v2',           // 'v2' | 'v1' | 'both'  (which probes succeed)
    requireAuth = true,
    unauthorizedTimes = 0,     // first N /api calls answer 401 even with a cookie
    unauthorizedPaths = [],    // e.g. ['session/prompt'] -> first hit on that path answers 401
    promptFailures = 0,        // first N session/prompt calls answer 503 (宿主不可用：测"消息不得丢")
    maxMessagesDefault = 50,
  } = opts;

  const state = {
    events: [],                // session log [{seq,type,data,surfaceOp?}]
    sessions: new Set(['session-mock-1']),
    http: [],                  // every /api call: {path, method, args, cookie}
    prompts: [],               // accepted session/prompt requests
    eventResults: [],          // $events/result payloads
    argViolations: [],         // exact-key violations
    promptSchemaErrors: [],    // prompt field-shape violations (mode/requestId/...)
    promptExtraKeys: [],       // unknown prompt fields the plugin sent (host codec strictness untested)
    imageRejections: 0,        // prompts rejected because the image part was degenerate
    followRequests: [],
    followStreams: [],         // {ws, streamId, sessionId}
    controlStreams: new Map(), // ws -> streamId
    pendingForwarded: new Map(), // eventId -> waterfall frame still awaiting a result
    rejectedUpgrades: [],      // legacy paths we refused (e.g. /api/events.mux)
    unauthorizedCount: 0,
    promptFailuresLeft: promptFailures,   // 注入的 prompt 失败次数（503）
    promptFailuresServed: 0,
    unauthorizedAttempts: [],  // payloads rejected with a forced 401 (for requestId comparison)
    forcedUnauthorized: new Set(),
    openControlFrames: [],
    cookieIssued: 0,
  };
  const listeners = { onControlItem: [] };

  const sendJson = (res, code, obj, extraHeaders = {}) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', ...extraHeaders });
    res.end(body);
  };
  const rpcOk = (res, value) => sendJson(res, 200, { type: 'server-response', rpcId: randomUUID(), result: { ok: true, value } });
  const rpcErr = (res, code, message) => sendJson(res, 200, { type: 'server-response', rpcId: randomUUID(), result: { ok: false, error: { code, message } } });

  function checkExactKeys(args, expected) {
    const keys = Object.keys(args ?? {}).slice().sort().join(',');
    const want = expected.slice().sort().join(',');
    return keys === want;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    // --- browserAuth launch-token exchange ---
    if (url.pathname === '/') {
      const token = url.searchParams.get('token');
      if (!token) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('fence'); return; }
      state.cookieIssued += 1;
      res.writeHead(303, { 'set-cookie': `${COOKIE}; Path=/; HttpOnly`, location: '/' });
      res.end();
      return;
    }
    if (!url.pathname.startsWith('/api/')) { res.writeHead(404); res.end('nope'); return; }

    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { rpcErr(res, 'gateway/bad-request', 'bad json'); return; }
    const cookie = String(req.headers.cookie ?? '');

    if (requireAuth && cookie !== COOKIE) {
      state.unauthorizedCount += 1;
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }
    if (unauthorizedTimes > 0 && state.unauthorizedCount < unauthorizedTimes) {
      state.unauthorizedCount += 1;
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const path = url.pathname.slice('/api/'.length);
    const endpoint = body?.payload?.args ?? {};
    state.http.push({ path, method: body?.method, args: endpoint, cookie: cookie === COOKIE });

    // targeted 401: force a re-auth in the middle of a call (tests requestId stability)
    if (unauthorizedPaths.includes(path) && !state.forcedUnauthorized.has(path)) {
      state.forcedUnauthorized.add(path);
      state.unauthorizedCount += 1;
      state.unauthorizedAttempts.push({ path, args: endpoint });
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const v2 = protocol === 'v2' || protocol === 'both';
    const v1 = protocol === 'v1' || protocol === 'both';

    // --- media type / doc comment: GET is not used by the plugin, POST only ---
    if (path === 'session/list') {
      if (!v2) { rpcErr(res, 'gateway/unknown-method', 'no such method'); return; }
      if (!checkExactKeys(endpoint, ['_request'])) {
        state.argViolations.push({ path, keys: Object.keys(endpoint) });
        rpcErr(res, 'gateway/arguments-invalid', 'session/list expects _request');
        return;
      }
      rpcOk(res, { items: [...state.sessions].map((id) => ({ sessionId: id })) });
      return;
    }
    if (path === 'session.list') {
      if (!v1) { rpcErr(res, 'gateway/unknown-method', 'no such method'); return; }
      rpcOk(res, { items: [...state.sessions].map((id) => ({ sessionId: id })) });
      return;
    }
    if (path === 'session/create') {
      if (!checkExactKeys(endpoint, ['request'])) { state.argViolations.push({ path, keys: Object.keys(endpoint) }); rpcErr(res, 'gateway/arguments-invalid', 'expects request'); return; }
      const id = `session-mock-${state.sessions.size + 1}`;
      state.sessions.add(id);
      rpcOk(res, { sessionId: id });
      return;
    }
    if (path === 'session/rename') { rpcOk(res, {}); return; }
    if (path === 'session/prompt') {
      if (state.promptFailuresLeft > 0) {
        state.promptFailuresLeft -= 1;
        state.promptFailuresServed += 1;
        rpcErr(res, 'gateway/unavailable', 'session/prompt: host temporarily unavailable (injected)');
        return;
      }
      if (!checkExactKeys(endpoint, ['request'])) { state.argViolations.push({ path, keys: Object.keys(endpoint) }); rpcErr(res, 'gateway/arguments-invalid', 'expects request'); return; }
      const r = endpoint.request ?? {};
      // Host type: SessionPromptRequest { requestId, sessionId, mode:'queue'|'steer', content, clientTimeZone? }
      // Verified against the live host: omitting `mode` fails boundary validation
      // ("wire field request failed boundary validation") and the prompt never lands.
      const missing = ['requestId', 'sessionId', 'mode', 'content'].filter((k) => r[k] === undefined);
      if (missing.length > 0) {
        state.promptSchemaErrors.push({ missing });
        rpcErr(res, 'gateway/input-invalid', `session/prompt: wire field "request" failed boundary validation (missing ${missing.join(',')})`);
        return;
      }
      if (r.mode !== 'queue' && r.mode !== 'steer') {
        state.promptSchemaErrors.push({ mode: r.mode });
        rpcErr(res, 'gateway/input-invalid', "session/prompt: mode must be 'queue' or 'steer'");
        return;
      }
      if (!Array.isArray(r.content)) {
        state.promptSchemaErrors.push({ content: typeof r.content });
        rpcErr(res, 'gateway/input-invalid', 'session/prompt: content must be an array of parts');
        return;
      }
      // Mirror the live host's image intake: a decodable PNG/JPEG above a floor size is fine,
      // a degenerate one is rejected with session/attachment-invalid (verified on 0.1.5-rc.2).
      for (const part of r.content) {
        if (part?.type !== 'image') continue;
        let buf = null;
        try { buf = Buffer.from(String(part.data ?? ''), 'base64'); } catch { buf = null; }
        const png = buf && buf.length > 8 && buf.subarray(0, 4).toString('hex') === '89504e47';
        if (!png || buf.length < 1000) {
          state.imageRejections += 1;
          rpcErr(res, 'session/attachment-invalid', 'Unsupported or malformed image data.');
          return;
        }
      }
      const extra = Object.keys(r).filter((k) => !['requestId', 'sessionId', 'mode', 'content', 'clientTimeZone'].includes(k));
      if (extra.length > 0) state.promptExtraKeys.push(extra);
      const dup = state.prompts.find((p) => p.requestId === r.requestId);
      if (dup) { dup.redelivered = (dup.redelivered ?? 0) + 1; rpcOk(res, { accepted: true, deduped: true }); return; }
      state.prompts.push({ ...r, at: Date.now() });
      rpcOk(res, { accepted: true });
      return;
    }
    if (path === 'session/page') {
      if (!checkExactKeys(endpoint, ['request'])) { state.argViolations.push({ path, keys: Object.keys(endpoint) }); rpcErr(res, 'gateway/arguments-invalid', 'expects request'); return; }
      const r = endpoint.request ?? {};
      if (!Number.isSafeInteger(r.throughSeq) || r.throughSeq < -1) { rpcErr(res, 'gateway/bad-request', 'throughSeq must be an integer >= -1'); return; }
      if (r.beforeSeq !== undefined && (!Number.isSafeInteger(r.beforeSeq) || r.beforeSeq < 0)) { rpcErr(res, 'gateway/bad-request', 'beforeSeq must be a non-negative safe integer'); return; }
      if (r.maxMessages !== undefined && (!Number.isSafeInteger(r.maxMessages) || r.maxMessages <= 0)) { rpcErr(res, 'gateway/bad-request', 'maxMessages must be a positive safe integer'); return; }
      const cursor = state.events.length ? state.events[state.events.length - 1].seq : -1;
      if (r.throughSeq > cursor) { rpcErr(res, 'gateway/bad-request', `session page through seq ${r.throughSeq} is past cursor ${cursor}`); return; }
      const page = paginate(state.events, r.beforeSeq, r.maxMessages ?? maxMessagesDefault, r.throughSeq === -1 ? -1 : r.throughSeq);
      rpcOk(res, { records: page.events.map((event) => ({ event })), hasMore: page.hasMore });
      return;
    }
    if (path === '$events/result') {
      if (!checkExactKeys(endpoint, ['clientId', 'eventId', 'outcome'])) { state.argViolations.push({ path, keys: Object.keys(endpoint) }); rpcErr(res, 'gateway/arguments-invalid', 'expects clientId,eventId,outcome'); return; }
      state.eventResults.push({ ...endpoint, at: Date.now() });
      state.pendingForwarded.delete(endpoint.eventId);
      rpcOk(res, { accepted: true });
      return;
    }
    rpcErr(res, 'gateway/unknown-method', `unknown ${path}`);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/api/remote.mux') {
      // the v1 path (/api/events.mux) does not exist on a v2 host
      state.rejectedUpgrades.push(url.pathname);
      socket.destroy();
      return;
    }
    if (requireAuth && String(req.headers.cookie ?? '') !== COOKIE) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (msg?.type !== 'open') return;
      const { streamId, endpoint } = msg;
      state.openControlFrames.push({ endpoint, payload: msg.payload });
      if (endpoint === '$events') {
        state.controlStreams.set(ws, streamId);
        ws.send(JSON.stringify({ type: 'item', streamId, value: { type: 'ready', clientId: 'mock-client', host: { home: '/tmp' } } }));
        // re-deliver everything still unanswered, exactly like the host does for a new client
        for (const frame of state.pendingForwarded.values()) {
          ws.send(JSON.stringify({ type: 'item', streamId, value: frame }));
        }
        return;
      }
      if (endpoint === 'session/follow') {
        const request = msg.payload?.args?.request ?? {};
        const sessionId = request.address?.sessionId ?? 'session-mock-1';
        const cursor = state.events.length ? state.events.at(-1).seq : -1;
        const page = paginate(state.events, undefined, request.maxMessages ?? 50, cursor);
        state.followRequests.push({ streamId, payload: msg.payload });
        state.followStreams.push({ ws, streamId, sessionId });
        // Real host opening frame: snapshot with cursor + recent window + hasMore
        ws.send(JSON.stringify({
          type: 'item',
          streamId,
          value: {
            type: 'snapshot',
            header: { sessionId, origin: 'user' },
            cursor,
            records: page.events.map((event) => ({ event })),
            hasMore: page.hasMore,
            projections: {},
          },
        }));
        return;
      }
      ws.send(JSON.stringify({ type: 'error', streamId, error: { message: `mock: unknown endpoint ${endpoint}` } }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // ---- scenario control surface ----
  const api = {
    port,
    state,
    cowl: COOKIE,
    /** simulate a host rebuild / log truncation: keep the first n events and renumber */
    truncateLog(n = 1) {
      state.events.splice(n);
      state.truncated = (state.truncated ?? 0) + 1;
      return state.events.length;
    },
    /** append a session-log event (auto seq) */
    append(type, data = {}, extra = {}) {
      const seq = state.events.length ? state.events.at(-1).seq + 1 : 0;
      const ev = { seq, type, data, ...extra };
      state.events.push(ev);
      // live follow subscribers get the durable entry (host: SessionEventEntry {type:'event',event})
      for (const s of state.followStreams) {
        if (ev.sessionId && s.sessionId && ev.sessionId !== s.sessionId) continue;
        try { s.ws.send(JSON.stringify({ type: 'item', streamId: s.streamId, value: { type: 'event', event: ev } })); } catch { /* closed */ }
      }
      return ev;
    },
    /** scripted successful turn: user/message + turn/start + assistant/message + turn/end */
    scriptTurn(text, { sessionId = 'session-mock-1', silent = false } = {}) {
      const evs = [];
      evs.push(api.append('user/message', { message: { content: [{ type: 'text', text }] }, sessionId }, { surfaceOp: 'append' }));
      if (!silent) {
        evs.push(api.append('turn/start', { sessionId }));
        evs.push(api.append('assistant/message', { message: { content: [{ type: 'text', text: `echo: ${text}` }] }, sessionId }, { surfaceOp: 'append' }));
        evs.push(api.append('turn/end', { sessionId }));
      }
      return evs;
    },
    /** keep the log noisy so a naive tail window loses the interesting events */
    padMessages(n, sessionId = 'session-mock-1') {
      for (let i = 0; i < n; i++) {
        api.append('user/message', { message: { content: [{ type: 'text', text: `pad-${i}` }] }, sessionId }, { surfaceOp: 'append' });
      }
    },
    /** waterfall approval request on the control stream */
    requestApproval({ eventId = randomUUID(), auditId = randomUUID(), sessionId = 'session-mock-1', toolName = 'pwsh', reason = 'mock approval' } = {}) {
      // host appends the audit event first, then forwards the waterfall
      api.append('approval/asked', { id: auditId, toolName, reason }, { sessionId });
      const frame = { type: 'waterfall', event: 'approval/request', eventId, agentId: sessionId, request: { toolName, reason } };
      // host keeps unanswered forwarded events in pendingRemoteEvents and re-delivers them
      // to every newly opened $events client (dsh-api-gateway/lib/index.js:590-598)
      state.pendingForwarded.set(eventId, frame);
      for (const [ws, streamId] of state.controlStreams) ws.send(JSON.stringify({ type: 'item', streamId, value: frame }));
      return { eventId, auditId };
    },
    /** host-side decision (e.g. answered in the desktop GUI) */
    decideAudit(auditId, outcome = 'allowed-once', sessionId = 'session-mock-1') {
      api.append('approval/decided', { id: auditId, outcome }, { sessionId });
    },
    /** host cancels a pending forwarded event (turn aborted) */
    cancelEvent(eventId) {
      for (const [ws, streamId] of state.controlStreams) ws.send(JSON.stringify({ type: 'item', streamId, value: { type: 'cancel', eventId } }));
    },
    endControlStream() {
      for (const [ws, streamId] of state.controlStreams) ws.send(JSON.stringify({ type: 'end', streamId }));
    },
    close() {
      for (const ws of state.controlStreams.keys()) { try { ws.close(); } catch { /* ignore */ } }
      for (const s of state.followStreams) { try { s.ws.close(); } catch { /* ignore */ } }
      wss.close();
      server.close();
    },
  };
  return api;
}

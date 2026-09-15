// QQ 网关（任务书 §1.2 / P2-13；`thincoder-v2-qq-spec.md §2`）：
// HELLO(op10) → 心跳 0.8×；IDENTIFY(op2)/RESUME(op6)；op0 分发（记录 `s`）；op7/op9；close code 分类重连；快速断连熔断。
import WsClient from 'ws';
import { sleep } from '../util.js';

export const DEFAULT_HEARTBEAT_MS = 41250;
export const HEARTBEAT_FACTOR = 0.8;
export const CONNECT_TIMEOUT_MS = 20000;
export const FAST_DISCONNECT_MS = 5000;
export const FAST_DISCONNECT_LIMIT = 3;
export const FAST_DISCONNECT_PAUSE_MS = 60000;
// 群/C2C 事件 + INTERACTION（键盘按钮）事件。
export const INTENTS = (1 << 25) | (1 << 26);

/** close code 分类表（保留 v1.2.4 的既有实现）。 */
export function classifyClose(code) {
  if (code === 4004) return { clearToken: true, clearSession: true, backoffMs: 5000, note: 'auth failed' };
  if (code === 4008) return { clearToken: false, clearSession: false, backoffMs: 60000, note: 'server requested reconnect' };
  if (code === 4009) return { clearToken: false, clearSession: false, backoffMs: 5000, note: 'resumable' };
  if (code === 4003 || code === 4005) return { clearToken: false, clearSession: true, backoffMs: 1000, note: 'gateway error' };
  if (code === 4006 || code === 4007 || (code >= 4900 && code <= 4913)) {
    return { clearToken: false, clearSession: true, backoffMs: 5000, note: 'resume/identify failed' };
  }
  if ([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915].includes(code)) {
    return { clearToken: false, clearSession: false, backoffMs: 0, fatal: true, note: 'fatal' };
  }
  return { clearToken: false, clearSession: false, backoffMs: 5000, note: 'unclassified' };
}

export function createGateway({ config, log, token, onDispatch, onReady, WebSocketImpl = WsClient }) {
  let disposed = false;
  let fatal = false;
  let socket = null;
  let heartbeatTimer = null;
  let handshakeTimer = null;
  let sessionId = '';
  let lastSeq = null;
  let loopPromise = null;

  const authToken = () => config.token || (token.peek() ? `QQBot ${token.peek()}` : null);

  function identifyPayload() {
    return { op: 2, d: { token: authToken(), intents: INTENTS, shard: [0, 1] } };
  }

  function send(frame) {
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      log?.warn?.('QQ gateway send failed', { error: String(err?.message ?? err) });
      return false;
    }
  }

  function startHeartbeat(interval) {
    const beat = Math.round((Number(interval) || DEFAULT_HEARTBEAT_MS) * HEARTBEAT_FACTOR);
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (socket && socket.readyState === 1) send({ op: 1, d: lastSeq });
    }, beat);
    log?.info?.('QQ gateway ready', { heartbeatMs: beat, factor: HEARTBEAT_FACTOR });
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (err) {
      log?.warn?.('QQ gateway frame not json', { error: String(err?.message ?? err) });
      return;
    }
    if (typeof msg?.s === 'number') lastSeq = msg.s;
    if (msg?.op === 10) {
      startHeartbeat(msg.d?.heartbeat_interval);
      return;
    }
    if (msg?.op === 0 && typeof msg.t === 'string') {
      if (msg.t === 'READY') {
        sessionId = msg.d?.session_id ?? sessionId;
        log?.info?.('QQ READY', { session: sessionId, bot: msg.d?.user?.username ?? '?' });
        onReady?.(msg.d ?? {});
        return;
      }
      try {
        onDispatch?.(msg.t, msg.d);
      } catch (err) {
        log?.error?.('QQ dispatch handler threw (socket kept alive)', { type: msg.t, error: String(err?.stack ?? err) });
      }
      return;
    }
    if (msg?.op === 11) return;                       // 心跳 ACK
    if (msg?.op === 7) {
      log?.info?.('QQ server asked to reconnect');
      try {
        socket?.close();
      } catch (err) {
        log?.debug?.('QQ close after op7 failed', { error: String(err?.message ?? err) });
      }
      return;
    }
    if (msg?.op === 9) {
      log?.warn?.('QQ INVALID_SESSION — re-identifying');
      sessionId = '';
      send(identifyPayload());
      return;
    }
    log?.debug?.('QQ gateway op unhandled', { op: msg?.op });
  }

  /** 一次连接生命周期：resolve 出关闭码与存活时长。 */
  function connectOnce() {
    return new Promise((resolve) => {
      const startAt = Date.now();
      let settled = false;
      let closeCode = 0;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        if (handshakeTimer === connectTimer) handshakeTimer = null;
        clearTimeout(connectTimer);
        // P2-13：心跳必须在"这次连接结束"的收尾路径里清理，否则重连会叠出多条定时器。
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
        resolve({ code: code ?? closeCode, livedMs: Date.now() - startAt });
      };

      let ws;
      try {
        ws = new WebSocketImpl(config.gatewayUrl);
      } catch (err) {
        log?.error?.('QQ gateway ctor failed', { error: String(err?.message ?? err) });
        closeCode = 1006;
        resolve({ code: 1006, livedMs: Date.now() - startAt });
        return;
      }
      socket = ws;
      // 握手超时只看**这次**的 socket：绝不能用共享的 `socket` 变量去 terminate，
      // 否则上一条连接的陈旧定时器会把刚建好的新连接杀掉（曾导致重连风暴）。
      const connectTimer = setTimeout(() => {
        if (settled) return;
        log?.warn?.('QQ gateway handshake timed out', { timeoutMs: CONNECT_TIMEOUT_MS });
        closeCode = 1006;
        try {
          ws.terminate();
        } catch (err) {
          log?.debug?.('QQ terminate failed', { error: String(err?.message ?? err) });
        }
        finish(1006);
      }, CONNECT_TIMEOUT_MS);
      handshakeTimer = connectTimer;

      // onopen 与 onclose **同一处**同步挂载（P2-13：晚挂 onclose 会漏掉"连上即断"的竞态）。
      ws.on('open', () => {
        // 握手成功即撤销超时守卫：健康连接不能被自己的定时器掐断。
        clearTimeout(connectTimer);
        if (handshakeTimer === connectTimer) handshakeTimer = null;
        log?.info?.('QQ gateway connected');
        if (!authToken()) log?.error?.('QQ gateway has no credential (token empty) — sending IDENTIFY anyway');
        send(sessionId ? { op: 6, d: { token: authToken(), session_id: sessionId, seq: lastSeq ?? 0 } } : identifyPayload());
      });
      ws.on('message', (data) => handleMessage(data));
      ws.on('error', (err) => {
        log?.warn?.('QQ gateway socket error', { error: String(err?.message ?? err) });
        closeCode = 1006;
      });
      ws.on('close', (code, reason) => {
        if (socket === ws) socket = null;
        log?.warn?.('QQ gateway closed', { code, reason: String(reason ?? '').slice(0, 60) });
        finish(code ?? 1006);
      });
    });
  }

  async function run() {
    let fastFailures = 0;
    while (!disposed && !fatal) {
      const ensured = await token.ensure();
      if (!ensured.ok) {
        log?.error?.('QQ gateway cannot start without access token', { error: `${ensured.reason}/${ensured.code}` });
        await sleep(5000);
        continue;
      }
      const { code, livedMs } = await connectOnce();
      if (disposed) return;
      const rule = classifyClose(code);
      log?.info?.('QQ gateway close classified', { code, note: rule.note, backoffMs: rule.backoffMs, livedMs });
      if (rule.fatal) {
        fatal = true;
        log?.error?.('QQ close code fatal — stopping gateway (restart dsh web to retry)', { code });
        return;
      }
      if (rule.clearToken) token.invalidate();
      if (rule.clearSession) sessionId = '';
      if (livedMs < FAST_DISCONNECT_MS) {
        fastFailures += 1;
        if (fastFailures >= FAST_DISCONNECT_LIMIT) {
          log?.warn?.('QQ fast-disconnect circuit breaker — pausing', { pauseMs: FAST_DISCONNECT_PAUSE_MS });
          await sleep(FAST_DISCONNECT_PAUSE_MS);
          fastFailures = 0;
          continue;
        }
      } else {
        fastFailures = 0;
      }
      await sleep(rule.backoffMs);
    }
  }

  function stop() {
    disposed = true;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    clearTimeout(handshakeTimer);
    handshakeTimer = null;
    const ws = socket;
    socket = null;
    if (ws) {
      try {
        ws.removeAllListeners?.();
        ws.close();
      } catch (err) {
        log?.debug?.('QQ gateway close failed', { error: String(err?.message ?? err) });
      }
    }
  }

  return {
    start() {
      if (loopPromise) return loopPromise;
      loopPromise = run().catch((err) => {
        log?.error?.('QQ gateway loop crashed', { error: String(err?.stack ?? err) });
      });
      return loopPromise;
    },
    session: () => sessionId,
    seq: () => lastSeq,
    stop,
    dispose: stop,
  };
}

// `remote.mux` 流载体客户端（PROTOCOL.md §3）：一条 socket 上开多条逻辑流，按 streamId 路由帧。
// 服务端没有断线续传（socket 一关，其上所有流被 abort）→ 重连必须由上层重新 open。
import { randomUUID } from 'node:crypto';
import WsClient from 'ws';
import { ok, fail } from '../result.js';

export const MUX_OPEN_TIMEOUT_MS = 10000;

export function createMux({ dshUrl, auth, log }) {
  const streams = new Map();       // streamId -> { onFrame, onEnd, onError }
  const downHandlers = [];
  let socket = null;
  let connecting = null;
  let disposed = false;

  const wsUrl = () => `${dshUrl.replace(/^http/, 'ws')}/api/remote.mux`;

  function route(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch (err) {
      log?.debug?.('mux frame not json', { error: String(err?.message ?? err) });
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const stream = msg.streamId ? streams.get(msg.streamId) : undefined;
    if (msg.type === 'item') {
      stream?.onFrame?.(msg.value);
    } else if (msg.type === 'end') {
      if (stream) {
        streams.delete(msg.streamId);
        stream.onEnd?.();
      }
    } else if (msg.type === 'error') {
      stream?.onError?.(msg.error);
    } else {
      log?.debug?.('mux frame unknown type', { type: String(msg.type) });
    }
  }

  function notifyDown(code) {
    for (const handler of downHandlers) {
      try {
        handler(code);
      } catch (err) {
        log?.error?.('mux down handler threw', { error: String(err?.stack ?? err) });
      }
    }
  }

  function connect() {
    if (disposed) return Promise.resolve(fail('disposed', 'mux-disposed', 'mux disposed'));
    if (socket && socket.readyState === 1) return Promise.resolve(ok(socket));
    if (connecting) return connecting;
    connecting = (async () => {
      const ensured = await auth.ensure();
      if (!ensured.ok) return ensured;
      return await new Promise((resolve) => {
        let ws;
        try {
          ws = new WsClient(wsUrl(), { headers: { cookie: auth.get() } });
        } catch (err) {
          resolve(fail('transport', 'ws-ctor-failed', String(err?.message ?? err)));
          return;
        }
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          try {
            ws.terminate();
          } catch (err) {
            log?.debug?.('mux terminate failed', { error: String(err?.message ?? err) });
          }
          finish(fail('timeout', 'ws-open-timeout', 'mux open timed out'));
        }, MUX_OPEN_TIMEOUT_MS);
        ws.on('open', () => {
          socket = ws;
          finish(ok(ws));
        });
        ws.on('message', (data) => route(data));
        ws.on('error', (err) => {
          log?.debug?.('mux socket error', { error: String(err?.message ?? err) });
          finish(fail('transport', 'ws-error', String(err?.message ?? err)));
        });
        ws.on('close', (code) => {
          if (socket === ws) socket = null;
          finish(fail('transport', 'ws-closed', `mux socket closed (${code})`));
          if (!disposed) notifyDown(code);
        });
      });
    })().finally(() => {
      connecting = null;
    });
    return connecting;
  }

  /** 打开一条逻辑流；`args` 必须是该方法 args 的**逐字**键集。 */
  async function open(endpoint, args, handlers = {}) {
    const connected = await connect();
    if (!connected.ok) return connected;
    const streamId = randomUUID();
    streams.set(streamId, handlers);
    try {
      connected.value.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }));
    } catch (err) {
      streams.delete(streamId);
      return fail('transport', 'ws-send-failed', String(err?.message ?? err));
    }
    return ok({
      streamId,
      cancel() {
        const stream = streams.get(streamId);
        streams.delete(streamId);
        if (!stream) return;
        remoteSend({ type: 'cancel', streamId });
      },
    });
  }

  function remoteSend(frame) {
    if (!socket || socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      log?.warn?.('mux send failed', { error: String(err?.message ?? err) });
      return false;
    }
  }

  /** 强制断开当前 socket（用于服务端 `end` 帧后重建整条 mux）。 */
  function dropSocket() {
    if (!socket) return;
    try {
      socket.close();
    } catch (err) {
      log?.debug?.('mux close failed', { error: String(err?.message ?? err) });
    }
  }

  return {
    open,
    dropSocket,
    onDown(handler) {
      downHandlers.push(handler);
    },
    isOpen: () => socket !== null && socket.readyState === 1,
    dispose() {
      disposed = true;
      streams.clear();
      downHandlers.length = 0;
      const ws = socket;
      socket = null;
      if (ws) {
        try {
          ws.removeAllListeners?.();
          ws.close();
        } catch (err) {
          log?.debug?.('mux dispose close failed', { error: String(err?.message ?? err) });
        }
      }
    },
  };
}

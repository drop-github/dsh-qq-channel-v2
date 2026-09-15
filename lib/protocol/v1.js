// v1（DSH ≤0.1.1）映射：`/api/session.list` 这类裸方法名 + `/api/respond` + `/api/events.mux`。
// 事实来自 v1.2.4 调用点反推（PROTOCOL.md §10.3 标"未对旧宿主核证"）——本文件只做映射，不做猜测性字段。
import WsClient from 'ws';
import { ok, fail } from '../result.js';
import { TIMEOUT_PROMPT_MS, TIMEOUT_DEFAULT_MS } from './transport.js';

const RECONNECT_MS = 5000;

export function createV1({ transport, auth, dshUrl, log }) {
  let eventSocket = null;
  let disposed = false;

  /** v1 方法名 = 带点的旧名；payload 就是参数本身（无 `{args}` 信封）。 */
  const endpoint = {
    list: 'session.list',
    create: 'session.create',
    prompt: 'session.prompt',
    page: 'session.page',
  };

  return {
    protocol: 'v1',

    list: () => transport.call(endpoint.list, {}, { timeoutMs: TIMEOUT_DEFAULT_MS }),
    create: (request) => transport.call(endpoint.create, request, { timeoutMs: TIMEOUT_DEFAULT_MS }),
    prompt: (request) => transport.call(endpoint.prompt, request, { timeoutMs: TIMEOUT_PROMPT_MS }),
    page: (request) => transport.call(endpoint.page, request, { timeoutMs: TIMEOUT_DEFAULT_MS }),

    /** 旧协议的应答走 `/api/respond` 的 `client-response` 信封（P2-8：必须带 cookie，这里统一由 transport 带）。 */
    respond: ({ rpcId, value }) =>
      transport.raw('respond', { type: 'client-response', rpcId, result: { ok: true, value } }, { timeoutMs: TIMEOUT_DEFAULT_MS }),

    /** v1 事件总线：一条 WS 推所有会话的 `session/event` + 审批/提问（旧协议里它们同流）。 */
    async openEventStream(handlers = {}) {
      if (disposed) return fail('disposed', 'v1-disposed', 'v1 event stream disposed');
      const ensured = await auth.ensure();
      if (!ensured.ok) return ensured;
      const url = `${dshUrl.replace(/^http/, 'ws')}/api/events.mux`;
      return await new Promise((resolve) => {
        let ws;
        try {
          ws = new WsClient(url, { headers: { cookie: auth.get() } });
        } catch (err) {
          resolve(fail('transport', 'ws-ctor-failed', String(err?.message ?? err)));
          return;
        }
        let settled = false;
        ws.on('open', () => {
          settled = true;
          eventSocket = ws;
          log?.info?.('v1 event stream connected', { url: 'events.mux' });
          resolve(ok({ close: () => ws.close() }));
        });
        ws.on('message', (data) => {
          let frame;
          try {
            frame = JSON.parse(String(data));
          } catch (err) {
            log?.debug?.('v1 frame not json', { error: String(err?.message ?? err) });
            return;
          }
          handlers.onFrame?.(frame);
        });
        ws.on('error', (err) => {
          log?.debug?.('v1 event stream error', { error: String(err?.message ?? err) });
          if (!settled) {
            settled = true;
            resolve(fail('transport', 'ws-error', String(err?.message ?? err)));
          }
        });
        ws.on('close', (code) => {
          if (eventSocket === ws) eventSocket = null;
          log?.warn?.('v1 event stream closed', { code });
          if (!settled) {
            settled = true;
            resolve(fail('transport', 'ws-closed', `events.mux closed (${code})`));
            return;
          }
          handlers.onDown?.(code, RECONNECT_MS);
        });
      });
    },

    dispose() {
      disposed = true;
      const ws = eventSocket;
      eventSocket = null;
      if (ws) {
        try {
          ws.close();
        } catch (err) {
          log?.debug?.('v1 ws close failed', { error: String(err?.message ?? err) });
        }
      }
    },
  };
}

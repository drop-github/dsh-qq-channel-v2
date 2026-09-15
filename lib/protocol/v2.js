// v2（typert）方法映射（PROTOCOL.md §1.4 / §4 / §5）：args 键逐字、`$events` 控制流、`$events/result`。
import { TIMEOUT_PROMPT_MS } from './transport.js';

export function createV2({ transport, mux, log }) {
  return {
    protocol: 'v2',

    list: () => transport.call('session/list', { _request: {} }),
    create: (request) => transport.call('session/create', { request }),
    rename: (request) => transport.call('session/rename', { request }),

    // D10：`mode` 是宿主必填枚举（'queue' | 'steer'）；调用点铸造 requestId 并复用（D6/幂等）。
    prompt: (request) => transport.call('session/prompt', { request }, { timeoutMs: TIMEOUT_PROMPT_MS }),
    page: (request) => transport.call('session/page', { request }),

    /** 控制流 `$events`：审批/提问的 waterfall + cancel（PROTOCOL.md §4）。 */
    openControl: (handlers) => mux.open('$events', {}, handlers),

    /** 每受管会话一条 `session/follow`（审计事件只能从这里取，D4）。 */
    attachSession: (request, handlers) => mux.open('session/follow', { request }, handlers),

    /**
     * 回传结果。`outcome` 三种 kind：`{kind:'next'}` | `{kind:'result', value}` | `{kind:'rejected', error}`。
     * 🔴 对未知 eventId 宿主会**静默 no-op 且仍回 ok**（§4）→ 返回值只作日志，结清一律以本地状态 + 审计事件为准。
     */
    postEventResult: ({ clientId, eventId, outcome }) => {
      if (!clientId) return Promise.resolve({ ok: false, reason: 'unavailable', code: 'no-client-id', message: 'control stream has no clientId yet' });
      return transport.call('$events/result', { clientId, eventId, outcome });
    },
  };
}

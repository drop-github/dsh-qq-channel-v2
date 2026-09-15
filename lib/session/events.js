// 事件泵（DESIGN.md §2.4.3/§2.4.4）：`session/follow` 主源 + `session/page` 缺口补齐。
// 只做归一化与放行，不做过滤（过滤在 `state.ingest` 的白名单闸门里）。
import { ok, fail, describe } from '../result.js';

export const DEFAULT_MAX_MESSAGES = 50;
const MAX_FILL_ROUNDS = 8;

/** 归一化：无论来自 snapshot / page / live，或来自 v1 的 events.mux，都落到同一形态（§2.3.2）。 */
export function normalizeEvent(sessionId, raw, origin, protocol = 'v2') {
  const event = raw?.event ?? raw;
  if (!event || typeof event !== 'object') return null;
  if (typeof event.seq !== 'number' || typeof event.type !== 'string') return null;
  return {
    sessionId,                                  // 一律由"这条流属于哪个会话"注入，不读事件体里的 sessionId
    seq: event.seq,
    time: event.time,
    type: event.type,
    data: event.data ?? {},
    origin,
    protocol,
  };
}

export function createEventPump({ client, state, onAction, log, maxMessages = DEFAULT_MAX_MESSAGES }) {
  const streams = new Map();      // sessionId -> { streamId, cancel }
  const baselined = new Set();    // 已按基线规则处理过首个 snapshot 的会话
  const attachedBaselines = new Map();   // sessionId -> baseline（重连后原样重建）
  const downHandlers = [];
  let disposed = false;

  function notifyDown(reason) {
    for (const handler of downHandlers) {
      try {
        handler(reason);
      } catch (err) {
        log?.error?.('pump down handler threw', { error: String(err?.stack ?? err) });
      }
    }
  }

  /** 放行一条事件：seq 幂等 + 白名单都在 state.ingest 里；这里只把 action 交给上层。 */
  function deliver(event) {
    const result = state.ingest(event);
    if (!result.ok) {
      log?.warn?.('ingest rejected event', { error: describe(result), type: event.type });
      return result;
    }
    if (result.value.kind === 'ignored' || result.value.kind === 'duplicate') return result;
    try {
      onAction?.(result.value, event);
    } catch (err) {
      log?.error?.('action handler threw (stream kept alive)', { error: String(err?.stack ?? err), type: event.type });
    }
    return result;
  }

  function sortBySeq(events) {
    return events.slice().sort((a, b) => a.seq - b.seq);
  }

  /** 缺口补齐（§2.4.4）：先补页放进来的旧事件，再按序放行 snapshot 窗口。 */
  async function fillGap(sessionId, cursor, beforeSeq, lastSeq) {
    const address = { kind: 'session', sessionId };
    const collected = [];
    let before = beforeSeq;
    let covered = false;
    for (let round = 0; round < MAX_FILL_ROUNDS; round += 1) {
      const request = { address, throughSeq: cursor, maxMessages };
      if (before !== undefined) request.beforeSeq = before;
      const page = await client.page(request);
      if (!page.ok) {
        log?.warn?.('gap fill page failed', { session: sessionId, error: describe(page) });
        break;
      }
      const events = (page.value?.records ?? [])
        .map((record) => normalizeEvent(sessionId, record, 'page', client.protocol))
        .filter(Boolean);
      if (events.length === 0) {
        covered = true;
        break;
      }
      collected.unshift(...events);
      const minSeq = Math.min(...events.map((event) => event.seq));
      if (minSeq <= lastSeq + 1) {
        covered = true;
        break;
      }
      if (page.value?.hasMore !== true) {
        covered = true;
        break;
      }
      before = minSeq;
    }
    for (const event of sortBySeq(collected)) deliver(event);
    if (!covered) {
      // §2.4.4 第 5 条：没覆盖完必须留痕，不得静默推进。
      log?.error?.('event gap not fully covered by page fill', { session: sessionId, lastSeq });
    }
    return covered;
  }

  async function reconcile(sessionId, snapshot) {
    const cursor = Number.isFinite(snapshot?.cursor) ? snapshot.cursor : -1;
    const records = (snapshot?.records ?? [])
      .map((record) => normalizeEvent(sessionId, record, 'snapshot', client.protocol))
      .filter(Boolean);
    const first = !baselined.has(sessionId);
    if (first) baselined.add(sessionId);
    const baseline = state.baselineOf(sessionId) ?? 'skip-history';
    const lastSeq = state.lastSeq(sessionId);

    if (cursor === -1) {
      // 真正的空日志：不补页、不报错，基线保持（§2.4.4 第 1 条）。
      log?.debug?.('follow snapshot on empty log', { session: sessionId });
      return ok({ cursor, delivered: 0 });
    }
    if (cursor < lastSeq) {
      // 宿主重建 / 日志截断：重置基线并全量对账，不能假装无事发生。
      log?.warn?.('follow cursor went backwards — resetting baseline', { session: sessionId, cursor, lastSeq });
      state.syncBaseline(sessionId, -1);
    }
    if (first && baseline === 'skip-history' && lastSeq <= -1) {
      // 历史不重放（A12）：基线与首个 snapshot.cursor 对齐，窗口内记录视为历史。
      // 条件是"还没有建立过任何位置"（lastSeq <= -1）：一旦有位置，即便这是本 pump 的首帧，
      // 也说明是重连/宿主重建，必须按缺口补齐继续投递（A24）。
      state.syncBaseline(sessionId, cursor);
      log?.info?.('follow baseline aligned to cursor (history skipped)', { session: sessionId, cursor });
      return ok({ cursor, delivered: 0, skipped: records.length });
    }

    const current = state.lastSeq(sessionId);
    const earliest = records.length > 0 ? Math.min(...records.map((event) => event.seq)) : undefined;
    if (earliest !== undefined && earliest > current + 1) {
      await fillGap(sessionId, cursor, earliest, current);
    }
    let delivered = 0;
    for (const event of sortBySeq(records)) {
      if (event.seq <= state.lastSeq(sessionId)) continue;
      deliver(event);
      delivered += 1;
    }
    return ok({ cursor, delivered });
  }

  function handleFrame(sessionId, value) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'snapshot') {
      reconcile(sessionId, value).catch((err) => log?.error?.('reconcile failed', { error: String(err?.stack ?? err) }));
      return;
    }
    if (value.type === 'event') {
      const event = normalizeEvent(sessionId, value, 'live', client.protocol);
      if (event) deliver(event);
      return;
    }
    if (value.type === 'assistant-stream') {
      log?.debug?.('assistant-stream frame ignored', { session: sessionId });
      return;
    }
    log?.debug?.('follow frame unknown type', { session: sessionId, type: String(value.type) });
  }

  async function attach(sessionId, baseline = 'skip-history') {
    if (disposed) return fail('disposed', 'pump-disposed', 'event pump disposed');
    // 只在首次纳入管理时定基线（D3）：重连不得重置 lastSeq，否则会重放历史。
    if (!state.isAdopted(sessionId)) state.adopt(sessionId, baseline);
    const request = { address: { kind: 'session', sessionId }, maxMessages };
    const opened = await client.attachSession(request, {
      onFrame: (value) => handleFrame(sessionId, value),
      onEnd: () => {
        streams.delete(sessionId);
        log?.warn?.('follow stream ended by server', { session: sessionId });
        notifyDown('follow-end');
      },
      onError: (error) => {
        log?.error?.('follow stream error frame', { session: sessionId, code: error?.code, detail: String(error?.message ?? '').slice(0, 120) });
      },
    });
    if (!opened.ok) {
      log?.warn?.('follow stream open failed', { session: sessionId, error: describe(opened) });
      return opened;
    }
    streams.set(sessionId, { streamId: opened.value.streamId, cancel: () => opened.value.cancel() });
    attachedBaselines.set(sessionId, baseline);
    log?.info?.('follow stream attached', { session: sessionId, baseline });
    return ok(opened.value.streamId);
  }

  function detach(sessionId) {
    const stream = streams.get(sessionId);
    if (!stream) return fail('not-found', 'no-follow-stream', `no follow stream for ${sessionId}`);
    streams.delete(sessionId);
    stream.cancel();
    return ok(true);
  }

  return {
    attach,
    detach,
    reconcile,
    /** 归一化入口：v1 的 events.mux 帧也走这里（§2.3.2）。 */
    normalizeEvent,
    /** 外部载体（v1 的 events.mux）直接推事件进来。 */
    push(sessionId, rawEvent, origin = 'live', protocol = 'v1') {
      const event = normalizeEvent(sessionId, rawEvent, origin, protocol);
      if (!event) return fail('rejected', 'bad-event', 'event could not be normalized');
      return deliver(event);
    },
    /** socket 断了：本地流登记全部作废（重连后由 reattachAll 重建）。 */
    markDown() {
      streams.clear();
    },
    /** 重连后重建所有已纳入管理的会话流（基线不变，lastSeq 不重置）。 */
    async reattachAll() {
      const results = [];
      for (const [sessionId, baseline] of attachedBaselines) {
        results.push(await attach(sessionId, baseline));
      }
      return results;
    },
    attached: () => [...streams.keys()],
    onDown(handler) {
      downHandlers.push(handler);
    },
    dispose() {
      disposed = true;
      for (const stream of streams.values()) {
        try {
          stream.cancel();
        } catch (err) {
          log?.debug?.('follow cancel failed', { error: String(err?.message ?? err) });
        }
      }
      streams.clear();
      downHandlers.length = 0;
    },
  };
}

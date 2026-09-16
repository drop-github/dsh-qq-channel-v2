// 会话状态机（DESIGN.md §2.4.1 / §2.4.5 / §2.4.6）：白名单闸门 + seq 幂等 + 轮次状态 + 回复目标 + 待发队列 + 空闲淘汰。
// 唯一写入者：这里的 `ingest()`。其它模块只读 `snapshot()` / `lastSeq()`。
import { ok, fail } from '../result.js';

/** 白名单 = 全部处理面（D18）。其余一律静默 + debug 计数，**不得**报错或中断流。 */
export const EVENT_WHITELIST = Object.freeze(['turn/start', 'assistant/message', 'turn/end', 'approval/asked', 'approval/decided']);

const WHITELIST = new Set(EVENT_WHITELIST);
export const DEFAULT_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_QUEUE_CAP = 20;
/**
 * 忙状态的最长存活时间。超过它还能收到新消息，就说明那一轮**不可能再结束**了
 * （典型成因：提问/审批帧被丢弃 → 宿主一直等回答 → `turn/end` 永不到来），
 * 必须自救放行新消息，否则后续消息只会一直堆在 `inboundQueue` 里（用户侧表现为"它不回我"）。
 */
export const DEFAULT_BUSY_STALE_MS = 20 * 60 * 1000;

export function createSessionStore({
  log,
  ttlMs = DEFAULT_TTL_MS,
  queueCap = DEFAULT_QUEUE_CAP,
  busyStaleMs = DEFAULT_BUSY_STALE_MS,
}) {
  const sessions = new Map();
  /**
   * 管理权登记（sessionId → { baseline, lastSeq }）—— 与"状态条目"**分开**，空闲淘汰不动它。
   * 事故（真机 2026-09-16 06:24/06:37/06:56）：条目被 TTL 删掉后 `isAdopted()` 变假，
   * 但 follow 流还挂着、`attach()` 不会重跑，于是**再也没有人重新 adopt** →
   * `isManaged()` 对该会话永远为假 → 审批/提问帧被判 unmanaged 静默丢弃 → 用户看不到提问、
   * 该轮一直 busy、后续消息只进队列不冲刷 = 永久沉默。管理权必须比条目活得久。
   */
  const managed = new Map();

  function record(sessionId) {
    let entry = sessions.get(sessionId);
    if (!entry) {
      entry = {
        sessionId,
        baseline: null,
        adopted: false,
        lastSeq: -1,
        busy: false,
        buffer: [],
        targetQueue: [],
        claimed: null,
        replyTarget: null,
        inboundQueue: [],
        droppedInbound: 0,
        busySince: null,
        adoptedAt: Date.now(),
        touchedAt: Date.now(),
      };
      sessions.set(sessionId, entry);
    }
    return entry;
  }

  /** 管理权登记（永不随条目淘汰）。`lastSeq` 也留一份：条目重建后位置必须沿用，否则会重放历史。 */
  function remember(sessionId, patch) {
    const previous = managed.get(sessionId) ?? { baseline: null, lastSeq: -1 };
    const next = { ...previous, ...patch };
    managed.set(sessionId, next);
    return next;
  }

  function adopt(sessionId, baseline = 'skip-history') {
    if (!sessionId) return fail('no-session', 'no-session-id', 'adopt without sessionId');
    const entry = record(sessionId);
    const known = remember(sessionId, { baseline });
    entry.baseline = baseline;
    entry.adopted = true;
    // `replay-all` 只对"从未建立过位置"的新会话成立。淘汰后重新纳入管理（或 v1 路径先收事件后 adopt）
    // 必须沿用既有位置：否则重连补页会把历史重放一遍，用户收到重复回复。
    const keepSeq = known.lastSeq > -1 ? known.lastSeq : entry.lastSeq;
    entry.lastSeq = baseline === 'replay-all' && keepSeq <= -1 ? -1 : keepSeq;
    entry.adoptedAt = Date.now();
    log?.info?.('session adopted', { session: sessionId, baseline });
    return ok({ sessionId, baseline });
  }

  /**
   * 空闲淘汰后按需重建条目（管理权仍在 `managed` 里）：控制帧到达时调用，保证回复目标可查。
   * 返回 `value.rehydrated` 标识是否真的重建。
   */
  function rehydrate(sessionId) {
    if (!sessionId || !managed.has(sessionId)) {
      return fail('not-managed', 'not-managed', 'session was never adopted');
    }
    if (sessions.has(sessionId)) return ok({ rehydrated: false });
    const known = managed.get(sessionId);
    const entry = record(sessionId);
    entry.adopted = true;
    entry.baseline = known.baseline ?? entry.baseline;
    entry.lastSeq = known.lastSeq;         // 位置沿用，避免重连补页重放历史
    entry.adoptedAt = Date.now();
    log?.warn?.('session state rebuilt after idle eviction (management retained)', {
      session: sessionId,
      lastSeq: entry.lastSeq,
    });
    return ok({ rehydrated: true });
  }

  /** 与首个 `snapshot.cursor` 对齐（D3：基线时刻 = 纳入管理那一刻，不是"首次拉取成功时"）。 */
  function syncBaseline(sessionId, seq) {
    const entry = record(sessionId);
    entry.lastSeq = Number.isFinite(seq) ? seq : -1;
    entry.touchedAt = Date.now();
    remember(sessionId, { lastSeq: entry.lastSeq });
    return ok(entry.lastSeq);
  }

  function takeReply(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry) return null;
    const text = entry.buffer.join('').trim();
    const target = entry.claimed ?? entry.replyTarget;
    entry.buffer = [];
    entry.claimed = null;
    if (!text) return null;
    return { text, target };
  }

  /** 忙太久 = 那轮已经不可能结束（提问帧被丢过等）→ 摘掉忙标志，让新消息照常走 prompt，不再无限排队。 */
  function clearStaleBusy(sessionId, now = Date.now()) {
    const entry = sessions.get(sessionId);
    if (!entry || !entry.busy) return false;
    const since = entry.busySince ?? entry.touchedAt;
    if (now - since < busyStaleMs) return false;
    entry.busy = false;
    entry.busySince = null;
    log?.warn?.('stale busy cleared — previous turn never ended; queued inbound no longer waits for it', {
      session: sessionId,
      busyMs: now - since,
    });
    return true;
  }

  /** 收到用户消息时记录回复目标（不依赖后续事件，P1-2）；忙时进待发队列（连内容块一起排队，供合并提问）。 */
  function noteInbound(sessionId, { target, parts }, now = Date.now()) {
    const entry = record(sessionId);
    entry.replyTarget = target ?? entry.replyTarget;
    entry.touchedAt = now;
    clearStaleBusy(sessionId, now);
    if (!entry.busy) {
      entry.targetQueue.push(target);
      return ok({ queued: false });
    }
    entry.inboundQueue.push({ target, parts, at: Date.now() });
    let dropped = 0;
    while (entry.inboundQueue.length > queueCap) {
      entry.inboundQueue.shift();
      dropped += 1;
    }
    if (dropped > 0) {
      entry.droppedInbound += dropped;
      log?.warn?.('inbound queue overflow — oldest dropped', { session: sessionId, dropped });
    }
    return ok({ queued: true, dropped });
  }

  /** prompt 失败时把刚压入的回复目标撤回，避免后续轮次认领到一个"没被受理"的入站（P1-2/P2-15）。 */
  function dropLastTarget(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry || entry.targetQueue.length === 0) return false;
    entry.targetQueue.pop();
    return true;
  }

  function drainInbound(sessionId) {
    const entry = sessions.get(sessionId);
    if (!entry || entry.inboundQueue.length === 0) return null;
    return entry.inboundQueue.splice(0);
  }

  /**
   * 事件入口：seq 幂等 → 白名单闸门 → 状态机。
   * 返回 action（`kind`），由调用方决定副作用（回复、审计配对、审批渲染）。
   */
  function ingest(event) {
    if (!event || typeof event.seq !== 'number' || typeof event.type !== 'string') {
      return fail('rejected', 'bad-event', 'event needs numeric seq and string type');
    }
    const sessionId = event.sessionId;
    const entry = record(sessionId);
    if (event.seq === entry.lastSeq) return ok({ kind: 'duplicate', sessionId, seq: event.seq });
    if (event.seq < entry.lastSeq) {
      // 宿主重建 / 日志被截断：`seq` 倒退说明对面换了一份日志。
      // （真实宿主对 seq 跳跃会直接抛错断流，我们重开 follow 时走 `cursor < lastSeq` 分支；
      //   这条是同一场景在"流没断"时的兜底，A24。）
      log?.warn?.('event seq went backwards — host log rebuilt, resetting session baseline', {
        session: sessionId,
        seq: event.seq,
        lastSeq: entry.lastSeq,
      });
      entry.lastSeq = -1;
      entry.busy = false;
      entry.busySince = null;
      entry.buffer = [];
      entry.claimed = null;
    }
    entry.lastSeq = event.seq;
    entry.touchedAt = Date.now();
    remember(sessionId, { lastSeq: event.seq });

    if (!WHITELIST.has(event.type)) {
      log?.countUnknown?.(event.type);
      return ok({ kind: 'ignored', sessionId, seq: event.seq, type: event.type });
    }

    if (event.type === 'turn/start') {
      entry.busy = true;
      entry.busySince = Date.now();
      entry.buffer = [];
      entry.claimed = entry.targetQueue.shift() ?? entry.replyTarget ?? null;
      return ok({ kind: 'turn-start', sessionId, seq: event.seq });
    }
    if (event.type === 'assistant/message') {
      const text = assistantText(event);
      if (entry.busy && text) entry.buffer.push(text);
      return ok({ kind: 'assistant-text', sessionId, seq: event.seq, accepted: entry.busy && !!text });
    }
    if (event.type === 'turn/end') {
      entry.busy = false;
      entry.busySince = null;
      return ok({ kind: 'turn-end', sessionId, seq: event.seq });
    }
    if (event.type === 'approval/asked') {
      return ok({ kind: 'audit-asked', sessionId, seq: event.seq, audit: event.data ?? {} });
    }
    return ok({ kind: 'audit-decided', sessionId, seq: event.seq, audit: event.data ?? {} });
  }

  return {
    EVENT_WHITELIST,
    adopt,
    rehydrate,
    syncBaseline,
    takeReply,
    noteInbound,
    dropLastTarget,
    drainInbound,
    clearStaleBusy,
    ingest,
    isAdopted: (sessionId) => sessions.get(sessionId)?.adopted === true,
    /** 管理权判定（D-per-source）：条目被空闲淘汰后**依然为真**，控制帧不得因此被丢。 */
    isManagedSession: (sessionId) => managed.has(sessionId),
    baselineOf: (sessionId) => sessions.get(sessionId)?.baseline ?? null,
    lastSeq: (sessionId) => sessions.get(sessionId)?.lastSeq ?? -1,
    replyTarget: (sessionId) => sessions.get(sessionId)?.replyTarget ?? null,
    isBusy: (sessionId) => sessions.get(sessionId)?.busy === true,
    snapshot(sessionId) {
      const entry = sessions.get(sessionId);
      if (!entry) return null;
      return {
        sessionId,
        lastSeq: entry.lastSeq,
        busy: entry.busy,
        baseline: entry.baseline,
        queuedInbound: entry.inboundQueue.length,
        droppedInbound: entry.droppedInbound,
        bufferLen: entry.buffer.length,
      };
    },
    ids: () => [...sessions.keys()],
    managedIds: () => [...managed.keys()],
    sweep(now = Date.now()) {
      let removed = 0;
      for (const [sessionId, entry] of sessions) {
        if (entry.busy) continue;
        if (now - entry.touchedAt < ttlMs) continue;
        sessions.delete(sessionId);
        removed += 1;
        // 只回收条目（buffer/队列这些重的东西）；管理权与位置留在 `managed` 里，
        // 控制帧到达时由 `rehydrate()` 按需重建（见文件头的事故注释）。
        log?.info?.('session evicted (idle TTL)', { session: sessionId });
      }
      return removed;
    },
    clear() {
      sessions.clear();
      managed.clear();
    },
    size: () => sessions.size,
  };
}

/** 回复正文**只**来自 `assistant/message`（D18）：把 text 块拼成一个字符串。 */
export function assistantText(event) {
  const blocks = event?.data?.message?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

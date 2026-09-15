// 会话状态机（DESIGN.md §2.4.1 / §2.4.5 / §2.4.6）：白名单闸门 + seq 幂等 + 轮次状态 + 回复目标 + 待发队列 + 空闲淘汰。
// 唯一写入者：这里的 `ingest()`。其它模块只读 `snapshot()` / `lastSeq()`。
import { ok, fail } from '../result.js';

/** 白名单 = 全部处理面（D18）。其余一律静默 + debug 计数，**不得**报错或中断流。 */
export const EVENT_WHITELIST = Object.freeze(['turn/start', 'assistant/message', 'turn/end', 'approval/asked', 'approval/decided']);

const WHITELIST = new Set(EVENT_WHITELIST);
export const DEFAULT_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_QUEUE_CAP = 20;

export function createSessionStore({ log, ttlMs = DEFAULT_TTL_MS, queueCap = DEFAULT_QUEUE_CAP }) {
  const sessions = new Map();

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
        adoptedAt: Date.now(),
        touchedAt: Date.now(),
      };
      sessions.set(sessionId, entry);
    }
    return entry;
  }

  function adopt(sessionId, baseline = 'skip-history') {
    if (!sessionId) return fail('no-session', 'no-session-id', 'adopt without sessionId');
    const entry = record(sessionId);
    entry.baseline = baseline;
    entry.adopted = true;
    entry.lastSeq = baseline === 'replay-all' ? -1 : entry.lastSeq;
    entry.adoptedAt = Date.now();
    log?.info?.('session adopted', { session: sessionId, baseline });
    return ok({ sessionId, baseline });
  }

  /** 与首个 `snapshot.cursor` 对齐（D3：基线时刻 = 纳入管理那一刻，不是"首次拉取成功时"）。 */
  function syncBaseline(sessionId, seq) {
    const entry = record(sessionId);
    entry.lastSeq = Number.isFinite(seq) ? seq : -1;
    entry.touchedAt = Date.now();
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

  /** 收到用户消息时记录回复目标（不依赖后续事件，P1-2）；忙时进待发队列（连内容块一起排队，供合并提问）。 */
  function noteInbound(sessionId, { target, parts }) {
    const entry = record(sessionId);
    entry.replyTarget = target ?? entry.replyTarget;
    entry.touchedAt = Date.now();
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
      entry.buffer = [];
      entry.claimed = null;
    }
    entry.lastSeq = event.seq;
    entry.touchedAt = Date.now();

    if (!WHITELIST.has(event.type)) {
      log?.countUnknown?.(event.type);
      return ok({ kind: 'ignored', sessionId, seq: event.seq, type: event.type });
    }

    if (event.type === 'turn/start') {
      entry.busy = true;
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
    syncBaseline,
    takeReply,
    noteInbound,
    dropLastTarget,
    drainInbound,
    ingest,
    isAdopted: (sessionId) => sessions.get(sessionId)?.adopted === true,
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
    sweep(now = Date.now()) {
      let removed = 0;
      for (const [sessionId, entry] of sessions) {
        if (entry.busy) continue;
        if (now - entry.touchedAt < ttlMs) continue;
        sessions.delete(sessionId);
        removed += 1;
        log?.info?.('session evicted (idle TTL)', { session: sessionId });
      }
      return removed;
    },
    clear() {
      sessions.clear();
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

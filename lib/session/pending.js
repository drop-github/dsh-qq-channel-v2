// 审批 / 提问条目（DESIGN.md §2.4.2 / D5 / R5）：
// - `eventId`（网关 mux 随机 UUID，只在控制流上）与 `auditId`（宿主审批服务的随机 UUID，只在会话日志里）**分列**；
// - 两者无协议关联字段、且走两条独立传输 → 用**短窗口双向缓存**容忍乱序；
// - `cancel` 帧必须结清并让后续点击被拒（P1-7）；回传成功才结清，失败保留 pending（P1-5）。
import { ok, fail } from '../result.js';

export const DEFAULT_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_AUDIT_CACHE_MS = 5 * 60 * 1000;

export function createPendingStore({ log, ttlMs = DEFAULT_TTL_MS, auditCacheMs = DEFAULT_AUDIT_CACHE_MS }) {
  const entries = new Map();       // eventId -> entry
  const auditIndex = new Map();    // auditId -> eventId
  const auditCache = new Map();    // sessionId -> [{auditId, toolName, reason, at}]（未配对的审计事件）

  function pruneAuditCache(sessionId, now) {
    const list = auditCache.get(sessionId);
    if (!list) return [];
    const kept = list.filter((item) => now - item.at < auditCacheMs);
    if (kept.length === 0) auditCache.delete(sessionId);
    else auditCache.set(sessionId, kept);
    return kept;
  }

  function pairWithCache(sessionId, entry, now) {
    const list = pruneAuditCache(sessionId, now);
    for (let index = 0; index < list.length; index += 1) {
      const candidate = list[index];
      if (entry.toolName && candidate.toolName && entry.toolName !== candidate.toolName) continue;
      list.splice(index, 1);
      if (list.length === 0) auditCache.delete(sessionId);
      entry.auditId = candidate.auditId;
      auditIndex.set(candidate.auditId, entry.eventId);
      log?.info?.('approval audit paired (cache)', { event: entry.eventId, audit: candidate.auditId });
      return true;
    }
    return false;
  }

  /**
   * 控制流 waterfall 帧 → 条目。
   * 无 `eventId` 的帧**不得**写表（P1-8：否则一个坏帧会毒化整表）。
   */
  function addFromWaterfall({ eventId, sessionId, kind = 'approval', request = {} } = {}) {
    if (!eventId) {
      log?.error?.('waterfall frame without eventId — rejected, not stored', { session: sessionId, kind });
      return fail('rejected', 'no-event-id', 'waterfall frame carried no eventId');
    }
    const existing = entries.get(eventId);
    if (existing) return ok({ entry: existing, duplicate: true });
    const entry = {
      eventId,
      sessionId,
      kind,
      toolName: request.toolName,
      reason: request.reason,
      questions: request.questions,
      auditId: null,
      state: 'pending',
      createdAt: Date.now(),
      decidedOutcome: undefined,
      notifySent: false,
    };
    if (kind === 'approval') pairWithCache(sessionId, entry, entry.createdAt);
    entries.set(eventId, entry);
    log?.info?.('pending entry added', { event: eventId, session: sessionId, kind, tool: entry.toolName });
    return ok({ entry, duplicate: false });
  }

  /** 会话日志里的 `approval/asked` → 与 waterfall 条目配对；对面还没到时先入短窗口缓存。 */
  function attachAudit({ sessionId, auditId, toolName, reason } = {}) {
    if (!auditId) return fail('rejected', 'no-audit-id', 'approval/asked without id');
    if (auditIndex.has(auditId)) return ok({ paired: false, reason: 'already-indexed' });
    for (const entry of entries.values()) {
      if (entry.kind !== 'approval') continue;
      if (entry.sessionId !== sessionId) continue;
      if (entry.auditId) continue;
      if (entry.toolName && toolName && entry.toolName !== toolName) continue;
      entry.auditId = auditId;
      auditIndex.set(auditId, entry.eventId);
      log?.info?.('approval audit paired (pending)', { event: entry.eventId, audit: auditId });
      return ok({ paired: true, eventId: entry.eventId });
    }
    const list = auditCache.get(sessionId) ?? [];
    list.push({ auditId, toolName, reason, at: Date.now() });
    auditCache.set(sessionId, list);
    log?.debug?.('approval audit buffered (no pending entry yet)', { session: sessionId, audit: auditId });
    return ok({ paired: false, buffered: true });
  }

  /**
   * 审计 `approval/decided`：电脑端处理的那次决定要**恰好一条**回补通知。
   * 已由 QQ 侧答复过的条目在答复时就地结清 → 这里不会再发。
   */
  function auditDecided({ auditId, outcome } = {}) {
    const eventId = auditIndex.get(auditId);
    const entry = eventId ? entries.get(eventId) : undefined;
    if (!entry) {
      log?.debug?.('approval/decided matched no pending entry', { audit: auditId, outcome });
      return ok({ notify: false });
    }
    if (entry.state !== 'pending' || entry.notifySent) {
      return ok({ entry, notify: false, state: entry.state });
    }
    entry.state = 'decided-elsewhere';
    entry.decidedOutcome = outcome;
    entry.notifySent = true;
    auditIndex.delete(auditId);
    log?.info?.('approval decided elsewhere — notifying once', { event: entry.eventId, outcome });
    return ok({ entry, notify: true });
  }

  /** 结清（本地状态先改，再发通知：这样宿主回传的 decided 不会再触发第二条）。 */
  function settle(eventId, nextState = 'answered', detail) {
    const entry = entries.get(eventId);
    if (!entry) return fail('not-found', 'no-pending-entry', `no pending entry ${eventId}`);
    entry.state = nextState;
    if (detail !== undefined) entry.decidedOutcome = detail;
    if (entry.auditId) {
      auditIndex.delete(entry.auditId);
      entry.auditId = null;
    }
    return ok(entry);
  }

  /** 是否还能应答：唯一防线是这里的状态判定（click_limit 只是平台体验，`permission.type=2` 不是权限）。 */
  function answerable(eventId) {
    const entry = entries.get(eventId);
    if (!entry) return fail('rejected', 'not-pending', 'entry not found (already handled or expired)');
    if (entry.state !== 'pending') return fail('rejected', `state-${entry.state}`, `entry is ${entry.state}`);
    return ok(entry);
  }

  return {
    addFromWaterfall,
    attachAudit,
    auditDecided,
    settle,
    answerable,
    get: (eventId) => entries.get(eventId),
    count: () => entries.size,
    pendingOf(sessionId) {
      return [...entries.values()].filter((entry) => entry.sessionId === sessionId && entry.state === 'pending');
    },
    sweep(now = Date.now()) {
      let expired = 0;
      for (const [eventId, entry] of entries) {
        const age = now - entry.createdAt;
        if (entry.state === 'pending') {
          if (age > ttlMs) {
            entry.state = 'expired';
            if (entry.auditId) {
              auditIndex.delete(entry.auditId);
              entry.auditId = null;
            }
            expired += 1;
            log?.warn?.('pending entry expired (TTL)', { event: eventId });
          }
          // 本轮刚过期的条目必须**留到下一轮**再回收：否则 `answerable` 只能看到 not-pending，
          // 用户得到的是"查无此条"而不是"已过期"（T-U27）。
          continue;
        }
        if (age > ttlMs) entries.delete(eventId);
      }
      for (const sessionId of [...auditCache.keys()]) pruneAuditCache(sessionId, now);
      return expired;
    },
    clear() {
      entries.clear();
      auditIndex.clear();
      auditCache.clear();
    },
  };
}

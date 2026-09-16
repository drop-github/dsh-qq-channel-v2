// DSH 侧编排：控制流帧（审批/提问 waterfall、cancel）→ QQ；会话事件 action（轮次结束、审计事件）→ QQ。
import { describe } from '../result.js';
import { approvalKeyboard, questionKeyboard } from '../qq/keyboard.js';

export const OUTCOME_ZH = {
  'allowed-once': '已批准 ✅',
  rejected: '已拒绝 ❌',
  cancelled: '已取消',
  unavailable: '无人应答（已按拒绝处理）',
};

export function createDshHandler({ log, config, state, pending, port, dsh, isManaged, onTurnEnd }) {
  /** 回复目标：该会话最近一次入站消息（无来源时回落到 owner 私聊，绝不静默丢弃）。 */
  function targetFor(sessionId) {
    const target = state.replyTarget(sessionId);
    if (target) return target;
    if (Array.isArray(config.allowedUsers) && config.allowedUsers.length > 0) {
      log?.warn?.('no reply target for session — routing notice to owner DM', { session: sessionId });
      return { kind: 'c2c', openid: config.allowedUsers[0] };
    }
    return null;
  }

  async function say(sessionId, text, target = targetFor(sessionId)) {
    if (!target) {
      log?.error?.('no target to send to (no inbound message, no allowedUsers)', { session: sessionId });
      return;
    }
    const result = await port.sendText(target, text, { passive: { msgId: target.msgId } });
    if (!result.ok) log?.error?.('DSH-side send failed', { error: describe(result), session: sessionId });
  }

  /**
   * 控制帧（审批/提问）到达时的管理权闸门：先判定归属，再按需重建被空闲淘汰的条目。
   * 只重建"曾纳入管理"的会话 —— 别人的会话照旧静默忽略，边界不变。
   */
  function ensureManagedState(sessionId, what) {
    if (!sessionId || !isManaged(sessionId)) {
      log?.warn?.(`${what} from unmanaged session ignored`, { session: String(sessionId ?? '') });
      return false;
    }
    const revived = state.rehydrate?.(sessionId);
    if (revived?.ok && revived.value?.rehydrated) {
      log?.warn?.('session state rebuilt for control frame after idle eviction', { session: sessionId, what });
    }
    return true;
  }

  async function onApprovalRequest(value) {
    const eventId = value.eventId;
    const sessionId = value.agentId ?? value.request?.sessionId;
    if (!eventId) {
      // 没有 eventId 就无法回传结果，推一条点了也没用的审批只会误导用户（P1-8 的同源纪律）。
      log?.error?.('approval/request without eventId — dropped');
      return;
    }
    if (!ensureManagedState(sessionId, 'approval')) return;
    const added = pending.addFromWaterfall({ eventId, sessionId, kind: 'approval', request: value.request ?? {} });
    if (!added.ok) {
      log?.error?.('approval entry rejected', { error: describe(added) });
      return;
    }
    if (added.value.duplicate) {
      // 控制流重开时宿主会补投仍未应答的事件（A23）——按 eventId 去重，不能再推一条。
      log?.debug?.('duplicate waterfall frame ignored', { event: eventId });
      return;
    }
    const entry = added.value.entry;
    const ordinal = pending.pendingOf(sessionId).length;
    const what = [entry.toolName, entry.reason].filter(Boolean).join('：');
    const target = targetFor(sessionId);
    if (!target) return;
    const text = `🔐 需要审批 #${ordinal}：${what}\n点击下方按钮，或回复「同意 / 拒绝」`;
    const result = config.keyboardApprovals
      ? await port.sendKeyboard(target, text, approvalKeyboard(eventId), { asMarkdown: true, passive: { msgId: target.msgId } })
      : await port.sendText(target, text, { passive: { msgId: target.msgId } });
    if (!result.ok) log?.error?.('approval notice failed to send', { error: describe(result), event: eventId });
    else log?.info?.('approval notice sent', { event: eventId, keyboard: !!config.keyboardApprovals });
  }

  async function onQuestionRequest(value) {
    const eventId = value.eventId;
    const sessionId = value.agentId ?? value.request?.sessionId;
    const questions = value.request?.questions ?? [];
    if (!eventId) {
      log?.error?.('user-questions/request without eventId — dropped');
      return;
    }
    if (!ensureManagedState(sessionId, 'question')) return;
    const added = pending.addFromWaterfall({ eventId, sessionId, kind: 'question', request: { questions } });
    if (!added.ok || added.value.duplicate) return;
    const target = targetFor(sessionId);
    if (!target) return;
    const question = questions[0];
    if (questions.length === 1 && Array.isArray(question?.options) && question.options.length > 0) {
      const options = question.options.map((option, index) => `${index + 1}) ${option.label ?? option.id}`).join('\n');
      const text = `❓ 提问：${question.question ?? question.header ?? question.id}\n${options}\n回复数字选择`;
      const result = config.keyboardApprovals && question.options.length <= 4
        ? await port.sendKeyboard(target, text, questionKeyboard(eventId, question), { asMarkdown: true, passive: { msgId: target.msgId } })
        : await port.sendText(target, text, { passive: { msgId: target.msgId } });
      if (!result.ok) log?.error?.('question notice failed to send', { error: describe(result), event: eventId });
      return;
    }
    await say(sessionId, '❓ 会话有提问（多问题/自定义输入），请在电脑 GUI 处理。', target);
  }

  function onCancel(eventId) {
    const entry = pending.get(eventId);
    if (!entry) {
      log?.debug?.('cancel frame for unknown entry ignored', { event: String(eventId ?? '') });
      return;
    }
    pending.settle(eventId, 'cancelled', 'cancelled');
    const label = entry.kind === 'question' ? '提问' : '审批';
    say(entry.sessionId, `⚠️ 这条${label}已由电脑端取消，按钮已失效。`);
  }

  /** 控制流帧入口（`$events`）。 */
  function onControlFrame(value) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'ready') {
      dsh.setClientId(value.clientId ?? null);
      log?.info?.('control stream ready', { clientId: String(value.clientId ?? '').slice(0, 8) });
      return;
    }
    if (value.type === 'cancel') {
      onCancel(value.eventId);
      return;
    }
    if (value.type === 'emit') return;   // 广播事件：白名单外，静默
    const eventName = value.event ?? value.type;
    if (eventName === 'approval/request') {
      onApprovalRequest(value);
      return;
    }
    if (eventName === 'user-questions/request') {
      onQuestionRequest(value);
      return;
    }
    log?.debug?.('control event unmapped', { event: String(eventName) });
  }

  /** 会话事件 action（白名单内、已过 seq 幂等）。 */
  async function onAction(action) {
    if (action.kind === 'turn-end') {
      await finishTurn(action.sessionId);
      return;
    }
    if (action.kind === 'audit-asked') {
      const paired = pending.attachAudit({
        sessionId: action.sessionId,
        auditId: action.audit?.id,
        toolName: action.audit?.toolName,
        reason: action.audit?.reason,
      });
      if (!paired.ok) log?.warn?.('approval/asked not paired', { error: describe(paired) });
      return;
    }
    if (action.kind === 'audit-decided') {
      const decided = pending.auditDecided({ auditId: action.audit?.id, outcome: action.audit?.outcome });
      if (!decided.ok) {
        log?.warn?.('approval/decided handling failed', { error: describe(decided) });
        return;
      }
      if (decided.value.notify && decided.value.entry) {
        const entry = decided.value.entry;
        const what = [entry.toolName, entry.reason].filter(Boolean).join('：');
        const zh = OUTCOME_ZH[decided.value.entry.decidedOutcome] ?? String(decided.value.entry.decidedOutcome ?? '');
        await say(entry.sessionId, `审批已处理：${zh}${what ? `（${what}）` : ''}`);
      }
      return;
    }
    if (action.kind === 'turn-start') log?.debug?.('turn started', { session: action.sessionId });
  }

  async function finishTurn(sessionId) {
    const reply = state.takeReply(sessionId);
    if (reply && reply.text) {
      if (reply.target) {
        const result = await port.sendText(reply.target, reply.text, {
          asMarkdown: config.markdown,
          passive: { msgId: reply.target.msgId },
          refMsgId: reply.target.refMsgId,
        });
        if (!result.ok) log?.error?.('reply send failed', { error: describe(result), session: sessionId });
        else log?.info?.('reply delivered', { session: sessionId, chunks: result.value?.chunks ?? 1 });
      } else {
        log?.error?.('reply dropped: no target', { session: sessionId });
      }
    }
    const flushed = state.drainInbound(sessionId);
    if (flushed && flushed.length > 0) await onTurnEnd(sessionId, flushed);
  }

  return { onControlFrame, onAction, targetFor, say, finishTurn };
}

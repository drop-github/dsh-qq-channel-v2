// 文本作答：把 QQ 里的一句话路由到「待答审批 / 待答提问」。
//
// 三种形状：
//   1) 同意/允许/批准、拒绝/驳回（审批）—— 走 `$events/result` 的 allowed-once / rejected；
//   2) 纯数字 —— 选当前这一问的选项；
//   3) **自由输入** —— DSH 的作答协议本来就有 `custom?: string` 字段
//      （`dsh-tool-ask-user` 的 output schema：`{ answers: [{ id, selected[], custom? }] }`），
//      v2.0.0 的 QQ 侧只接了前两种，打字一律被当成新消息排队 —— 这里补齐。
import { describe } from '../result.js';

/** 自由输入的长度上限：QQ 单条上限 2000 左右，再长基本是误粘。 */
export const MAX_CUSTOM_CHARS = 2000;

export function createTextAnswerer({ log, config, pending, dsh, questionFlow }) {
  /** 单会话模式下只有主人能代答；per-source 模式下审批只可能由该来源触发（恒真）。 */
  function answerAllowed(sessionId, operator) {
    if (!config.perSourceSessions) {
      const owner = Array.isArray(config.allowedUsers) ? config.allowedUsers[0] : undefined;
      return !owner || operator === owner;
    }
    return true;
  }

  /** 审批：`同意 [n]` / `拒绝 [n]`。回传失败保留待处理（P1-5）。 */
  async function answerApproval(sessionId, text) {
    const decision = text.match(/^(同意|允许|批准|approve|拒绝|驳回|reject)(?:\s*#?\s*(\d{1,2}))?$/i);
    if (!decision) return null;
    const approvals = pending.pendingOf(sessionId).filter((entry) => entry.kind === 'approval');
    if (approvals.length === 0) return { reply: '⚠️ 当前没有待处理的审批。' };
    const ordinal = decision[2] ? Number(decision[2]) : 1;
    if (ordinal < 1 || ordinal > approvals.length) return { reply: `⚠️ 审批编号范围 1-${approvals.length}。` };
    const entry = approvals[ordinal - 1];
    const gate = pending.answerable(entry.eventId);
    if (!gate.ok) return { reply: 'ℹ️ 这条审批已经处理过了，无需重复操作。' };
    const allow = /^(同意|允许|批准|approve)$/i.test(decision[1]);
    const outcome = allow ? 'allowed-once' : 'rejected';
    const delivered = await dsh.postEventResult({ eventId: entry.eventId, outcome: { kind: 'result', value: outcome } });
    if (!delivered.ok) {
      log?.error?.('text approval post failed — entry kept pending', { error: describe(delivered) });
      return { reply: '⚠️ 审批回传失败，未生效，请重试或到电脑端处理。' };
    }
    pending.settle(entry.eventId, 'answered', outcome);
    return { reply: `已提交审批 #${ordinal}：${allow ? '同意 ✅' : '拒绝 ❌'}` };
  }

  /**
   * 提问：数字选选项，其它文本当自由输入。
   * 多问题的编排（一个个问、凑齐再一次性回传）在 `session/question-flow.js`。
   */
  async function answerQuestion(sessionId, text) {
    const entries = pending.pendingOf(sessionId).filter((entry) => entry.kind === 'question');
    if (entries.length === 0) return null;
    const entry = entries[entries.length - 1];
    const current = questionFlow.currentQuestion(entry);
    if (!current) return null;
    const options = Array.isArray(current.options) ? current.options : [];

    const pick = text.match(/^#?(\d{1,2})$/);
    if (pick && options.length > 0) {
      const index = Number(pick[1]) - 1;
      if (index < 0 || index >= options.length) return { reply: `⚠️ 选项范围 1-${options.length}。` };
      return questionFlow.answer(entry, { selected: [options[index].label ?? options[index].id] });
    }
    if (/^(跳过|skip)$/i.test(text)) return questionFlow.answer(entry, { selected: [], custom: '' });
    if (text.length > MAX_CUSTOM_CHARS) {
      return { reply: `⚠️ 太长了（超过 ${MAX_CUSTOM_CHARS} 字），请精简后重发。` };
    }
    return questionFlow.answer(entry, { selected: [], custom: text });
  }

  /** 返回 `{ reply }`（可能是 null = 已经用提问消息本身回过了），或 null = 不是作答、按普通消息处理。 */
  async function tryTextAnswer(sessionId, operator, rawText) {
    const text = String(rawText ?? '').trim();
    if (text.length === 0) return null;
    if (!answerAllowed(sessionId, operator)) return null;

    const approval = await answerApproval(sessionId, text);
    if (approval) return approval;
    return answerQuestion(sessionId, text);
  }

  return tryTextAnswer;
}

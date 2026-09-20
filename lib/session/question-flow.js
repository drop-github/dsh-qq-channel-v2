// 提问应答流程（QQ 侧编排）：DSH 的 `user-questions/request` 一次可以带 N 个问题，
// 而应答必须是**一次性**的 `{ answers: [{ id, selected[], custom? }] }`
// （见 `dsh-tool-ask-user` 的 output schema）。QQ 是"一条消息一个回合"，
// 所以这里维护一份草稿：每收到一条答复就记一条、接着问下一个；凑齐了再一次性回传。
//
// 这样选项（点按钮 / 回数字）与**自由输入**（直接打字）走的是同一条通道，
// 多问题也不再需要退回"请到电脑 GUI 处理"。
import { describe } from '../result.js';
import { questionKeyboard } from '../qq/keyboard.js';

/** 草稿有效期：比 pending 的 15 分钟 TTL 宽松一点，超时即重新开始问。 */
export const DRAFT_TTL_MS = 30 * 60 * 1000;

export function createQuestionFlow({ log, config, port, pending, dsh, targetFor }) {
  const drafts = new Map(); // eventId -> { answers: [], at }

  function questionsOf(entry) {
    return Array.isArray(entry?.questions) ? entry.questions : [];
  }

  function draftFor(eventId) {
    const existing = drafts.get(eventId);
    if (existing && Date.now() - existing.at <= DRAFT_TTL_MS) return existing;
    const fresh = { answers: [], at: Date.now() };
    drafts.set(eventId, fresh);
    return fresh;
  }

  /** 当前该答的是哪一问（按已收集的答案数推进）。 */
  function currentQuestion(entry) {
    const list = questionsOf(entry);
    const answers = drafts.get(entry?.eventId)?.answers ?? [];
    return list[answers.length] ?? null;
  }

  function renderAsk(entry) {
    const list = questionsOf(entry);
    const index = drafts.get(entry.eventId)?.answers.length ?? 0;
    const question = list[index] ?? {};
    const options = Array.isArray(question.options) ? question.options : [];
    const head = `❓ 提问${list.length > 1 ? `（${index + 1}/${list.length}）` : ''}：${question.question ?? question.header ?? question.id ?? '(无内容)'}`;
    const lines = [head];
    if (options.length > 0) {
      for (let i = 0; i < options.length; i += 1) lines.push(`${i + 1}) ${options[i].label ?? options[i].id}`);
      lines.push('回复数字选择，或直接打字回答');
    } else {
      lines.push('直接打字回答即可');
    }
    return { text: lines.join('\n'), options, question, index, total: list.length };
  }

  async function askNext(entry) {
    const target = targetFor?.(entry.sessionId);
    if (!target) {
      log?.error?.('no target to ask the question — question not delivered', { event: entry.eventId, session: entry.sessionId });
      return false;
    }
    const ask = renderAsk(entry);
    // 键盘只用于"单问题 + 2~4 个选项"：多问题时按钮无法表达"这是在答第几问"。
    const useKeyboard = !!config.keyboardApprovals && ask.total === 1 && ask.options.length > 0 && ask.options.length <= 4;
    const result = useKeyboard
      ? await port.sendKeyboard(target, ask.text, questionKeyboard(entry.eventId, ask.question), { asMarkdown: true, passive: { msgId: target.msgId } })
      : await port.sendText(target, ask.text, { passive: { msgId: target.msgId } });
    if (!result.ok) {
      log?.error?.('question notice failed to send', { error: describe(result), event: entry.eventId, index: ask.index });
      return false;
    }
    log?.info?.('question asked', { event: entry.eventId, index: ask.index + 1, total: ask.total, keyboard: useKeyboard });
    return true;
  }

  /** 新提问到达：建草稿，问第 1 问。 */
  async function start(entry) {
    if (questionsOf(entry).length === 0) {
      log?.error?.('question request carried no questions — nothing asked', { event: entry.eventId });
      return false;
    }
    drafts.set(entry.eventId, { answers: [], at: Date.now() });
    return askNext(entry);
  }

  /**
   * 收到一条件答（选项或自由输入）。
   * 返回 `{ reply }`；`reply === null` 表示"已经用下一问的消息回过话了"，调用方不要再发。
   */
  async function answer(entry, item) {
    const gate = pending.answerable(entry.eventId);
    if (!gate.ok) {
      drafts.delete(entry.eventId);
      return { reply: 'ℹ️ 这个提问已经处理过了，无需重复作答。' };
    }
    const list = questionsOf(entry);
    const draft = draftFor(entry.eventId);
    const question = list[draft.answers.length];
    if (!question) {
      drafts.delete(entry.eventId);
      return { reply: 'ℹ️ 这个提问已经答完了。' };
    }
    const collected = { id: question.id, selected: Array.isArray(item?.selected) ? item.selected : [] };
    if (item?.custom !== undefined) collected.custom = String(item.custom);
    draft.answers.push(collected);
    draft.at = Date.now();

    if (draft.answers.length < list.length) {
      const asked = await askNext(entry);
      return { reply: asked ? null : '⚠️ 下一问没能发出去，请到电脑端处理。' };
    }

    const delivered = await dsh.postEventResult({
      eventId: entry.eventId,
      // 交出去的是**副本**：失败路径会 pop 草稿，若共享引用会把已提交的载荷一起改掉。
      outcome: { kind: 'result', value: { answers: draft.answers.map((answer) => ({ ...answer })) } },
    });
    if (!delivered.ok) {
      // 保留草稿（弹掉刚记的那条）：重发同一条即可重试。
      draft.answers.pop();
      draft.at = Date.now();
      log?.error?.('question result post failed — entry kept pending', { error: describe(delivered), event: entry.eventId });
      return { reply: '⚠️ 回传失败，未生效，请重试或到电脑端处理。' };
    }
    pending.settle(entry.eventId, 'answered', { answers: draft.answers });
    const count = draft.answers.length;
    drafts.delete(entry.eventId);
    log?.info?.('question answers delivered', { event: entry.eventId, count });
    return { reply: count > 1 ? `已提交 ✅（${count} 个问题）` : '已提交 ✅' };
  }

  function drop(eventId) {
    drafts.delete(eventId);
  }

  /**
   * 回收没人作答的草稿：条目已过期/取消/结清，或草稿本身超时。
   * 由 channel 的 sweep 定时器调用 —— 否则每次"问了没人答"都会在内存里留一份。
   */
  function sweep(now = Date.now()) {
    let dropped = 0;
    for (const [eventId, draft] of drafts) {
      const entry = pending.get(eventId);
      const alive = !!entry && entry.state === 'pending' && now - draft.at <= DRAFT_TTL_MS;
      if (alive) continue;
      drafts.delete(eventId);
      dropped += 1;
      log?.warn?.('question draft dropped', {
        event: eventId,
        reason: entry ? `state-${entry.state}` : 'entry-gone',
        answers: draft.answers.length,
      });
    }
    return dropped;
  }

  return {
    start,
    answer,
    drop,
    sweep,
    currentQuestion,
    draftOf: (eventId) => drafts.get(eventId) ?? null,
    size: () => drafts.size,
  };
}

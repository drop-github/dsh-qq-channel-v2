// QQ 侧编排：入站消息 → DSH prompt；按钮点击 → 先 ACK 再回传；附件 → image 块（含退化兜底）。
import { randomUUID } from 'node:crypto';
import { describe } from '../result.js';
import { parseButtonData } from '../qq/keyboard.js';
import { createDedupGate } from '../qq/inbound.js';

export const CLIENT_TIME_ZONE = 'Asia/Shanghai';
const ACK_IMAGE_TEXT = '已收到 ✅（含图片）正在处理…';
const ACK_TEXT = '已收到 ✅ 正在处理…';
const ACK_QUEUED_TEXT = '已收到 ✅（上一条还在处理，已并入等待，处理完一起回）';

/** 宿主拒绝图片时的判定：code 优先，其次看文案（A21 的兜底触发点）。 */
export function isImageRejection(result) {
  if (result?.ok !== false) return false;
  if (result.code === 'session/attachment-invalid') return true;
  return /attachment-invalid|unsupported image|does not support|image|图片/i.test(String(result.message ?? ''));
}

export function createQqHandler({ log, config, state, pending, port, dsh, fetcher }) {
  const dedup = createDedupGate();
  const sourceSessions = new Map();
  const inFlight = new Map();
  let lastMemberRejectLog = 0;

  function managedSessionId() {
    return dsh.currentSessionId();
  }

  async function sessionForSource(sourceKey) {
    const known = sourceSessions.get(sourceKey);
    if (known) return known;
    if (inFlight.has(sourceKey)) return inFlight.get(sourceKey);
    const task = (async () => {
      const created = await dsh.createSession();
      if (!created.ok) {
        log?.error?.('session/create failed', { error: describe(created) });
        return null;
      }
      const sessionId = created.value?.sessionId;
      if (!sessionId) {
        log?.error?.('session/create returned no sessionId');
        return null;
      }
      sourceSessions.set(sourceKey, sessionId);
      // 自建会话的日志从空开始 → 基线 replay-all，初始事件也要投递（§2.4.5）。
      await dsh.attach(sessionId, 'replay-all');
      log?.info?.('per-source session created', { source: sourceKey, session: sessionId });
      return sessionId;
    })().finally(() => inFlight.delete(sourceKey));
    inFlight.set(sourceKey, task);
    return task;
  }

  async function resolveSession(sourceKey) {
    if (!config.perSourceSessions) return managedSessionId();
    return sessionForSource(sourceKey);
  }

  // ---- 文本作答（同意/拒绝/数字）----
  function answerAllowed(sessionId, operator) {
    if (!config.perSourceSessions) {
      const owner = Array.isArray(config.allowedUsers) ? config.allowedUsers[0] : undefined;
      return !owner || operator === owner;
    }
    return true;
  }

  async function tryTextAnswer(sessionId, operator, text) {
    const trimmed = String(text).trim();
    const decision = trimmed.match(/^(同意|允许|批准|approve|拒绝|驳回|reject)(?:\s*#?\s*(\d{1,2}))?$/i);
    if (decision) {
      const approvals = pending.pendingOf(sessionId).filter((entry) => entry.kind === 'approval');
      if (approvals.length === 0) return { reply: '⚠️ 当前没有待处理的审批。' };
      const ordinal = decision[2] ? Number(decision[2]) : 1;
      if (ordinal < 1 || ordinal > approvals.length) return { reply: `⚠️ 审批编号范围 1-${approvals.length}。` };
      if (!answerAllowed(sessionId, operator)) return { reply: '⚠️ 这条审批不是你的会话触发的，不能代答。' };
      const entry = approvals[ordinal - 1];
      const allow = /^(同意|允许|批准|approve)$/i.test(decision[1]);
      const outcome = allow ? 'allowed-once' : 'rejected';
      const gate = pending.answerable(entry.eventId);
      if (!gate.ok) return { reply: 'ℹ️ 这条审批已经处理过了，无需重复操作。' };
      const delivered = await dsh.postEventResult({ eventId: entry.eventId, outcome: { kind: 'result', value: outcome } });
      if (!delivered.ok) {
        log?.error?.('text approval post failed — entry kept pending', { error: describe(delivered) });
        return { reply: '⚠️ 审批回传失败，未生效，请重试或到电脑端处理。' };
      }
      pending.settle(entry.eventId, 'answered', outcome);
      return { reply: `已提交审批 #${ordinal}：${allow ? '同意 ✅' : '拒绝 ❌'}` };
    }
    const questionPick = trimmed.match(/^(\d{1,2})$/) ?? trimmed.match(/^#(\d{1,2})\s+(\d{1,2})$/);
    if (!questionPick) return null;
    const questions = pending.pendingOf(sessionId).filter((entry) => entry.kind === 'question');
    if (questions.length === 0) return null;
    const entry = questions[questions.length - 1];
    const question = entry.questions?.[0];
    if (!question || !Array.isArray(question.options)) return null;
    const chosen = questionPick.length === 2 ? Number(questionPick[2]) : Number(questionPick[1]);
    const index = chosen - 1;
    if (index < 0 || index >= question.options.length) return { reply: `⚠️ 选项范围 1-${question.options.length}。` };
    const delivered = await dsh.postEventResult({
      eventId: entry.eventId,
      outcome: { kind: 'result', value: { answers: [{ id: question.id, selected: [question.options[index].label] }] } },
    });
    if (!delivered.ok) {
      log?.error?.('text question post failed — entry kept pending', { error: describe(delivered) });
      return { reply: '⚠️ 选择回传失败，未生效，请重试或到电脑端处理。' };
    }
    pending.settle(entry.eventId, 'answered', { selected: question.options[index].label });
    return { reply: `已选择 ${index + 1}) ${question.options[index].label} ✅` };
  }

  // ---- prompt ----
  async function submitPrompt(sessionId, parts, target) {
    const noted = state.noteInbound(sessionId, { target, parts });
    if (noted.ok && noted.value.queued) {
      if (config.ack) await port.sendText(target, ACK_QUEUED_TEXT, { passive: { msgId: target?.msgId } });
      return;
    }
    const hasImage = parts.some((part) => part?.type === 'image');
    // D6：requestId 在**调用点**铸造一次；401 重试由 transport 原样重放（A13）。
    let result = await dsh.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: parts,
      clientTimeZone: CLIENT_TIME_ZONE,
    });
    if (!result.ok && hasImage && isImageRejection(result)) {
      log?.warn?.('host rejected the image part — retrying text-only', { code: result.code });
      // 降级是另一条语义不同的输入 → 重新铸 id（复用会让真正发出去的那条被宿主去重丢掉）。
      result = await dsh.prompt({
        requestId: randomUUID(),
        sessionId,
        mode: 'queue',
        content: fetcher.textOnlyFallback(parts),
        clientTimeZone: CLIENT_TIME_ZONE,
      });
    }
    if (!result.ok) {
      state.dropLastTarget(sessionId);
      log?.error?.('session/prompt failed', { error: describe(result), session: sessionId });
      await port.sendText(target, `❌ 消息发送失败：${result.code ?? result.reason}`, { passive: { msgId: target?.msgId } });
      return;
    }
    log?.info?.('prompt accepted', { session: sessionId, parts: parts.length, images: hasImage });
    if (config.ack) {
      await port.sendText(target, hasImage ? ACK_IMAGE_TEXT : ACK_TEXT, { passive: { msgId: target?.msgId } });
    }
  }

  /** 轮次结束时把"忙时累积的消息"合并成一问（不丢消息，P2-15）。 */
  async function onMergedTurn(sessionId, items) {
    const texts = [];
    const parts = [];
    for (const item of items) {
      for (const part of item.parts ?? []) {
        if (part?.type === 'text') texts.push(part.text);
        else parts.push(part);
      }
    }
    if (texts.length > 0) {
      parts.unshift({
        type: 'text',
        text: `[以下 ${items.length} 条消息是在上一轮处理期间连续发送的，请一并回答]\n\n${texts.join('\n\n')}`,
      });
    }
    const target = items[items.length - 1]?.target;
    if (!target) return;
    await submitPrompt(sessionId, parts, target);
  }

  // ---- 入站消息 ----
  async function onMessage(descriptor) {
    const { target, text, attachments, msgId, refMsgId, sourceKey, memberId } = descriptor;
    if (!text && attachments.length === 0) return;
    if (dedup.isDuplicate(msgId)) {
      log?.info?.('duplicate inbound message skipped', { msgId: String(msgId ?? '') });
      return;
    }
    const sessionId = await resolveSession(sourceKey);
    if (!sessionId) {
      log?.error?.('no session for inbound message', { source: sourceKey });
      await port.sendText(target, '⚠️ 没有可用的 DSH 会话，请先在电脑端打开一次 GUI。');
      return;
    }
    const replyTarget = { ...target, msgId, refMsgId };
    if (msgId) port.notePassive(msgId);
    const answer = await tryTextAnswer(sessionId, memberId, text);
    if (answer) {
      log?.info?.('text answer handled', { session: sessionId });
      await port.sendText(replyTarget, answer.reply, { passive: { msgId } });
      return;
    }
    log?.info?.('inbound message', { source: sourceKey, chars: text.length, attachments: attachments.length });
    const parts = await fetcher.buildParts({ text, attachments });
    await submitPrompt(sessionId, parts, replyTarget);
  }

  // ---- 按钮点击 ----
  async function ackInteraction(interactionId) {
    const ensured = await dsh.qqAuth();
    if (!ensured.ok) return ensured;
    try {
      const res = await fetch(`${config.apiBase}/interactions/${interactionId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', authorization: `QQBot ${ensured.value}` },
        body: JSON.stringify({ code: 0 }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) log?.warn?.('interaction ACK failed', { status: res.status });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      log?.warn?.('interaction ACK error', { error: String(err?.message ?? err) });
      return { ok: false, error: String(err?.message ?? err) };
    }
  }

  function operatorOf(d) {
    return d?.group_member_openid || d?.user_openid || d?.data?.resolved?.user_id || '';
  }

  function operatorAllowed(d, operator) {
    if (Array.isArray(config.allowedUsers) && config.allowedUsers.length > 0 && d?.user_openid && !config.allowedUsers.includes(d.user_openid)) {
      return false;
    }
    if (d?.group_openid && Array.isArray(config.groupMembers) && config.groupMembers.length > 0) {
      if (!config.groupMembers.includes(operator)) {
        if (Date.now() - lastMemberRejectLog > 60000) {
          lastMemberRejectLog = Date.now();
          log?.warn?.('group operator not in groupMembers — rejected', {});
        }
        return false;
      }
    }
    return operator.length > 0;
  }

  /** 交互顺序是验收 A18 的判定点：**先 ACK**，再校验操作者，再回传 `$events/result`。 */
  async function onInteraction(d) {
    const interactionId = d?.id;
    if (!interactionId) return;
    if (dedup.isDuplicate(`int:${interactionId}`)) {
      log?.info?.('duplicate interaction skipped', { interaction: String(interactionId) });
      return;
    }
    await ackInteraction(interactionId);
    const parsed = parseButtonData(d?.data?.resolved?.button_data);
    const operator = operatorOf(d);
    if (!parsed) {
      log?.warn?.('unrecognized button_data', { len: String(d?.data?.resolved?.button_data ?? '').length });
      return;
    }
    if (!operatorAllowed(d, operator)) {
      log?.warn?.('interaction operator rejected', { kind: parsed.kind });
      return;
    }
    const gate = pending.answerable(parsed.id);
    const target = { kind: d?.group_openid ? 'group' : 'c2c', openid: d.group_openid ?? operator };
    if (!gate.ok) {
      log?.info?.('click on non-pending entry ignored', { code: gate.code });
      await port.sendText(target, 'ℹ️ 这条请求已经处理过了，无需重复操作。');
      return;
    }
    const entry = gate.value;
    const outcome = parsed.kind === 'approve'
      ? { kind: 'result', value: parsed.outcome }
      : { kind: 'result', value: questionAnswer(entry, parsed.optionIndex) };
    if (outcome.value === null) {
      log?.warn?.('question option index out of range', { index: parsed.optionIndex });
      return;
    }
    const delivered = await dsh.postEventResult({ eventId: parsed.id, outcome });
    if (!delivered.ok) {
      // 🔴 回传失败必须保留 pending + 明确告知（P1-5）：不能"点了没反应又无法再答"。
      log?.error?.('event result post failed — entry kept pending', { error: describe(delivered), event: parsed.id });
      await port.sendText(target, `⚠️ 回传失败（${delivered.code ?? delivered.reason}），未生效，请重试或到电脑端处理。`);
      return;
    }
    pending.settle(parsed.id, 'answered', outcome.value);
    if (parsed.kind === 'approve') {
      const what = [entry.toolName, entry.reason].filter(Boolean).join('：');
      await port.sendText(target, `${parsed.outcome === 'allowed-once' ? '已批准 ✅' : '已拒绝 ❌'}${what ? `：${what}` : ''}`);
    } else {
      await port.sendText(target, `已选择 ${parsed.optionIndex + 1}) ${outcome.value.answers[0].selected[0]} ✅`);
    }
    log?.info?.('interaction handled', { kind: parsed.kind, session: entry.sessionId });
  }

  function questionAnswer(entry, optionIndex) {
    const question = entry.questions?.[0];
    if (!question || !Array.isArray(question.options)) return null;
    const option = question.options[optionIndex];
    if (!option) return null;
    return { answers: [{ id: question.id, selected: [option.label] }] };
  }

  return {
    onMessage,
    onInteraction,
    onMergedTurn,
    resolveSession,
    submitPrompt,
    tryTextAnswer,
    onReady: (d) => log?.info?.('QQ gateway ready', { session: String(d?.session_id ?? '') }),
  };
}

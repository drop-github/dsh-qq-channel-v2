// QQ 侧编排：入站消息 → DSH prompt；按钮点击 → 先 ACK 再回传；附件 → image 块（含退化兜底）。
import { randomUUID } from 'node:crypto';
import { describe } from '../result.js';
import { parseButtonData } from '../qq/keyboard.js';
import { createDedupGate } from '../qq/inbound.js';
import { sessionIdForSource } from '../session/source-session.js';
import { createTextAnswerer } from './text-answer.js';

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

export function createQqHandler({ log, config, state, pending, port, dsh, fetcher, pendingInbox = null, questionFlow }) {
  const dedup = createDedupGate();
  const sourceSessions = new Map();
  const inFlight = new Map();
  let lastMemberRejectLog = 0;
  // 文本作答（审批 / 选项 / 自由输入）在 handlers/text-answer.js；多问题编排在 session/question-flow.js。
  const tryTextAnswer = createTextAnswerer({ log, config, pending, dsh, questionFlow });

  function managedSessionId() {
    return dsh.currentSessionId();
  }

  async function sessionForSource(sourceKey) {
    const known = sourceSessions.get(sourceKey);
    if (known) return known;
    if (inFlight.has(sourceKey)) return inFlight.get(sourceKey);
    const task = (async () => {
      // 身份是**算出来的**（session/source-session.js）：同一个来源每次启动都得到同一个 sessionId，
      // 宿主 `session/create` 于是"磁盘上有就 resume、没有才建" —— 重启不再换对话（v1 → v2 的回归修复）。
      const derived = sessionIdForSource(sourceKey);
      const existed = await dsh.sessionExists(derived);
      let created = await dsh.createSession({ sessionId: derived });
      let via = created.ok ? (existed === true ? 'adopted' : 'created') : 'fallback';
      if (!created.ok) {
        // 自带身份被拒（理论上不该发生）：退回随机身份并**大声**告警 —— 这条来源的跨重启稳定性丢失。
        log?.warn?.('derived session identity rejected — falling back to a fresh session', {
          source: sourceKey, session: derived, error: describe(created),
        });
        created = await dsh.createSession();
      }
      const sessionId = created.ok ? (created.value?.sessionId ?? (via === 'adopted' ? derived : '')) : '';
      if (!sessionId) {
        log?.error?.('session/create failed', { error: describe(created), source: sourceKey });
        return null;
      }
      sourceSessions.set(sourceKey, sessionId);
      // 新会话日志从空开始 → 基线 replay-all，初始事件也要投递（§2.4.5）；
      // 复用已有会话 → 必须跳历史，否则会把历史里的回复当成本轮结果灌进 QQ。
      await dsh.attach(sessionId, via === 'adopted' ? 'skip-history' : 'replay-all');
      log?.info?.(via === 'fallback' ? 'per-source session created (fallback identity)' : 'per-source session resolved', {
        source: sourceKey, session: sessionId, via,
      });
      return sessionId;
    })().finally(() => inFlight.delete(sourceKey));
    inFlight.set(sourceKey, task);
    return task;
  }

  async function resolveSession(sourceKey) {
    if (!config.perSourceSessions) return managedSessionId();
    return sessionForSource(sourceKey);
  }

  // ---- prompt ----
  /** 待补发项 → 内容块：图片降级成收件箱路径文本（重放不重传二进制，避免二次下载/体积爆炸）。 */
  function recoveredParts(pendingItems) {
    const parts = [];
    for (const item of pendingItems) {
      const texts = [];
      const paths = [];
      for (const part of item.parts ?? []) {
        if (part?.type === 'text' && part.text) texts.push(part.text);
        else if (part?.type === 'image') paths.push(part.inboxPath ?? part.name ?? '(图片, 路径未知)');
        else if (part?.type === 'file') paths.push(part.inboxPath ?? part.name ?? '(文件, 路径未知)');
      }
      const head = `[未送达补发 · ${new Date(item.at).toISOString()}]`;
      const body = texts.join('\n').trim();
      parts.push({
        type: 'text',
        text: `${head}\n${body || '(无文字)'}${paths.length > 0 ? `\n附件: ${paths.join(', ')}` : ''}`,
      });
    }
    return parts;
  }

  const RECOVERY_HEADER = '（以下消息在上一轮中未能送达，现一并补上；附件已存于收件箱路径，请按需读取）';

  async function submitPrompt(sessionId, parts, target, extra = {}) {
    // 落盘 id 随行："忙时并入等待"不等于送达，ids 要等到合并轮真正送出去才清（T-W10）。
    const carriedIds = [...(extra.pendingMsgIds ?? []), ...(extra.clearMsgIds ?? [])];
    const noted = state.noteInbound(sessionId, { target, parts, durableIds: carriedIds });
    if (noted.ok && noted.value.queued) {
      if (config.ack) await port.sendText(target, ACK_QUEUED_TEXT, { passive: { msgId: target?.msgId } });
      return;
    }
    const hasImage = parts.some((part) => part?.type === 'image');
    // D6：requestId 在**调用点**铸造一次；401 重试由 transport 原样重放（A13）。
    const requestId = randomUUID();
    // 发出前显式留痕：宿主冻结时这一行是"我们确实发了"的唯一证据（v1 缺的就是它）。
    log?.info?.('session/prompt sending', {
      session: sessionId,
      requestId,
      parts: parts.length,
      images: hasImage,
    });
    let result = await dsh.prompt({
      requestId,
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
      log?.error?.('session/prompt failed', { error: describe(result), session: sessionId, requestId });
      const queued = pendingInbox?.size?.() ?? 0;
      await port.sendText(
        target,
        `❌ 消息发送失败：${result.code ?? result.reason}（已存入待补发队列，共 ${queued} 条；宿主恢复后会自动补上）`,
        { passive: { msgId: target?.msgId } },
      );
      return;
    }
    // 成功才清：失败/卡死的消息留在队列里，等下一次成功轮次或重启后补发。
    for (const msgId of extra.pendingMsgIds ?? []) pendingInbox?.remove?.(msgId);
    for (const msgId of extra.clearMsgIds ?? []) pendingInbox?.remove?.(msgId);
    log?.info?.('prompt accepted', { session: sessionId, parts: parts.length, images: hasImage });
    if (config.ack) {
      await port.sendText(target, hasImage ? ACK_IMAGE_TEXT : ACK_TEXT, { passive: { msgId: target?.msgId } });
    }
  }

  /**
   * 补发上一次卡死/失败留下的入站消息。
   * 只在发起人是主人时触发（避免任何人凭一条消息捞走别人的内容）。
   */
  async function replayPending(sessionId, target) {
    if (!pendingInbox) return 0;
    const items = pendingInbox.list(sessionId).filter((item) => item.sessionId === sessionId);
    if (items.length === 0) return 0;
    const parts = [
      { type: 'text', text: `${RECOVERY_HEADER}\n\n${recoveredParts(items).map((part) => part.text).join('\n\n')}` },
    ];
    const msgIds = items.map((item) => item.msgId);
    log?.warn?.('replaying pending inbound messages', { session: sessionId, count: msgIds.length });
    await submitPrompt(sessionId, parts, target, { pendingMsgIds: msgIds });
    return msgIds.length;
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
    // 被并入的消息**此刻才真正送达** → 把它们的落盘 id 一并交给提交层：成功即清，失败则留在队列里等补发。
    const durableIds = items.flatMap((item) => item.durableIds ?? []);
    await submitPrompt(sessionId, parts, target, { pendingMsgIds: durableIds });
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
    // 补发指令：只有主人能触发，避免任何人凭一条消息把别人的内容捞出来。
    if (pendingInbox && /^(补发|重发|retry)$/i.test(String(text ?? '').trim())) {
      const owner = Array.isArray(config.allowedUsers) && config.allowedUsers.includes(memberId ?? '');
      if (!owner) {
        await port.sendText(replyTarget, '⚠️ 只有主人可以触发补发。', { passive: { msgId } });
        return;
      }
      const count = await replayPending(sessionId, replyTarget);
      if (count === 0) await port.sendText(replyTarget, 'ℹ️ 没有待补发的消息。', { passive: { msgId } });
      return;
    }
    const answer = await tryTextAnswer(sessionId, memberId, text);
    if (answer) {
      log?.info?.('text answer handled', { session: sessionId });
      // reply 为 null = 已经用"下一问"的消息回过话了（多问题逐问），这里不要多发一条。
      if (answer.reply) await port.sendText(replyTarget, answer.reply, { passive: { msgId } });
      return;
    }
    log?.info?.('inbound message', { source: sourceKey, chars: text.length, attachments: attachments.length });
    const parts = await fetcher.buildParts({ text, attachments });
    // 先落盘再发送：这一步必须在 `await dsh.prompt` **之前**，否则宿主冻结时
    // 消息只活在内存里，进程一死就永久丢失（09-16 事故的 3 个 PDF 就是这样没的）。
    const queueId = msgId ? `msg-${msgId}` : `auto-${randomUUID()}`;
    pendingInbox?.add?.({
      msgId: queueId,
      sessionId,
      sourceKey,
      target: replyTarget,
      parts,
      at: Date.now(),
    });
    await submitPrompt(sessionId, parts, replyTarget, { clearMsgIds: [queueId] });
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

  /**
   * 控制流回执（点击后的「已批准 / 已提交」等）：**必须复用被动窗口里的 msg_id**。
   * 不带 msg_id 就退化成主动消息 —— QQ 的主动消息有额度，用尽时直接丢弃，
   * 用户看到的是「点了按钮没反应」；而且这条路径此前失败是**静默**的，日志里什么都没有。
   */
  async function confirmTo(sessionId, target, text, what) {
    const passiveMsgId = sessionId ? state.replyTarget(sessionId)?.msgId : undefined;
    const result = await port.sendText(target, text, passiveMsgId ? { passive: { msgId: passiveMsgId } } : {});
    if (!result.ok) {
      log?.error?.(`${what} failed to send`, { error: describe(result), session: sessionId ?? '', code: result.code });
    }
    return result;
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
      await confirmTo(pending.get(parsed.id)?.sessionId, target, 'ℹ️ 这条请求已经处理过了，无需重复操作。', 'stale-click notice');
      return;
    }
    const entry = gate.value;
    if (parsed.kind === 'question') {
      // 选项点击与"回数字/打字"走同一条通道（多问题时由草稿决定这是在答第几问）。
      const option = questionFlow.currentQuestion(entry)?.options?.[parsed.optionIndex];
      if (!option) {
        log?.warn?.('question option index out of range', { index: parsed.optionIndex });
        return;
      }
      const answered = await questionFlow.answer(entry, { selected: [option.label ?? option.id] });
      if (answered.reply) await confirmTo(entry.sessionId, target, answered.reply, 'question confirmation');
      log?.info?.('interaction handled', { kind: parsed.kind, session: entry.sessionId });
      return;
    }
    const outcome = { kind: 'result', value: parsed.outcome };
    const delivered = await dsh.postEventResult({ eventId: parsed.id, outcome });
    if (!delivered.ok) {
      // 🔴 回传失败必须保留 pending + 明确告知（P1-5）：不能"点了没反应又无法再答"。
      log?.error?.('event result post failed — entry kept pending', { error: describe(delivered), event: parsed.id });
      await confirmTo(entry.sessionId, target, `⚠️ 回传失败（${delivered.code ?? delivered.reason}），未生效，请重试或到电脑端处理。`, 'approval failure notice');
      return;
    }
    pending.settle(parsed.id, 'answered', outcome.value);
    const what = [entry.toolName, entry.reason].filter(Boolean).join('：');
    await confirmTo(entry.sessionId, target, `${parsed.outcome === 'allowed-once' ? '已批准 ✅' : '已拒绝 ❌'}${what ? `：${what}` : ''}`, 'approval confirmation');
    log?.info?.('interaction handled', { kind: parsed.kind, session: entry.sessionId });
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

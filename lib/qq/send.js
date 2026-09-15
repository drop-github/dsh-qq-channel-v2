// 发送层（任务书 §1.4；`thincoder-v2-qq-spec.md §3`）：markdown / 文本 / 媒体三态、分块、
// **被动回复窗口**（M1/D17）、429/5xx 重试分类、判重降级。
import { ok, fail, describe } from '../result.js';
import { sleep, clamp } from '../util.js';
import { toQQMarkdown, chunkByCodePoints, MAX_CONTENT_CHARS } from './format.js';

export const MSG_TYPE_TEXT = 0;
export const MSG_TYPE_MARKDOWN = 2;
export const MSG_TYPE_MEDIA = 7;
// 被动回复窗口：收到消息后 5 分钟内，**每条**出站消息都可以带 msg_id（旧"只用一次"的叙述已作废）。
export const PASSIVE_WINDOW_MS = 5 * 60 * 1000;
export const MAX_SEND_ATTEMPTS = 3;
const SEND_TIMEOUT_MS = 15000;
const PASSIVE_TABLE_CAP = 500;

export function endpointFor(apiBase, target) {
  if (!target || !target.openid) return null;
  if (target.kind === 'group') return `${apiBase}/v2/groups/${target.openid}/messages`;
  if (target.kind === 'c2c') return `${apiBase}/v2/users/${target.openid}/messages`;
  return null;
}

/** 从响应体/文案里判"msg_id 被判重"（QQ 的 40054005 / msgseq 类错误）。 */
export function looksLikeDedup(detail) {
  const text = String(detail ?? '');
  return text.includes('40054005') || /msgseq/i.test(text);
}

export function createSender({ config, log, token, fetchImpl = fetch }) {
  const passive = new Map();   // msgId -> { seq, at }

  function prune(now = Date.now()) {
    for (const [key, entry] of passive) {
      if (now - entry.at > PASSIVE_WINDOW_MS * 2) passive.delete(key);
    }
    if (passive.size > PASSIVE_TABLE_CAP) {
      // 有界 + 按插入序淘汰（P2-5：整表清空会让正在进行的窗口全部失效）。
      const overflow = passive.size - PASSIVE_TABLE_CAP;
      let removed = 0;
      for (const key of passive.keys()) {
        passive.delete(key);
        removed += 1;
        if (removed >= overflow) break;
      }
    }
  }

  /** 入站消息到达时登记被动窗口（`msgSeq` 的分配责任在出站端口，不下沉到会话层）。 */
  function notePassive(msgId) {
    if (!msgId) return false;
    prune();
    if (!passive.has(msgId)) passive.set(msgId, { seq: 0, at: Date.now() });
    return true;
  }

  function passiveTicket(msgId) {
    if (!msgId) return null;
    const entry = passive.get(msgId);
    if (!entry || Date.now() - entry.at > PASSIVE_WINDOW_MS) return null;
    entry.seq += 1;
    return { msgId, msgSeq: entry.seq };
  }

  async function post(url, body) {
    let last = { status: 0, text: '' };
    for (let attempt = 1; attempt <= MAX_SEND_ATTEMPTS; attempt += 1) {
      const ensured = await token.ensure();
      if (!ensured.ok) return ensured;
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `QQBot ${ensured.value}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (err) {
        last = { status: 0, text: String(err?.message ?? err) };
        await sleep(500 * attempt);
        continue;
      }
      let text = '';
      try {
        text = await res.text();
      } catch (err) {
        text = `body-read-failed: ${String(err?.message ?? err)}`;
      }
      if (res.ok) return ok({ status: res.status, text });
      last = { status: res.status, text };
      if (res.status === 429) {
        const retryAfter = Number(res.headers?.get?.('retry-after') ?? 0);
        const waitMs = clamp(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 1, 1, 30) * 1000;
        log?.warn?.('send 429 — honoring retry-after', { waitMs });
        await sleep(waitMs);
        continue;
      }
      if (res.status >= 500) {
        await sleep(1000 * attempt);
        continue;
      }
      break;   // 4xx 不重试
    }
    const reason = last.status === 0 ? 'unavailable' : last.status >= 500 ? 'unavailable' : 'rejected';
    return fail(reason, `http-${last.status}`, String(last.text).slice(0, 160));
  }

  /** 单条投递 + 降级链：判重 → 去 msg_id 重发一次；markdown 失败 → 纯文本重发。 */
  async function deliver(url, body) {
    let result = await post(url, body);
    if (result.ok) return result;
    const detail = result.message ?? '';
    if (body.msg_id && looksLikeDedup(detail)) {
      log?.warn?.('msg_id rejected as duplicate — resending as active message', { code: result.code });
      const fallback = { ...body };
      delete fallback.msg_id;
      delete fallback.msg_seq;
      result = await post(url, fallback);
    } else if (body.markdown) {
      log?.warn?.('markdown send failed — falling back to plain text', { code: result.code });
      const fallback = { ...body, msg_type: MSG_TYPE_TEXT, content: body.markdown.content };
      delete fallback.markdown;
      result = await post(url, fallback);
    }
    return result;
  }

  function buildBody(kind, content, { msgId, msgSeq, keyboard, refMsgId } = {}) {
    const passiveFields = msgId ? { msg_id: msgId, msg_seq: msgSeq } : {};
    // 私聊不并用 `message_reference`（现役策略，避免与 msg_id 冲突 —— PROTOCOL.md §8）。
    const reference = refMsgId && kind === 'group' ? { message_reference: { message_id: refMsgId } } : {};
    return {
      msg_type: MSG_TYPE_MARKDOWN,
      markdown: { content },
      ...(keyboard ? { keyboard } : {}),
      ...passiveFields,
      ...reference,
    };
  }

  /**
   * 文本/回复消息：分块（码点）+ 每条都在被动窗口内挂 `msg_id` 与唯一 `msg_seq`。
   * 带键盘的消息**只发一条**（键盘一条消息只能挂一个，分块会各带一半）。
   */
  async function sendText(target, text, opts = {}) {
    const url = endpointFor(config.apiBase, target);
    if (!url) {
      log?.warn?.('sendText without target — dropped', {});
      return fail('no-target', 'no-target', 'sendText has no c2c/group target');
    }
    if (opts.keyboard) return sendKeyboard(target, text, opts.keyboard, opts);
    const asMarkdown = opts.asMarkdown ?? config.markdown;
    const body = asMarkdown ? toQQMarkdown(text) : String(text ?? '');
    const { chunks, total, truncated } = chunkByCodePoints(body, config.maxChunk, config.maxReplyChunks);
    if (total === 0) return fail('rejected', 'empty-message', 'nothing to send');
    let sentCount = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const part = chunks[index] + (chunks.length > 1 && index < chunks.length - 1 ? ' …' : '');
      // 每一条都单独取号：同一 msgId 下 (msgId, msgSeq) 必须互不相同（M1/A20）。
      const ticket = passiveTicket(opts.passive?.msgId);
      const payload = buildBody(target.kind, part, {
        msgId: ticket?.msgId,
        msgSeq: ticket?.msgSeq,
        refMsgId: opts.refMsgId,
      });
      const result = await deliver(url, payload);
      if (!result.ok) {
        log?.error?.('send failed', { chunk: `${index + 1}/${chunks.length}`, error: describe(result) });
        return fail(result.reason, result.code, `chunk ${index + 1}/${chunks.length}: ${result.message}`);
      }
      sentCount += 1;
    }
    if (truncated) {
      log?.warn?.('reply truncated', { total, kept: chunks.length });
      const noticeTicket = passiveTicket(opts.passive?.msgId);
      await deliver(url, buildBody(target.kind, '（回复过长已截断）', { msgId: noticeTicket?.msgId, msgSeq: noticeTicket?.msgSeq }));
    }
    return ok({ chunks: sentCount, total, truncated });
  }

  /** 带键盘的消息：只发一条，不参与分块（避免"键盘只挂在第一块"）。 */
  async function sendKeyboard(target, text, keyboard, opts = {}) {
    const url = endpointFor(config.apiBase, target);
    if (!url) return fail('no-target', 'no-target', 'sendKeyboard has no c2c/group target');
    const ticket = passiveTicket(opts.passive?.msgId);
    const content = String(text ?? '').slice(0, MAX_CONTENT_CHARS);
    const payload = buildBody(target.kind, content, { msgId: ticket?.msgId, msgSeq: ticket?.msgSeq, keyboard });
    const result = await deliver(url, payload);
    if (!result.ok) log?.error?.('keyboard send failed', { error: describe(result) });
    return result.ok ? ok({ chunks: 1, keyboard: true }) : result;
  }

  /** 媒体（msg_type 7）：服务端没有替我们发时使用（见 upload.js 的降级分支）。 */
  async function sendMedia(target, fileInfo, opts = {}) {
    const url = endpointFor(config.apiBase, target);
    if (!url) return fail('no-target', 'no-target', 'sendMedia has no c2c/group target');
    if (!fileInfo) return fail('rejected', 'no-file-info', 'sendMedia needs file_info');
    const ticket = passiveTicket(opts.passive?.msgId);
    const body = {
      msg_type: MSG_TYPE_MEDIA,
      media: { file_info: fileInfo },
      ...(ticket ? { msg_id: ticket.msgId, msg_seq: ticket.msgSeq } : {}),
    };
    const result = await deliver(url, body);
    return result.ok ? ok({ media: true }) : result;
  }

  return {
    sendText,
    sendKeyboard,
    sendMedia,
    notePassive,
    passiveSeqOf: (msgId) => passive.get(msgId)?.seq ?? 0,
    windowSize: () => passive.size,
  };
}

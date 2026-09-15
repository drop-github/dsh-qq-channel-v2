// 入站附件（任务书 §1.8 / M4-3 / P2-16）：只对预期域名带凭据、魔数校验、"收件箱 + 文本兜底"。
import fs from 'node:fs';
import path from 'node:path';
import { ok, fail } from '../result.js';
import { safeFileName } from '../util.js';

export const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

// QQ 给的下载 URL 只在这些域名下才附带 bot token；其余一律裸下载（P2-16）。
const AUTHORIZED_HOSTS = ['qq.com', 'qcloud.com', 'myqcloud.com', 'qq.com.cn'];
const MAGIC = new Map([
  ['image/jpeg', 'ffd8ff'],
  ['image/png', '89504e47'],
  ['image/gif', '474946'],
  ['image/webp', '52494646'],   // RIFF（另需 offset 8 处为 WEBP）
]);

export function isAuthorizedHost(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return AUTHORIZED_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch (err) {
    return false;   // URL 解析不了就当"非预期域名"处理，宁可少带凭据
  }
}

/** 不轻信 `content_type` 声明：按魔数判定真实格式。 */
export function magicOk(buffer, mediaType) {
  const signature = MAGIC.get(mediaType);
  if (!signature || !buffer || buffer.length < 12) return false;
  if (mediaType === 'image/webp') {
    return buffer.subarray(0, 4).toString('hex') === signature && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return buffer.subarray(0, signature.length / 2).toString('hex') === signature;
}

export function createAttachmentFetcher({ config, log, token, inboxDir, fetchImpl = fetch }) {
  // 图片块的"附带信息"（收件箱路径/字节数）**不能**塞进 image part（额外键会被宿主剥离，P2-17），
  // 因此单独挂在 WeakMap 上，只在降级为文本时使用。
  const partMeta = new WeakMap();
  async function download(url, { withAuthorization, maxBytes, what }) {
    if (!url) return fail('rejected', 'no-url', `${what} attachment has no url`);
    const headers = {};
    if (withAuthorization && isAuthorizedHost(url)) {
      const ensured = await token.ensure();
      if (!ensured.ok) return ensured;
      headers.authorization = `QQBot ${ensured.value}`;
    }
    let res;
    try {
      res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(60000) });
    } catch (err) {
      return fail('unavailable', String(err?.name ?? 'download-failed'), String(err?.message ?? err));
    }
    if (!res.ok) return fail(res.status >= 500 ? 'unavailable' : 'rejected', `http-${res.status}`, `${what} download failed`);
    let buffer;
    try {
      buffer = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      return fail('transport', 'download-read-failed', String(err?.message ?? err));
    }
    if (buffer.length > maxBytes) return fail('rejected', 'too-large', `${what} exceeds ${maxBytes} bytes`);
    return ok(buffer);
  }

  function saveToInbox(buffer, name) {
    if (!inboxDir) return null;
    try {
      fs.mkdirSync(inboxDir, { recursive: true });
      const target = path.join(inboxDir, `${Date.now()}-${safeFileName(name, 'file')}`);
      fs.writeFileSync(target, buffer);
      return target;
    } catch (err) {
      log?.warn?.('inbox save failed (non-fatal)', { error: String(err?.message ?? err) });
      return null;
    }
  }

  /**
   * 图片 → prompt 的 image 块。
   * 🔴 image part 是 zod union，额外键会被**剥离**（P2-17）→ 路径绝不塞进 image 块，改走 text part；
   *    下载/校验失败一律退化为文本提示，不能让整条 prompt 失败。
   */
  async function imagePart(attachment) {
    const mediaType = attachment?.content_type;
    if (!IMAGE_MEDIA_TYPES.has(mediaType)) return null;
    const fetched = await download(attachment.url, { withAuthorization: true, maxBytes: MAX_IMAGE_BYTES, what: mediaType });
    if (!fetched.ok) {
      log?.warn?.('image download failed', { error: `${fetched.reason}/${fetched.code}` });
      return { type: 'text', text: `[图片接收失败：${fetched.code ?? fetched.reason}]` };
    }
    if (!magicOk(fetched.value, mediaType)) {
      log?.warn?.('image magic mismatch', { mediaType });
      return { type: 'text', text: `[图片接收失败：内容与声明的类型 ${mediaType} 不符]` };
    }
    const inboxPath = saveToInbox(fetched.value, attachment.filename ?? `img-${Date.now()}.png`);
    if (inboxPath) log?.info?.('image saved to inbox', { bytes: fetched.value.length });
    const part = {
      type: 'image',
      mediaType,
      data: fetched.value.toString('base64'),
      ...(attachment.filename ? { name: attachment.filename } : {}),
    };
    partMeta.set(part, { inboxPath, bytes: fetched.value.length, mediaType });
    return part;
  }

  /** 非图片附件：存盘 + 文本注明路径（图片走 image part，文件只能这样表达）。 */
  async function fileNote(attachment) {
    const fetched = await download(attachment.url, { withAuthorization: true, maxBytes: MAX_FILE_BYTES, what: attachment.content_type ?? 'file' });
    if (!fetched.ok) {
      log?.warn?.('attachment download failed', { error: `${fetched.reason}/${fetched.code}` });
      return `[附件接收失败：${fetched.code ?? fetched.reason}]`;
    }
    const inboxPath = saveToInbox(fetched.value, attachment.filename ?? `file-${Date.now()}`);
    log?.info?.('attachment saved to inbox', { bytes: fetched.value.length, type: attachment.content_type ?? 'unknown' });
    return `[附件已保存到收件箱 ${inboxPath ?? '(保存失败)'}（类型 ${attachment.content_type ?? 'unknown'}，${fetched.value.length} 字节）]`;
  }

  /** 组装 prompt 内容块：文本 → 图片 → 其它附件。 */
  async function buildParts({ text, attachments = [] }) {
    const parts = [];
    if (text) parts.push({ type: 'text', text });
    const images = attachments.filter((item) => IMAGE_MEDIA_TYPES.has(item?.content_type));
    const others = attachments.filter((item) => !IMAGE_MEDIA_TYPES.has(item?.content_type) && item?.url);
    for (const image of images) {
      const part = await imagePart(image);
      if (part) parts.push(part);
    }
    for (const other of others) parts.push({ type: 'text', text: await fileNote(other) });
    return parts;
  }

  /** 宿主拒绝图片时的降级：image 块换成收件箱路径提示（文本兜底，A21）。 */
  function textOnlyFallback(parts) {
    return parts.map((part) => {
      if (part?.type !== 'image') return part;
      const meta = partMeta.get(part) ?? {};
      const where = meta.inboxPath ?? '(未保存到收件箱)';
      return {
        type: 'text',
        text: `[图片已保存到收件箱 ${where}（${meta.bytes ?? '?'} 字节，类型 ${meta.mediaType ?? part.mediaType}）；`
          + '当前会话不接受该图片，请用工具（OCR/元数据）识别或让用户用文字描述]',
      };
    });
  }

  return { buildParts, imagePart, fileNote, textOnlyFallback, metaOf: (part) => partMeta.get(part), download, isAuthorizedHost };
}

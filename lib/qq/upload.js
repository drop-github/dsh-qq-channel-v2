// 分片上传（任务书 §1.7 / M4；`thincoder-v2-qq-spec.md §6`）。
// 三条纪律：① `upload_part_finish` 必带 `upload_id`；② 上传前 `statSync` 判上限 + 分片读取，
// **不整文件进内存**；③ `40093002` = 当日限额（永久失败）、`40093001` = 瞬时可重试。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ok, fail } from '../result.js';
import { sleep, clamp } from '../util.js';

// First 10,002,432 bytes used for the md5_10m hash (per QQ API spec).
// 出处逐字：Hermes `gateway/platforms/qqbot/chunked_upload.py:66-67`（`_MD5_10M_SIZE = 10_002_432`），
// 且**小于该长度时 `md5_10m` 等于全文件 md5**（同文件 `:585-586`）。不要"修"成 10485760。
export const MD5_10M_SIZE = 10_002_432;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
export const UPLOAD_TIMEOUT_MS = 60000;
export const PART_PUT_TIMEOUT_MS = 300000;
export const RETRYABLE_CODE = '40093001';
export const QUOTA_CODE = '40093002';
const PART_FINISH_ATTEMPTS = 3;
const HASH_CHUNK = 1 << 20;

export const FILE_TYPE_IMAGE = 1;
export const FILE_TYPE_VIDEO = 2;
export const FILE_TYPE_VOICE = 3;
export const FILE_TYPE_FILE = 4;

const FILE_TYPE_BY_EXT = new Map([
  ['.jpg', FILE_TYPE_IMAGE], ['.jpeg', FILE_TYPE_IMAGE], ['.png', FILE_TYPE_IMAGE],
  ['.gif', FILE_TYPE_IMAGE], ['.webp', FILE_TYPE_IMAGE],
  ['.mp4', FILE_TYPE_VIDEO], ['.silk', FILE_TYPE_VOICE],
]);

export function fileTypeOf(fileName) {
  return FILE_TYPE_BY_EXT.get(String(fileName).toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? '') ?? FILE_TYPE_FILE;
}

/** 单遍流式哈希：md5 / sha1 覆盖全文件，md5_10m 只吃前 MD5_10M_SIZE 字节。 */
export async function hashFile(filePath, size) {
  const md5 = createHash('md5');
  const sha1 = createHash('sha1');
  const md5TenMegabyte = createHash('md5');
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(HASH_CHUNK);
    let offset = 0;
    while (offset < size) {
      const length = Math.min(buffer.length, size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead <= 0) break;
      const slice = buffer.subarray(0, bytesRead);
      md5.update(slice);
      sha1.update(slice);
      const remaining = MD5_10M_SIZE - offset;
      if (remaining > 0) md5TenMegabyte.update(slice.subarray(0, Math.min(remaining, bytesRead)));
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { md5: md5.digest('hex'), sha1: sha1.digest('hex'), md5_10m: md5TenMegabyte.digest('hex') };
}

async function readRange(filePath, offset, length) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

export function createUploader({ config, log, token, fetchImpl = fetch }) {
  function apiPath(target, suffix) {
    const kind = target?.kind === 'group' ? 'groups' : 'users';
    return `${config.apiBase}/v2/${kind}/${target.openid}/${suffix}`;
  }

  async function api(target, suffix, body, { timeoutMs = UPLOAD_TIMEOUT_MS } = {}) {
    const ensured = await token.ensure();
    if (!ensured.ok) return ensured;
    let res;
    try {
      res = await fetchImpl(apiPath(target, suffix), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `QQBot ${ensured.value}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return fail('unavailable', String(err?.name ?? 'upload-fetch-failed'), String(err?.message ?? err));
    }
    let text = '';
    try {
      text = await res.text();
    } catch (err) {
      text = `body-read-failed: ${String(err?.message ?? err)}`;
    }
    if (!res.ok) {
      if (text.includes(QUOTA_CODE)) return fail('rejected', QUOTA_CODE, 'daily upload quota exceeded (permanent)');
      if (text.includes(RETRYABLE_CODE)) return fail('unavailable', RETRYABLE_CODE, 'upload part transiently failed (retryable)');
      return fail(res.status >= 500 ? 'unavailable' : 'rejected', `http-${res.status}`, text.slice(0, 160));
    }
    if (text.length === 0) return ok({});
    try {
      return ok(JSON.parse(text));
    } catch (err) {
      return fail('transport', 'upload-bad-json', String(err?.message ?? err));
    }
  }

  /** 分片直传：不带 QQ 鉴权头（presigned URL 自带凭据）。 */
  async function putPart(presignedUrl, buffer) {
    try {
      const res = await fetchImpl(presignedUrl, {
        method: 'PUT',
        body: buffer,
        signal: AbortSignal.timeout(PART_PUT_TIMEOUT_MS),
      });
      if (!res.ok) return fail('unavailable', `http-${res.status}`, 'presigned part PUT failed');
      return ok(true);
    } catch (err) {
      return fail('unavailable', String(err?.name ?? 'part-put-failed'), String(err?.message ?? err));
    }
  }

  /**
   * 完整上传链：`upload_prepare` → 分片 PUT → `upload_part_finish`（带 upload_id）→ `/files`。
   * `/files` 正常走 `srv_send_msg:true`（服务端直接下发）；若响应里回带了 `file_info`
   * （说明服务端没有代发），则由发送层按 `msg_type:7` 自行投递 —— 该分支为防御性设计，真机未核（未验证项）。
   */
  async function uploadFile({ filePath, fileName, target, passiveMsgId }) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch (err) {
      return fail('not-found', 'stat-failed', String(err?.message ?? err));
    }
    if (!stat.isFile()) return fail('rejected', 'not-a-file', `${fileName} is not a regular file`);
    if (stat.size > MAX_UPLOAD_BYTES) {
      return fail('rejected', 'too-large', `${fileName} is ${stat.size} bytes > limit ${MAX_UPLOAD_BYTES}`);
    }
    const fileType = fileTypeOf(fileName);
    const hashes = await hashFile(filePath, stat.size);
    const prepared = await api(target, 'upload_prepare', {
      file_type: fileType,
      file_name: fileName,
      file_size: String(stat.size),
      md5: hashes.md5,
      sha1: hashes.sha1,
      md5_10m: hashes.md5_10m,
    });
    if (!prepared.ok) return prepared;
    const { upload_id: uploadId, block_size: responseBlockSize, parts = [] } = prepared.value ?? {};
    if (!uploadId) return fail('rejected', 'no-upload-id', 'upload_prepare returned no upload_id');
    const blockSize = Number(responseBlockSize) > 0 ? Number(responseBlockSize) : stat.size;

    for (const part of parts) {
      const index = Number(part.index ?? 1);
      const offset = (index - 1) * blockSize;
      const length = Math.min(Number(part.block_size ?? blockSize) || blockSize, stat.size - offset);
      if (length <= 0) continue;
      const buffer = await readRange(filePath, offset, length);
      const uploaded = await putPart(part.presigned_url, buffer);
      if (!uploaded.ok) return uploaded;
      let finished = fail('unavailable', RETRYABLE_CODE, 'part finish not attempted');
      for (let attempt = 1; attempt <= PART_FINISH_ATTEMPTS; attempt += 1) {
        finished = await api(target, 'upload_part_finish', {
          upload_id: uploadId,
          part_index: index,
          block_size: Number(part.block_size ?? blockSize) || blockSize,
          md5: createHash('md5').update(buffer).digest('hex'),
        });
        if (finished.ok) break;
        if (finished.code !== RETRYABLE_CODE) break;
        log?.warn?.('upload_part_finish retryable failure — retrying', { part: index, attempt });
        await sleep(clamp(attempt, 1, 5) * 1000);
      }
      if (!finished.ok) return finished;
    }

    // `file_name` 只在 file_type == 4（普通文件）时带（`adapter.py:2411-2428`）。
    const filesBody = { file_type: fileType, srv_send_msg: true, upload_id: uploadId };
    if (fileType === FILE_TYPE_FILE) filesBody.file_name = fileName;
    const completed = await api(target, 'files', filesBody);
    if (!completed.ok) return completed;
    const fileInfo = completed.value?.file_info ?? null;
    return ok({ uploadId, fileType, fileInfo, sentByServer: fileInfo === null, passiveMsgId });
  }

  return { uploadFile, apiPath, fileTypeOf };
}

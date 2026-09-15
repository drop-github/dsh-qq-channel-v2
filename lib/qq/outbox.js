// 发件箱（任务书 §1.7 / P1-11）：把文件丢进 `$DSH_HOME/storages/qq-channel-outbox/`，
// 插件自动分片上传并发送到 owner 私聊；成功移入 `sent/`，永久失败移入 `failed/`。
import fs from 'node:fs';
import path from 'node:path';
import { describe } from '../result.js';
import { QUOTA_CODE } from './upload.js';

export const POLL_INTERVAL_MS = 2000;
export const MAX_ATTEMPTS = 3;

export function createOutbox({ config, log, uploader, sender, dirs }) {
  let timer = null;
  let busy = false;
  let disposed = false;
  const attempts = new Map();     // 文件名 -> 已尝试次数
  const seenSizes = new Map();    // 文件名 -> 上一轮看到的字节数（写入完成判定）

  const ownerTarget = () => {
    if (!Array.isArray(config.allowedUsers) || config.allowedUsers.length === 0) return null;
    return { kind: 'c2c', openid: config.allowedUsers[0] };
  };

  function move(file, dir, name) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(file, path.join(dir, `${Date.now()}-${name}`));
      return true;
    } catch (err) {
      log?.error?.('outbox move failed', { dir, error: String(err?.message ?? err) });
      return false;
    }
  }

  async function handleFile(name, target) {
    const file = path.join(dirs.outbox, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (err) {
      log?.debug?.('outbox stat failed (file vanished?)', { error: String(err?.message ?? err) });
      return;
    }
    if (!stat.isFile()) return;
    // 写入完成判定：字节数连续两轮不变才处理（避免把半截文件传上去）。
    if (seenSizes.get(name) !== stat.size) {
      seenSizes.set(name, stat.size);
      return;
    }
    seenSizes.delete(name);
    const result = await uploader.uploadFile({ filePath: file, fileName: name, target });
    if (result.ok) {
      attempts.delete(name);
      // 上传返回 file_info 说明服务端没有代发 → 由发送层按 msg_type:7 自行投递。
      if (result.value?.fileInfo) {
        const delivered = await sender.sendMedia(target, result.value.fileInfo, {});
        if (!delivered.ok) {
          log?.error?.('media send after upload failed', { error: describe(delivered) });
          move(file, dirs.failed, name);
          return;
        }
      }
      if (move(file, dirs.sent, name)) log?.info?.('outbox file sent', { file: name, bytes: stat.size });
      return;
    }
    const permanent = result.code === QUOTA_CODE || result.reason === 'rejected';
    const tries = (attempts.get(name) ?? 0) + 1;
    attempts.set(name, tries);
    if (permanent || tries >= MAX_ATTEMPTS) {
      attempts.delete(name);
      log?.error?.('outbox file permanently failed', { file: name, tries, error: describe(result) });
      move(file, dirs.failed, name);
      return;
    }
    log?.warn?.('outbox attempt failed (transient) — will retry', { file: name, tries, error: describe(result) });
  }

  async function sweep() {
    if (disposed) return;
    if (busy) {
      log?.debug?.('outbox sweep still running — skipping tick');
      return;
    }
    const target = ownerTarget();
    if (!target) {
      log?.debug?.('outbox skipped: no allowedUsers configured (no send target)');
      return;
    }
    busy = true;
    try {
      let names = [];
      try {
        names = fs.readdirSync(dirs.outbox);
      } catch (err) {
        log?.debug?.('outbox directory not readable yet', { error: String(err?.message ?? err) });
        return;
      }
      for (const name of names) {
        if (disposed) return;
        await handleFile(name, target);
      }
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => {
        sweep().catch((err) => log?.error?.('outbox sweep crashed', { error: String(err?.stack ?? err) }));
      }, POLL_INTERVAL_MS);
      log?.info?.('outbox watcher started', { intervalMs: POLL_INTERVAL_MS });
    },
    sweep,
    stop() {
      disposed = true;
      clearInterval(timer);
      timer = null;
    },
  };
}

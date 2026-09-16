// 入站消息持久化队列。
//
// 事故背景（2026-09-16 18:50，v1.2.6 真机）：用户发来的 3 个 PDF + 1 条消息被插件存进
// 收件箱目录，然后宿主整体冻死 2.5 小时 —— 重发时机与全部上下文只活在那条**内存**里的
// Promise 链上，宿主一冻就永久丢失，重启也不会补发（用户侧表现："它没回我，那几条也没了"）。
//
// 本模块把"待处理入站"落成 **追加式 JSONL**：即使进程被杀，`prompt` 失败的消息仍在，
// 可在下次成功轮次作为前置上下文补发。内容块（含附件收件箱路径）原样保存。
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_INBOX_CAP = 50;
export const DEFAULT_INBOX_TTL_MS = 48 * 60 * 60 * 1000;

const OPS_FILE = 'qq-channel-pending.jsonl';
const SNAPSHOT_FILE = 'qq-channel-pending.json';

function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** 打开（或创建）一个持久化队列。所有写操作都是"先落盘、再改内存"。 */
export function createDurableInbox({
  dir,
  log = null,
  cap = DEFAULT_INBOX_CAP,
  ttlMs = DEFAULT_INBOX_TTL_MS,
} = {}) {
  const opsPath = dir ? path.join(dir, OPS_FILE) : null;
  const snapshotPath = dir ? path.join(dir, SNAPSHOT_FILE) : null;
  /** @type {Map<string, {msgId:string, sessionId:string, sourceKey:string, target:object, parts:object[], at:number, attempts:number}>} */
  const items = new Map();

  function appendOp(op) {
    if (!opsPath) return;
    try {
      fs.mkdirSync(path.dirname(opsPath), { recursive: true });
      fs.appendFileSync(opsPath, `${JSON.stringify(op)}\n`);
    } catch (error) {
      log?.warn?.('pending inbox append failed', { error: String(error?.message ?? error) });
    }
  }

  function writeSnapshot() {
    if (!snapshotPath) return;
    const records = [...items.values()];
    try {
      fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
      const tmp = `${snapshotPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, records }));
      fs.renameSync(tmp, snapshotPath);
    } catch (error) {
      log?.warn?.('pending inbox snapshot failed', { error: String(error?.message ?? error) });
    }
  }

  function normalize(record) {
    if (!record || typeof record !== 'object') return null;
    const msgId = typeof record.msgId === 'string' && record.msgId ? record.msgId : null;
    if (!msgId || typeof record.sessionId !== 'string' || !record.sessionId) return null;
    return {
      msgId,
      sessionId: record.sessionId,
      sourceKey: typeof record.sourceKey === 'string' ? record.sourceKey : '',
      target: record.target && typeof record.target === 'object' ? record.target : {},
      parts: Array.isArray(record.parts) ? record.parts : [],
      at: Number.isFinite(record.at) ? record.at : Date.now(),
      attempts: Number.isFinite(record.attempts) ? record.attempts : 0,
    };
  }

  function prune(now = Date.now()) {
    let removed = 0;
    for (const [msgId, item] of items) {
      if (now - item.at > ttlMs) {
        items.delete(msgId);
        removed += 1;
        appendOp({ op: 'remove', msgId });
      }
    }
    // 容量保护：丢最旧的（与 state.js 的队列语义一致：宁可丢最旧也不无限增长）
    while (items.size > cap) {
      const oldest = [...items.values()].sort((a, b) => a.at - b.at)[0];
      if (!oldest) break;
      items.delete(oldest.msgId);
      removed += 1;
      appendOp({ op: 'remove', msgId: oldest.msgId });
    }
    if (removed > 0) log?.warn?.('pending inbox pruned', { removed, size: items.size });
    return removed;
  }

  /** 启动恢复：快照 + 追加日志，后者以 `at` 较新者胜（崩溃时快照可能落后）。 */
  function restore(now = Date.now()) {
    let fromSnapshot = 0;
    if (snapshotPath && fs.existsSync(snapshotPath)) {
      try {
        const parsed = safeParse(fs.readFileSync(snapshotPath, 'utf8'));
        for (const raw of parsed?.records ?? []) {
          const item = normalize(raw);
          if (item) {
            items.set(item.msgId, item);
            fromSnapshot += 1;
          }
        }
      } catch (error) {
        log?.warn?.('pending inbox snapshot unreadable', { error: String(error?.message ?? error) });
      }
    }
    let fromOps = 0;
    if (opsPath && fs.existsSync(opsPath)) {
      try {
        for (const line of fs.readFileSync(opsPath, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          const op = safeParse(line);
          if (!op) continue;
          if (op.op === 'add') {
            const item = normalize(op.item);
            if (item) {
              const existing = items.get(item.msgId);
              // 同一 msgId 以较新的记录为准（重试会刷新 attempts/parts）
              if (!existing || item.at >= existing.at) items.set(item.msgId, item);
              fromOps += 1;
            }
          } else if (op.op === 'remove' && typeof op.msgId === 'string') {
            items.delete(op.msgId);
          }
        }
      } catch (error) {
        log?.warn?.('pending inbox op log unreadable', { error: String(error?.message ?? error) });
      }
    }
    const pruned = prune(now);
    if (items.size > 0) {
      log?.warn?.('pending inbound messages restored after restart', {
        size: items.size,
        fromSnapshot,
        fromOps,
      });
    }
    return { size: items.size, fromSnapshot, fromOps, pruned };
  }

  return {
    restore,
    /**
     * 记一条待处理入站。同 msgId 幂等（重复投递只刷新，不叠加）。
     * `now` 可注入：调用点若自带业务时间戳，过期判定必须用同一时间基准，
     * 否则测试/回放里"过去的消息"会被立刻当成过期删掉。
     */
    add({ msgId, sessionId, sourceKey = '', target = {}, parts = [], at = Date.now(), now = Date.now() }) {
      if (!msgId || !sessionId) return false;
      const existing = items.get(msgId);
      items.set(msgId, {
        msgId,
        sessionId,
        sourceKey,
        target,
        parts,
        at: existing?.at ?? at,
        attempts: (existing?.attempts ?? 0) + 1,
      });
      appendOp({ op: 'add', item: items.get(msgId) });
      prune(now);
      return true;
    },
    remove(msgId) {
      if (!items.has(msgId)) return false;
      items.delete(msgId);
      appendOp({ op: 'remove', msgId });
      return true;
    },
    /** 取某个会话的待处理项（按时间升序）；不删除，成功后才 remove。 */
    list(sessionId = null, now = Date.now()) {
      prune(now);
      return [...items.values()]
        .filter((item) => (sessionId ? item.sessionId === sessionId : true))
        .sort((a, b) => a.at - b.at);
    },
    size: () => items.size,
    /** 快照（供自检/自检脚本判断"有没有没送达的东西"）。 */
    snapshot: () => [...items.values()].sort((a, b) => a.at - b.at).map((item) => ({
      msgId: item.msgId,
      sessionId: item.sessionId,
      at: item.at,
      attempts: item.attempts,
      parts: item.parts.length,
    })),
    /** 测试用：把内存与磁盘一起清空。 */
    clear() {
      items.clear();
      for (const file of [opsPath, snapshotPath]) {
        try {
          if (file && fs.existsSync(file)) fs.rmSync(file, { force: true });
        } catch {
          /* ignore */
        }
      }
    },
    /** 只在显式需要时落快照（启动恢复后 / 大批变更后），避免每次 add 都写整份。 */
    compact() {
      writeSnapshot();
      if (opsPath && fs.existsSync(opsPath)) {
        try {
          fs.rmSync(opsPath, { force: true });
        } catch {
          /* ignore */
        }
      }
      return items.size;
    },
    paths: () => ({ opsPath, snapshotPath }),
  };
}

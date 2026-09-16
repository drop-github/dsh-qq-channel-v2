// 多实例锁：同一个 QQ 机器人只能被一个 dsh 实例驱动。
//
// 为什么需要（v1 有、v2 漏了，2026-09-17 补回）：两个 `dsh web` 同时连同一个 bot 会互相踢下线、
// 抢消息。v1 的做法是 `qq-channel.lock` 里写 {pid, at}，**以 PID 存活为准**（不看时间窗口），
// 持有者每 30s 刷新 `at`；这里保持同一语义，只是把依赖注入出来以便单测。
import fs from 'node:fs';
import path from 'node:path';

export const LOCK_HEARTBEAT_MS = 30000;

/** 默认存活探测：EPERM 说明进程存在但不可控，仍算活着。 */
function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * 建一把实例锁。
 * @param {object} options - 锁文件、日志与可注入的探测/文件系统（测试用）。
 * @returns {object} `{ acquire, release, isHeld, file }`。
 */
export function createInstanceLock({
  file,
  log = null,
  pid = process.pid,
  heartbeatMs = LOCK_HEARTBEAT_MS,
  isAlive = defaultIsAlive,
  fsApi = fs,
} = {}) {
  let timer = null;
  let held = false;

  function read() {
    try {
      const value = JSON.parse(fsApi.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;   // 不存在 / 坏文件：都按"没有锁"处理
    }
  }

  function write() {
    fsApi.mkdirSync(path.dirname(file), { recursive: true });
    fsApi.writeFileSync(file, JSON.stringify({ pid, at: Date.now() }));
  }

  return {
    /**
     * 抢锁。持有者是**另一个存活进程**时拒绝；陈旧锁（持有者已死）直接接管；
     * 锁文件不可写时降级为无锁放行（与 v1 一致：宁可两个实例互踢，也不要一个都起不来）。
     */
    acquire() {
      const current = read();
      const otherPid = Number.isInteger(current?.pid) ? current.pid : null;
      if (otherPid !== null && otherPid !== pid && isAlive(otherPid)) {
        return { ok: false, holder: otherPid, reason: 'held-by-live-process' };
      }
      const tookOverFrom = otherPid !== null && otherPid !== pid ? otherPid : null;
      try {
        write();
      } catch (err) {
        log?.warn?.('instance lock not writable — continuing unlocked', { file, error: String(err?.message ?? err) });
        return { ok: true, holder: pid, degraded: true, tookOverFrom };
      }
      held = true;
      if (heartbeatMs > 0) {
        timer = setInterval(() => {
          try {
            write();
          } catch { /* 心跳失败不改状态：下一轮还会试 */ }
        }, heartbeatMs);
        timer.unref?.();
      }
      return { ok: true, holder: pid, tookOverFrom };
    },
    /** 放锁：只删自己写的那把，别人接管过的锁不动。 */
    release() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      const wasHeld = held;
      held = false;
      if (!wasHeld) return false;
      const current = read();
      if (Number.isInteger(current?.pid) && current.pid !== pid) return false;
      try {
        fsApi.rmSync(file, { force: true });
        return true;
      } catch (err) {
        log?.warn?.('instance lock release failed', { file, error: String(err?.message ?? err) });
        return false;
      }
    },
    isHeld: () => held,
    file,
  };
}

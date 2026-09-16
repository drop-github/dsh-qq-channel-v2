// 卡死存活看门狗（主线程侧）。
//
// 职责有两件事，都只依赖**同步**能力（主线程被独占时异步能力全部失效）：
//   1. 用 `perf_hooks.monitorEventLoopDelay()` 观测事件循环延迟；
//   2. 用**细粒度时间戳**记录在飞的 DSH RPC —— 宿主挂起时"哪个请求挂了多久"是最有力的证据。
//
// 心跳节流到 `heartbeatIntervalMs`：postMessage 本身要排进主线程事件循环，
// 每 5s 一次在正常运行时开销可忽略，卡死时也恰好让 Worker 看到"最后一次活着的姿态"。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { renderStallReport } from './watchdog-worker.js';

export const DEFAULT_STALL_AFTER_MS = 30000;
export const DEFAULT_FATAL_AFTER_MS = 120000;
export const DEFAULT_HEARTBEAT_MS = 5000;
export { renderStallReport };

function relative(from, to) {
  if (!from || !to) return null;
  if (to === from) return 0;
  if (to.startsWith(from)) {
    const rest = to.slice(from.length);
    return rest.startsWith('/') ? `.${rest}` : `./${rest}`;
  }
  try {
    return path.relative(from, to) || './';
  } catch {
    return null;
  }
}

/** 在飞请求表：start/end 成对，snapshot 取"最老的几个"（卡死时最老的那个就是元凶候选）。 */
export function createInflightTracker({ cap = 32 } = {}) {
  const items = new Map();
  let nextId = 1;
  return {
    start(label, now = Date.now()) {
      const id = nextId;
      nextId += 1;
      items.set(id, { id, label: String(label ?? ''), startedAt: now });
      // 上限保护：异常路径下也不能让这张表无限长大
      if (items.size > cap) {
        const oldest = items.keys().next().value;
        items.delete(oldest);
      }
      return id;
    },
    end(id) {
      items.delete(id);
    },
    snapshot(now = Date.now(), limit = 8) {
      return [...items.values()]
        .sort((a, b) => a.startedAt - b.startedAt)
        .slice(0, limit)
        .map((item) => ({
          label: item.label,
          msAgo: Math.max(0, now - item.startedAt),
          at: item.startedAt,
        }));
    },
    size() {
      return items.size;
    },
    clear() {
      items.clear();
    },
  };
}

/**
 * 启动看门狗。返回 `{ stop, beat, inflight, sinkPath }`。
 * `workerFactory` 仅供测试注入（默认 `new Worker(new URL('./watchdog-worker.js', import.meta.url))`）。
 */
export function createWatchdog({
  dir,
  stallAfterMs = DEFAULT_STALL_AFTER_MS,
  fatalAfterMs = DEFAULT_FATAL_AFTER_MS,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_MS,
  log = null,
  workerFactory = null,
  procStartMs = Date.now(),
} = {}) {
  const sinkPath = dir ? path.join(dir, 'qq-channel-stall.log') : null;
  const inflight = createInflightTracker();
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  let worker = null;
  let timer = null;
  let disposed = false;
  let lastBeatAt = 0;
  const faults = [];

  const lagMs = () => {
    const mean = histogram.mean;
    return Number.isFinite(mean) ? Math.round(mean / 1e6) : 0;
  };

  const render = (reason, silentMs, now = Date.now()) => renderStallReport({
    reason,
    silentMs,
    nowMs: now,
    beats: [],
    sample: { lagMs: lagMs(), inflight: inflight.snapshot(now) },
    procStartMs,
  });

  /** 同步落盘（主线程侧兜底）：Worker 起不来时至少还能留下"谁挂了"。 */
  const appendSync = (lines) => {
    if (!sinkPath) return;
    try {
      fs.mkdirSync(path.dirname(sinkPath), { recursive: true });
      fs.appendFileSync(sinkPath, `${lines.join('\n')}\n`);
    } catch (error) {
      faults.push(String(error?.message ?? error));
      log?.warn?.('watchdog stall log write failed', { error: String(error?.message ?? error) });
    }
  };

  const beat = (now = Date.now()) => {
    lastBeatAt = now;
    worker?.postMessage({ type: 'beat', at: now, lagMs: lagMs(), inflight: inflight.snapshot(now) });
  };

  try {
    const factory = workerFactory ?? ((spec) => new Worker(new URL('./watchdog-worker.js', import.meta.url), spec));
    worker = factory({
      workerData: { sinkPath, stallAfterMs, fatalAfterMs, heartbeatIntervalMs, procStartMs },
    });
    worker.on?.('error', (error) => {
      log?.warn?.('watchdog worker failed — falling back to main-thread checks', {
        error: String(error?.message ?? error),
      });
      worker = null;
    });
    worker.unref?.();
  } catch (error) {
    log?.warn?.('watchdog worker unavailable — falling back to main-thread checks', {
      error: String(error?.message ?? error),
    });
    worker = null;
  }

  // 主线程兜底检查：Worker 正常时只做心跳；Worker 起不来时它退化为"延迟自身也变大"的自查。
  timer = setInterval(() => {
    if (disposed) return;
    const now = Date.now();
    if (!worker) {
      const silent = now - lastBeatAt;
      if (silent >= stallAfterMs) {
        appendSync(render('event-loop stall (main-thread check)', silent, now));
        lastBeatAt = now;   // 不刷屏：下一轮重新计时
        return;
      }
    }
    beat(now);
  }, heartbeatIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  beat();
  if (!worker && sinkPath) {
    // Worker 不可用时立刻留一条启动记录：主线程兜底依赖定时器，而定时器正是卡死时会失效的东西，
    // 所以"看门狗已进入降级模式"这件事本身必须马上落盘，不能等第一次疑似卡死。
    appendSync(render('watchdog running WITHOUT worker thread (degraded: only main-thread checks)', 0, Date.now()));
  }

  return {
    sinkPath,
    beat,
    inflight: {
      start: (label) => inflight.start(label),
      end: (id) => inflight.end(id),
      size: () => inflight.size(),
    },
    /** 测试/诊断用：手动取一次渲染结果（不落盘）。 */
    render,
    /** 降级路径的落盘失败原因（正常为空）。 */
    faults: () => [...faults],
    stop() {
      if (disposed) return;
      disposed = true;
      if (timer) clearInterval(timer);
      histogram.disable();
      try {
        worker?.terminate?.();
      } catch {
        /* ignore */
      }
      worker = null;
    },
  };
}

/**
 * 给任意"返回 Promise 的 RPC"套上在飞登记。不改语义，只让挂起可见。
 */
export function trackInflight(watchdog, label, fn) {
  const track = watchdog?.inflight;
  if (!track) return fn();
  const id = track.start(label);
  let result;
  try {
    result = fn();
  } catch (error) {
    track.end(id);
    throw error;
  }
  if (result && typeof result.then === 'function') {
    return result.then(
      (value) => {
        track.end(id);
        return value;
      },
      (error) => {
        track.end(id);
        throw error;
      },
    );
  }
  track.end(id);
  return result;
}

export { relative };

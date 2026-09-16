// 卡死存活看门狗（Worker 线程侧）。
//
// 为什么必须独立线程：真机事故（2026-09-16 10:51Z–13:21Z）里宿主 Node 主线程被长时间
// 同步操作独占，**同一线程上的任何定时器与日志都写不出来**，于是 2.5 小时零证据。
// Worker 有自己的事件循环，主线程再死它也能跑 → 唯一能在"卡死当时"落盘的角色。
//
// 判定：主线程通过 postMessage 心跳（自己也节流到 HEARTBEAT_INTERVAL_MS）。
//   silentMs < STALL_AFTER_MS            → 健康，丢弃旧样本
//   STALL_AFTER_MS <= silentMs < FATAL   → 记一次 stall（主线程还能自己恢复）
//   silentMs >= FATAL_AFTER_MS           → 记 fatal（进程已不可用，重启是唯一出路）
import { parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs';

const {
  sinkPath,
  stallAfterMs = 30000,
  fatalAfterMs = 120000,
  heartbeatIntervalMs = 5000,
  ringSize = 200,
  procStartMs = Date.now(),
} = workerData ?? {};

const ring = [];
let lastBeatAt = Date.now();
let lastSample = null;
let reportedStall = false;
let reportedFatal = false;
let timer = null;

function trim(value) {
  const text = String(value ?? '');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function sampleSummary(sample) {
  if (!sample) return 'none';
  const inflight = Array.isArray(sample.inflight) ? sample.inflight : [];
  const oldest = inflight.reduce((max, item) => Math.max(max, Number(item?.msAgo ?? 0)), 0);
  // 把"最老的那个在飞请求"直接写进摘要：卡死报告里最有价值的一行就是它。
  const head = inflight.reduce(
    (best, item) => (best === null || Number(item?.msAgo ?? 0) > Number(best?.msAgo ?? 0) ? item : best),
    null,
  );
  const detail = head ? ` oldest=(${trim(head.label)} @${head.msAgo}ms)` : '';
  return `loopLagMs=${sample.lagMs ?? '?'} liveRequests=${inflight.length} oldestInflightMs=${oldest}${detail}`;
}

function inflightLines(sample) {
  const inflight = Array.isArray(sample?.inflight) ? sample.inflight : [];
  if (inflight.length === 0) return ['  inflight: none'];
  return inflight
    .slice(0, 12)
    .map((item) => `  inflight ${item?.msAgo ?? '?'}ms: ${trim(item?.label)}`);
}

function append(lines) {
  if (!sinkPath) return;
  try {
    fs.mkdirSync(sinkPath.slice(0, Math.max(sinkPath.lastIndexOf('/'), sinkPath.lastIndexOf('\\'))), { recursive: true });
    fs.appendFileSync(sinkPath, `${lines.join('\n')}\n`);
  } catch {
    /* 落盘失败也不能把看门狗弄死：它已经是最后一道观测手段了 */
  }
}

/** 纯函数：把"卡死当时"的环形缓冲 + 心跳状态渲染成可 grep 的报告行。导出给测试直接用。 */
export function renderStallReport({ reason, silentMs, nowMs = Date.now(), beats = [], sample = null, procStartMs: startMs = 0 } = {}) {
  const lines = [];
  lines.push(
    `[${new Date(nowMs).toISOString()}] ${reason} silentMs=${silentMs} `
    + `uptimeMs=${nowMs - startMs} beatsInRing=${beats.length}`,
  );
  lines.push(`  current: ${sampleSummary(sample)}`);
  lines.push(...inflightLines(sample));
  // 倒序：最近的样本最有价值（旧的往往还是健康时的数据）
  for (let i = beats.length - 1; i >= 0; i -= 1) {
    const beat = beats[i];
    const age = Math.max(0, nowMs - Number(beat?.at ?? nowMs));
    lines.push(`  -${age}ms ${sampleSummary(beat)}`);
  }
  return lines;
}

function renderLocal(silentMs, nowMs) {
  return renderStallReport({
    reason: 'event-loop stall',
    silentMs,
    nowMs,
    beats: ring,
    sample: lastSample,
    procStartMs,
  });
}

function tick() {
  const now = Date.now();
  const silentMs = now - lastBeatAt;
  if (silentMs >= fatalAfterMs) {
    if (!reportedFatal) {
      reportedFatal = true;
      append(renderStallReport({
        reason: 'FATAL: host thread unresponsive — restart required',
        silentMs,
        nowMs: now,
        beats: ring,
        sample: lastSample,
        procStartMs,
      }));
    }
    return;
  }
  if (silentMs >= stallAfterMs) {
    if (!reportedStall) {
      reportedStall = true;
      append(renderStallReport({
        reason: 'event-loop stall detected',
        silentMs,
        nowMs: now,
        beats: ring,
        sample: lastSample,
        procStartMs,
      }));
    }
    return;
  }
  // 心跳恢复 → 复位告警，下一轮卡死还能再记一次（同一进程内可多次卡死）
  if (reportedStall || reportedFatal) {
    append([`[${new Date(now).toISOString()}] host thread recovered silentMs=${silentMs}`]);
    reportedStall = false;
    reportedFatal = false;
  }
}

parentPort?.on('message', (message) => {
  if (!message || message.type !== 'beat') return;
  lastBeatAt = Number(message.at ?? Date.now());
  lastSample = message;
  ring.push({ at: lastBeatAt, lagMs: message.lagMs, inflight: message.inflight });
  if (ring.length > ringSize) ring.shift();
});

parentPort?.on('close', () => {
  if (timer) clearInterval(timer);
});

timer = setInterval(tick, Math.max(1000, Math.floor(stallAfterMs / 4)));
if (typeof timer.unref === 'function') timer.unref();

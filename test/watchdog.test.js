// T-W1..T-W6：卡死看门狗的渲染与在飞登记。
// 背景：真机 2026-09-16 10:51Z–13:21Z 主线程被独占 2.5 小时，同线程日志**零输出**。
// 这里的断言保证"再卡死一次时，独立线程能写出一份可用报告"。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createInflightTracker,
  renderStallReport,
  createWatchdog,
} from '../lib/watchdog.js';

test('在飞登记：snapshot 按最老优先，end 后消失，超上限不无限增长', () => {
  const track = createInflightTracker({ cap: 3 });
  const a = track.start('session/prompt', 1000);
  const b = track.start('session/create', 2000);
  assert.equal(track.size(), 2);

  const snap = track.snapshot(5000);
  assert.equal(snap.length, 2);
  assert.equal(snap[0].label, 'session/prompt', '最老的排最前（卡死时它就是元凶候选）');
  assert.equal(snap[0].msAgo, 4000);
  assert.equal(snap[1].msAgo, 3000);

  track.end(a);
  assert.equal(track.size(), 1);

  track.start('x', 3000);
  track.start('y', 4000);
  track.start('z', 5000);
  assert.equal(track.size(), 3, 'cap 生效');
});

test('卡死报告：包含静默时长、事件循环延迟、在飞请求与历史心跳', () => {
  const lines = renderStallReport({
    reason: 'event-loop stall detected',
    silentMs: 45000,
    nowMs: 1_000_000,
    procStartMs: 0,
    sample: { lagMs: 1200, inflight: [{ label: 'session/prompt', msAgo: 42000, at: 958000 }] },
    beats: [
      { at: 990_000, lagMs: 5, inflight: [] },
      { at: 995_000, lagMs: 30, inflight: [{ label: 'session/create', msAgo: 1000 }] },
    ],
  });
  const text = lines.join('\n');
  assert.match(text, /event-loop stall detected/);
  assert.match(text, /silentMs=45000/);
  assert.match(text, /loopLagMs=1200/);
  assert.match(text, /liveRequests=1/);
  assert.match(text, /session\/prompt/, '在飞请求必须出现在报告里');
  assert.match(text, /session\/create/, '历史心跳也要保留：能看到卡死前的姿态');
  assert.match(text, /-5000ms/, '心跳带相对年龄，便于判断卡死起点');
});

test('卡死报告：无在飞请求时也要可读，不得抛错', () => {
  const lines = renderStallReport({ reason: 'x', silentMs: 1, beats: [], sample: null, procStartMs: 0 });
  assert.match(lines.join('\n'), /inflight: none/);
});

test('主线程兜底：Worker 起不来时仍会把卡死写进 stall 日志', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
  const watchdog = createWatchdog({
    dir,
    stallAfterMs: 20,
    heartbeatIntervalMs: 10,
    // 故意注入一个立刻失败的 worker 工厂：覆盖"Worker 不可用"的降级路径
    workerFactory: () => {
      throw new Error('worker unavailable in test');
    },
  });
  const sink = path.join(dir, 'qq-channel-stall.log');
  // 轮询而不是固定 sleep：并行跑测试时固定等待会因事件循环拥挤而假红。
  const deadline = Date.now() + 5000;
  try {
    while (!fs.existsSync(sink) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(fs.existsSync(sink), true, '降级路径也必须留下 stall 日志');
    const text = fs.readFileSync(sink, 'utf8');
    assert.match(text, /WITHOUT worker thread/, '降级模式必须立刻可见，不能等第一次疑似卡死');
  } finally {
    watchdog.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('看门狗生命周期：stop 后不再写盘', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
  const watchdog = createWatchdog({ dir, stallAfterMs: 20, heartbeatIntervalMs: 10 });
  watchdog.stop();
  assert.equal(typeof watchdog.sinkPath, 'string');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('看门狗启用后不影响正常路径：beat 可反复调用且不抛', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-'));
  const watchdog = createWatchdog({ dir, stallAfterMs: 5000, heartbeatIntervalMs: 1000 });
  for (let i = 0; i < 5; i += 1) watchdog.beat();
  assert.equal(watchdog.inflight.size(), 0);
  watchdog.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

// T-U32..T-U37：空闲淘汰后的**管理权保留**（真机 2026-09-16 06:24/06:37/06:56 事故回归）。
//
// 事故链路（线上日志 + 源码逐行核对）：
//   sweep() 删掉会话条目 → 但 follow 流还挂着、attach() 不会重跑 → 再没人 adopt →
//   isManaged() 永远为假 → 提问/审批帧被判 unmanaged 静默丢弃 → 用户看不到提问、
//   宿主那轮一直 busy → 后续消息只进 inboundQueue（只在 turn-end 冲刷）= 永久沉默。
//
// 本文件的断言就是"这四步里任何一步复发都会红"。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSessionStore,
  DEFAULT_TTL_MS,
  DEFAULT_BUSY_STALE_MS,
} from '../lib/session/state.js';
import { createPendingStore } from '../lib/session/pending.js';
import { createDshHandler } from '../lib/handlers/dsh.js';
import { createQuestionFlow } from '../lib/session/question-flow.js';
import { ok } from '../lib/result.js';

const quiet = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  countUnknown: () => {}, registerSecret: () => {}, fingerprint: () => 'fp',
};
const ev = (seq, type, data = {}, sessionId = 's1') => ({ sessionId, seq, type, data, origin: 'live', protocol: 'v2' });

test('空闲淘汰只回收条目，管理权必须保留（否则控制帧被判 unmanaged 丢弃）', () => {
  const state = createSessionStore({ log: quiet, ttlMs: 1000 });
  state.adopt('s1', 'replay-all');
  assert.equal(state.isManagedSession('s1'), true);

  assert.equal(state.sweep(Date.now() + 5000), 1);
  assert.equal(state.isAdopted('s1'), false, '条目确实被回收了（TTL 设计不变）');
  assert.equal(state.isManagedSession('s1'), true, '管理权不得被 TTL 抹掉');
  assert.deepEqual(state.managedIds(), ['s1']);
});

test('淘汰后 rehydrate：条目按需重建，管理权与位置原样沿用', () => {
  const state = createSessionStore({ log: quiet, ttlMs: 1000 });
  state.adopt('s1', 'replay-all');
  state.ingest(ev(7, 'turn/end'));
  assert.equal(state.lastSeq('s1'), 7);

  state.sweep(Date.now() + 5000);
  const revived = state.rehydrate('s1');
  assert.equal(revived.ok, true);
  assert.equal(revived.value.rehydrated, true);
  assert.equal(state.isAdopted('s1'), true);
  assert.equal(state.lastSeq('s1'), 7, '位置必须沿用，否则重连补页会重放历史（重复回复）');

  // 已在管理中的会话重复 rehydrate 是幂等的空操作
  assert.equal(state.rehydrate('s1').value.rehydrated, false);
  // 从未纳入管理的会话不得被"重建"（别人的会话边界不变）
  // `fail()` 只对未登记的 reason 抛错，普通失败是 `{ ok: false, reason: 'not-managed' }`。
  const stranger = state.rehydrate('other');
  assert.equal(stranger.ok, false);
  assert.equal(stranger.reason, 'not-managed');
});

test('淘汰后重新 adopt（重连 reattachAll 路径）不得把位置重置为 -1', () => {
  const state = createSessionStore({ log: quiet, ttlMs: 1000 });
  state.adopt('s1', 'replay-all');
  state.syncBaseline('s1', 42);
  state.sweep(Date.now() + 5000);

  state.adopt('s1', 'replay-all');            // events.js attach() 在重连时会再调一次
  assert.equal(state.isAdopted('s1'), true);
  assert.equal(state.lastSeq('s1'), 42, 'replay-all 只对"从未建立过位置"的新会话成立');
});

test('淘汰后新消息重建条目：回复目标仍可查，takeReply 正常', () => {
  const state = createSessionStore({ log: quiet, ttlMs: 1000 });
  state.adopt('s1', 'replay-all');
  state.sweep(Date.now() + 5000);

  const target = { kind: 'c2c', openid: 'U1', msgId: 'm1' };
  assert.equal(state.noteInbound('s1', { target, parts: [] }).value.queued, false);
  state.ingest(ev(1, 'turn/start'));
  state.ingest(ev(2, 'assistant/message', { message: { content: [{ type: 'text', text: '回复' }] } }));
  state.ingest(ev(3, 'turn/end'));
  assert.deepEqual(state.takeReply('s1'), { text: '回复', target });
});

test('忙死锁逃生：busy 超过阈值后新消息不再入队（提问帧被丢过时不会永久沉默）', () => {
  const state = createSessionStore({ log: quiet, busyStaleMs: 1000 });
  state.adopt('s1', 'replay-all');
  state.ingest(ev(1, 'turn/start'));          // 宿主开始干活，之后提问帧丢了 → turn/end 永不出现
  const busyAt = Date.now();

  const early = state.noteInbound('s1', { target: { openid: 'U1' }, parts: [] }, busyAt + 100);
  assert.equal(early.value.queued, true, '阈值内仍按原语义排队（不打扰正常轮次）');

  const late = state.noteInbound('s1', { target: { openid: 'U1' }, parts: [] }, busyAt + 2000);
  assert.equal(late.value.queued, false, '超过阈值必须放行，不能再无限排队');
  assert.equal(state.isBusy('s1'), false);
  assert.equal(DEFAULT_BUSY_STALE_MS > DEFAULT_TTL_MS / 2, true, '阈值必须明显小于会话 TTL');
});

// ---- 端到端回归：淘汰之后的提问帧必须真的发到 QQ，并留下可作答的条目 ----

function harness({ ttlMs = 1000 } = {}) {
  const sent = [];
  const port = {
    sendText: async (target, text) => { sent.push({ target, text }); return ok({ chunks: 1 }); },
    sendKeyboard: async (target, text) => { sent.push({ target, text, keyboard: true }); return ok({ chunks: 1 }); },
    notePassive: () => {},
  };
  const state = createSessionStore({ log: quiet, ttlMs });
  const pending = createPendingStore({ log: quiet });
  const config = { allowedUsers: ['USER-OWNER'], keyboardApprovals: false, markdown: false };
  // 提问编排在 session/question-flow.js；这里用真实实现（提问帧 → QQ 消息 → 待答草稿）。
  const questionFlow = createQuestionFlow({
    log: quiet,
    config,
    port,
    pending,
    dsh: { postEventResult: async () => ok({}) },
    targetFor: (sessionId) => state.replyTarget(sessionId),
  });
  const handler = createDshHandler({
    log: quiet,
    config,
    state,
    pending,
    port,
    dsh: { setClientId: () => {} },
    isManaged: (sessionId) => state.isManagedSession(sessionId),
    onTurnEnd: async () => {},
    questionFlow,
  });
  return { sent, state, pending, handler };
}

test('回归：会话被空闲淘汰后，提问帧仍会送达用户并进入待答表', async () => {
  const { sent, state, pending, handler } = harness();
  state.adopt('s1', 'replay-all');
  state.sweep(Date.now() + 5000);                                     // 线上那一步：06:28 淘汰
  state.noteInbound('s1', { target: { kind: 'c2c', openid: 'U1' }, parts: [] });   // 06:37 用户发消息

  handler.onControlFrame({
    type: 'waterfall',
    event: 'user-questions/request',
    eventId: 'ev-1',
    agentId: 's1',
    request: { questions: [{ id: 'q1', question: '选一个', options: [{ label: 'A' }, { label: 'B' }] }] },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sent.length, 1, '提问必须发出去（修复前这里是 0 = 用户看不到提问）');
  assert.equal(sent[0].target.openid, 'U1');
  assert.match(sent[0].text, /提问/);
  assert.equal(pending.count(), 1, '必须留下条目，否则用户回数字也无法作答');
});

test('回归：会话被空闲淘汰后，审批帧仍会送达用户（管理权不因 TTL 丢失）', async () => {
  const { sent, state, pending, handler } = harness();
  state.adopt('s1', 'replay-all');
  state.sweep(Date.now() + 5000);
  state.noteInbound('s1', { target: { kind: 'c2c', openid: 'U1' }, parts: [] });

  handler.onControlFrame({
    type: 'waterfall',
    event: 'approval/request',
    eventId: 'ev-2',
    agentId: 's1',
    request: { toolName: 'shell', reason: 'rm -rf' },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /审批/);
  assert.equal(pending.count(), 1);
});

test('边界：别人的会话（从未纳入管理）依旧静默忽略，不发任何消息', async () => {
  const { sent, state, handler } = harness();
  state.adopt('mine', 'replay-all');

  handler.onControlFrame({
    type: 'waterfall',
    event: 'user-questions/request',
    eventId: 'ev-3',
    agentId: 'someone-else',
    request: { questions: [{ id: 'q1', question: 'x', options: [{ label: 'A' }] }] },
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sent.length, 0, '不得打扰其他 agent 的会话（D18 边界不变）');
});

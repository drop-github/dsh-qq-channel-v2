// T-U11..T-U31：会话状态机（白名单/幂等/轮次）、基线、审批条目（配对/cancel/TTL）、事件泵缺口补齐。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore, EVENT_WHITELIST, assistantText } from '../lib/session/state.js';
import { createPendingStore } from '../lib/session/pending.js';
import { createEventPump, normalizeEvent } from '../lib/session/events.js';
import { ok, fail } from '../lib/result.js';

const quiet = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
  countUnknown: () => {}, registerSecret: () => {}, fingerprint: () => 'fp',
};
const counters = () => {
  const seen = new Map();
  return { ...quiet, countUnknown: (type) => seen.set(type, (seen.get(type) ?? 0) + 1), seen };
};

const ev = (seq, type, data = {}, sessionId = 's1') => ({ sessionId, seq, type, data, origin: 'live', protocol: 'v2' });

test('白名单：只处理 5 类事件，其余静默 + 计数，不报错不断流（T-U31 / D18 / AC11）', () => {
  const log = counters();
  const state = createSessionStore({ log });
  const noise = ['user/message', 'system/message', 'session/title', 'session/title-llm-request',
    'step/start', 'step/end', 'request/header', 'request/context', 'agent/inbox/spliced', 'never-seen-before'];
  noise.forEach((type, index) => {
    const result = state.ingest(ev(index, type));
    assert.equal(result.ok, true);
    assert.equal(result.value.kind, 'ignored');
  });
  assert.equal(EVENT_WHITELIST.length, 5);
  assert.equal(state.isBusy('s1'), false);
  for (const type of noise) assert.ok(log.seen.get(type) >= 1, `${type} 应被计数`);
});

test('user/message 与 system/message 不得变成回复正文（唯一文本来源是 assistant/message）', () => {
  const state = createSessionStore({ log: quiet });
  state.ingest(ev(0, 'turn/start'));
  state.ingest(ev(1, 'user/message', { message: { content: [{ type: 'text', text: '用户自己的话' }] } }));
  state.ingest(ev(2, 'system/message', { message: { content: [{ type: 'text', text: '系统噪声' }] } }));
  state.ingest(ev(3, 'assistant/message', { message: { content: [{ type: 'text', text: '真正的回复' }] } }));
  state.ingest(ev(4, 'turn/end'));
  const reply = state.takeReply('s1');
  assert.equal(reply.text, '真正的回复');
});

test('seq 幂等 + seq 倒退（宿主日志被重建）必须重置基线而不是永久丢弃（A24）', () => {
  const state = createSessionStore({ log: quiet });
  state.ingest(ev(0, 'turn/start'));
  state.ingest(ev(1, 'assistant/message', { message: { content: [{ type: 'text', text: 'A' }] } }));
  assert.equal(state.ingest(ev(1, 'assistant/message')).value.kind, 'duplicate');   // 同一 seq 重复
  state.ingest(ev(2, 'turn/end'));
  assert.equal(state.takeReply('s1').text, 'A');

  // 日志被截断：新的 turn 从 seq 1 重新开始
  assert.equal(state.ingest(ev(1, 'turn/start')).value.kind, 'turn-start');
  state.ingest(ev(2, 'assistant/message', { message: { content: [{ type: 'text', text: 'B' }] } }));
  state.ingest(ev(3, 'turn/end'));
  assert.equal(state.takeReply('s1').text, 'B', '重建后必须重新投递，不能当成重复');
});

test('轮次状态机 + 回复目标认领（turn/start 认领队头，turn/end 用认领的那个）', () => {
  const state = createSessionStore({ log: quiet });
  state.adopt('s1', 'skip-history');
  state.noteInbound('s1', { target: { kind: 'c2c', openid: 'U1' } });
  state.noteInbound('s1', { target: { kind: 'c2c', openid: 'U2' } });
  state.ingest(ev(0, 'turn/start'));
  state.ingest(ev(1, 'assistant/message', { message: { content: [{ type: 'text', text: '第一轮' }] } }));
  state.ingest(ev(2, 'turn/end'));
  const first = state.takeReply('s1');
  assert.equal(first.text, '第一轮');
  assert.equal(first.target.openid, 'U1');
  assert.equal(state.isBusy('s1'), false);
});

test('忙时入站进待发队列：有界、超限丢最旧并告警（P2-15/R8）', () => {
  const warnings = [];
  const log = { ...quiet, warn: (event, fields) => warnings.push({ event, fields }) };
  const state = createSessionStore({ log, queueCap: 3 });
  state.ingest(ev(0, 'turn/start'));
  for (let i = 0; i < 5; i += 1) state.noteInbound('s1', { target: { openid: `U${i}` }, parts: [] });
  const drained = state.drainInbound('s1');
  assert.equal(drained.length, 3, '必须被 queueCap 限制');
  assert.equal(drained[0].target.openid, 'U2', '丢的是最旧的');
  assert.equal(drained[2].target.openid, 'U4');
  assert.equal(warnings.filter((w) => w.event === 'inbound queue overflow — oldest dropped').length, 2);
  assert.equal(state.snapshot('s1').droppedInbound, 2);
});

test('prompt 失败回撤目标，避免后续轮次认领到未受理的入站（P1-2）', () => {
  const state = createSessionStore({ log: quiet });
  state.noteInbound('s1', { target: { openid: 'U1' } });
  state.noteInbound('s1', { target: { openid: 'U2' } });
  assert.equal(state.dropLastTarget('s1'), true);
  state.ingest(ev(0, 'turn/start'));
  state.ingest(ev(1, 'assistant/message', { message: { content: [{ type: 'text', text: 'x' }] } }));
  state.ingest(ev(2, 'turn/end'));
  assert.equal(state.takeReply('s1').target.openid, 'U1');
});

test('空闲 TTL 淘汰：busy 的会话不淘汰', () => {
  const state = createSessionStore({ log: quiet, ttlMs: 1000 });
  state.adopt('idle', 'skip-history');
  state.adopt('busy', 'skip-history');
  state.ingest(ev(0, 'turn/start', {}, 'busy'));
  assert.equal(state.sweep(Date.now() + 5000), 1);
  assert.deepEqual(state.ids(), ['busy']);
});

test('基线：skip-history 与首个 snapshot 对齐且不投递窗口；replay-all 投递全部（A12）', async () => {
  const actions = [];
  const client = {
    protocol: 'v2',
    attachSession: async () => ok({ streamId: 'st', cancel: () => {} }),
    page: async () => ok({ records: [], hasMore: false }),
  };
  const state = createSessionStore({ log: quiet });
  const pump = createEventPump({ client, state, onAction: (action) => actions.push(action), log: quiet });
  await pump.attach('s1', 'skip-history');
  await pump.reconcile('s1', { cursor: 100, records: [{ event: { seq: 40, type: 'assistant/message', data: {} } }] });
  assert.equal(actions.length, 0, '首次 snapshot 的历史不得被投递');
  assert.equal(state.lastSeq('s1'), 100);

  const state2 = createSessionStore({ log: quiet });
  const actions2 = [];
  const pump2 = createEventPump({ client, state: state2, onAction: (a) => actions2.push(a), log: quiet });
  await pump2.attach('s2', 'replay-all');
  await pump2.reconcile('s2', { cursor: 2, records: [{ event: { seq: 1, type: 'turn/start', data: {} } }, { event: { seq: 2, type: 'turn/end', data: {} } }] });
  assert.deepEqual(actions2.map((a) => a.kind), ['turn-start', 'turn-end']);
});

test('已有位置的会话再来首帧 snapshot（重连/换 pump）：不得再当历史丢掉，必须继续投递', async () => {
  const actions = [];
  const client = {
    protocol: 'v2',
    attachSession: async () => ok({ streamId: 'st', cancel: () => {} }),
    page: async () => ok({ records: [], hasMore: false }),
  };
  const state = createSessionStore({ log: quiet });
  state.adopt('s1', 'skip-history');
  state.syncBaseline('s1', 7);            // 已经处理到 seq 7
  const pump = createEventPump({ client, state, onAction: (a) => actions.push(a), log: quiet });
  await pump.reconcile('s1', { cursor: 9, records: [{ event: { seq: 8, type: 'turn/start', data: {} } }, { event: { seq: 9, type: 'turn/end', data: {} } }] });
  assert.deepEqual(actions.map((a) => a.seq), [8, 9]);
  assert.equal(state.lastSeq('s1'), 9);
});

test('缺口补齐：page 前翻补齐后才按序放行（T-U14 / §2.4.4）', async () => {
  const pages = [];
  const actions = [];
  const gapTypes = ['turn/start', 'assistant/message', 'turn/end', 'turn/start', 'assistant/message', 'turn/end'];
  const client = {
    protocol: 'v2',
    attachSession: async () => ok({ streamId: 'st', cancel: () => {} }),
    page: async (request) => {
      pages.push(request);
      return ok({
        records: gapTypes.map((type, index) => ({ event: { seq: index + 2, type, data: {} } })),
        hasMore: true,
      });
    },
  };
  const state = createSessionStore({ log: quiet });
  state.adopt('s1', 'replay-all');
  state.syncBaseline('s1', 1);
  const pump = createEventPump({ client, state, onAction: (a) => actions.push(a), log: quiet });
  const result = await pump.reconcile('s1', {
    cursor: 8,
    records: [{ event: { seq: 8, type: 'turn/start', data: {} } }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(pages.map((p) => [p.throughSeq, p.beforeSeq]), [[8, 8]]);
  assert.deepEqual(actions.map((a) => a.seq), [2, 3, 4, 5, 6, 7, 8], '补齐的旧事件必须先于窗口内事件放行');
  assert.equal(state.lastSeq('s1'), 8);
});

test('空日志 cursor=-1：不补页、不报错（T-U15）', async () => {
  const pages = [];
  const client = { protocol: 'v2', attachSession: async () => ok({ streamId: 'st', cancel: () => {} }), page: async (r) => { pages.push(r); return ok({ records: [], hasMore: false }); } };
  const state = createSessionStore({ log: quiet });
  state.adopt('s1', 'skip-history');
  const pump = createEventPump({ client, state, onAction: () => {}, log: quiet });
  const result = await pump.reconcile('s1', { cursor: -1, records: [] });
  assert.equal(result.ok, true);
  assert.equal(pages.length, 0);
  assert.equal(state.lastSeq('s1'), -1);
});

test('cursor 变小（宿主重建）→ 重置基线并重新对账', async () => {
  const state = createSessionStore({ log: quiet });
  state.adopt('s1', 'skip-history');
  state.syncBaseline('s1', 50);
  const actions = [];
  const client = { protocol: 'v2', attachSession: async () => ok({ streamId: 'st', cancel: () => {} }), page: async () => ok({ records: [], hasMore: false }) };
  const pump = createEventPump({ client, state, onAction: (a) => actions.push(a), log: quiet });
  await pump.reconcile('s1', { cursor: 1, records: [{ event: { seq: 1, type: 'turn/start', data: {} } }] });
  assert.equal(actions.length, 1, '重建后必须重新投递');
  assert.equal(actions[0].kind, 'turn-start');
});

test('normalizeEvent：sessionId 由流的归属注入，不读事件体里的同名字段（§2.3.2）', () => {
  const event = normalizeEvent('stream-session', { event: { seq: 3, type: 'turn/end', data: { sessionId: 'other-session' } } }, 'live');
  assert.equal(event.sessionId, 'stream-session');
  assert.equal(event.origin, 'live');
  assert.equal(normalizeEvent('s', { event: { type: 'x' } }, 'live'), null);
  assert.equal(assistantText({ data: { message: { content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] } } }), 'ab');
});

test('审批条目：无 eventId 的 waterfall 帧被拒且不写表（P1-8 / T-U22）', () => {
  const state = { errors: [] };
  const log = { ...quiet, error: (event) => state.errors.push(event) };
  const pending = createPendingStore({ log });
  const result = pending.addFromWaterfall({ eventId: undefined, sessionId: 's1', request: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rejected');
  assert.equal(pending.count(), 0, '毒帧不得写表');
  // 后续正常审批不受影响
  assert.equal(pending.addFromWaterfall({ eventId: 'e1', sessionId: 's1', request: { toolName: 'pwsh' } }).ok, true);
  assert.equal(pending.count(), 1);
});

test('审批审计配对：两种到达顺序都能配上（T-U21 / D5）', () => {
  const a = createPendingStore({ log: quiet });
  a.addFromWaterfall({ eventId: 'e1', sessionId: 's1', request: { toolName: 'pwsh' } });
  a.attachAudit({ sessionId: 's1', auditId: 'audit-1', toolName: 'pwsh' });
  assert.equal(a.get('e1').auditId, 'audit-1');

  const b = createPendingStore({ log: quiet });
  b.attachAudit({ sessionId: 's1', auditId: 'audit-2', toolName: 'pwsh' });    // 审计先到
  b.addFromWaterfall({ eventId: 'e2', sessionId: 's1', request: { toolName: 'pwsh' } });
  assert.equal(b.get('e2').auditId, 'audit-2');
});

test('电脑端处理：恰好一条通知；重复 decided 不再发（T-U23 / A7）', () => {
  const pending = createPendingStore({ log: quiet });
  pending.addFromWaterfall({ eventId: 'e1', sessionId: 's1', request: { toolName: 'pwsh' } });
  pending.attachAudit({ sessionId: 's1', auditId: 'audit-1', toolName: 'pwsh' });
  const first = pending.auditDecided({ auditId: 'audit-1', outcome: 'rejected' });
  assert.equal(first.value.notify, true);
  assert.equal(first.value.entry.state, 'decided-elsewhere');
  const second = pending.auditDecided({ auditId: 'audit-1', outcome: 'rejected' });
  assert.equal(second.value.notify, false);
  assert.equal(pending.auditDecided({ auditId: 'never-seen' }).value.notify, false);
});

test('QQ 侧答复过的条目在 decided 时不再重复通知', () => {
  const pending = createPendingStore({ log: quiet });
  pending.addFromWaterfall({ eventId: 'e1', sessionId: 's1', request: { toolName: 'pwsh' } });
  pending.attachAudit({ sessionId: 's1', auditId: 'audit-1', toolName: 'pwsh' });
  pending.settle('e1', 'answered', 'allowed-once');
  assert.equal(pending.auditDecided({ auditId: 'audit-1', outcome: 'allowed-once' }).value.notify, false);
});

test('cancel 帧：结清 + 之后点击被拒（T-U24 / P1-7 / A8）', () => {
  const pending = createPendingStore({ log: quiet });
  pending.addFromWaterfall({ eventId: 'e1', sessionId: 's1', request: { toolName: 'pwsh' } });
  assert.equal(pending.answerable('e1').ok, true);
  pending.settle('e1', 'cancelled', 'cancelled');
  const refused = pending.answerable('e1');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'state-cancelled');
  assert.equal(pending.answerable('nope').code, 'not-pending');
});

test('TTL：超时条目过期，之后点击被拒（T-U27）', () => {
  const pending = createPendingStore({ log: quiet, ttlMs: 1000 });
  pending.addFromWaterfall({ eventId: 'e1', sessionId: 's1', request: {} });
  assert.equal(pending.sweep(Date.now() + 5000), 1);
  assert.equal(pending.answerable('e1').code, 'state-expired');
});

test('pump.push（v1 events.mux 载体）与 dispose 幂等', async () => {
  const actions = [];
  const client = { protocol: 'v1', attachSession: async () => ok({ streamId: 'st', cancel: () => {} }), page: async () => ok({ records: [], hasMore: false }) };
  const state = createSessionStore({ log: quiet });
  state.adopt('s1', 'skip-history');
  const pump = createEventPump({ client, state, onAction: (a) => actions.push(a), log: quiet });
  const pushed = pump.push('s1', { seq: 5, type: 'turn/start', data: {} });
  assert.equal(pushed.ok, true);
  assert.deepEqual(actions.map((a) => a.kind), ['turn-start']);
  assert.equal(pump.push('s1', { nothing: true }).reason, 'rejected');
  pump.dispose();
  pump.dispose();
  assert.equal((await pump.attach('s1', 'skip-history')).reason, 'disposed');
});

test('unwrap: 失败结果不会被误当成成功（回归：describe/fail 与 ok 的判别）', () => {
  const state = createSessionStore({ log: quiet });
  const bad = state.ingest({ sessionId: 's1', seq: 'x', type: 'turn/start' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'rejected');
  assert.equal(fail('no-session', 'x').code, 'x');
  assert.equal(ok(1).value, 1);
});

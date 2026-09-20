// T-QF：提问应答流程（session/question-flow.js）的直测。
// 集成层（T-Q1..T-Q4）跑的是 QQ 消息 → 作答的整条链路；这里盯编排本身：
// 逐问推进、凑齐才回传、失败保留草稿、没人作答的草稿要回收。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPendingStore } from '../lib/session/pending.js';
import { createQuestionFlow, DRAFT_TTL_MS } from '../lib/session/question-flow.js';
import { ok, fail } from '../lib/result.js';

function harness({ postOk = true, withTarget = true, keyboardApprovals = false } = {}) {
  const sent = [];
  const posted = [];
  const logs = [];
  const health = { postOk };
  const log = {
    info: (msg, data) => logs.push({ level: 'info', msg, data }),
    warn: (msg, data) => logs.push({ level: 'warn', msg, data }),
    error: (msg, data) => logs.push({ level: 'error', msg, data }),
    debug: () => {},
  };
  const port = {
    sendText: async (target, text) => { sent.push({ target, text, keyboard: false }); return ok({ chunks: 1 }); },
    sendKeyboard: async (target, text) => { sent.push({ target, text, keyboard: true }); return ok({ chunks: 1 }); },
  };
  const pending = createPendingStore({ log });
  const dsh = {
    postEventResult: async (args) => {
      posted.push(args);
      return health.postOk ? ok({ accepted: true }) : fail('unavailable', 'host-down', 'injected failure');
    },
  };
  const flow = createQuestionFlow({
    log,
    config: { keyboardApprovals },
    port,
    pending,
    dsh,
    targetFor: () => (withTarget ? { kind: 'c2c', openid: 'U1', msgId: 'm1' } : null),
  });
  return { flow, pending, sent, posted, logs, health };
}

function addQuestion(pending, questions, eventId = 'ev1') {
  return pending.addFromWaterfall({ eventId, sessionId: 's1', kind: 'question', request: { questions } }).value.entry;
}

const TWO = [
  { id: 'q1', question: '第一个问题', options: [{ label: '甲' }, { label: '乙' }] },
  { id: 'q2', question: '第二个问题' },
];

test('多问题逐个问：答完最后一问才一次性回传', async () => {
  const t = harness();
  const entry = addQuestion(t.pending, TWO);

  assert.equal(await t.flow.start(entry), true);
  assert.equal(t.sent.length, 1);
  assert.match(t.sent[0].text, /（1\/2）/);
  assert.match(t.sent[0].text, /1\) 甲/);

  const first = await t.flow.answer(entry, { selected: ['甲'] });
  assert.equal(first.reply, null, '答完第一问不该再发一条额外回执（下一问本身就是回执）');
  assert.equal(t.sent.length, 2);
  assert.match(t.sent[1].text, /（2\/2）/);
  assert.equal(t.posted.length, 0, '没答完不许回传');

  const second = await t.flow.answer(entry, { selected: [], custom: '自由答案' });
  assert.match(second.reply, /已提交/);
  assert.deepEqual(t.posted[0], {
    eventId: 'ev1',
    outcome: {
      kind: 'result',
      value: {
        answers: [
          { id: 'q1', selected: ['甲'] },
          { id: 'q2', selected: [], custom: '自由答案' },
        ],
      },
    },
  });
  assert.equal(t.pending.get('ev1').state, 'answered');
  assert.equal(t.flow.size(), 0, '答完即清草稿');
});

test('回传失败保留草稿：弹掉刚记的那条，重发即可重试', async () => {
  const t = harness({ postOk: false });
  const entry = addQuestion(t.pending, [{ id: 'q1', question: '一个问题' }]);

  await t.flow.start(entry);
  const failed = await t.flow.answer(entry, { selected: [], custom: '第一次' });
  assert.match(failed.reply, /回传失败/);
  assert.equal(t.pending.get('ev1').state, 'pending', '失败不得结清');
  assert.equal(t.flow.draftOf('ev1').answers.length, 0, '刚记的那条要弹掉，否则重试会变成两条答案');
  assert.deepEqual(t.posted[0].outcome.value.answers, [{ id: 'q1', selected: [], custom: '第一次' }], '交给宿主的载荷不得被失败路径改写');

  t.health.postOk = true;
  const retried = await t.flow.answer(entry, { selected: [], custom: '第二次' });
  assert.match(retried.reply, /已提交/);
  assert.equal(t.posted.length, 2);
  assert.deepEqual(t.posted[1].outcome.value.answers, [{ id: 'q1', selected: [], custom: '第二次' }]);
  assert.equal(t.pending.get('ev1').state, 'answered');
});

test('sweep 回收没人作答的草稿：条目过期/取消即清，活着的留着', async () => {
  const t = harness();
  const entry = addQuestion(t.pending, [{ id: 'q1', question: '问一句' }]);
  await t.flow.start(entry);
  assert.equal(t.flow.size(), 1);

  assert.equal(t.flow.sweep(), 0, '条目还 pending、草稿没过期 → 不动');
  t.pending.settle('ev1', 'cancelled', 'cancelled');
  assert.equal(t.flow.sweep(), 1, '条目已取消 → 草稿必须回收');
  assert.equal(t.flow.size(), 0);
  assert.ok(t.logs.some((l) => l.msg === 'question draft dropped'), '回收要留痕');

  // 草稿自身超时（条目仍 pending）：也要回收，避免长期挂着
  const t2 = harness();
  const e2 = addQuestion(t2.pending, [{ id: 'q1', question: '问一句' }], 'ev2');
  await t2.flow.start(e2);
  assert.equal(t2.flow.sweep(Date.now() + DRAFT_TTL_MS + 1), 1);
});

test('没有回复目标时不静默丢弃：返回 false 并记 error', async () => {
  const t = harness({ withTarget: false });
  const entry = addQuestion(t.pending, [{ id: 'q1', question: '问一句' }]);
  assert.equal(await t.flow.start(entry), false);
  assert.equal(t.sent.length, 0);
  assert.ok(t.logs.some((l) => l.level === 'error' && /no target/.test(l.msg)), '必须有 error 级留痕');
});

test('键盘只给"单问题 + ≤4 选项"，多问题与自由输入走文本', async () => {
  const single = harness({ keyboardApprovals: true });
  await single.flow.start(addQuestion(single.pending, [{ id: 'q1', question: '选一个', options: [{ label: '甲' }, { label: '乙' }] }]));
  assert.equal(single.sent[0].keyboard, true);

  const multi = harness({ keyboardApprovals: true });
  await multi.flow.start(addQuestion(multi.pending, TWO));
  assert.equal(multi.sent[0].keyboard, false, '多问题时按钮无法表达"在答第几问"');

  const noOptions = harness({ keyboardApprovals: true });
  await noOptions.flow.start(addQuestion(noOptions.pending, [{ id: 'q1', question: '随便说说' }]));
  assert.equal(noOptions.sent[0].keyboard, false);
  assert.match(noOptions.sent[0].text, /直接打字回答/);
});

// T-I1..T-I7：入站待补发队列的持久化语义。
// 事故回归（2026-09-16 18:50）：3 个 PDF + 1 条消息在宿主冻死时只活在内存里，
// 进程一死就永久丢失。这里保证"消息先落盘、成功才清、崩了能恢复"。
//
// 时间约定：`add({ at, now })` 的 at 是消息业务时间、now 是判定基准。
// 测试用编造时间戳时必须同时给出 now，否则 TTL 会按真实时间把"过去的"消息判过期。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDurableInbox } from '../lib/session/inbox-store.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-'));
}

test('add → list：内容块（含附件收件箱路径）原样保存并按时间升序', () => {
  const dir = tmpdir();
  const inbox = createDurableInbox({ dir, log: quiet });
  inbox.add({
    msgId: 'msg-2',
    sessionId: 's1',
    target: { kind: 'c2c', openid: 'U1', msgId: 'm2' },
    parts: [{ type: 'text', text: '第二条' }],
    at: 2000,
    now: 2000,
  });
  inbox.add({
    msgId: 'msg-1',
    sessionId: 's1',
    target: { kind: 'c2c', openid: 'U1', msgId: 'm1' },
    parts: [
      { type: 'text', text: '第一条' },
      { type: 'file', inboxPath: 'C:/x/判决书.pdf' },
    ],
    at: 1000,
    now: 2000,
  });

  const items = inbox.list('s1', 2000);
  assert.equal(items.length, 2);
  assert.equal(items[0].msgId, 'msg-1', '按时间升序');
  assert.equal(items[0].parts[1].inboxPath, 'C:/x/判决书.pdf', '附件路径必须保留，否则补发时无从读取');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sessionId 缺失或 msgId 缺失时拒绝入队（避免补发时无处投递）', () => {
  const dir = tmpdir();
  const inbox = createDurableInbox({ dir, log: quiet });
  assert.equal(inbox.add({ msgId: 'm1', parts: [] }), false, '缺 sessionId');
  assert.equal(inbox.add({ sessionId: 's1', parts: [] }), false, '缺 msgId');
  assert.equal(inbox.size(), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('进程重启后仍能恢复：这是"宿主卡死也不丢消息"的核心保证', () => {
  const dir = tmpdir();
  const base = Date.now();
  const first = createDurableInbox({ dir, log: quiet });
  first.add({
    msgId: 'msg-1',
    sessionId: 's1',
    target: { openid: 'U1' },
    parts: [{ type: 'text', text: '卡死前发出的那条' }],
    at: base,
    now: base,
  });
  // 模拟被 SIGKILL：不调 remove、不调 compact
  const second = createDurableInbox({ dir, log: quiet });
  const restored = second.restore(base);
  assert.equal(restored.size, 1);
  assert.equal(second.list('s1', base)[0].parts[0].text, '卡死前发出的那条');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('成功送达后 remove：不再出现在列表里，重启也不会复活', () => {
  const dir = tmpdir();
  const base = Date.now();
  const inbox = createDurableInbox({ dir, log: quiet });
  inbox.add({ msgId: 'msg-1', sessionId: 's1', parts: [{ type: 'text', text: 'x' }], at: base, now: base });
  assert.equal(inbox.size(), 1);
  assert.equal(inbox.remove('msg-1'), true);
  assert.equal(inbox.list('s1', base).length, 0);
  assert.equal(inbox.remove('msg-1'), false, '重复删除返回 false');

  const restarted = createDurableInbox({ dir, log: quiet });
  restarted.restore(base);
  assert.equal(restarted.size(), 0, '删除操作必须持久化，否则重启会重复补发');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('同 msgId 幂等：重复投递只刷新 attempts，不叠加条目', () => {
  const dir = tmpdir();
  const base = Date.now();
  const inbox = createDurableInbox({ dir, log: quiet });
  inbox.add({ msgId: 'msg-1', sessionId: 's1', parts: [{ type: 'text', text: 'x' }], at: base, now: base });
  inbox.add({ msgId: 'msg-1', sessionId: 's1', parts: [{ type: 'text', text: 'x' }], at: base + 1, now: base + 1 });
  assert.equal(inbox.size(), 1);
  assert.equal(inbox.list('s1', base + 1)[0].attempts, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('容量与过期：丢最旧、不无限增长，且丢弃动作也会持久化', () => {
  const dir = tmpdir();
  const base = Date.now();
  const inbox = createDurableInbox({ dir, log: quiet, cap: 2, ttlMs: 1000 });
  inbox.add({ msgId: 'a', sessionId: 's1', parts: [], at: base, now: base });
  inbox.add({ msgId: 'b', sessionId: 's1', parts: [], at: base + 1, now: base + 1 });
  inbox.add({ msgId: 'c', sessionId: 's1', parts: [], at: base + 2, now: base + 2 });
  const ids = inbox.list('s1', base + 2).map((item) => item.msgId);
  assert.deepEqual(ids, ['b', 'c'], 'cap=2 时必须丢最旧的');

  // TTL：base+2 之后再过 1000ms，b 也过期，只剩 c
  const later = inbox.list('s1', base + 1002).map((item) => item.msgId);
  assert.deepEqual(later, ['c']);

  const restarted = createDurableInbox({ dir, log: quiet, cap: 2, ttlMs: 1000 });
  restarted.restore(base + 1002);
  assert.deepEqual(restarted.list('s1', base + 1002).map((item) => item.msgId), ['c']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('真实时间路径：不注入 now 时，刚入队的消息不会被 TTL 误删', () => {
  const dir = tmpdir();
  const inbox = createDurableInbox({ dir, log: quiet });
  inbox.add({ msgId: 'fresh', sessionId: 's1', parts: [{ type: 'text', text: '刚发的' }] });
  assert.equal(inbox.size(), 1, 'at 与 now 同源时绝不能误判过期');
  assert.equal(inbox.list('s1').length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('clear：内存与磁盘一起清空（测试/运维用）', () => {
  const dir = tmpdir();
  const inbox = createDurableInbox({ dir, log: quiet });
  inbox.add({ msgId: 'a', sessionId: 's1', parts: [] });
  inbox.clear();
  assert.equal(inbox.size(), 0);
  assert.equal(fs.existsSync(path.join(dir, 'qq-channel-pending.jsonl')), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

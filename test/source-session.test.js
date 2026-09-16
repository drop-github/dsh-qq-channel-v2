// T-S1..T-S3：来源 → 会话身份的确定性（回归：v2 曾把 v1 的"来源→会话"映射丢了，
// 于是同一个 QQ 来源每次重启都新建一个电脑端对话）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { SOURCE_SESSION_NAMESPACE, sessionIdForSource, uuidV5 } from '../lib/session/source-session.js';

const DNS_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

test('uuidV5 对得上 RFC 4122 的官方测试向量', () => {
  assert.equal(uuidV5('www.example.com', DNS_NAMESPACE), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
});

test('同一个来源每次都算出同一个身份；不同来源互不相同（含私聊/群）', () => {
  const a1 = sessionIdForSource('c2c:1E02C1ACFFC06F6C34CE9E2145852851');
  const a2 = sessionIdForSource('c2c:1E02C1ACFFC06F6C34CE9E2145852851');
  const other = sessionIdForSource('c2c:USER-A');
  const group = sessionIdForSource('grp:8F928F5D:1E02C1AC');
  assert.equal(a1, a2, '同一来源必须稳定');
  assert.notEqual(a1, other);
  assert.notEqual(a1, group);
  assert.notEqual(other, group);
});

test('形态与宿主自建的身份完全一致（session-<uuid v5>），不会让宿主多一条解析分支', () => {
  const id = sessionIdForSource('c2c:USER-A');
  assert.match(id, /^session-[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id.slice('session-'.length).length, 36);
});

test('命名空间固化：改它等于把所有来源换到新会话（防手滑改掉）', () => {
  assert.equal(SOURCE_SESSION_NAMESPACE, '3f1d29bb-6e49-5b77-b4e7-fae5199dc376');
  assert.equal(uuidV5('dsh-qq-channel', DNS_NAMESPACE), SOURCE_SESSION_NAMESPACE);
});

test('空来源键直接抛错，不产生"所有来源塌进同一个会话"的静默故障', () => {
  assert.throws(() => sessionIdForSource(''), /non-empty/);
  assert.throws(() => sessionIdForSource(undefined), /non-empty/);
  assert.throws(() => uuidV5('x', 'not-a-uuid'), /invalid namespace/);
});

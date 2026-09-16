// T-U: 配置（AC7 / N7 / R9）——17 键逐字一致、appId 归一、命名空间、settings 晚就绪必须重试（A25）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, CONFIG_KEYS, NAME, normalizeConfig, createConfigSource } from '../lib/config.js';

const EXPECTED_KEYS = [
  'enabled', 'appId', 'clientSecret', 'token', 'tokenUrl', 'gatewayUrl', 'apiBase', 'sessionId',
  'allowedGroups', 'allowedUsers', 'groupMembers', 'ack', 'markdown', 'perSourceSessions',
  'keyboardApprovals', 'maxChunk', 'maxReplyChunks',
];

test('schema 键集逐字等于 v1.2.4 的 17 个键（不多不少）', () => {
  assert.deepEqual([...CONFIG_KEYS].sort(), [...EXPECTED_KEYS].sort());
  assert.equal(CONFIG_KEYS.length, 17);
  assert.deepEqual(Object.keys(Config.dict).sort(), [...EXPECTED_KEYS].sort());
});

test('命名空间 = qq-channel', () => {
  assert.equal(NAME, 'qq-channel');
});

test('appId 接受 string|number 并归一为 string；默认值齐全', () => {
  assert.equal(normalizeConfig({ appId: 1905422590 }).appId, '1905422590');
  assert.equal(normalizeConfig({ appId: '1905422590' }).appId, '1905422590');
  const defaults = normalizeConfig({});
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.tokenUrl, 'https://bots.qq.com/app/getAppAccessToken');
  assert.equal(defaults.gatewayUrl, 'wss://api.sgroup.qq.com/websocket');
  assert.equal(defaults.apiBase, 'https://api.sgroup.qq.com');
  assert.deepEqual(defaults.allowedUsers, []);
  assert.deepEqual(defaults.allowedGroups, []);
  assert.deepEqual(defaults.groupMembers, []);
  assert.equal(defaults.ack, true);
  assert.equal(defaults.markdown, true);
  assert.equal(defaults.perSourceSessions, false);
  assert.equal(defaults.keyboardApprovals, false);
  assert.equal(defaults.maxChunk, 2000);
  assert.equal(defaults.maxReplyChunks, 4);
});

test('坏配置退回行配置而不是抛出（不留静默故障面）', () => {
  const warnings = [];
  const log = { warn: (event, fields) => warnings.push(`${event} ${JSON.stringify(fields ?? {})}`) };
  const out = normalizeConfig({ maxChunk: { not: 'a number' } }, log);
  assert.equal(warnings.length, 1);
  assert.deepEqual(out.maxChunk, { not: 'a number' });
});

test('宿主 settings 是 frozen 对象时仍必须归一化，不得静默降级', () => {
  // 回归：schemastery 的 z.transform 会把结果回写输入对象，而宿主 settings 传的是 frozen 对象，
  // 曾导致 Config(raw) 每次都抛 "Cannot assign to read only property 'appId'"，
  // 通道静默降级到未归一化的原始配置（默认值 / 类型强转全失效）。
  const warnings = [];
  const log = { warn: (event, fields) => warnings.push(`${event} ${JSON.stringify(fields ?? {})}`) };
  const frozen = Object.freeze({ appId: 1024, maxChunk: 500 });
  const out = normalizeConfig(frozen, log);
  assert.deepEqual(warnings, [], 'frozen 输入不得走降级分支');
  assert.equal(out.appId, '1024', 'appId 仍须归一为 string');
  assert.equal(out.enabled, true, '默认值仍须补齐');
  assert.equal(out.maxReplyChunks, 4, '默认值仍须补齐');
  assert.equal(out.maxChunk, 500, '显式值必须保留');
  assert.equal(frozen.appId, 1024, '不得改写调用方的 frozen 对象');
});

test('settings 服务晚就绪：必须重试注册，并在成功后通知上层采用已存配置（A25）', async () => {
  let calls = 0;
  let installCalls = 0;
  let current = { sessionId: 'row-config' };
  const settings = {
    installSection(_ctx, name, _schema, initial, hooks) {
      installCalls += 1;
      assert.equal(name, NAME);
      current = { ...initial, sessionId: 'session-from-settings' };
      hooks.setSource(() => ({ ...current }));
      return true;
    },
  };
  const ctx = {
    get: (service) => {
      if (service !== 'settings') return undefined;
      calls += 1;
      return calls <= 2 ? undefined : settings;    // 前两次还没就绪
    },
  };
  const events = [];
  const log = { info: (e) => events.push(e), warn: (e) => events.push(e), error: (e) => events.push(e), debug: () => {} };
  const registered = [];
  const source = createConfigSource(ctx, log, { sessionId: 'row-config' }, {
    retryDelayMs: 5,
    onRegistered: () => registered.push(true),
  });
  assert.equal(source.registered(), false, '首次必须失败（服务未就绪）');
  assert.equal(source.read().sessionId, 'row-config');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(installCalls, 1, '重试后必须恰好注册成功一次');
  assert.deepEqual(registered, [true], '注册成功后必须通知上层重启');
  assert.equal(source.read().sessionId, 'session-from-settings');
  source.dispose();
});

test('settings 服务一开始就绪时不重试、不通知重启', async () => {
  let installCalls = 0;
  const settings = { installSection: () => { installCalls += 1; return true; } };
  const ctx = { get: () => settings };
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  let notified = 0;
  const source = createConfigSource(ctx, log, {}, { retryDelayMs: 5, onRegistered: () => { notified += 1; } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(installCalls, 1);
  assert.equal(notified, 0);
  assert.equal(source.registered(), true);
  source.dispose();
});

// T-U: 统一结果类型（DESIGN §2.3.1 / D8）——reason 是封闭词表，写错必须立刻炸而不是静默漂移。
import test from 'node:test';
import assert from 'node:assert/strict';
import { REASONS, ok, fail, succeeded, describe, isRegisteredReason } from '../lib/result.js';

test('ok/fail 形态与控制流字段', () => {
  const good = ok(42);
  assert.equal(good.ok, true);
  assert.equal(good.value, 42);

  const bad = fail('timeout', 'TimeoutError', 'took too long');
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'timeout');
  assert.equal(bad.code, 'TimeoutError');     // code 只用于日志/判别，不参与分支
  assert.equal(bad.message, 'took too long');
});

test('reason 词表封闭：未登记值直接抛错（禁止悄悄新增）', () => {
  assert.throws(() => fail('whatever'), /unregistered reason/);
  for (const reason of REASONS) {
    assert.ok(isRegisteredReason(reason), `${reason} 应在词表里`);
    assert.equal(fail(reason).ok, false);
  }
  assert.equal(isRegisteredReason('not-a-reason'), false);
});

test('succeeded/describe 对任意输入都不抛', () => {
  assert.equal(succeeded(ok(1)), true);
  assert.equal(succeeded(fail('transport', 'x')), false);
  assert.equal(succeeded(undefined), false);
  assert.equal(succeeded(null), false);
  assert.equal(describe(ok(1)), 'ok');
  assert.equal(describe(fail('not-found', 'http-404', 'not found')), 'not-found / http-404 / not found');
  assert.equal(describe(undefined), 'none');
});

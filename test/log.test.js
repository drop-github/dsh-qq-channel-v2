// T-U9/T-U10: 日志脱敏（N1/R1）、截断与限流（R7）、文件 sink。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLog, fingerprint, createRedactor, MAX_LINE } from '../lib/log.js';

function collect() {
  const lines = [];
  const ctx = {
    logger: {
      info: (m) => lines.push(m),
      warn: (m) => lines.push(m),
      error: (m) => lines.push(m),
    },
  };
  return { ctx, lines };
}

test('fingerprint 只输出长度与 sha256 前 8 位', () => {
  const secret = 'MOCK-LAUNCH-TOKEN-VERY-SECRET';
  const fp = fingerprint(secret);
  assert.match(fp, /^sha256:[0-9a-f]{8}\(len=\d+\)$/);
  assert.ok(fp.includes(`(len=${secret.length})`));
  assert.ok(!fp.includes(secret));
  assert.equal(fingerprint(''), 'none');
});

test('注册过的 secret 在任何一行里都被替换（含 QQBot 头与 ?token= 形态）', () => {
  const redactor = createRedactor();
  redactor.register('MOCK-LAUNCH-TOKEN');
  const out = redactor.redact('auth ok token=MOCK-LAUNCH-TOKEN header=QQBot abcdef123456 url=/?token=MOCK-LAUNCH-TOKEN&x=1');
  assert.ok(!out.includes('MOCK-LAUNCH-TOKEN'));
  assert.ok(out.includes('«redacted:sha256:'));
  assert.ok(out.includes('QQBot «redacted»'));
  assert.ok(out.includes('token=«redacted»'));
});

test('日志：超长行被截断，且 secret 永远不出现在输出里', () => {
  const { ctx, lines } = collect();
  const log = createLog({ ctx, dir: null });
  log.registerSecret('SUPER-SECRET-VALUE');
  log.info('big', { detail: 'x'.repeat(500), leak: 'SUPER-SECRET-VALUE' });
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length <= MAX_LINE, `line length ${lines[0].length}`);
  assert.ok(!lines[0].includes('SUPER-SECRET-VALUE'));
});

test('限流：高频同名事件被抑制且计数可见', () => {
  const { ctx, lines } = collect();
  const log = createLog({ ctx, dir: null, rateMax: 3, rateWindowMs: 60000 });
  for (let i = 0; i < 10; i += 1) log.info('spam', { i });
  const spamLines = lines.filter((line) => line.includes('spam'));
  assert.ok(spamLines.length <= 3, `expected <=3 lines, got ${spamLines.length}`);
  assert.equal(log.counters()['spam:suppressed'], 7);
});

test('未知事件计数（D18：静默但可见）与文件 sink', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqlog-'));
  const { ctx } = collect();
  const log = createLog({ ctx, dir });
  log.countUnknown('session/title');
  log.countUnknown('session/title');
  log.countUnknown('step/start');
  assert.equal(log.counters()['unknown:session/title'], 2);
  log.info('boot', { session: 's1' });
  const written = fs.readFileSync(log.sinkPath(), 'utf8');
  assert.ok(written.includes('boot'));
  assert.ok(written.includes('session=s1'));
  fs.rmSync(dir, { recursive: true, force: true });
});

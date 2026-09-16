// T-L1..T-L5：多实例锁（回归：v1 有 qq-channel.lock，v2 漏迁 —— 两个 dsh web 会抢同一个 bot）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInstanceLock } from '../lib/lock.js';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qqv2-lock-')), 'qq-channel.lock');
const readLock = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('空目录：抢锁成功，锁文件里写着自己的 pid', () => {
  const file = tmpFile();
  const lock = createInstanceLock({ file, pid: 1001 });
  const result = lock.acquire();
  assert.equal(result.ok, true);
  assert.equal(result.tookOverFrom, null);
  assert.equal(readLock(file).pid, 1001);
  assert.equal(lock.isHeld(), true);
  lock.release();
});

test('另一个活进程持锁：必须拒绝，且不覆盖它的锁文件', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ pid: 2002, at: Date.now() }));
  const lock = createInstanceLock({ file, pid: 1001, isAlive: (pid) => pid === 2002 });
  const result = lock.acquire();
  assert.equal(result.ok, false);
  assert.equal(result.holder, 2002);
  assert.equal(readLock(file).pid, 2002, '被拒绝时不得改写别人的锁');
  assert.equal(lock.isHeld(), false);
  assert.equal(lock.release(), false);
});

test('陈旧锁（持有者已死）：直接接管并留下 tookOverFrom 痕迹', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ pid: 3003, at: Date.now() - 99999 }));
  const warnings = [];
  const lock = createInstanceLock({ file, pid: 1001, isAlive: () => false, log: { warn: (e, f) => warnings.push({ e, f }) } });
  const result = lock.acquire();
  assert.equal(result.ok, true);
  assert.equal(result.tookOverFrom, 3003);
  assert.equal(readLock(file).pid, 1001);
  lock.release();
});

test('放锁只删自己那把：别人接管之后不误删', () => {
  const file = tmpFile();
  const lock = createInstanceLock({ file, pid: 1001 });
  lock.acquire();
  fs.writeFileSync(file, JSON.stringify({ pid: 4004, at: Date.now() }));
  assert.equal(lock.release(), false);
  assert.equal(readLock(file).pid, 4004, '别人的锁必须留着');
});

test('心跳会刷新 at；锁文件不可写时降级放行而不是把通道一起拖死', async () => {
  const file = tmpFile();
  const lock = createInstanceLock({ file, pid: 1001, heartbeatMs: 20 });
  lock.acquire();
  const first = readLock(file).at;
  await sleep(70);
  assert.ok(readLock(file).at >= first, '心跳必须刷新时间戳');
  lock.release();
  assert.equal(fs.existsSync(file), false, '放锁后锁文件必须消失');

  const readOnly = createInstanceLock({
    file: tmpFile(),
    pid: 1001,
    fsApi: {
      ...fs,
      writeFileSync: () => { throw new Error('EPERM: read-only'); },
    },
  });
  const degraded = readOnly.acquire();
  assert.equal(degraded.ok, true, '不可写时降级为无锁放行（与 v1 一致）');
  assert.equal(degraded.degraded, true);
});

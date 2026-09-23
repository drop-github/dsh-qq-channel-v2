// L1 单元：命令通道（v2.0.3）—— 判据必须与宿主 parseCommand 逐字一致，
// 认不出来的行必须原样退回 prompt（否则用户打的普通文本会被悄悄吞掉）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSlashCommand, renderCommandReply, createCommandRunner } from '../lib/handlers/command.js';

test('T-C0a：命令行的切分与宿主 dsh-commands parseCommand 一致', () => {
  assert.deepEqual(parseSlashCommand('/compact'), { name: 'compact', rawInput: '' });
  // 命令名与输入之间的空白**原样保留**（宿主也是 `line.slice(match[0].length)`）
  assert.deepEqual(parseSlashCommand('/goal 把这活儿干完'), { name: 'goal', rawInput: ' 把这活儿干完' });
  assert.deepEqual(parseSlashCommand('/plan off'), { name: 'plan', rawInput: ' off' });
  assert.deepEqual(parseSlashCommand('/permission\tdefault'), { name: 'permission', rawInput: '\tdefault' });
  assert.deepEqual(parseSlashCommand('/session-log-export'), { name: 'session-log-export', rawInput: '' });
  assert.equal(parseSlashCommand('/goal\n下一行')?.name, 'goal', '换行也是合法的分隔符（宿主正则含 \\n）');
});

test('T-C0b：不是命令的行一律不认（退化成普通消息）', () => {
  for (const line of ['', '紧凑一点', '/', '//x', '/Compact', '/1abc', '/紧凑', '/_x', '/compact后', ' /compact', '/compact/x']) {
    assert.equal(parseSlashCommand(line), null, `不该认成命令：${JSON.stringify(line)}`);
  }
});

test('T-C0c：命令结果渲染保留宿主原文，只加成败记号', () => {
  assert.equal(renderCommandReply('compact', { kind: 'success', text: 'Compacted 12 items.' }), '✅ Compacted 12 items.');
  assert.equal(renderCommandReply('compact', { kind: 'success' }), '✅ /compact 已执行');
  assert.equal(renderCommandReply('plan', { kind: 'error', text: 'plan mode unavailable' }), '❌ /plan 失败：plan mode unavailable');
  assert.equal(renderCommandReply('plan', { kind: 'error' }), '❌ /plan 执行失败（宿主未给出原因）');
});

/** 造一个只记录调用的 dsh 替身。 */
function fakeDsh(result) {
  const calls = [];
  return { calls, command: async (request) => { calls.push(request); return result; } };
}

test('T-C0d：命令被宿主受理 → 只回一条结果，且不再走模型', async () => {
  const dsh = fakeDsh({ ok: true, value: { commandId: 'cmd-1', result: { kind: 'success', text: 'Compacted 12 items.' } } });
  const logs = [];
  const run = createCommandRunner({ log: { info: (m, d) => logs.push([m, d]), debug: () => {}, error: () => {} }, dsh });
  const out = await run('session-1', '/compact');
  assert.equal(out.reply, '✅ Compacted 12 items.');
  assert.equal(out.commandId, 'cmd-1');
  assert.deepEqual(dsh.calls, [{ agentId: 'session-1', line: '/compact' }]);
  assert.ok(logs.some(([m]) => m === 'command executed'));
});

test('T-C0e：宿主出错（如"有压缩在跑 / agent 不空闲"）原样回给用户', async () => {
  const dsh = fakeDsh({ ok: true, value: { commandId: 'cmd-2', result: { kind: 'error', text: 'Compaction is unavailable because the agent is not idle.' } } });
  const run = createCommandRunner({ log: { info: () => {}, debug: () => {}, error: () => {} }, dsh });
  const out = await run('session-1', '/compact');
  assert.match(out.reply, /^❌ \/compact 失败：Compaction is unavailable/);
});

test('T-C0f：宿主不认识这一行（result 里连 value 都没有）→ 退回 prompt', async () => {
  const dsh = fakeDsh({ ok: true, value: undefined });
  const run = createCommandRunner({ log: { info: () => {}, debug: () => {}, error: () => {} }, dsh });
  assert.equal(await run('session-1', '/nope'), null);
  assert.equal(dsh.calls.length, 1, '仍然问过宿主，是宿主说不认识');
});

test('T-C0g：老宿主没有命令通道 → 退回 prompt，不当成错误', async () => {
  const unsupported = fakeDsh({ ok: false, reason: 'not-found', code: 'protocol-unsupported', message: 'v1 host has no command channel' });
  const run = createCommandRunner({ log: { info: () => {}, debug: () => {}, error: () => {} }, dsh: unsupported });
  assert.equal(await run('session-1', '/compact'), null);

  const missing = fakeDsh({ ok: false, reason: 'rejected', code: 'gateway/unknown-method', message: 'unknown commands/execute' });
  const run2 = createCommandRunner({ log: { info: () => {}, debug: () => {}, error: () => {} }, dsh: missing });
  assert.equal(await run2('session-1', '/compact'), null);
});

test('T-C0h：通道本身失败（超时/不可用）要明确报错，不能假装成功', async () => {
  const dsh = fakeDsh({ ok: false, reason: 'timeout', code: 'TimeoutError', message: 'timed out' });
  const run = createCommandRunner({ log: { info: () => {}, debug: () => {}, error: () => {} }, dsh });
  const out = await run('session-1', '/compact');
  assert.match(out.reply, /^❌ \/compact 执行失败：TimeoutError/);
});

test('T-C0i：非命令行根本不碰命令通道', async () => {
  const dsh = fakeDsh({ ok: true, value: undefined });
  const run = createCommandRunner({ log: { info: () => {}, debug: () => {}, error: () => {} }, dsh });
  for (const line of ['你好', '/compact后', '这是 /compact 在句子中间']) {
    assert.equal(await run('session-1', line), null, `不该走命令通道：${line}`);
  }
  assert.equal(dsh.calls.length, 0, '一次都不该发给宿主');
});

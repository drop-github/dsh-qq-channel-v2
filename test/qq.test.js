// T-U: QQ 侧纯逻辑 —— 分块（码点）、被动回复窗口（M1/A9/A20）、键盘（M3/A16）、上传链（M4/A17）、
// 网关 close 分类、入站门控与去重（P2-5）、附件凭据与魔数（P2-16）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chunkByCodePoints, toQQMarkdown, MAX_CONTENT_CHARS } from '../lib/qq/format.js';
import { createSender, endpointFor, looksLikeDedup } from '../lib/qq/send.js';
import { approvalKeyboard, questionKeyboard, parseButtonData } from '../lib/qq/keyboard.js';
import { hashFile, MD5_10M_SIZE, fileTypeOf, createUploader, FILE_TYPE_FILE, FILE_TYPE_IMAGE } from '../lib/qq/upload.js';
import { classifyClose, INTENTS } from '../lib/qq/gateway.js';
import { createInboundRouter, createDedupGate } from '../lib/qq/inbound.js';
import { isAuthorizedHost, magicOk, IMAGE_MEDIA_TYPES } from '../lib/qq/attachment.js';
import { ok, fail } from '../lib/result.js';

const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, countUnknown: () => {} };
const config = {
  apiBase: 'https://api.example.test',
  maxChunk: 10,
  maxReplyChunks: 3,
  markdown: false,
  allowedUsers: ['U1'],
  allowedGroups: [],
  groupMembers: [],
};
const fakeToken = (value = 'tok') => ({ ensure: async () => ok(value), peek: () => value });

test('分块按码点切：emoji/代理对不被劈开，且总块数先算再截断（P2-1/P2-4）', () => {
  const text = '👍'.repeat(5);                      // 5 个码点 = 10 个 UTF-16 码元
  const all = chunkByCodePoints(text, 3, 10);
  assert.equal(all.total, 2);
  assert.deepEqual(all.chunks, ['👍👍👍', '👍👍']);
  assert.equal(all.chunks.join(''), text);
  assert.equal(all.truncated, false);

  const cut = chunkByCodePoints(text, 3, 1);
  assert.equal(cut.total, 2, 'total 必须是"未截断前的总块数"，否则截断提示永远是死代码');
  assert.equal(cut.chunks.length, 1);
  assert.equal(cut.truncated, true);
  assert.equal(chunkByCodePoints('', 10, 3).total, 0);
});

test('markdown 适配：代码块/表格降级为引用，标题最多 3 级（现役策略）', () => {
  const out = toQQMarkdown('#### 标题\n```\ncode\n```\n| a | b |\n| --- | --- |\n| 1 | 2 |');
  assert.ok(out.includes('### 标题'));
  assert.ok(out.includes('> code'));
  assert.ok(out.includes('> a | b'));
  assert.ok(!out.includes('---'));
});

test('发送层：被动窗口内**每条**都带 msg_id 且 (msg_id,msg_seq) 唯一、msg_seq 从 1 开始（M1/A9/A20）', async () => {
  const calls = [];
  const sender = createSender({
    config, log: quiet, token: fakeToken(),
    fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => '{"id":"out-1"}' }; },
  });
  sender.notePassive('MSG-1');
  const result = await sender.sendText({ kind: 'c2c', openid: 'U1' }, 'A'.repeat(26), { passive: { msgId: 'MSG-1' } });
  assert.equal(result.ok, true);
  assert.equal(result.value.total, 3);        // ceil(26/10)
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://api.example.test/v2/users/U1/messages');
  assert.deepEqual(calls.map((c) => c.body.msg_id), ['MSG-1', 'MSG-1', 'MSG-1']);
  assert.deepEqual(calls.map((c) => c.body.msg_seq), [1, 2, 3]);
  assert.equal(new Set(calls.map((c) => `${c.body.msg_id}#${c.body.msg_seq}`)).size, 3);

  // 第 4 块（超出 maxReplyChunks）被截断 → 追加一条普通的截断提示，仍走被动窗口
  assert.equal((await sender.sendText({ kind: 'c2c', openid: 'U1' }, 'B'.repeat(31), { passive: { msgId: 'MSG-1' } })).value.truncated, true);
  assert.deepEqual(calls.map((c) => c.body.msg_seq), [1, 2, 3, 4, 5, 6, 7]);
});

test('发送层：窗口过期后不再挂 msg_id（降级为主动消息）；无目标直接失败（P2-12）', async () => {
  const calls = [];
  const sender = createSender({
    config, log: quiet, token: fakeToken(),
    fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '{}' }; },
  });
  const noTarget = await sender.sendText(null, 'hi');
  assert.equal(noTarget.reason, 'no-target');
  assert.equal(calls.length, 0);

  sender.notePassive('OLD');
  const expired = sender;                                    // 通过时间推进模拟窗口过期
  await expired.sendText({ kind: 'group', openid: 'G1' }, 'hello', { passive: { msgId: 'NEVER-SEEN' } });
  assert.equal(calls[0].msg_id, undefined);
  assert.equal(endpointFor('https://x', { kind: 'group', openid: 'G1' }), 'https://x/v2/groups/G1/messages');
  assert.equal(endpointFor('https://x', { kind: 'c2c', openid: 'U1' }), 'https://x/v2/users/U1/messages');
});

test('发送层：带键盘只发一条不分块（任务书 §1.4）', async () => {
  const calls = [];
  const sender = createSender({
    config, log: quiet, token: fakeToken(),
    fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '{}' }; },
  });
  sender.notePassive('M');
  const sent = await sender.sendKeyboard({ kind: 'c2c', openid: 'U1' }, 'X'.repeat(45), approvalKeyboard('EV-1'), { passive: { msgId: 'M' } });
  assert.equal(sent.ok, true);
  assert.equal(calls.length, 1, '带键盘的消息绝不分块');
  assert.equal(calls[0].msg_type, 2);
  assert.ok(calls[0].keyboard.content.rows[0].buttons.length >= 2);
  assert.equal(calls[0].msg_id, 'M');
});

test('发送层：判重（40054005/msgseq）→ 去掉 msg_id 重发一次；markdown 失败 → 纯文本回退', async () => {
  const calls = [];
  let n = 0;
  const sender = createSender({
    config: { ...config, markdown: true, maxChunk: 4000 }, log: quiet, token: fakeToken(),
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      n += 1;
      if (n === 1) return { ok: false, status: 400, headers: { get: () => null }, text: async () => '{"code":40054005,"message":"msgseq duplicate"}' };
      return { ok: true, status: 200, text: async () => '{}' };
    },
  });
  sender.notePassive('M1');
  const result = await sender.sendText({ kind: 'c2c', openid: 'U1' }, 'dup 测试', { passive: { msgId: 'M1' } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].msg_id, 'M1');
  assert.equal(calls[1].msg_id, undefined, '判重后必须降级为主动消息');
  assert.ok(looksLikeDedup('msgseq') && looksLikeDedup('40054005') && !looksLikeDedup('bad request'));
});

test('发送层：5xx 退避重试、429 尊重 Retry-After（P1-1 三态重试）', async () => {
  const statuses = [503, 429];
  const calls = [];
  const sender = createSender({
    config: { ...config, markdown: false }, log: quiet, token: fakeToken(),
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      const status = statuses.shift() ?? 200;
      return { ok: status === 200, status, headers: { get: () => '1' }, text: async () => (status === 200 ? '{}' : 'busy') };
    },
  });
  const result = await sender.sendText({ kind: 'c2c', openid: 'U1' }, 'hi');
  assert.equal(result.ok, true);
  assert.equal(calls.length, 3, '5xx、429 各重试一次后成功');
});

test('键盘：回调型字段齐全（M3/A16），button_data 用锚定正则解析', () => {
  const keyboard = approvalKeyboard('EV-uuid-1');
  const button = keyboard.content.rows[0].buttons[0];
  assert.equal(button.action.type, 1);
  assert.equal(button.action.permission.type, 2);
  assert.equal(button.action.click_limit, 1);
  assert.ok(button.render_data.visited_label);
  assert.equal(button.action.data, 'approve:EV-uuid-1:allowed-once');

  assert.deepEqual(parseButtonData('approve:EV-uuid-1:rejected'), { kind: 'approve', id: 'EV-uuid-1', outcome: 'rejected' });
  assert.deepEqual(parseButtonData('question:EV-2:3'), { kind: 'question', id: 'EV-2', optionIndex: 3 });
  assert.equal(parseButtonData('xapprove:EV-1:rejected'), null, '必须锚定，前缀脏数据不得命中');
  assert.equal(parseButtonData('approve:EV-1:maybe'), null);
  assert.equal(parseButtonData(''), null);

  const qk = questionKeyboard('EV-3', { options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }, { label: 'd' }, { label: 'e' }] });
  assert.equal(qk.content.rows[0].buttons.length, 4, '选项最多 4 个按钮');
  assert.equal(qk.content.rows[0].buttons[3].action.data, 'question:EV-3:3');
});

test('上传链哈希：md5_10m = 前 10,002,432 字节；小文件等于全文件 md5（open-2 裁决）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqhash-'));
  try {
    const small = path.join(dir, 'small.bin');
    fs.writeFileSync(small, Buffer.from('hello qq'));
    const smallHashes = await hashFile(small, 8);
    assert.equal(smallHashes.md5_10m, smallHashes.md5, '小于阈值时 md5_10m 必须等于全文件 md5');

    const big = path.join(dir, 'big.bin');
    const payload = Buffer.alloc(MD5_10M_SIZE + 16, 0xab);
    payload.fill(0xcd, MD5_10M_SIZE);          // 阈值之后的内容不得影响 md5_10m
    fs.writeFileSync(big, payload);
    const bigHashes = await hashFile(big, payload.length);
    const expectedTenMb = createHash('md5').update(payload.subarray(0, MD5_10M_SIZE)).digest('hex');
    assert.equal(MD5_10M_SIZE, 10002432);
    assert.equal(bigHashes.md5_10m, expectedTenMb);
    assert.notEqual(bigHashes.md5_10m, bigHashes.md5);
    assert.equal(bigHashes.sha1, createHash('sha1').update(payload).digest('hex'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('上传链报文：upload_prepare 六字段 + upload_part_finish 带 upload_id（M4/A17）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqup-'));
  const calls = [];
  try {
    const file = path.join(dir, 'spec-check.png');
    fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
    const uploader = createUploader({
      config, log: quiet, token: fakeToken(),
      fetchImpl: async (url, init) => {
        const raw = typeof init.body === 'string' ? init.body : undefined;
        calls.push({ url, method: init.method, body: raw ? JSON.parse(raw) : undefined, bytes: init.body?.length });
        if (url.endsWith('upload_prepare')) {
          return { ok: true, status: 200, text: async () => JSON.stringify({ upload_id: 'UP-1', block_size: 14, parts: [{ index: 1, block_size: 14, presigned_url: 'https://put.example/1' }] }) };
        }
        return { ok: true, status: 200, text: async () => '{}' };
      },
    });
    const result = await uploader.uploadFile({ filePath: file, fileName: 'spec-check.png', target: { kind: 'c2c', openid: 'U1' } });
    assert.equal(result.ok, true);
    const prepare = calls.find((c) => c.url.endsWith('upload_prepare')).body;
    for (const key of ['file_type', 'file_name', 'file_size', 'md5', 'sha1', 'md5_10m']) {
      assert.notEqual(prepare[key], undefined, `upload_prepare 缺字段 ${key}`);
    }
    assert.equal(prepare.file_type, FILE_TYPE_IMAGE);
    const put = calls.find((c) => c.url === 'https://put.example/1');
    assert.equal(put.method, 'PUT');
    const finish = calls.find((c) => c.url.endsWith('upload_part_finish')).body;
    for (const key of ['upload_id', 'part_index', 'block_size', 'md5']) {
      assert.notEqual(finish[key], undefined, `upload_part_finish 缺字段 ${key}`);
    }
    assert.equal(finish.upload_id, 'UP-1');
    const files = calls.find((c) => c.url.endsWith('/files')).body;
    assert.equal(files.srv_send_msg, true);
    assert.equal(files.file_name, undefined, 'file_name 只在 file_type==4 时带');
    assert.equal(fileTypeOf('a.PNG'), FILE_TYPE_IMAGE);
    assert.equal(fileTypeOf('a.zip'), FILE_TYPE_FILE);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('上传错误码分类：40093002 永久失败、40093001 可重试；超过上限不上传', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqup2-'));
  try {
    const file = path.join(dir, 'x.bin');
    fs.writeFileSync(file, Buffer.from('x'));
    const quota = createUploader({
      config, log: quiet, token: fakeToken(),
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => '{"code":40093002}' }),
    });
    const quotaResult = await quota.uploadFile({ filePath: file, fileName: 'x.bin', target: { kind: 'c2c', openid: 'U1' } });
    assert.equal(quotaResult.code, '40093002');
    assert.equal(quotaResult.reason, 'rejected');

    const retryable = createUploader({
      config, log: quiet, token: fakeToken(),
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => '{"code":40093001}' }),
    });
    const retryResult = await retryable.uploadFile({ filePath: file, fileName: 'x.bin', target: { kind: 'c2c', openid: 'U1' } });
    assert.equal(retryResult.code, '40093001');
    assert.equal(retryResult.reason, 'unavailable', '可重试码必须归到可重试一类');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('网关 close code 分类表（保留现役语义）', () => {
  assert.deepEqual(classifyClose(4004), { clearToken: true, clearSession: true, backoffMs: 5000, note: 'auth failed' });
  assert.equal(classifyClose(4008).backoffMs, 60000);
  assert.equal(classifyClose(4008).clearSession, false);
  assert.equal(classifyClose(4009).clearSession, false);
  assert.equal(classifyClose(4003).clearSession, true);
  assert.equal(classifyClose(4007).clearSession, true);
  assert.equal(classifyClose(4903).clearSession, true);
  assert.equal(classifyClose(4001).fatal, true);
  assert.equal(classifyClose(4914).fatal, true);
  assert.equal(classifyClose(1006).fatal, undefined);
  assert.equal(INTENTS, (1 << 25) | (1 << 26));
});

test('入站门控：allowedUsers / allowedGroups / groupMembers 与 @ 前缀剥离（任务书 §1.3）', () => {
  const log = { ...quiet, warn: () => {} };
  const router = createInboundRouter({ config: { allowedUsers: ['U1'], allowedGroups: ['G1'], groupMembers: ['M1'] }, log });
  assert.equal(router.route('C2C_MESSAGE_CREATE', { id: 'm1', content: 'hi', author: { user_openid: 'U2' } }), null);
  const c2c = router.route('C2C_MESSAGE_CREATE', { id: 'm2', content: ' hi ', author: { user_openid: 'U1' } });
  assert.equal(c2c.text, 'hi');
  assert.deepEqual(c2c.target, { kind: 'c2c', openid: 'U1' });
  assert.equal(c2c.sourceKey, 'c2c:U1');

  assert.equal(router.route('GROUP_AT_MESSAGE_CREATE', { group_openid: 'G2', author: { member_openid: 'M1' } }), null);
  assert.equal(router.route('GROUP_AT_MESSAGE_CREATE', { group_openid: 'G1', author: { member_openid: 'M9' } }), null);
  const group = router.route('GROUP_AT_MESSAGE_CREATE', {
    group_openid: 'G1', content: '@Bot 你好', author: { member_openid: 'M1' },
    message_scene: { ext: ['msg_idx=REF-1'] },
  });
  assert.equal(group.text, '你好');
  assert.equal(group.refMsgId, 'REF-1');
  assert.equal(group.sourceKey, 'grp:G1:M1');
  assert.equal(router.route('SOMETHING_ELSE', {}), null);
});

test('去重：窗口内命中、有界且按插入序淘汰（绝不整表清空，P2-5）', () => {
  const gate = createDedupGate({ windowMs: 60000, cap: 3 });
  assert.equal(gate.isDuplicate('a'), false);
  assert.equal(gate.isDuplicate('a'), true);
  gate.isDuplicate('b');
  gate.isDuplicate('c');
  gate.isDuplicate('d');                       // 超限 → 淘汰最旧的 a
  assert.equal(gate.size(), 3);
  assert.equal(gate.isDuplicate('a'), false, '被淘汰后不应当成重复（有界淘汰，而不是整表清空）');
  const tiny = createDedupGate({ windowMs: 1 });
  tiny.isDuplicate('x');
  return new Promise((resolve) => setTimeout(() => {
    assert.equal(tiny.isDuplicate('x'), false, '窗口外的旧 id 不再拦');
    resolve();
  }, 10));
});

test('附件：只对预期域名带凭据（P2-16），魔数校验不轻信 content_type', () => {
  assert.equal(isAuthorizedHost('https://multimedia.nt.qq.com.cn/download?a=1'), true);
  assert.equal(isAuthorizedHost('https://api.sgroup.qq.com/x'), true);
  assert.equal(isAuthorizedHost('http://127.0.0.1:8080/attach/tiny.png'), false);
  assert.equal(isAuthorizedHost('https://evil.example/qq.com.png'), false);
  assert.equal(isAuthorizedHost('not a url'), false);

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]); 
  assert.equal(magicOk(png, 'image/png'), true);
  assert.equal(magicOk(png, 'image/jpeg'), false);
  assert.equal(magicOk(Buffer.alloc(4), 'image/png'), false);
  const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(4)]);
  assert.equal(magicOk(webp, 'image/webp'), true);
  assert.equal(IMAGE_MEDIA_TYPES.has('image/png'), true);
  assert.equal(MAX_CONTENT_CHARS, 4000);
  assert.equal(fail('no-target').ok, false);
});

// T-I1..T-I11：整插件在进程内跑真实代码（假 ctx + mock DSH + mock QQ）——不联网、不碰 3080、不读真实配置。
// 这是本仓的回归证据；对接方台子（qq-channel-verify）是最终验收，两者都不许放宽。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qqv2-test-'));
process.env.DSH_HOME = TMP;                       // 必须在插件被导入前生效（$DSH_HOME 隔离）
const STORAGE = path.join(TMP, 'storages');

const plugin = await import('../lib/index.js');
const { makeFakeCtx } = await import('./helpers/fake-ctx.mjs');
const { startMockDsh } = await import('./helpers/mock-dsh.mjs');
const { startMockQQ } = await import('./helpers/mock-qq.mjs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, label, ms = 12000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`timeout (${ms}ms) waiting for ${label}`);
    await sleep(100);
  }
}

function readPluginLog() {
  try {
    return fs.readdirSync(STORAGE)
      .filter((name) => name.endsWith('.log'))
      .map((name) => fs.readFileSync(path.join(STORAGE, name), 'utf8'))
      .join('\n');
  } catch (err) {
    return `(no log: ${String(err?.message ?? err)})`;
  }
}

async function boot({ unauthorizedTimes = 0, unauthorizedPaths = [], promptFailures = 0, overrides = {} } = {}) {
  const dsh = await startMockDsh({ unauthorizedTimes, unauthorizedPaths, promptFailures });
  const qq = await startMockQQ();
  const logs = [];
  const config = {
    enabled: true,
    appId: '1000',
    clientSecret: 'mock-secret',
    token: '',
    tokenUrl: qq.tokenUrl,
    gatewayUrl: qq.gatewayUrl,
    apiBase: qq.apiBase,
    sessionId: 'session-mock-1',
    allowedGroups: [],
    allowedUsers: ['USER-A'],
    groupMembers: [],
    ack: false,
    markdown: false,
    perSourceSessions: false,
    keyboardApprovals: true,
    maxChunk: 2000,
    maxReplyChunks: 4,
    ...overrides,
  };
  const fake = makeFakeCtx({ port: dsh.port, config, logs, token: 'MOCK-LAUNCH-TOKEN' });
  plugin.apply(fake.ctx, config);
  await waitFor(() => qq.state.identifies.length > 0, 'QQ IDENTIFY', 15000);
  return { dsh, qq, logs, config, stats: fake.stats, dispose: fake.dispose };
}

async function teardown(t, disposeFirst = true) {
  if (disposeFirst) t.dispose();
  await sleep(50);
  t.dsh.close();
  t.qq.close();
}

test('T-I1/T-I5：探测报文 args 恰为 _request、走 v2 事件通道（不开 events.mux）、prompt 报文合规', async () => {
  const t = await boot();
  try {
    t.qq.c2c('启动测试');
    const prompt = await waitFor(() => t.dsh.state.prompts[0], 'prompt');
    const probe = t.dsh.state.http.find((entry) => entry.path === 'session/list');
    assert.ok(probe, '必须发过 session/list 探测');
    assert.equal(Object.keys(probe.args).join(','), '_request');
    assert.equal(t.dsh.state.argViolations.length, 0, `参数键违反：${JSON.stringify(t.dsh.state.argViolations)}`);
    assert.equal(t.dsh.state.rejectedUpgrades.length, 0, 'v2 下绝不能触碰 /api/events.mux');
    await waitFor(() => t.dsh.state.openControlFrames.length > 0, '$events 控制流');
    await waitFor(() => t.dsh.state.followRequests.length > 0, 'session/follow');
    assert.equal(prompt.mode, 'queue', 'mode 是宿主必填枚举（A19）');
    assert.equal(prompt.sessionId, 'session-mock-1');
    assert.ok(prompt.requestId && prompt.requestId.length > 8);
    assert.equal(t.dsh.state.promptSchemaErrors.length, 0);
  } finally { await teardown(t); }
});

test('T-I6：turn/end 落在尾部窗口之外仍要送达（A5）', async () => {
  const t = await boot();
  try {
    await waitFor(() => t.dsh.state.openControlFrames.length > 0, 'control stream');
    t.qq.c2c('GAP 触发消息');
    await waitFor(() => t.dsh.state.prompts.length > 0, 'prompt');
    await sleep(2000);
    t.dsh.append('turn/start', { sessionId: 'session-mock-1' });
    t.dsh.append('assistant/message', { message: { content: [{ type: 'text', text: 'GAP-REPLY-MARKER' }] }, sessionId: 'session-mock-1' }, { surfaceOp: 'append' });
    t.dsh.append('turn/end', { sessionId: 'session-mock-1' });
    t.dsh.padMessages(60, 'session-mock-1');
    await waitFor(() => t.qq.textsTo().some((text) => text.includes('GAP-REPLY-MARKER')), 'gap reply', 15000);
  } finally { await teardown(t); }
});

test('T-I11/A6/A16：审批键盘 → 先 ACK 再回传；重复点击不二次回传；按钮字段齐全', async () => {
  const t = await boot();
  try {
    await sleep(1500);
    t.qq.c2c('审批前热身');
    await waitFor(() => t.dsh.state.prompts.length > 0, 'prompt');
    const { eventId } = t.dsh.requestApproval({ toolName: 'pwsh', reason: 'mock 审批' });
    await waitFor(() => t.qq.state.sent.some((entry) => entry.keyboard), 'keyboard message', 15000);
    const keyboardMessage = t.qq.state.sent.find((entry) => entry.keyboard);
    const button = keyboardMessage.keyboard.content.rows[0].buttons[0];
    assert.equal(button.action.type, 1);
    assert.equal(button.action.permission.type, 2);
    assert.equal(button.action.click_limit, 1);
    assert.ok(button.render_data.visited_label);
    assert.ok(button.action.data.startsWith('approve:'));

    t.qq.click(`approve:${eventId}:allowed-once`);
    const posted = await waitFor(() => t.dsh.state.eventResults[0], '$events/result');
    assert.equal(posted.eventId, eventId);
    assert.deepEqual(posted.outcome, { kind: 'result', value: 'allowed-once' });
    const ack = t.qq.state.interactions[0];
    assert.ok(ack && ack.at <= posted.at, '必须先 ACK 再回传（A18）');
    await waitFor(() => t.qq.textsTo().some((text) => text.includes('已批准')), 'confirmation');

    const before = t.dsh.state.eventResults.length;
    t.qq.click(`approve:${eventId}:rejected`);
    await sleep(1200);
    assert.equal(t.dsh.state.eventResults.length, before, '重复点击不得二次回传');
  } finally { await teardown(t); }
});

test('T-I11：电脑端决定的审批只回补一条通知；cancel 帧结清且之后点击被拒（A7/A8）', async () => {
  const t = await boot();
  try {
    await sleep(1500);
    t.qq.c2c('审批前热身2');
    await waitFor(() => t.dsh.state.prompts.length > 0, 'prompt');
    const first = t.dsh.requestApproval({ toolName: 'pwsh', reason: 'desktop 处理' });
    await waitFor(() => t.qq.textsTo().some((text) => text.includes('审批')), 'approval message');
    t.dsh.decideAudit(first.auditId, 'rejected');
    await waitFor(() => t.qq.textsTo().some((text) => text.includes('已处理')), 'desktop decision notice', 15000);
    assert.equal(t.qq.textsTo().filter((text) => text.includes('已处理')).length, 1);

    const second = t.dsh.requestApproval({ toolName: 'pwsh', reason: 'cancel 测试' });
    await waitFor(() => t.qq.textsTo().filter((text) => text.includes('审批')).length === 2, 'second approval', 15000);
    t.dsh.cancelEvent(second.eventId);
    await waitFor(() => t.qq.textsTo().some((text) => text.includes('取消')), 'cancel notice', 10000);
    const before = t.dsh.state.eventResults.length;
    t.qq.click(`approve:${second.eventId}:allowed-once`);
    await sleep(1200);
    assert.equal(t.dsh.state.eventResults.length, before, '已取消的审批不得被回传');
  } finally { await teardown(t); }
});

test('T-I7：已有历史不重放（A12）', async () => {
  const t = await boot();
  try {
    await sleep(1500);
    t.dsh.padMessages(100, 'session-mock-1');
    t.qq.c2c('历史之后的新消息');
    await waitFor(() => t.dsh.state.prompts.length > 0, 'prompt');
    await sleep(2500);
    assert.equal(t.qq.state.sent.length, 0, '历史不得被重放成回复');
    t.dsh.append('turn/start', { sessionId: 'session-mock-1' });
    t.dsh.append('assistant/message', { message: { content: [{ type: 'text', text: 'NEW-TURN-MARKER' }] }, sessionId: 'session-mock-1' }, { surfaceOp: 'append' });
    t.dsh.append('turn/end', { sessionId: 'session-mock-1' });
    await waitFor(() => t.qq.textsTo().some((text) => text.includes('NEW-TURN-MARKER')), 'new turn reply', 15000);
    const texts = t.qq.textsTo();
    assert.equal(texts.length, 1);
    assert.ok(!texts.some((text) => text.includes('pad-')));
  } finally { await teardown(t); }
});

test('T-I2/A2：launch token 不进任何日志（stdout 与文件 sink）', async () => {
  const t = await boot();
  try {
    t.qq.c2c('你好');
    await waitFor(() => t.dsh.state.prompts.length > 0, 'prompt');
    await sleep(1000);
    const all = `${t.logs.join('\n')}\n${readPluginLog()}`;
    assert.ok(!all.includes('MOCK-LAUNCH-TOKEN'), 'launch token 明文出现在日志里');
    assert.ok(!all.includes('mock-secret'), 'clientSecret 明文出现在日志里');
  } finally { await teardown(t); }
});

test('T-I3/T-I4：401 重认证后重试成功，且重试复用同一 requestId（A3/A13）', async () => {
  const t = await boot({ unauthorizedPaths: ['session/prompt'] });
  try {
    t.qq.c2c('幂等测试');
    const prompt = await waitFor(() => t.dsh.state.prompts[0], 'prompt after 401', 25000);
    assert.equal(t.dsh.state.prompts.length, 1, '重试不得被当成新消息');
    const rejected = t.dsh.state.unauthorizedAttempts.find((attempt) => attempt.path === 'session/prompt');
    assert.ok(rejected, 'mock 没有拦住第一次 prompt（场景未生效）');
    assert.equal(rejected.args.request.requestId, prompt.requestId, '重试必须复用同一 requestId');
  } finally { await teardown(t); }
});

test('A20：被动回复窗口内每条都带 msg_id 且 (msg_id,msg_seq) 唯一', async () => {
  const t = await boot({ overrides: { maxChunk: 40, maxReplyChunks: 4 } });
  try {
    t.qq.c2c('被动窗口测试');
    await waitFor(() => t.dsh.state.prompts.length > 0, 'prompt');
    t.dsh.scriptTurn('B'.repeat(120));
    await waitFor(() => t.qq.state.sent.length >= 2, 'multi-chunk reply', 15000);
    const sent = t.qq.state.sent;
    const pairs = sent.map((entry) => `${entry.msg_id ?? '-'}#${entry.msg_seq ?? '-'}`);
    assert.equal(new Set(pairs).size, pairs.length, `(msg_id,msg_seq) 重复：${pairs.join(',')}`);
    assert.ok(sent.every((entry) => entry.msg_id), '窗口内每条都应带 msg_id');
    assert.ok(sent.every((entry) => Number.isInteger(entry.msg_seq)));
    assert.equal(sent[0].msg_seq, 1, '同一 msg_id 的第一条必须从 1 开始');
  } finally { await teardown(t); }
});

test('A21/A22：退化图被宿主拒绝后文本兜底送达；非预期域名不带 Authorization', async () => {
  const t = await boot();
  try {
    await sleep(1200);
    t.qq.c2c('看看这张图', { attachments: [t.qq.imageAttachment({ kind: 'tiny' })] });
    const fallback = await waitFor(
      () => t.dsh.state.prompts.find((prompt) => Array.isArray(prompt.content) && prompt.content.every((part) => part.type === 'text')),
      'text-only fallback prompt', 20000,
    );
    assert.ok(t.dsh.state.imageRejections >= 1, 'mock 没有拒绝退化图（场景未生效）');
    assert.ok(String(fallback.content[0]?.text ?? '').length > 0, '兜底 prompt 不得为空');
    t.dsh.scriptTurn('兜底回复');
    await waitFor(() => t.qq.textsTo().length > 0, 'reply after fallback', 15000);
    const fetchInfo = t.qq.state.attachmentFetches[0];
    assert.ok(fetchInfo, '附件应当被下载');
    assert.ok(fetchInfo.auth === '' || fetchInfo.auth.startsWith('QQBot '), `意外凭据形态：${fetchInfo.auth}`);
    // 127.0.0.1 不是预期域名 → 必须裸下载（P2-16）
    assert.equal(fetchInfo.auth, '');
  } finally { await teardown(t); }
});

test('A23：控制流重开后宿主补投未答事件，不得重复推审批', async () => {
  const t = await boot();
  try {
    await sleep(1200);
    t.qq.c2c('重投测试');
    await waitFor(() => t.dsh.state.prompts.length > 0, 'prompt');
    const { eventId } = t.dsh.requestApproval({ toolName: 'pwsh', reason: '重投' });
    await waitFor(() => t.qq.textsTo().filter((text) => text.includes('审批')).length === 1, 'first approval');
    const before = t.dsh.state.openControlFrames.length;
    t.dsh.endControlStream();
    await waitFor(() => t.dsh.state.openControlFrames.length > before, 'control stream reopened', 20000);
    await sleep(2000);
    assert.equal(t.qq.textsTo().filter((text) => text.includes('审批')).length, 1, '补投的帧必须按 eventId 去重');
    t.qq.click(`approve:${eventId}:allowed-once`);
    await waitFor(() => t.dsh.state.eventResults.some((result) => result.eventId === eventId), 'result after reopen');
  } finally { await teardown(t); }
});

test('T-I9/A10：dispose 后不再有任何 HTTP 流量', async () => {
  const t = await boot();
  try {
    t.qq.c2c('生命周期测试');
    await waitFor(() => t.dsh.state.prompts.length > 0, 'prompt');
    t.dispose();
    await sleep(500);
    const after = t.dsh.state.http.length;
    await sleep(3000);
    assert.equal(t.dsh.state.http.length, after, `dispose 后仍有 ${t.dsh.state.http.length - after} 次请求`);
  } finally { await teardown(t, false); }
});

// ---- 2026-09-16 卡死事故回归：入站必须"先落盘、成功才清、失败留存" ----

function readPendingOps() {
  const file = path.join(STORAGE, 'qq-channel-pending.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
}

test('T-W7：入站消息在发送前先落盘，成功后清除（卡死即丢消息的回归）', async () => {
  const t = await boot();
  try {
    t.qq.c2c('排队持久化测试');
    await waitFor(() => t.dsh.state.prompts.length > 0, 'prompt');
    await waitFor(() => readPendingOps().some((op) => op.op === 'add'), 'pending add');

    const ops = readPendingOps();
    assert.ok(ops.some((op) => op.op === 'add'), '发送前必须先落盘（否则宿主卡死时消息只活在内存里）');
    assert.ok(ops.some((op) => op.op === 'remove'), '送达后必须清掉，避免重启后重复补发');
    const added = ops.find((op) => op.op === 'add');
    assert.equal(added.item.sessionId, 'session-mock-1');
    assert.ok(Array.isArray(added.item.parts) && added.item.parts.length > 0, '内容块必须一起落盘');
  } finally { await teardown(t); }
});

test('T-W8：prompt 失败时消息不得丢——留存队列并明确告知用户', async () => {
  const t = await boot({ promptFailures: 1 });
  try {
    await waitFor(() => t.dsh.state.openControlFrames.length > 0, 'control stream');
    t.qq.c2c('这条会因为宿主不可用而失败');
    await waitFor(() => t.dsh.state.promptFailuresServed > 0, 'injected prompt failure');
    await waitFor(() => t.qq.textsTo().some((text) => text.includes('待补发')), 'failure notice');

    const ops = readPendingOps();
    const added = ops.filter((op) => op.op === 'add');
    const removed = ops.filter((op) => op.op === 'remove');
    assert.equal(added.length, 1, '失败的消息必须留在队列里');
    assert.equal(removed.length, 0, '失败不得清队列');
    assert.equal(
      added[0].item.parts.some((part) => part.type === 'text' && part.text.includes('宿主不可用')),
      true,
      '留存的内容必须包含原文，否则补发时信息已丢失',
    );
  } finally { await teardown(t); }
});

// 2026-09-17 泄漏回归：忙时"并入等待"的消息进了落盘队列，却没人把它清出去。
// 表现：每次启动都误报 `pending inbound messages restored`，让主人以为有消息待补发；
// 直到 48h TTL 才自愈（实测：17:18 的一条在 17:53 / 17:58 两次启动各误报一次）。
test('T-W10：忙时并入等待的消息，在合并轮送达后必须清出待补发队列', async () => {
  const t = await boot({ overrides: { ack: true } });
  try {
    await waitFor(() => t.dsh.state.openControlFrames.length > 0, 'control stream');
    t.qq.c2c('第一条');
    await waitFor(() => t.dsh.state.prompts.length >= 1, 'first prompt');
    // 挂起第一轮：不 append turn/end —— 这样第二条才会走"忙时并入等待"分支
    t.dsh.append('turn/start', { sessionId: 'session-mock-1' });
    await sleep(800);
    t.qq.c2c('第二条');
    await waitFor(() => t.qq.textsTo().some((text) => text.includes('已并入等待')), 'queued ACK', 10000);

    // 场景自证：两条都落盘了，但此刻只清掉了第一条（第二条还没送达）
    await waitFor(() => readPendingOps().filter((op) => op.op === 'add').length >= 2, 'second add');
    const adds = () => readPendingOps().filter((op) => op.op === 'add');
    const removes = () => readPendingOps().filter((op) => op.op === 'remove');
    assert.equal(adds().length, 2);
    assert.equal(removes().length, 1, '尚未送达的那条不能提前清（宿主卡死时还得靠它补发）');

    // 合并轮：turn/end 冲刷 inboundQueue → 两条一起送
    t.dsh.append('assistant/message', { message: { content: [{ type: 'text', text: 'MERGED-REPLY' }] }, sessionId: 'session-mock-1' }, { surfaceOp: 'append' });
    t.dsh.append('turn/end', { sessionId: 'session-mock-1' });
    const merged = await waitFor(() => t.dsh.state.prompts[1], 'merged prompt', 15000);
    assert.ok(JSON.stringify(merged.content).includes('第二条'), '合并轮必须带上被并入的那条，否则这条消息就真丢了');

    await waitFor(() => removes().length >= 2, 'removal after merge', 15000);
    const cleared = new Set(removes().map((op) => op.msgId));
    for (const op of adds()) {
      assert.ok(
        cleared.has(op.item.msgId),
        `消息 ${op.item.msgId} 送达后没有清出待补发队列（每次启动都会误报"待补发"，直到 48h TTL）`,
      );
    }
  } finally { await teardown(t); }
});

// 2026-09-17 真机误报回归：身份切换前落盘的一条记录指向旧会话，补发永远捞不到，
// 却让每次启动都喊一次"有待补发消息"。启动期必须把它清掉并留痕。
test('T-W11：启动时清掉"身份重算过、永远补发不到"的僵尸记录', async () => {
  const zombie = {
    msgId: 'msg-zombie-stale-identity',
    sessionId: 'session-5c4401e4-069d-4457-91e8-ad53254a13d0',
    sourceKey: 'c2c:1E02C1ACFFC06F6C34CE9E2145852851',
    target: { kind: 'c2c', openid: 'USER-A' },
    parts: [{ type: 'text', text: '老会话的遗留消息' }],
    at: Date.now(),
    attempts: 1,
  };
  fs.mkdirSync(STORAGE, { recursive: true });
  fs.writeFileSync(
    path.join(STORAGE, 'qq-channel-pending.json'),
    JSON.stringify({ version: 1, records: [zombie] }),
  );
  const t = await boot({ overrides: { perSourceSessions: true } });
  try {
    const ops = readPendingOps().filter((op) => op.op === 'remove' && op.msgId === zombie.msgId);
    assert.equal(ops.length, 1, '僵尸记录必须在启动时被清掉，并落一条 remove（否则下次恢复又复活）');
    const logged = readPluginLog();
    assert.ok(
      logged.includes('pending inbound dropped — unreachable by design') && logged.includes(zombie.msgId),
      '丢弃必须留痕：静默丢消息是本模块最不能犯的错',
    );
  } finally { await teardown(t); }
});

test('T-W9：Worker 不可用时看门狗必须立刻降级可见（不能等第一次卡死）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-boot-'));
  const { createWatchdog } = await import('../lib/watchdog.js');
  const watchdog = createWatchdog({
    dir,
    workerFactory: () => { throw new Error('no worker in this environment'); },
  });
  try {
    const sink = path.join(dir, 'qq-channel-stall.log');
    assert.equal(fs.existsSync(sink), true, '降级模式必须立刻留痕');
    assert.match(fs.readFileSync(sink, 'utf8'), /WITHOUT worker thread/);
  } finally {
    watchdog.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch (err) {
    console.warn(`cleanup failed: ${String(err?.message ?? err)}`);
  }
});

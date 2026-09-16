// T-V1F：v1 控制帧 → 统一模型的映射（拆出 channel.js 时补上的直测；
// 集成用例只跑 v2，这条路径此前没有被任何用例直接覆盖）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createV1FrameRouter } from '../lib/protocol/v1-frames.js';

function rig({ managed = true } = {}) {
  const pushed = [];
  const frames = [];
  const debugged = [];
  const onV1Frame = createV1FrameRouter({
    getPump: () => ({ push: (...args) => pushed.push(args) }),
    getHandler: () => ({ onControlFrame: (frame) => frames.push(frame) }),
    isManaged: () => managed,
    log: { debug: (msg, data) => debugged.push({ msg, data }) },
  });
  return { onV1Frame, pushed, frames, debugged };
}

test('session/event：受管会话才进事件泵，且标记 live/v1', () => {
  const t = rig();
  t.onV1Frame({ payload: { type: 'session/event', sessionId: 's1', event: { seq: 7 } } });
  assert.deepEqual(t.pushed, [['s1', { seq: 7 }, 'live', 'v1']]);

  const other = rig({ managed: false });
  other.onV1Frame({ payload: { type: 'session/event', sessionId: 's2', event: { seq: 8 } } });
  assert.deepEqual(other.pushed, [], '不属于本插件的会话不得进泵');
});

test('approval/question：帧信封转成瀑布帧，eventId 取 rpcId', () => {
  const t = rig();
  t.onV1Frame({ rpcId: 'rpc-1', payload: { type: 'approval/requested', sessionId: 's1', toolName: 'pwsh', reason: '因为' } });
  t.onV1Frame({ rpcId: 'rpc-2', payload: { type: 'question/requested', sessionId: 's1', questions: [{ id: 'q1' }] } });
  assert.deepEqual(t.frames[0], {
    type: 'waterfall', event: 'approval/request', eventId: 'rpc-1', agentId: 's1',
    request: { toolName: 'pwsh', reason: '因为' },
  });
  assert.deepEqual(t.frames[1], {
    type: 'waterfall', event: 'user-questions/request', eventId: 'rpc-2', agentId: 's1',
    request: { questions: [{ id: 'q1' }] },
  });
  assert.deepEqual(rig().frames, []);
});

test('未知类型留痕、缺 payload 不炸（v1 帧形态漂移时不能把通道带崩）', () => {
  const t = rig();
  t.onV1Frame({ payload: { type: 'whatever' } });
  assert.deepEqual(t.debugged, [{ msg: 'v1 frame unmapped', data: { type: 'whatever' } }]);
  assert.doesNotThrow(() => t.onV1Frame(undefined));
  assert.doesNotThrow(() => t.onV1Frame({}));
});

test('依赖惰性取：boot 期才创建的 pump/handler 在调用时才解析', () => {
  let pump = null;
  let handler = null;
  const pushed = [];
  const frames = [];
  const onV1Frame = createV1FrameRouter({
    getPump: () => pump,
    getHandler: () => handler,
    isManaged: () => true,
    log: null,
  });
  pump = { push: (...args) => pushed.push(args) };
  handler = { onControlFrame: (frame) => frames.push(frame) };
  onV1Frame({ payload: { type: 'session/event', sessionId: 's1', event: { seq: 1 } } });
  onV1Frame({ rpcId: 'r', payload: { type: 'approval/requested', sessionId: 's1' } });
  assert.equal(pushed.length, 1);
  assert.equal(frames.length, 1);
});

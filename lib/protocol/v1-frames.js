// v1 控制帧 → 统一模型 / 控制路径（字段依据 v1.2.4 反推，PROTOCOL.md §10.3）。
//
// 从 channel.js 拆出来：组装根已经贴着 400 行预算，而这段映射只依赖四个注入项。
// `pump` / `dshHandler` 在 boot 期才创建 → 依赖一律用 getter 惰性取，不能按值捕获。
export function createV1FrameRouter({ getPump, getHandler, isManaged, log }) {
  return function onV1Frame(frame) {
    const payload = frame?.payload;
    if (!payload) return;
    if (payload.type === 'session/event') {
      if (!isManaged(payload.sessionId)) return;
      getPump().push(payload.sessionId, payload.event, 'live', 'v1');
      return;
    }
    if (payload.type === 'approval/requested') {
      getHandler().onControlFrame({
        type: 'waterfall',
        event: 'approval/request',
        eventId: frame.rpcId,
        agentId: payload.sessionId,
        request: { toolName: payload.toolName, reason: payload.reason },
      });
      return;
    }
    if (payload.type === 'question/requested') {
      getHandler().onControlFrame({
        type: 'waterfall',
        event: 'user-questions/request',
        eventId: frame.rpcId,
        agentId: payload.sessionId,
        request: { questions: payload.questions ?? [] },
      });
      return;
    }
    log?.debug?.('v1 frame unmapped', { type: String(payload.type) });
  };
}

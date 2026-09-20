// 组装根（DESIGN.md §2.2 / §2.4.3）：把协议层、会话层、QQ 层接起来，并持有生命周期。
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { describe } from './result.js';
import { createAuth } from './protocol/auth.js';
import { createTransport } from './protocol/transport.js';
import { createDetector } from './protocol/detect.js';
import { createMux } from './protocol/mux.js';
import { createV2 } from './protocol/v2.js';
import { createV1 } from './protocol/v1.js';
import { createV1FrameRouter } from './protocol/v1-frames.js';
import { createSessionStore } from './session/state.js';
import { createEventPump } from './session/events.js';
import { createPendingStore } from './session/pending.js';
import { createTokenClient } from './qq/token.js';
import { createGateway } from './qq/gateway.js';
import { createSender } from './qq/send.js';
import { createUploader } from './qq/upload.js';
import { createOutbox } from './qq/outbox.js';
import { createAttachmentFetcher } from './qq/attachment.js';
import { createInboundRouter } from './qq/inbound.js';
import { createQqPort } from './qq/port.js';
import { createDshHandler } from './handlers/dsh.js';
import { createQqHandler } from './handlers/qq.js';
import { createDurableInbox } from './session/inbox-store.js';
import { createQuestionFlow } from './session/question-flow.js';
import { unreachablePendingReason } from './session/source-session.js';
import { createInstanceLock } from './lock.js';
import { createWatchdog } from './watchdog.js';
import { VERSION_TAG } from './version.js';

export const RECONNECT_MS = 1500;
export const SWEEP_INTERVAL_MS = 60000;
export const DEFAULT_WS_PORT = 3080;

export function storageRoot() {
  return path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'storages');
}

export function createChannel({ ctx, config, log }) {
  const storage = storageRoot();
  const dirs = {
    storage,
    outbox: path.join(storage, 'qq-channel-outbox'),
    sent: path.join(storage, 'qq-channel-outbox', 'sent'),
    failed: path.join(storage, 'qq-channel-outbox', 'failed'),
    inbox: path.join(storage, 'qq-channel-inbox'),
  };
  const port = ctx?.get?.('webServer')?.port ?? DEFAULT_WS_PORT;
  const dshUrl = `http://127.0.0.1:${port}`;
  for (const dir of [dirs.storage, dirs.outbox, dirs.inbox]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      log?.warn?.('cannot create storage dir', { dir, error: String(err?.message ?? err) });
    }
  }

  const state = createSessionStore({ log });
  const pending = createPendingStore({ log });
  // 待补发队列：跨进程存活（宿主卡死/被重启后消息仍在）。
  const pendingInbox = createDurableInbox({ dir: dirs.storage, log });
  // 多实例锁：同一个 QQ 机器人只能被一个 dsh 实例驱动（v1 语义，v2 漏迁后补回）。
  const lock = createInstanceLock({ file: path.join(dirs.storage, 'qq-channel.lock'), log });
  // 卡死看门狗：Worker 线程独立跑，主线程被独占时它是唯一还能落盘的角色。
  const watchdog = createWatchdog({ dir: dirs.storage, log });
  const auth = createAuth({ ctx, dshUrl, log });
  const transport = createTransport({ auth, dshUrl, log });
  const detector = createDetector({ transport, log });
  const mux = createMux({ dshUrl, auth, log });
  const token = createTokenClient({ config, log });
  const sender = createSender({ config, log, token });
  const qqPort = createQqPort({ sender, log });
  const uploader = createUploader({ config, log, token });
  const fetcher = createAttachmentFetcher({ config, log, token, inboxDir: dirs.inbox });

  const control = { clientId: null };
  let client = null;
  let pump = null;
  let gateway = null;
  let qqHandler = null;
  let dshHandler = null;
  let outbox = null;
  let managedSessionId = '';
  let disposed = false;
  let bootPromise = null;
  const timers = { reconnect: null, sweep: null };

  // ---- 提供给 QQ 侧的 DSH API ----
  const listSessions = () => trackRpc('session/list', () => client.list());
  /** 来源身份是否已存在（只用来选基线：查不到就返回 null，调用方按"新建"保守处理）。 */
  const sessionExists = async (sessionId) => {
    const listed = await listSessions();
    if (!listed?.ok) return null;
    return (listed.value?.items ?? []).some((item) => item?.sessionId === sessionId);
  };
  const dsh = {
    prompt: (request) => trackRpc('session/prompt', () => client.prompt(request)),
    createSession: (request = {}) => trackRpc('session/create', () => client.create(request)),
    listSessions,
    sessionExists,
    attach: (sessionId, baseline) => pump.attach(sessionId, baseline),
    currentSessionId: () => managedSessionId,
    qqAuth: () => token.ensure(),
    postEventResult: ({ eventId, outcome }) => {
      if (!client) return Promise.resolve({ ok: false, reason: 'disposed', code: 'no-protocol', message: 'no protocol' });
      if (client.protocol === 'v1') {
        return client.respond({ rpcId: eventId, value: outcome?.kind === 'result' ? outcome.value : outcome });
      }
      return client.postEventResult({ clientId: control.clientId, eventId, outcome });
    },
  };

  /** 给 DSH RPC 套上在飞登记：宿主挂起时"哪个请求挂了多久"直接进卡死报告。 */
  function trackRpc(label, fn) {
    const id = watchdog.inflight.start(label);
    let result;
    try {
      result = fn();
    } catch (error) {
      watchdog.inflight.end(id);
      throw error;
    }
    if (result && typeof result.then === 'function') {
      return result.then(
        (value) => {
          watchdog.inflight.end(id);
          return value;
        },
        (error) => {
          watchdog.inflight.end(id);
          throw error;
        },
      );
    }
    watchdog.inflight.end(id);
    return result;
  }

  const isManaged = (sessionId) => {
    if (!sessionId) return false;
    if (sessionId === managedSessionId) return true;
    // 用**管理权登记**而不是条目是否还在：空闲淘汰只回收条目，不得把会话判成"别人的会话"，
    // 否则审批/提问帧会被静默丢掉（真机 06:37 事故，见 session/state.js 文件头）。
    return config.perSourceSessions && state.isManagedSession(sessionId);
  };

  async function pickSession() {
    if (config.sessionId) return config.sessionId;
    const listed = await client.list();
    if (!listed.ok) {
      log?.error?.('session/list failed while picking a session', { error: describe(listed) });
      return '';
    }
    const items = (listed.value?.items ?? []).filter((item) => item && item.blank !== true);
    if (items.length === 0) return '';
    const sorted = items.slice().sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const main = sorted.find((item) => item.origin !== 'subagent') ?? sorted[0];
    return main.sessionId ?? '';
  }

  /** 控制流（`$events`）：审批/提问/取消都从这里来。 */
  async function openControl() {
    if (!client || client.protocol !== 'v2') return;
    const opened = await client.openControl({
      onFrame: (value) => dshHandler.onControlFrame(value),
      onEnd: () => {
        log?.warn?.('control stream ended by server — rebuilding mux');
        handleStreamDown();
      },
      onError: (error) => log?.error?.('control stream error frame', { code: error?.code, detail: String(error?.message ?? '').slice(0, 120) }),
    });
    if (!opened.ok) log?.error?.('control stream open failed', { error: describe(opened) });
    else log?.info?.('control stream opened', { endpoint: '$events' });
  }

  function handleStreamDown() {
    if (disposed) return;
    control.clientId = null;
    pump?.markDown();
    mux.dropSocket();
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (disposed || timers.reconnect) return;
    timers.reconnect = setTimeout(() => {
      timers.reconnect = null;
      if (disposed) return;
      reconnect().catch((err) => log?.error?.('mux reconnect failed', { error: String(err?.stack ?? err) }));
    }, RECONNECT_MS);
  }

  async function reconnect() {
    await openControl();
    await pump?.reattachAll();
    log?.info?.('mux rebuilt after disconnect', { msg: 'streams reattached' });
  }

  async function openEventChannel() {
    if (client.protocol === 'v2') {
      await openControl();
      if (managedSessionId) await pump.attach(managedSessionId, 'skip-history');
      return;
    }
    // v1：一条 events.mux 广播流承载会话事件 + 审批/提问。
    const opened = await client.openEventStream({
      onFrame: (frame) => onV1Frame(frame),
      onDown: () => {
        if (disposed) return;
        log?.warn?.('v1 event stream down — reconnecting');
        setTimeout(() => {
          if (!disposed) openEventChannel().catch((err) => log?.error?.('v1 reopen failed', { error: String(err?.message ?? err) }));
        }, RECONNECT_MS);
      },
    });
    if (!opened.ok) log?.error?.('v1 event stream open failed', { error: describe(opened) });
  }

  // v1 帧映射拆到 protocol/v1-frames.js（组装根贴着 400 行预算）；pump/handler 是 boot 期才建的 → 惰性取。
  const onV1Frame = createV1FrameRouter({
    getPump: () => pump,
    getHandler: () => dshHandler,
    isManaged,
    log,
  });

  async function boot() {
    // 先抢实例锁：抢不到就什么都不连（两个活实例同时驱动同一个 bot 会互相踢下线、抢消息）。
    const acquired = lock.acquire();
    if (!acquired.ok) {
      log?.error?.('another live dsh instance holds the QQ channel lock — channel stays idle', { holder: acquired.holder, file: lock.file });
      log?.line?.(`channel idle: another dsh instance holds the QQ channel lock (pid=${acquired.holder})`);
      return;
    }
    if (acquired.degraded) log?.warn?.('QQ channel lock unavailable — running unlocked', { file: lock.file });
    if (acquired.tookOverFrom !== null) log?.warn?.('took over a stale QQ channel lock', { stalePid: acquired.tookOverFrom });
    // 再恢复待补发队列，然后才连通任何东西：崩溃/卡死留下的消息必须在日志里立刻可见。
    // 顺手清掉"身份重算过、永远捞不回来"的老条目（否则每次启动都误报一次待补发）。
    const recovered = pendingInbox.restore(undefined, {
      dropWhere: (item) => unreachablePendingReason(item, { perSourceSessions: config.perSourceSessions }),
    });
    if (recovered.size > 0) {
      log?.warn?.('pending inbound queue recovered — ask the owner to send 补发 or wait for the next turn', {
        size: recovered.size,
        fromSnapshot: recovered.fromSnapshot,
        fromOps: recovered.fromOps,
      });
    }
    const cookie = await auth.ensure();
    if (!cookie.ok) log?.warn?.('auth cookie unavailable at boot (legacy host?)', { error: describe(cookie) });
    const detected = await detector.detect();
    if (!detected.ok) {
      log?.error?.('protocol detection failed — event channel NOT established', { error: describe(detected) });
      return;
    }
    client = detected.value === 'v2'
      ? createV2({ transport, mux, log })
      : createV1({ transport, auth, dshUrl, log });
    log?.info?.('channel starting', { protocol: client.protocol, sessionConfigured: !!config.sessionId });

    pump = createEventPump({ client, state, onAction: (action) => dshHandler.onAction(action), log });
    mux.onDown((code) => {
      log?.warn?.('mux socket down', { code });
      control.clientId = null;
      pump.markDown();
      scheduleReconnect();
    });

    managedSessionId = await pickSession();
    if (!managedSessionId) {
      log?.error?.('no DSH session to drive — configure sessionId or open the Web GUI once');
    }

    // 提问应答流程：多问题拆成"一个个问"，选项与自由输入同一通道。
    const questionFlow = createQuestionFlow({ log, config, port: qqPort, pending, dsh, targetFor: (id) => dshHandler?.targetFor?.(id) ?? null });
    dshHandler = createDshHandler({
      log,
      config,
      state,
      pending,
      port: qqPort,
      dsh: { setClientId: (id) => { control.clientId = id; }, currentSessionId: () => managedSessionId },
      isManaged,
      onTurnEnd: (sessionId, items) => qqHandler.onMergedTurn(sessionId, items),
      questionFlow,
    });
    const router = createInboundRouter({ config, log });
    qqHandler = createQqHandler({
      log,
      config,
      state,
      pending,
      port: qqPort,
      dsh,
      fetcher,
      pendingInbox,
      questionFlow,
      ownerTarget: () => (config.allowedUsers?.[0] ? { kind: 'c2c', openid: config.allowedUsers[0] } : null),
    });
    /** 网关分发入口：路由门控 → 消息 / 交互。任何异常都不得打断 WS 循环。 */
    const handleDispatch = (type, data) => {
      try {
        if (type === 'INTERACTION_CREATE') return qqHandler.onInteraction(data);
        const routed = router.route(type, data);
        if (!routed) return undefined;
        return qqHandler.onMessage(routed);
      } catch (err) {
        log?.error?.('dispatch crashed', { type, error: String(err?.stack ?? err) });
        return undefined;
      }
    };
    gateway = createGateway({
      config,
      log,
      token,
      onDispatch: handleDispatch,
      onReady: (data) => qqHandler.onReady(data),
    });

    await openEventChannel();
    if (config.appId && config.clientSecret) {
      gateway.start();
      outbox = createOutbox({ config, log, uploader, sender, dirs });
      outbox.start();
    } else {
      log?.warn?.('QQ credentials missing — gateway and outbox stay idle (DSH side still running)');
    }
    timers.sweep = setInterval(() => {
      if (disposed) return;
      const expired = pending.sweep();
      const drafts = questionFlow.sweep();
      const evicted = state.sweep();
      if (expired > 0 || evicted > 0 || drafts > 0) log?.info?.('sweep done', { expired, evicted, drafts });
    }, SWEEP_INTERVAL_MS);
    log?.info?.('channel up', {
      session: managedSessionId || '(none)',
      mode: config.perSourceSessions ? 'per-source' : 'single',
      storage,
      pendingInbound: pendingInbox.size(),
      watchdog: watchdog.sinkPath ? 'on' : 'off',
    });
    // 免结构化的启动行：切换/回退自检直接 grep 它（CUTOVER-PLAN.md §3 的判据原样保留）。
    log?.line?.(`bridge up: QQ -> DSH session ${managedSessionId || '(none)'} [${VERSION_TAG}, `
      + `mode=${config.perSourceSessions ? 'per-source' : 'single'}, `
      + `src=${config.sessionId ? 'configured' : 'auto-picked'}]`);
  }

  return {
    start() {
      // 同步返回、异步自举（验收台在 apply() 返回后 await 现象，不 await 我们的 promise）。
      bootPromise = boot().catch((err) => log?.error?.('channel boot failed', { error: String(err?.stack ?? err) }));
      return this;
    },
    /** 仅测试/诊断用：等待自举完成（生产路径不依赖它）。 */
    ready: () => bootPromise,
    snapshot: () => ({
      protocol: client?.protocol ?? null,
      managedSessionId,
      controlClientId: control.clientId,
      sessions: state.ids(),
      pending: pending.count(),
      pendingInbound: pendingInbox.size(),
      inflightRpc: watchdog.inflight.size(),
      lock: lock.isHeld(),
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timers.reconnect);
      clearInterval(timers.sweep);
      outbox?.stop();
      gateway?.stop();
      pump?.dispose();
      mux.dispose();
      client?.dispose?.();
      auth.dispose();
      transport.dispose();
      token.dispose();
      state.clear();
      pending.clear();
      watchdog.stop();
      lock.release();
      // 迭代终态：把队列压缩成快照，避免进程反复重启后追加日志无限增长。
      try {
        pendingInbox.compact();
      } catch (err) {
        log?.warn?.('pending inbox compact failed', { error: String(err?.message ?? err) });
      }
      log?.info?.('channel disposed');
    },
  };
}

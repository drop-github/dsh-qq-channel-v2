// dsh-qq-channel v2.0.0 入口（Cordis 插件）。
// 安装：dsh plugin --profile web add link:<本仓库路径>
// 配置：DSH Web 设置页「插件」卡片（命名空间 qq-channel），密钥字段自动脱敏。
//
// 能力：QQ 私聊/群 @ → 驱动 DSH 会话；Markdown 回复（自动分块、被动回复窗口）；
//       审批/提问在 QQ 上直接确认；图片/文件双向收发；断线重连；凭据卫生。
import { createLog } from './log.js';
import { createConfigSource, NAME, Config, normalizeConfig, CONFIG_KEYS } from './config.js';
import { createChannel, storageRoot } from './channel.js';

export const name = NAME;
export { Config };
export { CONFIG_KEYS };
export const inject = [];

/**
 * Cordis 入口：**同步**返回、异步自举（验收台在 `apply()` 返回后观测现象，不 await 本函数）。
 * 启动不得依赖 `onChange`（D15）：配置来源统一走 `setSource` 给的 thunk；
 * settings 服务晚就绪时由 `onRegistered` 回调触发一次"用已存配置重启"（A25）。
 */
export function apply(ctx, config) {
  const log = createLog({
    ctx,
    dir: storageRoot(),
    debug: process.env.QQ_CHANNEL_DEBUG === '1',
  });
  let channel = null;
  let stopped = false;
  let startedWith = null;

  const start = (reason) => {
    if (stopped) return;
    try {
      channel?.dispose();
      channel = null;
      const resolved = normalizeConfig(configSource.read(), log);
      startedWith = resolved;
      if (!resolved.enabled) {
        log.info('qq-channel disabled (enabled: false)', { reason });
        return;
      }
      channel = createChannel({ ctx, config: resolved, log });
      channel.start();
    } catch (err) {
      // start 失败必须可见（R2），但绝不能把宿主一起带走。
      log.error('channel start failed', { error: String(err?.stack ?? err) });
    }
  };

  /**
   * settings 服务晚就绪 / 配置被改：只有**生效配置确实不同**才重建通道。
   * 无条件重建会白白重连一次 QQ 网关（多一次 IDENTIFY、多一条 mux 流），
   * 既浪费配额，也让"重连次数"这类外部判据失真。
   */
  const restartIfChanged = (reason) => {
    if (stopped) return;
    const next = normalizeConfig(configSource.read(), log);
    if (startedWith && JSON.stringify(next) === JSON.stringify(startedWith)) {
      log.info('effective config unchanged — no restart', { reason });
      return;
    }
    log.info('effective config changed — restarting channel', { reason });
    start(reason);
  };

  const configSource = createConfigSource(ctx, log, config ?? {}, {
    onRegistered: () => restartIfChanged('settings-registered'),
    onChanged: () => restartIfChanged('settings-changed'),
  });

  start('boot');

  ctx.effect(() => () => {
    stopped = true;
    configSource.dispose();
    try {
      channel?.dispose();
    } catch (err) {
      log.error('channel dispose failed', { error: String(err?.stack ?? err) });
    }
    channel = null;
  });
}

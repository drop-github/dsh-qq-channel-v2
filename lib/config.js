// 配置 schema（17 键，与 v1.2.4 逐字一致 —— PROTOCOL.md §9.13 / N7）与设置注册（新/旧 API 双兼容）。
import z from '@deepseek-ai/schemastery';

export const NAME = 'qq-channel';

// 键集与 v1.2.4 `lib/index.js:46-68` 逐字一致；`appId` 接受 string|number（YAML 裸数字）并归一为 string。
export const Config = z.object({
  enabled: z.boolean().default(true),
  appId: z.transform(z.union([z.string(), z.number()]), (v) => String(v)).default(''),
  clientSecret: z.string().role('secret').default(''),
  token: z.string().role('secret').default(''),
  tokenUrl: z.string().default('https://bots.qq.com/app/getAppAccessToken'),
  gatewayUrl: z.string().default('wss://api.sgroup.qq.com/websocket'),
  apiBase: z.string().default('https://api.sgroup.qq.com'),
  sessionId: z.string().default(''),
  allowedGroups: z.array(z.string()).default([]),
  allowedUsers: z.array(z.string()).default([]),
  groupMembers: z.array(z.string()).default([]),
  ack: z.boolean().default(true),
  markdown: z.boolean().default(true),
  perSourceSessions: z.boolean().default(false),
  keyboardApprovals: z.boolean().default(false),
  maxChunk: z.number().default(2000),
  maxReplyChunks: z.number().default(4),
});

export const CONFIG_KEYS = Object.freeze(Object.keys(Config.dict));

/** 归一化（补默认值 / 转类型）；schema 拒绝时退回行配置，不让单个坏字段杀死整条通道。 */
export function normalizeConfig(raw, log) {
  try {
    return { ...Config(raw ?? {}) };
  } catch (err) {
    log?.warn?.('config invalid — falling back to row config', { error: String(err?.message ?? err) });
    return { ...(raw ?? {}) };
  }
}

/**
/**
 * 建配置来源（单一 thunk）。
 * 真实宿主时序（真机 6 次启动一致）：`apply()` 时 settings 服务**还没出现**，约 1s 后才可注册。
 * 一次性尝试失败的后果是"静默退回行配置"（QQ 凭据全空、会话目标错误），所以必须重试；
 * 一旦注册成功就让上层用新配置重启通道（A25）。
 */
export function createConfigSource(ctx, log, rowConfig, { onRegistered, onChanged, retryDelayMs = 500, maxAttempts = 24 } = {}) {
  let source = () => ({ ...rowConfig });
  let attempts = 0;
  let timer = null;
  let stopped = false;
  let legacyTried = false;

  const hooks = {
    setSource: (fn) => {
      source = typeof fn === 'function' ? fn : () => ({ ...rowConfig });
    },
    onChange: () => {
      log?.info?.('settings changed');
      onChanged?.();
    },
  };

  function settingsService() {
    try {
      return typeof ctx?.get === 'function' ? ctx.get('settings') : undefined;
    } catch (err) {
      log?.warn?.('ctx.get(settings) threw', { error: String(err?.message ?? err) });
      return undefined;
    }
  }

  function tryLegacyOnce() {
    if (legacyTried) return;
    legacyTried = true;
    // 旧 API（DSH ≤0.1.1）：动态导入，缺包属预期，不是故障（PROTOCOL.md §10.2）。
    void import('@deepseek-ai/dsh-settings')
      .then((mod) => {
        if (typeof mod?.installSettingsSection !== 'function') return;
        mod.installSettingsSection(ctx, NAME, Config, rowConfig, hooks);
        log?.info?.('settings installed via legacy installSettingsSection (unverified host)');
      })
      .catch((err) => {
        log?.info?.('legacy settings module not available', { error: String(err?.message ?? err) });
      });
  }

  function tryNow() {
    attempts += 1;
    const service = settingsService();
    if (typeof service?.installSection !== 'function') return false;
    try {
      service.installSection(ctx, NAME, Config, rowConfig, hooks);
      log?.info?.('settings section registered', { attempt: attempts });
      return true;
    } catch (err) {
      log?.error?.('settings installSection threw', { error: String(err?.message ?? err), attempt: attempts });
      return false;
    }
  }

  const registeredNow = tryNow();
  if (!registeredNow) {
    const retry = () => {
      if (stopped) return;
      if (tryNow()) {
        onRegistered?.();
        return;
      }
      if (attempts < maxAttempts) timer = setTimeout(retry, retryDelayMs);
      else log?.warn?.('settings registration exhausted — using row config', { attempts });
    };
    timer = setTimeout(retry, retryDelayMs);
    tryLegacyOnce();
  }

  return {
    read: () => normalizeConfig(source(), log),
    registered: () => registeredNow,
    dispose() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    },
  };
}

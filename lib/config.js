// 配置 schema（17 键，与 v1.2.4 逐字一致 —— PROTOCOL.md §9.13 / N7）与设置注册（宿主三代 API 兼容）。
//
// 宿主设置 API 的三代形态（2026-09-22 在 0.1.6-alpha.2 与 0.1.7-alpha.1 两棵树上逐条比对确认）：
//   1. ≤0.1.1（v1 时代）：包级 `installSettingsSection(ctx, ns, schema, entry, hooks)`；
//   2. 0.1.5–0.1.6：服务级 `ctx.get('settings').installSection(owner, ns, schema, entry, hooks)`；
//   3. ≥0.1.7：**`installSection` 被移除** —— 插件配置改由 plugin-manager + profile entry 持有
//      （`dsh-settings` 新版只剩 update/describe/schema 等读写面），设置面板直接按插件的 `Config`
//      schema 渲染。这一代不需要插件做任何注册：行配置就是生效配置，宿主重建插件时会带上新配置。
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

/**
 * 第三代宿主（DSH ≥0.1.7）的设置服务辨识：没有 `installSection`，但有配置读写面。
 * 只用于判断"配置是否已由宿主托管"，不做任何注册调用。
 */
const HOST_MANAGED_MEMBERS = ['update', 'describe', 'schema', 'configure', 'replace', 'mutate'];

export function isHostManagedSettings(service) {
  if (!service || typeof service.installSection === 'function') return false;
  return HOST_MANAGED_MEMBERS.some((key) => typeof service[key] === 'function');
}

/**
 * 归一化（补默认值 / 转类型）；schema 拒绝时退回行配置，不让单个坏字段杀死整条通道。
 *
 * 注意：schemastery 的 `z.transform` 会把归一化结果**回写输入对象**，而宿主 settings 传进来的
 * 是 frozen 对象 —— 直接 `Config(raw)` 会抛 `Cannot assign to read only property 'appId'`，
 * 于是每次启动都静默降级到未归一化的原始配置（默认值/类型强转全失效）。
 * 故先浅拷贝再交给 schema。
 */
export function normalizeConfig(raw, log) {
  try {
    return { ...Config({ ...(raw ?? {}) }) };
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
  let hostManaged = false;

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
    if (typeof service?.installSection === 'function') {
      try {
        service.installSection(ctx, NAME, Config, rowConfig, hooks);
        log?.info?.('settings section registered', { attempt: attempts });
        return true;
      } catch (err) {
        log?.error?.('settings installSection threw', { error: String(err?.message ?? err), attempt: attempts });
        return false;
      }
    }
    if (isHostManagedSettings(service)) {
      // ≥0.1.7：设置面板由 plugin-manager 依本插件 `Config` schema 渲染，插件侧无需注册。
      // 行配置即生效配置；配置改动会让宿主重建本插件（届时带新配置再次 apply），故不触发"重启通道"。
      hostManaged = true;
      log?.info?.('settings are host-managed (DSH >= 0.1.7) — using the profile entry config', { attempt: attempts });
      return true;
    }
    return false;
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
    /** 配置由宿主托管（DSH ≥0.1.7）：插件没有自己的设置段。 */
    hostManaged: () => hostManaged,
    dispose() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    },
  };
}

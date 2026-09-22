// PROVENANCE: copied verbatim from E:\DSHWorkspace\qq-channel-verify\fake-ctx.mjs (read-only reference rig)
// at 2026-09-15T20:51:09.105Z; source fingerprint = 67 lines. Do NOT edit the original.
// Any behaviour change belongs in this copy (and must be noted in docs/ROUND-2-REPORT.md).
// Fake Cordis context: just enough surface for dsh-qq-channel to run in-process.
// Real surface used by the plugin (v1.2.4 and v2 must stay within it):
//   ctx.logger {info,warn,error}
//   ctx.get('settings')  -> { installSection(ctx, name, schema, initial, hooks) }
//   ctx.get('webServer') -> { port }
//   ctx.get('connection')-> { authenticatedUrl(baseUrl) }
//   ctx.effect(fn)       -> registers a disposer factory
export function makeFakeCtx({ port, token = 'MOCK-LAUNCH-TOKEN', config, logs = [], name = 'qq-channel', settingsDelayMs = 0, settingsOverride = null, connectionNotReadyTimes = 0, hostManagedSettings = false } = {}) {
  const disposers = [];
  let currentConfig = { ...config };
  const readyAt = Date.now() + settingsDelayMs;
  let connectionNotReady = connectionNotReadyTimes;
  const stats = { settingsGetCalls: 0, settingsReadyOnFirstGet: false, installCalls: 0, connectionGetCalls: 0 };
  const settings = {
    installSection(_ctx, _name, _schema, initial, hooks) {
      // Real service contract (dsh-settings/lib/index.js): register -> setSource(() => scope.get())
      // -> onChange() immediately, and again on every scope change. Model both calls.
      stats.installCalls += 1;
      currentConfig = { ...initial, ...(settingsOverride ?? {}) };
      hooks?.setSource?.(() => ({ ...currentConfig }));
      hooks?.onChange?.();
      return true;
    },
  };
  const ctx = {
    logger: {
      info: (m) => logs.push(`info ${m}`),
      warn: (m) => logs.push(`warn ${m}`),
      error: (m) => logs.push(`error ${m}`),
    },
    get: (service) => {
      if (service === 'settings') {
        stats.settingsGetCalls += 1;
        // Real host timing (verified in qq-channel.log): the settings service shows up only
        // ~1s AFTER plugin apply() — v1 needed 3 attempts to register. Model that delay.
        if (Date.now() < readyAt) return undefined;
        if (stats.settingsGetCalls === 1) stats.settingsReadyOnFirstGet = true;
        // DSH ≥0.1.7 形态：没有 installSection，配置由 plugin-manager/profile entry 托管
        // （dsh-settings 新版只剩 update/describe/schema 等读写面）。
        if (hostManagedSettings) {
          return {
            update: async () => {},
            describe: () => ({}),
            schema: () => ({}),
            configure: () => {},
          };
        }
        return settings;
      }
      if (service === 'webServer') return { port };
      if (service === 'connection') {
        // 宿主服务晚就绪的真实形态：前 N 次拿不到 connection（DSH ≥0.1.7 下没有 settings 重建兜底，
        // 插件必须靠自己的有界重试把通道拉起来 —— 见 channel.js 的 scheduleBootRetry）。
        if (connectionNotReady > 0) {
          connectionNotReady -= 1;
          stats.connectionGetCalls += 1;
          return undefined;
        }
        stats.connectionGetCalls += 1;
        return {
          authenticatedUrl: (base) => {
            const u = new URL(base);
            u.searchParams.set('token', token);
            return u.toString();
          },
        };
      }
      return undefined;
    },
    effect: (fn) => { disposers.push(fn); return () => {}; },
    on: () => () => {},
  };
  return {
    ctx,
    logs,
    token,
    stats,
    dispose() {
      for (const fn of disposers) {
        try { fn()(); } catch { /* ignore */ }
      }
      disposers.length = 0;
    },
  };
}

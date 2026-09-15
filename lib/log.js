// 结构化日志 + 凭据脱敏（DESIGN.md §2.2 / D9 / R1 / R7）。
// 这一层是**唯一**允许把字符串写到 ctx.logger / 文件的出口：调用点不得自行拼接 secret。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_LINE = 240;
const DEFAULT_RATE_WINDOW_MS = 1000;
const DEFAULT_RATE_MAX = 20;

const QQ_TOKEN_HEADER = /\bQQBot\s+[A-Za-z0-9._~+/=-]+/g;
const TOKEN_QUERY = /([?&]token=)[^&\s"']+/g;
const SECRET_ASSIGN = /\b(secret|clientSecret|access_token|password)\b\s*[:=]\s*[^\s,"']+/gi;

/** 只允许长度 / sha256 前 8 位出现在日志里（N1）。 */
export function fingerprint(secret) {
  const text = String(secret ?? '');
  if (text.length === 0) return 'none';
  return `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 8)}(len=${text.length})`;
}

/**
 * 脱敏器：显式注册过的 secret 值一律不许出现在任何一行输出里；
 * 另外按固定模式兜住 `QQBot <token>`、`?token=` 与 `secret=` 三种常见泄漏形态。
 */
export function createRedactor() {
  const secrets = new Set();
  // 掩码里不要出现 `secret` 字面量：否则会被下面的 SECRET_ASSIGN 规则二次改写，日志变得难以辨认。
  const mask = (value) => `«redacted:${fingerprint(value)}»`;
  return {
    register(value) {
      if (typeof value === 'string' && value.length >= 4) secrets.add(value);
    },
    redact(text) {
      let out = String(text ?? '');
      for (const secret of secrets) out = out.split(secret).join(mask(secret));
      out = out.replace(QQ_TOKEN_HEADER, (m) => m.replace(/[A-Za-z0-9._~+/=-]+$/, '«redacted»'));
      out = out.replace(TOKEN_QUERY, '$1«redacted»');
      out = out.replace(SECRET_ASSIGN, (m) => m.replace(/[:=]\s*.*$/, '=«redacted»'));
      return out;
    },
    count() {
      return secrets.size;
    },
  };
}

function formatFields(fields) {
  if (!fields) return '';
  const pairs = [];
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === undefined) continue;
    let value = raw;
    if (typeof value === 'string' && value.length > 80) value = `${value.slice(0, 77)}...`;
    else if (value !== null && typeof value === 'object') {
      try {
        value = JSON.stringify(value);
        if (value.length > 80) value = `${value.slice(0, 77)}...`;
      } catch {
        value = '[unserializable]';
      }
    }
    pairs.push(`${key}=${value}`);
  }
  return pairs.length > 0 ? ` ${pairs.join(' ')}` : '';
}
/**
 * 建日志器。
 * - `sink`：文件路径（`$DSH_HOME/storages/qq-channel.log`）；写失败只累计计数，不抛。
 * - 高频限流：同名事件每 `rateWindowMs` 最多 `rateMax` 行，超出记 suppressed 计数并在下一个窗口报一次。
 */
export function createLog({ ctx, dir, debug = false, rateWindowMs = DEFAULT_RATE_WINDOW_MS, rateMax = DEFAULT_RATE_MAX } = {}) {
  const redactor = createRedactor();
  const logger = ctx?.logger;
  const sinkPath = dir ? path.join(dir, 'qq-channel.log') : null;
  const counters = new Map();
  const rate = new Map();
  const faults = { sink: 0, sinkNotified: false };

  const emit = (level, line) => {
    const text = redactor.redact(line).slice(0, MAX_LINE);
    try {
      if (level === 'error') logger?.error?.(text);
      else if (level === 'warn') logger?.warn?.(text);
      else if (level === 'debug') logger?.debug?.(text);
      else logger?.info?.(text);
    } catch {
      faults.sink += 1;    // logger 抛错不能反向杀死通道，计入故障面
    }
    if (sinkPath && level !== 'debug') {
      try {
        fs.mkdirSync(path.dirname(sinkPath), { recursive: true });
        fs.appendFileSync(sinkPath, `[${new Date().toISOString()}] ${level} ${text}\n`);
      } catch {
        faults.sink += 1;
        if (!faults.sinkNotified) {
          faults.sinkNotified = true;
          try { logger?.warn?.('qq-channel: file log sink unavailable'); } catch { faults.sink += 1; }
        }
      }
    }
  };

  const throttled = (event) => {
    const now = Date.now();
    const entry = rate.get(event) ?? { window: now, count: 0, suppressed: 0 };
    if (now - entry.window > rateWindowMs) {
      const suppressed = entry.suppressed;
      entry.window = now;
      entry.count = 0;
      entry.suppressed = 0;
      rate.set(event, entry);
      if (suppressed > 0) emit('warn', `log ${event} suppressed=${suppressed} (rate limited)`);
    }
    entry.count += 1;
    if (entry.count > rateMax) {
      entry.suppressed += 1;
      rate.set(event, entry);
      return true;
    }
    rate.set(event, entry);
    return false;
  };

  const write = (level, event, fields) => {
    if (throttled(event)) {
      counters.set(`${event}:suppressed`, (counters.get(`${event}:suppressed`) ?? 0) + 1);
      return;
    }
    emit(level, `qq-channel: ${event}${formatFields(fields)}`);
  };

  return {
    registerSecret: (value) => redactor.register(value),
    redact: (text) => redactor.redact(text),
    fingerprint,
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    /** 免结构化的一行（仍走脱敏 + 文件 sink）：用于"人肉 grep"的启动/切换自检行。 */
    line: (text) => emit('info', `qq-channel: ${String(text)}`),
    debug: (event, fields) => {
      counters.set(event, (counters.get(event) ?? 0) + 1);
      if (debug) write('debug', event, fields);
    },
    /** 未知事件类型计数（D18：静默但可见）。 */
    countUnknown: (type) => counters.set(`unknown:${type}`, (counters.get(`unknown:${type}`) ?? 0) + 1),
    counters: () => Object.fromEntries(counters),
    faults: () => ({ ...faults }),
    sinkPath: () => sinkPath,
  };
}

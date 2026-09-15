// 统一结果类型（DESIGN.md §2.3.1 / D8）。
// 规矩：失败必须可分支（看 `reason`）、可观测（带原始 `code`），禁止抛异常穿透到调用点的 try/catch 里被吞掉。
export const REASONS = Object.freeze([
  'transport',           // 传输层失败：非 200、body 不可解析、连接错误
  'timeout',             // 硬超时
  'unauthorized',        // 401（cookie 缺失/失效）
  'not-found',           // 404（未知方法/路径）
  'protocol-mismatch',   // 探测三态里的"是 v2 但 args 键不符"或两协议都不可用
  'rejected',            // 对端明确拒绝（gateway/* 业务错误、HTTP 4xx 非 401/404）
  'unavailable',         // 暂时不可用（5xx、429、连接被拒）
  'no-target',           // 出站端口无目标（P2-12）
  'no-session',          // 会话未就绪（P2-14）
  'disposed',            // 生命周期已结束
]);

const REASON_SET = new Set(REASONS);

/** 成功结果。 */
export function ok(value) {
  return { ok: true, value };
}

/**
 * 失败结果。`reason` 必须来自封闭词表（DESIGN §2.3.1：禁止新增未登记值，写错立刻炸而不是静默漂移）。
 * `code` 只承载对端原始码（如 `gateway/arguments-invalid`），用于日志与判别，不参与控制流。
 */
export function fail(reason, code, message) {
  if (!REASON_SET.has(reason)) {
    throw new TypeError(`result.fail: unregistered reason "${reason}" (allowed: ${REASONS.join(', ')})`);
  }
  return { ok: false, reason, code, message };
}

/** 把任意 Result 归一成布尔，便于分支。 */
export function succeeded(result) {
  return result !== undefined && result !== null && result.ok === true;
}

/** 失败时取一句话描述（日志用）。 */
export function describe(result) {
  if (succeeded(result)) return 'ok';
  if (!result) return 'none';
  return [result.reason, result.code, result.message].filter(Boolean).join(' / ');
}

/** 失败原因词表校验（供测试与评审静态核对）。 */
export function isRegisteredReason(value) {
  return REASON_SET.has(value);
}

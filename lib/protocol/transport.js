// typert HTTP RPC（PROTOCOL.md §1）：信封、状态码语义、401 重认证重试一次、超时分档。
import { randomUUID } from 'node:crypto';
import { ok, fail, describe } from '../result.js';

// D7：prompt 会排队等宿主受理，15s 对慢机器偏紧；其余方法保持短超时以便快速暴露挂起。
export const TIMEOUT_DEFAULT_MS = 15000;
export const TIMEOUT_PROMPT_MS = 60000;

function mapCodeToReason(code, status) {
  if (status === 401) return 'unauthorized';
  if (status === 404) return 'not-found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'unavailable';
  if (status >= 500) return 'unavailable';
  if (typeof code === 'string' && code.startsWith('gateway/')) return 'rejected';
  return status >= 400 ? 'rejected' : 'transport';
}

export function createTransport({ auth, dshUrl, log }) {
  let disposed = false;

  async function once(endpoint, args, timeoutMs) {
    const cookie = auth.get();
    const body = { type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } };
    let res;
    try {
      res = await fetch(`${dshUrl}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = String(err?.name ?? 'fetch-error');
      const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'transport';
      return fail(reason, name, String(err?.message ?? err));
    }
    let text;
    try {
      text = await res.text();
    } catch (err) {
      return fail('transport', 'body-read-failed', String(err?.message ?? err));
    }
    // 401 是纯文本响应、无 JSON body（§1.2）→ 只能看状态码。
    if (res.status === 401) return fail('unauthorized', 'http-401', 'unauthorized');
    if (res.status === 404) return fail('not-found', 'http-404', 'not found');
    if (!res.ok) return fail(mapCodeToReason(undefined, res.status), `http-${res.status}`, text.slice(0, 160));
    let full;
    try {
      full = JSON.parse(text);
    } catch (err) {
      return fail('transport', 'bad-json', String(err?.message ?? err));
    }
    if (full?.result?.ok === true) return ok(full.result.value);
    const error = full?.result?.error ?? {};
    // 业务错误与网关错误恒为 HTTP 200，错误在 body 里（§1.2）。
    return fail(mapCodeToReason(error.code, res.status), error.code, String(error.message ?? '').slice(0, 200));
  }

  /** 业务调用：内含"401 → 强制重认证 → 原样重试一次"（P0-2 / A3）。args 由调用点铸造并复用 → requestId 幂等（A13）。 */
  async function call(endpoint, args, { timeoutMs = TIMEOUT_DEFAULT_MS } = {}) {
    if (disposed) return fail('disposed', 'transport-disposed', 'transport disposed');
    const first = await auth.ensure();
    if (!first.ok) return first;
    let result = await once(endpoint, args, timeoutMs);
    if (!result.ok && result.reason === 'unauthorized') {
      log?.warn?.('rpc unauthorized — re-authenticating once', { endpoint });
      const refreshed = await auth.ensure(true);
      if (!refreshed.ok) return refreshed;
      result = await once(endpoint, args, timeoutMs);
    }
    if (!result.ok) log?.debug?.('rpc failed', { endpoint, error: describe(result) });
    return result;
  }

  /** 原始信封 POST（v1 的 `/api/respond` 走 `client-response`，不是 client-request）。 */
  async function raw(path, body, { timeoutMs = TIMEOUT_DEFAULT_MS } = {}) {
    if (disposed) return fail('disposed', 'transport-disposed', 'transport disposed');
    const ensured = await auth.ensure();
    if (!ensured.ok) return ensured;
    const cookie = auth.get();
    let res;
    try {
      res = await fetch(`${dshUrl}/api/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return fail(err?.name === 'TimeoutError' ? 'timeout' : 'transport', String(err?.name ?? 'fetch-error'), String(err?.message ?? err));
    }
    if (!res.ok) return fail(mapCodeToReason(undefined, res.status), `http-${res.status}`, 'raw rpc failed');
    return ok(true);
  }

  return {
    call,
    raw,
    dispose() {
      disposed = true;
    },
    disposed: () => disposed,
  };
}

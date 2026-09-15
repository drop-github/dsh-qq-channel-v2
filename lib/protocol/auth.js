// browserAuth：launch token → cookie（PROTOCOL.md §2）。
// 单一持有者：整个插件只有这里能取/刷新 cookie，transport 只问它要。
import { ok, fail } from '../result.js';

export const AUTH_TIMEOUT_MS = 10000;

export function createAuth({ ctx, dshUrl, log }) {
  let cookie = null;
  let flight = null;
  let disposed = false;

  /** `connection.authenticatedUrl(baseUrl)` → 带 `?token=` 的绝对 URL（必然含 token）。 */
  function authenticatedUrl() {
    const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : undefined;
    if (!connection || typeof connection.authenticatedUrl !== 'function') {
      return fail('unavailable', 'no-connection-service', 'connection.authenticatedUrl unavailable (legacy host?)');
    }
    try {
      return ok(connection.authenticatedUrl(dshUrl));
    } catch (err) {
      return fail('transport', 'auth-url-failed', String(err?.message ?? err));
    }
  }

  /** GET /?token=… → 303 + set-cookie；必须 `redirect:'manual'`（跟随后 cookie 会丢）。 */
  async function exchange() {
    const url = authenticatedUrl();
    if (!url.ok) return url;
    let token = null;
    try {
      token = new URL(url.value).searchParams.get('token');
    } catch (err) {
      return fail('transport', 'auth-url-invalid', String(err?.message ?? err));
    }
    if (token) log?.registerSecret?.(token);
    let res;
    try {
      res = await fetch(url.value, { redirect: 'manual', signal: AbortSignal.timeout(AUTH_TIMEOUT_MS) });
    } catch (err) {
      return fail('unavailable', err?.name ?? 'auth-fetch-failed', String(err?.message ?? err));
    }
    const setCookie = res.headers?.get?.('set-cookie');
    if (!setCookie) {
      return fail('unauthorized', `http-${res.status}`, 'launch token exchange returned no cookie');
    }
    cookie = setCookie.split(';')[0];
    // 只记指纹：明文 token 能换全量 /api 凭证，绝不落日志（P0-1 / A2）。
    log?.info?.('auth cookie acquired', { token: log.fingerprint(token), len: cookie.length });
    return ok(cookie);
  }

  /** 单飞：并发调用共享同一个交换 promise。`force=true` 用于 401 后强制重取。 */
  async function ensure(force = false) {
    if (disposed) return fail('disposed', 'auth-disposed', 'auth disposed');
    if (cookie && !force) return ok(cookie);
    if (!flight) {
      flight = exchange()
        .then((result) => {
          if (result.ok) cookie = result.value;
          return result;
        })
        .finally(() => {
          flight = null;
        });
    }
    return flight;
  }

  return {
    ensure,
    get: () => cookie,
    has: () => cookie !== null,
    dispose() {
      disposed = true;
      cookie = null;
      flight = null;
    },
  };
}

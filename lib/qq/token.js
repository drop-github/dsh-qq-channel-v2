// QQ 应用级 access token（PROTOCOL.md §8「token」/ `thincoder-v2-qq-spec.md §1`）。
// 提前 ~120s 刷新；并发刷新单飞（令牌过期瞬间不得打出多个刷新请求）。
import { ok, fail } from '../result.js';

export const TOKEN_TIMEOUT_MS = 20000;
export const REFRESH_MARGIN_MS = 120 * 1000;
const MIN_TTL_MS = 30 * 1000;

export function createTokenClient({ config, log, fetchImpl = fetch }) {
  let token = null;
  let expiresAt = 0;
  let flight = null;
  let disposed = false;

  async function refresh() {
    let res;
    try {
      res = await fetchImpl(config.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId: config.appId, clientSecret: config.clientSecret }),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      });
    } catch (err) {
      return fail('unavailable', String(err?.name ?? 'token-fetch-failed'), String(err?.message ?? err));
    }
    let text;
    try {
      text = await res.text();
    } catch (err) {
      return fail('transport', 'token-body-read-failed', String(err?.message ?? err));
    }
    if (!res.ok) {
      // 凭据错（401/403）与"服务端暂时不可用"必须分开：前者要人改配置，后者等重试。
      const reason = res.status === 401 || res.status === 403 ? 'unauthorized' : res.status >= 500 ? 'unavailable' : 'rejected';
      const code = reason === 'unauthorized' ? 'qq-credentials-rejected' : `http-${res.status}`;
      log?.error?.('QQ token request failed', { code, status: res.status, len: text.length });
      return fail(reason, code, text.slice(0, 160));
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      return fail('transport', 'token-bad-json', String(err?.message ?? err));
    }
    if (!data || typeof data.access_token !== 'string' || data.access_token.length === 0) {
      return fail('rejected', 'qq-token-missing', 'getAppAccessToken returned no access_token');
    }
    token = data.access_token;
    log?.registerSecret?.(token);
    const ttlMs = Number(data.expires_in) > 0 ? Number(data.expires_in) * 1000 : 7200 * 1000;
    expiresAt = Date.now() + Math.max(ttlMs - REFRESH_MARGIN_MS, MIN_TTL_MS);
    log?.info?.('QQ access token refreshed', { fingerprint: log?.fingerprint?.(token), expiresInSec: Math.round(ttlMs / 1000) });
    return ok(token);
  }

  return {
    /** 有效则直接返回；否则（含单飞）刷新。 */
    ensure() {
      if (disposed) return Promise.resolve(fail('disposed', 'token-disposed', 'token client disposed'));
      if (token && Date.now() <= expiresAt) return Promise.resolve(ok(token));
      if (!flight) {
        flight = refresh().finally(() => {
          flight = null;
        });
      }
      return flight;
    },
    peek: () => token,
    /** 4004（鉴权失败）时清空，让下一次 ensure 重新取。 */
    invalidate() {
      token = null;
      expiresAt = 0;
      log?.warn?.('QQ access token invalidated');
    },
    dispose() {
      disposed = true;
      token = null;
      expiresAt = 0;
      flight = null;
    },
  };
}

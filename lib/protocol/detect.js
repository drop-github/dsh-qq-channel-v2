// 协议探测三态（D11）：v2 / v1 / protocol-mismatch。
// 关键纪律：`gateway/arguments-invalid` 说明"对端就是 v2，只是我们的 args 键不符"——
// 这属于**协议事实不符**，绝不回退到 v1（回退会让整条事件通道在 v2 宿主上静默死掉，验收 A1 的来历）。
import { ok, fail, describe } from '../result.js';
import { TIMEOUT_DEFAULT_MS } from './transport.js';

export function createDetector({ transport, log }) {
  let detected = null;
  let flight = null;

  async function run() {
    const probeErrors = [];
    // v2：`session/list` 的 args 键**恰为** `_request`（PROTOCOL.md §1.4）。
    const v2 = await transport.call('session/list', { _request: {} }, { timeoutMs: TIMEOUT_DEFAULT_MS });
    if (v2.ok && Array.isArray(v2.value?.items)) {
      detected = 'v2';
      log?.info?.('protocol detected', { protocol: 'v2' });
      return ok('v2');
    }
    if (!v2.ok && v2.code === 'gateway/arguments-invalid') {
      log?.error?.('protocol mismatch — v2 gateway rejected our argument keys', { code: v2.code, detail: v2.message });
      return fail('protocol-mismatch', v2.code, `session/list args rejected: ${v2.message}`);
    }
    probeErrors.push(`v2: ${v2.ok ? `unexpected value ${JSON.stringify(v2.value)?.slice(0, 80)}` : describe(v2)}`);

    // v1（DSH ≤0.1.1）：`/api/session.list`，payload 就是参数本身。
    const v1 = await transport.call('session.list', {}, { timeoutMs: TIMEOUT_DEFAULT_MS });
    if (v1.ok && Array.isArray(v1.value?.items)) {
      detected = 'v1';
      log?.info?.('protocol detected', { protocol: 'v1' });
      return ok('v1');
    }
    probeErrors.push(`v1: ${v1.ok ? `unexpected value ${JSON.stringify(v1.value)?.slice(0, 80)}` : describe(v1)}`);
    log?.error?.('protocol probe failed', { detail: probeErrors.join(' | ') });
    return fail('protocol-mismatch', 'no-usable-protocol', probeErrors.join(' | '));
  }

  return {
    /** 命中后缓存；并发调用单飞。 */
    detect() {
      if (detected) return Promise.resolve(ok(detected));
      if (!flight) {
        flight = run().finally(() => {
          flight = null;
        });
      }
      return flight;
    },
    current: () => detected,
    reset() {
      detected = null;
    },
  };
}

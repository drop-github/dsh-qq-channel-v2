// 来源 → 会话身份（确定性推导）。
//
// 动机（v1 → v2 的回归，2026-09-17）：v1 把 `sourceKey → sessionId` 存在
// `qq-channel-sources.json` 里，v2 把它丢了，于是每次重启都为同一个 QQ 来源新建一个会话，
// 电脑端的对话每重启换一次。Hermes 的做法是把这件事**算出来**而不是记下来
// （`gateway/session.py: build_session_key` → `get_or_create_session`）。
//
// DSH 里同样能"算出来"：`session/create` 接受调用方自带的 `sessionId`，语义是
// "磁盘上有这个身份就 resume、没有才新建"（dsh-api-session-controller `createOrAdopt`）。
// 所以这里只负责把 sourceKey 稳定地映射成一个 sessionId —— 不落任何 side 文件。
import { createHash } from 'node:crypto';

/**
 * 本插件专用的 UUIDv5 命名空间。**改了它等于把所有来源都换到新会话**，属于破坏性变更。
 * 取值来源：`uuidV5('dsh-qq-channel', DNS 命名空间)`，固化下来避免运行时依赖。
 */
export const SOURCE_SESSION_NAMESPACE = '3f1d29bb-6e49-5b77-b4e7-fae5199dc376';

/** RFC 4122 v5（SHA-1）UUID。 */
export function uuidV5(name, namespace = SOURCE_SESSION_NAMESPACE) {
  const hex = String(namespace).replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new Error(`uuidV5: invalid namespace ${namespace}`);
  const digest = createHash('sha1')
    .update(Buffer.from(hex, 'hex'))
    .update(String(name), 'utf8')
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;   // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80;   // RFC 4122 variant
  const out = bytes.toString('hex');
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}

/** sourceKey（`c2c:<openid>` / `grp:<group>:<user>`）→ 稳定的 DSH 会话身份。 */
export function sessionIdForSource(sourceKey) {
  const key = String(sourceKey ?? '');
  if (key.length === 0) throw new Error('sessionIdForSource requires a non-empty source key');
  return `session-${uuidV5(`qq-channel:${key}`)}`;
}

/**
 * 待补发记录是否已经"补发不到"。
 *
 * per-source 模式下，补发是按**当前来源算出来的会话**去捞的（`handlers/qq.js` 的 `replayPending`
 * 只取 `item.sessionId === 当前会话`），所以一条记录只要指向了别的会话，就永远捞不回来：
 * 留着它只会让每次启动都误报"有待补发消息"（实测：v1 → v2 身份切换前的一条 17:18 记录，
 * 在 17:53、17:58 两次启动各误报一次，直到 48h TTL 才消失）。
 *
 * 返回丢弃原因；`null` = 仍然可达，必须留着。
 */
export function unreachablePendingReason(item, { perSourceSessions = true } = {}) {
  // 关掉 per-source 时补发按"当前受管会话"捞，记录里的会话可能正好是它 → 不能按身份判死。
  if (!perSourceSessions) return null;
  const sourceKey = String(item?.sourceKey ?? '');
  if (sourceKey.trim().length === 0) return null;        // 空/空白来源：判不了 → 保守留着
  let derived;
  try { derived = sessionIdForSource(sourceKey); } catch { return null; }
  if (derived === item?.sessionId) return null;
  return `source ${sourceKey} now maps to ${derived}, record points at ${item?.sessionId}`;
}

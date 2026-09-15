// 入站路由与去重（任务书 §1.3 / P2-5）。
// 去重窗口 300s：**有界 Map + 按插入序淘汰**，绝不整表清空（整表清空会让窗口内的重投全部穿过去）。
import { DEFAULT_QUEUE_CAP } from '../session/state.js';

export const DEDUP_WINDOW_MS = 300 * 1000;
export const DEDUP_CAP = 2000;
const MEMBER_REJECT_LOG_MS = 60000;

export function createDedupGate({ windowMs = DEDUP_WINDOW_MS, cap = DEDUP_CAP } = {}) {
  const seen = new Map();   // key -> at（Map 保持插入序，天然就是淘汰顺序）
  return {
    isDuplicate(key) {
      if (!key) return false;
      const now = Date.now();
      for (const [k, at] of seen) {
        if (now - at <= windowMs) break;   // 插入序 = 时间序，遇到的第一个未过期即停
        seen.delete(k);
      }
      if (seen.has(key)) return true;
      seen.set(key, now);
      while (seen.size > cap) {
        const oldest = seen.keys().next();
        if (oldest.done) break;
        seen.delete(oldest.value);
      }
      return false;
    },
    size: () => seen.size,
  };
}

/** 引用回复：`message_scene.ext` 里的 `msg_idx=<message_id>`。 */
function referenceOf(d) {
  const parts = Array.isArray(d?.message_scene?.ext) ? d.message_scene.ext : [];
  for (const item of parts) {
    const match = /^msg_idx=(.+)$/.exec(String(item));
    if (match) return match[1];
  }
  return '';
}

const GROUP_TYPES = new Set(['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE']);

/**
 * 把一条 QQ 网关分发归一成内部描述；被门控挡下的一律返回 `null`（不抛错、不惊动上层）。
 * 门控：`allowedUsers`（私聊）/ `allowedGroups`（群）/ `groupMembers`（群成员）。
 */
export function createInboundRouter({ config, log }) {
  let lastMemberRejectLog = 0;

  function memberAllowed(memberId) {
    if (!Array.isArray(config.groupMembers) || config.groupMembers.length === 0) return true;
    if (memberId && config.groupMembers.includes(memberId)) return true;
    if (Date.now() - lastMemberRejectLog > MEMBER_REJECT_LOG_MS) {
      lastMemberRejectLog = Date.now();
      log?.warn?.('group member not in groupMembers — ignored (rate-limited log)', { member: memberId || 'unknown' });
    }
    return false;
  }

  function route(type, d) {
    if (type === 'C2C_MESSAGE_CREATE') {
      const user = d?.author?.user_openid;
      if (!user) return null;
      if (Array.isArray(config.allowedUsers) && config.allowedUsers.length > 0 && !config.allowedUsers.includes(user)) {
        log?.warn?.('message from unlisted user ignored', { user });
        return null;
      }
      return {
        kind: 'c2c',
        target: { kind: 'c2c', openid: user },
        sourceKey: `c2c:${user}`,
        memberId: user,
        text: String(d?.content ?? '').trim(),
        attachments: Array.isArray(d?.attachments) ? d.attachments : [],
        msgId: d?.id,
        refMsgId: referenceOf(d),
      };
    }
    if (GROUP_TYPES.has(type)) {
      const group = d?.group_openid;
      if (!group) return null;
      if (Array.isArray(config.allowedGroups) && config.allowedGroups.length > 0 && !config.allowedGroups.includes(group)) {
        log?.warn?.('message from unlisted group ignored', { group });
        return null;
      }
      const memberId = d?.author?.member_openid ?? d?.author?.id ?? 'unknown';
      if (!memberAllowed(memberId)) return null;
      return {
        kind: 'group',
        target: { kind: 'group', openid: group },
        sourceKey: `grp:${group}:${memberId}`,
        memberId,
        // 群聊里 @机器人 会在正文里留下 "@昵称 "，剥掉才不会污染 prompt。
        text: String(d?.content ?? '').replace(/^\s*@\S+\s*/u, '').trim(),
        attachments: Array.isArray(d?.attachments) ? d.attachments : [],
        msgId: d?.id,
        refMsgId: referenceOf(d),
      };
    }
    return null;
  }

  return { route, memberAllowed, isGroupType: (type) => GROUP_TYPES.has(type) };
}

export { DEFAULT_QUEUE_CAP };

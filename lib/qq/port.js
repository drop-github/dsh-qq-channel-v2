// 出站端口（DESIGN.md §2.3.4）：会话层只表达"要发什么"，QQ 线格式细节全部留在这里。
//   sendText(target, text, opts)               —— target = {kind:'c2c'|'group', openid}
//   sendKeyboard(target, text, keyboard, opts) —— 带键盘只发一条
//   sendMedia(target, fileInfo, opts)          —— msg_type 7
//   opts.passive = { msgId } 声明"本条回复的是哪条入站消息" → 端口走被动回复**窗口**
//   opts.msgSeq 缺省由端口分配；显式给值时端口只做唯一性校验（契约见 §2.3.4 / D17）
import { fail } from '../result.js';

/** Round 1 的空实现：保持端口契约可用，同时让"没有 QQ 层"可被明确观测（P2-12 的结构性对策）。 */
export function createNullPort({ log } = {}) {
  const refuse = (what) => {
    log?.warn?.('null port invoked (no QQ adapter wired)', { what });
    return fail('no-target', 'null-port', `${what}: no QQ adapter wired`);
  };
  return {
    sendText: () => Promise.resolve(refuse('sendText')),
    sendKeyboard: () => Promise.resolve(refuse('sendKeyboard')),
    sendMedia: () => Promise.resolve(refuse('sendMedia')),
    notePassive: () => false,
  };
}

function normalizeOpts(opts) {
  const out = { ...(opts ?? {}) };
  if (out.passiveMsgId && !out.passive) out.passive = { msgId: out.passiveMsgId };
  return out;
}

/** 真实 QQ 端口：薄适配层，只做参数归一与契约守卫，实现全在 `lib/qq/send.js`。 */
export function createQqPort({ sender, log }) {
  return {
    sendText(target, text, opts) {
      if (!target || !target.openid) return Promise.resolve(fail('no-target', 'no-target', 'sendText called without a target'));
      return sender.sendText(target, text, normalizeOpts(opts));
    },
    sendKeyboard(target, text, keyboard, opts) {
      if (!target || !target.openid) return Promise.resolve(fail('no-target', 'no-target', 'sendKeyboard called without a target'));
      if (!keyboard) return Promise.resolve(fail('rejected', 'no-keyboard', 'sendKeyboard without keyboard payload'));
      return sender.sendKeyboard(target, text, keyboard, normalizeOpts(opts));
    },
    sendMedia(target, fileInfo, opts) {
      if (!target || !target.openid) return Promise.resolve(fail('no-target', 'no-target', 'sendMedia called without a target'));
      return sender.sendMedia(target, fileInfo, normalizeOpts(opts));
    },
    notePassive(msgId) {
      return sender.notePassive(msgId);
    },
  };
}

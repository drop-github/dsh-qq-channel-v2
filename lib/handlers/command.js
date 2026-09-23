// 命令通道（v2.0.3）：QQ 里以 `/` 开头的整行交给**宿主的命令注册表**执行，不再当成 prompt 喂给模型。
//
// 为什么要有它：插件此前只有 `session/prompt` 一条路，而 `/compact`、`/goal`、`/feedback`
// 这类命令是"宿主直接执行、根本不进模型"的（dsh-commands 的 CommandRuntime）。在 QQ 上敲
// `/compact` 只会变成一句普通文字，模型看到 "/compact" 一头雾水，用户以为压缩了其实没有。
//
// 判据与宿主**逐字一致**：dsh-commands 的 parseCommand 用
// `/^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u`，只认小写命令名 + 空白/行尾。
// 认不出来的行（`/不存在的命令`、`/紧凑`、`//x`、`/1abc`）**原样退回 prompt**，
// 升级前后行为完全一样 —— 命令通道只多接走"宿主确实注册过的那些名字"。
import { describe } from '../result.js';

/** 宿主 parseCommand 的同一张正则（改这里必须同步改 dsh-commands，否则两端判据会漂移）。 */
export const COMMAND_LINE_RE = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u;

/** 与宿主同样的切分：`name` 是不带斜杠的小写命令名，`rawInput` 是其后原文（含分隔空白）。 */
export function parseSlashCommand(line) {
  const text = String(line ?? '');
  const match = COMMAND_LINE_RE.exec(text);
  if (match === null) return null;
  return { name: match[1], rawInput: text.slice(match[0].length) };
}

/** 「宿主没有命令通道」不是错误：老宿主（v1）或未来被砍掉的接口都按此退回 prompt。 */
const NO_COMMAND_CHANNEL = /unknown-method|not-found|protocol-unsupported|no-commands/i;

/** 命令结果 → 一条 QQ 消息。沿用宿主原文（它已经是给用户看的话术），只加一个成败记号。 */
export function renderCommandReply(name, result) {
  const text = typeof result?.text === 'string' ? result.text.trim() : '';
  if (result?.kind === 'error') {
    return text ? `❌ /${name} 失败：${text}` : `❌ /${name} 执行失败（宿主未给出原因）`;
  }
  return text ? `✅ ${text}` : `✅ /${name} 已执行`;
}

export function createCommandRunner({ log, dsh }) {
  /**
   * @returns `null` = 不是命令 / 宿主不认识这一行 → 调用方照常走 prompt；
   *          `{ reply }` = 命令通道已处理，回这句就够，**绝不能再发给模型**（否则命令会执行两次语义）。
   */
  async function runCommand(sessionId, line) {
    const parsed = parseSlashCommand(line);
    if (!parsed) return null;
    const result = await dsh.command({ agentId: sessionId, line: String(line) });
    if (!result.ok) {
      if (NO_COMMAND_CHANNEL.test(String(result.code ?? ''))) {
        log?.debug?.('host has no command channel — line goes to the model instead', {
          name: parsed.name, code: result.code,
        });
        return null;
      }
      log?.error?.('command execution failed', { name: parsed.name, error: describe(result) });
      return { reply: `❌ /${parsed.name} 执行失败：${result.code ?? result.reason ?? 'unknown'}` };
    }
    const execution = result.value;
    if (!execution || typeof execution !== 'object' || !execution.result) {
      // 真机核证（0.1.7-alpha.1）：语法不认识或命令名没注册时，宿主返回的 result 连 `value` 字段都没有。
      log?.debug?.('line is not a registered command — line goes to the model instead', { name: parsed.name });
      return null;
    }
    const kind = execution.result.kind;
    log?.info?.('command executed', { name: parsed.name, kind, commandId: String(execution.commandId ?? '') });
    return {
      name: parsed.name,
      commandId: execution.commandId,
      reply: renderCommandReply(parsed.name, execution.result),
    };
  }
  return runCommand;
}

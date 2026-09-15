# REVIEW-2：对 ThinCoder Round 2 交付的评审（DSH 侧对接方）

评审对象：`E:\DSHWorkspace\dsh-qq-channel-v2`（Round 2：QQ 层 + 接线，28 个 `.js` 文件）。评审方式：**静态逐模块精读 + 独立动态验收**（我自己的集成台，不采信对方自报结果）。

## 一、结论：**通过**（可进入真机切换）

| 门禁 | 结果 | 证据 |
|---|---|---|
| 语法 | ✅ 28/28 文件 `node --check` 通过 | `round-verify.txt` |
| 单文件 ≤400 行 | ✅ 最大 325 行（`lib/handlers/qq.js`） | 同上 |
| 配置兼容（读线上 `settings.yaml` 实际配置 + 17 键归一化） | ✅ `CONFIG-COMPAT OK` | 同上 |
| 插件单测 | ✅ **73 pass / 0 fail**（`node --test`，26.3s） | `node --test` 直接复跑 |
| **验收台（core 21 + v2 目标 4）** | ✅ **25/25** | 我独立复跑两次；`MODE=v2` |
| 与现役基线对照 | ✅ core 在 v1.2.6 上同样 21/21（证明不是放宽断言） | 同台两实例对比 |

验收台覆盖：A1 v2 启动/事件通道、A2 凭据卫生、A3 401 恢复、A4 prompt 报文、A5 窗口外事件不丢、A6 审批往返（重复点击不回传）、A7 电脑端处理回补、A8 cancel、A9 token/IDENTIFY/首条被动、A10 dispose 零流量、A11 控制流重开、A12 历史不重放、A13 prompt 级 401 幂等、A14 网关 4009 重连、A15 发件箱、A16 键盘 `click_limit`、A17 上传报文、A18 先 ACK 再回传、A19 `mode` 必填、A20 被动回复窗口、A21 退化图文本兜底、A22 附件下载凭据、A23 宿主补投去重、A24 宿主重建恢复、A25 设置服务晚就绪。

## 二、静态审查：我裁定的每一项都核到落点（零 defect）

| 裁决/缺陷 | 落点 | 结论 |
|---|---|---|
| M1 被动回复窗口（每条带 `msg_id` + 唯一 `msg_seq`） | `qq/send.js:10-11,48-60,128` | ✅ |
| M2 事件白名单 + 未知静默 | `session/state.js:6,111-113`、`handlers/dsh.js:120` | ✅ |
| M3 键盘 `click_limit:1` + `permission.type:2` | `qq/keyboard.js:12` | ✅ |
| M4 文件链三坑（`md5_10m=1002432`、`upload_id`、限额语义、流式读） | `qq/upload.js:10-13,37-60,136,170-172` | ✅ |
| M4.3 凭据只发白名单域名（P2-16） | `qq/attachment.js:12,20-23,46-49` | ✅ |
| P0-2 401 重认证重试一次 + requestId 幂等 | `protocol/transport.js:61-74` | ✅ |
| P1-1/2/3 事件 gap-free（follow 主源 + `beforeSeq` 补页 + 基线在 adopt 时定） | `session/events.js:61-140`、`state.js:38-45` | ✅ |
| P1-5 回传失败保留 pending + 明确告知 | `handlers/qq.js:272-278` | ✅ |
| P1-6 审计配对 + 电脑端处理恰好一条通知 | `session/pending.js:69-`、`handlers/dsh.js:139-161` | ✅ |
| P1-7 cancel 结清 | `handlers/dsh.js:97-106` | ✅ |
| P1-8 无 eventId 的帧不写表 | `pending.js:43-47` | ✅ |
| P1-11 发件箱单飞 + 归档 | `qq/outbox.js:13,26,58,62` | ✅ |
| P2-1/4/5 分块先算 total、按码点切、去重表按插入序淘汰 | `qq/send.js:153-154,173`、`format.js`、`inbound.js:10-25` | ✅ |
| P2-7 超时分档 | `protocol/transport.js:6-7` | ✅ |
| P2-13 网关 `onclose` 同挂 + 心跳 `finally` 清理 | `qq/gateway.js:121-123,147,205-206` | ✅ |
| P2-17 收件箱路径不进 image 块 | `qq/attachment.js:103,119,141` | ✅ |
| R1 凭据卫生（含 QQ token） | `log.js` + `qq/token.js:50-53` | ✅ |
| A18 交互顺序（先 ACK 再回传） | `handlers/qq.js:238-246` | ✅ |
| **A23 宿主补投去重** | `pending.js:48-49` + `handlers/dsh.js:50-54` | ✅ |

## 三、本轮发现的缺陷（都已闭环）

### D1（P0，**v2 已自行修复**）设置服务晚就绪 → 一次性注册失败即永久退回行配置
- 真机证据（`~/.dsh/storages/qq-channel.log`，6 次启动一致）：`apply()` 时 `hasSettingsService=false`，约 1s 后才出现，v1 需第 3 次尝试才注册成功。
- 后果：v2 早期版本只尝试一次 → 通道拿着**空 appId/clientSecret** 启动（QQ 连不上），属"启动竞态下永久失联"（P0-2 同类）。
- 现状：v2 已实现重试（`config.js` 的 `createConfigSource(..., {retryDelayMs:500, maxAttempts:24})`）+ 注册成功后重启通道；**验收 A25 实测通过**。
- 附带要求（已满足）：宿主 `installSection` 契约是 `setSource(...)` **紧接 `onChange()`**，插件必须真正应用新配置（而不是只记日志）。

### D2（P1，已修在现役 v1.2.6，v2 无此问题）
- 配置变更触发重启时，被 dispose 的实例**没有关闭 `$events` 控制流**且帧处理器无 dispose 守卫 → **僵尸流继续收帧**，同一审批被推两条消息（调试实锤）。
- 已修：`dsh-qq-channel` 提交 `d7780bf`（dispose 关闭控制流 + 清理重连定时器 + 丢弃 dispose 后的帧）。
- v2 侧检查：`channel.dispose()` 会 `mux.dispose()`/`pump.dispose()` 等（`channel.js:306-318`），无同类问题。

### D3（工具侧，非代码缺陷）
- 验收台早期把"设置服务立刻可用"当成事实，导致 D1 无法被发现；现已按宿主契约建模（`setSource` + `onChange` + 晚 ~1s 到达），并新增 A25。附带两条 mock 卫生修复（清理已关闭 socket、发送加守卫）。

## 四、遗留与下一步

1. `docs/ROUND-2-REPORT.md` 尚未落地（Round 2 进程仍在收尾）——不阻塞：上述门禁全部由我独立复跑得出。
2. 真机切换（`CUTOVER-PLAN.md`）：profile 依赖指向 v2 → WMI 重启 + `verify-live-cutover.mjs 2.0.0` 自动自检 → 手机 QQ 上 E1–E10（收发/合并/审批双按钮/电脑端回补/提问/图片入箱/文件出箱/断线重连/日志无凭据）→ 一条命令回退 v1.2.6。
3. A9 在首次全量跑出现过一次 IDENTIFY 超时（二次复跑通过），已把 boot 的就绪条件收紧（等活 socket + 延长超时）并在三次复跑中稳定通过；若切换后再现，按 rig 侧 flake 处理并记录。

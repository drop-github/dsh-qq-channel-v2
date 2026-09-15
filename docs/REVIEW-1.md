# REVIEW-1：对 ThinCoder Round 1 交付的评审（DSH 侧对接方）

评审对象：`docs/DESIGN.md`（528 行）、`docs/PROTOCOL.md`（36 KB）、`docs/batches/round-1-design-skeleton.md`、`docs/ROUND-1-REPORT.md`（若有）。

**总评：设计通过，可以进入实现。** 三条独立发现与我真机核验完全一致（`mode` 必填、审计事件不在 `$events` 白名单、`follow` 作主源 + `page` 补页），31 条缺陷处置表与 31 条用例结构完整，范围边界明确。下面 6 条是本轮评审要求处理的事项，其中 **M1 是唯一需要改设计的地方**。

---

## 一、裁决（对应 DESIGN.md §5.2 open 项）

| open | 裁决 |
|---|---|
| open-1（QQ 网络层是否纳入本轮） | **维持原范围**：QQ 网络层留 Round 2。同时我已在验收台加开关（见 §四），你 Round 1 的骨架可以在"不连 QQ"的模式下被我的台子直接跑，不必为我的台子扩范围。 |
| open-2（`md5_10m` 字节数） | **`10_002_432` 正确，不要改成 10485760。** 证据：Hermes 生产实现 `gateway/platforms/qqbot/chunked_upload.py:66` 原文注释 `# First 10,002,432 bytes used for the md5_10m hash (per QQ API spec).` 与常量 `_MD5_10M_SIZE = 10_002_432`；且**小于该长度时 `md5_10m` 直接等于全文件 md5**（同文件 585-586）。采用具名常量 + 注释出处。 |
| open-3（旧设置 API 签名） | 保留防御分支 + 标未验证，接受。 |
| open-4（批次档 N7"18 键"应为 17） | 接受你的纠正：**17 个键**（我的任务书笔误）。批次档 §1.3 由你侧修正即可。 |
| open-5（`$events/result` 失败边界） | Round 2 真机验证后再定，接受；但设计要求先固定：回传失败 → 条目保留 pending + 明确告知（T-U26 已覆盖）。 |

---

## 二、真机核验结果（我已对运行中的 DSH 实测，全部为证据）

脚本：`E:\DSHWorkspace\qq-channel-verify\probe-live-host.mjs`（`LIVE-PROBE OK`，16/16）。

1. **`mode` 必填** ✓ 与你的 PROTOCOL §9.2 / D10 一致。实测：缺 `mode`、缺 `requestId`、`content` 传字符串 → 全部 `gateway/input-invalid: wire field "request" failed boundary validation`；带 `mode:'queue'` → `{accepted:true}`。
2. **`session/follow` 实时可用** ✓ 开帧 `{type:'snapshot',header,cursor,records,hasMore,projections}`；一次 prompt 推 **16 帧** `{type:'event',event}`，类型含 `turn/start, step/start, system/message, user/message×3, request/header, request/context, session/title, assistant/message, step/end, turn/end, session/title`。
   → **设计要求**：事件白名单只需 `turn/start`、`turn/end`、`assistant/message`、`approval/asked`、`approval/decided`；**其余类型必须静默**（debug 计数），不得因未知类型报错或中断流。
3. **`page` 的 `beforeSeq` 前翻有效** ✓ `throughSeq=minSeq, beforeSeq=minSeq` 返回**严格更早**的事件（`maxBack < minSeq`）→ 缺口补齐方案成立。
4. **审计事件确实不在 `$events` 白名单** ✓（你 D4 的判断正确）：白名单只有 `approval/request`（waterfall）与 `user-questions/request`（waterfall）等，`approval/asked|decided` 不在其中。
5. **`$events` 开帧** `{type:'ready',clientId,host}` ✓；**错误 args 键名** → `gateway/arguments-invalid` ✓（D11/D12 的分态识别正确）。
6. **游标事实修正**：`session/create` 之后立刻查是 **2**（新建会话自带初始事件），不是 -1；越界文案 `session page through seq <N> is past cursor 2`。`-1` 只出现在真正的空日志。你的设计以 `snapshot.cursor` 为基线，本就正确——但 **PROTOCOL §5.1"空日志 = -1"的引用行号要改**（见 M5）。
7. **图片块（P2-17 定论）**：`session/prompt` 的 image part 是 zod union `{type:'image', mediaType: png|jpeg|webp|gif, data: base64, name?}`（`typert.host.js:573-590`）。实测：
   - 真实 PNG + **额外键 `inboxPath`** → **ACCEPTED**（未知键被容忍/剥离，不会报错）
   - 非法 `mediaType` → `gateway/input-invalid`（union 强制）
   - **1×1 退化 PNG** → `session/attachment-invalid: Unsupported or malformed image data`
   → 设计要求：`inboxPath` 不要塞进 image 块（会被剥掉，等于没传）；退化/过小图片必须有**文本兜底**，不能让整条 prompt 失败。

---

## 三、必须处理（Round 2 前完成设计微调）

### M1（改设计）被动回复模型：**不要**沿用"每个 `msg_id` 只用一次被动额度"
- 现役 v1.2.4 用 `usedPassiveMsgIds` 保证"只有第一条带 `msg_id`"，审查报告 P2-3 又建议"ack 也带 msgId"——两者都建立在"同一 `msg_id` 只能被动回复一次"这个**错误前提**上。
- 事实：Hermes 生产适配器在**每一次**发送都带 `msg_id`，并给每条配一个**新的随机 `msg_seq`**（`adapter.py:945-950` 的 `_next_msg_seq()`（`(time_part ^ rand) % 65536`）+ `:2573-2574` 设置 `body["msg_id"]`）。QQ 的 `msg_seq` 字段本身就是为"同一 `msg_id` 的多条回复"设计的。
- **v2 契约**：回复窗口内（收到消息后 5 分钟内）**每条出站消息都带 `msg_id`**，且 `msg_seq` 每条唯一（随机 0..65535 或单调递增）；**保证 (msg_id, msg_seq) 不重复**。这样 ack 与最终回复都能走被动额度，不再白耗主动配额（同时满足 P2-3 的初衷）。
- 我会把验收拆成：**A9（core）** 首条带 `msg_id`；**A20（v2 目标）** 窗口内每条都带 `msg_id` 且 `(msg_id,msg_seq)` 唯一、`msg_seq` 为整数。真机 E2E 再确认一次。

### M2（补设计落点）事件白名单与未知事件静默
见 §二.2。DESIGN 里请补一张"事件类型 → 处理动作"表（处理/忽略/未知计数），并明确 `assistant/message` 是唯一文本来源。

### M3（补设计落点）键盘按钮必须带 `click_limit: 1`
`permission.type=2` 只是"人人可点"，**不会**置灰按钮；`click_limit: 1` 才是平台级的"点过即灰"（Hermes `keyboards.py:82-89`）。这是 A16 的判定点，Round 2 渲染层必须发。

### M4（补设计落点）文件链三个已知坑
1. `upload_part_finish` 要带 `upload_id`（现役已正确，别退步）；`40093001` 可重试、`40093002` 当日限额视为永久失败（`chunked_upload.py:50-51`）。
2. 上传前 `statSync` 大小上限 + 分片读取，不要整文件进内存。
3. 附件下载**只对预期域名**带 `Authorization`（P2-16），QQ 给的 URL 不能无条件附带 bot token。

### M5（文档修正）`PROTOCOL.md §5.1` 的游标断言
把"空日志 = -1"限定为"真正的空日志（新建会话通常已带初始事件，实测 `cursor=2`）"，并把引用行号对准 `dsh-api-session-controller/lib/index.js:1378`（`sourceLog.at(-1)?.seq ?? -1`）与 `types/history.js:196-199`。引文与本机实测不一致时**以实测为准并标注**。

### M6（流程）自测不能替代对接方验收
`test/` 套件（T-U*/T-I*）是你自证的证据，但我仍会跑我的 17 条 core + 4 条 v2 目标场景（`MODE=v2`）。两者冲突时以我的台子为准，并回来定位差异（历史上我的台子抓到过启动顺序导致的 v2 通道误判）。

---

## 四、验收契约（Round 2 生效）

```
core（必须全绿，现役 v1.2.5 已 17/17）：A1..A15、A18、A19
v2 目标（MODE=v2 计入，现役应失败）：A16 键盘 click_limit/A17 上传报文/A20 被动回复模型
```

- 我的台子新增**不连 QQ 的降级模式**（`SKIP_QQ=1`）：`boot()` 不再等 `IDENTIFY`，用于只实现 DSH 侧的中间态实现；Round 2 完成后仍要跑完整模式。
- 命令：
  ```
  $env:PLUGIN_PATH='E:\DSHWorkspace\dsh-qq-channel-v2\lib\index.js'
  $env:SKIP_QQ='1'   # 仅 DSH 侧中间态
  $env:MODE='v2'     # Round 2 收尾时必须
  node E:\DSHWorkspace\qq-channel-verify\run-scenarios.mjs
  ```
- 另加门禁（切换前）：`verify-config-compat.mjs`（配置逐键兼容）与 `CUTOVER-PLAN.md` 的 G1–G7。

## 五、Round 2 输入清单（已备好，直接引用）

| 文件 | 内容 |
|---|---|
| `E:\DSHWorkspace\qq-dsh-bridge\thincoder-v2-qq-spec.md` | QQ 侧协议规格（token/网关/REST/键盘/交互/分片上传/错误码），含 `file:line` 证据与 5 项未验证 |
| `E:\DSHWorkspace\qq-dsh-bridge\thincoder-v2-live-verified.md` | 真机核验结果（`mode` 必填、follow 实时帧、beforeSeq、审计事件来源、游标事实） |
| `E:\DSHWorkspace\qq-dsh-bridge\thincoder-v2-round2-notes.txt` | 验收台用法 + 代码可测性契约（ctx 五面、导出形态、$DSH_HOME） |
## 六、评审补充（修正轮核对：M1–M6 已落地，设计准予进入 Round 2）

我在你修正后的 `DESIGN.md` / `PROTOCOL.md` 里逐条核到落点，**全部到位**：

| 项 | 落点（已核） | 结论 |
|---|---|---|
| M1 被动回复窗口 | `DESIGN.md` D17 + §2.3.4；`PROTOCOL.md` §8「被动回复窗口」行；并新增 `PROTOCOL.md §9.14` 明确与我的 QQ 规格冲突时以 REVIEW-1 为准 | ✅ 采纳 |
| M2 事件白名单 | `DESIGN.md §2.4.6`（含 16 帧清单）+ D18 + 新用例 T-U31 + AC11 | ✅ 采纳 |
| M3 `click_limit:1` | `DESIGN.md §2.10.1` 键盘字段表 + 明文"服务端校验才是唯一防线" | ✅ 采纳 |
| M4 文件链三坑 | `DESIGN.md §2.10.2`（`statSync` + 分片读 + 流式哈希 + `md5_10m` 具名常量） | ✅ 采纳 |
| M5 游标事实 | `PROTOCOL.md §5.1` 已改为"新建会话自带初始事件、实测游标常为 2" | ✅ 采纳 |
| M6 自测≠验收 | 报告与 §3.3 已引我的台子行号与 `SKIP_QQ` 模式 | ✅ 采纳 |
| open-2 / P2-6 | `PROTOCOL.md §10.1` 已按裁决写 `10_002_432` + 出处 + 小文件等于全文件 md5 | ✅ 定案 |

另外：你在 `PROTOCOL.md §9.14` 主动标注"我的 QQ 规格里那句'同一 msg_id 只有一次被动回复机会'是错的，以 REVIEW-1 M1 为准"——做法正确，保留这种"对外部输入的纠错留痕"。

### 你新发现的两条宿主事实（我已独立复核，均成立，纳入验收）

1. **`$events/result` 对未知 `eventId`（或该 client 从未收到该事件）静默 no-op，RPC 仍回 `ok:true`**
   证据：`dsh-api-gateway/lib/index.js:683-684`（`if (pending === void 0 || !pending.deliveries.has(client)) return;`）。
   → 含义：**不能用返回码判断"用户点了有没有用"**；必须靠本地 pending 状态 + 审计事件兜底（T-U25 已覆盖）。
2. **新开的 `$events` client 会被补投所有仍未应答的转发事件**
   证据：`dsh-api-gateway/lib/index.js:590-598`（新 client 注册后 `for (const pending of this.pendingRemoteEvents.values()) this.deliverRemoteEvent(pending, client)`）。
   → 含义：控制流重连后**可能收到已经推过的审批帧**，必须按 `eventId` 去重，否则用户会在 QQ 上看到两条一样的审批。我已把它做成 **core 场景 A23**（现役 v1.2.5 实测通过，v2 不得退步）；同时这条也说明"控制流断开期间不要丢本地 pending 条目"是对的。

### 验收契约（Round 2 最终版）

```
core（必须全绿；现役 v1.2.5 已 20/20）：A1..A15、A18、A19、A21、A22、A23
v2 目标（MODE=v2 计入；现役实测 3 红 1 绿）：A16 键盘 click_limit / A17 上传报文 /
        A20 被动回复窗口 / A24 宿主重建（cursor 变小）后恢复投递
```

- **A24（本轮新增，2026-09-16）**：宿主重建/日志截断后游标变小，插件必须（按 `DESIGN.md §2.4.4` 第 2 步）检测 `snapshot.cursor < lastSeq` → 记日志 + 重置 `lastSeq = -1` + 重新对账，**恢复投递**。
  实测：现役 v1.2.5 在截断后**永久不再投递**（`lastSeqs` 停在旧值，新事件 seq 更小被判为已处理）→ 红；v2 的设计已覆盖此分支，必须绿。
- A17 在现役上已经绿（`upload_id` 本来就带），保留它作为"不许退步"的守卫。

**结论：Round 1 设计与协议文档准予通过，可以按 `thincoder-v2-round2-task.txt` 进入 Round 2 实现。**


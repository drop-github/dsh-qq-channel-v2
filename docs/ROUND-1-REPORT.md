# ROUND-1-REPORT：dsh-qq-channel v2.0.0（Round 1）

- 日期：2026-09-16 · 工作目录：`E:\DSHWorkspace\dsh-qq-channel-v2` · 批次：`round-1-design-skeleton`
- 输入：`thincoder-v2-round1-task.txt` + `thincoder-v2-round1-answers.txt`（裁决优先）+ `thincoder-review-clean.md` + `qq-channel-verify/`

---

## 结论摘要

1. **设计部分完成并通过对接方评审**：`docs/DESIGN.md`（606 行）+ `docs/PROTOCOL.md`（524 行）就绪，
   三层齐备、3 处方案选型对比、18 条关键决策（含否决备选）、31 条缺陷逐条处置、42 条用例、A1–A20 对位表。
2. **你方 `docs/REVIEW-1.md` 已裁决"设计通过，可以进入实现"**，其 M1–M6 与 open-1…open-5 修正轮**已全部落地**（见本报告 §四）。
3. **骨架代码与测试本轮未能交付**：机内设计评审 `advisor(type='design')` **机械故障**（对任意输入规模确定性失败），
   导致 `designToken` 未签发 → `eng-coder` 被机械拒绝。按你任务书 §0 的明令，**我没有绕过门禁、没有改 `.thincoder` 配置规避**。
4. 本轮唯一"可运行"的证据是**文档层静态证据**（行数/可读性/凭据扫描/交付物存在性），已附原始输出（§二）。
5. 两个**规格纠错**（均已被你方真机核验独立证实）：`session/prompt` 的 `mode` 是**必填**（任务书 §5.6 说反了）；
   配置键是 **17** 个不是 18 个（你方 open-4 已确认）。

---

## 一、交付清单

| 文件 | 作用 | 行数 | 状态 |
|---|---|---|---|
| `docs/DESIGN.md` | 唯一设计权威：需求层 / 设计层 / 测试层 / 变更记录 / 边界与 open 项 | 606 | ✅ |
| `docs/PROTOCOL.md` | 协议事实档：每条带宿主源码 `file:line`，含"与我给的规格不符"与"未验证项"两节 | 524 | ✅ |
| `docs/batches/round-1-design-skeleton.md` | 批次档：§1 验收契约（主 agent）· §2 任务书（eng-designer）· §3 评审发现+故障记录 · §4 裁决表 · §6 收口 | 562 | ✅ |
| `docs/VERIFY.md` | 你该跑的命令与预期输出 + 当前状态说明 | 126 | ✅ |
| `docs/ROUND-1-REPORT.md` | 本档 | — | ✅ |
| `docs/REVIEW-1.md` | **你方放入本仓的评审**，本轮作为权威输入读取，未改动 | 125 | 外部 |
| `lib/**`（19 文件，预算 ≈2300 行） | 骨架：入口/配置/日志/协议层/会话层/q q 端口预留 | 0 | ❌ **未创建**（见 §三） |
| `test/**`（10 文件，预算 ≈1750 行） | 单测 + mock 集成（T-U1–T-U31 / T-I1–T-I11） | 0 | ❌ **未创建**（见 §三） |
| `package.json` / `cordis.patch.yml` / `.gitignore` / `README.md` | 包形态与安装面 | 0 | ❌ **未创建**（见 §三） |

> 交付物存在性原始输出见 §二.3：`lib/test/package.json/cordis.patch.yml/.gitignore/README.md` 全部 `MISSING`。

---

## 二、自测证据（原始输出）

### 2.1 文档规模与可读性（N8：无 >300 字符单行）

```
docs/DESIGN.md                                 lines= 606  maxLine=275  over300=0
docs/PROTOCOL.md                               lines= 524  maxLine=290  over300=0
docs/batches/round-1-design-skeleton.md        lines= 562  maxLine=283  over300=0
docs/VERIFY.md                                 lines= 126  maxLine=100  over300=0
```

### 2.2 凭据卫生扫描（N1，全仓除 `node_modules`）

扫描模式：`MOCK-LAUNCH-TOKEN` / `clientSecret=<值>` / `appId=<6+位数字>` / `access_token=<值>` / PEM 头。

```
no secret-like pattern found (clean)
```

（限定说明：这是**文档仓**的扫描；代码落地后必须对 `lib/**`、`test/**`、日志 sink 重跑同一扫描。）

### 2.3 交付物存在性

```
lib                  MISSING
test                 MISSING
package.json         MISSING
cordis.patch.yml     MISSING
.gitignore           MISSING
README.md            MISSING
```

### 2.4 本轮**无法**执行的验收项（如实列出，不含推测）

| 任务书要求 | 状态 | 原因 |
|---|---|---|
| §7.1 `node --test` 全绿 | ❌ 未执行 | 无 `test/` 目录、无被测代码 |
| §7.2 全部 `.js` 跑 `node --check` | ❌ 未执行 | 全仓 0 个 `.js` 文件 |
| §7.3 自写 mock 证明四项（v2 探测 / 401 重试 requestId 不变 / page 补页 / auditId 配对） | ❌ 未执行 | 同上 |
| §7.4 mock 测试不联网、不碰 3080 | — | 无 mock 可跑（前置未达成） |

**不把这些写成"通过"**：本轮没有可运行的实现，因此**没有任何功能级证据**。设计层的正确性依据是
`docs/PROTOCOL.md` 的 `file:line` 证据链 + 你方 REVIEW-1 的真机核验，不是我方自测。

---

## 三、门禁阻断（骨架未交付的直接原因）

### 3.1 事实链

1. 工程模式要求：设计 → `advisor(type='design')` 评审通过并签发 `designToken` → 才能派 `eng-coder` 写代码。
2. `advisor(type='design')` **确定性失败**：

```
Advisor: review failed (unknown) — The "chunk" argument must be of type string or an instance of
Buffer, TypedArray, or DataView. Received an instance of Object.
评审未完成——token 未签发 (review incomplete — no design token issued; reason: review_failed)
```

3. 三次尝试，排除范围因素：

| 尝试 | 范围 | 结果 |
|---|---|---|
| 1 | `DESIGN.md` + `PROTOCOL.md` + 批次档 + `REVIEW-1.md`（异步） | 9 秒后 `status: done`，**未写批次档 §3**、无报告内容 |
| 2 | 同上但**不传 `batchDoc`**（走"无批次档不受阻"路径，同步） | 同上错误 |
| 3 | **仅 `docs/REVIEW-1.md`（8.7 KB）**（同步） | **同样错误** → 排除文档体积/档数因素 |

4. `eng-coder` 门禁复现（不带 token 直接派）：

```
Error: Invalid or missing design token — run advisor with type='design' first and pass the
returned token as designToken.
```

### 3.2 我的处置（按你任务书 §0 的明令）

> 任务书原文："若门禁阻止你写代码文件，**先写完 `docs\DESIGN.md` 并通过 `advisor(type='design')`**，再动代码；
> 若仍被拦住，就在报告里写清被拦的具体工具与提示，**不要绕过门禁、不要改 `.thincoder` 配置去规避**。"

- ✅ 已写完设计档并尝试评审；
- ✅ 被拦后**未**绕过（未用其它角色代写实现、未伪造 token、未改配置）；
- ✅ 本档如实写明被拦工具（`advisor(type='design')`）与提示原文（§3.1 第 2、4 条）。

**我没有把"设计通过"写成"实现完成"**：P0/P1 的"已消除"一律指**设计层消除**，代码层面**尚未落地**（见 §四表头说明）。

---

## 四、与审查报告 P0/P1/P2 的处置表（31 条）

> 口径（重要）："**设计层消除**" = `docs/DESIGN.md` 已给出结构性对策，**代码尚未实现**（§三 阻断）。
> "**遗留 Round 2**" = 属 QQ 网络层，你方 open-1 已裁决留 Round 2，但设计落点已固定。

### P0（2 条）

| 编号 | 处置 | 理由 / 设计落点 |
|---|---|---|
| P0-1 launch token 明文落盘 | **设计层消除** | 脱敏单一入口 `lib/log.js`（D9，`DESIGN.md §2.5`）；调用点禁止自行拼接 secret；A2 断言 |
| P0-2 cookie 只取一次 + 探测吞 401 | **设计层消除** | `auth.js` 单一持有者 + `transport.js` 401 统一重认证并重试一次 + `detect.js` **三态**（v2/v1/协议事实不符），不吞错（D11） |

### P1（11 条）

| 编号 | 处置 | 理由 / 设计落点 |
|---|---|---|
| P1-1 靠正则解析英文文案学游标 | **设计层消除** | 不再"学游标"：游标来自 `snapshot.cursor`；`-1` 显式处理；缺口用 `beforeSeq` 前翻（`§2.4.4`） |
| P1-2 基线在"首次轮询成功"时建立 | **设计层消除** | 基线绑定 `adopt()`（**会话纳入管理那一刻**，`§2.4.5`） |
| P1-3 尾部窗口丢事件且不回补 | **设计层消除** | `follow` 主源 + 缺口检测 + `session/page` 补页（`§2.4.4`） |
| P1-4 单会话异常中止整轮 | **设计层消除** | 每会话独立 try/catch + 递减退避（`events.js`） |
| P1-5 回执先于送达、失败也结清 | **设计层消除** | 统一结果类型（D8）+ `await` 成功才结清，失败保留条目并明确告知（P1-5 结构性对策） |
| P1-6 `eventId` 当审批身份 | **设计层消除** | `eventId`/`auditId` **分列**（D5）+ `approval/asked` 显式配对（`§2.4.2`） |
| P1-7 `cancel` 帧被忽略 | **设计层消除** | `cancelled` 分支：结清 + 提示失效 + 之后点击被拒 |
| P1-8 无 `eventId` 时毒化整表 | **设计层消除** | `addFromWaterfall` 前置校验：无 `eventId` → `fail('rejected')` + 记日志，不写表 |
| P1-9 单会话模式任意人可代答 | **设计层消除**（QQ 载荷解析留 R2） | 审批独立开关（默认安全）+ `authorize` **单点判定**（`§2.3.3`）+ README 写明单会话=单一信任域 |
| P1-10 `requestId` 在映射函数里重铸 | **设计层消除** | D6：**调用点铸造一次**，映射函数只包装 |
| P1-11 发件箱可重入 + 无大小上限 | **遗留 Round 2** | 属 QQ 文件链；端口契约已预留单飞集合 + `statSync` 上限（`§2.3.4`） |

### P2（18 条）

| 编号 | 处置 | 理由 / 设计落点 |
|---|---|---|
| P2-1 截断提示死代码 | 遗留 R2 | 发送层 Round 2；设计要求"先记 `total` 再 slice" |
| P2-2 死代码（`recallMessage` 等） | **设计层消除** | 设计约束：不引入无调用点的代码；撤回要么接回要么不写 |
| P2-3 ack 未传 `msgId` | 遗留 R2（**已按 M1 重定义**） | 不再是"只传一次"，而是窗口内**每条**都带 `msg_id` + 唯一 `msg_seq`（D17 / A20） |
| P2-4 `chunkText` 按 UTF-16 码元切 | 遗留 R2 | 发送层按码点切 |
| P2-5 去重集合整表清空 | 遗留 R2 | 有界 Map + 按插入序淘汰（设计要求已固定） |
| P2-6 `md5_10m` 数值 | 遗留 R2（**数值已裁决**） | **`10_002_432` 正确**，不改为 `10485760`；具名常量 + 出处注释（`PROTOCOL.md §10.1`） |
| P2-7 15s 超时套在 prompt 上 | **设计层消除** | D7 超时分档：`session/prompt` 60s、其余 15s |
| P2-8 v1 `respondRpc` 不带 cookie | **设计层消除** | `v1.js` 统一带 cookie |
| P2-9 "no usable protocol" 掩盖真因 | **设计层消除** | 结果类型带 `reason`/`code`；探测三态各记一条 |
| P2-10 args 键名强耦合 | **设计层消除** | `PROTOCOL.md §1.4` 记录耦合；`arguments-invalid` 单独成态并告警（D11） |
| P2-11 per-source 会话永不收缩 | **设计层消除** | D13 空闲淘汰（TTL + `sweep()`） |
| P2-12 无目标时静默 `return false` | **设计层消除** | 端口契约 `fail('no-target')` + 告警 |
| P2-13 `onclose` 竞态 + 心跳不清理 | 遗留 R2 | QQ 网关模块：`onopen` 同时挂 `onclose` + `readyState` 兜底 + `finally` 清理 |
| P2-14 空会话仍发 prompt | **设计层消除** | `fail('no-session')` + 明确提示 |
| P2-15 合并轮次失败丢消息 | **设计层消除** | 待发队列**不 splice 丢**：失败归还并记日志 |
| P2-16 附件下载凭据外发 | 遗留 R2 | 只对预期域名带 `Authorization` |
| P2-17 image 块额外字段 | **设计层消除** | image part 是 zod union（`typert.host.js:577-585`）；额外键被剥离 → `inboxPath` 改走 text part；退化图片必须文本兜底 |
| P2-18 `mode:'queue'` 被判"猜的" | **设计层消除** | **反转**：`mode` 是必填枚举，`'queue'` 合法（D10；`typert.host.js:576`） |

统计：**设计层消除 24 条**、**遗留 Round 2 7 条**（P1-11、P2-1、P2-3、P2-4、P2-5、P2-6、P2-13、P2-16 中的
Round 2 部分按你方 open-1 裁决留后——其中 P2-6 数值已定）。**没有一条被判"不修"**。

---

## 五、未验证项（逐条，不含推测）

1. **机内设计评审结论缺失**：`advisor(type='design')` 机械故障 → 本轮**无机内独立评审**（只有你方 REVIEW-1 与多模型会诊）。
2. **全部 P0/P1/P2 的"消除"均为设计层**：无一行代码被验证过；`node --check` / `node --test` 本轮 0 次执行。
3. **旧设置 API `installSettingsSection`（DSH ≤0.1.1）的真实签名**：保留防御分支，未核到旧宿主（`PROTOCOL.md §10.2`）。
4. **`$events/result` 失败边界**（一次坏回投是否中断整条 generation 的恢复策略）：留 Round 2 真机。
5. **审计事件与 waterfall 的到达乱序窗口**：`§2.4.2` 的"短窗口双向缓存"窗口长度未定（需真机时序）。
6. **`click_limit=1` 的实际置灰效果**：Hermes 实现为依据，未在 QQ 真机验证。
7. **mock 行号漂移**：`docs` 中引用的 `qq-channel-verify/*.mjs` 行号是 2026-09-16 某时刻快照；你方仍在更新该目录。
8. **QQ 官方文档本身**未被我方直接读到（`md5_10m` 的结论来自你方 Hermes 证据裁决，非官方文档原文）。
9. **`user-questions/request` 的 request/answer 结构**：仅依据宿主类型定义推断，未有真机帧 dump。
10. **`session/follow` 在"宿主重建/日志截断"时的 `cursor < lastSeq` 场景**：`§2.4.4` 第 2 步的处理是设计推断，未实测。

---

## 六、需要你裁决或提供的信息（逐条编号）

1. **【最高优先】设计评审门禁故障怎么继续？** `advisor(type='design')` 在本会话确定性失败（§3.1），
   `designToken` 无法签发，`eng-coder` 被机械拒绝。请择一裁决：
   (a) 由你方修/绕过该机制后我重跑评审；
   (b) 你方以 REVIEW-1 的"设计通过"为授权，允许我在**无 token** 的情况下用普通只读/实现子代理落地骨架（需你显式授权，否则我不动）；
   (c) 本轮以"设计档交付"收口，骨架并入 Round 2 一次做完。
   —— 无论哪条，我**不会**自行绕过门禁。
2. **Round 1 验收口径确认**：你的验收台靠 `t.qq.c2c(...)` 驱动入站（`run-scenarios.mjs:99`），
   `SKIP_QQ=1` 只跳过等 `IDENTIFY`，因此本轮无 QQ 层的骨架在其台上 A1–A9/A14–A18 **必然失败**。
   请确认：本轮验收是否以我方 `test/` 套件为准（你 open-1 的裁决倾向如此）？
3. **是否要我方在 Round 1 就补"最小 QQ 入站通路"**（token + WS IDENTIFY/心跳 + 文本收发，约 250 行）
   以便你的台子可直接跑 A1–A13？这是**范围变更**，按你 open-1 我维持不做，若要请显式裁决。
4. **`docs/REVIEW-1.md` 的交接方式**：它是由你侧写进我方 docs 目录的。确认后续评审都走这个通道
   （我方按只读输入对待），还是仍通过 `qq-dsh-bridge/*.txt` 交接？
5. **`verify-config-compat.mjs` 的键数**：配置键已更正为 **17**（你 open-4）。若你侧脚本或文档仍按 18 校验，请同步。
6. **多模型会诊**：我已在你方台子之外另起一次多模型独立设计复核（kimi/glm），结论落地后会写入 `docs/CONSULT-1.md`。
   若其中有 🔴，请裁决是否纳入本轮修正还是并入 Round 2。
7. **`docs/PROTOCOL.md` 的"未验证项"是否要我在下一轮优先补齐**（尤其第 3、5、9 条需要旧宿主/真机时序）？

---

DONE-ROUND-1

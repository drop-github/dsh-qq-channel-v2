# 批次档：Round 1 — dsh-qq-channel v2.0.0 设计 + 骨架

- 批次号：`round-1-design-skeleton`
- 日期：2026-09-16
- 工作目录（本轮唯一可写）：`E:\DSHWorkspace\dsh-qq-channel-v2`
- 输入（权威顺序）：`E:\DSHWorkspace\qq-dsh-bridge\thincoder-v2-round1-answers.txt`（裁决，**优先**）
  > `E:\DSHWorkspace\qq-dsh-bridge\thincoder-v2-round1-task.txt`（任务书）
  > 宿主源码 `E:\DSHWorkspace\dsh-new\node_modules\@deepseek-ai\*`（协议判断的**唯一权威**）
- 本轮范围：**设计 + 骨架 + 单测 + 报告**。QQ 网关业务主体（消息收发、审批渲染、文件收发）留 Round 2。
- 段作者：§1 主 agent · §2 eng-designer · §3 评审子代理 · §4 主 agent · §5 eng-coder · §6 主 agent

---

## §1 批次任务与验收（主 agent）

### 1.1 总目标

为 `dsh-qq-channel` 从零重写 v2.0.0：把一款能跑但 2200 行单文件、经严格审查暴露
2 个 P0 + 11 个 P1 + 18 个 P2 的 Cordis 插件，**在设计层**重建为模块化、可测、
凭据卫生、失败路径闭环的插件；本轮交付设计与可运行骨架，供对接方审查后进入 Round 2 实现。

**为谁解决什么问题**：DSH 用户在手机上用 QQ 驱动机器人 agent 时，现有实现会在认证竞态、
事件漏推、审批身份错配三类场景下**静默失效**（表现为"不回复""回复消失""审批点了没用"），
且失败不具备可观测性。v2 必须让这三类失效在结构上不可能发生。

### 1.2 功能需求（本轮 = 设计 + 骨架落地；每条可验收）

| # | 需求（用户故事式） | 本轮交付深度 |
|---|---|---|
| F1 | 作为插件使用者，我要插件在 DSH ≥0.1.5（v2/typert）与 ≤0.1.1（v1）上都能工作，以便升级 DSH 后不必换插件 | 协议探测 + 双协议映射**骨架完整可跑**（含探测三态：v2 / v1 / 协议事实不符） |
| F2 | 作为插件使用者，我要 `/api` 请求在 401 时自动重取 cookie 并重试一次，以便启动竞态不会让我永久失联 | 骨架实现 + mock 断言（requestId 不变） |
| F3 | 作为使用者，我要"发送/应答/回传"的成败**明确可见**，以便界面上的"成功"永远是真的 | 骨架实现（结果对象 / await / 日志 code） |
| F4 | 作为使用者，我要会话事件流 gap-free（不丢 `turn/end`、不哑掉会话），以便每条消息都有回复 | 主源 `session/follow` + `session/page` 补页 + 基线 + 单会话隔离 + 退避：骨架实现 |
| F5 | 作为使用者，我要 prompt 幂等（重试不重复执行），以便 401 重试不会发出两条消息 | 骨架实现（requestId 调用点铸造一次） |
| F6 | 作为使用者，我要审批/提问在 QQ 侧可答，且"电脑端已处理"能回补通知，以便不必盯着电脑 | 条目模型（`eventId` / `auditId` 分离）+ cancel 结清：骨架实现；QQ 渲染留 Round 2 |
| F7 | 作为使用者，我要高权限交互默认安全（默认不放开危险来源），以便群成员不能代我批准 | 配置开关 + 操作者校验骨架 |
| F8 | 作为使用者，我要结构化、可读、不泄密的日志，以便现场排障 | 日志模块骨架（事件名 + id 前缀 + 结果 + code；≤240 字符；限流） |
| F9 | 作为使用者，我要 plugin 在 dispose 后彻底静默（无 HTTP/WS/定时器残留），以便重载不打架 | 生命周期骨架 + mock 断言 A10 |
| F10 | 作为插件作者，我要单文件 ≤400 行、ESM、零构建、依赖仅 `ws` + `schemastery`，以便长期维护 | 骨架遵守 |

### 1.3 非功能标准（硬指标，可机判）

| # | 标准 | 度量方式 |
|---|---|---|
| N1 | 凭据卫生 | 全仓 `*.js`/`*.md`/`*.json` 中不出现真实 secret；日志/错误信息只允许长度或 sha256 前 8 位；A2 场景断言 |
| N2 | 失败可见 | 静态检查：无空 `catch {}`（`catch` 块内必须有日志、重试或状态变更）；所有"发送/回传"调用点 `await` 其返回值并据此改状态 |
| N3 | 模块边界 | `wc -l` 每文件 ≤400 行；`lib/qq/` 目录在骨架中**预留但可空** |
| N4 | 依赖面 | `package.json` 的 `dependencies` 恰为 `ws` + `@deepseek-ai/schemastery`；`peerDependencies` 含 cordis + dsh-settings |
| N5 | 可测 | `node --test` 全绿且**不联网**、不碰 3080、不读真实配置；单测含纯逻辑 + 一个 mock 集成测试 |
| N6 | 语法 | 全部 `.js` 文件 `node --check` 通过 |
| N7 | 配置兼容 | 17 个配置键名与 v1.2.4 逐字一致（对接方 open-4 裁定：任务书笔误"18"）；`appId` 接受 string\|number；双 API 设置注册 |
| N8 | 文档可读 | 文档无 >300 字符单行；表格/列表/标题正常分隔 |

### 1.4 硬要求 R1–R10 的对策落点（对接方逐条对照评审）

| # | 要求 | 设计落点（设计档必须逐条给出对策小节） |
|---|---|---|
| R1 | 凭据卫生 | 日志模块的脱敏入口 + 调用约束（禁止直接拼接 secret） |
| R2 | 失败必须可见 | 统一结果类型 `{ok, reason, code}`；无空 catch；失败驱动状态机 |
| R3 | 事件 gap-free | `session/follow` 主源 + `session/page` 补页 + 基线时刻 + 单会话隔离 + 退避 + 卡住可恢复 |
| R4 | 幂等 | requestId 调用点铸造；重复帧/重复点击/重放的去重键 |
| R5 | 身份分离 | `eventId`（mux 回传）与 `auditId`（审计匹配）分列；`cancel` 结清；无 id 帧拒处理并记日志 |
| R6 | 权限 | `keyboardApprovals`/审批独立开关（默认安全）+ 操作者校验 + README 写明单会话=单一信任域 |
| R7 | 可观测 | 结构化日志（事件名 + id 前缀 + 结果）、错误带 code、debug 开关、≤240 字符、高频限流 |
| R8 | 资源边界 | 发件箱重入保护 + 文件大小上限；映射表空闲淘汰；dispose 统一定时器/WS 清理 |
| R9 | 兼容 | 双协议；配置键/安装方式不变；探测失败区分 401 / `gateway/arguments-invalid` / 超时 |
| R10 | 可测 | 纯逻辑单测 + mock 集成测试（复现 A3/A5/A6/A7/A8/A10 的关键断言） |

### 1.5 验收契约（对接方的 A1–A10 场景，本轮以 mock 自测覆盖可实现部分）

| # | 场景 | 本轮自测可否覆盖 | 断言要点 |
|---|---|---|---|
| A1 | v2 启动 | ✅ | 探测 `POST /api/session/list`，`args` 键**恰好** `{_request:{}}`；`gateway/arguments-invalid` 单独判为"协议事实不符"并告警 |
| A2 | 凭据卫生 | ✅ | launch token 明文不出现在 stdout/stderr/日志 |
| A3 | 401 恢复 | ✅ | 首个 `/api` 401 → 重取 cookie → 重试成功；`session/prompt` 重试 `requestId` 不变 |
| A4 | prompt 报文 | ✅ | `args` 键恰好 `{request:{…}}`，含客户端铸造的 `requestId` |
| A5 | 不丢事件 | ✅（mock） | 注入 `turn/start`+`assistant/message`+`turn/end` 后再灌 60 条 `user/message` 垫底，回复仍必须送达 |
| A6 | 审批往返 | 骨架层（无 QQ 渲染） | waterfall → `POST /api/$events/result`，`args` 恰好 `{clientId,eventId,outcome}`，`outcome==={kind:'result',value:'allowed-once'}`；重复点击不二次回传 |
| A7 | 电脑端处理 | ✅（骨架层） | `approval/asked{id}` + `approval/decided{id}` 配对 → **恰好一条**"已处理"通知 |
| A8 | cancel 帧 | ✅（骨架层） | `{type:'cancel',eventId}` → 结清该项 + 之后点击被拒 |
| A9 | QQ 侧 | Round 2 | token / op2 / op10 / `msg_id` 被动一次 / `INTERACTION_CREATE` 先 ACK / 操作者校验 |
| A10 | 生命周期 | ✅ | dispose 后无任何 HTTP/WS 流量 |

**验收台状态（2026-09-16 20:07 版，对接方在持续更新——断言 mock 行为时须注明读取时间点/行号）**：
验收台 `E:\DSHWorkspace\qq-channel-verify\` 已从 A1–A10 扩到 **A1–A15**（`run-scenarios.mjs`），
且 `mock-dsh.mjs` 现在**真的推送 follow 事件帧**：
- 开帧是真 `snapshot`：`{type:'snapshot', header, cursor, records, hasMore, projections}`（`mock-dsh.mjs:201-222`）；
- `append()` 向所有 follow 流推送 `{type:'item', streamId, value:{type:'event', event}}`（`mock-dsh.mjs:236-246`）。

→ **结论（取代早期"follow 桩不推事件"的判断）**：`session/follow` 是**实时主源**，
`session/page` 是**断线/缺口补页与对账源**——两者都必须实现。
补缺口判定式：重连后拿到 snapshot，若 `cursor > lastSeq` 且 `records` 最早 seq > `lastSeq + 1`，
用 `session/page`（`throughSeq = snapshot.cursor`，`beforeSeq` 连续前翻）补齐到 `lastSeq + 1`，**补齐后才推进 lastSeq**。

**新增场景（本轮设计必须覆盖，实现可留 Round 2 的已标注）**：
A11 控制流被服务端 `end` 后自动重连且重连后审批仍可达；A12 **历史不重放**（100 条历史垫底 + 新消息 → 恰好 1 条回复，不含 `pad-`）；
A13 **prompt 级** 401 重试 `requestId` 必须复用；A14 QQ 网关 4009 断开后重连；A15 发件箱分片上传后移入 `sent/`。
A6–A9、A14、A15 依赖 QQ 网关与消息渲染（Round 2 主体），本轮骨架不要求跑通，
但 `DESIGN.md` 必须给出 **A1–A15 对位表**（场景 → 设计元素 → 本轮可跑通 / Round 2 落地）。

### 1.6 与 v1.2.4 审查报告的处置要求（P0/P1/P2 必须逐条进处置表）

- **P0-1**（launch token 明文落盘）、**P0-2**（cookie 只取一次 + 探测吞 401）：**必须在设计层消除**，
  设计档给出结构性对策（不是"删一行"级别的补丁）。
- **P1-1…P1-11**：逐条给出 v2 结构性对策（游标/基线/缺口/隔离/退避；回执 await 后结清；
  `eventId`/`auditId` 分离；cancel 结清；无 id 帧拒绝；权限开关；requestId 调用点铸造；发件箱重入 + 大小上限）。
- **P2-1…P2-18**：作为设计检查清单，逐条标注"已消除 / 不适用（原因）/ 遗留到 Round 2"。
- 处置表形态：一行一条，列 = `编号 | 现状根因 | v2 对策（设计档节号） | 状态`。

### 1.7 本轮明令禁止（越界即本轮失败）

1. 不改/不删 `E:\DSHWorkspace\dsh-qq-channel`（现役 v1.2.4，只读）。
2. 不写 `C:\Users\么\.dsh\**` 或任何 DSH 配置。
3. 不启动/停止 DSH，不占用 3080。
4. 不 `git push`、不改远程、不在 v2 目录 `git init` 后提交（提交由对接方负责）。
5. 不联网调 QQ 官方 API；不读真实 appId/clientSecret/token。
6. 任何 secret/token 不进日志、文档、测试固件。
7. 不为让测试通过而放宽断言或跳过用例。
8. 不改 `E:\DSHWorkspace\qq-channel-verify\`（对接方的集成台，只读参考）。

### 1.8 允许事项（对接方已裁决）

- `npm install` 允许；`node_modules/` 与 `package-lock.json` 保留；`ws@8.21.3`、`@deepseek-ai/schemastery@3.18.2`。
- 联网读 QQ 官方文档站与 npm 元数据核字段（只读），核实不了写进 `PROTOCOL.md` 未验证项。
- 本轮写批次档（本文件）。
- **设计评审预授权自动发起**：`DESIGN.md` + `PROTOCOL.md` 就绪即自行调 `advisor(type='design')`；
  评审通过后在同一轮内继续派 eng-coder，不必等对接方回话。

### 1.9 交付物清单（本轮，全部落在 cwd）

| # | 文件 | 责任角色 |
|---|---|---|
| D1 | `docs/DESIGN.md` | eng-designer |
| D2 | `docs/PROTOCOL.md` | eng-designer |
| D3 | `docs/batches/round-1-design-skeleton.md` §2 任务书 | eng-designer |
| D4 | `package.json` / `cordis.patch.yml` / `.gitignore` / `README.md` | eng-coder |
| D5 | `lib/*.js` 骨架（入口 / 配置 / 日志 / 协议 / 会话 / 预留 qq） | eng-coder |
| D6 | `test/*.test.js`（含 mock 集成台，复制改造自 `qq-channel-verify`，**不改原件**） | eng-coder |
| D7 | `docs/VERIFY.md`（对接方该跑的命令与预期输出） | eng-coder |
| D8 | `docs/ROUND-1-REPORT.md` | 主 agent |
| D9 | 本批次档 §3/§5/§6 | 评审 / eng-coder / 主 agent |

### 1.10 批次验收判据（本轮完成 = 全部满足）

1. `docs/DESIGN.md` / `docs/PROTOCOL.md` 存在，R1–R10 逐条有对策小节，P0/P1/P2 逐条有处置行，
   协议事实带 `file:line`，未验证项单列。
2. 设计评审（`advisor(type='design')`）无未处置 🔴。
3. `node --test` 全绿；全部 `.js` `node --check` 通过；证据原文进 `docs/VERIFY.md` 与报告。
4. mock 自测覆盖任务书 §7.3 的四项 + A2/A10。
5. `docs/ROUND-1-REPORT.md` 末行 `DONE-ROUND-1`。
6. 单文件 ≤400 行、依赖面合规、配置键逐字一致。

---

## §2 本批任务书（eng-designer 撰写）



- 施工对象：`E:\DSHWorkspace\dsh-qq-channel-v2`（本轮唯一可写目录）。
- 配套文档（**施工前必读**）：
  - `docs/PROTOCOL.md` —— 协议事实，每条带宿主源码 `file:line`；**凡涉及协议细节以它为准**。
  - `docs/DESIGN.md` —— 设计权威：模块边界、接口契约、状态机、决策记录、R1–R10 对策、P0/P1/P2 处置表、A1–A18 对位表。
  - 本段 —— **可执行任务书**：文件清单、验收标准、报告格式。
- 优先级：本段与 `PROTOCOL.md` 冲突时以 `PROTOCOL.md` 的源码证据为准；与 `DESIGN.md` 冲突时以 `DESIGN.md` 为准并打回设计者。

### 2.1 目标与理由（一段）

从零实现 `dsh-qq-channel` v2.0.0 的**可运行骨架**：把一款 2234 行单文件、经审查暴露 2 个 P0 + 11 个 P1 + 18 个 P2 的 Cordis 插件，
在**结构上**重建为分层模块（协议层 / 会话层 / 出站端口），使三类静默失效不可能发生 ——
**认证竞态**（401 后永久失联）、**事件漏推**（丢一个 `turn/end` 即会话永久哑掉）、**审批身份错配**（"电脑端已处理"永远配不出来）。
本轮交付 DSH 侧完整骨架 + QQ 端口契约（QQ 网络层留 Round 2），供对接方审查后进入 Round 2。

### 2.2 既定事实（**已勘察，禁止重新探索**；每条带证据）

#### 2.2.1 宿主（v2 = DSH 0.1.5-rc.2，路径根 `E:\DSHWorkspace\dsh-new\node_modules\@deepseek-ai\`）

| 事实 | 证据 |
|---|---|
| `POST /api/<method>`（斜杠形式）；体 `{type:'client-request',rpcId,method,payload:{args}}`；`method` 必须逐字等于 URL endpoint | `dsh-client-connection/lib/index.js:502`、`:640-651` |
| 响应 `{type:'server-response',rpcId,result:{ok:true,value}}` 或 `{…error:{code,message,details}}` | `dsh-client-connection/lib/index.js:685`、`:492` |
| 🔴 **业务/网关错误恒为 HTTP 200**，错误在 `result.error`；非 200 只在传输层 | 同上 + `PROTOCOL.md §1.2` |
| 🔴 未认证 = **HTTP 401 + 纯文本 `unauthorized`**（无 JSON、无 code）；非信任 Host = 403 | `dsh-client-connection/lib/index.js:553-556`、`:771-777` |
| 🔴 **未知方法 = HTTP 404 + 纯文本 `not found`，无 code**（真实宿主不存在 `gateway/unknown-method`） | `dsh-client-connection/lib/index.js:582`；全 `node_modules` grep 0 命中 |
| `assertExactArguments`：args 键必须精确；多余/缺失一律 `gateway/arguments-invalid`（HTTP 200） | `dsh-api-gateway/lib/index.js:1040-1052`、调用点 `:741` |
| args 键：`session/list` → **`_request`**；`session/create`/`rename`/`prompt`/`page`/`follow` → `request` | `dsh-api-session-controller/lib/typert.host.js:901-911`、`:824-834`、`:1020-1030`、`:996-1003`、`:970-971`、`:850-860` |
| `browserAuth`：`ctx.get('connection').authenticatedUrl(base)` 返回**带 `?token=` 的绝对 URL**；`GET /?token=…` → **303 + `set-cookie`** | `dsh-client-connection/lib/index.js:370-377`、`:386-425` |
| cookie 名 = `dsh-auth-`+hash(Host)；属性 `Path=/; HttpOnly; SameSite=Strict`；**必须 `redirect:'manual'` 才能读到 set-cookie** | `dsh-client-connection/lib/index.js:280-294`、`:401-406` |
| mux：路径 **精确** `/api/remote.mux`；**鉴权走 cookie 头**（与 `/api` 同一处）；`streamId` **由客户端生成**、非空即可 | `dsh-api-gateway/lib/index.js:11`、`:459-476`、`:155-157` |
| mux 帧：客户端 `{type:'open',streamId,endpoint,payload}` / `{type:'cancel',streamId}`；服务端 `{type:'item',streamId,value}` / `{type:'end',streamId}` / `{type:'error',streamId,error}` | `dsh-api-gateway/lib/index.js:122-133`、`:325-340` |
| 服务端每 2s ping、**丢 2 次 pong 即 terminate**；**无断线续传**（socket 关闭即 abort 所有流） | `dsh-api-gateway/lib/index.js:197`、`:251-268`、`:299-301` |
| `$events` 开流 payload 必须**恰为** `{"args":{}}` | `dsh-api-gateway/lib/index.js:586` |
| `$events` 帧：`ready{type,clientId,host}` / `emit{type,event,args}` / `waterfall{type,event,eventId,agentId,request}` / `cancel{type,eventId}` | `dsh-api-gateway/lib/types/stream-protocol.d.ts:27-53` |
| `clientId` **每条流新生成**（重连后会变）→ 每次 `ready` 都要刷新本地值 | `dsh-api-gateway/lib/index.js:590-591`、`:698-702` |
| `waterfall.request` 已剥掉 `agent`/`signal`；`agentId` **就是 SessionId** | `dsh-api-gateway/lib/index.js:60-85`、`:657-663`；`dsh-agent/lib/types/types.d.ts:11-14` |
| `$events/result` args **恰** `{clientId,eventId,outcome}`；outcome ∈ `{kind:'next'}` / `{kind:'result',value?}` / `{kind:'rejected',error}` | `dsh-api-gateway/lib/types/stream-protocol.js:17-52`、`.d.ts:69-81` |
| 🔴 `$events/result` 对**未知 `eventId` 静默返回 `ok:true`**（"点了没用"不可由返回码判定） | `dsh-api-gateway/lib/index.js:683-692` |
| `session/follow`：`{address,maxMessages?,assistantStream?}` —— **无起始 seq 参数**；`@Remote({mode:'stream'})` | `dsh-api-session-controller/lib/types/types.d.ts:416-422`、`lib/index.js:2513` |
| 开帧 `{type:'snapshot',header,cursor,records,hasMore,projections}`；随后 `{type:'event',event}`；`cursor=-1` = 空日志 | `lib/types/types.d.ts:474-486`、`lib/types/history.js:196-199` |
| 事件 envelope = `{type,seq,time,data,ignorable?,surfaceOp?,sourceEventSeqs?}` —— **无 sessionId**（会话归属由流决定） | `lib/types/types.d.ts:397-407`、`lib/types/history.js:1419-1426` |
| 🔴 宿主对事件 seq 做稠密断言，**一旦不连续直接抛错终止流**（不重连不补齐）→ 补齐只能靠 `session/page` | `lib/types/history.js:243-248` |
| `session/page`：`{address,throughSeq(必填),beforeSeq?,maxMessages?}`；`throughSeq` TSDoc = "Inclusive log cut obtained from the corresponding follow opening frame" | `lib/types/types.d.ts:408-415` |
| 🔴 `paginate` = **消息对齐的向回扫窗口**：`end=min(throughSeq+1,beforeSeq??…)`、只计 `user/message`+`assistant/message` 且 `surfaceOp==='append'`、`hasMore=cut>0` | `lib/types/history.js:387-410` |
| 空日志 `cursor=-1`；`throughSeq > sourceCursor` → `gateway/bad-request` + `session page through seq N is past cursor C` | `lib/types/history.js:110-113` |
| `session/prompt`：`{requestId,sessionId,mode,content,clientTimeZone?}`；**`mode` 必填**，取值仅 `'queue'` / `'steer'` | `lib/types/types.d.ts:291-300`、`lib/typert.host.js:573-590` |
| 宿主只特判 `'steer'`，其余一律 `followup` → `mode:'queue'` 合法且行为 = followup | `dsh-api-session-controller/lib/index.js:773-774` |
| `requestId` 去重：命中在途收件箱或已落盘 `user/message.data.source.rpcId` → 直接回 `{accepted:true}` 且不追加消息 | `lib/index.js:741`、`:940-951` |
| 审批瀑布帧 `request` **不含 id**；`ApprovalRequestId` 只出现在会话日志的 `approval/asked{id,…}` / `approval/decided{id,outcome}`（同一 id） | `dsh-user-approval/lib/types/types.d.ts:37-51`、`lib/index.js:134-145` |
| 🔴 `approval/asked` / `decided` **不在 `$events` 转发白名单**里 → 只能经 `session/follow` 获取 | `dsh-api-remotes/lib/index.js:17-94` |
| `ApprovalOutcome = 'allowed-once' / 'rejected' / 'cancelled' / 'unavailable'` | `dsh-user-approval/lib/types/types.d.ts:26` |
| 提问：`user-questions/request` waterfall，request = `{questions:[{id,question,detail?,header?,options?,multiSelect?,intent?}]}`；应答 = `{answers:[{id,selected[],custom?}]}`，**复用 `$events/result`**；**无 asked/decided 审计对** | `dsh-user-questions/lib/types/types.d.ts:29-67`、`:46-58`、`:77` |
| 设置：`settings.installSection(ctx, ns, Config, entry, {setSource, onChange})`；**`setSource` 收到的是取当前配置的 thunk**；注册时同步回调一次 `onChange` | `dsh-settings/lib/index.js:327-343`、`lib/types/index.d.ts:314-334` |
| 🔴 `installSettingsSection`（旧 API）在 0.1.5-rc.2 **不存在**（grep 0 命中）—— 旧宿主形态未验证 | `PROTOCOL.md §9.8` / `§10.2` |
| `ctx.get(name)` 未注册返回 `undefined`；`ctx.effect(fn)` 立即执行、返回函数即 disposer | `cordis/lib/index.js:762-771`、`:1168-1278` |

#### 2.2.2 现役 v1.2.4（只读，`E:\DSHWorkspace\dsh-qq-channel\lib\index.js`，实测 **2234 行**）

| 事实 | 证据 |
|---|---|
| 配置键 **17 个**（逐字与默认值见 `PROTOCOL.md §9.13`）；`appId` = `z.union([string,number])` 转 string | v1 `:46-68` |
| 导出面 `name` / `Config` / `inject`(=`[]`) / `apply`；设置命名空间 `qq-channel` | v1 `:44`、`:46`、`:70`、`:82` |
| 设置注册新/旧双分支（`installSection` 优先，`installSettingsSection` 兜底），失败重试 24×500ms 后回落行配置 | v1 `:113-158` |
| 配置读取 = 闭包 `current` + 启动时浅拷贝快照（**不是**每次读 ctx） | v1 `:85`、`:92-94`、`:99-101` |
| dshUrl 由 `ctx.get('webServer')?.port ?? 3080` 构造 | v1 `:188-190` |
| v1 协议：`/api/{method}`（如 `session.list`）、报文同信封、回传 `/api/respond`、事件 WS `/api/events.mux` | v1 `:231-232`、`:255`、`:758-762`、`:190` |
| 硬超时：`session.prompt` 60s、其余 15s | v1 `:322` |

#### 2.2.3 验收台（只读，`E:\DSHWorkspace\qq-channel-verify\`；版本指纹见 `PROTOCOL.md §0.2`）

| 事实 | 证据 |
|---|---|
| 假 ctx **只提供五面**：`logger{info,warn,error}` / `get('settings')` / `get('webServer')→{port}` / `get('connection')→{authenticatedUrl}` / `effect(fn)` | `fake-ctx.mjs:19-41` |
| 🔴 假 `installSection(_ctx,_name,_schema,initial,hooks)` **只调 `hooks.setSource`，不调 `hooks.onChange`** | `fake-ctx.mjs:12-17` |
| `webServer.port` = **mock DSH 的端口**（插件据此构造 dshUrl） | `run-scenarios.mjs:67` |
| 起动即 `plugin.apply(ctx, config)`；**`boot()` 等 QQ IDENTIFY** 才返回 | `run-scenarios.mjs:68-70` |
| mock DSH 的 `session/follow` **会真推事件帧**：开帧 snapshot + `append()` 向所有 follow 流推 `{type:'item',streamId,value:{type:'event',event}}` | `mock-dsh.mjs:201-222`、`:236-246` |
| mock 记录 `rejectedUpgrades`：**任何非 `/api/remote.mux` 的 upgrade 都算错**（A1 断言其为空） | `mock-dsh.mjs:179-183`、`run-scenarios.mjs:101` |
| mock 的未知方法回 `gateway/unknown-method`（**与真实宿主不同**，须两种都识别） | `mock-dsh.mjs:123`、`:173` |
| 场景 A1–A18；`MODE=core` 只跑 `core` 标签，`A16/A17/A18` 标 `v2` | `run-scenarios.mjs:76-86`、`:384-385` |
| 端口桩需覆盖的出站形态：`sendText` 的 `target.openid`、正文取 `markdown?.content ?? content` | `mock-qq.mjs:119-121` |

#### 2.2.4 本批规定的缺口补齐判定式（照抄，不得自创）

见 `DESIGN.md §2.4.4` 与 `PROTOCOL.md §5.3`：新开 follow 拿到 `snapshot` 后与 `lastSeq` 比对，
`earliest > lastSeq + 1` 时用 `session/page`（`throughSeq = snapshot.cursor`，`beforeSeq` 逐页前翻）补到覆盖 `lastSeq + 1`，
**补齐后才推进 `lastSeq = snapshot.cursor`**；`cursor < lastSeq` 视为异常（重置对账）；放行按 `seq` 升序且跳过 `seq <= lastSeq`。

### 2.3 模块与文件清单（职责 / 导出面 / 行数预算）

依赖方向**单向**：`index → channel → {session/*, protocol/*} → {log, result} → qq/port`；`protocol/*` 不懂会话语义，`session/*` 不懂 HTTP/WS，`qq/*` 不懂 DSH。

| 文件 | 职责 | 导出面 | 预算上限 |
|---|---|---|---|
| `lib/index.js` | Cordis 入口：导出 `name`/`Config`/`inject`/`apply`；组装与生命周期 | `name, Config, inject, apply` | 120 |
| `lib/channel.js` | 组装根：接线、把状态机的"回复意图"交给出站端口并 await 结果 | `createChannel(deps)` | 160 |
| `lib/config.js` | `Config` schema、设置注册（新/旧 API）、配置读取（`setSource` thunk） | `Config, registerSettings(ctx, config, hooks)` | 150 |
| `lib/log.js` | 结构化日志、凭据脱敏、限流、文件 sink | `createLog({ctx, dir, debug})` | 150 |
| `lib/result.js` | 统一结果类型与 reason 词表 | `ok, fail, REASONS` | 60 |
| `lib/protocol/auth.js` | browserAuth cookie 获取/刷新 | `createAuth({ctx, dshUrl, log})` | 110 |
| `lib/protocol/transport.js` | HTTP RPC（v2/v1 信封）、超时分档、401 重认证 + 重试一次 | `createTransport({auth, dshUrl, log})` | 200 |
| `lib/protocol/detect.js` | 协议探测三态 | `detectProtocol({transport, log})` | 90 |
| `lib/protocol/mux.js` | `remote.mux` 客户端：open/cancel、帧路由、断线重开、dispose | `createMux({dshUrl, auth, log})` | 220 |
| `lib/protocol/v2.js` | v2 方法映射、`$events` 控制流、`$events/result` | `createV2({transport, mux, log})` | 130 |
| `lib/protocol/v1.js` | v1 方法映射、`/api/respond`、`events.mux` 适配 | `createV1({transport, log})` | 150 |
| `lib/session/events.js` | 事件归一化 + follow 消费 + `page` 缺口补齐 | `createEventPump(deps)` | 260 |
| `lib/session/state.js` | 会话状态机：基线、游标、忙闲、待发队列、回复目标、空闲淘汰 | `createSessionStore({log})` | 270 |
| `lib/session/pending.js` | 审批/提问条目：`eventId`/`auditId` 分列、cancel 结清、审计配对、TTL | `createPendingStore({log})` | 200 |
| `lib/qq/port.js` | **出站端口契约** + 空实现（Round 2 接真实适配器） | `createNullPort({log})` + JSDoc 契约 | 80 |
| `lib/qq/README.md` | Round 2 落点说明（键盘/交互/文件/发件箱） | — | — |
| `test/helpers/fake-ctx.mjs` | 复制自验收台（**不改原件**），加 provenance 头 | — | 60 |
| `test/helpers/mock-dsh.mjs` | 复制自验收台（同上），允许加"抑制 live 推送"开关用于 T-I10 | — | 300 |
| `test/helpers/qq-port-stub.mjs` | 记录型出站端口桩（被调用的 target/text/次数） | — | 90 |
| `test/result.test.js` `log.test.js` `config.test.js` | 纯逻辑单测 | — | 90 / 120 / 140 |
| `test/protocol.test.js` | 传输/401/探测三态/超时/映射键集 | — | 220 |
| `test/session.test.js` | 基线、幂等、缺口补齐、状态机、隔离、退避、淘汰 | — | 240 |
| `test/pending.test.js` | 条目生命周期、配对、cancel、TTL、授权 | — | 190 |
| `test/integration.test.js` | T-I1–T-I11（mock 集成台） | — | 300 |
| `package.json` `cordis.patch.yml` `.gitignore` `README.md` `docs/VERIFY.md` | 工程面 | — | 45 / 12 / 18 / 90 / 90 |

**测试可注入性（关键）**：`lib/index.js` 的 `apply` 必须能按验收台方式被调用；同时把组装逻辑放在 `lib/channel.js` 的 `createChannel(deps)` 里，
使 `test/` 能直接以 `{ ctx, config, log, qqPort, now }` 驱动，**无需** QQ 网络层。这是本轮可验证性的前提。

### 2.4 接口契约（逐字对齐 `DESIGN.md §2.3`，不得改名）

```js
// 统一结果类型 —— reason 为封闭词表
ok(value) -> { ok: true, value }
fail(reason, code, message) -> { ok: false, reason, code?, message }
// reason ∈ 'transport' | 'timeout' | 'unauthorized' | 'not-found' | 'protocol-mismatch'
//          | 'rejected' | 'unavailable' | 'no-target' | 'no-session' | 'disposed'

// 统一内部事件模型（跨 v1/v2、跨流/页）—— 层间只传这个，不传原始帧
{ sessionId, seq, time, type, data, origin: 'snapshot' | 'page' | 'live', protocol: 'v2' | 'v1' }

// 协议层
createTransport({ auth, dshUrl, log }) -> { rpc(method, args, { timeoutMs, requestId }) -> Promise<Result>, dispose() }
createMux({ dshUrl, auth, log })       -> { open(endpoint, payload, onFrame), onDown(handler), dispose() }
detectProtocol({ transport, log })     -> Promise<'v2' | 'v1' | 'protocol-mismatch' | Failure>

// 会话层
createSessionStore({ log, ttlMs }) -> {
  adopt(sessionId, 'replay-all' | 'skip-history'), noteReplyTarget(sessionId, target),
  ingest(event), nextReply(sessionId), snapshot(sessionId), sweep(now), clear()
}
createPendingStore({ log, ttlMs, authorize }) -> {
  addFromWaterfall({ eventId, sessionId, kind, request }), attachAudit({ sessionId, auditId, toolName, callId, reason }),
  auditDecided({ auditId, outcome }), settleByEventId(eventId, reason), answerable(eventId, operator), get(eventId), sweep(now)
}
createEventPump({ transport, mux, state, onEvent, log }) -> { attach(sessionId, {baseline}), detach(sessionId), reconcile(sessionId, snapshot), dispose() }

// 出站端口（本轮空实现）
createNullPort({ log }) -> { sendText(target, text, opts) -> Promise<Result>, sendKeyboard(target, text, keyboard, opts) -> Promise<Result> }
// target = { kind: 'c2c' | 'group', openid }
```

硬性约定：

1. **`sessionId` 一律由"流/页属于哪个会话"注入**，禁止读事件体内的 `sessionId`（真实宿主无此字段，mock 有，是 mock 附加物）。
2. **回传 `$events/result` 必须用最近一次 `ready` 给的 `clientId`**（重连后 clientId 会变）。
3. **`session/prompt` 必须显式传 `mode:'queue'`**（省略 → `gateway/input-invalid`）。
4. **`requestId` 在调用点铸造一次**，重试原样复用；映射函数只包装不生成。
5. **401 判定看 HTTP 状态码**，不看 `error.code`；**业务失败判定看 `result.ok`**，不看状态码。
6. **禁止空 `catch {}`**：每个 catch 必须"记日志 + 改状态 + 返回 Result"三者之一。
7. **发送/回传必须 `await` 结果并按结果改状态**；失败不得结清条目（P1-5）。
8. **所有定时器/套接字/监听必须经 `ctx.effect` 注册**，`dispose()` 幂等（A10）。
9. **`apply` 不得只在 `onChange` 里启动**（假 ctx 不调 `onChange`，只在 `setSource` 后裸启动；`hooks` 仍须同时提供 `setSource` 与 `onChange`，因为真实宿主两者都调）。
10. 只使用假 ctx 五面（`logger` / `get('settings')` / `get('webServer')` / `get('connection')` / `effect`）；**不使用 `ctx.on`**；`inject = []`。

### 2.5 禁止范围（越界即本轮失败）

1. **不实现 QQ 网络层**：token、网关 WS、IDENTIFY/心跳/RESUME、REST 发消息、键盘/交互、文件上传、发件箱/收件箱、markdown 渲染 —— 全部留 Round 2。
   `lib/qq/port.js` 只给契约 + 空实现；`lib/qq/README.md` 写清 Round 2 落点。
2. 不改 `E:\DSHWorkspace\dsh-qq-channel`（只读）、不改 `E:\DSHWorkspace\qq-channel-verify\`（只读参考；复制到 `test/helpers/` 可以，**不许改原件**）。
3. 不写 `$DSH_HOME/**` 或任何 DSH 配置（测试里用 `mkdtemp` 临时目录）。
4. 不启动/停止 DSH；不占 3080；不联网；不读真实 appId/clientSecret/token。
5. 不 `git push`、不改远程、不提交（提交由对接方负责）。
6. 任何 secret/token 不进日志、文档、测试固件。
7. **不为让测试通过而放宽断言或跳过用例**；失败就如实写进报告。
8. 不引入 `ws` 与 `@deepseek-ai/schemastery` 之外的运行时依赖。
9. 不改本批次档的 §1/§3/§4/§5/§6（只写自己的 §5）。

### 2.6 验收标准（可机判）

| # | 标准 | 命令/判据 |
|---|---|---|
| AC1 | `node --test` 全绿，含 `DESIGN.md §3.1` 的 T-U1–T-U30 与 T-I1–T-I11 | `node --test test/` |
| AC2 | 全部 `.js` 语法通过 | `node --check <file>`（每个文件） |
| AC3 | 每文件 ≤400 行 | 行数统计 |
| AC4 | `dependencies` 恰为 `ws@8.21.3` + `@deepseek-ai/schemastery@3.18.2`；`peerDependencies` 含 `@deepseek-ai/cordis` + `@deepseek-ai/dsh-settings` | 读 `package.json` |
| AC5 | 无空 `catch {}`；所有发送/回传调用点 `await` 结果 | 静态检查 |
| AC6 | launch token 明文不出现在 stdout/stderr 与 `$DSH_HOME/storages/*.log` | T-I2 |
| AC7 | 配置键 **17 个**逐字一致；`appId` 接受 string\|number | `config.test.js` |
| AC8 | 文档无 >300 字符单行 | 行长度检查 |
| AC9 | A1–A5、A10–A13 的 DSH 侧行为在 T-I1–T-I11 中可复现 | 集成用例 |
| AC10 | `lib/qq/` 存在且为端口契约 + 空实现，Round 2 落点明确 | 目录 + `lib/qq/README.md` |
| AC11 | 探测报文 args 键恰 `_request`；**未尝试** `events.mux`；v2 下已建立 follow 或 page 通道 | T-I1（对应 A1） |
| AC12 | `session/prompt` 报文 args 键恰 `request`，含 `requestId` 与 `mode:'queue'` | T-I5（对应 A4） |
| AC13 | prompt 级 401 重试后 `request` 的 `requestId` 与首次**完全相同**，且宿主侧只接受 1 条 | T-I4（对应 A13） |
| AC14 | 100 条历史垫底后新轮次**恰好 1 条**回复、不含历史内容 | T-I7（对应 A12） |
| AC15 | 控制流被服务端 `end` 后自动重开（open 帧计数增加），重开后审批仍被处理 | T-I8（对应 A11） |
| AC16 | `dispose()` 后 ≥4s 无任何 HTTP/WS 流量 | T-I9（对应 A10） |
| AC17 | 窗口外 `turn/end` 经 `page` 补页后不丢（回复产出） | T-I10（对应 A5/R3） |

**本轮不要求跑通**（QQ 侧，留 Round 2）：A6–A9、A14–A18 的 QQ 部分；`docs/VERIFY.md` 须写明"用对接方的 `run-scenarios.mjs` 跑本轮骨架会停在 boot（其 `boot()` 等 QQ IDENTIFY）"，以及本轮应跑的替代命令。

### 2.7 交付报告格式（`docs/ROUND-1-REPORT.md`，eng-coder 写；最终报告由主 agent 收口）

必含：结论摘要（3–5 行）· 交付清单（文件 → 作用 → 行数）· 自测证据（命令 + 原始输出片段）·
与审查报告 P0/P1/P2 的处置表（照 `DESIGN.md §2.8` 逐条，标"修 / 不修 + 理由"）·
**未验证项**（逐条列）· 需要裁决或提供的信息（逐条编号）。

报告末尾必须是 Delivery Report 表，**一条需求一行**（F1–F10 + AC1–AC17）：

| # | Status | Requirement |
|---|--------|-------------|
| 1 | ✅ Done | （完整覆盖） |
| 2 | ⚠️ Simplified | （做了但更简单 —— 说明差距） |
| 3 | ❌ Not done | （未实现 —— 含本轮想推迟的一切） |

注意：没有"deferred/后续"列 —— "以后再做"就是"现在没做"，归 ❌ 并说明归属轮次（如"QQ 网络层，Round 2"）。

### 2.8 编号对齐更正（三方条目一致 —— 以本节为准）

`§2.6` 的验收标准表里，`AC1–AC10` 与 `DESIGN.md §3.2` 的 `AC1–AC10` **同号同义**（canonical）；
但该表后半段的 `AC11–AC17` 与设计档的编号体系不同源，属**编号冲突**，现更正为：

| 旧编号（§2.6） | 新编号 | 对应验收场景 | 归属 |
|---|---|---|---|
| AC11 | **SC1** | A1（探测报文 + 未触 `events.mux` + v2 事件通道已建立） | AC9 的子项 |
| AC12 | **SC2** | A4（prompt 报文 args 键 + requestId + mode） | AC9 的子项 |
| AC13 | **SC3** | A13（prompt 级 401 重试 requestId 复用） | AC9 的子项 |
| AC14 | **SC4** | A12（历史不重放，恰好 1 条回复） | AC9 的子项 |
| AC15 | **SC5** | A11（控制流 `end` 后自动重开） | AC9 的子项 |
| AC16 | **SC6** | A10（dispose 后无流量） | AC9 的子项 |
| AC17 | **SC7** | A5 / R3（窗口外 `turn/end` 经补页不丢） | AC9 的子项 |

**三方条目一致（自查基线，评审据此判覆盖与范围）：**

1. **需求档条目** = `批次档 §1.2` 的 `F1–F10` = `DESIGN.md §1.2` 的 `F1–F10`（逐条同名同义）。
2. **验收标准条目** = `DESIGN.md §3.2` 的 `AC1–AC10`（canonical）；`§2.6` 的 `AC1–AC10` 与之同号同义，`SC1–SC7` 为 AC9 的场景级子判据。
3. **用例条目** = `DESIGN.md §3.1` 的 `T-U1–T-U30` + `T-I1–T-I11`；`§2.6` 引用的即这一组，无第二套编号。
4. **非功能条目** = `批次档 §1.3` 的 `N1–N8` = `DESIGN.md §1.3` 的 `N1–N8`，其中 **N7 的"18 个配置键"应为 17**（见 `§2.2.2` 与 `PROTOCOL.md §9.11`；计数与列表必须同时改，否则该条无法机判）。

> 主 agent 若在 §1 修订 N7 计数，本段不再变动；`DESIGN.md` 与 `PROTOCOL.md` 已按 17 落档。


---

### 2.9 修正轮追加（REVIEW-1 M1–M6 落档 —— coder 的实现依据）

本节是修正轮补充，**不改动 §2.1–§2.8 原文**（append-only）；与前述节冲突处**以本节为准**。
本轮改动只落在 `docs/DESIGN.md`、`docs/PROTOCOL.md` 与本节：**未夹带新语义/新范围**（全部来自 `REVIEW-1` 已裁决事项）。
→ **对 coder 的实际影响只有一条进本轮实现**：M2 的事件白名单（§2.9.2）。M1/M3/M4 是 Round 2 落点，本轮只固定契约；M5 是协议档修正。

#### 2.9.1 M1 被动回复模型 = **窗口**（改设计）

- **作废**："同一 `msg_id` 只有一次被动额度"（v1 的 `usedPassiveMsgIds`，v1 `:634`/`:696`；审查 P2-3 的"ack 只带一次 msgId"同样基于该错误前提）。
- **v2 契约**（`DESIGN.md §2.3.4`，决策 D17）：收到消息后 **5 分钟内**，**每条**出站消息都**可以**带 `msgId`；每条配**唯一 `msgSeq`**（0..65535）；
  契约只保证 **`(msgId,msgSeq)` 不重复**；**`msgSeq` 的分配责任在出站端口**（`lib/qq/`），**同一 `msgId` 首次发送为 `1`**、此后单调递增。
  端口信封：`opts.passive: { msgId }`（声明本条可走被动窗口）+ `opts.msgSeq?`（缺省由端口分配）。
- 证据（逐行核）：Hermes `gateway/platforms/qqbot/adapter.py:2777-2790`（`_build_text_body` 每次发送都带 `msg_seq`）、
  `:2568-2569` / `:2590-2591` / `:2969-2970`（`reply_to` 存在即设 `body["msg_id"]`）、`:944-949`（`_next_msg_seq` = `0..65535`）；全仓无"已用额度"记录。
- 验收口径：**A9（core）首条带 `msg_id`** + **A20（v2 目标）窗口内每条都带且 `(msg_id,msg_seq)` 唯一、`msg_seq` 为整数** —— **Round 2 落地，本轮只固定契约**。
- 文档冲突留痕：对接方 `thincoder-v2-qq-spec.md §3` 与 `REVIEW-1 §三 M1` 相反，**以 REVIEW-1 为准**（`PROTOCOL.md §9.14` 已记）。

#### 2.9.2 M2 事件白名单与未知事件静默（**本轮实现**）

真机一次 prompt 推 **16 帧**（实测 2026-09-16，来源 `thincoder-v2-live-verified.md §2`）。消费侧**只认下表**，其余**静默忽略 + debug 计数**；
**未知类型不得报错、不得中断流**。落点：`lib/session/state.js` 的 `ingest(event)` 首步判定（`events.js` 只做归一化）。

| 事件类型 | 处理动作 |
|---|---|
| `turn/start` | 状态机 → `busy`；清空本轮助手文本累积 |
| `assistant/message` | **唯一文本来源**：累积为本轮回复正文 |
| `turn/end` | 状态机 → `idle`；产出"回复意图"交给 `channel.js` |
| `approval/asked` | `pending.attachAudit({ sessionId, auditId:id, … })`（与 waterfall 双向配对） |
| `approval/decided` | `pending.auditDecided({ auditId:id, outcome })` → **恰好一条**"已处理"通知 |
| 其余全部（`system/message`、`user/message`、`session/title`、`session/title-llm-request`、`step/start`、`step/end`、`request/header`、`request/context`、`agent/inbox/spliced` … 及**本表未列出的任何新类型**） | **静默忽略**；debug 级按类型名计数 |

- **`user/message` / `system/message` 不得变成回复**（它们只是噪声）；回复正文只来自 `assistant/message`。
- 规则形态 = 白名单之外的一切都走同一分支，**不需要逐个登记新类型**；忽略计数可见（R7）。
- 设计落点：`DESIGN.md §2.4.6`（决策 D18）；用例 `T-U31`；验收 `AC11`。

#### 2.9.3 M3 键盘按钮（Round 2 落点，本轮只固定）

每个回调按钮**必须同时**具备：`action.type=1`（回调型）、`action.data="approve:<handle>:<outcome>"`（锚定正则解析）、
`action.permission.type=2`（"人人可点"——**不是权限**）、`action.click_limit=1`（平台级"点过即灰"）、`render_data.visited_label`（非空）。
- **服务端校验仍是唯一防线**：`click_limit` 只是体验增强，**不得**写成"靠按钮防重复"；防重复靠 `pending.answerable()` + 回传后结清。
- 证据：Hermes `gateway/platforms/qqbot/keyboards.py:57-90`、`:98-109`；验收场景 A16（v2 目标）。
- 设计落点：`DESIGN.md §2.10.1`。

#### 2.9.4 M4 文件链三个已知坑（Round 2 落点，本轮只固定）

1. `upload_part_finish` **必须带 `upload_id`**（现役 v1.2.4 `:1940-1945` 已正确，别退步）；错误码：`40093001` = 瞬时可重试，`40093002` = 当日限额 = **永久失败**（进 `failed/`）。
2. 上传前 `statSync` 大小上限 + **分片读取**，**不许整文件进内存**（v1 `:1903` `readFileSync` 是反例）；哈希单遍流式，`md5_10m` 只吃前 `_MD5_10M_SIZE` 字节。
3. 附件下载**只对预期域名**带 `Authorization`（P2-16）；QQ 给的 URL 不能无条件附带 bot token。
- 证据：Hermes `chunked_upload.py:18-22`、`:50-51`、`:456-459`、`:507`、`:548-550`、`:559-586`；验收场景 A17（v2 目标）。设计落点：`DESIGN.md §2.10.2`。

#### 2.9.5 M5 协议档游标断言（已落 `PROTOCOL.md`）

- `PROTOCOL.md §5.1`：`-1` 限定为"**真正的空日志**"；真机实测 `session/create` 后立刻查游标 = **2**（新建会话自带初始事件），越界文案 `session page through seq <N> is past cursor 2`。
- 引用行号对准 bundle `dsh-api-session-controller/lib/index.js:1378`（`sourceLog.at(-1)?.seq ?? -1`，实际被加载的副本）+ `lib/types/history.js:196-199`；`§5.2`/`§5.4` 同步。
- 规则：**引文与本机实测不一致时以实测为准并标注**（来源 `thincoder-v2-live-verified.md §3`，实测于 2026-09-16）。

#### 2.9.6 本追加节的验收条目（三方条目一致的增量）

| 条目 | 回指需求 | 验收方式 |
|---|---|---|
| **AC11**（`DESIGN.md §3.2`） | F4 / R2 / D18 | 事件白名单：白名单外类型静默忽略且不中断流；`assistant/message` 是唯一文本来源 → 用例 `T-U31`（`node --test`） |
| **AC12**（`DESIGN.md §3.2`） | F3 / D17 | 出站端口契约能表达"本条可走被动窗口"且 `msgSeq` 分配责任归端口 → **本轮契约落档**（`§2.3.4`）；判定口径 = 对接方 **A9（core）/ A20（v2 目标）**，Round 2 落地 |

- **三方条目一致**：本节两条**不新增需求项**——AC11 回指 `F4`、AC12 回指 `F3`，两条需求在 `批次档 §1.2` 与 `DESIGN.md §1.2` 逐条同名同义。
- 场景级子判据沿用 `§2.8` 的 `SC1–SC7` 体系；对接方新增场景 **A19**（`mode` 必填，core）与 **A20**（被动窗口，v2 目标）见 `DESIGN.md §3.3` 对位表。

#### 2.9.7 M6（流程，不改文档）

`test/` 套件是我方自证证据，**不替代对接方验收**：以其验收台结果为准，冲突时回来定位差异。已读，**不再改动此条**。

## §3 设计评审发现

> ⚠️ **段作者标注（纪律要求，不得静默代笔）**：本段**不是评审子代理自写**——本会话的
> `advisor(type='design')` **机械故障**（见 §3.3），评审实例无法通过 `batch_segment` 写入。
> 本段由**主 agent 代写并打标**，内容分为两部分：§3.1 = 对接方 `docs/REVIEW-1.md` 的评审发现（真实外部评审，
> 权威且带真机证据）；§3.3 = 机内评审器故障记录。禁止把本段当作"机内评审已通过"。

### 3.1 对接方评审（`docs/REVIEW-1.md`，2026-09-16 04:19 落文本仓）

总评：**设计通过，可以进入实现**。三条独立发现与其真机核验一致（`mode` 必填、审计事件不在 `$events` 白名单、
`follow` 作主源 + `page` 补页），31 条缺陷处置表与 41 条用例结构完整，范围边界明确。

| # | 发现 | 级别 |
|---|---|---|
| M1 | 被动回复模型错误：不是"每个 `msg_id` 只有一次被动额度"，而是窗口内**每条**都应带 `msg_id` + 唯一 `msg_seq` | 🔴 改设计 |
| M2 | 缺"事件类型 → 处理动作"白名单表（真机一次 prompt 推 16 帧，未知类型必须静默） | 🟡 补落点 |
| M3 | 键盘按钮必须带 `click_limit: 1`（`permission.type=2` 不会置灰） | 🟡 补落点 |
| M4 | 文件链三坑：`upload_part_finish` 带 `upload_id`、错误码分类、`statSync` 上限 + 分片读、下载凭据只带预期域名 | 🟡 补落点 |
| M5 | `PROTOCOL.md §5.1` 游标断言需限定"真正的空日志"（实测新建会话 `cursor=2`） | 🔵 文档修正 |
| M6 | 自测不能替代对接方验收（流程） | — |

另附真机核验 7 条（`probe-live-host.mjs`，16/16）：`mode` 必填；`follow` 实时推 16 帧；`page beforeSeq` 前翻有效；
审计事件确实不在 `$events` 白名单；`$events` 开帧 `{type:'ready',clientId,host}`；新建会话 `cursor=2`；
image part 为 zod union、额外键被剥离、退化图片报 `session/attachment-invalid`。

### 3.2 独立复核（多模型会诊，替代机内评审）

见 `docs/CONSULT-1.md`（会诊结论落地后追加；若会诊未在本轮返回，则本行为"未完成"，不视为通过）。

### 3.3 机内设计评审器故障（阻断记录）

| 项 | 内容 |
|---|---|
| 工具 | `advisor(type='design', async:false, documents=[…])` |
| 尝试 1 | `documents=[DESIGN.md, PROTOCOL.md, 批次档, REVIEW-1.md]` + `batchDoc` → 9 秒后 `status:done`，**未写 §3**、无报告内容 |
| 尝试 2 | 去掉 `batchDoc`（走"无批次档不受阻"路径）→ `review failed (unknown)` |
| 尝试 3 | 缩小到单档 `docs/REVIEW-1.md`（8.7 KB）→ **同样失败**（排除文档体积因素） |
| 原始错误 | `The "chunk" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received an instance of Object.` |
| 结论 | 评审器对**任意输入规模**均确定性失败 → 会话级机械故障（Node 流写入收到 Object），非范围/体积问题 |
| 后果 | **designToken 未签发**（工具明示 `评审未完成——token 未签发`）→ `eng-coder` 被机械拒绝（见 §3.4） |
| 处置 | **不绕过门禁、不改 `.thincoder` 配置规避**（任务书 §0 明令）；改走"报告写清被拦工具与提示"路径 |

### 3.4 eng-coder 门禁复现（证据）

```
subagent(role='eng-coder', batchDoc='docs/batches/round-1-design-skeleton.md')   // 不带 designToken
→ Error: Invalid or missing design token — run advisor with type='design' first and pass the returned token as designToken.
```

---

## §4 裁决表（主 agent）

裁决对象：`docs/REVIEW-1.md` 的 M1–M6 与 §一/§二 裁决。全部修正轮已落地并回读核验（`docs/DESIGN.md` / `docs/PROTOCOL.md`）。

| # | Action | Detail |
|---|---|---|
| M1 | Fixed | 被动回复模型重写为"窗口"：`DESIGN.md:323` D17（窗口内每条带 `msgId`，`msgSeq` 由出站端口分配并保证 `(msgId,msgSeq)` 唯一）+ 证据行 `DESIGN.md:326-328`（Hermes `adapter.py:2777-2790`/`:2568-2569`/`:944-949`，全仓无 `usedPassiveMsgIds`）；P2-3 处置行随之改写；A20 对位行 `DESIGN.md:571` |
| M2 | Fixed | `DESIGN.md §2.4.6`（`DESIGN.md:283-292`）新增"事件类型 → 处理动作"表：5 类处理、其余静默 + debug 计数、未知类型不得断流；`assistant/message` 为唯一文本来源；新增决策 D18（`DESIGN.md:324`）；已同步进批次档 §2 与 `PROTOCOL.md` |
| M3 | Fixed | `DESIGN.md §2.10.1`（`DESIGN.md:457-461`）键盘字段表：`permission.type=2` + `action.click_limit=1` + `render_data.visited_label`；并显式写死"服务端校验仍是唯一防线，`click_limit` 不得写成防重复手段"（防重复判定点 = A6 / `pending.answerable()`） |
| M4 | Fixed | `DESIGN.md §2.10.2` 文件链三坑：`upload_part_finish` 带 `upload_id` + `40093001` 可重试 / `40093002` 永久失败；`statSync` 上限 + 分片读；下载凭据只带预期域名（P2-16 结构性对策） |
| M5 | Fixed | `PROTOCOL.md §5.1` 游标断言限定为"真正的空日志"，补实测事实（新建会话 `cursor=2`，来源 `thincoder-v2-live-verified.md`），引用行号对准 `dsh-api-session-controller/lib/index.js:1378` 与 `types/history.js:196-199` |
| M6 | Fixed | 流程确认：`test/` 仅为自证证据，不替代对接方验收台；已落 `DESIGN.md §3.3` 与批次档 §2 |
| open-1 | Fixed | 维持本轮范围（QQ 网络层留 Round 2）；`DESIGN.md §5.2` 标为已裁决，并写明其验收台 `SKIP_QQ=1` 下 A1–A9/A14–A18 **必然失败**（入站流量需 QQ 层），本轮证据以 `test/` 为准 |
| open-2 | Fixed | 裁决采纳：`md5_10m = 10_002_432` 正确，不改为 `10485760`；`PROTOCOL.md §10.1` 由"未验证"改"已裁决"（Hermes `chunked_upload.py:66-67` + `:585-586`）；P2-6 处置行同步（`DESIGN.md:421`） |
| open-3 | Fixed | 保留旧设置 API 防御分支 + 标未验证（接受裁决） |
| open-4 | Fixed | 计数更正为 **17 键**：批次档 §1.3 N7（主 agent 落）与 `DESIGN.md §1.3` N7 / `PROTOCOL.md §9.11` 已对齐 |
| open-5 | Fixed | 设计要求先固定：回传失败 → 条目保留 pending + 明确告知（T-U26 覆盖）；重连策略留 Round 2 真机 |
| P2-17 | Fixed | image part 结论更新：zod union（`typert.host.js:577-585`，本人独立复核）；额外键被剥离 → `inboxPath` 改走 text part；退化图片必须文本兜底 |

**未裁决（实测由机制故障导致，见 §3.3）**：`advisor(type='design')` 未产出发现、未签发 designToken →
本轮**无机内独立评审结论**。已按任务书 §0 的明令"不绕过门禁"，改为报告披露 + 外部/多模型复核。

---

## §5 实现记录（eng-coder 撰写）

（待实现）

---

## §6 批次收口（主 agent）

### 6.1 批次状态（2026-09-16）

**部分完成，卡在实现前的门禁上**：

- ✅ 设计与协议档交付（`docs/DESIGN.md` 606 行 · `docs/PROTOCOL.md` 524 行），对接方 `docs/REVIEW-1.md` **裁决"设计通过，可以进入实现"**；
- ✅ REVIEW-1 的 M1–M6 + open-1…open-5 修正轮全部落地（见 §4）；
- ⛔ **实现未开始**：机内 `advisor(type='design')` 机械故障 → `designToken` 未签发 → `eng-coder` 机械拒绝（§3.3/§3.4）；
  按任务书 §0 明令未绕过门禁，改以 `docs/ROUND-1-REPORT.md` 披露。

### 6.2 交付物对照（§1.9 D1–D9）

| # | 交付物 | 状态 |
|---|---|---|
| D1 | `docs/DESIGN.md` | ✅ 交付 |
| D2 | `docs/PROTOCOL.md` | ✅ 交付 |
| D3 | 批次档 §2 任务书 | ✅ 交付（含 §2.8 编号对齐更正） |
| D4 | `package.json` / `cordis.patch.yml` / `.gitignore` / `README.md` | ⛔ 未创建（门禁阻断） |
| D5 | `lib/*.js` 骨架 | ⛔ 未创建（门禁阻断） |
| D6 | `test/*.test.js` + mock | ⛔ 未创建（门禁阻断） |
| D7 | `docs/VERIFY.md` | ✅ 交付（形态为"命令清单 + 当前无产物说明"） |
| D8 | `docs/ROUND-1-REPORT.md` | ✅ 交付（末行 `DONE-ROUND-1`） |
| D9 | 批次档 §3/§4/§5/§6 | §3 ✅（代写打标）· §4 ✅ · §5 ⛔ 待实现 · §6 ✅ |

### 6.3 核销同步清单（D7 变更留痕 + 核销同步）

| 项 | 核销结果 |
|---|---|
| 角色表（§1 谁写哪段） | §1 主 agent / §2 eng-designer / §3 **主 agent 代写并打标**（评审通道故障）/ §4 主 agent / §5 未写 / §6 主 agent |
| 状态行 | §6.1 已更新；`docs/VERIFY.md §0` 已标注"无任何可执行产物" |
| 计数 | 配置键 **17**（原写 18，open-4 更正，已同步批次档 §1.3 / DESIGN §1.3 / PROTOCOL §9.11）；缺陷 **31** 条（2 P0 + 11 P1 + 18 P2）；用例 42 条（T-U1–T-U31 + T-I1–T-I11）；A 场景 **A1–A20** |
| 指针 | 修正轮后指针已核对：`REVIEW-1` → `DESIGN.md §2.4.6/§2.10.1/§2.10.2/§2.5 D17,D18`；`open-2` → `PROTOCOL.md §10.1` |
| 变更记录 | `DESIGN.md §四` 已补修正轮一行；本档 §3/§4/§6 本日写入 |
| 待办勾销 | **不勾销**：T3（骨架）/T4（测试证据）/T5（报告+token consume）中，T5 报告已交付、**链终 token consume 未执行**（无 token 可消费） |

### 6.4 移交 Round 2 / 待对接方裁决

1. **门禁继续方式**（`ROUND-1-REPORT.md §六.1`，最高优先）：修机制后重跑评审 / 显式授权无 token 实现 / 并入 Round 2。
2. 骨架 + 测试 + `package.json` 等 D4–D6 产物：待门禁解除后按 §2 任务书施工（设计已冻结，接口契约见 `DESIGN.md §2.3.3`）。
3. `docs/CONSULT-1.md`（多模型独立复核）：会诊仍在运行；结论返回后追加，并在 §3.2 更新（**未返回即视为未完成，不得当作通过**）。
4. 本轮**未做**：`node --test`、`node --check`、mock 集成 —— 全部因无代码而无法执行（`ROUND-1-REPORT.md §2.4`）。

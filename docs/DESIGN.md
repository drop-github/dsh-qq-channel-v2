# dsh-qq-channel v2.0.0 设计档（DESIGN）

- 批次：`round-1-design-skeleton`（Round 1 = 设计 + 可运行骨架 + 单测；QQ 网关业务主体留 Round 2）
- 定位：本文档是 v2.0.0 的**唯一设计权威**；协议事实见 `docs/PROTOCOL.md`（每条带宿主源码 `file:line`）。
- 读者：实现方（按 §设计层施工）、评审（按 §测试层与 §P0/P1/P2 处置表逐条核对）、对接方。
- 与 v1.2.4 的关系：v1 只作为**协议事实来源**与**缺陷清单来源**（`E:\DSHWorkspace\dsh-qq-channel\lib\index.js`，只读，实测 2234 行）；v2 从零重写，不继承其结构。

---

# 一、需求层

## 1.1 总体需求

为 DSH 用户提供一条"在手机上用 QQ 驱动机器人 agent"的通道插件。v1.2.4 能跑，但会在三类场景下**静默失效**
（表现为"不回复""回复消失""审批点了没用"），且失败不可观测。v2 必须让这三类失效在**结构上**不可能发生：

1. **认证竞态**：启动瞬间 cookie 未就绪导致此后所有 RPC 永久失败；
2. **事件漏推**：用"尾部窗口轮询"模拟事件流，漏一个 `turn/end` 即该会话永久哑掉；
3. **审批身份错配**：把 mux 的 `eventId` 当作宿主审批身份，导致"电脑端已处理"永远无法回补通知。

交付形态：模块化、单文件 ≤400 行、ESM、零构建、凭据卫生、失败路径闭环；本轮交付设计与**可运行骨架**。

## 1.2 功能性需求（F1–F10，逐条可验收，含范围边界）

| # | 用户故事 | 本轮交付深度 | 范围边界（明确不做什么） |
|---|---|---|---|
| F1 | 作为插件使用者，我要插件在 DSH ≥0.1.5（typert）与 ≤0.1.1（旧）上都能工作 | 探测 + 双协议映射**骨架完整可跑**；探测三态（v2 / v1 / 协议事实不符） | 不实现旧宿主的其它 API；不猜测未核证的旧协议字段 |
| F2 | 作为使用者，我要 `/api` 请求在 401 时自动重取 cookie 并重试一次 | 骨架 + mock 断言 | 不实现无限重试；不做 cookie 持久化 |
| F3 | 作为使用者，我要"发送/应答/回传"的成败**明确可见** | 统一结果类型 + await + 结构化日志 | 不做重试队列（Round 2 发件箱负责） |
| F4 | 作为使用者，我要会话事件流 gap-free（不丢 `turn/end`、不哑会话） | 主源 `follow` + `page` 补页 + 基线 + **事件白名单（白名单外静默，§2.4.6）** + 单会话隔离 + 退避 | 不保证"跨进程重启后的事件连续性"（那是宿主职责） |
| F5 | 作为使用者，我要 prompt 幂等（重试不重复执行） | `requestId` 调用点铸造一次 | 不做客户端侧消息去重表 |
| F6 | 作为使用者，我要审批/提问可答，且"电脑端已处理"能回补通知 | 条目模型（`eventId`/`auditId` 分离）+ cancel 结清（状态层） | **QQ 键盘渲染与交互入口留 Round 2** |
| F7 | 作为使用者，我要高权限交互默认安全 | 审批独立开关（默认安全）+ 操作者校验**契约** | 操作者校验的 QQ 载荷解析留 Round 2 |
| F8 | 作为使用者，我要结构化、可读、不泄密的日志 | 日志模块骨架（事件名 + id 前缀 + 结果 + code；≤240 字符；限流） | 不做日志轮转/聚合 |
| F9 | 作为使用者，我要 dispose 后彻底静默 | 生命周期骨架 + mock 断言 | 不做进程级守护 |
| F10 | 作为插件作者，我要单文件 ≤400 行、ESM、零构建、依赖仅 `ws` + `schemastery` | 骨架遵守 | 不引入任何其它运行时依赖 |

## 1.3 非功能性需求（N1–N8，含度量方式）

| # | 标准 | 度量方式（可机判） |
|---|---|---|
| N1 | 凭据卫生 | 全仓 `*.js`/`*.md`/`*.json` 无真实 secret；日志/错误只允许长度或 sha256 前 8 位；A2 断言 |
| N2 | 失败可见 | 静态检查：无空 `catch {}`；所有"发送/回传"调用点 `await` 结果并据此改状态 |
| N3 | 模块边界 | 每 `.js` ≤400 行；`lib/qq/` 预留（本轮 = 端口契约 + 空实现） |
| N4 | 依赖面 | `dependencies` 恰为 `ws@8.21.3` + `@deepseek-ai/schemastery@3.18.2`；`peerDependencies` 含 cordis + dsh-settings |
| N5 | 可测 | `node --test` 全绿、不联网、不碰 3080、不读真实配置；含纯逻辑单测 + mock 集成测试 |
| N6 | 语法 | 全部 `.js` 通过 `node --check` |
| N7 | 配置兼容 | **17** 个配置键与 v1.2.4 逐字一致（清单见 `PROTOCOL.md §9.13`）；`appId` 接受 string\|number；设置注册新/旧双兼容 |
| N8 | 文档可读 | 文档无 >300 字符单行；表格/列表/标题正常分隔 |

> **N7 计数更正（重要）**：任务书 §4 / 裁决 §4 写"18 个配置键"，但裁决/任务书自己列的清单与 v1.2.4 `Config` 实测都只有 **17 个**；
> 批次档 §1.3 已由主 agent 按对接方 open-4 裁定更正为 **17**（本角色不改 §1）。计数与列表必须同时改（计数纪律），否则该条无法机判。
> 本档以 **17** 为准，并已记入 `PROTOCOL.md §9.11` / §9.13。

---

# 二、设计层

## 2.1 方案选型对比

### 表 A：会话事件源（判据来自 §1.2 F4 / §1.3 N5）

| # | 候选方案 | 判据逐项评估 | 取舍（选定代价/权衡） | 结论 |
|---|---|---|---|---|
| A | **`session/follow` 主源 + `session/page` 补页/对账** | gap-free（宿主自述 `history.js:137`）；开帧即给权威 `cursor` 与回看窗口；`page` 的 `throughSeq` 文案就是要配 follow 用（`types.d.ts:411`） | 需要两个载体（control 流 + 每会话 follow 流）+ 自己写缺口对账；单会话一个 WS 逻辑流 | **选定** |
| B | 纯轮询尾部窗口（v1.2.4 做法） | `paginate` 是**消息对齐的向回扫窗口**，装不下的中间事件永不出现；`lastSeq` 照推 → 丢 `turn/end` 即会话永久哑掉（P1-3 实测） | 实现最省，但结构性丢事件 | 否决：**不满足 F4**，且正是被审查判为 P0 级失效模式 |
| C | 纯 `follow` 事件帧（不实现补页） | 实时性好；但宿主对 seq 不连续**直接抛错终止流**（`history.js:243-248`），重连后必有缺口；无对账手段 | 代码最少；一旦断线即永久缺事件 | 否决：**不满足 F4**，且验收台 A5/A12 的窗口场景无兜底 |

### 表 B：模块划分与状态归属（判据来自 §1.3 N3 / R2 / R8）

| # | 候选方案 | 判据逐项评估 | 取舍 | 结论 |
|---|---|---|---|---|
| A | **分层 + 端口：协议层（transport/auth/mux/v1/v2）/ 会话层（events/state/pending）/ 出站端口（qq）** | 每层可独立单测；QQ 与 DSH 两侧解耦 → 本轮无 QQ 也能验证会话层；单文件易守 400 行 | 需要显式定义层间接口契约（多写一档） | **选定** |
| B | 每会话独立 actor（各持自己的 socket/游标/定时器） | 隔离性最好；但一个会话一个 WS 逻辑流或一个 socket，资源随会话线性增长；dispose 面分散 | 隔离收益被"每条 follow 流本就按会话隔离"覆盖 | 否决：**复杂度换不来收益**，且 R8 的资源边界更难守 |
| C | 单文件集中式（v1.2.4 做法） | 无跨文件成本；但 2234 行 → N3 直接违规，且被审查判定为根因之一 | — | 否决：**违反 N3** |

### 表 C：审批 `eventId` ↔ 宿主 `auditId` 的关联策略（判据来自 §1.2 F6 / R5）

| # | 候选方案 | 判据逐项评估 | 取舍 | 结论 |
|---|---|---|---|---|
| A | **开 `session/follow` 取审计事件，按 `(sessionId, toolName, callId?, reason?)` 双向配对** | 唯一有协议证据的路径（审计事件只在会话日志里，`dsh-api-remotes` 白名单不含它们） | 每受管会话多一条流；配对需容忍到达乱序 | **选定** |
| B | 仅凭 `allowedUsers`/会话单信任域，把"同会话最旧的 pending"当作被决定项 | 零额外流；但并发两个审批时必然错配 | 会重新引入 P1-6 的错配类别 | 否决：**不满足 R5** |
| C | 用 `toolName` 单键匹配 | 简单；同工具名连续两次审批即错配 | — | 否决：错配概率高，且无法与 `callId` 一起校验 |

## 2.2 架构与模块边界

依赖方向**单向**：`index → channel → { session/*, protocol/* } → { log, result } → qq/port`。
`protocol/*` 不感知会话语义；`session/*` 不感知 HTTP/WS；`qq/*` 不感知 DSH。

| 文件 | 职责 | 导出面 | 依赖方向 | 行数预算 |
|---|---|---|---|---|
| `lib/index.js` | Cordis 入口：导出 `name`/`Config`/`inject`/`apply`；组装与生命周期 | `name, Config, inject, apply` | → channel, config, log | ≤120 |
| `lib/channel.js` | 组装根：把各层接起来跑，产出"回复意图"并调用出站端口 | `createChannel(deps)` | → 全部 | ≤160 |
| `lib/config.js` | `Config` schema + 设置注册（新/旧 API 双兼容）+ 配置读取（`setSource` thunk） | `Config, registerSettings(ctx, config, hooks)` | → log | ≤150 |
| `lib/log.js` | 结构化日志、凭据脱敏、限流、文件 sink | `createLog({ctx, dir, debug})` | 无 | ≤150 |
| `lib/result.js` | 统一结果类型与 reason 词表 | `ok, fail, REASONS` | 无 | ≤60 |
| `lib/protocol/auth.js` | browserAuth cookie 获取/刷新（GET + 303 + set-cookie） | `createAuth({ctx, dshUrl, log})` | → result, log | ≤110 |
| `lib/protocol/transport.js` | HTTP RPC（v2/v1 信封）、超时分档、401 重认证 + 重试一次 | `createTransport({auth, dshUrl, log})` | → auth, result, log | ≤200 |
| `lib/protocol/detect.js` | 协议探测三态 | `detectProtocol({transport, log})` | → result | ≤90 |
| `lib/protocol/mux.js` | `remote.mux` 客户端：open/cancel、帧路由、断线重开、dispose | `createMux({dshUrl, auth, log})` | → auth, result, log | ≤220 |
| `lib/protocol/v2.js` | v2 方法映射、`$events` 控制流、`$events/result` | `createV2({transport, mux, log})` | → transport, mux | ≤130 |
| `lib/protocol/v1.js` | v1 方法映射、`/api/respond`、`events.mux` 适配 | `createV1({transport, log})` | → transport | ≤150 |
| `lib/session/events.js` | 事件归一化 + follow 消费 + `page` 缺口补齐 | `createEventPump(deps)` | → state, result, log | ≤260 |
| `lib/session/state.js` | 会话状态机：基线、游标、忙闲、待发队列、回复目标、空闲淘汰 | `createSessionStore({log})` | → result, log | ≤270 |
| `lib/session/pending.js` | 审批/提问条目：`eventId`/`auditId` 分列、cancel 结清、审计配对、TTL | `createPendingStore({log})` | → result, log | ≤200 |
| `lib/qq/port.js` | **出站端口契约** + 空实现（Round 2 填真实适配器） | `createNullPort({log})`, JSDoc 契约 | → result | ≤80 |
| `lib/qq/README.md` | Round 2 落点说明（键盘/交互/文件/发件箱） | — | — | — |

## 2.3 接口契约

### 2.3.1 统一结果类型（`lib/result.js`）

```js
ok(value)                       -> { ok: true, value }
fail(reason, code, message)     -> { ok: false, reason, code?, message }
```

`reason` 词表（**封闭集合**，禁止新增未登记值）：
`'transport' | 'timeout' | 'unauthorized' | 'not-found' | 'protocol-mismatch' | 'rejected' | 'unavailable' | 'no-target' | 'no-session' | 'disposed'`。

`code` 承载宿主/网关的原始 code（如 `gateway/arguments-invalid`），**只用于日志与判别，不参与控制流分支**（控制流看 `reason`）。

### 2.3.2 统一内部事件模型（跨 v1/v2、跨流/页）

```js
{ sessionId, seq, time, type, data, origin: 'snapshot'|'page'|'live', protocol: 'v2'|'v1' }
```

- 映射：v2 follow 的 `SessionEventEntry {type:'event', event}` → 取 `event.{seq,time,type,data}`；
  v2 `page` 的 `records[].event` 同上（`origin:'page'`）；
  v1 `events.mux` 的 `payload.type==='session/event'` → 同上（`protocol:'v1'`）。
- **`sessionId` 一律由"这条流/这一页属于哪个会话"注入**，**不得**读事件体里的 `sessionId`（真实宿主 envelope 无该字段；验收台 mock 有，属 mock 附加物）。

### 2.3.3 模块间签名（实现必须逐字对齐）

```js
// lib/protocol/transport.js
createTransport({ auth, dshUrl, log }) -> {
  rpc(method, args, { timeoutMs, requestId }) -> Promise<Result>,   // 内含 401 重认证 + 重试一次
  dispose()
}

// lib/protocol/mux.js
createMux({ dshUrl, auth, log }) -> {
  open(endpoint, payload, onFrame) -> Promise<{ ok: true, stream } | Failure>,  // stream = { streamId, cancel() }
  onDown(handler),                     // 底层 socket 断 → 通知上层重开逻辑流
  dispose()
}

// lib/session/events.js
createEventPump({ transport, mux, state, onEvent, log }) -> {
  attach(sessionId, { baseline: 'replay-all' | 'skip-history' }) -> Promise<Result>,
  detach(sessionId) -> Result,
  reconcile(sessionId, snapshot) -> Promise<Result>,   // §2.4.3 的缺口补齐
  dispose()
}

// lib/session/state.js
createSessionStore({ log, ttlMs }) -> {
  adopt(sessionId, baseline) -> Result,
  noteReplyTarget(sessionId, target /* {kind:'c2c'|'group', openid} */) -> Result,
  ingest(event) -> Result,          // 按 seq 幂等；驱动 idle/busy 与待发队列
  nextReply(sessionId) -> Result[],  // 待发回复（不含发送）
  snapshot(sessionId) -> { lastSeq, busy, pendingCount, origin },
  sweep(now) -> number,             // 空闲淘汰
  clear()
}

// lib/session/pending.js
createPendingStore({ log, ttlMs, authorize }) -> {
  addFromWaterfall({ eventId, sessionId, kind, request }) -> Result,
  attachAudit({ sessionId, auditId, toolName, callId, reason }) -> Result,
  auditDecided({ auditId, outcome }) -> Result,       // 返回"是否应发通知"
  settleByEventId(eventId, reason) -> Result,
  answerable(eventId, operator) -> Result,            // 关（开关 / 操作者 / 是否已结清）
  get(eventId) -> entry | undefined,
  sweep(now) -> number
}
```

`authorize(operator, entry)` 是**注入点**：Round 1 只提供默认实现（单会话 + 白名单）；
QQ 侧的操作者载荷解析留 Round 2，但**判定点只有这一个**（避免 v1 那种"两处各判一半"）。

### 2.3.4 出站端口契约（`lib/qq/port.js`，Round 2 的接缝）

```js
sendText(target /* {kind:'c2c'|'group', openid} */, text, opts) -> Promise<Result>
sendKeyboard(target, text, keyboard, opts)                       -> Promise<Result>

// opts（出站信封；语义本轮固定，实现落 Round 2）
//   passive?: { msgId: string }  —— 声明"本条回复的是哪条入站消息" → 端口据此走被动回复窗口
//   msgSeq?:  number             —— 缺省 = 由端口分配；显式给值时端口只做唯一性校验
```

- **被动回复模型 = 窗口，不是次数**（D17）：收到消息后 **5 分钟内**，**每条**出站消息都**可以**带 `msgId`；
  "同一 `msg_id` 只有一次被动额度"的旧叙述**作废**（`REVIEW-1 §三 M1`；证据 Hermes `adapter.py:2568-2569`、`:2777-2790`）。
- **`msgSeq` 的分配责任在出站端口**（QQ 线格式细节不下沉到会话层）：端口对同一 `msgId` 分配唯一 `msgSeq` ——
  取值 `0..65535`，**同一 `msgId` 首次发送为 `1`**（A9 core 判定点）、此后单调递增（回绕时不得与已用值重复）；
  契约只保证 **`(msgId, msgSeq)` 不重复**。
- **无目标必须失败**：`fail('no-target', …)` 并记日志（P2-12 的结构性对策）。
- 会话未就绪（无 `sessionId`）→ `fail('no-session', …)`（P2-14）。
- 验收口径：**A9（core）首条带 `msgId`** + **A20（v2 目标）窗口内每条都带 `msgId` 且 `(msgId,msgSeq)` 唯一、`msgSeq` 为整数** ——
  Round 2 落地，**本轮只固定契约**（§3.2 AC12）。

## 2.4 状态机与数据流

### 2.4.1 会话状态机（事件驱动，谁改谁读）

```
idle ──turn/start──▶ busy ──turn/end──▶ idle
  ▲                                        │
  └──────────── 收到 assistant/message 累积 ─┘（仅 busy 期间累积，idle 时清空；白名单与静默规则见 §2.4.6）
```

- **唯一写入者**：`session/state.js` 的 `ingest(event)`。任何其它模块只读 `snapshot()`。
- `busy` 期间到达的用户消息进**待发队列**（有界，超限按"最旧先丢 + 告警"，不静默）。
- `turn/end` → 产出一条"回复意图"（本轮的 `assistant/message` 拼接结果）→ `channel.js` 调出站端口 → **await 结果** → 成功/失败都记日志并按结果改状态。
- 回复目标 `target` 在**收到用户消息时**记录（不依赖后续事件），并在派发后消费一次。

### 2.4.2 审批条目生命周期（`$events` 与审计两条来路）

```
waterfall(approval/request) ─▶ entry{eventId, sessionId, kind:'approval', state:'pending', auditId:null}
approval/asked{id} ──配对──▶ entry.auditId = id                （双向容忍乱序，见下）
用户/桌面应答 ──$events/result──▶ await 结果 ──成功──▶ state:'answered'
                                    └──失败──▶ 保留 pending + 明确告知（P1-5）
cancel 帧 {type:'cancel',eventId} ─▶ state:'cancelled' + 提示失效 + 之后点击被拒（P1-7）
approval/decided{id} ─▶ 按 auditId 找条目；若仍 pending ─▶ state:'decided-elsewhere' + **恰好一条**"已处理"通知
TTL 到期 ─▶ state:'expired'
question: 同构，但**无审计对**（宿主无 asked/decided），只能靠本地状态
```

**乱序容忍**：`approval/asked`（走 follow）与 `waterfall`（走 control 流）是两条独立传输，先后不保证；
因此 `pending.js` 维护一个**短窗口的未配对审计缓存**（按 `sessionId` 分键），两种到达顺序都能配对。
配对键 = `sessionId` + `toolName`，并用 `callId`/`reason`（存在时）做二次校验；同键多条按 FIFO 取最旧。

### 2.4.3 数据流图

```
[browserAuth cookie] ──▶ transport.rpc ──▶ detect（三态）
                                  │
        ┌─────────────────────────┴──────────────────────────┐
        ▼ v2                                                 ▼ v1
  mux: $events 控制流                                mux/WS: events.mux
        │  ready(clientId) / waterfall / cancel / end        │  session/event 帧
        │                                                    │
  mux: 每受管会话一条 session/follow                          │
        │  snapshot(cursor/records/hasMore) → live events     │
        │      └─ 缺口? ─▶ transport: session/page(beforeSeq 前翻补齐)   ◀─┘
        ▼                                                    ▼
                 events.js（归一化为统一内部事件模型）
                                  │
                     ┌────────────┴────────────┐
                     ▼                         ▼
        state.js（状态机/待发/回复目标）   pending.js（审批/提问条目）
                     │                         │
                     └───────────┬─────────────┘
                                 ▼
                   channel.js（回复意图 → 出站端口，await 结果）
                                 ▼
                        qq/port.js（Round 1：空实现；Round 2：真实 QQ）
```

### 2.4.4 缺口补齐判定式（**实现必须逐字照此**）

`PROTOCOL.md §5.3` 已给判定式与循环；本档复述**关键顺序约束**：

1. 新开 follow → 拿到 `snapshot`；
2. `snapshot.cursor < lastSeq` → 异常（宿主重建/日志截断）：记日志 + 重置 `lastSeq = -1` + 全量对账；
3. `earliest > lastSeq + 1` → 走 `session/page`（`throughSeq = snapshot.cursor`，`beforeSeq` 逐页前翻）；
4. **补齐之后**才推进 `lastSeq = snapshot.cursor`，且放行时按 `seq` 升序、跳过 `seq <= lastSeq`（防重放）；
5. 补齐过程中若 `hasMore === false` 仍未覆盖 → 记 `protocol` 级告警并**保留缺口标记**，不得静默推进。

### 2.4.5 基线（P1-2 的结构性对策）

| 会话来源 | 基线 | 理由 |
|---|---|---|
| 本插件新建的会话（per-source 模式） | `lastSeq = -1`（`replay-all`） | 新会话的**初始事件（seed）也要投递**：实测新建会话已自带初始事件、游标常为 `2`（`PROTOCOL.md §5.1`），故**不能**假设"新会话游标 = -1"；非白名单类型由 §2.4.6 静默 |
| 启动时已存在 / 从 `qq-channel-sources.json` 恢复 | 与**首个 `snapshot.cursor`** 对齐（`skip-history`） | 不能把历史当新事件重放给用户（A12） |

**基线时刻 = 会话纳入管理那一刻**（`adopt()`），**不是**"首次拉取成功时"。

### 2.4.6 事件类型 → 处理动作（白名单 = 全部处理面；未知类型静默）

真机一次 prompt 会推 **16 帧**，类型远多于"需要处理的两三种"（实测 2026-09-16，来源 `thincoder-v2-live-verified.md §2`）。
消费侧**只认下表**，其余一律**静默忽略 + debug 计数**——**未知类型不得报错、不得中断流**（M2）。

| 事件类型 | 处理动作 | 依据 |
|---|---|---|
| `turn/start` | 状态机 → `busy`；清空本轮助手文本累积 | §2.4.1 |
| `assistant/message` | **唯一文本来源**：累积为本轮回复正文 | 实测帧清单（`thincoder-v2-live-verified.md §2`） |
| `turn/end` | 状态机 → `idle`；产出"回复意图"交给 `channel.js` | §2.4.1 |
| `approval/asked` | `pending.attachAudit({ sessionId, auditId:id, … })`（与 waterfall 双向配对） | `dsh-user-approval/lib/index.js:134-145` |
| `approval/decided` | `pending.auditDecided({ auditId:id, outcome })` → **恰好一条**"已处理"通知 | `dsh-user-approval/lib/types/types.d.ts:26`、`:48-51` |
| 其余全部（`system/message`、`user/message`、`session/title`、`session/title-llm-request`、`step/start`、`step/end`、`request/header`、`request/context`、`agent/inbox/spliced` …） | **静默忽略**；debug 级按类型名计数 | 实测 16 帧清单（同上） |

- **`user/message` / `system/message` 不得变成回复**——它们只是噪声；回复正文只来自 `assistant/message`。
- 规则是"白名单之外的一切都走同一分支"（**含本档未列出的新类型**），不需要逐个登记新类型。
- 计数可见（R7）：debug 日志按类型名聚合计数，供排障"到底哪些事件被忽略了"。
- **落点**：`lib/session/state.js` 的 `ingest(event)` 首步做白名单判定（命中 → 按状态机处理；未命中 → debug 计数 + 返回 `ok()`）；
  `lib/session/events.js` 只做归一化，不做过滤。

## 2.5 关键决策记录（含被否决备选）

| # | 决策 | 理由 | 被否决的备选 |
|---|---|---|---|
| D1 | `follow` 主源 + `page` 补页/对账 | 表 A | 纯轮询（丢事件）；纯 follow（断线后无兜底） |
| D2 | 分层 + 端口（表 B） | 可测性 + 400 行约束 + QQ/DSH 解耦 | 每会话 actor；单文件 |
| D3 | 基线绑定"纳入管理时刻" | P1-2 根因 | 首次拉取成功时定基线（会吞掉首轮） |
| D4 | 审计事件只能经 `session/follow` 取 → 每受管会话必开一条 follow | 审计事件不在 `$events` 白名单 | 只开 control 流（"已处理"永远配不出来） |
| D5 | `eventId` 与 `auditId` **分列存储**，配对靠短窗口双向缓存 | 两者无协议关联字段 + 两条传输乱序 | 单字段复用（P1-6）；只按 toolName 匹配（表 C） |
| D6 | `requestId` 在**调用点铸造一次**，映射函数只包装 | P1-10；宿主按 `requestId` 去重 | 在映射函数里 `randomUUID()`（重试即换 id） |
| D7 | 硬超时**按方法分档**：`session/prompt` 60s，其余 15s | P2-7 | 统一 15s（冷会话把"已接受"变硬失败） |
| D8 | 统一结果类型 `{ok, reason, code?}` + 禁空 catch | R2；失败必须可分支可观测 | 抛异常穿透（调用点必须 try，易被吞） |
| D9 | 脱敏**单一入口**（`log.js`），任何调用点不得自行拼接 secret | R1；P0-1 的全文件唯一泄漏点 | 各调用点自觉（P0-1 的成因） |
| D10 | **`session/prompt` 必须显式传 `mode:'queue'`** | 宿主 schema 必填且只认 `'queue'\|'steer'`（`PROTOCOL.md §9.2`） | 省略 `mode`（→ `gateway/input-invalid`）；传 `'steer'`（会插队，语义不符） |
| D11 | 协议探测三态：`v2` / `v1` / **`protocol-mismatch`** | A1；`gateway/arguments-invalid` 说明"是 v2 但 args 键不符"，属**事实不符**，不得回退 v1 | 两态（v2/v1，错判后回落到不存在的 v1 → 整条通道死） |
| D12 | 未知方法按**状态码**判（404）+ 兼容 mock 的 `gateway/unknown-method` | `PROTOCOL.md §9.3/§9.4` | 只认 `error.code`（真实宿主 404 无 code） |
| D13 | 空闲淘汰：会话/条目 TTL（`ttlMs`），`sweep()` 定时驱动 | R8；P2-11 | 永不收缩（每会话一条永久流） |
| D14 | 生命周期统一 `ctx.effect` 注册 disposer；`dispose()` 幂等 | A10；R8 | 各自 `clearInterval`（P2-13 的成因） |
| D15 | 设置读取走 `setSource` 给的 thunk，**但启动不依赖 `onChange`** | 验收台 `installSection` 只调 `setSource`、**不调** `onChange`（`fake-ctx.mjs:12-17`） | 只在 `onChange` 里启动（在验收台上永不启动） |
| D16 | 层间不传递原始帧，只传 §2.3.2 的统一事件模型 | 双协议同源；v1/v2 差异收在 `protocol/*` | 让会话层直接认 v2 帧（v1 分支要写两遍） |
| D17 | **被动回复是"窗口"不是"次数"**：窗口内每条出站消息都带 `msgId`，`msgSeq` 由出站端口分配并保证 `(msgId,msgSeq)` 唯一 | QQ 的 `msg_seq` 就是为"同一 `msg_id` 多条回复"设计的：Hermes 每次发送都带 `msg_seq`、`reply_to` 存在即带 `msg_id`，且无"已用额度"记录 | v1 的 `usedPassiveMsgIds`（`REVIEW-1 §三 M1` 判为错误前提）；"ack 只带一次 msgId"（P2-3 原建议，同一前提） |
| D18 | 事件消费**白名单制**：只处理 §2.4.6 的 5 类，其余静默 + debug 计数 | 真机一次 prompt 推 16 帧；未知类型报错会中断整条事件流（F4 的反面）；`assistant/message` 是唯一文本来源 | 逐类型 `switch` 且未匹配即告警（遇到新类型就断流）；把 `user/message` 也当文本来源（会把用户自己的话回贴给用户） |

**D17 证据（逐行核）**：Hermes `adapter.py:2777-2790`（`_build_text_body` 每条都带 `msg_seq`）、
`:2568-2569` / `:2590-2591` / `:2969-2970`（`reply_to` 存在即设 `body["msg_id"]`）、`:944-949`（`_next_msg_seq` = `0..65535`）；
全仓无 `usedPassiveMsgIds` 类记录。"只用一次"的旧假设会白耗主动配额（v1 `:634` `useMsgId = i === 0 && …`）。

**D18 证据**：真机一次 prompt 推 16 帧（`thincoder-v2-live-verified.md §2`）；白名单与静默规则见 §2.4.6。

## 2.6 受影响文件全清单（当前行数 / 预计增量）

> 本轮 `E:\DSHWorkspace\dsh-qq-channel-v2` 除批次档外为空 → 下列**全部为新建（当前 0 行）**。
> 修正轮（REVIEW-1）影响：M2 的事件白名单落在 `lib/session/state.js::ingest` 首步（一行查表 + 默认分支），**不新增文件、不调预算**；
> M3/M4 属 Round 2（§2.10），本轮不实现。

| 文件 | 当前 | 预计 | 上限 | 责任 |
|---|---|---|---|---|
| `package.json` | 0 | 45 | — | eng-coder |
| `cordis.patch.yml` | 0 | 12 | — | eng-coder |
| `.gitignore` | 0 | 18 | — | eng-coder |
| `README.md` | 0 | 90 | — | eng-coder |
| `lib/index.js` | 0 | 120 | 400 | eng-coder |
| `lib/channel.js` | 0 | 160 | 400 | eng-coder |
| `lib/config.js` | 0 | 150 | 400 | eng-coder |
| `lib/log.js` | 0 | 150 | 400 | eng-coder |
| `lib/result.js` | 0 | 60 | 400 | eng-coder |
| `lib/protocol/auth.js` | 0 | 110 | 400 | eng-coder |
| `lib/protocol/transport.js` | 0 | 200 | 400 | eng-coder |
| `lib/protocol/detect.js` | 0 | 90 | 400 | eng-coder |
| `lib/protocol/mux.js` | 0 | 220 | 400 | eng-coder |
| `lib/protocol/v2.js` | 0 | 130 | 400 | eng-coder |
| `lib/protocol/v1.js` | 0 | 150 | 400 | eng-coder |
| `lib/session/events.js` | 0 | 260 | 400 | eng-coder |
| `lib/session/state.js` | 0 | 270 | 400 | eng-coder |
| `lib/session/pending.js` | 0 | 200 | 400 | eng-coder |
| `lib/qq/port.js` | 0 | 80 | 400 | eng-coder |
| `lib/qq/README.md` | 0 | 40 | — | eng-coder |
| `test/helpers/fake-ctx.mjs` | 0 | 60 | 400 | eng-coder（复制自验收台，**不改原件**） |
| `test/helpers/mock-dsh.mjs` | 0 | 300 | 400 | eng-coder（复制，加 provenance 头） |
| `test/helpers/qq-port-stub.mjs` | 0 | 90 | 400 | eng-coder |
| `test/result.test.js` · `log.test.js` · `config.test.js` | 0 | 90·120·140 | 400 | eng-coder |
| `test/protocol.test.js` | 0 | 220 | 400 | eng-coder |
| `test/session.test.js` | 0 | 240 | 400 | eng-coder |
| `test/pending.test.js` | 0 | 190 | 400 | eng-coder |
| `test/integration.test.js` | 0 | 300 | 400 | eng-coder |
| `docs/VERIFY.md` | 0 | 90 | — | eng-coder |

预计总量：`lib/` ≈ 2300 行 / 19 文件；`test/` ≈ 1750 行 / 10 文件。

## 2.7 硬要求 R1–R10 对策落点

| # | 要求 | 设计落点 |
|---|---|---|
| R1 | 凭据卫生 | `lib/log.js` 单一脱敏入口（D9）；错误信息与日志都经它；A2 断言 |
| R2 | 失败必须可见 | `lib/result.js` 统一结果类型（D8）；`channel.js` 所有发送 `await` 结果；无空 catch（N2 静态检查） |
| R3 | 事件 gap-free | `session/follow` 主源 + `page` 补页 + 基线（§2.4.4/§2.4.5）+ 单会话隔离 + 退避 |
| R4 | 幂等 | `requestId` 调用点铸造（D6）；`ingest` 按 `seq` 幂等；条目状态机拒绝二次应答 |
| R5 | 身份分离 | `eventId`/`auditId` 分列（D5）+ cancel 结清 + 无 `eventId` 帧拒绝并记日志 |
| R6 | 权限 | 审批独立开关（默认安全）+ `authorize` 单点判定（§2.3.3）+ README 写明"单会话 = 单一信任域" |
| R7 | 可观测 | 结构化日志（事件名 + id 前缀 + 结果 + code）、≤240 字符、高频限流、debug 开关 |
| R8 | 资源边界 | 待发队列有界 + 空闲淘汰（D13）+ `ctx.effect` 统一清理（D14） |
| R9 | 兼容 | 双协议 + 探测三态（D11/D12）+ 配置键逐字兼容（17 键）+ 安装方式不变 |
| R10 | 可测 | 纯逻辑单测 + mock 集成台（复制改造 `qq-channel-verify`，不改原件） |

## 2.8 P0/P1/P2 处置表（逐条）

### P0

| 编号 | 现状根因 | v2 对策（设计档节号） | 状态 |
|---|---|---|---|
| P0-1 | launch token 明文写日志（v1 `:221`） | §2.5 D9 + §2.2 `lib/log.js`：脱敏单一入口，只允许长度/sha256 前 8 位 | 设计层消除 |
| P0-2 | cookie 只取一次 + 探测吞 401（v1 `:198-311`） | §2.3.3 `auth.js` 单一持有者 + `transport.js` 401 统一重认证重试一次 + `detect.js` 三态不吞错（D11） | 设计层消除 |

### P1

| 编号 | 现状根因 | v2 对策 | 状态 |
|---|---|---|---|
| P1-1 | 靠正则解析宿主英文错误文案学游标；空日志 `-1` 解析不出（v1 `:1313-1355`） | v2 **不再"学游标"**：游标来自 `snapshot.cursor`；`-1` 显式处理；缺口靠 `beforeSeq` 前翻，不用文案解析（§2.4.4） | 已消除 |
| P1-2 | 基线在"首次轮询成功"时建立（v1 `:1356-1364`） | §2.4.5 基线绑定 `adopt()` 时刻 | 已消除 |
| P1-3 | 尾部窗口丢事件且不回补（v1 `:1366-1381`） | §2.4.4 缺口检测 + `page` 补页 + follow 主源 | 已消除 |
| P1-4 | 单会话异常中止整轮（v1 `:1330-1345`） | `events.js` 每会话独立 try/catch + 递减频率退避 | 已消除 |
| P1-5 | 回执先于送达、失败也结清（v1 `:883-929`） | D8 + `pending.js`：`await` 成功才结清，失败保留条目并明确告知 | 已消除 |
| P1-6 | `eventId` 当审批身份（v1 `:1240` 等） | D5 + §2.4.2 审计配对（经 follow） | 已消除 |
| P1-7 | `cancel` 帧被忽略（v1 `:1209-1278`） | §2.4.2 `cancelled` 分支 + 结清 + 提示失效 | 已消除 |
| P1-8 | 无 `eventId` 时 `set(undefined,…)` 毒化整表（v1 `:1221-1222`） | `addFromWaterfall` 前置校验：无 `eventId` → `fail('rejected')` + 记日志，不写表 | 已消除 |
| P1-9 | 单会话模式任意人可代答（v1 `:862-868`） | R6：审批独立开关（默认安全）+ `authorize` 单点；README 写明单会话=单一信任域 | 设计层消除；QQ 载荷解析留 Round 2 |
| P1-10 | `requestId` 在映射函数里重铸（v1 `:240`/`:307`） | D6 调用点铸造一次 | 已消除 |
| P1-11 | 发件箱可重入 + 无大小上限（v1 `:1664-1769`） | 端口契约预留（单飞集合 + `statSync` 上限）；**文件链整体留 Round 2** | 遗留 Round 2（有设计落点） |

### P2

| 编号 | 现状根因 | v2 对策 | 状态 |
|---|---|---|---|
| P2-1 | 截断提示死代码（先 slice 再判长度） | Round 2 发送层：先记 `total` 再 slice | 遗留 Round 2 |
| P2-2 | 死代码：`recallMessage` 无调用、`pendingRemoteEvents` 只写不读 | v2 不引入无调用点的代码；撤回要么接回要么不写 | 已消除（设计约束） |
| P2-3 | ack 未传 `msgId`，白耗主动额度 | **纠正前提**：被动回复是窗口不是次数 —— Round 2 发送层按 D17：窗口内**每条**都带 `msgId` 且 `(msgId,msgSeq)` 唯一（§2.3.4） | 设计已固定（A9 core / A20 v2 目标），Round 2 落地 |
| P2-4 | `chunkText` 按 UTF-16 码元切分，emoji 被切碎 | Round 2：按码点切（`Array.from`） | 遗留 Round 2 |
| P2-5 | 去重集合超限时**整表清空** | Round 2：有界 Map + 按插入序淘汰 | 遗留 Round 2 |
| P2-6 | `md5_10m` 用 `10002432` | **已裁决**（`PROTOCOL.md §10.1`）：`10_002_432` 正确（Hermes `chunked_upload.py:66-67`）；实现用具名常量 + 出处注释；小于该长度时 `md5_10m` = 全文件 md5（同文件 `:585-586`） | 遗留 Round 2（数值已定） |
| P2-7 | 15s 超时套在 `prompt` 上 | D7 超时分档 | 已消除 |
| P2-8 | v1 `respondRpc` 不带 cookie | `v1.js` 统一带 cookie | 已消除 |
| P2-9 | "no usable protocol" 掩盖真实原因 | D8/D11：结果类型带 `reason`/`code`，探测三态各记一条日志 | 已消除 |
| P2-10 | args 键名与宿主强耦合 | `PROTOCOL.md §1.4` 记录耦合；`arguments-invalid` 单独成态并告警（D11） | 已消除 |
| P2-11 | per-source 会话/游标永不收缩 | D13 空闲淘汰（TTL + `sweep()`） | 已消除 |
| P2-12 | `sendText` 无目标静默 return false | §2.3.4 端口契约：`fail('no-target')` + 告警 | 已消除 |
| P2-13 | `onclose` 竞态 + 心跳不在 `finally` 清理 | Round 2 QQ 网关模块：`onopen` 同时挂 `onclose` + `readyState` 兜底；清理放 `finally` | 遗留 Round 2（QQ 客户端） |
| P2-14 | 目标会话为空仍发 prompt | §2.3.4 `fail('no-session')` + 明确提示 | 已消除 |
| P2-15 | 合并轮次失败丢消息 | `state.js` 待发队列**不 splice 丢**：失败归还并记日志 | 已消除 |
| P2-16 | 附件下载把 bot token 发给任意 URL | Round 2 文件链：只对预期域名带 Authorization | 遗留 Round 2 |
| P2-17 | image 块附额外字段（strict codec 是否容忍未验证） | **定论**（`PROTOCOL.md §10.6`）：额外键被**容忍但剥离** = 等于没传 → image 块**不得**带额外字段（路径走 text part）；退化图片必须有**文本兜底** | 已消除（设计约束 + 文本兜底） |
| P2-18 | `mode:'queue'` 被判为"猜的" | **反转**：`mode` 是宿主必填字段，`'queue'` 合法且行为 = followup（D10 / `PROTOCOL.md §9.2`） | 已消除（纠正认知） |

## 2.9 与既有纪律 / N1–N8 的冲突点核对

| 潜在冲突 | 核对结论 |
|---|---|
| 单文件 ≤400 行（N3）vs `state.js`/`events.js` 的职责量 | 预算 270/260，留 130/140 行余量；若超，按"纯函数抽到 `lib/session/*` 子模块"拆，不在原文件里堆 |
| 依赖面仅 `ws` + `schemastery`（N4）vs 需要 WebSocket 客户端 | DSH 侧用 `ws`；QQ 侧若也用 `ws` 则同一依赖（Round 2 确认） |
| 零构建（N4）vs 需要 `package.json` 的 `type: module` | 无冲突：纯 ESM，无转译 |
| 验收台只给五个 ctx 面 vs 插件可能需要 `ctx.on` | 设计**不使用** `ctx.on`（`fake-ctx.mjs` 虽提供但不在声明的五面内）；`inject: []`（与 v1 一致） |
| 设置注册新/旧双兼容 vs 本机只有新 API | 保留旧 API 防御分支，形态标"未验证"（`PROTOCOL.md §10.2`） |
| 任务书"不写 QQ 网关"vs 验收台 `boot()` 需 QQ IDENTIFY | **见 §五 边界与 open-1**：本轮不实现 QQ 网络层，代价与替代方案已显式列出 |

## 2.10 Round 2 落点（本轮只固定设计，不实现）

### 2.10.1 键盘按钮（A16 判定点）

Round 2 渲染层发出的每个回调按钮**必须同时**具备下列字段（缺一即 A16 失败，`run-scenarios.mjs:352-370`）：

| 字段 | 值 | 作用 | 证据 |
|---|---|---|---|
| `action.type` | `1` | 回调型（触发 `INTERACTION_CREATE`） | Hermes `keyboards.py:199` |
| `action.data` | `approve:<handle>:<outcome>` | 回调载荷（读取方**锚定正则**解析） | Hermes `keyboards.py:47-52`；v1 `:778`、`:845` |
| `action.permission.type` | `2` | "所有人可点"—— **不是权限**，不提供任何防重复能力 | Hermes `keyboards.py:59-63` |
| `action.click_limit` | `1` | 平台级"点过即灰"（体验增强） | Hermes `keyboards.py:75`、`:82`、`:88-89` |
| `render_data.visited_label` | 非空 | 点后文案（按钮原地置灰） | Hermes `keyboards.py:98-109` |

- 🔴 **服务端校验仍是唯一防线**：`click_limit` 只是体验增强，**不得**写成"靠按钮防重复"——
  重复点击的拦截靠 `pending.answerable()` 的状态判定（R6/P1-9）+ 回传后结清；A16 只验按钮字段，防重复的判定点是 A6。

### 2.10.2 文件链（A17 判定点）

1. **`upload_part_finish` 必须带 `upload_id`**（现役 v1.2.4 已正确：`:1940-1945`，别退步）；错误码语义：
   `40093001` = 瞬时可重试（按服务端给的 retry timeout 重试到上限）、`40093002` = 当日累计限额 = **永久失败**
   （进 `failed/` 并给用户可读文案）—— Hermes `chunked_upload.py:18-22`、`:50-51`、`:454-459`。
2. **上传前 `statSync` 大小上限 + 分片读取**，不许整文件进内存（v1 `:1903` 的 `fs.readFileSync` 是反例）；
   哈希单遍流式，`md5_10m` 只吃前 `_MD5_10M_SIZE` 字节 —— Hermes `chunked_upload.py:548-550`、`:559-586`。
3. **附件下载只对预期域名带 `Authorization`**：QQ 给的 URL 不能无条件附带 bot token（P2-16 的结构性对策；
   v1 `:1805-1808`/`:1840-1843` 是无条件带头的反例）。

---

# 三、测试层

## 3.1 用例表（正常 / 边界 / 错误；每条需求 ≥1 用例）

层级：`U` = 纯逻辑单测；`I` = mock 集成（`test/helpers/mock-dsh.mjs` + 端口桩）。

| # | 层级 | 覆盖需求 | 类型 | 输入 | 预期输出 |
|---|---|---|---|---|---|
| T-U1 | U | F1, R9 | 正常 | 探测：`session/list` 返回 `{items:[…]}` | 结果 `'v2'` |
| T-U2 | U | F1, R9 | 边界 | v2 探测 404，v1 探测成功 | 结果 `'v1'` |
| T-U3 | U | F1, R9, D11 | 错误 | v2 探测返回 `gateway/arguments-invalid` | 结果 `'protocol-mismatch'`，**不回退 v1**，记一条告警 |
| T-U4 | U | F1, R9 | 错误 | 两协议都失败 | 结果 `fail('protocol-mismatch')`，带两次探测的 `code`/`message` |
| T-U5 | U | F3, R2 | 错误 | HTTP 401 / 404 / 200+`result.ok=false` | 分别 → `reason='unauthorized'` / `'not-found'` / `'rejected'`+`code` |
| T-U6 | U | F1, F5 | 正常 | v2 映射 5 个方法 | args 键恰为 `_request` / `request`（逐方法断言） |
| T-U7 | U | F5, R4 | 边界 | 同一逻辑调用触发 401 重试 | 两次报文 `request.requestId` **完全相同** |
| T-U8 | U | F3, R2 | 边界 | 方法为 `session/prompt` vs 其他 | 超时预算分别 60000 / 15000 |
| T-U9 | U | F8, R1, N1 | 正常 | 日志含 token 字样 | 输出只含长度或 sha256 前 8 位，**不含原文** |
| T-U10 | U | F8, R7 | 边界 | 单条 >240 字符 / 高频重复 | 被截断；高频被限流且计数可见 |
| T-U11 | U | F4 | 正常 | 新会话 `adopt('replay-all')` | `lastSeq = -1`，全部事件投递 |
| T-U12 | U | F4 | 正常 | 既有会话 `adopt('skip-history')` | 基线与首个 `snapshot.cursor` 对齐，`records` 不投递 |
| T-U13 | U | F4, R4 | 边界 | 同一 `seq` 事件重复投递 | 第二次被忽略（幂等） |
| T-U14 | U | F4, R3 | 正常 | `lastSeq=9`、`snapshot.cursor=100`、`records` 最早 `seq=40` | 触发补页；`beforeSeq=40` 再取；覆盖到 10 后按序放行 10..100，再推进 `lastSeq=100` |
| T-U15 | U | F4 | 边界 | 空日志 `cursor = -1` | 不补页、不报错、`lastSeq` 保持基线 |
| T-U16 | U | F4, R2 | 错误 | `page` 返回 `gateway/bad-request` / `past cursor` | 记为异常路径，不进入无限重试；记 `code` |
| T-U17 | U | F4 | 错误 | 会话 A 的 `page` 抛错 | 会话 B 仍正常处理（隔离） |
| T-U18 | U | F4, R8 | 边界 | 会话连续失败 | 退避间隔递增；恢复后重置 |
| T-U19 | U | F4 | 正常 | `turn/start` → `assistant/message` → `turn/end` | `busy`→累积→`idle`，产出 1 条回复意图 |
| T-U20 | U | F4 | 边界 | `busy` 期间再来 20 条用户消息 | 进待发队列（有界，超限丢最旧 + 告警） |
| T-U21 | U | F6, R5 | 正常 | `approval/asked{id}` 与 waterfall（两种到达顺序） | 都成功配对：`entry.auditId === id` |
| T-U22 | U | F6, R5 | 错误 | 无 `eventId` 的 waterfall 帧 | `fail('rejected')`，记日志，**不写表**（后续审批不受影响） |
| T-U23 | U | F6, R5 | 正常 | `approval/decided{auditId}` 命中 pending 条目 | 返回"应发通知"，**恰好一次**（重复 decided 不再发） |
| T-U24 | U | F6, R5 | 正常 | `{type:'cancel',eventId}` | 条目结清为 `cancelled`，之后 `answerable()` 拒绝 |
| T-U25 | U | F3, R2 | 错误 | `$events/result` 返回 `ok:true` 但本地标记未知 `eventId` | 记明确日志（**不能**因为返回 ok 就认为送达） |
| T-U26 | U | F3 | 错误 | 回传失败 | 条目**保留** pending + 明确告知，不结清 |
| T-U27 | U | F6 | 边界 | 条目超过 TTL | `expired`，之后点击被拒 |
| T-U28 | U | F7, R6 | 边界 | 审批开关关闭 / 操作者不在白名单 | `authorize` 拒绝，条目保持不变 |
| T-U29 | U | F3, R2 | 错误 | 出站端口无目标 / 无会话 | `fail('no-target')` / `fail('no-session')` + 告警 |
| T-U30 | U | F9, R8 | 边界 | 队列失败后归还 | 消息不丢（P2-15） |
| T-U31 | U | F4, R2, D18 | 错误 | follow 推来全部白名单外类型（`user/message`、`system/message`、`session/title`…）外加一个从未见过的类型 | 全部静默忽略（debug 计数按类型名 +1）；**不报错、不中断流**；不产出任何回复（`assistant/message` 仍是唯一文本来源） |
| T-I1 | I | F1, A1 | 正常 | 起动 → 首次 RPC | 探测报文 args 键恰 `_request`；控制流已开；**未触碰** `events.mux`；v2 事件通道已建立 |
| T-I2 | I | N1, A2 | 正常 | 完整起动 + 一条入站消息 | stdout/stderr 与 `$DSH_HOME/storages/*.log` 均**不含** launch token |
| T-I3 | I | F2, A3 | 错误 | 首个 `/api` 强制 401 | 自动重取 cookie → 重试成功 |
| T-I4 | I | F5, A13 | 错误 | 首个 `session/prompt` 强制 401 | 重试报文 `requestId` 相同；mock 侧只接受 1 条 prompt |
| T-I5 | I | F1, F5, A4 | 正常 | 入站消息 → prompt | args 键恰 `request`，含客户端铸造的 `requestId`，`mode:'queue'` |
| T-I6 | I | F4, A5 | 边界 | `turn/start`+`assistant/message`+`turn/end` 后灌 60 条垫底 | 回复意图**仍产出**且内容不含 `pad-` |
| T-I7 | I | F4, A12 | 边界 | 100 条历史垫底 → 新消息 → 新轮次 | 历史不产生任何回复；新轮次**恰好 1 条**回复 |
| T-I8 | I | F4, A11 | 错误 | 服务端对控制流发 `{type:'end'}` | 自动重开控制流（open 帧计数增加）；重开后审批帧仍被处理 |
| T-I9 | I | F9, A10 | 边界 | `dispose()` 后等待 ≥4s | 无任何新的 HTTP 请求 / WS 流量 |
| T-I10 | I | F4, R3 | 边界 | 抑制 live 推送 → 追加 `turn/end` 在窗口外 → 重开 follow | 走 `page` 补页覆盖到 `lastSeq+1`；`turn/end` 不丢；回复产出 |
| T-I11 | I | F6, A7, A8 | 正常 | 桌面决定审计 / cancel 帧 | 各自的端口调用**恰好一次**（"已处理"一条 / "已取消"一条）；重复点击不再回传 |

## 3.2 验收标准（逐条回指需求，每条可机器验证）

| # | 验收标准 | 回指 | 验证命令/方式 |
|---|---|---|---|
| AC1 | `node --test` 全绿，含 T-U1..T-U30 与 T-I1..T-I11 全部用例 | F1–F9, R10, N5 | `node --test test/` |
| AC2 | 全部 `.js` 通过语法检查 | N6 | `node --check <每个文件>` |
| AC3 | 每文件 ≤400 行 | N3 | 行数统计 |
| AC4 | `dependencies` 恰为 `ws@8.21.3` + `@deepseek-ai/schemastery@3.18.2` | N4 | 读 `package.json` |
| AC5 | 无空 `catch {}`；所有发送/回传调用点 `await` 结果 | N2, R2 | 静态检查（评审逐点核） |
| AC6 | 日志/输出中无 launch token 明文 | N1, R1, A2 | T-I2 |
| AC7 | 17 个配置键逐字一致；`appId` 接受 string\|number | N7, R9 | `config.test.js` 断言键集与类型 |
| AC8 | 文档无 >300 字符单行 | N8 | 行长度检查 |
| AC9 | A1–A5、A10–A13 的 DSH 侧行为在集成用例中可复现 | §3.3 对位表 | T-I1..T-I11 |
| AC10 | `lib/qq/` 存在且为端口契约 + 空实现，Round 2 落点明确 | F6, F10 | 目录检查 + `lib/qq/README.md` |
| AC11 | 事件白名单：白名单外类型静默忽略且不中断流；`assistant/message` 是唯一文本来源 | F4, R2, D18 | T-U31（`node --test test/session.test.js`） |
| AC12 | 出站端口契约能表达"本条可走被动窗口"，且 `msgSeq` 分配责任归端口；窗口内每条带 `msgId` 且 `(msgId,msgSeq)` 唯一 | F3, D17 | 本轮**契约落档**（§2.3.4）；判定口径 = 对接方 **A9（core）/ A20（v2 目标）** —— Round 2 落地 |

## 3.3 A1–A20 对位表（每条场景 → 设计元素 → 本轮状态）

> 验收台见 `E:\DSHWorkspace\qq-channel-verify\run-scenarios.mjs`（**432 行**版本，2026-09-16 04:2x 读取）。
> **前置事实**：默认 `boot()` 会等 QQ `IDENTIFY` 才继续（`run-scenarios.mjs:71-72`）；对接方已加降级开关 **`SKIP_QQ=1`**（`run-scenarios.mjs:69-75`：跳过等 `IDENTIFY`）。
> 本轮 QQ 网络层留 Round 2（§五 边界）→ `SKIP_QQ=1` 下本轮骨架也只是"能启动不挂"；**依赖 QQ 入站流量的场景（A1–A9、A14–A18）本轮必然失败**。
> 本轮验收证据以 `test/` 套件（T-I*）为准。验收契约（`REVIEW-1 §四`）= **core：A1–A15、A18、A19**；**v2 目标：A16、A17、A20**。

| # | 场景 | 满足它的设计元素 | 本轮状态 |
|---|---|---|---|
| A1 | v2 探测 + 走 v2 事件通道、不得尝试 `events.mux` | `detect.js`（D11/D12）+ `v2.js` + `mux.js`（follow 通道） | 本轮可跑通（T-I1，DSH 侧） |
| A2 | 凭据卫生 | `log.js` 脱敏入口（D9） | 本轮可跑通（T-I2） |
| A3 | 401 恢复 | `transport.js` + `auth.js`（D8） | 本轮可跑通（T-I3） |
| A4 | prompt 报文 | `v2.js` 映射（D10） | 本轮可跑通（T-I5） |
| A5 | 不丢事件（窗口外 `turn/end`） | `events.js` 缺口补齐（§2.4.4）+ `state.js` | 本轮可跑通（T-I6，回复在端口断言） |
| A6 | 审批往返 + 重复点击不二次回传 | `pending.js` 状态机 + `v2.js` 回传 | 状态层本轮可跑通（T-U21/T-U25/T-I11）；QQ 键盘渲染 Round 2 |
| A7 | 电脑端处理 → 恰好一条通知 | `pending.js` 审计配对（D4/D5）+ `session/follow` | 状态层本轮可跑通（T-U23/T-I11）；QQ 渲染 Round 2 |
| A8 | cancel 帧 → 结清 + 点击被拒 | `pending.js`（§2.4.2） | 状态层本轮可跑通（T-U24/T-I11）；QQ 渲染 Round 2 |
| A9 | QQ 侧 token/IDENTIFY/被动额度（首条带 `msg_id`） | `lib/qq/client.js` + `send.js`（Round 2）+ §2.3.4 端口契约（D17） | Round 2 |
| A10 | dispose 后无流量 | `channel.js` + 各模块 `dispose()`（D14） | 本轮可跑通（T-I9） |
| A11 | 控制流 `end` 后自动重连 | `mux.js` 重开 + `pending.js` 保留条目 | 本轮可跑通（T-I8） |
| A12 | 历史不重放（基线） | `state.js` `adopt('skip-history')`（§2.4.5） | 本轮可跑通（T-I7） |
| A13 | prompt 级 401 幂等 | `transport.js` + `v2.js` 铸造点（D6） | 本轮可跑通（T-I4） |
| A14 | QQ 网关断开重连（4009） | `lib/qq/client.js` close 分类（Round 2） | Round 2 |
| A15 | 发件箱文件移入 `sent/` | `lib/qq/outbox`（Round 2） | Round 2 |
| A16 | 键盘按钮 `click_limit=1` + `permission.type=2` + 回调型 | §2.10.1 渲染层字段表（Hermes `keyboards.py:57-90`；**v1.2.4 未发 `click_limit`**，属 v2 新增要求） | Round 2 |
| A17 | 分片上传报文完整（含 `md5_10m`） | §2.10.2 文件链三坑；`md5_10m = 10_002_432` **已裁决**（`PROTOCOL.md §10.1`） | Round 2 |
| A18 | 先 ACK 再回传 `$events/result` | Round 2 交互层（顺序已在 `PROTOCOL.md §8` 固定） | Round 2 |
| A19 | `session/prompt` 必带 `mode`（缺 → `gateway/input-invalid`） | `v2.js` 映射（D10）；实测 `thincoder-v2-live-verified.md §1` | 本轮固定契约（T-I5 已断言 `mode:'queue'`；对接方标 core） |
| A20 | 被动回复窗口：窗口内每条都带 `msg_id`，`msg_seq` 为整数且 `(msg_id,msg_seq)` 唯一 | §2.3.4 端口契约（D17） | Round 2（本轮只固定契约；对接方标 v2 目标） |

---

# 四、变更记录

- 2026-09-16：初版（Round 1）。三层 + 8 项齐备；3 处方案选型对比；R1–R10 对策；P0/P1/P2 逐条处置（2 P0 + 11 P1 + 18 P2）；
  41 条用例（T-U1–T-U30 + T-I1–T-I11）；A1–A18 对位表。记录 2 处对既有规格的**纠错**（`mode` 必填、配置键 17 非 18）。
- 2026-09-16（修正轮，`REVIEW-1` M1–M6）：M1 被动回复模型改"窗口"（§2.3.4 + D17 + P2-3）；M2 事件白名单与未知静默（§2.4.6 + D18）；
  M3 键盘 `click_limit=1`（§2.10.1）；M4 文件链三坑（§2.10.2）；M5 游标断言（落 `PROTOCOL.md §5.1`）；open-1/2/4/5 与 P2-6/P2-17 处置随裁决更新（§5.2）。
  同步：§3.1 +T-U31、§3.2 +AC11/AC12、§3.3 扩为 A1–A20。**未夹带新语义**（改动全部来自 REVIEW-1 已裁决事项）。

---

# 五、边界（本轮明确不做）与 open 项

## 5.1 本轮不做（越界即本轮失败）

1. 不实现 QQ 网络层（token/网关/REST/交互/文件/发件箱）——留 Round 2，含 A6–A9、A14–A18 的 QQ 侧部分。
2. 不改 `E:\DSHWorkspace\dsh-qq-channel`（现役 v1.2.4，只读）、不改 `E:\DSHWorkspace\qq-channel-verify\`（对接方集成台）。
3. 不写 `$DSH_HOME/**` 或任何 DSH 配置；不启动/停止 DSH；不占 3080。
4. 不 `git push`、不改远程、不在 v2 目录提交（提交由对接方负责）。
5. 不联网调 QQ 官方 API；不读真实 appId/clientSecret/token。
6. 任何 secret/token 不进日志、文档、测试固件。
7. 不为让测试通过而放宽断言或跳过用例（失败就如实写进报告）。

## 5.2 open 项（`REVIEW-1 §一` 已逐条裁决，2026-09-16）

| # | open 项 | 裁决 | 落档位置 |
|---|---|---|---|
| open-1 | **QQ 网络层是否纳入本轮** | **维持原范围**：QQ 网络层留 Round 2。对接方已给验收台加 `SKIP_QQ=1`（`run-scenarios.mjs:69-75`），本轮骨架在其台上只是"能启动不挂"——**依赖 QQ 入站流量的场景（A1–A9、A14–A18）本轮必然失败**；本轮验收证据以 `test/` 套件为准 | 本表 + §3.3 前置事实 |
| open-2 | `md5_10m` 字节数 | **`10_002_432` 正确**（不改 `10485760`）：Hermes `chunked_upload.py:66-67` 具名常量 + 出处注释；小于该长度时 `md5_10m` = 全文件 md5（同文件 `:585-586`）。采用具名常量 | `PROTOCOL.md §10.1`（已裁决）+ §2.8 P2-6 |
| open-3 | 旧设置 API `installSettingsSection` 的真实签名 | **保留防御分支 + 标未验证**，接受（不改） | `PROTOCOL.md §10.2`、§2.9 |
| open-4 | 批次档 N7 计数"18 键"应为 17 | **接受 17**；批次档 §1.3 已由主 agent 更正，本档叙述与之对齐 | §1.3 N7 + `PROTOCOL.md §9.11` / §9.13 |
| open-5 | `$events/result` 失败被宿主 abort 的边界 | 设计要求**先固定**：回传失败 → 条目**保留 pending** + 明确告知（`T-U26` 覆盖）；**重连策略**留 Round 2 真机验证再定 | §2.4.2 + §3.1 `T-U26` |

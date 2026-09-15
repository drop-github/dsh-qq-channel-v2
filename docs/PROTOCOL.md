# dsh-qq-channel v2.0.0 — 协议事实档（PROTOCOL）

- 目的：把 v2 实现所依赖的**每一条协议事实**固定下来，逐条带宿主源码 `file:line` 证据，供实现方按图施工、供评审逐条核对。
- 权威顺序：**宿主源码 > 对接方裁决（`thincoder-v2-round1-answers.txt`）> 任务书（`thincoder-v2-round1-task.txt`）> 现役实现 v1.2.4**。
- 与既有规格冲突处一律以源码为准，并在 §9「与本任务书/规格不符之处」逐条写明；核不到的进 §10「未验证项」，**不猜**。

## 0. 证据基线与读法

| 对象 | 路径根 | 说明 |
|---|---|---|
| 宿主源码（v2，DSH 0.1.5-rc.2） | `E:\DSHWorkspace\dsh-new\node_modules\@deepseek-ai\` | 本档 `file:line` 的行号基准；下表包名省略该前缀 |
| 现役实现 v1.2.4（只读） | `E:\DSHWorkspace\dsh-qq-channel\lib\index.js` | 实测 **2234 行**（任务书写 2284 行，差 50 —— 见 §9.12） |
| 对接方验收台（只读） | `E:\DSHWorkspace\qq-channel-verify\` | 行号对应 §0.2 记录的版本指纹 |

### 0.1 包发布形态（影响行号可信度，必读）

宿主这些包**只发布构建产物**：`main` 指向打包后的 `lib/index.js`，`files` 不含 `src`，目录内无 `src/`。
因此：

- 本档引用 `lib/index.js`（bundle，实际被加载）与 `lib/types/*.d.ts`（tsc 分模块产物）两类文件；
- **同一模块在 bundle 与 `lib/types/*.js` 中行号不同**，本档行号只对所指文件有效；
- 原始 TS 文件不在本机，`typert.host.js` 里的 `sourceLocation` 只作为参数名/签名的**双重印证**，不作为证据行号。

### 0.2 验收台版本指纹（防漂移）

对接方的验收台在 2026-09-16 本轮期间被更新过（批次档 §1.5 关于"A5 陷阱"的旧叙述已随之作废）。
本档断言 mock 行为时，一律以下列**行数指纹**标注版本（行数变化 = 版本已漂移，需重核）：

| 文件 | 本档读取版本 | 指纹 | 读取时间 |
|---|---|---|---|
| `fake-ctx.mjs` | 53 行 | 假 ctx 五面 | 2026-09-16 04:0x |
| `mock-dsh.mjs` | **313 行** | follow 推事件帧 + `rejectedUpgrades` | 2026-09-16 04:2x |
| `mock-qq.mjs` | 134 行 | `dropGateway` + `partFinishes` | 2026-09-16 04:0x |
| `run-scenarios.mjs` | **432 行** | A1–**A20** + `MODE=core|v2` 分档 + `SKIP_QQ` 降级 | 2026-09-16 04:2x |
| `probe-live-host.mjs` | 145 行 | 真机 16 项探测（`LIVE-PROBE OK`） | 2026-09-16 04:2x |
| `verify-config-compat.mjs` | 78 行 | 配置逐键兼容门禁（切换前跑） | 2026-09-16 04:2x |

---

## 1. 传输层（typert 网关，v2 = DSH ≥0.1.5）

### 1.1 端点与请求

- 入口 = **Connection 的 `/api` 前缀路由**，网关是注册其上的 interceptor（不是独立 HTTP server）。
  证据：`dsh-client-connection/lib/index.js:768`（`{kind:'prefix', path: API_PATH}`，`API_PATH='/api'` 见 `:13`）、
  `dsh-api-gateway/lib/index.js:455`（`connection.rpc.intercept('/api', …)`）。
- 方法名 = 路径去掉 `/api/` 后的剩余部分（`namespace/method`），每段须匹配 `^[A-Za-z0-9_$.-]+$`。
  证据：`dsh-client-connection/lib/index.js:673-676`、`:521`。
- 请求体（逐字）：

  ```json
  {"type":"client-request","rpcId":"<string>","method":"<endpoint>","payload":{"args":{…}}}
  ```

  证据：`dsh-client-connection/lib/index.js:502`（`clientRequestSchema`）、`:648`；**`method` 必须逐字等于 URL 里的 endpoint**（`:651`）。
- 方法限制：必须 `POST`（否则 404），`content-type` 必须 `application/json`（否则 415）。
  证据：`dsh-client-connection/lib/index.js:640-641`。
- 响应体（逐字）：`{"type":"server-response","rpcId":"<同>","result":{"ok":true,"value":…}}`
  或 `{"…result":{"ok":false,"error":{"code","message","details"}}}`。证据：`dsh-client-connection/lib/index.js:685`、`:492`。

### 1.2 🔴 状态码与错误模型（最容易写错的一条）

**业务错误与网关错误恒为 HTTP 200，错误在 body 里**；非 200 只出现在传输层：

| 情形 | 状态码 | body | 证据 |
|---|---|---|---|
| 正常（含 `result.ok=false`） | **200** | `server-response` JSON | `dsh-client-connection/lib/index.js:685` |
| 未认证（缺/失效 cookie） | **401** | 纯文本 `unauthorized`（**无 JSON、无 code**） | `:553-556`、`:771-777` |
| 非信任 Host/Origin | **403** | 纯文本 `forbidden` | 同上 |
| 未知方法 / 非 `/api/` 路径 | **404** | 纯文本 `not found`（**无 code**） | `:582`、`:640` |
| content-type 非 JSON | 415 | 纯文本 | `:641` |
| body 非 JSON | 400 | 纯文本 | `:646` |
| 体量超限 | 413 | 断连 | `:24`、`:47-67` |
| handler 内部异常 | 500 | 纯文本 | `:660` |

→ **实现约束**：判定"401"必须看 **HTTP 状态码**，不能找 `error.code`；判定业务失败必须看 `result.ok`/`result.error.code`，不能看状态码。

### 1.3 `assertExactArguments`（args 键必须精确）

- 定义：`dsh-api-gateway/lib/index.js:1040-1052`；**唯一调用点** `:741`（`prepareInvocation` 内，HTTP 与 mux 两条路共用）。
- 行为（逐条）：
  1. `args` 必须是 plain object，否则 `gateway/arguments-invalid` + `"args must be a plain object"`（`:1041`）；
  2. 期望键集 = 描述符 `parameters[].wire`（`:1042`）；
  3. 多余键（含符号键）→ `unexpected "k"`（`:1044`、`:1050`）；
  4. 缺失键（且不属 `acceptsUndefined`/`src-json` 豁免）→ `missing "k"`（`:1045-1046`、`:1049`）；
  5. 错误码恒为 **`gateway/arguments-invalid`**，message 形如 `args fields do not match the descriptor: missing "…"; unexpected "…"`。
- **这五个方法都没有豁免键**（`codec.mode:'strict'`）→ **缺键同样是 `gateway/arguments-invalid`**。

### 1.4 各方法 args 键集（逐字）

| endpoint | args 允许键 | TS 参数名 | 证据 |
|---|---|---|---|
| `session/list` | **`_request`**（唯此一键） | `_request` | `dsh-api-session-controller/lib/typert.host.js:901-911` |
| `session/create` | `request` | `request` | 同文件 `:824-834` |
| `session/rename` | `request` | `request` | 同文件 `:1020-1030` |
| `session/prompt` | `request` | `request` | 同文件 `:996-1003` |
| `session/page` | `request` | `request` | 同文件 `:970-971` |
| `session/follow`（流） | `request` | `request` | 同文件 `:850-860` |
| `$events`（流） | 恰 `{"args":{}}`（args 零自有键） | — | `dsh-api-gateway/lib/index.js:586` |
| `$events/result` | 恰 `clientId,eventId,outcome` | — | `dsh-api-gateway/lib/types/stream-protocol.js:17-24` |

→ `session/list` 用 `{request:{}}` 会被判 `unexpected "request"; missing "_request"`。这是探测 v2 时最容易踩的坑。

### 1.5 载体错配

| 场景 | code | message 原文 | 证据 |
|---|---|---|---|
| 流式方法走普通 HTTP | `gateway/signature-invalid` | `stream Remote methods must be opened through the stream carrier` | `dsh-api-gateway/lib/index.js:540` |
| 非流式方法走 mux | `gateway/signature-invalid` | `unary Remote methods cannot be opened through the stream carrier` | `:555` |
| mux `payload` 不是恰 `{args:…}` | `gateway/internal`（被兜底折叠） | `Remote payload must contain exactly one plain-object args field` | `:927`、`:978-985` |

### 1.6 错误码词表要点

- 网关码共 17 个：`dsh-api-gateway/lib/types/types.d.ts:89`。
- **`gateway/unknown-method` 不存在**（全 `node_modules` grep 0 命中）——真实宿主对未知方法是 **HTTP 404 + 纯文本**，无任何 code。
- 兜底：任何非 `RemoteError` 异常 → `gateway/internal`（`:978-985`）。
- `gateway/bad-request` 亦用于传输层信封校验失败（`dsh-client-connection/lib/index.js:651`、`:665-671`）。

### 1.7 mux 连接的心跳 / 容量 / 重连

- 服务端 **ping 心跳**：默认 2000 ms（`websocketHeartbeatIntervalMs`），**连续 2 次未收到 pong 即 `socket.terminate()`**。证据：`dsh-api-gateway/lib/index.js:197`、`:398`、`:433`、`:226-228`、`:251-268`。
- `ws` 库自动回 pong，**插件无需自己发 ping**；但**必须不要因为长时间无消息而主动断开**。
- **服务端无断线续传**：socket 一关，该连接上所有逻辑流被 abort（`"Remote stream socket closed"`，`:299-301`）；重连必须由客户端自己重新 `open`。
- 未发现连接数/流数上限；唯一天花板是 ws 默认 `maxPayload = 100 MiB`（`:203` 未覆盖该选项）。

---

## 2. browserAuth 与连接服务

- 服务名 **`'connection'`**：`dsh-client-connection/lib/index.js:535`（`super(ctx, "connection")`）；类型面 `lib/types/rpc-host.d.ts:5-9`。
- `authenticatedUrl(baseUrl)`：`dsh-client-connection/lib/index.js:370-377` —— 返回**绝对 URL 字符串**，path 强制 `/`、丢弃原 query/hash，并**必然带 `?token=<launchToken>`**（`TOKEN_QUERY='token'` 见 `:222`）。
- 令牌兑换 cookie：`GET /?token=<launchToken>` → **303** + `set-cookie`。证据：`:386-425`（主体 `:392-408`）。
  - cookie 名 = `dsh-auth-` + base64url(sha256(authority))，`authority` 来自 `Host` 头（`:280-282`、`:252-261`）→ **换 Host 名就取不到 cookie**。
  - cookie 值 = `v1.<b64 body>.<b64 HMAC>`，属性 **`Max-Age` / `Path=/` / `Expires` / `HttpOnly` / `SameSite=Strict`**（无 `Secure`、无 `Domain`）。证据：`:292-294`。
  - 有效期默认 **30 天**（`:740`、`:753`）。
- 实现约束：
  1. 兑换必须用 **GET + `redirect:'manual'`** 读 `set-cookie`（跟随后会丢掉 cookie）；
  2. 只取 `set-cookie` 的**第一段**（`name=value`）作为后续 `cookie` 头；
  3. 请求 `Host` 保持 `127.0.0.1:<port>` 形态，**不要设置 `Origin`**（设了就必须与 Host 同源，`:207-211`）。
- 非浏览器客户端不会被拒：fence 只要求（a）authority 是 loopback 或 `trustedHosts`，（b）非跨站 Origin。证据：`:201-215` + `lib/types/api-request-trust.js` 头注释。
- 401 语义：cookie 缺失/签名不符/过期/authority 不匹配 → `isAuthenticated` 返回 false → `requestRejection` 返回 401（`:431-441`、`:553-556`）。

---

## 3. `remote.mux` 流载体

- 路径常量 `REMOTE_STREAM_MUX_PATH = "/api/remote.mux"`（**精确匹配**）。证据：`dsh-api-gateway/lib/index.js:11`、`:459-476`。
- 鉴权 = **与 `/api` 同一处** `connection.requestRejection(req)`；失败时手写 HTTP 响应拒绝 upgrade（**不进 ws**）。证据：`:462-469`、`:377-388`。→ WS 握手必须带 **cookie 头**（在 `ws` 里通过 `options.headers` 传）。
- 客户端 → 服务端帧（逐字，**恰键**，多一键即拒）：

  ```json
  {"type":"open","streamId":"<非空串>","endpoint":"<2 段>","payload":{"args":{…}}}
  {"type":"cancel","streamId":"<非空串>"}
  ```

  证据：`:122-133`（校验）、`:155-157`（`streamId` 非空即可，**由客户端生成**）、`:309`（同连接内重复 streamId → 抛错并 close 1008）。
- 服务端 → 客户端帧（逐字）：

  ```json
  {"type":"item","streamId":"…","value":<任意>}
  {"type":"end","streamId":"…"}
  {"type":"error","streamId":"…","error":{"code","message","details"}}
  ```

  证据：`:325-333`、`:336-340`。
- `open.payload`：普通流方法必须**恰为** `{"args":{…}}`（与 HTTP 同一 `remoteRequest` 校验，`:925-936`）；内置 `$events` 必须恰为 `{"args":{}}`（`:586`）。
- **`{type:'cancel', streamId}` 取消的是整条流，不是某个事件**；不存在"逐事件取消"的客户端→宿主帧。证据：`dsh-api-gateway/lib/types/stream-protocol.js:157-159`、`lib/index.js:510-517`。
- 二进制帧 → `close(1003)`；解析失败 → `close(1008)`（`:287-296`）。

---

## 4. `$events` 内部事件流（审批 / 提问）

- 常量：`REMOTE_EVENT_STREAM_ENDPOINT = "$events"`、`REMOTE_EVENT_RESULT_ENDPOINT = "$events/result"`。
  证据：`dsh-api-gateway/lib/types/stream-protocol.d.ts:6`、`:8`。
- 流入口特判：`dsh-api-gateway/lib/index.js:581-584`（`endpoint === '$events'` → `openRemoteEvents`）。
- 事件源注册：`dsh-api-remotes/lib/index.js:102`（`ctx.typertGateway.registerRemoteEvents(...)`）；白名单在 `:17-94`，其中两条 waterfall：`approval/request`（`:22-25`）、`user-questions/request`（`:90-93`）。
- **服务端下推帧（逐字）**（`dsh-api-gateway/lib/types/stream-protocol.d.ts`）：

  | 帧 | 行 | 逐字字段 |
  |---|---|---|
  | `ready` | `:27-32` | `{type:'ready', clientId, host:{home}}` |
  | `emit` | `:36-40` | `{type:'emit', event, args}` |
  | `waterfall` | `:42-48` | `{type:'waterfall', event, eventId, agentId, request}` |
  | `cancel` | `:50-53` | `{type:'cancel', eventId}` |

  客户端侧**逐字键集**校验（比类型更严）：`lib/types/client/remote-events.js:172-218`；首帧必须是 `ready`（否则抛 `…did not begin with ready`，`:68-72`）。

- `clientId` 语义：**宿主生成，每条流一次**（`let clientId = randomUUID()`，`lib/index.js:590-591`），流结束时注销（`:698-702`）；**断线重连后 clientId 会变**。
  → 实现约束：每次收到 `ready` 都要刷新本地 `clientId`；回传用它。
- `waterfall.request` 的投影：宿主**剥掉 `agent` 与 `signal`**，其余自有可枚举字符串键原样保留。证据：`:60-85`（投影函数，`if (key === 'agent' || key === 'signal') continue;`）、`:634`、`:657-663`。
- `agentId` **就是 SessionId**：`dsh-api-remotes/lib/index.js:115-125` 用 `agent.id` 作为 `agentId`，而 `Agent.id` 的类型即 `SessionId`（`dsh-agent/lib/types/types.d.ts:11-14`）。
- `$events/result`（回传）：args 恰 `{clientId, eventId, outcome}`；`outcome` 三种 kind：
  `{kind:'next'}` | `{kind:'result', value?}` | `{kind:'rejected', error:{name,message,code?,details?}}`。
  证据：`stream-protocol.d.ts:69-81`、`stream-protocol.js:17-52`。
- 🔴 **回传的两条静默路径（设计必须兜住）**：
  1. `clientId` 未知 → 抛普通 Error → 折叠为 `gateway/internal`（`lib/index.js:566-578`、`:968-986`）；
  2. **`eventId` 未知/该 client 从未收到该事件 → 静默 no-op，RPC 仍回 `{ok:true}`**（`:683-692` 的 `pending === undefined` 分支）。
     → "点了没用"**无法由返回码判定**；实现必须靠本地条目状态 + 审计事件兜底。
- 多客户端语义：`{kind:'next'}` 只有在**所有**已投递客户端都答 `next` 后才交还链（`:683-692`）。
- 无 remote 客户端时：宿主把瀑布帧挂起（`pendingRemoteEvents.set`），**审批静默悬挂**；**稍后开流会补投**（`:598`）。→ 实现约束：控制流断开期间不能丢本地条目，重连后仍要能处理。

---

## 5. 会话事件消费（follow / page）

### 5.1 `session/follow`（主事件源）

- 声明：`@Remote({mode:'stream'})`（编译产物 `dsh-api-session-controller/lib/index.js:2513`；生成物描述符 `lib/typert.host.js:843-868`，`mode:'stream'` 在 `:848`）。
- 请求（**逐字，无任何起始 seq 参数**）：

  ```ts
  interface SessionFollowRequest {
    readonly address: SessionAddress;      // {kind:'session', sessionId} | {kind:'subagent', …}
    readonly maxMessages?: number;
    readonly assistantStream?: true;
  }
  ```

  证据：`lib/types/types.d.ts:416-422`；线上 zod schema 同形 `lib/typert.host.js:226-238`；`SessionAddress` 定义 `lib/types/types.d.ts:356-365`。
  → **确认：任务书 §5.5 的"起始 seq"不存在**（裁决已作废该条；源码复核一致）。
- 帧联合类型（`lib/types/types.d.ts:474-486`）：

  | 帧 | 逐字字段 |
  |---|---|
  | 开帧 `snapshot` | `{type:'snapshot', header, cursor, records, hasMore, projections, assistantStream?}` |
  | 事件帧 | `SessionEventEntry = {type:'event', event}`（`:366-370`） |
  | 助手流帧 | `{type:'assistant-stream', frame}`（`:440-468`） |

- `snapshot.cursor` = 开帧时刻**最后一个已提交事件 seq**；**只有真正的空日志才等于 `-1`**。
  证据：`lib/types/history.js:196-199` + `dsh-session-query/lib/types/observation.d.ts:20-21`；取游标的实现行 `dsh-api-session-controller/lib/index.js:1378`
  （`sourceLog.at(-1)?.seq ?? -1` —— bundle = 实际被加载的副本）。
- 🔴 **实测（2026-09-16，来源 `thincoder-v2-live-verified.md §3`）**：`session/create` 之后**立刻**查游标得到 **2**（新建会话自带初始事件），
  越界文案 `session page through seq <N> is past cursor 2`。
  → **基线不得假设"新会话 = -1"**，一律以 `snapshot.cursor` 为准（§5.4）；`-1` 只用于真正的空日志。
  → 规则：**引文与本机实测不一致时以实测为准并标注**（`REVIEW-1 §三 M5`）。
- `snapshot.records` = 开帧回看窗口，**复用同一个 `paginate`**，默认 ≤50 条 message（`lib/types/history.js:200`、`:59`）；`hasMore = cut > 0`。
- 事件 envelope（`lib/types/types.d.ts:397-407`）：

  ```ts
  { type: string; seq: number; time: number; data: JsonValue;
    ignorable?: true; sourceEventSeqs?: JsonValue; surfaceOp?: JsonValue }
  ```

  → **envelope 里没有 `sessionId`**；会话归属由"这条流跟随哪个会话"决定（服务端按 `session.id !== target` 过滤，`lib/index.js:1419-1426`）。
- 源码自述 gap-free：`lib/types/history.js:137`、`lib/types/index.d.ts:168-169`（`complete opening snapshot followed by gap-free durable event frames`）。
- **保序机制与失败行为（关键）**：宿主先挂监听再取观测（`:158-163`、`:195`），随后对 seq 做**稠密断言**：
  `if (seq < expectedSeq) 静默跳过; if (seq !== expectedSeq) throw RemoteError('gateway/internal', 'session event stream skipped seq N')` —— **抛错即终止流，不重连、不补齐**（`:243-248`）。
  → 一旦本地漏帧，宿主会主动断流；**补齐只能靠 `session/page`**；断流后由本地重连逻辑重新开流并做缺口对账。
- 流没有"完成帧"：generator 退出即结束（`:231-251`）。

### 5.2 `session/page`（补页 / 对账源）

- 请求（逐字）：

  ```ts
  interface SessionPageRequest {
    readonly address: SessionAddress;
    readonly throughSeq: number;   // 必填，无 optional
    readonly beforeSeq?: number;
    readonly maxMessages?: number;
  }
  ```

  证据：`lib/types/types.d.ts:408-415`；线上 schema `lib/typert.host.js:544-557`（`throughSeq` 无 `.optional()`）。
- `throughSeq` 的 TSDoc 原文（**宿主设计意图就是"follow 拿游标 + page 补历史"**）：

  > `Inclusive log cut obtained from the corresponding follow opening frame.`

  证据：`lib/types/types.d.ts:411`。
- 响应：`{records: [{event: SessionWireEvent}], hasMore: boolean}`（`lib/types/types.d.ts:469-473`）。
- `paginate` 语义（**消息对齐的向回扫窗口，不是增量拉取**）：

  ```js
  const end = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1);
  // 自 end-1 向 0 回扫，只计 user/message、assistant/message 且 surfaceOp==='append' 的事件
  // cut 落在第 maxMessages 条（自右向左数）的 groupStart = min(seq, ...sourceEventSeqs)
  // 返回 events.slice(cut, end)，hasMore = cut > 0
  ```

  证据：`dsh-api-session-controller/lib/types/history.js:387-410`（bundle 副本 `lib/index.js:1602` 起）；
  `MESSAGE_TYPES` 定义 `:60`；`isAppendSurfaceEvent` 在 `dsh-session/lib/types/surface.d.ts:36-38`。
- 参数校验与报错原文（`lib/types/history.js:317-333`）：
  - `throughSeq` 必须是安全整数且 `>= -1`（`-0` 被拒）→ 否则 `gateway/bad-request` / `throughSeq must be an integer greater than or equal to -1`；
  - `beforeSeq` 非负安全整数；`maxMessages` 正安全整数，否则 `gateway/bad-request`。
- 空日志与越界：

  ```js
  const sourceCursor = sourceLog.at(-1)?.seq ?? -1;   // 只有真正的空日志才是 -1
  if (throughSeq > sourceCursor) throw new RemoteError('gateway/bad-request',
      `session page through seq ${throughSeq} is past cursor ${sourceCursor}`, {});
  ```

  证据：bundle `dsh-api-session-controller/lib/index.js:1378-1379`（实际被加载的副本）+ 分模块产物 `lib/types/history.js:110-113`（逐字一致）。
  → `throughSeq=-1` 在空日志**合法**（`-1 > -1` 为假）→ 返回空页；`throughSeq` 超过服务端游标才报 `past cursor`。
  → **实测补充（2026-09-16，来源 `thincoder-v2-live-verified.md §3`）**：`session/create` 后游标 = **2**，
  故"新会话"传 `throughSeq=-1` 仍是合法调用，但游标**不是** `-1` —— `-1` 只出现在真正的空日志。
- 稠密前缀不变量：`sourceLog[throughSeq]?.seq !== throughSeq` → `gateway/internal session log does not contain through seq N`（`:114-117`）。

### 5.3 缺口补齐判定式（设计常数，**实现必须照此**）

本地为每个受管会话维护 `lastSeq`（已连续处理到的最后一个 seq；初始基线见 §5.4）。每次**新开 follow 拿到 `snapshot`** 时：

```
若 snapshot.cursor === -1                 -> 空日志，无需补页，lastSeq 保持基线
若 snapshot.cursor <  lastSeq             -> 异常（宿主重建/日志被截断）：记日志 + 重置 lastSeq = -1 并重新对账
若 snapshot.cursor >= lastSeq             -> 存在缺口判定：
     令 earliest = min(records.map(r => r.event.seq))   （records 为空则视为无缺口）
     若 earliest === undefined 或 earliest <= lastSeq + 1  -> 无缺口，直接按序处理 records(seq > lastSeq) 与后续 live 帧
     否则（earliest > lastSeq + 1）                        -> 有缺口，走 session/page 前翻：
           throughSeq = snapshot.cursor
           beforeSeq  = 上一页最早的 seq（首页用 earliest）
           循环直到 页面最早 seq <= lastSeq + 1  或 hasMore === false
           收集完成后按 seq 升序放行 [lastSeq+1, snapshot.cursor]，再推进 lastSeq = snapshot.cursor
```

- `beforeSeq` 是**排他上界**（`end = min(throughSeq+1, beforeSeq)`）→ 传上一页最早 seq 即"继续拿更早的窗口"。
- 全程 `throughSeq` 固定为 `snapshot.cursor`（一定 ≤ 服务端游标，不会触发 `past cursor`）。
- 与裁决 §2 的判定式一致：`cursor > lastSeq && records 最早 seq > lastSeq+1` → 补页，**补齐后才推进 `lastSeq`**。

### 5.4 基线时刻（P1-2 的结构性对策）

- **基线必须在"会话纳入管理那一刻"确定**，而不是"首次拉取成功时"：
  - 由本插件新建的会话（per-source 模式）：基线 `lastSeq = -1`（`replay-all`）→ **全部事件都投递**
    （含新建会话自带的初始事件——实测游标常为 `2`，见 §5.1；非白名单类型由 `DESIGN.md §2.4.6` 静默）；
  - 启动时已存在 / 从 `qq-channel-sources.json` 恢复的会话：**跳过历史** → 基线与**首个 `snapshot.cursor`** 对齐，`records` 视为历史不对用户投递。
- 证据（宿主侧不提供该语义，属插件责任）：`session/follow` 每次都是从零开帧、开帧窗口是历史窗口，故"是否重放"完全由消费方决定（§5.1、§5.2）。

---

## 6. `session/prompt` 与幂等

- 请求（逐字）：

  ```ts
  interface SessionPromptRequest {
    readonly requestId: SessionRequestId;   // 客户端铸造
    readonly sessionId: SessionId;
    readonly mode: 'queue' | 'steer';       // 必填，无 ?
    readonly content: readonly PromptContentPart[];
    readonly clientTimeZone?: string;
  }
  ```

  证据：`lib/types/types.d.ts:291-300`；线上 schema `lib/typert.host.js:573-590`（`mode` 为 `z.union([z.literal("queue"), z.literal("steer")])`，**非 optional**）。
- 🔴 **`mode` 是必填**：省略或传其他值 → 边界校验失败 `gateway/input-invalid`（`dsh-api-gateway/lib/index.js:1053-1068`）。
- 宿主对 `mode` 的处理**只特判 `'steer'`**，其余一律 followup：

  ```js
  if (request.mode === "steer") agent.steer(message);
  else agent.followup(message);
  ```

  证据：`dsh-api-session-controller/lib/index.js:773-774`。→ 传 `'queue'` 是**合法且行为等于 followup**。
- `requestId` 去重语义：同一 `requestId` 只要出现在**在途收件箱**或**已落盘 `user/message.data.source.rpcId`**，就直接返回 `{accepted:true}` 且**不追加消息**。
  证据：`lib/index.js:741`（调用点）、`:940-951`（`hasPromptRequest` 实现）。
  → 重试必须复用同一 `requestId`，否则去重失效、消息重复。
- 返回值：`{accepted: true}`（字面量，无队列位次/seq 回执）。证据：`lib/types/types.d.ts:301-304`、`lib/typert.host.js:591-593`。
- 其它错误码：空内容 `gateway/bad-request`（`:737`）；时区非法 `session/invalid-time-zone`（`:739`）；模型不可用 `session/model-unavailable`（`:743`）；图像不支持 `session/attachment-invalid` + `{reason:'MODEL_DOES_NOT_SUPPORT_IMAGES'}`（`:764`）；兜底 `session/agent-busy`（`:785`）。
- content 块（逐字）：`text{type,text}` | `image{type,mediaType,data,name?}` | `file{type,receiptId}`。
  证据：`lib/types/types.d.ts:59-75`、线上 schema `lib/typert.host.js:577-588`。
  `mediaType` 仅 `image/png|image/jpeg|image/webp|image/gif`。
- 🔴 **image 块的实测边界（2026-09-16，来源 `REVIEW-1 §二.7`，对接方真机核验）**：
  - 额外键（如 `inboxPath`）**被容忍但剥离**——不报错，但等于没传 → **不得**把路径塞进 image 块（改走 text part 携带）；
  - 非法 `mediaType` → `gateway/input-invalid`（zod union 强制）；
  - **退化/过小图片（如 1×1 PNG）** → `session/attachment-invalid: Unsupported or malformed image data`
    → 发送侧必须有**文本兜底**，不能让整条 prompt 失败。

---

## 7. 审批与提问

### 7.1 审批 id 的两个身份（P1-6 的根因）

| 身份 | 出处 | 铸造 | 是否上网 |
|---|---|---|---|
| mux `eventId`（`RemoteEventId`） | 瀑布帧 | 网关 `randomUUID()`（`dsh-api-gateway/lib/index.js:635`） | **只在这条流上** |
| 宿主 `ApprovalRequestId`（审计 id） | 会话日志 | 审批服务 `randomUUID()`（`dsh-user-approval/lib/index.js:134`） | **只在会话日志里** |

- 两者**各自独立随机、无任何关联字段**；瀑布帧的 `request` **不含 `id`**（`dsh-user-approval/lib/types/index.d.ts:60-81`；投影只剥不加，见 §4）。
- 证据补充：`ApprovalRequestId` 定义 `lib/types/types.d.ts:15-21`（恒等转换，无运行期校验，`lib/index.js:19-21`）。
- 🔴 **审计事件不经 `$events`**：`approval/asked` / `approval/decided` **不在** `dsh-api-remotes` 转发白名单里（`dsh-api-remotes/lib/index.js:17-94`）；要拿到它们**只能开该会话的 `session/follow`**。
  → **这一条决定架构**：每个受管会话必须有一条 follow 流，否则"电脑端已处理"永远无法配对（P1-6 死代码的结构性根因）。
- 两侧字段（逐字）：`approval/asked {id, toolName, callId?, reason?}`、`approval/decided {id, outcome}`，**同一个 `id`**；发射点仅一处、前后夹住 `decide()`：`dsh-user-approval/lib/index.js:134-145`。
- `outcome` 词表：`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`（`lib/types/types.d.ts:26`）；非词表值被归一为 `'unavailable'`（`lib/index.js:15`、`:179`）；`approval/decided` 每次 ask **恰好一条**（`types.d.ts:48-51`）。
- 日志事件与会话归属：`approval/asked` 的 `data` **不含 sessionId**，会话归属来自 follow 流寻址（§5.1）。

### 7.2 提问（`user-questions/request`）

- 事件名 `user-questions/request`，waterfall（`dsh-user-questions/lib/types/types.d.ts:77`）。
- 线上 `request`（投影后）逐字 = `{questions: AskUserQuestionItem[]}`；每项
  `{id, question, detail?, header?, options?: {label, description?}[], multiSelect?, intent?}`。
  证据：`dsh-user-questions/lib/types/types.d.ts:29-67`。
- 应答结构（作为 waterfall 结果回投，**复用 `$events/result`**）：
  `{answers: [{id, selected: string[], custom?}]}`。证据：`lib/types/types.d.ts:46-58`；提交路径 `dsh-api-gateway/lib/types/client/remote-events.js:139-163`。
- **与审批不对称**：提问**没有** asked/decided 审计对（该包无任何 `session.append`，`dsh-session` 已知事件词表也无 `user-questions/*`）。
  → 提问的"已处理"只能由**本地条目状态**判定，没有审计兜底。

### 7.3 本次审批帧的线上形态（任务书未给全，补齐）

```json
{"type":"waterfall","event":"approval/request","eventId":"<gw-uuid>","agentId":"<sessionId>","request":{"toolName":"…","callId":"…?","reason":"…?"}}
```

- `callId`/`reason` 为可选，仅在宿主侧存在时才出现（`dsh-user-approval/lib/index.js:135-140` 的条件展开）。
- 键集**恰好**五个（客户端校验器 `lib/types/client/remote-events.js:200-208` 逐字校验，且 `request` 不得含 `agent`/`signal`）。

---

## 8. QQ 侧协议（Round 2 实现；本轮只固定事实与风险）

> 本节事实来自现役实现 v1.2.4（`E:\DSHWorkspace\dsh-qq-channel\lib\index.js`）与 Hermes 参考实现；**未对 QQ 官方文档逐条核证**（见 §10）。

| 项 | 事实 | 证据 |
|---|---|---|
| token | `POST {tokenUrl}`，体 `{appId, clientSecret}`，回 `{access_token, expires_in}`；提前 120s 过期；单飞共享 | v1 `:504-517`、`:519-526` |
| 网关 | WS `{gatewayUrl}`；连上收 `{op:10,d:{heartbeat_interval}}` | v1 `:2031`、`:2053-2061` |
| IDENTIFY | `{op:2, d:{token, intents, shard}}`，`intents = (1<<25)|(1<<26)`（群/C2C 事件 + INTERACTION） | v1 `:527-536` |
| 心跳 | `op:1, d:lastSeq`，间隔 `Math.round(heartbeat_interval * 0.8)` | v1 `:2059`、`:2056` |
| RESUME | `{op:6, d:{token, session_id, seq}}` | v1 `:2035-2040` |
| close 分类 | 4004 清 token(5s) / 4008 保 session(60s) / 4009 保 session(5s) / 4003,4005 清 session(1s) / 4006,4007,4900-4913 清 session(5s) / 4001,4002,4010-4014,4914,4915 致命停 / 其他 5s | v1 `:2090-2120` |
| 熔断 | 存活 <5s 连断 3 次 → 等 60s | v1 `:2121-2132` |
| 发消息 | `POST {apiBase}/v2/users/{openid}/messages` 或 `/v2/groups/{gid}/messages` | v1 `:623-625` |
| 报文体（markdown） | `{msg_type:2, markdown:{content}, keyboard?, msg_id?, msg_seq?, message_reference?}`；**`msg_seq` 每条都要给** | v1 `:637-644`；Hermes `adapter.py:2777-2790` |
| 报文体（纯文本） | `{content, msg_type:0, msg_seq, msg_id?, message_reference?}`（**同样要带 `msg_seq`**；私聊不并用 `message_reference` —— 采用现役策略，与 Hermes 的差异见下） | v1 `:645-650`；Hermes `adapter.py:2786-2795` |
| 🔴 **被动回复窗口**（`REVIEW-1 §三 M1` 纠正） | 收到消息后 **5 分钟内**，**每条**出站消息都可带 `msg_id`（**不再**"同一 `msg_id` 只用一次"）；每条配**唯一 `msg_seq`**（0..65535），契约只保证 **`(msg_id,msg_seq)` 不重复** | Hermes 每次发送都带 `msg_seq` + `msg_id`（证据见下表后注）；v1 的 `usedPassiveMsgIds`（`:434`/`:634`/`:696`）**不采用** |
| 降级 | 响应含 `40054005`/`msgseq` → 改主动消息重发；markdown 失败回退纯文本 | v1 `:679-690` |
| 交互 | `INTERACTION_CREATE` → 先 `PUT {apiBase}/interactions/{id}` `{code:0}` → 再校验操作者 → 再回传 | v1 `:833-840`、`:893`、`:898` |
| 操作者字段 | `group_member_openid` / `user_openid` / `data.resolved.user_id` | v1 `:808-823` |
| `button_data` | 构造 `approve:<id>:<outcome>`（`:778`）、`question:<id>:<index>`（`:801`）；解析正则均**锚定**（`:845`、`:874`） | v1 同左 |
| 键盘结构 | `keyboard.content.rows[].buttons[] = {id, render_data:{label,visited_label,style}, action:{type:1, data, permission:{type:2}, click_limit:1}}`；`click_limit:1` 才是"点过即灰" | v1 `:774-793`（**无 `click_limit`**）；Hermes `keyboards.py:57-90` |
| 上传链 | `upload_prepare` → 分片 `PUT presigned_url` → `upload_part_finish`（**体必须带 `upload_id`**）→ `/files{srv_send_msg:true}` | v1 `:1921-1952`；Hermes `chunked_upload.py:456-459`、`:507` |
| 上传错误码 | `40093001` = `upload_part_finish` **瞬时可重试**；`40093002` = 当日累计限额 = **永久失败**（进 `failed/`） | Hermes `chunked_upload.py:18-22`、`:50-51` |
| 上传读取 | **不整文件进内存**：`statSync` 大小上限 + 分片读取（`fh.seek(offset)` / `fh.read(length)`）；哈希单遍流式，`md5_10m` 只吃前 `_MD5_10M_SIZE` 字节 | Hermes `chunked_upload.py:548-550`、`:559-586`；现役整文件读入（`readFileSync`）见 v1 `:1903` |
| 附件下载鉴权 | **只对预期域名**带 `Authorization: QQBot <token>`（P2-16）；QQ 给的 URL 不能无条件附带 bot token（v1 `:1805-1808`/`:1840-1843` 是无条件带头的反例） | 设计约束（Round 2 文件链，`DESIGN.md §2.10.2`） |
| 目录 | 日志/outbox/inbox/lock 均在 `$DSH_HOME/storages/`（默认 `~/.dsh`） | v1 `:74`、`:78`、`:1884-1888`、`:343-344`、`:361`、`:379` |
| `md5_10m` | **已裁决：取前 10,002,432 字节**（具名常量 `_MD5_10M_SIZE`）；小于该长度时 `md5_10m` = 全文件 md5 | Hermes `chunked_upload.py:66-67`、`:585-586`（详见 §10.1） |

**M1 的证据（逐行核）**：Hermes `adapter.py:2777-2790`（`_build_text_body` 每次发送都带 `msg_seq`）、
`:2568-2569` / `:2590-2591` / `:2969-2970`（`reply_to` 存在即设 `body["msg_id"]`）、`:944-949`（`_next_msg_seq` = `(time_part ^ rand) % 65536`）；全仓无"已用额度"记录。

**M3 的语义边界**：`permission.type=2` = "所有人可点"（不是权限，也不提供防重复能力，`keyboards.py:59-63`）；`click_limit=1` = 平台级"点过即灰"（`keyboards.py:75`/`:82`/`:88-89`）；
`render_data.visited_label` = 点后文案（`:98-109`）。**服务端校验仍是唯一防线**（见 `DESIGN.md §2.10.1`）。

**M4 的 `md5_10m` 出处注释（逐字）**：`# First 10,002,432 bytes used for the md5_10m hash (per QQ API spec).` + `_MD5_10M_SIZE = 10_002_432`（`chunked_upload.py:66-67`）。

### 8.1 验收台注意（Round 2 会用到）

- 验收台 `mock-qq.mjs`（134 行）**要求**：连上 WS 后发 `op:2`/`op:6` 才算 IDENTIFY（`:79-86`）；默认 `boot()` 以"收到 IDENTIFY"为启动完成条件（`run-scenarios.mjs:69`、`:71-72`）。
  → **凡 `run-scenarios.mjs` 的 A 场景都跑在 `boot()` 之后**，因此**任何 QQ 侧未接通骨架的实现，在该台上都会停在 boot 阶段**。这是本轮"QQ 留 Round 2"的直接后果（见 DESIGN §边界与 §11）。
- **降级开关 `SKIP_QQ=1`**（`run-scenarios.mjs:69-75`）：`boot()` 不再等 `IDENTIFY`，用于"只实现 DSH 侧"的中间态；
  本轮骨架在其台上也只是"能启动不挂"——**依赖 QQ 入站流量的场景（A1–A9、A14–A18）本轮必然失败**（`DESIGN.md §5.2` open-1）。
- A16（键盘结构）额外要求 `action.click_limit === 1` 与 `render_data.visited_label` 存在（`run-scenarios.mjs:352-370`），**而 v1.2.4 并未发 `click_limit`**（v1 `:774-793` 无该字段）→ 属 v2 新增要求。
- A20（v2 目标）要求窗口内**每条**出站消息都带 `msg_id`、`msg_seq` 为整数且 `(msg_id,msg_seq)` 唯一（`run-scenarios.mjs:237-252`）；
  A9（core）只要求首条带 `msg_id`（`run-scenarios.mjs:221-235`）。→ 两条一起定出 `DESIGN.md §2.3.4` 的端口契约（D17）。

---

## 9. 与本任务书 / 既有规格不符之处

逐条列"任务书或裁决所写"与"源码事实"的差异，**一律以源码为准**。

| # | 出处 | 原文/要求 | 源码事实 | 处置 |
|---|---|---|---|---|
| 9.1 | 任务书 §5.5 | `session/follow` 有"起始 seq"参数 | 无该参数（`types.d.ts:416-422`） | 裁决已作废；设计改"重开 follow + 比对 cursor 补页" |
| 9.2 | 任务书 §5.6 / 审查报告 P2-18 | "`mode` 不是宿主概念…要么省略要么注释说明" | `mode` **必填**，取值仅 `'queue'\|'steer'`；省略 → `gateway/input-invalid` | **设计必须显式传 `mode:'queue'`**（行为 = followup） |
| 9.3 | 任务书 §5.2 | 协议不匹配 = "404、`gateway/arguments-invalid`" | 未知方法 = **HTTP 404 + 纯文本，无 code**；`gateway/arguments-invalid` 只在 args 键不符时出现（HTTP 200） | 两者分别识别，各自成态 |
| 9.4 | 验收台 mock | `gateway/unknown-method` 用于未知方法 | **真实宿主无此码**（grep 0 命中），是 mock 的简化 | 客户端**两种都要识别**（以状态码为主、code 为辅） |
| 9.5 | 任务书 §5.2 | 401 与其它错误并列处理 | 401 是**纯文本响应、无 JSON body** | 401 判定只能看状态码 |
| 9.6 | 任务书 §5.4 | `$events` 承载审批与提问 | 审计事件 `approval/asked\|decided` **不在** `$events` 白名单 | 必须经 `session/follow` 取审计 → 成为架构约束 |
| 9.7 | 任务书（隐含） | 回传成功即"点了有用" | `$events/result` 对未知 `eventId` **静默返回 ok** | 必须本地结清 + 审计兜底，不能只看返回码 |
| 9.8 | 任务书 §4 | 设置注册要兼容 `installSettingsSection`（旧） | DSH 0.1.5-rc.2 全仓库**无该符号** | 保留防御分支（旧宿主未验证，见 §10） |
| 9.9 | 裁决 §2 | "v1 没有 follow，才退回 `events.mux` 广播" | 一致；且验收台对非 `/api/remote.mux` 的 upgrade 记 `rejectedUpgrades`（`mock-dsh.mjs:179-183`） | v2 下**不得**触碰 `events.mux` |
| 9.10 | 任务书 §5.5 | 会话事件 envelope 形如 `{seq,type,data}` | 实为 `{type, seq, time, data, ignorable?, sourceEventSeqs?, surfaceOp?}` | 按实际字段实现（`time` 必读、另三个可选） |
| 9.11 | 裁决 §4 / 任务书 §4 / 批次档 §1.3 N7 | "18 个配置键" | v1.2.4 `Config` 实测 **17 个键**（逐字见 §9.13）；任务书与裁决自己列出的清单也是 17 项 | 兼容基线 = **17 键**；N7 的"18"是计数错误，须改为 17（否则该条无法机判） |
| 9.12 | 任务书 §2 | v1.2.4 = 2284 行 | 实测 **2234 行** | 行号以实测为准 |

### 9.13 v1.2.4 的 17 个配置键（逐字，兼容基线）

`enabled`(bool,true) · `appId`(string|number→String,'') · `clientSecret`(secret,'') · `token`(secret,'') ·
`tokenUrl`('https://bots.qq.com/app/getAppAccessToken') · `gatewayUrl`('wss://api.sgroup.qq.com/websocket') ·
`apiBase`('https://api.sgroup.qq.com') · `sessionId`('') · `allowedGroups`([]) · `allowedUsers`([]) ·
`groupMembers`([]) · `ack`(true) · `markdown`(true) · `perSourceSessions`(false) · `keyboardApprovals`(false) ·
`maxChunk`(2000) · `maxReplyChunks`(4)。
证据：v1 `:46-68`。命名空间 `qq-channel`（v1 `:44`）；导出面 `name`/`Config`/`inject`/`apply`（v1 `:44`、`:46`、`:70`、`:82`，`inject = []`）。

### 9.14 对接方两份档之间的一处冲突（以 `REVIEW-1` 为准）

`thincoder-v2-qq-spec.md` §3 写"**同一 `msg_id` 只有一次被动回复机会**（用掉后必须降级为主动消息），现役（首条带 `msg_id`，其余不带）是对的"，
与 `REVIEW-1 §三 M1` 直接冲突。源码事实支持后者：Hermes **每次**发送都带 `msg_seq`，`reply_to` 存在即带 `msg_id`，且全仓无"已用额度"记录
（`adapter.py:2777-2790`、`:2568-2569`、`:944-949`）。

| 出处 | 原文 | 源码事实 | 处置 |
|---|---|---|---|
| 9.14 | 对接方 `thincoder-v2-qq-spec.md` §3 | "同一 `msg_id` 只有一次被动回复机会" | Hermes 每条回复都带 `msg_id` + 唯一 `msg_seq`（见左） | **以 `REVIEW-1 §三 M1` 为准**；本档 §8「被动回复窗口」行、`DESIGN.md §2.3.4`（D17）按窗口模型落档 |

> 本节的双方档冲突已报给主 agent（修正轮报告）：对方两份档同期不一致，建议保留本节作为裁决留痕。

---

## 10. 未验证项（**不许猜**，逐条列）

| # | 项 | 现状 | 影响 |
|---|---|---|---|
| 10.1 | `md5_10m` 的字节数 | **已裁决（2026-09-16）**：`10_002_432` 正确，**不要**改成 `10485760`（Hermes 具名常量 + 出处注释，`chunked_upload.py:66-67`）；且小于该长度时 = 全文件 md5（同文件 `:585-586`） | 仅 A15/A17（Round 2 文件链）：实现采用**具名常量 + 出处注释**（注释逐字见 §8 后注） |
| 10.2 | 旧设置 API `installSettingsSection` 的真实签名 | 本机只有 0.1.5-rc.2，该符号不存在；形态只能从 v1 调用点反推（v1 `:133`） | 影响 DSH ≤0.1.1 的设置注册；保留防御分支 |
| 10.3 | v1（DSH ≤0.1.1）协议细节 | 未对旧宿主核证；事实来自 v1.2.4 反推（`/api/session.list`、`/api/respond`、`/api/events.mux`） | 影响双协议兼容；v1 分支标"依据反推" |
| 10.4 | 宿主原始 TS 源码 | 不随包发布；本档 TS 行号来自 `typert.host.js` 的 `sourceLocation` 元数据 | 参数名已由生成物 `wire` + `signature` 双重印证，可信 |
| 10.5 | `$events` 上审批帧的真机 dump | 帧字段集已由 `stream-protocol.d.ts` + 客户端校验器确认，但**未真机抓帧** | 建议 Round 2 真机抓一次 |
| 10.6 | zod 是否丢弃未知内层字段（P2-17） | **已裁决（2026-09-16 真机，来源 `REVIEW-1 §二.7`）**：额外键被**容忍但剥离**（`inboxPath` → 不报错、等于没传）；非法 `mediaType` → `gateway/input-invalid`；退化/过小图片（1×1 PNG）→ `session/attachment-invalid` | 已定论：image 块**不带**额外字段（路径改走 text part）；退化图片必须有**文本兜底**（§6 实测边界、`DESIGN.md §2.8` P2-17） |
| 10.7 | QQ 侧全部字段 | 仅对 v1.2.4 + Hermes 参考实现核证，**未对官方文档逐条核证** | Round 2 前应补文档核对 |
| 10.8 | 审批/提问路径是否有内置超时 | 源码未见超时；上层（tool call timeout policy / turn 超时）未调查 | 影响"卡片永远挂着"的兜底策略（本地 TTL 必须有） |

---

## 11. 变更记录

- 2026-09-16：初版。基于 DSH 0.1.5-rc.2 源码 + 验收台（mock-dsh 291 行 / run-scenarios 397 行 / mock-qq 134 行 / fake-ctx 53 行）逐条取证；
  记录 9 条与任务书不符（含 `mode` 必填、未知方法无 code、审计事件不经 `$events` 三条会改变设计的差异），8 条未验证项。
- 2026-09-16（修正轮，`REVIEW-1`）：§5.1/§5.2/§5.4 游标断言限定为"真正的空日志"+ 接入真机实测（`lib/index.js:1378`）；
  §6 补 image 块实测边界；§8 被动回复窗口（M1）/`click_limit`（M3）/文件链（M4）行重写，§8.1 补 `SKIP_QQ`/A16/A20；
  §9.14 记对方两份档之间的冲突（以 REVIEW-1 为准）；§10.1、§10.6 改为已裁决；§0.2 指纹表按 2026-09-16 04:2x 重核。
  证据来源：Hermes `gateway/platforms/qqbot/{adapter.py,keyboards.py,chunked_upload.py}`（逐行核）+ `thincoder-v2-live-verified.md`。

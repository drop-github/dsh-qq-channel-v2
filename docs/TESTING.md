# 测试速查（v2.0.0）

四层测试，从上到下越接近真实环境。**L1–L3 不需要配置 QQ 凭据、不联网、不碰 3080**；只有 L4 打真机。

| 层 | 测什么 | 耗时 | 是否需真机 |
|---|---|---|---|
| L1 单元 + 集成 | 纯逻辑（协议、会话、pending、格式、配置） | ~28s | 否 |
| L2 验收台 | 25 个端到端 mock 场景（收发/审批/上传/重连/宿主重建） | ~4min | 否 |
| L3 配置兼容 | 17 键与 v1 逐字一致、归一化行为一致 | <5s | 否 |
| L4 真机现网 | 正在运行的宿主 + 插件日志 + QQ 网关 READY | <20s | 是（宿主在跑） |

---

## L1 单元 + 集成测试（130 例）

```powershell
cd E:\DSHWorkspace\dsh-qq-channel-v2
node --test --test-isolation=none
```

预期：`pass 130 / fail 0 / skipped 0`，无网络访问。

> 2026-09-20 新增 1 例（`T-Q5`，点击回执必须走被动窗口）：线上反馈「点了按钮没任何反馈」——
> 根因是 `onInteraction` 里的回执用 `{kind,openid}` 目标直发，**没有 msg_id** → 退化成
> 「主动消息」，额度用尽时被 QQ 直接丢弃；而且这条路径失败是静默的（没检查返回值）。
> 现在回执复用该会话最近一条入站的被动窗口（`state.replyTarget` 的 msgId），失败记
> `<what> failed to send`。审批的「已批准 ✅」是同一个毛病，一并修了（`T-I11` 补 msg_id 断言）。
> 反向验证：把被动 msgId 摘掉，`T-Q5` 与 `T-I11/A6` 双红。

> 2026-09-20 新增 5 例（`test/question-flow.test.js`，提问编排直测）：
> 逐问推进、凑齐才一次性回传、回传失败弹掉刚记的答案且可重试、**没人作答的草稿由 sweep 回收**
> （条目过期/取消即清、活着的不动）、没有回复目标时报 error 而非静默丢弃、
> 键盘只给「单问题 + ≤4 选项」。配套：`channel` 的 sweep 定时器也回收提问草稿
> （此前"问了没人答"会在内存里留一份）；交给宿主的 `answers` 改成**副本**，
> 免得失败路径 pop 草稿时把已提交的载荷一起改掉。

> 2026-09-20 新增 4 例（提问作答：选项 / 自由输入 / 多问题逐问）：
> `T-Q1`（回数字选选项）、`T-Q2`（**直接打字**走 `answers[].custom`）、
> `T-Q3`（多问题拆成一个个问，凑齐才一次性回传）、`T-Q4`（没有待答提问时普通文本不被误吞）。
> 背景：v2.0.0 的 QQ 侧只认数字，多问题/自由输入会退回"请到电脑 GUI 处理"，
> 人不在电脑前就答不了；DSH 的作答协议本来就有 `custom` 字段，这次把它接上。
> 配套：`test/helpers/mock-dsh.mjs` 新增 `requestQuestion()`（waterfall
> `user-questions/request`）；文本作答从 `handlers/qq.js` 抽到 `handlers/text-answer.js`，
> 多问题编排在 `session/question-flow.js`。

> 2026-09-17 新增 4 例（待补发队列的僵尸与泄漏）：
> `T-W10`（忙时"并入等待"的消息在合并轮送达后必须清出队列 —— 原来没人清，
> 每次启动都误报 `pending inbound messages restored`，直到 48h TTL）、
> `T-W11` + `inbox-store` 的 `dropWhere`（启动时清掉"来源身份重算过、永远补发不到"的
> 老记录并留痕）、`source-session` 的 `unreachablePendingReason` 判定（判不了就保守留着）。
> 另把 v1 帧映射从 `channel.js` 拆到 `protocol/v1-frames.js`（组装根回到 400 行预算内），
> 顺手补上这条路径此前缺失的直测 `test/v1-frames.test.js`。

> 2026-09-17 新增 1 例（T-W10，待补发队列泄漏）：忙时"并入等待"的入站消息会落盘，
> 但合并轮送达后没人清它 —— 表现为**每次启动都误报** `pending inbound messages restored`
> （真机上 17:18 的一条在 17:53、17:58 两次启动各误报一次），直到 48h TTL 才自愈。
> 修法是让落盘 id 跟着 `state.inboundQueue` 一起走、由合并轮成功提交时统一清；
> 用例断言"并入的那条在合并轮送达前不许清、送达后必须清"，摘掉合并轮的接线即转红。

> 2026-09-17 新增 12 例（回归 v1 → v2 漏迁的两项）：
> `test/source-session.test.js`（UUIDv5 身份推导，含 RFC 4122 测试向量）、
> `test/lock.test.js`（实例锁：接管陈旧锁 / 拒绝活持有者 / 心跳 / 降级）、
> `test/restart-stability.test.js`（端到端：同一来源跨"重启"复用同一会话身份且不重放历史；
> 另一活实例持锁时本实例待机、一个 IDENTIFY 都不发）。
> 配套：`test/helpers/mock-dsh.mjs` 的 `session/create` 现在遵守调用方自带的 `sessionId`
> （与宿主 `createOrAdopt` 的幂等语义一致），并新增 `state.creates` 记录。

> **必须有 `--test-isolation=none`。** 默认隔离模式由 Node 测试运行器用管道
> spawn 子进程执行每个用例文件；在受限沙箱下管道创建被拒，表现为每个文件都报
> `Error: spawn EPERM`（看起来像 10 个用例全红，其实一个都没跑）。加了这个 flag
> 后在单进程内执行，既不需要放宽沙箱，也更快。
>
> 另注：`node --test test/`（带目录参数）在 Node 26 下会被当成模块路径，报
> `MODULE_NOT_FOUND`——不要带路径，直接在仓库根跑。

## L2 验收台（25 个端到端场景，私有资产）

```powershell
cd E:\DSHWorkspace\qq-channel-verify
$env:PLUGIN_PATH='E:\DSHWorkspace\dsh-qq-channel-v2\lib\index.js'
$env:MODE='v2'
node run-scenarios.mjs
```

预期：`total 25, failed 0`；`MODE=v2` 时含 A19–A25 七个 v2 专属场景。
想看单条失败细节就通读输出里的 `FAIL` 行，场景名即缺陷范围。

## L3 配置兼容（对照 v1）

```powershell
cd E:\DSHWorkspace\qq-channel-verify
node verify-config-compat.mjs E:\DSHWorkspace\dsh-qq-channel-v2\lib\index.js
```

预期：末行 `CONFIG-COMPAT OK`。

## L4 真机现网（切换/重启后必跑）

```powershell
cd E:\DSHWorkspace\qq-channel-verify
node verify-live-cutover.mjs 2.0.0
```

预期：12 项全 `PASS` + `CUTOVER-VERIFY OK`，判据写入
`E:\DSHWorkspace\dsh-cutover-verify.txt`。它检查：token→cookie、`/api` 可达、
`qq-channel.log` 可读、本次启动的 `bridge up` 版本号、事件通道已建立、控制流就绪、
`QQ READY`、无明文凭据、无致命错误。

### 一键跑 L1–L3（顺序驱动 + 汇总）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File E:\DSHWorkspace\qq-channel-verify\verify-round.ps1 `
    -PluginDir E:\DSHWorkspace\dsh-qq-channel-v2 -ExpectVersion 2.0.0
```

> 该脚本内部调 `node --test`（走默认隔离）与验收台，在受限沙箱下会因 `spawn EPERM`
> 误报 L1 失败；在正常 shell 或放宽沙箱下运行才可信。日常快查用 L1 的
> `--test-isolation=none` 单条命令，汇总用 `-Quick`（只跑语法/行长/配置兼容）。

---

## 出问题看哪里

| 现象 | 先看 |
|---|---|
| 真机收不到回复 | L4 输出哪一项 FAIL；再看 `~/.dsh/storages/qq-channel.log` 的 `bridge up` / `follow stream attached` / `QQ READY` |
| 审批点了没反应 | 日志搜 `event result post failed` |
| 启动日志报"待补发"但其实没丢过消息 | `~/.dsh/storages/qq-channel-pending.json` 里的僵尸条目（T-W10 泄漏，已修；残留条目靠 48h TTL 或手工 `remove` op 清） |
| 文件没发出去 | `~/.dsh/storages/qq-channel-outbox/failed/`；日志搜 `40093002`（当日限额）/ `40093001`（可重试） |
| 本地改完想回归 | L1 → L3 → L2；动到协议/会话层再加 L4 |

## 回退验证

`E:\DSHWorkspace\qq-channel-verify\rollback-to-v1.ps1` 可把 profile 指回 v1 并重启；
回退后 L4 的版本断言应变成 v1.2.x（用它反证 L4 的版本检查真的有效）。

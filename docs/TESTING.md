# 测试速查（v2.0.0）

四层测试，从上到下越接近真实环境。**L1–L3 不需要配置 QQ 凭据、不联网、不碰 3080**；只有 L4 打真机。

| 层 | 测什么 | 耗时 | 是否需真机 |
|---|---|---|---|
| L1 单元 + 集成 | 纯逻辑（协议、会话、pending、格式、配置） | ~28s | 否 |
| L2 验收台 | 25 个端到端 mock 场景（收发/审批/上传/重连/宿主重建） | ~4min | 否 |
| L3 配置兼容 | 17 键与 v1 逐字一致、归一化行为一致 | <5s | 否 |
| L4 真机现网 | 正在运行的宿主 + 插件日志 + QQ 网关 READY | <20s | 是（宿主在跑） |

---

## L1 单元 + 集成测试（73 例）

```powershell
cd E:\DSHWorkspace\dsh-qq-channel-v2
node --test --test-isolation=none
```

预期：`pass 73 / fail 0 / skipped 0`，无网络访问。

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
| 文件没发出去 | `~/.dsh/storages/qq-channel-outbox/failed/`；日志搜 `40093002`（当日限额）/ `40093001`（可重试） |
| 本地改完想回归 | L1 → L3 → L2；动到协议/会话层再加 L4 |

## 回退验证

`E:\DSHWorkspace\qq-channel-verify\rollback-to-v1.ps1` 可把 profile 指回 v1 并重启；
回退后 L4 的版本断言应变成 v1.2.x（用它反证 L4 的版本检查真的有效）。

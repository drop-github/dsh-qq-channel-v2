# VERIFY：Round 1 该跑什么命令、预期看到什么

- 批次：`round-1-design-skeleton` · 日期：2026-09-16
- 本档由 eng-coder 负责产出（本批任务书 §1.9 D7）；**本轮因门禁故障未能产出代码**（见
  `docs/ROUND-1-REPORT.md` §五 与批次档 §3.3），故本档当前形态 = **"代码落地后即可执行的验收脚本清单"**，
  并在 §0 如实标注"当前无任何可执行产物"。

---

## §0 当前状态（先读这一节，别照着跑空）

| 项 | 状态 |
|---|---|
| `lib/**` 代码骨架 | ❌ **不存在**（未创建） |
| `test/**` 用例 | ❌ **不存在**（未创建） |
| `package.json` / `cordis.patch.yml` / `.gitignore` / `README.md` | ❌ 不存在 |
| 可执行的自测 | **无** —— 本轮唯一产物是文档（`docs/**`） |

原因（一条）：机内设计评审 `advisor(type='design')` 机械故障 → `designToken` 未签发 →
`eng-coder` 被机械拒绝（错误原文见 `docs/ROUND-1-REPORT.md` §四）。按任务书 §0 明令**未绕过门禁**。

→ 因此**本轮请勿执行** §1–§3 的任何命令（它们必然因文件缺失而失败）；这些命令是为"代码落地后的下一轮"准备的。

---

## §1 代码落地后：自测三件套

工作目录：`E:\DSHWorkspace\dsh-qq-channel-v2`

### 1.1 单元 + 集成测试（主证据）

```powershell
cd E:\DSHWorkspace\dsh-qq-channel-v2
"D:\Program Files\nodejs\node.exe" --test test/
```

预期（对接方口径 AC1）：

- 末尾 `# pass N` / `# fail 0`，N ≥ 41（`DESIGN.md §3.1` 的 T-U1–T-U31 + T-I1–T-I11）；
- **不得**出现 `# skipped` 非零（任务书 §3.7：不许跳过用例）；
- 全程**无网络**、不触碰 3080、不读真实 DSH 配置（mock 自建本地端口）。

### 1.2 逐文件语法检查（AC2 / N6）

```powershell
cd E:\DSHWorkspace\dsh-qq-channel-v2
Get-ChildItem -Recurse -Filter *.js -Path lib,test | ForEach-Object {
  & "D:\Program Files\nodejs\node.exe" --check $_.FullName
  if ($LASTEXITCODE -ne 0) { Write-Host "FAIL $($_.Name)" }
}
Write-Host "check done"
```

预期：无 `FAIL` 行；每个文件静默通过（`node --check` 成功不打印任何东西）。

### 1.3 结构性约束（AC3 / AC4 / AC7 / AC8）

```powershell
cd E:\DSHWorkspace\dsh-qq-channel-v2
# ① 每文件 ≤400 行（N3）
Get-ChildItem -Recurse -Filter *.js -Path lib,test |
  ForEach-Object { [pscustomobject]@{ F=$_.FullName.Replace($PWD,''); L=(Get-Content $_).Count } } |
  Where-Object { $_.L -gt 400 } | Format-Table
# ② 依赖面（N4）：dependencies 只允许 ws + @deepseek-ai/schemastery
(Get-Content package.json -Raw | ConvertFrom-Json).dependencies
# ③ 配置键 17 个（N7）：见 §2 的断言
# ④ 文档无 >300 字符单行（N8）
Get-ChildItem docs -Recurse -Filter *.md |
  ForEach-Object { $f=$_; (Get-Content $_ ) | Where-Object { $_.Length -gt 300 } |
    ForEach-Object { "$($f.Name): $($_.Length)" } }
```

预期：① 空表；② 仅 `ws` 与 `@deepseek-ai/schemastery`；④ 空（本仓 `docs/DESIGN.md` 最长 275、
`docs/PROTOCOL.md` 最长 290、批次档最长 283 —— 已合规；`docs/REVIEW-1.md` 是对接方文件，不在 N8 管辖内）。

---

## §2 配置兼容（对接方 `verify-config-compat.mjs` 的对位）

代码落地后，我方 `test/config.test.js` 必须断言键集**逐字等于**下列 17 个（**不是 18 个**，对接方 open-4 已裁定）：

```
enabled, appId, clientSecret, token, tokenUrl, gatewayUrl, apiBase, sessionId,
allowedGroups, allowedUsers, groupMembers, ack, markdown, perSourceSessions,
keyboardApprovals, maxChunk, maxReplyChunks
```

附加断言：`appId` 同时接受 `string` 与 `number`（YAML 裸数字），归一化为 `string`；
设置命名空间 = `qq-channel`；`installSection`（新）与 `installSettingsSection`（旧）双兼容，失败记日志并退化为行配置。

---

## §3 对接方验收台（我方不自评，仅列命令）

```powershell
$env:PLUGIN_PATH='E:\DSHWorkspace\dsh-qq-channel-v2\lib\index.js'
$env:SKIP_QQ='1'    # 仅 DSH 侧中间态（跳过等 QQ IDENTIFY）
$env:MODE='v2'      # Round 2 收尾时必须
node E:\DSHWorkspace\qq-channel-verify\run-scenarios.mjs
```

**重要范围事实（已写入 `DESIGN.md §3.3` 与批次档 §1.5）**：该台的场景靠 `t.qq.c2c(...)`
驱动入站流量（`run-scenarios.mjs:99` 等），`SKIP_QQ=1` 只跳过"等 `IDENTIFY`"（`run-scenarios.mjs:69-75`），
**不会**为无 QQ 层的实现补出入站通路。
→ 因此对 Round 1 骨架（不含 QQ 网络层）而言，**A1–A9、A14–A18 必然失败**，这是范围裁决的结果，不是缺陷。
本轮自证证据以 §1 的 `test/` 套件为准。

---

## §4 判据汇总（对照 `DESIGN.md §3.2` 的 AC1–AC12）

| # | 判据 | 命令 |
|---|---|---|
| AC1 | `node --test` 全绿且用例数达标 | §1.1 |
| AC2 | 全部 `.js` 过 `node --check` | §1.2 |
| AC3 | 每文件 ≤400 行 | §1.3① |
| AC4 | 依赖面恰为 `ws` + `schemastery` | §1.3② |
| AC5 | 无空 `catch {}`；发送/回传调用点均 `await` 结果 | 静态检查（评审逐点核） |
| AC6 | 日志/输出无 launch token 明文 | `test/integration.test.js` 的 T-I2 |
| AC7 | 17 键逐字一致 + `appId` string\|number | §2 |
| AC8 | 文档无 >300 字符单行 | §1.3④ |
| AC9 | A1–A5、A10–A13 的 DSH 侧行为可复现 | `test/integration.test.js` 的 T-I1–T-I11 |
| AC10 | `lib/qq/` 为端口契约 + 空实现，Round 2 落点明确 | 目录检查 + `lib/qq/README.md` |
| AC11 | 事件白名单：未知类型静默且不断流 | `test/session.test.js` |
| AC12 | 被动回复契约 `(msgId,msgSeq)` 唯一（Round 2 落地） | Round 2 |

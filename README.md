# dsh-qq-channel（v2.0.0）

把 QQ 官方机器人接到 DSH（DeepSeek Harness）会话上的 Cordis 插件：在手机 QQ 里给机器人发消息，就能驱动你电脑上的 agent；审批、提问、图片与文件双向都能在 QQ 里完成。

- 双协议：DSH ≥ 0.1.5（typert 网关，`session/follow` 事件流）与 DSH ≤ 0.1.1（`events.mux`）都支持，自动探测。
- 事件不丢：以 `session/follow` 为主事件源（宿主保证不丢帧），断线/宿主重建时用 `session/page` 的 `beforeSeq` 向前补页对账。
- 审批闭环：网关事件 id 与宿主审计 id 分开保存并配对；QQ 侧点击、电脑端处理都会得到**恰好一条**结果通知。
- 凭据卫生：任何 token/secret 只以指纹或长度入日志；附件下载只对 QQ 官方域名携带凭据。
- 模块化：`lib/` 按协议层 / 会话层 / QQ 层 / 处理层拆分，单文件 ≤ 400 行，零构建、纯 ESM。

## 安装

```bash
# 1) 把本仓库链接进 profile（路径按你的实际目录替换）
dsh plugin --profile web add link:/path/to/dsh-qq-channel-v2

# 2) 重启 DSH（插件在启动时加载）
```

安装后插件名仍为 `dsh-qq-channel`，配置命名空间仍为 `qq-channel`，**与 v1 完全兼容**（可直接替换，无需改配置）。

## 配置（17 个键）

在 DSH Web 设置页的「插件」卡片里填写（密钥字段会自动脱敏），或写进 `$DSH_HOME/settings.yaml` 的 `qq-channel:` 段。

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | bool | `true` | 关掉后不启动通道 |
| `appId` | string\|number | — | QQ 机器人 AppID（YAML 里写裸数字也接受） |
| `clientSecret` | secret | — | QQ 机器人 AppSecret |
| `token` | secret | `''` | 可选：直接给定网关鉴权 token（否则用 appId/secret 换取） |
| `tokenUrl` | string | `https://bots.qq.com/app/getAppAccessToken` | 取 token 的地址 |
| `gatewayUrl` | string | `wss://api.sgroup.qq.com/websocket` | QQ 网关地址 |
| `apiBase` | string | `https://api.sgroup.qq.com` | QQ REST 基地址 |
| `sessionId` | string | `''` | 单会话模式：固定驱动的 DSH 会话；留空则自动挑最近活跃的主会话 |
| `allowedUsers` | string[] | `[]` | 允许私聊的 user_openid 白名单（空 = 不限制） |
| `allowedGroups` | string[] | `[]` | 允许的群 group_openid 白名单（空 = 不限制） |
| `groupMembers` | string[] | `[]` | 群成员白名单；非空时只有这些成员的消息会被处理 |
| `ack` | bool | `true` | 收到消息先回一句「已收到」 |
| `markdown` | bool | `true` | 用 QQ Markdown（`msg_type 2`）回复 |
| `perSourceSessions` | bool | `false` | 每个来源（私聊/群成员）一个独立 DSH 会话 |
| `keyboardApprovals` | bool | `false` | 审批/提问用 QQ 内嵌键盘按钮 |
| `maxChunk` | number | `2000` | 单条消息最大字符数（按码点切分） |
| `maxReplyChunks` | number | `4` | 一条回复最多分几块 |

## 信任域（请务必理解）

- **`perSourceSessions: false`（默认值）= 单一信任域**：所有来源共用一个 DSH 会话。审批/提问属于高权限交互，此模式下只允许 `allowedUsers[0]`（主人私聊）代答，群里其他人无法批准。
- **推荐改成 `perSourceSessions: true`**：每个来源独立会话，审批只能由触发该会话的来源回答；这是更安全的用法。
- `allowedUsers` / `allowedGroups` / `groupMembers` 三者共同决定"谁能驱动 agent"。生产使用请**至少**配置 `allowedUsers`。
- 键盘按钮的 `click_limit` 只让 QQ 把按钮置灰，**不是安全边界**；真正的判定在插件服务端（同一审批重复点击不会重复执行）。

## 运行期目录（`$DSH_HOME/storages/`）

| 路径 | 用途 |
|---|---|
| `qq-channel.log` | 运行日志（不含明文凭据） |
| `qq-channel-outbox/` | **发件箱**：把文件丢进来，插件会分片上传并发到主人私聊；成功后移入 `sent/`，永久失败移入 `failed/` |
| `qq-channel-inbox/` | **收件箱**：QQ 发来的图片/附件存盘位置（无视觉能力的模型可据此走 OCR/元数据兜底） |
| `qq-channel-sources.json` | per-source 模式的来源→会话映射 |

## 自测与验收

```bash
node --test          # 73 个单元测试（纯逻辑）
node --check lib/index.js
```

本插件在开发期还跑过一套 25 个场景的端到端 mock 验收（收发、审批往返与重复点击、电脑端回补、提问、图片、文件、断线重连、宿主重建、设置竞态）。那套台子不在本仓库内，属于私有验证资产。

## 兼容性与回退

- 支持 DSH ≤ 0.1.1 与 ≥ 0.1.5；协议自动探测，探测失败会明确区分「401 缺 cookie」与「参数键不符（arguments-invalid）」，不会误判降级。
- 回退：把 profile 依赖指回上一版目录（如 `link:/path/to/dsh-qq-channel`）并重启即可；v1.2.6 已打标签。

## 排障

| 现象 | 先看哪里 |
|---|---|
| QQ 能发消息但收不到回复 | `qq-channel.log` 是否有 `bridge up` / `event stream: ...` / `control stream opened`；再看 `QQ READY` |
| 启动时报设置相关告警 | 宿主设置服务可能晚就绪（真机实测约 1s），插件会自动重试注册（最多 24 次 × 500ms）并应用已存配置；若最终仍失败会退回行配置并记 `settings registration exhausted — using row config`（`warn`，见 REVIEW-2 的 D4：此场景建议升为 `error`，因为它通常意味着拿不到已存凭据） |
| 审批点了没反应 | 日志搜 `event result post failed`（回传失败会保留待处理并提示重试） |
| 文件没发出去 | `qq-channel-outbox/failed/` 里是否有该文件，日志搜 `40093002`（当日限额）或 `40093001`（可重试） |

## 许可

MIT

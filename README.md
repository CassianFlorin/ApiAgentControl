# ApiAgentControl

让 API key 方式启动的 Codex（Desktop / CLI / VSCode 插件）会话能被移动端实时查看与控制。

架构：`[手机 App] ←→ [中继层] ←→ [电脑侧 daemon] ←→ [Codex 会话]`

**MVP 已完成**：电脑侧 daemon（监听 + 控制）、端到端加密中继、iOS App、推送通知，
全链路已在真实数据上验证。唯一还需你提供的是 APNs 凭证（见 [docs/push.md](docs/push.md)），
配上即可在真机收到推送。

```
[iOS App] ←加密→ [中继] ←加密→ [daemon] ←→ [Codex Desktop / CLI 会话]
                                    └──────→ [APNs] ──→ [iOS App]
```

## codex-watchd（监听 + 控制 daemon）

零依赖 Node.js（需 Node ≥ 20，macOS）。两条通道互补：

- **只读通道**：监听 `~/.codex` 下的会话落盘文件，零侵入覆盖**所有来源**
  （Desktop / CLI / VSCode 插件），包括别人在 Desktop 里手工开的会话。
- **控制通道**：托管 `codex app-server` 子进程（官方 JSON-RPC 协议），
  发指令、打断、远程审批。详见 [docs/control-protocol.md](docs/control-protocol.md)。

```bash
node daemon/codex-watchd.js [--home ~/.codex] [--port 8787] [--bind 127.0.0.1]
                            [--verbose] [--no-server] [--no-control] [--no-auth]
```

启动后终端会打印**带 token 的调试页地址**，直接打开即可。

启动后：

- **stdout**：人类可读的彩色实时日志
- **`http://127.0.0.1:8787/`**：浏览器调试页（左侧项目/会话树 + 审批按钮，右侧实时流）
- **`GET /events`**：SSE 事件流。支持 `?session=<id>` 只订阅单个会话、
  `?kinds=a,b,c` 按类型降噪、`?replay=N` 回放最近 N 条
- **`GET /sessions?limit=100&active=1`**：会话列表，含状态/项目/worktree/未读数
- **`GET /sessions/:id/history?before=<seq>&limit=100`**：会话历史回填。
  `seq` 是事件在会话文件中的**字节偏移量**，既是游标也是稳定序号 ——
  实时流的事件带同一个 `seq`，客户端据此去重、断线后续拉，不需要另建序号体系。
  从文件尾部反向分块读取（最大会话实测 25MB / 7000 行，整份加载不可接受）
- **`GET /projects?days=3`**：首页视图，对齐 Codex Desktop 侧栏的三段结构
  （置顶 / 项目 / 最近），见 [docs/desktop-sidebar.md](docs/desktop-sidebar.md)

会话与事件在 App 中如何分类，见 [docs/app-model.md](docs/app-model.md)。
首页分组直接复用 Desktop 侧栏结构，见 [docs/desktop-sidebar.md](docs/desktop-sidebar.md)。
让手机在任意网络下连上 daemon，见 [docs/relay.md](docs/relay.md)。
推送通知与 APNs 配置，见 [docs/push.md](docs/push.md)。
「需要我处理」如何判断（含一处协议不提供信号、只能启发式的地方），见 [docs/waiting-detection.md](docs/waiting-detection.md)。

### 鉴权与权限档位

默认启用。首次运行在 `~/.codex-watchd/auth.json`（0600）生成本机 token。
凭证通过 `Authorization: Bearer <token>` 传递；SSE 只能用 `?token=`，
因为浏览器的 `EventSource` 不支持自定义请求头。

**三个档位按风险分级**，因为它们的危险程度差一个数量级：

| 档位 | 能做什么 | 风险 |
|---|---|---|
| `read` | 看会话、事件流、项目列表 | 低 |
| `approve` | 批准/拒绝 Codex 已提出的具体命令 | 低——动作空间被模型限死，只能对眼前的命令说是或否 |
| `control` | 发送任意指令、新建线程、打断 | **等同远程 shell**，设备丢失即机器失守 |

`approve` 能批准 Codex 提出的具体命令，但**不能回复文字**。
而实测中最常见的「卡住等我」并不是结构化审批，而是**模型用文字问了你一句然后停下** ——
那种情况只能回文字，也就必须是 `control`。所以想在手机上真正接着干活，就得给 `control`；
`approve` 适合只想放行命令、不想交出输入能力的场景。

```bash
node daemon/codex-watchd.js --add-device 我的手机 --scope approve
node daemon/codex-watchd.js --pair --relay ws://... --pair-scope approve
node daemon/codex-watchd.js --list-devices
node daemon/codex-watchd.js --revoke-device <id>
```

`--add-device` 与 `--pair` **默认都是 `read`**，提权必须显式指定。
（曾把 `--pair` 默认设成 `approve`，等于每次配对都悄悄多发一档权限。）

**档位以服务端为准**：客户端通过 `GET /me` 获知**当前**档位，而不是一直信任配对串里的快照 ——
凭证被吊销或调降后，只信快照的客户端会显示自己其实没有的权限，
还会渲染出点了必然失败的按钮。

**为什么本地回环也要鉴权**：`Content-Type: text/plain` 的跨站 POST 属于 CORS
"简单请求"、不触发预检。此前接口带通配 `Access-Control-Allow-Origin: *`，
意味着你浏览任意网页时，那个网页就能向 `127.0.0.1` 的控制接口投递指令——
响应它读不到，但命令已经在你机器上执行了。现已移除通配 CORS，并加了两道防线：
拒绝携带外部 `Origin` 的请求（挡 CSRF）、校验 `Host` 头（挡 DNS rebinding）。

**暴露到网络时**：`--bind 0.0.0.0` 会自动把本机各网卡 IP 纳入合法 Host；
Tailscale MagicDNS 等主机名用 `--allow-host mac.tailnet.ts.net` 显式放行。
`--bind` 非回环地址 + `--no-auth` 的组合会被**拒绝启动**——失败要失败在安全的一侧。

### 验证 daemon 是否正常

```bash
node daemon/selftest.js
```

在隔离的临时目录里跑，**不读写你的 `~/.codex`**，可安全反复执行。共 40 项：
鉴权（缺失/错误/正确 token）、/me 档位、CSRF、DNS rebinding、冷文件检测延迟、跨会话时序、
45KB 首行元数据解析、半行写入还原、项目分组、归档不重放/不进默认视图、
CLI(item_completed) 格式解析、子代理过滤、审批详情归一化、历史回填分页、
等你回复的识别、推送触发规则、未读清零、中继房间记账。

**默认关闭 `fs.watch`、只测轮询路径**——这是刻意的：`fs.watch` 在安静的小目录树里
永远好用，会掩盖轮询侧的缺陷。用户遇到的"续接的会话监听不到"当初就是这样躲过测试的；
加上仅轮询模式后，立刻暴露出冷文件检测其实要 8s（已修）。加 `--with-fswatch` 可测叠加路径。

自检本身的有效性已用故意注入回归的方式验证过：把首行读取改回 16KB、去掉跨文件排序、
恢复冷文件降频，三种情况分别被检出 2 / 1 / 3 处失败。

### 控制接口

| 接口 | 说明 |
|---|---|
| `GET /threads?limit=&cursor=&search=` | 线程列表（app-server 视角，比 `/sessions` 更丰富，支持分页/搜索） |
| `POST /threads` `{cwd, approvalPolicy?, model?}` | 新建线程 |
| `POST /threads/:id/turns` `{text}` | 发送指令 |
| `POST /threads/:id/interrupt` | 打断当前 turn（无活跃 turn 时 409） |
| `POST /threads/:id/steer` `{text}` | 向进行中的 turn 追加引导 |
| `GET /approvals` | 待审批列表 |
| `POST /approvals/:id` `{decision}` | 答复审批：`allow` / `allow_always` / `deny` / `abort` |

`GET /approvals` 与 `approval_request` 事件都会带上归一化后的可读字段
（`title` / `command` / `cwd` / `reason` / `network`）。**手机上必须看得见批的是什么** ——
盲批比不批更危险。协议里这些字段散在新旧两套方法、三种审批类型的不同字段名下
（v2 的 `commandActions` vs 旧版 `parsedCmd`，文件修改的 `fileChanges`…），
统一在 [daemon/approvals.js](daemon/approvals.js) 里处理。

审批决策对外统一为上面四个语义值，daemon 内部映射到各方法各自的协议枚举
（v2 的 `accept`/`decline`，旧版 `execCommandApproval` 的 `approved`/`denied`）——
这两套枚举不通用，混用会被静默当成拒绝。

远程审批闭环示例（已实测）：线程以 `approvalPolicy: "untrusted"` 创建 → 模型请求执行命令 →
daemon 挂起并经 SSE 广播 `approval_request` → 客户端 `POST /approvals/:id {"decision":"allow"}`
→ 命令实际执行 → `approval_resolved` 事件回流。

### 监听原理（基于实测确认的 Codex 落盘行为）

| 路径 | 内容 |
|---|---|
| `~/.codex/sessions/YYYY/MM/DD/rollout-*-<uuid>.jsonl` | 会话正文，逐行事件。CLI / Desktop / VSCode 插件**共用同一格式**，`session_meta.originator` 区分来源 |
| `~/.codex/archived_sessions/` | 归档会话，同格式 |
| `~/.codex/session_index.jsonl` | 会话索引（id → 线程标题），用于会话目录 |

关键行为：

- **续接的旧会话会追加写回原文件**（按创建日期归档的目录里的文件会在数天后继续增长），因此必须递归监听整个 `sessions/` 树，daemon 对每个文件维护字节偏移量做尾随。
- 行可能被分次写入（半行），daemon 缓存尾部残行到下次拼接。
- 新出现的 `.jsonl` 视为新会话，从头读取；存量文件从 EOF 开始只流增量。
- **`fs.watch` 单独用不可靠**：macOS FSEvents 在密集写入时会合并/丢失文件级事件，实测出现过只收到前两条事件后再无更新。因此 **轮询是主检测手段，fs.watch 只是加速器**：每 2s stat **全部**已跟踪文件，每 5 分钟重扫全树捕获跨天/移动的文件。
- **不要对轮询做分级**：曾按"是否近期活跃"把沉寂文件降频到 10s，结果续接旧会话的检测延迟回升到 8s（`fs.watch` 掩盖了这点，只有仅轮询模式才暴露）。实测 67 个文件的全量 stat 仅 **1ms**，分级纯属过早优化。
- **续接旧会话曾有最长 30s 的检测延迟**（已修复，现 ≤2s）。原因是续接会写回**原始文件**，而它在旧日期目录里，daemon 启动时是"冷"的，此前只能等全量慢扫。表现为"打开之前创建的会话，监听不到"。
- **跨会话事件必须合批排序**：多个会话并行时 `fs.watch` 会为每个文件分别触发，若各自立即读取并发出，全局流会按"文件读取顺序"而非时间顺序涌出，时间戳来回跳几十秒。daemon 把待读文件累积 200ms 后合并读取、跨文件按 `ts` 排序再发出。
- **归档的会话默认不该出现**：`archived_sessions/` 也在监听范围内（归档会话仍可能被续接），但归档是用户主动做的动作。`/sessions` 与 `/projects` 默认过滤掉它们，`?archived=1` 才返回。
- **归档会移动文件，不能当成新会话**：归档把 rollout 从 `sessions/` 移到 `archived_sessions/`。偏移量按路径记录，若不识别"同一会话换了位置"，新路径会被当成新文件从头重放整个历史——一个 20MB 的会话能瞬间灌出上万条"新"事件。
- **`session_meta` 首行约 45KB**（内含完整 base_instructions），读文件头解析元数据时必须循环读到换行符，一次读 16KB 会解析失败——症状是所有会话的项目归属都是 `unknown`。
- `~/.codex/sqlite/codex-dev.db` 中存在尚未启用的线程存储表（`thread_timeline_ledger` 等，目前为空）。未来 Codex 版本可能从 JSONL 迁移到 SQLite，读取层应保持可替换。

### 归一化事件模型

SSE 输出的每个事件形如：

```json
{ "ts": "...", "session_id": "<uuid>", "file": "sessions/...", "kind": "...", ... }
```

| kind | 来源（rollout type / payload.type） | 附加字段 |
|---|---|---|
| `session_meta` | `session_meta` | `cwd, originator, provider, source, cliVersion` |
| `user_message` | `event_msg/user_message` | `text` |
| `assistant_message` | `event_msg/agent_message` | `text` |
| `reasoning` | `event_msg/agent_reasoning` | `text` |
| `tool_call` | `response_item/{function,custom_tool}_call` | `name, args`（截断） |
| `tool_result` | `response_item/*_call_output` | `output`（截断） |
| `turn_started` / `turn_complete` / `turn_aborted` | `event_msg/task_*` 等 | `last_message` |
| `thread_status` | 控制通道 `thread/status/changed` | `status, waitingOnUserInput, waitingOnApproval` |
| `turn_context` | `turn_context` | `model, cwd, approval_policy, effort` |
| `compacted` | `compacted` | — |
| `approval_request` | 控制通道（服务端请求） | `approval_id, method, detail` |
| `approval_resolved` | 控制通道 | `approval_id, decision, mapped` |
| `ctl_error` | 控制通道 | `method, detail` |

`response_item` 里的 `message` / `reasoning` 与 `event_msg` 重复，默认跳过；
`token_count`、`thread_settings_applied` 等低价值事件仅在 `--verbose` 时输出。

## Roadmap

1. ~~只读监听 daemon~~（codex-watchd 原型完成）
2. ~~反向控制通道调研~~（完成，见 [docs/control-protocol.md](docs/control-protocol.md)：无需逆向，
   `codex app-server` 官方 JSON-RPC 协议已端到端验证——外部进程可 list/start/resume 线程、
   发送 turn、接收事件流，与 Desktop 共享线程存储）
3. ~~daemon 集成控制通道~~（完成：托管 app-server 子进程 + 断线重启，
   发指令/打断/引导/远程审批全部实测通过）
4. ~~daemon 鉴权~~（完成：token + 三档权限 + CSRF/DNS-rebinding 防护 + 失败关闭的绑定规则）。
   配合 Tailscale 已可用手机直连：`--bind 0.0.0.0 --allow-host <你的-tailscale-域名>`
5. ~~中继层~~（完成：daemon 主动外连、X25519 + AES-GCM 端到端加密、配对串、
   手机模拟器验证全链路，见 [docs/relay.md](docs/relay.md)）
6. ~~手机 App~~（完成：配对、项目/会话列表、会话详情、远程审批、发指令，
   见 [ios/README.md](ios/README.md)）
7. ~~审批详情 + 历史回填~~（完成：审批卡片显示命令/目录/原因；会话可往上翻页，
   事件带字节偏移量作游标，实时流与历史共用）
8. ~~推送通知~~（完成：daemon 直连 APNs、零依赖 ES256 签名、通知不含任何会话信息、
   模拟器验证投递与跳转。见 [docs/push.md](docs/push.md)。**真机需你提供 APNs 凭证**）
9. ~~收尾~~（未读清零、daemon 重启后仍能打断、App 图标、404 统一 JSON）

## 还没做的

- **真机运行**：只在模拟器验证过。需要你的签名 Team 和自己的 Bundle ID。
- **中继正式部署**：现在跑在本机。手机出了家门要连，得部署到 VPS 或 Cloudflare（见 [docs/relay.md](docs/relay.md)）。
- **多台电脑**：所有接口隐含单机，家里+公司两台需要 hostId 维度。
- `thread/resume` 一个**正被 Desktop 打开**的线程时，写锁行为未实测。

## 已知待验证

- `thread/resume` 一个**正被 Desktop 打开**的线程时，写锁（`~/.codex/thread-writer-locks/`）的行为未测。
  已确认锁确实生效：daemon 持有线程时 `codex delete` 会失败，需先停 daemon。
- daemon 重启后 `activeTurns` 丢失，此时 `interrupt` 会返回 409（无活跃 turn 记录）。

# 反向控制通道调研结论（2026-08-11 实测）

结论先行：**不需要逆向任何私有协议**。Codex CLI 内置了官方的 app-server JSON-RPC 协议，
自带 schema 生成器，且与 Desktop 共享线程存储。已在本机完成端到端验证：
外部进程 → `codex app-server` → 新建线程 → 发送指令 → 模型（custom API 提供方）执行并回复 → 事件流回传。

## 各 socket / 通道的身份鉴定

| 通道 | 身份 | 结论 |
|---|---|---|
| `~/.codex/ipc/ipc.sock` | ChatGPT.app（Codex Desktop 宿主进程）持有的 **IDE 上下文发现 IPC**（二进制内字符串：`codex-ipc`、`client-discovery-response`、`ide-context`），服务于 VSCode 插件互发现 | ❌ 不是控制通道，直接写 JSON-RPC 会被断开（broken pipe） |
| `~/.codex/app-server-control/app-server-control.sock` | `codex app-server daemon` 管理的常驻 daemon 控制 socket | ⚠️ 需要 standalone 安装（`~/.codex/packages/standalone/`），本机未装 |
| **`codex app-server`（stdio / `--listen unix://PATH` / `ws://IP:PORT`）** | 官方 app-server，JSON-RPC over NDJSON | ✅ **采用此路线**，homebrew 版 CLI 直接可用 |

另有 `codex remote-control`（start/stop/pair，短时效配对码）——官方自己正在做的远控功能，
说明该协议就是为"外部客户端控制本机 Codex"设计的，方向合法且长期受支持。

## 协议要点

获取完整 schema（246 个 v2 方法/通知的 JSON Schema + TS 绑定）：

```bash
codex app-server generate-json-schema --out <dir>
codex app-server generate-ts --out <dir>
```

传输：每行一条 JSON（NDJSON），JSON-RPC 2.0 风格 `{id, method, params}`。

### 实测验证过的握手与调用序列

```jsonc
// 1. 握手（experimentalApi 开启后才能用 v2 方法）
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "clientInfo":{"name":"apiagentcontrol","version":"0.1.0"},
  "capabilities":{"experimentalApi":true}}}
{"jsonrpc":"2.0","method":"initialized","params":{}}

// 2. 列出线程（与 Desktop 看到的完全一致，可按 cwd/provider/标题过滤、分页）
{"jsonrpc":"2.0","id":2,"method":"thread/list","params":{"limit":20,"sortKey":"recency_at"}}

// 3. 新建线程 → 发指令
{"jsonrpc":"2.0","id":3,"method":"thread/start","params":{"cwd":"/path/to/project"}}
{"jsonrpc":"2.0","id":4,"method":"turn/start","params":{
  "threadId":"<id>","input":[{"type":"text","text":"..."}]}}

// 4. 事件以通知回流：item/completed（userMessage / reasoning / commandExecution /
//    agentMessage）、turn/completed 等
```

### 对 App 最有价值的方法（均在 v2 schema 中）

- 会话：`thread/list`、`thread/read`、`thread/resume`、`thread/fork`、`thread/archive`
- 指令：`turn/start`（发消息）、`turn/interrupt`（打断）、`turn/steer`（追加引导）
- 审批：服务端请求 `commandExecutionRequestApproval` / `fileChangeRequestApproval` /
  `execCommandApproval` 等，客户端答复即可实现**手机端远程审批**
- 移动直连备选：`codex app-server --listen ws://IP:PORT --ws-auth capability-token`
  ——官方支持 WebSocket + token 鉴权，中继层甚至可以做薄

## 审批决策枚举（易错，务必注意）

**两套枚举并存且不通用**，用错会被静默视为拒绝（实测：给 v2 方法回 `allow`，
模型收到的是"权限请求被拒绝"，命令未执行）：

| 方法 | 允许 | 始终允许 | 拒绝（继续本轮） | 中止本轮 |
|---|---|---|---|---|
| `item/commandExecution/requestApproval`、`item/fileChange/requestApproval`（v2） | `accept` | `acceptForSession` | `decline` | `cancel` |
| `execCommandApproval`、`applyPatchApproval`（旧版） | `approved` | `approved_for_session` | `{denied:{rejection:"..."}}` | `abort` |

daemon 对外统一暴露 `allow` / `allow_always` / `deny` / `abort`，内部按方法名映射。

## 踩坑记录

- `thread/start` 后如果从未跑过 turn，线程不落盘；换个进程 `thread/resume` 会报
  `no rollout found`。**同一连接内完成 start→turn**，或以常驻进程维持连接。
- **写锁确实存在**：daemon 的 app-server 持有某线程时，外部 `codex delete --force` 会
  `failed to delete session`，停掉 daemon 后即可删除。对应 `~/.codex/thread-writer-locks/`。
  由此推断 resume 一个正被 Desktop 打开的线程存在竞争风险，仍需专门实测。
- `turn/interrupt` 需要 `turnId`，只能从 `turn/start` 响应或 `turn/started` 通知中获得 —— 
  daemon 需自行维护 threadId → 当前 turnId 的映射（进程重启后丢失）。
- 本机 homebrew codex-cli 0.147.0，Desktop（ChatGPT.app 宿主）为 0.147.0-alpha —— 版本需保持大体同步。

## 对架构的影响

电脑侧 daemon 的最终形态 = **常驻进程，同时握两个通道**：

1. **JSONL watcher**（已完成，codex-watchd）—— 零侵入监听所有来源（Desktop/CLI/VSCode）的会话内容
2. **app-server 子进程**（本文档验证）—— 新建/续接线程、发指令、打断、审批

两通道天然互补：watcher 覆盖"别人发起的会话"（Desktop 里人工开的），app-server 覆盖"App 发起的控制"。

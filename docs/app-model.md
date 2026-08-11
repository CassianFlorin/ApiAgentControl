# App 内容分类与信息架构设计

设计前提来自真实使用场景实测：本机 3 天内有 **33 个会话、分布在 6 个项目**，
其中 `example-service` 一个项目就有 **14 个并行会话**，各自跑在独立的 git worktree 里。
所以"一个扁平的会话列表"必然不可用——手机屏幕上 14 条同名项目的条目无法分辨。

## 一、分类的三个正交维度

不要把它们混成一个列表，它们回答的是不同问题：

| 维度 | 回答的问题 | 取值 |
|---|---|---|
| **归属**（在哪） | 这个任务属于哪个代码库？ | `project` + `worktree` |
| **状态**（要不要管） | 现在需要我吗？ | `waiting_approval` / `running` / `idle` / `aborted` / `error` |
| **来源**（谁开的） | 是我在 Desktop 手工开的，还是 App 发起的？ | `originator`（Codex Desktop / CLI / VSCode） |

**排序永远由"状态"主导，而不是时间。** 时间只是同状态内的次级排序。
一个等审批 40 分钟的会话必须排在 10 秒前刚回复的会话之前。

### 归属：worktree 必须折叠到项目

用户的 cwd 形如 `~/.codex/worktrees/6d98/example-service`。
如果按 cwd 分组，14 个并行任务会散成 14 个"不同项目"，完全看不出关系。
daemon 的 `projectOf()` 因此从 worktree 路径中提取**仓库名**作为 project，
把 worktree 短哈希作为会话的副标题。实测效果：

```
example-service (14)   ← 一个项目
  ├ 【加急】【0812上线】库存判断逻辑优化   wt:6d98
  ├ 【进】【0820上线】地址返回参数优化  wt:b05c
  └ 表单校验优化                                wt:03e3
```

会话标题来自 `session_index.jsonl`（Codex 自己生成的线程名），
已经是人类可读的任务名，直接用，不要自己造摘要。

## 二、状态机

由事件流驱动（daemon 的 `applyEventToSession`）：

```
user_message / turn_started ──→ running
approval_request ────────────→ waiting_approval  ← 唯一需要推送通知的状态
approval_resolved ───────────→ running
turn_complete ───────────────→ idle
turn_aborted ────────────────→ aborted
ctl_error ───────────────────→ error
```

**只有两个状态值得打扰用户**：

1. `waiting_approval` —— 会话卡住了，**在等你**。这是推送通知的核心场景，
   也是整个产品相对"云任务管理"的最大差异化：本地会话的审批目前必须回到电脑前才能点。
2. `running → idle` 的跃迁（turn 完成）—— 任务干完了，可以看结果了。

`running` 中间态不推送，否则一个会话一轮能推十几条。

## 三、三层页面结构

```
[项目列表]  →  [会话列表]  →  [会话详情]
 /projects     (项目内)        /events?session=<id>
```

### 第 1 层 · 项目列表（首页）

数据源 `GET /projects?days=3`。每个项目卡片显示：项目名、`attention` 数（等审批）、
`running` 数、最近活动时间。排序规则已在 daemon 内实现：
**attention 降序 → running 降序 → 最近活动降序**。

顶部固定一个「需要我处理」区，横跨所有项目聚合 `waiting_approval` 的会话——
用户打开 App 的第一诉求就是"有没有事等我"，不应该要求他逐个项目点进去找。

### 第 2 层 · 会话列表（项目内）

数据源 `GET /sessions?active=1`（只看活跃）或全部。每条显示：
状态徽章、线程标题、worktree 短哈希、最后一条助手消息摘要（`lastAssistantMessage`）、
未读数（`unread`）、来源图标。

### 第 3 层 · 会话详情

数据源 `GET /events?session=<id>&replay=200`（daemon 已支持按会话过滤 SSE）。
底部是输入框 → `POST /threads/:id/turns`；运行中额外露出「打断」→ `/interrupt`。

## 四、事件在详情页里的呈现分级

一个 turn 会产生大量事件，全平铺在手机上没法看。实测一个 turn 的构成：
`reasoning` 9 条、`tool_call` 6 条、`tool_result` 6 条、`assistant_message` 仅 2 条。
**噪音是信号的 10 倍**，必须分级：

| 层级 | 事件 | 默认呈现 |
|---|---|---|
| 主线 | `user_message`、`assistant_message` | 完整展示，聊天气泡 |
| 进度 | `tool_call`、`tool_result` | 折叠成一行"🔧 执行了 6 个命令"，可展开 |
| 内部 | `reasoning` | 默认隐藏，开关控制 |
| 状态 | `turn_started/complete`、`turn_context` | 细分隔线，不占气泡 |
| 阻塞 | `approval_request` | **置顶卡片 + 操作按钮**，不进流水 |
| 噪音 | `usage`、`settings` | 不显示（daemon 侧 `--verbose` 才产出） |

客户端可用 `GET /events?kinds=user_message,assistant_message,approval_request`
让 daemon 侧就过滤掉噪音，省流量——移动网络下这很实际。

## 五、daemon 已提供的对应接口

| App 需求 | 接口 |
|---|---|
| 首页项目分组 | `GET /projects?days=3` |
| 会话列表 / 只看活跃 | `GET /sessions?limit=&active=1` |
| 会话详情实时流 | `GET /events?session=<id>&replay=200` |
| 按类型降噪 | `GET /events?kinds=a,b,c` |
| 待办审批聚合 | `GET /approvals` |
| 审批操作 | `POST /approvals/:id {"decision":"allow"}` |
| 发指令 / 打断 | `POST /threads/:id/turns` \| `/interrupt` |

会话对象字段：`id, title, status, project, worktree, cwd, originator, provider,
model, lastActivity, lastUserMessage, lastAssistantMessage, unread, pendingApproval`。

## 六、待补

- `unread` 目前只在 daemon 内累加，没有"已读"回写接口；App 接入时需要
  `POST /sessions/:id/read`。
- 跨设备多 daemon（家里 + 公司两台电脑）时需要 `hostId` 维度，
  目前所有接口都隐含"单机"。Codex 自己的 SQLite 里已有 `host_id` 概念可参考。

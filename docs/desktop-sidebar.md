# 对齐 Codex Desktop 的侧栏组织

App 首页不再自己推导分组，而是直接复用 Desktop 侧栏里**用户自己整理出来的**结构：
置顶 / 项目 / 最近。之前按 cwd 末段分组只是碰巧和项目名对上，仓库改名或同名就会错乱，
而且完全拿不到「置顶」和用户排的顺序。

数据源：`~/.codex/.codex-global-state.json`（Desktop 的 Electron 持久化状态，约 157KB）。
纯 CLI 用户没有这个文件，此时自动退回按 cwd 推导。

## 三段结构

| 段 | 数据来源 | 排序 |
|---|---|---|
| 置顶 | `pinned-thread-ids` | **数组顺序即显示顺序**，不按时间重排 |
| 项目 | `local-projects`（id / name / rootPaths）+ 会话 cwd 匹配 | 组内按最近活动 |
| 最近 | 其余会话 | 按最近活动，平铺不分组 |

项目归属的匹配：cwd 落在某个 `rootPaths` 下即归入该项目；并行任务常跑在
`~/.codex/worktrees/<hash>/<repo>`，此时用 `<repo>` 与项目 rootPath 的末段比对。

## 踩过的坑

**别用 `unified-sidebar-pinned-order-v1`。** 名字看起来才是"顺序"，实际含过期条目：
实测里有一条**已归档**的会话和一条早已取消置顶的会话仍留在其中，
还会把 UI 里新建的会话记成临时 id（`client-new-thread:*`，需经 `thread-client-id-v1` 还原）。
照它渲染会多出 Desktop 根本不显示的条目。`pinned-thread-ids` 才是解析好的权威列表 ——
实测 11 条与侧栏逐条逐序完全一致。

**别自己判断哪些会话该显示，问 Codex。** 一开始我按 `session_meta.thread_source != "user"`
过滤子代理线程，结果误伤了一条真实会话 —— 它由用户的另一个会话派生
（`thread_source: subagent`），但用户能在 Desktop 里直接看到、还把它置顶了。
**能被用户直接看到的就应该出现在列表里**，而这个判断只有 Codex 自己做得准。

正确做法：调用 app-server 的 `thread/list`（不带 `sourceKinds` 时的默认口径就是
Desktop 侧栏用的那套），把返回的 id 集合当作可见性依据，60s 刷新一次。
实测它返回 28 条，既包含那条被置顶的 subagent，也包含 CLI 交互会话，
同时排除压缩/审阅之类的内部线程。控制通道关闭时才退回 `thread_source` 粗判。

数据对照（142 个会话文件）：`Codex Desktop|subagent` 78、`Codex Desktop|user` 55、
`codex_exec|user` 5、`codex-tui|user` 2、`Codex Desktop|system` 2。
其中官方口径判定可见的 28 条 = Desktop 24 + codex-tui 2 + system 1 + subagent 1。
`codex_exec`（脚本化非交互运行）不算对话，Desktop 也不显示。

## CLI 会话是另一套事件格式

`codex-tui` 的会话把内容包在 `event_msg` / `item_completed` 里，item 有
`UserMessage` / `AgentMessage` / `Reasoning` / `CommandExecution` / `FileChange` 五类，
文本在 `item.content[].text`；而 Desktop 用的是 `user_message` / `agent_message`
加 `response_item`。**只认后者的话，CLI 会话在列表里只有一串 UUID、
实时流里几乎什么都看不到** —— 两套形态都要归一化。

标题推导也要跟着走两条路径。另外启动时的扫描只覆盖已有内容的文件，
daemon 运行期间新建的会话必须在收到第一条用户消息时补标题，否则会一直显示 UUID。

**标题缺失要兜底。** `session_index.jsonl` 只覆盖被命名过的线程，实测 68 个会话里
40 个没有标题。现在从 session_meta 之后限量扫描（≤512KB）取第一条用户消息当标题。
需要跳过机器注入的消息：`<heartbeat>` 之类的标记，以及 fork/压缩时注入的
`The following is the Codex agent history…` 前缀 —— 否则列表里会出现一排一模一样的条目。

## App 侧的对应处理

分组骨架来自 daemon，**客户端不能在本地重新分组**，否则用户排的置顶顺序会被冲掉。
收到事件时只就地更新会话数据与计数（`ProjectGroup.preservesOrder` 标记置顶段不参与重排）；
出现任何分组里都没有的新会话时，才向 daemon 重新要一次结构（1.5s 合并窗口，
避免一轮对话里连着拉好几次）。

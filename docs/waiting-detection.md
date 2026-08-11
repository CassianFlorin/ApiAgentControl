# 「在等我」是怎么判断的

App 首页的「需要我处理」要回答一个问题：**哪些会话卡住了、在等我**。
这件事比想象中麻烦，因为 Codex 停下来等人有两种完全不同的形态，
而协议只对其中一种给了明确信号。

## 两种「在等你」

| 形态 | 协议信号 | 用户要做的动作 |
|---|---|---|
| 结构化审批 | `item/commandExecution/requestApproval` 等服务端请求；线程 `activeFlags` 含 `waitingOnApproval` | 点允许 / 拒绝 |
| **模型用文字问你** | **没有任何信号** | 回一段文字 |

`ThreadActiveFlag` 只有两个取值：`waitingOnApproval` 和 `waitingOnUserInput`。
名字看起来第二个正好对应"等你回文字"，但**实测并非如此**：

让模型问一句话然后停下，线程状态变化是 `active → idle`，
`waitingOnUserInput` **始终为 false**：

```
{"kind":"thread_status","status":"active","waitingOnUserInput":false,"waitingOnApproval":false}
{"kind":"thread_status","status":"idle",  "waitingOnUserInput":false,"waitingOnApproval":false}
```

`waitingOnUserInput` 对应的是工具显式索要输入（`item/tool/requestUserInput`）那种结构化场景，
不是模型用自然语言发问。**协议层根本不区分「它问了你」和「任务干完了」——两者都是 idle。**

## 所以只能启发式，且必须偏保守

在轮次结束时看最后一句助手消息像不像在问你：

- 结尾是 `?` 或 `？`
- 或结尾 100 字内出现明确征询用语（请确认 / 请选择 / 是否要 / 要不要 / 需要我 /
  你希望 / 哪一个 / 确认一下 / 请告诉我 / 可以吗）

只看**结尾附近**，正文里提到"请确认"不算——长回复里顺带写了这类词很常见。

**宁可漏报也不能误报。** 待办区一旦被完成态的会话淹没，它就失去了全部意义
（用户打开 App 的第一诉求就是"有没有事等我"）。用 25 个真实会话验证过：
只标出 1 个（确实是提问的那个），其余 24 个完成态全部正确排除。

推断出来的会话在 UI 上标注**「推测」**，与协议给出的确定信号区分开——
不能让用户以为这是系统确知的事实。

## 权限的连带影响

回复文字 = 发送任意输入，风险等同 `control` 档位，无法降级。
所以：**`approve` 档位解决不了最常见的卡住场景**，只能处理结构化审批。
想在手机上真正接着干活，必须配 `control`。

这不是可以绕过的设计取舍——一个能发任意文字的输入框，实质就是远程 shell，
因为 agent 会照着执行。

## 状态机

```
user_message / turn_started      → running（并清除待办标记）
approval_request                 → waiting_approval  (reason=signal)
thread_status.waitingOnApproval  → waiting_approval  (reason=signal)
thread_status.waitingOnUserInput → waiting_input     (reason=signal)
turn_complete + 最后一句像问句   → waiting_input     (reason=inferred)
turn_complete + 其余             → idle
```

`thread_status` 报 idle 时**不覆盖**已有状态——否则会把 `turn_complete` 那边
刚推断出的「等你回复」冲掉（两个事件几乎同时到达）。

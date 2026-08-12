# 中继层

让手机在任意网络下连上你电脑上的 daemon。中继是条**哑管道**：它把同一房间里的
daemon 和手机配对起来转发字节，但读不懂转发的内容。

## 为什么是这个形状

**daemon 主动外连，不监听公网端口。** 这是整个设计里最重要的一条：不需要端口转发、
不用在路由器开洞、不把一个能执行任意命令的接口暴露给互联网扫描，换 Wi-Fi / 4G 也不受影响。

**端到端加密，中继只看得见信封。** 会话内容就是你的源代码，这部分不能对第三方妥协。
配对时通过 X25519 交换公钥、ECDH + HKDF 派生会话密钥，业务载荷一律 AES-256-GCM 封装。
中继能看到的只有房间 ID、时间和大小。已实测：以 client 身份接入房间的窃听者，
12 秒内截获 32 条消息，全部是密文。

**手机的请求经回环再入一次本地 HTTP。** daemon 收到解密后的请求后，
不是走单独的分支，而是对自己发起一次 `127.0.0.1` 的 HTTP 调用。
这样鉴权、权限档位、CSRF/Host 校验完全复用同一套代码路径——
给中继单开一条分支的话，两边规则迟早漂移，而漂移的那一侧就是漏洞。回环这一跳的开销可忽略。

## 用法

```bash
# 1. 起中继（VPS 上，或本机测试）
node relay/server.js --port 8090 --secret <准入密钥>

# 2. daemon 接入中继
node daemon/codex-watchd.js --relay ws://中继地址:8090 --relay-secret <准入密钥>

# 3. 配对设备（生成一次性配对串，手机扫码导入）
node daemon/codex-watchd.js --pair --relay ws://中继地址:8090 \
     --relay-secret <准入密钥> --pair-scope approve
```

配对串形如 `apiagentcontrol://pair?d=<base64url>`，内含中继地址、房间 ID、
daemon 公钥、设备 token 与权限档位。**它等同于一把钥匙，不要转发给他人**——
持有者可以接入房间；虽然没有私钥读不了历史流量，但 token 本身就是访问凭证。

手机端逻辑可参照 [relay/client-sim.js](../relay/client-sim.js)（模拟器，也是 App 的实现参考）：

```bash
node relay/client-sim.js "<配对串>" /projects?days=3
LISTEN_SEC=30 node relay/client-sim.js "<配对串>" /threads/<id>/turns POST '{"text":"..."}'
```

## 协议

WebSocket，两种角色接入同一房间：`?room=<id>&role=host|client&secret=<准入密钥>`。

中继转发的消息只有两种形状，它不解析 `env` 内部：

```jsonc
// 手机 → daemon
{ "from": "<手机公钥>", "env": { "iv": "...", "ct": "...", "tag": "..." } }
// daemon → 手机
{ "to":   "<手机公钥>", "env": { ... } }
```

`env` 解密后是请求或响应：

```jsonc
{ "id": "ab12cd34", "method": "POST", "path": "/threads/<id>/turns",
  "token": "<设备 token>", "body": { "text": "..." } }        // 请求
{ "type": "response", "id": "ab12cd34", "status": 200, "body": {...} }  // 响应
{ "type": "event", "event": { "kind": "assistant_message", ... } }      // 主动推送
```

中继自身的状态用明文通知：`host_online` / `host_offline` / `client_online` /
`client_offline` / `replaced`（同房间接入新 daemon 时顶掉旧连接，daemon 重启即此情形）。

## 已验证

| 项 | 结果 |
|---|---|
| 手机 → 中继 → daemon → Codex → 加密事件回传 | 通，`turn_started → user_message → assistant_message → turn_complete` 完整到达 |
| 权限档位在中继上同样生效 | `read` 设备发指令被拒：`insufficient scope: 需要 control，该设备为 read` |
| 中继无法读取内容 | 房间内窃听者截获 32 条，全部密文 |
| daemon 断线重连 | 指数退避重连，重连后顶掉旧连接 |

## 房间记账的两个坑（都实际踩到过）

症状都是同一个：**手机长时间显示"电脑离线"，重启 daemon 也不恢复**。

**一、替换 host 时先关旧连接会把房间删掉。** 同一房间只允许一个 daemon，
新连接要顶掉旧的。若先 `close()` 旧连接再赋值新的，`close()` 会**同步**触发旧连接的
`onClose`：它看到 `room.host` 仍是自己，于是置空，并在无客户端时把房间从表里删除；
等赋值语句执行时，房间对象已不在 `rooms` 里。表现为 daemon 明明连着、
`/health` 却显示 0 个房间，手机随后接入只会被告知"电脑离线"。
**daemon 每次重启都会踩到**（重启时手机通常没连着，正好满足"无客户端"）。
修法：先装新 host，再关旧的。

**二、陈旧闭包会删掉当前房间。** `onClose` 闭包捕获的是当时的 room 对象，
却按 id 调用 `rooms.delete(roomId)`。若房间已被新对象取代，旧连接关闭时
会把**正在用的**房间误删。修法：删除前确认 `rooms.get(roomId) === room`。

## 客户端实现的坑：别丢掉 upgrade 的 head

Node `http` 的 `'upgrade'` 事件第三个参数 `head`，装着随握手响应一起到达的、
属于升级后协议的字节。服务端在 101 之后立刻发帧时（中继就是这样：客户端一接入
就发 `host_online`），这一帧极可能与响应头合进同一个 TCP 段，从而落在 `head` 里。
**丢掉 head 就是静默丢掉第一条消息** —— 表现为"连上了但状态永远不更新"。
iOS 的 `URLSessionWebSocketTask` 内部处理了这点，所以只有 Node 侧会中招。

## 部署建议

中继推荐 Cloudflare Durable Objects：一个房间一个实例、原生 WebSocket、
全球接入、零运维，代价是 Cloudflare 能看到元数据（谁在什么时候连了多久）。
本目录的 `server.js` 是等价的自托管版本（零依赖，含最小 RFC 6455 实现），
协议一致，随时可切。生产部署务必套 TLS（`wss://`）并设置 `--secret`。

## 待办

- 断线补数：daemon 侧给事件打持久化的单调序号，手机重连时带 `since=<seq>` 拉增量，
  避免地铁里断网十分钟后丢事件。目前 daemon 只有内存里 500 条的环形缓冲。
- 推送通知（下一步）：待审批 / turn 完成时唤醒手机。推送体走密文、
  客户端本地解密后再渲染，APNs 服务器看不到内容。

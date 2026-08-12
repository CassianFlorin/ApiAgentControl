# 推送通知

没有推送，整个产品的核心场景就不成立：App 退到后台，iOS 会杀掉长连接，
而「人不在电脑前、Codex 卡住等你」恰恰只能靠推送叫醒。

## 通知里没有任何会话内容

APNs 服务器能看到推送体。而你的会话标题本身就带业务信息
（形如"【加急】【0812上线】库存判断逻辑优化"，直接暴露排期与业务模块），命令内容更敏感。

所以通知的明文部分只写：

```
有一条需要处理
打开查看
```

真实内容在你点开后，由 App 经端到端加密通道取回。**这样无需 Notification Service
Extension 和 App Group 权限，就已经是完全隐私的**——比"加密后放进推送体再由扩展解密"
更简单，隐私性相同。

推送体里仍带了一个 `e2e` 密文字段（用与该设备协商的会话密钥加密），
供以后想在通知栏直接显示解密预览时使用；现在不解也不影响任何功能。

## 为什么 daemon 直连 APNs，不经中继

- 中继是哑管道。让它参与推送，就得让它知道"什么时候该推"，等于泄漏会话动态。
- daemon 本来就要连中继，直连 APNs 不增加任何暴露面。
- 少一跳就少一处可失败、可窥探的地方。

实现零依赖：Node 内置 `http2` + `crypto` 的 ES256 签名（[daemon/push.js](../daemon/push.js)）。

## 什么时候推

只推「需要你动手」的时刻。进行中的每条都推，一轮对话能炸出几十条通知，
用户会直接关掉推送权限——那比不做还糟。

| 触发 | 通知 |
|---|---|
| `approval_request` | 需要审批 |
| `turn_complete` 且判定为等你回复 | 等你回复 |
| `turn_aborted` | 任务已中止 |

单纯"任务完成"不推。同一会话的同类通知用 `apns-collapse-id` 合并，不会刷屏。

## 你需要准备的（只有这一步需要开发者账号）

1. **APNs 鉴权密钥**：开发者后台 → Keys → 新建，勾选 Apple Push Notifications service，
   下载 `AuthKey_XXXXXXXXXX.p8`（**只能下载一次**）。记下 Key ID。
2. **Team ID**：开发者后台右上角，或 Membership 页。
3. **Bundle ID**：本项目用 `com.cassianflorin.apiagentcontrol`。需在开发者后台注册、
   勾选 Push Notifications 能力。

然后在 `~/.codex-watchd/auth.json` 里加一段（该文件权限 0600）：

```jsonc
{
  "devices": [ ... ],
  "apns": {
    "keyId": "ABCD123456",
    "teamId": "XYZ9876543",
    "bundleId": "com.cassianflorin.apiagentcontrol",
    "p8Path": "/Users/you/AuthKey_ABCD123456.p8",
    "production": false      // 用 Xcode 直接装到手机上时是 false（沙盒）
  }
}
```

daemon 启动时会打印 `推送 APNs 沙盒环境, bundle=...`；没配置则打印"未配置"并跳过。

**`production` 别搞错**：Xcode 直接安装（development 签名）必须用 `false`；
TestFlight / App Store 分发才是 `true`。用错会一直收到 `BadDeviceToken`。

## 手机侧

首次进入设置页点「开启通知」授权。App 拿到 device token 后经加密通道
`POST /devices/push-token` 交给 daemon，同时上报本机中继公钥（推送内容要用该设备的密钥加密）。

token 失效时 APNs 返回 410，daemon 会自动把它从设备记录里删掉。

## 已验证 / 未验证

**已在模拟器验证**：推送投递（系统日志确认 `pipeline completion with success`）、
锁屏与通知中心展示、多条按 App 归组、明文不含任何会话信息、点击后跳转到对应会话。

**无法在模拟器验证**：真机 APNs 链路本身（`.p8` 签名 → Apple 服务器 → 设备）。
模拟器不产生真实 device token，`xcrun simctl push` 是本地注入。
配好上面三项凭证、用 Xcode 装到真机后即可打通。

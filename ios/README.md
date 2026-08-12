# iOS App

SwiftUI，零第三方依赖（加密用系统 CryptoKit，WebSocket 用 URLSessionWebSocketTask）。

## 构建运行

```bash
open ios/ApiAgentControl.xcodeproj
```

或命令行：

```bash
xcodebuild -project ios/ApiAgentControl.xcodeproj -scheme ApiAgentControl \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

最低 iOS 17，Bundle ID `com.cassianflorin.apiagentcontrol`。换成你自己的账号时，记得同步改 `~/.codex-watchd/auth.json` 里 apns 段的 `bundleId` —— 两边必须一致。

## 配对

电脑上生成配对串：

```bash
node daemon/codex-watchd.js --pair --relay ws://<中继>:8090 --relay-secret <密钥> --pair-scope approve
```

三种导入方式，**手输不在其列**——载荷是 337 字符的 base64，实测在手机上输入会被
输入法插入空格和智能标点而失败：

1. 扫描二维码（`qrencode -t ANSIUTF8 "<配对串>"`）
2. 点击 `apiagentcontrol://` 链接（已注册 URL scheme）
3. 粘贴（解析时会剔除所有空白字符）

模拟器上可直接：

```bash
xcrun simctl openurl <UDID> "<配对串>"
```

## 结构

| 文件 | 职责 |
|---|---|
| `Crypto.swift` | X25519 + HKDF + AES-GCM，与 daemon 侧 Node 实现严格对齐 |
| `RelayClient.swift` | WebSocket 连接、加密请求/响应、Keychain 存凭证、断线指数退避重连 |
| `AppState.swift` | 会话状态机、项目分组、事件缓冲、审批队列 |
| `Models.swift` | 数据模型与事件分级规则 |
| `Views/` | 配对页、首页（项目分组）、会话详情 |

## 加密互操作

CryptoKit 与 Node 的实现必须逐字节一致，任一处不同都会解密失败。已用测试向量双向验证：

```bash
swiftc -O ios/ApiAgentControl/Crypto.swift <测试文件> -o /tmp/cryptotest
```

对齐要点（都踩过）：

- **公钥格式**：Node 导出 SPKI DER，CryptoKit 用 32 字节裸表示。
  X25519 的 SPKI 前缀固定为 `302a300506032b656e032100`，转换时加/去这 12 字节。
- **HKDF**：SHA-256，salt = roomId，info = `apiagentcontrol-v1`，输出 32 字节。
- **`crypto.hkdfSync` 返回 ArrayBuffer 而非 Buffer** —— 直接 `.toString()` 会得到
  `[object ArrayBuffer]`，daemon 侧已统一包成 Buffer。
- **AES-GCM**：12 字节 nonce、16 字节 tag，密文与 tag 分开传输，一律 base64url 无填充。

## 已在模拟器上验证

真实数据、端到端加密、经中继：

- 深链配对 → Keychain 持久化
- 首页按项目分组，真实会话列表（状态徽章、worktree 哈希、未读数、最后回复摘要）
- 会话详情：助手消息完整展示、工具调用折叠单行可展开、推理默认隐藏
- 实时事件推送（电脑上运行中的会话，事件持续流入手机）
- **远程审批闭环**：电脑触发审批 → 手机弹「需要我处理」卡片 → 点「允许」→
  命令在 Mac 上真实执行（已核验目录被创建）

## 推送

已实现，见 [../docs/push.md](../docs/push.md)。通知**不含任何会话内容**
（APNs 服务器看得到推送体），点开后由 App 经加密通道取真实内容。
模拟器已验证投递、展示、归组与点击跳转；真机链路需要你的 APNs 凭证。

## 装到真机

1. Bundle ID 已设为 `com.cassianflorin.apiagentcontrol`，Team 已配置；换账号时在 Xcode → Signing & Capabilities 改
2. 选你的 Team，勾上 Push Notifications 能力
3. `ApiAgentControl.entitlements` 里的 `aps-environment` 保持 `development`
4. 手机与 Mac 在同一网络时可直连（`--bind 0.0.0.0`），否则需要部署中继

## 已知待办

- 二维码扫描在模拟器上无摄像头，会显示降级提示（真机正常）。
- 多台电脑（家里 + 公司）需要 hostId 维度，目前隐含单机。

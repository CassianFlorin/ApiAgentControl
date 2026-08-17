# 隐私政策 · Privacy Policy

最后更新：2026 年 8 月 17 日

## 简体中文

**ApiAgentControl 不收集、不存储、不传输任何个人数据。**

本 app 没有服务器、没有账号体系。开发者不运营任何后端服务，因此**在技术上就无法
接触到你的任何数据**。所有数据只存在于两个地方：你自己的 iPhone，以及你自己部署
的后台服务。

### 数据在哪里、去哪里

| 数据 | 存放位置 | 是否离开你的设备 |
|---|---|---|
| 配对凭证（访问令牌、中继地址） | iOS 钥匙串（Keychain） | 否 |
| 会话内容（Codex 的对话、命令、输出） | 你自己的电脑 | 仅在你的设备与你自己的电脑之间传输，**全程端到端加密** |
| 相机画面 | 不保存 | 否。相机仅用于扫描配对二维码，图像不落盘、不上传 |
| 推送令牌 | 你自己部署的后台 | 仅发送给你自己的后台，不发给开发者 |

会话内容使用 X25519 密钥协商 + AES-256-GCM 加密。中继服务器（由你自己部署）以及
路径上的任何中间节点**只能看到密文**。

### 关于推送通知

推送经由 Apple 推送通知服务（APNs）投递。推送体中的可见文本**恒为占位内容**
（如「有一条需要处理」），不含任何会话标题或正文——真实内容在你打开 app 后经
加密通道取回。因此 Apple 的服务器也看不到你的会话内容。

### 我们不做的事

- 不收集使用数据、不做行为分析、不做用户画像
- 不含任何第三方 SDK、广告或追踪组件（本 app 仅使用 Apple 系统框架）
- 不要求注册、不收集邮箱或手机号
- 不将任何数据出售或分享给第三方

### 例外：Apple 自身的数据收集

通过 TestFlight 分发的测试版本，若你在系统设置中同意与开发者共享，Apple 会向
开发者提供崩溃日志与基本使用统计。这部分由 Apple 收集与提供，遵循
[Apple 的隐私政策](https://www.apple.com/legal/privacy/)，你可以随时在 TestFlight
app 中关闭。开发者仅将其用于修复缺陷。

### 源代码

本项目完全开源，上述所有说法都可以在代码中自行核实：
<https://github.com/CassianFlorin/ApiAgentControl>

### 联系方式

有任何隐私相关问题，请通过 GitHub Issues 联系：
<https://github.com/CassianFlorin/ApiAgentControl/issues>

---

## English

**ApiAgentControl does not collect, store, or transmit any personal data.**

The app has no servers and no accounts. The developer operates no backend service and
therefore has no technical means of accessing your data. All data lives in exactly two
places: your own iPhone, and the backend you deploy yourself.

### Where data lives

| Data | Stored in | Leaves your device? |
|---|---|---|
| Pairing credentials (access token, relay address) | iOS Keychain | No |
| Session content (Codex conversations, commands, output) | Your own computer | Only between your device and your own computer, **end-to-end encrypted throughout** |
| Camera frames | Not stored | No. The camera is used solely to scan the pairing QR code; images are never written to disk or uploaded |
| Push token | Your self-hosted backend | Sent only to your own backend, never to the developer |

Session content is encrypted with X25519 key agreement and AES-256-GCM. The relay server
(which you deploy yourself) and any intermediate node see ciphertext only.

### Push notifications

Notifications are delivered through Apple Push Notification service (APNs). The visible
text in the payload is **always a placeholder** (e.g. "Something needs your attention")
and never contains session titles or content — the real content is fetched over the
encrypted channel after you open the app. Apple's servers therefore cannot see your
session content.

### What we do not do

- No usage analytics, behavioral tracking, or profiling
- No third-party SDKs, advertising, or tracking components (Apple system frameworks only)
- No registration; no email addresses or phone numbers collected
- No data sold or shared with third parties

### Exception: Apple's own data collection

For builds distributed via TestFlight, Apple provides the developer with crash logs and
basic usage statistics if you consent to share them. This data is collected and provided
by Apple under [Apple's privacy policy](https://www.apple.com/legal/privacy/), and you
can opt out at any time in the TestFlight app. The developer uses it solely to fix defects.

### Source code

The project is fully open source; every claim above can be verified in the code:
<https://github.com/CassianFlorin/ApiAgentControl>

### Contact

For privacy-related questions, please open an issue:
<https://github.com/CassianFlorin/ApiAgentControl/issues>

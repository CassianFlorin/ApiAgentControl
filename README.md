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

---

# 使用手册

## 它解决什么

OAuth 登录的 Codex 云任务有官方移动端可管，但**本地会话**（Desktop / CLI，尤其是
API key 方式启动的）完全脱管——人离开电脑，会话就失联了。
最难受的是 Codex 停下来等你：等审批、或者用文字问了你一句，
而你在地铁上、在会议室，只能等回到电脑前。

这个项目就是补上这一环。

## 完全自托管，不提供任何官方服务

本项目**不提供**官方中继、不提供直连服务、没有账号体系。中继由你自己部署
（[中继部署](#中继部署) 有三个现成方案，从一条命令到 VPS 都有），
会话内容全程端到端加密——你的代码和命令只经过你自己的基础设施，
任何第三方（包括中继所在的服务器）都只能看到密文。
代价是首次配置要花十分钟；换来的是没有任何一方能看你的数据，也没有服务会停摆。

**推送是唯一的例外**：APNs 凭证按 Apple 开发者团队 + Bundle ID 锁死，
作者的推送密钥不随项目分发，也没有集中推送网关。装官方分发的包 + 自部署后台 =
除推送外全部可用；**要推送，请从源码构建**，换成自己的 Bundle ID 和 APNs
凭证（详见 [docs/push.md](docs/push.md) 的「推送的边界」）。

## 前置条件

- macOS，Node ≥ 20（`node --version` 确认）
- 已安装 Codex（`codex --version`）
- iPhone 或模拟器；装真机需要 Apple 开发者账号

## 第一次跑起来

### 0. 一键启动（推荐）

```bash
scripts/start.sh
```

顺序拉起三件套：中继（:8090）→ daemon（:8787）→ Cloudflare 隧道（公网 wss 地址），
并打印配对命令。可重复执行——已在跑的组件自动跳过，不会起第二份。
准入密钥首次运行自动生成（`~/.codex-watchd/relay-secret`），
日志在 `~/.codex-watchd/{relay,daemon,tunnel}.log`。停止：

```bash
scripts/stop.sh
```

> **隧道域名是临时的**：cloudflared 每次重启都会换域名，而配对串里嵌着地址，
> 所以隧道重启后手机要重新配对。固定域名方案见 [中继部署](#中继部署)。

跑完直接跳到第 3 步配对。下面 1–2 步是各组件的手动启动方式，
用于理解结构或单独调试。

### 1. 启动 daemon

```bash
node daemon/codex-watchd.js
```

终端会打印一个**带 token 的调试页地址**，浏览器打开就能看到实时会话流——
先用它确认 daemon 正常工作，再去折腾手机。

daemon 会自动发现 `~/.codex` 下所有会话，无论是 Desktop、CLI 还是 VSCode 插件开的。

### 2. 启动中继

手机和电脑通常不在同一网络，需要一个中继帮它们碰面：

```bash
node relay/server.js --port 8090 --secret 你自己起一个密钥
```

先在本机跑通即可。**要在外面（4G / 公司网络）用，中继得有个公网地址** ——
最省事的是一条 `cloudflared` 命令把本机中继暴露出去，不需要服务器也不需要域名，
详见下面的 [中继部署](#中继部署)。

然后让 daemon 接上它——重启 daemon 时带上参数：

```bash
node daemon/codex-watchd.js --relay ws://中继地址:8090 --relay-secret 你的密钥
```

### 3. 配对手机

```bash
node daemon/codex-watchd.js --pair \
  --relay ws://中继地址:8090 --relay-secret 你的密钥 \
  --pair-scope control
```

会打印一个 `apiagentcontrol://pair?d=...` 的配对串。三种导入方式：

- **扫码**（推荐）：`qrencode -t ANSIUTF8 "<配对串>"` 在终端里生成二维码，用 App 扫
- **点链接**：把配对串发到手机上点开（已注册 URL scheme）
- **粘贴**：复制进 App 的输入框

> 配对串等同一把钥匙，别转发给别人。

模拟器上可以直接：`xcrun simctl openurl <UDID> "<配对串>"`

## 日常使用

### 首页

三段结构，和你 Codex Desktop 侧栏**完全一致**：置顶 / 项目 / 最近。
置顶的顺序就是你在 Desktop 里排的顺序。

最上面是**「需要我处理」**——跨所有项目聚合，两类：

| 卡片 | 什么情况 | 你能做什么 |
|---|---|---|
| 🔒 需要审批 | Codex 要执行命令 / 改文件，在等批准 | 看清命令内容后点「允许」「始终允许」「拒绝」 |
| 💬 等你回复 | 模型用文字问了你一句然后停下 | 直接在卡片里回复，不用点进会话 |

带「推测」标签的是启发式判断的（协议不提供这个信号，详见
[docs/waiting-detection.md](docs/waiting-detection.md)），可能偶有误判。

### 会话详情

点任意会话进去，是完整的对话记录：

- **往上翻**能加载更早的历史，一直到「— 会话开始 —」
- 工具调用默认**折叠成一行**，点开看详情——一个 turn 里工具和推理的条数是正经消息的
  十倍，不折叠没法看
- 右上角菜单里可以打开「显示推理过程」、打断正在跑的任务
- 底部输入框直接发指令

### 权限档位怎么选

配对时用 `--pair-scope` 指定，**默认是 `read`**：

| 档位 | 能做什么 | 什么时候用 |
|---|---|---|
| `read` | 只能看 | 给别人演示，或你只想随时瞄一眼进度 |
| `approve` | 能批准命令，但**不能回文字** | 只想远程放行命令，不交出输入能力 |
| `control` | 能发任意指令 | **想在手机上真正接着干活，只能选这个** |

要提醒的是：`approve` 在实际使用中够呛——最常见的「卡住等你」不是结构化审批，
而是模型用文字问你一句，那种情况只能回文字，也就必须是 `control`。

而 `control` 等同远程 shell（agent 会照着执行你发的任何东西），手机丢了等于机器失守。
这是绕不过去的取舍，自己权衡。

改档位需要重新配对：

```bash
node daemon/codex-watchd.js --list-devices        # 看当前有哪些设备
node daemon/codex-watchd.js --revoke-device <id>  # 吊销
node daemon/codex-watchd.js --pair --pair-scope control ...   # 重新配
```

### 开启推送

不开推送，App 退到后台就收不到任何东西（iOS 会杀掉长连接），
"人不在电脑前收到审批请求"这个核心场景就不成立。

手机上：设置页 → 开启通知。
电脑上：需要配 APNs 凭证，步骤见 [docs/push.md](docs/push.md)。

通知内容**不含任何会话信息**（只写"有一条需要处理"），因为 APNs 服务器能看到推送体，
而你的会话标题本身就带业务信息。真实内容在你点开后由 App 经加密通道取。

## 出问题了怎么办

| 现象 | 原因与处理 |
|---|---|
| 手机显示「电脑离线」 | daemon 没连上中继。确认 daemon 和中继都在跑，然后点左上角**「重连」** |
| 手机显示「已断开」 | 自动重试 3 次后停了（刻意设计，见下）。点左上角「重连」 |
| 「配对凭证已失效」 | 设备被吊销了，或换了 Bundle ID。点「重新配对」按新配对串重配 |
| 看不到某个会话 | 归档的会话默认不显示；子代理线程也不显示（跟随 Codex 自己的判定） |
| 会话只显示一串 UUID | 该会话既没被命名、也没有可提取的用户消息，属正常 |
| 推送收不到 | `auth.json` 的 `bundleId` 要和工程一致；`production` 要和安装方式一致 ——<br>Xcode 直装是 `false`，**TestFlight 是 `true`**（它走 production APNs，反直觉但确实如此）。<br>详见 [docs/push.md](docs/push.md) |
| Xcode Cloud 的 export 步骤失败（exit 70） | Archive 成功而 export 失败＝签名问题，不是代码问题。<br>多半是 App ID 没注册、或没勾 Push Notifications 能力。见 [docs/push.md](docs/push.md) |
| 手机上发不了指令 | 当前设备是 `read` 或 `approve` 档位，需要 `control` |

**为什么不做无限自动重连**：它给人的是"看起来在恢复"的假象。
实测遇到过中继侧记账出错，客户端一直重连也无济于事，界面却始终显示"连接中"，
反而掩盖了真实状态。所以自动重试只覆盖切网、锁屏这类瞬时抖动（3 次），
之后停下来把决定权交给你。

## 中继部署

中继要能被手机和电脑同时够到。三个方案按省事程度排列，**都验证过**。

### 方案一：Cloudflare 隧道（最省事，推荐先用这个）

中继就跑在你自己的 Mac 上，用隧道把它暴露成公网 HTTPS 地址。
**不需要服务器、不需要域名、不需要注册账号**，一条命令：

```bash
brew install cloudflared

# 终端 A：中继（本机）
node relay/server.js --port 8090 --secret <你的密钥>

# 终端 B：隧道，会打印一个 https://xxx.trycloudflare.com 地址
cloudflared tunnel --url http://127.0.0.1:8090
```

拿到地址后，把 `https://` 换成 `wss://` 用作中继地址：

```bash
node daemon/codex-watchd.js --relay wss://xxx.trycloudflare.com --relay-secret <你的密钥>
node daemon/codex-watchd.js --pair --relay wss://xxx.trycloudflare.com \
     --relay-secret <你的密钥> --pair-scope control
```

**隐私不受影响**：业务载荷是端到端加密的，Cloudflare 只能看到密文和连接元数据
（谁在什么时候连了多久），和自建中继时它作为网络中间人能看到的一样多。

**唯一的坑**：临时隧道的地址**每次重启都会变**，而配对串里嵌了中继地址，
地址一变就得重新配对。适合先跑通、临时用。要长期用，走下面两个方案之一，
或者用 Cloudflare 命名隧道（需要一个接入 Cloudflare 的域名，地址就固定了）。

### 方案二：Fly.io（地址固定，仍然省事）

仓库里已经备好 [`relay/Dockerfile`](relay/Dockerfile) 和 [`relay/fly.toml`](relay/fly.toml)：

```bash
cd relay
fly launch --no-deploy --copy-config     # 选区域，确认 app 名
fly secrets set RELAY_SECRET=<你的密钥>
fly deploy
```

中继地址就是 `wss://<你的app名>.fly.dev`，固定不变，Fly 自动配好 TLS。

`fly.toml` 里 `auto_stop_machines = false` 是**必须的**——中继是长连接，
机器一自动停机，daemon 和手机就会被反复断开。

### 方案三：自己的 VPS

```bash
# 服务器上
node relay/server.js --port 8090 --secret <你的密钥>
```

然后用 Caddy / Nginx 反代并配 TLS（**必须**，否则配对串和流量走明文网络）。
Caddy 只要两行：

```
relay.你的域名.com {
    reverse_proxy 127.0.0.1:8090
}
```

Caddy 默认就支持 WebSocket 升级，不用额外配置。用 Nginx 的话记得加
`proxy_set_header Upgrade $http_upgrade;` 和 `proxy_set_header Connection "upgrade";`。

**Docker + nginx-proxy-manager + Cloudflare 橙云的完整走法**（实际部署在用的组合）：

```bash
# 服务器上：构建并挂进 NPM 所在的 docker 网络，不暴露宿主端口
scp relay/server.js relay/Dockerfile 服务器:~/apiagent-relay/
docker build -t apiagent-relay ~/apiagent-relay
docker run -d --name apiagent-relay --restart unless-stopped \
  --network <NPM所在网络> -e RELAY_SECRET=<你的密钥> apiagent-relay
```

- NPM 加 Proxy Host：域名 → `http://apiagent-relay:8080`，**Websockets Support 必须打开**
- 证书用 **Cloudflare Origin CA**（SSL/TLS → Origin Server → Create Certificate，
  15 年免费），Custom 方式贴进 NPM，配 Force SSL —— 橙云下走 Let's Encrypt http-01
  会跟 "Always Use HTTPS" / Full (strict) 互相打架，Origin CA 没这些破事
- Cloudflare DNS 开**橙云**（隐藏源站 IP + DDoS 防护），SSL 模式 **Full (strict)**
- 空闲超时无忧：中继每 30 秒发 WebSocket ping，短于 CF（100s）和 nginx（60s）的掐线阈值

### 中继固定后，本地只剩 daemon 一个进程

把中继地址写进 `~/.codex-watchd/relay-url`，然后装 launchd（开机自启 + 崩溃自动拉起）：

```bash
echo "wss://relay.你的域名.com" > ~/.codex-watchd/relay-url
scripts/install-launchd.sh
```

卸载用 `scripts/install-launchd.sh --uninstall`；重启用
`launchctl kickstart -k gui/$(id -u)/com.apiagentcontrol.daemon`。
本地中继和 cloudflared 从此不需要了，`scripts/start.sh` 检测到 `relay-url`
也只会起 daemon。

### 三个方案怎么选

| | 要服务器 | 地址固定 | 适合 |
|---|---|---|---|
| Cloudflare 隧道 | 不要 | ✗ 每次重启变 | 先跑通、临时用 |
| Cloudflare 命名隧道 | 不要 | ✓ | 你已经有域名在 Cloudflare |
| Fly.io | 不要（托管） | ✓ | **日常自用，推荐** |
| 自己的 VPS | 要 | ✓ | 你本来就有服务器 |

### 不管哪个方案，都记得

- **一定要设 `--secret`**。没有它，任何人知道你的中继地址就能接入房间。
  虽然读不了内容（端到端加密），但能耗你的资源、也能看到连接时序。
- **一定要用 `wss://` 而不是 `ws://`**。方案一二自动就是；VPS 方案要自己配 TLS。
- 中继**不需要**和 daemon 在同一台机器。方案一之所以放在本机，纯粹是图省事。

## 发版（Xcode Cloud）

### 流水线怎么配

Xcode Cloud 的 workflow 存在 App Store Connect 服务端，**仓库里没有对应文件**，
只能在 **Xcode → Integrate → Manage Workflows…** 里改。当前配置：

| workflow | 触发条件 | Action |
|---|---|---|
| Release | **Tag Changes** → 开头为 `v` 的标签 | Archive + **TestFlight（仅限内部测试）** |

只留 tag 触发意味着**推到 `main` 不跑任何 CI**，`ci_post_clone.sh` 里的自检也只在
发版时才执行。本地随时可以补上：`node daemon/selftest.js`。

### CI 脚本的位置很关键

`ci_scripts/` 必须与 `.xcodeproj` **同级**，本项目即 `ios/ci_scripts/`，
**不是仓库根目录**。放错了 Xcode Cloud 不会报错，只打印一行

```
Post-Clone script not found at ci_scripts/ci_post_clone.sh
```

并且**把该步骤标成成功**。于是自检和版本号注入全程没跑，构建照样是绿的——
本项目踩过这个坑，直到发现上传的版本号还是工程里写死的值才察觉。

### 打 tag 发版

```bash
git tag v0.2.0
git push origin v0.2.0
```

版本号会**自动从 tag 取**——`ios/ci_scripts/ci_pre_xcodebuild.sh` 在构建前把
`v0.2.0` 写进 `MARKETING_VERSION`，把 Xcode Cloud 的 `CI_BUILD_NUMBER`
写进 `CURRENT_PROJECT_VERSION`，工程里不用手工改版本。

**为什么必须这么做**：TestFlight 要求每次上传的构建号唯一且递增。
工程里的 `CURRENT_PROJECT_VERSION` 是写死的，不处理的话第一次能传、
**第二次会被拒**，而报错只说"该值已被使用"，不会指向工程配置——很难查。

tag 不是版本号格式（比如 `hotfix-abc`）时脚本不会乱改版本，只更新构建号。

**别复用 tag 名。** 构建失败后想用 `git tag -f` 把同名 tag 指到新 commit 重推，
Xcode Cloud **不一定会触发**——GitHub 对强制更新发出的是 `forced` 而非 `created`
事件，实测同样的操作有时起构建、有时毫无反应，且不留任何记录。
每次重试都递一个新版本号（`v0.1.1`、`v0.1.2`）既能稳定触发，
也让 TestFlight 里的每个包都能对应回一份不可变的代码。

### 装上 TestFlight 版本之后必须改的一处

`~/.codex-watchd/auth.json` 里 `apns.production` 要改成 `true`，然后**重启 daemon**
（推送环境在构造时定死，不会热更新），启动日志应显示"推送 APNs 生产环境"。

时机是**手机装好 TestFlight 版本之后**，不是打 tag 之前：这个开关是全局二选一，
提前翻掉会让当前 Xcode 直装的版本（sandbox token）立刻收不到推送。
换成 TestFlight 版本后 device token 也变了，需要**重新配对一次**。
配置对不上时推送会静默失效——不报错、无日志（见 [docs/push.md](docs/push.md)）。

## 命令速查

```bash
# daemon
node daemon/codex-watchd.js                          # 启动（默认只监听本机）
node daemon/codex-watchd.js --relay ws://... --relay-secret ...   # 接入中继
node daemon/codex-watchd.js --bind 0.0.0.0           # 暴露到局域网（配合 Tailscale 直连）
node daemon/codex-watchd.js --verbose                # 打印更多事件
node daemon/selftest.js                              # 自检，不碰你的 ~/.codex

# 设备与配对
node daemon/codex-watchd.js --list-devices
node daemon/codex-watchd.js --pair --relay ws://... --pair-scope read|approve|control
node daemon/codex-watchd.js --revoke-device <id>

# 中继
node relay/server.js --port 8090 --secret <密钥>
cloudflared tunnel --url http://127.0.0.1:8090       # 暴露成公网地址
curl http://127.0.0.1:8090/health                    # 看房间与连接数
```

配置与凭证都在 `~/.codex-watchd/auth.json`（权限 0600，不在仓库里）。

---

# 实现说明

以下是设计取舍与实测记录，日常使用不需要看。

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
- **中继长期地址**：临时隧道地址每次重启都变，长期用需要 Fly.io 或命名隧道（见 [中继部署](#中继部署)，配置文件已备好）。
- **多台电脑**：所有接口隐含单机，家里+公司两台需要 hostId 维度。
- `thread/resume` 一个**正被 Desktop 打开**的线程时，写锁行为未实测。

## 已知待验证

- `thread/resume` 一个**正被 Desktop 打开**的线程时，写锁（`~/.codex/thread-writer-locks/`）的行为未测。
  已确认锁确实生效：daemon 持有线程时 `codex delete` 会失败，需先停 daemon。
- daemon 重启后 `activeTurns` 丢失，此时 `interrupt` 会返回 409（无活跃 turn 记录）。

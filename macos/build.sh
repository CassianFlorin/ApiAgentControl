#!/bin/sh
# 构建菜单栏 App。
#
#   macos/build.sh              仅构建到 macos/build/（ad-hoc 签名，本机可用）
#   macos/build.sh --install    构建 + 装进「应用程序」+ 启动
#   macos/build.sh --release    Developer ID 签名 + 公证 + 打成 .dmg（可分发给别人）
#
# 刻意不建 Xcode 工程：这是个几百行的单窗口工具，swiftc 直接编译 + 手工组装
# bundle 就够了，也不会跟 iOS 工程的 Xcode Cloud 配置互相干扰。
#
# 为什么不走 App Store / TestFlight：上架强制要求 App Sandbox，而本 App 的
# 核心动作（执行 /bin/launchctl 起停 daemon、读 ~/.codex-watchd/）在沙盒下
# 全部被禁止 —— 开关和沙盒互斥。Developer ID + 公证是这类工具的标准分发方式。
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/.." && pwd)"
NAME="ApiAgentControl Monitor"
APP="$DIR/build/$NAME.app"
BIN="$APP/Contents/MacOS/ApiAgentControlMonitor"
RES="$APP/Contents/Resources"
VERSION="${VERSION:-1.0}"

MODE="$1"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>com.cassianflorin.apiagentcontrol.monitor</string>
  <key>CFBundleExecutable</key><string>ApiAgentControlMonitor</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <!-- 只驻留菜单栏：不进 Dock、不抢焦点 -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF

# --- 图标：复用 iOS 那张 1024，转成 macOS 风格（留白 + 圆角）---
SRC_ICON="$REPO/ios/ApiAgentControl/Assets.xcassets/AppIcon.appiconset/icon-1024.png"
if [ -f "$SRC_ICON" ]; then
  echo "生成图标…"
  ICONSET="$DIR/build/AppIcon.iconset"
  rm -rf "$ICONSET"
  swift "$DIR/Tools/makeicon.swift" "$SRC_ICON" "$ICONSET" >/dev/null
  iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns"
  rm -rf "$ICONSET"
else
  echo "（没找到 iOS 图标源文件，App 将使用系统默认图标）"
fi

echo "编译…"
swiftc -O -parse-as-library \
  -target "$(uname -m)-apple-macos13.0" \
  -o "$BIN" \
  "$DIR/Sources/Monitor.swift" "$DIR/Sources/App.swift"

# ---------------------------------------------------------------- 分发构建
if [ "$MODE" = "--release" ]; then
  # 证书名形如 "Developer ID Application: Your Name (TEAMID)"，从钥匙串里找
  IDENTITY="${SIGN_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null \
    | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)".*/\1/')}"
  if [ -z "$IDENTITY" ]; then
    cat >&2 <<'MSG'
错误：钥匙串里没有 "Developer ID Application" 证书。

  1. developer.apple.com → Certificates → ＋ → Developer ID Application
  2. 下载 .cer 双击导入钥匙串
  （也可以用 Xcode: Settings → Accounts → Manage Certificates → ＋）

已有证书但名字特殊时，可显式指定：
  SIGN_IDENTITY="Developer ID Application: 你的名字 (TEAMID)" macos/build.sh --release
MSG
    exit 1
  fi
  echo "签名身份: $IDENTITY"

  # --options runtime 开 Hardened Runtime，公证的硬性前提；
  # --timestamp 打可信时间戳，证书到期后已签的包仍然有效
  codesign --force --deep --options runtime --timestamp \
    --sign "$IDENTITY" "$APP"
  codesign --verify --strict --verbose=2 "$APP" 2>&1 | tail -2

  DMG="$DIR/build/ApiAgentControl-Monitor-$VERSION.dmg"
  rm -f "$DMG"
  echo "打包 dmg…"
  STAGE="$DIR/build/dmg-stage"
  rm -rf "$STAGE"; mkdir -p "$STAGE"
  cp -R "$APP" "$STAGE/"
  ln -s /Applications "$STAGE/Applications"     # 拖拽安装的老规矩
  hdiutil create -volname "$NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
  rm -rf "$STAGE"
  codesign --force --sign "$IDENTITY" --timestamp "$DMG"

  PROFILE="${NOTARY_PROFILE:-apiagentcontrol-notary}"
  if xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
    echo "提交公证（几十秒到几分钟）…"
    xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
    # 钉票据：装订后即使断网，Gatekeeper 也能就地验证
    xcrun stapler staple "$DMG"
    echo
    echo "验证:"
    spctl -a -t open --context context:primary-signature -v "$DMG" 2>&1 | tail -2
  else
    cat >&2 <<MSG

已签名并打包，但**跳过了公证**（没找到钥匙串凭据 "$PROFILE"）。
未公证的 dmg 别人下载后会被 Gatekeeper 拦。先存一次凭据：

  xcrun notarytool store-credentials "$PROFILE" \\
    --apple-id <你的 Apple ID> \\
    --team-id <Team ID> \\
    --password <App 专用密码，appleid.apple.com 生成>

然后重跑 macos/build.sh --release
MSG
  fi
  echo
  echo "产物: $DMG"
  exit 0
fi

# ---------------------------------------------------------------- 本机自用
# 未签名的 bundle 在较新的 macOS 上会被直接拒绝运行
codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "（ad-hoc 签名失败，可忽略）"

echo "已生成: $APP"

if [ "$MODE" = "--install" ]; then
  DEST="/Applications/$NAME.app"
  # 换新版本前先退掉旧进程，否则复制过去的可执行文件仍是被占用的旧实例
  pkill -f "ApiAgentControlMonitor" 2>/dev/null || true
  sleep 1
  rm -rf "$DEST"
  cp -R "$APP" "$DEST"
  # 图标缓存不刷新的话，Finder 里可能还显示旧的/空白图标
  touch "$DEST"
  open "$DEST"
  echo "已安装并启动: $DEST"
  echo "开机自启：系统设置 → 通用 → 登录项 → ＋ 添加「$NAME」"
else
  echo
  echo "装进「应用程序」并启动:  macos/build.sh --install"
  echo "打成可分发的 dmg:        macos/build.sh --release"
fi

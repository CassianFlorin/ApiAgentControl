#!/bin/sh
# 构建菜单栏 App，产出 macos/build/ApiAgentControl Monitor.app
#
# 刻意不建 Xcode 工程：这是个几百行的单窗口工具，swiftc 直接编译 + 手工组装
# bundle 就够了，也不会跟 iOS 工程的 Xcode Cloud 配置互相干扰。
# 签名用 ad-hoc（`-`）：本机自用不需要开发者证书。
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/build/ApiAgentControl Monitor.app"
BIN="$APP/Contents/MacOS/ApiAgentControlMonitor"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ApiAgentControl Monitor</string>
  <key>CFBundleDisplayName</key><string>ApiAgentControl Monitor</string>
  <key>CFBundleIdentifier</key><string>com.cassianflorin.apiagentcontrol.monitor</string>
  <key>CFBundleExecutable</key><string>ApiAgentControlMonitor</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <!-- 只驻留菜单栏：不进 Dock、不抢焦点 -->
  <key>LSUIElement</key><true/>
</dict>
</plist>
EOF

echo "编译…"
swiftc -O -parse-as-library \
  -target "$(uname -m)-apple-macos13.0" \
  -o "$BIN" \
  "$DIR/Sources/Monitor.swift" "$DIR/Sources/App.swift"

# 未签名的 bundle 在较新的 macOS 上会被直接拒绝运行
codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "（ad-hoc 签名失败，可忽略）"

echo "已生成: $APP"
echo
echo "试运行:  open \"$APP\""
echo "装到应用程序:  cp -R \"$APP\" /Applications/"
echo "开机自启:  系统设置 → 通用 → 登录项 → 添加该 App"

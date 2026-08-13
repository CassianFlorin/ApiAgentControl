#!/bin/sh
# 构建菜单栏 App。
#
#   macos/build.sh              仅构建到 macos/build/
#   macos/build.sh --install    构建 + 装进「应用程序」+ 打开
#
# 刻意不建 Xcode 工程：这是个几百行的单窗口工具，swiftc 直接编译 + 手工组装
# bundle 就够了，也不会跟 iOS 工程的 Xcode Cloud 配置互相干扰。
# 签名用 ad-hoc（`-`）：本机自用不需要开发者证书。
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$DIR/.." && pwd)"
NAME="ApiAgentControl Monitor"
APP="$DIR/build/$NAME.app"
BIN="$APP/Contents/MacOS/ApiAgentControlMonitor"
RES="$APP/Contents/Resources"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES"

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ApiAgentControl Monitor</string>
  <key>CFBundleDisplayName</key><string>ApiAgentControl Monitor</string>
  <key>CFBundleIdentifier</key><string>com.cassianflorin.apiagentcontrol.monitor</string>
  <key>CFBundleExecutable</key><string>ApiAgentControlMonitor</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
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

# 未签名的 bundle 在较新的 macOS 上会被直接拒绝运行
codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "（ad-hoc 签名失败，可忽略）"

echo "已生成: $APP"

if [ "$1" = "--install" ]; then
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
fi

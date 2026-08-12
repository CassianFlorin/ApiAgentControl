#!/bin/sh
# 把 daemon 装成 launchd 用户代理：开机自启、崩溃自动拉起。
#
# 前提：中继已经在别处固定运行（VPS / Fly.io），地址写在 ~/.codex-watchd/relay-url。
# 本脚本只管 daemon —— 本地中继/隧道的时代已经结束。
#
# 卸载：scripts/install-launchd.sh --uninstall
set -e

LABEL="com.apiagentcontrol.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$HOME/.codex-watchd"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
UID_="$(id -u)"

if [ "$1" = "--uninstall" ]; then
  launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null && echo "已停止" || echo "本来就没在跑"
  rm -f "$PLIST" && echo "已删除 $PLIST"
  exit 0
fi

[ -f "$DIR/relay-url" ]    || { echo "缺 $DIR/relay-url（固定中继地址，如 wss://relay.example.com）"; exit 1; }
[ -f "$DIR/relay-secret" ] || { echo "缺 $DIR/relay-secret（中继准入密钥）"; exit 1; }

NODE="$(command -v node)"
[ -n "$NODE" ] || { echo "找不到 node"; exit 1; }
CODEX_BIN="$(command -v codex || true)"
[ -n "$CODEX_BIN" ] || echo "警告：PATH 里没有 codex，控制通道（发指令/审批）会不可用"

# launchd 的默认 PATH 只有系统目录，node（mise）和 codex（homebrew）都不在 ——
# 把安装时解析到的 bin 目录写进环境，否则 daemon 找不到 codex 起不了控制通道
AGENT_PATH="$(dirname "$NODE")${CODEX_BIN:+:$(dirname "$CODEX_BIN")}:/usr/bin:/bin:/usr/sbin:/sbin"

# 密钥和中继地址在启动时从文件读，不写死进 plist ——
# 换中继或轮换密钥后 kickstart 一下就生效，不用重装
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>exec "$NODE" "$REPO/daemon/codex-watchd.js" --port 8787 --relay "\$(cat "$DIR/relay-url")" --relay-secret "\$(cat "$DIR/relay-secret")"</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$AGENT_PATH</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DIR/daemon.log</string>
  <key>StandardErrorPath</key><string>$DIR/daemon.log</string>
  <key>WorkingDirectory</key><string>$REPO</string>
</dict>
</plist>
EOF

# 重装场景：先卸旧的（不存在也无妨）
launchctl bootout "gui/$UID_/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_" "$PLIST"
sleep 2

if launchctl print "gui/$UID_/$LABEL" 2>/dev/null | grep -q "state = running"; then
  echo "daemon 已由 launchd 接管（开机自启 + 崩溃自动拉起）"
  echo "  状态: launchctl print gui/$UID_/$LABEL | head -20"
  echo "  重启: launchctl kickstart -k gui/$UID_/$LABEL"
  echo "  日志: tail -f $DIR/daemon.log"
else
  echo "启动状态未确认，看日志: tail -20 $DIR/daemon.log"; exit 1
fi

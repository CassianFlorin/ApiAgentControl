#!/bin/sh
# 一键拉起本机组件。
#
# 两种形态：
#   - ~/.codex-watchd/relay-url 存在（固定中继，VPS/Fly.io）→ 只起 daemon
#     ※ 这种形态更推荐 scripts/install-launchd.sh，开机自启 + 崩溃自动拉起
#   - 不存在 → 本机三件套：中继 → daemon → Cloudflare quick tunnel
#     ※ quick tunnel 域名每次重启都变，隧道重启后手机必须重新配对
#
# 可重复执行：已在跑的组件跳过，不会起第二份。
# 停止：scripts/stop.sh；日志：~/.codex-watchd/{relay,daemon,tunnel}.log
set -e

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$HOME/.codex-watchd"
SECRET_FILE="$DIR/relay-secret"

RELAY_PORT=8090
DAEMON_PORT=8787

mkdir -p "$DIR"
REMOTE_RELAY="$(cat "$DIR/relay-url" 2>/dev/null || true)"

# 准入密钥：没有就生成（首次运行）
if [ ! -f "$SECRET_FILE" ]; then
  openssl rand -hex 24 > "$SECRET_FILE"
  chmod 600 "$SECRET_FILE"
  echo "已生成中继准入密钥 $SECRET_FILE"
fi
SECRET="$(cat "$SECRET_FILE")"

# pgrep -f 按完整命令行匹配；起来后各自 sleep 一拍再验一次，
# 否则「起了但立刻崩」会被当成成功
running() { pgrep -f "$1" >/dev/null 2>&1; }

# --- 固定中继形态：只起 daemon ---
if [ -n "$REMOTE_RELAY" ]; then
  if launchctl print "gui/$(id -u)/com.apiagentcontrol.daemon" >/dev/null 2>&1; then
    echo "daemon 已由 launchd 接管，无需本脚本（重启用 launchctl kickstart -k gui/$(id -u)/com.apiagentcontrol.daemon）"
    exit 0
  fi
  if running "daemon/codex-watchd.js"; then
    echo "daemon     已在运行，跳过"
  else
    nohup node "$REPO/daemon/codex-watchd.js" --port "$DAEMON_PORT" \
      --relay "$REMOTE_RELAY" --relay-secret "$SECRET" \
      >> "$DIR/daemon.log" 2>&1 &
    sleep 2
    running "daemon/codex-watchd.js" || { echo "daemon 启动失败，看 $DIR/daemon.log"; exit 1; }
    echo "daemon     :$DAEMON_PORT 已启动（中继 $REMOTE_RELAY）"
  fi
  echo
  echo "配对新设备："
  echo "  node $REPO/daemon/codex-watchd.js --pair --relay $REMOTE_RELAY --relay-secret \"\$(cat $SECRET_FILE)\" --pair-scope control"
  exit 0
fi

# --- 1. 中继 ---
if running "relay/server.js"; then
  echo "中继       已在运行，跳过"
else
  nohup node "$REPO/relay/server.js" --port "$RELAY_PORT" --secret "$SECRET" \
    >> "$DIR/relay.log" 2>&1 &
  sleep 1
  running "relay/server.js" || { echo "中继启动失败，看 $DIR/relay.log"; exit 1; }
  echo "中继       :$RELAY_PORT 已启动"
fi

# --- 2. daemon ---
if running "daemon/codex-watchd.js"; then
  echo "daemon     已在运行，跳过"
else
  nohup node "$REPO/daemon/codex-watchd.js" --port "$DAEMON_PORT" \
    --relay "ws://127.0.0.1:$RELAY_PORT" --relay-secret "$SECRET" \
    >> "$DIR/daemon.log" 2>&1 &
  sleep 2
  running "daemon/codex-watchd.js" || { echo "daemon 启动失败，看 $DIR/daemon.log"; exit 1; }
  echo "daemon     :$DAEMON_PORT 已启动"
fi

# --- 3. 隧道 ---
if running "cloudflared tunnel"; then
  echo "隧道       已在运行，跳过"
else
  command -v cloudflared >/dev/null || { echo "未安装 cloudflared（brew install cloudflared），跳过隧道"; exit 0; }
  nohup cloudflared tunnel --url "http://127.0.0.1:$RELAY_PORT" \
    >> "$DIR/tunnel.log" 2>&1 &
  echo "隧道       启动中，等待分配域名…"
fi

# 隧道域名从日志里捞（新起或已在跑都适用）
URL=""
i=0
while [ $i -lt 15 ]; do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$DIR/tunnel.log" 2>/dev/null | tail -1 || true)"
  [ -n "$URL" ] && break
  sleep 2; i=$((i+1))
done

echo
if [ -n "$URL" ]; then
  WSS="wss://${URL#https://}"
  echo "公网中继地址: $WSS"
  echo
  echo "手机若是新设备或隧道域名已变，重新配对："
  echo "  node $REPO/daemon/codex-watchd.js --pair --relay $WSS --relay-secret \"\$(cat $SECRET_FILE)\" --pair-scope control"
else
  echo "没等到隧道域名，看 $DIR/tunnel.log"
fi

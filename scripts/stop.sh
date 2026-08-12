#!/bin/sh
# 停掉 start.sh 拉起的三件套。按启动的反序停：先断外面的，再停里面的。
#
# 注意：停掉隧道后，下次 start.sh 会拿到**新域名**，手机需要重新配对。

stop_one() {
  # $1: pgrep 模式  $2: 显示名
  if pgrep -f "$1" >/dev/null 2>&1; then
    pkill -f "$1"
    echo "$2 已停止"
  else
    echo "$2 本来就没在跑"
  fi
}

stop_one "cloudflared tunnel"        "隧道  "
stop_one "daemon/codex-watchd.js"    "daemon"
stop_one "relay/server.js"           "中继  "

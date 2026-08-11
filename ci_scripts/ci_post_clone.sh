#!/bin/sh
# Xcode Cloud 在克隆仓库后自动执行本脚本。
#
# 项目里近一半代码是 daemon 与中继（Node），Xcode Cloud 默认只构建 iOS 侧。
# 在这里把 daemon 自检也跑一遍，否则 Node 那半边在 CI 上完全无人把关。
#
# 注意：脚本必须放在仓库根目录的 ci_scripts/ 下，且需要可执行权限（chmod +x）。
set -e

echo "--- 环境 ---"
node --version 2>/dev/null || { echo "构建环境没有 Node，跳过 daemon 自检"; exit 0; }

# Xcode Cloud 的工作目录是仓库根；CI_PRIMARY_REPOSITORY_PATH 更可靠
REPO="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO"

echo "--- daemon 自检 ---"
# 自检在隔离的临时目录里跑，不依赖真实的 ~/.codex；
# 但它会读 ~/.codex-watchd/auth.json 取 token，CI 上没有该文件时
# 鉴权相关用例会以"无 token"路径运行，其余用例照常。
node daemon/selftest.js

echo "--- 语法检查 ---"
for f in daemon/*.js relay/*.js; do
  node --check "$f"
done
echo "全部通过"

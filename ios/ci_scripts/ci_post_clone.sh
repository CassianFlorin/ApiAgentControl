#!/bin/sh
# Xcode Cloud 在克隆仓库后自动执行本脚本。
#
# 项目里近一半代码是 daemon 与中继（Node），Xcode Cloud 默认只构建 iOS 侧。
# 在这里把 daemon 自检也跑一遍，否则 Node 那半边在 CI 上完全无人把关。
#
# 注意：ci_scripts/ 必须与 .xcodeproj **同级**（这里是 ios/），不是仓库根目录。
# 放错位置时 Xcode Cloud 只打印一行 "Post-Clone script not found"，
# 并且把该步骤标成成功 —— 脚本从头到尾没跑，构建却是绿的。
# 需要可执行权限（chmod +x），git 里应为 100755。
set -e

echo "--- 环境 ---"
node --version 2>/dev/null || { echo "构建环境没有 Node，跳过 daemon 自检"; exit 0; }

# 本脚本位于 <repo>/ios/ci_scripts/，故回退路径是两级
REPO="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}"
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

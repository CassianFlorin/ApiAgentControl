#!/bin/sh
# Xcode Cloud 在每次 xcodebuild 之前执行本脚本。
#
# 解决两件事：
#
# 1. **构建号必须唯一且递增**，否则第二次上传 TestFlight 会被拒，
#    而报错只说"该值已被使用"，不会指向工程里写死的 CURRENT_PROJECT_VERSION。
#    Xcode Cloud 提供单调递增的 CI_BUILD_NUMBER，直接用它。
#
# 2. **版本号跟着 tag 走**。流水线由 tag 触发时，CI_TAG 形如 v0.2.0，
#    取出 0.2.0 作为 MARKETING_VERSION，省得每次发版还要手工改工程。
#
# 直接改 pbxproj 而不用 agvtool：agvtool 需要 VERSIONING_SYSTEM=apple-generic，
# 且对多配置的处理不如直接替换直观。CI 上的检出是一次性的，改了不影响仓库。
#
# 注意：ci_scripts/ 必须与 .xcodeproj **同级**（这里是 ios/）。放在仓库根目录时
# Xcode Cloud 找不到，只打印 "Pre-Xcodebuild script not found" 并标为成功，
# 于是版本号注入静默失效，构建照样绿。
set -e

REPO="${CI_PRIMARY_REPOSITORY_PATH:-$(cd "$(dirname "$0")/../.." && pwd)}"
PBX="$REPO/ios/ApiAgentControl.xcodeproj/project.pbxproj"

# 这里宁可让构建失败也不静默跳过：版本号错了要等上传 TestFlight 才会发现。
[ -f "$PBX" ] || { echo "错误：找不到 $PBX"; exit 1; }

if [ -n "$CI_BUILD_NUMBER" ]; then
  sed -i '' "s/CURRENT_PROJECT_VERSION = .*;/CURRENT_PROJECT_VERSION = $CI_BUILD_NUMBER;/g" "$PBX"
  echo "构建号 → $CI_BUILD_NUMBER"
else
  echo "无 CI_BUILD_NUMBER（本地运行？），构建号保持不变"
fi

# tag 形如 v1.2.3 或 1.2.3；只取数字部分，非法格式则不动
if [ -n "$CI_TAG" ]; then
  VERSION=$(printf '%s' "$CI_TAG" | sed -E 's/^[vV]//')
  if printf '%s' "$VERSION" | grep -qE '^[0-9]+(\.[0-9]+){0,2}$'; then
    sed -i '' "s/MARKETING_VERSION = .*;/MARKETING_VERSION = $VERSION;/g" "$PBX"
    echo "版本号 → $VERSION（来自 tag $CI_TAG）"
  else
    echo "tag $CI_TAG 不是版本号格式，MARKETING_VERSION 保持不变"
  fi
fi

grep -m1 -E 'MARKETING_VERSION|CURRENT_PROJECT_VERSION' "$PBX" >/dev/null && {
  echo "当前： $(grep -m1 'MARKETING_VERSION' "$PBX" | tr -d ' \t')  $(grep -m1 'CURRENT_PROJECT_VERSION' "$PBX" | tr -d ' \t')"
}

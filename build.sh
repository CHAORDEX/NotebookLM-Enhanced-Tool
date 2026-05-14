#!/bin/bash

# NotebookLM 心智图复制工具 - 打包脚本

echo "开始打包 Chrome 扩展..."

# 功能说明:
# bump_patch_version: 自动将 manifest.json 的 patch 版本号 +1
bump_patch_version() {
  local current_version
  local major minor patch new_patch new_version

  current_version=$(grep '"version"' manifest.json | sed 's/.*"version": "\(.*\)".*/\1/')
  IFS='.' read -r major minor patch <<< "$current_version"

  if [ -z "$major" ] || [ -z "$minor" ] || [ -z "$patch" ]; then
    echo "❌ 版本号格式不正确: $current_version"
    exit 1
  fi

  new_patch=$((patch + 1))
  new_version="${major}.${minor}.${new_patch}"

  echo "版本号将从 $current_version 更新为 $new_version"

  # 替换 manifest.json 中的版本号 (兼容 macOS 和 Linux 的 sed)
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' 's/"version": "'"$current_version"'"/"version": "'"$new_version"'"/' manifest.json
  else
    sed -i 's/"version": "'"$current_version"'"/"version": "'"$new_version"'"/' manifest.json
  fi

  echo "版本号更新完成！"
}

# 默认自动更新版本号；传 no-update 时跳过
if [ "$1" == "no-update" ]; then
  echo "已跳过版本号更新（no-update）"
else
  echo "正在自动更新版本号 (patch)..."
  bump_patch_version
fi

# 创建 dist 目录
mkdir -p dist

# 获取打包使用的版本号
PACKAGE_NAME="notebooklm-mindmap-tool"
VERSION=$(grep '"version"' manifest.json | sed 's/.*"version": "\(.*\)".*/\1/')
ZIP_FILE="dist/${PACKAGE_NAME}-v${VERSION}.zip"

# 删除旧的打包文件
rm -f "$ZIP_FILE"

# 创建 zip 包（排除不需要的文件）
zip -r "$ZIP_FILE" \
  manifest.json \
  background/ \
  content/ \
  assets/ \
  -x "*.DS_Store" \
  -x "*/.git/*" \
  -x "*/node_modules/*" \
  -x "*.sh" \
  -x "dist/*"

echo "✅ 打包完成: $ZIP_FILE"
echo "📦 版本: v${VERSION}"
echo ""
echo "使用方法："
echo "0. 默认会自动更新 patch 版本号（如 1.0.2 -> 1.0.3）"
echo "   如需跳过版本更新：./build.sh no-update"
echo "1. 打开 Chrome 扩展管理页面: chrome://extensions/"
echo "2. 启用'开发者模式'"
echo "3. 点击'加载已解压的扩展程序'，选择解压后的文件夹"
echo "   或者直接拖拽 $ZIP_FILE 到扩展管理页面"

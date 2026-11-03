#!/bin/bash
# 双击启动 Grsai 模型测试台（macOS）
# 关闭终端窗口即停止服务。

cd "$(dirname "$0")" || exit 1

# 双击启动时不会加载 shell 配置，这里手动找 Node
NODE_BIN="$(command -v node 2>/dev/null)"
if [ -z "$NODE_BIN" ] && [ -d "$HOME/.nvm/versions/node" ]; then
  NODE_BIN="$(ls -d "$HOME/.nvm/versions/node"/*/bin/node 2>/dev/null | sort -V | tail -1)"
fi
if [ -z "$NODE_BIN" ]; then
  for c in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$c" ]; then NODE_BIN="$c"; break; fi
  done
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  echo ""
  echo "未找到 Node.js。"
  echo "请先安装 Node.js 18 或更高版本：https://nodejs.org/"
  echo ""
  read -n 1 -s -r -p "按任意键关闭窗口…"
  exit 1
fi

echo "正在启动 Grsai 模型测试台…"
echo "（首次使用可在页面里直接填 API Key）"
echo ""

"$NODE_BIN" bench/web-server.mjs --open

echo ""
echo "服务已停止。按任意键关闭窗口…"
read -n 1 -s -r

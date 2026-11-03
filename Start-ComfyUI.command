#!/bin/bash
# ============================================================
#  ComfyUI 快速启动（macOS）
#
#  双击运行          → 仅本机 http://127.0.0.1:8188
#  加 -lan           → 局域网可访问（插件装在另一台机器时用）
#  加 -port 8189     → 换端口
#  加 -open          → 启动后自动打开浏览器
#  加 -check         → 只打印检测结果，不启动
#
#  例：./Start-ComfyUI.command -lan -open
#
#  找不到 ComfyUI？把下面 COMFY_DIR 改成实际路径（含 main.py 的那层）。
# ============================================================

COMFY_DIR=""
LAN=0
PORT=8188
OPEN=0
CHECK=0

while [ $# -gt 0 ]; do
  case "$1" in
    -lan|--listen) LAN=1 ;;
    -open) OPEN=1 ;;
    -check) CHECK=1 ;;
    -port)
      shift
      PORT="$1"
      ;;
    -h|--help)
      sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "未知参数：$1（可用：-lan / -port N / -open / -check）" ;;
  esac
  shift
done

[ -z "$PORT" ] && PORT=8188

# ---------- 找 ComfyUI ----------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -n "$COMFY_DIR" ] && [ -f "$COMFY_DIR/main.py" ]; then
  :
else
  COMFY_DIR=""
  for d in \
    "$SCRIPT_DIR/ComfyUI" \
    "$SCRIPT_DIR" \
    "$HOME/ComfyUI" \
    "$HOME/Documents/ComfyUI" \
    "$HOME/Desktop/ComfyUI" \
    "$HOME/Applications/ComfyUI" \
    "/Applications/ComfyUI" \
    "$HOME/ComfyUI_windows_portable/ComfyUI"
  do
    if [ -f "$d/main.py" ]; then COMFY_DIR="$d"; break; fi
  done
fi

if [ -z "$COMFY_DIR" ]; then
  echo ""
  echo "[x] 没找到 ComfyUI（要含有 main.py 的那个目录）"
  echo ""
  echo "    右键本文件 → 打开方式 → 文本编辑，把 COMFY_DIR 改成你的路径，例如："
  echo '      COMFY_DIR="$HOME/AI/ComfyUI"'
  echo "    或把本文件放到 ComfyUI 目录里（或它的上一级）。"
  echo ""
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

# ---------- 找 Python ----------
PY=""
if [ -x "$COMFY_DIR/venv/bin/python" ]; then
  PY="$COMFY_DIR/venv/bin/python"
elif [ -x "$COMFY_DIR/.venv/bin/python" ]; then
  PY="$COMFY_DIR/.venv/bin/python"
elif command -v python3 >/dev/null 2>&1; then
  PY="$(command -v python3)"
fi

if [ -z "$PY" ]; then
  echo ""
  echo "[x] 没找到 Python"
  echo "    ComfyUI 目录里建一个虚拟环境："
  echo "      cd \"$COMFY_DIR\" && python3 -m venv venv && venv/bin/pip install -r requirements.txt"
  echo ""
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

# ---------- 地址 ----------
if [ "$LAN" = "1" ]; then LISTEN="0.0.0.0"; else LISTEN="127.0.0.1"; fi
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)"

if [ "$CHECK" = "1" ]; then
  echo "目录    : $COMFY_DIR"
  echo "Python  : $PY"
  echo "监听    : $LISTEN:$PORT"
  echo "命令    : \"$PY\" main.py --listen $LISTEN --port $PORT"
  [ -n "$LAN_IP" ] && echo "局域网  : http://$LAN_IP:$PORT"
  exit 0
fi

echo "============================================================"
echo "  ComfyUI 启动中"
echo "    目录   : $COMFY_DIR"
echo "    Python : $PY"
echo "    监听   : $LISTEN:$PORT"
echo "    本机   : http://127.0.0.1:$PORT"
if [ "$LAN" = "1" ]; then
  if [ -n "$LAN_IP" ]; then
    echo "    局域网 : http://$LAN_IP:$PORT"
  else
    echo "    局域网 : 没拿到 IP（检查 Wi-Fi / 有线是否连接）"
  fi
fi
echo ""
echo "    关掉这个窗口或按 Ctrl+C = 停止 ComfyUI"
echo "============================================================"
echo ""

# 已经在跑就不重复启动，直接打开页面
# 注意：必须 --noproxy，否则环境代理对未监听端口返回 502，curl 退出码仍是 0 → 误判“已在跑”
ALIVE_CODE="$(curl -s -m 1 --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/system_stats")"
if [ "$ALIVE_CODE" = "200" ]; then
  echo "[i] $PORT 端口已有 ComfyUI 在跑，直接使用它。"
  [ "$OPEN" = "1" ] && open "http://127.0.0.1:$PORT"
  read -n 1 -s -r -p "按任意键关闭…"
  exit 0
fi

[ "$OPEN" = "1" ] && ( sleep 6; open "http://127.0.0.1:$PORT" ) &

cd "$COMFY_DIR" || exit 1
"$PY" main.py --listen "$LISTEN" --port "$PORT"
CODE=$?

echo ""
echo "[ComfyUI 已退出] 退出码 $CODE"
if [ "$CODE" -ne 0 ]; then
  echo "常见原因：依赖没装全 → cd \"$COMFY_DIR\" && venv/bin/pip install -r requirements.txt"
  echo "           端口被占用 → 换个端口：./Start-ComfyUI.command -port 8189"
fi
echo ""
read -n 1 -s -r -p "按任意键关闭…"
exit $CODE

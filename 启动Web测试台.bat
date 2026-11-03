@echo off
chcp 65001 >nul
rem 双击启动 Grsai 模型测试台（Windows）。关闭窗口即停止服务。
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 未找到 Node.js。
  echo 请先安装 Node.js 18 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo 正在启动 Grsai 模型测试台…
echo （首次使用可在页面里直接填 API Key）
echo.
node bench\web-server.mjs --open

echo.
echo 服务已停止。
pause

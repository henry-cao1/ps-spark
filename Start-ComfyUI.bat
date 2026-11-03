@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title ComfyUI 快速启动 - Grsai

rem ============================================================
rem  ComfyUI 快速启动（Windows）
rem
rem  双击运行        → 仅本机可访问 http://127.0.0.1:8188
rem  加 -lan         → 局域网可访问（插件装在另一台机器时用这个）
rem  加 -port 8189   → 换端口
rem  加 -open        → 启动后自动打开浏览器
rem
rem  例：Start-ComfyUI.bat -lan -open
rem
rem  找不到 ComfyUI？把下面这行的 COMFY_DIR 改成你的实际路径
rem  （路径里有空格要保留双引号）
rem ============================================================

set "COMFY_DIR="
set "LAN=0"
set "PORT=8188"
set "OPEN=0"

:parse
if "%~1"=="" goto detect
if /i "%~1"=="-lan" set "LAN=1"
if /i "%~1"=="--listen" set "LAN=1"
if /i "%~1"=="-open" set "OPEN=1"
if /i "%~1"=="-port" (
  set "PORT=%~2"
  shift
)
shift
goto parse

:detect
if "%PORT%"=="" set "PORT=8188"

if defined COMFY_DIR if exist "%COMFY_DIR%\main.py" goto found

rem 本文件就放在 ComfyUI 目录里
if exist "%~dp0main.py" set "COMFY_DIR=%~dp0"

rem 依次探测常见位置（含便携包 ComfyUI_windows_portable\ComfyUI）
for %%D in (
  "%~dp0ComfyUI"
  "%~dp0..\ComfyUI"
  "%USERPROFILE%\ComfyUI"
  "%USERPROFILE%\Documents\ComfyUI"
  "%USERPROFILE%\Desktop\ComfyUI"
  "%USERPROFILE%\ComfyUI_windows_portable\ComfyUI"
  "%USERPROFILE%\Downloads\ComfyUI_windows_portable\ComfyUI"
  "C:\ComfyUI"
  "D:\ComfyUI"
  "E:\ComfyUI"
) do (
  if not defined COMFY_DIR if exist "%%~D\main.py" set "COMFY_DIR=%%~D"
)

if not defined COMFY_DIR (
  echo.
  echo [x] 没找到 ComfyUI（要含有 main.py 的那个目录）
  echo.
  echo     二选一：
  echo       1. 右键本文件 - 编辑，把 COMFY_DIR 改成你的路径，例如
  echo          set "COMFY_DIR=D:\AI\ComfyUI_windows_portable\ComfyUI"
  echo       2. 把本文件放到 ComfyUI 目录的上一级再双击
  echo.
  pause
  exit /b 1
)

:found
set "LISTEN=127.0.0.1"
if "%LAN%"=="1" set "LISTEN=0.0.0.0"

rem ---- 找 Python：便携包自带 → venv → 系统 python ----
set "PY_KIND="
set "PY_EXE="
set "RUN_DIR=%COMFY_DIR%"
set "ENTRY=main.py"

if exist "%COMFY_DIR%\..\python_embeded\python.exe" (
  set "PY_KIND=portable"
  set "PY_EXE=%COMFY_DIR%\..\python_embeded\python.exe"
  set "RUN_DIR=%COMFY_DIR%\.."
  set "ENTRY=ComfyUI\main.py"
) else if exist "%COMFY_DIR%\venv\Scripts\python.exe" (
  set "PY_KIND=venv"
  set "PY_EXE=%COMFY_DIR%\venv\Scripts\python.exe"
) else if exist "%COMFY_DIR%\.venv\Scripts\python.exe" (
  set "PY_KIND=venv"
  set "PY_EXE=%COMFY_DIR%\.venv\Scripts\python.exe"
) else (
  where python >nul 2>nul
  if not errorlevel 1 (
    set "PY_KIND=python"
    set "PY_EXE=python"
  ) else (
    where py >nul 2>nul
    if not errorlevel 1 (
      set "PY_KIND=py"
      set "PY_EXE=py -3"
    )
  )
)

if not defined PY_KIND (
  echo.
  echo [x] 没找到 Python
  echo     装 Python 3.10+ 并勾选 Add python.exe to PATH，
  echo     或在 ComfyUI 目录执行：python -m venv venv
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo   ComfyUI 启动中
echo     目录   : "%COMFY_DIR%"
echo   Python : %PY_EXE%
echo   监听   : %LISTEN%:%PORT%
echo   本机   : http://127.0.0.1:%PORT%
if "%LAN%"=="1" call :showip
echo.
echo   关掉这个窗口 = 停止 ComfyUI
echo ============================================================
echo.

if "%OPEN%"=="1" start "" cmd /c "timeout /t 6 >nul & start http://127.0.0.1:%PORT%"

cd /d "%RUN_DIR%"
if /i "%PY_KIND%"=="portable" (
  "%PY_EXE%" -s "%ENTRY%" --listen %LISTEN% --port %PORT%
) else if /i "%PY_KIND%"=="venv" (
  "%PY_EXE%" "%ENTRY%" --listen %LISTEN% --port %PORT%
) else if /i "%PY_KIND%"=="python" (
  python "%ENTRY%" --listen %LISTEN% --port %PORT%
) else (
  py -3 "%ENTRY%" --listen %LISTEN% --port %PORT%
)

echo.
echo [ComfyUI 已退出] 退出码 %ERRORLEVEL%
echo 如果是依赖问题，在 ComfyUI 目录执行：
echo     venv\Scripts\python.exe -m pip install -r requirements.txt
echo.
pause
exit /b 0

:showip
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do (
  set "IP=%%a"
  set "IP=!IP: =!"
  if not "!IP!"=="" echo   局域网 : http://!IP!:!PORT!
  goto :eof
)
goto :eof

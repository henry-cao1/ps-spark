/*
 * package-win.mjs — 生成「可直接发给测试者」的 Windows 安装包
 *
 * 与 build.mjs 的分工：
 *   build.mjs      产出给开发者自己侧载的裸目录 / ccx；
 *   本脚本         在它之上再加一层「人能用」的东西：安装说明、一键安装 bat、
 *                  ComfyUI 启动器、许可证，压成一个 zip。
 *
 * 用法：
 *   node tools/package-win.mjs                      # 开发版（含开发者工作台），默认中文
 *   node tools/package-win.mjs --channel=release    # 发布版（剥离开发者模式）
 *   node tools/package-win.mjs --lang=en            # 默认英文界面
 *
 * 产物：dist/PS-Spark-<版本>[-dev][-en]-win-<日期>.zip
 *
 * 两个编码坑（都踩过）：
 *   1) 压缩包内文件名一律 ASCII —— macOS 的 zip 不写 UTF-8 标志位，
 *      中文文件名在 Windows 资源管理器里会变成乱码；
 *   2) .txt 用 UTF-8 + BOM（老记事本靠 BOM 认 UTF-8）；.bat 用 UTF-8 不带 BOM
 *      （BOM 会被 cmd 当成命令的一部分），靠开头 chcp 65001 显示中文。
 */

import { cp, rm, mkdir, readFile, writeFile, readdir, copyFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const s = argv[i];
    if (s.indexOf("--") !== 0) continue;
    if (s.indexOf("=") > 2) {
      const eq = s.indexOf("=");
      out[s.slice(2, eq)] = s.slice(eq + 1);
      continue;
    }
    const k = s.slice(2);
    const next = argv[i + 1];
    if (next && next.indexOf("--") !== 0) { out[k] = next; i++; }
    else out[k] = true;
  }
  return out;
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function zipDir(dir, outFile) {
  const entries = readdirSync(dir);
  if (process.platform === "win32") {
    const ps = `Compress-Archive -Path '${dir}\\*' -DestinationPath '${outFile}' -Force`;
    execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "inherit" });
  } else {
    execFileSync("zip",
      ["-rqX", outFile].concat(entries).concat(["-x", "*.DS_Store", "-x", "__MACOSX/*"]),
      { cwd: dir, stdio: "inherit" });
  }
}

/* 统一 CRLF；bom=true 用于 .txt，false 用于 .bat */
function writeText(file, text, bom) {
  const body = (bom ? "\uFEFF" : "") + text.replace(/\r?\n/g, "\r\n");
  return writeFile(file, body, "utf8");
}

const INSTALL_BAT = String.raw`@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
title PS Spark 安装（Windows）

rem ============================================================
rem  PS Spark 一键安装：复制到 UXP 侧载目录，并清掉旧版残留
rem  用法：双击运行；或 Install-Windows.bat -y 跳过确认
rem ============================================================

set "VER=__VER__"
set "SRC=%~dp0com.psspark.ps.assistant_%VER%"
set "DST=%APPDATA%\Adobe\UXP\Plugins\External"
set "TARGET=%DST%\com.psspark.ps.assistant_%VER%"

if not exist "%SRC%\manifest.json" (
  echo [x] 找不到 com.psspark.ps.assistant_%VER% 文件夹。
  echo     请把本文件与 com.psspark.ps.assistant_%VER% 放在同一目录后再运行。
  echo.
  pause
  exit /b 1
)

rem Photoshop 开着时插件文件被占用：装了也可能不生效，先挡一下
tasklist /FI "IMAGENAME eq Photoshop.exe" 2>nul | find /i "Photoshop.exe" >nul
if not errorlevel 1 (
  echo [!] 检测到 Photoshop 正在运行。
  echo     建议先完全退出 Photoshop 再安装，否则文件被占用会装不上或装了不生效。
  echo.
  if /i not "%~1"=="-y" (
    choice /c YN /m "仍然继续"
    if errorlevel 2 exit /b 0
  )
)

echo 即将安装 PS Spark %VER% 到：
echo   %TARGET%
echo.
if /i not "%~1"=="-y" (
  choice /c YN /m "继续"
  if errorlevel 2 exit /b 0
)

if not exist "%DST%" mkdir "%DST%"

for %%D in (
  com.psspark.ps.assistant_1.0.0
  com.psspark.ps.assistant_1.6.0
  com.psspark.ps.assistant_1.7.0
) do (
  if exist "%DST%\%%D" (
    echo 清理旧目录：%%D
    rmdir /s /q "%DST%\%%D" 2>nul
  )
)

for /d %%D in ("%DST%\com.psspark.*") do (
  echo 清理遗留目录：%%~nxD
  rmdir /s /q "%%~D" 2>nul
)

echo 正在复制…
xcopy /e /i /y /q "%SRC%" "%TARGET%" >nul
if errorlevel 1 (
  echo [x] 复制失败：多半是 Photoshop 还开着，或没有写入权限。
  echo     关掉 Photoshop 后重试；仍失败可手动把 com.psspark.ps.assistant_%VER% 复制到：
  echo     %DST%
  echo.
  pause
  exit /b 1
)

echo.
echo [OK] 已安装到 %TARGET%
echo.
echo 接下来两步：
echo   1. Photoshop 菜单 编辑 - 首选项 - 增效工具，勾选「启用开发人员模式」
echo   2. 完全退出 Photoshop 再打开，菜单 增效工具 - PS Spark
echo.
pause
`;

function installNotes(ver, isDev, lang, date) {
  const devBlock = isDev
    ? `三、开发者工作台（本包特有）
  设置 ▸ 底部「开发者（内部）」▸ 勾选「启用开发者模式」▸ 点「打开开发者工作台」
  - 提示词逐段编辑 / 变量校验 / 试跑 / 覆盖写 localStorage
  - 该区域只存在于开发构建，发布版与开源包已剥离
`
    : `三、本包为发布构建
  不含开发者工作台（已剥离并做隔离校验）。
`;

  return `PS Spark ${ver} · Windows ${isDev ? "开发版（含开发者工作台）" : "发布版"}
构建日期：${date}
默认界面语言：${lang === "en" ? "English（设置 ▸ 界面语言 可切中文）" : "中文（设置 ▸ 界面语言 可切英文）"}

【本软件已开源，如你是付费购买的，请向卖方申请退款】
插件非 Adobe 官方产品，许可证 AGPL-3.0（见 LICENSE）。

一、安装（二选一）
  方式 A · 双击
    双击 Install-Windows.bat，按提示确认。
    它会复制到 %APPDATA%\\Adobe\\UXP\\Plugins\\External\\com.psspark.ps.assistant_${ver}
    并清掉旧版残留（com.psspark.ps.assistant_1.0.0 / com.psspark.*）。

  方式 B · 手动
    1) 把整个 com.psspark.ps.assistant_${ver} 文件夹放到：
       %APPDATA%\\Adobe\\UXP\\Plugins\\External\\
       （资源管理器地址栏输入 %APPDATA% 回车即到 Roaming）
    2) 以前的旧目录先删掉，否则增效工具菜单会出现两个面板

二、启用
  1. Photoshop ▸ 编辑 ▸ 首选项 ▸ 增效工具 ▸ 勾选「启用开发人员模式」
  2. 完全退出 Photoshop，再重新打开
  3. 菜单 ▸ 增效工具 ▸ PS Spark

${devBlock}
四、首次使用
  - 设置 ▸ 服务接入 ▸ 重新填 API Key（Key 不跨机，Windows 上必须重填）
  - 设置 ▸ 界面语言：中文 / English 随时切换，重启后保持

五、本地 ComfyUI（可选）
  - 双击 Start-ComfyUI.bat 启动（仅本机可访问）
  - 跨机：Start-ComfyUI.bat -lan
  - 换端口：Start-ComfyUI.bat -port 8189
  - 设置 ▸ 本地 ComfyUI ▸ 添加内置模板（文生图 / 参考图 / 局部重绘）

六、出问题怎么查
  诊断日志：
    %APPDATA%\\Adobe\\UXP\\PluginsStorage\\PHSP\\<PS大版本>\\External\\com.psspark.ps.assistant\\PluginData\\psspark_debug.log
    例：...\\PHSP\\26\\External\\com.psspark.ps.assistant\\PluginData\\psspark_debug.log
  面板底部「诊断」也能直接看最近日志。
  反馈请带：操作步骤 + 日志对应时间段 + 截图。

七、卸载
  删掉 %APPDATA%\\Adobe\\UXP\\Plugins\\External\\com.psspark.ps.assistant_${ver} 即可；
  历史与缓存在 PluginsStorage 下，需要一并清空时删除对应目录。
`;
}

async function sizeOf(dir) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await sizeOf(p);
    else total += (await stat(p)).size;
  }
  return total;
}

async function main() {
  const args = parseArgs(process.argv);
  const isDev = args.channel !== "release";
  const lang = args.lang === "en" ? "en" : "zh";
  const manifest = JSON.parse(await readFile(path.join(ROOT, "ps-spark-plugin", "manifest.json"), "utf8"));
  const ver = manifest.version;
  const date = today();

  /* 1) 先跑标准构建，保证产物与源码一致 */
  const buildArgs = ["tools/build.mjs", "--channel=" + (isDev ? "dev" : "release")];
  if (lang === "en") buildArgs.push("--lang=en");
  console.log("→ node " + buildArgs.join(" "));
  execFileSync(process.execPath, buildArgs, { cwd: ROOT, stdio: "inherit" });

  const srcDir = isDev ? path.join(DIST, "dev", "ps-spark") : path.join(DIST, "ps-spark");
  if (!existsSync(srcDir)) throw new Error("构建产物缺失：" + srcDir);

  /* 2) 组装交付目录 */
  const folder = "PS-Spark-" + ver + (isDev ? "-dev" : "") + (lang === "en" ? "-en" : "") + "-win-" + date;
  const stage = path.join(DIST, "deliver", folder);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  await cp(srcDir, path.join(stage, "com.psspark.ps.assistant_" + ver), { recursive: true });
  for (const f of ["LICENSE", "NOTICE", "Start-ComfyUI.bat"]) {
    const p = path.join(ROOT, f);
    if (existsSync(p)) await copyFile(p, path.join(stage, f));
  }
  await writeText(path.join(stage, "INSTALL-Windows.txt"), installNotes(ver, isDev, lang, date), true);
  await writeText(path.join(stage, "Install-Windows.bat"), INSTALL_BAT.replace(/__VER__/g, ver), false);

  /* 3) 打包（文件名全 ASCII，避免 Windows 端解压乱码） */
  const outZip = path.join(DIST, folder + ".zip");
  await rm(outZip, { force: true });
  zipDir(stage, outZip);

  const mb = (await sizeOf(stage)) / 1024 / 1024;
  console.log("完成：");
  console.log("  " + stage);
  console.log("  " + outZip + "（" + mb.toFixed(2) + " MB）");
  if (isDev) console.log("提示：开发版含开发者工作台，仅限内部测试，不作为公开交付包。");
}

main().catch((e) => {
  console.error("打包失败：" + e.message);
  process.exit(1);
});

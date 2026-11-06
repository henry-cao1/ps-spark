# Windows 测试指南 · PS Spark 1.7.1

> 适用包：`dist/PS-Spark-1.7.1-dev-win-<日期>.zip`（开发版，含开发者工作台，默认中文）
> 生成命令：`node tools/package-win.mjs`
> 功能项不在这里重复列，统一走 [实机验收清单 F10 平台章](实机验收清单-2026-11-01.md)；本文只讲**装、开、看日志**。

---

## 一、包内有什么

```
PS-Spark-1.7.1-dev-win-<日期>/
├── com.psspark.ps.assistant_1.7.1/   插件本体（manifest.json / index.html / js / icons）
├── Install-Windows.bat             一键安装：复制到侧载目录 + 清旧版残留
├── INSTALL-Windows.txt             同样的步骤，文字版
├── Start-ComfyUI.bat               本地 ComfyUI 启动器（可不用）
└── LICENSE / NOTICE
```

插件 id 是 `com.psspark.ps.assistant`，版本目录 `com.psspark.ps.assistant_1.7.1`。
**不要改 id**：改了会读不到旧配置（Key、预设、历史都在这个 id 下）。

---

## 二、安装

### 方式 A · 一键（推荐）

1. 解压到 **不含中文和空格的路径**，例如 `D:\ps-spark\`。
2. **先完全退出 Photoshop**（否则文件被占用，装了也不生效）。
3. 双击 `Install-Windows.bat`，确认两次。
4. 脚本会复制到：
   ```
   %APPDATA%\Adobe\UXP\Plugins\External\com.psspark.ps.assistant_1.7.1\
   ```
   并顺手删掉 `com.psspark.ps.assistant_1.0.0`、`com.psspark.*` 等旧目录，避免菜单里出现两个面板。

### 方式 B · 手动

把 `com.psspark.ps.assistant_1.7.1` 整个文件夹放到 `%APPDATA%\Adobe\UXP\Plugins\External\`。
地址栏输入 `%APPDATA%` 回车即可到 Roaming。
目录里应当**直接**看到 `manifest.json`、`index.html`、`js\`、`icons\`（不要多套一层）。

### 启用

1. Photoshop ▸ 编辑 ▸ 首选项 ▸ **增效工具** ▸ 勾选「**启用开发人员模式**」。
2. 完全退出 Photoshop，再打开。
3. 菜单 ▸ 增效工具 ▸ **PS Spark**。

> 打开开发者模式是侧载的必要条件，不是「调试开关」；不开菜单里不会出现插件。

---

## 三、开发者工作台（本包特有）

`设置 ▸ 底部「开发者（内部）」▸ 勾选「启用开发者模式」▸ 点「打开开发者工作台」`

- 提示词逐段编辑、变量校验、试跑、覆盖写 localStorage；
- 该区域只在 dev 构建里存在，发布/开源包已剥离，且构建会扫描残留字符串。

---

## 四、第一件事：确认日志能写出来

面板底部「诊断」能看最近日志。日志文件在：

```
%APPDATA%\Adobe\UXP\PluginsStorage\PHSP\<PS主版本号>\External\com.psspark.ps.assistant\PluginData\psspark_debug.log
```

`<PS主版本号>` 通常是 `26`（PS 2025）或 `27`（PS 2026）。不确定就在 `PluginsStorage\PHSP\` 下逐个点开找。

开头应有一行环境信息：

```
env[boot]: platform=Windows | ps=26.x | dataFolder=C:\Users\...\AppData\Roaming\Adobe\UXP\...
```

**如果这行是 `platform=unknown` 或 dataFolder 读取失败，直接反馈** —— 说明环境探测或权限有问题。

---

## 五、Windows 冒烟（约 15 分钟）

功能细节按 F10 走；这里只列「换到 Windows 后最容易崩」的几处：

| # | 操作 | 预期 / 失败时看什么 |
|---|---|---|
| 1 | 打开面板看整体 | 中文是**微软雅黑/无衬线**，不是宋体；按钮不重叠、不裁切 |
| 2 | 设置 ▸ 服务接入填 Key | 显示已保存；关掉面板重开 Key 仍在 |
| 3 | 生成域文生图，1 张 | 出图、结果卡有缩略图；点插入图层位置正确 |
| 4 | 连跑 3 次看历史 Tab | 缩略图正常；**中文名/长路径不报错**（日志有 ENOENT/EPERM 就是这里） |
| 5 | 拆图 1 次（3 层） | 各层写入；无窗口乱闪/焦点丢失；日志有 `placeEvent ok` |
| 6 | 扩图：四边各 100px | 超限时弹确认层；点「返回调整」队列不新增 |
| 7 | 系统缩放 150%，重启 PS | 面板文字与按钮不错位、不被裁切 |
| 8 | 复制一段长提示词，点「📋 粘贴」 | 文本进入输入框（Cmd+V 在 UXP 里可能被 PS 吃掉，用按钮最稳） |
| 9 | 设置 ▸ 界面语言切 English | 全界面英文、无残留中文；切回中文正常 |
| 10 | 设置 ▸ 本地 ComfyUI ▸「添加内置模板」→ 点「适配本机模型」 | 状态行写明把哪个文件改成了本机哪个（如 `flux…Q8_0.gguf→Klein\flux…Q4_K_M.gguf`）；缺什么也会直接说 |
| 11 | SDXL / SD1.5 / Pony 这类单文件 checkpoint | 用内置「通用 Checkpoint 文生图」模板：添加时自动选中本机 ckpt，**不用自己导工作流**；换 ckpt 直接跑，提交前会自动校准 |

> 数据目录写文件（第 5 项）若出现 `EPERM` / `EACCES`，把日志发来——说明 Windows 权限或杀软拦截。

---

## 六、出问题怎么回传

1. 关掉面板前等 1 秒，让日志落盘。
2. 整个 `psspark_debug.log` 拷出来发我。
3. 弹窗报错请截图或抄原文——PS 原生错误不进日志。
4. 注明卡在第几项（用上面编号，例如「第 5 项，拆图只写了 2 层」）。

重点关键字：`env[boot]` · `placeEvent` · `EPERM` / `ENOENT` · `decomp:` · `export: 临时隐藏输入污染层` · `clip: 剪贴蒙版已生效`

---

## 七、已知在 Windows 上可能不同的地方

| 现象 | 原因 | 处理 |
|---|---|---|
| 字体略小/偏宽 | Windows 与 macOS 字体度量不同 | 可接受则不改；明显影响阅读反馈后调字号 |
| 面板最小宽度下按钮换行 | UXP 在 Windows 的 padding 略不同 | 截图，调 CSS |
| 拆图偶发闪窗 | `placeEvent` 未生效 → 回退临时文档 | 日志会写明，属已知降级路径 |
| Key 需要重新填 | 配置存本机，不跨设备 | 正常 |
| `Install-Windows.bat` 提示复制失败 | Photoshop 还开着 | 关掉 PS 再跑一次 |

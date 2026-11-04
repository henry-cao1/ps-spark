<div align="center">

# PS Spark

**跑在 Adobe Photoshop 里的 AI 生图、画布内编辑与拆图分层工具。**

一个 UXP 面板，把云端图像模型和本机 ComfyUI 接到同一块画布上：
选区、图层、任务队列都按 Photoshop 的方式工作。

[功能](#功能) · [安装](#安装) · [快速上手](#快速上手) ·
[本地-ComfyUI](#本地-comfyui可选) · [构建与测试](#构建与测试) · [English](README.md)

![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)
![Photoshop](https://img.shields.io/badge/Photoshop-24.4%2B-31A8FF.svg)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)
![Tests](https://img.shields.io/badge/tests-705%20passing-brightgreen.svg)

</div>

---

PS Spark 是 Adobe Photoshop 的第三方插件（UXP）。它把云端图像模型和本机 ComfyUI
直接接到你正在编辑的文档上：不用导出文件、切到浏览器、再把结果拖回来——
框选一块区域或选中一个图层，结果会按原坐标落回同一份文档，单独成层。

面板只有四个 Tab：**生成**、**编辑**、**拆图**、**历史**。模型选择、ComfyUI 预设、
界面语言、默认参数都收在右上角的设置里。

本项目以 AGPL-3.0 开源。如果你是付费拿到这个插件的，请向卖方申请退款——
任何人无权对它收费。

## 功能

| 模块 | 能力 |
|---|---|
| **生成** | 文生图（1–4 张候选）、基于当前画面的相似图、商品图、多图融合 |
| **编辑** | 局部重绘（选区或整幅）、擦除 / 去水印、换色、内容修图（含改文字）、高清修复、老照片修复、人像精修、线稿上色、艺术融合、原位合成、图像融合 |
| **结构** | 扩图（真实扩展画布，按百分比或像素）、抠图去背景（透明输出） |
| **拆图** | 看图分析 → 可编辑的图层蓝图 → 逐层提取 → 合并为图层组 |
| **本地模型** | ComfyUI 预设、4 条起步模板；工作流按本机模型文件适配 |
| **队列** | 云端 2 路并发、本地串行、按入队顺序落图、单条/全部取消、运行中追加 |
| **历史** | 所有结果本地归档、可重新插入任意文档、缓存管理 |
| **语言** | 中文 / English 运行时切换；开源构建默认英文 |
| **开发者** | 仅开发构建：按分支覆盖提示词、模型基准台、诊断日志 |

### 16 个功能，一份注册表

`js/registry.js` 是唯一事实来源。每个功能声明自己的输入槽、提示词档位、参数、
是否需要选区、输出形态与成本；界面由这些声明生成。因此同一个工具无论是走云端模型
还是本地工作流，行为都一致。

```
生成  文生图 · 相似图 · 商品图 · 图像融合
重绘  局部重绘 · 擦除 · 换色 · 内容修图
修复  高清修复 · 老照片修复 · 人像精修
创意  线稿上色 · 艺术融合 · 原位合成
结构  扩图 · 抠图去背景
```

### 几个关键差别

**选区和图层是一等公民。** 编辑类工具只导出选区或选中图层，发给模型，再按原坐标落回。
模型返回的比例不一致时，用等比铺满 + 图层蒙版裁边，而不是把画面拉变形。

**云端与本地共用一条队列。** 云端同时跑 2 条，本地串行，结果严格按入队顺序写入文档。
每条任务都带一份「点击运行那一刻的图层快照」，并发任务的结果不会混进下一条任务的输入；
取消某一条不会影响其它任务。

**拆图产出的是可编辑图层，不是一张压平的图。** 视觉模型先给出图层蓝图，你可以改名字和
描述，再逐层提取。元素层用纯色底抠像，颜色和光照取自原图像素；如果模型没有按要求给出
纯色底，插件会明确提示，而不是塞给你一个看不见的空层。

## 环境要求

- Adobe Photoshop **24.4 或更高**（支持 UXP 面板）
- macOS 或 Windows
- 图像服务的 API Key；另外可选配一个支持看图的文本模型（拆图分析、提示词助手用）
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI)：可选，用于本地生成
- Node.js **20+**：仅构建与测试需要，运行插件不需要

## 安装

PS Spark 通过侧载安装，需要打开 Photoshop 的开发者模式：
**Photoshop ▸ 设置（Windows：编辑 ▸ 首选项）▸ 增效工具 ▸ 启用开发人员模式**，
然后重启 Photoshop。

### Windows

安装包从 [Releases](https://github.com/henry-cao1/ps-spark/releases/latest) 下载。

1. 完全退出 Photoshop。
2. 把发布包解压到不含空格和中文的路径。
3. 双击 `Install-Windows.bat`：复制到 `%APPDATA%\Adobe\UXP\Plugins\External\`，
   并清理旧版本残留。
4. 启动 Photoshop → **增效工具 ▸ PS Spark**。

### macOS

安装包从 [Releases](https://github.com/henry-cao1/ps-spark/releases/latest) 下载，解压后把插件文件夹
复制到 UXP 目录：

```bash
mkdir -p ~/Library/Application\ Support/Adobe/UXP/Plugins/External
cp -R com.psspark.ps.assistant_1.7.0 ~/Library/Application\ Support/Adobe/UXP/Plugins/External/
```

完全退出并重新打开 Photoshop → **增效工具 ▸ PS Spark**。

> `manifest.json` 的 id 是 `com.psspark.ps.assistant`。UXP 配置与加密存储按 id 隔离；
> 1.7.0 之前的构建用的是另一个 id，因此旧版的 API Key、本地预设和历史不会自动带过来，
> 升级后重新填一次即可。面板与菜单显示的一直是 **PS Spark**。

## 快速上手

1. **接入服务** — 设置 ▸ 图像服务：填服务地址与 API Key。密钥优先存 UXP 加密存储，
   不可用时回退到本地存储；除你配置的接口外，插件不会把数据发到别处。
2. **按用途选模型** — 生成、编辑、拆图各自记住自己的模型，可以用小模型试稿、大模型出图。
3. **生成** — 写提示词、选比例与候选张数，点运行。结果落在新图层，同时进历史。
4. **编辑** — 先框选（或选中图层），再选工具、写要求。没有选区时，重绘按整幅画面处理。
5. **拆图** — 分析当前画面或选中图层，修改蓝图，勾选要拆的层，执行后得到图层组。

## 本地 ComfyUI（可选）

支持本地模型，走 [ComfyUI](https://github.com/comfyanonymous/ComfyUI)，但不是开箱即用：
需要自己按本机安装的模型文件适配工作流。

先启动 ComfyUI（仓库里附了 `Start-ComfyUI.command` / `Start-ComfyUI.bat`），再进入
**设置 ▸ 本地 ComfyUI**：添加起步模板 → **适配本机模型** → **检测全部**，确认服务能跑哪些
预设。其它架构在 ComfyUI 里导出 API 工作流（**Workflow ▸ Export (API)**），再导入 JSON。

Windows 和 macOS 测试时用的本地模型不是同一套，所以在一台机器上能跑的预设，换到另一台
可能需要重新适配；出图质量与速度取决于你安装的模型和硬件。

## 实现结构

```
index.html, js/ui.js     面板外壳、注册表驱动的表单、结果查看器
js/registry.js           16 个功能声明、提示词规格、参数 schema
js/app.js                流程编排、队列、历史、拆图流水线
js/ps.js                 Photoshop 文档与图层操作（batchPlay）
js/services.js           配置、模型表、ComfyUI 适配
js/api.js                HTTP、轮询、ComfyUI 提交
js/store.js              本地归档与缓存
js/i18n.js               中英词典与运行时翻译
js/diag.js               诊断日志与进度
```

四套机制承担了大部分工作：

- **按任务的输入快照** — 导出参考图前，临时隐藏入队之后新增的图层（以及插件上一次的结果）。
  如果你选中了某个图层，它永远保留：选中就意味着要在它基础上迭代。
- **对齐落图** — 结果按等比铺满放置；比例差超过 1% 时，溢出部分用可编辑的图层蒙版裁掉。
- **拆图流水线** — 纯色底抠像、四角探测、原图像素重建，最后按 alpha 重建图层蒙版，
  保证图层仍可编辑。
- **队列** — 基于槽位的调度：云端两个槽、本地一个槽，按序落图，支持单条取消，
  异常退出后残留的 running 任务会被标记为失败。

## 构建与测试

```bash
node tools/build.mjs                 # 发布构建（默认界面中文）
node tools/build.mjs --channel=dev   # 开发构建（含开发者工作台）
node tools/build.mjs --target=oss    # 开源构建（默认界面英文）
node tools/package-win.mjs           # Windows 交付包（安装脚本 + 说明）

cd bench && npm install && npm test  # 9 个套件，705 项断言
```

发布构建会剥离全部开发者模块，并校验禁用字符串是否残留。测试覆盖面板 UI、ComfyUI 适配与
执行、队列调度、Photoshop 命令重试、提示词拼装、Web 测试台与并发池。

```
ps-spark-plugin/       插件源码（manifest.json、index.html、js/、icons/）
bench/                 自动化测试、用例素材、提示词集、Web 测试台
docs/                  开发纪要、验收清单、接入说明
tools/build.mjs        构建脚本（dev / release / oss）
tools/package-win.mjs  Windows 交付打包
```

## 当前状态

版本 **1.7.0**，已在 macOS 与 Windows 的 Photoshop 24.4+ 上运行。

- 自动化覆盖：9 个套件、**705 项断言**
- 实机验收：按功能分章在真实文档上验证；已通过的章节单独归档，回归只重跑受影响的部分
- 已知限制：拆图质量取决于图像模型是否遵守纯色底要求；扩图比例极端时会先弹确认，
  而不是悄悄降质

计划中：英文文档、更多本地工作流模板、预设分享、CI。

## 文档

- [开发纪要](docs/dev/开发纪要-2026-10-30.md) — 时间线、版本、决策、踩过的坑、待办
- [文档索引](docs/README.md) — 每份设计 / 计划 / 接入文档的一句话摘要
- [实机验收清单](docs/bench/实机验收清单-2026-11-01.md) — 按功能分章的逐项验收
- [Windows 测试指南](docs/bench/Windows测试指南.md) — 安装、开发者模式、冒烟步骤
- [本地 ComfyUI 接入说明](docs/dev/integration/本地ComfyUI接入说明-2026-10.md)
- [Web 测试台使用说明](docs/bench/Web测试台-使用说明-2026-10.md)

## 参与贡献

欢迎提交 Issue 与 Pull Request。有问题、Bug 或建议也可以直接发邮件到
**psspark-feedback@hotmail.com**。

提交前请确认：

- 不含 API Key、令牌或本机个人路径；
- 不含第三方受版权保护的文档、提示词或素材；
- 新增界面文案同时加入中英两份词典（`js/i18n.js`）；
- `cd bench && npm test` 通过。

Pull Request 默认以 AGPL-3.0 授权合并。

## 隐私

无统计、无埋点、不回传数据。插件只与你配置的图像服务、文本服务和 ComfyUI 地址通信。
API Key 优先存入 UXP 加密存储（不可用时回退本地存储）；生成历史保存在本机，可在
「历史」页清理。

## 许可证

[AGPL-3.0](LICENSE)。允许商用。如果你修改了 PS Spark 并分发，或把它作为网络服务提供，
必须以相同许可证公开对应源码。第三方组件与商标归属见 [NOTICE](NOTICE)。

## 声明

PS Spark 与 Adobe 无隶属、背书或认证关系。「Adobe」「Photoshop」是 Adobe 的商标，
此处仅用于说明运行环境。模型与厂商名称归各自所有者。API 费用由你自行承担；生成或编辑
的内容需符合当地法律及所使用服务的条款。

---

Copyright (C) 2026 Cao · 反馈：psspark-feedback@hotmail.com · [English](README.md)

# 文档索引

> 公开仓库里的文档分两部分：`docs/dev/` 是过程记录与接入说明，
> `docs/bench/` 是测试台和实机验收说明；可执行代码在 `bench/`。
>
> 设计稿、排期、厂商调研与合规审核属于内部资料，不在公开仓库内。

---

## 一、项目目录

```
ps-spark/
├── README.md                    项目总览（英文，GitHub 主入口）
├── README.zh-CN.md              中文说明
├── LICENSE                      AGPL-3.0 全文
├── NOTICE                       第三方、商标、商业授权声明
├── .gitignore
│
├── ps-spark-plugin/             插件源码（UXP）
│   ├── manifest.json
│   ├── index.html               结构 + 全部样式
│   ├── icons/
│   └── js/
│       ├── registry.js          16 个功能声明 + 提示词模板
│       ├── services.js          配置 / 模型 / 本地预设 / 密钥
│       ├── api.js               云端请求 + ComfyUI + 取消
│       ├── ps.js                Photoshop 操作
│       ├── store.js             历史归档
│       ├── ui.js                公共组件
│       ├── diag.js              日志与进度
│       ├── brand.js             品牌与仓库地址
│       ├── app.js               渲染 + 运行管线 + 队列
│       └── dev/devmode.js       开发者工作台（仅 dev 构建）
│
├── bench/                       模型基准测试台（独立工具，不随插件分发）
│   ├── README.md                工具设计、CLI 用法、指标说明
│   ├── run.mjs                  CLI 跑批
│   ├── web-server.mjs + web/    Web 测试台（零依赖 Node + 原生前端）
│   ├── lib/                     插件沙箱、provider、指标、报告
│   ├── test-*.cjs / test-*.mjs  9 个自动化测试
│   ├── cases/                   冻结用例
│   ├── assets/                  固定测试素材
│   ├── prompts/                 生成提示词集
│   ├── out/                     每次运行的自包含快照（本地数据，不入库）
│   └── preview/                 预览页输出（本地数据，不入库）
│
├── docs/
│   ├── README.md                本文件
│   ├── dev/
│   │   ├── 开发纪要-2026-10-30.md
│   │   └── integration/         本地 ComfyUI 接入说明与示例工作流
│   └── bench/                   测试台与实机验收文档
│
├── tools/build.mjs              构建（dev / release / oss 三渠道）
├── tools/package-win.mjs        Windows 交付包（安装说明 + 一键安装 bat + zip）
├── Start-ComfyUI.command        macOS 一键启动本地 ComfyUI
├── Start-ComfyUI.bat            Windows 一键启动
├── 启动Web测试台.command / .bat  双击启动测试台
└── dist/                        构建产物（不入库）
```

---

## 二、开发文档（docs/dev）

| 文档 | 内容 |
|---|---|
| [开发纪要-2026-10-30.md](dev/开发纪要-2026-10-30.md) | 09-22 → 11-03 完整时间线、版本演进、设计决策、踩坑清单、测试现状 |
| [本地ComfyUI接入说明-2026-10.md](dev/integration/本地ComfyUI接入说明-2026-10.md) | 预设、能力闸门、编辑域 inpaint、队列、验收清单 |
| [Klein4B本机安装说明-2026-10.md](dev/integration/Klein4B本机安装说明-2026-10.md) | Klein 4B（Q8/Q6 + flux2-vae）的安装与实测数据 |
| [ComfyUI-Klein4B-workflow.json](dev/integration/ComfyUI-Klein4B-workflow.json) | 内置模板对应的 API 格式工作流 |

---

## 三、基准测试文档（docs/bench）

| 文档 | 一句话 |
|---|---|
| [README.md](bench/README.md) | 测试台文档导航：两种入口、测试脚本清单、提示词包、运行方式 |
| [实机验收清单-2026-11-01.md](bench/实机验收清单-2026-11-01.md) | 按功能分 10 章（F1–F10），每章一次过完；含「改动 → 只重跑哪章」对照表 |
| [已通过验收-2026-11-02.md](bench/已通过验收-2026-11-02.md) | 已实机跑通的章节归档，主清单不再重复 |
| [提示词能力评测集-2026-10.md](bench/提示词能力评测集-2026-10.md) | 10 组 46 条能力维度用例，横向比模型，不是发布验收项 |
| [Web测试台-使用说明-2026-10.md](bench/Web测试台-使用说明-2026-10.md) | 用例三种来源、提示词包格式、搜索、CSV、跨机复现 |
| [Windows测试指南.md](bench/Windows测试指南.md) | Windows 包安装、开发者模式与冒烟步骤（1.7.0） |

配套的可执行文件与数据：

- 测试脚本：`bench/test-*.cjs` / `test-*.mjs`（9 个，共 705 项）
- 提示词包：`bench/prompts/`
  - `测试提示词-多维度-2026-10-29.txt`（10 组 46 条，评分维度见文件头）
  - `功能测试文本集-2026-10.txt`（冒烟 22 条）
  - `功能测试文本集-完整版-2026-10.txt`（68 条，每功能 L1–L4）
- 用例与素材：`bench/cases/`、`bench/assets/`

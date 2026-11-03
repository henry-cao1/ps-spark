# 模型基准测试（独立工具）

> 定位：**开发/写文档用的内部工具，不随插件分发、不对用户开放**。
> 它不实现任何新功能，只做一件事：把插件的真实提示词与请求规则，批量打到不同模型上，产出可横向对比的结果与报告。
>
> 文档导航、测试脚本清单、提示词包说明见 [`../docs/bench/README.md`](../docs/bench/README.md)。

---

## 为什么独立，而不是做进插件

| | 插件面板 | 这个工具 |
|---|---|---|
| 运行环境 | PS 面板（单文档、交互式） | Node（可并发、可跑几百次、可挂机） |
| 输入 | 当前画布/选区 | 固定素材（保证跨模型可比） |
| 输出 | 图层 | 图片 + JSON + HTML 报告 |
| 用户 | 设计师 | 你自己（选型、写手册、回归） |

把它塞进插件只会让面板变复杂，而且测一次几十张图，面板根本不适合批量跑。

---

## 与插件的数据连接（关键设计）

不是"另写一套提示词"，而是**直接加载插件源码**：

```
bench/lib/plugin.mjs
  ├─ 用 vm 沙箱执行 ps-spark-plugin/js/services.js
  ├─ 再执行 ps-spark-plugin/js/registry.js
  └─ 取出 buildFinalPrompt / normalizeSizeForModel / IMAGE_MODEL_PRESETS …
```

所以：

- 用例只写「实例 id + 用户提示词 + 参数」，**最终提示词由插件自己拼**（含保真锚点、色框定位、资产约束等模板）；
- 插件改了提示词，benchmark 下次运行自动跟着变，不会出现"测的和线上不一样"；
- 输出 `model-profile.json`（成功率 / 中位耗时 / 框外变化 / 各用例状态），后续可被插件读取，用于模型能力标记或默认模型推荐。

---

## 快速开始（从零到第一次真实测试）

```bash
cd bench
npm install        # 只装 pngjs（像素指标用）
npm run assets     # 生成固定测试素材（首次或需要重置时）
npm run init       # 生成 config.json（已存在则不覆盖）
```

**第 1 步：填 Key（二选一）**

```bash
export GRSAI_API_KEY=sk-xxxx          # macOS/Linux
$env:GRSAI_API_KEY="sk-xxxx"          # Windows PowerShell
```

或直接编辑 `config.json` 的 `providers.grsai.apiKey`（该文件已被 git 忽略，不会误提交）。

**第 2 步：确认测什么、花多少钱（不发请求）**

```bash
npm run list          # 用例分类 + config.json 里的模型序号 + Key 是否就绪
npm run dry           # 全部改图用例的请求次数与预估成本
```

**第 3 步：小样本真实测试（推荐第一次只跑 2 用例 × 2 模型）**

```bash
npm run smoke
```

**第 4 步：确认计费与结果无误后放量**

```bash
npm run bench                                      # 12 个改图用例 × config 里全部模型
node run.mjs --config config.json --models 1,3 --cases erase_object,text_edit --repeat 2
```

**第 5 步：看结果**

```bash
open "$(cat out/latest.txt)/report.html"    # macOS
# Windows: start "" "%CD%\out\latest.txt" 后按提示打开
```

每次运行的输入、结果、用例、配置快照都保存在 `out/<runId>/`，可以整目录拷走或归档，见下文「产物」。

**第 6 步：改提示词后一键复测**

```bash
npm run retest                       # 原条件再跑一次
npm run retest -- --repeat 2         # 看模型稳定性
```

改提示词：编辑 `out/<runId>/prompts.json` 后执行 `npm run retest`（详见「提示词文件与一键复测」）。

离线自检（不需要任何 Key）：

```bash
npm run mock          # 2 个假模型跑 12 个改图用例，验证流水线与报告
npm run test:prompts  # P0 校验：声明式模板与旧实现逐字符一致（128 条）
```

---

## 提示词模板校验（P0）

插件把 16 个功能的提示词从 JS 闭包迁移为声明式 `promptSpec` 后，本工具提供固定校验：

```bash
npm run test:prompts
# P0 提示词校验：PASS 309 · FAIL 0 · 对比 128 条
```

覆盖 8 种上下文（空输入 / 带色框 / 换色 / 无资产 / 带资产 / 空输入带资产 / 画布对齐 / 模板覆盖），逐个功能与旧的 `promptTpl.wrap` 对照。任何提示词改动导致不一致都会直接失败并打印 diff 片段。

---

## 提示词文件与一键复测

每次运行都会把**实际发送的提示词**单独存两份：

| 文件 | 用途 |
|---|---|
| `prompts.json` | 可编辑：`prompt`（用户输入）、`finalPrompt`（实际发送）、参数、输入图路径 |
| `prompts.md` | 同内容只读版，按用例列出提示词全文，写手册/评审时直接看 |

**改哪个字段，行为不同**（这是刻意设计的）：

- 改 `prompt` → 用**插件当前模板**重新生成提示词（模板升级后复测会自动跟上）；
- 改 `finalPrompt` → **原样发送**，用于严格复现某一次测试；
- 都不改 → 原样复现，等于"同条件再跑一次看模型稳不稳定"。

一键复测：

```bash
npm run retest                                  # 复测最近一次运行
npm run retest -- out/20261018161500            # 复测指定运行
npm run retest -- --repeat 2                    # 同条件跑两轮
npm run retest -- --models 1,3                  # 换模型复测
```

`prompts.json` 顶层的 `models` 决定默认复测哪几个模型；`images` / `mask` 指向该运行目录内的 `inputs/` 副本，所以**复测时别删原运行目录**（或把整个目录一起拷贝）。

---

## 测哪些功能（覆盖范围）

**默认只跑 `category=edit`（需要输入图、对图做修改的功能）**，纯生图默认关闭。

| 功能实例 | 名称 | 需要输入图 | 分类 | 是否覆盖 | 说明 |
|---|---|---|---|---|---|
| `text2img` | 文生图 | 否 | gen | ❌ 默认关闭 | 纯生图，不参与对比 |
| `similar` | 相似图 | 是（参考） | gen | ❌ 默认关闭 | 参考生成，结果整张重画，不属于改图 |
| `erase` | 擦除 | 是 + 蒙版 | edit | ✅ | 框外变化、残影 |
| `local_redraw` | 局部重绘 | 是 + 蒙版 | edit | ✅ | 指令遵循、框外变化 |
| `recolor` | 换色 | 是 + 蒙版 | edit | ✅ | 只改色相、保持明暗材质 |
| `content_retouch` | 内容修图 | 是 + 蒙版 | edit | ✅ | 改文字/换物 |
| `hd_restore` | 高清修复 | 是 | edit | ✅ | 提升清晰度、保真 |
| `photo_restore` | 老照片修复 | 是 | edit | ✅ | 去划痕、不改编内容 |
| `colorize` | 线稿上色 | 是 | edit | ✅ | 线条保留、配色 |
| `cutout` | 抠图 | 是 | edit | ✅ | 必须透明通道 |
| `composite` | 原位合成 | 是（多图） | edit（gen 通道） | ✅ | 资产保形、位置 |
| `product_shot` | 商品图 | 是（多图） | edit（gen 通道） | ✅ | 商品保形、场景融合 |
| `image_fusion` | 图像融合 | 是（多图） | edit（gen 通道） | ✅ | 透视一致、拼贴痕迹 |
| `art_fusion` | 艺术融合 | 是（多图） | edit（gen 通道） | ✅ | 风格迁移、主体可辨 |
| `portrait_retouch` | 人像精修 | 是 | edit | ⚠️ 需自备 | 合成图没有人脸，测不出真实效果；把人像图放进 `assets/` 再加用例即可 |
| `outpaint` | 扩图 | 是 | edit | ⚠️ 不覆盖 | 扩图要先改画布尺寸再请求，脱离 PS 测的是另一件事；属真机测试项 |

> 目前 12 个可自动对比的改图用例，覆盖 13 个改图功能中的 12 个（人像/扩图见上）。

---

## 配置

```json
{
  "concurrency": 2,
  "timeoutSec": 300,
  "providers": {
    "grsai": {
      "baseUrl": "https://grsai.dakka.com.cn",
      "apiKey": "",
      "apiKeyEnv": "GRSAI_API_KEY",
      "generationsPath": "/v1/images/generations",
      "editsPath": "/v1/images/edits",
      "unifiedPath": "/v1/api/generate"
    }
  },
  "models": [
    { "id": "gpt-image-2.5", "provider": "grsai", "label": "GPT Image 2.5", "pricePerImage": 0.32 }
  ]
}
```

- **Key 读取顺序**：`providers.<name>.apiKey` > 环境变量（`apiKeyEnv`）；推荐环境变量，避免误传配置文件。
- 任何 OpenAI 兼容平台都能加：填 `baseUrl` + 路径即可（硅基流动、百炼、OpenRouter 等）。
- `pricePerImage` 只用于报告里的成本估算，可留空。

---

## 只测指定模型（不用全测）

`--models` 支持三种写法：

```bash
node run.mjs --models all                 # 配置里的全部模型
node run.mjs --models 1,3                 # 按 config.json 里的顺序选第 1、3 个（推荐，短）
node run.mjs --models gpt-image-2.5,seedream-4.5   # 按 id 选
```

配合 `--dry-run` 先确认：

```bash
node run.mjs --models 1,3 --dry-run
# 用例 12 个 × 模型 2 个 × 重复 1 = 24 次请求
# 模型：GPT Image 2.5、Nano Banana Pro
# 预估成本：¥14.64
```

序号越界会直接报错并列出可选模型，不会静默少跑。

---

## 用例

一个用例 = 一次固定请求。文件放在 `bench/cases/*.json`：

```json
{
  "id": "erase_object",
  "title": "擦除 · 框外不变",
  "category": "edit",
  "instance": "erase",
  "prompt": "",
  "images": ["assets/scene.png"],
  "mask": "assets/scene_mask.png",
  "params": { "size": "auto", "quality": "auto" },
  "expected": { "aspectFromFirstImage": true, "maxOutsideChange": 8 }
}
```

| 字段 | 说明 |
|---|---|
| `category` | `edit`（默认跑）/ `gen`（纯生图，配合 `enabled:false` 默认关闭） |
| `enabled` | 设为 `false` 时默认不跑，需要时用 `--all-cases` 或改回 true |
| `instance` | 必须是插件注册表里的 id（`text2img` / `erase` / `local_redraw` / `composite` …）；提示词模板由它决定 |
| `prompt` | 用户输入部分；留空则用实例内置模板（如擦除） |
| `images` | 输入图（相对 `bench/`）；1 张 = 单图，2 张 = 多图参考 |
| `mask` | 可选，白 = 允许修改 |
| `params` | 尺寸/质量/透明等，按实例支持的参数写 |
| `extra` | 少数实例需要（如 `composite` 的 `{"hasAsset":true,"aligned":true}`） |
| `expected` | `aspect`（期望宽高比）或 `aspectFromFirstImage` |

**新增一个用例**：复制一个 JSON 改字段即可，不需要改代码。

---

## 指标

### 自动（每张图都算）

| 指标 | 含义 | 怎么看 |
|---|---|---|
| 状态 / 耗时 | HTTP 成功与端到端时间 | 失败率高的模型直接淘汰 |
| 尺寸 / 比例误差 | 输出宽高与期望的偏差 | >5% 说明模型擅自改画幅（拆图偏色的同源问题） |
| 含透明通道 | PNG 是否带 alpha | 抠图/元素层类用例必须为"是" |
| 空图评分 | 亮度标准差 | <3 多半是纯色失败图 |
| **框外变化** | 蒙版外像素平均变化（%） | **编辑类最关键**：越低越"守规矩"，>8% 基本不可用 |
| 整体变化 | 与输入的整体差异 | 太低 = 没改，太高 = 整张重画 |
| 估算成本 | 单价 × 次数 | 与质量一起看性价比 |

用例里的 `expected` 会变成**硬指标**：`maxOutsideChange`（框外变化上限）、`alpha:true`（必须透明）、画幅误差 ≤3%。报告顶部有「硬指标通过率」一列，每个格子里直接标红绿——这比只看平均分更能筛掉"看着还行但不能用"的模型。

### 人工（报告里点星）

构图、文字正确性、指令遵循、融合自然度这些没法自动判。报告里每个格子有 1–5 星，保存在浏览器本地，可一键导出 `ratings-<runId>.json`。

> 写用户手册时，直接用「自动指标 + 人工评分」的组合结论，比如："qwen-image-3.0 中文文字 4.6 分、框外变化 1.2%，适合海报；nanobanana 综合最高但单张 ¥0.9。"

---

## 产物（每次运行都是自包含的快照）

```
bench/out/<runId>/
  README.txt            本次运行的说明与复现命令
  inputs/               实际发送给模型的输入图与蒙版（原件副本）
  inputs/manifest.json  输入清单：来源、sha256、字节数（确认多次运行用同一份素材）
  images/               模型返回的结果图：用例__模型__第N次.png
  cases.json            本次使用的完整用例定义（含提示词与期望指标）
  config.snapshot.json  服务商地址与模型清单（已剔除 Key）
  run.json              每个请求的完整记录：提示词、尺寸/质量、耗时、指标、错误原文
  results.csv           汇总表，Excel 直接打开（UTF-8 BOM）
  prompts.json          提示词文件（可编辑，用于一键复测）
  prompts.md            提示词全文（便于阅读/写手册）
  report.html           可视化报告（单文件，图片相对引用）
  model-profile.json    模型画像（给插件/文档用）
```

`bench/out/latest.txt` 记录最近一次运行目录。

**归档与对比**：整个 `out/<runId>/` 可以直接压缩发给别人，对方不需要 `assets/` 也能看到当时用的图；`results.csv` 把多次运行的同一列并起来就是横向对比表。`images/` 与 `inputs/` 的命名一一对应，不会混淆哪个结果由哪张输入产生。

---

## 注意事项

- **成本**：默认 12 个改图用例 × N 模型 × 重复次数。先用 `npm run smoke` 或 `--cases erase_object,text_edit` 小范围试，确认没问题再全量。
- **素材**：用例引用的图片/蒙版缺失时会在**发请求前**直接报错并列出缺哪个文件，不会白花钱。
- **限流**：`concurrency` 建议 2；被限流时降到 1，并看 `HTTP 429`。
- **隐私**：素材是本地生成的合成图，不含真实人像；换成自己的图时注意不要提交到公开仓库。
- **可重复**：素材固定、提示词固定、参数固定，唯一变量是模型——这是能横向比的前提。
- **不测 UI**：这里只测"模型出图"，不测 PS 里的落层、蒙版、智能对象等，那些由插件的真机清单覆盖。

---

## 后续可加（按价值）

1. **同用例多随机种子**：目前 `--repeat` 已支持，报告里取中位数即可判断稳定性。
2. **并排大图对比页**：报告现在是格子点开单图，可加"同用例 4 模型并排"。
3. **ComfyUI provider**：本地模型也纳入同一套用例（需要 workflow 模板 + 图片上传）。
4. **回归门禁**：把 `model-profile.json` 与上次运行对比，提示"某模型某用例从 OK 变 FAIL"。

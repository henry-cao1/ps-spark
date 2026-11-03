/*
 * i18n.js — 界面多语言（中文 / English）
 *
 * 设计：
 * - 词典以「中文原文」为 key，英文为 value，调用点零侵入；缺词自动回退中文。
 * - 静态 DOM 在启动时整树替换；运行期新增节点由 MutationObserver 兜底。
 * - 语言存 localStorage `psspark.lang`；未设置时用 BRAND.defaultLang
 *   （开源构建 en，dev/release 构建 zh，由 tools/build.mjs 注入）。
 * - 只翻译文本节点与 placeholder/title/alt，不碰 script/style/textarea。
 */
const I18N = {
  lang: "zh",
  dict: { en: {} },
  records: [],   /* { node, zh, en } 文本节点原始值 */
  attrs: [],     /* { el, attr, zh, en } */
  observer: null,
  applying: false
};

/* ---------------- 词典（中文 → English） ---------------- */

I18N.dict.en = {
  /* ===== 顶栏 / 提示条 / 一句话 ===== */
  "生成": "Generate",
  "编辑": "Edit",
  "拆图": "Split",
  "历史": "History",
  "本软件已开源，如购买请退款": "Open source · Refund if you paid",
  "已开源": "Open source",
  "未开源": "Not open source",
  "如购买请退款": "refund if you paid",
  "许可证": "License",
  "密钥与配置仅存于本机": "keys and settings stay on this machine",
  "点击打开源码仓库（": "Open the source repository (",
  "仓库地址不可用：": "Repository unavailable: ",
  "开源地址将在发布时公布": "The repository will be announced at release",
  "✨ 一句话：说出你想做什么（自动定位功能）": "✨ One line: say what you want (auto-picks the feature)",
  "解析并定位": "Parse & locate",
  "收起": "Collapse",
  "用此功能 →": "Use this feature →",
  "① 描述": "① Describe",
  "② 蓝图": "② Blueprint",
  "③ 执行": "③ Run",

  /* ===== 队列 / 底栏 ===== */
  "队列空闲": "Queue idle",
  "取消全部": "Cancel all",
  "清空已完成": "Clear finished",
  "就绪": "Ready",

  /* ===== 设置：图像服务 ===== */
  "‹ 返回": "‹ Back",
  "设置": "Settings",
  "服务接入 · 图像服务": "Service · Image",
  "点击打开源码仓库": "Open the source repository",
  "节点 / Base URL": "Endpoint / Base URL",
  "模型": "Model",
  "尺寸 / 质量 / 分辨率随所选模型自动调整：gpt-image 系列走 OpenAI 兼容端点；nano-banana 系列走统一端点（比例出图 + 分辨率档）":
    "Size / quality / resolution follow the selected model: gpt-image uses the OpenAI-compatible endpoint; nano-banana uses the unified endpoint (aspect ratio + resolution tiers).",
  "测试连接": "Test connection",
  "未配置 · 点「测试连接」可零成本鉴别 Key 有效性": "Not configured · “Test connection” validates the key at no cost",

  /* ===== 设置：本地 ComfyUI ===== */
  "本地 ComfyUI（一条工作流 · 可绑多台机器）": "Local ComfyUI (one workflow · multiple machines)",
  "模型预设": "Model presets",
  "新增": "Add",
  "复制": "Duplicate",
  "删除": "Delete",
  "名称（显示在模型下拉里）": "Name (shown in the model list)",
  "主地址": "Primary URL",
  "其他机器地址（一行一个，可选）": "Other machine URLs (one per line, optional)",
  "能力（决定它能出现在哪些功能里）": "Capabilities (which features can use it)",
  "透明通道": "Alpha channel",
  "本地局部重绘方式": "Local inpainting mode",
  "拆图统一按「纯洋红底 + 抠色 + 原图像素重建」处理，不依赖这项声明；这里只作能力记录。":
    "Layer splitting always uses “magenta background + chroma key + original pixels”, independent of this setting; it is recorded for reference only.",
  "整图重绘 + 蒙版合成（推荐：模型能力较弱时）": "Redraw whole image + mask composite (recommended for weaker models)",
  "工作流自带蒙版（原样）": "Workflow's own mask (as-is)",
  "模型能力较弱时，选「整图重绘 + 蒙版合成」：把选区向外扩大一圈后整张重绘（不依赖工作流的蒙版质量），再用蒙版把结果裁回选区，边缘按羽化过渡。":
    "When the model is weak, pick “Redraw whole image + mask composite”: the area around the selection is included, the whole image is redrawn (independent of the workflow's mask quality), then the result is cut back to the selection with a feathered edge.",
  "透明背景": "Transparent background",
  "工作流 JSON（API 格式）": "Workflow JSON (API format)",
  "导入 JSON…": "Import JSON…",
  "检测全部": "Probe all",
  "未测试": "Not tested",
  "高级：节点角色 / 采样参数": "Advanced: node roles / sampling",
  "PROMPT 节点 ID（留空自动识别）": "PROMPT node ID (blank = auto-detect)",
  "步数": "Steps",
  "重绘幅度": "Denoise",
  "工作流里把节点标题改成 PROMPT / NEGATIVE / INPUT / MASK / SIZE / OUTPUT，插件按角色注入；没改也能靠类型自动识别。":
    "Rename nodes to PROMPT / NEGATIVE / INPUT / MASK / SIZE / OUTPUT to inject by role; without renaming, node types are auto-detected.",
  "添加内置模板": "Add built-in template",
  "通用 Checkpoint 文生图": "Generic checkpoint · text to image",
  "适配本机模型": "Match local models",
  "适配中…（读取本机模型列表）": "Matching… (reading local model list)",
  "内置模板已在列表里": "Built-in templates already added",
  "「适配本机模型」按 ComfyUI 里实际的文件名改写工作流：子目录、量化档（Q4/Q8）、大小写不同都能对上；本机没装 GGUF 加载器时会自动换成标准加载器。改不动会明确告诉你缺什么，不会把模型硬套上去。换电脑后先点这一下再跑。":
    "“Match local models” rewrites the workflow to the filenames actually present in ComfyUI: subfolders, quantization (Q4/Q8) and letter case are all tolerated; if the GGUF loaders are missing it switches to the standard loaders. When it cannot match, it tells you exactly what is missing instead of forcing a wrong model. After moving to a new machine, click this once before running.",
  "导出预设…": "Export presets…",
  "导入预设…": "Import presets…",
  "同一条工作流可以填多台机器：运行时自动选第一台在线的，某台离线会顺延到下一台；「检测全部」逐台核对是否缺模型文件。不同模型仍需各自的工作流（节点和模型文件名不同），但同一模型不必为每台机器复制一遍。":
    "One workflow can list several machines: the first online one is used at run time, offline ones are skipped. “Probe all” checks each machine for missing model files. Different models still need their own workflow (different nodes and model filenames), but one model does not need a copy per machine.",

  /* ===== 设置：文本服务 ===== */
  "服务接入 · 文本服务（语言模型 / 图片分析）": "Service · Text (LLM / image analysis)",
  "区域（切换候选模型列表）": "Region (switches the model list)",
  "语言模型（提示词助手 / 蓝图 / 指令解析）": "Language model (prompt assistant / blueprint / command parsing)",
  "Base URL（OpenAI 兼容 · 选择模型后自动填充，可修改）": "Base URL (OpenAI-compatible · auto-filled, editable)",
  "图片分析模型（拆图看图专用 · 仅列支持看图的模型）": "Vision model (used by Split · vision-capable only)",
  "语言模型支持看图时自动跟随；不支持时使用上一次跑通的模型": "Follows the language model when it supports vision; otherwise uses the last working model",
  "未配置（可选）· 用于提示词助手 / 拆图看图分析": "Not configured (optional) · used by the prompt assistant and image analysis",

  /* ===== 设置：模型分配 ===== */
  "模型分配（功能 → 模型）": "Model mapping (feature → model)",
  "编辑 / 拆图逐层": "Edit / per-layer split",
  "提示词助手 / 蓝图": "Prompt assistant / blueprint",
  "「跟随默认」= 不覆盖；拆图逐层跟随「编辑」模型": "“Follow default” = no override; per-layer split follows the Edit model",

  /* ===== 设置：默认参数 ===== */
  "默认参数": "Defaults",
  "默认尺寸": "Default size",
  "默认质量": "Default quality",
  "生成候选张数（文生图 / 相似图）": "Candidates per run (text-to-image / similar)",
  "并发请求数（拆图逐层 / 多候选）": "Concurrency (per-layer split / candidates)",
  "并发越高总耗时越短，但更易触发平台限流；不稳时降到 1–2": "Higher concurrency finishes faster but may hit rate limits; drop to 1–2 if unstable",
  "默认透明背景": "Transparent background by default",
  "默认结果裁剪到选区": "Crop result to selection by default",
  "结果以智能对象插入（可无损缩放；拆图除外）": "Insert as smart object (lossless scaling; except Split)",
  "候选张数 = 每次生成几张备选（并发请求，选一张插入，其余存入历史）；也可在功能面板临时调整":
    "Candidates = alternatives per run (requested concurrently; one is inserted, the rest go to history). Can also be adjusted per feature.",

  /* ===== 设置：功能说明 / 诊断 ===== */
  "功能说明（怎么用 · 特点 · 开销）": "Feature guide (usage · highlights · cost)",
  "每个功能从注册表自动生成。开销 = 每运行一次消耗的请求次数（图像 = 生成请求 · 文本 = 文本请求；多候选张数另计）。":
    "Generated from the feature registry. Cost = requests per run (image = generation request; text = text request; extra candidates counted separately).",
  "▸ 展开说明": "▸ Expand",
  "诊断与数据": "Diagnostics & data",
  "记录调试日志（psspark_debug.log）": "Write debug log (psspark_debug.log)",
  "历史缓存": "History cache",
  "统计中…": "Calculating…",
  "更换缓存位置": "Change cache folder",
  "清理未收藏缓存": "Clear unfavorited cache",
  "恢复默认位置": "Restore default location",
  "缓存仅含插件自建目录（结果图与参数记录）；★ 收藏的任务不会被清理；不触碰其它文件。":
    "Only the plugin's own folder is used (results and params). ★ Favorited jobs are never cleared. No other files are touched.",

  /* ===== 预览 ===== */
  "单图": "Single",
  "并排": "Side by side",
  "滑动": "Swipe",
  "关闭": "Close",
  "重做框内区域": "Redo selection",
  "在图上拖一个矩形，可只重做该区域（图像 ×1）": "Drag a rectangle to redo only that area (image ×1)",

  /* ===== 语言设置 ===== */
  "语言 / Language": "Language / 语言",
  "界面语言 / Interface language": "Interface language / 界面语言",
  "切换后立即生效，设置会保存在本机": "Takes effect immediately; saved on this machine",
  "默认语言": "Default language",
  "中文": "Chinese",
  "English": "English",
  "默认：中文（内部构建）": "Default: Chinese (internal build)",
  "默认：English（开源构建）": "Default: English (open-source build)",
  "切换后立即生效，设置会保存在本机": "Applies immediately and is saved on this machine",

  /* ===== 页面属性 ===== */
  "设置（唯一配置入口）": "Settings (the single place to configure)",
  "点击查看开源地址": "Open the source repository",
  "用一句话描述你想做的事，自动定位到对应功能并填好提示词（消耗 1 次文本请求）":
    "Describe your goal in one line; the feature is picked and the prompt filled in (1 text request)",
  "例：把背景换成海边沙滩 / 去掉画面右侧的水印 / 把标题文字改成「夏日特惠」/ 把这张图拆成图层":
    "e.g. replace the background with a beach / remove the watermark on the right / change the title to \"Summer Sale\" / split this image into layers",
  "点击展开/收起队列": "Expand / collapse the queue",
  "sk-xxxxxxxx（填写后自动保存到本机）": "sk-xxxxxxxx (saved locally once entered)",
  "模型名（如 nano-banana-2）": "Model name (e.g. nano-banana-2)",
  "例如 Klein 4B（本机）": "e.g. Klein 4B (local)",
  "ComfyUI 里 Workflow ▸ Export (API) 导出，或点下面的「导入 JSON…」":
    "Export from ComfyUI ▸ Workflow ▸ Export (API), or use “Import JSON…” below",
  "例如 4": "e.g. 4",
  "模型名（如 deepseek-flash）": "Model name (e.g. deepseek-flash)",
  "自定义图片分析模型名": "Custom vision model name",
  "模型名": "Model name",
  "补充要求（可留空，例：把手部改自然）": "Extra instructions (optional, e.g. make the hands natural)",

  /* ===== 功能名 / 描述 ===== */
  "扩写细节": "Expand details",
  "精简": "Shorten",
  "译成英文": "Translate to English",
  "优化表达": "Polish",
  "文生图": "Text to image",
  "用文字描述生成全新图像": "Create a new image from a text description",
  "描述你想生成的画面，例如：一只坐在窗台上的橘猫，午后阳光":
    "Describe the image, e.g. a ginger cat on a windowsill in the afternoon sun",
  "生 成": "Generate",
  "相似图": "Similar image",
  "基于主源画面生成相似但不同的新图": "Create a similar but different image from the main source",
  "主源": "Main source",
  "局部重绘": "Local redraw",
  "在选区内按提示词重绘，选区外保持原样（支持色框定位 + 结果裁剪）":
    "Redraw inside the selection from your prompt; outside stays untouched (color-box masking + result crop)",
  "描述要修改的内容，例如：把选中的物体换成白色陶瓷材质":
    "Describe the change, e.g. turn the selected object into white ceramic",
  "重 绘": "Redraw",
  "擦除": "Erase",
  "去水印": "Remove watermark",
  "移除物体/瑕疵并用周围背景无缝填补；未框选时对当前选中图层的范围执行（别名：去水印）":
    "Remove objects or blemishes and fill with surrounding background; with no selection the current layer's bounds are used (alias: remove watermark)",
  "擦 除": "Erase",
  "换色": "Recolor",
  "把选中区域的颜色改为指定颜色，保留明暗与材质": "Recolor the selection while keeping shading and texture",
  "换 色": "Recolor",
  "内容修图": "Content edit",
  "含改文字": "Text editing",
  "按描述修改选区内容：换物、改文字、调整细节（别名：高级修图）":
    "Edit the selection as described: replace objects, change text, refine details (alias: advanced retouch)",
  "描述修改内容，例如：把招牌上的文字改成「欢迎光临」": "Describe the edit, e.g. change the sign text to \"Welcome\"",
  "修 图": "Edit",
  "高清修复": "Enhance",
  "提升清晰度与细节，去除噪点与轻微模糊": "Improve clarity and detail, remove noise and slight blur",
  "修 复": "Enhance",
  "老照片修复": "Photo restoration",
  "修复划痕、折痕、褪色，还原老照片": "Repair scratches, creases and fading in old photos",
  "人像精修": "Portrait retouch",
  "自然精修人物皮肤与光影，保持人物特征": "Natural skin and lighting retouch while keeping identity",
  "精 修": "Retouch",
  "线稿上色": "Colorize",
  "为线稿/草图填充自然协调的颜色": "Fill line art and sketches with natural colors",
  "上 色": "Colorize",
  "艺术融合": "Art fusion",
  "把参考图的艺术风格融入主源画面": "Blend the reference style into the main image",
  "风格参考": "Style reference",
  "描述融合方式，例如：用水墨画的笔触重新演绎主体": "Describe the blend, e.g. restyle the subject with ink-brush strokes",
  "融 合": "Fuse",
  "原位合成": "Composite in place",
  "把资产图原位合入底图：位置与透视锁定、资产保形，只做接触处自然融合（不选资产 = 只统一画面光影）":
    "Composite assets into the base image in place: position and perspective locked, asset shape preserved, only contact areas blended (no asset selected = unify lighting only)",
  "底图": "Base image",
  "资产图": "Asset image",
  "描述每张资产放在哪里，例如：把资产1的杯子放在木桌右侧，资产2作为背景装饰（留空则由模型选合理位置）":
    "Describe where each asset goes, e.g. put the cup from asset 1 on the right of the wooden table; use asset 2 as background decoration (blank = model chooses)",
  "合 入": "Composite",
  "商品图": "Product shot",
  "以商品素材制作专业展示图（可附模特/背景）": "Create a professional product shot (optional model / background)",
  "模特图": "Model image",
  "背景图": "Background image",
  "制 作": "Create",
  "图像融合": "Image blend",
  "高级溶图": "Advanced blending",
  "把多张图片无缝合成为一张画面（别名：高级溶图）": "Blend multiple images seamlessly into one (alias: advanced blending)",
  "融合素材": "Blend sources",
  "扩图": "Outpaint",
  "向外扩展画面并同步扩展画布：AI 自然延展场景（新区域生成，原区域保持像素不变）":
    "Extend the image and canvas outward: AI continues the scene (new area generated, original pixels kept)",
  "扩 图": "Outpaint",
  "抠图去背景": "Remove background",
  "免抠图": "Cutout",
  "移除背景、只保留主体（透明背景输出；别名：免抠图）": "Remove the background and keep the subject (transparent output; alias: cutout)",
  "抠 图": "Cut out",
  "默认": "Default",
  "无资产 · 光影统一": "No asset · unify lighting",
  "带资产 · 画布对齐": "With asset · canvas aligned",
  "带资产 · 按描述放置": "With asset · place as described",
  "重绘": "Redraw",
  "修复": "Repair",
  "创意": "Creative",
  "结构": "Structure",

  /* ===== 运行期常用文案 ===== */
  "请先打开一个文档": "Open a document first",
  "自定义…": "Custom…",
  "已取消": "Cancelled",
  "已自动保存": "Saved automatically",
  "参考图": "Reference image",
  "失败": "Failed",
  "点击放大预览": "Click to preview",
  "结果": "Result",
  "当前画面": "Current image",
  "运行中…": "Running…",
  "运行中": "Running",
  "等待": "Waiting",
  "重新生成": "Regenerate",
  "请先填写提示词": "Enter a prompt first",
  "插入为新图层": "Insert as new layer",
  "正在运行，结束后可插入": "Running — insert available when it finishes",
  "没有可插入的结果图（任务失败或文件已被清理）": "No result image to insert (task failed or file was cleaned up)",
  "任务未完成，但结果图已归档，可插入": "Task did not finish, but its image is archived and can be inserted",
  "上次运行未完成（Photoshop 已关闭或中断）": "Last run did not finish (Photoshop closed or interrupted)",
  "☆ 收藏": "☆ Favorite",
  "★ 已收藏": "★ Favorited",
  "选中图层": "Selected layer",
  "请先打开要拆分的文档": "Open a document to split first",
  "正在导出画面…": "Exporting image…",
  "插入": "Insert",
  "分层": "Layers",
  "背景": "Background",
  "AI 结果": "AI result",
  "测试失败": "Test failed",
  "已保存": "Saved",
  "密钥已保存到本机": "Key saved locally",
  "密钥保存失败（见日志）": "Failed to save key (see log)",
  "请先填写 API Key": "Enter an API key first",
  "请填写 Base URL": "Base URL is required",
  "国内": "China",
  "国外": "Global",
  "跟随图像服务模型": "Follow image service model",
  "跟随生成 / 图像服务": "Follow generation / image service",
  "跟随文本服务": "Follow text service",
  "请先解析": "Parse first",
  "生成域": "Generate",
  "编辑域": "Edit",
  "画布": "Canvas",
  "选区／画布": "Selection / canvas",
  "自动取自 PS 当前": "Auto from Photoshop",
  "＋ 当前图层": "+ Current layer",
  "本地模型": "Local model",
  "尚无运行记录": "No runs yet",
  "分割": "Segment",
  "测试": "Test",

  /* ===== 功能面板 / 参数 ===== */
  "提示词（必填）": "Prompt (required)",
  "提示词（可选）": "Prompt (optional)",
  "提示词（内置模板）": "Prompt (built-in template)",
  "补充提示（可选）": "Extra prompt (optional)",
  "替换原文": "Replace text",
  "参数": "Parameters",
  "尺寸": "Size",
  "质量": "Quality",
  "候选张数": "Candidates",
  "取 消": "Cancel",
  "参考图（含色框）": "Reference image (with color box)",
  "主源 *": "Main source *",
  "图像输入": "Image input",
  "定位选项": "Locate options",
  "色框标记定位（自动选醒目颜色描边并在提示词中说明）":
    "Color-box locating (auto outline in a vivid color and mention it in the prompt)",
  "结果裁剪到选区（选区外保留原图）": "Crop result to selection (keep the original outside it)",
  "此功能需要选区：请先用选区工具框出区域": "This feature needs a selection: draw one with a selection tool first",
  "当前：只分析选中图层的内容（其余透明）。执行拆图时仍以整个画面为底，各层按原位置对齐。":
    "Current: analyze only the selected layer (the rest transparent). Splitting still uses the whole image as the base and aligns each layer to its original position.",
  "⚠ 当前没有选中图层：请先在 PS 图层面板点选一个图层，或切回「当前画面」":
    "⚠ No layer selected: pick one in the Photoshop Layers panel, or switch back to “Current image”",
  "留空 = 完全由模型看图判断。也可补充偏好，例：只拆文字和 logo / 主体拆成人物与道具两层 / 忽略背景杂物":
    "Leave empty = the model decides from the image. You can add preferences, e.g. split only text and logo / split the subject into character and props / ignore background clutter",
  "运行中…再点「加入队列」会排队执行；队列条里可单独取消":
    "Running… clicking “Add to queue” will queue another run; cancel individual jobs in the queue bar",
  "＋ 加入队列": "+ Add to queue",
  "把本次结果作为新图层再插入一次（图层被删/想多处使用时）":
    "Insert this result again as a new layer (after deleting it, or to reuse it elsewhere)",
  "同参再跑一遍（产生新记录，原记录保留）": "Run again with the same settings (new record; the original is kept)",
  "收藏此任务（清理缓存时豁免）": "Favorite this job (exempt from cache cleanup)",
  "移除（改回自动取当前画面）": "Remove (back to automatic current image)",
  "改用本地图片": "Use a local image",
  "＋ 本地文件": "+ Local file",
  "+ 当前图层": "+ Current layer",
  "请填写提示词": "Enter a prompt",
  "当前画面（未导出）": "Current image (not exported)",
  "选中图层（未导出）": "Selected layer (not exported)",
  "（无，完全由模型看图判断）": "(none, the model decides from the image)",
  "层级顺序：列表越靠下 = 写入越晚 = 越上层（背景层恒在最底）；用每行的 ↑↓ 调整叠放顺序":
    "Layer order: lower in the list = written later = higher in the stack (background always at the bottom); use ↑↓ on each row to reorder",
  "✨ 智能分析补充候选": "✨ Smart analysis suggestions",
  "＋ 添加元素": "+ Add element",
  "② 蓝图（勾选要拆的层；名称与描述可直接修改）":
    "② Blueprint (check the layers to split; names and descriptions are editable)",
  "蓝图还是空的：点上方「✨ 智能分析补充候选」，或「＋ 添加元素」逐条手动填写。":
    "Blueprint is empty: use “✨ Smart analysis suggestions” above, or “+ Add element” to fill it in manually.",
  "自动按已选元素生成：移除所有拆出的元素后自然补全的底图（最后写入，置于最底层）":
    "Generated from the selected elements: a base image with every split element removed and naturally filled in (written last, at the bottom)",
  "开始拆图": "Start split",
  "③ 执行（并发生成 · 串行写入）": "③ Run (concurrent generation · serial writes)",
  "再拆一张 / 重新开始": "Split another / Start over",
  "强度": "Strength",
  "中（推荐）": "Medium (recommended)",
  "轻（保留原图更多）": "Light (keeps more of the original)",
  "重（完全重渲染光影）": "Strong (fully re-renders lighting)",
  "强度通过结果图层的融合比例实现：轻=更多保留原图，重=完全采用重新渲染的光影":
    "Strength is applied as the blend ratio of the result layer: light = keeps more of the original, strong = fully uses the re-rendered lighting",
  "各层并发生成、串行写入新文档；背景层最后写入并置于最底层。完成后自动建图层组（每层独立计费 ×1）。":
    "Layers are generated concurrently and written serially into a new document; the background is written last and placed at the bottom. A layer group is created at the end (each layer billed ×1).",
  "两种用法：① 不添加资产——先在 PS 里把素材图层拖到目标位置摆好，直接点「合 入」，对已摆好的合成做自然融合（光影 / 边缘 / 接触阴影）；② 添加资产——在 PS 图层面板选中素材图层（可多选）后点「＋ 当前图层」，插件会把它们合并成一张与画布对齐的图（位置原样保留），模型只做融合、不再重新摆放":
    "Two ways to use: ① No assets — place the asset layers where you want them in Photoshop, then click Composite: the existing arrangement is blended naturally (lighting / edges / contact shadows); ② With assets — select the asset layers in the Photoshop Layers panel (multi-select) and click “+ Current layer”: they are merged into one canvas-aligned image (positions kept) and the model only blends, never repositions.",
  "补充说明（可选）": "Notes (optional)",
  "云端模型": "Cloud models",
  "本地（ComfyUI）": "Local (ComfyUI)",
  "该本地预设已删除：设置 ▸ 本地 ComfyUI": "This local preset was deleted: Settings ▸ Local ComfyUI",
  "本地预设还没导入工作流：设置 ▸ 本地 ComfyUI": "Local presets have no workflow yet: Settings ▸ Local ComfyUI",
  "全部功能": "All features",
  "拆图对象": "Split target",
  "手动填写蓝图 →": "Write blueprint manually →",
  "预览将发送的画面": "Preview the image that will be sent",
  "自动取自 PS 当前选区／画布（无需手动选择）": "Taken from the current Photoshop selection / canvas",
  "未配置图像服务 · 点右上角 ⚙ 填写 API Key": "Image service not configured · open ⚙ to enter an API key",
  "未配置服务": "Service not configured",
  "本次结果（已归档到本机历史）": "This result (archived to local history)",
  "✨ 提示词助手": "✨ Prompt assistant",
  "📋 粘贴": "📋 Paste",
  "选区可选": "Selection optional",
  "（可框选局部，不选则整幅画面）": "(select an area, or leave it to process the whole image)",
  "未框选 · 按整幅画面处理 · ": "No selection · whole image · ",
  "扩图保留原图区域（挖空蒙版；默认关，关掉融合更自然）":
    "Keep the original area when expanding (punch a mask; off by default — off blends better)",
  "有新任务在跑，插入会在其落图之后执行":
    "A task is running — the insert will happen after it lands",
  "未框选区域：按整幅画面重绘（选区外无法单独保护；只想改局部请先框选）":
    "No selection: redrawing the whole image (areas outside a selection cannot be protected; select first to change just a part)",
  "从系统剪贴板粘贴（UXP 里 Cmd+V 可能无效，用这个）":
    "Paste from the system clipboard (Cmd+V may not work inside UXP — use this)",
  "剪贴板里没有文本（或剪贴板权限未生效）":
    "No text on the clipboard (or clipboard permission is not effective)",
  "已从剪贴板粘贴（Cmd+V 未生效的兜底路径）":
    "Pasted from the clipboard (fallback because Cmd+V did not take effect)",
  "✨ 智能分析画面（看图 · 文本 ×1）": "✨ Analyze the image (vision · text ×1)",
  "尚未导出画面（智能分析会自动导出；也可先点下方「预览」确认内容）":
    "Nothing exported yet (Smart analysis exports automatically; or click “Preview” below)",
  "尚未导入工作流": "No workflow imported yet",
  "未配置文本服务：智能分析需在 设置 ▸ 文本服务 填写 Key（也可先「手动填写蓝图」）":
    "Text service not configured: Smart analysis needs a key in Settings ▸ Text service (or write the blueprint manually)",
  "当前：分析整个画布的可见内容（含背景）。这是默认选项，绝大多数场景用它。":
    "Current: analyze the visible canvas including background. This is the default and right for most cases.",
  "暂无历史任务——运行任意功能后会自动归档到这里（仅存本机，可清理）":
    "No history yet — run any feature and results are archived here (local only, can be cleared)",
  "多张候选：并发生成，选一张插入，其余自动存入历史（可从历史再插入）":
    "Multiple candidates: generated concurrently; one is inserted, the rest go to history (and can be re-inserted)",
  "本地预设都不适用于当前功能（需要「文生图」能力）：设置 ▸ 本地 ComfyUI":
    "No local preset matches this feature (requires text-to-image): Settings ▸ Local ComfyUI",
  "本地预设都不适用于当前功能（需要「局部重绘」能力）：设置 ▸ 本地 ComfyUI":
    "No local preset matches this feature (requires inpainting): Settings ▸ Local ComfyUI",
  "跟随语言模型（其支持看图时）": "Follow the language model (when it supports vision)",

  "修图": "Edit",
  "精修": "Retouch",
  "上色": "Colorize",
  "融合": "Fuse",
  "抠图": "Cut out",
  "制作": "Create",
  "合入": "Composite",
  "位图": "Bitmap",

  /* ===== 功能说明「怎么用」 ===== */
  "直接写提示词描述画面 → 点「生 成」。上限 4 张候选（候选张数在参数里调，默认跟随设置）；多张时在结果卡里选一张插入，其余存入历史。":
    "Write a prompt describing the image → click Generate. Up to 4 candidates (adjust in Parameters; defaults follow Settings); with several, pick one in the result card to insert and the rest go to history.",
  "① 先框选参考区域（不选则用整个画面）② 可写补充说明描述变化方向 ③ 点「生 成」，得到相似但不同的新图。":
    "① Select a reference area (skip to use the whole image) ② optionally note the direction of change ③ click Generate to get a similar but different image.",
  "① 用选框/套索框出要改的区域 ② 填提示词描述改成什么 ③ 点「重 绘」。默认开启色框定位（更精准），结果默认裁剪回选区。":
    "① Select the area to change with marquee or lasso ② describe the change ③ click Redraw. Color-box locating is on by default (more precise) and the result is cropped back to the selection.",
  "① 框选要去掉的物体或水印（也可不框选：将自动以当前选中图层的范围为处理区域）② 点「擦 除」（补充提示可留空）③ 模型用周围背景无缝填补。":
    "① Select the object or watermark to remove (or skip: the current layer's bounds are used) ② click Erase (notes optional) ③ the model fills the area with the surrounding background.",
  "① 框选区域 ② 在参数里填目标颜色 ③ 点「换 色」。只改颜色，明暗、材质与纹理保持不变。":
    "① Select the area ② set the target color in Parameters ③ click Recolor. Only the color changes; shading, material and texture stay.",
  "① 框选（也可不选 = 整图）② 用自然语言描述要改什么（换物 / 改文字 / 调细节）③ 点「修 图」。":
    "① Select (or skip = whole image) ② describe the change in natural language (replace an object / edit text / refine details) ③ click Edit.",
  "打开要提质的小图/模糊图 →（可框选局部）→ 点「修 复」。想微调可在参数区展开内置模板改写。":
    "Open the small or blurry image → (optionally select an area) → click Enhance. Expand the built-in template in Parameters for finer control.",
  "打开老照片 → 点「修 复」。自动去划痕、折痕、褪色，保留人物面貌特征。":
    "Open the old photo → click Enhance. Scratches, creases and fading are repaired while faces are preserved.",
  "框选人物（或不选 = 整图）→ 点「精 修」。自然磨皮、保留皮肤质感与五官特征，不会换脸。":
    "Select the person (or skip = whole image) → click Retouch. Natural skin smoothing that keeps texture and facial features; no face swap.",
  "把线稿放在画布上 →（可框选局部）→ 点「上 色」。可在补充提示里写配色与风格要求。":
    "Place the line art on the canvas → (optionally select an area) → click Colorize. Add color and style notes if you like.",
  "① 主源取当前画面（可先框选）② 上传 1 张风格参考图 ③ 写融合方式或留空 ④ 点「融 合」。":
    "① Take the current image as the main source (select first if needed) ② upload one style reference ③ describe the blend or leave it blank ④ click Fuse.",
  "① 上传商品图（必需）② 可选上传模特图 / 背景图 ③ 点「制 作」，得到电商质感的展示图。":
    "① Upload the product image (required) ② optionally add a model / background ③ click Create for a commerce-ready shot.",
  "① 主源取当前画面 ② 上传 1–4 张融合素材 ③ 点「融 合」。布局由模型重新设计、位置可能被重排；要保形请用「原位合成」。":
    "① Take the current image ② upload 1–4 sources ③ click Fuse. The model re-lays out the scene and may move things; use Composite in place to keep positions.",
  "①（可选）框选要合成的区域，或点「改用本地图片」换底图 ② 上传 1–4 张资产图 ③ 写清每张资产放哪（留空由模型选合理位置）④ 点「合 入」。不传资产 = 只统一画面光影（强度轻/中/重）。":
    "① (Optional) select the target area, or switch the base image ② upload 1–4 assets ③ say where each asset goes (blank = model decides) ④ click Composite. No asset = unify lighting only (light / medium / strong).",
  "①（可选）先框选要扩展的方向 ② 在参数里设置四边扩展比例（默认各 25%）③ 点「扩 图」。画布同步扩展，原区域像素保持不变。":
    "① (Optional) select the direction to extend ② set the expansion ratio per side in Parameters (25% each by default) ③ click Outpaint. The canvas grows and original pixels stay unchanged.",
  "框选主体（或不选 = 整图）→ 点「抠 图」。输出透明背景主体，自动裁剪回选区。":
    "Select the subject (or skip = whole image) → click Cut out. Outputs a transparent-background subject, cropped back to the selection.",
  "未知（按不支持处理）": "Unknown (treated as unsupported)",
  "支持透明通道（真 alpha）": "Alpha supported (true alpha)",
  "不支持（拆图用纯色底 + 抠色）": "Not supported (Split uses solid background + color key)",

  /* ===== 模型描述 / 选项后缀 ===== */
  "基础 · 比例/1K": "basic · aspect/1K",
  "默认 · 比例/1K": "default · aspect/1K",
  "1–4K · 支持透明": "1–4K · alpha",
  "1–4K · 最高质量": "1–4K · best quality",
  "快速 · 仅比例": "fast · aspect only",
  "分辨率 1–4K 可选": "1–4K resolution",
  "1–4K 可选": "1–4K optional",
  "1–2K 可选": "1–2K optional",
  "1–4K · 含极端比例": "1–4K · extreme ratios",
  "1K · 含极端比例": "1K · extreme ratios",
  "2K · 含极端比例": "2K · extreme ratios",
  "4K · 含极端比例": "4K · extreme ratios",
  "支持看图 · 兼容层": "vision · compatibility layer",
  "V4.1 · 支持看图": "V4.1 · vision",
  "深度推理 · 纯文本": "deep reasoning · text only",
  "纯文本 · 需填接入点": "text only · endpoint required",
  "支持看图 · 需填接入点": "vision · endpoint required",
  "支持看图 · 强推理": "vision · strong reasoning",
  "支持看图 · 快": "vision · fast",
  "纯文本": "text only",
  "支持看图 · 以控制台最新名为准": "vision · see vendor console for the latest name",
  "支持看图 · 性价比": "vision · cost effective",
  "支持看图": "vision",
  "纯文本 · 长上下文": "text only · long context",
  "纯文本 · 中文强": "text only · strong Chinese",
  "最稳": "most stable",
  "默认": "default",
  "最快": "fastest",
  "自动": "automatic",
  "自动 · 可微调模板": "automatic · editable template",
  "可选": "optional",
  "必需": "required",
  "无": "none",
  "通义千问（阿里云百炼 · 兼容模式）": "Qwen (Alibaba Cloud Bailian · compatible mode)",
  "智谱 GLM": "Zhipu GLM",
  "Kimi（月之暗面）": "Kimi (Moonshot)",
  "豆包（火山方舟）": "Doubao (Volcano Ark)",
  "国内 (dakka)": "China (dakka)",
  "全球 (grsaiapi)": "Global (grsaiapi)",
  "gpt-image 系列": "gpt-image series",
  "nano-banana 系列": "nano-banana series",
  /* ===== 扩图参数 ===== */
  "扩展 %": "Expand %",
  "扩展 px": "Expand px",
  "扩展方式": "Expansion mode",
  "按百分比（相对原图）": "By percentage (of original)",
  "按像素（绝对值）": "By pixels (absolute)",
  "上": "Top",
  "右": "Right",
  "下": "Bottom",
  "左": "Left",
  "打开一个文档后可预览扩展后的画布尺寸": "Open a document to preview the expanded canvas size",

  /* ===== 二次确认（扩图超限等） ===== */
  "请确认": "Confirm",
  "扩图超出模型上限": "Outpaint exceeds the model limit",
  "这张图会先缩小再放大，效果可能打折": "The image will be downscaled then upscaled — quality may drop",
  "仍然继续": "Continue anyway",
  "返回调整": "Back to adjust",
  "取消": "Cancel",
  "是否仍然继续？": "Continue anyway?",
  "已取消：扩图超出模型上限，参数未提交（可调小扩展量后重试）":
    "Cancelled: the expansion exceeds the model limit, nothing was submitted (reduce it and retry)",
  "接口会先把参考图缩小、生成后再放大：细节和边缘容易发糊，扩展区也更容易跑偏。":
    "The service downscales the reference image, generates, then upscales: detail and edges soften, and the expanded area is more likely to drift.",
  "原图区域可能无法精确对齐；建议减小单侧扩展，或换 nano-banana-2 系列（最高 8:1）。":
    "The original area may not align exactly — reduce one side's expansion, or switch to nano-banana-2 (up to 8:1).",

  /* ===== 拆图：模型能力提示 ===== */
  "拆图需要模型严格照做「纯洋红底 + 位置不变」。nano 系列常会重新构图，抠色容易失败——建议改用 gpt-image-2 / 2.5 系列。":
    "Splitting needs a model that follows \u201cflat magenta backdrop + unchanged position\u201d strictly. Nano models tend to recompose the scene, so keying often fails — gpt-image-2 / 2.5 is recommended."
};

/* 组合型文案：正则 → 英文（$1… 为捕获组） */
I18N.patterns = [
  [/^已适配 (\d+) 个预设：(.+)$/, "Matched $1 preset(s): $2"],
  [/^本机模型已与工作流一致（(\d+) 个预设），无需改动$/, "Local models already match the workflow ($1 preset(s))"],
  [/^缺节点：(.+)（装 ComfyUI-GGUF，或导入用标准加载器的工作流）$/,
    "Missing nodes: $1 (install ComfyUI-GGUF, or import a workflow using standard loaders)"],
  [/^缺模型文件：(.+)$/, function (full, body) {
    return "Missing model files: " + String(body)
      .replace(/（本机有 (.+?)）/g, "(available: $1)")
      .replace(/（本机没有同类文件）/g, "(no similar file locally)");
  }],
  [/^本机另有 (\d+) 个模型没配工作流：(.+)（需要各自的 API 工作流）$/, "$1 more local model(s) without a workflow: $2 (each needs its own API workflow)"],
  [/^连不上 ComfyUI：(\d+) 个预设$/, "Cannot reach ComfyUI: $1 preset(s)"],
  [/^已添加 (\d+) 个内置模板，正在按本机模型适配…$/, "Added $1 built-in template(s); matching local models…"],
  [/^适配失败：(.+)$/, "Matching failed: $1"],
  [/^候选 (\d+) 张$/, "Candidates $1"],
  [/^候选 (\d+)$/, "Candidates $1"],
  [/^(\d+) 张候选$/, "$1 candidates"],
  [/^(\d+) 张（默认 · 单张）$/, "$1 (default · single)"],
  [/^(\d+) 张（默认）$/, "$1 (default)"],
  [/^(\d+) 张$/, "$1"],
  [/^图像 ×(\d+)$/, "image ×$1"],
  [/^第 (\d+) 层$/, "Layer $1"],
  [/^本地 · (.+)$/, function (full, name) { return "Local · " + i18nText(name); }],
  [/^「(.+)」没有可用于当前功能的本地工作流（需要「(.+)」）：设置 ▸ 本地 ComfyUI$/,
    function (full, a, b) {
      return "\u201c" + i18nText(a) + "\u201d has no local workflow for this feature (needs " +
        i18nText(b) + "): Settings ▸ Local ComfyUI";
    }],
  [/^「(.+)」没有「(.+)」工作流：设置 ▸ 本地 ComfyUI$/,
    function (full, a, b) {
      return "\u201c" + i18nText(a) + "\u201d has no \u201c" + i18nText(b) +
        "\u201d workflow: Settings ▸ Local ComfyUI";
    }],
  [/^「(.+)」还没导入工作流：设置 ▸ 本地 ComfyUI$/,
    function (full, a) {
      return "\u201c" + i18nText(a) + "\u201d has no workflow yet: Settings ▸ Local ComfyUI";
    }],
  [/^本地模型 (\d+)$/, "Local model $1"],
  [/^将拆分的画面：当前文档 (.+?)（按可见内容导出）$/, "Image to split: current document $1 (visible content exported)"],
  [/^跟随设置（(.+)）$/, "Follow settings ($1)"],
  [/^模型: (.+)$/, "Model: $1"],
  [/^按钮「(.+)」$/, function (full, x) { return "Button \u201c" + i18nText(x) + "\u201d"; }],
  [/^特点：(.+)$/, function (full, x) { return "Highlights: " + i18nText(x); }],
  [/^怎么用：(.+)$/, function (full, x) { return "How to use: " + i18nText(x); }],
  [/^开销：(.+)$/, function (full, x) { return "Cost: " + i18nText(x); }],
  [/^(\d+) 个节点 · 未测试连接$/, "$1 nodes · not connected yet"],
  [/^画布 (\d+×\d+)$/, "Canvas $1"],
  [/^扩展后画布 (\d+)×(\d+)（原 (\d+)×(\d+) · 左 (\d+) \/ 右 (\d+) \/ 上 (\d+) \/ 下 (\d+) px）$/,
    "Expanded canvas $1×$2 (original $3×$4 · left $5 / right $6 / top $7 / bottom $8 px)"],
  /* 扩图超限二次确认（逐行翻译，见 app.js confirmOutpaintLimit） */
  [/^扩展后画布 (\d+)×(\d+) 超出「(.+)」的原生处理能力。$/,
    "Expanded canvas $1×$2 exceeds what \u201c$3\u201d can handle natively."],
  [/^· 超过上限 (\d+)px（当前 (\d+)px，多出 (\d+)px）$/,
    "· $1px above the limit (currently $2px, $3px over)"],
  [/^建议每边少扩约 (\d+)px，或改用支持更大画布的模型。$/,
    "Try expanding about $1px less per side, or switch to a model with a larger canvas."],
  [/^· 长宽比 ([\d.]+):1 超过该模型支持的 ([\d.]+):1$/,
    "· Aspect $1:1 exceeds this model's $2:1"],
  [/^(⚠ )?扩展后 (\d+)×(\d+) 超过该模型上限 (\d+)px，接口会先缩小再放大，细节可能变糊$/,
    function (full, mark, a, b, c) {
      return (mark || "") + "Expanded " + a + "×" + b + " exceeds this model's " + c +
        "px limit; it will be downscaled then upscaled, so detail may soften";
    }],
  [/^(⚠ )?长宽比 ([\d.]+):1 超出该模型支持（最大 ([\d.]+):1），可能无法精确对齐：建议减小单侧扩展，或换 nano-banana-2 系列（最高 8:1）$/,
    function (full, mark, a, b) {
      return (mark || "") + "Aspect " + a + ":1 is beyond this model's max " + b +
        ":1, so alignment may drift — reduce one side, or switch to nano-banana-2 (up to 8:1)";
    }],
  [/^文档 (\d+×\d+)$/, "Document $1"],
  [/^本地预设都不适用于当前功能（需要「(.+)」能力）：设置 ▸ 本地 ComfyUI$/,
    function (full, x) { return "No local preset matches this feature (requires " + i18nText(x) + "): Settings ▸ Local ComfyUI"; }],
  [/^已选中图层：「(.+)」$/, function (full, x) { return "Selected layer: \u201c" + x + "\u201d"; }],
  [/^图片分析模型：(.+)（可在 设置 ▸ 文本服务 切换）$/,
    function (full, x) { return "Vision model: " + x + " (change in Settings ▸ Text service)"; }],
  [/^(.+) · 用时 (\d+) 秒$/, "$1 · took $2s"],
  [/^用时 (\d+) 秒(?: · (.+))?$/, function (full, s, tail) {
    if (!tail) return "took " + s + "s";
    return "took " + s + "s · " + String(tail).split(" · ")
      .map(function (x) { return i18nText(x); }).join(" · ");
  }],
  [/^抠色失败（保留模型输出）$/, "keying failed (kept model output)"],
  [/^模型未给纯色底$/, "model ignored the flat key color"],
  [/^写入失败：Photoshop 正忙.*$/, "Write failed: Photoshop is busy (a dialog may be open). Close it, then re-insert from History"],
  [/^写入时 Photoshop 拒绝了某条命令.*$/, "Photoshop rejected a command while writing (unusual document state). This layer was skipped — re-insert it from History"],
  [/^纯色底抠图$/, "chroma-key cutout"],
  [/^原图色彩$/, "original colors"],
  [/^模型颜色$/, "model colors"],
  [/^(.+) · 共 (\d+) 张（选中的已插入，其余在历史）$/, "$1 · $2 total (one inserted, rest in history)"],
  [/^(.+) \*$/, function (full, x) { return i18nText(x) + " *"; }],
  [/^自动取自 PS 当前(.+)（也可改用本地图片或选中图层）$/,
    function (full, x) { return "Taken from the current Photoshop " + i18nText(x) + " (or use a local image / selected layer)"; }],
  [/^自动取自 PS 当前(.+)（无需手动选择）$/,
    function (full, x) { return "Taken from the current Photoshop " + i18nText(x); }],
  [/^支持 (\d+)~(\d+) 张 · 来源：PS 选中图层（可多选）或本地文件$/,
    "Supports $1–$2 images · from selected Photoshop layers (multi-select) or local files"],
  [/^提示：(.+)$/, function (full, x) { return "Note: " + i18nText(x); }],
  [/^分析对象：(.+?) · 补充说明：(.+)$/,
    function (full, a, b) { return "Target: " + i18nText(a) + " · Notes: " + i18nText(b); }],
  [/^(.+) · 最后$/, function (full, x) { return i18nText(x) + " · last"; }],
  [/^(.+)·\s*最后$/, function (full, x) { return i18nText(x) + " · last"; }],
  [/^已选 (\d+) 层(?:（含背景 (\d+) 层）)? · 将发送 (\d+) 次图像请求（并发 (\d+) 路，写入串行）$/,
    function (full, n, bg, c, conc) {
      return "Selected " + n + " layer(s)" + (bg ? " (incl. " + bg + " background)" : "") +
        " · " + c + " image request(s) (concurrency " + conc + ", serial writes)";
    }],
  [/^编辑域 · (.+)$/, function (full, x) { return "Edit · " + i18nText(x); }],
  [/^需要选区$/, "Selection required"],
  [/^语言模型 (.+?) 支持看图 → 图片分析自动跟随（两者联动） · 当前生效：(.+)$/,
    "Language model $1 supports vision → image analysis follows automatically · active: $2"],
  [/^全部 (\d+)$/, "All $1"],
  [/^成功 (\d+)$/, "Succeeded $1"],
  [/^失败 (\d+)$/, "Failed $1"],
  [/^★ 收藏 (\d+)$/, "★ Favorites $1"]
];

/* 中文原文 → 英文：精确词典 → 组合规则 → 括号内描述翻译；都不命中则原样返回 */
function i18nText(zh) {
  if (!zh) return zh;
  /* 只有英文模式才替换；中文模式必须原样返回（否则回写文案会变英文） */
  if (I18N.lang !== "en") return zh;
  const exact = I18N.dict.en[zh];
  if (exact) return exact;

  /* 数字 +（最稳/默认/最快） */
  let m = /^(\d+)（(.+)）$/.exec(zh);
  if (m && I18N.dict.en[m[2]]) return m[1] + " (" + I18N.dict.en[m[2]] + ")";

  for (let i = 0; i < I18N.patterns.length; i++) {
    const p = I18N.patterns[i];
    if (p[0].test(zh)) return zh.replace(p[0], p[1]);
  }

  /* 多个「 · 」片段：逐段翻译，全部命中才替换 */
  if (zh.indexOf(" · ") > 0) {
    const segs = zh.split(" · ");
    const mapped = segs.map(function (x) { return i18nText(x); });
    if (mapped.every(function (x, i) { return x !== segs[i]; })) return mapped.join(" · ");
  }

  /* 括号描述：模型名（基础 · 比例/1K） → model (basic · aspect/1K) */
  m = /^(.+?)（(.+?)）(.*)$/.exec(zh);
  if (m) {
    let innerEn = I18N.dict.en[m[2]] || "";
    if (!innerEn) {
      const parts = m[2].split(" · ");
      const mapped = parts.map(function (x) { return I18N.dict.en[x] || ""; });
      if (mapped.every(function (x) { return !!x; })) innerEn = mapped.join(" · ");
    }
    if (innerEn) {
      const head = I18N.dict.en[m[1]] || m[1];
      return head + " (" + innerEn + ")" + m[3];
    }
  }
  return zh;
}

/* ---------------- 语言状态 ---------------- */

function i18nDefaultLang() {
  try {
    if (typeof BRAND !== "undefined" && BRAND.defaultLang === "en") return "en";
  } catch (e) { /* ignore */ }
  return "zh";
}

function i18nSavedLang() {
  try {
    const v = localStorage.getItem("psspark.lang");
    return (v === "en" || v === "zh") ? v : "";
  } catch (e) { return ""; }
}

function i18nLang() { return I18N.lang; }

/* 取英文；未收录则回退中文。vars 支持 {name} 占位 */
function t(zh, vars) {
  let s = zh;
  if (I18N.lang === "en") {
    const en = I18N.dict.en[zh];
    if (en) s = en;
  }
  if (vars) {
    s = String(s).replace(/\{(\w+)\}/g, function (m, k) {
      return (vars[k] != null) ? vars[k] : m;
    });
  }
  return s;
}

/* ---------------- DOM 翻译 ---------------- */

const I18N_SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, INPUT: 1, OPTION: 1, TITLE: 1 };

function __i18nSkip(node) {
  let p = node.parentNode;
  while (p && p.nodeType === 1) {
    if (I18N_SKIP_TAGS[p.tagName]) return true;
    p = p.parentNode;
  }
  return false;
}

function i18nRestore() {
  I18N.records.forEach(function (r) {
    try {
      if (r.node.nodeValue === r.en) r.node.nodeValue = r.zh;
    } catch (e) { /* ignore */ }
  });
  I18N.attrs.forEach(function (a) {
    try {
      if (a.el.getAttribute(a.attr) === a.en) a.el.setAttribute(a.attr, a.zh);
    } catch (e) { /* ignore */ }
  });
  I18N.records = [];
  I18N.attrs = [];
}

function i18nApply(root) {
  if (I18N.lang !== "en") return;
  const base = root || document.body;
  if (!base) return;
  I18N.applying = true;
  try {
    /* 文本节点 */
    const doc = base.ownerDocument || document;
    const list = [];
    try {
      const walker = doc.createTreeWalker(base, 4 /* SHOW_TEXT */, null);
      let n = walker.nextNode();
      while (n) { list.push(n); n = walker.nextNode(); }
    } catch (e) {
      /* 极端环境没有 TreeWalker：退化为遍历元素子节点 */
      const els = base.querySelectorAll ? base.querySelectorAll("*") : [];
      Array.prototype.forEach.call(els, function (el) {
        Array.prototype.forEach.call(el.childNodes || [], function (c) {
          if (c.nodeType === 3) list.push(c);
        });
      });
    }
    list.forEach(function (node) {
      const raw = node.nodeValue;
      if (!raw) return;
      const zh = raw.trim();
      if (!zh || !/[\u4e00-\u9fa5]/.test(zh)) return;
      const en = i18nText(zh);
      if (!en || en === zh) return;
      if (__i18nSkip(node)) return;
      const lead = raw.match(/^\s*/)[0];
      const tail = raw.match(/\s*$/)[0];
      const next = lead + en + tail;
      if (node.nodeValue === next) return;
      I18N.records.push({ node: node, zh: raw, en: next });
      node.nodeValue = next;
    });

    /* placeholder / title / alt */
    const els = base.querySelectorAll ? base.querySelectorAll("[placeholder],[title],[alt]") : [];
    Array.prototype.forEach.call(els, function (el) {
      ["placeholder", "title", "alt"].forEach(function (attr) {
        const zh = el.getAttribute(attr);
        if (!zh || !/[\u4e00-\u9fa5]/.test(zh)) return;
        const en = i18nText(zh);
        if (!en || en === zh) return;
        I18N.attrs.push({ el: el, attr: attr, zh: zh, en: en });
        el.setAttribute(attr, en);
      });
    });
  } catch (e) {
    if (typeof diag === "function") diag("i18n apply warn: " + (e && e.message));
  } finally {
    I18N.applying = false;
  }
}

/* 运行期新增/更新节点：合并成一次，避免频繁触发 */
let __i18nTimer = null;
function __i18nSchedule(root) {
  if (I18N.lang !== "en") return;
  if (__i18nTimer) return;
  __i18nTimer = setTimeout(function () {
    __i18nTimer = null;
    if (I18N.lang === "en") i18nApply(root && (root.isConnected !== false) ? root : document.body);
  }, 150);
}

function i18nObserve() {
  if (I18N.observer || typeof MutationObserver !== "function" || !document.body) return;
  try {
    I18N.observer = new MutationObserver(function (muts) {
      if (I18N.applying || I18N.lang !== "en") return;
      for (let i = 0; i < muts.length; i++) {
        if (muts[i].type === "childList" && muts[i].addedNodes.length) {
          __i18nSchedule();
          return;
        }
        if (muts[i].type === "characterData") {
          __i18nSchedule();
          return;
        }
      }
    });
    I18N.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  } catch (e) {
    if (typeof diag === "function") diag("i18n observer warn: " + (e && e.message));
  }
}

/* ---------------- 对外接口 ---------------- */

function i18nInit() {
  const saved = i18nSavedLang();
  I18N.lang = saved || i18nDefaultLang();
  i18nApply();
  i18nObserve();
  return I18N.lang;
}

/* 创建即翻译的节点登记，保证切回中文能还原 */
function i18nMark(node, zh, en) {
  if (!node || zh == null || en == null || zh === en) return;
  I18N.records.push({ node: node, zh: String(zh), en: String(en) });
}

/* 渲染完成后立即翻译子树（UXP 下 MutationObserver 不可靠，渲染点主动调用） */
function i18nFlush(root) {
  if (I18N.lang !== "en") return;
  i18nApply(root || document.body);
}

function i18nSetLang(lang) {
  const v = (lang === "en") ? "en" : "zh";
  if (v !== I18N.lang) {
    i18nRestore();
    I18N.lang = v;
    try { localStorage.setItem("psspark.lang", v); } catch (e) { /* ignore */ }
  }
  if (v === "en") i18nApply();
  /* 设置页「语言」状态行是拼接文案，需要按新语言重写 */
  try { if (typeof updateLangStatus === "function") updateLangStatus(); } catch (e) { /* ignore */ }
  return v;
}

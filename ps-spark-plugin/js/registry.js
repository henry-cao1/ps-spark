/*
 * registry.js — 功能注册表（唯一事实来源）+ 提示词模板体系（W2）
 * 依据：产品设计方案 v4.1 §3（字段全集 / 三闸门 / 实例预览 19 条）
 * 原则：UI 不写死「按域显隐」——组件出现一律由实例声明驱动（见 ui.js 三闸门渲染）
 *
 * 字段说明：
 *   id · domain(gen/edit) · group · name · alias · desc · modelUse(gen/edit/text)
 *   slots[]   输入槽：{role,label,required,implicit,sources,count{min,max}}
 *             implicit=true 表示自动取自 PS 上下文（画布/选区），不渲染文件选择
 *   prompt    提示词档位：none(无) / auto(自动·可微调模板) / optional(可选) / required(必需)
 *   params[]  参数声明（驱动参数行）：size / quality / transparent / color / expand
 *   paramDefaults / paramOverrides（固定值，如抠图强制透明）
 *   selection none/optional/required · locate[]: box/clip · mask: auto/none
 *   output{form,organize,nameTemplate} · cost{image,text} · flow · runLabel · wip
 *   promptSpec {branches, parts}  声明式提示词（当前生效，供可视化编辑）
 *   promptTpl {text} 或 {wrap(...)}  旧实现，仅在缺少 promptSpec 时回退（P0 迁移期保留）
 */

/* ================= 提示词通用段（保真锚点 / 空语义防幻觉 / 色框定位） ================= */

const PROMPT_FIDELITY = "除上述指定的修改外，画面其余内容（构图、光影、色彩、纹理、文字）必须保持原样不变；不要添加或删除任何未要求的内容。";
const PROMPT_NO_HALLUC = "如果目标区域为空、被遮挡或无法判断，请保持该区域原样，不要凭空生成任何元素。";

/* 色框定位段：颜色名 + HEX 双描述（防模型对颜色名理解漂移）+ 去框指令 */
function boxSegment(color) {
  return "【区域定位】图片中有一个" + color.name + "（" + color.hex + "）的矩形边框，框内即为需要修改的目标区域。" +
    "请只修改色框内部的内容，色框外的内容保持原样不变，并在结果中去除该" + color.name + "边框（结果图不应出现任何彩色边框）。";
}
function buildBoxPrompt(userPrompt, color) {
  return userPrompt + "\n\n" + boxSegment(color);
}

function joinPrompt(parts) {
  return parts.filter(Boolean).join("\n\n");
}

/* 擦除内置模板（"可选"档：用户可另加补充要求，如"去掉水印"） */
const ERASE_BASE = joinPrompt([
  "移除指定区域内的物体／瑕疵（如水印、杂物、路人、污点），并用周围背景自然、无缝地填补该区域：不留下任何痕迹、模糊、涂抹感或残影，被移除的对象不应再出现。",
  PROMPT_FIDELITY,
  PROMPT_NO_HALLUC
]);

/* 提示词助手（文本服务 · 4 种改写方式；工具槽内联于提示词框） */
const ASSIST_ACTIONS = [
  {
    id: "expand", name: "扩写细节",
    sys: "你是图像生成提示词专家。将用户的提示词扩写得更具体、更有画面感：补充主体细节、材质、光线、构图、风格等可执行描述。必须保留用户原有的全部意图与约束（如「只修改某区域」「保持某部分不变」）。不要添加与用户意图无关的元素或文字水印。只输出改写后的提示词本身，不要任何解释、标题或引号。"
  },
  {
    id: "shorten", name: "精简",
    sys: "你是图像生成提示词专家。把用户提示词精简为更短的核心表达，保留主体、动作与关键约束，去掉冗余修饰。只输出改写后的提示词本身，不要任何解释。"
  },
  {
    id: "en", name: "译成英文",
    sys: "Translate the user's image-generation prompt into natural, fluent English. Keep ALL instructions and constraints (e.g. 'only modify the selected area', 'keep the rest unchanged') intact. Output ONLY the translated prompt, no explanations, no quotes."
  },
  {
    id: "polish", name: "优化表达",
    sys: "你是图像生成提示词专家。在不改变意图的前提下优化提示词的表达结构与措辞，使其对图像模型更清晰、更易执行：明确主体、动作、位置、风格，以及需要保持/排除的内容。只输出改写后的提示词本身，不要任何解释。"
  }
];

/* ================= 功能注册表 ================= */

const REGISTRY = [

  /* ========== 生成域（2 项 · 单张输出） ========== */

  {
    id: "text2img", domain: "gen", group: "gen",
    name: "文生图", alias: "", desc: "用文字描述生成全新图像",
    modelUse: "gen",
    slots: [],
    prompt: "required",
    promptPlaceholder: "描述你想生成的画面，例如：一只坐在窗台上的橘猫，午后阳光",
    params: ["size", "quality", "transparent", "variants"],
    paramDefaults: { transparent: false }, /* 候选张数跟随 设置 ▸ 默认参数（默认 1 张） */
    selection: "none", locate: [], mask: "none",
    output: { form: "single", organize: "layer", nameTemplate: "AI: {prompt}" },
    cost: { image: 1, text: 0 },
    flow: "single", runLabel: "生 成",
    promptTpl: {
      wrap: function (u) {
        return joinPrompt([u, "画面需完整清晰、主体明确、细节精致、构图自然；不要出现文字水印或多余边框。"]);
      }
    }
  },
  {
    id: "similar", domain: "gen", group: "gen",
    name: "相似图", alias: "", desc: "基于主源画面生成相似但不同的新图",
    modelUse: "gen",
    refMain: true, /* 业务上以「主源画面」为参考图（自动导出画布/选区），与文生图区分路由 */
    slots: [{ role: "main", label: "主源", required: true, implicit: true, sources: ["canvas", "selection", "file"], count: { min: 1, max: 1 } }],
    prompt: "optional",
    params: ["size", "quality", "transparent", "variants"],
    paramDefaults: { transparent: false }, /* 候选张数跟随 设置 ▸ 默认参数（默认 1 张） */
    selection: "none", locate: [], mask: "none",
    output: { form: "single", organize: "layer", nameTemplate: "AI: {prompt}" },
    cost: { image: 1, text: 0 },
    flow: "single", runLabel: "生 成",
    promptTpl: {
      wrap: function (u) {
        return joinPrompt([
          "以参考图为基准生成一张相似的图像：保持主体的造型特征、构图与整体风格，在细节、背景或光影上做出自然合理的变化，使其成为一张不重复原作的新图。",
          u ? "变化方向：" + u : ""
        ]);
      }
    }
  },

  /* ========== 编辑域 · 重绘组（选区驱动） ========== */

  {
    id: "local_redraw", domain: "edit", group: "redraw",
    name: "局部重绘", alias: "", desc: "在选区内按提示词重绘，选区外保持原样（支持色框定位 + 结果裁剪）",
    modelUse: "edit",
    slots: [{ role: "main", label: "主源", required: true, implicit: true, sources: ["selection", "canvas"], count: { min: 1, max: 1 } }],
    prompt: "required",
    promptPlaceholder: "描述要修改的内容，例如：把选中的物体换成白色陶瓷材质",
    params: ["size", "quality", "transparent"],
    selection: "required", locate: ["box", "clip"], mask: "auto",
    noSelArea: "canvas", /* 无选区 → 按整幅画面重绘（i2i），不再直接拒绝 */
    output: { form: "single", organize: "layer", nameTemplate: "AI 重绘: {prompt}" },
    cost: { image: 1, text: 0 },
    flow: "single", runLabel: "重 绘",
    promptTpl: {
      wrap: function (u, o) {
        return joinPrompt([u, o.color ? boxSegment(o.color) : "", PROMPT_FIDELITY, PROMPT_NO_HALLUC]);
      }
    }
  },
  {
    id: "erase", domain: "edit", group: "redraw",
    name: "擦除", alias: "去水印", desc: "移除物体/瑕疵并用周围背景无缝填补；未框选时对当前选中图层的范围执行（别名：去水印）",
    modelUse: "edit",
    slots: [{ role: "main", label: "主源", required: true, implicit: true, sources: ["selection", "canvas"], count: { min: 1, max: 1 } }],
    prompt: "optional", /* 内置模板 + 「补充提示（可选）」入口（如指定要移除的对象） */
    params: ["size", "quality", "transparent"],
    selection: "optional", locate: ["clip"], mask: "auto",
    noSelArea: "layer", /* 无选区 → 以当前选中图层的像素范围为处理区域 */
    output: { form: "single", organize: "layer", nameTemplate: "AI 擦除: {prompt}" },
    cost: { image: 1, text: 0 },
    flow: "single", runLabel: "擦 除",
    promptTpl: {
      text: ERASE_BASE,
      wrap: function (u) {
        return joinPrompt([ERASE_BASE, u ? "补充要求：" + u : ""]);
      }
    }
  },
  {
    id: "recolor", domain: "edit", group: "redraw",
    name: "换色", alias: "", desc: "把选中区域的颜色改为指定颜色，保留明暗与材质",
    modelUse: "edit",
    slots: [{ role: "main", label: "主源", required: true, implicit: true, sources: ["selection", "canvas"], count: { min: 1, max: 1 } }],
    prompt: "optional",
    params: ["size", "quality", "transparent", "color"],
    paramDefaults: { color: "#FFFFFF" },
    selection: "required", locate: ["clip"], mask: "auto",
    output: { form: "single", organize: "layer", nameTemplate: "AI 换色: {prompt}" },
    cost: { image: 1, text: 0 },
    flow: "single", runLabel: "换 色",
    promptTpl: {
      wrap: function (u, o) {
        var target = (o.params && o.params.color) || "#FFFFFF";
        return joinPrompt([
          "将指定区域内的颜色改为 " + target + "：严格保持区域内的明暗层次、光影方向、材质与纹理不变，只改变颜色本身，不要改变形状或添加元素。",
          u ? "补充要求：" + u : "",
          PROMPT_FIDELITY
        ]);
      }
    }
  },
  {
    id: "content_retouch", domain: "edit", group: "redraw",
    name: "内容修图", alias: "含改文字", desc: "按描述修改选区内容：换物、改文字、调整细节（别名：高级修图）",
    modelUse: "edit",
    slots: [{ role: "main", label: "主源", required: true, implicit: true, sources: ["selection", "canvas"], count: { min: 1, max: 1 } }],
    prompt: "required",
    promptPlaceholder: "描述修改内容，例如：把招牌上的文字改成「欢迎光临」",
    params: ["size", "quality", "transparent"],
    selection: "optional", locate: ["box", "clip"], mask: "auto",
    output: { form: "single", organize: "layer", nameTemplate: "AI 修图: {prompt}" },
    cost: { image: 1, text: 0 },
    flow: "single", runLabel: "修 图",
    promptTpl: {
      wrap: function (u, o) {
        return joinPrompt([
          u,
          "只在标记区域内进行上述修改；修改后的区域需与周围环境自然衔接（光影、透视、质感一致）。",
          o.color ? boxSegment(o.color) : "",
          PROMPT_FIDELITY,
          PROMPT_NO_HALLUC
        ]);
      }
    }
  },

  /* ========== 编辑域 · 修复组（提质还原） ========== */

  {
    id: "hd_restore", domain: "edit", group: "repair",
    name: "高清修复", alias: "", desc: "提升清晰度与细节，去除噪点与轻微模糊",
    modelUse: "edit",
    slots: [{ role: "main", label: "主源", required: true, implicit: true, sources: ["canvas", "selection"], count: { min: 1, max: 1 } }],
    prompt: "auto",
    params: ["size", "quality", "transparent"],
    paramDefaults: { transparent: false },
    selection: "optional", locate: ["clip"], mask: "auto",
    output: { form: "single", organize: "layer", nameTemplate: "AI 高清修复" },
    cost: { image: 1, text: 0 },
    flow: "single", runLabel: "修 复",
    promptTpl: {
      text: "提升整张图像的清晰度与细节：增强纹理与边缘细节、去除噪点与压缩伪影、缓解轻微模糊，保持原有构图、色彩、明暗关系和全部内容不变，不要改变人物或物体的身份与形状。"
    }
  },
  {
    id: "photo_restore", domain: "edit", group: "repair",
    name: "老照片修复", alias: "", desc: "修复划痕、折痕、褪色，还原老照片",
    modelUse: "edit",
    slots: [{ role: "main", label: "主源", required: true, implicit: true, sources: ["canvas", "selection"], count: { min: 1, max: 1 } }],
    prompt: "auto",
    params: ["size", "quality", "transparent"],
    paramDefaults: { transparent: false },
    selection: "optional", locate: [], mask: "none",
    output: { form: "single", organize: "layer", nameTemplate: "AI 老照片修复" },
    cost: { image: 1, text: 0 },
    flow: "single", runLabel: "修 复",
    promptTpl: {
      text: "修复这张老照片：去除划痕、折痕、污渍、霉斑与噪点，修复破损与褪色区域，恢复自然的色彩与细节层次，保持人物的面貌特征和整体构图不变。"
    }
  },
  {
    id: "portrait_retouch", domain: "edit", group: "repair",
    name: "人像精修", alias: "", desc: "自然精修人物皮肤与光影，保持人物特征",
    modelUse: "edit",
    slots: [{ role: "main", label: "主源", required: true, implicit: true, sources: ["canvas", "selection"], count: { min: 1, max: 1 } }],
    prompt: "auto",
    params: ["size", "quality", "transparent"],
    paramDefaults: { transparent: false },
    selection: "optional", locate: [], mask: "none",
    output: { form: "single", organize: "layer", nameTemplate: "AI 人像精修" },
    cost: { image: 1, text: 0 },
    flow: "single", runLabel: "精 修",
    promptTpl: {
      text: "对人物进行自然精修：柔化皮肤瑕疵、保留真实皮肤质感与毛孔、均匀肤色与光影、提亮眼神、整理碎发；保持五官特征与人物身份不变，不要过度磨皮、换脸或改变脸型。"
    }
  },

  /* ========== 编辑域 · 创意组（合成迁移） ========== */

  {
    id: "colorize", domain: "edit", group: "creative",
    name: "线稿上色", alias: "", desc: "为线稿/草图填充自然协调的颜色",
    modelUse: "edit",
    slots: [{ role: "main", label: "主源", required: true, implicit: true, sources: ["canvas", "selection"], count: { min: 1, max: 1 } }],
    prompt: "optional",
    params: ["size", "quality", "transparent"],
    paramDefaults: { transparent: false },
    selection: "optional", locate: ["clip"], mask: "auto",
    output: { form: "single", organize: "layer", nameTemplate: "AI 上色" },
    cost: { image: 1, text: 0 },
    flow: "single", runLabel: "上 色",
    promptTpl: {
      wrap: function (u) {
        return joinPrompt([
          "为线稿／草图填充颜色：为画面各区域铺上自然、协调的色彩，完整保留原有线条与结构关系，上色细腻、光影合理。",
          u ? "配色与风格补充：" + u : ""
        ]);
      }
    }
  },
  {
    id: "art_fusion", domain: "edit", group: "creative",
    name: "艺术融合", alias: "", desc: "把参考图的艺术风格融入主源画面",
    modelUse: "gen",
    slots: [
      { role: "main", label: "主源", required: true, implicit: true, sources: ["canvas", "selection"], count: { min: 1, max: 1 } },
      { role: "ref", label: "风格参考", required: true, implicit: false, sources: ["file"], count: { min: 1, max: 1 } }
    ],
    prompt: "required",
    promptPlaceholder: "描述融合方式，例如：用水墨画的笔触重新演绎主体",
    params: ["size", "quality", "transparent"],
    paramDefaults: { transparent: false },
    selection: "optional", locate: [], mask: "none",
    output: { form: "single", organize: "layer", nameTemplate: "AI 艺术融合" },
    cost: { image: 1, text: 0 },
    flow: "single", runLabel: "融 合",
    promptTpl: {
      wrap: function (u) {
        return joinPrompt([
          u || "将参考图的艺术风格融入主源画面。",
          "以主源画面的构图与内容为基础，把参考图的风格特征（笔触、色调、质感、氛围）自然融入画面；保持主源主体结构清晰可辨，融合自然无拼接痕迹。"
        ]);
      }
    }
  },
  {
    id: "composite", domain: "edit", group: "creative",
    name: "原位合成", alias: "", desc: "把资产图原位合入底图：位置与透视锁定、资产保形，只做接触处自然融合（不选资产 = 只统一画面光影）",
    modelUse: "gen",
    slots: [
      /* 底图：默认自动取自 PS 当前画面/选区，也可替换为本地图片（implicitFile） */
      { role: "main", label: "底图", required: false, implicit: true, implicitFile: true, sources: ["canvas", "selection"], count: { min: 0, max: 1 } },
      /* 资产：0~4 张（留空 = 对已摆好的画面做自然融合，即"PS 里拖好位置再合入"） */
      { role: "asset", label: "资产图", required: false, implicit: false, sources: ["file"], count: { min: 0, max: 4 },
        alignCanvas: true, /* 「＋ 当前图层」：选中图层合并为一张画布对齐图（位置不变，避免资产偏移） */
        hint: "两种用法：① 不添加资产——先在 PS 里把素材图层拖到目标位置摆好，直接点「合 入」，对已摆好的合成做自然融合（光影 / 边缘 / 接触阴影）；② 添加资产——在 PS 图层面板选中素材图层（可多选）后点「＋ 当前图层」，插件会把它们合并成一张与画布对齐的图（位置原样保留），模型只做融合、不再重新摆放" }
    ],
    prompt: "optional",
    promptPlaceholder: "描述每张资产放在哪里，例如：把资产1的杯子放在木桌右侧，资产2作为背景装饰（留空则由模型选合理位置）",
    params: ["size", "quality", "transparent", "strength"],
    paramDefaults: { transparent: false, strength: "medium" },
    selection: "optional", locate: [], mask: "none",
    output: { form: "single", organize: "layer", nameTemplate: "AI 原位合成" },
    cost: { image: 1, text: 0 },
    flow: "single", runLabel: "合 入",
    promptTpl: {
      wrap: function (u, o) {
        var hasAsset = !!(o && o.extra && o.extra.hasAsset);
        if (!hasAsset) {
          /* 无资产：对"已在画面里摆好位置"的素材做自然融合（光影 + 边缘 + 接触阴影；
           * 承原「和谐化」能力并强化边缘过渡，强度 = 结果层不透明度） */
          return joinPrompt([
            "把画面中新贴入/合成的元素与场景做自然融合：分析场景的光源方向、色温、环境色与阴影，使该元素与周围环境完全一致。",
            "调整内容：亮度、对比度、色温、反射光与接触投影与环境匹配；同时处理该元素与背景的边缘过渡（消除硬边、抠图残边与拼贴痕迹），必要时补上自然的接触阴影与倒影。",
            "保持所有物体的形状、位置、纹理与画面内容完全不变：不要移动、替换、删除或新增任何元素。",
            u ? "补充要求：" + u : ""
          ]);
        }
        /* 有资产 · 画布对齐模式：资产图与底图同坐标系，禁止模型重新摆放（避免资产偏移） */
        if (o && o.extra && o.extra.aligned) {
          return joinPrompt([
            "把提供的「资产图」原位合入「底图」，生成一张自然的合成画面。",
            "【对齐】资产图与底图来自同一画布坐标：资产图中的内容必须保持在资产图中的原始位置、大小与比例，禁止移动、缩放、旋转或重新摆放；若两图尺寸不同，请先按画面内容对齐，再原样叠加。",
            "【底图约束】底图的构图、布局、透视、光照方向与全部内容保持完全不变：不移动、不替换、不删除底图中的任何元素。",
            "【资产约束】资产保持自身的形状、比例、朝向与细节：不重绘、不改透视、不新增或省略细节、不改变材质与颜色。",
            "【融合】只在资产与底图的接触处做自然融合：光照方向、色温、明暗、接触阴影与边缘过渡与底图环境一致，无剪贴痕迹。",
            u ? ("【补充】" + u) : "",
            "仅输出一张合成后的完整画面。"
          ]);
        }
        /* 有资产：原位合入（位置与透视锁定、资产保形，只做接触处融合） */
        return joinPrompt([
          "把提供的「资产图」原位合入「底图」，生成一张自然的合成画面。",
          "【底图约束】底图的构图、布局、透视、光照方向与全部内容保持完全不变：不移动、不替换、不删除底图中的任何元素。",
          "【资产约束】资产保持自身的形状、比例、朝向与细节：不重绘、不改透视、不新增或省略细节、不改变材质与颜色。",
          u ? ("【放置与要求】" + u) : "【放置】为每张资产选择一个与底图协调的合理位置与大小，保持自然的空间与透视关系。",
          "【融合】只在资产与底图的接触处做自然融合：光照方向、色温、明暗、接触阴影与边缘过渡与底图环境一致，无剪贴痕迹。",
          "仅输出一张合成后的完整画面。"
        ]);
      }
    }
  },
  {
    id: "product_shot", domain: "edit", group: "creative",
    name: "商品图", alias: "", desc: "以商品素材制作专业展示图（可附模特/背景）",
    modelUse: "gen",
    slots: [
      { role: "main", label: "主源", required: false, implicit: true, sources: ["canvas", "selection"], count: { min: 0, max: 1 } },
      { role: "product", label: "商品图", required: true, implicit: false, sources: ["file"], count: { min: 1, max: 1 } },
      { role: "model", label: "模特图", required: false, implicit: false, sources: ["file"], count: { min: 0, max: 1 } },
      { role: "bg", label: "背景图", required: false, implicit: false, sources: ["file"], count: { min: 0, max: 1 } }
    ],
    prompt: "optional",
    params: ["size", "quality", "transparent"],
    paramDefaults: { transparent: false },
    selection: "none", locate: [], mask: "none",
    output: { form: "single", organize: "layer", nameTemplate: "AI 商品图" },
    cost: { image: 1, text: 0 },
    flow: "single", runLabel: "制 作",
    promptTpl: {
      wrap: function (u) {
        return joinPrompt([
          "制作专业商品展示图：以商品素材为画面主体，置于干净、有质感的场景中；光影柔和真实、投影自然、色彩准确、边缘干净，达到电商主图／广告片质感。",
          u ? "补充要求：" + u : ""
        ]);
      }
    }
  },
  {
    id: "image_fusion", domain: "edit", group: "creative",
    name: "图像融合", alias: "高级溶图", desc: "把多张图片无缝合成为一张画面（别名：高级溶图）",
    modelUse: "gen",
    slots: [
      { role: "main", label: "主源", required: true, implicit: true, sources: ["canvas", "selection"], count: { min: 1, max: 1 } },
      { role: "ref", label: "融合素材", required: true, implicit: false, sources: ["file"], count: { min: 1, max: 4 } }
    ],
    prompt: "optional",
    params: ["size", "quality", "transparent"],
    paramDefaults: { transparent: false },
    selection: "optional", locate: [], mask: "none",
    output: { form: "single", organize: "layer", nameTemplate: "AI 图像融合" },
    cost: { image: 1, text: 0 },
    flow: "single", runLabel: "融 合",
    promptTpl: {
      wrap: function (u) {
        return joinPrompt([
          "把提供的多张图片无缝合成为一张画面：各主体自然组合到同一场景，透视一致、光影统一、色彩协调、边缘过渡自然，无拼贴错位痕迹。",
          u ? "补充要求：" + u : ""
        ]);
      }
    }
  },

  /* ========== 编辑域 · 结构组（画布与图层） ========== */

  {
    id: "outpaint", domain: "edit", group: "struct",
    name: "扩图", alias: "", desc: "向外扩展画面并同步扩展画布：AI 自然延展场景（新区域生成，原区域保持像素不变）",
    modelUse: "edit",
    slots: [{ role: "main", label: "主源", required: true, implicit: true, sources: ["canvas"], count: { min: 1, max: 1 } }],
    prompt: "none",
    params: ["quality", "expand"], /* 尺寸固定 auto（导出图尺寸与扩展后画布一致，不能选标准档） */
    paramDefaults: {
      expand: {
        mode: "percent",
        up: 25, right: 25, down: 25, left: 25,
        px: { up: 0, right: 0, down: 0, left: 0 }
      }
    },
    selection: "none", locate: [], mask: "none",
    output: { form: "single", organize: "layer", nameTemplate: "AI 扩图" },
    cost: { image: 1, text: 0 },
    flow: "single", runLabel: "扩 图",
    promptTpl: {
      text: "画面四周的透明区域是待扩展的画布：请把透明区域补全为与原画面自然连贯的延伸场景（延续纹理、光线、透视、色调与风格），衔接处无缝过渡。\n" +
        "硬性要求：1) 输出画幅与输入图像完全一致——同尺寸、同比例、同构图，不得裁剪、不得改变画幅、不得加边框或留白；" +
        "2) 原画面区域的内容、位置、大小、比例必须保持完全不变，不得缩放、移动、平移或重新构图（原画面只允许被扩展边包围，绝不能被放大/缩小）；" +
        "3) 只补全透明区域，输出为不含透明像素的完整图像。"
    }
  },
  {
    id: "cutout", domain: "edit", group: "struct",
    name: "抠图去背景", alias: "免抠图", desc: "移除背景、只保留主体（透明背景输出；别名：免抠图）",
    modelUse: "edit",
    slots: [{ role: "main", label: "主源", required: true, implicit: true, sources: ["canvas", "selection"], count: { min: 1, max: 1 } }],
    prompt: "none",
    params: ["size", "transparent"],
    paramOverrides: { transparent: true },
    selection: "optional", locate: [], mask: "none",
    output: { form: "single", organize: "layer", nameTemplate: "AI 抠图" },
    cost: { image: 1, text: 0 },
    flow: "single", runLabel: "抠 图",
    promptTpl: {
      text: "只保留画面中的主体（人物／商品／物体），完整移除背景并输出透明背景图像；主体边缘干净自然（发丝等细节保留），不要改变主体的颜色、质感与细节；背景区域必须完全透明。"
    }
  }
];

/* ================= 声明式提示词模板（P0） =================
 * 目的：把提示词从 JS 闭包变成纯数据，供可视化编辑。
 * 结构：
 *   branches  分支（按 when 做等值匹配，自上而下取第一个命中的）
 *   parts     每个分支由若干段组成；字符串=固定段，{text,if}=条件段
 *   {{var}}   运行时插值（user / colorName / colorHex / targetColor）
 * 兼容：promptTpl.wrap 暂时保留，仅在缺少 promptSpec 时回退；改提示词请改这里。
 */

const PROMPT_BOX = "【区域定位】图片中有一个{{colorName}}（{{colorHex}}）的矩形边框，框内即为需要修改的目标区域。" +
  "请只修改色框内部的内容，色框外的内容保持原样不变，并在结果中去除该{{colorName}}边框（结果图不应出现任何彩色边框）。";

const PROMPT_SPECS = {
  text2img: {
    branches: [{ id: "default", label: "默认", when: null }],
    parts: {
      default: [
        { text: "{{user}}", if: "hasUser" },
        "画面需完整清晰、主体明确、细节精致、构图自然；不要出现文字水印或多余边框。"
      ]
    }
  },

  similar: {
    branches: [{ id: "default", label: "默认", when: null }],
    parts: {
      default: [
        "以参考图为基准生成一张相似的图像：保持主体的造型特征、构图与整体风格，在细节、背景或光影上做出自然合理的变化，使其成为一张不重复原作的新图。",
        { text: "变化方向：{{user}}", if: "hasUser" }
      ]
    }
  },

  local_redraw: {
    branches: [{ id: "default", label: "默认", when: null }],
    parts: {
      default: [
        { text: "{{user}}", if: "hasUser" },
        { text: PROMPT_BOX, if: "hasColor" },
        PROMPT_FIDELITY,
        PROMPT_NO_HALLUC
      ]
    }
  },

  erase: {
    branches: [{ id: "default", label: "默认", when: null }],
    parts: {
      default: [
        ERASE_BASE,
        { text: "补充要求：{{user}}", if: "hasUser" }
      ]
    }
  },

  recolor: {
    branches: [{ id: "default", label: "默认", when: null }],
    parts: {
      default: [
        "将指定区域内的颜色改为 {{targetColor}}：严格保持区域内的明暗层次、光影方向、材质与纹理不变，只改变颜色本身，不要改变形状或添加元素。",
        { text: "补充要求：{{user}}", if: "hasUser" },
        PROMPT_FIDELITY
      ]
    }
  },

  content_retouch: {
    branches: [{ id: "default", label: "默认", when: null }],
    parts: {
      default: [
        { text: "{{user}}", if: "hasUser" },
        "只在标记区域内进行上述修改；修改后的区域需与周围环境自然衔接（光影、透视、质感一致）。",
        { text: PROMPT_BOX, if: "hasColor" },
        PROMPT_FIDELITY,
        PROMPT_NO_HALLUC
      ]
    }
  },

  hd_restore: {
    branches: [{ id: "default", label: "默认", when: null }],
    parts: {
      default: ["提升整张图像的清晰度与细节：增强纹理与边缘细节、去除噪点与压缩伪影、缓解轻微模糊，保持原有构图、色彩、明暗关系和全部内容不变，不要改变人物或物体的身份与形状。"]
    }
  },

  photo_restore: {
    branches: [{ id: "default", label: "默认", when: null }],
    parts: {
      default: ["修复这张老照片：去除划痕、折痕、污渍、霉斑与噪点，修复破损与褪色区域，恢复自然的色彩与细节层次，保持人物的面貌特征和整体构图不变。"]
    }
  },

  portrait_retouch: {
    branches: [{ id: "default", label: "默认", when: null }],
    parts: {
      default: ["对人物进行自然精修：柔化皮肤瑕疵、保留真实皮肤质感与毛孔、均匀肤色与光影、提亮眼神、整理碎发；保持五官特征与人物身份不变，不要过度磨皮、换脸或改变脸型。"]
    }
  },

  colorize: {
    branches: [{ id: "default", label: "默认", when: null }],
    parts: {
      default: [
        "为线稿／草图填充颜色：为画面各区域铺上自然、协调的色彩，完整保留原有线条与结构关系，上色细腻、光影合理。",
        { text: "配色与风格补充：{{user}}", if: "hasUser" }
      ]
    }
  },

  art_fusion: {
    branches: [{ id: "default", label: "默认", when: null }],
    parts: {
      default: [
        { text: "{{user}}", if: "hasUser" },
        { text: "将参考图的艺术风格融入主源画面。", if: "noUser" },
        "以主源画面的构图与内容为基础，把参考图的风格特征（笔触、色调、质感、氛围）自然融入画面；保持主源主体结构清晰可辨，融合自然无拼接痕迹。"
      ]
    }
  },

  composite: {
    branches: [
      { id: "noAsset", label: "无资产 · 光影统一", when: { hasAsset: false } },
      { id: "aligned", label: "带资产 · 画布对齐", when: { hasAsset: true, aligned: true } },
      { id: "asset", label: "带资产 · 按描述放置", when: { hasAsset: true, aligned: false } }
    ],
    parts: {
      noAsset: [
        "把画面中新贴入/合成的元素与场景做自然融合：分析场景的光源方向、色温、环境色与阴影，使该元素与周围环境完全一致。",
        "调整内容：亮度、对比度、色温、反射光与接触投影与环境匹配；同时处理该元素与背景的边缘过渡（消除硬边、抠图残边与拼贴痕迹），必要时补上自然的接触阴影与倒影。",
        "保持所有物体的形状、位置、纹理与画面内容完全不变：不要移动、替换、删除或新增任何元素。",
        { text: "补充要求：{{user}}", if: "hasUser" }
      ],
      aligned: [
        "把提供的「资产图」原位合入「底图」，生成一张自然的合成画面。",
        "【对齐】资产图与底图来自同一画布坐标：资产图中的内容必须保持在资产图中的原始位置、大小与比例，禁止移动、缩放、旋转或重新摆放；若两图尺寸不同，请先按画面内容对齐，再原样叠加。",
        "【底图约束】底图的构图、布局、透视、光照方向与全部内容保持完全不变：不移动、不替换、不删除底图中的任何元素。",
        "【资产约束】资产保持自身的形状、比例、朝向与细节：不重绘、不改透视、不新增或省略细节、不改变材质与颜色。",
        "【融合】只在资产与底图的接触处做自然融合：光照方向、色温、明暗、接触阴影与边缘过渡与底图环境一致，无剪贴痕迹。",
        { text: "【补充】{{user}}", if: "hasUser" },
        "仅输出一张合成后的完整画面。"
      ],
      asset: [
        "把提供的「资产图」原位合入「底图」，生成一张自然的合成画面。",
        "【底图约束】底图的构图、布局、透视、光照方向与全部内容保持完全不变：不移动、不替换、不删除底图中的任何元素。",
        "【资产约束】资产保持自身的形状、比例、朝向与细节：不重绘、不改透视、不新增或省略细节、不改变材质与颜色。",
        { text: "【放置与要求】{{user}}", if: "hasUser" },
        { text: "【放置】为每张资产选择一个与底图协调的合理位置与大小，保持自然的空间与透视关系。", if: "noUser" },
        "【融合】只在资产与底图的接触处做自然融合：光照方向、色温、明暗、接触阴影与边缘过渡与底图环境一致，无剪贴痕迹。",
        "仅输出一张合成后的完整画面。"
      ]
    }
  },

  product_shot: {
    branches: [{ id: "default", label: "默认", when: null }],
    parts: {
      default: [
        "制作专业商品展示图：以商品素材为画面主体，置于干净、有质感的场景中；光影柔和真实、投影自然、色彩准确、边缘干净，达到电商主图／广告片质感。",
        { text: "补充要求：{{user}}", if: "hasUser" }
      ]
    }
  },

  image_fusion: {
    branches: [{ id: "default", label: "默认", when: null }],
    parts: {
      default: [
        "把提供的多张图片无缝合成为一张画面：各主体自然组合到同一场景，透视一致、光影统一、色彩协调、边缘过渡自然，无拼贴错位痕迹。",
        { text: "补充要求：{{user}}", if: "hasUser" }
      ]
    }
  },

  outpaint: {
    branches: [{ id: "default", label: "默认", when: null }],
    parts: {
      default: ["画面四周的透明区域是待扩展的画布：请把透明区域补全为与原画面自然连贯的延伸场景（延续纹理、光线、透视、色调与风格），衔接处无缝过渡。\n" +
        "硬性要求：1) 输出画幅与输入图像完全一致——同尺寸、同比例、同构图，不得裁剪、不得改变画幅、不得加边框或留白；" +
        "2) 原画面区域的内容、位置、大小、比例必须保持完全不变，不得缩放、移动、平移或重新构图（原画面只允许被扩展边包围，绝不能被放大/缩小）；" +
        "3) 只补全透明区域，输出为不含透明像素的完整图像。"]
    }
  },

  cutout: {
    branches: [{ id: "default", label: "默认", when: null }],
    parts: {
      default: ["只保留画面中的主体（人物／商品／物体），完整移除背景并输出透明背景图像；主体边缘干净自然（发丝等细节保留），不要改变主体的颜色、质感与细节；背景区域必须完全透明。"]
    }
  }
};

REGISTRY.forEach(function (inst) {
  if (PROMPT_SPECS[inst.id]) inst.promptSpec = PROMPT_SPECS[inst.id];
});

/* ================= 功能说明（设置 ▸ 功能说明） =================
 * 「怎么用」在此维护；「特点」用实例 desc、「开销」用实例 cost（单一事实来源）。 */
const HELP_HOW = {
  /* 生成域 */
  text2img: "直接写提示词描述画面 → 点「生 成」。上限 4 张候选（候选张数在参数里调，默认跟随设置）；多张时在结果卡里选一张插入，其余存入历史。",
  similar: "① 先框选参考区域（不选则用整个画面）② 可写补充说明描述变化方向 ③ 点「生 成」，得到相似但不同的新图。",
  /* 重绘组 */
  local_redraw: "① 用选框/套索框出要改的区域 ② 填提示词描述改成什么 ③ 点「重 绘」。默认开启色框定位（更精准），结果默认裁剪回选区。",
  erase: "① 框选要去掉的物体或水印（也可不框选：将自动以当前选中图层的范围为处理区域）② 点「擦 除」（补充提示可留空）③ 模型用周围背景无缝填补。",
  recolor: "① 框选区域 ② 在参数里填目标颜色 ③ 点「换 色」。只改颜色，明暗、材质与纹理保持不变。",
  content_retouch: "① 框选（也可不选 = 整图）② 用自然语言描述要改什么（换物 / 改文字 / 调细节）③ 点「修 图」。",
  /* 修复组 */
  hd_restore: "打开要提质的小图/模糊图 →（可框选局部）→ 点「修 复」。想微调可在参数区展开内置模板改写。",
  photo_restore: "打开老照片 → 点「修 复」。自动去划痕、折痕、褪色，保留人物面貌特征。",
  portrait_retouch: "框选人物（或不选 = 整图）→ 点「精 修」。自然磨皮、保留皮肤质感与五官特征，不会换脸。",
  /* 创意组 */
  colorize: "把线稿放在画布上 →（可框选局部）→ 点「上 色」。可在补充提示里写配色与风格要求。",
  art_fusion: "① 主源取当前画面（可先框选）② 上传 1 张风格参考图 ③ 写融合方式或留空 ④ 点「融 合」。",
  product_shot: "① 上传商品图（必需）② 可选上传模特图 / 背景图 ③ 点「制 作」，得到电商质感的展示图。",
  image_fusion: "① 主源取当前画面 ② 上传 1–4 张融合素材 ③ 点「融 合」。布局由模型重新设计、位置可能被重排；要保形请用「原位合成」。",
  composite: "①（可选）框选要合成的区域，或点「改用本地图片」换底图 ② 上传 1–4 张资产图 ③ 写清每张资产放哪（留空由模型选合理位置）④ 点「合 入」。不传资产 = 只统一画面光影（强度轻/中/重）。",
  /* 结构组 */
  outpaint: "①（可选）先框选要扩展的方向 ② 在参数里设置四边扩展比例（默认各 25%）③ 点「扩 图」。画布同步扩展，原区域像素保持不变。",
  cutout: "框选主体（或不选 = 整图）→ 点「抠 图」。输出透明背景主体，自动裁剪回选区。"
};
function helpHowFor(inst) {
  return (inst && HELP_HOW[inst.id]) || "";
}

/* ================= 分组元数据 / 查询 ================= */

const EDIT_GROUP_META = [
  { id: "redraw", name: "重绘" },
  { id: "repair", name: "修复" },
  { id: "creative", name: "创意" },
  { id: "struct", name: "结构" }
];

function instById(id) {
  for (var i = 0; i < REGISTRY.length; i++) if (REGISTRY[i].id === id) return REGISTRY[i];
  return null;
}
function genInstances() {
  return REGISTRY.filter(function (r) { return r.domain === "gen"; });
}
function instancesOfGroup(groupId) {
  return REGISTRY.filter(function (r) { return r.domain === "edit" && r.group === groupId; });
}

/* ================= 解析辅助（供 ui.js / 执行器共用） ================= */

/* 参数默认值：实例覆盖 > 设置默认参 > 内置兜底 */
function paramDefaultsFor(inst) {
  var s = getDefaults();
  var o = inst.paramDefaults || {};
  return {
    size: o.size || s.size || "auto",
    quality: o.quality || s.quality || "auto",
    transparent: (o.transparent != null) ? o.transparent : (s.transparent !== false),
    color: o.color || "#FFFFFF",
    expand: o.expand || {
      mode: "percent",
      up: 25, right: 25, down: 25, left: 25,
      px: { up: 0, right: 0, down: 0, left: 0 }
    },
    /* 生成域多候选张数：实例覆盖 > 设置 ▸ 默认参数 > 1（默认单张，可调） */
    variants: (o.variants != null) ? o.variants : ((s.variants != null) ? s.variants : 1),
    strength: o.strength || "medium"                    /* 原位合成·光影模式强度：light/medium/strong */
  };
}

function resolveParams(inst, st) {
  var d = paramDefaultsFor(inst);
  var out = {};
  (inst.params || []).forEach(function (k) {
    var cur = (st && st.params) ? st.params[k] : undefined;
    if (k === "expand") {
      out[k] = Object.assign({}, d.expand, (cur && typeof cur === "object") ? cur : {});
    } else {
      out[k] = (cur != null) ? cur : d[k];
    }
  });
  /* 分辨率（imageSize）：未在 inst.params 中声明（仅部分模型支持），随实例状态透传，
     否则「重新生成」会丢失用户选择（回退为该模型默认档） */
  if (st && st.params && st.params.imageSize != null) out.imageSize = st.params.imageSize;
  if (inst.paramOverrides) {
    Object.keys(inst.paramOverrides).forEach(function (k2) { out[k2] = inst.paramOverrides[k2]; });
  }
  return out;
}

function resolveLocate(inst, st) {
  var out = {};
  if (!inst.locate || !inst.locate.length) return out;
  var s = getDefaults();
  if (inst.locate.indexOf("box") >= 0) {
    out.box = (st && st.locate && st.locate.box != null) ? !!st.locate.box : true;
  }
  if (inst.locate.indexOf("clip") >= 0) {
    out.clip = (st && st.locate && st.locate.clip != null) ? !!st.locate.clip : (s.clip !== false);
  }
  return out;
}

/* ================= 声明式模板渲染 ================= */

function promptSpecContext(u, color, params, extra) {
  var p = params || {};
  var ex = extra || {};
  var hasUser = !!u;
  return {
    user: u,
    hasUser: hasUser,
    noUser: !hasUser,
    colorName: (color && color.name) || "",
    colorHex: (color && color.hex) || "",
    hasColor: !!(color && color.hex),
    targetColor: p.color || "#FFFFFF",
    hasAsset: !!ex.hasAsset,
    aligned: !!ex.aligned,
    assetCount: ex.assetCount != null ? ex.assetCount : 1
  };
}

function promptBranchFor(spec, ctx) {
  var bs = (spec && spec.branches) || [];
  for (var i = 0; i < bs.length; i++) {
    var when = bs[i].when;
    if (!when) return bs[i];
    var ok = true;
    var keys = Object.keys(when);
    for (var j = 0; j < keys.length; j++) {
      if (ctx[keys[j]] !== when[keys[j]]) { ok = false; break; }
    }
    if (ok) return bs[i];
  }
  return null;
}

/* 只做 {{name}} 文本替换；未知变量原样保留（编辑器会提示） */
function interpolatePrompt(text, ctx) {
  return String(text).replace(/\{\{(\w+)\}\}/g, function (m, k) {
    return Object.prototype.hasOwnProperty.call(ctx, k) ? String(ctx[k] == null ? "" : ctx[k]) : m;
  });
}

function renderParts(parts, ctx) {
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (typeof p === "string") {
      var s = interpolatePrompt(p, ctx);
      if (s) out.push(s);
      continue;
    }
    if (!p || typeof p.text !== "string") continue;
    if (p.if && !ctx[p.if]) continue;
    var t = interpolatePrompt(p.text, ctx);
    if (t) out.push(t);
  }
  return out.join("\n\n");
}

function renderPromptSpec(spec, ctx) {
  if (!spec || !spec.parts) return null;
  var branch = promptBranchFor(spec, ctx);
  if (!branch || !spec.parts[branch.id]) return null;
  return renderParts(spec.parts[branch.id], ctx);
}

/* 模板覆盖钩子：默认无提供者（发布构建不加载开发者模块）。
 * 提供者签名 (inst, ctx) → parts 数组 | null；返回 null 表示用内置模板。
 * 这里只做通用转发，不出现任何开发者存储键。 */
var __promptOverrideProvider = null;
function setPromptOverrideProvider(fn) {
  __promptOverrideProvider = (typeof fn === "function") ? fn : null;
}
function promptOverrideParts(inst, ctx) {
  if (!__promptOverrideProvider) return null;
  try {
    var parts = __promptOverrideProvider(inst, ctx);
    return (parts && parts.length) ? parts : null;
  } catch (e) {
    return null;
  }
}

/* 用给定 parts 走与 buildFinalPrompt 相同的 4 档调度（供编辑器预览草稿） */
function buildPromptFromParts(inst, parts, userText, color, params, tplOverride, extra) {
  var tpl = inst.promptTpl || {};
  var u = (userText || "").trim();
  var ov = (tplOverride || "").trim();
  var ctx = promptSpecContext(u, color, params, extra);
  var specText = parts ? renderParts(parts, ctx) : renderPromptSpec(inst.promptSpec, ctx);
  switch (inst.prompt) {
    case "none":
      return specText != null ? specText : (tpl.text || "");
    case "auto":
      return ov || (specText != null ? specText : (tpl.text || ""));
    case "optional":
    case "required":
      if (specText != null) return specText;
      return tpl.wrap ? tpl.wrap(u, { color: color, params: params, extra: extra || null }) : u;
    default:
      return u;
  }
}

/* 最终提示词：4 档调度（none/auto 用模板文本；optional/required 走模板包装）。
 * extra：运行时上下文（如 { hasAsset: true } 供「原位合成」双模式模板切换）。
 * 优先使用 promptSpec（纯数据）；缺少时回退旧的 promptTpl.wrap。
 * 开发者模式可通过 setPromptOverrideProvider 注入模板覆盖（发布版无提供者）。 */
function buildFinalPrompt(inst, userText, color, params, tplOverride, extra) {
  var u = (userText || "").trim();
  var ctx = promptSpecContext(u, color, params, extra);
  var parts = promptOverrideParts(inst, ctx);
  return buildPromptFromParts(inst, parts, userText, color, params, tplOverride, extra);
}

function layerNameFor(inst, text) {
  var t = (text || "").replace(/\s+/g, " ").trim().slice(0, 20).replace(/[，。；、,.;:：!！?？\-\s]+$/, "");
  return "AI " + inst.name + ": " + (t || "结果");
}

/* 候选张数：仅当实例声明 variants 参数时生效（生成域多候选；1~4，默认 1） */
function variantsOf(inst, st) {
  if (!inst || !inst.params || inst.params.indexOf("variants") < 0) return 1;
  var d = paramDefaultsFor(inst);
  var v = (st && st.params && st.params.variants != null) ? parseInt(st.params.variants, 10) : parseInt(d.variants, 10);
  if (isNaN(v) || v < 1) v = 1;
  return Math.max(1, Math.min(4, v));
}

/* 原位合成·光影模式强度 → 结果图层不透明度（轻/中/重；不透明度越低 = 保留原图越多 = 调整越轻） */
function strengthOpacityOf(st) {
  var s = (st && st.params && st.params.strength) || "medium";
  if (s === "light") return 45;
  if (s === "strong") return 100;
  return 70;
}

function costBadge(inst) {
  var c = inst.cost || {};
  var s = "图像 ×" + (c.image != null ? c.image : 1);
  if (c.text) s += " · 文本 ×" + c.text;
  return s;
}

/* 运行条上的实时成本文案（候选张数会改变实际请求次数） */
function costTextFor(inst, st) {
  var n = variantsOf(inst, st);
  if (n > 1) return "图像 ×" + n + "（" + n + " 张候选）";
  return costBadge(inst);
}

/* 模型分配：功能用途 → 实际模型名 */
function resolveModel(use) {
  var m = getModelMap();
  var img = getImageService();
  /* 各域在面板里可临时切换模型（gen / edit / decomp），覆盖设置里的分配 */
  if (typeof getModelOverride === "function") {
    var ov = getModelOverride(use);
    if (ov) return ov;
  }
  if (use === "gen") return m.gen || img.model || DEFAULT_IMAGE_SERVICE.model;
  if (use === "edit" || use === "decomp") return m.edit || m.gen || img.model || DEFAULT_IMAGE_SERVICE.model;
  var t = getTextService();
  return m.text || t.model || DEFAULT_TEXT_SERVICE.model;
}

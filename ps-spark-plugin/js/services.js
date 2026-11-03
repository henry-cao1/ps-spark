/*
 * services.js — 服务接入与配置存储（W0 骨架）
 * - 双服务结构：图像服务 / 文本服务（OpenAI 兼容）
 * - 模型分配 / 默认参数 / 诊断开关
 * - 密钥：secureStorage 优先 + localStorage 兜底（保留 coerceKey 字节数组还原）
 * - 旧键兼容：pssparkBaseUrl → psspark.imageService
 */

/* ---------------- 基础存取 ---------------- */

function lsGetJSON(key, dft) {
  try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : dft; } catch (e) { return dft; }
}
function lsSetJSON(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); return true; }
  catch (e) { diag("localStorage 写入失败(" + key + "): " + (e && e.message)); return false; }
}

/* ---------------- 服务定义 ---------------- */

const DEFAULT_IMAGE_SERVICE = { baseUrl: "https://grsai.dakka.com.cn", model: "gpt-image-2.5" };
/* DeepSeek 旧模型名 deepseek-chat / deepseek-reasoner 已于 2026-07-24 停用；现行为 deepseek-flash / deepseek-v4-pro。
 * baseUrl 统一带版本段（/v1），与各平台「OpenAI 兼容」接入格式一致。 */
const DEFAULT_TEXT_SERVICE = { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-flash", region: "cn", visionModel: "__follow__" };
const RETIRED_TEXT_MODELS = ["deepseek-chat", "deepseek-reasoner"];

function getImageService() {
  const s = lsGetJSON("psspark.imageService", null);
  if (s && s.baseUrl) return { baseUrl: s.baseUrl, model: s.model || DEFAULT_IMAGE_SERVICE.model };
  /* 旧键兼容读取：pssparkBaseUrl → 图像服务 */
  let legacy = null;
  try { legacy = localStorage.getItem("pssparkBaseUrl"); } catch (e) { /* ignore */ }
  return { baseUrl: legacy || DEFAULT_IMAGE_SERVICE.baseUrl, model: DEFAULT_IMAGE_SERVICE.model };
}
function saveImageService(svc) {
  return lsSetJSON("psspark.imageService", { baseUrl: svc.baseUrl, model: svc.model || DEFAULT_IMAGE_SERVICE.model });
}

function getTextService() {
  const s = lsGetJSON("psspark.textService", null);
  if (s && s.baseUrl) {
    let model = s.model || DEFAULT_TEXT_SERVICE.model;
    if (RETIRED_TEXT_MODELS.indexOf(model) >= 0) model = DEFAULT_TEXT_SERVICE.model; // 已停用的旧名自动替换
    const p = textModelPreset(model);
    return {
      baseUrl: s.baseUrl,
      model: model,
      region: s.region || (p ? p.region : DEFAULT_TEXT_SERVICE.region),
      visionModel: s.visionModel || "__follow__"   /* "__follow__" = 跟随语言模型；否则为指定模型名 */
    };
  }
  return {
    baseUrl: DEFAULT_TEXT_SERVICE.baseUrl,
    model: DEFAULT_TEXT_SERVICE.model,
    region: DEFAULT_TEXT_SERVICE.region,
    visionModel: DEFAULT_TEXT_SERVICE.visionModel
  };
}
function saveTextService(svc) {
  return lsSetJSON("psspark.textService", {
    baseUrl: svc.baseUrl,
    model: svc.model || DEFAULT_TEXT_SERVICE.model,
    region: svc.region || DEFAULT_TEXT_SERVICE.region,
    visionModel: svc.visionModel || "__follow__"
  });
}

/* ---------------- 文本模型能力（看图 / 纯文本） ----------------
 * DeepSeek V4.1-Flash（deepseek-flash）自 2026-09-10 起原生支持图像输入
 * （OpenAI 兼容：user 消息 content 数组里的 image_url，base64 data URI 内联）；
 * deepseek-v4-pro 为纯文本模型，发送图片会被拒（400）。
 * 自定义模型按「未知」处理：先尝试带图，若服务端明确报不支持则自动降级为纯文本分析。 */

/*
 * 文本模型目录（区域 × 厂商 · 统一 OpenAI 兼容 /chat/completions 接入格式）
 *
 * 字段：
 *   id / label / region(cn|intl) / vendor（下拉分组标题）/ baseUrl（该厂商官方兼容端点，含版本段）
 *   vision：true 支持图片分析（看图），false 纯文本
 *
 * ⚠ 各平台模型名与地址迭代极快（2026-10 核对）：预设仅作「一键填充」，
 *    实际可用模型名以平台控制台为准；不在列表中的模型可用「自定义…」填写。
 *    自定义 Base URL 请填到「含版本段」为止（如 https://xxx/v1），插件会补 /chat/completions。
 */
const TEXT_MODEL_CATALOG = [
  /* —— 国内 —— */
  { id: "deepseek-flash", label: "deepseek-flash（V4.1 · 支持看图）", region: "cn", vendor: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", vision: true },
  { id: "deepseek-v4-pro", label: "deepseek-v4-pro（深度推理 · 纯文本）", region: "cn", vendor: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", vision: false },
  { id: "qwen3-vl-plus", label: "qwen3-vl-plus（支持看图）", region: "cn", vendor: "通义千问（阿里云百炼 · 兼容模式）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", vision: true },
  { id: "qwen3-max", label: "qwen3-max（纯文本 · 中文强）", region: "cn", vendor: "通义千问（阿里云百炼 · 兼容模式）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", vision: false },
  { id: "glm-5.1", label: "glm-5.1（纯文本）", region: "cn", vendor: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", vision: false },
  { id: "glm-5v", label: "glm-5v（支持看图 · 以控制台最新名为准）", region: "cn", vendor: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", vision: true },
  { id: "kimi-latest", label: "kimi-latest（支持看图）", region: "cn", vendor: "Kimi（月之暗面）", baseUrl: "https://api.moonshot.cn/v1", vision: true },
  { id: "kimi-k3", label: "kimi-k3（纯文本 · 长上下文）", region: "cn", vendor: "Kimi（月之暗面）", baseUrl: "https://api.moonshot.cn/v1", vision: false },
  { id: "doubao-seed-1-6", label: "doubao-seed-1-6（支持看图 · 需填接入点）", region: "cn", vendor: "豆包（火山方舟）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", vision: true },
  { id: "doubao-1-6-pro", label: "doubao-1-6-pro（纯文本 · 需填接入点）", region: "cn", vendor: "豆包（火山方舟）", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", vision: false },
  /* —— 国外 —— */
  { id: "gpt-5.4", label: "gpt-5.4（支持看图）", region: "intl", vendor: "OpenAI", baseUrl: "https://api.openai.com/v1", vision: true },
  { id: "gpt-5.4-mini", label: "gpt-5.4-mini（支持看图 · 性价比）", region: "intl", vendor: "OpenAI", baseUrl: "https://api.openai.com/v1", vision: true },
  { id: "gemini-3.8-flash", label: "gemini-3.8-flash（支持看图 · 快）", region: "intl", vendor: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", vision: true },
  { id: "gemini-3.1-pro", label: "gemini-3.1-pro（支持看图 · 强推理）", region: "intl", vendor: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", vision: true },
  { id: "grok-4.7", label: "grok-4.7（支持看图）", region: "intl", vendor: "xAI Grok", baseUrl: "https://api.x.ai/v1", vision: true },
  { id: "claude-sonnet-5.5", label: "claude-sonnet-5.5（支持看图 · 兼容层）", region: "intl", vendor: "Anthropic Claude", baseUrl: "https://api.anthropic.com/v1", vision: true },
  { id: "mistral-large-latest", label: "mistral-large-latest（纯文本）", region: "intl", vendor: "Mistral", baseUrl: "https://api.mistral.ai/v1", vision: false }
];

/* 历史/别名 ID：请求仍被接受，且由 V4.1-Flash 承接（具备视觉能力） */
const TEXT_MODEL_VISION_ALIASES = {
  "deepseek-v4-flash": true,
  "deepseek-v4-flash-vision-exp": true
};

const TEXT_REGION_META = [
  { id: "cn", name: "国内" },
  { id: "intl", name: "国外" }
];
const TEXT_DEFAULT_VISION_MODEL = "deepseek-flash";
const TEXT_FOLLOW_VISION = "__follow__";

function textModelPreset(id) {
  const m = String(id || "").trim();
  for (let i = 0; i < TEXT_MODEL_CATALOG.length; i++) {
    if (TEXT_MODEL_CATALOG[i].id === m) return TEXT_MODEL_CATALOG[i];
  }
  return null;
}
function textModelCatalogForRegion(region) {
  return TEXT_MODEL_CATALOG.filter(function (p) { return p.region === region; });
}
function textVisionModelPresets() {
  return TEXT_MODEL_CATALOG.filter(function (p) { return p.vision; });
}
/* 返回 "yes"（支持图像输入）/ "no"（纯文本）/ "unknown"（自定义模型，按支持尝试） */
function textModelVision(model) {
  const id = String(model || "").trim();
  if (!id) return "unknown";
  const p = textModelPreset(id);
  if (p) return p.vision ? "yes" : "no";
  if (TEXT_MODEL_VISION_ALIASES[id]) return "yes";
  return "unknown";
}
function textModelPresetIds() {
  return TEXT_MODEL_CATALOG.map(function (p) { return p.id; });
}
/* 模型 → 推荐 Base URL（厂商官方兼容端点；"__custom__"/未知返回 ""） */
function textModelBaseUrl(model) {
  const p = textModelPreset(model);
  return p ? p.baseUrl : "";
}
/* 模型 → 所属区域（未知 → ""） */
function textModelRegion(model) {
  const p = textModelPreset(model);
  return p ? p.region : "";
}

/* ---- 「上一次跑通」的图片分析模型（拆图看图成功后记录） ---- */
function lastOkVisionModel() {
  try { return localStorage.getItem("psspark.visionOk") || ""; } catch (e) { return ""; }
}
function markVisionOk(model) {
  const m = String(model || "").trim();
  if (!m) return;
  try { localStorage.setItem("psspark.visionOk", m); } catch (e) { /* ignore */ }
  diag("vision: 记录跑通模型 " + m);
}

/*
 * 解析「图片分析模型」（拆图看图等视觉调用专用）：
 *   ① 设置里明确指定了具体模型 → 用它；
 *   ② "跟随语言模型" 且语言模型支持看图 → 用语言模型（两者联动）；
 *   ③ 语言模型不支持看图（纯文本）→ 用「上一次跑通的模型」；
 *   ④ 仍无 → 默认 deepseek-flash。
 */
function resolveVisionModel() {
  const svc = getTextService();
  const vm = svc.visionModel || TEXT_FOLLOW_VISION;
  if (vm && vm !== TEXT_FOLLOW_VISION) {
    const v = textModelVision(vm);
    if (v === "yes" || v === "unknown") return vm;
  }
  if (textModelVision(svc.model) === "yes") return svc.model;
  const last = lastOkVisionModel();
  if (last) return last;
  return TEXT_DEFAULT_VISION_MODEL;
}

/* ---------------- 密钥（secureStorage 优先，localStorage 兜底） ---------------- */

let lastSavedKey = "";

function maskKey(k) {
  if (!k) return "";
  return k.length > 8 ? k.slice(0, 3) + "****" + k.slice(-4) : "****";
}

/* secureStorage 在部分 UXP 版本会把字符串存成字节数组，读回来需要还原为字符串 */
function coerceKey(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    let bytes = null;
    if (v instanceof Uint8Array) bytes = v;
    else if (v instanceof ArrayBuffer) bytes = new Uint8Array(v);
    else if (Array.isArray(v)) bytes = Uint8Array.from(v);
    else if (typeof v.byteLength === "number") bytes = new Uint8Array(v.buffer || v);
    else if (typeof v.length === "number" && typeof v[0] === "number") {
      bytes = new Uint8Array(v.length);
      for (let i = 0; i < v.length; i++) bytes[i] = v[i];
    }
    if (bytes) {
      let s = "";
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
  } catch (e) { diag("coerceKey warn: " + e.message); }
  return String(v);
}

async function saveSecret(secureName, fallbackName, key) {
  try {
    await secure.setItem(secureName, key);
    return true;
  } catch (e) {
    diag("secureStorage 保存失败(" + secureName + "): " + (e && e.message));
  }
  try {
    localStorage.setItem(fallbackName, key);
    log("⚠ 系统安全存储不可用，密钥已存到本地存储（明文，仅本机）");
    return true;
  } catch (e2) {
    diag("localStorage 保存失败: " + (e2 && e2.message));
    return false;
  }
}
async function loadSecret(secureName, fallbackName) {
  try {
    const s = coerceKey(await secure.getItem(secureName));
    if (s) return s;
  } catch (e) {
    diag("secureStorage 读取失败(" + secureName + "): " + (e && e.message));
  }
  try {
    return coerceKey(localStorage.getItem(fallbackName) || "");
  } catch (e) {
    return "";
  }
}

/* 图像服务 */
async function getImageKey() { return loadSecret("pssparkApiKey", "pssparkApiKeyFallback"); }
async function saveImageKey(k) { return saveSecret("pssparkApiKey", "pssparkApiKeyFallback", k); }
/* 文本服务（DeepSeek 等） */
async function getTextKey() { return loadSecret("pssparkTextApiKey", "pssparkTextApiKeyFallback"); }
async function saveTextKey(k) { return saveSecret("pssparkTextApiKey", "pssparkTextApiKeyFallback", k); }

/* ---------------- api.js 兼容包装（图像服务） ---------------- */

async function getApiKey() {
  const key = await getImageKey();
  if (!key) throw new Error("请先在设置 ▸ 服务接入中填写图像服务 API Key");
  return key;
}
function getBaseUrl() {
  return getImageService().baseUrl;
}

/* 设置界面用：输入框优先（存在则顺手保存），否则读本机存储 */
async function resolveKey(autoSave) {
  const el = $("apiKey");
  const input = el ? el.value.trim() : "";
  if (input) {
    if (autoSave && input !== lastSavedKey) {
      const ok = await saveImageKey(input);
      lastSavedKey = input;
      if (ok) log("密钥已自动保存到本机（" + maskKey(input) + "），下次无需重新输入", "ok");
    }
    return input;
  }
  const saved = await getImageKey();
  if (saved) {
    lastSavedKey = saved;
    if (el) el.value = saved;
    return saved;
  }
  return "";
}

/* ---------------- 模型分配 / 默认参数 / 诊断开关 ---------------- */

function getModelMap() {
  const m = lsGetJSON("psspark.modelMap", {});
  return { gen: m.gen || "", edit: m.edit || "", text: m.text || "" };
}
function saveModelMap(m) {
  return lsSetJSON("psspark.modelMap", { gen: m.gen || "", edit: m.edit || "", text: m.text || "" });
}

const DEFAULT_PARAMS = { size: "auto", quality: "auto", transparent: true, clip: true, variants: 1, concurrency: 3, smartObject: true };
function getDefaults() {
  const d = lsGetJSON("psspark.defaults", {});
  let v = parseInt(d.variants, 10);
  if (isNaN(v) || v < 1) v = DEFAULT_PARAMS.variants;
  v = Math.max(1, Math.min(4, v));
  let c = parseInt(d.concurrency, 10);
  if (isNaN(c) || c < 1) c = DEFAULT_PARAMS.concurrency;
  c = Math.max(1, Math.min(6, c));
  return {
    size: d.size || DEFAULT_PARAMS.size,
    quality: d.quality || DEFAULT_PARAMS.quality,
    transparent: d.transparent !== false,
    clip: d.clip !== false,
    variants: v,      /* 生成域默认候选张数（可在每个功能面板临时调大） */
    concurrency: c,   /* 并发请求数（拆图逐层 / 多候选），范围 1–6 */
    smartObject: d.smartObject !== false  /* 结果以智能对象插入（可无损缩放，默认开） */
  };
}
function saveDefaults(d) {
  return lsSetJSON("psspark.defaults", { size: d.size, quality: d.quality, transparent: !!d.transparent, clip: !!d.clip, variants: d.variants, concurrency: d.concurrency, smartObject: !!d.smartObject });
}

/* 并发请求数（统一入口：拆图逐层 / 生成多候选） */
function getConcurrency() {
  const v = getDefaults().concurrency;
  return Math.max(1, Math.min(6, v || 3));
}

function getDiagFlag() {
  try { return localStorage.getItem("psspark.diag") !== "0"; } catch (e) { return true; }
}
function setDiagFlag(v) {
  try { localStorage.setItem("psspark.diag", v ? "1" : "0"); } catch (e) { /* ignore */ }
}

/* ---------------- 本地 ComfyUI（多预设） ----------------
 * 一个预设 = 一台机器上的「一条工作流 + 它需要的参数」。
 * 为什么不是「一个 checkpoint 一个选项」：checkpoint 只是工作流的一部分，
 * steps/cfg/采样器/编码器/VAE 都得配套，所以按预设而不是按模型文件选。
 */

const DEFAULT_COMFY = { url: "http://127.0.0.1:8188", workflow: "", promptNode: "" };
const COMFY_STORE_KEY = "psspark.comfy";
const COMFY_CAPS = [
  ["t2i", "文生图"],
  ["i2i", "参考图"],
  ["inpaint", "局部重绘"],
  ["segment", "分割"]
];

function comfyNewId() {
  return "p" + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

function comfyEmptyPreset(name) {
  return {
    id: comfyNewId(),
    name: name || "本地模型",
    url: DEFAULT_COMFY.url,
    urls: [],                  /* 同一套工作流的其他机器地址（一行一个） */
    workflow: "",
    roles: { prompt: "", input: "", mask: "", size: "", output: "", negative: "" },
    overrides: { steps: null, cfg: null, denoise: null },
    caps: ["t2i"],
    alpha: "unknown",          /* native / none / unknown：是否支持透明通道 */
    templateKey: ""            /* 来自内置模板时记一下，避免重复添加 */
  };
}

/*
 * 内置模板：换电脑后不用再找 JSON 文件，点「添加内置模板」即可建好预设，
 * 只需改地址。模型文件不在这台机器上时，「检测全部」会列出缺哪个文件。
 */
const COMFY_TEMPLATES = [{
  key: "klein4b-t2i",
  name: "Klein 4B 文生图",
  caps: ["t2i"],
  alpha: "none",              /* GGUF 直出无 alpha */
  steps: 4,
  cfg: 1,
  denoise: null,
  roles: { prompt: "4" },
  workflow: JSON.stringify({
    "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "flux-2-klein-4b-Q8_0.gguf" }, _meta: { title: "UNET" } },
    "2": { class_type: "CLIPLoaderGGUF", inputs: { clip_name: "Qwen3-4B-UD-Q6_K_XL.gguf", type: "flux2" }, _meta: { title: "CLIP" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "flux2-vae.safetensors" }, _meta: { title: "VAE" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] }, _meta: { title: "PROMPT" } },
    "5": { class_type: "EmptySD3LatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 }, _meta: { title: "SIZE" } },
    "6": { class_type: "KSampler", inputs: { seed: 42, steps: 4, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1, model: ["1", 0], positive: ["4", 0], negative: ["4", 0], latent_image: ["5", 0] } },
    "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["3", 0] } },
    "8": { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: "psspark_local" }, _meta: { title: "OUTPUT" } }
  })
}, {
  key: "klein4b-i2i",
  name: "Klein 4B 参考图",
  caps: ["i2i"],
  alpha: "none",
  steps: 4,
  cfg: 1,
  denoise: 0.6,
  roles: { prompt: "4", input: "5", output: "9" },
  workflow: JSON.stringify({
    "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "flux-2-klein-4b-Q8_0.gguf" }, _meta: { title: "UNET" } },
    "2": { class_type: "CLIPLoaderGGUF", inputs: { clip_name: "Qwen3-4B-UD-Q6_K_XL.gguf", type: "flux2" }, _meta: { title: "CLIP" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "flux2-vae.safetensors" }, _meta: { title: "VAE" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] }, _meta: { title: "PROMPT" } },
    "5": { class_type: "LoadImage", inputs: { image: "" }, _meta: { title: "INPUT" } },
    "6": { class_type: "VAEEncode", inputs: { pixels: ["5", 0], vae: ["3", 0] } },
    "7": { class_type: "KSampler", inputs: { seed: 42, steps: 4, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 0.6, model: ["1", 0], positive: ["4", 0], negative: ["4", 0], latent_image: ["6", 0] } },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "psspark_i2i" }, _meta: { title: "OUTPUT" } }
  })
}, {
  key: "klein4b-inpaint",
  name: "Klein 4B 局部重绘",
  caps: ["inpaint"],
  alpha: "none",
  steps: 4,
  cfg: 1,
  denoise: 0.85,
  roles: { prompt: "4", input: "5", mask: "6", output: "10" },
  workflow: JSON.stringify({
    "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "flux-2-klein-4b-Q8_0.gguf" }, _meta: { title: "UNET" } },
    "2": { class_type: "CLIPLoaderGGUF", inputs: { clip_name: "Qwen3-4B-UD-Q6_K_XL.gguf", type: "flux2" }, _meta: { title: "CLIP" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: "flux2-vae.safetensors" }, _meta: { title: "VAE" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] }, _meta: { title: "PROMPT" } },
    "5": { class_type: "LoadImage", inputs: { image: "" }, _meta: { title: "INPUT" } },
    "6": { class_type: "LoadImageMask", inputs: { image: "", channel: "red" }, _meta: { title: "MASK" } },
    "7": { class_type: "VAEEncodeForInpaint", inputs: { pixels: ["5", 0], vae: ["3", 0], mask: ["6", 0], grow_mask_by: 6 } },
    "8": { class_type: "KSampler", inputs: { seed: 42, steps: 4, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 0.85, model: ["1", 0], positive: ["4", 0], negative: ["4", 0], latent_image: ["7", 0] } },
    "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
    "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "psspark_inpaint" }, _meta: { title: "OUTPUT" } }
  })
}, {
  /* 通用兜底：不含具体模型名（ckpt_name 留空）。「适配本机模型」或运行时
   * 会自动挑本机任意一个 checkpoint，所以换机器、换 checkpoint 不必重新导工作流。
   * 适合 SD1.5 / SDXL / Pony 这类「单文件 checkpoint 一把梭」的模型。 */
  key: "generic-ckpt-t2i",
  name: "通用 Checkpoint 文生图",
  caps: ["t2i"],
  alpha: "unknown",
  steps: null,
  cfg: null,
  denoise: null,
  roles: { prompt: "4", negative: "2", size: "5", output: "8" },
  workflow: JSON.stringify({
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "" }, _meta: { title: "MODEL" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 1] }, _meta: { title: "NEGATIVE" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 1] }, _meta: { title: "PROMPT" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024, batch_size: 1 }, _meta: { title: "SIZE" } },
    "6": { class_type: "KSampler", inputs: { seed: 42, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["1", 0], positive: ["4", 0], negative: ["2", 0], latent_image: ["5", 0] } },
    "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["1", 2] } },
    "8": { class_type: "SaveImage", inputs: { images: ["7", 0], filename_prefix: "psspark_t2i" }, _meta: { title: "OUTPUT" } }
  })
}];

/* 一条工作流可绑多台机器：url 为主地址，urls 为其余地址 */
function comfyPresetUrls(p) {
  const out = [];
  const push = function (u) {
    const s = String(u || "").trim().replace(/\/+$/, "");
    if (s && out.indexOf(s) < 0) out.push(s);
  };
  if (p) { push(p.url); (p.urls || []).forEach(push); }
  return out.length ? out : [DEFAULT_COMFY.url];
}

/* 工作流实际具备什么能力：只认节点，不认用户勾选。
 * 用来防止「文生图工作流勾了局部重绘」这种虚标——UI 会让它出现，运行时才报错。 */
function comfyWorkflowShape(p) {
  let wf = null;
  try { wf = JSON.parse(String((p && p.workflow) || "{}")); } catch (e) { return null; }
  const ids = Object.keys(wf || {});
  if (!ids.length) return null;
  const types = ids.map(function (id) { return String((wf[id] || {}).class_type || ""); });
  const has = function (re) { return types.some(function (t) { return re.test(t); }); };
  const role = function (r) { return !!(p.roles && p.roles[r]); };
  return {
    input: role("input") || has(/^LoadImage$/i),
    mask: role("mask") || has(/LoadImageMask/i),
    segment: has(/SAM2|SAMLoader|Segment|BiRefNet|GroundingDINO|MaskGenerator/i)
  };
}

function comfySanitizeCaps(p) {
  const declared = (p.caps || []).slice();
  const shape = comfyWorkflowShape(p);
  if (!shape) return declared;
  const kept = declared.filter(function (c) {
    /* 有 MASK 节点的 workflow 只能做局部重绘：它的 LoadImageMask 必填，
       拿它跑纯参考图会缺输入（ComfyUI 报 node 6 缺 image）。 */
    if (c === "inpaint") return shape.input && shape.mask;
    if (c === "i2i") return shape.input && !shape.mask;
    if (c === "t2i") return !shape.input && !shape.mask;
    if (c === "segment") return shape.segment;
    return true;
  });
  if (kept.length) return kept;
  /* 声明与实际不符时按工作流形态回退，避免「文生图」虚标继续留在 i2i/inpaint 工作流上 */
  return shape.mask ? ["inpaint"] : (shape.input ? ["i2i"] : ["t2i"]);
}

function comfyNormPreset(p) {
  const base = comfyEmptyPreset(p && p.name);
  const src = p || {};
  const out = {
    id: String(src.id || base.id),
    name: String(src.name || base.name),
    url: String(src.url || DEFAULT_COMFY.url),
    urls: Array.isArray(src.urls) ? src.urls.map(function (u) { return String(u || "").trim(); }).filter(Boolean) : [],
    workflow: String(src.workflow || ""),
    roles: {},
    overrides: {},
    caps: [],
    alpha: ["native", "none", "unknown"].indexOf(src.alpha) >= 0 ? src.alpha : "unknown",
    templateKey: String(src.templateKey || "")
  };
  Object.keys(base.roles).forEach(function (k) {
    out.roles[k] = String((src.roles && src.roles[k]) || "");
  });
  /* 兼容 v1 的单个 promptNode */
  if (!out.roles.prompt && src.promptNode) out.roles.prompt = String(src.promptNode);
  ["steps", "cfg", "denoise"].forEach(function (k) {
    const v = src.overrides ? src.overrides[k] : null;
    out.overrides[k] = (v == null || v === "" || isNaN(Number(v))) ? null : Number(v);
  });
  out.caps = Array.isArray(src.caps) ? src.caps.filter(function (c) {
    return COMFY_CAPS.some(function (x) { return x[0] === c; });
  }) : ["t2i"];
  if (!out.caps.length) out.caps = ["t2i"];
  /* 能力以工作流节点为准：虚标的 i2i/inpaint/segment 在这里被剔除，
     否则下拉里会选到一个根本跑不了的预设 */
  out.caps = comfySanitizeCaps(out);
  return out;
}

/* ===== 同一模型的多条工作流（文生图 / 参考图 / 局部重绘）合并成一个模型项 =====
 * 底层模型用工作流里的 unet/ckpt 文件名识别；识别不到时退回名称去掉能力后缀。
 * 模型下拉只显示一条；运行时按当前功能挑对应工作流，用户不用在同一模型里做选择。 */
function comfyBaseName(name) {
  return String(name || "")
    .replace(/[（(][^）)]*[）)]\s*$/, "")
    .replace(/\s*(文生图|参考图|局部重绘|图生图|重绘|分割|txt2img|img2img|t2i|i2i|inpaint)\s*$/i, "")
    .trim();
}

function comfyWorkflowModelSig(p) {
  let wf = null;
  try { wf = JSON.parse(String((p && p.workflow) || "{}")); } catch (e) { return ""; }
  const names = [];
  Object.keys(wf || {}).forEach(function (id) {
    const inp = (wf[id] && wf[id].inputs) || {};
    ["unet_name", "ckpt_name", "lora_name"].forEach(function (k) {
      if (typeof inp[k] === "string" && inp[k]) names.push(inp[k]);
    });
  });
  /* 归一后再排序：Windows 上来回混用 \ 与 / 会把同一个模型拆成两个下拉项 */
  return names.length ? names.map(comfyNormModelPath).sort().join("|") : "";
}

/* ===== 本机模型适配 =====
 * 内置模板写死了作者机器上的模型文件名。换一台机器（尤其 Windows）常见的差异有三种：
 *   1) 文件放在子目录里，且分隔符可能是反斜杠：Klein\flux-2-klein-4b-Q8_0.gguf
 *   2) 量化档不同：Q4_K_M / Q6_K / Q8_0
 *   3) 大小写不同（NTFS 不区分大小写，字符串比较区分）
 * 下面这套只做「能确定是同一个模型」的改写：宁可改不动报清楚，也不要把别的模型硬套上去。
 */
function comfyNormModelPath(s) {
  return String(s || "").replace(/\\/g, "/").replace(/^\.?\//, "").trim();
}

function comfyModelBase(s) {
  const p = comfyNormModelPath(s);
  return p.split("/").pop() || "";
}

/* 去掉扩展名与量化/精度后缀，得到「同一个底模」的比较键 */
function comfyModelStem(s) {
  let n = comfyModelBase(s).toLowerCase();
  n = n.replace(/\.(safetensors|sft|ckpt|pt|pth|bin|gguf)$/i, "");
  n = n.replace(/[-_.](q\d+([_-][a-z0-9]+)*|fp\d+|bf\d+|f\d+|int\d+)$/i, "");
  return n;
}

function comfyModelQuant(s) {
  const m = comfyModelBase(s).toLowerCase()
    .match(/[-_.](q\d+([_-][a-z0-9]+)*|fp\d+|bf\d+|f\d+|int\d+)(?=\.|$)/i);
  return m ? m[1].toLowerCase() : "";
}

/* 在「本机已装」列表里找 wanted 对应的那个文件；找不到返回 "" */
function comfyModelMatch(wanted, installed) {
  const list = (Array.isArray(installed) ? installed : []).filter(Boolean);
  const w = String(wanted || "");
  if (!w || !list.length) return "";
  if (list.indexOf(w) >= 0) return w;                       /* 原样命中 */
  const wn = comfyNormModelPath(w).toLowerCase();
  let hit = list.filter(function (x) { return comfyNormModelPath(x).toLowerCase() === wn; })[0];
  if (hit) return hit;                                       /* 只是分隔符/大小写不同 */
  const wb = comfyModelBase(w).toLowerCase();
  hit = list.filter(function (x) { return comfyModelBase(x).toLowerCase() === wb; })[0];
  if (hit) return hit;                                       /* 同名文件，换了目录 */
  const ws = comfyModelStem(w), wq = comfyModelQuant(w);
  const same = list.filter(function (x) { return comfyModelStem(x) === ws; });
  if (same.length) {
    const q = same.filter(function (x) { return comfyModelQuant(x) === wq; })[0];
    if (q) return q;                                         /* 同量化，换了目录 */
    return same.slice().sort(function (a, b) { return a.length - b.length; })[0];
  }
  const loose = list.filter(function (x) {
    const s = comfyModelStem(x);
    return !!(s && ws && (s.indexOf(ws) === 0 || ws.indexOf(s) === 0));
  });
  return loose.length === 1 ? loose[0] : "";                 /* 唯一的前缀命中 */
}

/* GGUF 加载器 ↔ 标准加载器：本机没装 ComfyUI-GGUF，或模型是 safetensors 时用得上 */
const COMFY_LOADER_SWAP = {
  UnetLoaderGGUF: { to: "UNETLoader", field: "unet_name" },
  CLIPLoaderGGUF: { to: "CLIPLoader", field: "clip_name" }
};

/* 按本机实际情况改写工作流：先补缺失的加载器节点，再对齐模型文件名。
 * probe = {
 *   has(cls) -> bool                 server 上有没有这个节点类型
 *   required(cls) -> object|null     object_info 的 required 段（用来补缺省参数）
 *   list(cls, field) -> string[]     该节点可选的模型文件名
 * }
 * 返回 { workflow, changes:[{node,kind,from,to}], missingClasses:[cls] } */
function comfyAdaptWorkflow(workflow, probe) {
  let wf = null;
  try { wf = JSON.parse(String(workflow || "{}")); } catch (e) {
    return { workflow: workflow, changes: [], missingClasses: [], missingFiles: [] };
  }
  const changes = [];
  const missing = [];
  const missingFiles = [];
  const fieldOf = {
    UnetLoaderGGUF: "unet_name", UnetLoader: "unet_name", UNETLoader: "unet_name",
    CheckpointLoaderSimple: "ckpt_name",
    CLIPLoaderGGUF: "clip_name", CLIPLoader: "clip_name",
    VAELoader: "vae_name",
    LoraLoader: "lora_name", LoraLoaderModelOnly: "lora_name"
  };

  const ids = Object.keys(wf || {});
  for (let i = 0; i < ids.length; i++) {
    const n = wf[ids[i]] || {};
    const cls = String(n.class_type || "");
    if (!cls || !n.inputs) continue;

    /* 1) 节点类型本机没有 → 看能不能换成标准加载器 */
    if (!probe.has(cls)) {
      const sw = COMFY_LOADER_SWAP[cls];
      if (sw && probe.has(sw.to)) {
        const cur = n.inputs[sw.field];
        const list = probe.list(sw.to, sw.field) || [];
        const hit = cur ? comfyModelMatch(cur, list) : "";
        if (!list.length || hit) {
          n.class_type = sw.to;
          if (hit) n.inputs[sw.field] = hit;
          /* 补上目标节点的必填项（如 weight_dtype / type），否则 ComfyUI 会报缺参数 */
          const req = probe.required(sw.to) || {};
          Object.keys(req).forEach(function (k) {
            if (n.inputs[k] != null) return;
            const spec = req[k];
            if (Array.isArray(spec) && Array.isArray(spec[0]) && spec[0].length) n.inputs[k] = spec[0][0];
            else if (spec && spec[1] && spec[1].default != null) n.inputs[k] = spec[1].default;
          });
          changes.push({ node: ids[i], kind: "class", from: cls, to: sw.to });
          continue;
        }
      }
      if (missing.indexOf(cls) < 0) missing.push(cls);
      continue;
    }

    /* 2) 文件名对齐本机 */
    const f = fieldOf[cls];
    if (!f) continue;
    const cur = n.inputs[f];
    if (typeof cur !== "string") continue;
    const list = probe.list(cls, f) || [];
    if (!list.length) continue;
    /* 模板里留空的模型名（通用 Checkpoint）：直接挑本机第一个，用户不用手填 */
    if (!cur) {
      n.inputs[f] = list[0];
      changes.push({ node: ids[i], kind: "auto", from: "", to: list[0] });
      continue;
    }
    const hit = comfyModelMatch(cur, list);
    if (hit && hit !== cur) {
      n.inputs[f] = hit;
      changes.push({ node: ids[i], kind: "file", from: cur, to: hit });
    } else if (!hit) {
      /* 本机确实没有这个文件：必须报出来，否则用户以为「无需改动」、跑起来才炸 */
      missingFiles.push({ node: ids[i], field: f, name: cur, cls: cls });
    }
  }
  return {
    workflow: changes.length ? JSON.stringify(wf) : workflow,
    changes: changes,
    missingClasses: missing,
    missingFiles: missingFiles
  };
}


function comfyModelKey(p) {
  return comfyWorkflowModelSig(p) || comfyBaseName(p && p.name) || String((p && p.id) || "");
}

function comfyModelGroups() {
  const map = {}, order = [];
  getComfyPresets().forEach(function (p) {
    const k = comfyModelKey(p);
    if (!map[k]) {
      map[k] = { key: k, name: comfyBaseName(p.name) || p.name, presets: [] };
      order.push(k);
    }
    map[k].presets.push(p);
  });
  return order.map(function (k) { return map[k]; });
}

function comfyGroupOfPreset(p) {
  if (!p) return null;
  const k = comfyModelKey(p);
  const groups = comfyModelGroups();
  for (let i = 0; i < groups.length; i++) if (groups[i].key === k) return groups[i];
  return null;
}

/* 显示用：把任意预设 id 归一到该模型组的第一个预设（下拉只认一个值） */
function comfyModelDisplayId(m) {
  if (!isComfyModel(m)) return m;
  const p = getComfyPreset(comfyPresetIdOf(m));
  if (!p) return m;
  const g = comfyGroupOfPreset(p);
  return comfyModelId((g && g.presets[0] && g.presets[0].id) || p.id);
}

/* 运行时按能力挑工作流；同组没有对应能力时返回 null，调用方给明确报错 */
function comfyPresetForNeed(m, need) {
  const p = getComfyPreset(comfyPresetIdOf(m));
  if (!p) return null;
  const caps = comfySanitizeCaps(p);
  if (!need || caps.indexOf(need) >= 0) return p;
  const g = comfyGroupOfPreset(p);
  if (!g) return null;
  for (let i = 0; i < g.presets.length; i++) {
    const x = g.presets[i];
    if (!String(x.workflow || "").trim()) continue;
    if (comfySanitizeCaps(x).indexOf(need) >= 0) return x;
  }
  return null;
}

function comfyResolvePresetId(m, need) {
  const p = comfyPresetForNeed(m, need);
  return p ? p.id : comfyPresetIdOf(m);
}

/* 清理历史遗留的重复预设：同 templateKey 或（同名 + 同工作流）合并；补回 templateKey */
function comfyDedupeStore(store) {
  if (!store || !Array.isArray(store.presets)) return { changed: false, idMap: {} };
  let changed = false;
  const tplByName = {};
  COMFY_TEMPLATES.forEach(function (t) { tplByName[String(t.name).trim()] = t.key; });

  store.presets.forEach(function (p) {
    if (!p.templateKey && tplByName[String(p.name || "").trim()]) {
      p.templateKey = tplByName[String(p.name || "").trim()];
      changed = true;
    }
  });

  const keep = [], idMap = {};
  store.presets.forEach(function (p) {
    const wf = String(p.workflow || "").trim();
    let hit = null;
    for (let i = 0; i < keep.length; i++) {
      const q = keep[i];
      const qWf = String(q.workflow || "").trim();
      /* 同模板且工作流一致（或一方为空）才算重复；用户改过的工作流不丢 */
      const sameKey = !!(p.templateKey && q.templateKey && p.templateKey === q.templateKey &&
        (!wf || !qWf || wf === qWf));
      const sameDup = !!(wf && String(p.name || "").trim() === String(q.name || "").trim() && qWf === wf);
      if (sameKey || sameDup) { hit = q; break; }
    }
    if (!hit) { keep.push(p); return; }

    hit.caps = Array.from(new Set((hit.caps || []).concat(p.caps || [])));
    hit.urls = Array.from(new Set((hit.urls || []).concat(p.urls || [])));
    if (p.url && p.url !== hit.url && (hit.urls || []).indexOf(p.url) < 0) hit.urls.push(p.url);
    if (!hit.workflow) hit.workflow = p.workflow;
    ["prompt", "input", "mask", "size", "output", "negative"].forEach(function (r) {
      if (!hit.roles[r] && p.roles && p.roles[r]) hit.roles[r] = p.roles[r];
    });
    ["steps", "cfg", "denoise"].forEach(function (k) {
      if ((hit.overrides[k] == null || hit.overrides[k] === "") &&
          p.overrides && p.overrides[k] != null && p.overrides[k] !== "") hit.overrides[k] = p.overrides[k];
    });
    if (hit.alpha === "unknown" && p.alpha && p.alpha !== "unknown") hit.alpha = p.alpha;
    if (!hit.templateKey && p.templateKey) hit.templateKey = p.templateKey;
    idMap[p.id] = hit.id;
    changed = true;
  });

  if (!changed) return { changed: false, idMap: {} };
  store.presets = keep.map(function (p) {
    p.caps = comfySanitizeCaps(p);
    return p;
  });
  if (idMap[store.activeId]) store.activeId = idMap[store.activeId];
  if (!getComfyPresetIn(store, store.activeId)) store.activeId = store.presets[0].id;
  ["gen", "edit", "decomp"].forEach(function (u) {
    const id = store.defaultByUse[u];
    if (idMap[id]) store.defaultByUse[u] = idMap[id];
    if (store.defaultByUse[u] && !getComfyPresetIn(store, store.defaultByUse[u])) store.defaultByUse[u] = "";
  });
  return { changed: true, idMap: idMap };
}

function getComfyPresetIn(store, id) {
  const list = (store && store.presets) || [];
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

/* 去重后把面板里已选的「comfy:<旧 id>」改到保留项，避免下拉显示失效 id */
function comfyRemapModelOverrides(idMap) {
  if (!idMap || !Object.keys(idMap).length) return;
  ["gen", "edit", "decomp"].forEach(function (u) {
    const k = "psspark.model." + u;
    try {
      const v = localStorage.getItem(k);
      if (v && v.indexOf("comfy:") === 0 && idMap[v.slice(6)]) {
        localStorage.setItem(k, "comfy:" + idMap[v.slice(6)]);
      }
    } catch (e) { /* ignore */ }
  });
  try {
    const old = localStorage.getItem("psspark.gen.model");
    if (old && old.indexOf("comfy:") === 0 && idMap[old.slice(6)]) {
      localStorage.setItem("psspark.gen.model", "comfy:" + idMap[old.slice(6)]);
    }
  } catch (e) { /* ignore */ }
}

/* 读整份存储；首次读到 v1 结构时自动迁移成单预设 */
function getComfyStore() {
  const raw = lsGetJSON(COMFY_STORE_KEY, null);
  if (raw && Array.isArray(raw.presets) && raw.presets.length) {
    const store = {
      version: 2,
      activeId: String(raw.activeId || raw.presets[0].id),
      presets: raw.presets.map(comfyNormPreset),
      defaultByUse: {
        gen: String((raw.defaultByUse && raw.defaultByUse.gen) || ""),
        edit: String((raw.defaultByUse && raw.defaultByUse.edit) || ""),
        decomp: String((raw.defaultByUse && raw.defaultByUse.decomp) || "")
      }
    };
    /* 历史版本重复点「添加内置模板」会留下同名副本，读到时就地合并一次 */
    const mig = comfyDedupeStore(store);
    if (mig.changed) {
      comfyRemapModelOverrides(mig.idMap);
      try { lsSetJSON(COMFY_STORE_KEY, store); } catch (e) { /* ignore */ }
    }
    return store;
  }
  const legacy = raw || {};
  const p = comfyEmptyPreset("本地模型 1");
  p.url = String(legacy.url || DEFAULT_COMFY.url);
  p.workflow = String(legacy.workflow || "");
  p.roles.prompt = String(legacy.promptNode || "");
  const store = {
    version: 2,
    activeId: p.id,
    presets: [p],
    defaultByUse: { gen: p.workflow ? p.id : "", edit: "", decomp: "" }
  };
  try { localStorage.setItem(COMFY_STORE_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }
  return store;
}

function saveComfyStore(s) {
  const store = {
    version: 2,
    activeId: s.activeId,
    presets: (s.presets || []).map(comfyNormPreset),
    defaultByUse: s.defaultByUse || { gen: "", edit: "", decomp: "" }
  };
  return lsSetJSON(COMFY_STORE_KEY, store);
}

function getComfyPresets() { return getComfyStore().presets; }

/* 把内置模板补进来（已存在同名模板则跳过），返回新增数量 */
function comfyApplyTemplates(url) {
  const store = getComfyStore();
  /* 老版本没写 templateKey：同名 + 同工作流也视为已存在，避免重复添加 */
  const exists = function (t) {
    return store.presets.some(function (p) {
      if (p.templateKey && p.templateKey === t.key) return true;
      return String(p.name || "").trim() === String(t.name || "").trim() &&
        String(p.workflow || "").trim() === String(t.workflow || "").trim();
    });
  };
  let added = 0;
  COMFY_TEMPLATES.forEach(function (t) {
    if (exists(t)) return;
    const p = comfyEmptyPreset(t.name);
    p.url = url || DEFAULT_COMFY.url;
    p.workflow = t.workflow;
    p.caps = t.caps.slice();
    p.alpha = t.alpha;
    p.overrides = {
      steps: t.steps == null ? null : t.steps,
      cfg: t.cfg == null ? null : t.cfg,
      denoise: t.denoise == null ? null : t.denoise
    };
    p.templateKey = t.key;
    p.roles = Object.assign({}, p.roles, t.roles || { prompt: "4" });
    store.presets.push(p);
    added++;
  });
  if (added) {
    store.activeId = store.presets[store.presets.length - 1].id;
    saveComfyStore(store);
  }
  return added;
}

function getComfyPreset(id) {
  const list = getComfyPresets();
  if (!id) return list[0] || null;
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

function upsertComfyPreset(p) {
  const store = getComfyStore();
  const norm = comfyNormPreset(p);
  let hit = false;
  store.presets = store.presets.map(function (x) {
    if (x.id === norm.id) { hit = true; return norm; }
    return x;
  });
  if (!hit) store.presets.push(norm);
  saveComfyStore(store);
  return norm;
}

function removeComfyPreset(id) {
  const store = getComfyStore();
  if (store.presets.length <= 1) return false;
  store.presets = store.presets.filter(function (p) { return p.id !== id; });
  if (store.activeId === id) store.activeId = store.presets[0].id;
  ["gen", "edit", "decomp"].forEach(function (u) {
    if (store.defaultByUse[u] === id) store.defaultByUse[u] = "";
  });
  saveComfyStore(store);
  return true;
}

function getComfyDefault(use) {
  const store = getComfyStore();
  const id = store.defaultByUse[use];
  return id && getComfyPreset(id) ? id : "";
}

function setComfyDefault(use, id) {
  const store = getComfyStore();
  if (["gen", "edit", "decomp"].indexOf(use) < 0) return;
  store.defaultByUse[use] = id || "";
  saveComfyStore(store);
}

/* 模型 id：comfy:<presetId>。保留裸 "comfy" 兼容旧数据 */
function comfyModelId(id) { return id ? ("comfy:" + id) : ""; }

function isComfyModel(m) {
  return typeof m === "string" && (m === "comfy" || m.indexOf("comfy:") === 0);
}

function comfyPresetIdOf(m) {
  if (!isComfyModel(m)) return "";
  if (m.indexOf("comfy:") === 0) return m.slice(6);
  return getComfyDefault("gen") || (getComfyPresets()[0] || {}).id || "";
}

function comfyPresetName(id) {
  const p = getComfyPreset(id);
  return p ? p.name : "";
}

function comfyModelLabel(m) {
  if (m === "comfy") return "本地 ComfyUI";
  if (isComfyModel(m)) {
    const p = getComfyPreset(comfyPresetIdOf(m));
    if (!p) return "本地 · 未命名";
    const g = comfyGroupOfPreset(p);
    return "本地 · " + ((g && g.name) || p.name || "未命名");
  }
  return null;
}

/* 哪些模型真的支持透明通道（background: transparent）。
 * 只列确认过的：猜错会拿到"棋盘格伪透明"，比不透明更难处理。
 * 本地模型由预设里的 alpha 字段声明，不在这里猜。 */
const ALPHA_NATIVE_MODELS = ["gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2"];

function modelAlphaSupport(mdl) {
  if (isComfyModel(mdl)) {
    const p = getComfyPreset(comfyPresetIdOf(mdl));
    return (p && p.alpha) || "unknown";
  }
  const id = String(mdl || "").toLowerCase();
  for (let i = 0; i < ALPHA_NATIVE_MODELS.length; i++) {
    if (id === ALPHA_NATIVE_MODELS[i]) return "native";
  }
  return "unknown";
}

/* 兼容旧接口：读/写「当前编辑的预设」 */
function getComfyConfig() {
  const store = getComfyStore();
  const p = getComfyPreset(store.activeId) || store.presets[0];
  if (!p) return { url: DEFAULT_COMFY.url, workflow: "", promptNode: "" };
  return { url: p.url, workflow: p.workflow, promptNode: p.roles.prompt };
}

function saveComfyConfig(c) {
  const store = getComfyStore();
  const p = getComfyPreset(store.activeId) || store.presets[0] || comfyEmptyPreset("本地模型 1");
  p.url = String((c && c.url) || DEFAULT_COMFY.url);
  p.workflow = String((c && c.workflow) || "");
  if (c && c.promptNode != null) p.roles.prompt = String(c.promptNode || "");
  upsertComfyPreset(p);
  return true;
}

/* 各域的模型覆盖：空字符串 = 跟随设置里的「模型分配」
 * use: gen / edit / decomp（拆图复用编辑模型，但可单独覆盖） */
const MODEL_USES = ["gen", "edit", "decomp"];

function getModelOverride(use) {
  if (MODEL_USES.indexOf(use) < 0) return "";
  try {
    const v = localStorage.getItem("psspark.model." + use);
    if (v != null) return v;
    /* 兼容旧键：v1.6.0 之前只有生图覆盖 */
    if (use === "gen") return localStorage.getItem("psspark.gen.model") || "";
  } catch (e) { /* ignore */ }
  return "";
}

function setModelOverride(use, m) {
  if (MODEL_USES.indexOf(use) < 0) return;
  try {
    if (m) localStorage.setItem("psspark.model." + use, m);
    else localStorage.removeItem("psspark.model." + use);
    if (use === "gen") localStorage.removeItem("psspark.gen.model");
  } catch (e) { /* ignore */ }
}

/* 兼容旧调用 */
function getGenModelOverride() { return getModelOverride("gen"); }
function setGenModelOverride(m) { setModelOverride("gen", m); }

function defaultModelFor(use) {
  const m = getModelMap();
  const img = getImageService();
  if (use === "gen") return m.gen || img.model || DEFAULT_IMAGE_SERVICE.model;
  if (use === "edit" || use === "decomp") return m.edit || m.gen || img.model || DEFAULT_IMAGE_SERVICE.model;
  return m.text || getTextService().model || DEFAULT_TEXT_SERVICE.model;
}

function defaultGenModel() { return defaultModelFor("gen"); }

/* ---------------- 图像模型 / 尺寸 / 质量选项 ----------------
 * 尺寸与质量的可选值随所选模型变化（不同模型支持范围不同），
 * 由 sizeOptionsForModel / qualityOptionsForModel 统一提供，UI 与请求层共用。 */

/* 平台图像模型预设
 * 来源：服务商公开测试页的模型清单与尺寸映射表（含 nano-banana-2.1）。
 * group: gpt / nano（下拉分组标题）；sizeKind 决定尺寸表；imageSize 为该模型可选分辨率（[] = 无该控件）。
 * 视频模型（minimax-h3 等）不在本插件范围，不纳入。 */
const IMAGE_MODEL_PRESETS = [
  /* —— gpt-image 系列（像素值 / 比例，走 OpenAI 兼容端点） —— */
  { id: "gpt-image-2", label: "gpt-image-2（基础 · 比例/1K）", group: "gpt", sizeKind: "ratio1k", imageSize: [] },
  { id: "gpt-image-2-vip", label: "gpt-image-2-vip（1–4K · 支持透明）", group: "gpt", sizeKind: "pixel14k", imageSize: [] },
  { id: "gpt-image-2.5", label: "gpt-image-2.5（默认 · 比例/1K）", group: "gpt", sizeKind: "ratio1k", imageSize: [] },
  { id: "gpt-image-2.5-flare", label: "gpt-image-2.5-flare（1–4K · 支持透明）", group: "gpt", sizeKind: "pixel14k", imageSize: [] },
  { id: "gpt-image-2.5-sunburst", label: "gpt-image-2.5-sunburst（1–4K · 最高质量）", group: "gpt", sizeKind: "pixel14k", imageSize: [] },
  /* —— nano-banana 系列（比例出图，走统一端点 /v1/api/generate） —— */
  { id: "nano-banana-fast", label: "nano-banana-fast（快速 · 仅比例）", group: "nano", sizeKind: "ratio", imageSize: [] },
  { id: "nano-banana-pro", label: "nano-banana-pro（分辨率 1–4K 可选）", group: "nano", sizeKind: "ratio", imageSize: ["1K", "2K", "4K"] },
  { id: "nano-banana-pro-vt", label: "nano-banana-pro-vt（1–4K 可选）", group: "nano", sizeKind: "ratio", imageSize: ["1K", "2K", "4K"] },
  { id: "nano-banana-pro-cl", label: "nano-banana-pro-cl（1K）", group: "nano", sizeKind: "ratio", imageSize: ["1K"] },
  { id: "nano-banana-pro-vip", label: "nano-banana-pro-vip（1–2K 可选）", group: "nano", sizeKind: "ratio", imageSize: ["1K", "2K"] },
  { id: "nano-banana-pro-4k-vip", label: "nano-banana-pro-4k-vip（4K）", group: "nano", sizeKind: "ratio", imageSize: ["4K"] },
  { id: "nano-banana-2", label: "nano-banana-2（1–4K · 含极端比例）", group: "nano", sizeKind: "ratioExt", imageSize: ["1K", "2K", "4K"] },
  { id: "nano-banana-2.1", label: "nano-banana-2.1（1–4K · 含极端比例）", group: "nano", sizeKind: "ratioExt", imageSize: ["1K", "2K", "4K"] },
  { id: "nano-banana-2-cl", label: "nano-banana-2-cl（1K · 含极端比例）", group: "nano", sizeKind: "ratioExt", imageSize: ["1K"] },
  { id: "nano-banana-2-2k-cl", label: "nano-banana-2-2k-cl（2K · 含极端比例）", group: "nano", sizeKind: "ratioExt", imageSize: ["2K"] },
  { id: "nano-banana-2-4k-cl", label: "nano-banana-2-4k-cl（4K · 含极端比例）", group: "nano", sizeKind: "ratioExt", imageSize: ["4K"] }
];

/* 尺寸选项①：gpt-image-2 / gpt-image-2.5 —— 支持比例出图（按 1K 像素值发送） */
const SIZE_RATIO_1K = [
  ["auto", "auto（自动）"],
  ["1024x1024", "1:1 · 1024×1024"],
  ["1672x941", "16:9 · 1672×941"],
  ["941x1672", "9:16 · 941×1672"],
  ["1443x1090", "4:3 · 1443×1090"],
  ["1090x1443", "3:4 · 1090×1443"],
  ["1536x1024", "3:2 · 1536×1024"],
  ["1024x1536", "2:3 · 1024×1536"],
  ["1408x1120", "5:4 · 1408×1120"],
  ["1120x1408", "4:5 · 1120×1408"],
  ["1920x832", "21:9 · 1920×832"],
  ["832x1920", "9:21 · 832×1920"],
  ["1792x896", "2:1 · 1792×896"],
  ["896x1792", "1:2 · 896×1792"]
];

/* 尺寸选项②：gpt-image-2-vip / 2.5-flare / 2.5-sunburst —— 1–4K 像素值（不支持比例） */
const SIZE_PIXEL_1_4K = [
  ["auto", "auto（自动）"],
  [null, "1K"],
  ["1024x1024", "1:1 · 1024×1024"],
  ["1280x720", "16:9 · 1280×720"],
  ["720x1280", "9:16 · 720×1280"],
  ["1152x864", "4:3 · 1152×864"],
  ["864x1152", "3:4 · 864×1152"],
  ["1536x1024", "3:2 · 1536×1024"],
  ["1024x1536", "2:3 · 1024×1536"],
  ["1120x896", "5:4 · 1120×896"],
  ["896x1120", "4:5 · 896×1120"],
  ["1456x624", "21:9 · 1456×624"],
  ["624x1456", "9:21 · 624×1456"],
  ["1536x768", "2:1 · 1536×768"],
  ["768x1536", "1:2 · 768×1536"],
  [null, "2K"],
  ["2048x2048", "1:1 · 2048×2048"],
  ["2048x1152", "16:9 · 2048×1152"],
  ["1152x2048", "9:16 · 1152×2048"],
  ["2304x1728", "4:3 · 2304×1728"],
  ["1728x2304", "3:4 · 1728×2304"],
  ["2048x1360", "3:2 · 2048×1360"],
  ["1360x2048", "2:3 · 1360×2048"],
  ["2240x1792", "5:4 · 2240×1792"],
  ["1792x2240", "4:5 · 1792×2240"],
  ["2912x1248", "21:9 · 2912×1248"],
  ["1248x2912", "9:21 · 1248×2912"],
  ["688x2048", "1:3 · 688×2048"],
  ["2048x688", "3:1 · 2048×688"],
  ["3072x1536", "2:1 · 3072×1536"],
  ["1536x3072", "1:2 · 1536×3072"],
  [null, "4K"],
  ["2880x2880", "1:1 · 2880×2880"],
  ["3840x2160", "16:9 · 3840×2160"],
  ["2160x3840", "9:16 · 2160×3840"],
  ["3264x2448", "4:3 · 3264×2448"],
  ["2448x3264", "3:4 · 2448×3264"],
  ["3504x2336", "3:2 · 3504×2336"],
  ["2336x3504", "2:3 · 2336×3504"],
  ["3200x2560", "5:4 · 3200×2560"],
  ["2560x3200", "4:5 · 2560×3200"],
  ["3840x1648", "21:9 · 3840×1648"],
  ["1648x3840", "9:21 · 1648×3840"],
  ["1280x3840", "1:3 · 1280×3840"],
  ["3840x1280", "3:1 · 3840×1280"],
  ["3840x1920", "2:1 · 3840×1920"],
  ["1920x3840", "1:2 · 1920×3840"]
];

/* 尺寸选项③：nano-banana 系列 —— 直接发送比例字符串（分辨率由 imageSize 控制） */
const SIZE_RATIO_NANO = [
  ["auto", "auto（自动）"],
  ["1:1", "1:1（方形）"],
  ["16:9", "16:9（横屏）"],
  ["9:16", "9:16（竖屏）"],
  ["4:3", "4:3（横版）"],
  ["3:4", "3:4（竖版）"],
  ["3:2", "3:2（横幅）"],
  ["2:3", "2:3（竖幅）"],
  ["4:5", "4:5（竖幅·偏方）"],
  ["5:4", "5:4（横幅·偏方）"],
  ["21:9", "21:9（超宽）"]
];
/* nano-banana-2 系列额外支持的极端比例 */
const SIZE_RATIO_NANO_EXT = SIZE_RATIO_NANO.concat([
  ["1:4", "1:4（长条竖）"],
  ["4:1", "4:1（长条横）"],
  ["1:8", "1:8（极长竖）"],
  ["8:1", "8:1（极长横）"]
]);

/* 尺寸选项④：未知 / 自定义模型 —— 通用兜底（各档固定值） */
const SIZE_GENERIC = [
  ["auto", "auto（自动）"],
  ["1024x1024", "1024×1024"],
  ["1536x1024", "1536×1024"],
  ["1024x1536", "1024×1536"]
];

/* 质量选项（按模型支持范围；「请根据模型支持情况进行选择」） */
const QUALITY_BY_MODEL = {
  "gpt-image-2": { opts: ["auto"], dft: "auto" },
  "gpt-image-2.5": { opts: ["auto"], dft: "auto" },
  "gpt-image-2-vip": { opts: ["medium"], dft: "medium" },
  "gpt-image-2.5-flare": { opts: ["low", "medium", "high"], dft: "medium" },
  "gpt-image-2.5-sunburst": { opts: ["low", "medium", "high", "xhigh", "max"], dft: "high" }
};
const QUALITY_GENERIC = { opts: ["auto", "high", "medium", "low"], dft: "auto" };

function imgModelPreset(model) {
  for (let i = 0; i < IMAGE_MODEL_PRESETS.length; i++) {
    if (IMAGE_MODEL_PRESETS[i].id === model) return IMAGE_MODEL_PRESETS[i];
  }
  return null;
}

/* nano-banana 系列统一走 /v1/api/generate（OpenAI 兼容端点未文档化支持该族） */
function isNanoModel(model) {
  return /^nano-banana/.test(String(model || ""));
}

function sizeOptionsForModel(model) {
  const p = imgModelPreset(model);
  if (p && p.sizeKind === "ratio1k") return SIZE_RATIO_1K;
  if (p && p.sizeKind === "pixel14k") return SIZE_PIXEL_1_4K;
  if (p && p.sizeKind === "ratio") return SIZE_RATIO_NANO;
  if (p && p.sizeKind === "ratioExt") return SIZE_RATIO_NANO_EXT;
  if (isNanoModel(model)) return SIZE_RATIO_NANO_EXT; /* 自定义填写的 nano：按全集给 */
  return SIZE_GENERIC;
}

function sizeHasValue(options, v) {
  for (let i = 0; i < options.length; i++) if (options[i][0] === v) return true;
  return false;
}

/* 归一化：值不在模型可选范围内（如切换模型后遗留的旧值）→ 回退 auto */
function normalizeSizeForModel(model, size) {
  const opts = sizeOptionsForModel(model);
  const v = size || "auto";
  return sizeHasValue(opts, v) ? v : "auto";
}

/* 分辨率（imageSize）：仅部分 nano-banana 模型支持，各模型可选范围不同（来源：测试页 rd 表） */
function imageSizeOptionsForModel(model) {
  const p = imgModelPreset(model);
  if (p) return (p.imageSize || []).slice();
  if (isNanoModel(model)) return ["1K", "2K", "4K"];
  return [];
}

function normalizeImageSizeForModel(model, v) {
  const o = imageSizeOptionsForModel(model);
  if (!o.length) return null;
  return o.indexOf(v) >= 0 ? v : o[0];
}

/* 质量：nano-banana 系列无质量档位（平台未文档化）→ 返回空选项 / null */
function qualityOptionsForModel(model) {
  if (isNanoModel(model)) return [];
  const q = QUALITY_BY_MODEL[model] || QUALITY_GENERIC;
  return q.opts.map(function (v) { return [v, v]; });
}

function defaultQualityForModel(model) {
  if (isNanoModel(model)) return null;
  const q = QUALITY_BY_MODEL[model] || QUALITY_GENERIC;
  return q.dft;
}

/* 归一化：值不受模型支持 → 回退该模型默认质量（如 flare 不支持 auto → medium）；不支持质量的模型返回 null */
function normalizeQualityForModel(model, quality) {
  if (isNanoModel(model)) return null;
  const q = QUALITY_BY_MODEL[model] || QUALITY_GENERIC;
  const v = quality || q.dft;
  return q.opts.indexOf(v) >= 0 ? v : q.dft;
}

/* ---------------- 模型画布上限（最大边长 / 最大长宽比） ----------------
 * 由尺寸表推导，而不是另写一份硬编码：表里出现过的最大边就是该模型能出的最大像素，
 * 表里的最长条就是它能接受的最极端比例。
 *   gpt-image-2 / 2.5（比例 1K）        → 1920px / 21:9 ≈ 2.33
 *   gpt-image-2-vip / flare / sunburst → 3840px / 3:1
 *   nano-banana 系列（比例出图）        → 由 imageSize 决定（1K/2K/4K），比例 16:9
 *   nano-banana-2 / 2.1（ratioExt）    → 同上，比例可到 8:1
 * 用途：扩图等「结果必须整幅对齐」的功能，超出上限时提前警告（不阻断）。 */
function modelCanvasLimit(model) {
  const opts = sizeOptionsForModel(model) || [];
  let maxSide = 0, maxRatio = 1;
  (opts || []).forEach(function (o) {
    const v = o && o[0];
    if (!v || v === "auto") return;
    const m = /^(\d+)x(\d+)$/.exec(v);
    if (m) {
      const w = +m[1], h = +m[2];
      maxSide = Math.max(maxSide, w, h);
      maxRatio = Math.max(maxRatio, w / h, h / w);
      return;
    }
    const p = /^(\d+):(\d+)$/.exec(v);
    if (p) {
      const w = +p[1], h = +p[2];
      if (w > 0 && h > 0) maxRatio = Math.max(maxRatio, w / h, h / w);
    }
  });
  if (isNanoModel(model)) {
    /* 取该模型可选的最高分辨率档（1K/2K/4K），而不是默认档 */
    const iszOpts = imageSizeOptionsForModel(model) || [];
    const isz = iszOpts.length ? iszOpts[iszOpts.length - 1] : "1K";
    const base = (isz === "4K") ? 4096 : (isz === "2K" ? 2048 : 1024);
    maxSide = Math.max(maxSide, base);
  }
  if (!maxSide) maxSide = 2048;
  if (!(maxRatio > 0)) maxRatio = 2;
  return { maxSide: Math.round(maxSide), maxRatio: maxRatio };
}

/* 扩图四边扩展量（像素）：百分比按原图宽/高换算，像素模式直接取绝对值。
 * 老数据没有 mode 字段 → 按百分比处理。 */
function expandSidesOf(expand, W, H) {
  const e = expand || {};
  const mode = (e.mode === "pixels") ? "pixels" : "percent";
  const px = e.px || {};
  const num = function (v) { const n = Number(v); return isFinite(n) ? Math.max(0, Math.round(n)) : 0; };
  const pct = function (v, base) { return Math.max(0, Math.round(base * (Number(v) || 0) / 100)); };
  return {
    mode: mode,
    left: mode === "pixels" ? num(px.left) : pct(e.left, W),
    right: mode === "pixels" ? num(px.right) : pct(e.right, W),
    up: mode === "pixels" ? num(px.up) : pct(e.up, H),
    down: mode === "pixels" ? num(px.down) : pct(e.down, H)
  };
}

/* 扩图超限明细（给「二次确认」用）：结构化返回，UI 可以分条列出超了什么。
 * 返回 { ok, NW, NH, maxSide, maxRatio, reasons:[{kind,limit,actual,over}], text }
 * text 与旧版 expandLimitWarning 的输出保持一致（一行中文，用「；」分隔）。 */
function expandLimitInfo(model, W, H, l, r, u, d) {
  const NW = W + l + r, NH = H + u + d;
  const out = { ok: true, NW: NW, NH: NH, maxSide: 0, maxRatio: 0, reasons: [], text: "" };
  if (!(NW > 0 && NH > 0)) return out;
  const lim = modelCanvasLimit(model);
  out.maxSide = lim.maxSide;
  out.maxRatio = lim.maxRatio;

  const longest = Math.max(NW, NH);
  if (longest > lim.maxSide) {
    out.reasons.push({ kind: "pixels", limit: lim.maxSide, actual: longest, over: longest - lim.maxSide });
  }
  const ar = Math.max(NW / NH, NH / NW);
  if (ar > lim.maxRatio * 1.05) {
    out.reasons.push({ kind: "ratio", limit: lim.maxRatio, actual: ar });
  }
  out.ok = out.reasons.length === 0;
  out.text = out.reasons.map(function (r) {
    if (r.kind === "pixels") {
      return "扩展后 " + NW + "×" + NH + " 超过该模型上限 " + lim.maxSide + "px，" +
        "接口会先缩小再放大，细节可能变糊";
    }
    return "长宽比 " + ar.toFixed(1) + ":1 超出该模型支持（最大 " +
      Math.round(lim.maxRatio * 10) / 10 + ":1），可能无法精确对齐：" +
      "建议减小单侧扩展，或换 nano-banana-2 系列（最高 8:1）";
  }).join("；");
  return out;
}

/* 扩图超限提示：返回空串表示没问题；否则是给用户看的一句话（像素上限 + 比例上限） */
function expandLimitWarning(model, W, H, l, r, u, d) {
  return expandLimitInfo(model, W, H, l, r, u, d).text;
}

/* ---------------- 初始化（旧键迁移 + 自检） ---------------- */

async function servicesInit() {
  const img = lsGetJSON("psspark.imageService", null);
  if (!img) {
    let legacy = null;
    try { legacy = localStorage.getItem("pssparkBaseUrl"); } catch (e) { /* ignore */ }
    if (legacy) {
      saveImageService({ baseUrl: legacy, model: DEFAULT_IMAGE_SERVICE.model });
      diag("migrate: pssparkBaseUrl -> psspark.imageService (" + legacy + ")");
    }
  }
  const txt = lsGetJSON("psspark.textService", null);
  if (txt && txt.model && RETIRED_TEXT_MODELS.indexOf(txt.model) >= 0) {
    saveTextService({ baseUrl: txt.baseUrl, model: DEFAULT_TEXT_SERVICE.model, region: txt.region, visionModel: txt.visionModel });
    diag("migrate: text model " + txt.model + " -> " + DEFAULT_TEXT_SERVICE.model);
  }
  /* 旧默认地址补齐版本段（各平台「OpenAI 兼容」格式统一为 …/v1 起） */
  if (txt && txt.baseUrl === "https://api.deepseek.com") {
    saveTextService({ baseUrl: "https://api.deepseek.com/v1", model: txt.model || DEFAULT_TEXT_SERVICE.model, region: txt.region, visionModel: txt.visionModel });
    diag("migrate: text baseUrl 补齐 /v1 -> https://api.deepseek.com/v1");
  }
  diag("services ready: image=" + getImageService().baseUrl + " text=" + getTextService().baseUrl +
    " region=" + getTextService().region + " visionModel=" + getTextService().visionModel);
}

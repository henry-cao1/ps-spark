/*
 * api.js — 网络层（XHR，可取消、可超时）+ 请求封装
 * W0：自 main.js 原样搬迁（行为不变）
 * 依赖：diag.js（log/startProgress/diag/utf8Bytes/base64FromBuffer）、services.js（getApiKey/getBaseUrl）
 */

let currentXHR = null;
/* 在途请求集合（拆图并发时用得上：取消要把整批请求都 abort，只 abort 最后一个不够） */
const activeXHRs = new Set();

/* 运行级取消标志：ComfyUI 轮询的等待段没有在途请求，只 abort XHR 是取消不掉的 */
let RUN_ABORTED = false;
function resetRunAbort() { RUN_ABORTED = false; }
function abortRun() { RUN_ABORTED = true; abortAllRequests(); }
function throwIfAborted() {
  if (RUN_ABORTED) {
    const e = new Error("已取消");
    e.canceled = true;
    throw e;
  }
}

function abortAllRequests() {
  try {
    activeXHRs.forEach(function (x) { try { x.abort(); } catch (e) { /* ignore */ } });
    activeXHRs.clear();
  } catch (e) { /* ignore */ }
}

function xhrRequest({ method, url, headers = {}, body = null, responseType = "text", timeout = 300000 }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    currentXHR = xhr;
    activeXHRs.add(xhr);
    const drop = function () { activeXHRs.delete(xhr); if (currentXHR === xhr) currentXHR = null; };
    xhr.open(method, url, true);
    xhr.timeout = timeout;
    if (responseType) xhr.responseType = responseType;
    for (const k of Object.keys(headers)) xhr.setRequestHeader(k, headers[k]);
    xhr.onload = () => {
      drop();
      resolve({ status: xhr.status, response: xhr.response });
    };
    xhr.onerror = () => { drop(); reject(new Error("网络错误（检查节点/网络）")); };
    xhr.ontimeout = () => { drop(); reject(new Error(`请求超时（${timeout / 1000}s）`)); };
    xhr.onabort = () => { drop(); reject(new Error("已取消")); };
    try {
      const len = body ? (body.byteLength != null ? body.byteLength : (body.length || 0)) : 0;
      diag(`xhr ${method} ${url.slice(0, 90)} body=${len}B`);
    } catch (e) { /* ignore */ }
    xhr.send(body);
  });
}

/* 手动构造 multipart/form-data（UXP 部分版本无 FormData） */
function buildMultipart(fields) {
  const boundary = "----PSSparkBoundary" + Date.now();
  const parts = [];
  for (const name of Object.keys(fields)) {
    parts.push(utf8Bytes(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`));
    parts.push(utf8Bytes(String(fields[name])));
    parts.push(utf8Bytes("\r\n"));
  }
  parts.push(utf8Bytes(`--${boundary}--\r\n`));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { body.set(p, off); off += p.length; }
  return { body: body.buffer, contentType: `multipart/form-data; boundary=${boundary}` };
}

/* 调图像服务 API，返回 { url, usage } */
async function callApi(path, payload, isMultipart) {
  /* 本地预设不能当云端模型 id 发出去（否则服务端只回 model not register） */
  if (payload && isComfyModel(payload.model)) {
    throw new Error("本地 ComfyUI 未接入当前功能，请切回云端模型");
  }
  throwIfAborted();
  const key = await getApiKey();
  const url = getBaseUrl() + path;
  let body, headers = { "Authorization": "Bearer " + key };
  if (isMultipart) {
    const mp = buildMultipart(payload);
    body = mp.body;
    headers["Content-Type"] = mp.contentType;
  } else {
    body = JSON.stringify(payload);
    headers["Content-Type"] = "application/json";
  }
  log(`请求 ${path} ...`);
  startProgress("等待模型生成（通常 10~60 秒）");
  let waited = 0;
  const hb = setInterval(() => {
    waited += 10;
    log(`⏳ 模型仍在生成中（已等待 ${waited} 秒）…`);
  }, 10000);
  let res;
  try {
    res = await xhrRequest({ method: "POST", url, headers, body, timeout: 300000 });
  } finally {
    clearInterval(hb);
  }
  let json;
  try { json = JSON.parse(res.response); } catch (e) {
    throw new Error(`响应不是 JSON（HTTP ${res.status}）`);
  }
  if (res.status !== 200) {
    const msg = (json && (json.error && json.error.message || json.message)) || (typeof res.response === "string" ? res.response.slice(0, 300) : "") || "未知错误";
    const low = String(msg).toLowerCase();
    let hint = "";
    if (low.indexOf("apikey expired") >= 0 || (low.indexOf("api key") >= 0 && low.indexOf("expired") >= 0)) {
      hint = "（Key 已过期：请到平台续费或换新 Key，然后在设置 ▸ 图像服务 重新保存）";
    } else if (low.indexOf("quota") >= 0 || low.indexOf("balance") >= 0 || low.indexOf("余额") >= 0) {
      hint = "（额度/余额不足：请到平台充值）";
    }
    throw new Error(`API 错误 HTTP ${res.status}: ${msg}${hint}`);
  }
  const imgUrl = json && json.data && json.data[0] && json.data[0].url;
  if (!imgUrl) throw new Error("响应中未找到图片 URL");
  return { url: imgUrl, usage: json.usage || null };
}

/* ============ 统一生成端点（/v1/api/generate） ============
 * 适用：nano-banana 系列等模型（OpenAI 兼容端点未文档化支持该族）。
 * 契约来源：服务商公开测试页的前端实现（比接口文档更完整）：
 *   POST /v1/api/generate  body: {model, prompt, images[], aspectRatio, replyType:"async", imageSize?, quality?, background?}
 *     → {id, status:"running"}
 *   GET  /v1/api/result?id=<id>  → {status, progress(0-100), results:[{url}], error}
 * 用 async + 轮询（与官方页一致）：避免长连接超时，且能拿到 progress 进度。
 */
const UNIFIED_POLL_MS = 4000;
const UNIFIED_MAX_MS = 600000;   /* 10 分钟上限 */

function sleepMs(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

async function callUnifiedGenerate(payload) {
  const key = await getApiKey();
  const base = getBaseUrl().replace(/\/+$/, "");
  const body = JSON.stringify(Object.assign({ replyType: "async" }, payload));
  log("请求 /v1/api/generate ...");
  startProgress("等待模型生成（通常 30~90 秒）");

  const res = await xhrRequest({
    method: "POST",
    url: base + "/v1/api/generate",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: body,
    timeout: 120000
  });
  let json = null;
  try { json = JSON.parse(res.response); } catch (e) { json = null; }
  if (res.status !== 200 || !json) {
    const msg = (json && (json.error || json.msg)) ||
      (typeof res.response === "string" ? res.response.slice(0, 300) : "") || "未知错误";
    throw new Error(`生成请求失败 HTTP ${res.status}: ${msg}`);
  }
  if (json.status === "failed" || json.status === "violation") {
    throw new Error(json.error || json.msg || ("任务" + json.status));
  }
  /* 兼容同步返回（带 results 的形态） */
  const direct = json.results && json.results[0] && json.results[0].url;
  if (direct) {
    diag("unified: 同步返回结果");
    return { url: direct };
  }
  const id = json.id;
  if (!id) throw new Error(json.error || json.msg || "创建生成任务失败");
  diag("unified: task id=" + id + " status=" + json.status);

  const t0 = Date.now();
  let lastPct = -1;
  for (;;) {
    await sleepMs(UNIFIED_POLL_MS);
    if (Date.now() - t0 > UNIFIED_MAX_MS) throw new Error("生成超时（10 分钟未完成，可稍后在历史中查看）");
    const r = await xhrRequest({
      method: "GET",
      url: base + "/v1/api/result?id=" + encodeURIComponent(id),
      headers: { "Authorization": "Bearer " + key },
      timeout: 60000
    });
    let j = null;
    try { j = JSON.parse(r.response); } catch (e) { j = null; }
    if (!j || r.status !== 200) {
      diag("unified poll: 异常响应 HTTP " + r.status);
      continue;
    }
    if (j.status === "running") {
      const pct = (typeof j.progress === "number") ? j.progress : null;
      if (pct != null) {
        startProgress("模型生成中 " + pct + "%");
        if (pct >= lastPct + 20) { lastPct = pct; log("⏳ 生成进度 " + pct + "%"); }
      }
      continue;
    }
    if (j.status === "succeeded") {
      const url = (j.results && j.results[0] && j.results[0].url) || j.url || "";
      if (!url) throw new Error("任务成功但未返回图片 URL");
      diag("unified: succeeded，耗时 " + Math.round((Date.now() - t0) / 1000) + "s");
      return { url: url };
    }
    if (j.status === "failed" || j.status === "violation") {
      throw new Error(j.error || j.failure_reason || j.msg || ("任务" + j.status));
    }
    diag("unified poll: 未知状态 " + j.status);
  }
}

/* ---------------- 本地 ComfyUI（预设驱动） ----------------
 * 节点按「角色」定位：工作流里把节点标题（_meta.title）写成
 *   PROMPT / NEGATIVE / INPUT / MASK / SIZE / OUTPUT
 * 插件按角色注入，用户不用记节点 id；找不到再退回设置里填的 id。
 * 这样同一段代码可以跑文生图、图生图、局部重绘、分割四种工作流。 */

const COMFY_ROLE_TITLE = {
  prompt: /^(prompt|positive|正向|提示词)$/i,
  negative: /^(negative|负面|反向)$/i,
  input: /^(input|image|src|输入|原图)$/i,
  mask: /^(mask|蒙版|遮罩)$/i,
  size: /^(size|latent|尺寸)$/i,
  output: /^(output|save|输出)$/i
};

function comfyFindRole(wf, role, configuredId) {
  if (configuredId && wf[configuredId] && wf[configuredId].inputs) return configuredId;
  const ids = Object.keys(wf);
  const re = COMFY_ROLE_TITLE[role];
  for (let i = 0; i < ids.length; i++) {
    const n = wf[ids[i]] || {};
    const title = String((n._meta && n._meta.title) || "").trim();
    if (title && re && re.test(title) && n.inputs) return ids[i];
  }
  /* 兜底启发式 */
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i], n = wf[id] || {}, ins = n.inputs || {}, ct = String(n.class_type || "");
    if (role === "prompt") {
      if (!/CLIPTextEncode/i.test(ct) || typeof ins.text !== "string") continue;
      const t = String((n._meta && n._meta.title) || "").toLowerCase();
      if (/negative|负面|反向/.test(t)) continue;
      return id;
    }
    if (role === "input" && /^LoadImage$/i.test(ct) && typeof ins.image === "string") return id;
    if (role === "mask" && /LoadImageMask/i.test(ct) && typeof ins.image === "string") return id;
    if (role === "size" && /Latent/i.test(ct) && typeof ins.width === "number") return id;
    if (role === "output" && /SaveImage|PreviewImage/i.test(ct)) return id;
  }
  return "";
}

function comfyApplySize(wf, size) {
  const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(String(size || ""));
  if (!m) return;
  const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
  if (!w || !h) return;
  Object.keys(wf).forEach(function (id) {
    const n = wf[id] || {};
    const ins = n.inputs || {};
    if (typeof ins.width === "number" && typeof ins.height === "number" &&
        /Latent/i.test(String(n.class_type || ""))) {
      ins.width = w;
      ins.height = h;
    }
  });
}

/* 采样参数覆盖：不同模型步数/cfg 差异很大，不能全靠工作流里写死 */
function comfyApplyOverrides(wf, ov, denoise) {
  Object.keys(wf).forEach(function (id) {
    const n = wf[id] || {}, ins = n.inputs || {};
    if (!/KSampler/i.test(String(n.class_type || ""))) return;
    if (ov) {
      if (ov.steps != null && typeof ins.steps === "number") ins.steps = ov.steps;
      if (ov.cfg != null && typeof ins.cfg === "number") ins.cfg = ov.cfg;
    }
    if (denoise != null && typeof ins.denoise === "number") ins.denoise = denoise;
  });
}

/* data URI → 字节（UXP 有 atob；没有时走手写表兜底） */
function b64ToBytes(b64) {
  const s = String(b64 || "").replace(/[^A-Za-z0-9+/=]/g, "");
  if (typeof atob === "function") {
    const raw = atob(s);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  const T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let buf = 0, bits = 0, o = 0;
  for (let i = 0; i < clean.length; i++) {
    buf = (buf << 6) | T.indexOf(clean[i]);
    bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff; }
  }
  return out.subarray(0, o);
}

/* multipart：既要文本字段，也要二进制文件（ComfyUI /upload/image 需要真文件） */
function buildBinaryMultipart(fields, files) {
  const boundary = "----PSSparkBoundary" + Date.now();
  const chunks = [];
  const pushStr = function (s) { chunks.push(utf8Bytes(s)); };
  Object.keys(fields || {}).forEach(function (k) {
    pushStr("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + k + "\"\r\n\r\n" + String(fields[k]) + "\r\n");
  });
  (files || []).forEach(function (f) {
    pushStr("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + f.field + "\"; filename=\"" + f.filename + "\"\r\nContent-Type: " + (f.type || "application/octet-stream") + "\r\n\r\n");
    chunks.push(f.bytes);
    pushStr("\r\n");
  });
  pushStr("--" + boundary + "--\r\n");
  const total = chunks.reduce(function (n, c) { return n + c.length; }, 0);
  const body = new Uint8Array(total);
  let off = 0;
  chunks.forEach(function (c) { body.set(c, off); off += c.length; });
  return { body: body.buffer, contentType: "multipart/form-data; boundary=" + boundary };
}

async function comfyUploadImage(dataUri, base, filename) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(String(dataUri || ""));
  if (!m) throw new Error("图片不是 base64 data URI，无法上传到 ComfyUI");
  const mime = m[1];
  const ext = mime.indexOf("png") >= 0 ? "png" : (mime.indexOf("webp") >= 0 ? "webp" : "jpg");
  const mp = buildBinaryMultipart(
    { overwrite: "true", type: "input" },
    [{ field: "image", filename: filename + "." + ext, type: mime, bytes: b64ToBytes(m[2]) }]
  );
  diag("comfy upload: " + filename + "." + ext + " (" + Math.round(m[2].length / 1024) + "KB b64)");
  const res = await xhrRequest({
    method: "POST",
    url: base + "/upload/image",
    headers: { "Content-Type": mp.contentType },
    body: mp.body,
    timeout: 60000
  });
  if (res.status !== 200) throw new Error("上传图片到 ComfyUI 失败 HTTP " + res.status + "：" + String(res.response || "").slice(0, 160));
  let j = null;
  try { j = JSON.parse(res.response); } catch (e) { j = null; }
  if (!j || !j.name) throw new Error("ComfyUI 上传未返回文件名");
  return j.subfolder ? (j.subfolder + "/" + j.name) : j.name;
}

/* 把 /prompt 的拒收原因翻成人话：最常见的是这台机器缺模型文件 */
function comfyErrorText(j) {
  if (!j) return "";
  const parts = [];
  const err = j.error;
  if (err) parts.push(String(err.message || err));
  if (j.node_errors) {
    Object.keys(j.node_errors).forEach(function (id) {
      const ne = j.node_errors[id] || {};
      (ne.errors || []).forEach(function (e) {
        parts.push((ne.class_type || ("节点" + id)) + "：" + (e.message || e.details || ""));
      });
    });
  }
  return parts.join("；").slice(0, 400);
}

/* 探测一台机器的 ComfyUI 是否在线（多机场景：Mac / Win 各自一个预设） */
async function comfyProbe(url) {
  const base = String(url || "").replace(/\/+$/, "");
  if (!base) return { ok: false, error: "未填地址" };
  try {
    const r = await xhrRequest({ method: "GET", url: base + "/system_stats", timeout: 3000 });
    if (r.status !== 200) return { ok: false, error: "HTTP " + r.status };
    let j = null;
    try { j = JSON.parse(r.response); } catch (e) { j = null; }
    return { ok: true, version: (j && j.system && j.system.comfyui_version) || "?" };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "连接失败" };
  }
}

/* shouldAbort：可选回调。并发时全局取消标志可能被下一条任务清掉，
 * 被取消的那条靠这个回调仍能立刻停下轮询（落图另有闸门兜底）。 */
/* 多机地址：优先用第一台在线的。单地址不探测，保持原有零额外延迟。
 * 结果缓存 15 秒，避免每次生成都打一遍 /system_stats。 */
let COMFY_EP_CACHE = { key: "", base: "", at: 0 };
function comfyHostOf(u) {
  return String(u || "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}
async function comfyPickEndpoint(p) {
  const urls = comfyPresetUrls(p);
  if (urls.length <= 1) return urls[0];
  const key = urls.join("|");
  const now = Date.now();
  if (COMFY_EP_CACHE.key === key && (now - COMFY_EP_CACHE.at) < 15000 && COMFY_EP_CACHE.base) {
    return COMFY_EP_CACHE.base;
  }
  const errs = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const r = await xhrRequest({ method: "GET", url: urls[i] + "/system_stats", timeout: 1500 });
      if (r.status === 200) {
        COMFY_EP_CACHE = { key: key, base: urls[i], at: Date.now() };
        return urls[i];
      }
      errs.push(comfyHostOf(urls[i]) + " HTTP " + r.status);
    } catch (e) {
      errs.push(comfyHostOf(urls[i]) + " " + ((e && e.message) || e));
    }
  }
  throw new Error("本地 ComfyUI 都连不上：" + errs.join("；") + "（检查地址与 ComfyUI 是否在跑）");
}

/* ===== 运行时模型兜底 =====
 * 换机器后 preset 里记的模型文件名可能已经不存在（或通用模板里本来就是空的）。
 * 提交前按本机 object_info 校准一次：存在就原样用，不存在/为空才换成第一个可用的。
 * 目的：同一个预设换机器不用再点一次「适配本机模型」。 */
const COMFY_RUN_INFO = {};        /* base|Class -> { at, list } */
const COMFY_RUN_INFO_TTL = 300000;

async function comfyRunModelList(base, cls, field) {
  const b = String(base || "").replace(/\/+$/, "");
  const key = b + "|" + cls + "|" + field;
  const now = Date.now();
  const hit = COMFY_RUN_INFO[key];
  if (hit && (now - hit.at) < COMFY_RUN_INFO_TTL) return hit.list;
  let list = [];
  try {
    const r = await xhrRequest({
      method: "GET",
      url: b + "/object_info/" + encodeURIComponent(cls),
      timeout: 2500
    });
    if (r.status === 200) {
      const info = JSON.parse(r.response)[cls];
      const spec = info && info.input && info.input.required && info.input.required[field];
      if (spec && Array.isArray(spec[0])) list = spec[0];
    }
  } catch (e) { /* 查不到就不动工作流，交给 ComfyUI 自己报错 */ }
  COMFY_RUN_INFO[key] = { at: now, list: list };
  return list;
}

/* 返回改动条数；失败不抛，绝不影响正常提交 */
async function comfyRunFixModels(wf, base) {
  const fields = {
    UnetLoaderGGUF: "unet_name", UnetLoader: "unet_name", UNETLoader: "unet_name",
    CheckpointLoaderSimple: "ckpt_name",
    CLIPLoaderGGUF: "clip_name", CLIPLoader: "clip_name",
    VAELoader: "vae_name",
    LoraLoader: "lora_name", LoraLoaderModelOnly: "lora_name"
  };
  let changed = 0;
  const ids = Object.keys(wf || {});
  for (let i = 0; i < ids.length; i++) {
    const n = wf[ids[i]] || {};
    const f = fields[String(n.class_type || "")];
    if (!f || !n.inputs) continue;
    const cur = n.inputs[f];
    if (typeof cur !== "string") continue;
    const list = await comfyRunModelList(base, n.class_type, f);
    if (!list.length) continue;
    const hit = comfyModelMatch(cur, list);
    if (hit) {
      if (hit !== cur) { n.inputs[f] = hit; changed++; diag("comfy run: 模型名对齐 " + cur + " -> " + hit); }
      continue;
    }
    n.inputs[f] = list[0];
    changed++;
    diag("comfy run: 本机没有「" + (cur || "（空）") + "」，改用「" + list[0] + "」");
  }
  return changed;
}

async function callComfyUI(prompt, params, presetId, shouldAbort) {
  const p = getComfyPreset(presetId) || getComfyPreset(getComfyDefault("gen")) || getComfyPresets()[0];
  if (!p) throw new Error("还没有本地模型预设（设置 ▸ 本地 ComfyUI ▸ 新增）");
  if (!p.url) throw new Error("预设「" + p.name + "」未填 ComfyUI 地址");
  if (!String(p.workflow || "").trim()) throw new Error("预设「" + p.name + "」未配置工作流（设置 ▸ 本地 ComfyUI）");

  let wf;
  try { wf = JSON.parse(p.workflow); } catch (e) {
    throw new Error("预设「" + p.name + "」工作流 JSON 解析失败：" + e.message);
  }
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) {
    throw new Error("ComfyUI 工作流应为 API 格式对象（节点 id → 节点）");
  }

  const roles = {};
  ["prompt", "negative", "input", "mask", "size", "output"].forEach(function (r) {
    roles[r] = comfyFindRole(wf, r, p.roles && p.roles[r]);
  });
  if (!roles.prompt) {
    throw new Error("工作流里找不到正向提示词节点：把该节点标题改成 PROMPT，或在设置里填节点 ID");
  }
  wf[roles.prompt].inputs.text = prompt;
  if (roles.negative && params && typeof params.negative === "string") {
    wf[roles.negative].inputs.text = params.negative;
  }

  const base = await comfyPickEndpoint(p);
  /* 本机模型兜底：换机器后不必再点「适配本机模型」 */
  try { await comfyRunFixModels(wf, base); } catch (e) { diag("comfy run: 模型兜底失败（忽略） " + ((e && e.message) || e)); }
  const P = params || {};

  /* 图生图 / 局部重绘：先把图与蒙版传上去，再把文件名注入节点 */
  if (P.imageUri) {
    if (!roles.input) throw new Error("该预设的工作流没有输入图节点：把 LoadImage 标题改成 INPUT");
    startProgress("上传图片到本地 ComfyUI");
    wf[roles.input].inputs.image = await comfyUploadImage(P.imageUri, base, "psspark_in");
  }
  if (P.maskUri) {
    if (!roles.mask) throw new Error("该预设的工作流没有蒙版节点：把 LoadImageMask 标题改成 MASK");
    startProgress("上传蒙版到本地 ComfyUI");
    wf[roles.mask].inputs.image = await comfyUploadImage(P.maskUri, base, "psspark_mask");
  }

  /* 随机 seed：同一提示词多次运行不应出同一张 */
  Object.keys(wf).forEach(function (id) {
    const ins = (wf[id] && wf[id].inputs) || {};
    if (typeof ins.seed === "number") ins.seed = Math.floor(Math.random() * 1e15);
    if (typeof ins.noise_seed === "number") ins.noise_seed = Math.floor(Math.random() * 1e15);
  });
  comfyApplySize(wf, P.size);
  const dn = P.denoise != null ? P.denoise : (p.overrides && p.overrides.denoise);
  comfyApplyOverrides(wf, p.overrides, dn);

  throwIfAborted();
  startProgress("提交到本地 ComfyUI");
  const res = await xhrRequest({
    method: "POST",
    url: base + "/prompt",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: wf, client_id: "ps-spark-" + Date.now() }),
    timeout: 30000
  });
  let j = null;
  try { j = JSON.parse(res.response); } catch (e) { j = null; }
  if (res.status !== 200) {
    throw new Error("ComfyUI 拒绝请求 HTTP " + res.status + "：" + (comfyErrorText(j) || String(res.response || "").slice(0, 200)));
  }
  if (!j || !j.prompt_id) throw new Error("ComfyUI 未返回 prompt_id：" + (comfyErrorText(j) || ""));
  const id = j.prompt_id;
  diag("comfy: preset=" + p.name + " prompt_id=" + id);

  const t0 = Date.now();
  for (;;) {
    await sleepMs(1500);
    throwIfAborted();
    if (typeof shouldAbort === "function" && shouldAbort()) {
      const e = new Error("已取消");
      e.canceled = true;
      throw e;
    }
    if (Date.now() - t0 > 300000) throw new Error("ComfyUI 生成超时（5 分钟）");
    startProgress("本地 ComfyUI 生成中 " + Math.round((Date.now() - t0) / 1000) + "s");

    const hr = await xhrRequest({
      method: "GET",
      url: base + "/history/" + encodeURIComponent(id),
      timeout: 20000
    });
    let h = null;
    try { h = JSON.parse(hr.response); } catch (e) { h = null; }
    if (!h || hr.status !== 200) continue;
    const job = h[id];
    if (!job) continue;

    const st = job.status || {};
    if (st.status_str === "error") {
      const msgs = st.messages || [];
      let ex = null;
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i] && msgs[i][0] === "execution_error") ex = msgs[i][1];
      }
      if (ex) {
        throw new Error("ComfyUI 执行失败：节点 " + (ex.node_id || "?") +
          "（" + (ex.node_type || "?") + "）· " + (ex.exception_type || "") +
          "：" + (ex.exception_message || ""));
      }
      throw new Error("ComfyUI 执行失败：" + String(JSON.stringify(msgs)).slice(0, 300));
    }
    const outputs = job.outputs || {};
    const nodeIds = roles.output && outputs[roles.output] ? [roles.output] : Object.keys(outputs);
    for (let i = 0; i < nodeIds.length; i++) {
      const imgs = (outputs[nodeIds[i]] || {}).images;
      if (imgs && imgs.length) {
        const im = imgs[0];
        diag("comfy: 完成，耗时 " + Math.round((Date.now() - t0) / 1000) + "s");
        return base + "/view?filename=" + encodeURIComponent(im.filename) +
          "&subfolder=" + encodeURIComponent(im.subfolder || "") +
          "&type=" + encodeURIComponent(im.type || "output");
      }
    }
  }
}

/* 文本服务：OpenAI 兼容 Chat Completions（提示词助手 / 后续拆图蓝图等共用）
 * messages: [{role, content}, ...] → 返回纯文本内容 */
async function callTextApi(messages, timeout, modelOverride) {
  const key = await getTextKey();
  if (!key) throw new Error("请先在设置 ▸ 服务接入中配置文本服务 API Key");
  const svc = getTextService();
  const url = svc.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  const model = modelOverride || resolveModel("text");
  const body = JSON.stringify({
    model: model,
    messages: messages,
    temperature: 0.7,
    stream: false
  });
  log("请求文本服务（" + model + "）...");
  startProgress("等待文本服务响应");
  let res;
  try {
    res = await xhrRequest({
      method: "POST",
      url: url,
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: body,
      timeout: timeout || 120000
    });
  } finally {
    stopProgress();
  }
  let json;
  try { json = JSON.parse(res.response); } catch (e) {
    throw new Error("文本服务响应不是 JSON（HTTP " + res.status + "）");
  }
  if (res.status !== 200) {
    const msg = (json && json.error && json.error.message) || (json && json.message) || ("HTTP " + res.status);
    throw new Error("文本服务错误: " + msg);
  }
  const content = json && json.choices && json.choices[0] &&
    json.choices[0].message && json.choices[0].message.content;
  if (!content) throw new Error("文本服务未返回内容");
  diag("textApi ok: " + String(content).length + " chars");
  return String(content).trim();
}

/* 视觉理解调用：把画面（data URI）与文本一起发给「图片分析模型」。
 * 模型选择：resolveVisionModel()（设置里指定的图片分析模型；未指定时跟随支持看图的
 * 语言模型，否则用上一次跑通的看图模型）。
 * 约束：图片必须放在 user 消息的 content 数组里（DeepSeek 不接受其它角色携带图片）。
 * 成功后记录「跑通模型」，供语言模型不支持看图时回退使用。 */
async function callTextApiVision(systemText, userText, images, timeout) {
  const content = [{ type: "text", text: userText }];
  (images || []).forEach(function (u) {
    if (!u) return;
    content.push({ type: "image_url", image_url: { url: u, detail: "high" } });
  });
  const vModel = resolveVisionModel();
  diag("textApi(vision): " + (images || []).length + " 张图, " + String(userText).length + " 字, model=" + vModel);
  const out = await callTextApi([
    { role: "system", content: systemText },
    { role: "user", content: content }
  ], timeout, vModel);
  markVisionOk(vModel);
  return out;
}

/* 判断错误是否为「该模型不接受图片输入 / 模型不可用」——用于自动降级为纯文本分析。
 * 含模型不存在类错误：切换厂商后若图片分析模型不属于该平台（如用通义 Key 调 deepseek），
 * 服务端会返回 model 不存在——此时同样降级为纯文本（有补充说明时），而不是直接失败。 */
function isVisionUnsupportedError(err) {
  const s = String((err && err.message) || err || "").toLowerCase();
  if (!s) return false;
  return s.indexOf("does not support image") >= 0 ||
    s.indexOf("do not support image") >= 0 ||
    s.indexOf("not support image") >= 0 ||
    s.indexOf("unsupported image") >= 0 ||
    s.indexOf("image is not supported") >= 0 ||
    s.indexOf("invalid image") >= 0 ||
    s.indexOf("invalid content") >= 0 ||
    s.indexOf("multimodal") >= 0 ||
    s.indexOf("only support text") >= 0 ||
    s.indexOf("text-only") >= 0 ||
    s.indexOf("model not found") >= 0 ||
    s.indexOf("no such model") >= 0 ||
    s.indexOf("unknown model") >= 0 ||
    s.indexOf("invalid model") >= 0 ||
    s.indexOf("model does not exist") >= 0;
}

/* 文件 → data URI
 * 容错：部分管线函数返回 {entry, ...} 包装对象——若传入包装对象，自动取内层 entry */
async function fileToDataURI(entry) {
  let file = entry;
  if (file && typeof file.read !== "function" && file.entry && typeof file.entry.read === "function") {
    diag("fileToDataURI: 入参为包装对象，自动解包取 .entry");
    file = file.entry;
  }
  if (!file || typeof file.read !== "function") {
    throw new Error("无法读取文件对象（File.read 不可用）");
  }
  const buf = await file.read({ format: formats.binary });
  const b64 = base64FromBuffer(buf);
  diag(`dataURI ${file.name || "file"}: ${buf.byteLength || 0}B -> ${b64.length} chars`);
  return "data:image/png;base64," + b64;
}

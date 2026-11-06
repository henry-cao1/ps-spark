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
  const boundary = "----PS SparkBoundary" + Date.now();
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

/* 调 PS Spark API，返回 { url, usage } */
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
 * 契约来源：PS Spark 官方测试页 image.psspark.ai 的前端实现（比接口文档更完整）：
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
      /* 文本编码节点的字段名不统一：CLIPTextEncode 用 text，Qwen Image 2.1 的
         TextEncodeQwenImage21 用 prompt。两种都要认，否则导入新模型的工作流会报"找不到提示词节点" */
      const hasText = (typeof ins.text === "string" && /CLIPTextEncode/i.test(ct));
      const hasPrompt = (typeof ins.prompt === "string" && /TextEncode/i.test(ct));
      if (!hasText && !hasPrompt) continue;
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

function comfySnap(v, step) { return Math.max(step, Math.round(v / step) * step); }

/* 工作流对「像素尺寸整除」的要求（latent patchify 步长）：
 * HiDream O1 = 32、Flux2 = 16、其余按 8。预设可用 sizeStep 显式覆盖。 */
function comfyGridStep(wf, p) {
  if (p && typeof p.sizeStep === "number" && p.sizeStep > 0) return p.sizeStep;
  const ids = Object.keys(wf || {});
  let step = 8;
  for (let i = 0; i < ids.length; i++) {
    const t = String((wf[ids[i]] || {}).class_type || "");
    if (/HiDreamO1/i.test(t)) return 32;
    if (/Flux2/i.test(t)) step = Math.max(step, 16);
  }
  return step;
}

/* 取工作流里最大的数字节点 id + 1，用于插入辅助节点 */
function comfyNextNodeId(wf) {
  let max = 0;
  Object.keys(wf || {}).forEach(function (id) {
    const n = parseInt(id, 10);
    if (!isNaN(n) && n > max) max = n;
  });
  return String(max + 1);
}

/* 把 autogrow 动态插槽的嵌套写法拍平成 ComfyUI 认可的扁平键。
 * 例：{ images: { image1: ["5",0] } } → { "images.image_1": ["5",0] }
 * 只处理「值全是连线数组」的对象，且键名限定 images/image/refs/masks，
 * 免得把其它真正需要嵌套的输入（比如提示词对象）改坏。返回改动条数。 */
function comfyFlattenAutogrow(wf) {
  let n = 0;
  Object.keys(wf || {}).forEach(function (id) {
    const node = wf[id] || {};
    const ins = node.inputs || {};
    Object.keys(ins).forEach(function (k) {
      if (!/^(images?|refs?|masks?)$/i.test(k)) return;
      const v = ins[k];
      if (!v || typeof v !== "object" || Array.isArray(v)) return;
      const subs = Object.keys(v);
      if (!subs.length) return;
      /* 子项必须全是 [nodeId, slot] 这样的连线数组，否则不是插槽 */
      if (!subs.every(function (kk) { return Array.isArray(v[kk]); })) return;
      subs.forEach(function (kk) {
        const m = /^(?:image|img|ref|mask)_?(\d+)$/i.exec(kk);
        const outKey = k + "." + (m ? ("image_" + m[1]) : kk);
        ins[outKey] = v[kk];
        n++;
      });
      delete ins[k];
    });
  });
  return n;
}

/* 在输入图后插入 ImageScale，把所有对输入图的引用改指到缩放结果。
 * 为什么必须在「图」这一侧对齐，而不是只改 latent：
 * HiDream O1 的参考图分支会在 SamplerCustom 里对参考图做 32×32 patchify，
 * 693×1232 的图直接抛 einops「can't divide axis of length 1232 in chunks of 32」，
 * 这时 latent 改多少次都没用 —— 报错的是参考图张量本身。 */
function comfyInsertImageScale(wf, inputId, w, h) {
  const id = comfyNextNodeId(wf);
  wf[id] = {
    class_type: "ImageScale",
    inputs: { image: [String(inputId), 0], upscale_method: "lanczos", width: w, height: h, crop: "center" },
    _meta: { title: "psspark_align" }
  };
  const repoint = function (ref) {
    if (Array.isArray(ref) && String(ref[0]) === String(inputId) && (ref[1] === 0 || ref[1] == null)) return [id, 0];
    return ref;
  };
  Object.keys(wf).forEach(function (nid) {
    if (nid === id) return;
    const ins = (wf[nid] || {}).inputs || {};
    Object.keys(ins).forEach(function (k) {
      const v = ins[k];
      if (Array.isArray(v)) {
        ins[k] = Array.isArray(v[0]) ? v.map(repoint) : repoint(v);
      } else if (v && typeof v === "object") {
        /* 动态输入：{ image_1: ["6", 0], ... } */
        Object.keys(v).forEach(function (kk) { if (Array.isArray(v[kk])) v[kk] = repoint(v[kk]); });
      }
    });
  });
  return id;
}

/* 找 VAE 引用（VAEEncode 需要）：优先 VAELoader，其次 CheckpointLoaderSimple 的 vae 输出 */
function comfyFindVAERef(wf) {
  const ids = Object.keys(wf || {});
  for (let i = 0; i < ids.length; i++) {
    if (/VAELoader$/i.test(String((wf[ids[i]] || {}).class_type || ""))) return [ids[i], 0];
  }
  for (let i = 0; i < ids.length; i++) {
    if (/CheckpointLoaderSimple/i.test(String((wf[ids[i]] || {}).class_type || ""))) return [ids[i], 2];
  }
  for (let i = 0; i < ids.length; i++) {
    if (/VAELoader/i.test(String((wf[ids[i]] || {}).class_type || ""))) return [ids[i], 0];
  }
  return null;
}

/* 图生图保真：把「空 latent 起跑」的 i2i 工作流改成「参考图编码起跑」。
 * 背景：HiDream O1 参考图模板的 latent 是 EmptyHiDreamO1LatentImage + denoise=1，
 * 等于完全重绘，参考图只当弱条件 —— 实测出图跟原图基本无关（用户看到的就是
 * 「生成结果与给定图不相关」）。把 latent 换成 VAEEncode(参考图) 并把 denoise
 * 压到 0.6 附近，才能既保留构图、又有自然变化。返回被改造的采样节点数。 */
function comfyApplyI2iFidelity(wf, roles) {
  if (!roles || !roles.input) return 0;
  /* 优先用对齐后的输入（插过 ImageScale 时是它的输出），否则 VAEEncode 会吃到未对齐的原图，
   * latent 与参考图尺寸不一致，patchify 照样报错。 */
  const srcId = String(roles.inputRef || roles.input);
  const vaeRef = comfyFindVAERef(wf);
  if (!vaeRef) return 0;
  let n = 0;
  Object.keys(wf).forEach(function (id) {
    const node = wf[id] || {};
    const ins = node.inputs || {};
    if (!/Sampler/i.test(String(node.class_type || ""))) return;
    const lat = ins.latent_image;
    if (!Array.isArray(lat) || !lat.length) return;
    const src = wf[String(lat[0])];
    const srcType = String((src && src.class_type) || "");
    if (!/^Empty/i.test(srcType) || !/Latent/i.test(srcType)) return; /* 已是 img2img/inpaint 的不动 */
    const encId = comfyNextNodeId(wf);
    wf[encId] = {
      class_type: "VAEEncode",
      inputs: { pixels: [srcId, 0], vae: vaeRef },
      _meta: { title: "psspark_i2i_encode" }
    };
    ins.latent_image = [encId, 0];
    n++;
  });
  return n;
}

/* 把 denoise 压到上限（只动采样/调度节点，别误伤无关字段）。
 * SamplerCustom 系的 denoise 在 BasicScheduler 上，KSampler 系在自己身上，两种都要覆盖。 */
function comfyClampDenoise(wf, maxD) {
  let n = 0;
  Object.keys(wf || {}).forEach(function (id) {
    const node = wf[id] || {};
    const ins = node.inputs || {};
    if (typeof ins.denoise !== "number") return;
    if (!/Sampler|Scheduler/i.test(String(node.class_type || ""))) return;
    if (ins.denoise > maxD) { ins.denoise = maxD; n++; }
  });
  return n;
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
      /* 空 latent 的尺寸有整除要求，不能把选区/画布像素尺寸原样塞进去：
       * HiDream O1 的 patchify 是 32×32（本机实测 940×1672 → einops 报
       * “can't divide axis of length 1672 in chunks of 32”，任务直接失败），
       * Flux2 / MOSS 是 16。按模型对齐到最近的合法尺寸；图层落回画布时
       * 由 placeEntryAsLayer 的拉伸/居中对齐，不影响最终位置。 */
      const ct = String(n.class_type || "");
      const step = /HiDreamO1/i.test(ct) ? 32 : (/Flux2/i.test(ct) ? 16 : 8);
      ins.width = comfySnap(w, step);
      ins.height = comfySnap(h, step);
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
  const boundary = "----PS SparkBoundary" + Date.now();
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

/* 每次上传用唯一文件名（时间戳 + 自增序号），避免排队任务互相覆盖 input 文件 */
let __comfyTempSeq = 0;
function comfyTempName(prefix) {
  __comfyTempSeq++;
  return prefix + "_" + Date.now().toString(36) + "_" + __comfyTempSeq;
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

/* 提交前自检：工作流用到的节点、以及节点引用的模型文件，这台 ComfyUI 上到底有没有。
 * 之前的"测试连接"只打 /system_stats，只要服务在跑就说"连接正常"；
 * 真正缺自定义节点（如 ComfyUI-GGUF）或缺模型文件时，要点生成才失败，
 * 用户看到的现象就是"本地 ComfyUI 模型接不上"。这里提前把原因说清楚。 */
const COMFY_LOADER_FIELDS = {
  UnetLoaderGGUF: "unet_name", CLIPLoaderGGUF: "clip_name", VAELoader: "vae_name",
  CheckpointLoaderSimple: "ckpt_name", UnetLoader: "unet_name", UNETLoader: "unet_name",
  CLIPLoader: "clip_name", CLIPVisionLoader: "clip_name"
};
async function comfyPreflight(wf, base) {
  const types = [];
  Object.keys(wf || {}).forEach(function (id) {
    const t = String((wf[id] || {}).class_type || "");
    if (t && types.indexOf(t) < 0) types.push(t);
  });
  const infoMap = {}; /* 只在"确实查到了回应"时写，请求失败留空 —— 免得把网络问题误报成缺节点 */
  await Promise.all(types.map(async function (t) {
    try {
      const r = await xhrRequest({ method: "GET", url: base + "/object_info/" + encodeURIComponent(t), timeout: 4000 });
      if (r.status !== 200) return;
      const j = JSON.parse(r.response);
      infoMap[t] = j[t] || null; /* {} = 这台机器没装这个节点 */
    } catch (e) { /* ignore */ }
  }));
  const noNode = [], noFile = [];
  Object.keys(wf || {}).forEach(function (id) {
    const n = wf[id] || {};
    const t = String(n.class_type || "");
    if (!t || !(t in infoMap)) return;
    if (infoMap[t] === null) { if (noNode.indexOf(t) < 0) noNode.push(t); return; }
    const field = COMFY_LOADER_FIELDS[t];
    if (!field) return;
    const want = (n.inputs || {})[field];
    const req = infoMap[t].input && infoMap[t].input.required;
    const list = req && req[field] && req[field][0];
    if (want && Array.isArray(list) && list.length && list.indexOf(want) < 0) noFile.push(want);
  });
  if (noNode.length || noFile.length) {
    const parts = [];
    if (noNode.length) parts.push("缺节点 " + noNode.join("、") + "（需在 ComfyUI 装对应自定义节点）");
    if (noFile.length) parts.push("缺模型文件 " + noFile.join("、"));
    throw new Error("本地 ComfyUI 跑不了这条工作流：" + parts.join("；"));
  }
}

/* 探测一台机器的 ComfyUI 是否在线（多机场景：Mac / Win 各自一个预设） */
async function comfyProbe(url) {
  const base = (typeof comfyNormalizeUrl === "function") ? comfyNormalizeUrl(url) : String(url || "").replace(/\/+$/, "");
  if (!base) return { ok: false, error: "未填地址" };
  try {
    const r = await xhrRequest({ method: "GET", url: base + "/system_stats", timeout: 3000 });
    if (r.status !== 200) return { ok: false, error: "HTTP " + r.status };
    let j = null;
    try { j = JSON.parse(r.response); } catch (e) { j = null; }
    return { ok: true, version: (j && j.system && j.system.comfyui_version) || "?" };
  } catch (e) {
    /* 把实际请求地址带出来：Windows 上最常见的是 localhost(::1) 与 127.0.0.1 对不上 */
    return { ok: false, error: ((e && e.message) || "连接失败") + " · " + base };
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

  /* —— 参考图插槽（COMFY_AUTOGROW_V3）必须拍平成 "images.image_1" ——
   * Qwen Image 2.1 / HiDream O1 的 TextEncode* / ReferenceImages 节点，图片输入是
   * autogrow 动态插槽：API 格式里只认扁平键 `inputs["images.image_1"] = ["5",0]`。
   * 写成嵌套对象 `images:{image1:["5",0]}` 时 ComfyUI **不报错**，直接当没有参考图，
   * 结果就是「生成照跑，画出来跟原图毫无关系」（本机实测：万圣节海报 → 一张无关的巫师素描）。
   * 这里统一拍平并把 image1 / image_2 之类的键名归一成 image_N，用户自己导入的工作流也不会再踩。 */
  const flatN = comfyFlattenAutogrow(wf);
  if (flatN) diag("comfy: 已把 " + flatN + " 个参考图插槽拍平为 images.image_N（嵌套写法会被 ComfyUI 忽略）");

  const roles = {};
  ["prompt", "negative", "input", "mask", "size", "output"].forEach(function (r) {
    roles[r] = comfyFindRole(wf, r, p.roles && p.roles[r]);
  });
  if (!roles.prompt) {
    throw new Error("工作流里找不到正向提示词节点：把该节点标题改成 PROMPT，或在设置里填节点 ID");
  }
  /* 提示词字段名不统一：CLIPTextEncode 叫 text，TextEncodeQwenImage21 这类新节点叫 prompt。
     写死在 text 上会让新模型的提示词永远为空（生成照跑，但画的是空 prompt）。 */
  const pe = wf[roles.prompt].inputs || (wf[roles.prompt].inputs = {});
  if (!("text" in pe) && "prompt" in pe) pe.prompt = prompt;
  else pe.text = prompt;
  if (roles.negative && params && typeof params.negative === "string") {
    wf[roles.negative].inputs.text = params.negative;
  }

  const P = params || {};

  /* —— 输入图按工作流步长对齐（修「本地模型生成失败」）——
   * HiDream O1 的参考图会被 32×32 patchify，693×1232 这种尺寸直接抛 einops 错，
   * 且 latent 用 GetImageSize 链接到参考图时，comfyApplySize 改不到（它不是字面数字），
   * 所以必须在图这一侧对齐：插入 ImageScale 到 step 的整数倍，并把所有引用改指到它。 */
  const gridStep = comfyGridStep(wf, p);
  let sizeForApply = P.size;
  if (P.imageUri && gridStep > 8) {
    const dim = (typeof pngSizeFromDataURI === "function") ? pngSizeFromDataURI(P.imageUri) : null;
    if (dim && dim.w && dim.h) {
      const aw = comfySnap(dim.w, gridStep), ah = comfySnap(dim.h, gridStep);
      sizeForApply = aw + "x" + ah;
      if (aw !== dim.w || ah !== dim.h) {
        if (!roles.input) throw new Error("该预设的工作流没有输入图节点：把 LoadImage 标题改成 INPUT");
        const alignId = comfyInsertImageScale(wf, roles.input, aw, ah);
        roles.inputRef = alignId;
        diag("comfy: 输入图 " + dim.w + "×" + dim.h + " 按步长 " + gridStep + " 对齐为 " + aw + "×" + ah +
          "（否则 latent / 参考图 patchify 会失败）");
      }
    }
  }

  /* —— 图生图保真（修「生成结果与给定图不相关」）——
   * i2i 预设若从空 latent 起跑（denoise=1），参考图只是弱条件，出图等于重画一张。
   * 有参考图时把 latent 换成 VAEEncode(参考图)，denoise 压到 0.62（预设显式给了
   * 0<d<1 就按预设）。inpaint / 已是 img2img 的工作流不会被改动。 */
  let i2iEncoded = 0;
  if (P.imageUri) {
    i2iEncoded = comfyApplyI2iFidelity(wf, roles);
    if (i2iEncoded) diag("comfy: 参考图已接入 sampling 起点（VAEEncode ×" + i2iEncoded + "），避免只按提示词重画");
  }

  const base = await comfyPickEndpoint(p);
  /* 本机模型兜底：换机器后不必再点「适配本机模型」。
     必须在 preflight 之前跑，否则自检看到的还是旧文件名。 */
  try { await comfyRunFixModels(wf, base); } catch (e) { diag("comfy run: 模型兜底失败（忽略） " + ((e && e.message) || e)); }
  /* 连上之后、上传之前先自检：缺节点/缺模型文件直接抛出可读原因，
     否则本机没装 ComfyUI-GGUF 之类会一路走到 /prompt 才报晦涩的错误。 */
  await comfyPreflight(wf, base);

  /* 图生图 / 局部重绘：先把图与蒙版传上去，再把文件名注入节点。
   * ⚠ 上传名必须唯一：ComfyUI 的 input 目录是共享的，之前固定用 psspark_in.png
   * （overwrite=true），当排队里有两次任务、或相似图/拆图交错时，后一次上传会
   * 直接覆盖前一次的文件 —— 先入队的任务执行时拿到的是别的图，
   * 表现就是「生成的相似图跟原图没关系」。改成带序号的文件名，各任务互不影响。 */
  if (P.imageUri) {
    if (!roles.input) throw new Error("该预设的工作流没有输入图节点：把 LoadImage 标题改成 INPUT");
    startProgress("上传图片到本地 ComfyUI");
    wf[roles.input].inputs.image = await comfyUploadImage(P.imageUri, base, comfyTempName("psspark_in"));
  }
  if (P.maskUri) {
    if (!roles.mask) throw new Error("该预设的工作流没有蒙版节点：把 LoadImageMask 标题改成 MASK");
    startProgress("上传蒙版到本地 ComfyUI");
    wf[roles.mask].inputs.image = await comfyUploadImage(P.maskUri, base, comfyTempName("psspark_mask"));
  }

  /* 随机 seed：同一提示词多次运行不应出同一张 */
  Object.keys(wf).forEach(function (id) {
    const ins = (wf[id] && wf[id].inputs) || {};
    if (typeof ins.seed === "number") ins.seed = Math.floor(Math.random() * 1e15);
    if (typeof ins.noise_seed === "number") ins.noise_seed = Math.floor(Math.random() * 1e15);
  });
  comfyApplySize(wf, sizeForApply);
  const dn = P.denoise != null ? P.denoise : (p.overrides && p.overrides.denoise);
  comfyApplyOverrides(wf, p.overrides, dn);
  /* 走 VAEEncode 起跑时再压一次 denoise：BasicScheduler 上的 denoise 不受 overrides 管，
   * 仍是工作流里写死的 1.0（= 完全重绘，参考图白给）。 */
  if (i2iEncoded) {
    const ov = (p.overrides && p.overrides.denoise != null) ? Number(p.overrides.denoise) : null;
    const wantD = (ov != null && ov > 0 && ov < 1) ? ov : 0.62;
    const clamped = comfyClampDenoise(wf, wantD);
    diag("comfy: 图生图 denoise 上限 " + wantD + (clamped ? "（已调整 " + clamped + " 处）" : "（工作流已是该值）"));
  }

  throwIfAborted();
  startProgress("提交到本地 ComfyUI");
  const res = await xhrRequest({
    method: "POST",
    url: base + "/prompt",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: wf, client_id: "psspark-ps-" + Date.now() }),
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
  /* 原来写死 5 分钟：MOSS 指令编辑单张就要 155 秒，HiDream 1024 / 28 步在 8GB 显存上
   * 还要先卸载再加载 7.5GB 主模型，很容易越过 5 分钟被判「超时」——任务其实还在跑。
   * 预设可用 timeoutMs 覆盖；默认放宽到 20 分钟，取消/中止仍然随时生效。 */
  const waitMs = (p && typeof p.timeoutMs === "number" && p.timeoutMs > 60000) ? p.timeoutMs : 20 * 60000;
  for (;;) {
    await sleepMs(1500);
    throwIfAborted();
    if (typeof shouldAbort === "function" && shouldAbort()) {
      const e = new Error("已取消");
      e.canceled = true;
      throw e;
    }
    if (Date.now() - t0 > waitMs) throw new Error("ComfyUI 生成超时（" + Math.round(waitMs / 60000) + " 分钟）");
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

/* 按文件头魔数判定图片真实格式。
 * 为什么需要：服务端会给出「扩展名与内容不一致」的文件——gpt-image-2.6 的 GIF 结果
 * URL 是 .gif，但插件历史上固定把字节写进 psspark_result.png，于是磁盘上出现
 * 「名字叫 png、内容是 GIF」的文件（双击打不开、上传按后缀校验会被拒）。
 * 一律以字节为准。返回 "png" | "gif" | "jpg" | "webp" | ""（未知）。 */
function sniffImageExt(buf) {
  try {
    if (!buf) return "";
    const b = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
    if (b.length < 12) return "";
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";  /* GIF8 */
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "png";
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "jpg";
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
        b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
    return "";
  } catch (e) { return ""; }
}

/* 文件名 → MIME（data URI 用）。认不出就当 png，与旧行为一致。 */
function imageMimeOfName(name) {
  const n = String(name || "").toLowerCase();
  if (/\.gif$/.test(n)) return "image/gif";
  if (/\.jpe?g$/.test(n)) return "image/jpeg";
  if (/\.webp$/.test(n)) return "image/webp";
  return "image/png";
}

/* 文件名换扩展名：psspark_result.png + "gif" → psspark_result.gif（ext 为空则原样返回） */
function nameWithExt(name, ext) {
  const s = String(name || "psspark_result.png");
  if (!ext) return s;
  const m = /^(.*)\.[^.]+$/.exec(s);
  return (m ? m[1] : s) + "." + ext;
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
  /* MIME 按真实格式给：GIF 结果声明成 image/png 虽然多数浏览器会嗅探纠正，
   * 但 WebView 里「按声明解码」的分支会拿到静态首帧，动画就不动了。 */
  return "data:" + imageMimeOfName(file.name) + ";base64," + b64;
}

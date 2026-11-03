/*
 * providers.mjs — 把插件的请求规则复刻到 Node（只做 HTTP，不碰 PS）。
 *
 * 三种通道与插件保持一致：
 *   generations —— 文生图 / 带参考图的生成（image 传 data URI 数组）
 *   edits       —— 编辑类（image + 可选 mask，multipart）
 *   unified     —— nano 系列统一端点（images[] + aspectRatio，任务轮询）
 */
import { postJson, postForm, getJson, fetchBuffer, pickImageUrl } from "./http.mjs";

function authHeaders(provider) {
  const h = {};
  const key = provider.apiKey || "";
  if (provider.authHeader) h[provider.authHeader] = (provider.authPrefix || "Bearer ") + key;
  else h.Authorization = "Bearer " + key;
  if (provider.extraHeaders) Object.assign(h, provider.extraHeaders);
  return h;
}

function joinUrl(base, path) {
  return String(base).replace(/\/+$/, "") + (path || "");
}

function dataUriToBlob(uri) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(uri || "");
  if (!m) throw new Error("不是合法的 data URI");
  return new Blob([Buffer.from(m[2], "base64")], { type: m[1] });
}

export function modeFor(plugin, inst, model, hasImage, hasMask) {
  if (plugin.isNanoModel(model)) return "unified";
  if (inst.domain === "gen") return "generations";
  return "edits";
}

/* 返回 { url, latencyMs, requestMeta } */
export async function callModel(plugin, provider, modelCfg, req, timeoutMs) {
  const model = modelCfg.id;
  const t0 = Date.now();
  const mode = req.mode;
  const h = authHeaders(provider);
  let url = null;
  let meta = { mode: mode, model: model, endpoint: "" };

  try {

  if (mode === "generations") {
    const payload = {
      model: model,
      prompt: req.prompt,
      size: plugin.normalizeSizeForModel(model, req.size || "auto"),
      quality: plugin.normalizeQualityForModel(model, req.quality || "auto")
    };
    if (req.transparent) payload.Background = "transparent";
    if (req.images && req.images.length) payload.image = req.images;
    if (req.n) payload.n = req.n;

    const endpoint = joinUrl(provider.baseUrl, provider.generationsPath || "/v1/images/generations");
    meta.endpoint = endpoint;
    const res = await postJson(endpoint, payload, h, timeoutMs);
    if (!res.ok) throw httpError(res, endpoint);
    url = pickImageUrl(res.json);
    if (!url) throw new Error("响应中未找到图片 URL：" + (res.text || "").slice(0, 200));

  } else if (mode === "edits") {
    const fd = new FormData();
    fd.append("model", model);
    fd.append("prompt", req.prompt);
    fd.append("size", plugin.normalizeSizeForModel(model, req.size || "auto"));
    fd.append("quality", plugin.normalizeQualityForModel(model, req.quality || "auto"));
    if (req.transparent) fd.append("background", "transparent");
    fd.append("image", dataUriToBlob(req.images[0]), "image.png");
    if (req.maskUri) fd.append("mask", dataUriToBlob(req.maskUri), "mask.png");

    const endpoint = joinUrl(provider.baseUrl, provider.editsPath || "/v1/images/edits");
    meta.endpoint = endpoint;
    const res = await postForm(endpoint, fd, h, timeoutMs);
    if (!res.ok) throw httpError(res, endpoint);
    url = pickImageUrl(res.json);
    if (!url) throw new Error("响应中未找到图片 URL：" + (res.text || "").slice(0, 200));

  } else if (mode === "unified") {
    const endpoint = joinUrl(provider.baseUrl, provider.unifiedPath || "/v1/api/generate");
    meta.endpoint = endpoint;
    const payload = {
      model: model,
      prompt: req.prompt,
      images: req.images || [],
      aspectRatio: req.aspectRatio || plugin.normalizeSizeForModel(model, req.size || "auto")
    };
    const res = await postJson(endpoint, payload, h, timeoutMs);
    if (!res.ok) throw httpError(res, endpoint);
    url = pickImageUrl(res.json);
    if (!url) {
      const id = res.json && res.json.id;
      if (!id) throw new Error("统一端点未返回结果或任务 id");
      url = await pollUnified(endpoint, id, h, timeoutMs);
    }
  } else {
    throw new Error("未知请求模式：" + mode);
  }

  } catch (e) {
    if (e && !e.endpoint) e.endpoint = meta.endpoint || null;
    if (e && /^fetch failed$/.test(String(e.message || "")) && e.cause) {
      e.message = "网络请求失败：" + (e.cause.code || e.cause.message || String(e.cause));
    }
    throw e;
  }

  const latencyMs = Date.now() - t0;
  const buf = String(url).startsWith("data:") ? Buffer.from(url.split(",")[1], "base64") : await fetchBuffer(url);
  return { url: url, buffer: buf, latencyMs: latencyMs, meta: meta };
}

function httpError(res, endpoint) {
  let msg = "";
  try {
    const j = res.json || {};
    msg = (j.error && (j.error.message || j.error)) || j.message || j.msg || "";
  } catch (e) { /* ignore */ }
  if (!msg) msg = (res.text || "").slice(0, 300);
  const err = new Error("HTTP " + res.status + "：" + msg);
  err.httpStatus = res.status;
  err.body = res.text || (res.json ? JSON.stringify(res.json) : "");
  err.endpoint = endpoint || null;
  return err;
}

async function pollUnified(endpoint, id, headers, timeoutMs) {
  const t0 = Date.now();
  const pollUrl = endpoint.replace(/\/generate$/, "/result");
  while (Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await getJson(pollUrl + "?id=" + encodeURIComponent(id), headers, 30000);
    const j = r.json || {};
    if (j.status === "succeeded") {
      const u = (j.results && j.results[0] && j.results[0].url) || j.url;
      if (!u) throw new Error("任务成功但未返回 URL");
      return u;
    }
    if (j.status === "failed" || j.status === "violation") {
      throw new Error(j.error || j.failure_reason || j.msg || ("任务" + j.status));
    }
  }
  throw new Error("任务超时（" + Math.round(timeoutMs / 1000) + "s）");
}

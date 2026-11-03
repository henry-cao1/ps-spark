/* http.mjs — 轻量 HTTP 封装（Node 22 原生 fetch；带超时与错误归一化） */

export async function postJson(url, body, headers, timeoutMs = 180000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}

export async function postForm(url, form, headers, timeoutMs = 180000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "POST", headers: headers || {}, body: form, signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* ignore */ }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}

export async function getJson(url, headers, timeoutMs = 60000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: headers || {}, signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* ignore */ }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBuffer(url, timeoutMs = 120000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error("下载图片失败 HTTP " + res.status);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

/* 统一从各家响应里取图片地址（OpenAI 兼容 / 统一端点 / 任务轮询） */
export function pickImageUrl(json) {
  if (!json) return null;
  if (json.data && json.data[0]) {
    if (json.data[0].url) return json.data[0].url;
    if (json.data[0].b64_json) return "data:image/png;base64," + json.data[0].b64_json;
  }
  if (json.results && json.results[0] && json.results[0].url) return json.results[0].url;
  if (json.url) return json.url;
  return null;
}

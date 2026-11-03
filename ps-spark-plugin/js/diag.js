/*
 * diag.js — 环境探测 / 诊断日志 / 进度指示 / 通用工具
 * W0：自 main.js 原样搬迁（行为不变）
 * 加载顺序：diag → services → api → ps → app（全局共享命名空间）
 */

/* 环境探测：UXP 面板内可 require photoshop；浏览器预览时优雅降级（UI 可点，PS 功能提示不可用） */
let app = null, core = null, action = null, imaging = null;
let fs = null, secure = null, formats = null;
const IS_UXP = (function () {
  try {
    const ps = require("photoshop");
    app = ps.app; core = ps.core; action = ps.action; imaging = ps.imaging;
    const uxp = require("uxp");
    fs = uxp.storage.localFileSystem;
    secure = uxp.storage.secureStorage;
    formats = uxp.storage.formats;
    return true;
  } catch (e) {
    return false;
  }
})();

/* ---------------- 基础工具 ---------------- */

const $ = (id) => document.getElementById(id);
const logEl = $("log");

function log(msg, cls) {
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = `[${t}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
  diag((cls || "info") + " | " + msg);
}

/* ---------------- 进度指示（长等待时保持"活着"的观感，避免误判为卡死/闪退） ---------------- */

let progressTimer = null, progressStart = 0;

function startProgress(label) {
  /* 与底部诊断条合并：进度直接写在状态行上，不再单占一行 */
  const wrap = $("progressWrap"), txt = $("progressText"), spin = $("progressSpin");
  const st = $("statusText"), dot = $("statusDot");
  startProgress.lastLabel = label;
  progressStart = Date.now();
  if (spin) spin.classList.add("spin");
  if (wrap) wrap.classList.add("hidden");
  if (dot) dot.className = "spin";
  const show = (t) => {
    if (st) st.textContent = t;
    if (txt) txt.textContent = t;
  };
  show(label + "…");
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    const s = Math.round((Date.now() - progressStart) / 1000);
    show(`${startProgress.lastLabel}… 已等待 ${s} 秒`);
  }, 1000);
}

function stopProgress() {
  clearInterval(progressTimer);
  progressTimer = null;
  const wrap = $("progressWrap"), spin = $("progressSpin"), dot = $("statusDot");
  if (wrap) wrap.classList.add("hidden");
  if (spin) spin.classList.remove("spin");
  if (dot) dot.className = "";
}

/* ---------------- 诊断日志（写入 dataFolder/psspark_debug.log，定位已安装插件问题） ---------------- */

const diagBuffer = [];
let diagWriting = false, diagQueued = false;

/* 串行 + 合并写入：避免并发写导致「旧快照覆盖新日志」以及半截文件 */
function diag(msg) {
  diagBuffer.push(`[${new Date().toISOString()}] ${msg}`);
  if (!fs || !formats) return;
  try { if (typeof getDiagFlag === "function" && !getDiagFlag()) return; } catch (e) { /* ignore */ }
  if (diagWriting) { diagQueued = true; return; }
  diagKick();
}

async function diagKick() {
  diagWriting = true;
  try {
    await new Promise((r) => setTimeout(r, 80)); // 合并同一批日志为一次写盘
    const snapshot = diagBuffer.join("\n");
    const folder = await fs.getDataFolder();
    const entry = await folder.createFile("psspark_debug.log", { overwrite: true });
    await entry.write(snapshot, { format: formats.utf8 });
  } catch (e) { /* 诊断写失败不影响主流程 */ }
  finally {
    diagWriting = false;
    if (diagQueued) { diagQueued = false; diagKick(); }
  }
}
window.addEventListener("error", (e) => {
  diag("window.onerror: " + (e.message || e.type) + " @ " + (e.filename || "") + ":" + (e.lineno || ""));
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason;
  diag("unhandledrejection: " + ((r && (r.stack || r.message)) || String(r)));
});

/* ---------------- 环境自检（跨平台定位：Windows / macOS 差异、数据目录权限） ---------------- */

function envInfo() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) ? navigator.userAgent : "";
  let platform = "unknown";
  if (/Windows/i.test(ua)) platform = "Windows";
  else if (/Mac OS X|Macintosh/i.test(ua)) platform = "macOS";
  let psVer = "?";
  try { psVer = app.version || "?"; } catch (e) { /* ignore */ }
  return { platform: platform, ps: psVer, ua: ua };
}

/* 把平台 / PS 版本 / 数据目录真实路径写进日志：Windows 上路径与权限问题主要靠这一行定位 */
async function diagEnv(tag) {
  const e = envInfo();
  let dataPath = "?";
  try {
    const f = await fs.getDataFolder();
    dataPath = (f && (f.nativePath || f.name)) || "?";
  } catch (err) {
    dataPath = "读取失败: " + ((err && err.message) || String(err));
  }
  diag("env[" + (tag || "boot") + "]: platform=" + e.platform + " | ps=" + e.ps +
    " | dataFolder=" + dataPath + " | ua=" + e.ua);
  return { platform: e.platform, ps: e.ps, dataPath: dataPath };
}

/* ---------------- 工具：UTF-8 / Base64 ---------------- */

function utf8Bytes(str) {
  const s = encodeURIComponent(str);
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "%") {
      out.push(parseInt(s.substr(i + 1, 2), 16));
      i += 2;
    } else {
      out.push(s.charCodeAt(i));
    }
  }
  return new Uint8Array(out);
}

function base64FromBuffer(buf) {
  const bytes = new Uint8Array(buf);
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : null, b2 = i + 2 < bytes.length ? bytes[i + 2] : null;
    out += table[b0 >> 2] + table[((b0 & 3) << 4) | (b1 === null ? 0 : b1 >> 4)];
    out += b1 === null ? "=" : table[((b1 & 15) << 2) | (b2 === null ? 0 : b2 >> 6)];
    out += b2 === null ? "=" : table[b2 & 63];
  }
  return out;
}

/* 从 PNG data URI 读取宽高（只解前 33 字节，用于尺寸对齐校验；非 PNG 或无 ihdr 返回 null） */
function pngSizeFromDataURI(uri) {
  try {
    const s = String(uri || "");
    const head0 = "data:image/png;base64,";
    if (s.indexOf(head0) !== 0) return null;
    const b64 = s.slice(head0.length, head0.length + 48);
    const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const idx = {};
    for (let i = 0; i < table.length; i++) idx[table[i]] = i;
    const bytes = [];
    for (let i = 0; i + 3 < b64.length; i += 4) {
      const c0 = idx[b64[i]], c1 = idx[b64[i + 1]], c2 = idx[b64[i + 2]], c3 = idx[b64[i + 3]];
      if (c0 == null || c1 == null) break;
      bytes.push((c0 << 2) | (c1 >> 4));
      if (c2 != null) bytes.push(((c1 & 15) << 4) | (c2 >> 2));
      if (c3 != null) bytes.push(((c2 & 3) << 6) | c3);
      if (bytes.length >= 24) break;
    }
    if (bytes.length < 24) return null;
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
    const w = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
    const h = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
    if (!w || !h) return null;
    return { w: w, h: h };
  } catch (e) { return null; }
}

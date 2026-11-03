#!/usr/bin/env node
/*
 * web-server.mjs — 本地 Web 测试台（宽屏查看 / 运行 / 打分）
 *
 * 与插件共用同一份数据目录：
 *   macOS   ~/Library/Application Support/Adobe/UXP/PluginsStorage/PHSP/<ver>/External/
 *           com.psspark.ps.assistant/PluginData/dev/bench
 *   Windows %APPDATA%/Adobe/UXP/PluginsStorage/PHSP/<ver>/External/
 *           com.psspark.ps.assistant/PluginData/dev/bench
 *
 * 用法：
 *   node bench/web-server.mjs                 # 自动探测数据目录，端口 7788
 *   node bench/web-server.mjs --port 8080
 *   node bench/web-server.mjs --data /path/to/dev/bench
 *   GRSAI_API_KEY=sk-xxx node bench/web-server.mjs
 *
 * 只监听 127.0.0.1，不对外网开放。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPlugin } from "./lib/plugin.mjs";
import { callModel } from "./lib/providers.mjs";
import { runPool } from "./lib/pool.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PLUGIN_DIR = path.join(ROOT, "ps-spark-plugin");
const WEB_DIR = path.join(HERE, "web");
const CONFIG_PATH_DEFAULT = path.join(HERE, "config.json");

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const s = argv[i];
    if (!s.startsWith("--")) continue;
    const k = s.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { a[k] = next; i++; }
    else a[k] = true;
  }
  return a;
}

/* ---------------- 配置与数据目录 ---------------- */

const args = parseArgs(process.argv);
const PORT = parseInt(args.port || process.env.GRSAI_BENCH_PORT || "7788", 10);
const CONFIG_PATH = args.config ? path.resolve(String(args.config)) : CONFIG_PATH_DEFAULT;

let config = { providers: {}, models: [], timeoutSec: 300 };
try { config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); } catch (e) { /* 允许无配置启动 */ }

function findBenchDir() {
  if (args.data) {
    const p = path.resolve(String(args.data));
    return p;
  }
  if (process.env.GRSAI_BENCH_DATA) return path.resolve(process.env.GRSAI_BENCH_DATA);

  const roots = [];
  if (process.platform === "darwin") {
    roots.push(path.join(os.homedir(), "Library", "Application Support", "Adobe", "UXP", "PluginsStorage"));
  } else if (process.platform === "win32") {
    if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, "Adobe", "UXP", "PluginsStorage"));
    roots.push(path.join(os.homedir(), "AppData", "Roaming", "Adobe", "UXP", "PluginsStorage"));
  } else {
    roots.push(path.join(os.homedir(), ".config", "Adobe", "UXP", "PluginsStorage"));
  }

  const hits = [];
  for (const root of roots) {
    let hosts = [];
    try { hosts = fs.readdirSync(root); } catch (e) { continue; }
    for (const host of hosts) {
      const hostDir = path.join(root, host);
      let versions = [];
      try { versions = fs.readdirSync(hostDir); } catch (e) { continue; }
      for (const ver of versions) {
        const extDir = path.join(hostDir, ver, "External");
        let plugins = [];
        try { plugins = fs.readdirSync(extDir); } catch (e) { continue; }
        for (const pid of plugins) {
          if (pid.indexOf("com.psspark.ps.assistant") !== 0) continue;
          const dir = path.join(extDir, pid, "PluginData", "dev", "bench");
          if (fs.existsSync(dir)) {
            hits.push({ dir, mtime: fs.statSync(dir).mtimeMs });
          }
        }
      }
    }
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits.length ? hits[0].dir : null;
}

let DATA_DIR = findBenchDir();

function benchPaths() {
  const dir = DATA_DIR || "";
  return {
    root: dir,
    cases: path.join(dir, "cases"),
    index: path.join(dir, "index.json")
  };
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/* ---------------- 通用工具 ---------------- */

function json(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function text(res, code, msg) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(msg);
}

function safeId(s) {
  return /^[A-Za-z0-9_-]{1,64}$/.test(String(s || ""));
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}

function writeJson(file, obj) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(obj, null, 1), "utf8");
}

function hashStr(s) {
  return crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 8);
}

function newId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ---------------- 提示词包 → 批量建用例 ----------------
 * 让「一批提示词」不用在 PS 里一条条冻结：解析文本 → 每条建一个文生图用例，
 * 底图用指定尺寸的纯白画布（文生图不会把它当参考图发出去）。
 */
let CRC_TABLE = null;
function crc32(buf) {
  if (typeof zlib.crc32 === "function") return zlib.crc32(buf);
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function solidPng(w, h, rgb) {
  const rowLen = 1 + w * 3;
  const raw = Buffer.alloc(rowLen * h);
  for (let y = 0; y < h; y++) {
    const off = y * rowLen;
    raw[off] = 0;
    for (let x = 0; x < w; x++) {
      raw[off + 1 + x * 3] = rgb[0];
      raw[off + 2 + x * 3] = rgb[1];
      raw[off + 3 + x * 3] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

/* 支持两种格式：
 *   1) 带 [A1 标题] 的块：块内取「输入：/提示词：/Prompt:」下一行的内容
 *   2) 一行一条提示词（跳过 # 注释、=== 分隔线、判定行）
 */
function parsePromptPack(text) {
  const lines = String(text || "").split(/\r?\n/);
  const out = [];
  const ignored = [];
  const push = (title, prompt) => {
    let p = String(prompt || "").trim();
    p = p.replace(/^[「"']/, "").replace(/[」"']$/, "").trim();
    if (p.length < 4) return false;
    if (/^判定/.test(p)) return false;
    out.push({ title: String(title || "").trim() || ("文生图 · " + (out.length + 1)), prompt: p });
    return true;
  };
  const hasBlocks = lines.some((l) => /^\s*\[[^\]]+\]\s*$/.test(l));
  if (!hasBlocks) {
    lines.forEach((l) => {
      const s = l.trim();
      if (!s) return;
      if (/^(#|\/\/|=|>|-{3,})/.test(s)) return;
      if (/^(判定|输入|提示词)[:：]/.test(s)) return;
      push("", s);
    });
    return { items: out, ignored };
  }
  let title = "", titleLine = -1, got = false;
  const flush = () => {
    if (title && !got) ignored.push(title);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const h = /^\[([^\]]+)\]$/.exec(line);
    if (h) { flush(); title = h[1]; titleLine = i; got = false; continue; }
    /* 「输入图：」「提问：」= 看图题，需要真实底图，不自动建文生图用例 */
    if (/^(?:输入图|提问)\s*[:：]/.test(line)) {
      if (title && !got) ignored.push(title);
      got = true;
      continue;
    }
    const m = /^(?:输入|提示词|Prompt)\s*[:：]\s*(.+)$/i.exec(line);
    if (m) {
      if (push(title, m[1])) got = true;
      continue;
    }
  }
  flush();
  return { items: out, ignored };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const txt = Buffer.concat(chunks).toString("utf8");
        resolve(txt ? JSON.parse(txt) : {});
      } catch (e) { reject(new Error("请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

function mimeOf(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return "application/octet-stream";
}

function extOf(mime) {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/webp") return "webp";
  return "bin";
}

/* 读 PNG/JPEG/WebP 尺寸（插件侧只解析 PNG，导致 JPEG 输入尺寸为空） */
function imageSize(buf) {
  try {
    if (buf.length >= 24 && buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG") {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
    if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
      const fmt = buf.toString("ascii", 12, 16);
      if (fmt === "VP8X") return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (fmt === "VP8 ") return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (fmt === "VP8L") {
        const b = buf.readUInt32LE(21);
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
      }
    }
  } catch (e) { /* ignore */ }
  return null;
}

function fileToDataUri(file) {
  const buf = fs.readFileSync(file);
  return "data:" + mimeOf(buf) + ";base64," + buf.toString("base64");
}

/* ---------------- 用例读取 ---------------- */

function listCases() {
  const p = benchPaths();
  if (!p.root || !fs.existsSync(p.cases)) return [];
  const out = [];
  for (const id of fs.readdirSync(p.cases)) {
    if (!safeId(id)) continue;
    const dir = path.join(p.cases, id);
    const c = readJson(path.join(dir, "case.json"), null);
    if (!c) continue;
    const runs = listRunMetas(dir);
    const okCount = runs.filter((r) => r.status === "ok").length;
    const last = runs.length ? runs[runs.length - 1].createdAt : null;
    out.push({
      id: c.id,
      title: c.title,
      instId: c.instId,
      instName: c.instName,
      branchLabel: c.branchLabel,
      createdAt: c.createdAt,
      promptPreview: String(c.prompt || "").slice(0, 60),
      promptHash: c.promptHash || "",
      runCount: runs.length,
      okCount,
      lastRunAt: last,
      baselineRunId: c.baselineRunId || null,
      hasMask: fs.existsSync(path.join(dir, "mask.png")) || fs.existsSync(path.join(dir, "mask.jpg")),
      hasAssets: fs.existsSync(path.join(dir, "assets"))
    });
  }
  out.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  return out;
}

function listRunMetas(caseDir) {
  const runsDir = path.join(caseDir, "runs");
  const out = [];
  if (!fs.existsSync(runsDir)) return out;
  for (const rid of fs.readdirSync(runsDir)) {
    if (!safeId(rid)) continue;
    const m = readJson(path.join(runsDir, rid, "meta.json"), null);
    if (m) {
      m.runId = m.runId || rid;
      out.push(m);
    }
  }
  out.sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  return out;
}

function getCase(id) {
  if (!safeId(id)) return null;
  const dir = path.join(benchPaths().cases, id);
  const c = readJson(path.join(dir, "case.json"), null);
  if (!c) return null;
  return { caseData: c, dir };
}

function findAssetFiles(caseDir) {
  const dir = path.join(caseDir, "assets");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f)).sort();
}

function findInputFile(caseDir) {
  return ["input.png", "input.jpg", "input.jpeg", "input.webp"]
    .map((f) => path.join(caseDir, f))
    .filter((f) => fs.existsSync(f))[0] || null;
}

function updateIndexRun(c) {
  const p = benchPaths();
  if (!p.root) return;
  const idx = readJson(p.index, []);
  const arr = Array.isArray(idx) ? idx : [];
  let ent = arr.filter((e) => e.id === c.id)[0];
  if (!ent) {
    ent = { id: c.id, title: c.title, instId: c.instId, instName: c.instName, branch: c.branch, branchLabel: c.branchLabel, createdAt: c.createdAt, promptHash: c.promptHash, runCount: 0, lastRunAt: null, baselineRunId: c.baselineRunId || null };
    arr.unshift(ent);
  }
  const runs = listRunMetas(path.join(p.cases, c.id));
  ent.runCount = runs.filter((r) => r.status === "ok").length;
  ent.lastRunAt = runs.length ? runs[runs.length - 1].createdAt : null;
  ent.baselineRunId = c.baselineRunId || null;
  writeJson(p.index, arr);
}

/* ---------------- 运行任务 ---------------- */

const plugin = loadPlugin(PLUGIN_DIR);
const jobs = new Map();

function providerFor() {
  const list = config.providers || {};
  const name = Object.keys(list)[0];
  if (!name) return null;
  const p = Object.assign({}, list[name]);
  if (!p.apiKey && p.apiKeyEnv) p.apiKey = process.env[p.apiKeyEnv] || "";
  if (!p.apiKey) p.apiKey = process.env.GRSAI_API_KEY || "";
  return p;
}

function modelCatalog() {
  const presets = (plugin.IMAGE_MODEL_PRESETS || []).map((m) => ({
    id: m.id,
    label: m.label || m.id,
    group: m.group || ""
  }));
  const locals = comfyPresets();
  if (!locals.length) {
    /* 还没配本地预设时也留一个占位，点运行会明确提示怎么配 */
    presets.push({ id: "comfy", label: "本地 ComfyUI（未配置）", group: "local" });
  } else {
    locals.forEach((p) => {
      presets.push({ id: "comfy:" + p.id, label: "本地 · " + p.name, group: "local" });
    });
  }
  return presets;
}

function modelCfg(id) {
  const found = (config.models || []).filter((m) => m.id === id)[0];
  return found ? Object.assign({}, found) : { id };
}

/* ---------------- 本地预设（benchmark 也把本地模型当一等公民） ----------------
 * config.comfy.presets[]：每台机器/每条工作流一条，模型 id 用 comfy:<presetId>
 * 兼容旧配置（单条 comfy.url + comfy.workflow）→ 自动视为 id=default 的预设
 */
function comfyPresets() {
  const c = config.comfy || {};
  if (Array.isArray(c.presets) && c.presets.length) {
    return c.presets.filter((p) => p && p.workflow).map((p) => ({
      id: String(p.id || p.name || "p"),
      name: String(p.name || p.id || "本地"),
      url: String(p.url || "http://127.0.0.1:8188"),
      workflow: String(p.workflow),
      promptNode: String(p.promptNode || ""),
      caps: Array.isArray(p.caps) && p.caps.length ? p.caps : ["t2i"]
    }));
  }
  if (c.url && c.workflow) {
    return [{
      id: "default", name: c.name || "本机", url: c.url, workflow: c.workflow,
      promptNode: c.promptNode || "", caps: c.caps || ["t2i"]
    }];
  }
  return [];
}
function comfyPresetById(id) { return comfyPresets().filter((p) => p.id === id)[0] || null; }
function isComfyModel(m) { return typeof m === "string" && (m === "comfy" || m.indexOf("comfy:") === 0); }
function comfyPresetIdOf(m) {
  if (!isComfyModel(m)) return "";
  if (m.indexOf("comfy:") === 0) return m.slice(6);
  const l = comfyPresets();
  return l[0] ? l[0].id : "";
}
function comfyModelLabel(m) {
  if (!isComfyModel(m)) return m;
  const p = comfyPresetById(comfyPresetIdOf(m));
  return "本地 · " + (p ? p.name : "未配置");
}

/* 用例需要的能力：和插件侧同一套判定 */
function requiredCaps(caseData, baseReq) {
  if (!caseData) return ["t2i"];
  if (caseData.instId === "text2img") return ["t2i"];
  if (baseReq && baseReq.maskUri) return ["inpaint"];
  return ["i2i"];
}

function comfyBlockReason(caseData, baseReq, preset) {
  if (!preset) return "本地预设不存在（检查 bench/config.json 的 comfy.presets）";
  if (!String(preset.workflow || "").trim()) return "预设「" + preset.name + "」未配置工作流";
  const need = requiredCaps(caseData, baseReq);
  const lack = need.filter((c) => preset.caps.indexOf(c) < 0);
  if (lack.length) {
    const name = (caseData && caseData.instName) || (caseData && caseData.instId) || "当前用例";
    return "「" + preset.name + "」未声明「" + lack.join("/") + "」能力，跑不了「" + name + "」";
  }
  return null;
}

function buildRequestFor(caseData, inst, dir) {
  const inputPath = findInputFile(dir);
  if (!inputPath) throw new Error("用例缺少输入图 input.png");

  const images = [fileToDataUri(inputPath)];
  const maskPath = ["mask.png", "mask.jpg", "mask.jpeg"].map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f))[0];
  const maskUri = maskPath ? fileToDataUri(maskPath) : null;

  const warnings = [];
  if (maskPath) {
    const ins = imageSize(fs.readFileSync(inputPath));
    const ms = imageSize(fs.readFileSync(maskPath));
    if (ins && ms && (ins.w !== ms.w || ins.h !== ms.h)) {
      warnings.push("蒙版尺寸 " + ms.w + "×" + ms.h + " 与输入 " + ins.w + "×" + ins.h + " 不一致，API 可能拒绝");
    }
  }

  /* 拼合类：assets/ 下的图层（画布对齐）按顺序附加 */
  const assets = findAssetFiles(dir).map((f) => fileToDataUri(path.join(dir, "assets", f)));
  images.push.apply(images, assets);

  const params = caseData.params || {};
  return {
    prompt: caseData.prompt,
    images,
    maskUri,
    assets,
    warnings,
    size: params.size || "auto",
    quality: params.quality || "auto",
    transparent: !!params.transparent,
    /* 用例固定了 seed 就跨机可复现；没固定则运行时随机并记录实际值 */
    seed: params.seed != null && params.seed !== "" ? Number(params.seed) : null
  };
}

function modeForModel(inst, model) {
  if (plugin.isNanoModel(model)) return "unified";
  if (inst && inst.domain === "gen") return "generations";
  return "edits";
}

/* 本地 ComfyUI：提交 → 轮询 → 下载，Node fetch 版（插件内是 UXP XHR 版）
 * preset: { id, name, url, workflow, promptNode, caps }
 * 返回 meta.provenance：复现一次结果所需的全部信息（seed / 采样参数 / 工作流指纹 / 模型文件） */
async function callComfyNode(prompt, params, preset) {
  if (!preset || !preset.url || !preset.workflow) {
    throw new Error("本地预设未配置（bench/config.json 的 comfy.presets）");
  }
  let wf;
  try {
    wf = typeof preset.workflow === "string" ? JSON.parse(preset.workflow) : preset.workflow;
  } catch (e) {
    throw new Error("ComfyUI 工作流 JSON 解析失败：" + e.message);
  }
  if (!wf || typeof wf !== "object" || Array.isArray(wf)) throw new Error("ComfyUI 工作流应为 API 格式对象");

  const ids = Object.keys(wf);
  let promptNode = preset.promptNode && wf[preset.promptNode] ? preset.promptNode : null;
  if (!promptNode) {
    for (const id of ids) {
      const n = wf[id] || {};
      if (!/CLIPTextEncode/i.test(String(n.class_type || ""))) continue;
      if (!n.inputs || typeof n.inputs.text !== "string") continue;
      const title = String((n._meta && n._meta.title) || "").toLowerCase();
      if (/negative|负面|反向/.test(title)) continue;
      promptNode = id;
      break;
    }
  }
  if (!promptNode) throw new Error("工作流里找不到正向提示词节点（CLIPTextEncode）");
  wf[promptNode].inputs.text = prompt;

  /* 固定 seed 才能跨机复现：用例给了 seed 就用它，否则随机并把实际值记进 meta */
  const fixedSeed = params && Number.isFinite(Number(params.seed)) ? Number(params.seed) : null;
  const seeds = [];
  for (const id of ids) {
    const ins = (wf[id] && wf[id].inputs) || {};
    if (typeof ins.seed === "number") { ins.seed = fixedSeed != null ? fixedSeed : Math.floor(Math.random() * 1e15); seeds.push(ins.seed); }
    if (typeof ins.noise_seed === "number") { ins.noise_seed = fixedSeed != null ? fixedSeed : Math.floor(Math.random() * 1e15); seeds.push(ins.noise_seed); }
  }
  const m = /^(\d+)\s*[x×]\s*(\d+)$/.exec(String((params && params.size) || ""));
  if (m) {
    const w = parseInt(m[1], 10), h = parseInt(m[2], 10);
    for (const id of ids) {
      const n = wf[id] || {};
      const ins = n.inputs || {};
      if (/Latent/i.test(String(n.class_type || "")) && typeof ins.width === "number" && typeof ins.height === "number") {
        ins.width = w; ins.height = h;
      }
    }
  }

  /* 溯源：工作流指纹按「注入之后」算，seed 已经写进去了 */
  const workflowHash = crypto.createHash("sha1").update(JSON.stringify(wf)).digest("hex").slice(0, 12);
  const samplers = [];
  const modelFiles = [];
  for (const id of ids) {
    const n = wf[id] || {}, ins = n.inputs || {}, ct = String(n.class_type || "");
    if (/KSampler/i.test(ct)) {
      samplers.push({ steps: ins.steps, cfg: ins.cfg, sampler: ins.sampler_name, scheduler: ins.scheduler, denoise: ins.denoise });
    }
    for (const k of ["unet_name", "ckpt_name", "clip_name", "vae_name", "lora_name"]) {
      if (typeof ins[k] === "string") modelFiles.push(ins[k]);
    }
  }

  const base = String(preset.url).replace(/\/+$/, "");
  const t0 = Date.now();
  const res = await fetch(base + "/prompt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: wf, client_id: "ps-spark-web-" + Date.now() })
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error("ComfyUI 拒绝请求 HTTP " + res.status + "：" + txt.slice(0, 200));
  }
  const j = await res.json();
  if (!j || !j.prompt_id) throw new Error("ComfyUI 未返回 prompt_id");
  const pid = j.prompt_id;

  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    if (Date.now() - t0 > 300000) throw new Error("ComfyUI 生成超时（5 分钟）");
    const hr = await fetch(base + "/history/" + encodeURIComponent(pid));
    if (!hr.ok) continue;
    const h = await hr.json().catch(() => null);
    if (!h) continue;
    const job = h[pid];
    if (!job) continue;
    if (job.status && job.status.status_str === "error") {
      throw new Error("ComfyUI 执行失败：" + String(JSON.stringify(job.status.messages || [])).slice(0, 300));
    }
    const outputs = job.outputs || {};
    for (const nid of Object.keys(outputs)) {
      const imgs = outputs[nid].images;
      if (!imgs || !imgs.length) continue;
      const im = imgs[0];
      const vurl = base + "/view?filename=" + encodeURIComponent(im.filename) +
        "&subfolder=" + encodeURIComponent(im.subfolder || "") +
        "&type=" + encodeURIComponent(im.type || "output");
      const vr = await fetch(vurl);
      if (!vr.ok) throw new Error("下载 ComfyUI 结果失败 HTTP " + vr.status);
      const buf = Buffer.from(await vr.arrayBuffer());
      return {
        buffer: buf,
        latencyMs: Date.now() - t0,
        meta: {
          endpoint: base + "/prompt",
          provenance: {
            kind: "local",
            presetId: preset.id,
            presetName: preset.name,
            url: base,
            promptNode,
            seed: seeds.length ? seeds[0] : null,
            samplers,
            modelFiles,
            workflowHash,
            size: m ? (m[1] + "x" + m[2]) : (params && params.size) || ""
          }
        }
      };
    }
  }
}

async function runJob(job, caseData, dir, models, makeBaseline) {
  const provider = providerFor();
  const hasApi = models.some((m) => !isComfyModel(m));
  if (hasApi && (!provider || !provider.apiKey)) {
    job.status = "error";
    job.error = "未配置 API Key：在 bench/config.json 的 providers.grsai.apiKey 填入，或启动时设置 GRSAI_API_KEY";
    return;
  }
  const inst = plugin.instById(caseData.instId);
  const baseReq = buildRequestFor(caseData, inst, dir);
  (baseReq.warnings || []).forEach((w) => job.logs.push("⚠ " + w));
  const runsDir = ensureDir(path.join(dir, "runs"));

  async function runOneModel(model) {
    job.running.push(model);
    job.logs.push("→ " + model);

    const runId = newId("r");
    const runDir = ensureDir(path.join(runsDir, runId));
    const meta = {
      runId,
      model,
      status: "running",
      isBaseline: false,
      createdAt: new Date().toISOString(),
      latencyMs: 0,
      width: null,
      height: null,
      bytes: 0,
      rating: null,
      note: "",
      error: null
    };
    writeJson(path.join(runDir, "meta.json"), meta);

    const t0 = Date.now();
    try {
      let buf = null, latency = 0, endpoint = null, provenance = null;
      if (isComfyModel(model)) {
        const preset = comfyPresetById(comfyPresetIdOf(model));
        const reason = comfyBlockReason(caseData, baseReq, preset);
        if (reason) throw new Error(reason);
        const r = await callComfyNode(baseReq.prompt, { size: baseReq.size, seed: baseReq.seed }, preset);
        buf = r.buffer;
        latency = r.latencyMs;
        endpoint = r.meta && r.meta.endpoint;
        provenance = (r.meta && r.meta.provenance) || null;
      } else {
        const req = {
          mode: modeForModel(inst, model),
          prompt: baseReq.prompt,
          images: baseReq.images,
          maskUri: baseReq.maskUri,
          size: baseReq.size,
          quality: baseReq.quality,
          transparent: baseReq.transparent
        };
        const res = await callModel(plugin, provider, modelCfg(model), req, (config.timeoutSec || 300) * 1000);
        buf = res.buffer;
        latency = res.latencyMs;
        endpoint = res.meta && res.meta.endpoint;
      }
      const size = imageSize(buf);
      meta.width = size ? size.w : null;
      meta.height = size ? size.h : null;
      meta.bytes = buf.length;
      meta.latencyMs = latency;
      meta.status = "ok";
      meta.endpoint = endpoint || null;
      if (provenance) meta.provenance = provenance;

      /* 统一写 output.png：内容可能是 JPEG/WebP，服务端按字节返回正确 MIME，
       * 插件侧也只认 output.png，避免同一张图存两份。 */
      fs.writeFileSync(path.join(runDir, "output.png"), buf);
      job.logs.push("✓ " + model + " · " + (meta.latencyMs / 1000).toFixed(1) + "s · " + (size ? size.w + "×" + size.h : "尺寸未知"));
    } catch (e) {
      meta.status = "error";
      meta.latencyMs = Date.now() - t0;
      meta.error = (e && e.message) || String(e);
      if (e && e.httpStatus) meta.httpStatus = e.httpStatus;
      if (e && e.body) meta.body = String(e.body).slice(0, 2000);
      job.logs.push("✗ " + model + "：" + meta.error);
    } finally {
      job.running = job.running.filter((m) => m !== model);
      job.done++;
    }

    writeJson(path.join(runDir, "meta.json"), meta);
    job.results.push(meta);
  }

  /* API 模型并发；comfy 串行（显存只够一条工作流，同时提交会互相等待/爆显存） */
  const comfyModels = models.filter(isComfyModel);
  const apiModels = models.filter((m) => !isComfyModel(m));
  const limit = Math.max(1, Math.min(parseInt(config.concurrency, 10) || 3, 6));

  await Promise.all([
    runPool(apiModels, limit, runOneModel),
    (async () => {
      for (const m of comfyModels) await runOneModel(m);
    })()
  ]);

  /* 并发下统一挑第一个成功结果作为基准，避免多路同时写 case.json */
  if (makeBaseline && !caseData.baselineRunId) {
    const firstOk = job.results.filter((r) => r.status === "ok")[0];
    if (firstOk) {
      caseData.baselineRunId = firstOk.runId;
      firstOk.isBaseline = true;
      writeJson(path.join(dir, "case.json"), caseData);
      const p = path.join(runsDir, firstOk.runId, "meta.json");
      const m = readJson(p, null);
      if (m) { m.isBaseline = true; writeJson(p, m); }
    }
  }

  updateIndexRun(caseData);
  job.status = "done";
  job.finishedAt = new Date().toISOString();
}

/* ---------------- 路由 ---------------- */

function sendFile(res, file, cache) {
  if (!fs.existsSync(file)) return json(res, 404, { error: "文件不存在" });
  const buf = fs.readFileSync(file);
  res.writeHead(200, {
    "Content-Type": mimeOf(buf),
    "Content-Length": buf.length,
    "Cache-Control": cache ? "max-age=60" : "no-store"
  });
  res.end(buf);
}

function findRunOutput(caseId, runId) {
  if (!safeId(caseId) || !safeId(runId)) return null;
  const dir = path.join(benchPaths().cases, caseId, "runs", runId);
  for (const name of ["output.png", "output.jpg", "output.webp"]) {
    const f = path.join(dir, name);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

async function handleApi(req, res, u) {
  const parts = u.pathname.split("/").filter(Boolean); /* api/... */

  if (u.pathname === "/api/config/key" && req.method === "POST") {
    const body = await readBody(req);
    const key = String(body.apiKey || "").trim();
    if (!key) return json(res, 400, { error: "Key 不能为空" });
    const cfg = readJson(CONFIG_PATH, {});
    cfg.providers = cfg.providers || {};
    cfg.providers.grsai = cfg.providers.grsai || {};
    cfg.providers.grsai.apiKey = key;
    writeJson(CONFIG_PATH, cfg);
    config = cfg;
    const p = providerFor();
    return json(res, 200, { ok: true, keyReady: !!(p && p.apiKey) });
  }

  if (u.pathname === "/api/state") {
    const provider = providerFor();
    return json(res, 200, {
      dataDir: DATA_DIR,
      keyReady: !!(provider && provider.apiKey),
      models: modelCatalog(),
      cases: listCases(),
      platform: process.platform
    });
  }

  if (u.pathname === "/api/cases" && req.method === "GET") {
    return json(res, 200, { cases: listCases() });
  }

  /* 提示词包 → 批量建文生图用例（不用在 PS 里一条条冻结） */
  if (u.pathname === "/api/cases/import-pack" && req.method === "POST") {
    const body = await readBody(req);
    const parsed = parsePromptPack(body.text);
    const list = parsed.items;
    if (!list.length) {
      return json(res, 400, {
        error: "没解析出提示词：支持「[A1 标题] + 输入：…」块格式，或一行一条",
        ignored: parsed.ignored
      });
    }
    const sizeStr = /^\d{2,5}x\d{2,5}$/i.test(String(body.size || "")) ? String(body.size) : "1024x1024";
    const [pw, ph] = sizeStr.toLowerCase().split("x").map((n) => parseInt(n, 10));
    const png = solidPng(pw, ph, [255, 255, 255]);
    const known = new Set(listCases().map((c) => c.promptHash));
    const created = [];
    const skipped = [];
    for (const item of list.slice(0, 80)) {
      const ph2 = hashStr(item.prompt);
      if (known.has(ph2)) { skipped.push(item.title); continue; }
      known.add(ph2);
      const id = newId("c");
      const dir = ensureDir(path.join(benchPaths().cases, id));
      const c = {
        schema: 1, id, instId: "text2img", instName: "文生图",
        branch: "default", branchLabel: "默认",
        title: item.title, createdAt: new Date().toISOString(),
        prompt: item.prompt, promptHash: ph2,
        params: { size: sizeStr, quality: "auto", transparent: false },
        source: { kind: "blank", width: pw, height: ph, bytes: png.length },
        inputs: { input: "input.png", mask: null, assets: [] },
        warnings: [], baselineRunId: null,
        pack: String(body.pack || "提示词包")
      };
      writeJson(path.join(dir, "case.json"), c);
      fs.writeFileSync(path.join(dir, "input.png"), png);
      updateIndexRun(c);
      created.push({ id, title: c.title });
    }
    return json(res, 200, {
      ok: true,
      created: created.length,
      skipped: skipped.length,
      ignored: parsed.ignored,
      cases: created
    });
  }

  /* 导入用例包：换机器后跑同一份用例（可复现性靠 case.params.seed + meta.provenance） */
  if (u.pathname === "/api/cases/import" && req.method === "POST") {
    const body = await readBody(req);
    const b = body && body.schema === "ps-spark-case-bundle" ? body : (body && body.bundle);
    if (!b || b.schema !== "ps-spark-case-bundle" || !b.input || !b.input.b64) {
      return json(res, 400, { error: "不是有效的用例包（应为「导出用例包」生成的 JSON）" });
    }
    const id = newId("c");
    const dir = ensureDir(path.join(benchPaths().cases, id));
    const extOf = (n) => {
      const m = /\.([a-z0-9]+)$/i.exec(String(n || ""));
      return m ? m[1].toLowerCase() : "png";
    };
    const c = Object.assign({}, b.case || {}, {
      id,
      createdAt: new Date().toISOString(),
      baselineRunId: null,
      importedFrom: b.case && b.case.id ? b.case.id : null,
      importedAt: new Date().toISOString()
    });
    writeJson(path.join(dir, "case.json"), c);
    fs.writeFileSync(path.join(dir, "input." + extOf(b.input.name)), Buffer.from(b.input.b64, "base64"));
    if (b.mask && b.mask.b64) {
      fs.writeFileSync(path.join(dir, "mask." + extOf(b.mask.name)), Buffer.from(b.mask.b64, "base64"));
    }
    if (Array.isArray(b.assets) && b.assets.length) {
      ensureDir(path.join(dir, "assets"));
      b.assets.forEach((a) => {
        fs.writeFileSync(path.join(dir, "assets", a.name || ("asset_" + a.b64.length + ".png")), Buffer.from(a.b64, "base64"));
      });
    }
    updateIndexRun(c);
    return json(res, 200, { ok: true, id, title: c.title || c.instName || id });
  }

  /* /api/cases/:id */
  if (parts.length >= 3 && parts[0] === "api" && parts[1] === "cases") {
    const caseId = parts[2];
    const got = getCase(caseId);
    if (!got) return json(res, 404, { error: "用例不存在" });

    if (parts.length === 3 && req.method === "GET") {
      /* 插件旧数据可能没解析出尺寸（JPEG 输入），这里按文件补一次，不回写 */
      const inputFile = findInputFile(got.dir);
      if (inputFile) {
        const sz = imageSize(fs.readFileSync(inputFile));
        if (sz) {
          got.caseData.source = Object.assign({}, got.caseData.source || {}, { width: sz.w, height: sz.h });
        }
      }
      const assets = findAssetFiles(got.dir).map((f, i) => ({
        index: i,
        name: f,
        url: "/api/cases/" + caseId + "/asset/" + i
      }));
      const hasMask = fs.existsSync(path.join(got.dir, "mask.png")) || fs.existsSync(path.join(got.dir, "mask.jpg"));
      /* 只要有任意一个预设支持这条用例，comfy 就可用；具体到某个预设再单独判定 */
      const baseReqLite = { maskUri: hasMask ? "local" : null, assets };
      const locals = comfyPresets();
      const okLocal = locals.filter((p) => !comfyBlockReason(got.caseData, baseReqLite, p));
      const blockReason = okLocal.length ? null
        : (locals.length ? comfyBlockReason(got.caseData, baseReqLite, locals[0]) : "还没配置本地预设（bench/config.json 的 comfy.presets）");
      return json(res, 200, {
        case: got.caseData,
        runs: listRunMetas(got.dir),
        assets,
        comfy: {
          ok: !blockReason,
          reason: blockReason,
          presets: locals.map((p) => ({ id: p.id, name: p.name, ok: !comfyBlockReason(got.caseData, baseReqLite, p) }))
        },
        inputUrl: "/api/cases/" + caseId + "/file/input",
        maskUrl: hasMask ? "/api/cases/" + caseId + "/file/mask" : null
      });
    }

    /* 导出用例包：JSON（含 base64 图片），另一台机器导入后跑同一份用例 */
    if (parts.length === 4 && parts[3] === "export" && req.method === "GET") {
      const inputFile = findInputFile(got.dir);
      if (!inputFile) return json(res, 400, { error: "用例缺少输入图 input.png" });
      const maskFile = ["mask.png", "mask.jpg", "mask.jpeg"].map((f) => path.join(got.dir, f)).filter((f) => fs.existsSync(f))[0];
      const bundle = {
        schema: "ps-spark-case-bundle",
        version: 1,
        exportedAt: new Date().toISOString(),
        case: Object.assign({}, got.caseData, { baselineRunId: null }),
        input: { name: path.basename(inputFile), b64: fs.readFileSync(inputFile).toString("base64") },
        mask: maskFile ? { name: path.basename(maskFile), b64: fs.readFileSync(maskFile).toString("base64") } : null,
        assets: findAssetFiles(got.dir).map((f) => ({
          name: f,
          b64: fs.readFileSync(path.join(got.dir, "assets", f)).toString("base64")
        })),
        /* 这台机器跑出来的可复现参数：换机后按同样的 seed / 工作流指纹复核 */
        provenance: listRunMetas(got.dir).filter((r) => r.provenance).map((r) => ({
          model: r.model,
          status: r.status,
          createdAt: r.createdAt,
          provenance: r.provenance
        }))
      };
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="ps-spark-case-' + caseId + '.json"'
      });
      return res.end(JSON.stringify(bundle));
    }

    if (parts.length === 4 && parts[3] === "file" && req.method === "GET") {
      const which = u.searchParams.get("name") || "input";
      const names = which === "mask"
        ? ["mask.png", "mask.jpg", "mask.jpeg"]
        : ["input.png", "input.jpg", "input.jpeg", "input.webp"];
      const f = names.map((n) => path.join(got.dir, n)).filter((p) => fs.existsSync(p))[0];
      if (!f) return json(res, 404, { error: "文件不存在" });
      return sendFile(res, f, true);
    }

    if (parts.length === 4 && parts[3] === "asset" && req.method === "GET") {
      const idx = parseInt(u.searchParams.get("i") || "0", 10);
      const list = findAssetFiles(got.dir);
      if (!list[idx]) return json(res, 404, { error: "资产不存在" });
      return sendFile(res, path.join(got.dir, "assets", list[idx]), true);
    }

    if (parts.length === 4 && parts[3] === "run" && req.method === "POST") {
      for (const j of jobs.values()) {
        if (j.status === "running") return json(res, 409, { error: "已有任务在运行，请等待完成" });
      }
      const body = await readBody(req);
      const models = (body.models || []).filter((m) => typeof m === "string" && m);
      if (!models.length) return json(res, 400, { error: "至少选择一个模型" });
      if (models.some(isComfyModel)) {
        const baseReq = buildRequestFor(got.caseData, plugin.instById(got.caseData.instId), got.dir);
        for (const m of models.filter(isComfyModel)) {
          const reason = comfyBlockReason(got.caseData, baseReq, comfyPresetById(comfyPresetIdOf(m)));
          if (reason) return json(res, 400, { error: reason });
        }
      }
      const job = {
        id: newId("job"),
        caseId,
        status: "running",
        total: models.length,
        done: 0,
        running: [],
        logs: [],
        results: [],
        startedAt: new Date().toISOString(),
        error: null,
        concurrency: Math.max(1, Math.min(parseInt(config.concurrency, 10) || 3, 6))
      };
      jobs.set(job.id, job);
      /* 同步标记，避免并发任务 */
      runJob(job, got.caseData, got.dir, models, true).catch((e) => {
        job.status = "error";
        job.error = (e && e.message) || String(e);
      });
      return json(res, 200, { jobId: job.id });
    }

    if (parts.length === 3 && req.method === "DELETE") {
      fs.rmSync(got.dir, { recursive: true, force: true });
      const idx = readJson(benchPaths().index, []);
      writeJson(benchPaths().index, (Array.isArray(idx) ? idx : []).filter((e) => e.id !== caseId));
      return json(res, 200, { ok: true });
    }
  }

  /* /api/cases/:id/runs/:runId/(image|rating|baseline) */
  if (parts.length >= 6 && parts[0] === "api" && parts[1] === "cases" && parts[3] === "runs") {
    const caseId = parts[2], runId = parts[4], action = parts[5];
    if (!safeId(caseId) || !safeId(runId)) return json(res, 400, { error: "id 不合法" });
    const runDir = path.join(benchPaths().cases, caseId, "runs", runId);
    const metaPath = path.join(runDir, "meta.json");
    const meta = readJson(metaPath, null);
    if (!meta) return json(res, 404, { error: "结果不存在" });

    if (action === "image" && req.method === "GET") {
      const f = findRunOutput(caseId, runId);
      return f ? sendFile(res, f, true) : json(res, 404, { error: "结果图不存在" });
    }

    if (action === "rating" && req.method === "POST") {
      const body = await readBody(req);
      if (body.rating != null) meta.rating = Math.max(0, Math.min(5, parseInt(body.rating, 10) || 0));
      if (body.note != null) meta.note = String(body.note).slice(0, 200);
      writeJson(metaPath, meta);
      return json(res, 200, { ok: true, rating: meta.rating, note: meta.note });
    }

    if (action === "baseline" && req.method === "POST") {
      const got = getCase(caseId);
      if (!got) return json(res, 404, { error: "用例不存在" });
      got.caseData.baselineRunId = runId;
      writeJson(path.join(got.dir, "case.json"), got.caseData);
      for (const other of listRunMetas(got.dir)) {
        const p = path.join(got.dir, "runs", other.runId, "meta.json");
        const m = readJson(p, null);
        if (!m) continue;
        m.isBaseline = m.runId === runId;
        writeJson(p, m);
      }
      updateIndexRun(got.caseData);
      return json(res, 200, { ok: true });
    }
  }

  if (parts.length === 3 && parts[0] === "api" && parts[1] === "jobs" && req.method === "GET") {
    const job = jobs.get(parts[2]);
    if (!job) return json(res, 404, { error: "任务不存在" });
    return json(res, 200, job);
  }

  return json(res, 404, { error: "接口不存在" });
}

const MIME_STATIC = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function serveStatic(res, pathname) {
  let rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  rel = rel.replace(/\.\./g, "");
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return text(res, 404, "Not found");
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME_STATIC[ext] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  res.end(fs.readFileSync(file));
}

/* ---------------- 启动 ---------------- */

DATA_DIR = DATA_DIR || null;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  try {
    if (u.pathname === "/api/health") {
      return json(res, 200, { ok: true, dataDir: DATA_DIR, version: 1 });
    }
    if (u.pathname.startsWith("/api/")) {
      return await handleApi(req, res, u);
    }
    return serveStatic(res, u.pathname);
  } catch (e) {
    return json(res, 500, { error: (e && e.message) || String(e) });
  }
});

function openBrowser(url) {
  try {
    let child;
    if (process.platform === "darwin") {
      child = spawn("open", [url], { detached: true, stdio: "ignore" });
    } else if (process.platform === "win32") {
      /* explorer.exe 直接交给默认浏览器；比 cmd /c start 的空标题写法稳 */
      child = spawn("explorer.exe", [url], { detached: true, stdio: "ignore" });
    } else {
      child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    }
    if (child && child.unref) child.unref();
  } catch (e) { /* 打不开就让用户手动点链接 */ }
}

let currentPort = PORT;
let readyShown = false;

function onReady() {
  if (readyShown) return;
  readyShown = true;
  const url = "http://127.0.0.1:" + currentPort;
  const p = providerFor();
  console.log("");
  console.log("  ◆ Grsai 模型测试台已启动");
  console.log("    页面     " + url);
  console.log("    数据     " + (DATA_DIR || "未找到（请先用插件创建一个用例，或 --data 指定）"));
  console.log("    API Key  " + (p && p.apiKey ? "已配置" : "未配置（页面里可以直接填，或改 bench/config.json）"));
  console.log("    模型     " + modelCatalog().length + " 个");
  console.log("");
  console.log("  保持这个窗口打开；关闭窗口即停止服务。");
  if (args.open || args.o) setTimeout(() => openBrowser(url), 350);
}

server.on("listening", onReady);

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE" && currentPort < PORT + 20) {
    const busy = currentPort;
    currentPort++;
    console.log("端口 " + busy + " 被占用，改用 " + currentPort + " …");
    setTimeout(() => server.listen(currentPort, "127.0.0.1"), 60);
    return;
  }
  console.error("启动失败：" + ((err && err.message) || err));
  process.exit(1);
});

server.listen(currentPort, "127.0.0.1");

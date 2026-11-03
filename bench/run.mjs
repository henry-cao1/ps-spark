#!/usr/bin/env node
/*
 * run.mjs — 模型基准测试（独立工具，不进插件包）
 *
 * 用法：
 *   node bench/run.mjs --list
 *   node bench/run.mjs --mock                        # 离线自检，不需要 Key
 *   node bench/run.mjs --config bench/config.json --models all --cases all --repeat 2
 *   node bench/run.mjs --models gpt-image-2.5,seedream-4.5 --cases text2img_basic,erase_object
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPlugin, buildRequest } from "./lib/plugin.mjs";
import { callModel, modeFor } from "./lib/providers.mjs";
import { mockGenerate } from "./lib/mock.mjs";
import { decode, imageInfo, blankScore, alphaRatio, outsideChange, diffRatio, aspectError, hasPixelMetrics } from "./lib/metrics.mjs";
import { buildReport } from "./lib/report.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PLUGIN_DIR = path.join(ROOT, "ps-spark-plugin");

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const s = argv[i];
    if (!s.startsWith("--")) { a._.push(s); continue; }
    const k = s.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) { a[k] = next; i++; }
    else a[k] = true;
  }
  return a;
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

/* 提示词文件：可直接编辑 prompt / finalPrompt 后用 --prompts 复测。
 * 图片路径优先相对提示词文件所在目录解析（运行目录内的 inputs/ 副本），找不到再回退 bench/。 */
function loadPromptsFile(file, forceReTemplate) {
  const abs = path.resolve(file);
  const baseDir = path.dirname(abs);
  const raw = readJson(abs);
  const arr = Array.isArray(raw) ? raw : (raw.prompts || []);
  if (!arr.length) throw new Error("提示词文件里没有条目：" + abs);

  const resolveAsset = (rel) => {
    if (!rel) return null;
    if (path.isAbsolute(rel)) return rel;
    const near = path.resolve(baseDir, rel);
    if (fs.existsSync(near)) return near;
    return path.resolve(HERE, rel);
  };

  let retemplated = 0;
  const list = arr.map((p, i) => {
    /* 用户改了 prompt 却没改 finalPrompt 时，自动按当前插件模板重新生成，避免"改了没生效" */
    const changed = !!(p.promptHash && sha256(p.prompt || "").slice(0, 16) !== p.promptHash);
    const useFinal = !forceReTemplate && !changed;
    if (changed) retemplated++;
    return {
      id: p.id || p.caseId || ("prompt_" + (i + 1)),
      title: p.title || p.id || ("提示词 " + (i + 1)),
      category: p.category || "edit",
      instance: p.instance,
      prompt: p.prompt || "",
      params: p.params || {},
      extra: p.extra || null,
      images: (p.images || []).map(resolveAsset).filter(Boolean),
      mask: resolveAsset(p.mask),
      _finalPrompt: useFinal ? (p.finalPrompt || p._finalPrompt || null) : null,
      _promptChanged: changed,
      _file: path.basename(abs)
    };
  });

  return {
    list,
    all: list,
    meta: {
      runId: Array.isArray(raw) ? null : (raw.runId || null),
      models: Array.isArray(raw) ? [] : (raw.models || []),
      source: abs,
      retemplated: retemplated
    }
  };
}

function loadCases(opts) {
  if (opts.promptsFile) {
    const loaded = loadPromptsFile(opts.promptsFile, opts.forceReTemplate);
    let list = loaded.list.slice();
    if (opts.ids && opts.ids !== "all") {
      const set = String(opts.ids).split(",").map((s) => s.trim());
      list = list.filter((c) => set.indexOf(c.id) >= 0);
    }
    if (opts.category && opts.category !== "all") list = list.filter((c) => c.category === opts.category);
    return { list, all: loaded.all, promptsMeta: loaded.meta };
  }

  const dir = path.join(HERE, "cases");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const all = files.map((f) => {
    const def = readJson(path.join(dir, f));
    def._file = f;
    if (!def.category) def.category = "edit";
    return def;
  });
  let list = all.slice();
  if (opts.includeDisabled !== true) list = list.filter((c) => c.enabled !== false);
  if (opts.category && opts.category !== "all") list = list.filter((c) => c.category === opts.category);
  if (opts.ids && opts.ids !== "all") {
    const set = String(opts.ids).split(",").map((s) => s.trim());
    list = list.filter((c) => set.indexOf(c.id) >= 0);
  }
  return { list, all };
}

/* 模型选择：支持 id、1 基序号（1,3,5）或 all */
function pickModels(models, spec) {
  if (!spec || spec === "all") return models;
  const parts = String(spec).split(",").map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    if (/^\d+$/.test(p)) {
      const i = parseInt(p, 10);
      if (i < 1 || i > models.length) throw new Error("模型序号越界：" + p + "（共 " + models.length + " 个）");
      out.push(models[i - 1]);
    } else {
      const m = models.filter((x) => x.id === p)[0];
      if (!m) throw new Error("未找到模型：" + p);
      out.push(m);
    }
  }
  return out;
}

function loadConfig(file) {
  const cfg = readJson(file);
  cfg.models = (cfg.models || []).map((m) => {
    const p = (cfg.providers || {})[m.provider] || {};
    const envKey = p.apiKeyEnv || (m.provider + "_API_KEY").toUpperCase();
    return Object.assign({}, m, {
      apiKey: p.apiKey || process.env[envKey] || "",
      _envKey: envKey
    });
  });
  return cfg;
}

function dataUri(buf) { return "data:image/png;base64," + buf.toString("base64"); }
function safeName(s) { return String(s).replace(/[^a-zA-Z0-9._-]/g, "_"); }
function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function toPosix(p) { return String(p).split(path.sep).join("/"); }
function median(arr) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/* 输入归档：把用例引用的图片/蒙版复制进本次运行目录，保证 runs 可独立复现 */
function createInputArchiver(outDir) {
  const dir = path.join(outDir, "inputs");
  fs.mkdirSync(dir, { recursive: true });
  const map = new Map();      // 绝对路径 -> 运行目录内相对路径
  const index = {};           // 相对路径 -> { source, sha256, bytes, kind }
  function archive(srcPath, kind) {
    const abs = path.resolve(srcPath);
    if (map.has(abs)) return map.get(abs);
    if (!fs.existsSync(abs)) throw new Error("输入文件不存在：" + abs);
    const buf = fs.readFileSync(abs);
    const hash = sha256(buf);
    let name = path.basename(abs);
    let dest = path.join(dir, name);
    if (fs.existsSync(dest) && sha256(fs.readFileSync(dest)) !== hash) {
      const ext = path.extname(name);
      dest = path.join(dir, path.basename(name, ext) + "-" + hash.slice(0, 8) + ext);
    }
    fs.writeFileSync(dest, buf);
    const relp = toPosix(path.relative(outDir, dest));
    map.set(abs, relp);
    index[relp] = {
      source: toPosix(path.relative(ROOT, abs)),
      sha256: hash,
      bytes: buf.length,
      kind: kind
    };
    return relp;
  }
  return { dir, map, index, archive, saved: (relp) => map.has(path.resolve(relp)) };
}

/* 配置快照：抹掉一切密钥，只留可复现所需的服务商地址与模型清单 */
function redactConfig(cfg, models) {
  const providers = {};
  Object.keys(cfg.providers || {}).forEach((k) => {
    const p = cfg.providers[k] || {};
    providers[k] = {
      type: p.type || "openai",
      baseUrl: p.baseUrl || "",
      apiKeyEnv: p.apiKeyEnv || null,
      generationsPath: p.generationsPath || null,
      editsPath: p.editsPath || null,
      unifiedPath: p.unifiedPath || null,
      authHeader: p.authHeader || null
    };
  });
  return {
    capturedAt: new Date().toISOString(),
    concurrency: cfg.concurrency != null ? cfg.concurrency : null,
    timeoutSec: cfg.timeoutSec != null ? cfg.timeoutSec : null,
    providers: providers,
    models: models.map((m) => ({
      id: m.id,
      label: m.label || m.id,
      provider: m.provider,
      pricePerImage: m.pricePerImage || null,
      apiKeyEnv: m._envKey || null,
      apiKeyPresent: !!m.apiKey
    }))
  };
}

function toPromptsMd(prompts, meta) {
  const out = [];
  out.push("# 测试提示词 · " + meta.runId);
  out.push("");
  out.push("> 共 " + prompts.length + " 条。改完 `prompts.json` 里的 `prompt`（用户输入）或 `finalPrompt`（实际发送）后，");
  out.push("> 执行 `npm run retest`（默认复测最近一次），或 `node run.mjs --prompts <本文件路径>`。");
  out.push("> 不传 `--models` 时沿用本文件的模型组合。");
  out.push("> 改 `prompt` → 按插件当前模板重新生成提示词；改 `finalPrompt` → 原样发送（精确复现）。");
  out.push("");
  prompts.forEach((p, i) => {
    out.push("## " + (i + 1) + ". " + p.title + "（" + p.id + "）");
    out.push("");
    out.push("- 功能实例：`" + p.instance + "`");
    out.push("- 输入：" + ((p.images || []).map((x) => "`" + x + "`").join("、") || "（无）"));
    if (p.mask) out.push("- 蒙版：`" + p.mask + "`");
    const pk = Object.keys(p.params || {});
    out.push("- 参数：" + (pk.length ? pk.map((k) => k + "=" + JSON.stringify(p.params[k])).join(" · ") : "默认"));
    out.push("");
    out.push("**用户提示词**：" + (p.prompt ? p.prompt : "（空，走内置模板）"));
    out.push("");
    out.push("**实际发送提示词**：");
    out.push("");
    out.push("```text");
    out.push(p.finalPrompt || "");
    out.push("```");
    out.push("");
  });
  return out.join("\n");
}

function toCsv(run) {
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const head = ["caseId", "caseTitle", "instance", "model", "modelLabel", "rep", "status",
    "mode", "latencyMs", "width", "height", "aspectError", "outsideChange", "diffRatio",
    "blankScore", "alphaRatio", "hasAlpha", "checksPass", "checks", "cost", "error"];
  const modelLabel = {};
  run.models.forEach((m) => { modelLabel[m.id] = m.label || m.id; });
  const caseTitle = {};
  run.cases.forEach((c) => { caseTitle[c.id] = c.title; });
  const rows = run.results.map((r) => [
    r.caseId, caseTitle[r.caseId] || "", r.instance || "", r.model, modelLabel[r.model] || "",
    r.rep, r.status, r.mode,
    r.latencyMs, r.width, r.height,
    r.aspectError == null ? "" : (r.aspectError * 100).toFixed(2) + "%",
    r.outsideChange == null ? "" : r.outsideChange.toFixed(2),
    r.diffRatio == null ? "" : r.diffRatio.toFixed(2),
    r.blankScore == null ? "" : r.blankScore.toFixed(2),
    r.alphaRatio == null ? "" : (r.alphaRatio * 100).toFixed(1) + "%",
    r.hasAlpha == null ? "" : (r.hasAlpha ? "yes" : "no"),
    r.checksPass == null ? "" : (r.checksPass ? "PASS" : "FAIL"),
    (r.checks || []).map((c) => c.name + "=" + (c.pass ? "PASS" : "FAIL") + "(" + c.detail + ")").join("; "),
    r.cost == null ? "" : r.cost,
    r.error || ""
  ]);
  return "\uFEFF" + [head].concat(rows).map((row) => row.map(esc).join(",")).join("\n") + "\n";
}

async function pool(tasks, limit, fn) {
  let i = 0;
  const workers = new Array(Math.min(limit, tasks.length)).fill(0).map(async () => {
    while (i < tasks.length) {
      const idx = i++;
      await fn(tasks[idx], idx);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const args = parseArgs(process.argv);
  const plugin = loadPlugin(PLUGIN_DIR);
  const loaded = loadCases({
    ids: args.cases || "all",
    /* 提示词文件已自带筛选结果，默认不再按 edit 过滤 */
    category: args.category || (args.prompts ? null : "edit"),
    includeDisabled: !!args["all-cases"],
    promptsFile: args.prompts || null,
    forceReTemplate: !!args.retemplate
  });
  const cases = loaded.list;
  if (loaded.promptsMeta && loaded.promptsMeta.retemplated) {
    console.log("检测到 " + loaded.promptsMeta.retemplated + " 条 prompt 被修改：按当前插件模板重新生成 finalPrompt");
  }

  if (args.list) {
    console.log("用例（默认只跑 category=edit 且 enabled!=false）：");
    for (const c of loaded.all) {
      const flags = (c.category || "edit") + (c.enabled === false ? " · 已关闭" : "");
      console.log("  " + c.id.padEnd(22) + c.title.padEnd(24) + "[" + flags + "]");
    }
    if (loaded.promptsMeta) {
      console.log("\n提示词文件：" + loaded.promptsMeta.source +
        "（" + loaded.all.length + " 条，来源运行 " + (loaded.promptsMeta.runId || "?") + "）");
    }
    console.log("\n当前筛选：" + cases.length + " 个（category=" + (args.category || "edit") + "）");
    console.log("\n插件模型目录（" + plugin.IMAGE_MODEL_PRESETS.length + "）：");
    for (const m of plugin.IMAGE_MODEL_PRESETS) console.log("  " + m.id.padEnd(28) + (m.label || ""));

    const listCfg = args.config || path.join(HERE, "config.json");
    if (fs.existsSync(listCfg)) {
      const raw = readJson(listCfg);
      const ms = raw.models || [];
      console.log("\nconfig.json 中可选的测试模型（--models 传序号或 id）：");
      ms.forEach((m, i) => {
        const p = (raw.providers || {})[m.provider] || {};
        const env = p.apiKeyEnv || (m.provider + "_API_KEY").toUpperCase();
        const ready = !!(process.env[env] || p.apiKey);
        console.log("  " + (i + 1) + ") " + String(m.id).padEnd(26) + (m.label || "") +
          "  [" + (ready ? "Key 就绪" : "缺 " + env) + "]");
      });
    } else {
      console.log("\n未找到 config.json：先执行 npm run init（或复制 config.example.json）。");
    }
    return;
  }

  if (!cases.length) {
    console.error("没有匹配的用例（category=" + (args.category || "edit") + "）。用 --list 查看。");
    process.exit(1);
  }

  const mock = !!args.mock;
  let cfg;
  if (mock) {
    cfg = {
      mode: "mock",
      concurrency: 2,
      timeoutSec: 30,
      providers: {},
      models: [
        { id: "mock-good", provider: "mock", label: "Mock 好模型", pricePerImage: 0.2, apiKey: "mock" },
        { id: "mock-bad-weak", provider: "mock", label: "Mock 差模型", pricePerImage: 0.05, apiKey: "mock" }
      ]
    };
  } else {
    const file = args.config || path.join(HERE, "config.json");
    if (!fs.existsSync(file)) {
      console.error("缺少配置文件：" + file + "\n先复制 bench/config.example.json 为 bench/config.json 并填 Key 环境变量名。");
      process.exit(1);
    }
    cfg = loadConfig(file);
  }

  let models;
  let modelSpec = args.models;
  /* 用提示词文件复测时，默认沿用当时的模型组合（--models 可覆盖） */
  if (!modelSpec && !mock && loaded.promptsMeta && loaded.promptsMeta.models && loaded.promptsMeta.models.length) {
    modelSpec = loaded.promptsMeta.models.join(",");
    console.log("复测模型：沿用提示词文件中的 " + loaded.promptsMeta.models.length + " 个模型");
  }
  try {
    models = pickModels(cfg.models, modelSpec);
  } catch (e) {
    console.error(e.message);
    console.error("可选模型：\n" + cfg.models.map((m, i) => "  " + (i + 1) + ") " + m.id).join("\n"));
    process.exit(1);
  }
  if (!models.length) { console.error("没有匹配的模型"); process.exit(1); }

  const repeat = Math.max(1, parseInt(args.repeat || "1", 10));
  const concurrency = Math.max(1, parseInt(args.concurrency || cfg.concurrency || 2, 10));
  const timeoutMs = Math.max(30, parseInt(args.timeoutSec || cfg.timeoutSec || 300, 10)) * 1000;

  if (args["dry-run"]) {
    const est = models.reduce((s, m) => s + (m.pricePerImage || 0) * cases.length * repeat, 0);
    console.log("将要运行（dry-run，不发请求）：");
    console.log("  用例 " + cases.length + " 个 × 模型 " + models.length + " 个 × 重复 " + repeat + " = " + (cases.length * models.length * repeat) + " 次请求");
    console.log("  模型：" + models.map((m) => m.label || m.id).join("、"));
    console.log("  预估成本：¥" + est.toFixed(2) + (est === 0 ? "（未配置 pricePerImage）" : ""));
    console.log("\n  用例清单：");
    for (const c of cases) console.log("    - " + c.id.padEnd(22) + c.title + "  [" + c.instance + "]");
    return;
  }

  /* 开跑前先确认素材齐全：不要在创建目录、甚至发请求之后才发现缺文件 */
  const missingFiles = [];
  for (const c of cases) {
    const paths = (c.images || (c.input ? [c.input] : [])).concat(c.mask ? [c.mask] : []);
    paths.forEach((p) => {
      if (!fs.existsSync(path.resolve(HERE, p))) missingFiles.push("  " + c.id + "：" + p);
    });
  }
  if (missingFiles.length) {
    console.error("输入素材缺失：\n" + missingFiles.join("\n") + "\n先执行 npm run assets 生成固定素材。");
    process.exit(1);
  }

  const runId = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const outDir = path.resolve(args.out || path.join(HERE, "out", runId));
  const imgDir = path.join(outDir, "images");
  fs.mkdirSync(imgDir, { recursive: true });
  const inputs = createInputArchiver(outDir);
  let pluginVersion = "";
  try { pluginVersion = readJson(path.join(PLUGIN_DIR, "manifest.json")).version || ""; } catch (e) { /* ignore */ }

  console.log("用例 " + cases.length + " · 模型 " + models.length + " · 重复 " + repeat + " · 并发 " + concurrency);
  console.log("输出：" + outDir);

  /* —— 预检 + 归档输入：素材缺失在开跑前就报错，不浪费请求 —— */
  const inputRefsByCase = {};
  const missing = [];
  for (const c of cases) {
    try {
      const paths = c.images || (c.input ? [c.input] : []);
      inputRefsByCase[c.id] = {
        images: paths.map((p) => inputs.archive(path.resolve(HERE, p), "image")),
        mask: c.mask ? inputs.archive(path.resolve(HERE, c.mask), "mask") : null
      };
    } catch (e) {
      missing.push("  " + c.id + "：" + e.message);
    }
  }
  if (missing.length) {
    console.error("输入素材预检失败：\n" + missing.join("\n") + "\n先执行 npm run assets 生成固定素材。");
    process.exit(1);
  }

  /* 用例与配置快照先落盘：即使中途崩溃，也知道"当时测了什么、用什么测的" */
  fs.writeFileSync(path.join(outDir, "cases.json"), JSON.stringify(cases.map((c) => c), null, 2));
  fs.writeFileSync(path.join(outDir, "config.snapshot.json"), JSON.stringify(redactConfig(cfg, models), null, 2));

  const tasks = [];
  for (const c of cases) for (const m of models) for (let r = 1; r <= repeat; r++) tasks.push({ c, m, r });

  const results = [];
  let done = 0;
  await pool(tasks, concurrency, async ({ c, m, r }) => {
    const inst = plugin.instById(c.instance);
    const item = {
      caseId: c.id, instance: c.instance, model: m.id, rep: r, status: "fail",
      latencyMs: null, error: null, image: null,
      width: null, height: null, hasAlpha: null, blankScore: null,
      outsideChange: null, diffRatio: null, aspectError: null, checks: [],
      prompt: "", promptChars: 0, mode: null, cost: m.pricePerImage || null,
      inputFiles: [], maskFile: null, size: null, quality: null,
      endpoint: null, httpStatus: null, errorBody: null
    };
    try {
      if (!inst) throw new Error("注册表中不存在实例：" + c.instance);

      const built = buildRequest(plugin, inst, c.prompt || "", c.params || {}, c.extra || null);
      /* 提示词文件复测：直接使用保存的最终提示词，避免模板变更导致“测的不是上次那版” */
      if (c._finalPrompt) built.prompt = c._finalPrompt;
      item.prompt = built.prompt;
      item.promptChars = built.prompt.length;
      item.params = built.params;
      item.size = built.params.size || null;
      item.quality = built.params.quality || null;

      const refs = inputRefsByCase[c.id] || { images: [], mask: null };
      item.inputFiles = refs.images.slice();
      item.maskFile = refs.mask;
      const inputBufs = refs.images.map((p) => fs.readFileSync(path.join(outDir, p)));
      const maskBuf = refs.mask ? fs.readFileSync(path.join(outDir, refs.mask)) : null;
      const uris = inputBufs.map(dataUri);

      item.mode = modeFor(plugin, inst, m.id, inputBufs.length > 0, !!maskBuf);
      let outBuf;
      if (mock) {
        const g = mockGenerate({ modelId: m.id, caseDef: c, inputBuf: inputBufs[0] || null, maskBuf: maskBuf, rep: r });
        outBuf = g.buffer;
        item.latencyMs = g.latencyMs + Math.round(Math.random() * 400);
      } else {
        if (!m.apiKey) throw new Error("缺少 API Key（环境变量 " + (m._envKey || "?") + "）");
        const provider = cfg.providers[m.provider];
        if (!provider) throw new Error("未知 provider：" + m.provider);
        const res = await callModel(plugin, provider, m, {
          mode: item.mode,
          prompt: built.prompt,
          images: uris,
          maskUri: maskBuf ? dataUri(maskBuf) : null,
          size: built.params.size,
          quality: built.params.quality,
          transparent: !!built.params.transparent,
          aspectRatio: built.params.size
        }, timeoutMs);
        outBuf = res.buffer;
        item.latencyMs = res.latencyMs;
        item.endpoint = (res.meta && res.meta.endpoint) || null;
      }

      const file = safeName(c.id) + "__" + safeName(m.id) + "__r" + r + ".png";
      fs.writeFileSync(path.join(imgDir, file), outBuf);
      item.image = "images/" + file;
      item.status = "ok";

      const info = imageInfo(outBuf);
      item.width = info.width; item.height = info.height; item.hasAlpha = info.hasAlpha;
      const png = decode(outBuf);
      item.blankScore = blankScore(png);
      item.alphaRatio = alphaRatio(png);

      const firstInput = inputBufs[0] ? decode(inputBufs[0]) : null;
      if (firstInput) {
        item.diffRatio = diffRatio(firstInput, outBuf);
        if (maskBuf) item.outsideChange = outsideChange(firstInput, outBuf, decode(maskBuf));
        const exp = c.expected && c.expected.aspectFromFirstImage ? (firstInput.width / firstInput.height) : null;
        item.aspectError = aspectError(item.width, item.height, exp);
      } else if (c.expected && c.expected.aspect) {
        item.aspectError = aspectError(item.width, item.height, c.expected.aspect);
      }

      /* 硬性检查：满足才算"这张可用"，避免只看平均分 */
      const exp = c.expected || {};
      if (exp.aspect || exp.aspectFromFirstImage) {
        item.checks.push({ name: "画幅", pass: item.aspectError != null && item.aspectError <= 0.03, detail: item.aspectError == null ? "-" : (item.aspectError * 100).toFixed(1) + "%" });
      }
      if (exp.maxOutsideChange != null && item.outsideChange != null) {
        item.checks.push({ name: "框外≤" + exp.maxOutsideChange + "%", pass: item.outsideChange <= exp.maxOutsideChange, detail: item.outsideChange.toFixed(1) + "%" });
      }
      if (exp.alpha != null) {
        item.checks.push({ name: "透明通道", pass: item.hasAlpha === exp.alpha, detail: item.hasAlpha ? "有" : "无" });
      }
      item.checksPass = item.checks.length ? item.checks.every((x) => x.pass) : null;
    } catch (e) {
      item.error = (e && e.message) || String(e);
      item.httpStatus = e && e.httpStatus != null ? e.httpStatus : null;
      item.errorBody = e && e.body ? String(e.body).slice(0, 4000) : null;
      if (e && e.endpoint) item.endpoint = e.endpoint;
    }
    results.push(item);
    done++;
    const tag = item.status === "ok" ? "OK " : "ERR";
    console.log("[" + done + "/" + tasks.length + "] " + tag + " " + c.id + " · " + m.id +
      (item.latencyMs ? " · " + Math.round(item.latencyMs / 1000) + "s" : "") +
      (item.error ? " · " + item.error : ""));
    if (item.outsideChange != null) console.log("        框外变化 " + item.outsideChange.toFixed(1) + "%");
  });

  /* 汇总：给插件/手册用的模型画像 */
  const profile = {
    generatedAt: new Date().toISOString(),
    runId: runId,
    models: models.map((m) => {
      const rs = results.filter((x) => x.model === m.id);
      const ok = rs.filter((x) => x.status === "ok");
      const outs = ok.map((x) => x.outsideChange).filter((v) => v != null);
      return {
        id: m.id, label: m.label, provider: m.provider,
        successRate: rs.length ? ok.length / rs.length : null,
        p50LatencyMs: median(ok.map((x) => x.latencyMs).filter(Boolean)),
        avgOutsideChange: outs.length ? outs.reduce((a, b) => a + b, 0) / outs.length : null,
        cases: rs.reduce((acc, x) => { acc[x.caseId] = x.status; return acc; }, {})
      };
    })
  };

  /* 提示词文件：给"看/改/复测"用的稳定快照（与模型无关） */
  const prompts = cases.map((c) => {
    const r = results.filter((x) => x.caseId === c.id)[0] || null;
    const refs = inputRefsByCase[c.id] || { images: [], mask: null };
    return {
      id: c.id,
      title: c.title,
      category: c.category || "edit",
      instance: c.instance,
      prompt: c.prompt || "",
      promptHash: sha256(c.prompt || "").slice(0, 16),
      finalPrompt: r ? r.prompt : (c._finalPrompt || ""),
      params: (r && r.params) ? r.params : (c.params || {}),
      images: refs.images,
      mask: refs.mask,
      extra: c.extra || undefined
    };
  });

  const redacted = redactConfig(cfg, models);
  const run = {
    id: runId, startedAt: new Date().toISOString(), mode: mock ? "mock" : "live",
    pluginVersion: pluginVersion,
    repeat: repeat, concurrency: concurrency,
    models: models.map((m) => ({ id: m.id, label: m.label, provider: m.provider, pricePerImage: m.pricePerImage || null })),
    providers: redacted.providers,
    cases: cases.map((c) => ({ id: c.id, title: c.title, instance: c.instance, category: c.category || "edit" })),
    inputs: inputs.index,
    results: results
  };

  fs.writeFileSync(path.join(outDir, "inputs", "manifest.json"), JSON.stringify({
    runId: runId,
    note: "本次运行实际发送的输入文件副本；sha256 可用于确认多次运行使用的是同一份素材",
    files: inputs.index
  }, null, 2));
  fs.writeFileSync(path.join(outDir, "run.json"), JSON.stringify(run, null, 2));
  fs.writeFileSync(path.join(outDir, "report.html"), buildReport(run));
  fs.writeFileSync(path.join(outDir, "model-profile.json"), JSON.stringify(profile, null, 2));
  fs.writeFileSync(path.join(outDir, "results.csv"), toCsv(run));

  const promptsFile = {
    runId: runId,
    generatedAt: new Date().toISOString(),
    pluginVersion: pluginVersion,
    mode: mock ? "mock" : "live",
    note: "改 prompt 后按当前插件模板重生成提示词；改 finalPrompt 则原样发送。运行：node run.mjs --prompts <本文件>；不传 --models 时沿用 models 列表。images/mask 相对本文件所在目录。",
    models: models.map((m) => m.id),
    prompts: prompts
  };
  fs.writeFileSync(path.join(outDir, "prompts.json"), JSON.stringify(promptsFile, null, 2));
  fs.writeFileSync(path.join(outDir, "prompts.md"), toPromptsMd(prompts, { runId: runId }));

  const totalCost = results.reduce((s, r) => s + (r.cost || 0), 0);
  const okForReadme = results.filter((r) => r.status === "ok").length;
  const readme = [
    "模型基准测试 · 运行记录",
    "=".repeat(40),
    "运行编号：" + runId,
    "时间：" + new Date().toLocaleString("zh-CN"),
    "模式：" + (mock ? "mock（离线自检，结果图非真实模型输出）" : "live（真实 API 调用）"),
    "插件版本：v" + (pluginVersion || "?"),
    "用例：" + cases.length + " 个 · 模型：" + models.length + " 个 · 重复：" + repeat + " 次",
    "请求结果：" + okForReadme + "/" + results.length + " 成功 · 估算成本 ¥" + totalCost.toFixed(2),
    "",
    "目录说明",
    "-".repeat(40),
    "inputs/                本次实际发送的输入图片与蒙版（可直接复用的原件副本）",
    "inputs/manifest.json   输入清单：来源路径、sha256、字节数",
    "images/                模型返回的结果图，命名 = 用例__模型__第N次.png",
    "cases.json             本次使用的完整用例定义（提示词模板参数、期望指标）",
    "config.snapshot.json   服务商地址与模型清单（已剔除 API Key）",
    "run.json               完整结果：每个请求的提示词、参数、耗时、指标、错误原文",
    "results.csv            汇总表（Excel 可直接打开，UTF-8 BOM）",
    "prompts.json           提示词文件（可编辑：prompt / finalPrompt）",
    "prompts.md             提示词全文（便于阅读与写手册）",
    "report.html            可视化报告（双击打开）",
    "model-profile.json     模型画像（供插件/手册引用）",
    "",
    "一键复测",
    "-".repeat(40),
    "node run.mjs --prompts \"" + path.join(outDir, "prompts.json") + "\"",
    "（不传 --models 时沿用本次的模型组合；加 --repeat 2 可多跑几轮）",
    "",
    "复现命令",
    "-".repeat(40),
    "node run.mjs --config config.json --cases " + cases.map((c) => c.id).join(",") +
      " --models " + models.map((m) => m.id).join(",") + " --repeat " + repeat,
    "",
    "说明：config.snapshot.json 与 run.json 均不包含密钥；密钥只从环境变量读取。",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "README.txt"), readme);
  fs.writeFileSync(path.join(HERE, "out", "latest.txt"), outDir + "\n");

  const okCount = results.filter((r) => r.status === "ok").length;
  console.log("\n完成：" + okCount + "/" + results.length + " 成功 · 估算成本 ¥" + totalCost.toFixed(2));
  console.log("输入副本：" + path.join(outDir, "inputs") + "（" + Object.keys(inputs.index).length + " 个文件）");
  console.log("结果图：" + imgDir);
  console.log("提示词：" + path.join(outDir, "prompts.json") + "（改完可一键复测）");
  console.log("汇总表：" + path.join(outDir, "results.csv"));
  console.log("报告：" + path.join(outDir, "report.html"));
  if (!hasPixelMetrics) console.log("提示：未安装 pngjs，已跳过像素类指标（在 bench/ 下执行 npm i）");
}

main().catch((e) => {
  console.error("运行失败：" + (e && e.stack || e));
  process.exit(1);
});

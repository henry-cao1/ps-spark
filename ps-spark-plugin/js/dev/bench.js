/*
 * bench.js — 开发者基准测试（P3，仅开发构建加载）
 *
 * 一个用例 = 冻结的输入（input.png）+ 冻结的提示词 + 一套参数。
 * 数据目录：<PluginData>/dev/bench/
 *   index.json                 用例索引
 *   cases/<caseId>/
 *     case.json                功能/分支/提示词/哈希/参数/基准 runId
 *     input.png                冻结画面
 *     runs/<runId>/
 *       output.png             结果图（失败时无）
 *       meta.json              模型/耗时/尺寸/字节/错误原文
 *
 * 设计约束：
 *   1. 只用插件已有的请求通道（callApi / callUnifiedGenerate），与正式功能同源；
 *   2. 失败也落 meta，不中断同批复测；
 *   3. 所有图片读写都走 UXP File API，不依赖 canvas；
 *   4. 本文件不进入发布构建（js/dev 被排除）。
 */
(function () {
  "use strict";
  if ("__DEV_CHANNEL__" === "false") return;

  var SCHEMA = 1;
  var KEY_LAST_CASE = "psspark.dev.bench.lastCase";
  var KEY_MODELS = "psspark.dev.bench.models";

  var state = {
    index: [],
    caseId: null,
    caseData: null,
    runs: [],
    inputUri: null,
    busy: false,
    active: 0,
    stopFlag: false,
    onChange: null,
    onStatus: null,
    inited: false
  };

  var cmp = { el: null, runId: null, mode: "side" };
  /* 当前用例的输入素材 data URI 缓存（input / mask / assets） */
  var fileCache = { caseId: null, inputUri: null, maskUri: null, assetUris: [] };

  /* ---------------- 基础工具 ---------------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function nowIso() { return new Date().toISOString(); }

  function newId(prefix) {
    return prefix + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);
  }

  function hashStr(s) {
    var h = 2166136261;
    var str = String(s == null ? "" : s);
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function b64ToBytes(b64) {
    var table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    var idx = {};
    for (var i = 0; i < table.length; i++) idx[table[i]] = i;
    var clean = String(b64 || "").replace(/[^A-Za-z0-9+/=]/g, "");
    var out = [];
    for (var j = 0; j + 3 < clean.length; j += 4) {
      var c0 = idx[clean[j]], c1 = idx[clean[j + 1]], c2 = idx[clean[j + 2]], c3 = idx[clean[j + 3]];
      if (c0 == null || c1 == null) break;
      out.push((c0 << 2) | (c1 >> 4));
      if (c2 != null && clean[j + 2] !== "=") out.push(((c1 & 15) << 4) | (c2 >> 2));
      if (c3 != null && clean[j + 3] !== "=") out.push(((c2 & 3) << 6) | c3);
    }
    return new Uint8Array(out);
  }

  /* PNG / JPEG / WebP 尺寸（PS 导出的 data URI 实际是 JPEG，不能只按 PNG 解析） */
  function pngSizeFromBytes(buf) {
    try {
      var b = new Uint8Array(buf);
      if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
        var w = ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0;
        var h = ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0;
        return (w && h) ? { w: w, h: h } : null;
      }
      if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
        var i = 2;
        while (i + 9 < b.length) {
          if (b[i] !== 0xff) { i++; continue; }
          var marker = b[i + 1];
          if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
          var len = (b[i + 2] << 8) | b[i + 3];
          if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            var jh = (b[i + 5] << 8) | b[i + 6];
            var jw = (b[i + 7] << 8) | b[i + 8];
            return (jw && jh) ? { w: jw, h: jh } : null;
          }
          i += 2 + len;
        }
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function dataUriMime(uri) {
    var m = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(String(uri || ""));
    return m ? m[1].toLowerCase() : "image/png";
  }

  function dataUriExt(uri) {
    var mime = dataUriMime(uri);
    if (mime === "image/jpeg") return "jpg";
    if (mime === "image/webp") return "webp";
    return "png";
  }

  function dataUriMeta(uri) {
    var b64 = String(uri || "").split(",")[1] || "";
    var head = b64ToBytes(b64.slice(0, 65536));
    var p = pngSizeFromBytes(head.buffer);
    return { w: p ? p.w : null, h: p ? p.h : null, bytes: Math.round(b64.length * 3 / 4) };
  }

  function fmtDuration(ms) {
    if (ms == null || isNaN(ms)) return "—";
    if (ms < 1000) return Math.round(ms) + "ms";
    return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
  }

  function fmtDate(iso) {
    try {
      var d = new Date(iso);
      var p = function (n) { return (n < 10 ? "0" : "") + n; };
      return (d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    } catch (e) { return String(iso || ""); }
  }

  function setStatus(text, cls) {
    if (state.onStatus) {
      try { state.onStatus(text, cls || ""); } catch (e) { /* ignore */ }
    }
  }

  function notify() {
    if (state.onChange) {
      try { state.onChange(); } catch (e) { /* ignore */ }
    }
  }

  /* ---------------- 文件层 ---------------- */

  async function ensureFolder(parent, name) {
    try {
      var f = await parent.getEntry(name);
      if (f && f.isFolder) return f;
    } catch (e) { /* not exists */ }
    return await parent.createFolder(name);
  }

  async function benchRoot() {
    var data = await fs.getDataFolder();
    var dev = await ensureFolder(data, "dev");
    return await ensureFolder(dev, "bench");
  }

  async function casesRoot() {
    return await ensureFolder(await benchRoot(), "cases");
  }

  async function caseFolder(id) {
    if (!id) return null;
    try {
      var c = await casesRoot();
      return await c.getEntry(id);
    } catch (e) { return null; }
  }

  async function writeJson(folder, name, obj) {
    var f = await folder.createFile(name, { overwrite: true });
    await f.write(JSON.stringify(obj, null, 1), { format: formats.utf8 });
  }

  async function readJson(folder, name) {
    try {
      var f = await folder.getEntry(name);
      var txt = await f.read({ format: formats.utf8 });
      return JSON.parse(txt);
    } catch (e) { return null; }
  }

  async function writeImage(folder, base, uri) {
    var b64 = String(uri || "").split(",")[1] || "";
    var bytes = b64ToBytes(b64);
    var buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    var name = base + "." + dataUriExt(uri);
    var f = await folder.createFile(name, { overwrite: true });
    await f.write(buf, { format: formats.binary });
    return { name: name, bytes: bytes.byteLength };
  }

  async function removeTree(node) {
    try {
      if (node.isFolder) {
        var items = await node.getEntries();
        for (var i = 0; i < items.length; i++) await removeTree(items[i]);
      }
      await node.delete();
    } catch (e) { /* ignore */ }
  }

  function plainMeta(r) {
    var o = {};
    Object.keys(r).forEach(function (k) {
      if (k.charAt(0) === "_") return;
      o[k] = r[k];
    });
    return o;
  }

  /* ---------------- 索引与用例 ---------------- */

  async function saveIndex() {
    try {
      var root = await benchRoot();
      var f = await root.createFile("index.json", { overwrite: true });
      await f.write(JSON.stringify(state.index, null, 1), { format: formats.utf8 });
    } catch (e) { /* ignore */ }
  }

  /* 并发复测时 index.json 不能同时写：串成一条队列 */
  var indexChain = Promise.resolve();
  function queueSaveIndex() {
    indexChain = indexChain.then(function () { return saveIndex(); }).catch(function () { /* ignore */ });
    return indexChain;
  }

  async function loadIndex() {
    state.index = [];
    try {
      var root = await benchRoot();
      var f = await root.getEntry("index.json");
      var arr = JSON.parse(await f.read({ format: formats.utf8 }));
      if (Array.isArray(arr)) state.index = arr;
    } catch (e) { /* 首次使用没有索引 */ }
    return state.index;
  }

  function upsertIndex(c) {
    var i = -1;
    for (var k = 0; k < state.index.length; k++) if (state.index[k].id === c.id) { i = k; break; }
    var old = i >= 0 ? state.index[i] : null;
    var entry = {
      id: c.id,
      title: c.title,
      instId: c.instId,
      instName: c.instName,
      branch: c.branch,
      branchLabel: c.branchLabel,
      createdAt: c.createdAt,
      promptHash: c.promptHash,
      baselineRunId: c.baselineRunId || null,
      runCount: old ? old.runCount : 0,
      lastRunAt: old ? old.lastRunAt : null
    };
    if (i >= 0) state.index[i] = entry; else state.index.unshift(entry);
  }

  async function createCase(input) {
    var id = newId("c");
    var root = await casesRoot();
    var folder = await ensureFolder(root, id);
    var meta = dataUriMeta(input.dataUri);

    var inputFile = await writeImage(folder, "input", input.dataUri);
    var maskName = null;
    if (input.maskUri) {
      var mf = await writeImage(folder, "mask", input.maskUri);
      maskName = mf.name;
    }
    var assetNames = [];
    if (input.assets && input.assets.length) {
      var ad = await ensureFolder(folder, "assets");
      for (var i = 0; i < input.assets.length && i < 4; i++) {
        var af = await writeImage(ad, "asset_" + (i + 1), input.assets[i]);
        assetNames.push(af.name);
      }
    }

    var caseData = {
      schema: SCHEMA,
      id: id,
      instId: input.instId,
      instName: input.instName,
      branch: input.branchId,
      branchLabel: input.branchLabel,
      title: input.instName + (input.branchLabel ? " · " + input.branchLabel : ""),
      createdAt: nowIso(),
      prompt: input.prompt || "",
      promptHash: hashStr(input.prompt || ""),
      params: input.params || {},
      source: { kind: "canvas", width: meta.w, height: meta.h, bytes: meta.bytes },
      inputHash: hashStr(input.dataUri || ""),
      userText: input.userText || "",
      inputs: { input: inputFile.name, mask: maskName, assets: assetNames },
      warnings: input.warnings || [],
      baselineRunId: null
    };

    await writeJson(folder, "case.json", caseData);

    state.caseId = id;
    state.caseData = caseData;
    state.runs = [];
    fileCache = {
      caseId: id,
      inputUri: input.dataUri,
      maskUri: input.maskUri || null,
      assetUris: (input.assets || []).slice(0, 4)
    };
    upsertIndex(caseData);
    await saveIndex();
    try { localStorage.setItem(KEY_LAST_CASE, id); } catch (e) { /* ignore */ }
    notify();
    return caseData;
  }

  async function loadRuns(folder) {
    var out = [];
    try {
      var rd = await folder.getEntry("runs");
      var items = await rd.getEntries();
      for (var i = 0; i < items.length; i++) {
        if (!items[i].isFolder) continue;
        var m = await readJson(items[i], "meta.json");
        if (!m) continue;
        m._folder = items[i];
        out.push(m);
      }
    } catch (e) { /* 还没有 runs 目录 */ }
    out.sort(function (a, b) {
      return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
    });
    return out;
  }

  async function selectCase(id) {
    /* 运行中不允许切用例：runOne 依赖当前用例的目录与提示词 */
    if (state.busy) return state.caseData;
    state.caseId = id || null;
    state.caseData = null;
    state.runs = [];
    fileCache = { caseId: null, inputUri: null, maskUri: null, assetUris: [] };
    if (!id) { notify(); return null; }
    var folder = await caseFolder(id);
    if (!folder) {
      state.caseId = null;
      try { localStorage.removeItem(KEY_LAST_CASE); } catch (e) { /* ignore */ }
      notify();
      return null;
    }
    state.caseData = await readJson(folder, "case.json");
    if (!state.caseData) {
      state.caseId = null;
      try { localStorage.removeItem(KEY_LAST_CASE); } catch (e) { /* ignore */ }
      notify();
      return null;
    }
    state.runs = await loadRuns(folder);
    try { localStorage.setItem(KEY_LAST_CASE, id); } catch (e) { /* ignore */ }
    notify();
    return state.caseData;
  }

  async function deleteCase(id) {
    if (state.busy) return;
    var folder = await caseFolder(id);
    if (folder) await removeTree(folder);
    state.index = state.index.filter(function (e) { return e.id !== id; });
    await saveIndex();
    if (state.caseId === id) {
      state.caseId = null;
      state.caseData = null;
      state.runs = [];
      fileCache = { caseId: null, inputUri: null, maskUri: null, assetUris: [] };
    }
    notify();
  }

  /* 清除全部基准数据（设置页「清除开发数据」调用） */
  async function clearAll() {
    try {
      var data = await fs.getDataFolder();
      var dev = await data.getEntry("dev");
      var bench = await dev.getEntry("bench");
      await removeTree(bench);
    } catch (e) { /* 目录本来就不存在 */ }
    state.index = [];
    state.caseId = null;
    state.caseData = null;
    state.runs = [];
    fileCache = { caseId: null, inputUri: null, maskUri: null, assetUris: [] };
    cmp.runId = null;
    try { localStorage.removeItem(KEY_LAST_CASE); } catch (e2) { /* ignore */ }
    notify();
  }

  function updateIndexAfterRun(meta) {
    var e = null;
    for (var i = 0; i < state.index.length; i++) if (state.index[i].id === state.caseId) { e = state.index[i]; break; }
    if (!e) return;
    e.runCount = (e.runCount || 0) + (meta.status === "ok" ? 1 : 0);
    e.lastRunAt = meta.createdAt;
    e.baselineRunId = state.caseData ? state.caseData.baselineRunId : null;
  }

  /* ---------------- 运行 ---------------- */

  async function entryByName(folder, names) {
    for (var i = 0; i < names.length; i++) {
      try {
        var f = await folder.getEntry(names[i]);
        if (f) return f;
      } catch (e) { /* next */ }
    }
    return null;
  }

  /* 读取当前用例的 input / mask / assets（缓存；切换用例时失效） */
  async function loadCaseFiles() {
    if (fileCache.caseId === state.caseId && fileCache.inputUri) return fileCache;
    var folder = await caseFolder(state.caseId);
    if (!folder) throw new Error("用例目录不可用");
    var c = state.caseData || {};
    var ins = c.inputs || {};

    var inputEntry = await entryByName(folder,
      ins.input ? [ins.input] : ["input.png", "input.jpg", "input.jpeg", "input.webp"]);
    if (!inputEntry) throw new Error("用例缺少输入图");

    var maskEntry = await entryByName(folder,
      ins.mask ? [ins.mask] : ["mask.png", "mask.jpg", "mask.jpeg"]);

    var assetNames = ins.assets || [];
    var assetUris = [];
    var ad = null;
    try { ad = await folder.getEntry("assets"); } catch (e) { ad = null; }
    if (ad) {
      var items = await ad.getEntries();
      for (var i = 0; i < items.length; i++) {
        if (items[i].isFolder) continue;
        if (assetNames.length && assetNames.indexOf(items[i].name) < 0) continue;
        if (!/\.(png|jpg|jpeg|webp)$/i.test(items[i].name)) continue;
        assetUris.push(await fileToDataURI(items[i]));
        if (assetUris.length >= 4) break;
      }
    }

    fileCache = {
      caseId: state.caseId,
      inputUri: await fileToDataURI(inputEntry),
      maskUri: maskEntry ? await fileToDataURI(maskEntry) : null,
      assetUris: assetUris
    };
    return fileCache;
  }

  function modeFor(inst, model) {
    if (typeof isNanoModel === "function" && isNanoModel(model)) return "unified";
    if (inst && inst.domain === "gen") return "generations";
    return "edits";
  }

  async function requestModel(inst, model, prompt, files, params) {
    var p = params || {};
    var images = [files.inputUri].concat(files.assetUris || []);
    var mode = modeFor(inst, model);

    if (mode === "unified") {
      /* nano 族：统一端点，不传 mask（与插件一致，靠提示词/色框定位） */
      var u = await callUnifiedGenerate(buildUnifiedPayload(model, prompt, images, { params: p }, null));
      return u.url;
    }

    if (mode === "generations") {
      var gp = {
        model: model,
        prompt: prompt,
        size: normalizeSizeForModel(model, p.size || "auto"),
        quality: normalizeQualityForModel(model, p.quality || "auto"),
        image: images
      };
      if (p.transparent) gp.Background = "transparent";
      var gr = await callApi("/v1/images/generations", gp, false);
      return gr.url;
    }

    var payload = {
      model: model,
      prompt: prompt,
      size: normalizeSizeForModel(model, p.size || "auto"),
      quality: normalizeQualityForModel(model, p.quality || "auto")
    };
    if (p.transparent) payload.background = "transparent";
    payload.image = files.inputUri;
    if (files.maskUri) payload.mask = files.maskUri;
    var r = await callApi("/v1/images/edits", payload, true);
    return r.url;
  }

  async function runOne(model, opts) {
    opts = opts || {};
    if (!state.caseData) throw new Error("请先创建或选择用例");
    if (state.busy) throw new Error("已有任务在运行");

    var folder = await caseFolder(state.caseId);
    if (!folder) throw new Error("用例目录不可用");
    var runsDir = await ensureFolder(folder, "runs");
    var runId = newId("r");
    var runFolder = await ensureFolder(runsDir, runId);

    var meta = {
      runId: runId,
      model: model,
      status: "running",
      isBaseline: false,
      createdAt: nowIso(),
      latencyMs: 0,
      width: null,
      height: null,
      bytes: 0,
      rating: null,
      note: "",
      error: null
    };
    await writeJson(runFolder, "meta.json", meta);

    state.active = (state.active || 0) + 1;
    state.busy = true;
    notify();
    var t0 = Date.now();
    try {
      var files = await loadCaseFiles();
      var inst = instById(state.caseData.instId);
      setStatus("正在请求 " + model + " …");
      var url = await requestModel(inst, model, state.caseData.prompt, files, state.caseData.params);
      if (state.stopFlag) throw new Error("已停止");

      setStatus("正在下载 " + model + " 的结果…");
      var res = await xhrRequest({ method: "GET", url: url, responseType: "arraybuffer", timeout: 180000 });
      if (res.status !== 200) throw new Error("下载结果失败 HTTP " + res.status);
      var bytes = res.response;
      var size = pngSizeFromBytes(bytes);
      meta.bytes = (bytes && bytes.byteLength) ? bytes.byteLength : 0;
      meta.width = size ? size.w : null;
      meta.height = size ? size.h : null;

      var out = await runFolder.createFile("output.png", { overwrite: true });
      await out.write(bytes, { format: formats.binary });
      meta.status = "ok";

      /* 首个成功结果自动成为基准；之后手动切换 */
      if (!state.caseData.baselineRunId) {
        state.caseData.baselineRunId = runId;
        meta.isBaseline = true;
        await writeJson(folder, "case.json", state.caseData);
      }
    } catch (e) {
      meta.status = "error";
      meta.error = (e && e.message) || String(e);
    }

    meta.latencyMs = Date.now() - t0;
    try { await writeJson(runFolder, "meta.json", meta); } catch (e) { /* 落盘失败不阻塞结果展示 */ }
    meta._folder = runFolder;
    state.runs.push(meta);
    updateIndexAfterRun(meta);
    await queueSaveIndex();
    state.active = Math.max(0, (state.active || 1) - 1);
    state.busy = state.active > 0;
    setStatus(meta.status === "ok" ? (model + " 完成 · " + fmtDuration(meta.latencyMs)) : (model + " 失败：" + meta.error),
      meta.status === "ok" ? "ok" : "err");
    notify();
    return meta;
  }

  async function runMany(models) {
    var list = (models || []).filter(Boolean);
    if (!list.length) throw new Error("请至少勾选一个模型");
    if (state.busy) throw new Error("已有任务在运行");
    state.stopFlag = false;
    var out = [];
    var doneCount = 0;
    var total = list.length;

    async function one(m) {
      if (state.stopFlag) return;
      setStatus("复测中 " + (doneCount + 1) + "/" + total + "：" + m + " …");
      try {
        out.push(await runOne(m, {}));
      } catch (e) {
        out.push({ model: m, status: "error", error: (e && e.message) || String(e) });
      }
      doneCount++;
      setStatus("复测 " + doneCount + "/" + total + " 完成", "ok");
    }

    /* API 模型并发；本地预设串行（同一台机器/显存，不能并发） */
    var isLocal = (typeof isComfyModel === "function")
      ? function (m) { return isComfyModel(m); }
      : function (m) { return String(m).toLowerCase() === "comfy"; };
    var comfy = list.filter(isLocal);
    var api = list.filter(function (m) { return !isLocal(m); });
    var limit = Math.max(1, Math.min(getConcurrency(), api.length || 1));

    async function apiPool() {
      var next = 0;
      var workers = [];
      for (var w = 0; w < Math.min(limit, api.length); w++) {
        workers.push((async function () {
          for (;;) {
            var i = next++;
            if (i >= api.length || state.stopFlag) return;
            await one(api[i]);
          }
        })());
      }
      await Promise.all(workers);
    }

    async function comfySerial() {
      for (var i = 0; i < comfy.length; i++) {
        if (state.stopFlag) return;
        await one(comfy[i]);
      }
    }

    await Promise.all([apiPool(), comfySerial()]);
    setStatus(state.stopFlag ? "已停止复测" : "复测完成 · " + out.length + " 个模型", state.stopFlag ? "" : "ok");
    return out;
  }

  function stop() {
    state.stopFlag = true;
    try { abortAllRequests(); } catch (e) { /* ignore */ }
    setStatus("正在停止…", "");
  }

  async function setBaseline(runId) {
    if (!state.caseData) return;
    var folder = await caseFolder(state.caseId);
    if (!folder) return;
    state.caseData.baselineRunId = runId;
    await writeJson(folder, "case.json", state.caseData);
    for (var i = 0; i < state.runs.length; i++) {
      var r = state.runs[i];
      r.isBaseline = r.runId === runId;
      if (r._folder) await writeJson(r._folder, "meta.json", plainMeta(r));
    }
    notify();
  }

  /* 人工评分与备注：只改 meta.json，不动结果图 */
  async function updateRunMeta(runId, patch) {
    var r = findRun(runId);
    if (!r || !r._folder) return;
    Object.keys(patch).forEach(function (k) { r[k] = patch[k]; });
    await writeJson(r._folder, "meta.json", plainMeta(r));
    notify();
  }

  function setRating(runId, rating) {
    return updateRunMeta(runId, { rating: Math.max(0, Math.min(5, rating || 0)) });
  }

  function setNote(runId, note) {
    return updateRunMeta(runId, { note: String(note || "").slice(0, 200) });
  }

  /* ---------------- 缩略图 / 对比 ---------------- */

  async function thumbFor(run) {
    if (!run) return "";
    if (run._uri) return run._uri;
    if (run.status !== "ok" || !run._folder) return "";
    try {
      var f = await run._folder.getEntry("output.png");
      run._uri = await fileToDataURI(f);
      return run._uri;
    } catch (e) { return ""; }
  }

  function injectCompareStyle() {
    if (document.getElementById("bStyle")) return;
    var st = document.createElement("style");
    st.id = "bStyle";
    st.textContent = [
      ".bc-wrap{position:absolute;top:0;left:0;right:0;bottom:0;z-index:45;background:var(--bg);display:flex;flex-direction:column;overflow:hidden;}",
      ".bc-head{display:flex;align-items:center;padding:8px;border-bottom:1px solid var(--border);flex-shrink:0;overflow:hidden;}",
      ".bc-head button{height:28px;padding:0 9px;margin-right:5px;border-radius:5px;border:1px solid var(--border);background:var(--panel);color:var(--text);font:inherit;font-size:11px;cursor:pointer;}",
      ".bc-head button.on{background:var(--accent);border-color:var(--accent);color:#fff;}",
      ".bc-title{font-size:12px;font-weight:600;margin-right:auto;white-space:nowrap;}",
      ".bc-body{flex:1;min-height:0;display:flex;padding:6px;overflow:hidden;}",
      ".bc-pane{flex:1 1 0%;min-width:0;display:flex;flex-direction:column;padding:0 3px;overflow:hidden;}",
      ".bc-imgwrap{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:var(--panel2);border:1px solid var(--border);border-radius:5px;}",
      ".bc-imgwrap img{display:block;}",
      ".bc-cap{flex-shrink:0;padding:5px 2px 0;font-size:10px;line-height:1.5;color:var(--dim);word-break:break-all;}",
      ".bc-cap b{color:var(--text);font-weight:600;}",
      ".bc-foot{flex-shrink:0;padding:6px 10px 8px;border-top:1px solid var(--border);font-size:10px;line-height:1.6;color:var(--dim);word-break:break-all;}",
      ".bc-foot .err{color:var(--err);}",
      ".bc-rate{display:flex;align-items:center;margin-top:4px;}",
      ".bc-rate-label{margin-right:6px;}",
      ".bc-star{width:22px;height:22px;margin-right:2px;padding:0;border:1px solid var(--border);border-radius:4px;background:var(--panel);color:var(--dim);font-size:13px;line-height:1;cursor:pointer;}",
      ".bc-star.on{color:#e8c87a;border-color:#6b5320;background:#3a2f16;}",
      ".bc-note{display:block;width:100%;height:26px;min-height:26px;margin-top:4px;padding:3px 6px;background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:4px;font:inherit;font-size:10px;outline:none;user-select:text;}",
      ".bc-empty{flex:1;display:flex;align-items:center;justify-content:center;color:var(--dim);font-size:11px;}"
    ].join("\n");
    document.head.appendChild(st);
  }

  function findRun(id) {
    for (var i = 0; i < state.runs.length; i++) if (state.runs[i].runId === id) return state.runs[i];
    return null;
  }

  function baselineRun() {
    var bl = null;
    for (var i = 0; i < state.runs.length; i++) {
      if (state.runs[i].isBaseline) { bl = state.runs[i]; break; }
    }
    if (!bl) {
      for (var j = state.runs.length - 1; j >= 0; j--) {
        if (state.runs[j].status === "ok") { bl = state.runs[j]; break; }
      }
    }
    return bl;
  }

  function fitCompareImages() {
    if (!document.getElementById("bcWrap")) return;
    var pairs = [
      { wrap: "bcWrapA", img: "bcImgA", run: cmp.runId ? findRun(cmp.runId) : null },
      { wrap: "bcWrapB", img: "bcImgB", run: baselineRun() }
    ];
    pairs.forEach(function (p) {
      var wrap = document.getElementById(p.wrap);
      var img = document.getElementById(p.img);
      if (!wrap || !img || !p.run || p.run.width == null) return;
      var aw = wrap.clientWidth - 12, ah = wrap.clientHeight - 12;
      if (aw <= 0 || ah <= 0) return;
      var s = Math.min(aw / p.run.width, ah / p.run.height);
      img.style.width = Math.max(1, Math.round(p.run.width * s)) + "px";
      img.style.height = Math.max(1, Math.round(p.run.height * s)) + "px";
    });
  }

  async function fillCompare() {
    var run = cmp.runId ? findRun(cmp.runId) : null;
    var base = baselineRun();
    var setPane = async function (imgId, capId, r, label) {
      var img = document.getElementById(imgId);
      var cap = document.getElementById(capId);
      if (!img || !cap) return;
      if (!r) {
        img.removeAttribute("src");
        img.style.width = "0px";
        img.style.height = "0px";
        cap.textContent = label + "：无";
        return;
      }
      var uri = await thumbFor(r);
      if (uri) img.src = uri;
      cap.textContent = label + " · " + r.model + " · " + fmtDuration(r.latencyMs) +
        (r.width ? " · " + r.width + "×" + r.height : "") +
        (r.status === "ok" ? "" : " · 失败");
      if (r.status !== "ok" && r.error) cap.title = r.error;
    };
    await setPane("bcImgA", "bcCapA", run, "当前");
    await setPane("bcImgB", "bcCapB", base, "基准");
    var foot = document.getElementById("bcFoot");
    if (foot) {
      foot.innerHTML = "";
      if (run && run.status !== "ok") {
        foot.appendChild(el("div", "err", "当前结果失败：" + (run.error || "未知错误")));
      }
      if (run) {
        foot.appendChild(el("div", null,
          "模型 " + run.model + " · 耗时 " + fmtDuration(run.latencyMs) +
          " · 尺寸 " + (run.width ? run.width + "×" + run.height : "—") +
          " · 体积 " + (run.bytes ? Math.round(run.bytes / 1024) + " KB" : "—") +
          " · " + fmtDate(run.createdAt)));
      }
      if (base && run && base.runId !== run.runId) {
        var delta = run.latencyMs - base.latencyMs;
        foot.appendChild(el("div", null,
          "对比基准 " + base.model + "：耗时 " + (delta >= 0 ? "+" : "") + fmtDuration(Math.abs(delta)) +
          (run.width && base.width && run.width !== base.width ? " · 尺寸不一致" : " · 尺寸一致")));
      }
      if (run && run.status === "ok") {
        var rate = el("div", "bc-rate");
        rate.appendChild(el("span", "bc-rate-label", "评分"));
        for (var i = 1; i <= 5; i++) {
          (function (n) {
            var b = el("button", "bc-star" + ((run.rating || 0) >= n ? " on" : ""), "★");
            b.type = "button";
            b.addEventListener("click", function () {
              setRating(run.runId, run.rating === n ? 0 : n).then(function () { fillCompare(); });
            });
            rate.appendChild(b);
          })(i);
        }
        foot.appendChild(rate);

        var note = document.createElement("input");
        note.type = "text";
        note.className = "bc-note";
        note.placeholder = "备注（离开输入框后保存）";
        note.value = run.note || "";
        note.addEventListener("change", function () { setNote(run.runId, note.value); });
        foot.appendChild(note);
      }
    }
    setTimeout(fitCompareImages, 30);
  }

  function setCompareMode(mode) {
    cmp.mode = mode;
    var a = document.getElementById("bcPaneA");
    var b = document.getElementById("bcPaneB");
    if (a) a.classList.remove("hidden");
    if (b) b.classList.toggle("hidden", mode === "single");
    var bs = document.getElementById("bcModeSide");
    var bc = document.getElementById("bcModeSingle");
    if (bs) bs.classList.toggle("on", mode === "side");
    if (bc) bc.classList.toggle("on", mode === "single");
    setTimeout(fitCompareImages, 30);
  }

  function openCompare(runId) {
    injectCompareStyle();
    cmp.runId = runId || null;
    var old = document.getElementById("bcWrap");
    if (old) old.parentNode.removeChild(old);

    var wrap = el("div", "bc-wrap");
    wrap.id = "bcWrap";
    wrap.innerHTML =
      '<div class="bc-head">' +
      '  <button id="bcBack" type="button">‹ 返回</button>' +
      '  <span class="bc-title">结果对比</span>' +
      '  <button id="bcModeSide" type="button" class="on">并排</button>' +
      '  <button id="bcModeSingle" type="button">单图</button>' +
      "</div>" +
      '<div class="bc-body">' +
      '  <div class="bc-pane" id="bcPaneA"><div class="bc-imgwrap" id="bcWrapA"><img id="bcImgA" alt=""></div><div class="bc-cap" id="bcCapA"></div></div>' +
      '  <div class="bc-pane" id="bcPaneB"><div class="bc-imgwrap" id="bcWrapB"><img id="bcImgB" alt=""></div><div class="bc-cap" id="bcCapB"></div></div>' +
      "</div>" +
      '<div class="bc-foot" id="bcFoot"></div>';
    document.body.appendChild(wrap);
    cmp.el = wrap;

    document.getElementById("bcBack").addEventListener("click", closeCompare);
    document.getElementById("bcModeSide").addEventListener("click", function () { setCompareMode("side"); });
    document.getElementById("bcModeSingle").addEventListener("click", function () { setCompareMode("single"); });
    setCompareMode("side");
    fillCompare();
  }

  function closeCompare() {
    var w = document.getElementById("bcWrap");
    if (w && w.parentNode) w.parentNode.removeChild(w);
    cmp.el = null;
    cmp.runId = null;
  }

  /* ---------------- 对外接口 ---------------- */

  async function init(opts) {
    opts = opts || {};
    state.onChange = opts.onChange || null;
    state.onStatus = opts.onStatus || null;
    if (state.inited) return state;
    state.inited = true;
    await loadIndex();
    var last = null;
    try { last = localStorage.getItem(KEY_LAST_CASE); } catch (e) { /* ignore */ }
    if (last) await selectCase(last);
    notify();
    return state;
  }

  function modelsToRetest() {
    try {
      var raw = localStorage.getItem(KEY_MODELS);
      if (raw) {
        var arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr;
      }
    } catch (e) { /* ignore */ }
    return [];
  }

  function saveModelsToRetest(list) {
    try { localStorage.setItem(KEY_MODELS, JSON.stringify(list || [])); } catch (e) { /* ignore */ }
  }

  window.Bench = {
    init: init,
    state: state,
    index: function () { return state.index; },
    current: function () { return state.caseData; },
    runs: function () { return state.runs; },
    runIdOf: function () { return state.caseId; },
    busy: function () { return state.busy; },
    newCase: createCase,
    selectCase: selectCase,
    deleteCase: deleteCase,
    clearAll: clearAll,
    runOne: runOne,
    runMany: runMany,
    stop: stop,
    setBaseline: setBaseline,
    setRating: setRating,
    setNote: setNote,
    thumbFor: thumbFor,
    measure: dataUriMeta,
    openCompare: openCompare,
    closeCompare: closeCompare,
    modelsToRetest: modelsToRetest,
    saveModelsToRetest: saveModelsToRetest,
    refresh: async function () {
      await loadIndex();
      if (state.caseId) await selectCase(state.caseId);
      notify();
    },
    baselineRun: baselineRun
  };
})();

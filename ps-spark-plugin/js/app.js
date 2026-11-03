/*
 * app.js — 路由 / 视图渲染 / 设置中心 / 运行执行器（W2：注册表驱动）
 * W0：4 Tab 骨架 + 设置覆盖层进出
 * W1：设置中心实装（图像 / 文本双服务 · 模型分配 · 默认参数 · 诊断）
 * W2：生成域 / 编辑域由 registry.js 驱动渲染（ui.js 三闸门）；执行器统一路由
 *     generations（文生图/相似图/合成类）与 edits（选区重绘/修复类）
 */

let running = false;
let RUN_COUNT = 0;       /* 并发运行计数：running = RUN_COUNT > 0 */
let MANUAL_RUN = false;  /* 手动运行占位：队列任务要等它退出，队列任务之间互不等待 */
let RUN_SEQ = 0;         /* 单次运行的自增号（给任务日志/上下文用） */  /* 手动运行占位：队列任务要等它退出，队列任务之间互不等待 */
let lastRun = null;        /* { instId, snap, statusText, level, secs, layerName, thumbUri, exportUri } */
let lastLayerName = "";
/* 并发运行时，图层名/参考图必须写在本次 run 上，不能落到全局（否则两条任务互相覆盖） */
function setRunLayerName(ctx, name) {
  if (ctx && ctx.run) ctx.run.layerName = name;
  else lastLayerName = name;
}
/* 本地工作流轮询的取消探针：全局标志会被别的任务重置，这条按任务自己判断 */
function runAbortProbe(ctx) {
  const t = ctx && ctx.run && ctx.run.task;
  return t ? function () { return !!t.cancelled; } : null;
}
function setRunExportUri(ctx, uri) {
  if (ctx && ctx.run) ctx.run.exportUri = uri;
  else lastExportUri = uri;
}
let lastExportUri = null;  /* 本次运行发送给模型的参考图（data URI，含色框标记），供结果卡缩略图展示 */

function setRunning(v) {
  /* 引用计数：云端可以两路并发，running 必须等到最后一条结束才落回 false */
  const wasRunning = running;
  RUN_COUNT = Math.max(0, RUN_COUNT + (v ? 1 : -1));
  running = RUN_COUNT > 0;
  const host = currentHost();
  if (host) {
    const btn = host.querySelector(".run-btn");
    const cn = host.querySelector(".run-cancel");
    /* 队列模式下运行中也要能继续点「加入队列」，所以不禁用按钮 */
    if (btn) btn.disabled = false;
    if (cn) cn.style.display = running ? "block" : "none";
  }
  updateStatus(running ? (RUN_COUNT > 1 ? ("运行中…（" + RUN_COUNT + " 路）") : "运行中…") : "就绪");
  if (!running) {
    const h = currentHost(), i = currentInstance();
    if (h && i) UI.refreshRunBar(h, i);
  }
  /* 历史页的「插入为新图层」按运行状态置灰/解禁：
   * 开跑时要变灰（否则用户以为能点），跑完要恢复（否则得切页才解禁）。 */
  if (wasRunning !== running && App.tab === "history") {
    try { renderHistoryView(); } catch (e) { diag("history refresh warn: " + e.message); }
  }
}

const App = {
  tab: "gen", settingsReturn: null, hasImageKey: false,
  hasTextKey: null, /* null=未知 / true / false（提示词助手启用状态） */
  editGroup: "redraw", editInstance: "local_redraw",
  genInstance: "text2img",
  groupLast: { redraw: "local_redraw", repair: "hd_restore", creative: "colorize", struct: "cutout" },
  __poll: null
};

function updateStatus(text, level) {
  const dot = $("statusDot"), t = $("statusText");
  if (t) t.textContent = text;
  if (dot) dot.className = level || "";
}

function switchTab(name) {
  App.tab = name;
  document.querySelectorAll(".tab").forEach((el) => {
    el.classList.toggle("active", el.dataset.tab === name);
  });
  ["gen", "edit", "decomp", "history"].forEach((t) => {
    const v = $("view-" + t);
    if (v) v.classList.toggle("hidden", t !== name);
  });
  /* 一句话入口：仅生成/编辑域显示（拆图/历史域隐藏并收起） */
  const nl = $("nlBar");
  if (nl) {
    const showNl = (name === "gen" || name === "edit");
    nl.classList.toggle("hidden", !showNl);
    if (!showNl && NL.open) { NL.open = true; nlToggleBar(); }
  }
  const h = currentHost(), i = currentInstance();
  if (h && i) UI.refreshRunBar(h, i);
  UI.remeasureTextareas(h); /* 由隐藏变可见：把文本域高度从估算精修为实测 */
  if (name === "history") renderHistoryView();
  if (name === "decomp") renderDecompView();
  syncScrollGutter();
  if (typeof i18nFlush === "function") i18nFlush();
  diag("tab -> " + name);
}

/* ================= 视图渲染（注册表驱动） ================= */

function currentInstance() {
  if (App.tab === "gen") return instById(App.genInstance);
  if (App.tab === "edit") return instById(App.editInstance);
  return null;
}
function currentHost() {
  if (App.tab === "gen") return $("genHost");
  if (App.tab === "edit") return $("editHost");
  return null;
}

function renderGenView() {
  const chips = $("genChips");
  if (!chips) return;
  chips.innerHTML = "";
  const list = genInstances();
  if (!instById(App.genInstance) || instById(App.genInstance).domain !== "gen") App.genInstance = list[0].id;
  list.forEach(function (inst) {
    const c = el("div", "chip" + (inst.id === App.genInstance ? " active" : ""), inst.name);
    c.addEventListener("click", function () {
      App.genInstance = inst.id;
      renderGenView();
    });
    chips.appendChild(c);
  });
  UI.renderHost($("genHost"), instById(App.genInstance));
  refreshResultBlock();
  if (typeof i18nFlush === "function") i18nFlush();
}

function renderEditView() {
  const seg = $("editGroups");
  if (!seg) return;
  seg.innerHTML = "";
  EDIT_GROUP_META.forEach(function (g) {
    const s = el("div", "seg-item" + (g.id === App.editGroup ? " active" : ""), g.name);
    s.addEventListener("click", function () {
      if (App.editGroup === g.id) return;
      App.groupLast[App.editGroup] = App.editInstance;
      App.editGroup = g.id;
      const list = instancesOfGroup(g.id);
      App.editInstance = App.groupLast[g.id] && instById(App.groupLast[g.id]) ? App.groupLast[g.id] : (list[0] && list[0].id);
      renderEditView();
    });
    seg.appendChild(s);
  });

  const list = instancesOfGroup(App.editGroup);
  if (!list.length) return;
  if (!list.some(function (r) { return r.id === App.editInstance; })) App.editInstance = list[0].id;

  const chips = $("editChips");
  chips.innerHTML = "";
  list.forEach(function (inst) {
    const c = el("div", "chip" + (inst.id === App.editInstance ? " active" : ""), inst.name);
    c.addEventListener("click", function () {
      App.editInstance = inst.id;
      renderEditView();
    });
    chips.appendChild(c);
  });
  UI.renderHost($("editHost"), instById(App.editInstance));
  refreshResultBlock();
  if (typeof i18nFlush === "function") i18nFlush();
}

/* ================= 自然语言指令入口（一句话 → 自动定位功能） =================
 * 流程：用户输入一句话 → 文本模型（DeepSeek）从注册表功能清单中选择最合适的一项
 *      → 展示解析结果（功能 / 提示词 / 理由）→ 用户确认 → 切 Tab、选实例、预填提示词。
 * 不自动运行——用户检查提示词与选区后自行点运行（避免误触发付费请求）。 */
const NL = { open: false, busy: false, plan: null };

function nlSetStatus(text, level) {
  const s = $("nlStatus");
  if (!s) return;
  s.textContent = text || "";
  s.className = "nl-status" + (level ? " " + level : "");
}

function nlToggleBar() {
  const panel = $("nlPanel"), btn = $("nlToggle");
  NL.open = !NL.open;
  if (panel) panel.classList.toggle("hidden", !NL.open);
  if (btn) btn.classList.toggle("open", NL.open);
  if (NL.open) {
    const ta = $("nlInput");
    if (ta) {
      try { ta.focus(); } catch (e) { /* ignore */ }
      autoGrowTa(ta, 64, ta.value);
    }
    ensureVisibleInMain(btn);
  }
}

/* 功能清单（供意图解析；含拆图的虚拟条目 __decomp） */
function nlCatalog() {
  const rows = [];
  REGISTRY.forEach(function (r) {
    if (r.wip) return;
    rows.push({
      id: r.id, name: r.name, domain: r.domain,
      alias: r.alias || "",
      desc: r.desc || "",
      needSelection: r.selection === "required"
    });
  });
  rows.push({ id: "__decomp", name: "拆图", domain: "decomp", alias: "", desc: "把一张成品图拆分为多个可编辑图层（看图分析 → 蓝图 → 逐层提取）", needSelection: false });
  return rows;
}

function nlParseJson(text) {
  try {
    let s = String(text || "");
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    s = s.slice(a, b + 1);
    return JSON.parse(s);
  } catch (e) { return null; }
}

function nlShowPlan(p) {
  const plan = $("nlPlan"), cf = $("nlConfirm");
  if (!plan || !cf) return;
  plan.innerHTML = "";
  const inst = p.instanceId === "__decomp" ? null : instById(p.instanceId);
  const name = p.instanceId === "__decomp" ? "拆图" : ((inst && inst.name) || p.instanceId);
  const line1 = el("div");
  line1.appendChild(document.createTextNode("将使用："));
  line1.appendChild(el("b", null, name));
  if (inst && inst.selection === "required" && inst.noSelArea !== "canvas") line1.appendChild(document.createTextNode("（需要先框选区域）"));
  else if (inst && inst.selection === "required") line1.appendChild(document.createTextNode("（可框选局部，不选则整幅画面）"));
  else if (inst && inst.selection === "optional") line1.appendChild(document.createTextNode("（可选：框选后只处理选区）"));
  plan.appendChild(line1);
  if (p.userText) plan.appendChild(el("div", null, "提示词：" + p.userText));
  if (p.reason) plan.appendChild(el("div", "dim-note", "理由：" + p.reason));
  cf.classList.remove("hidden");
}

async function nlParse() {
  const ta = $("nlInput");
  const text = ((ta && ta.value) || "").trim();
  if (!text) { nlSetStatus("请先输入一句话，例如：把背景换成海边沙滩", "err"); return; }
  if (!IS_UXP) { nlSetStatus("浏览器预览无法调用文本服务，请在 Photoshop 面板中运行", "err"); return; }
  if (!App.hasTextKey) { nlSetStatus("未配置文本服务：请到 右上角 ⚙ 设置 ▸ 服务接入 ▸ 文本服务 填写 Key", "err"); return; }
  if (NL.busy) return;
  NL.busy = true;
  const btn = $("nlParse"), cf = $("nlConfirm");
  if (btn) btn.disabled = true;
  if (cf) cf.classList.add("hidden");
  nlSetStatus("正在解析…（文本请求 ×1）", "");
  try {
    const sys = "你是 Photoshop 插件的意图路由助手。用户会用一句话描述想做的事，请从下面的功能清单中选择最合适的一个功能，并整理出该功能的提示词（userText）。\n" +
      "功能清单（JSON）：\n" + JSON.stringify(nlCatalog()) + "\n" +
      "要求：\n" +
      "- instanceId：必须原样使用清单中的某个 id（如 erase、local_redraw、text2img、composite、__decomp…）。\n" +
      "- userText：把用户的话整理成该功能的提示词（如 erase 要移除什么 / text2img 要生成什么画面）；功能不需要提示词时留空字符串。\n" +
      "- reason：一句话说明为什么选这个功能（给用户看）。\n" +
      "- 只输出 JSON，不要输出任何其它文字或代码块标记。格式：{\"instanceId\":\"…\",\"userText\":\"…\",\"reason\":\"…\"}";
    const out = await callTextApi([
      { role: "system", content: sys },
      { role: "user", content: text }
    ], 60000);
    const parsed = nlParseJson(out);
    if (!parsed || !parsed.instanceId) throw new Error("解析结果无法识别，请换个说法或手动选择功能");
    if (parsed.instanceId !== "__decomp" && !instById(parsed.instanceId)) {
      throw new Error("模型选择了未知功能（" + parsed.instanceId + "），请换个说法");
    }
    NL.plan = parsed;
    nlShowPlan(parsed);
    nlSetStatus("解析完成——确认后点「用此功能」", "ok");
    diag("nl parse ok: " + parsed.instanceId);
  } catch (e) {
    diag("nl parse warn: " + ((e && e.stack) || String(e)));
    nlSetStatus("解析失败：" + ((e && e.message) || String(e)), "err");
  } finally {
    NL.busy = false;
    if (btn) btn.disabled = false;
  }
}

/* 按解析结果路由：切 Tab / 选实例 / 预填提示词（不自动运行） */
function nlApplyPlan() {
  const p = NL.plan;
  if (!p) { nlSetStatus("请先解析", "err"); return; }
  if (p.instanceId === "__decomp") {
    switchTab("decomp");
    nlSetStatus("已切到「拆图」Tab —— 点「✨ 智能分析画面」开始", "ok");
    if (NL.open) nlToggleBar();
    return;
  }
  const inst = instById(p.instanceId);
  if (!inst) { nlSetStatus("功能不存在：请重新解析", "err"); return; }
  if (inst.wip) { nlSetStatus(inst.wip, "err"); return; }

  if (inst.domain === "gen") {
    App.genInstance = inst.id;
    switchTab("gen");
    renderGenView();
  } else {
    App.groupLast[App.editGroup] = App.editInstance;
    App.editGroup = inst.group;
    App.editInstance = inst.id;
    switchTab("edit");
    renderEditView();
  }
  const st = getInstanceState(inst.id);
  if (p.userText) st.userText = String(p.userText);
  const host = currentHost(), cur = currentInstance();
  if (host && cur && cur.id === inst.id) {
    UI.renderHost(host, inst);
    UI.refreshRunBar(host, inst);
  }
  const m = $("main");
  if (m) m.scrollTop = 0;
  const need = inst.selection === "required" && inst.noSelArea !== "canvas";
  nlSetStatus("已定位到「" + inst.name + "」" + (need ? "（请先框选区域）" : "") + "——检查提示词后点运行", need ? "" : "ok");
  log("一句话已定位到：「" + inst.name + "」" + (need ? "（需要先在画面上框选区域）" : ""), need ? "" : "ok");
  if (NL.open) nlToggleBar();
}

function nlBindEvents() {
  const tg = $("nlToggle"), pa = $("nlParse"), cl = $("nlClose"), ap = $("nlApply"), ta = $("nlInput");
  if (tg) tg.addEventListener("click", function () { nlToggleBar(); });
  if (pa) pa.addEventListener("click", function () { nlParse(); });
  if (cl) cl.addEventListener("click", function () { if (NL.open) nlToggleBar(); });
  if (ap) ap.addEventListener("click", function () { nlApplyPlan(); });
  if (ta) {
    ta.addEventListener("input", function () { growOnTypeTa(ta, 64); });
    ta.addEventListener("change", function () { scheduleRefitTa(ta); });
  }
}

/* ================= 设置中心（W1，保持） ================= */

const IMG_BASE_PRESETS = ["https://grsai.dakka.com.cn", "https://grsaiapi.com"];
/* 文本模型预设 ID（能力标签/看图支持见 services.js 的 TEXT_MODEL_CATALOG 与 textModelVision()） */
const TXT_MODEL_PRESETS = textModelPresetIds();

/* 自绘下拉实例表（替代原生 select；UXP 原生 select 在滚动容器内会残留残影） */
const DROPDOWNS = {};

function initDropdown(id, options, value, onChange, opts) {
  const slot = $(id);
  if (!slot) return null;
  const dd = UI.makeDropdown(options, value, onChange, opts);
  slot.appendChild(dd.el);
  DROPDOWNS[id] = dd;
  return dd;
}

function initSettingsDropdowns() {
  initDropdown("imgBaseUrl", [
    ["https://grsai.dakka.com.cn", "国内 (dakka)"],
    ["https://grsaiapi.com", "全球 (grsaiapi)"],
    ["__custom__", "自定义…"]
  ], "https://grsai.dakka.com.cn", function (v) {
    const custom = v === "__custom__";
    $("imgBaseUrlCustom").classList.toggle("hidden", !custom);
    if (!custom) saveImageServiceFromForm(false);
  });

  /* 图像模型：下拉可选（gpt-image 系列，文档 2026-09 版）；尺寸/质量选项随模型联动 */
  initDropdown("imgModel", imgModelOptions(), "gpt-image-2.5", function (v) {
    const custom = v === "__custom__";
    $("imgModelCustom").classList.toggle("hidden", !custom);
    if (!custom) {
      saveImageServiceFromForm(false);
      refreshDefaultsDropdowns();
      rerenderCurrentDomain();
    }
  });

  /* 文本服务：区域（国内/国外）→ 语言模型（按厂商分组）→ 图片分析模型（仅看图模型） */
  renderTextRegionSeg();
  initDropdown("txtModel", txtModelOptionsForRegion(getTextService().region), getTextService().model, function (v) {
    onTextModelPicked(v);
  });
  initDropdown("txtVisionModel", txtVisionOptions(), getTextService().visionModel, function (v) {
    const custom = v === "__custom__";
    $("txtVisionCustom").classList.toggle("hidden", !custom);
    if (!custom) {
      saveTextServiceFromForm(true);
      refreshTextVisionNote();
      rerenderCurrentDomain();
    }
  });

  /* 默认参数 · 生成候选张数（默认 1 张，可调） */
  initDropdown("defVariants", [[1, "1 张（默认 · 单张）"], [2, "2 张"], [3, "3 张"], [4, "4 张"]], 1, saveDefaultsFromForm);

  /* 默认参数 · 并发请求数（拆图逐层 / 多候选，默认 3） */
  initDropdown("defConcurrency", [[1, "1（最稳）"], [2, "2"], [3, "3（默认）"], [4, "4"], [6, "6（最快）"]], 3, saveDefaultsFromForm);

  /* 模型分配（首项「跟随默认」= 不覆盖；高级用法） */
  initDropdown("mapGen", mapModelOptions("image", "跟随图像服务模型"), "", function (v) {
    const custom = v === "__custom__";
    $("mapGenCustom").classList.toggle("hidden", !custom);
    if (!custom) { saveMapFromForm(); rerenderCurrentDomain(); }
  });
  initDropdown("mapEdit", mapModelOptions("image", "跟随生成 / 图像服务"), "", function (v) {
    const custom = v === "__custom__";
    $("mapEditCustom").classList.toggle("hidden", !custom);
    if (!custom) { saveMapFromForm(); rerenderCurrentDomain(); }
  });
  initDropdown("mapText", mapModelOptions("text", "跟随文本服务"), "", function (v) {
    const custom = v === "__custom__";
    $("mapTextCustom").classList.toggle("hidden", !custom);
    if (!custom) saveMapFromForm();
  });

  /* 默认尺寸 / 质量：选项随「图像服务模型」联动（打开设置时与模型切换时重建） */
  refreshDefaultsDropdowns();
}

/* ---- 文本服务：区域 / 语言模型 / 图片分析模型（联动） ---- */

/* 语言模型选项：按厂商分组（vendors 顺序 = 目录顺序） */
function txtModelOptionsForRegion(region) {
  const opts = [];
  const list = textModelCatalogForRegion(region || "cn");
  const vendors = [];
  list.forEach(function (p) { if (vendors.indexOf(p.vendor) < 0) vendors.push(p.vendor); });
  vendors.forEach(function (v) {
    opts.push([null, v]);
    list.forEach(function (p) { if (p.vendor === v) opts.push([p.id, p.label]); });
  });
  if (!opts.length) opts.push([null, "（该区域暂无预设，请用「自定义…」）"]);
  opts.push(["__custom__", "自定义…"]);
  return opts;
}

/* 图片分析模型选项：跟随语言模型 + 全部「支持看图」的模型（按区域分组） */
function txtVisionOptions() {
  const opts = [[TEXT_FOLLOW_VISION, "跟随语言模型（其支持看图时）"]];
  TEXT_REGION_META.forEach(function (r) {
    const list = textVisionModelPresets().filter(function (p) { return p.region === r.id; });
    if (!list.length) return;
    opts.push([null, r.name]);
    list.forEach(function (p) { opts.push([p.id, p.label]); });
  });
  opts.push(["__custom__", "自定义…"]);
  return opts;
}

/* 某 Base URL 是否为目录中任一预设（用于「切模型时自动换地址」判定） */
function textModelBaseUrlForAny(u) {
  const s = String(u || "").trim().replace(/\/+$/, "");
  if (!s) return false;
  for (let i = 0; i < TEXT_MODEL_CATALOG.length; i++) {
    if (TEXT_MODEL_CATALOG[i].baseUrl.replace(/\/+$/, "") === s) return true;
  }
  return false;
}

function renderTextRegionSeg() {
  const seg = $("txtRegion");
  if (!seg) return;
  seg.innerHTML = "";
  const cur = getTextService().region;
  TEXT_REGION_META.forEach(function (r) {
    const s = el("div", "seg-item" + (r.id === cur ? " active" : ""), r.name);
    s.addEventListener("click", function () {
      if (getTextService().region === r.id) return;
      onTextRegionChange(r.id);
    });
    seg.appendChild(s);
  });
}

/* 切换区域：语言模型列表重建 + 默认选该区域第一个模型 + Base URL 跟随其厂商 */
function onTextRegionChange(region) {
  const svc = getTextService();
  const list = textModelCatalogForRegion(region);
  const first = list[0];
  const model = first ? first.id : svc.model;
  const baseUrl = first ? first.baseUrl : svc.baseUrl;
  saveTextService({ baseUrl: baseUrl, model: model, region: region, visionModel: TEXT_FOLLOW_VISION });
  $("txtBaseUrl").value = baseUrl;
  $("txtModelCustom").value = "";
  $("txtModelCustom").classList.add("hidden");
  rebuildDropdown("txtModel", txtModelOptionsForRegion(region), model, function (v) { onTextModelPicked(v); });
  fillSettingsForm();
  setStatusEl("txtStatus", "已切换到「" + (region === "cn" ? "国内" : "国外") + "」模型列表：默认 " + (first ? first.label : model) +
    "（记得检查 API Key 是否属于该平台）", "ok");
  diag("settings: text region -> " + region + " (" + model + ")");
}

/* 选择语言模型：自动填充厂商 Base URL + 刷新联动提示 */
function onTextModelPicked(v) {
  const custom = v === "__custom__";
  $("txtModelCustom").classList.toggle("hidden", !custom);
  if (custom) return;
  const p = textModelPreset(v);
  if (p) {
    const cur = ($("txtBaseUrl").value || "").trim();
    if (!cur || textModelBaseUrlForAny(cur)) $("txtBaseUrl").value = p.baseUrl; /* 地址为空或仍是预设 → 跟随厂商；用户手改过则保留 */
  }
  saveTextServiceFromForm(true);
  refreshTextVisionNote();
  rerenderCurrentDomain();   /* 语言模型能力（是否支持看图）影响拆图提示 */
}

/* 联动说明：语言模型支持看图 → 自动跟随；纯文本 → 上一次跑通的图片分析模型 */
function refreshTextVisionNote() {
  const note = $("txtVisionNote");
  if (!note) return;
  const svc = getTextService();
  const lv = textModelVision(svc.model);
  const vm = svc.visionModel || TEXT_FOLLOW_VISION;
  let txt;
  if (vm !== TEXT_FOLLOW_VISION) {
    txt = "已指定图片分析模型：" + vm + "（拆图看图固定用它）";
  } else if (lv === "yes") {
    txt = "语言模型 " + svc.model + " 支持看图 → 图片分析自动跟随（两者联动）";
  } else {
    const last = lastOkVisionModel();
    txt = "语言模型 " + svc.model + " 为纯文本 → 图片分析使用" +
      (last ? ("上一次跑通的模型 " + last) : ("默认模型 " + TEXT_DEFAULT_VISION_MODEL + "（尚无跑通记录）"));
  }
  txt += " · 当前生效：" + resolveVisionModel();
  note.textContent = txt;
}

/* ---- 下拉选项构造 ---- */

/* 图像模型选项行（含系列分组标题，便于在 16 个模型里定位） */
function imageModelOptionRows() {
  const rows = [];
  [["gpt", "gpt-image 系列"], ["nano", "nano-banana 系列"]].forEach(function (g) {
    const list = IMAGE_MODEL_PRESETS.filter(function (p) { return p.group === g[0]; });
    if (!list.length) return;
    rows.push([null, g[1]]);
    list.forEach(function (p) { rows.push([p.id, p.label]); });
  });
  IMAGE_MODEL_PRESETS.forEach(function (p) {   /* 未分组的预设兜底列出 */
    if (p.group !== "gpt" && p.group !== "nano") rows.push([p.id, p.label]);
  });
  return rows;
}

function imgModelOptions() {
  const opts = imageModelOptionRows();
  opts.push(["__custom__", "自定义…"]);
  return opts;
}

function mapModelOptions(kind, followLabel) {
  const opts = [["", followLabel]];
  if (kind === "text") {
    TEXT_MODEL_CATALOG.forEach(function (p) { opts.push([p.id, p.label]); });
  } else {
    imageModelOptionRows().forEach(function (r) { opts.push(r); });
  }
  opts.push(["__custom__", "自定义…"]);
  return opts;
}

/* ---- 下拉读写辅助 ---- */

function imgModelValue() {
  const v = DROPDOWNS.imgModel ? DROPDOWNS.imgModel.getValue() : "";
  if (v === "__custom__") return $("imgModelCustom").value.trim();
  return v;
}

function mapFieldValue(id) {
  const dd = DROPDOWNS[id];
  const v = dd ? dd.getValue() : "";
  if (v === "__custom__") return $(id + "Custom").value.trim();
  return v;
}

function rebuildDropdown(id, options, value, onChange, opts) {
  const slot = $(id);
  if (!slot) return null;
  slot.innerHTML = "";
  return initDropdown(id, options, value, onChange, opts);
}

/* 默认尺寸/质量选项随图像服务模型重建；越界遗留值仅作归一化显示，不主动改写存储。
 * 模型无质量档位（nano-banana 系列）→ 质量下拉置为禁用态提示。 */
function refreshDefaultsDropdowns() {
  const model = imgModelValue() || getImageService().model;
  const d = getDefaults();
  rebuildDropdown("defSize", sizeOptionsForModel(model), normalizeSizeForModel(model, d.size), saveDefaultsFromForm);
  const qo = qualityOptionsForModel(model);
  if (!qo.length) {
    rebuildDropdown("defQuality", [["", "该模型无质量档位"]], "", null, { disabled: true });
  } else {
    rebuildDropdown("defQuality", qo, normalizeQualityForModel(model, d.quality), saveDefaultsFromForm);
  }
}

/* 回填「模型分配」某行（空 = 跟随默认；预设 → 选中；其它 → 自定义输入框） */
function fillMapField(id, val) {
  const dd = DROPDOWNS[id];
  if (!dd) return;
  const custom = $(id + "Custom");
  const presets = (id === "mapText")
    ? TXT_MODEL_PRESETS
    : IMAGE_MODEL_PRESETS.map(function (p) { return p.id; });
  if (!val) {
    dd.setValue("");
    custom.value = "";
    custom.classList.add("hidden");
  } else if (presets.indexOf(val) >= 0) {
    dd.setValue(val);
    custom.value = "";
    custom.classList.add("hidden");
  } else {
    dd.setValue("__custom__");
    custom.value = val;
    custom.classList.remove("hidden");
  }
}

/* 模型变更后刷新当前功能域（运行条模型标签与参数可选项联动）。
 * ⚠ 设置覆盖层打开时必须跳过：UXP 对覆盖层下方内容的局部重绘不可靠，会把底层内容
 * 穿透绘制到覆盖层上（实测重叠鬼影）。底层已被 body.settings-open 隐藏（不参与绘制），
 * 且关闭设置时会统一重渲染，因此这里直接跳过即可，无需记账。 */
function doRerenderDomain() {
  try {
    if (App.tab === "gen") renderGenView();
    else if (App.tab === "edit") renderEditView();
    else if (App.tab === "decomp") renderDecompView();
    else if (App.tab === "history") renderHistoryView();
  } catch (e) { diag("rerenderDomain warn: " + e.message); }
}

function rerenderCurrentDomain() {
  const ov = $("settingsOverlay");
  if (ov && !ov.classList.contains("hidden")) {
    diag("rerenderDomain: skip（设置层打开中，关闭时统一重渲染）");
    return;
  }
  doRerenderDomain();
}

function setStatusEl(id, text, level) {
  const el2 = $(id);
  if (!el2) return;
  el2.textContent = text;
  el2.className = "status-line" + (level ? " " + level : "");
}

function currentImgBaseUrl() {
  const v = DROPDOWNS.imgBaseUrl ? DROPDOWNS.imgBaseUrl.getValue() : "";
  return v === "__custom__" ? $("imgBaseUrlCustom").value.trim() : v;
}
function currentTxtModel() {
  const v = DROPDOWNS.txtModel ? DROPDOWNS.txtModel.getValue() : "";
  return v === "__custom__" ? ($("txtModelCustom").value.trim() || DEFAULT_TEXT_SERVICE.model) : v;
}

/* ---- 表单 → 存储（自动保存，无显式保存按钮） ---- */

function saveImageServiceFromForm(silent) {
  const baseUrl = currentImgBaseUrl();
  if (!baseUrl) { setStatusEl("imgStatus", "请填写自定义 Base URL", "err"); return false; }
  saveImageService({ baseUrl: baseUrl, model: imgModelValue() || DEFAULT_IMAGE_SERVICE.model });
  diag("settings: image service saved -> " + baseUrl + " / " + imgModelValue());
  if (!silent) setStatusEl("imgStatus", "已自动保存", "ok");
  return true;
}

function saveTextServiceFromForm(silent) {
  const baseUrl = $("txtBaseUrl").value.trim();
  if (!baseUrl) { setStatusEl("txtStatus", "请填写 Base URL", "err"); return false; }
  const vv = DROPDOWNS.txtVisionModel ? DROPDOWNS.txtVisionModel.getValue() : TEXT_FOLLOW_VISION;
  const visionModel = (vv === "__custom__")
    ? ($("txtVisionCustom").value.trim() || TEXT_FOLLOW_VISION)
    : (vv || TEXT_FOLLOW_VISION);
  saveTextService({ baseUrl: baseUrl, model: currentTxtModel(), region: getTextService().region, visionModel: visionModel });
  diag("settings: text service saved -> " + baseUrl + " / " + currentTxtModel() + " / vision=" + visionModel);
  if (!silent) setStatusEl("txtStatus", "已自动保存", "ok");
  return true;
}

function saveMapFromForm() {
  saveModelMap({ gen: mapFieldValue("mapGen"), edit: mapFieldValue("mapEdit"), text: mapFieldValue("mapText") });
  setStatusEl("mapStatus", "已自动保存（「跟随默认」= 不覆盖）", "ok");
}

function saveDefaultsFromForm() {
  saveDefaults({
    size: DROPDOWNS.defSize ? DROPDOWNS.defSize.getValue() : "auto",
    quality: DROPDOWNS.defQuality ? DROPDOWNS.defQuality.getValue() : "auto",
    transparent: $("defTransparent").checked,
    clip: $("defClip").checked,
    variants: DROPDOWNS.defVariants ? (parseInt(DROPDOWNS.defVariants.getValue(), 10) || 1) : 1,
    concurrency: DROPDOWNS.defConcurrency ? (parseInt(DROPDOWNS.defConcurrency.getValue(), 10) || 3) : 3,
    smartObject: $("defSmartObject").checked
  });
  setStatusEl("defStatus", "已自动保存", "ok");
}

/* ---- 功能说明（从注册表动态生成：特点=desc · 开销=cost · 怎么用=HELP_HOW） ---- */

function renderHelpList() {
  const host = $("helpList");
  if (!host) return;
  host.innerHTML = "";
  const groups = [{ title: "生成域", list: genInstances() }];
  EDIT_GROUP_META.forEach(function (g) {
    groups.push({ title: "编辑域 · " + g.name, list: instancesOfGroup(g.id) });
  });
  groups.forEach(function (g) {
    if (!g.list.length) return;
    host.appendChild(el("div", "help-group", g.title));
    g.list.forEach(function (inst) {
      const item = el("div", "help-item");
      const head = el("div", "help-head");
      const main = el("div", "help-head-main");
      main.appendChild(el("span", "help-name", inst.name));
      main.appendChild(el("span", "help-chip", costBadge(inst)));
      if (inst.runLabel) main.appendChild(el("span", "help-chip", "按钮「" + inst.runLabel.replace(/\s+/g, "") + "」"));
      if (inst.selection === "required") {
        main.appendChild(el("span", "help-chip",
          inst.noSelArea === "canvas" ? "选区可选" : "需要选区"));
      }
      head.appendChild(main);

      /* 描述统一由「展开说明 / 收起说明」控制，每项不再单独折叠 */
      const body = el("div", "help-body");
      body.appendChild(el("div", "help-desc", "特点：" + (inst.desc || "")));
      const how = helpHowFor(inst);
      if (how) body.appendChild(el("div", "help-how", "怎么用：" + how));

      item.appendChild(head);
      item.appendChild(body);
      host.appendChild(item);
    });
  });
  if (typeof i18nFlush === "function") i18nFlush();
}

/* ---- 存储 → 表单（每次打开设置时刷新） ---- */

function fillSettingsForm() {
  const img = getImageService();
  const baseCustom = $("imgBaseUrlCustom");
  if (IMG_BASE_PRESETS.indexOf(img.baseUrl) >= 0) {
    if (DROPDOWNS.imgBaseUrl) DROPDOWNS.imgBaseUrl.setValue(img.baseUrl);
    baseCustom.classList.add("hidden");
    baseCustom.value = "";
  } else {
    if (DROPDOWNS.imgBaseUrl) DROPDOWNS.imgBaseUrl.setValue("__custom__");
    baseCustom.value = img.baseUrl;
    baseCustom.classList.remove("hidden");
  }
  /* 图像模型（预设 → 选中；不在预设 → 自定义输入框） */
  if (imgModelPreset(img.model)) {
    if (DROPDOWNS.imgModel) DROPDOWNS.imgModel.setValue(img.model);
    $("imgModelCustom").value = "";
    $("imgModelCustom").classList.add("hidden");
  } else {
    if (DROPDOWNS.imgModel) DROPDOWNS.imgModel.setValue("__custom__");
    $("imgModelCustom").value = img.model;
    $("imgModelCustom").classList.remove("hidden");
  }

  const txt = getTextService();
  /* 区域修正：模型属其它区域（如旧配置）→ 以模型为准 */
  const txtPreset = textModelPreset(txt.model);
  const txtRegion = txtPreset ? txtPreset.region : txt.region;
  if (txtRegion !== txt.region) {
    saveTextService({ baseUrl: txt.baseUrl, model: txt.model, region: txtRegion, visionModel: txt.visionModel });
  }
  renderTextRegionSeg();
  $("txtBaseUrl").value = txt.baseUrl;
  /* 语言模型下拉：按区域重建后回填（预设 → 选中；自定义 → 输入框） */
  if (DROPDOWNS.txtModel) {
    rebuildDropdown("txtModel", txtModelOptionsForRegion(txtRegion), txt.model, function (v) { onTextModelPicked(v); });
  }
  const inRegion = textModelCatalogForRegion(txtRegion).some(function (p) { return p.id === txt.model; });
  if (inRegion) {
    if (DROPDOWNS.txtModel) DROPDOWNS.txtModel.setValue(txt.model);
    $("txtModelCustom").classList.add("hidden");
    $("txtModelCustom").value = "";
  } else {
    if (DROPDOWNS.txtModel) DROPDOWNS.txtModel.setValue("__custom__");
    $("txtModelCustom").value = txt.model;
    $("txtModelCustom").classList.remove("hidden");
  }
  /* 图片分析模型：跟随 / 具体 vision 预设 / 自定义 */
  if (DROPDOWNS.txtVisionModel) {
    const vm = txt.visionModel || TEXT_FOLLOW_VISION;
    const vs = $("txtVisionCustom");
    if (vm === TEXT_FOLLOW_VISION) {
      DROPDOWNS.txtVisionModel.setValue(TEXT_FOLLOW_VISION);
      vs.value = ""; vs.classList.add("hidden");
    } else {
      const vp = textModelPreset(vm);
      if (vp && vp.vision) {
        DROPDOWNS.txtVisionModel.setValue(vm);
        vs.value = ""; vs.classList.add("hidden");
      } else {
        DROPDOWNS.txtVisionModel.setValue("__custom__");
        vs.value = vm; vs.classList.remove("hidden");
      }
    }
  }
  refreshTextVisionNote();

  const m = getModelMap();
  fillMapField("mapGen", m.gen);
  fillMapField("mapEdit", m.edit);
  fillMapField("mapText", m.text);

  /* 默认尺寸 / 质量：按当前图像服务模型重建选项（越界值归一化显示） */
  refreshDefaultsDropdowns();
  if (DROPDOWNS.defVariants) DROPDOWNS.defVariants.setValue(getDefaults().variants);
  if (DROPDOWNS.defConcurrency) DROPDOWNS.defConcurrency.setValue(getConcurrency());
  $("defTransparent").checked = getDefaults().transparent;
  $("defClip").checked = getDefaults().clip;
  $("defSmartObject").checked = getDefaults().smartObject;
  if ($("defOutpaintKeep")) $("defOutpaintKeep").checked = outpaintKeepOriginal();

  renderComfyForm();

  renderHelpList();

  initLangSetting();

  $("diagLog").checked = getDiagFlag();
  updateVersionInfo();
  if (typeof i18nFlush === "function") i18nFlush();
}

/* 版本信息行：语言切换后也要重写（拼接文案无法靠词典整句命中） */
function updateVersionInfo() {
  const el = $("versionInfo");
  if (!el) return;
  const brandName = (typeof BRAND !== "undefined" && BRAND.name) ? BRAND.name : "PS Spark";
  const brandVer = (typeof BRAND !== "undefined" && BRAND.version) ? BRAND.version : "";
  const brandLic = (typeof BRAND !== "undefined" && BRAND.license) ? BRAND.license : "AGPL-3.0";
  const brandRepo = (typeof brandRepoUrl === "function") ? brandRepoUrl() : "";
  const brandPub = (typeof brandIsPublic === "function") ? brandIsPublic() : false;
  const brandTr = (typeof t === "function") ? t : function (x) { return x; };
  el.textContent = brandName + (brandVer ? (" · v" + brandVer) : "") +
    " · " + brandTr("许可证") + " " + brandLic + " · " + brandTr("密钥与配置仅存于本机") + " · " +
    ((brandRepo && brandPub) ? brandTr("已开源") : brandTr("未开源"));
}

async function fillKeys() {
  try {
    const k = await getImageKey();
    if (k) {
      $("apiKey").value = k;
      setStatusEl("imgStatus", "已保存（" + maskKey(k) + "）");
    } else {
      $("apiKey").value = "";
      setStatusEl("imgStatus", "未配置 · 点「测试连接」可零成本鉴别 Key 有效性");
    }
  } catch (e) { diag("fillKeys(image) warn: " + e.message); }
  try {
    const k = await getTextKey();
    if (k) {
      $("txtApiKey").value = k;
      setStatusEl("txtStatus", "已保存（" + maskKey(k) + "）");
    } else {
      $("txtApiKey").value = "";
      setStatusEl("txtStatus", "未配置（可选）· 配置后可用提示词助手（v1.2 起用于拆图蓝图）");
    }
    App.hasTextKey = !!k;
  } catch (e) { diag("fillKeys(text) warn: " + e.message); }
}

/* ---- 连通性测试（零成本探测） ---- */

async function testImageService() {
  if (!IS_UXP) { setStatusEl("imgStatus", "请在 Photoshop 面板中测试（浏览器预览仅界面）", "err"); return; }
  const key = $("apiKey").value.trim() || (await getImageKey());
  if (!key) { setStatusEl("imgStatus", "请先填写 API Key", "err"); return; }
  if (!saveImageServiceFromForm(true)) return;
  await saveImageKey(key);
  lastSavedKey = key;
  updateGearBadge(true);
  const btn = $("btnTestImage");
  btn.disabled = true;
  setStatusEl("imgStatus", "测试中（零成本探测）…");
  try {
    const base = currentImgBaseUrl();
    log(`测试图像服务（节点 ${base}）...`);
    const res = await xhrRequest({
      method: "POST",
      url: base + "/v1/images/generations",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "__key_test__", prompt: "ping", size: "1024x1024" }),
      timeout: 60000
    });
    const text = typeof res.response === "string" ? res.response : "";
    diag("testImage resp HTTP " + res.status + ": " + text.slice(0, 300));
    const lower = text.toLowerCase();
    if (res.status === 200) {
      setStatusEl("imgStatus", "连接正常（HTTP 200）", "ok");
    } else if (lower.indexOf("apikey") >= 0 || lower.indexOf("api key") >= 0 || lower.indexOf("unauthorized") >= 0 || res.status === 401 || res.status === 403) {
      setStatusEl("imgStatus", `❌ Key 无效（HTTP ${res.status}）· 到后台核对 Key 或切换节点`, "err");
    } else {
      setStatusEl("imgStatus", `Key 可用 ✓（鉴权已通过，HTTP ${res.status} 为参数类响应）`, "ok");
    }
  } catch (e) {
    setStatusEl("imgStatus", "测试失败: " + e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

async function testTextService() {
  if (!IS_UXP) { setStatusEl("txtStatus", "请在 Photoshop 面板中测试（浏览器预览仅界面）", "err"); return; }
  const key = $("txtApiKey").value.trim() || (await getTextKey());
  if (!key) { setStatusEl("txtStatus", "请先填写文本服务 API Key（可选，v1.2 使用）", "err"); return; }
  if (!saveTextServiceFromForm(true)) return;
  await saveTextKey(key);
  const btn = $("btnTestText");
  btn.disabled = true;
  setStatusEl("txtStatus", "测试中…");
  try {
    const base = $("txtBaseUrl").value.trim().replace(/\/+$/, "");
    log(`测试文本服务（${base}）...`);
    const res = await xhrRequest({
      method: "GET",
      url: base + "/models",
      headers: { "Authorization": "Bearer " + key },
      timeout: 30000
    });
    const text = typeof res.response === "string" ? res.response : "";
    diag("testText resp HTTP " + res.status + ": " + text.slice(0, 300));
    if (res.status === 200) {
      let n = "";
      try {
        const j = JSON.parse(text);
        if (j && Array.isArray(j.data)) n = "，可用模型 " + j.data.length + " 个";
      } catch (e) { /* ignore */ }
      setStatusEl("txtStatus", "连接正常 ✓" + n, "ok");
    } else if (res.status === 401 || res.status === 403) {
      setStatusEl("txtStatus", `❌ Key 无效（HTTP ${res.status}）`, "err");
    } else {
      setStatusEl("txtStatus", `服务返回 HTTP ${res.status}（/models 接口可用性视平台而定）`, "err");
    }
  } catch (e) {
    setStatusEl("txtStatus", "测试失败: " + e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

/* ---- 本地 ComfyUI 设置（多预设：一台机器一条） ---- */

let COMFY_ACTIVE = "";
let COMFY_PRESET_DD = null, COMFY_ALPHA_DD = null, COMFY_WHOLE_DD = null;

/* 本地局部重绘方式（全局设置，不按预设存）：
 *   whole = 扩大区域整图重绘 + 蒙版合成（默认；不依赖工作流的蒙版/融合质量）
 *   mask  = 直接把选区蒙版交给工作流（工作流自带 inpaint 融合时用） */
const COMFY_WHOLE_KEY = "psspark.comfy.wholeRedraw";
const COMFY_WHOLE_OPTS = [
  ["whole", "整图重绘 + 蒙版合成（推荐：模型能力较弱时）"],
  ["mask", "工作流自带蒙版（原样）"]
];

function comfyWholeRedraw() {
  try {
    const v = localStorage.getItem(COMFY_WHOLE_KEY);
    return v == null ? true : v !== "0";
  } catch (e) { return true; }
}
function setComfyWholeRedraw(on) {
  try {
    if (on) localStorage.setItem(COMFY_WHOLE_KEY, "1");
    else localStorage.setItem(COMFY_WHOLE_KEY, "0");
  } catch (e) { /* ignore */ }
}

const COMFY_ALPHA_OPTS = [
  ["native", "支持透明通道（真 alpha）"],
  ["none", "不支持（拆图用纯色底 + 抠色）"],
  ["unknown", "未知（按不支持处理）"]
];

function comfyNumOrNull(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
}

function comfyActiveId() {
  const store = getComfyStore();
  if (!COMFY_ACTIVE || !getComfyPreset(COMFY_ACTIVE)) COMFY_ACTIVE = store.activeId;
  return COMFY_ACTIVE;
}

function renderComfyForm() {
  if (!$("comfyName")) return;
  const list = getComfyPresets();
  const id = comfyActiveId();
  const cur = getComfyPreset(id) || list[0];

  /* 预设下拉 */
  const opts = list.map(function (p) {
    const caps = (p.caps || []).map(function (c) {
      const hit = COMFY_CAPS.filter(function (x) { return x[0] === c; })[0];
      return hit ? hit[1] : c;
    });
    return [p.id, p.name + (caps.length ? "（" + caps.join("/") + "）" : "")];
  });
  const host = $("comfyPresetDD");
  host.innerHTML = "";
  COMFY_PRESET_DD = UI.makeDropdown(opts, id, function (v) {
    COMFY_ACTIVE = v;
    const s = getComfyStore(); s.activeId = v; saveComfyStore(s);
    renderComfyForm();
  });
  host.appendChild(COMFY_PRESET_DD.el);

  if (!cur) return;
  $("comfyName").value = cur.name;
  $("comfyUrl").value = cur.url;
  if ($("comfyUrlExtra")) $("comfyUrlExtra").value = (cur.urls || []).join("\n");
  $("comfyWorkflow").value = cur.workflow;
  $("comfyPromptNode").value = cur.roles.prompt || "";
  $("comfySteps").value = cur.overrides.steps == null ? "" : String(cur.overrides.steps);
  $("comfyCfg").value = cur.overrides.cfg == null ? "" : String(cur.overrides.cfg);
  $("comfyDenoise").value = cur.overrides.denoise == null ? "" : String(cur.overrides.denoise);

  /* 能力勾选 */
  const caps = $("comfyCaps");
  caps.innerHTML = "";
  COMFY_CAPS.forEach(function (c) {
    const lab = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.setAttribute("data-cap", c[0]);
    cb.checked = (cur.caps || []).indexOf(c[0]) >= 0;
    cb.addEventListener("change", function () {
      const p = collectComfyForm();
      upsertComfyPreset(p);
      rerenderCurrentDomain();
      renderComfyForm();
    });
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(c[1]));
    caps.appendChild(lab);
  });

  /* 透明通道 */
  const ah = $("comfyAlpha");
  ah.innerHTML = "";
  COMFY_ALPHA_DD = UI.makeDropdown(COMFY_ALPHA_OPTS, cur.alpha || "unknown", function (v) {
    const p = collectComfyForm();
    p.alpha = v;
    upsertComfyPreset(p);
  });
  ah.appendChild(COMFY_ALPHA_DD.el);

  /* 本地局部重绘方式（全局，不分预设） */
  const wh = $("comfyWhole");
  if (wh) {
    wh.innerHTML = "";
    COMFY_WHOLE_DD = UI.makeDropdown(COMFY_WHOLE_OPTS, comfyWholeRedraw() ? "whole" : "mask", function (v) {
      setComfyWholeRedraw(v !== "mask");
      diag("comfy: 局部重绘方式 -> " + v);
    });
    wh.appendChild(COMFY_WHOLE_DD.el);
  }

  const wfNodes = (function () {
    try { return Object.keys(JSON.parse(cur.workflow || "{}")).length; } catch (e) { return 0; }
  })();
  setStatusEl("comfyStatus", wfNodes ? (wfNodes + " 个节点 · 未测试连接") : "尚未导入工作流");
}

function comfyParseUrlLines(v) {
  return String(v || "").split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
}

function collectComfyForm() {
  const id = comfyActiveId();
  const prev = getComfyPreset(id) || {};
  const caps = [];
  $("comfyCaps").querySelectorAll("input[data-cap]").forEach(function (cb) {
    if (cb.checked) caps.push(cb.getAttribute("data-cap"));
  });
  return {
    id: id,
    name: $("comfyName").value.trim() || "本地模型",
    url: $("comfyUrl").value.trim() || DEFAULT_COMFY.url,
    urls: comfyParseUrlLines($("comfyUrlExtra") ? $("comfyUrlExtra").value : ""),
    workflow: $("comfyWorkflow").value,
    roles: Object.assign({}, prev.roles || {}, { prompt: $("comfyPromptNode").value.trim() }),
    overrides: {
      steps: comfyNumOrNull($("comfySteps").value),
      cfg: comfyNumOrNull($("comfyCfg").value),
      denoise: comfyNumOrNull($("comfyDenoise").value)
    },
    caps: caps,
    alpha: (COMFY_ALPHA_DD && COMFY_ALPHA_DD.getValue()) || prev.alpha || "unknown"
  };
}

function saveComfyFromForm(silent) {
  const p = collectComfyForm();
  upsertComfyPreset(p);
  if (!silent) setStatusEl("comfyStatus", "已保存「" + p.name + "」", "ok");
  rerenderCurrentDomain();
  return p;
}

function comfyAddPreset(copyCurrent) {
  const base = copyCurrent ? collectComfyForm() : null;
  const p = comfyEmptyPreset(base ? (base.name + " 副本") : "本地模型 " + (getComfyPresets().length + 1));
  p.url = base ? base.url : DEFAULT_COMFY.url;
  p.urls = base ? (base.urls || []).slice() : [];
  p.workflow = base ? base.workflow : "";
  p.roles = base ? Object.assign({}, base.roles) : p.roles;
  p.overrides = base ? Object.assign({}, base.overrides) : p.overrides;
  p.caps = base ? base.caps.slice() : ["t2i"];
  p.alpha = base ? base.alpha : "unknown";
  upsertComfyPreset(p);
  COMFY_ACTIVE = p.id;
  const s = getComfyStore(); s.activeId = p.id; saveComfyStore(s);
  renderComfyForm();
  rerenderCurrentDomain();
  setStatusEl("comfyStatus", "已新增「" + p.name + "」，改完记得点保存", "ok");
}

/* UXP 没有 window.confirm（调用直接返回 false，表现为"点了没反应"），
 * 改成按钮两段式确认：第一次点变红并提示，4 秒内再点才真删。 */
let COMFY_DEL_ARMED = "";
function comfyDeletePreset() {
  const id = comfyActiveId();
  const cur = getComfyPreset(id);
  if (!cur) return;
  if (getComfyPresets().length <= 1) {
    setStatusEl("comfyStatus", "至少保留一个预设", "err");
    return;
  }
  const btn = $("btnComfyDel");
  if (COMFY_DEL_ARMED !== id) {
    COMFY_DEL_ARMED = id;
    if (btn) { btn.textContent = "确认删除？"; btn.classList.add("armed"); }
    setStatusEl("comfyStatus", "再点一次「确认删除」删除「" + cur.name + "」", "err");
    setTimeout(function () {
      if (COMFY_DEL_ARMED !== id) return;
      COMFY_DEL_ARMED = "";
      if (btn) { btn.textContent = "删除"; btn.classList.remove("armed"); }
    }, 4000);
    return;
  }
  COMFY_DEL_ARMED = "";
  if (btn) { btn.textContent = "删除"; btn.classList.remove("armed"); }
  removeComfyPreset(id);
  COMFY_ACTIVE = getComfyPresets()[0].id;
  const st = getComfyStore(); st.activeId = COMFY_ACTIVE; saveComfyStore(st);
  renderComfyForm();
  rerenderCurrentDomain();
  setStatusEl("comfyStatus", "已删除「" + cur.name + "」", "ok");
}

async function testComfyConnection() {
  const btn = $("btnTestComfy");
  /* 先把当前表单落盘：用户导入工作流后通常直接点这里 */
  const p = saveComfyFromForm(true);
  btn.disabled = true;
  setStatusEl("comfyStatus", "连接中…");
  const urls = comfyPresetUrls(p);
  const parts = [];
  let ok = 0;
  for (let i = 0; i < urls.length; i++) {
    const host = comfyHostOf(urls[i]);
    const r = await comfyProbe(urls[i]);
    if (!r.ok) { parts.push(host + " 离线（" + r.error + "）"); continue; }
    ok++;
    const miss = await comfyCheckModels(p, urls[i]);
    if (miss.length) parts.push(host + " 在线但缺 " + miss.join("、"));
    else parts.push(host + " 在线 " + r.version);
  }
  const prefix = ok === urls.length ? "连接正常 ✓ " : (ok ? "部分可用：" : "连接失败：");
  setStatusEl("comfyStatus", prefix + parts.join("；"), ok === urls.length ? "ok" : "err");
  btn.disabled = false;
}

/* ===== 本机模型探测：按「机器 + 节点类型」缓存 object_info =====
 * 换机器（尤其 Windows）后最常见的问题是模板里的模型文件名对不上：
 * 文件在子目录里、量化档不同、或者本机根本没有 GGUF 加载器。
 * 这里把 object_info 的可用列表取回来，交给 services.js 的 comfyAdaptWorkflow 做确定性改写。 */
const COMFY_INFO = {};        /* "base|Class" -> { at, ok, required } */
const COMFY_INFO_TTL = 120000;

async function comfyClassInfo(base, cls, force) {
  const b = String(base || "").replace(/\/+$/, "");
  const key = b + "|" + cls;
  const now = Date.now();
  const hit = COMFY_INFO[key];
  if (!force && hit && (now - hit.at) < COMFY_INFO_TTL) return hit;
  const rec = { at: now, ok: false, required: null };
  try {
    const r = await xhrRequest({ method: "GET", url: b + "/object_info/" + encodeURIComponent(cls), timeout: 4000 });
    if (r.status === 200) {
      const info = JSON.parse(r.response)[cls];
      if (info) {
        rec.ok = true;
        rec.required = (info.input && info.input.required) || {};
      }
    }
  } catch (e) { /* 离线或没这个节点 */ }
  COMFY_INFO[key] = rec;
  return rec;
}

/* 把工作流用到的节点类型（含可能要换过去的标准加载器）全部预取，
 * 再给 comfyAdaptWorkflow 一个同步 probe */
async function comfyMakeProbe(base, workflow, force) {
  let wf = null;
  try { wf = JSON.parse(String(workflow || "{}")); } catch (e) { wf = null; }
  const classes = [];
  const push = function (c) { if (c && classes.indexOf(c) < 0) classes.push(c); };
  Object.keys(wf || {}).forEach(function (id) {
    const cls = String((wf[id] || {}).class_type || "");
    push(cls);
    const sw = COMFY_LOADER_SWAP[cls];
    if (sw) push(sw.to);
  });
  for (let i = 0; i < classes.length; i++) await comfyClassInfo(base, classes[i], force);

  const at = function (cls) { return COMFY_INFO[String(base).replace(/\/+$/, "") + "|" + cls] || null; };
  return {
    any: function () { return classes.some(function (c) { const r = at(c); return !!(r && r.ok); }); },
    has: function (cls) { const r = at(cls); return !!(r && r.ok); },
    required: function (cls) { const r = at(cls); return (r && r.required) || null; },
    list: function (cls, field) {
      const r = at(cls);
      const spec = r && r.required && r.required[field];
      return (spec && Array.isArray(spec[0])) ? spec[0] : [];
    },
    classes: classes
  };
}

/* 用 /object_info 粗查某个预设在这台机器上能不能跑：
 * 返回 { files:[模型名], classes:[缺的节点类型] }；查不到该类就跳过，不误报 */
async function comfyCheckPreset(p, urlOverride, force) {
  const base = String(urlOverride || p.url || "").replace(/\/+$/, "");
  const probe = await comfyMakeProbe(base, p.workflow, force);
  const r = comfyAdaptWorkflow(p.workflow, probe);
  return {
    files: (r.missingFiles || []).map(function (x) { return x.name; }),
    classes: r.missingClasses
  };
}

/* 兼容旧调用：只返回缺失条目（模型文件名 + 缺的节点类型） */
async function comfyCheckModels(p, urlOverride) {
  const r = await comfyCheckPreset(p, urlOverride);
  return r.files.concat(r.classes.map(function (c) { return "节点 " + c; }));
}

/* 适配一套预设：先探本机，再改写模型文件名 / 换加载器。
 * 返回 { adapted:[{name,changes}], unchanged:[name], offline:[name],
 *        missing:[{name,classes,files:[{name,available}]}] } */
async function comfyAdaptStore(force) {
  const store = getComfyStore();
  const out = { adapted: [], unchanged: [], offline: [], missing: [], extra: [] };
  const machineModels = {};   /* stem -> 本机实际文件名（所有能看到的 unet/ckpt） */
  const usedModels = {};      /* stem -> 预设里已经在用的 */
  for (let i = 0; i < store.presets.length; i++) {
    const p = store.presets[i];
    if (!String(p.workflow || "").trim()) continue;
    const urls = comfyPresetUrls(p);
    let done = false;
    for (let k = 0; k < urls.length && !done; k++) {
      const ping = await comfyProbe(urls[k]);
      if (!ping.ok) continue;
      const probe = await comfyMakeProbe(urls[k], p.workflow, force);
      ["UnetLoaderGGUF", "UNETLoader", "UnetLoader", "CheckpointLoaderSimple"].forEach(function (cls) {
        const field = cls === "CheckpointLoaderSimple" ? "ckpt_name" : "unet_name";
        (probe.list(cls, field) || []).forEach(function (n) {
          const k = comfyModelStem(n);
          if (k) machineModels[k] = n;
        });
      });
      if (!probe.any()) {
        /* 机器在线，但工作流用的节点一个都没有 —— 如实报「缺节点」，别当成离线 */
        out.missing.push({ name: p.name, classes: probe.classes, files: [] });
        done = true;
        continue;
      }
      const r = comfyAdaptWorkflow(p.workflow, probe);
      let touched = false;
      /* 改得动就改：某几个节点本机没有，不该连带把模型名对齐也一起放弃 */
      if (r.changes.length) {
        p.workflow = r.workflow;              /* 只改内存里的副本，最后统一落盘 */
        out.adapted.push({ name: p.name, changes: r.changes, url: urls[k] });
        touched = true;
      }
      const files = (r.missingFiles || []).map(function (x) {
        const avail = probe.list(x.cls, x.field) || [];
        return { name: x.name, available: avail.slice(0, 3), total: avail.length };
      });
      if (r.missingClasses.length || files.length) {
        out.missing.push({ name: p.name, classes: r.missingClasses, files: files });
      } else if (!touched) {
        out.unchanged.push(p.name);
      }
      done = true;
    }
    if (!done) out.offline.push(p.name);
  }
  /* 预设里用到的模型 */
  store.presets.forEach(function (p) {
    let wf = null;
    try { wf = JSON.parse(String(p.workflow || "{}")); } catch (e) { wf = null; }
    Object.keys(wf || {}).forEach(function (id) {
      const inp = (wf[id] || {}).inputs || {};
      ["unet_name", "ckpt_name"].forEach(function (k) {
        if (typeof inp[k] === "string" && inp[k]) {
          const st = comfyModelStem(inp[k]);
          if (st) usedModels[st] = 1;
        }
      });
    });
  });
  Object.keys(machineModels).forEach(function (k) {
    if (!usedModels[k]) out.extra.push(machineModels[k]);
  });

  if (out.adapted.length) saveComfyStore(store);
  return out;
}

function comfyAdaptSummary(r) {
  const bits = [];
  if (r.adapted.length) {
    const detail = r.adapted.map(function (a) {
      return a.name + "（" + a.changes.map(function (c) {
        if (c.kind === "auto") return "自动选中 " + c.to;
        return c.from + "→" + c.to;
      }).join("、") + "）";
    }).join("；");
    bits.push("已适配 " + r.adapted.length + " 个预设：" + detail);
    diag("comfy adapt: " + r.adapted.map(function (a) {
      return a.name + " @ " + a.url + " :: " + a.changes.map(function (c) {
        return c.kind + " " + c.node + " " + c.from + " -> " + c.to;
      }).join(" | ");
    }).join(" || "));
  }
  if (r.missing.length) {
    const clsList = [];
    const fileList = [];
    r.missing.forEach(function (m) {
      (m.classes || []).forEach(function (c) { if (clsList.indexOf(c) < 0) clsList.push(c); });
      (m.files || []).forEach(function (f) {
        const hint = f.available && f.available.length
          ? ("本机有 " + f.available.join(" / ") + (f.total > f.available.length ? " 等" : ""))
          : "本机没有同类文件";
        const line = f.name + "（" + hint + "）";
        if (fileList.indexOf(line) < 0) fileList.push(line);
      });
    });
    if (clsList.length) {
      const shown = clsList.slice(0, 3).join("/") + (clsList.length > 3 ? (" 等 " + clsList.length + " 个") : "");
      bits.push("缺节点：" + shown + "（装 ComfyUI-GGUF，或导入用标准加载器的工作流）");
    }
    if (fileList.length) bits.push("缺模型文件：" + fileList.join("；"));
  }
  if (r.offline.length) bits.push("连不上 ComfyUI：" + r.offline.length + " 个预设");
  if (r.extra && r.extra.length) {
    const shown = r.extra.slice(0, 3).join("、") + (r.extra.length > 3 ? (" 等 " + r.extra.length + " 个") : "");
    bits.push("本机另有 " + r.extra.length + " 个模型没配工作流：" + shown + "（需要各自的 API 工作流）");
  }
  if (!bits.length) bits.push("本机模型已与工作流一致（" + r.unchanged.length + " 个预设），无需改动");
  return bits.join("；");
}

/* 「适配本机模型」按钮 */
async function comfyAdaptAll() {
  const btn = $("btnComfyAdapt");
  if (btn) btn.disabled = true;
  setStatusEl("comfyStatus", "适配中…（读取本机模型列表）");
  try {
    const r = await comfyAdaptStore(true);
    renderComfyForm();
    rerenderCurrentDomain();
    setStatusEl("comfyStatus", comfyAdaptSummary(r), r.missing.length ? "err" : (r.adapted.length ? "ok" : ""));
    return r;
  } catch (e) {
    setStatusEl("comfyStatus", "适配失败：" + ((e && e.message) || String(e)), "err");
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* 内置模板：新机器一键建预设，只需改地址。
 * 加完立刻按本机模型适配一次——模板里写的是作者的量化档，换机器基本都要改。 */
async function comfyAddTemplates() {
  const before = getComfyPresets().length;
  const n = comfyApplyTemplates(($("comfyUrl") && $("comfyUrl").value.trim()) || DEFAULT_COMFY.url);
  COMFY_ACTIVE = "";
  renderComfyForm();
  /* 装完顺手把生图模型切到新模板：当前没选本地、或选中的是没工作流的空预设时才切 */
  if (n) {
    const tpl = getComfyPresets().filter(function (p) {
      return p.templateKey && String(p.workflow || "").trim();
    })[0];
    const cur = getModelOverride("gen");
    const curP = isComfyModel(cur) ? getComfyPreset(comfyPresetIdOf(cur)) : null;
    if (tpl && (!curP || !String(curP.workflow || "").trim())) {
      setModelOverride("gen", comfyModelId(tpl.id));
    }
  }
  rerenderCurrentDomain();
  if (!n) {
    setStatusEl("comfyStatus", "内置模板已在列表里", "");
    return;
  }
  setStatusEl("comfyStatus", "已添加 " + n + " 个内置模板，正在按本机模型适配…");
  const r = await comfyAdaptStore(false);
  renderComfyForm();
  rerenderCurrentDomain();
  setStatusEl("comfyStatus", comfyAdaptSummary(r), r.missing.length ? "err" : (r.adapted.length ? "ok" : ""));
}

/* 批量检测：每台机器的在线状态 + 缺哪些模型文件 */
async function comfyProbeAll() {
  const btn = $("btnComfyProbeAll");
  const list = getComfyPresets();
  if (!list.length) { setStatusEl("comfyStatus", "还没有预设", "err"); return; }
  btn.disabled = true;
  setStatusEl("comfyStatus", "检测中…（" + list.length + " 个预设）");
  const lines = [];
  let bad = 0;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const urls = comfyPresetUrls(p);
    const parts = [];
    let anyOk = false, anyBad = false;
    for (let k = 0; k < urls.length; k++) {
      const host = comfyHostOf(urls[k]);
      const r = await comfyProbe(urls[k]);
      if (!r.ok) { anyBad = true; parts.push(host + " 离线（" + r.error + "）"); continue; }
      anyOk = true;
      const miss = await comfyCheckModels(p, urls[k]);
      if (miss.length) { anyBad = true; parts.push(host + " 缺 " + miss.join(" / ")); }
      else parts.push(host + " 在线 " + r.version);
    }
    if (!anyOk || anyBad) bad++;
    lines.push(p.name + "：" + parts.join("；"));
  }
  setStatusEl("comfyStatus", lines.join("；"), bad ? "err" : "ok");
  btn.disabled = false;
}

/* 导出/导入整套预设：换电脑不用重配 */
async function exportComfyPresets() {
  if (!IS_UXP || !fs) { setStatusEl("comfyStatus", "浏览器预览无法导出，请在 PS 面板操作", "err"); return; }
  try {
    saveComfyFromForm(true);
    const store = getComfyStore();
    const f = await fs.getFileForSaving("ps-spark-comfy-presets.json", { types: ["json"] });
    if (!f) return;
    await f.write(JSON.stringify(store, null, 1), { format: formats.utf8 });
    setStatusEl("comfyStatus", "已导出 " + store.presets.length + " 个预设", "ok");
  } catch (e) {
    setStatusEl("comfyStatus", "导出失败：" + e.message, "err");
  }
}

async function importComfyPresets() {
  if (!IS_UXP || !fs) { setStatusEl("comfyStatus", "浏览器预览无法导入，请在 PS 面板操作", "err"); return; }
  try {
    const f = await fs.getFileForOpening({ types: ["json"] });
    if (!f) return;
    const j = JSON.parse(await f.read());
    const list = Array.isArray(j) ? j : (j && j.presets);
    if (!Array.isArray(list) || !list.length) { setStatusEl("comfyStatus", "文件里没有 presets", "err"); return; }
    const store = getComfyStore();
    const byId = {};
    store.presets.forEach(function (p) { byId[p.id] = p; });
    list.forEach(function (p) { byId[p.id] = comfyNormPreset(p); });
    store.presets = Object.keys(byId).map(function (k) { return byId[k]; });
    if (j && j.defaultByUse) {
      ["gen", "edit", "decomp"].forEach(function (u) {
        if (j.defaultByUse[u] && byId[j.defaultByUse[u]]) store.defaultByUse[u] = j.defaultByUse[u];
      });
    }
    saveComfyStore(store);
    COMFY_ACTIVE = store.presets[0].id;
    renderComfyForm();
    rerenderCurrentDomain();
    setStatusEl("comfyStatus", "已导入，共 " + store.presets.length + " 个预设", "ok");
  } catch (e) {
    setStatusEl("comfyStatus", "导入失败：" + e.message, "err");
  }
}

/*
 * 导入工作流文件：避免把几 KB JSON 手动粘进 UXP 文本框（粘贴容易截断）。
 * 只接受 Export (API) 的扁平对象；普通 Save 导出的是含 nodes/links 的 UI 格式，直接说明原因。
 */
async function importComfyWorkflow() {
  if (!IS_UXP || !fs) {
    setStatusEl("comfyStatus", "浏览器预览无法选文件，请在 Photoshop 面板里操作", "err");
    return;
  }
  const btn = $("btnImportComfy");
  btn.disabled = true;
  try {
    const f = await fs.getFileForOpening({ types: ["json"] });
    if (!f) return;
    const txt = await f.read();
    let wf = null;
    try { wf = JSON.parse(txt); } catch (e) {
      setStatusEl("comfyStatus", "不是合法 JSON：" + e.message, "err");
      return;
    }
    if (!wf || typeof wf !== "object" || Array.isArray(wf) || !Object.keys(wf).length) {
      setStatusEl("comfyStatus", "工作流应为对象（节点 id → 节点）", "err");
      return;
    }
    if (Array.isArray(wf.nodes) || Array.isArray(wf.links)) {
      setStatusEl("comfyStatus", "这是普通 Save 的工作流，请用 Workflow ▸ Export (API) 重新导出", "err");
      return;
    }
    const ids = Object.keys(wf);
    let promptId = null, outputCount = 0, hasInput = false, hasMask = false;
    for (let i = 0; i < ids.length; i++) {
      const n = wf[ids[i]] || {};
      const ct = String(n.class_type || "");
      if (/SaveImage|PreviewImage/i.test(ct)) outputCount++;
      if (/^LoadImage$/i.test(ct)) hasInput = true;
      if (/LoadImageMask/i.test(ct)) hasMask = true;
      if (!promptId && /CLIPTextEncode/i.test(ct) && n.inputs && typeof n.inputs.text === "string") {
        const title = String((n._meta && n._meta.title) || "").toLowerCase();
        if (!/negative|负面|反向/.test(title)) promptId = ids[i];
      }
    }
    $("comfyWorkflow").value = txt;
    if (!$("comfyPromptNode").value.trim() && promptId) $("comfyPromptNode").value = promptId;

    /* 按工作流实际节点推断能力：有蒙版=可重绘，有输入图=可图生图 */
    const caps = [];
    if (hasMask && hasInput) caps.push("t2i", "i2i", "inpaint");
    else if (hasInput) caps.push("t2i", "i2i");
    else caps.push("t2i");
    $("comfyCaps").querySelectorAll("input[data-cap]").forEach(function (cb) {
      cb.checked = caps.indexOf(cb.getAttribute("data-cap")) >= 0;
    });
    const p = saveComfyFromForm(true);
    if (!outputCount) {
      setStatusEl("comfyStatus", "已导入 " + f.name + "，但没找到 SaveImage 输出节点", "err");
      return;
    }
    setStatusEl("comfyStatus", "已导入「" + p.name + "」· " + ids.length + " 个节点 · 提示词节点 " +
      (promptId || "未识别") + (hasMask ? " · 含蒙版" : ""), "ok");
  } catch (e) {
    setStatusEl("comfyStatus", "导入失败：" + e.message, "err");
  } finally {
    btn.disabled = false;
  }
}

/* ---- 设置中心事件绑定 ---- */

function bindSettingsEvents() {
  /* 节点 / 图像模型 / 文本模型 / 模型分配 / 默认尺寸·质量 由自绘下拉承载（initSettingsDropdowns 里绑定 onChange） */
  $("imgBaseUrlCustom").addEventListener("change", () => saveImageServiceFromForm(false));
  $("imgModelCustom").addEventListener("change", () => {  /* 自定义模型名：保存并联动尺寸/质量 */
    if (saveImageServiceFromForm(false)) { refreshDefaultsDropdowns(); rerenderCurrentDomain(); }
  });
  $("apiKey").addEventListener("change", async () => {
    const k = $("apiKey").value.trim();
    if (!k) return;
    const ok = await saveImageKey(k);
    lastSavedKey = k;
    if (ok) {
      setStatusEl("imgStatus", "密钥已保存到本机（" + maskKey(k) + "）", "ok");
      updateGearBadge(true);
    } else {
      setStatusEl("imgStatus", "密钥保存失败（见日志）", "err");
    }
  });
  $("btnTestImage").addEventListener("click", testImageService);

  /* 本地 ComfyUI：表单失焦即保存；预设增删与导入导出单独按钮 */
  const comfyField = function () { return function () { saveComfyFromForm(); }; };
  ["comfyName", "comfyUrl", "comfyWorkflow", "comfyPromptNode", "comfySteps", "comfyCfg", "comfyDenoise"].forEach(function (id) {
    if ($(id)) $(id).addEventListener("change", comfyField());
  });
  if ($("btnTestComfy")) $("btnTestComfy").addEventListener("click", testComfyConnection);
  if ($("btnImportComfy")) $("btnImportComfy").addEventListener("click", importComfyWorkflow);
  if ($("btnComfyAdd")) $("btnComfyAdd").addEventListener("click", function () { comfyAddPreset(false); });
  if ($("btnComfyDup")) $("btnComfyDup").addEventListener("click", function () { comfyAddPreset(true); });
  if ($("btnComfyDel")) $("btnComfyDel").addEventListener("click", comfyDeletePreset);
  if ($("btnComfyExport")) $("btnComfyExport").addEventListener("click", exportComfyPresets);
  if ($("btnComfyImportAll")) $("btnComfyImportAll").addEventListener("click", importComfyPresets);
  if ($("btnComfyTemplates")) $("btnComfyTemplates").addEventListener("click", comfyAddTemplates);
  if ($("btnComfyAdapt")) $("btnComfyAdapt").addEventListener("click", comfyAdaptAll);
  if ($("btnComfyProbeAll")) $("btnComfyProbeAll").addEventListener("click", comfyProbeAll);

  /* 功能说明：整个描述区一个开关 */
  const helpBtn = $("btnHelpToggle");
  if (helpBtn) {
    helpBtn.addEventListener("click", function () {
      const list = $("helpList");
      if (!list) return;
      const collapsed = list.classList.toggle("collapsed");
      helpBtn.textContent = collapsed ? "▸ 展开说明" : "▾ 收起说明";
    });
  }

  $("txtBaseUrl").addEventListener("change", () => saveTextServiceFromForm(false));
  $("txtModelCustom").addEventListener("change", () => {
    if (saveTextServiceFromForm(false)) { refreshTextVisionNote(); rerenderCurrentDomain(); }
  });
  $("txtVisionCustom").addEventListener("change", () => {
    if (saveTextServiceFromForm(false)) { refreshTextVisionNote(); rerenderCurrentDomain(); }
  });
  $("txtApiKey").addEventListener("change", async () => {
    const k = $("txtApiKey").value.trim();
    if (!k) return;
    const ok = await saveTextKey(k);
    if (ok) {
      App.hasTextKey = true;
      setStatusEl("txtStatus", "密钥已保存到本机（" + maskKey(k) + "）", "ok");
    } else setStatusEl("txtStatus", "密钥保存失败（见日志）", "err");
  });
  $("btnTestText").addEventListener("click", testTextService);

  ["mapGenCustom", "mapEditCustom", "mapTextCustom"].forEach((id) => $(id).addEventListener("change", () => {
    saveMapFromForm();
    rerenderCurrentDomain();
  }));
  ["defTransparent", "defClip", "defSmartObject"].forEach((id) => $(id).addEventListener("change", saveDefaultsFromForm));
  if ($("defOutpaintKeep")) {
    $("defOutpaintKeep").addEventListener("change", function () {
      setOutpaintKeepOriginal($("defOutpaintKeep").checked);
      setStatusEl("defStatus", "已自动保存", "ok");
    });
  }
  $("diagLog").addEventListener("change", () => {
    const on = $("diagLog").checked;
    setDiagFlag(on);
    diag("settings: diag log -> " + (on ? "on" : "off"));
  });

  /* 历史缓存管理 */
  $("btnCacheMove").addEventListener("click", async () => {
    if (!IS_UXP) { setStatusEl("cacheStatus", "请在 Photoshop 面板中操作", "err"); return; }
    try {
      const folder = await fs.getFolder();
      if (!folder) return;
      setStatusEl("cacheStatus", "正在迁移缓存到新位置…");
      const ok = await storeSetCustomRoot(folder);
      if (ok) {
        setStatusEl("cacheStatus", "缓存位置已切换（旧位置内容保留为备份）", "ok");
        await refreshCacheStats();
        renderHistoryView();
      } else {
        setStatusEl("cacheStatus", "切换失败（详见日志），仍使用原位置", "err");
      }
    } catch (e) {
      setStatusEl("cacheStatus", "选择文件夹失败: " + e.message, "err");
    }
  });

  $("btnCacheReset").addEventListener("click", async () => {
    try {
      setStatusEl("cacheStatus", "正在迁回默认位置…");
      const ok = await storeResetRoot();
      if (ok) {
        setStatusEl("cacheStatus", "已恢复默认位置", "ok");
        await refreshCacheStats();
        renderHistoryView();
      } else {
        setStatusEl("cacheStatus", "迁回失败（详见日志）", "err");
      }
    } catch (e) { setStatusEl("cacheStatus", "失败: " + e.message, "err"); }
  });

  let __cleanT = null;
  $("btnCacheClean").addEventListener("click", async () => {
    const btn = $("btnCacheClean");
    try {
      if (btn.dataset.confirm !== "1") {
        const s = await storeStats();
        const n = s.count - s.favorites;
        if (n <= 0) { setStatusEl("cacheStatus", "没有可清理的内容（未收藏任务为 0）", "err"); return; }
        btn.dataset.confirm = "1";
        btn.textContent = "确认清理 " + n + " 条？（再点一次执行）";
        clearTimeout(__cleanT);
        __cleanT = setTimeout(function () {
          btn.dataset.confirm = "";
          btn.textContent = "清理未收藏缓存";
        }, 5000);
        setStatusEl("cacheStatus", "将删除未收藏任务的结果图与记录；★ 收藏的任务豁免", "err");
        return;
      }
      clearTimeout(__cleanT);
      btn.dataset.confirm = "";
      btn.textContent = "清理未收藏缓存";
      const r = await storeCleanup();
      setStatusEl("cacheStatus", "已清理 " + r.removed + " 条（保留 " + r.kept + " 条，含收藏）", "ok");
      await refreshCacheStats();
      renderHistoryView();
    } catch (e) {
      setStatusEl("cacheStatus", "清理失败: " + e.message, "err");
    }
  });
}

/* ---- 历史缓存管理（设置 · 诊断与数据） ---- */

async function refreshCacheStats() {
  const t = $("cacheStats");
  if (!t) return;
  try {
    const s = await storeStats();
    const mb = s.bytes > 0 ? ("约 " + (s.bytes / 1048576).toFixed(1) + " MB") : "—";
    const info = storeCustomRootInfo();
    t.textContent = "共 " + s.count + " 条任务（成功 " + (s.count - s.failed) + " · 失败 " + s.failed +
      " · ★收藏 " + s.favorites + "）· " + mb + " · 位置：" + (info.custom ? info.path : "默认（插件数据目录）");
  } catch (e) {
    diag("cache stats warn: " + e.message);
    t.textContent = "统计失败（见日志）";
  }
  try {
    $("cacheResetRow").classList.toggle("hidden", !storeCustomRootInfo().custom);
  } catch (e2) { /* ignore */ }
}

/* ---- 覆盖层进出（支持深链到指定分组，供运行条模型标签使用） ---- */

async function openSettings(sectionId) {
  App.settingsReturn = App.tab;
  document.body.classList.add("settings-open");   /* 隐藏底层内容：防 UXP 重绘穿透（见 index.html 注释） */
  $("settingsOverlay").classList.remove("hidden");
  fillSettingsForm();
  await fillKeys();
  refreshCacheStats();
  if (sectionId) {
    const el2 = $(sectionId);
    if (el2) setTimeout(() => {
      try { el2.scrollIntoView({ block: "start" }); }
      catch (e) { try { el2.scrollIntoView(); } catch (e2) { /* ignore */ } }
    }, 60);
  }
  diag("settings open" + (sectionId ? " @" + sectionId : ""));
}

function closeSettings() {
  $("settingsOverlay").classList.add("hidden");
  document.body.classList.remove("settings-open");   /* 恢复底层内容绘制 */
  if (App.settingsReturn) switchTab(App.settingsReturn);
  /* 统一重渲染当前域：拾取设置期间的模型/参数变更，并把底层绘制整体刷新一遍（不留旧绘制内容） */
  doRerenderDomain();
  const h = currentHost(), i = currentInstance();
  if (h && i) UI.refreshRunBar(h, i);
  diag("settings close");
}

function updateGearBadge(configured) {
  App.hasImageKey = !!configured;
  const g = $("btnSettings");
  if (g) g.classList.toggle("alert", !configured);
  const h = currentHost(), i = currentInstance();
  if (h && i) UI.refreshRunBar(h, i);
}

/* ================= 运行执行器（注册表驱动 · W2） ================= */

/* 快照：捕获当前实例的表单状态（"重新生成"用同一份快照再跑） */
function captureSnapshot(inst) {
  const st = getInstanceState(inst.id);
  const slots = {};
  Object.keys(st.slots || {}).forEach(function (k) { slots[k] = (st.slots[k] || []).slice(); });
  return {
    userText: st.userText || "",
    tplOverride: st.tplOverride || "",
    params: resolveParams(inst, st),
    locate: resolveLocate(inst, st),
    slots: slots
  };
}

function slotItems(snap, role) {
  return (snap.slots && snap.slots[role]) ? snap.slots[role] : [];
}

/* 已填充的非隐式槽（参考/商品/模特/背景）→ 扁平列表 */
function filledRefSlots(inst, snap) {
  const out = [];
  (inst.slots || []).forEach(function (s) {
    if (s.implicit) return;
    slotItems(snap, s.role).forEach(function (it) {
      out.push({ role: s.role, label: s.label, item: it });
    });
  });
  return out;
}

function computeExportBounds(sel, docW, docH, useBox) {
  if (!sel) return { left: 0, top: 0, right: docW, bottom: docH, width: docW, height: docH };
  if (!useBox) {
    const l = Math.max(0, sel.left), t = Math.max(0, sel.top);
    const r = Math.min(docW, sel.right), b = Math.min(docH, sel.bottom);
    return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
  }
  const pad = Math.max(24, Math.round(Math.min(sel.width, sel.height) * 0.25));
  const l = Math.max(0, sel.left - pad), t = Math.max(0, sel.top - pad);
  const r = Math.min(docW, sel.right + pad), b = Math.min(docH, sel.bottom + pad);
  return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
}

/* 本地整图重绘的导出范围：选区向外扩一圈，得到一块「有上下文的完整画面」。
 * 目标短边至少 768px（太小的图本地模型容易糊），选区大致占画面 40%~70%；四周不超出画布。 */
function computeWholeRedrawBounds(sel, docW, docH) {
  const margin = Math.max(64, Math.round(Math.min(sel.width, sel.height) * 0.75));
  let l = sel.left - margin, t = sel.top - margin;
  let r = sel.right + margin, b = sel.bottom + margin;
  const shortSide = Math.min(r - l, b - t);
  if (shortSide < 768) {
    const grow = (768 - shortSide) / 2;
    l -= grow; t -= grow; r += grow; b += grow;
  }
  l = Math.max(0, Math.round(l)); t = Math.max(0, Math.round(t));
  r = Math.min(docW, Math.round(r)); b = Math.min(docH, Math.round(b));
  if (r - l < 8 || b - t < 8) {
    return { left: Math.max(0, sel.left), top: Math.max(0, sel.top), right: Math.min(docW, sel.right), bottom: Math.min(docH, sel.bottom), width: Math.min(docW, sel.right) - Math.max(0, sel.left), height: Math.min(docH, sel.bottom) - Math.max(0, sel.top) };
  }
  return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
}

/* ================= 扩图执行链（W4：导出扩展版 → edits → 扩展画布回贴） ================= */

/* 发给模型的扩展版最长边。过大时：① base64 十几 MB，请求慢且易被网关拒；
 * ② 接口会自行降采样，原图在参考图里只占几百像素，模型就按"小图放大"重新构图，
 *    返回的画面比要求的扩展量大得多。压到 2048 内可显著稳住构图。 */
const OUTPAINT_REF_MAX = 2048;

/* 参考图缩放系数：只缩尺寸，不改比例；回贴仍按整块画布映射，所以不影响对齐 */
function outpaintRefScale(NW, NH, maxSide) {
  const cap = Math.max(256, maxSide || OUTPAINT_REF_MAX);
  const k = Math.min(1, cap / Math.max(NW, NH));
  return (k > 0 && isFinite(k)) ? k : 1;
}

/* 扩图参考图几何：把「扩展后画布」按上限等比缩小，返回参考图尺寸与原图矩形在其中的位置。
 * 单独成函数便于单测（错位问题的核心就是这里的尺寸/偏移换算）。 */
function outpaintRefGeometry(W, H, l, r, u, d, maxSide) {
  const NW = W + l + r, NH = H + u + d;
  const k = outpaintRefScale(NW, NH, maxSide);
  const RW = Math.max(16, Math.round(NW * k));
  const RH = Math.max(16, Math.round(NH * k));
  const rl = Math.round(l * k), rt = Math.round(u * k);
  /* 用总宽减去左右边，保证「原图矩形 + 两条边」正好等于参考图宽度，不留 1px 缝 */
  const rw = Math.max(1, RW - rl - Math.round(r * k));
  const rh = Math.max(1, RH - rt - Math.round(d * k));
  return { NW: NW, NH: NH, k: k, RW: RW, RH: RH, rl: rl, rt: rt, rw: rw, rh: rh };
}

/* 扩图是否保留原图区域（把原图矩形从结果层挖空成蒙版）。
 * 默认关闭：模型整体重绘的融合更自然；挖空在「只扩单边」时容易与原图错位、露空白条。 */
function outpaintKeepOriginal() {
  try { return localStorage.getItem("psspark.outpaint.keepOriginal") === "1"; } catch (e) { return false; }
}
function setOutpaintKeepOriginal(on) {
  try { localStorage.setItem("psspark.outpaint.keepOriginal", on ? "1" : "0"); } catch (e) { /* ignore */ }
  diag("outpaint: 保留原图区域 -> " + (on ? "开" : "关"));
}

async function execOutpaint(inst, snap, ctx) {
  const doc = app.activeDocument;
  const W = Math.round(doc.width), H = Math.round(doc.height);
  const e = snap.params.expand || {};
  /* 扩展量支持两种口径：百分比（相对原图宽/高）与像素（绝对值）。 */
  const sides = expandSidesOf(e, W, H);
  const emode = sides.mode;
  const l = sides.left, r = sides.right, u = sides.up, d = sides.down;
  if (l + r + u + d <= 0) throw new Error("扩展量为 0：请至少为一个方向设置大于 0 的数值");
  const NW = W + l + r, NH = H + u + d;
  if (NW > 8000 || NH > 8000) throw new Error("扩展后画布过大（上限 8000px），请减小扩展量");
  const mdlOut = resolveModel("edit");
  /* 超出模型像素/比例上限时提前警告（不阻断：仍会按最接近的档位出图） */
  const limWarn = (typeof expandLimitWarning === "function")
    ? expandLimitWarning(mdlOut, W, H, l, r, u, d) : "";
  if (limWarn) log("⚠ " + limWarn, "err");
  diag("outpaint: " + W + "x" + H + " -> " + NW + "x" + NH + " (mode=" + emode +
    ", l=" + l + ",r=" + r + ",u=" + u + ",d=" + d + ")" + (limWarn ? " 超限：" + limWarn : ""));

  /* 参考图按固定上限缩放：k=1 时与画布同尺寸；否则等比缩小，
   * 原图矩形在参考图里的位置/大小也按同一系数换算（回贴按整块画布铺满，仍精确对齐）。 */
  const geo = outpaintRefGeometry(W, H, l, r, u, d);
  const RW = geo.RW, RH = geo.RH, rl = geo.rl, rt = geo.rt, rw = geo.rw, rh = geo.rh;
  diag("outpaint: 参考图 " + RW + "x" + RH + "（k=" + geo.k.toFixed(4) + "），原图区 (" + rl + "," + rt + ") " + rw + "x" + rh);

  /* —— 阶段 1：导出「扩展版」参考图 + 扩图蒙版 ——
   * 参考图：原内容位于 (rl,rt)，四周透明；
   * 蒙版：白＝可重绘（扩展边），黑＝原图矩形（必须保持原样）。
   * 路径：临时副本 → 合并可见（保留透明、不触碰源文档）→ 跨文档复制图层 →
   *       透明目标文档 → 精确移到 (rl,rt) → 存 PNG。全程零剪贴板。 */
  let exportEntry = null, maskEntry = null;
  await core.executeAsModal(async function () {
    const srcDoc = ensureActiveDoc(ctx.docId);
    if (!srcDoc) throw new Error("未能定位原文档（文档可能已被关闭）");
    protectDoc(srcDoc);
    const beforeIds = snapshotDocIds();
    let dupDoc = null, tmpDoc = null;
    try {
      log("导出扩图参考图（生成扩展版，含透明边）...");
      /* 只导出用户点击那一刻的画面：隐藏入队之后新增的图层 + 上次落的结果层 */
      const hidOut = await hideLayersNotIn(srcDoc,
        (ctx && ctx.run && ctx.run.task && ctx.run.task.layerIds) || null,
        sourcePollutionIds(srcDoc));
      try {
        await batchPlay([{
          _obj: "duplicate",
          _target: [{ _ref: "document", _enum: "ordinal", _value: "targetEnum" }],
          name: "psspark_outpaint_copy",
          _options: { dialogOptions: "dontDisplay" }
        }]);
        dupDoc = findNewDoc(beforeIds);
        if (!dupDoc) throw new Error("复制文档失败：未识别到临时文档，已中止（原文档未受影响）");
        try { await batchPlay([{ _obj: "mergeVisible" }]); } catch (e1) { diag("outpaint: mergeVisible warn: " + e1.message); }
      } finally {
        if (hidOut.length) await restoreLayerVisibility(srcDoc, hidOut);
      }

      /* 先取合并图层引用（须在切换活动文档之前读取） */
      let mergedLayer = null;
      try { mergedLayer = dupDoc.activeLayers[0]; } catch (e2) { mergedLayer = null; }
      if (!mergedLayer) { try { mergedLayer = dupDoc.layers[0]; } catch (e3) { mergedLayer = null; } }
      if (!mergedLayer) throw new Error("未取到合并图层，已中止（原文档未受影响）");

      tmpDoc = await makeDoc(RW, RH, "psspark_outpaint_tmp");
      /* 校验临时画布：确认拿到的是真正新建的目标尺寸文档（防活动文档指针滞后返回旧文档） */
      let tW = -1, tH = -1;
      try { tW = Math.round(tmpDoc.width); tH = Math.round(tmpDoc.height); } catch (e5) { diag("outpaint export: 读取临时画布尺寸失败 " + e5.message); }
      diag("outpaint export: tmpDoc id=" + (tmpDoc && tmpDoc.id) + " " + tW + "×" + tH);
      if (tW > 0 && (Math.abs(tW - RW) > 2 || Math.abs(tH - RH) > 2)) {
        throw new Error("临时画布尺寸异常（" + tW + "×" + tH + "，期望 " + RW + "×" + RH + "），已中止（未消耗 API）");
      }

      const pasted = await mergedLayer.duplicate(tmpDoc);
      /* 校验复制内容尺寸（防跨文档复制异常） */
      const rr = await batchPlay([{ _obj: "get", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], _options: { dialogOptions: "dontDisplay" } }]);
      const lb = rr[0].boundsNoEffects || rr[0].bounds;
      const res = tmpDoc.resolution || 72;
      const bl = toPx(lb.left, res), bt = toPx(lb.top, res);
      const bw = toPx(lb.right, res) - bl, bh = toPx(lb.bottom, res) - bt;
      diag("outpaint export: 复制内容 " + Math.round(bw) + "x" + Math.round(bh) + " @ (" + Math.round(bl) + "," + Math.round(bt) + ")，目标 (" + rw + "x" + rh + " @ " + rl + "," + rt + ")");
      if (Math.abs(bw - W) > 2 || Math.abs(bh - H) > 2) {
        throw new Error("导出内容尺寸异常（" + Math.round(bw) + "×" + Math.round(bh) + "，期望 " + W + "×" + H + "），已中止");
      }
      /* 一次变换同时完成「等比缩到 rw×rh」与「移到 (rl,rt)」——中心对齐后偏移量是差值 */
      await batchPlay([{
        _obj: "transform",
        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
        freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
        offset: {
          _obj: "offset",
          horizontal: { _unit: "pixelsUnit", _value: (rl + rw / 2) - (bl + bw / 2) },
          vertical: { _unit: "pixelsUnit", _value: (rt + rh / 2) - (bt + bh / 2) }
        },
        width: { _unit: "percentUnit", _value: (rw / bw) * 100 },
        height: { _unit: "percentUnit", _value: (rh / bh) * 100 }
      }]);
      try { pasted.name = "psspark_outpaint_content"; } catch (e4) { /* ignore */ }

      const folder = await fs.getDataFolder();
      exportEntry = await folder.createFile("psspark_outpaint.png", { overwrite: true });
      await tmpDoc.saveAs.png(exportEntry, { compression: 6 }, true);
      diag("outpaint export: saved " + RW + "x" + RH);

      /* 蒙版与参考图同尺寸、同位置：白＝扩展边，黑＝原图矩形 */
      maskEntry = await buildOutpaintMaskPNG(RW, RH, { left: rl, top: rt, right: rl + rw, bottom: rt + rh });
    } finally {
      /* 无论成败：关闭本次创建的全部临时文档（srcDoc 受保护、永不关闭） */
      if (tmpDoc && tmpDoc !== dupDoc) { try { await closeDocNoSave(tmpDoc); } catch (e6) { diag("outpaint cleanup tmp warn: " + e6.message); } }
      if (dupDoc) { try { await closeDocNoSave(dupDoc); } catch (e7) { diag("outpaint cleanup dup warn: " + e7.message); } }
      restoreActiveDoc(srcDoc);
      diag("outpaint export: cleanup done");
    }
  }, { commandName: "PS Spark: 导出扩图参考图" });

  /* —— 阶段 2：调用 edits ——
   * size 必须是与扩展后画布同比例的「模型支持档位」：传 auto 时接口常回 1:1，
   * 回贴时只能等比缩小居中 → 扩展边被放大、原图错位（就是之前的现场）。
   * 蒙版限定只重绘扩展边，原图矩形由接口保留。 */
  let prompt = buildFinalPrompt(inst, snap.userText, null, snap.params, snap.tplOverride);
  /* 构图比例随参数走：改了扩展量，提示词里的比例描述也跟着变（不会停留在旧画布）。
   * 对模型来说「原画面占参考图百分之几」比一串像素坐标更有指导意义。 */
  const origPct = Math.max(1, Math.min(99, Math.round((rw * rh) / (RW * RH) * 100)));
  if (origPct < 96) {
    prompt += "\n构图比例：原画面在参考图中约占 " + origPct + "%，其余 " + (100 - origPct) +
      "% 为待补的透明区域。";
  }
  diag("prompt: " + prompt.slice(0, 300));
  const exportUri = await fileToDataURI(exportEntry);
  const maskUri = maskEntry ? await fileToDataURI(maskEntry) : null;
  setRunExportUri(ctx, exportUri);
  const wantSize = decompPickSize(RW, RH, mdlOut, true);
  diag("outpaint: 请求尺寸 " + wantSize + "（目标画布 " + NW + "×" + NH + "，" +
    (wantSize === "auto" ? "无同比例档位，按输入比例出图" : "与画布同比例") + "）");
  let apiRes;
  if (isNanoModel(mdlOut)) {
    /* nano 系列：统一端点；aspectRatio 用同比例档位（该族无蒙版能力，靠提示词 + 落图后挖回原图区） */
    diag("路由：统一端点 /v1/api/generate（扩图）");
    apiRes = await callUnifiedGenerate(buildUnifiedPayload(mdlOut, prompt, [exportUri], snap, wantSize));
  } else {
    const payload = {
      model: mdlOut,
      prompt: prompt,
      size: wantSize,
      quality: normalizeQualityForModel(mdlOut, snap.params.quality || "auto")
    };
    payload.image = exportUri;
    if (maskUri) payload.mask = maskUri;
    apiRes = await callApi("/v1/images/edits", payload, true);
  }

  /* —— 阶段 3：扩展用户画布 → 回贴结果（铺满整块画布 + 挖回原图矩形） —— */
  const name = layerNameFor(inst, W + "×" + H + "→" + NW + "×" + NH);
  setRunLayerName(ctx, name);
  let finalEntry = null;
  await placeWithGate(ctx && ctx.run, "PS Spark: 扩图应用", async function () {
    const doc2 = ensureActiveDoc(ctx.docId);
    if (!doc2) throw new Error("扩图应用失败：未能定位原文档（文档可能已被关闭，请检查后重试）");
    protectDoc(doc2);
    diag("outpaint phase3: doc id=" + doc2.id);
    log("扩展画布 " + W + "×" + H + " → " + NW + "×" + NH + " ...");
    await canvasResizeTo(W, H, NW, NH, l, u);
    try { diag("outpaint: 画布已扩展 -> " + Math.round(doc2.width) + "×" + Math.round(doc2.height)); } catch (eW) { diag("outpaint: 读取画布尺寸失败 " + eW.message); }
    /* stretch：结果铺满 (0,0,NW,NH)，比例不一致也不留边、不错位；
     * punchRect：把原图矩形挖空，保证「原区域像素不变」——默认关闭：
     * 模型整体重绘的融合度更好，而挖空在「只扩单边」时容易与原图错位、露出空白条。
     * 需要原图区绝对不变时在 设置 ▸ 功能 打开「扩图保留原图区域」。 */
    const keepOrig = outpaintKeepOriginal();
    finalEntry = await placeResultAsLayer(apiRes.url, { left: 0, top: 0, width: NW, height: NH }, name, null, ctx.docId, {
      stretch: true,
      punchRect: keepOrig ? { left: l, top: u, right: l + W, bottom: u + H } : null
    });
    if (ctx && ctx.run) ctx.run.layerId = (lastPlacedLayer && lastPlacedLayer.id) || null;
    const bp = lastPlacedLayer && lastPlacedLayer.bounds;
    diag("outpaint phase3: 落层 " + (bp ? (Math.round(bp.left) + "," + Math.round(bp.top) + " " +
      Math.round(bp.width) + "×" + Math.round(bp.height)) : "未知") +
      "，期望 (0,0 " + NW + "×" + NH + ")，原图区 (" + l + "," + u + ") " + W + "×" + H);
  });

  return { entry: finalEntry, placeTarget: { left: 0, top: 0, width: NW, height: NH } };
}

/*
 * 原位合成：双模式路由
 *   ① 有资产图（1–4 张）→ 多图生成通道：底图（当前画面/选区，或本地文件）+ 资产，
 *      提示词按「原位合入」模板（底图不变、资产保形、只做接触处融合）；
 *   ② 无资产图 → 单图光影通道（承原「和谐化」能力）：统一画面光影，强度＝结果层不透明度。
 */
async function execComposite(inst, snap, ctx) {
  const assets = slotItems(snap, "asset");
  if (!assets.length) {
    diag("composite: 无资产 → 光影统一模式");
    const r = await runEditPipeline(inst, snap, ctx, { hasAsset: false, modelUse: "edit" });
    return { entry: r.entry, placeTarget: r.placeTarget, extra: { hasAsset: false } };
  }
  /* 底图：优先用本地文件（用户替换过），否则导出当前画面/选区 */
  const mains = slotItems(snap, "main");
  let main = null;
  if (mains.length) {
    main = { uri: mains[0].uri, eb: null, w: 0, h: 0, fromFile: true };
    setRunExportUri(ctx, main.uri);   /* 结果卡"参考图"显示底图 */
    diag("composite: 底图来自本地文件（" + (mains[0].name || "") + "）");
  } else {
    main = await exportMainForRefs(inst, ctx);
  }
  const uris = [main.uri].concat(assets.map(function (a) { return a.uri; }));
  /* 只有全部资产都是「画布对齐」时才走对齐模式；混入本地文件则退回"按描述摆放" */
  const aligned = assets.length > 0 && assets.every(function (a) { return !!(a && a.aligned); });
  const mixed = assets.some(function (a) { return !!(a && a.aligned); }) && !aligned;
  diag("composite: 资产 " + assets.length + " 张" + (aligned ? "（画布对齐 · 合并图层）" : "") +
    "（共 " + uris.length + " 图输入）");
  if (mixed) log("提示：资产里同时有「画布对齐」与「本地文件」，将按描述摆放（位置不锁定）");
  if (aligned) {
    /* 对齐资产是按"当前画布"导出的；底图必须同尺寸，否则位置仍会偏 */
    const aw = assets[0].w || 0, ah = assets[0].h || 0;
    let bw = main.w || 0, bh = main.h || 0;
    if (!bw || !bh) {
      const bs = pngSizeFromDataURI(main.uri);   /* 底图来自本地文件时，从 PNG 头读尺寸 */
      if (bs) { bw = bs.w; bh = bs.h; }
    }
    if (aw && bw && (Math.abs(aw - bw) > 2 || Math.abs(ah - bh) > 2)) {
      log("⚠ 底图（" + bw + "×" + bh + "）与资产画布（" + aw + "×" + ah + "）尺寸不同，位置可能偏移：" +
        "建议底图选「＋ 当前图层」中覆盖整个画布的图层，或不选底图（自动导出当前画布）", "err");
      diag("composite: 尺寸不一致 base=" + bw + "x" + bh + " asset=" + aw + "x" + ah);
    } else if (aw && bw) {
      diag("composite: 尺寸一致（" + bw + "×" + bh + "），按画布坐标对齐");
    }
  }
  const r = await runGenerationsWithRefs(inst, snap, main, uris, ctx, { hasAsset: true, aligned: aligned });
  return { entry: r.entry, placeTarget: r.placeTarget, extra: { hasAsset: true, aligned: aligned } };
}

/* ================= 任务队列 =================
 * 生图这类「点一次就该跑一次」的操作走队列：连点多次不会互相顶掉。
 * · 任务保存加入时刻的快照（提示词/参数/参考图），不随后续 UI 改动漂移
 * · 并行规则：云端 2 路并发；本地 ComfyUI 1 路（单实例只能串行）；
 *   编辑类 1 路（要动画布与选区，天然独占）
 * · 落图（写图层）严格按入队顺序：并发生成允许乱序完成，但谁先落图由队列顺序决定
 * · 可单条取消（等待中直接移除，运行中见 taskCancel）、可清空已完成
 */
const TASKQ = {
  list: [], seq: 0, cancelId: null, open: false,
  limits: { cloud: 2, local: 1, edit: 1 }
};

/* 槽位：决定这条任务能和谁并行
 * 编辑类默认独占（选区/画布是全局状态）；但「不带选区、只处理整幅画面」的编辑
 * （老照片修复、线稿上色等）不碰选区，可以像生成任务一样并发。 */
function taskSlotOf(inst, local, hasSel) {
  if (inst && inst.domain === "edit") {
    if (hasSel) return "edit";
    return local ? "local" : "cloud";
  }
  return local ? "local" : "cloud";
}
const TASK_STATUS_TEXT = { wait: "等待", run: "运行中", ok: "完成", err: "失败", cancel: "已取消" };

function taskQueueActive() {
  return TASKQ.list.filter(function (t) { return t.status === "wait" || t.status === "run"; });
}

/* ---------------- 二次确认层 ----------------
 * UXP 里 window.confirm 不可用（会直接抛），这里用「隐藏底层 + 覆盖层」实现，
 * 与设置层同一套策略：底层不绘制，避免 UXP 覆盖层重绘穿透（鬼影/重叠）。
 * 返回 Promise<boolean>：true=确认继续，false=取消。 */
function askConfirm(opts) {
  return new Promise(function (resolve) {
    /* 同一时刻只允许一个确认框：连点运行按钮时，第二次直接按「取消」处理，
     * 避免两个 Promise 抢同一组按钮、点一下入队两次。 */
    if (askConfirm.busy) { resolve(false); return; }
    const o = opts || {};
    const ov = $("confirmOverlay");
    const okBtn = $("cfOk"), cancelBtn = $("cfCancel");
    if (!ov || !okBtn || !cancelBtn) { resolve(true); return; }
    askConfirm.busy = true;
    const head = $("cfHead"), title = $("cfTitle"), text = $("cfText");
    const tr = function (s) { return (typeof i18nText === "function") ? i18nText(s) : s; };
    if (head) head.textContent = tr(o.head || "请确认");
    if (title) title.textContent = tr(o.title || "");
    /* 逐行翻译：确认正文是多行中文拼出来的，整段匹配不到词典；
     * 每一行都是完整句子（可带数字），走 patterns 才能中英都覆盖。 */
    if (text) {
      const raw = String(o.text || "");
      text.textContent = raw.split("\n").map(tr).join("\n");
    }
    okBtn.textContent = tr(o.okText || "仍然继续");
    cancelBtn.textContent = tr(o.cancelText || "取消");

    let settled = false;
    function cleanup() {
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      ov.classList.add("hidden");
      document.body.classList.remove("confirm-open");
    }
    function done(v) {
      if (settled) return;
      settled = true;
      askConfirm.busy = false;
      cleanup();
      diag("confirm: " + (o.head || "") + " -> " + (v ? "继续" : "取消"));
      resolve(v);
    }
    function onOk() { done(true); }
    function onCancel() { done(false); }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    document.body.classList.add("confirm-open");
    ov.classList.remove("hidden");
    diag("confirm: " + (o.head || "") + " -> 等待用户");
  });
}

/* 扩图超限确认：超过模型原生画布/比例时先问一句，用户点「仍然继续」才入队。
 * 返回 true = 继续；false = 用户选择返回调整。 */
async function confirmOutpaintLimit(inst, snap) {
  if (!inst || inst.id !== "outpaint") return true;
  if (typeof app === "undefined" || !app.activeDocument) return true;
  let W = 0, H = 0;
  try {
    W = Math.round(app.activeDocument.width);
    H = Math.round(app.activeDocument.height);
  } catch (e) { return true; }
  if (!(W > 0 && H > 0)) return true;
  const sides = (typeof expandSidesOf === "function")
    ? expandSidesOf((snap && snap.params && snap.params.expand) || {}, W, H)
    : null;
  if (!sides) return true;
  if (sides.left + sides.right + sides.up + sides.down <= 0) return true;

  const mdl = resolveModel(inst.modelUse);
  const info = (typeof expandLimitInfo === "function")
    ? expandLimitInfo(mdl, W, H, sides.left, sides.right, sides.up, sides.down) : null;
  if (!info || info.ok) return true;

  const px = info.reasons.filter(function (r) { return r.kind === "pixels"; })[0];
  const rt = info.reasons.filter(function (r) { return r.kind === "ratio"; })[0];
  const lines = [];
  lines.push("扩展后画布 " + info.NW + "×" + info.NH + " 超出「" + modelLabelFor(mdl) + "」的原生处理能力。");
  if (px) {
    lines.push("");
    lines.push("· 超过上限 " + px.limit + "px（当前 " + px.actual + "px，多出 " + px.over + "px）");
    lines.push("接口会先把参考图缩小、生成后再放大：细节和边缘容易发糊，扩展区也更容易跑偏。");
    lines.push("建议每边少扩约 " + Math.ceil(px.over / 2) + "px，或改用支持更大画布的模型。");
  }
  if (rt) {
    lines.push("");
    lines.push("· 长宽比 " + rt.actual.toFixed(1) + ":1 超过该模型支持的 " +
      (Math.round(rt.limit * 10) / 10) + ":1");
    lines.push("原图区域可能无法精确对齐；建议减小单侧扩展，或换 nano-banana-2 系列（最高 8:1）。");
  }
  lines.push("");
  lines.push("是否仍然继续？");

  return await askConfirm({
    head: "扩图超出模型上限",
    title: "这张图会先缩小再放大，效果可能打折",
    text: lines.join("\n"),
    okText: "仍然继续",
    cancelText: "返回调整"
  });
}

async function enqueueCurrentRun() {
  const inst = currentInstance();
  if (!inst) return null;
  if (!IS_UXP) { log("浏览器预览无法运行，请在 Photoshop 面板中操作", "err"); return null; }
  if (!app.activeDocument) { log("请先打开一个文档", "err"); return null; }
  if (inst.wip) { log(inst.wip, "err"); return null; }

  const snap = captureSnapshot(inst);
  if (inst.prompt === "required" && !String(snap.userText || "").trim()) {
    log("请先填写提示词", "err");
    return null;
  }
  /* 扩图超过模型原生大小时二次确认：不确认就入队，用户会拿到一张"糊掉再放大"的图 */
  if (inst.id === "outpaint") {
    const go = await confirmOutpaintLimit(inst, snap);
    if (!go) {
      log("已取消：扩图超出模型上限，参数未提交（可调小扩展量后重试）", "info");
      return null;
    }
  }
  const mdl = resolveModel(inst.modelUse);
  const t = {
    id: "t" + (++TASKQ.seq),
    seq: TASKQ.seq,
    instId: inst.id,
    instName: inst.name || inst.id,
    domain: inst.domain || "gen",
    prompt: String(snap.userText || "").slice(0, 40),
    model: modelLabelFor(mdl),
    local: isComfyModel(mdl),
    snap: snap,
    status: "wait",
    phase: "",              /* "" | "gen" | "place" */
    slot: "",               /* cloud | local | edit */
    cancelled: false,
    createdAt: Date.now(), startedAt: 0, endedAt: 0,
    error: "",
    restoreChannel: "",
    hasSel: false,
    selReady: null
  };

  /* 入队那一刻的图层清单：执行时把「之后才出现的图层」临时隐藏，
   * 保证每条任务都用用户点击时的原图，而不是上一条任务写入的结果层。
   * （本地模型跑完再跑云端时，云端曾经拿到本地结果继续改，就是少了这一步） */
  try { t.layerIds = collectLayerIds(app.activeDocument); } catch (e) { t.layerIds = []; }
  /* 文档 id 也固定下来：并发时活动文档可能被别的任务切走 */
  try { t.docId = app.activeDocument.id; } catch (e) { t.docId = null; }

  /* 编辑类必须把「点击那一刻的选区」存成通道：
   * 真正执行时用户可能已经换了选区，直接跑会改错地方。 */
  if (t.domain === "edit") {
    let selNow = null;
    try { selNow = await getSelectionBounds(); } catch (e) { selNow = null; }
    t.hasSel = !!selNow;
    /* 区域也按入队那一刻固定下来：执行时用户可能已经取消/换了选区 */
    t.selBounds = selNow ? {
      left: selNow.left, top: selNow.top, right: selNow.right, bottom: selNow.bottom,
      width: selNow.width, height: selNow.height, fromLayer: !!selNow.fromLayer
    } : null;
    t.selReady = captureQueueSelection(t);
  }

  /* 选区是全局状态：带选区的编辑任务独占；只处理整幅画面的编辑任务可以并发 */
  t.slot = taskSlotOf(inst, t.local, t.hasSel);
  TASKQ.list.push(t);
  const ahead = taskQueueActive().length - 1;
  log("已加入队列：" + t.instName + (ahead > 0 ? "（前面还有 " + ahead + " 个）" : ""), "ok");
  renderQueue();
  taskPump();
  return t;
}

/* 队列用过的选区通道及时删掉，别把用户的通道面板弄乱 */
function dropQueueChannel(name) {
  if (!name) return Promise.resolve();
  return execModal(async function () {
    await batchPlay([{ _obj: "delete", _target: [{ _ref: "channel", _name: name }] }]);
  }, "PS Spark: 清理队列选区", 1).catch(function () { /* 通道可能已被删/文档已关 */ });
}

/* 把当前选区复制成通道（队列任务执行时再还原），返回通道名 */
function captureQueueSelection(t) {
  const name = "pssparkQ" + t.id;
  return execModal(async function () {
    await batchPlay([{
      _obj: "duplicate",
      _target: [{ _ref: "channel", _property: "selection" }],
      name: name
    }]);
    diag("queue: 选区已存为通道 " + name);
    return name;
  }, "PS Spark: 保存队列选区", 2).catch(function (e) {
    diag("queue: 保存选区失败 " + ((e && e.message) || e));
    return "";
  });
}

function taskCancel(id) {
  const t = TASKQ.list.filter(function (x) { return x.id === id; })[0];
  if (!t) return;
  if (t.status === "wait") {
    t.status = "cancel";
    t.endedAt = Date.now();
    /* 还没跑的任务也可能已经存了选区通道，顺手清掉 */
    if (t.selReady) t.selReady.then(function (n) { dropQueueChannel(n); });
    renderQueue();
    log("已取消（还没开始）：" + t.instName);
    return;
  }
  if (t.status === "run") {
    t.cancelled = true;
    const alone = TASKQ.list.filter(function (x) { return x.status === "run"; }).length <= 1;
    /* 只有它一条在跑才真中断网络：多路并发时 abort 会把别人的请求一起打断 */
    if (alone) {
      TASKQ.cancelId = t.id;
      try { abortRun(); } catch (e) { /* ignore */ }
    }
    t.status = "cancel";
    t.phase = "";
    t.endedAt = Date.now();
    log("正在取消：" + t.instName + (alone ? "（中断在途请求与轮询）" : "（已停止落图，在途请求让它自己结束）"), "err");
    renderQueue();
    taskPump();   /* 槽位立刻腾出来给后面的任务 */
  }
}

function taskCancelAll() {
  const act = taskQueueActive();
  if (!act.length) return;
  act.forEach(function (t) {
    if (t.status === "wait") taskCancel(t.id);
  });
  /* 并发时可能有多条在跑：全部标记取消，再统一中断一次请求 */
  const runs = act.filter(function (t) { return t.status === "run"; });
  if (!runs.length) return;
  runs.forEach(function (t) {
    t.cancelled = true;
    t.status = "cancel";
    t.phase = "";
    t.endedAt = Date.now();
  });
  TASKQ.cancelId = runs[0].id;
  try { abortRun(); } catch (e) { /* ignore */ }
  log("已取消全部（运行中 " + runs.length + " 条）", "err");
  renderQueue();
  taskPump();
}

function taskClearDone() {
  TASKQ.list = TASKQ.list.filter(function (t) { return t.status === "wait" || t.status === "run"; });
  renderQueue();
}

/* 调度器：按槽位放行任务（云端 2、本地 1、编辑 1），不为每条任务起定时器 */
function taskPump() {
  const active = TASKQ.list.filter(function (t) { return t.status === "run"; });
  const used = { cloud: 0, local: 0, edit: 0 };
  active.forEach(function (t) { used[t.slot || "cloud"]++; });
  TASKQ.list.forEach(function (t) {
    if (t.status !== "wait" || t.cancelled) return;
    const slot = t.slot || "cloud";
    const cap = TASKQ.limits[slot] || 1;
    if (used[slot] >= cap) return;
    used[slot]++;
    startTask(t);
  });
  renderQueue();
}

function taskCanceledError() {
  const e = new Error("已取消");
  e.canceled = true;
  return e;
}

/* 落图闸门：按入队顺序排队写图层。
 * 生图并发会乱序完成，但「谁先写进画布」必须按队列顺序，否则图层叠放顺序和用户预期的相反。
 * 排在前面且还没结束（wait/run）的任务会让后面的等；前面的取消/失败不挡路。 */
async function waitPlaceTurn(run) {
  const t = run && run.task;
  if (!t) return;                       /* 手动运行不进闸门 */
  if (t.cancelled) throw taskCanceledError();
  if (t.phase !== "place") { t.phase = "place"; renderQueue(); }
  const t0 = Date.now();
  for (;;) {
    if (t.cancelled) throw taskCanceledError();
    const ahead = TASKQ.list.some(function (x) {
      return x !== t && x.seq < t.seq && (x.status === "wait" || x.status === "run");
    });
    if (!ahead) return;
    if (Date.now() - t0 > 6 * 60 * 1000) {
      diag("queue: 等落图超过 6 分钟，先落这条 " + t.id);
      return;
    }
    await sleepMs(120);
  }
}

/* 带闸门的写入：先等轮到它，再进 executeAsModal（PS 同一时刻只允许一个模态操作） */
async function placeWithGate(run, commandName, fn) {
  await waitPlaceTurn(run);
  /* 并发时另一条任务可能正占着模态作用域：execModal 遇到 modal 冲突会退避重试 */
  return execModal(fn, commandName, 3);
}

/* 候选落图（队列自动插第 1 张 / 结果卡手点）——同样走闸门 */
async function placeCandidateForRun(run, idx) {
  const c = run && run.cands && run.cands[idx];
  if (!c || !c.entry || c.inserted) return false;
  if (!IS_UXP) throw new Error("请在 Photoshop 面板中运行");
  await waitPlaceTurn(run);
  await execModal(async function () {
    await placeEntryAsLayer(c.entry, run.placeTarget || null, c.layerName || "候选结果", null, run.docId);
    c.layerId = (lastPlacedLayer && lastPlacedLayer.id) || null;
  }, "PS Spark: 插入候选 " + (idx + 1), 2);
  c.inserted = true;
  log("候选 " + (idx + 1) + " 已插入为新图层 ✓", "ok");
  return true;
}

async function startTask(t) {
  t.status = "run";
  t.phase = "gen";
  t.startedAt = Date.now();
  t.error = "";
  renderQueue();

  try {
    /* 用户刚手点过一次运行：等它退出。队列任务之间不再互相等（那是槽位的事） */
    let guard = 0;
    while (MANUAL_RUN && guard++ < 200) await sleepMs(200);

    /* 编辑任务：先把入队时存下的选区还原回来，再跑 */
    if (t.selReady) {
      t.restoreChannel = (await t.selReady) || "";
      if (t.restoreChannel) {
        await execModal(async function () {
          await loadSelectionFromChannel(t.restoreChannel);
        }, "PS Spark: 还原队列选区", 2).catch(function (e) {
          diag("queue: 还原选区失败 " + ((e && e.message) || e));
        });
      } else if (t.hasSel) {
        /* 入队时明明有选区，通道却没存下来：宁可不跑，也不能改到整张画布 */
        throw new Error("入队时的选区未能保存，为避免改错区域已跳过（请重新加入队列）");
      }
    }

    /* 文档关了就别硬跑：否则会改到别的画布上。
     * 只看「原文档还在不在」——并发时活动文档可能被另一条任务切走，不能拿 activeDocument 比较。 */
    if (t.domain === "edit" && t.docId != null) {
      let exists = null;
      try { exists = docById(t.docId); } catch (e) { exists = null; }
      if (!exists) throw new Error("原文档已关闭，编辑任务已跳过（请重新入队）");
    }

    /* 只在没有别的任务在跑时切页，避免多路并发互相抢界面 */
    const activeN = TASKQ.list.filter(function (x) { return x.status === "run"; }).length;
    if (activeN <= 1) {
      const tab = t.domain === "edit" ? "edit" : "gen";
      if (App.tab !== tab) switchTab(tab);
      if (tab === "gen" && App.genInstance !== t.instId) {
        App.genInstance = t.instId;
        renderGenView();
      } else if (tab === "edit" && App.editInstance !== t.instId) {
        App.editInstance = t.instId;
        renderEditView();
      }
    }

    const run = await runCurrentInstance({ instId: t.instId, snapshot: t.snap, fromQueue: true, task: t });

    if (t.cancelled || (run && run.cancelled)) {
      t.status = "cancel";
    } else if (run && run.ok) {
      t.status = "ok";
      /* 多候选不会自动落图：队列里统一插第 1 张，其余留在历史 */
      if (run.cands && run.cands.length && run.cands[0] && !run.cands[0].inserted) {
        try {
          await placeCandidateForRun(run, 0);
          t.note = "已自动插入第 1 张";
          try { refreshResultBlock(); } catch (e) { /* ignore */ }
        } catch (e) {
          if (e && e.canceled) t.status = "cancel";
          else diag("queue: 自动插入失败 " + ((e && e.message) || e));
        }
      }
    } else {
      t.status = "err";
      t.error = (run && run.error) || "未执行（可能有其它运行占用）";
    }
  } catch (e) {
    t.status = (t.cancelled || TASKQ.cancelId === t.id || (e && e.canceled)) ? "cancel" : "err";
    t.error = (e && e.message) || String(e);
  } finally {
    t.endedAt = Date.now();
    t.phase = "";
    if (TASKQ.cancelId === t.id) TASKQ.cancelId = null;
    if (t.restoreChannel) {
      await dropQueueChannel(t.restoreChannel);
      t.restoreChannel = "";
    }
    /* 只留最近 20 条历史，避免面板越用越卡 */
    const done = TASKQ.list.filter(function (x) { return x.status !== "wait" && x.status !== "run"; });
    if (done.length > 20) {
      const drop = done.slice(0, done.length - 20).map(function (x) { return x.id; });
      TASKQ.list = TASKQ.list.filter(function (x) { return drop.indexOf(x.id) < 0; });
    }
    renderQueue();
    taskPump();
  }
}

function taskQueueRow(t) {
  const row = el("div", "q-row " + t.status);
  row.appendChild(el("span", "q-dot"));
  const main = el("div", "q-main");
  main.appendChild(el("div", "q-title", t.instName + (t.local ? " · 本地" : "")));
  const sub = [];
  if (t.prompt) sub.push(t.prompt);
  sub.push(t.model);
  if (t.status === "ok" && t.endedAt) sub.push(Math.round((t.endedAt - t.startedAt) / 1000) + "s");
  if (t.status === "err" && t.error) sub.push(String(t.error).slice(0, 40));
  else if (t.note) sub.push(t.note);
  main.appendChild(el("div", "q-sub", sub.join(" · ")));
  row.appendChild(main);
  const stateText = (t.status === "run" && t.phase === "place")
    ? "待落图"
    : (TASK_STATUS_TEXT[t.status] || t.status);
  row.appendChild(el("span", "q-state", stateText));
  if (t.status === "wait" || t.status === "run") {
    const x = el("button", "q-x", "×");
    x.type = "button";
    x.title = "取消这个任务";
    x.addEventListener("click", function () { taskCancel(t.id); });
    row.appendChild(x);
  }
  return row;
}

function renderQueue() {
  const wrap = $("queueWrap");
  if (!wrap) return;
  wrap.classList.toggle("hidden", !TASKQ.list.length);
  wrap.classList.toggle("collapsed", !TASKQ.open);
  if ($("qCaret")) $("qCaret").textContent = TASKQ.open ? "▾" : "▸";
  const act = taskQueueActive();
  const runT = act.filter(function (t) { return t.status === "run"; })[0];
  const waitN = act.filter(function (t) { return t.status === "wait"; }).length;
  if ($("queueSummary")) {
    const doneN = TASKQ.list.length - act.length;
    if (act.length) {
      const runN = act.length - waitN;
      $("queueSummary").textContent = "队列 " + act.length + " 项" +
        (runN ? (" · 运行 " + runN) : "") + (waitN ? (" · 等待 " + waitN) : "");
    } else {
      $("queueSummary").textContent = doneN ? ("队列空闲 · 最近 " + doneN + " 条") : "队列空闲";
    }
  }
  const host = $("queueList");
  if (!host) return;
  host.innerHTML = "";
  TASKQ.list.slice(-8).forEach(function (t) { host.appendChild(taskQueueRow(t)); });
  if (TASKQ.list.length > 8) {
    host.appendChild(el("div", "q-more", "只显示最近 8 条，共 " + TASKQ.list.length + " 条"));
  }
  syncScrollGutter();
}

async function runCurrentInstance(opts) {
  const fromQueue = !!(opts && opts.fromQueue);

  /* 手动点击：队列在跑时不再接受（按钮此时显示「加入队列」） */
  if (!fromQueue) {
    if (running) return null;
    MANUAL_RUN = true;
  }

  /* 按 id 取实例：并发时界面可能已经切到别的功能，currentInstance() 不可靠 */
  const inst = (opts && opts.instId) ? instById(opts.instId) : currentInstance();
  if (!inst) { if (!fromQueue) MANUAL_RUN = false; return null; }
  if (!IS_UXP) {
    log("当前是浏览器预览环境，请在 Photoshop 面板中运行", "err");
    if (!fromQueue) MANUAL_RUN = false;
    return null;
  }
  if (!app.activeDocument) { log("请先打开一个文档", "err"); if (!fromQueue) MANUAL_RUN = false; return null; }
  if (inst.wip) { log(inst.wip, "err"); if (!fromQueue) MANUAL_RUN = false; return null; }

  const snap = (opts && opts.snapshot) || captureSnapshot(inst);
  if (inst.prompt === "required" && !(snap.userText || "").trim()) {
    log("请先填写提示词", "err");
    if (!fromQueue) MANUAL_RUN = false;
    return null;
  }

  /* 单次运行的上下文：并发生成时不能再把图层名/参考图写进全局变量，
     否则两条任务的 UI 状态会互相覆盖。pipeline 统一读写 run.* */
  const run = {
    id: "r" + (++RUN_SEQ),
    instId: inst.id,
    task: (opts && opts.task) || null,
    docId: null,
    layerName: "",
    exportUri: null,
    cands: null,
    entry: null,
    placeTarget: null,
    layerId: null,
    ok: false,
    cancelled: false,
    error: "",
    secs: null,
    job: null,
    multi: false
  };

  /* 每条运行开始时清取消标志：上一条的取消不能把新启动的任务秒杀
     （被取消的那条已经 abort 掉在途 XHR；本地轮询最多多跑一会儿，落图仍会被闸门拦住） */
  try { resetRunAbort(); } catch (e) { /* ignore */ }

  setRunning(true);
  refreshResultBlock();
  setTimeout(scrollResultIntoView, 80);
  const t0 = Date.now();
  diag("=== run start, inst=" + inst.id + (opts && opts.fromRegen ? " (regen)" : "") +
    (fromQueue ? " (queue " + (run.task ? run.task.id : "") + ")" : "") + " ===");

  let job = null;
  try { job = storeCreateJob(inst, snap, resolveModel(inst.modelUse)); } catch (e) { diag("store create warn: " + e.message); }
  run.job = job;

  try {
    const key = await getImageKey();
    if (!key) throw new Error("请先在设置 ▸ 服务接入中配置图像服务 API Key");

    /* 并发时活动文档可能被另一条任务切走：队列任务优先按入队时的文档 id 取 */
    const doc = (fromQueue && opts && opts.task && opts.task.docId != null)
      ? (docById(opts.task.docId) || app.activeDocument)
      : app.activeDocument;
    /* 队列任务用入队那一刻的选区（避免执行前用户改选区导致改错区域） */
    let sel = (fromQueue && opts && opts.task && opts.task.selBounds !== undefined)
      ? opts.task.selBounds
      : await getSelectionBounds();
    /* 无选区时的「图层级处理」：擦除等声明了 noSelArea:"layer" 的功能，
     * 自动以当前选中图层的像素范围为处理区域（选区=图层范围） */
    if (!sel && inst.noSelArea === "layer") {
      sel = await getActiveLayerBounds();
      if (sel) {
        log("未框选区域：以当前图层的范围（" + Math.round(sel.width) + "×" + Math.round(sel.height) + "）为处理区域");
      } else {
        log("未框选、也无可用的图层范围（需选中一个普通图层）→ 将对整个画面执行");
      }
    }
    const ctx = { sel: sel, docW: doc.width, docH: doc.height, docId: doc.id, run: run };
    run.docId = doc.id;
    if (inst.selection === "required" && !sel) {
      /* 局部重绘声明了 noSelArea:"canvas"：没框选就按整幅画面重绘（整图 i2i），
       * 而不是直接拒绝 —— 用户在没有选区时最想要的就是「先整张改一版」。 */
      if (inst.noSelArea === "canvas") {
        log("未框选区域：按整幅画面重绘（选区外无法单独保护；只想改局部请先框选）", "info");
      } else {
        throw new Error("此功能需要选区：请先用选区工具框出区域");
      }
    }

    const refs = filledRefSlots(inst, snap);
    const missing = [];
    (inst.slots || []).forEach(function (s) {
      if (s.required && !s.implicit) {
        const arr = slotItems(snap, s.role);
        const min = (s.count && s.count.min) || 1;
        if (arr.length < min) missing.push(s.label);
      }
    });
    if (missing.length) throw new Error("请先添加：" + missing.join("、"));

    let result = null;
    const nVar = variantsOf(inst, snap);
    if (inst.id === "composite") {
      result = await execComposite(inst, snap, ctx);
    } else if (inst.id === "outpaint") {
      result = await execOutpaint(inst, snap, ctx);
    } else if (inst.domain === "gen" && nVar > 1) {
      /* 多候选：并发生成 n 张，结果卡网格选一张插入（编辑域不受影响） */
      let uris = [], target = null;
      if (inst.refMain || refs.length) {
        const main = await exportMainForRefs(inst, ctx);
        uris = [main.uri].concat(refs.map(function (r) { return r.item.uri; }));
        target = { left: main.eb.left, top: main.eb.top, width: main.w, height: main.h };
      }
      log("候选张数 " + nVar + "：并发请求中…");
      result = await runGenerationsMulti(inst, snap, ctx, nVar, uris, target);
    } else if (inst.modelUse === "gen" && (refs.length || inst.refMain)) {
      /* 相似图（主源为参考）/ 合成迁移类（主源 + 参考图）→ generations（image[] 多图） */
      const main = await exportMainForRefs(inst, ctx);
      result = await runGenerationsWithRefs(inst, snap, main, [main.uri].concat(refs.map(function (r) { return r.item.uri; })), ctx);
    } else if (inst.modelUse === "gen") {
      result = await runGenerationsPlain(inst, snap, ctx);
    } else if (refs.length) {
      const main = await exportMainForRefs(inst, ctx);
      result = await runGenerationsWithRefs(inst, snap, main, [main.uri].concat(refs.map(function (r) { return r.item.uri; })), ctx);
    } else {
      result = await runEditPipeline(inst, snap, ctx);
    }

    const secs = Math.round((Date.now() - t0) / 1000);
    const multiCands = (result && result.cands) ? result.cands : null;
    log("完成 ✓（总耗时 " + secs + " 秒）" + (multiCands ? (" · " + multiCands.length + " 张候选待选") : ""), "ok");

    run.secs = secs;
    run.cands = multiCands;
    run.entry = (result && result.entry) ? result.entry : null;
    run.placeTarget = (result && result.placeTarget) ? result.placeTarget : null;
    run.multi = !!(result && result.multi);
    run.ok = true;
    if (!run.layerName) run.layerName = lastLayerName;

    /* 此刻才同步全局：界面只展示「最近一条」，并发时不互相污染 */
    lastExportUri = run.exportUri;
    lastLayerName = run.layerName;

    lastRun = {
      instId: inst.id, snap: snap,
      statusText: "成功 · 用时 " + secs + " 秒" + (multiCands ? (" · 已生成 " + multiCands.length + " 张候选" + (multiCands.length > 1 ? "，选择一张插入" : "")) : ""),
      level: "ok",
      secs: secs, layerName: run.layerName,
      thumbUri: null,
      exportUri: run.exportUri,
      entry: run.entry,
      placeTarget: run.placeTarget,
      /* 候选列表（多候选待选 / 单张已插入）——统一由结果卡渲染 */
      cands: multiCands || (run.entry
        ? [{ entry: run.entry, fileName: "psspark_result.png", url: null, thumbUri: null, inserted: true, layerName: run.layerName, layerId: run.layerId || null }]
        : []),
      layerId: run.layerId || null,
      multi: run.multi,
      docId: ctx.docId,
      job: job, jobId: job ? job.id : null
    };
    refreshResultBlock();
    loadCandsThumbs(lastRun);
    try {
      const entriesForStore = multiCands
        ? multiCands.map(function (c) { return { entry: c.entry, fileName: c.fileName }; })
        : (run.entry ? [{ entry: run.entry, fileName: "psspark_result.png" }] : []);
      await storeCompleteJob(job, entriesForStore, {
        layerName: run.layerName, secs: secs,
        placeTarget: run.placeTarget,
        prompt: buildFinalPrompt(inst, snap.userText, null, snap.params, snap.tplOverride, (result && result.extra) || null)
      });
    } catch (e) { diag("store complete warn: " + e.message); }
  } catch (e) {
    diag("run caught: " + ((e && e.stack) || String(e)));
    const msg = (e && e.message) ? e.message : String(e);
    run.ok = false;
    run.error = msg;
    run.cancelled = !!(e && e.canceled) || !!(run.task && run.task.cancelled) || /^已取消$/.test(msg);
    if (!run.cancelled) log("失败: " + msg, "err");
    lastRun = {
      instId: inst.id, snap: snap,
      statusText: (run.cancelled ? "已取消" : ("失败：" + msg)), level: run.cancelled ? "err" : "err",
      secs: null, layerName: "", thumbUri: null, exportUri: null,
      entry: null, placeTarget: null, job: job, jobId: job ? job.id : null
    };
    refreshResultBlock();
    try { storeFailJob(job, run.cancelled ? "已取消" : msg); } catch (e2) { diag("store fail warn: " + e2.message); }
  } finally {
    /* 先落计数再清进度：还有别的路在跑时，别把它的进度条清掉 */
    setRunning(false);
    if (!running) stopProgress();
    refreshResultBlock();
    setTimeout(scrollResultIntoView, 80);
    if (!fromQueue) MANUAL_RUN = false;
    diag("=== run end ===");
  }
  return run;
}

/* 主源导出要排除的「输入污染层」：本次会话里本插件落过的结果层。
 * 不排除的话，连跑相似图/扩图就是在上一次输出上继续改（越跑越偏）。
 * 用户当前选中的层由 hideLayersNotIn 内部保护。 */
function sourcePollutionIds(doc) {
  try { if (typeof prunePluginResultLayers === "function") prunePluginResultLayers(doc); } catch (e) { /* ignore */ }
  try { return (typeof pluginResultLayerIds === "function") ? pluginResultLayerIds() : []; } catch (e) { return []; }
}

/* 主源导出（画布或选区，供参考图路由使用），返回 { uri, eb, w, h } */
/* 用「入队那一刻的画面」导出：把入队之后才出现的图层（上一条任务的结果）临时隐藏，
 * 导出完立刻恢复。必须在 executeAsModal 里调用，隐藏窗口只有几十毫秒。 */
async function withSourceSnapshot(ctx, fn) {
  const keep = (ctx && ctx.run && ctx.run.task && ctx.run.task.layerIds) || null;
  const doc = (ctx && ctx.docId != null) ? docById(ctx.docId) : app.activeDocument;
  const hidden = await hideLayersNotIn(doc, keep, sourcePollutionIds(doc));
  try {
    return await fn();
  } finally {
    if (hidden.length) await restoreLayerVisibility(doc, hidden);
  }
}

async function exportMainForRefs(inst, ctx) {
  const eb = computeExportBounds(ctx.sel, ctx.docW, ctx.docH, false);
  let entry = null, w = 0, h = 0;
  await core.executeAsModal(async function () {
    /* 并发时活动文档可能被另一条任务切走：先按 id 切回，再导出 */
    if (!ensureActiveDoc(ctx.docId)) throw new Error("未能定位原文档（文档可能已被关闭）");
    log("导出主源图像 " + Math.round(eb.width) + "×" + Math.round(eb.height) + " ...");
    const ex = await withSourceSnapshot(ctx, function () { return exportRegionToPNG(eb, null); });
    entry = ex.entry; w = ex.actualW; h = ex.actualH;
  }, { commandName: "PS Spark: 导出主源" });
  const uri = await fileToDataURI(entry);
  setRunExportUri(ctx, uri); /* 供结果卡"参考图"缩略图展示 */
  return { uri: uri, eb: eb, w: w, h: h };
}

/* 统一端点请求体（nano-banana 系列）：
 * {model, prompt, images[], aspectRatio, imageSize?, quality?, background?}
 * sizeOverride：编辑/扩图/拆图类必须传 "auto"，让输出保持输入图比例（回贴才不会被拉伸）。 */
function buildUnifiedPayload(model, prompt, images, snap, sizeOverride) {
  const sp = (snap && snap.params) ? snap.params : {};
  const p = {
    model: model,
    prompt: prompt,
    images: images || [],
    aspectRatio: sizeOverride || normalizeSizeForModel(model, sp.size || "auto")
  };
  const isz = normalizeImageSizeForModel(model, sp.imageSize);
  if (isz) p.imageSize = isz;
  const q = normalizeQualityForModel(model, sp.quality);
  if (q) p.quality = q;
  if (sp.transparent) p.background = "transparent";
  return p;
}

/* ================= 生成域 · 多候选（默认 3 张备选） ================= */

/* 候选文件命名：i=0 → psspark_result.png；i>0 → psspark_cand_<i+1>.png（与归档/历史一致） */
function candFileName(i) {
  return i === 0 ? "psspark_result.png" : ("psspark_cand_" + (i + 1) + ".png");
}

/* Promise.allSettled 的最小实现（不依赖运行环境支持） */
async function genAllSettled(tasks) {
  const out = [];
  await Promise.all(tasks.map(function (p, i) {
    return p.then(
      function (v) { out[i] = { ok: true, value: v }; },
      function (e) { out[i] = { ok: false, reason: e }; }
    );
  }));
  return out;
}

/* 单次生成请求 → 结果图 URL。
 * uris：参考图数组（文生图 = []）。
 * 说明：generations 端点用大写 Background、统一端点用小写 background——各自保持既有行为。 */
async function requestGenerationOnce(mdl, prompt, uris, snap, probe) {
  if (isComfyModel(mdl)) {
    /* 本地参考图：单张走图生图（预设必须有 INPUT 节点，内置「Klein 4B 参考图」即是）。
       多图拼合需要多个 LoadImage 槽，当前角色模型只有一个 input，明确拒绝而不是丢图。 */
    if (uris && uris.length > 1) {
      throw new Error("本地 ComfyUI 目前只支持 1 张参考图；多图拼合请切回云端模型");
    }
    const params = Object.assign({}, snap.params || {});
    if (uris && uris[0]) params.imageUri = uris[0];
    const need = (uris && uris.length) ? "i2i" : "t2i";
    const cid = comfyResolvePresetId(mdl, need);
    const cp = getComfyPreset(cid);
    if (!cp || comfySanitizeCaps(cp).indexOf(need) < 0) {
      throw new Error(need === "i2i"
        ? "本地模型没有「参考图」工作流：设置 ▸ 本地 ComfyUI 添加「Klein 4B 参考图」模板"
        : "本地模型没有「文生图」工作流：设置 ▸ 本地 ComfyUI 添加「Klein 4B 文生图」模板");
    }
    diag("comfy: 选中 " + cp.name + "（" + need + "）");
    return await callComfyUI(prompt, params, cid, probe || null);
  }
  if (isNanoModel(mdl)) {
    return (await callUnifiedGenerate(buildUnifiedPayload(mdl, prompt, uris || [], snap, null))).url;
  }
  const payload = {
    model: mdl,
    prompt: prompt,
    size: normalizeSizeForModel(mdl, snap.params.size || "auto"),
    quality: normalizeQualityForModel(mdl, snap.params.quality || "auto")
  };
  if (snap.params.transparent) payload.Background = "transparent";
  if (uris && uris.length) payload.image = uris;
  return (await callApi("/v1/images/generations", payload, false)).url;
}

/* 多候选：并发 n 次请求（失败不整体中断）+ 串行下载，返回 { cands, multi, placeTarget }。
 * 候选生成后不自动插入——由结果卡网格让用户「选一张插入」，其余已在内存/磁盘候着。 */
async function runGenerationsMulti(inst, snap, ctx, n, uris, target, extra) {
  const prompt = buildFinalPrompt(inst, snap.userText, null, snap.params, snap.tplOverride, extra);
  diag("prompt: " + prompt.slice(0, 400));
  const mdl = resolveModel("gen");
  diag("multi: " + n + " 张候选并发（" + ((uris && uris.length) ? ("参考图 " + uris.length + " 张") : "文生图") + "）");

  /* 按设置的分批并发（并发请求数可调，默认 3），失败不整体中断 */
  const conc = Math.max(1, Math.min(getConcurrency(), n));
  const urls = [], errs = [];
  for (let b = 0; b < n; b += conc) {
    const batchN = Math.min(conc, n - b);
    startProgress("生成候选 " + (b + 1) + "–" + (b + batchN) + "/" + n + "（并发 " + batchN + " 路）");
    const tasks = [];
    const probe = (typeof runAbortProbe === "function") ? runAbortProbe(ctx) : null;
    for (let i = 0; i < batchN; i++) tasks.push(requestGenerationOnce(mdl, prompt, uris, snap, probe));
    const settled = await genAllSettled(tasks);
    settled.forEach(function (r, i) {
      if (r && r.ok && r.value) urls.push(r.value);
      else errs.push("第 " + (b + i + 1) + " 张：" + ((r && r.reason && r.reason.message) || (r && r.reason) || "失败"));
    });
  }
  if (!urls.length) throw new Error("全部候选生成失败 —— " + errs.join("；"));
  if (errs.length) log("部分候选失败：" + errs.join("；"), "err");

  const cands = [];
  for (let i = 0; i < urls.length; i++) {
    startProgress("下载候选 " + (i + 1) + "/" + urls.length);
    try {
      const fileName = candFileName(i);
      const entry = await downloadResultToEntry(urls[i], fileName);
      cands.push({
        entry: entry, fileName: fileName, url: urls[i], thumbUri: null, inserted: false,
        layerName: layerNameFor(inst, snap.userText || prompt) + (urls.length > 1 ? " #" + (i + 1) : "")
      });
    } catch (e) {
      errs.push("第 " + (i + 1) + " 张下载：" + ((e && e.message) || String(e)));
      log("候选 " + (i + 1) + " 下载失败：" + ((e && e.message) || String(e)), "err");
    }
  }
  if (!cands.length) throw new Error("候选下载全部失败 —— " + errs.join("；"));

  setRunLayerName(ctx, cands[0].layerName);
  log("已生成 " + cands.length + " 张候选 —— 请在结果卡中选择一张插入（其余已存入历史）", "ok");
  return { cands: cands, multi: true, entry: null, placeTarget: target || null };
}

/* 文生图（无参考图 → generations 纯文本 / 本地 ComfyUI） */
async function runGenerationsPlain(inst, snap, ctx, extra) {
  const prompt = buildFinalPrompt(inst, snap.userText, null, snap.params, snap.tplOverride, extra);
  diag("prompt: " + prompt.slice(0, 400));
  const mdl = resolveModel("gen");
  let r;
  if (isComfyModel(mdl)) {
    /* 本地工作流返回 /view 地址，后面下载 + 置入与云端同一套 */
    const cid = comfyResolvePresetId(mdl, "t2i");
    const cp = getComfyPreset(cid);
    if (!cp || comfySanitizeCaps(cp).indexOf("t2i") < 0) {
      throw new Error("本地模型没有「文生图」工作流：设置 ▸ 本地 ComfyUI 添加「Klein 4B 文生图」模板");
    }
    diag("路由：本地 ComfyUI（文生图）preset=" + cp.name);
    r = { url: await callComfyUI(prompt, snap.params || {}, cid, runAbortProbe(ctx)) };
  } else if (isNanoModel(mdl)) {
    diag("路由：统一端点 /v1/api/generate（文生图）");
    r = await callUnifiedGenerate(buildUnifiedPayload(mdl, prompt, [], snap, null));
  } else {
    const payload = {
      model: mdl,
      prompt: prompt,
      size: normalizeSizeForModel(mdl, snap.params.size || "auto"),
      quality: normalizeQualityForModel(mdl, snap.params.quality || "auto")
    };
    if (snap.params.transparent) payload.Background = "transparent";
    r = await callApi("/v1/images/generations", payload, false);
  }
  const name = layerNameFor(inst, snap.userText || prompt);
  setRunLayerName(ctx, name);
  let entry = null;
  await placeWithGate(ctx && ctx.run, "PS Spark: 写入结果", async function () {
    entry = await placeResultAsLayer(r.url, null, name, null, ctx && ctx.docId);
    if (ctx && ctx.run) ctx.run.layerId = (lastPlacedLayer && lastPlacedLayer.id) || null;
  });
  return { entry: entry, placeTarget: null };
}

/* 参考图路由（相似图 / 合成类 / 原位合成）：image[] 多图 → generations → 回贴导出区域 */
async function runGenerationsWithRefs(inst, snap, main, uris, ctx, extra) {
  const prompt = buildFinalPrompt(inst, snap.userText, null, snap.params, snap.tplOverride, extra);
  diag("prompt: " + prompt.slice(0, 400));
  diag("refs: " + uris.length + " 张（generations image[]）");
  const mdl = resolveModel("gen");
  let r;
  if (isComfyModel(mdl)) {
    if (!uris || !uris.length) throw new Error("本地参考图缺少输入图");
    if (uris.length > 1) throw new Error("本地 ComfyUI 目前只支持 1 张参考图；多图拼合请切回云端模型");
    const cid = comfyResolvePresetId(mdl, "i2i");
    const cp = getComfyPreset(cid);
    if (!cp || comfySanitizeCaps(cp).indexOf("i2i") < 0) {
      throw new Error("本地模型没有「参考图」工作流：设置 ▸ 本地 ComfyUI 添加「Klein 4B 参考图」模板");
    }
    diag("路由：本地 ComfyUI（参考图 1 张）preset=" + cp.name);
    r = { url: await requestGenerationOnce(mdl, prompt, uris, snap, runAbortProbe(ctx)) };
  } else if (isNanoModel(mdl)) {
    diag("路由：统一端点 /v1/api/generate（参考图 " + uris.length + " 张）");
    r = await callUnifiedGenerate(buildUnifiedPayload(mdl, prompt, uris, snap, null));
  } else {
    const payload = {
      model: mdl,
      prompt: prompt,
      size: normalizeSizeForModel(mdl, snap.params.size || "auto"),
      quality: normalizeQualityForModel(mdl, snap.params.quality || "auto"),
      image: uris
    };
    if (snap.params.transparent) payload.Background = "transparent";
    r = await callApi("/v1/images/generations", payload, false);
  }
  const name = layerNameFor(inst, snap.userText || prompt);
  setRunLayerName(ctx, name);
  const target = main && main.eb ? { left: main.eb.left, top: main.eb.top, width: main.w, height: main.h } : null;
  let entry = null;
  await placeWithGate(ctx && ctx.run, "PS Spark: 写入结果", async function () {
    entry = await placeResultAsLayer(r.url, target, name, null, ctx && ctx.docId);
    if (ctx && ctx.run) ctx.run.layerId = (lastPlacedLayer && lastPlacedLayer.id) || null;
  });
  return { entry: entry, placeTarget: target };
}

/* 整图重绘模式的补充要求（本地模型能力弱时用：靠蒙版裁切保证只改选区） */
const WHOLE_REDRAW_PROMPT =
  "这是整张画面（不是局部小图）：只修改前面描述的内容，画面其余部分（构图、背景、其它物体、光影、色调）保持与输入图完全一致，不要重画整张图。\n" +
  "输出必须是一张完整、连续、边缘清晰的图像：不要出现矩形接缝、边框、白边、黑边或色边；修改区域要自然融入周围（轮廓清晰、过渡柔和），不要有模糊斑块或明显的贴图感。";

/* 编辑管线（选区/画布区域 → edits + mask → 1:1 回贴 + 可选色框/裁剪）。
 * extra（可选）：{ modelUse: "edit" } 覆盖模型用途；{ hasAsset: false } 供提示词模板区分模式。 */
async function runEditPipeline(inst, snap, ctx, extra) {
  const sel = ctx.sel;
  /* 模型先定：本地 ComfyUI 有自己的蒙版通道，不需要（也不应该）在输入图上画色框。
     色框只服务云端「无蒙版、靠视觉定位」的模型；画给本地模型会被当成画面内容保留下来。 */
  const mdl = resolveModel((extra && extra.modelUse) ? extra.modelUse : inst.modelUse);
  /* 色框只服务云端「无蒙版、靠视觉定位」的模型；本地有自己的蒙版通道。
     注意：仍要按色框模式扩大导出范围（保留上下文），只是不画那圈线。 */
  const wantBox = !!(sel && inst.locate && inst.locate.indexOf("box") >= 0 && snap.locate.box);
  const useBox = wantBox && !isComfyModel(mdl);
  const useMask = !!(sel && inst.mask !== "none");
  const useClip = !!(sel && inst.locate && inst.locate.indexOf("clip") >= 0 && snap.locate.clip);
  /* 本地 ComfyUI 局部重绘：默认走「扩大区域 → 整图重绘 → 蒙版合成」。
   * 原因：本地工作流多数只是把生成图直接贴回蒙版区域，模型能力弱时会出现
   * 白底/硬边框/只改一小块的问题；整图重绘能拿到光照一致的完整画面，再用蒙版裁回选区。 */
  let localWhole = !!(sel && !sel.fromLayer && inst.domain === "edit" &&
    isComfyModel(mdl) && useMask && comfyWholeRedraw());
  if (localWhole) {
    /* 整图重绘要用「参考图」工作流；只有局部重绘模板时不硬撑，直接退回蒙版模式 */
    const probeId = comfyResolvePresetId(mdl, "i2i");
    const probeP = probeId ? getComfyPreset(probeId) : null;
    if (!probeP || comfySanitizeCaps(probeP).indexOf("i2i") < 0) {
      diag("comfy: 整图重绘需要「参考图」工作流，当前模型没有 → 退回工作流自带蒙版");
      log("提示：本地模型没有「参考图」工作流，本次改用工作流自带蒙版（设置 ▸ 本地 ComfyUI 可加「参考图」模板）", "err");
      localWhole = false;
    }
  }
  const eb = localWhole
    ? computeWholeRedrawBounds(sel, ctx.docW, ctx.docH)
    : computeExportBounds(sel, ctx.docW, ctx.docH, wantBox);
  const relRect = sel ? {
    left: sel.left - eb.left, top: sel.top - eb.top,
    right: sel.right - eb.left, bottom: sel.bottom - eb.top,
    width: sel.width, height: sel.height
  } : null;
  const CH = "pssparkSelClip" + ((ctx && ctx.run && ctx.run.id) ? ctx.run.id : "");
  let channelCreated = false, channelHandled = false;
  let imgEntry = null, maskEntry = null, color = null, exW = 0, exH = 0;
  let resultEntry = null;

  startProgress("导出参考图与蒙版");
  try {
    await core.executeAsModal(async function () {
      /* 并发时活动文档可能被另一条任务切走：先按 id 切回 */
      if (!ensureActiveDoc(ctx.docId)) throw new Error("未能定位原文档（文档可能已被关闭）");
      /* sel.fromLayer = 图层范围（非真实选区）：没有可保存的选区通道，跳过裁剪/蒙版链路 */
      if (sel && !sel.fromLayer) {
        diag("step: save selection to channel");
        try {
          await batchPlay([{ _obj: "duplicate", _target: [{ _ref: "channel", _property: "selection" }], name: CH }]);
          channelCreated = true;
        } catch (eCh) {
          diag("step: 保存选区到通道失败（按无裁剪处理）: " + ((eCh && eCh.message) || String(eCh)));
        }
      }
      /* 整图重绘必须靠这个通道把结果裁回选区；通道没建成 → 退回工作流蒙版，避免整块区域被替换 */
      if (localWhole && !channelCreated) {
        diag("comfy: 选区通道保存失败 → 整图重绘无法裁切，退回工作流蒙版");
        log("⚠ 本次没能保存选区通道，改用工作流自带蒙版（结果可能仍有硬边）", "err");
        localWhole = false;
      }
      log(`导出区域图像 ${Math.round(eb.width)}×${Math.round(eb.height)}${useBox ? "（含上下文+色框）" : ""} ...`);
      const ex = await withSourceSnapshot(ctx, function () {
        return exportRegionToPNG(eb, (useBox && relRect) ? { relRect: relRect } : null);
      });
      imgEntry = ex.entry; color = ex.color; exW = ex.actualW; exH = ex.actualH;
      if (useMask && !localWhole && !(sel && sel.fromLayer)) {
        log("生成选区蒙版...");
        maskEntry = (await buildMaskPNG(eb, null, channelCreated ? CH : "")).entry; /* 用本次运行自己的选区通道 */
      }
    }, { commandName: "PS Spark: 导出选区与蒙版" });

    let prompt = buildFinalPrompt(inst, snap.userText, color, snap.params, snap.tplOverride, extra);
    /* 整图重绘模式：明确告诉模型「这是整张图，只改描述的部分」，并要求边缘干净 */
    if (localWhole) prompt = prompt + "\n\n" + WHOLE_REDRAW_PROMPT;
    diag("prompt: " + prompt.slice(0, 400));
    const imgUri = await fileToDataURI(imgEntry);
    setRunExportUri(ctx, imgUri); /* 供结果卡"参考图"缩略图展示（可见色框标记） */
    let r;
    if (isComfyModel(mdl)) {
      /* 本地局部重绘：图 + 蒙版都上传，工作流里由 INPUT / MASK 两个节点接收。
         同一模型可能有多条工作流：这里按能力挑（inpaint / i2i），不要求用户先去设里选。
         整图重绘模式不传蒙版：让模型按完整画面重绘，落图后再用选区蒙版裁回。 */
      const need = (useMask && !localWhole) ? "inpaint" : "i2i";
      const cid = comfyResolvePresetId(mdl, need);
      const cp = getComfyPreset(cid);
      const cok = cp && comfySanitizeCaps(cp).indexOf(need) >= 0;
      if (!cok) {
        throw new Error(need === "inpaint"
          ? "本地模型没有「局部重绘」工作流：设置 ▸ 本地 ComfyUI 添加「Klein 4B 局部重绘」模板，或把「本地局部重绘方式」改为整图重绘"
          : "本地模型没有「参考图」工作流：设置 ▸ 本地 ComfyUI 添加「Klein 4B 参考图」模板");
      }
      diag("路由：本地 ComfyUI（编辑域 · " + need + (localWhole ? " · 整图重绘" : "") + "）preset=" + cp.name);
      if (localWhole) log("本地重绘：整图重绘模式（导出 " + exW + "×" + exH + " 含上下文，落图后按选区蒙版裁回）");
      r = { url: await callComfyUI(prompt, {
        size: (exW && exH) ? (exW + "x" + exH) : "",
        imageUri: imgUri,
        maskUri: (!localWhole && maskEntry) ? await fileToDataURI(maskEntry) : null,
        denoise: snap.params.denoise
      }, cid, runAbortProbe(ctx)) };
    } else if (isNanoModel(mdl)) {
      /* nano 系列：统一端点、单图、无 mask（该族未文档化蒙版能力，靠色框 + 提示词定位）；
         aspectRatio 取与导出区域同比例的档位 → 回贴 1:1 不拉伸、不错位 */
      const nsize = editOutputSize(mdl, exW, exH, snap.params.size);
      diag("路由：统一端点 /v1/api/generate（编辑类 · 无 mask）aspect=" + nsize);
      r = await callUnifiedGenerate(buildUnifiedPayload(mdl, prompt, [imgUri], snap, nsize));
    } else {
      /* 尺寸同样按导出区域比例挑档位：抠图/修复类回贴必须 1:1 */
      const esize = editOutputSize(mdl, exW, exH, snap.params.size);
      diag("编辑请求尺寸：" + esize + "（导出 " + exW + "×" + exH + "）");
      const payload = {
        model: mdl,
        prompt: prompt,
        size: esize,
        quality: normalizeQualityForModel(mdl, snap.params.quality || "auto")
      };
      if (snap.params.transparent) payload.background = "transparent";
      payload.image = imgUri;
      if (maskEntry) payload.mask = await fileToDataURI(maskEntry);
      r = await callApi("/v1/images/edits", payload, true);
    }

    const name = layerNameFor(inst, snap.userText || prompt);
    setRunLayerName(ctx, name);
    await placeWithGate(ctx && ctx.run, "PS Spark: 写入结果", async function () {
      /* 整图重绘：始终套选区蒙版（外圈只做上下文，不写进画面）；收缩 1px + 羽化让接缝自然 */
      const clipOpt = channelCreated ? {
        channel: CH,
        mask: useClip || localWhole,
        contract: localWhole ? 1 : 0,
        feather: localWhole ? Math.max(2, Math.min(10, Math.round(Math.min(sel.width, sel.height) * 0.01))) : 0
      } : null;
      /* 编辑类结果一律「铺满导出区域」：结果图代表的就是这块画面，
       * 铺满才能保证与原图/选区的像素一一对应（等比居中会在四边留出空档 → 错位）。
       * fitCover：模型返回比例与区域不符时改为「等比铺满 + 蒙版裁边」，不再拉伸变形。 */
      resultEntry = await placeResultAsLayer(r.url, { left: eb.left, top: eb.top, width: exW, height: exH }, name,
        clipOpt, ctx.docId, { stretch: true, fitCover: true });
      if (ctx && ctx.run) ctx.run.layerId = (lastPlacedLayer && lastPlacedLayer.id) || null;
      /* 原位合成·光影模式：结果层按「轻/中/重」不透明度与下层原图融合（融合比例即调整强度） */
      if (inst.id === "composite" && extra && extra.hasAsset === false) {
        const op = strengthOpacityOf(snap);
        await setActiveLayerOpacity(op);
        log("原位合成·光影模式：结果层不透明度 " + Math.round(op) + "%（强度轻/中/重）");
      }
    });
    channelHandled = true;
  } finally {
    if (channelCreated && !channelHandled) {
      try {
        await execModal(async function () { await deleteChannelQuiet(CH); }, "PS Spark: 清理通道", 2);
      } catch (e) { diag("cleanup channel warn: " + e.message); }
    }
  }
  return { entry: resultEntry, placeTarget: { left: eb.left, top: eb.top, width: exW, height: exH } };
}

/* 重新生成（同参再跑 → 产生新任务记录；原记录保留可对比） */
function regenLastRun(instId) {
  if (running) return;
  if (!lastRun || lastRun.instId !== instId) { log("暂无可重跑的任务", "err"); return; }
  if (!IS_UXP) { log("请在 Photoshop 面板中运行", "err"); return; }
  diag("regen: " + instId);
  runCurrentInstance({ snapshot: lastRun.snap, fromRegen: true, instId: instId });
}

/* 插入为新图层：把本次结果再插入一次（图层被删/想多处使用时） */
async function reinsertLastRun(instId) {
  if (running) return;
  if (!lastRun || lastRun.instId !== instId) { log("暂无可插入的结果", "err"); return; }
  if (!lastRun.entry) { log("结果文件引用不可用（请重新生成后再试）", "err"); return; }
  if (!IS_UXP) { log("请在 Photoshop 面板中操作", "err"); return; }
  if (!app.activeDocument) { log("请先打开一个文档", "err"); return; }
  try {
    setRunning(true);
    diag("reinsert: " + instId);
    await core.executeAsModal(async function () {
      await placeEntryAsLayer(lastRun.entry, lastRun.placeTarget || null, (lastRun.layerName || "AI 结果") + "（再插入）");
    }, { commandName: "PS Spark: 再次插入结果" });
    log("已再次插入结果图层", "ok");
  } catch (e) {
    diag("reinsert warn: " + ((e && e.stack) || String(e)));
    log("插入失败: " + (e && e.message ? e.message : String(e)), "err");
  } finally {
    stopProgress();
    setRunning(false);
  }
}

/* 收藏 / 取消收藏（清理缓存时豁免） */
async function toggleFavLastRun(instId) {
  if (!lastRun || lastRun.instId !== instId) { log("暂无可收藏的任务", "err"); return; }
  if (!lastRun.job) { log("该任务未归档（存储未就绪）", "err"); return; }
  try {
    const fav = await storeToggleFavorite(lastRun.job);
    lastRun.favorite = fav;
    refreshResultBlock();
    log(fav ? "已收藏（清理缓存时豁免）" : "已取消收藏", "ok");
  } catch (e) {
    diag("fav warn: " + e.message);
    log("收藏失败: " + e.message, "err");
  }
}

/* 删除本次结果的历史副本（PS 图层不受影响；卡片重置） */
async function deleteLastRun(instId) {
  if (!lastRun || lastRun.instId !== instId) { log("暂无可删除的记录", "err"); return; }
  const job = lastRun.job;
  if (!job) { lastRun = null; refreshResultBlock(); return; }
  try {
    await storeDeleteJob(job);
    log("已删除本机历史副本（PS 图层不受影响）", "ok");
  } catch (e) {
    diag("delete warn: " + e.message);
  }
  lastRun = null;
  refreshResultBlock();
}

/* ================= 历史域（W6：浏览 / 筛选 / 操作） ================= */

App.historyFilter = { status: "all", instId: "all" };

function historyTimeText(iso) {
  try {
    const d = new Date(iso);
    const p = function (n) { return (n < 10 ? "0" : "") + n; };
    if (isNaN(d.getTime())) return String(iso || "");
    return (d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  } catch (e) { return String(iso || ""); }
}

function renderHistoryView() {
  const chips = $("historyChips"), host = $("historyHost"), filterRow = $("historyFilterRow");
  if (!chips || !host) return;
  const f = App.historyFilter;

  /* 状态筛选 chips（含计数） */
  const counts = { all: Store.jobs.length, success: 0, failed: 0, fav: 0 };
  Store.jobs.forEach(function (j) {
    if (j.status === "success") counts.success++;
    else if (j.status === "failed") counts.failed++;
    if (j.favorite) counts.fav++;
  });
  chips.innerHTML = "";
  [["all", "全部 " + counts.all], ["success", "成功 " + counts.success], ["failed", "失败 " + counts.failed], ["fav", "★ 收藏 " + counts.fav]]
    .forEach(function (c) {
      const ch = el("div", "chip" + (f.status === c[0] ? " active" : ""), c[1]);
      ch.addEventListener("click", function () { f.status = c[0]; renderHistoryView(); });
      chips.appendChild(ch);
    });

  /* 功能筛选（下拉） */
  if (filterRow) {
    filterRow.innerHTML = "";
    const used = {};
    Store.jobs.forEach(function (j) {
      if (j.source && j.source.instanceId) used[j.source.instanceId] = j.source.instanceName || j.source.instanceId;
    });
    const opts = [["all", "全部功能"]];
    Object.keys(used).forEach(function (k) { opts.push([k, used[k]]); });
    const dd = UI.makeDropdown(opts, f.instId, function (v) { f.instId = v; renderHistoryView(); });
    filterRow.appendChild(dd.el);
  }

  /* 列表 */
  host.innerHTML = "";
  const list = Store.jobs.filter(function (j) {
    if (f.status === "fav" && !j.favorite) return false;
    if (f.status === "success" && j.status !== "success") return false;
    if (f.status === "failed" && j.status !== "failed") return false;
    if (f.instId !== "all" && (!j.source || j.source.instanceId !== f.instId)) return false;
    return true;
  });

  if (!list.length) {
    host.appendChild(el("div", "hj-empty",
      Store.jobs.length
        ? "当前筛选条件下没有任务"
        : "暂无历史任务——运行任意功能后会自动归档到这里（仅存本机，可清理）"));
    return;
  }

  const MAX = 30;
  list.slice(0, MAX).forEach(function (job) { host.appendChild(historyJobCard(job)); });
  if (list.length > MAX) {
    host.appendChild(el("div", "hj-empty", "仅显示最近 " + MAX + " 条（共 " + list.length + " 条，可用筛选缩小范围）"));
  }
}

function historyJobCard(job) {
  const card = el("div", "hj-card");
  const top = el("div", "hj-top");

  const img = document.createElement("img");
  img.className = "hj-thumb";
  img.alt = "";
  top.appendChild(img);

  const info = el("div", "hj-info");
  info.appendChild(el("div", "hj-name", job.layerName || ((job.source && job.source.instanceName) || "任务")));
  info.appendChild(el("div", "hj-meta",
    ((job.source && job.source.instanceName) || "") + " · " + historyTimeText(job.time) +
    (job.secs != null ? " · " + job.secs + "s" : "") +
    (job.model ? " · " + job.model : "") +
    (job.assets && job.assets.length > 1 ? (" · 共 " + job.assets.length + " 张候选") : "")));

  const stateRow = el("div", "hj-state");
  stateRow.appendChild(el("span", "hj-badge " + (job.status === "success" ? "ok" : (job.status === "failed" ? "err" : "")),
    job.status === "success" ? "成功" : (job.status === "failed" ? "失败" : "运行中")));
  if (job.favorite) stateRow.appendChild(el("span", "hj-badge fav", "★ 收藏"));
  info.appendChild(stateRow);
  if (job.error) info.appendChild(el("div", "hj-meta", "错误：" + job.error));
  top.appendChild(info);
  card.appendChild(top);

  /* 缩略图 + 候选列表（异步加载归档文件）：多候选逐张展示——点图放大预览，↧ 插入该张 */
  if (job.assets && job.assets.length) {
    const assetList = job.assets;
    (async function () {
      try {
        const f = await storeJobFileEntry(job);
        if (f) {
          const uri = await fileToDataURI(f);
          img.src = uri;
          img.title = "点击放大预览";
          img.style.cursor = "pointer";
          img.addEventListener("click", function () {
            openImagePreview(uri, (job.layerName || "结果") + " · 第 1 张");
          });
        }
      } catch (e) { /* ignore */ }
    })();
    if (assetList.length > 1) {
      const cands = el("div", "hj-cands");
      assetList.forEach(function (a, ai) {
        const cell = el("div", "hj-cand");
        const im2 = document.createElement("img");
        im2.className = "hj-cand-img";
        im2.alt = "";
        im2.title = "点击放大预览";
        cell.appendChild(im2);
        const ins = el("span", "hj-cand-ins", "↧");
        ins.title = "插入第 " + (ai + 1) + " 张为新图层";
        ins.addEventListener("click", function (e) {
          e.stopPropagation();
          historyReinsert(job, a.file);
        });
        cell.appendChild(ins);
        cell.appendChild(el("div", "hj-cand-cap", "第 " + (ai + 1) + " 张"));
        (async function () {
          try {
            const f2 = await storeJobFileEntry(job, a.file);
            if (f2) {
              const uri2 = await fileToDataURI(f2);
              im2.src = uri2;
              im2.addEventListener("click", function () {
                openImagePreview(uri2, (job.layerName || "结果") + " · 第 " + (ai + 1) + " 张");
              });
            }
          } catch (e) { /* ignore */ }
        })();
        cands.appendChild(cell);
      });
      card.appendChild(cands);
    }
  } else {
    img.classList.add("hj-noimg");
  }

  /* 操作 */
  const acts = el("div", "hj-actions");
  const ins = el("button", null, "插入为新图层");
  /* 判定「能不能插入」只看归档目录里有没有图：
   * 旧记录的 assets 字段可能缺失、失败任务也可能已经生成了图（只是没写进图层）。
   * UXP 里 <button disabled> 的 :disabled 伪类与 title tooltip 都不可靠：
   * 状态同时挂 class（变灰），说明用卡片内浮层（悬停出现），按钮文字也直接写原因。 */
  const hasAssets = !!(job.assets && job.assets.length);
  let insWhy = "";
  let tipEl = null;
  const showTip = function () {
    if (!insWhy) { if (tipEl) tipEl.classList.add("hidden"); return; }
    if (!tipEl) {
      tipEl = el("div", "hj-tip hidden", "");
      card.appendChild(tipEl);
    }
    tipEl.textContent = insWhy;
    tipEl.classList.remove("hidden");
  };
  const hideTip = function () { if (tipEl) tipEl.classList.add("hidden"); };
  ["mouseover", "mouseenter"].forEach(function (t) { ins.addEventListener(t, showTip); });
  ["mouseout", "mouseleave"].forEach(function (t) { ins.addEventListener(t, hideTip); });
  /* state: "running" | "noimg" | "partial" | "ok" */
  const setInsState = function (state) {
    const runningNow = state === "running";
    const dead = state === "noimg";
    /* 后台有任务时也允许插入：历史的图早已归档，插入只是本地写层，
     * 真撞上模态作用域会被 execModal 的退避重试挡住，不需要整块禁用。 */
    ins.disabled = dead;
    if (dead) ins.classList.add("is-dis");
    else ins.classList.remove("is-dis");
    if (dead) {
      ins.textContent = "无可插入图";
      insWhy = "没有可插入的结果图（任务失败或文件已被清理）";
    } else if (runningNow) {
      ins.textContent = "插入为新图层";
      insWhy = "有新任务在跑，插入会在其落图之后执行";
    } else if (state === "partial") {
      ins.textContent = "插入为新图层";
      insWhy = "任务未完成，但结果图已归档，可插入";
    } else {
      ins.textContent = "插入为新图层";
      insWhy = "";
      hideTip();
    }
    ins.title = insWhy; /* 兜底：部分环境会显示原生 tooltip */
  };
  setInsState(running ? "running" : "ok");
  /* assets 字段缺失时要扫目录，扫描期间先禁用，避免点了才报「历史文件缺失」 */
  if (!hasAssets && !running) {
    ins.disabled = true;
    ins.classList.add("is-dis");
    ins.textContent = "检查中…";
  }
  ins.addEventListener("click", function () { historyReinsert(job); });
  if (!hasAssets) {
    storeJobAssetNames(job).then(function (names) {
      if (!names.length) {
        setInsState("noimg");
        return;
      }
      job.assets = names.map(function (n, i) {
        return { id: job.id + "-a" + (i + 1), form: "single", file: n, status: "done" };
      });
      setInsState(running ? "running" : (job.status === "success" ? "ok" : "partial"));
      /* 顺带把缩略图补上（文件名取实际扫到的第一张） */
      storeJobFileEntry(job, names[0]).then(function (f) {
        if (!f) return;
        fileToDataURI(f).then(function (uri) {
          img.classList.remove("hj-noimg");
          img.src = uri;
          img.title = "点击放大预览";
          img.style.cursor = "pointer";
          img.addEventListener("click", function () { openImagePreview(uri, (job.layerName || "结果") + " · 第 1 张"); });
        });
      }).catch(function () { /* ignore */ });
    }).catch(function () { setInsState("noimg"); });
  }
  const regen = el("button", null, "重新生成");
  regen.disabled = !!running;
  if (running) regen.classList.add("is-dis");
  regen.addEventListener("click", function () { historyRegen(job); });
  const fav = el("button", null, job.favorite ? "★ 已收藏" : "☆ 收藏");
  fav.addEventListener("click", function () { historyToggleFav(job); });
  const del = el("button", "hj-del", "删除");
  del.addEventListener("click", function () { historyDelete(job); });
  acts.appendChild(ins); acts.appendChild(regen); acts.appendChild(fav); acts.appendChild(del);
  card.appendChild(acts);
  return card;
}

/* 插入为新图层（从历史归档文件）；fileName 可选（多候选逐张插入）。
 * 不再因后台有任务而拒绝：插入是独立的写层动作，模态冲突交给 execModal 退避重试。 */
async function historyReinsert(job, fileName) {
  if (!IS_UXP) { log("请在 Photoshop 面板中操作", "err"); return; }
  if (!app.activeDocument) { log("请先打开一个文档", "err"); return; }
  try {
    setRunning(true);
    diag("history reinsert: " + job.id + (fileName ? (" / " + fileName) : ""));
    const entry = await storeJobFileEntry(job, fileName);
    if (!entry) throw new Error("历史文件缺失（可能已被清理）");
    const docId = app.activeDocument.id;
    await execModal(async function () {
      await placeEntryAsLayer(entry, job.placeTarget || null, (job.layerName || "AI 结果") + "（历史插入）", null, docId);
    }, "PS Spark: 历史插入结果", 3);
    log("已从历史插入结果图层", "ok");
  } catch (e) {
    diag("history reinsert warn: " + ((e && e.stack) || String(e)));
    log("插入失败: " + (e && e.message ? e.message : String(e)), "err");
  } finally { stopProgress(); setRunning(false); }
}

/* 重新生成（同参再跑）：切到对应功能页、回填历史参数后直接运行 */
function historyRegen(job) {
  if (running) return;
  if (!IS_UXP) { log("请在 Photoshop 面板中运行", "err"); return; }
  const inst = instById(job.source && job.source.instanceId);
  if (!inst) { log("该功能已不存在，无法重跑", "err"); return; }
  if (inst.wip) { log(inst.wip, "err"); return; }

  /* 回填实例表单状态（提示词 / 参数 / 定位），让面板与历史一致 */
  const st = getInstanceState(inst.id);
  const p = (job.params && job.params.params) ? job.params.params : {};
  Object.keys(p).forEach(function (k) { st.params[k] = p[k]; });
  st.userText = (job.params && job.params.userText) || "";
  st.tplOverride = (job.params && job.params.tplOverride) || "";
  const lc = (job.params && job.params.locate) ? job.params.locate : {};
  Object.keys(lc).forEach(function (k) { st.locate[k] = lc[k]; });

  /* 切换到对应视图并重渲染（此时表单已是历史参数） */
  if (inst.domain === "gen") {
    App.genInstance = inst.id;
    switchTab("gen");
    renderGenView();
  } else {
    App.editGroup = inst.group || App.editGroup;
    App.editInstance = inst.id;
    switchTab("edit");
    renderEditView();
  }
  log("已按历史参数回填，正在重跑：" + inst.name, "ok");
  diag("history regen: job=" + job.id + " inst=" + inst.id);
  runCurrentInstance({ fromRegen: true, instId: inst.id });
}

async function historyToggleFav(job) {
  try {
    const fav = await storeToggleFavorite(job);
    if (lastRun && lastRun.job === job) { lastRun.favorite = fav; refreshResultBlock(); }
    renderHistoryView();
    log(fav ? "已收藏（清理缓存时豁免）" : "已取消收藏", "ok");
  } catch (e) { diag("history fav warn: " + e.message); }
}

async function historyDelete(job) {
  try {
    await storeDeleteJob(job);
    if (lastRun && lastRun.job === job) { lastRun = null; refreshResultBlock(); }
    renderHistoryView();
    log("已删除该历史记录（PS 图层不受影响）", "ok");
  } catch (e) { diag("history delete warn: " + e.message); }
}

/* ================= 拆图域（v1.2：① 拆图对象/智能分析 → ② 蓝图 → ③ 执行） =================
 * 蓝图来源（两条路，可混用）：
 *   ① 智能分析——把「当前画面（合并可见）」或「当前选中图层」导出为图片，交给支持看图的
 *      文本模型（deepseek-flash / V4.1-Flash）识别可拆元素；用户可另加「补充说明」约束偏好。
 *      模型不支持看图时：有补充说明则自动降级为纯文本分析，否则明确提示切换模型。
 *   ② 手动填写——直接编辑蓝图条目（名称 + 描述）。
 * 执行：每层 1 次图像请求；逐层提取为透明 PNG 写入新文档，完成后自动建图层组。 */

App.decomp = {
  step: 1,
  src: "canvas",     /* 拆图对象："canvas"（当前画面·合并可见）| "layer"（当前选中图层） */
  desc: "",          /* 补充说明（可选；留空 = 完全由模型看图判断） */
  imgUri: null,      /* 已导出的分析图（data URI，缓存；切换对象时作废） */
  imgW: 0, imgH: 0, imgLab: "",
  layers: [],        /* [{ name, prompt, checked }] —— 蓝图条目（名称/描述均可在界面直接编辑） */
  results: [],       /* [{ name, status: wait|run|ok|err, msg }] */
  running: false,
  cancel: false,
  outDocName: "",
  msg: null          /* { text, level } —— 跨步骤保留的状态提示 */
};

function dcStepBar(step) {
  [1, 2, 3].forEach(function (i) {
    const e = $("dcStep" + i);
    if (!e) return;
    e.classList.toggle("active", i === step);
    e.classList.toggle("done", i < step);
  });
}

function dcSetMsg(text, level) {
  App.decomp.msg = text ? { text: text, level: level || "" } : null;
  const e = $("dcMsg");
  if (e) { e.textContent = text || ""; e.className = "dc-status " + (level || ""); }
}
function dcSetRunMsg(text, level) {
  const e = $("dcRunMsg");
  if (e) { e.textContent = text; e.className = "dc-status " + (level || ""); }
}

function renderDecompView() {
  dcStepBar(App.decomp.step);
  const host = $("dcHost");
  if (!host) return;
  host.innerHTML = "";

  /* 拆图模型：默认跟随编辑模型，可单独覆盖 */
  const mcard = el("div", "card");
  const mrow = selectRow("模型", modelOptionsFor("decomp"), getModelOverride("decomp"), function (v) {
    setModelOverride("decomp", v);
    renderDecompView();
  });
  mrow.setAttribute("data-model-use", "decomp");
  mcard.appendChild(mrow);
  /* 拆图对「指令遵循」要求很高：必须严格保留位置 + 背景刷成纯品红。
   * nano 系列偏创意、常重新构图，用它会得到"整幅背景"的元素层。 */
  try {
    if (typeof isNanoModel === "function" && isNanoModel(resolveModel("decomp"))) {
      mcard.appendChild(el("div", "dim-note warn-note",
        "拆图需要模型严格照做「纯洋红底 + 位置不变」。nano 系列常会重新构图，抠色容易失败——" +
        "建议改用 gpt-image-2 / 2.5 系列。"));
    }
  } catch (eNano) { /* 模型判断失败不影响面板 */ }
  host.appendChild(mcard);

  if (App.decomp.step === 1) renderDecompStep1(host);
  else if (App.decomp.step === 2) renderDecompStep2(host);
  else renderDecompStep3(host);
  if (typeof i18nFlush === "function") i18nFlush();
}

/* ---- ① 描述 ---- */

function renderDecompStep1(host) {
  const d = App.decomp;
  const card = el("div", "dc-card");
  if (IS_UXP && app.activeDocument) {
    const doc = app.activeDocument;
    card.appendChild(el("div", "hj-meta", "将拆分的画面：当前文档 " + Math.round(doc.width) + "×" + Math.round(doc.height) + "（按可见内容导出）"));
  } else {
    card.appendChild(el("div", "hj-meta", IS_UXP ? "请先打开一个要拆分的文档" : "浏览器预览：界面可交互，执行需在 Photoshop 面板中"));
  }

  /* 拆图对象：当前画面（合并可见）/ 当前选中图层 */
  card.appendChild(el("div", "card-title", "拆图对象"));
  const seg = el("div", "seg");
  [["canvas", "当前画面"], ["layer", "选中图层"]].forEach(function (o) {
    const it = el("div", "seg-item" + (d.src === o[0] ? " active" : ""), o[1]);
    it.title = o[0] === "canvas"
      ? "当前画面（合并可见）：整张画布上所有可见图层叠加后的样子，含背景与全部元素——适合整图分层"
      : "选中图层：只把你在 PS 图层面板点中的那个图层单独导出，其余区域透明——适合画面元素太多、只想让模型盯住某个图层时";
    it.addEventListener("click", function () { dcSetSrc(o[0]); });
    seg.appendChild(it);
  });
  card.appendChild(seg);
  card.appendChild(el("div", "hj-meta", d.src === "layer"
    ? "当前：只分析选中图层的内容（其余透明）。执行拆图时仍以整个画面为底，各层按原位置对齐。"
    : "当前：分析整个画布的可见内容（含背景）。这是默认选项，绝大多数场景用它。"));
  if (d.src === "layer") {
    const ln = dcActiveLayerName();
    card.appendChild(el("div", "hj-meta", ln ? ("已选中图层：「" + ln + "」") : "⚠ 当前没有选中图层：请先在 PS 图层面板点选一个图层，或切回「当前画面」"));
  }

  /* 画面预览：让用户确认「发给模型的是哪张图」 */
  const prev = el("div", "dc-preview");
  if (d.imgUri) {
    const img = document.createElement("img");
    img.src = d.imgUri;
    prev.appendChild(img);
    prev.appendChild(el("div", "dc-preview-cap", (d.imgLab || "") + " · 已导出"));
  } else {
    prev.appendChild(el("div", "dc-preview-cap", "尚未导出画面（智能分析会自动导出；也可先点下方「预览」确认内容）"));
  }
  card.appendChild(prev);
  const pvRow = el("div", "btnRow");
  const bPv = el("button", "secondary", d.imgUri ? "重新导出画面" : "预览将发送的画面");
  bPv.disabled = !IS_UXP || !app.activeDocument;
  bPv.addEventListener("click", function () { dcPreviewImage(); });
  pvRow.appendChild(bPv);
  card.appendChild(pvRow);

  /* 补充说明（可选）：留空即完全由模型看图判断 */
  card.appendChild(el("div", "card-title", "补充说明（可选）"));
  const ta = document.createElement("textarea");
  ta.className = "ta-prompt";
  ta.value = d.desc;
  ta.placeholder = "留空 = 完全由模型看图判断。也可补充偏好，例：只拆文字和 logo / 主体拆成人物与道具两层 / 忽略背景杂物";
  autoGrowTa(ta, 116, d.desc);
  ta.addEventListener("input", function () { d.desc = ta.value; });
  ta.addEventListener("change", function () { d.desc = ta.value; });
  card.appendChild(ta);

  const vModel = resolveVisionModel();
  const vision = textModelVision(vModel);
  const row = el("div", "btnRow");
  const bAi = el("button", null, "✨ 智能分析画面（看图 · 文本 ×1）");
  bAi.disabled = !App.hasTextKey || !IS_UXP;
  bAi.title = "把" + (d.src === "layer" ? "选中图层" : "当前画面") + "发给文本模型看图分析，识别可拆分的元素并填入蓝图";
  bAi.addEventListener("click", function () { dcAnalyze(); });
  row.appendChild(bAi);
  card.appendChild(row);

  const row2 = el("div", "btnRow");
  const bMan = el("button", "secondary", "手动填写蓝图 →");
  bMan.title = "不经过分析，直接进入蓝图，逐条填写要拆的元素（可随时用智能分析补充候选）";
  bMan.addEventListener("click", function () { dcGoManual(); });
  row2.appendChild(bMan);
  card.appendChild(row2);

  if (!App.hasTextKey) {
    card.appendChild(el("div", "dc-status", "未配置文本服务：智能分析需在 设置 ▸ 文本服务 填写 Key（也可先「手动填写蓝图」）"));
  } else if (vision === "no") {
    card.appendChild(el("div", "dc-status", "当前图片分析模型（" + vModel + "）为纯文本、不能看图：请在 设置 ▸ 文本服务 ▸「图片分析模型」中选择支持看图的模型；或填写「补充说明」按文字分析。"));
  } else {
    card.appendChild(el("div", "dc-status", "图片分析模型：" + vModel + "（可在 设置 ▸ 文本服务 切换）"));
  }

  const msg = el("div", "dc-status", d.msg ? d.msg.text : "");
  msg.id = "dcMsg";
  if (d.msg) msg.className = "dc-status " + d.msg.level;
  card.appendChild(msg);
  host.appendChild(card);
}

function dcGoManual() {
  App.decomp.step = 2;
  renderDecompView();
}

/* 当前选中图层名（无选中返回 ""） */
function dcActiveLayerName() {
  try {
    const doc = app.activeDocument;
    if (!doc) return "";
    const al = doc.activeLayers;
    if (al && al.length) return al[0].name || "";
    return (doc.layers && doc.layers.length) ? (doc.layers[0].name || "") : "";
  } catch (e) { return ""; }
}

/* 切换拆图对象：作废已导出的画面缓存 */
function dcSetSrc(src) {
  const d = App.decomp;
  if (d.src === src) return;
  d.src = src;
  d.imgUri = null; d.imgW = 0; d.imgH = 0; d.imgLab = ""; d.degraded = "";
  dcSetMsg("");
  renderDecompView();
}

/* 导出用于分析/预览的画面（带缓存；force=true 强制重新导出） */
async function dcExportImage(force) {
  const d = App.decomp;
  if (!IS_UXP) throw new Error("浏览器预览无法导出画面");
  if (!app.activeDocument) throw new Error("请先打开要拆分的文档");
  if (d.imgUri && !force) return d.imgUri;
  const doc = app.activeDocument;
  const W = Math.round(doc.width), H = Math.round(doc.height);
  const uri = await exportScopePngDataURI(d.src);
  if (!uri) throw new Error("画面导出失败");
  d.imgUri = uri; d.imgW = W; d.imgH = H;
  d.degraded = (typeof scopeExportDegraded === "string") ? scopeExportDegraded : "";
  d.imgLab = (d.src === "layer"
    ? (d.degraded ? "当前画面（图层导出失败·已降级）" : "选中图层（其余透明）")
    : "当前画面") + " " + W + "×" + H;
  diag("decomp: 分析画面已导出（" + d.imgLab + "，" + Math.round(uri.length / 1024) + " KB）" +
    (d.degraded ? " 【降级】" + d.degraded : ""));
  return uri;
}

async function dcPreviewImage() {
  try {
    dcSetMsg("正在导出画面…", "");
    await dcExportImage(true);
    const d = App.decomp;
    dcSetMsg(d.degraded
      ? ("已导出画面（见上方预览）；" + d.degraded)
      : "已导出画面（见上方预览）", d.degraded ? "" : "ok");
  } catch (e) {
    dcSetMsg("导出失败：" + (e && e.message ? e.message : String(e)), "err");
  }
  renderDecompView();
}

/* 智能分析：把画面（当前画面 / 选中图层）发给支持看图的文本模型 → 蓝图候选。
 * 模型不支持看图时：有「补充说明」则自动降级为纯文本分析，否则提示切换模型。 */
async function dcAnalyze() {
  const d = App.decomp;
  if (!IS_UXP) { dcSetMsg("浏览器预览无法调用文本服务，请在 Photoshop 中运行（可先用「手动填写蓝图」熟悉流程）", "err"); return; }
  if (!App.hasTextKey) { dcSetMsg("未配置文本服务：请到 设置 ▸ 文本服务 填写 Key", "err"); return; }

  const model = resolveModel("text");          /* 语言模型（纯文本降级时使用） */
  const vModel = resolveVisionModel();         /* 图片分析模型（设置 ▸ 文本服务 ▸ 图片分析） */
  const vision = textModelVision(vModel);
  const desc = String(d.desc || "").trim();

  /* 1) 导出画面（缓存复用；已知纯文本模型不导出） */
  let uri = null;
  if (vision !== "no") {
    dcSetMsg("正在导出画面…", "");
    try { uri = await dcExportImage(false); }
    catch (e) {
      diag("dcAnalyze export warn: " + ((e && e.stack) || String(e)));
      dcSetMsg("画面导出失败，改为按文字描述分析：" + (e && e.message ? e.message : String(e)), "");
    }
  }
  if (!uri && !desc) {
    dcSetMsg("图片分析模型不能看图（" + vModel + "）：请在 设置 ▸ 文本服务 ▸「图片分析模型」选择支持看图的模型，或填写「补充说明」后再分析。", "err");
    renderDecompView();
    return;
  }

  const sys = "你是图像分层助手。你会收到一张图片（可能另有用户的补充说明），请先观察图片内容，再判断其中可以独立提取为图层的元素。\n" +
    "逐一判断下列常见类别，只为「图片中确实存在」的类别输出图层：\n" +
    "1) 背景  2) 主体/主要物件  3) 文字·Logo  4) 装饰元素  5) 光影/氛围  6) 其他元素\n" +
    "要求：\n" +
    "- name：结合画面给出具体命名（2~8 字，如「南瓜灯」「夜景墓园」），不要直接使用类别词。\n" +
    "- prompt：中文描述该元素在画面中的完整外观：形状、颜色、材质、光影，以及它在画面中的位置与大致大小占比。\n" +
    "- 按图层叠放顺序排列（数组第 1 个 = 最底层，最后 1 个 = 最顶层）：背景 → 光影 → 装饰 → 主体/前景 → 文字·Logo → 其他；仔细判断相邻元素之间的上下叠压关系（谁遮住谁）。\n" +
    "- prompt 中必须写明该元素在画面中的具体位置（如：左上角、画面下方 1/3 处、居中偏右），供后续原位还原。宁缺毋滥：图片中不存在或看不清的元素不要输出。\n" +
    "- 只输出 JSON，不要输出任何其它文字。格式：{\"layers\":[{\"name\":\"…\",\"prompt\":\"…\"}]}";

  async function callOnce(note) {
    const noteTxt = note ? ("\n\n注意：" + note) : "";
    if (uri) {
      try {
        return await callTextApiVision(
          sys,
          "请观察这张图片，列出可拆分的图层清单。" +
            (desc ? ("\n\n用户补充说明（优先级更高，请遵循）：" + desc) : "") + noteTxt,
          [uri], 180000);
      } catch (e) {
        if (isVisionUnsupportedError(e) && desc) {
          diag("vision 不支持看图，降级为纯文本：" + ((e && e.message) || ""));
          dcSetMsg("图片分析模型不支持看图，已改用「补充说明」做文字分析…", "");
          return await callTextApi([
            { role: "system", content: sys },
            { role: "user", content: "画面描述：" + desc + noteTxt }
          ], 120000);
        }
        throw e;
      }
    }
    return await callTextApi([
      { role: "system", content: sys },
      { role: "user", content: "画面描述：" + desc + noteTxt }
    ], 120000);
  }

  try {
    dcSetMsg(uri ? "正在看图分析（文本请求 ×1）…" : "正在按描述分析（文本请求 ×1）…", "");
    let out = await callOnce("");
    let arr = parseBlueprint(out);
    if (!arr) {
      dcSetMsg("首次输出无法解析，正在重试…", "");
      out = await callOnce("上次输出无法解析，请只输出合法 JSON，不要包含解释或代码块标记。");
      arr = parseBlueprint(out);
    }
    if (!arr) { dcSetMsg("智能分析失败：可改用手动填写（蓝图列表可直接编辑）", "err"); return; }
    const added = dcMergeLayers(arr);
    dcEnsureBg(); /* 背景层恒在最后（AI 若也输出了「背景」条目，按名去重会被跳过） */
    d.step = 2;
    renderDecompView();
    dcSetMsg("智能分析完成（" + (uri ? ("看图：" + (d.imgLab || "")) : "按文字描述") + "）：新增 " +
      added + " 个候选（已合并去重，可勾选 / 改名 / 增删）" +
      (d.degraded ? ("。注意：" + d.degraded) : ""), d.degraded ? "" : "ok");
  } catch (e) {
    diag("decomp blueprint warn: " + ((e && e.stack) || String(e)));
    dcSetMsg("智能分析失败：" + (e && e.message ? e.message : String(e)), "err");
    renderDecompView();
  }
}

/* 合并候选到蓝图（按名称去重；不覆盖已有条目与已编辑内容） */
function dcMergeLayers(arr) {
  const d = App.decomp;
  let added = 0;
  (arr || []).forEach(function (L) {
    const dup = d.layers.some(function (x) { return String(x.name || "").trim() === String(L.name || "").trim(); });
    if (!dup) { d.layers.push(L); added++; }
  });
  return added;
}

function parseBlueprint(text) {
  try {
    let s = String(text || "");
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a < 0 || b <= a) return null;
    s = s.slice(a, b + 1);
    const obj = JSON.parse(s);
    const ls = obj && obj.layers;
    if (!Array.isArray(ls)) return null;
    const out = [];
    ls.forEach(function (L) {
      if (!L) return;
      const name = String(L.name || "").trim().slice(0, 16);
      const prompt = String(L.prompt || "").trim();
      if (!name && !prompt) return;
      out.push({ name: name || ("层 " + (out.length + 1)), prompt: prompt || name, checked: true });
    });
    if (!out.length) return null;
    if (out.length > 12) out.length = 12;
    return out;
  } catch (e) { return null; }
}

/* ---- ② 蓝图确认 ---- */

/* 拆图请求并发路数（写入仍串行：executeAsModal 不支持并发/嵌套） */
/* 拆图并发数已改由 设置 ▸ 默认参数 ▸「并发请求数」控制（getConcurrency()） */

function dcSelected() {
  return App.decomp.layers.filter(function (L) { return L.checked; });
}
function dcCountText() {
  const sel = dcSelected();
  const n = sel.length;
  const bgN = sel.filter(function (L) { return L.bg; }).length;
  return "已选 " + n + " 层" + (bgN ? "（含背景 " + bgN + " 层）" : "") +
    " · 将发送 " + n + " 次图像请求（并发 " + Math.max(1, Math.min(getConcurrency(), n)) + " 路，写入串行）";
}

function renderDecompStep2(host) {
  const d = App.decomp;
  dcEnsureBg(); /* 背景层：默认存在、恒在列表最后 */

  /* 描述回顾 + 工具行 */
  const head = el("div", "dc-card");
  head.appendChild(el("div", "hj-meta", "分析对象：" + (d.imgLab || (d.src === "layer" ? "选中图层（未导出）" : "当前画面（未导出）")) +
    " · 补充说明：" + (d.desc || "（无，完全由模型看图判断）")));
  head.appendChild(el("div", "dim-note", "层级顺序：列表越靠下 = 写入越晚 = 越上层（背景层恒在最底）；用每行的 ↑↓ 调整叠放顺序"));
  const bar = el("div", "dc-toolbar");
  const bAi = el("button", "secondary", "✨ 智能分析补充候选");
  bAi.disabled = !App.hasTextKey || !IS_UXP;
  bAi.title = "把画面（或选中图层）发给文本模型看图识别元素，候选合并进蓝图（不覆盖已有条目；已导出的画面会复用，不重复导出）";
  bAi.addEventListener("click", function () { dcAnalyze(); });
  const bAdd = el("button", "secondary", "＋ 添加元素");
  bAdd.addEventListener("click", function () {
    if (d.layers.length >= 12) { dcSetMsg("最多 12 层", "err"); return; }
    d.layers.push({ name: "", prompt: "", checked: true });
    dcEnsureBg(); /* 背景层恒在最后 */
    renderDecompView();
  });
  bar.appendChild(bAi);
  bar.appendChild(bAdd);
  head.appendChild(bar);
  host.appendChild(head);

  /* 蓝图列表（名称/描述直接编辑） */
  const card = el("div", "dc-card");
  card.appendChild(el("div", "card-title", "② 蓝图（勾选要拆的层；名称与描述可直接修改）"));
  if (!d.layers.length) {
    card.appendChild(el("div", "dc-empty", "蓝图还是空的：点上方「✨ 智能分析补充候选」，或「＋ 添加元素」逐条手动填写。"));
  }
  d.layers.forEach(function (L) {
    const isBg = !!L.bg;
    const row = el("div", "dc-layer");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!L.checked;
    cb.addEventListener("change", function () {
      L.checked = cb.checked;
      dcRefreshCount();
    });
    row.appendChild(cb);

    const info = el("div", "dc-layer-info");
    /* 名称行：输入框 + 详细描述折叠按钮（默认折叠，点开才渲染文本框） */
    const row1 = el("div", "dc-row1");
    const nameIn = document.createElement("input");
    nameIn.type = "text";
    nameIn.className = "dc-name-in";
    nameIn.value = L.name;
    nameIn.placeholder = isBg ? "背景层名称" : "层名（如：南瓜灯）";
    nameIn.addEventListener("input", function () { L.name = nameIn.value; });
    nameIn.addEventListener("change", function () { L.name = nameIn.value; });
    row1.appendChild(nameIn);

    /* 层级顺序调整：列表越靠后 = 写入越晚 = 越上层；背景层固定在最后不可移动 */
    if (!isBg) {
      const mvUp = el("button", "dc-mv", "↑");
      mvUp.title = "上移一层（更靠底层）";
      mvUp.addEventListener("click", function () {
        const idx = d.layers.indexOf(L);
        if (idx > 0) { d.layers.splice(idx, 1); d.layers.splice(idx - 1, 0, L); }
        dcEnsureBg();
        renderDecompView();
      });
      row1.appendChild(mvUp);
      const mvDn = el("button", "dc-mv", "↓");
      mvDn.title = "下移一层（更靠上层）";
      mvDn.addEventListener("click", function () {
        const idx = d.layers.indexOf(L);
        const last = d.layers.length - 1; /* 末位恒为背景层，不可越过 */
        if (idx >= 0 && idx < last - 1) {
          d.layers.splice(idx, 1);
          d.layers.splice(idx + 1, 0, L);
        }
        dcEnsureBg();
        renderDecompView();
      });
      row1.appendChild(mvDn);
    }

    const tg = el("button", "dc-toggle" + (L.open ? " open" : ""), L.open ? "▾" : "▸");
    tg.title = L.open ? "收起详细描述" : "展开详细描述";
    tg.addEventListener("click", function () {
      L.open = !L.open;
      renderDecompView();
    });
    row1.appendChild(tg);
    info.appendChild(row1);

    if (L.open) {
      const pTa = document.createElement("textarea");
      pTa.className = "dc-prompt-ta";
      pTa.value = L.prompt;
      pTa.placeholder = isBg
        ? "可选：对背景补全的额外要求（如「保留地面投影」，留空即可）"
        : "描述该元素的外观（形状、颜色、材质、位置…）";
      autoGrowTa(pTa, 46, L.prompt);
      pTa.addEventListener("input", function () { L.prompt = pTa.value; });
      pTa.addEventListener("change", function () { L.prompt = pTa.value; });
      info.appendChild(pTa);
    } else if (isBg) {
      info.appendChild(el("div", "dc-bg-note",
        "自动按已选元素生成：移除所有拆出的元素后自然补全的底图（最后写入，置于最底层）"));
    }
    row.appendChild(info);

    if (isBg) {
      row.appendChild(el("span", "dc-badge", "背景·最后"));
    } else {
      const rm = el("button", "dc-rm", "×");
      rm.title = "移除该层";
      rm.addEventListener("click", function () {
        const idx = d.layers.indexOf(L);
        if (idx >= 0) d.layers.splice(idx, 1);
        renderDecompView();
      });
      row.appendChild(rm);
    }
    card.appendChild(row);
  });
  host.appendChild(card);

  const cnt = el("div", "dc-count", dcCountText());
  cnt.id = "dcCount";
  host.appendChild(cnt);

  const row = el("div", "btnRow");
  const back = el("button", "secondary", "‹ 返回");
  back.addEventListener("click", function () { d.step = 1; renderDecompView(); });
  const go = el("button", null, "开始拆图");
  go.id = "dcStart";
  go.disabled = dcSelected().length === 0;
  go.addEventListener("click", function () { startDecomp(); });
  row.appendChild(back);
  row.appendChild(go);
  host.appendChild(row);

  host.appendChild(el("div", "dc-status", "各层并发生成、串行写入新文档；背景层最后写入并置于最底层。完成后自动建图层组（每层独立计费 ×1）。"));

  const msg = el("div", "dc-status", d.msg ? d.msg.text : "");
  msg.id = "dcMsg";
  if (d.msg) msg.className = "dc-status " + d.msg.level;
  host.appendChild(msg);
}

/* ---- ③ 执行 ---- */

function renderDecompStep3(host) {
  const d = App.decomp;
  const card = el("div", "dc-card");
  card.appendChild(el("div", "card-title", "③ 执行（并发生成 · 串行写入）"));
  d.results.forEach(function (r) {
    const row = el("div", "dc-layer");
    const info = el("div", "dc-layer-info");
    info.appendChild(el("div", "dc-layer-name", r.name));
    if (r.msg) info.appendChild(el("div", "dc-layer-p", r.msg));
    row.appendChild(info);
    const t = r.status === "ok" ? "✓ 成功" : r.status === "err" ? "✗ 失败" : r.status === "run" ? "… 进行中" : "等待";
    row.appendChild(el("span", "dc-run-status " + r.status, t));
    card.appendChild(row);
  });
  host.appendChild(card);

  const row = el("div", "btnRow");
  if (d.running) {
    const cancel = el("button", "secondary", "停止（已完成层保留）");
    cancel.addEventListener("click", function () {
      d.cancel = true;
      abortAllRequests(); /* 并发在途请求全部 abort（只 abort 最后一个不够） */
      dcSetRunMsg("正在停止…");
    });
    row.appendChild(cancel);
  } else {
    const again = el("button", null, "再拆一张 / 重新开始");
    again.addEventListener("click", function () {
      App.decomp = {
        step: 1, src: "canvas", desc: "", imgUri: null, imgW: 0, imgH: 0, imgLab: "",
        layers: [], results: [], running: false, cancel: false, outDocName: "", msg: null
      };
      renderDecompView();
    });
    row.appendChild(again);
  }
  host.appendChild(row);

  const msg = el("div", "dc-status", "");
  msg.id = "dcRunMsg";
  host.appendChild(msg);
}

/* 纯色底颜色：洋红在自然画面里几乎不会出现，抠色误伤最小（绿幕容易被植物/草地撞） */
const DECOMP_KEY_COLOR = "#FF00FF";

function buildDecompLayerPrompt(L, useColorKey) {
  const name = L.name;
  /* 纯色底是拆图整条链路的命门：魔棒点四角必须能选中一大片。
   * 提示词要写成"绿幕"这种模型熟悉的概念，并明确"背景是色块不是场景"——
   * 否则 nano 系列会把背景画成渐变/场景，抠色必然失败（元素层就带上了整幅背景）。 */
  const tail = useColorKey
    ? ("背景必须是整片纯品红色 " + DECOMP_KEY_COLOR + "（RGB 255,0,255，像影视绿幕那样的抠像底色）：" +
       "从四角到每一条边都是同一种平的色块，没有渐变、没有光照、没有阴影、没有纹理、没有噪点、也没有其它物体；" +
       "不要画场景、地面、桌面或天空，背景只是色块、不是画面内容。" +
       "除「" + name + "」以外的每一个像素都必须是这个纯品红；不要画棋盘格、不要画格子、不要加边框。")
    : ("除「" + name + "」以外，画面其余部分必须完全透明（真 Alpha 通道，输出透明背景 PNG）。");
  return "任务：从输入图里只提取「" + name + "」这一个元素，输出一张只包含它的图。\n" +
    "元素特征（用于定位，照此识别，不要重新设计）：" + L.prompt + "\n" +
    "硬性要求：\n" +
    "1) 画面里只允许出现「" + name + "」：原图中的其它物体、文字、装饰、背景纹理、投影全部去掉，不要保留、不要模糊残影、也不要用周围颜色凑数。\n" +
    "2) 形状、颜色、材质、光影、细节与原图完全一致；位置、大小、角度保持不变（不要移动、缩放、旋转或重新构图）。\n" +
    "3) 边缘清晰：轮廓干净利落，不要羽化、不要外发光、不要白边/黑边/紫边，不要描边或加边框。\n" +
    "4) " + tail + "\n" +
    "5) 输出画幅与输入图像完全一致：同尺寸、同比例、同构图，不要裁剪、不要加边或留白。\n" +
    "6) 色调锁死：不得调整白平衡、色温、亮度、对比度、饱和度，不得添加滤镜、HDR、锐化；该元素区域的颜色必须与原图对应区域一致。\n" +
    "7) 如果画面中确实找不到「" + name + "」，就输出一张纯色底图，不要虚构其它内容。";
}

/* 编辑类（抠图 / 修复 / 上色 / 局部重绘…）的输出尺寸：
 * 结果会 1:1 贴回导出区域，所以**输出比例必须与导出区域一致**——否则回贴只能缩放居中，
 * 与画面错位（抠图"插入后没对齐"就是这条）。用户选的尺寸若比例不符（如 4:3 画幅上选了 1:1），
 * 改用模型支持的同比例档位；没有合适的档位才回 auto（回贴时再拉伸铺满兜底）。 */
function editOutputSize(mdl, exW, exH, prefSize) {
  const ar = (exW > 0 && exH > 0) ? exW / exH : 1;
  const pick = String(prefSize || "").trim();
  /* auto：交给接口按输入图出图（实测会贴着原图尺寸，如 1254² → 1153×1231），
   * 分辨率最接近原图；回贴靠 stretch 保证对齐，不强行换成固定档位。 */
  if (!pick || pick === "auto") return "auto";
  let w = 0, h = 0;
  const m = /^(\d+)x(\d+)$/.exec(pick);
  if (m) { w = +m[1]; h = +m[2]; }
  else if (/^\d+:\d+$/.test(pick)) { const p = pick.split(":"); w = +p[0]; h = +p[1]; }
  if (w > 0 && h > 0) {
    const diff = Math.abs(Math.log((w / h) / ar));
    if (diff <= 0.02) return pick;
    diag("editSize: 选定 " + pick + " 与画面比例 " + (Math.round(ar * 100) / 100) + " 不符 → 改用同比例档位");
  }
  return decompPickSize(exW, exH, mdl, true);
}

/* 拆图请求尺寸：从当前模型**支持**的尺寸表里挑一个与画布同比例的档位。
 * 直接传 3000x3000 这类自定义值会被网关改写（实测 3000×3000 → 1206×962），
 * 输出比例一变，回贴与蒙版就全部错位，元素层还会带上模型重绘的底色。 */
function decompPickSize(W, H, mdl, preferLarge) {
  const ar = W / H;
  const opts = (typeof sizeOptionsForModel === "function") ? sizeOptionsForModel(mdl) : [];
  const cands = [];
  (opts || []).forEach(function (o) {
    const v = o && o[0];
    if (!v || v === "auto") return;
    let w = 0, h = 0;
    const m = /^(\d+)x(\d+)$/.exec(v);
    if (m) { w = +m[1]; h = +m[2]; if (Math.max(w, h) > 2048) return; }
    else if (/^\d+:\d+$/.test(v)) { const p = v.split(":"); w = +p[0]; h = +p[1]; }
    else return;
    if (!(w > 0 && h > 0)) return;
    cands.push({ v: v, diff: Math.abs(Math.log((w / h) / ar)), area: w * h });
  });
  if (!cands.length) return "auto";
  cands.sort(function (a, b) { return a.diff - b.diff; });
  const best = cands[0];
  /* 比例差太多（>12%）就别硬套，交回 auto 让模型按输入图比例出图 */
  if (best.diff > 0.12) return "auto";
  if (preferLarge) {
    /* 背景层要保留细节：比例同样贴合的前提下挑面积最大的档位（仍 ≤2048） */
    let big = best;
    cands.forEach(function (c) { if (c.diff <= best.diff + 0.01 && c.area > big.area) big = c; });
    return big.v;
  }
  return best.v;
}

/* 背景层提示词：把原图里所有被单独拆出的元素去掉，剩余区域按周围纹理/光影自然补全 */
function buildDecompBgPrompt(names, L) {
  const list = (names || []).filter(function (n) { return String(n || "").trim(); })
    .map(function (n) { return "「" + n + "」"; }).join("、");
  const extra = String((L && L.prompt) || "").trim();
  return "请生成这张图的「纯净背景版」：从画面中彻底移除 " + (list || "所有被单独拆出的元素") +
    " 等元素本体，只保留它们背后的背景与底纹。\n" +
    "补全要求（关键）：被移除区域要用周围环境的纹理、结构与光影自然延续——纹理连续、透视一致、光照方向与强度一致、接缝无痕；" +
    "不要留下空洞、纯色块、涂抹痕迹、模糊斑块，也不要残留被移除元素的轮廓、投影或碎片。\n" +
    "其它要求：不得新增任何原图不存在的物体、文字或装饰；画面尺寸、构图、视角、整体色调与原图完全一致；输出不透明的完整画面。" +
    (extra ? ("\n额外要求：" + extra) : "");
}

/* executeAsModal 包装：遇到 "host is in a modal state"（PS 正忙/有未关闭对话框）自动等待重试 */
async function execModal(fn, name, tries) {
  const n = Math.max(1, tries || 1);
  let last = null;
  for (let i = 0; i < n; i++) {
    try {
      return await core.executeAsModal(fn, { commandName: name });
    } catch (e) {
      last = e;
      const m = String((e && e.message) || e);
      if (/modal/i.test(m) && i < n - 1) {
        diag("execModal: " + name + " 第 " + (i + 1) + " 次失败（" + m + "），1.5 秒后重试");
        await new Promise(function (r) { setTimeout(r, 1500); });
        continue;
      }
      throw e;
    }
  }
  throw last;
}

/* 蓝图固定条目：背景层（默认勾选、恒在最后、不可删除；可取消勾选） */
function dcEnsureBg() {
  const d = App.decomp;
  let bg = null;
  for (let i = 0; i < d.layers.length; i++) { if (d.layers[i].bg) { bg = d.layers[i]; break; } }
  if (!bg) {
    bg = { name: "背景", prompt: "", checked: true, bg: true, open: false };
    d.layers.push(bg);
  }
  const idx = d.layers.indexOf(bg);
  if (idx >= 0 && idx !== d.layers.length - 1) { d.layers.splice(idx, 1); d.layers.push(bg); }
  return bg;
}

/* 底部计数/开始按钮刷新（勾选变化、增删层后调用） */
function dcRefreshCount() {
  const c = $("dcCount");
  if (c) c.textContent = dcCountText();
  const btn = $("dcStart");
  if (btn) btn.disabled = dcSelected().length === 0;
}

async function startDecomp() {
  const d = App.decomp;
  if (d.running) return;
  if (!IS_UXP) { log("浏览器预览无法执行拆图，请在 Photoshop 面板中运行", "err"); return; }
  if (!app.activeDocument) { log("请先打开要拆分的文档", "err"); return; }
  const layers = dcSelected();
  if (!layers.length) return;
  /* 规范化：空名称/空描述用兜底填充（界面允许留空编辑）；背景层描述留空=无额外要求 */
  layers.forEach(function (L, i) {
    if (!String(L.name || "").trim()) L.name = L.bg ? "背景" : ("层 " + (i + 1));
    if (!L.bg && !String(L.prompt || "").trim()) L.prompt = L.name;
  });

  d.results = layers.map(function (L) { return { name: L.name, status: "wait", msg: "" }; });
  d.running = true;
  d.cancel = false;
  d.step = 3;
  renderDecompView();
  setRunning(true);

  const t0 = Date.now();
  diag("=== decomp start: " + layers.length + " layers ===");
  const srcDoc = app.activeDocument;
  const W = Math.round(srcDoc.width), H = Math.round(srcDoc.height);
  let okN = 0, errN = 0, probeFailN = 0;
  try {
    /* 1) 导出原图（全画布，可见内容）；entry 保留，后面放入目标文档作参考底层
     *    排除本插件落过的结果层：重复拆图时不该把上一次的分层结果当原图 */
    let base = null, baseEntry = null;
    await core.executeAsModal(async function () {
      const hid = await hideLayersNotIn(srcDoc, null, sourcePollutionIds(srcDoc));
      try {
        const ex = await exportRegionToPNG({ left: 0, top: 0, right: W, bottom: H, width: W, height: H }, null);
        baseEntry = ex.entry;
        base = await fileToDataURI(ex.entry);
      } finally {
        if (hid.length) await restoreLayerVisibility(srcDoc, hid);
      }
    }, { commandName: "PS Spark: 拆图导出原图" });
    if (!base) throw new Error("原图导出失败");

    /* 2) 新建目标文档（透明背景，收纳各层）
     * 走 ps.js 的 makeDoc（四级兜底）：PS 26 实测 createDocument 会"建了文档但返回 undefined"，
     * 直接调用会拿到 null 并留下无人认领的空文档——这里统一交给兜底逻辑。 */
    let outDoc = null;
    await core.executeAsModal(async function () {
      outDoc = await makeDoc(W, H, "拆图 · " + (String(d.desc || "分层").trim().slice(0, 12) || "分层"), srcDoc);
    }, { commandName: "PS Spark: 拆图新建文档" });
    if (!outDoc || outDoc.id == null) throw new Error("未能创建目标文档（可在设置中查看日志）");
    const outId = outDoc.id;
    if (srcDoc && srcDoc.id != null && outId === srcDoc.id) {
      throw new Error("目标文档创建异常：拿到了原文档本身，已中止（原文档未改动）");
    }
    let oW = -1, oH = -1;
    try { oW = Math.round(outDoc.width); oH = Math.round(outDoc.height); } catch (eD) { /* ignore */ }
    diag("decomp: out doc id=" + outId + " " + oW + "×" + oH + "（期望 " + W + "×" + H + "）");
    if (oW > 0 && (Math.abs(oW - W) > 2 || Math.abs(oH - H) > 2)) {
      /* 尺寸不符：宁可收尾清理后中止，也不要把各层塞进错误画布 */
      try { await core.executeAsModal(async function () { await closeDocNoSave(outDoc); }, { commandName: "PS Spark: 拆图清理" }); } catch (eC) { /* ignore */ }
      throw new Error("目标文档尺寸异常（" + oW + "×" + oH + "，期望 " + W + "×" + H + "），已中止");
    }
    d.outDocName = outDoc.name;

    /* 2b) 先把原图复制进目标文档最底层，作为对位/参考层（不参与建组） */
    let refLayerOk = false;
    try {
      await execModal(async function () {
        await placeEntryAsLayer(baseEntry, { left: 0, top: 0, width: W, height: H }, "原图（参考）", null, outId);
      }, "PS Spark: 拆图放入原图参考层", 3);
      refLayerOk = true;
      log("原图已放入目标文档最底层（参考层）");
    } catch (eRef) {
      diag("decomp: 原图参考层写入失败（不阻塞拆图）: " + ((eRef && eRef.message) || String(eRef)));
      log("⚠ 原图参考层写入失败（不影响拆图）：" + ((eRef && eRef.message) || String(eRef)), "err");
    }

    /* 3) 拆出各层：**请求并发、写入串行**
     *  - 为什么要并发：各层的图像请求互不依赖，串行会把总耗时拉成 N×40s（真机实测 3 层 202 秒）；
     *    更糟的是超长等待期间 PS 极易被弹窗/用户操作顶成 modal state，后几层写入全部失败（实测只成功 1 层）。
     *  - 为什么写入必须串行：executeAsModal 不允许并发，也不允许嵌套。
     *  - 背景层：与其它层同时生成，但排在最后写入并压到图层最底部。 */
    const isBg = function (L) { return !!L.bg; };
    const itemNames = layers.filter(function (L) { return !isBg(L); })
      .map(function (L) { return String(L.name || "").trim(); }).filter(Boolean);
    const urls = new Array(layers.length).fill(null);
    const secsArr = new Array(layers.length).fill(0);

    /* —— 3a) 并发请求 —— */
    async function requestJob(i) {
      const L = layers[i];
      d.results[i].status = "run";
      d.results[i].msg = "生成中…";
      renderDecompView();
      const tL = Date.now();
      try {
        const mdlDc = resolveModel("decomp");
        /* 元素层一律用「纯洋红底 + 抠色」：即便是声明支持透明通道的模型，
         * 经网关后也经常返回白底 / 半透明彩雾（实测），直接贴上去就是一层脏底色。
         * 纯色底是唯一能稳定判断「哪块属于元素」的输出方式。 */
        const keyMode = !isBg(L);
        const prompt = isBg(L) ? buildDecompBgPrompt(itemNames, L) : buildDecompLayerPrompt(L, keyMode);
        const wantSize = decompPickSize(W, H, mdlDc, isBg(L));
        diag("decomp req " + (i + 1) + "/" + layers.length + " [" + L.name + (isBg(L) ? " · 背景" : "") + "]" +
          (keyMode ? " · 纯色底" : "") + " · size=" + wantSize);
        let r;
        if (isNanoModel(mdlDc)) {
          /* nano 系列：统一端点；aspectRatio 取与画布最接近的比例，逐层归位才准确 */
          if (i === 0) log("提示：拆图元素层统一按「纯洋红底 + 抠色」处理，与模型是否支持透明通道无关");
          diag("路由：统一端点 /v1/api/generate（拆图并发）aspect=" + wantSize);
          r = await callUnifiedGenerate(buildUnifiedPayload(mdlDc, prompt, [base], { params: {} }, wantSize));
        } else {
          /* 只发模型支持的尺寸（自定义像素值会被网关改写，输出比例一变，蒙版就错位） */
          const payload = {
            model: mdlDc,
            prompt: prompt,
            size: wantSize,
            quality: normalizeQualityForModel(mdlDc, getDefaults().quality || "auto"),
            image: base
          };
          try {
            r = await callApi("/v1/images/edits", payload, true);
          } catch (eS) {
            /* 有些模型/网关只接受预设尺寸：退回 auto 再试一次，避免整层失败 */
            const sm = String((eS && eS.message) || "");
            const sizeRelated = /size|尺寸|分辨率|dimension|resolution|invalid.*(width|height)|参数|param/i.test(sm);
            const authRelated = /apikey|api key|unauthor|quota|balance|余额|鉴权/i.test(sm);
            if (wantSize !== "auto" && sizeRelated && !authRelated) {
              diag("decomp: size=" + wantSize + " 被拒（" + sm + "），回退 auto");
              payload.size = "auto";
              r = await callApi("/v1/images/edits", payload, true);
            } else {
              throw eS;
            }
          }
        }
        urls[i] = r.url;
        secsArr[i] = Math.round((Date.now() - tL) / 1000);
        d.results[i].msg = "已生成（" + secsArr[i] + " 秒），等待写入";
      } catch (e) {
        if (d.cancel && /取消/.test(String(e && e.message))) {
          d.results[i].status = "wait";
          d.results[i].msg = "已停止";
        } else {
          d.results[i].status = "err";
          d.results[i].msg = (e && e.message ? e.message : String(e));
          errN++;
          diag("decomp req err [" + L.name + "]: " + ((e && e.stack) || String(e)));
        }
      }
      renderDecompView();
    }

    let nextReq = 0;
    async function reqWorker() {
      while (nextReq < layers.length) {
        const i = nextReq++;
        if (d.cancel) {
          d.results[i].status = "wait";
          d.results[i].msg = "已停止（未执行）";
          renderDecompView();
          continue;
        }
        await requestJob(i);
      }
    }
    /* 并发数：设置 ▸ 默认参数（默认 3，范围 1–6）可调 */
    const nConc = Math.max(1, Math.min(getConcurrency(), layers.length));
    diag("decomp: 并发 " + nConc + " 路请求 / 共 " + layers.length + " 层（含背景 " +
      layers.filter(isBg).length + " 层）");
    log("开始拆图：" + layers.length + " 层 · 并发 " + nConc + " 路请求（写入排队串行）");
    const ws = [];
    for (let k = 0; k < nConc; k++) ws.push(reqWorker());
    await Promise.all(ws);

    /* —— 3a-2) 失败层串行补做一次（并发可能撞限流，串行重试成功率更高） —— */
    const retry = [];
    layers.forEach(function (L, i) {
      if (!urls[i] && d.results[i].status === "err" && !d.cancel) retry.push(i);
    });
    if (retry.length) {
      diag("decomp: " + retry.length + " 层首轮失败，串行补做一次");
      for (let k = 0; k < retry.length; k++) {
        if (d.cancel) break;
        errN--; /* 首轮已计过一次失败，这里先抵消，成败交给补做结果 */
        await requestJob(retry[k]);
      }
    }

    /* —— 3b) 串行写入（背景层先写 → 元素层按蓝图顺序叠加，后写的在上；
     *     原图参考层已是最底，背景层写在它之上、元素层之下，无需再移动） —— */
    const order = [];
    layers.forEach(function (L, i) { if (isBg(L) && urls[i]) order.push(i); });
    layers.forEach(function (L, i) { if (!isBg(L) && urls[i]) order.push(i); });

    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      const L = layers[i];
      if (d.cancel) {
        d.results[i].msg = "已停止（未写入）";
        renderDecompView();
        continue;
      }
      d.results[i].status = "run";
      d.results[i].msg = "写入中…";
      renderDecompView();
      try {
        const mdlW = resolveModel("decomp");
        const keyModeW = !isBg(L);
        const prompt = isBg(L) ? buildDecompBgPrompt(itemNames, L) : buildDecompLayerPrompt(L, keyModeW);
        const layerName = isBg(L) ? "拆图 · 背景" : ("拆图 · " + L.name);
        let entry = null;
        let rebuilt = false;
        let keyed = false;
        let keyProbeFailed = false;
        await execModal(async function () {
          /* 多文档场景：命令作用到「前台文档」，目标文档不在前台时会莫名报
           * 「命令"建立"/"羽化"当前不可用」。每次写入前强制切回目标文档。 */
          ensureActiveDoc(outId);
          /* stretch：模型输出尺寸不可控时也铺满画布，保证蒙版与原图严格对齐 */
          entry = await placeResultAsLayer(urls[i], { left: 0, top: 0, width: W, height: H }, layerName, null, outId, { smartObject: false, stretch: true });
          /* 落图后立刻锁定生成层 id（后续抠色/重建都会改变活动层，不能再靠 activeLayers 现查） */
          let genId = null;
          try { genId = lastPlacedLayer && lastPlacedLayer.id; } catch (eG0) { genId = null; }
          if (genId == null) {
            try {
              const dd = docById(outId);
              const al = dd && dd.activeLayers;
              if (al && al.length) genId = al[0].id;
            } catch (eGen) { /* ignore */ }
          }
          /* 纯色底方案：先确认模型真的给了纯色底，再抠。
           * 四角颜色不统一 = 模型没照做（nano 系列常重新构图/画真实背景），
           * 此时魔棒必然点不中，与其报「抠色失败」，不如直接判定并提示换模型。 */
          if (keyModeW) {
            const probe = await decompProbeKeyBg(outId, genId);
            if (probe && !probe.ok) {
              keyProbeFailed = true;
              probeFailN++;
              diag("decomp: 生成层四角颜色不统一（spread=" + probe.spread + "，" + probe.hex +
                "），判定模型未按纯色底输出 → 跳过抠色");
            } else {
              keyed = await cutLayerByColorKey({ tolerance: 26 });
            }
          }
          /* 元素层：用「模型给的透明通道 + 原图像素」重建，彻底消除生成模型的色调/光照偏移。
           * 失败时自动保留生成层（rebuilt=false），不影响主流程。 */
          if (!isBg(L) && refLayerOk && baseEntry) {
            /* stretch 落图后结果层已铺满画布，蒙版与原图坐标一致，可直接重建 */
            const scaled = !!(lastPlaceMeta && lastPlaceMeta.aspectMismatch);
            if (scaled) {
              diag("decomp: 结果图被等比缩放（" + lastPlaceMeta.lw + "×" + lastPlaceMeta.lh + "），跳过原图色彩重建以避免蒙版错位");
            } else if (genId != null) {
              rebuilt = await rebuildLayerWithOriginalPixels(baseEntry, genId, layerName, W, H, outId,
                { useMask: !!keyed, feather: 1 });
            }
          }
        }, "PS Spark: 拆图写入 " + L.name, 3);
        d.results[i].status = "ok";
        d.results[i].msg = "用时 " + (secsArr[i] || 0) + " 秒" +
          (keyModeW
            ? (keyed ? " · 纯色底抠图"
              : (keyProbeFailed ? " · 模型未给纯色底" : " · 抠色失败（保留模型输出）"))
            : "") +
          (isBg(L) ? "" : (rebuilt ? " · 原图色彩" : " · 模型颜色"));
        okN++;
        /* 归档到历史（每层一条，可在历史 Tab 重新插入） */
        try {
          const fakeInst = { domain: "edit", id: "decomp", name: layerName, cost: { image: 1, text: 0 } };
          const job = storeCreateJob(fakeInst, { userText: "", tplOverride: "", params: {}, locate: {} }, resolveModel("decomp"));
          await storeCompleteJob(job, entry, {
            layerName: layerName, secs: secsArr[i] || 0,
            placeTarget: { left: 0, top: 0, width: W, height: H }, prompt: prompt
          });
        } catch (eS) { diag("decomp store warn: " + eS.message); }
      } catch (e) {
        const m = (e && e.message ? e.message : String(e));
        d.results[i].status = "err";
        /* 把 PS 的原始命令错误翻译成人话：用户看到「命令"建立"当前不可用」
         * 完全无法操作，技术细节留在诊断日志里。 */
        if (/modal/i.test(m)) {
          d.results[i].msg = "写入失败：Photoshop 正忙（可能有未关闭的对话框），关掉后可从历史重新插入";
        } else if (/不可用|not currently available|isn'?t available/i.test(m)) {
          d.results[i].msg = "写入时 Photoshop 拒绝了某条命令（文档状态特殊），该层已跳过，可从历史重新插入";
        } else {
          d.results[i].msg = m;
        }
        errN++;
        diag("decomp write err [" + L.name + "]: " + ((e && e.stack) || String(e)));
      }
      renderDecompView();
    }

    /* 4) 合并为图层组（best-effort，失败则保持散层） */
    if (okN > 0) {
      try {
        await core.executeAsModal(async function () {
          await groupAllLayers(outId, refLayerOk); /* 原图参考层（最底）不参与建组 */
        }, { commandName: "PS Spark: 拆图建组" });
      } catch (eG) { diag("decomp group warn: " + eG.message); }
    }

    /* 有层没拿到纯色底：说清楚原因 + 给下一步动作（否则用户只看到"元素层带着整幅背景"） */
    if (probeFailN > 0) {
      const tip = "⚠ " + probeFailN + " 层没拿到纯洋红底：模型没照做「只画元素 + 平铺洋红」的指令，" +
        "这些层保留的是整幅生成图（没有蒙版）。建议把拆图模型换成 gpt-image-2 / 2.5 后重试。";
      log(tip, "err");
      diag("decomp: probe failed " + probeFailN + " layer(s)");
    }

    const total = Math.round((Date.now() - t0) / 1000);
    d.running = false;
    renderDecompView();
    const doneMsg = "完成（总耗时 " + total + " 秒）：成功 " + okN + " 层" + (errN ? (" · 失败 " + errN + " 层") : "") +
      " · 已创建文档「" + d.outDocName + "」（图层组可再编辑；各层已归档到历史）";
    dcSetRunMsg(doneMsg, errN ? "err" : "ok");
    log(doneMsg, errN ? "err" : "ok");
    diag("=== decomp end === ok=" + okN + " err=" + errN);
  } catch (e) {
    d.running = false;
    renderDecompView();
    diag("decomp fatal: " + ((e && e.stack) || String(e)));
    dcSetRunMsg("拆图失败：" + (e && e.message ? e.message : String(e)), "err");
    log("拆图失败: " + (e && e.message ? e.message : String(e)), "err");
  } finally {
    setRunning(false);
  }
}

/* 把所有图层合并为一个图层组（best-effort）。
 * excludeBottom=true：跳过最底层（拆图的原图参考层，保留在组外作对照） */
async function groupAllLayers(docId, excludeBottom) {
  try {
    const dd = docById(docId);
    if (!dd) return;
    const arr = [];
    const ls = dd.layers;
    const n = excludeBottom ? Math.max(0, ls.length - 1) : ls.length;
    for (let i = 0; i < n; i++) arr.push(ls[i]);
    if (arr.length < 2) return;
    dd.activeLayers = arr;
    await batchPlay([{ _obj: "group", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }]);
    try {
      const g = dd.activeLayers[0];
      if (g) g.name = "拆图分层";
    } catch (e2) { /* ignore */ }
    diag("decomp: 图层已建组（" + arr.length + " 层 → 1 组）");
  } catch (e) {
    diag("decomp group warn: " + e.message);
  }
}

/* 结果缩略图：逐个读取候选结果文件（串行，避免并发读大图占内存） */
async function loadCandsThumbs(run) {
  if (!IS_UXP || !run || !run.cands) return;
  for (let i = 0; i < run.cands.length; i++) {
    const c = run.cands[i];
    if (!c || c.thumbUri || !c.entry) continue;
    try {
      const buf = await c.entry.read({ format: formats.binary });
      c.thumbUri = "data:image/png;base64," + base64FromBuffer(buf);
      if (lastRun === run) refreshResultBlock();
    } catch (e) { diag("cand thumb warn: " + ((e && e.message) || String(e))); }
  }
}

/* ================= 结果查看器（单图 / 并排 / 滑动 / 缩放 / 局部重做） ================= */

const PV = {
  mode: "single", zoom: 1,
  refUri: null, items: [], idx: 0, run: null,
  redoable: false, sel: null, split: 0.5, drag: null, _w: 0, _h: 0
};

function pvWaitImg(img) {
  return new Promise(function (resolve) {
    if (!img) return resolve();
    if (img.complete && img.naturalWidth) return resolve();
    let done = false;
    const fin = function () { if (done) return; done = true; resolve(); };
    img.addEventListener("load", fin);
    img.addEventListener("error", fin);
    setTimeout(fin, 4000);
  });
}

async function pvFullUri(item) {
  if (!item) return "";
  if (item._full) return item._full;
  if (item.uri) return item.uri;
  if (item.entry) {
    try { item._full = await fileToDataURI(item.entry); return item._full; } catch (e) { /* ignore */ }
  }
  return item.thumbUri || item.url || "";
}

function pvSyncModeBtns() {
  const box = $("pvModes");
  if (!box) return;
  const btns = box.querySelectorAll("button");
  for (let i = 0; i < btns.length; i++) {
    btns[i].classList.toggle("on", btns[i].getAttribute("data-mode") === PV.mode);
  }
}

function pvSetMode(m) {
  if (m === "slide" && !PV.refUri) m = "single";
  PV.mode = m;
  PV.sel = null;
  pvSyncModeBtns();
  pvLayout();
  pvUpdateSel();
  pvUpdateRedoBtn();
}

function pvSizeFrame(id, nw, nh, scale) {
  const f = $(id);
  if (!f) return { w: 1, h: 1 };
  const w = Math.max(1, Math.round(nw * scale)), h = Math.max(1, Math.round(nh * scale));
  f.style.width = w + "px"; f.style.height = h + "px";
  f.classList.remove("hidden");
  return { w: w, h: h };
}

function pvLayout() {
  const body = $("pvBody"), stage = $("pvStage");
  const bImg = $("pvImgB"), aImg = $("pvImgA");
  if (!body || !stage || !bImg || !aImg) return;
  const bw = bImg.naturalWidth || 1, bh = bImg.naturalHeight || 1;
  const aw = aImg.naturalWidth || bw, ah = aImg.naturalHeight || bh;
  const availW = Math.max(80, body.clientWidth - 24);
  const availH = Math.max(80, body.clientHeight - 24);
  stage.className = "pv-stage mode-" + PV.mode;
  stage.style.width = ""; stage.style.height = "";
  bImg.style.width = ""; bImg.style.height = ""; bImg.style.marginLeft = "";

  const divider = $("pvDivider");
  if (divider) divider.classList.toggle("hidden", PV.mode !== "slide");

  if (PV.mode === "single") {
    $("pvFrameA").classList.add("hidden");
    pvSizeFrame("pvFrameB", bw, bh, Math.min(availW / bw, availH / bh, 4) * PV.zoom);
  } else if (PV.mode === "side") {
    $("pvFrameA").classList.remove("hidden");
    const half = Math.max(80, (availW - 8) / 2);
    pvSizeFrame("pvFrameA", aw, ah, Math.min(half / aw, availH / ah, 4) * PV.zoom);
    pvSizeFrame("pvFrameB", bw, bh, Math.min(half / bw, availH / bh, 4) * PV.zoom);
  } else {
    $("pvFrameA").classList.remove("hidden");
    const s = Math.min(availW / bw, availH / bh, 4) * PV.zoom;
    const bb = pvSizeFrame("pvFrameB", bw, bh, s);
    pvSizeFrame("pvFrameA", bw, bh, s);
    PV._w = bb.w; PV._h = bb.h;
    stage.style.width = bb.w + "px";
    stage.style.height = bb.h + "px";
    pvApplySplit();
  }
  const z = $("pvZoomVal");
  if (z) z.textContent = Math.round(PV.zoom * 100) + "%";
}

/* 滑动对比：用「裁切 + 反向外边距」实现，避免依赖 clip-path 支持 */
function pvApplySplit() {
  const b = $("pvFrameB"), a = $("pvFrameA"), d = $("pvDivider"), im = $("pvImgB");
  if (!b || !d || !im || !PV._w) return;
  const x = Math.max(1, Math.min(PV._w - 1, Math.round(PV._w * PV.split)));
  b.style.width = (PV._w - x) + "px";
  im.style.width = PV._w + "px";
  im.style.height = PV._h + "px";
  im.style.marginLeft = (-x) + "px";
  d.style.left = x + "px";
  if (a) { a.style.width = PV._w + "px"; a.style.height = PV._h + "px"; }
}

function pvUpdateSel() {
  const sel = $("pvSel");
  if (!sel) return;
  if (!PV.sel || PV.mode !== "single") { sel.classList.add("hidden"); return; }
  const stage = $("pvStage"), f = $("pvFrameB");
  const sr = stage.getBoundingClientRect(), fr = f.getBoundingClientRect();
  sel.style.left = (fr.left - sr.left + PV.sel.x) + "px";
  sel.style.top = (fr.top - sr.top + PV.sel.y) + "px";
  sel.style.width = PV.sel.w + "px";
  sel.style.height = PV.sel.h + "px";
  sel.classList.remove("hidden");
}

function pvUpdateRedoBtn() {
  const btn = $("pvRedoBtn");
  if (!btn) return;
  btn.disabled = !(PV.redoable && PV.sel && !running);
  const hint = $("pvHint");
  if (hint) {
    hint.textContent = PV.redoable
      ? (PV.sel ? ("已选 " + Math.round(PV.sel.w) + "×" + Math.round(PV.sel.h) + " 显示像素，点击按钮只重绘该区域（图像 ×1）")
        : "在图上拖一个矩形，可只重做该区域（图像 ×1）")
      : "该结果不支持局部重做（缺少图层定位信息）";
  }
}

function pvRenderThumbs() {
  const box = $("pvThumbs");
  if (!box) return;
  box.innerHTML = "";
  if (PV.items.length < 2) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  PV.items.forEach(function (it, i) {
    const im = document.createElement("img");
    im.className = "pv-thumb" + (i === PV.idx ? " on" : "");
    im.src = it.thumbUri || it.uri || "";
    im.title = "候选 " + (i + 1);
    im.addEventListener("click", function () { pvShowIndex(i); });
    box.appendChild(im);
  });
}

async function pvShowIndex(i) {
  const item = PV.items[i];
  if (!item) return;
  PV.idx = i;
  PV.sel = null;
  const uri = await pvFullUri(item);
  const bImg = $("pvImgB"), aImg = $("pvImgA");
  bImg.removeAttribute("style");
  bImg.src = uri || "";
  if (PV.refUri) aImg.src = PV.refUri;
  else aImg.removeAttribute("src");
  await pvWaitImg(bImg);
  if (PV.refUri) await pvWaitImg(aImg);
  pvLayout();
  pvUpdateSel();
  pvUpdateRedoBtn();
  pvRenderThumbs();
}

async function openCompareView(o) {
  const ov = $("imgPreview");
  if (!ov) return;
  PV.refUri = o.refUri || null;
  PV.items = (o.items || []).slice();
  PV.run = o.run || null;
  PV.redoable = !!o.redoable;
  PV.zoom = 1; PV.sel = null; PV.split = 0.5;
  PV.mode = PV.refUri ? "side" : "single";
  const cap = $("pvCap");
  if (cap) cap.textContent = o.title || "";
  pvSyncModeBtns();
  ov.classList.remove("hidden");
  document.body.classList.add("preview-open");
  await pvShowIndex(o.idx || 0);
}

/* 单图预览（历史/参考图等）：复用查看器，但无对比与重做 */
function openImagePreview(uri, caption) {
  if (!uri) return;
  openCompareView({ title: caption, refUri: null, items: [{ thumbUri: uri, uri: uri }], idx: 0, redoable: false });
}

function closeImagePreview() {
  const ov = $("imgPreview");
  if (ov) ov.classList.add("hidden");
  document.body.classList.remove("preview-open");
  PV.sel = null; PV.drag = null; PV.items = []; PV.run = null; PV.refUri = null;
}

/* 拖拽画框（仅单图模式 + 支持重做时） */
function pvBindStage() {
  const f = $("pvFrameB");
  if (!f) return;
  f.addEventListener("mousedown", function (e) {
    if (PV.mode !== "single" || !PV.redoable) return;
    const r = f.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < 0 || y < 0 || x > r.width || y > r.height) return;
    PV.drag = { x: x, y: y };
    PV.sel = { x: x, y: y, w: 0, h: 0 };
    pvUpdateSel();
    if (e.preventDefault) e.preventDefault();
  });
  document.addEventListener("mousemove", function (e) {
    if (!PV.drag) return;
    const r = f.getBoundingClientRect();
    const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
    const y = Math.max(0, Math.min(r.height, e.clientY - r.top));
    PV.sel = {
      x: Math.min(PV.drag.x, x), y: Math.min(PV.drag.y, y),
      w: Math.abs(x - PV.drag.x), h: Math.abs(y - PV.drag.y)
    };
    pvUpdateSel();
  });
  document.addEventListener("mouseup", function () {
    if (!PV.drag) return;
    PV.drag = null;
    if (PV.sel && (PV.sel.w < 6 || PV.sel.h < 6)) PV.sel = null;
    pvUpdateSel();
    pvUpdateRedoBtn();
  });
  const d = $("pvDivider");
  if (d) {
    let dragging = false;
    d.addEventListener("mousedown", function (e) { dragging = true; if (e.preventDefault) e.preventDefault(); });
    document.addEventListener("mousemove", function (e) {
      if (!dragging) return;
      const r = f.getBoundingClientRect();
      PV.split = Math.max(0.05, Math.min(0.95, (e.clientX - r.left) / Math.max(1, r.width)));
      pvApplySplit();
    });
    document.addEventListener("mouseup", function () { dragging = false; });
  }
}

/* 局部重做：把查看器里的矩形换算成画布坐标 → 导出区域+蒙版 → edits → 1:1 回贴 */
async function pvDoRedo() {
  if (running) { log("当前有任务在运行，请稍候", "err"); return; }
  if (!PV.sel) return;
  if (!IS_UXP) { log("请在 Photoshop 面板中操作", "err"); return; }
  const cand = PV.items[PV.idx] || {};
  const extra = (($("pvRedoPrompt") && $("pvRedoPrompt").value) || "").trim();
  const bImg = $("pvImgB");
  const nw = bImg.naturalWidth, nh = bImg.naturalHeight;
  if (!nw || !nh) { log("图片尚未加载完成", "err"); return; }

  const selSnap = { x: PV.sel.x, y: PV.sel.y, w: PV.sel.w, h: PV.sel.h };
  const btn = $("pvRedoBtn");
  if (btn) btn.disabled = true;
  setRunning(true);
  startProgress("局部重做");
  try {
    const doc = app.activeDocument;
    if (!doc) throw new Error("请先打开一个文档");
    const docW = Math.round(doc.width), docH = Math.round(doc.height);
    const pad = 16;
    const CH = "pssparkRedoClip";
    let eb = null, imgEntry = null, maskEntry = null, exW = 0, exH = 0;

    await core.executeAsModal(async function () {
      let lb = null;
      if (cand.layerId != null) lb = await getLayerBoundsById(cand.layerId);
      if (!lb) lb = await getActiveLayerBounds();
      if (!lb) throw new Error("找不到结果图层：请在图层面板选中结果图层后重试");

      const kx = lb.width / nw, ky = lb.height / nh;
      let r = {
        left: lb.left + selSnap.x * kx,
        top: lb.top + selSnap.y * ky,
        width: selSnap.w * kx,
        height: selSnap.h * ky
      };
      r.left = Math.max(0, Math.min(docW - 2, r.left));
      r.top = Math.max(0, Math.min(docH - 2, r.top));
      r.width = Math.max(2, Math.min(docW - r.left, r.width));
      r.height = Math.max(2, Math.min(docH - r.top, r.height));

      eb = {
        left: Math.max(0, Math.floor(r.left - pad)),
        top: Math.max(0, Math.floor(r.top - pad)),
        right: Math.min(docW, Math.ceil(r.left + r.width + pad)),
        bottom: Math.min(docH, Math.ceil(r.top + r.height + pad))
      };
      eb.width = eb.right - eb.left;
      eb.height = eb.bottom - eb.top;
      diag("redo: 选区 " + Math.round(r.width) + "×" + Math.round(r.height) +
        " @ " + Math.round(r.left) + "," + Math.round(r.top) + "；导出框 " + eb.width + "×" + eb.height);

      const saved = await saveSelectionToChannel("pssparkPrevSel");
      await setRectSelection(r);
      await batchPlay([{ _obj: "duplicate", _target: [{ _ref: "channel", _property: "selection" }], name: CH }]);
      const ex = await exportRegionToPNG(eb, null);
      imgEntry = ex.entry; exW = ex.actualW; exH = ex.actualH;
      maskEntry = (await buildMaskPNG(eb, null, CH)).entry;
      if (saved) await restoreSelectionFromChannel("pssparkPrevSel");
      else await deselect();
    }, { commandName: "PS Spark: 导出局部重做区域" });

    if (!imgEntry || !maskEntry) throw new Error("区域导出失败");

    const prompt = "只重绘框内区域" + (extra ? "：" + extra : "") +
      "。框外内容必须保持完全不变；框内与周围的光照方向、色温、材质与纹理自然衔接，不要出现接缝、重复结构或风格突变。";
    const mdl = resolveModel("edit");
    const imgUri = await fileToDataURI(imgEntry);
    const maskUri = await fileToDataURI(maskEntry);
    diag("redo: model=" + mdl + " prompt=" + prompt.slice(0, 160));

    let res;
    if (isNanoModel(mdl)) {
      res = await callUnifiedGenerate(buildUnifiedPayload(mdl, prompt, [imgUri], { params: { size: "auto", quality: "auto" } }, "auto"));
    } else {
      res = await callApi("/v1/images/edits", {
        model: mdl,
        prompt: prompt,
        size: normalizeSizeForModel(mdl, "auto"),
        quality: normalizeQualityForModel(mdl, getDefaults().quality || "auto"),
        image: imgUri,
        mask: maskUri
      }, true);
    }

    let entry = null;
    await core.executeAsModal(async function () {
      entry = await placeResultAsLayer(res.url,
        { left: eb.left, top: eb.top, width: exW, height: exH },
        "AI 局部重做", { channel: CH, mask: true }, doc.id, { smartObject: false });
    }, { commandName: "PS Spark: 写入局部重做" });

    const uri = await fileToDataURI(entry);
    const item = PV.items[PV.idx];
    if (item) { item._full = uri; item.uri = uri; item.thumbUri = uri; item.layerId = (lastPlacedLayer && lastPlacedLayer.id) || item.layerId; }
    if (PV.run) {
      PV.run.thumbUri = uri;
      PV.run.statusText = "局部重做完成";
      refreshResultBlock();
    }
    await pvShowIndex(PV.idx);
    log("局部重做完成：仅重绘框内区域（其余像素未改动）", "ok");
  } catch (e) {
    diag("redo fail: " + ((e && e.stack) || String(e)));
    log("局部重做失败：" + ((e && e.message) || String(e)), "err");
  } finally {
    stopProgress();
    setRunning(false);
    pvUpdateRedoBtn();
  }
}

/* 候选结果网格（1~N 张）：多候选时每张配「插入」按钮，选中的落图、其余留档 */
function renderCandCells(b, run) {
  const wrap = b.querySelector(".rb-cands");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!run) return;
  const list = (run.cands && run.cands.length)
    ? run.cands
    : (run.thumbUri ? [{ thumbUri: run.thumbUri, entry: run.entry || null, inserted: true, layerId: run.layerId }] : []);
  const multi = list.length > 1;
  list.forEach(function (c, i) {
    const cell = el("div", "rb-cell");
    const img = document.createElement("img");
    img.className = "rb-thumb";
    img.alt = "";
    if (c.thumbUri) {
      img.src = c.thumbUri;
      img.title = "点击查看大图 / 对比 / 局部重做";
      img.style.cursor = "pointer";
      img.addEventListener("click", function () {
        openCompareView({
          title: multi ? ("候选 " + (i + 1) + "：" + (run.instId || "")) : "结果",
          refUri: run.exportUri || null,
          items: list,
          idx: i,
          run: run,
          redoable: !!IS_UXP
        });
      });
    }
    cell.appendChild(img);
    cell.appendChild(el("div", "rb-cap", multi ? ("候选 " + (i + 1)) : "结果"));
    if (multi) {
      const btn = el("button", "rb-pick" + (c.inserted ? " done" : ""), c.inserted ? "✓ 已插入" : "插入");
      btn.type = "button";
      btn.disabled = !!c.inserted;
      btn.title = "把候选 " + (i + 1) + " 插入为新图层";
      btn.addEventListener("click", function () { pickCandidate(run, i); });
      cell.appendChild(btn);
    }
    wrap.appendChild(cell);
  });
}

/* 从候选网格插入指定一张（已插入的不可重复） */
async function pickCandidate(run, idx) {
  if (running || !run || run !== lastRun) return;
  const c = run.cands && run.cands[idx];
  if (!c || !c.entry || c.inserted) return;
  if (!IS_UXP) { log("请在 Photoshop 面板中运行", "err"); return; }
  if (!app.activeDocument) { log("请先打开一个文档", "err"); return; }
  diag("pickCandidate: #" + (idx + 1) + " " + c.fileName);
  setRunning(true);
  try {
    await placeCandidateForRun(run, idx);
  } catch (e) {
    diag("pickCandidate warn: " + ((e && e.stack) || String(e)));
    log("插入失败：" + ((e && e.message) || String(e)), "err");
  } finally {
    setRunning(false);
    if (!running) stopProgress();
    refreshResultBlock();
  }
}

function refreshResultBlock() {
  const host = currentHost(), inst = currentInstance();
  if (!host || !inst) return;
  const b = host.querySelector(".result-block");
  if (!b) return;
  const s = b.querySelector(".rb-status"), body = b.querySelector(".rb-body"),
    meta = b.querySelector(".rb-meta"), acts = b.querySelector(".rb-actions");
  const refCell = b.querySelector(".rb-cell"); /* 参考图 cell（固定第一个） */
  const imgRef = refCell ? refCell.querySelector("img") : null;

  function showBody(show) { body.classList.toggle("hidden", !show); acts.classList.toggle("hidden", !show); }

  if (running) {
    s.textContent = "运行中…"; s.className = "rb-status";
    showBody(false);
    renderCandCells(b, null);
    if (typeof i18nFlush === "function") i18nFlush(host);
    return;
  }
  if (!lastRun || lastRun.instId !== inst.id) {
    s.textContent = "尚无运行记录"; s.className = "rb-status";
    showBody(false);
    renderCandCells(b, null);
    if (typeof i18nFlush === "function") i18nFlush(host);
    return;
  }
  s.textContent = lastRun.statusText;
  s.className = "rb-status " + (lastRun.level || "");
  if (imgRef && refCell) {
    if (lastRun.exportUri) { imgRef.src = lastRun.exportUri; refCell.classList.remove("hidden"); }
    else refCell.classList.add("hidden");
    if (!imgRef.__pvBound) {
      imgRef.__pvBound = true;
      imgRef.title = "点击放大预览";
      imgRef.style.cursor = "pointer";
      imgRef.addEventListener("click", function () {
        if (imgRef.src) openImagePreview(imgRef.src, "参考图（发送给模型的画面）");
      });
    }
  }
  renderCandCells(b, lastRun);
  meta.textContent = (lastRun.layerName ? (lastRun.layerName + (lastRun.secs != null ? " · 用时 " + lastRun.secs + " 秒" : "")) : "") +
    (lastRun.multi && lastRun.cands ? (" · 共 " + lastRun.cands.length + " 张（选中的已插入，其余在历史）") : "");
  /* 四操作按钮状态 */
  const insBtn = b.querySelector(".rb-ins");
  const favBtn = b.querySelector(".rb-fav");
  const delBtn = b.querySelector(".rb-del");
  const isOk = lastRun.level === "ok";
  /* 多候选：插入动作在每张候选自带的按钮上，总"插入"按钮禁用避免歧义 */
  if (insBtn) insBtn.disabled = !(isOk && lastRun.entry && !lastRun.multi);
  if (favBtn) {
    favBtn.disabled = !lastRun.job;
    favBtn.textContent = lastRun.favorite ? "★ 已收藏" : "☆ 收藏";
  }
  if (delBtn) delBtn.disabled = false; /* 失败记录也允许删除 */
  showBody(true);
  if (typeof i18nFlush === "function") i18nFlush(host);
}

/* 把结果卡滚动进可视区：UXP 不派发滚轮事件，内容区较长时结果卡易被"藏"在下半部，
 * 运行开始/结束时自动带到视野内（结果卡位于运行条下方）。 */
function scrollResultIntoView() {
  try {
    const host = currentHost();
    if (!host) return;
    const rb = host.querySelector(".result-block");
    const main = $("main");
    if (!rb || !main) return;
    if (rb.offsetParent === null) return; /* 当前视图不可见（切换到了其他 Tab） */
    const mRect = main.getBoundingClientRect();
    const rRect = rb.getBoundingClientRect();
    const delta = (rRect.bottom + 12) - mRect.bottom; /* 优先完整展示结果卡 */
    if (delta > 0) { main.scrollTop += delta; return; }
    if (rRect.top - 8 < mRect.top) main.scrollTop += (rRect.top - mRect.top - 8);
  } catch (e) { diag("scrollResultIntoView warn: " + e.message); }
}

/* ================= 上下文轮询（三闸门自动刷新） =================
 * 用户建立/取消选区、切换文档时，运行条状态自动更新（低频，仅 UI 可见域）。 */
function startContextPoll() {
  if (App.__poll) return;
  App.__poll = setInterval(async function () {
    if (!IS_UXP || running) return;
    if (App.tab !== "gen" && App.tab !== "edit") return;
    const inst = currentInstance(), host = currentHost();
    if (!inst || !host || !host.querySelector(".run-wrap")) return;
    let g;
    try { g = await evalRunGate(inst); } catch (e) { return; }
    const sig = (g.ok ? "1" : "0") + "|" + (g.hint || "") + "|" + (g.ctx || "");
    if (host.__gateSig === sig) return;
    host.__gateSig = sig;
    UI.refreshRunBar(host, inst);
  }, 1300);
}

/* ================= 滚动支持（不可见辅助；可视滚动条使用 UXP 系统原生） ================= */

function __isFormControl(t) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName.toLowerCase();
  return tag === "input" || tag === "select" || tag === "textarea" ||
         tag === "button" || tag === "label" || tag === "option";
}

/*
 * 滚动增强：UXP 的 wheel 不稳定、也没有惯性，这里统一接管。
 * 关键点：一帧只写一次 scrollTop —— 每次赋值都会触发同步布局 + 重绘，
 * 逐个 wheel 事件直接赋值（旧实现）在长列表上就是明显的卡顿。
 */
function attachScrollSupport(el2, opts) {
  if (!el2 || el2.__scrollSupport) return;
  el2.__scrollSupport = true;
  const allowContentDrag = !opts || opts.dragScroll !== false;

  let pending = 0, raf = 0;
  const flush = function () {
    raf = 0;
    if (!pending) return;
    const d = pending;
    pending = 0;
    el2.scrollTop = Math.max(0, el2.scrollTop + d);
  };
  const queue = function (d) {
    pending += d;
    if (!raf) raf = requestAnimationFrame(flush);
  };

  el2.addEventListener("wheel", function (e) {
    let d = e.deltaY || 0;
    if (!d) return;
    if (e.deltaMode === 1) d *= 16;                        /* 行 → 像素 */
    else if (e.deltaMode === 2) d *= el2.clientHeight;      /* 页 → 像素 */
    queue(d);
    if (e.preventDefault) e.preventDefault();
  }, { passive: false });

  if (!allowContentDrag) return;

  let dragRaf = 0, dragTarget = 0, dragged = false;
  el2.addEventListener("pointerdown", function (e) {
    if (e.button !== 0) return;
    if (__isFormControl(e.target)) return;
    const startY = e.clientY;
    const startTop = el2.scrollTop;
    dragged = false;
    const onMove = function (ev) {
      if (ev.buttons === 0) { onUp(); return; }
      const dy = ev.clientY - startY;
      if (!dragged && Math.abs(dy) < 5) return;
      dragged = true;
      dragTarget = Math.max(0, startTop - dy);
      if (!dragRaf) dragRaf = requestAnimationFrame(function () {
        dragRaf = 0;
        el2.scrollTop = dragTarget;
      });
    };
    const onUp = function () {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0; el2.scrollTop = dragTarget; }
      /* 拖完紧跟的那次 click 会误选下拉项：标记一下，下面 capture 阶段吞掉 */
      if (dragged) {
        el2.__swallowClick = true;
        setTimeout(function () { el2.__swallowClick = false; }, 0);
      }
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });

  el2.addEventListener("click", function (e) {
    if (!el2.__swallowClick) return;
    el2.__swallowClick = false;
    if (e.stopPropagation) e.stopPropagation();
    if (e.preventDefault) e.preventDefault();
  }, true);
}

/* ================= 事件绑定 ================= */

/* 只有带 data-tab 的才是视图 Tab（⚙ 复用 .tab 的盒模型，不参与切换） */
document.querySelectorAll(".tab[data-tab]").forEach((el2) => {
  el2.addEventListener("click", () => switchTab(el2.dataset.tab));
});
$("btnSettings").addEventListener("click", () => openSettings());
$("btnSettingsBack").addEventListener("click", closeSettings);
$("btnPvClose").addEventListener("click", closeImagePreview);
/* 查看器：模式切换 / 缩放 / 局部重做 / 拖框与分割线 */
pvBindStage();
$("pvModes").addEventListener("click", function (e) {
  const t = e.target;
  const m = t && t.getAttribute ? t.getAttribute("data-mode") : null;
  if (m) pvSetMode(m);
});
$("pvZoomIn").addEventListener("click", function () {
  PV.zoom = Math.min(4, PV.zoom * 1.5); pvLayout(); pvUpdateSel();
});
$("pvZoomOut").addEventListener("click", function () {
  PV.zoom = Math.max(0.25, PV.zoom / 1.5); pvLayout(); pvUpdateSel();
});
$("pvRedoBtn").addEventListener("click", pvDoRedo);
$("imgPreview").addEventListener("click", function (e) {
  /* 点击空白区域也可关闭（头部与图片本体除外） */
  if (e.target && (e.target.classList.contains("pv-body") || e.target.id === "imgPreview")) closeImagePreview();
});
$("logBar").addEventListener("click", () => {
  $("log").classList.toggle("hidden");
  $("logBar").classList.toggle("open");
});
initSettingsDropdowns();
bindSettingsEvents();

attachScrollSupport($("main"), { dragScroll: true });
attachScrollSupport($("settingsBody"), { dragScroll: true });
attachScrollSupport($("log"), { dragScroll: false });
attachScrollSupport($("queueList"), { dragScroll: false });

$("btnQueueCancelAll").addEventListener("click", function (ev) { ev.stopPropagation(); taskCancelAll(); });
$("btnQueueClear").addEventListener("click", function (ev) { ev.stopPropagation(); taskClearDone(); });
$("queueHead").addEventListener("click", function () {
  TASKQ.open = !TASKQ.open;
  renderQueue();
});


/* ---- 滚动条占位同步 ----
 * #main 用 overflow-y:scroll 固定预留滚动条槽位，但顶栏/队列条/底部条在滚动区之外，
 * 不扣掉这条宽度右边线就会比卡片宽出一条滚动条。这里把实测宽度写进 --sbw，
 * 由 CSS 的 calc(var(--pad) + var(--sbw)) 统一扣减。
 * 队列列表自己也可能出滚动条，单独把宽度补给标题行，× 才和「取消全部」对齐。 */
let SBW_BUSY = false;
function syncScrollGutter() {
  /* 同步执行：读一次布局就能拿到滚动条宽度，rAF 在 UXP/无重绘时不一定回调，
     这里宁可多一次 reflow（调用点都是用户操作之后，开销可忽略）。 */
  if (SBW_BUSY) return;
  SBW_BUSY = true;
  try {
    const m = $("main");
    if (!m) return;
    const w = Math.max(0, m.offsetWidth - m.clientWidth);
    try {
      document.documentElement.style.setProperty("--sbw", w + "px");
    } catch (e) {
      document.body.style.setProperty("--sbw", w + "px");
    }
    const list = $("queueList"), head = $("queueHead"), wrapEl = $("queueWrap");
    if (list && head && wrapEl) {
      const hide = wrapEl.classList.contains("hidden") || wrapEl.classList.contains("collapsed");
      const lw = hide ? 0 : Math.max(0, list.offsetWidth - list.clientWidth);
      head.style.paddingRight = lw ? (8 + lw) + "px" : "";
    }
  } finally {
    SBW_BUSY = false;
  }
}

/* ---- 语言切换（设置 ▸ 语言）：默认值由构建渠道决定，用户可随时改 ---- */
function updateLangStatus() {
  const el = $("langStatus");
  if (!el) return;
  const def = (typeof i18nDefaultLang === "function") ? i18nDefaultLang() : "zh";
  const tr = (typeof t === "function") ? t : function (x) { return x; };
  el.textContent = (def === "en" ? tr("默认：English（开源构建）") : tr("默认：中文（内部构建）")) +
    " · " + tr("切换后立即生效，设置会保存在本机");
  if (typeof updateVersionInfo === "function") updateVersionInfo();
  if (typeof updateBrandTip === "function") updateBrandTip();
}

function initLangSetting() {
  const host = $("langDD");
  if (!host) return;
  if (host.__langDD) { host.__langDD.setValue(i18nLang()); updateLangStatus(); return; }
  const dd = UI.makeDropdown(
    [["zh", "中文 / Chinese"], ["en", "English"]],
    (typeof i18nLang === "function") ? i18nLang() : "zh",
    function (v) {
      try { i18nSetLang(v); } catch (e) { diag("i18nSetLang warn: " + e.message); }
      updateLangStatus();
      if (typeof i18nApply === "function") i18nApply();
    }
  );
  host.__langDD = dd;
  host.appendChild(dd.el);
  updateLangStatus();
}

/* ---- 设置分区整体折叠（不再每项一个小折叠） ---- */
function makeSettingsCollapsible() {
  const openByDefault = { secLang: true, secImage: true, secComfy: true };
  ["secLang", "secImage", "secComfy", "secText", "secModelMap", "secDefaults", "secHelp", "secDiag", "secDev"].forEach(function (id) {
    const fs = $(id);
    if (!fs || fs.__collapsible) return;
    fs.__collapsible = true;
    const legend = fs.querySelector("legend");
    const body = document.createElement("div");
    body.className = "sec-body";
    Array.prototype.slice.call(fs.children).forEach(function (c) {
      if (c !== legend) body.appendChild(c);
    });
    fs.appendChild(body);
    if (legend) {
      legend.classList.add("sec-legend");
      legend.addEventListener("click", function () { fs.classList.toggle("sec-collapsed"); });
    }
    if (!openByDefault[id]) fs.classList.add("sec-collapsed");
  });
  /* 功能说明：去掉内层小折叠，跟随分区一起开合 */
  const hl = $("helpList");
  if (hl) hl.classList.remove("collapsed");
  const hm = document.querySelector(".help-master");
  if (hm) hm.classList.add("hidden");
}

/* ---- 品牌与开源提示条（BRAND 在 js/brand.js） ---- */
function updateBrandTip() {
  const tip = $("ossTip");
  const txt = $("ossTipText");
  if (!tip || !txt) return;
  const repo = (typeof brandRepoUrl === "function") ? brandRepoUrl() : "";
  const pub = (typeof brandIsPublic === "function") ? brandIsPublic() : false;
  const lic = (typeof BRAND !== "undefined" && BRAND.license) ? BRAND.license : "AGPL-3.0";
  const tr = (typeof t === "function") ? t : function (x) { return x; };
  if (repo) {
    /* 面板窄，只显示 owner/repo，完整地址放 title；拼接文案按段翻译 */
    const short = repo.replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/^https?:\/\//i, "");
    txt.textContent = (pub ? tr("已开源") : tr("未开源")) + " · " + short + " · " + tr("如购买请退款");
    tip.title = pub
      ? (tr("点击打开源码仓库") + " (" + lic + "): " + repo)
      : (tr("仓库地址不可用：") + repo);
  } else {
    txt.textContent = tr("本软件已开源，如购买请退款");
    tip.title = tr("开源地址将在发布时公布");
  }
}

(function initBrandUi() {
  const tip = $("ossTip");
  if (!tip) return;
  updateBrandTip();
  const repo = (typeof brandRepoUrl === "function") ? brandRepoUrl() : "";
  const pub = (typeof brandIsPublic === "function") ? brandIsPublic() : false;
  tip.addEventListener("click", function () {
    if (pub && repo) {
      if (typeof openExternal === "function") openExternal(repo);
      return;
    }
    if (repo) {
      log("仓库地址暂不可用：" + repo, "ok");
      return;
    }
    log("开源地址尚未公布，发布后会在这里给出", "ok");
  });
})();

/* ================= 启动 ================= */

(async function init() {
  diag("=== app init (W2) ===");

  try { await servicesInit(); } catch (e) { diag("servicesInit warn: " + e.message); }

  /* 界面语言：存档优先，其次 BRAND.defaultLang（开源构建 en / 其余 zh） */
  try { if (typeof i18nInit === "function") i18nInit(); } catch (e) { diag("i18nInit warn: " + e.message); }

  /* 环境自检：写入平台 / PS 版本 / 数据目录真实路径（跨平台问题定位的第一条线索） */
  let ENV = { platform: "browser", ps: "-" };
  try { ENV = await diagEnv("boot"); } catch (e) { diag("diagEnv warn: " + e.message); }

  renderGenView();
  renderEditView();
  makeSettingsCollapsible();
  syncScrollGutter();
  window.addEventListener("resize", syncScrollGutter);
  /* 从 PS 文档切回面板：画布尺寸/选区可能刚在 PS 里改过（如「图像 ▸ 画布大小」），
   * 重渲染当前域让参数卡上的「扩展后画布」等提示跟上真实状态。
   * 节流 800ms：UXP 在切换面板时可能连发多次 focus，避免反复重建闪烁。 */
  let lastFocusRender = 0;
  window.addEventListener("focus", function () {
    const now = Date.now();
    if (now - lastFocusRender < 800) return;
    lastFocusRender = now;
    try {
      if (document.body.classList.contains("settings-open")) return;
      if (document.body.classList.contains("confirm-open")) return;
      const h = (typeof UI !== "undefined" && UI.host) ? UI.host() : null;
      const i = currentInstance();
      if (h && i && typeof UI.renderHost === "function") UI.renderHost(h, i);
    } catch (eF) { diag("focus rerender warn: " + ((eF && eF.message) || eF)); }
  });
  setTimeout(syncScrollGutter, 300); /* 字体/布局稳定后再校准一次 */
  startContextPoll();
  nlBindEvents();

  if (!IS_UXP) {
    updateStatus("浏览器预览模式");
    log("⚠ 当前为浏览器预览：界面可交互（切换域 / 切换实例 / 组件按声明显隐 / 设置表单）；运行与连接测试需在 Photoshop 面板中。");
    log("加载方式：UXP Developer Tool → Add Plugin → 选择 manifest.json → Load → PS 菜单「增效工具 → PS Spark」");
    return;
  }

  try {
    const key = await getImageKey();
    updateGearBadge(!!key);
    if (key) {
      log("已载入本机保存的图像服务密钥（" + maskKey(key) + "）");
      updateStatus("就绪", "ok");
    } else {
      log("尚未配置图像服务：请点右上角 ⚙ 进入设置填写 API Key（填完自动保存）");
      updateStatus("未配置服务");
    }
  } catch (e) {
    diag("init key check warn: " + e.message);
    updateStatus("初始化异常");
  }

  try {
    const tk = await getTextKey();
    App.hasTextKey = !!tk;
  } catch (e) { diag("init text key check warn: " + e.message); }

  try { await storeInit(); } catch (e) { diag("storeInit warn: " + e.message); }

  log("环境：" + ENV.platform + " · Photoshop " + ENV.ps + " · v1.2.0", "ok");
  log("注册表与渲染引擎已就绪（W2）：生成域 2 项 · 编辑域 14 项" + (App.hasTextKey ? " · 提示词助手可用" : " · 提示词助手待配置文本服务") + "。", "ok");
  log("扩展功能已就绪（W4/W5）：扩图 · 结果卡（插入/重跑/收藏/删除）· 历史归档" + (Store.ready ? "（已载入 " + Store.jobs.length + " 条记录）" : "") + "。", "ok");
})();

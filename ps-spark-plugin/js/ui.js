/*
 * ui.js — 公共组件层 + 三闸门渲染引擎（W2）
 *
 * 六组件（定义一次 · 按需出现）：
 *   图像输入（多角色槽）· 定位选项 · 提示词框（4 档）· 参数行（含模板折叠）· 运行条 · 结果卡（最小）
 * 三闸门：组件可见性 = 实例声明 ∩ 服务状态 ∩ 上下文状态
 *   声明缺失 → 隐藏；服务未配置 → 禁用 + 引导设置；上下文缺失 → 禁用 + 就地提示
 */

/* 每实例的会话内状态（切换实例/重新渲染不丢输入） */
const INSTANCE_STATE = {};

/* 模型显示名：本地预设用「本地 · 名称」，云端直接用 id */
function modelLabelFor(model) {
  if (typeof comfyModelLabel === "function") {
    const lab = comfyModelLabel(model);
    if (lab) return lab;
  }
  return model || "—";
}

/* 组件命名空间（须在全部 UI.xxx 赋值之前声明） */
const UI = {};

function getInstanceState(id) {
  if (!INSTANCE_STATE[id]) {
    INSTANCE_STATE[id] = { userText: "", tplOverride: "", params: {}, locate: {}, slots: {} };
  }
  return INSTANCE_STATE[id];
}

/* ---------- 小组件工具 ---------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) {
    /* 创建即翻译：UXP 里 MutationObserver 不可靠，动态面板必须在生成时就是目标语言 */
    let s = text;
    try {
      if (typeof i18nText === "function" && typeof i18nLang === "function" && i18nLang() === "en") {
        s = i18nText(String(text));
      }
    } catch (e) { /* ignore */ }
    n.textContent = s;
    if (s !== text && typeof i18nMark === "function") {
      i18nMark(n.firstChild, text, s); /* 供切回中文时还原 */
    }
  }
  return n;
}

/* 折叠块：head 点击切换 body */
function makeFold(headText, bodyEl) {
  const wrap = el("div", "fold");
  const head = el("div", "fold-head");
  head.appendChild(el("span", "chev", "›"));
  head.appendChild(el("span", null, headText));
  const body = el("div", "fold-body hidden");
  body.appendChild(bodyEl);
  head.addEventListener("click", function () {
    head.classList.toggle("open");
    body.classList.toggle("hidden");
  });
  wrap.appendChild(head);
  wrap.appendChild(body);
  return wrap;
}

/* 文本域自适应高度：UXP 中 textarea 的 rows 属性不可靠（会被压成一行高）。
 * 策略：先按字符数估算（隐藏容器时的兜底），元素可见时同步用 scrollHeight 实测精修
 * （框高精确贴合文本、随面板宽度自适应；上限 300px，超出滚动）。 */
const TA_MAX = 300;

function autoGrowTa(ta, base, text) {
  const len = String(text || "").length;
  const est = Math.max(base, Math.min(TA_MAX, Math.ceil(len / 18) * 18 + 24));
  ta.style.height = est + "px";
  ta.__taBase = base;

  const measure = function () {
    try {
      if (!ta.offsetHeight || ta.offsetHeight <= 1) return false; /* 隐藏容器 / 未挂载：保持估算值 */
      ta.style.height = "1px";
      const sh = ta.scrollHeight;
      if (sh > 24 && sh < 4000) {
        ta.style.height = Math.max(base, Math.min(TA_MAX, sh + 14)) + "px";
        return true;
      }
    } catch (e) { /* ignore */ }
    ta.style.height = est + "px";
    return true;
  };

  if (!measure()) {
    if (ta.__taT) clearTimeout(ta.__taT);
    ta.__taT = setTimeout(measure, 0);
  }
}

/* 输入过程中仅增高（不收缩），避免"边写边滚"；收缩在重渲染 / 替换原文时由 autoGrowTa 精修。
 * 注意：scrollHeight 与 clientHeight 同口径（均不含边框）——用 sh > clientHeight 判断真溢出；
 * 不可与 offsetHeight（含边框）差比，否则内容恰好放下时也会被判为溢出而反复增高
 * （曾导致：点助手按钮→输入框失焦→误增高→按钮位移→点击事件丢失）。 */
function growOnTypeTa(ta, base) {
  try {
    const h = ta.offsetHeight;
    if (h <= 0 || h >= TA_MAX) return;
    if (ta.scrollHeight > ta.clientHeight) {
      ta.style.height = Math.max(base || 64, Math.min(TA_MAX, ta.scrollHeight + 14)) + "px";
    }
  } catch (e) { /* ignore */ }
}

/* 失焦后延迟精排：文本删减后收缩回贴合高度。
 * 延迟 400ms 是为了避开"点击其它按钮"的点击序列（若在 mousedown/mouseup 之间重排，
 * 按钮位移会导致 click 事件丢失）；聚焦中不重排，避免打字跳动。 */
function scheduleRefitTa(ta) {
  if (ta.__taFitT) clearTimeout(ta.__taFitT);
  ta.__taFitT = setTimeout(function () {
    try {
      if (ta.offsetHeight <= 0) return;
      if (document.activeElement === ta) return;
      autoGrowTa(ta, ta.__taBase || 116, ta.value);
    } catch (e) { /* ignore */ }
  }, 400);
}

/* 重新测量：标签页由隐藏变可见时调用，把估算值精修为实测值 */
UI.remeasureTextareas = function (root) {
  if (!root) return;
  try {
    const tas = root.querySelectorAll("textarea");
    for (let i = 0; i < tas.length; i++) {
      const t = tas[i];
      if (t.__taBase) autoGrowTa(t, t.__taBase, t.value);
    }
  } catch (e) { /* ignore */ }
};

/* ---------- 自绘下拉选择（替代原生 <select>：UXP 中原生 select 在滚动容器内会残留残影/错位） ---------- */

let __ddOpenMenu = null;
let __ddDocBound = false;

function __ddCloseAll() {
  if (__ddOpenMenu) {
    __ddOpenMenu.classList.add("hidden");
    __ddOpenMenu = null;
  }
}
function __ddBindDoc() {
  if (__ddDocBound) return;
  __ddDocBound = true;
  document.addEventListener("click", function (e) {
    let n = e.target;
    while (n) {
      if (n.classList && n.classList.contains("dd")) return; /* 点击落在下拉内部：交给它自己处理 */
      n = n.parentNode;
    }
    __ddCloseAll();
  });
}

/* 确保节点滚入"它所在的那个"滚动容器可视区。
 * UXP 无滚轮事件，长面板下半部内容需程序化带入视野；设置层打开时
 * 只能滚动设置体（滚动被覆盖的底层 #main 会引发 UXP 重绘穿透/重叠）。 */
function ensureVisibleInMain(node) {
  try {
    if (!node) return;
    const ov = document.getElementById("settingsOverlay");
    const inSettings = !!(ov && !ov.classList.contains("hidden") && ov.contains(node));
    const scroller = inSettings
      ? document.getElementById("settingsBody")
      : document.getElementById("main");
    if (!scroller) return;
    const sRect = scroller.getBoundingClientRect();
    const nRect = node.getBoundingClientRect();
    const delta = (nRect.bottom + 10) - sRect.bottom;
    if (delta > 0) scroller.scrollTop += delta;
  } catch (e) { /* ignore */ }
}

/* options: [[value, label], ...]（[null, "组名"] = 分组标题）；opts.disabled = 禁用态
 * → { el, getValue, setValue } */
UI.makeDropdown = function (options, value, onChange, opts) {
  __ddBindDoc();
  const disabled = !!(opts && opts.disabled);
  const root = el("div", "dd");
  const btn = el("button", "dd-btn");
  btn.type = "button";
  if (disabled) btn.disabled = true;
  const valEl = el("span", "dd-val");
  const chev = el("span", "dd-chev", "▾");
  btn.appendChild(valEl);
  btn.appendChild(chev);
  const menu = el("div", "dd-menu hidden");
  let cur = value;

  const items = options.map(function (o) {
    if (o[0] === null) { /* 分组标题（不可点选） */
      const head = el("div", "dd-head", o[1]);
      menu.appendChild(head);
      return { value: null, node: head, head: true };
    }
    const item = el("div", "dd-item" + (o[2] ? " off" : ""), o[1]);
    if (o[2]) {
      item.title = o[3] || "不可用";
      item.addEventListener("click", function () {
        if (typeof log === "function") log(o[3] || "该选项不可用", "err");
      });
      menu.appendChild(item);
      return { value: o[0], node: item, off: true };
    }
    item.addEventListener("click", function () {
      setValue(o[0]);
      menu.classList.add("hidden");
      if (__ddOpenMenu === menu) __ddOpenMenu = null;
      if (onChange) onChange(o[0]);
    });
    menu.appendChild(item);
    return { value: o[0], node: item };
  });

  /* 长列表（如 1–4K 尺寸档）在菜单内滚动：挂内容拖拽 + 滚轮兜底（UXP 无 wheel 事件） */
  if (typeof attachScrollSupport === "function") {
    try { attachScrollSupport(menu, { dragScroll: true }); } catch (e) { /* ignore */ }
  }

  function setValue(v) {
    cur = v;
    let label = "";
    items.forEach(function (it) {
      const on = !it.head && it.value === v;
      it.node.classList.toggle("active", on);
      if (on) label = it.node.textContent;
    });
    if (!label) label = (v == null ? "" : String(v));
    valEl.textContent = label;
  }

  btn.addEventListener("click", function () {
    if (disabled) return;
    if (menu.classList.contains("hidden")) {
      __ddCloseAll();
      menu.classList.remove("hidden");
      __ddOpenMenu = menu;
      setTimeout(function () { ensureVisibleInMain(menu); }, 30); /* 流内展开后确保菜单可见 */
    } else {
      menu.classList.add("hidden");
      if (__ddOpenMenu === menu) __ddOpenMenu = null;
    }
  });

  setValue(value);
  root.appendChild(btn);
  root.appendChild(menu);
  return {
    el: root,
    getValue: function () { return cur; },
    setValue: setValue
  };
};

function selectRow(labelText, options, value, onChange) {
  const row = el("div", "prow");
  row.appendChild(el("label", null, labelText));
  const dd = UI.makeDropdown(options, value, onChange);
  row.appendChild(dd.el);
  return row;
}

/* 当前功能需要本地模型具备哪些能力 */
const COMFY_CAP_TEXT = { t2i: "文生图", i2i: "参考图", inpaint: "局部重绘", segment: "分割" };
function comfyCapsForInst(inst, use) {
  if (!inst) return ["t2i"];
  if (use === "decomp" || inst.domain === "decomp") return ["segment"];
  if (inst.domain === "gen") return inst.refMain ? ["i2i"] : ["t2i"];
  /* 编辑域：要蒙版的走 inpaint，其余走图生图 */
  return inst.mask === "auto" ? ["inpaint"] : ["i2i"];
}

/* 模型选项：跟随设置 + 本地预设（在前）+ 云端预设
 * 本地放最前：云端有 16 个，排在后面会被菜单滚动区藏住，看起来像"没有本地选项" */
function modelOptionsFor(use, inst) {
  const opts = [["", "跟随设置（" + defaultModelFor(use) + "）"]];
  const groups = ((typeof comfyModelGroups === "function") ? comfyModelGroups() : [])
    .filter(function (g) {
      /* 还没导入工作流的预设不进模型下拉（设置里仍可见，避免误选） */
      return g.presets.some(function (p) { return !!String(p.workflow || "").trim(); });
    });
  if (groups.length) {
    const need = comfyCapsForInst(inst, use);
    opts.push([null, "本地（ComfyUI）"]);
    groups.forEach(function (g) {
      const hasWf = g.presets.some(function (p) { return !!String(p.workflow || "").trim(); });
      const usable = g.presets.some(function (p) {
        return !!String(p.workflow || "").trim() &&
          need.every(function (c) { return comfySanitizeCaps(p).indexOf(c) >= 0; });
      });
      let note = "";
      if (!hasWf) note = "「" + g.name + "」还没导入工作流（设置 ▸ 本地 ComfyUI）";
      else if (!usable) {
        note = "「" + g.name + "」没有可用于当前功能的本地工作流（需要「" +
          need.map(function (c) { return COMFY_CAP_TEXT[c] || c; }).join("、") + "」）：设置 ▸ 本地 ComfyUI";
      }
      opts.push([comfyModelId(g.presets[0].id), "本地 · " + g.name, !usable, note]);
    });
  }
  if ((IMAGE_MODEL_PRESETS || []).length) {
    opts.push([null, "云端模型"]);
    IMAGE_MODEL_PRESETS.forEach(function (m) { opts.push([m.id, m.label || m.id]); });
  }
  return opts;
}

/* ---------- 渲染引擎 ---------- */

let UI_HOST = null;
UI.host = function () { return UI_HOST; };

UI.renderHost = function (host, inst) {
  if (!host || !inst) return;
  UI_HOST = host;
  host.innerHTML = "";
  const st = getInstanceState(inst.id);
  const rerender = function () { UI.renderHost(host, inst); };

  host.appendChild(el("div", "inst-desc", inst.desc || ""));

  if (inst.slots && inst.slots.length) host.appendChild(UI.slotSection(inst, st, rerender));
  if (inst.locate && inst.locate.length) host.appendChild(UI.locateSection(inst, st));
  const pe = UI.promptSection(inst, st);
  if (pe) host.appendChild(pe);
  const pa = UI.paramsSection(inst, st);
  if (pa) host.appendChild(pa);
  host.appendChild(UI.runBar(inst, st));
  host.appendChild(UI.resultBlock(inst));

  UI.refreshRunBar(host, inst);
  if (typeof i18nFlush === "function") i18nFlush(host);
};

/* ---- 组件 1：图像输入（多角色槽） ---- */

UI.slotSection = function (inst, st, rerender) {
  const card = el("div", "card");
  card.appendChild(el("div", "card-title", "图像输入"));
  (inst.slots || []).forEach(function (slot) {
    const row = el("div", "slot-row");
    row.appendChild(el("span", "slot-role", slot.label + (slot.required ? " *" : "")));
    if (slot.implicit && slot.implicitFile) {
      /* 默认自动取 PS 上下文，但可替换为本地文件（如「原位合成」的底图） */
      const arr = st.slots[slot.role] || (st.slots[slot.role] = []);
      const src = (slot.sources || []).indexOf("selection") >= 0 ? "选区／画布" : "画布";
      if (arr.length) {
        const thumbs = el("div", "slot-thumbs");
        arr.forEach(function (item, idx) {
          const th = el("div", "slot-thumb");
          const img = document.createElement("img");
          img.src = item.uri;
          img.alt = item.name || "";
          th.appendChild(img);
          const rm = el("span", "rm", "×");
          rm.title = "移除（改回自动取当前画面）";
          rm.addEventListener("click", function (e) {
            e.stopPropagation();
            arr.splice(idx, 1);
            rerender();
          });
          th.appendChild(rm);
          thumbs.appendChild(th);
        });
        const back = el("button", "slot-add", "改回自动");
        back.type = "button";
        back.title = "移除本地图片，改回自动取当前" + src;
        back.addEventListener("click", function () { arr.length = 0; rerender(); });
        thumbs.appendChild(back);
        row.appendChild(thumbs);
      } else {
        row.appendChild(el("span", "slot-note", "自动取自 PS 当前" + src + "（也可改用本地图片或选中图层）"));
        const useL = el("button", "slot-add", "＋ 当前图层");
        useL.type = "button";
        useL.title = "在 PS 图层面板选中图层（可多选）后点此处，直接用该图层作为" + slot.label;
        useL.addEventListener("click", function () { addSlotFromLayers(slot, st, rerender); });
        row.appendChild(useL);
        const use = el("button", "slot-add", "改用本地图片");
        use.type = "button";
        use.title = "默认自动使用当前画面；也可选一张本地图片作为" + slot.label;
        use.addEventListener("click", function () { pickSlotFile(slot, st, rerender); });
        row.appendChild(use);
      }
      card.appendChild(row);
      return;
    }
    if (slot.implicit) {
      const src = (slot.sources || []).indexOf("selection") >= 0 ? "选区／画布" : "画布";
      row.appendChild(el("span", "slot-note", "自动取自 PS 当前" + src + "（无需手动选择）"));
      card.appendChild(row);
      return;
    }
    const arr = st.slots[slot.role] || (st.slots[slot.role] = []);
    const thumbs = el("div", "slot-thumbs");
    arr.forEach(function (item, idx) {
      const th = el("div", "slot-thumb");
      const img = document.createElement("img");
      img.src = item.uri;
      img.alt = item.name || "";
      th.appendChild(img);
      const rm = el("span", "rm", "×");
      rm.title = "移除";
      rm.addEventListener("click", function (e) {
        e.stopPropagation();
        arr.splice(idx, 1);
        diag("slot " + slot.role + " -= " + item.name);
        rerender();
      });
      th.appendChild(rm);
      thumbs.appendChild(th);
    });
    const max = (slot.count && slot.count.max) || 1;
    if (arr.length < max) {
      const addL = el("button", "slot-add", "＋ 当前图层");
      addL.type = "button";
      addL.title = "在 PS 图层面板选中图层（可多选）后点此直接加入，无需先导出文件";
      addL.addEventListener("click", function () { addSlotFromLayers(slot, st, rerender); });
      thumbs.appendChild(addL);
      const add = el("button", "slot-add", "＋ 本地文件");
      add.type = "button";
      add.title = "从磁盘选择图片（png / jpg / webp）";
      add.addEventListener("click", function () { pickSlotFile(slot, st, rerender); });
      thumbs.appendChild(add);
    }
    row.appendChild(thumbs);
    card.appendChild(row);
    if (slot.count && slot.count.max > 1) {
      card.appendChild(el("div", "slot-note", "支持 " + ((slot.count.min || 1)) + "~" + slot.count.max + " 张 · 来源：PS 选中图层（可多选）或本地文件"));
    }
    if (slot.hint) {
      card.appendChild(el("div", "slot-note", "提示：" + slot.hint));
    }
  });
  return card;
};

async function pickSlotFile(slot, st, rerender) {
  if (!IS_UXP) { log("浏览器预览无法选择文件，请在 Photoshop 面板中操作", "err"); return; }
  const arr = st.slots[slot.role] || (st.slots[slot.role] = []);
  const max = (slot.count && slot.count.max) || 1;
  if (arr.length >= max) { log("「" + slot.label + "」最多 " + max + " 张", "err"); return; }
  try {
    const f = await fs.getFileForOpening({ types: ["png", "jpg", "jpeg", "webp"] });
    if (!f) return;
    const uri = await fileToDataURI(f);
    arr.push({ name: f.name || ("图 " + (arr.length + 1)), uri: uri });
    diag("slot " + slot.role + " += " + f.name + " (" + Math.round(uri.length / 1024) + "KB b64)");
    rerender();
  } catch (e) {
    log("选择文件失败: " + e.message, "err");
  }
}

/*
 * 从 PS 选中图层一键加入槽位（可多选）。
 * UXP 无法把图层面板里的图层"拖"进插件面板（无跨面板拖放 API），
 * 此交互为等效实现：图层里选好 → 这里点一下 → 自动导出为槽位图片。
 */
async function addSlotFromLayers(slot, st, rerender) {
  if (!IS_UXP) { log("浏览器预览无法读取 PS 图层，请在 Photoshop 面板中操作", "err"); return; }
  const arr = st.slots[slot.role] || (st.slots[slot.role] = []);
  const max = (slot.count && slot.count.max) || 1;
  const room = max - arr.length;
  if (room <= 0) { log("「" + slot.label + "」最多 " + max + " 张", "err"); return; }
  try {
    /* 画布对齐槽（原位合成资产）：先把选中图层合并成一张与画布同尺寸的图，
     * 位置与原图一致 → 模型无需重新摆放，也就不会"资产偏移"。 */
    if (slot.alignCanvas) {
      log("正在把选中图层合并为一张画布对齐的资产图…");
      const m = await exportActiveLayersMergedCanvasPng();
      arr.push({
        name: "资产（合并 " + m.count + " 层）",
        uri: m.uri, from: "layer", aligned: true, w: m.w, h: m.h
      });
      log("已合并 " + m.count + " 层为 1 张对齐资产（" + m.w + "×" + m.h + "，位置保持原样）", "ok");
      rerender();
      return;
    }
    log("正在导出 PS 选中图层…（可多选；图层多时逐张导出）");
    const r = await exportActiveLayersToSlotItems(room, 2048);
    r.items.forEach(function (it) {
      arr.push({ name: it.name, uri: it.uri, from: "layer" });
    });
    let msg = "已加入 " + r.items.length + " 张图层到「" + slot.label + "」";
    if (r.total > room) msg += "（选中 " + r.total + " 个，受上限 " + max + " 张限制）";
    if (r.failed && r.failed.length) msg += "；" + r.failed.length + " 个图层导出失败：" + r.failed.join("、");
    log(msg, (r.failed && r.failed.length) ? "" : "ok");
    rerender();
  } catch (e) {
    log("从图层添加失败：" + (e && e.message ? e.message : String(e)), "err");
  }
}

/* ---- 组件 2：定位选项 ---- */

UI.locateSection = function (inst, st) {
  const card = el("div", "card");
  card.appendChild(el("div", "card-title", "定位选项"));
  const loc = resolveLocate(inst, st);
  if (inst.locate.indexOf("box") >= 0) {
    const lb = el("label", "check");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!loc.box;
    cb.addEventListener("change", function () {
      st.locate.box = cb.checked;
      const h = UI.host(), i = inst;
      if (h) UI.refreshRunBar(h, i);
    });
    lb.appendChild(cb);
    lb.appendChild(document.createTextNode(" 色框标记定位（自动选醒目颜色描边并在提示词中说明）"));
    card.appendChild(lb);
  }
  if (inst.locate.indexOf("clip") >= 0) {
    const lb = el("label", "check");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!loc.clip;
    cb.addEventListener("change", function () { st.locate.clip = cb.checked; });
    lb.appendChild(cb);
    lb.appendChild(document.createTextNode(" 结果裁剪到选区（选区外保留原图）"));
    card.appendChild(lb);
  }
  return card;
};

/* ---- 剪贴板：UXP 面板里 Cmd+V 常常不落到 <textarea>（PS 先把快捷键吃了），
 * 所以提供一个显式「粘贴」按钮 + Cmd+V 兜底监听。manifest 已声明 clipboard 权限。 ---- */

function readClipboardText() {
  return new Promise(function (resolve) {
    const clip = (typeof navigator !== "undefined") ? navigator.clipboard : null;
    if (!clip) { resolve(""); return; }
    try {
      if (typeof clip.getContent === "function") {
        clip.getContent().then(function (d) {
          resolve((d && (d["text/plain"] || d["text"])) || "");
        }, function () { resolve(""); });
        return;
      }
      if (typeof clip.readText === "function") {
        clip.readText().then(function (t) { resolve(t || ""); }, function () { resolve(""); });
        return;
      }
      resolve("");
    } catch (e) { resolve(""); }
  });
}

/* 把文本插到光标处（拿不到光标就追加），然后触发一次 onChange 同步状态 */
function insertIntoTextarea(ta, text, onChange) {
  let s = null, e = null;
  try { s = ta.selectionStart; e = ta.selectionEnd; } catch (err) { /* UXP 可能不支持 */ }
  const v = String(ta.value || "");
  let next;
  if (typeof s === "number" && typeof e === "number" && s >= 0) {
    next = v.slice(0, s) + text + v.slice(e);
    try { ta.selectionStart = ta.selectionEnd = s + text.length; } catch (err2) { /* ignore */ }
  } else {
    next = v ? (v + text) : text;
  }
  ta.value = next;
  if (typeof onChange === "function") onChange();
}

/* 提示词框旁的「粘贴」按钮；同时给 Cmd/Ctrl+V 加兜底：
 * 按键后 180ms 文本没变 → 默认粘贴没生效，自己读剪贴板补上。 */
function attachPasteTools(ta, tools, onChange) {
  const btn = el("button", "p-btn", "📋 粘贴");
  btn.type = "button";
  btn.title = "从系统剪贴板粘贴（UXP 里 Cmd+V 可能无效，用这个）";
  btn.addEventListener("click", function () {
    readClipboardText().then(function (txt) {
      if (!txt) { log("剪贴板里没有文本（或剪贴板权限未生效）", "err"); return; }
      insertIntoTextarea(ta, txt, onChange);
    });
  });
  tools.appendChild(btn);

  ta.addEventListener("keydown", function (ev) {
    const k = ev && (ev.key || ev.keyCode);
    const isV = (k === "v" || k === "V" || k === 86);
    if (!isV || !(ev.metaKey || ev.ctrlKey)) return;
    const before = String(ta.value || "");
    setTimeout(function () {
      if (String(ta.value || "") === before) {
        readClipboardText().then(function (txt) {
          if (!txt) return;
          insertIntoTextarea(ta, txt, onChange);
          log("已从剪贴板粘贴（Cmd+V 未生效的兜底路径）", "info");
        });
      }
    }, 180);
  });
}

/* ---- 提示词助手（文本服务 · 提示词框内联工具槽） ---- */

function assistTool(inst, st, getText, setText, pasteOpts) {
  const box = el("div", "assist");
  const tools = el("div", "prompt-tools");
  const toggle = el("button", "p-btn assist-btn", "✨ 提示词助手");
  toggle.type = "button";
  toggle.title = "用文本服务改写/扩写/翻译提示词（每次消耗 1 次文本请求）";
  tools.appendChild(toggle);
  if (pasteOpts && pasteOpts.ta) attachPasteTools(pasteOpts.ta, tools, pasteOpts.onChange);
  box.appendChild(tools);

  const panel = el("div", "assist-panel hidden");
  const chips = el("div", "assist-chips");
  const statusEl = el("div", "assist-status", "");
  const resultTa = document.createElement("textarea");
  resultTa.rows = 3;
  resultTa.className = "assist-result hidden";
  resultTa.readOnly = true;
  const ops = el("div", "assist-ops hidden");
  const applyBtn = el("button", "p-btn", "替换原文");
  applyBtn.type = "button";
  const closeBtn = el("button", "p-btn", "关闭");
  closeBtn.type = "button";
  ops.appendChild(applyBtn);
  ops.appendChild(closeBtn);
  panel.appendChild(chips);
  panel.appendChild(statusEl);
  panel.appendChild(resultTa);
  panel.appendChild(ops);
  box.appendChild(panel);

  let busy = false;
  const actionBtns = ASSIST_ACTIONS.map(function (a) {
    const c = el("button", "assist-chip", a.name);
    c.type = "button";
    c.addEventListener("click", function () { runAction(a); });
    chips.appendChild(c);
    return c;
  });

  function setBusy(v) {
    busy = v;
    actionBtns.forEach(function (c) { c.disabled = v; });
    toggle.disabled = v;
  }

  function resetStatus() {
    statusEl.className = "assist-status";
    statusEl.textContent = "选择一种改写方式（消耗 1 次文本请求）";
    if (typeof App !== "undefined" && App.hasTextKey === false) {
      statusEl.className = "assist-status warn";
      statusEl.textContent = "未配置文本服务：请到 右上角 ⚙ 设置 ▸ 服务接入 ▸ 文本服务 填写 API Key 与模型";
    }
  }

  async function runAction(a) {
    if (busy) return;
    panel.classList.remove("hidden");
    const text = (getText() || "").trim();
    if (!text) {
      statusEl.className = "assist-status warn";
      statusEl.textContent = "请先在提示词框输入内容，再让助手改写";
      return;
    }
    setBusy(true);
    statusEl.className = "assist-status";
    statusEl.textContent = "正在调用文本服务（" + a.name + "）…";
    resultTa.classList.add("hidden");
    ops.classList.add("hidden");
    try {
      const out = await callTextApi([
        { role: "system", content: a.sys },
        { role: "user", content: text }
      ]);
      resultTa.value = out;
      autoGrowTa(resultTa, 150, out); /* 结果框按内容自适应（150px 起，避免"一行高+滚动"） */
      resultTa.classList.remove("hidden");
      ops.classList.remove("hidden");
      statusEl.className = "assist-status ok";
      statusEl.textContent = "建议已生成 · 「替换原文」应用，或换一种方式再生成";
      if (typeof App !== "undefined") App.hasTextKey = true;
    } catch (e) {
      statusEl.className = "assist-status err";
      statusEl.textContent = "失败：" + (e && e.message ? e.message : String(e));
      log("提示词助手失败: " + (e && e.message ? e.message : String(e)), "err");
    } finally {
      setBusy(false);
    }
  }

  toggle.addEventListener("click", function () {
    if (panel.classList.contains("hidden")) {
      panel.classList.remove("hidden");
      resetStatus();
    } else {
      panel.classList.add("hidden");
    }
  });

  applyBtn.addEventListener("click", function () {
    if (!resultTa.value) return;
    setText(resultTa.value);
    statusEl.className = "assist-status ok";
    statusEl.textContent = "已替换 ✓（可继续让助手改写）";
    ops.classList.add("hidden");
    resultTa.classList.add("hidden");
  });
  closeBtn.addEventListener("click", function () {
    panel.classList.add("hidden");
  });

  return box;
}

/* ---- 组件 3：提示词框（4 档：无 / 自动 / 可选 / 必需） ---- */

UI.promptSection = function (inst, st) {
  const lvl = inst.prompt;
  if (lvl === "none") return null; /* 无档：系统内置模板，不渲染任何提示词 UI */
  const card = el("div", "card");
  const title = lvl === "required" ? "提示词（必填）" : (lvl === "optional" ? "提示词（可选）" : "提示词（内置模板）");
  card.appendChild(el("div", "card-title", title));

  const ta = document.createElement("textarea");
  const onPromptChange = function () {
    st.userText = ta.value;
    growOnTypeTa(ta, ta.__taBase || 116); /* 边写边长（输入阶段仅增高） */
    scheduleRefitTa(ta);                   /* 失焦后精排（可收缩回贴合高度） */
    const h = UI.host();
    if (h) UI.refreshRunBar(h, inst);
  };
  const bind = function () {
    ta.addEventListener("input", onPromptChange);   /* 主路径（UXP 支持 input） */
    ta.addEventListener("change", onPromptChange);  /* 兜底：失焦时同步，防止个别版本不派发 input */
  };

  if (lvl === "required") {
    ta.rows = 3;
    ta.className = "ta-prompt";
    ta.placeholder = inst.promptPlaceholder || "描述要修改的内容…";
    ta.value = st.userText || "";
    autoGrowTa(ta, 116, st.userText);
    bind();
    card.appendChild(ta);
    card.appendChild(assistTool(inst, st,
      function () { return ta.value; },
      function (v) {
        ta.value = v;
        st.userText = v;
        autoGrowTa(ta, 116, v); /* 替换成长文本后，主输入框同步长高 */
        const h = UI.host();
        if (h) UI.refreshRunBar(h, inst);
      }, { ta: ta, onChange: onPromptChange }));
    return card;
  }

  if (lvl === "optional") {
    ta.rows = 2;
    ta.className = "ta-supp";
    ta.placeholder = "补充要求（可留空）…";
    ta.value = st.userText || "";
    autoGrowTa(ta, 64, st.userText);
    bind();
    const wrap = el("div");
    wrap.appendChild(ta);
    wrap.appendChild(assistTool(inst, st,
      function () { return ta.value; },
      function (v) {
        ta.value = v;
        st.userText = v;
        autoGrowTa(ta, 64, v);
        const h = UI.host();
        if (h) UI.refreshRunBar(h, inst);
      }, { ta: ta, onChange: onPromptChange }));
    card.appendChild(makeFold("补充提示（可选）", wrap));
    return card;
  }

  /* auto 档：不渲染输入框；模板折叠项在参数区提供（spec §4.1） */
  return null;
};

/* ---- 组件 4：参数行（+ auto 档的模板折叠） ---- */

UI.paramsSection = function (inst, st) {
  const hasParams = inst.params && inst.params.length;
  const showTpl = inst.prompt === "auto";
  const hasModel = inst.modelUse === "gen" || inst.modelUse === "edit";
  if (!hasParams && !showTpl && !hasModel) return null;
  const card = el("div", "card");
  card.appendChild(el("div", "card-title", "参数"));

  if (showTpl) {
    const ta = document.createElement("textarea");
    ta.rows = 4;
    ta.className = "ta-tpl";
    ta.placeholder = (inst.promptTpl && inst.promptTpl.text) || "";
    ta.value = st.tplOverride || "";
    autoGrowTa(ta, 116, st.tplOverride);
    ta.addEventListener("input", function () { st.tplOverride = ta.value; });
    ta.addEventListener("change", function () { st.tplOverride = ta.value; });
    const wrap = el("div");
    wrap.appendChild(ta);
    wrap.appendChild(el("div", "dim-note", "留空 = 使用内置模板（上方灰字即内置模板，可微调后生效）"));
    card.appendChild(makeFold("模板（可查看 / 微调）", wrap));
  }

  const d = paramDefaultsFor(inst);
  const val = function (k) {
    if (inst.paramOverrides && inst.paramOverrides[k] != null) return inst.paramOverrides[k];
    return (st.params && st.params[k] != null) ? st.params[k] : d[k];
  };
  /* 尺寸/质量的可选项与当前实例实际使用的模型联动（不同模型支持范围不同） */
  const mdl = resolveModel(inst.modelUse);

  (inst.params || []).forEach(function (k) {
    if (k === "size") {
      card.appendChild(selectRow("尺寸", sizeOptionsForModel(mdl),
        normalizeSizeForModel(mdl, val("size")), function (v) { st.params.size = v; }));
      /* 分辨率（imageSize）：仅部分 nano-banana 模型提供，且各模型可选范围不同 */
      const iso = imageSizeOptionsForModel(mdl);
      if (iso.length) {
        card.appendChild(selectRow("分辨率", iso.map(function (v) { return [v, v]; }),
          normalizeImageSizeForModel(mdl, st.params.imageSize),
          function (v) { st.params.imageSize = v; }));
      }
    } else if (k === "quality") {
      const qo = qualityOptionsForModel(mdl);
      if (qo.length) {   /* 模型无质量档位（如 nano-banana 系列）→ 不渲染该行 */
        card.appendChild(selectRow("质量", qo,
          normalizeQualityForModel(mdl, val("quality")), function (v) { st.params.quality = v; }));
      }
    } else if (k === "transparent") {
      const row = el("div", "prow");
      const lb = el("label", "chk");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      const forced = !!(inst.paramOverrides && inst.paramOverrides.transparent != null);
      cb.checked = !!val("transparent");
      if (forced) cb.disabled = true;
      cb.addEventListener("change", function () { st.params.transparent = cb.checked; });
      lb.appendChild(cb);
      lb.appendChild(document.createTextNode("透明背景" + (forced ? "（此功能固定开启）" : "")));
      row.appendChild(lb);
      card.appendChild(row);
    } else if (k === "color") {
      const row = el("div", "prow");
      row.appendChild(el("label", null, "目标颜色"));
      const inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = "#RRGGBB";
      inp.value = val("color");
      const sw = el("span", "swatch");
      sw.style.background = val("color");
      inp.addEventListener("change", function () {
        st.params.color = inp.value.trim();
        sw.style.background = st.params.color;
      });
      row.appendChild(inp);
      row.appendChild(sw);
      card.appendChild(row);
    } else if (k === "variants") {
      card.appendChild(selectRow("候选张数", [[1, "1 张（默认）"], [2, "2 张"], [3, "3 张"], [4, "4 张"]],
        parseInt(val("variants"), 10) || 1,
        function (v) {
          st.params.variants = v;
          const h = UI.host();
          if (h) UI.refreshRunBar(h, inst);
        }));
      card.appendChild(el("div", "dim-note", "多张候选：并发生成，选一张插入，其余自动存入历史（可从历史再插入）"));
    } else if (k === "strength") {
      card.appendChild(selectRow("强度", [["light", "轻（保留原图更多）"], ["medium", "中（推荐）"], ["strong", "重（完全重渲染光影）"]],
        val("strength") || "medium",
        function (v) { st.params.strength = v; }));
      card.appendChild(el("div", "dim-note", "强度通过结果图层的融合比例实现：轻=更多保留原图，重=完全采用重新渲染的光影"));
    } else if (k === "expand") {
      const cur = val("expand") || {};
      const mode = (cur.mode === "pixels") ? "pixels" : "percent";
      /* 画布尺寸：百分比是「每一边相对原图宽/高」，不显示很容易误判
         （100% ≠ 放大一倍，而是三倍画布）。 */
      let dw = 0, dh = 0;
      try {
        if (typeof app !== "undefined" && app.activeDocument) {
          dw = Math.round(app.activeDocument.width);
          dh = Math.round(app.activeDocument.height);
        }
      } catch (eDoc) { dw = 0; dh = 0; }

      /* 口径切换：把当前数值按画布尺寸换算过去，避免切到像素后全变 0 */
      const mrow = selectRow("扩展方式", [["percent", "按百分比（相对原图）"], ["pixels", "按像素（绝对值）"]],
        mode, function (v) {
          var c0 = val("expand") || {};
          var s0 = (typeof expandSidesOf === "function")
            ? expandSidesOf(c0, dw || 1, dh || 1) : null;
          var e2 = Object.assign({}, c0);
          e2.mode = (v === "pixels") ? "pixels" : "percent";
          if (s0) {
            if (e2.mode === "pixels") {
              e2.px = { left: s0.left, right: s0.right, up: s0.up, down: s0.down };
            } else {
              e2.left = dw ? Math.round(s0.left / dw * 100) : 0;
              e2.right = dw ? Math.round(s0.right / dw * 100) : 0;
              e2.up = dh ? Math.round(s0.up / dh * 100) : 0;
              e2.down = dh ? Math.round(s0.down / dh * 100) : 0;
            }
          }
          st.params.expand = e2;
          const h = UI.host();
          if (h) UI.renderHost(h, inst);
        });
      card.appendChild(mrow);

      const isPx = mode === "pixels";
      const row = el("div", "prow");
      row.appendChild(el("label", null, isPx ? "扩展 px" : "扩展 %"));
      const sizeNote = el("div", "dim-note", "");
      const warnNote = el("div", "dim-note warn-note", "");
      const refreshExpandNote = function () {
        /* 画布可能刚被用户在 PS 里改过（图像 ▸ 画布大小）：每次刷新都重读真实尺寸，
         * 不要用渲染参数卡那一刻的快照，否则提示里的「扩展后画布」会一直是旧值。 */
        try {
          if (typeof app !== "undefined" && app.activeDocument) {
            dw = Math.round(app.activeDocument.width);
            dh = Math.round(app.activeDocument.height);
          }
        } catch (eRe) { /* 保留上一次的值 */ }
        const c2 = val("expand") || {};
        if (!dw || !dh) {
          sizeNote.textContent = "打开一个文档后可预览扩展后的画布尺寸";
          warnNote.textContent = "";
          return;
        }
        const s2 = (typeof expandSidesOf === "function")
          ? expandSidesOf(c2, dw, dh)
          : { left: 0, right: 0, up: 0, down: 0 };
        sizeNote.textContent = "扩展后画布 " + (dw + s2.left + s2.right) + "×" + (dh + s2.up + s2.down) +
          "（原 " + dw + "×" + dh + " · 左 " + s2.left + " / 右 " + s2.right +
          " / 上 " + s2.up + " / 下 " + s2.down + " px）";
        let warn = "";
        try {
          if (typeof expandLimitWarning === "function") {
            warn = expandLimitWarning(resolveModel(inst.modelUse), dw, dh, s2.left, s2.right, s2.up, s2.down);
            /* 警告由「像素超限；比例超限」两段拼成：逐段翻译，整句词典匹配不到 */
            if (warn && typeof i18nText === "function") {
              warn = warn.split("；").map(function (x) { return i18nText(x); }).join("；");
            }
          }
        } catch (eW) { warn = ""; }
        warnNote.textContent = warn ? ("⚠ " + warn) : "";
      };
      [["up", "上"], ["right", "右"], ["down", "下"], ["left", "左"]].forEach(function (pair) {
        const kk = pair[0];
        const box = el("div", "mini-box");
        const lab = el("div", "mini-lab", pair[1]);
        const inp = document.createElement("input");
        inp.type = "text";
        inp.className = "mini";
        const curVal = isPx ? ((cur.px && cur.px[kk] != null) ? cur.px[kk] : 0)
          : ((cur[kk] != null) ? cur[kk] : 25);
        inp.value = String(curVal);
        /* 实时应用：改完数字立刻刷新「扩展后画布」与超限警告（不必等失焦）。
         * 输入过程中不回写 inp.value——否则输 "1" 就被规范化，没法接着输 "10"。 */
        const applyExpandInput = function () {
          if (String(inp.value).trim() === "") return;
          var n = parseInt(inp.value, 10);
          if (isNaN(n)) n = isPx ? 0 : 25;
          n = Math.max(0, Math.min(isPx ? 8000 : 200, n));
          var e2 = Object.assign({}, val("expand") || {});
          if (isPx) {
            e2.px = Object.assign({}, e2.px || {}, {});
            e2.px[kk] = n;
            e2.mode = "pixels";
          } else {
            e2[kk] = n;
            e2.mode = "percent";
          }
          st.params.expand = e2;
          refreshExpandNote();
        };
        inp.addEventListener("input", applyExpandInput);
        inp.addEventListener("keyup", applyExpandInput);
        inp.addEventListener("change", function () {
          applyExpandInput();
          /* 失焦/回车时把显示值规范化（清空 → 默认值，超范围 → 上限） */
          var n = parseInt(inp.value, 10);
          if (isNaN(n)) n = isPx ? 0 : 25;
          inp.value = String(Math.max(0, Math.min(isPx ? 8000 : 200, n)));
        });
        box.appendChild(lab);
        box.appendChild(inp);
        row.appendChild(box);
      });
      card.appendChild(row);
      refreshExpandNote();
      card.appendChild(sizeNote);
      card.appendChild(warnNote);
    }
  });

  /* 模型选择放在参数末尾：生图域在「候选张数」下方，编辑域在参数卡片底部 */
  const use = inst.modelUse === "gen" ? "gen" : (inst.modelUse === "edit" ? "edit" : null);
  if (use) {
    let cur = getModelOverride(use);
    /* 旧值 "comfy" 没有指向具体预设：落到该用途的默认预设 */
    if (cur === "comfy") cur = comfyModelId(getComfyDefault(use) || (getComfyPresets()[0] || {}).id);
    /* 同一模型有多条工作流时，下拉只显示组内第一条；运行时按功能自动选 */
    if (typeof comfyModelDisplayId === "function") cur = comfyModelDisplayId(cur);
    const mrow = selectRow("模型", modelOptionsFor(use, inst), cur, function (v) {
      setModelOverride(use, v);
      const h = UI.host();
      if (h) UI.renderHost(h, inst);
    });
    mrow.setAttribute("data-model-use", use);
    card.appendChild(mrow);
    if (isComfyModel(cur)) {
      const p = getComfyPreset(comfyPresetIdOf(cur));
      const need = comfyCapsForInst(inst, use);
      if (!p) card.appendChild(el("div", "dim-note", "该本地预设已删除：设置 ▸ 本地 ComfyUI"));
      else {
        const g = comfyGroupOfPreset(p) || { name: p.name, presets: [p] };
        const hasWf = g.presets.some(function (x) { return !!String(x.workflow || "").trim(); });
        const usable = g.presets.some(function (x) {
          return !!String(x.workflow || "").trim() &&
            need.every(function (c) { return comfySanitizeCaps(x).indexOf(c) >= 0; });
        });
        if (!hasWf) {
          card.appendChild(el("div", "dim-note", "「" + g.name + "」还没导入工作流：设置 ▸ 本地 ComfyUI"));
        } else if (!usable) {
          card.appendChild(el("div", "dim-note",
            "「" + g.name + "」没有「" +
            need.map(function (c) { return COMFY_CAP_TEXT[c] || c; }).join("、") +
            "」工作流：设置 ▸ 本地 ComfyUI"));
        }
      }
    } else if (getComfyPresets().length) {
      /* 一个能用的本地预设都没有时，说清楚是缺能力，而不是"没有本地选项" */
      const need = comfyCapsForInst(inst, use);
      const anyWf = getComfyPresets().some(function (p) { return !!String(p.workflow || "").trim(); });
      const usable = comfyModelGroups().filter(function (g) {
        return g.presets.some(function (p) {
          return !!String(p.workflow || "").trim() &&
            need.every(function (c) { return comfySanitizeCaps(p).indexOf(c) >= 0; });
        });
      });
      if (!usable.length) {
        const noteEl = el("div", "dim-note", anyWf
          ? ("本地预设都不适用于当前功能（需要「" +
            need.map(function (c) { return COMFY_CAP_TEXT[c] || c; }).join("、") + "」能力）：设置 ▸ 本地 ComfyUI")
          : "本地预设还没导入工作流：设置 ▸ 本地 ComfyUI");
        /* 硬约束：窄面板里必须换行（UXP 下父容器可能带 nowrap，继承覆盖不掉） */
        noteEl.style.whiteSpace = "normal";
        noteEl.style.wordBreak = "break-word";
        noteEl.style.width = "100%";
        noteEl.style.maxWidth = "100%";
        card.appendChild(noteEl);
      }
    }
  }
  return card;
};

/* ---- 组件 5：运行条（+ 三闸门状态） ---- */

UI.runBar = function (inst, st) {
  const wrap = el("div", "run-wrap");
  const bar = el("div", "runbar");
  const btn = el("button", "run-btn", inst.runLabel || "运 行");
  btn.addEventListener("click", function () {
    /* 生成域与编辑域都走队列：连点多次会排队执行，不会互相顶掉。
       编辑任务的选区在入队时存成通道，执行前再还原（见 captureQueueSelection）。 */
    if ((inst.domain === "gen" || inst.domain === "edit") && typeof enqueueCurrentRun === "function") {
      /* 入队是异步的（要先固定选区/图层快照）：失败要报出来，不能变成未处理异常 */
      var p = enqueueCurrentRun();
      if (p && typeof p.catch === "function") {
        p.catch(function (e) { log("加入队列失败：" + ((e && e.message) || String(e)), "err"); });
      }
    } else {
      runCurrentInstance();
    }
  });
  const cancel = el("button", "run-cancel", "取 消");
  cancel.addEventListener("click", function () {
    /* 运行条上的取消：同时告诉队列"这条被取消了"，否则任务会挂到超时才结束 */
    try {
      const act = (typeof TASKQ !== "undefined") ? TASKQ.list.filter(function (t) { return t.status === "run"; })[0] : null;
      if (act) TASKQ.cancelId = act.id;
    } catch (e) { /* ignore */ }
    if (typeof abortRun === "function") abortRun();
    else if (currentXHR) currentXHR.abort();
  });
  bar.appendChild(btn);
  bar.appendChild(cancel);
  wrap.appendChild(bar);

  const meta = el("div", "run-meta");
  meta.appendChild(el("span", "cost-badge", costBadge(inst)));
  const tag = el("span", "model-tag", "模型: " + modelLabelFor(resolveModel(inst.modelUse)));
  tag.title = "点击打开 设置 ▸ 模型分配";
  tag.addEventListener("click", function () { openSettings("secModelMap"); });
  meta.appendChild(tag);
  wrap.appendChild(meta);

  wrap.appendChild(el("div", "rb-hint"));
  wrap.appendChild(el("div", "rb-ctx"));
  return wrap;
};

/* 三闸门求值：声明（注册表）∩ 服务（Key/模型可用）∩ 上下文（文档/选区/槽/提示词） */
async function evalRunGate(inst) {
  const out = { ok: false, hint: "", ctx: "" };
  if (inst.wip) { out.hint = inst.wip; return out; }
  if (!IS_UXP) { out.hint = "浏览器预览：界面可交互，运行需在 Photoshop 面板中"; return out; }
  if (!app.activeDocument) { out.hint = "请先打开一个文档"; return out; }
  if (!App.hasImageKey) { out.hint = "未配置图像服务 · 点右上角 ⚙ 填写 API Key"; return out; }

  let sel = null;
  try { sel = await getSelectionBounds(); } catch (e) { sel = null; }
  const doc = app.activeDocument;
  out.ctx = (sel ? "选区 " + Math.round(sel.width) + "×" + Math.round(sel.height) + " · " : "") +
    "画布 " + Math.round(doc.width) + "×" + Math.round(doc.height);

  if (inst.selection === "required" && !sel) {
    /* 声明了 noSelArea:"canvas" 的功能（局部重绘）：没框选就按整幅画面跑，
     * 这里不能把运行按钮锁死，只在上下文行里说明当前口径。 */
    if (inst.noSelArea === "canvas") {
      out.ctx = "未框选 · 按整幅画面处理 · " + out.ctx;
    } else {
      out.hint = "此功能需要选区：请先用选区工具框出区域";
      return out;
    }
  }

  const st = getInstanceState(inst.id);
  const missing = [];
  (inst.slots || []).forEach(function (s) {
    if (s.required && !s.implicit) {
      const arr = (st.slots && st.slots[s.role]) || [];
      const min = (s.count && s.count.min) || 1;
      if (arr.length < min) missing.push(s.label);
    }
  });
  if (missing.length) { out.hint = "请先添加：" + missing.join("、"); return out; }

  if (inst.prompt === "required" && !((st.userText || "").trim())) {
    out.hint = "请填写提示词";
    return out;
  }

  out.ok = true;
  return out;
}

/* 刷新运行条状态（闸门变化 / 运行开始结束 / 设置变更后调用） */
UI.refreshRunBar = async function (host, inst) {
  if (!host || !inst) return;
  if (!host.querySelector(".run-wrap")) return;
  const g = await evalRunGate(inst);

  host.__gateSig = (g.ok ? "1" : "0") + "|" + (g.hint || "") + "|" + (g.ctx || "");

  const btn = host.querySelector(".run-btn");
  const cn = host.querySelector(".run-cancel");
  const hint = host.querySelector(".rb-hint");
  const ctxE = host.querySelector(".rb-ctx");
  const tag = host.querySelector(".model-tag");
  const tr = (typeof i18nText === "function") ? i18nText : function (x) { return x; };
  if (tag) tag.textContent = "模型: " + modelLabelFor(resolveModel(inst.modelUse));
  const cb = host.querySelector(".cost-badge");
  if (cb) cb.textContent = costTextFor(inst, getInstanceState(inst.id));

  if (typeof running !== "undefined" && running) {
    /* 运行中仍可继续追加任务：按钮保持可点，文案改成「加入队列」 */
    if (btn) { btn.disabled = false; btn.textContent = tr("＋ 加入队列"); }
    if (cn) cn.style.display = "block";
    if (hint) {
      hint.textContent = tr("运行中…再点「加入队列」会排队执行；队列条里可单独取消");
      hint.className = "rb-hint";
    }
    if (ctxE) ctxE.textContent = "";
    if (typeof i18nFlush === "function") i18nFlush(host);
    return;
  }
  if (cn) cn.style.display = "none";
  if (btn) { btn.disabled = !g.ok; btn.textContent = tr(inst.runLabel || "运 行"); }
  if (hint) {
    hint.textContent = tr(g.hint || "");
    hint.className = "rb-hint" + (g.ok ? "" : " warn");
  }
  if (ctxE) ctxE.textContent = g.ctx || "";
  if (typeof i18nFlush === "function") i18nFlush(host);
};

/* ---- 组件 6：结果卡（单图卡 · W5：插入为新图层 / 重新生成 / 收藏 / 删除） ---- */

UI.resultBlock = function (inst) {
  const b = el("div", "result-block");
  b.appendChild(el("div", "rb-title", "本次结果（已归档到本机历史）"));
  b.appendChild(el("div", "rb-status", "尚无运行记录"));
  const body = el("div", "rb-body hidden");

  /* 缩略图区：参考图（即实际发送给模型的画面，含色框标记）+ 候选结果（1~N 张） */
  const thumbs = el("div", "rb-thumbs");
  const cellRef = el("div", "rb-cell hidden");
  const imgRef = document.createElement("img");
  imgRef.className = "rb-thumb";
  imgRef.alt = "";
  cellRef.appendChild(imgRef);
  cellRef.appendChild(el("div", "rb-cap", "参考图（含色框）"));
  thumbs.appendChild(cellRef);
  /* 候选结果容器：单张=结果缩略图；多张=候选网格（含逐张「插入」按钮） */
  const candsWrap = el("div", "rb-cands");
  thumbs.appendChild(candsWrap);
  body.appendChild(thumbs);

  const meta = el("div", "rb-meta");
  body.appendChild(meta);
  b.appendChild(body);

  const acts = el("div", "rb-actions hidden");
  const insBtn = el("button", "rb-ins", "插入为新图层");
  insBtn.type = "button";
  insBtn.title = "把本次结果作为新图层再插入一次（图层被删/想多处使用时）";
  insBtn.addEventListener("click", function () { reinsertLastRun(inst.id); });
  const regen = el("button", "rb-regen", "重新生成");
  regen.type = "button";
  regen.title = "同参再跑一遍（产生新记录，原记录保留）";
  regen.addEventListener("click", function () { regenLastRun(inst.id); });
  const fav = el("button", "rb-fav", "☆ 收藏");
  fav.type = "button";
  fav.title = "收藏此任务（清理缓存时豁免）";
  fav.addEventListener("click", function () { toggleFavLastRun(inst.id); });
  const del = el("button", "rb-del", "删除");
  del.type = "button";
  del.title = "删除本机历史副本（PS 中的图层不受影响）";
  del.addEventListener("click", function () { deleteLastRun(inst.id); });
  acts.appendChild(insBtn);
  acts.appendChild(regen);
  acts.appendChild(fav);
  acts.appendChild(del);
  b.appendChild(acts);
  return b;
};

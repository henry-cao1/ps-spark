/*
 * ps.js — Photoshop 像素管线（选区 / 导出 / 蒙版 / 色框 / 结果回写 / 裁剪）
 * W0：自 main.js 原样搬迁（行为不变，逐字保留——这是已验证的硬资产）
 * 依赖：diag.js（app/action/imaging/fs/diag/log）、api.js（xhrRequest）
 * 注：提示词构造已迁往 registry.js（W2 模板体系）
 */

/* ---------------- Photoshop 交互 ---------------- */

const BP_OPTS = { synchronousExecution: true, modalBehavior: "execute" };

/* 判定「命令当前不可用」类错误。
 * 关键语义：PS 抛这个错时**命令根本没有执行**（执行前就被拒绝），
 * 因此重试一定安全，不会产生重复副作用（建两次蒙版之类）。 */
function isCmdUnavailable(e) {
  const m = String((e && (e.message || e.description)) || e || "");
  return /不可用|not currently available|isn'?t available|not available|command is not/i.test(m);
}

const BP_WAITS = [0, 140, 320];
async function batchPlay(descs) {
  let last = null;
  for (let i = 0; i < BP_WAITS.length; i++) {
    if (BP_WAITS[i]) await new Promise(function (r) { setTimeout(r, BP_WAITS[i]); });
    try { return await action.batchPlay(descs, BP_OPTS); }
    catch (e) {
      last = e;
      if (!isCmdUnavailable(e) || i === BP_WAITS.length - 1) throw e;
      diag("batchPlay: 命令暂不可用，稍后重试（" + String((e && e.message) || e) + "）");
    }
  }
  throw last;
}

/* 显式重试入口（保留旧签名，供少数需要更长等待的调用点使用）。
 * batchPlay 本身已内置「不可用即重试」，这里主要是多给一拍 + 便于打日志。 */
async function batchPlayRetry(desc, label) {
  let last = null;
  for (let i = 0; i < 2; i++) {
    try { return await batchPlay([desc]); }
    catch (e) {
      last = e;
      if (i === 0 && isCmdUnavailable(e)) {
        diag((label || "batchPlay") + ": 命令仍不可用，再等 200ms 重试");
        await new Promise(function (r) { setTimeout(r, 200); });
        continue;
      }
      throw e;
    }
  }
  throw last;
}

/* 选区是否真的存在（有面积）。PS 里「选区存在但为空」时：
 * 羽化不报错但等于没做，建图层蒙版则抛「命令"建立"当前不可用」——
 * 所有选区相关命令执行前都先过这一关。 */
async function selectionNonEmpty() {
  try {
    const res = await batchPlay([{
      _obj: "get",
      _target: [{ _property: "selection" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }],
      _options: { dialogOptions: "dontDisplay" }
    }]);
    const s = res && res[0] && res[0].selection;
    if (!s) return false;
    let r = 72;
    try { r = (app.activeDocument && app.activeDocument.resolution) || 72; } catch (eR) { /* ignore */ }
    const w = toPx(s.right, r) - toPx(s.left, r);
    const h = toPx(s.bottom, r) - toPx(s.top, r);
    return w > 0.5 && h > 0.5;
  } catch (e) {
    return false;
  }
}

/* 单位换算 → 像素 */
function toPx(obj, resolution) {
  if (!obj) return 0;
  const v = obj._value, u = obj._unit || "";
  if (u.indexOf("pixels") >= 0) return v;
  const r = resolution || 72;
  switch (u) {
    case "inchesUnit": return v * r;
    case "cmUnit": return v / 2.54 * r;
    case "mmUnit": return v / 25.4 * r;
    case "pointsUnit": return v / 72 * r;
    case "picasUnit": return v / 6 * r;
    case "distanceUnit": return v; // 标尺单位，通常即像素
    default: return v;
  }
}

/* 选区 bounds（像素）；无选区返回 null */
async function getSelectionBounds() {
  const doc = app.activeDocument;
  try {
    const res = await batchPlay([{
      _obj: "get",
      _target: [{ _property: "selection" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }],
      _options: { dialogOptions: "dontDisplay" }
    }]);
    const s = res[0].selection;
    const r = doc.resolution || 72;
    const left = toPx(s.left, r), top = toPx(s.top, r), right = toPx(s.right, r), bottom = toPx(s.bottom, r);
    const b = { left, top, right, bottom, width: right - left, height: bottom - top };
    if (b.width < 2 || b.height < 2) return null;
    return b;
  } catch (e) {
    return null;
  }
}

/* 用矩形设置选区（局部重做用）。rect 为文档像素坐标。
 * 不依赖用户已在 PS 中框选，UI 里画的框直接变成选区。必须在 executeAsModal 内调用。 */
async function setRectSelection(rect) {
  const l = Math.round(rect.left), t = Math.round(rect.top);
  const r = Math.round(rect.left + rect.width), b = Math.round(rect.top + rect.height);
  if (r - l < 2 || b - t < 2) throw new Error("重做区域太小（至少 2×2 像素）");
  await batchPlay([{
    _obj: "set",
    _target: [{ _ref: "channel", _property: "selection" }],
    to: {
      _obj: "rectangle",
      top: { _unit: "pixelsUnit", _value: t },
      left: { _unit: "pixelsUnit", _value: l },
      bottom: { _unit: "pixelsUnit", _value: b },
      right: { _unit: "pixelsUnit", _value: r }
    },
    _options: { dialogOptions: "dontDisplay" }
  }]);
  diag("setRectSelection: " + l + "," + t + " → " + r + "," + b);
  return { left: l, top: t, right: r, bottom: b, width: r - l, height: b - t };
}

/* 按图层 ID 读取像素范围（文档坐标）。图层被删除/找不到时返回 null。 */
async function getLayerBoundsById(layerId) {
  if (layerId == null) return null;
  try {
    const doc = app.activeDocument;
    const res = await batchPlay([{
      _obj: "get",
      _target: [{ _ref: "layer", _id: layerId }],
      _options: { dialogOptions: "dontDisplay" }
    }]);
    const lb = res[0] && (res[0].boundsNoEffects || res[0].bounds);
    if (!lb) return null;
    const r = (doc && doc.resolution) || 72;
    const left = toPx(lb.left, r), top = toPx(lb.top, r), right = toPx(lb.right, r), bottom = toPx(lb.bottom, r);
    if (!(right > left) || !(bottom > top)) return null;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  } catch (e) {
    diag("getLayerBoundsById warn: " + ((e && e.message) || String(e)));
    return null;
  }
}

/* 选区存取（局部重做前后保护用户原有选区）。 */
async function saveSelectionToChannel(name) {
  try {
    const sel = await getSelectionBounds();
    if (!sel) return false;
    await batchPlay([{ _obj: "duplicate", _target: [{ _ref: "channel", _property: "selection" }], name: name }]);
    return true;
  } catch (e) {
    diag("saveSelection warn: " + ((e && e.message) || String(e)));
    return false;
  }
}
async function restoreSelectionFromChannel(name) {
  try {
    await batchPlay([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _ref: "channel", _name: name } }]);
    await deleteChannelQuiet(name);
    return true;
  } catch (e) {
    diag("restoreSelection warn: " + ((e && e.message) || String(e)));
    return false;
  }
}

/*
 * 当前选中图层的像素范围（文档坐标，像素）。
 * 用途：无选区时的「图层级处理」——如擦除未框选时，对所选图层的范围执行。
 * 返回 null：无选中图层 / 背景层（背景=整画布，交给全画布逻辑）/ 范围异常。
 */
async function getActiveLayerBounds() {
  try {
    const doc = app.activeDocument;
    if (!doc) return null;
    const al = doc.activeLayers;
    const layer = (al && al.length) ? al[0] : null;
    if (!layer) return null;
    if (layer.isBackgroundLayer) return null;
    const b = layer.bounds; /* UXP DOM：{left, top, right, bottom}（像素数值） */
    if (!b) return null;
    const left = Math.round(b.left), top = Math.round(b.top);
    const right = Math.round(b.right), bottom = Math.round(b.bottom);
    const w = right - left, h = bottom - top;
    if (w < 2 || h < 2) return null;
    const out = { left: left, top: top, right: right, bottom: bottom, width: w, height: h, fromLayer: true };
    diag("getActiveLayerBounds: " + (layer.name || "") + " " + w + "×" + h + " @(" + left + "," + top + ")");
    return out;
  } catch (e) {
    diag("getActiveLayerBounds warn: " + e.message);
    return null;
  }
}

async function deselect() {
  try {
    await batchPlay([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "none" } }]);
  } catch (e) { /* 无选区时忽略 */ }
}

async function selectAll() {
  await batchPlay([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _enum: "ordinal", _value: "allEnum" } }]);
}

/* ---------------- 选区备份 / 结果按选区裁剪 ---------------- */

/* 静默删除命名通道（不存在则忽略） */
async function deleteChannelQuiet(name) {
  try {
    await batchPlay([{ _obj: "delete", _target: [{ _ref: "channel", _name: name }] }]);
  } catch (e) { /* 通道不存在等，忽略 */ }
}

/* 从命名通道载入选区 */
async function loadSelectionFromChannel(name) {
  await batchPlay([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _ref: "channel", _name: name } }]);
}

/*
 * 纯色底抠图（不支持透明通道的模型用）：
 * 魔棒点左上角取底色 → 反选 → 建图层蒙版。
 * 结果层保留像素，蒙版可再编辑；失败只报错，不改动文档内容。
 */
async function cutLayerByColorKey(opts) {
  const o = opts || {};
  const tol = Math.max(0, Math.min(100, o.tolerance == null ? 24 : o.tolerance));
  const x = o.x == null ? 1 : o.x;
  const y = o.y == null ? 1 : o.y;
  try {
    await batchPlay([{
      _obj: "magicWand",
      _target: [{ _ref: "channel", _property: "selection" }],
      tolerance: tol,
      antiAlias: true,
      sampleMerged: false,
      clickPoint: { _obj: "point", horizontal: x, vertical: y }
    }]);
    /* 点到透明区/纯色整幅时魔棒选不出东西：此时反选=全选，建蒙版等于没抠，
     * 还会因选区为空触发「建立不可用」。直接判定失败、保留生成层。 */
    if (!(await selectionNonEmpty())) {
      diag("colorKey: 魔棒未选中任何区域（点 (" + x + "," + y + ")），跳过抠色");
      try { await deselect(); } catch (e0) { /* ignore */ }
      return false;
    }
    await batchPlay([{ _obj: "inverse" }]);
    const okMask = await applySelectionAsLayerMask();
    try { await deselect(); } catch (e2) { /* ignore */ }
    diag("colorKey: 抠底色完成（容差 " + tol + "，蒙版=" + okMask + "）");

    /* 蒙版建出来但全黑 = 一个元素像素都没抠到，图层会整体不可见（用户以为没生成）。
     * 这时删掉蒙版，保留模型原样，比留一个"看不见的层"可操作得多。 */
    if (okMask) {
      let maskEmpty = false;
      try {
        await selectLayerMaskChannel();
        maskEmpty = !(await selectionNonEmpty());
      } catch (eChk) { maskEmpty = false; }
      try { await deselect(); } catch (eChk2) { /* ignore */ }
      if (maskEmpty) {
        diag("colorKey: 蒙版全黑（未命中元素），删除蒙版、保留模型原图");
        try {
          await batchPlay([{
            _obj: "delete",
            _target: [{ _ref: "channel", _enum: "channel", _value: "mask" }],
            _options: { dialogOptions: "dontDisplay" }
          }]);
        } catch (eDelMask) {
          diag("colorKey: 删除空蒙版失败 " + ((eDelMask && eDelMask.message) || String(eDelMask)));
        }
        return false;
      }
    }
    return true;
  } catch (e) {
    diag("colorKey: 失败 " + ((e && e.message) || String(e)));
    try { await deselect(); } catch (e3) { /* ignore */ }
    return false;
  }
}

/*
 * 拆图：探测生成层是不是真的「纯色底」。
 * 读 64×64 缩略图，取四角各 8×8 的平均色：
 *  - spread ≤ 24 → 四角同色，可信的抠像底，交魔棒去抠；
 *  - 否则 → 模型没照做纯色底（nano 系列常"重新构图"），魔棒必然点不中，提前判定失败。
 * 返回 null 表示读不到像素（按原逻辑继续试魔棒）。必须在 executeAsModal 内调用。
 */
async function decompProbeKeyBg(docId, layerId) {
  try {
    const px = await readPixelsCompat({
      documentID: docId,
      layerID: layerId,
      targetSize: { width: 64, height: 64 },
      componentSize: 8,
      colorSpace: "RGB",
      applyAlpha: false
    });
    const ch = px.length >= 64 * 64 * 4 ? 4 : 3;
    const at = function (x, y) { const i = (y * 64 + x) * ch; return [px[i], px[i + 1], px[i + 2]]; };
    const corners = [];
    for (let dy = 0; dy < 8; dy++) {
      for (let dx = 0; dx < 8; dx++) {
        corners.push(at(dx, dy), at(63 - dx, dy), at(dx, 63 - dy), at(63 - dx, 63 - dy));
      }
    }
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < corners.length; i++) { r += corners[i][0]; g += corners[i][1]; b += corners[i][2]; }
    const n = corners.length || 1;
    const avg = [r / n, g / n, b / n];
    let spread = 0;
    for (let i = 0; i < corners.length; i++) {
      spread = Math.max(spread,
        Math.abs(corners[i][0] - avg[0]),
        Math.abs(corners[i][1] - avg[1]),
        Math.abs(corners[i][2] - avg[2]));
    }
    const rgb = avg.map(function (v) { return Math.round(v); });
    const hex = "#" + rgb.map(function (v) {
      const s = Math.max(0, Math.min(255, v)).toString(16).toUpperCase();
      return s.length < 2 ? "0" + s : s;
    }).join("");
    const isMagenta = rgb[0] > 170 && rgb[2] > 170 && rgb[1] < 100;
    diag("decomp probe: 四角 avg=" + hex + " spread=" + Math.round(spread) +
      (isMagenta ? "（接近洋红）" : "（不是洋红）"));
    return { ok: spread <= 24, rgb: rgb, hex: hex, spread: Math.round(spread), isMagenta: isMagenta };
  } catch (e) {
    diag("decomp probe: 读像素失败（按原逻辑继续试魔棒） " + ((e && e.message) || String(e)));
    return null;
  }
}

/*
 * 合并后的元素层会丢掉蒙版（mergeLayers 把蒙版烘焙进像素）。这里按结果层的
 * 透明度重建一个可编辑蒙版：只载入透明选区 → 建蒙版，不羽化。
 * 失败只记日志（层仍可用），整幅不透明的层本来就不该有蒙版。
 */
async function restoreMaskFromAlpha(doc, layerId) {
  try {
    if (!(await selectLayerById(doc, layerId))) return false;
    await selectLayerTransparency();
    if (!(await selectionNonEmpty())) {
      try { await deselect(); } catch (e0) { /* ignore */ }
      diag("rebuild: 结果层没有透明区域，不重建蒙版");
      return false;
    }
    const ok = await applySelectionAsLayerMask();
    try { await deselect(); } catch (e1) { /* ignore */ }
    if (ok) diag("rebuild: 已按透明度重建图层蒙版（可再编辑）");
    return ok;
  } catch (e) {
    diag("rebuild: 重建蒙版失败（层保持像素） " + ((e && e.message) || String(e)));
    try { await deselect(); } catch (e2) { /* ignore */ }
    return false;
  }
}

/* 选区羽化（Select ▸ 修改 ▸ 羽化）：让结果层与原图之间没有硬边接缝 */
async function featherSelection(px) {
  const v = Math.max(0, Number(px) || 0);
  if (!v) return false;
  /* 空选区时 PS 报「命令"羽化"当前不可用」；先确认真有选区再调 */
  if (!(await selectionNonEmpty())) {
    diag("selection: 无有效选区，跳过羽化（" + v + "px）");
    return false;
  }
  try {
    await batchPlay([{
      _obj: "feather",
      radius: { _unit: "pixelsUnit", _value: v },
      _options: { dialogOptions: "dontDisplay" }
    }]);
    diag("selection: feather " + v + "px");
    return true;
  } catch (e) {
    diag("selection: feather 失败 " + ((e && e.message) || String(e)));
    return false;
  }
}

/* 选区收缩（Select ▸ 修改 ▸ 收缩）：用于把「定位框线」这类画在边界上的标记排除在结果之外 */
async function contractSelection(px) {
  const v = Math.max(0, Number(px) || 0);
  if (!v) return false;
  if (!(await selectionNonEmpty())) {
    diag("selection: 无有效选区，跳过收缩（" + v + "px）");
    return false;
  }
  try {
    await batchPlay([{
      _obj: "contract",
      radius: { _unit: "pixelsUnit", _value: v },
      _options: { dialogOptions: "dontDisplay" }
    }]);
    diag("selection: contract " + v + "px");
    return true;
  } catch (e) {
    diag("selection: contract 失败 " + ((e && e.message) || String(e)));
    return false;
  }
}

/* 把当前图层的蒙版载入为选区（逆向：用蒙版去取原图像素） */
async function selectLayerMaskChannel() {
  await batchPlay([{
    _obj: "set",
    _target: [{ _ref: "channel", _property: "selection" }],
    to: { _ref: "channel", _property: "mask" }
  }]);
}

/*
 * 把当前选区套用到活动图层：创建图层蒙版（revealSelection = 选区内显示、选区外隐藏）。
 * 非破坏性，用户后续可直接编辑/删除蒙版；创建失败时降级为像素删除（硬裁剪）。
 */
async function applySelectionAsLayerMask() {
  /* 没有选区就建蒙版 → PS 只说「命令"建立"当前不可用」，看不出真实原因。
   * 这里先自证：无选区直接返回 false，不惊动 PS。 */
  if (!(await selectionNonEmpty())) {
    diag("clip: 无有效选区，跳过建蒙版");
    return false;
  }
  /* 背景图层不能加图层蒙版（PS 会报同一条「建立不可用」）→ 不动它 */
  let isBg = false;
  try {
    const L = app.activeDocument && app.activeDocument.activeLayers && app.activeDocument.activeLayers[0];
    isBg = !!(L && L.isBackgroundLayer);
  } catch (eBg) { /* ignore */ }
  if (isBg) {
    diag("clip: 当前图层是背景图层，跳过建蒙版（改为保留完整图层）");
    return false;
  }
  try {
    await batchPlayRetry({
      _obj: "make",
      "new": { _class: "channel" },
      at: { _ref: "channel", _enum: "channel", _value: "mask" },
      using: { _enum: "userMaskEnabled", _value: "revealSelection" },
      _options: { dialogOptions: "dontDisplay" }
    }, "clip.makeMask");
    diag("clip: layer mask from selection created");
  } catch (e) {
    diag("clip: make-mask 失败，改用像素删除兜底: " + ((e && e.message) || String(e)));
    try {
      await batchPlay([{ _obj: "inverse" }]);
      await batchPlay([{ _obj: "delete" }]);
    } catch (eDel) {
      diag("clip: 像素删除兜底也失败（图层保持完整）: " + ((eDel && eDel.message) || String(eDel)));
    }
    try { await deselect(); } catch (eD) { /* ignore */ }
    return false;
  }
  // 蒙版创建后活动通道切到蒙版 → 切回图层像素通道，避免用户下一步操作误编辑蒙版
  try {
    await batchPlay([{ _obj: "select", _target: [{ _ref: "channel", _enum: "channel", _value: "RGB" }], makeVisible: false }]);
  } catch (e) { diag("clip: select RGB warn: " + e.message); }
  return true;
}

/* 矩形选区 */
async function selectRect(b) {
  await batchPlay([{
    _obj: "set",
    _target: [{ _ref: "channel", _property: "selection" }],
    to: {
      _obj: "rectangle",
      top: { _unit: "pixelsUnit", _value: Math.round(b.top) },
      left: { _unit: "pixelsUnit", _value: Math.round(b.left) },
      bottom: { _unit: "pixelsUnit", _value: Math.round(b.bottom) },
      right: { _unit: "pixelsUnit", _value: Math.round(b.right) }
    }
  }]);
}

/* 受保护文档：用户的工作文档绝不参与关闭（防御性保险） */
const protectedDocIds = new Set();
function protectDoc(doc) {
  try { if (doc && doc.id != null) protectedDocIds.add(doc.id); } catch (e) { /* ignore */ }
}
function isProtectedDocId(id) { return id != null && protectedDocIds.has(id); }

/* 当前打开文档的 ID 快照 / 找出快照之后新建的文档（安全识别临时文档用） */
function snapshotDocIds() {
  const s = new Set();
  try {
    const ds = app.documents;
    for (let i = 0; i < ds.length; i++) s.add(ds[i].id);
  } catch (e) { diag("snapshotDocIds warn: " + e.message); }
  return s;
}
function findNewDoc(before) {
  try {
    const ds = app.documents;
    for (let i = ds.length - 1; i >= 0; i--) {
      if (ds[i] && !before.has(ds[i].id)) return ds[i];
    }
  } catch (e) { diag("findNewDoc warn: " + e.message); }
  return null;
}

/* 关闭文档（不保存）：按 ID 走 batchPlay，避免失效的 DOM 代理导致 "文档 does not exist"；
 * 受保护文档（用户工作文档）一律拒绝关闭 */
/* ---- 输入快照：导出时隐藏「入队之后才出现」的图层 ----
 * 场景：队列里先跑本地模型、再跑云端模型。云端任务启动时，本地结果层已经写进文档，
 * 如果直接合并可见导出，云端拿到的就是本地结果（再改一次），而不是用户点击时的原图。
 * 做法：入队时记下当时的全部图层 id；每次导出前临时隐藏不在名单里的图层，导出完立刻恢复。
 * 只在 executeAsModal 里调用，隐藏窗口只有几十毫秒，用户看不到。 */

/* 递归收集图层 id（含组内图层） */
function collectLayerIds(doc) {
  const out = [];
  const walk = function (layers) {
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      if (!L) continue;
      try { if (L.id != null) out.push(L.id); } catch (e) { /* ignore */ }
      try { if (L.layers && L.layers.length) walk(L.layers); } catch (e2) { /* ignore */ }
    }
  };
  try { if (doc && doc.layers) walk(doc.layers); } catch (e) { diag("collectLayerIds warn: " + e.message); }
  return out;
}

function __findLayerById(layers, id) {
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i];
    if (!L) continue;
    try { if (L.id === id) return L; } catch (e) { /* ignore */ }
    try {
      if (L.layers && L.layers.length) {
        const hit = __findLayerById(L.layers, id);
        if (hit) return hit;
      }
    } catch (e2) { /* ignore */ }
  }
  return null;
}

/* 隐藏「不该算作输入」的图层，返回被隐藏的 id（调用方负责恢复）。
 * hideIds：本插件落过的结果层（连跑时不叠在上一次输出上）
 * keepIds：入队那一刻的图层清单（隐藏并发任务后来写入的层）
 * 当前选中的图层永远保留 —— 用户选它就是要以它为源。 */
async function hideLayersNotIn(doc, keepIds, hideIds) {
  if (!doc) return [];
  const keep = (keepIds && keepIds.length) ? new Set(keepIds) : null;
  const hide = (hideIds && hideIds.length) ? new Set(hideIds) : null;
  if (!keep && !hide) return [];
  const protect = new Set();
  try { (doc.activeLayers || []).forEach(function (L) { if (L && L.id != null) protect.add(L.id); }); } catch (e) { /* ignore */ }
  const hidden = [];
  const walk = function (layers) {
    for (let i = 0; i < layers.length; i++) {
      const L = layers[i];
      if (!L) continue;
      try {
        if (L.layers && L.layers.length) { walk(L.layers); continue; }
        const drop = (keep && !keep.has(L.id)) || (hide && hide.has(L.id));
        if (drop && !protect.has(L.id) && L.visible) { L.visible = false; hidden.push(L.id); }
      } catch (e) { /* 组/智能对象读取失败就跳过 */ }
    }
  };
  try { walk(doc.layers); } catch (e) { diag("hideLayersNotIn warn: " + e.message); }
  if (hidden.length) diag("export: 临时隐藏输入污染层 " + hidden.length + " 个（上次结果 / 并发新层）");
  return hidden;
}

/* 恢复 hideLayersNotIn 隐藏的图层 */
async function restoreLayerVisibility(doc, ids) {
  if (!doc || !ids || !ids.length) return;
  let n = 0;
  for (let i = 0; i < ids.length; i++) {
    try {
      const L = __findLayerById(doc.layers, ids[i]);
      if (L && !L.visible) { L.visible = true; n++; }
    } catch (e) { /* ignore */ }
  }
  if (n) diag("export: 已恢复图层可见性 " + n + " 个");
}

async function closeDocNoSave(doc) {
  const id = doc && doc.id;
  if (isProtectedDocId(id)) {
    diag("closeDocNoSave: 已阻止关闭受保护文档 id=" + id);
    return;
  }
  if (id != null && !docExists(id)) {
    diag("closeDocNoSave: id=" + id + " 已不存在，跳过");
    return;
  }
  if (id != null) {
    diag("closeDocNoSave: closing id=" + id);
    try {
      await batchPlay([{
        _obj: "close",
        _target: [{ _ref: "document", _id: id }],
        saving: { _enum: "saveOptions", _value: "no" },
        _options: { dialogOptions: "dontDisplay" }
      }]);
      return;
    } catch (e) {
      diag("closeDocNoSave(batchPlay) warn: " + e.message);
    }
  }
  try {
    if (isProtectedDocId(doc && doc.id)) { diag("closeDocNoSave: DOM 兜底同样阻止关闭受保护文档"); return; }
    await doc.closeWithoutSaving();
  } catch (e2) { diag("closeDocNoSave(dom) warn: " + e2.message); }
}

function docExists(id) {
  const docs = app.documents;
  for (let i = 0; i < docs.length; i++) {
    if (docs[i] && docs[i].id === id) return true;
  }
  return false;
}

/* 切回指定文档（目标不存在/已是活动文档时静默跳过） */
function restoreActiveDoc(doc) {
  try {
    if (doc && docExists(doc.id)) app.activeDocument = doc;
  } catch (e) {
    diag("restoreActiveDoc warn: " + e.message);
  }
}

/* 按 ID 定位文档（不依赖可能滞后的活动文档指针） */
function docById(id) {
  try {
    if (id == null) return null;
    const ds = app.documents;
    for (let i = 0; i < ds.length; i++) {
      if (ds[i] && ds[i].id === id) return ds[i];
    }
  } catch (e) { diag("docById warn: " + e.message); }
  return null;
}

/* 确保目标文档处于活动状态。
 * 背景（实测）：UXP 中 app.activeDocument 在批处理/画布操作后可能返回 null 或滞后指针，
 * 直接读取会抛 "Cannot read properties of null ..."。这里优先按 ID 定位并显式切回。 */
function ensureActiveDoc(id) {
  const cur = app.activeDocument;
  if (cur && (id == null || cur.id === id)) return cur;
  const target = docById(id);
  if (target) {
    try { app.activeDocument = target; } catch (e) { diag("ensureActiveDoc: 切换警告 " + e.message); }
    return target;
  }
  return cur || null;
}

function makeDocWait(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/* 文档名清洗：去掉 PS/文件系统不接受与控制字符（真机：怪异名称会让建文档静默失败） */
function sanitizeDocName(name) {
  let s = String(name == null ? "" : name);
  s = s.replace(/[\u0000-\u001f]/g, "").replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim();
  if (!s) s = "PS Spark";
  return s.slice(0, 60);
}

/* 读取文档像素尺寸（失败返回 [-1,-1]） */
function docDims(doc) {
  try {
    if (!doc) return [-1, -1];
    return [Math.round(doc.width), Math.round(doc.height)];
  } catch (e) { return [-1, -1]; }
}

/* 新建 RGB 文档（像素尺寸），返回新文档（并成为活动文档）。
 * 真机实证（PS 26 / UXP）：createDocument 存在两种异常表现——
 *   ① 抛错；② **文档建出来了但返回 undefined**（拆图 W10 就栽在这：调用方拿到 null 直接报错，
 *      同时留下一个没人认领的空文档）。另有 batchPlay("make") 会"静默不生效"。
 * 因此这里做五级兜底，且每一步都实测校验，绝不把旧文档（用户的工作文档）当成新文档返回：
 *   1) app.createDocument 直接返回 → 用；
 *   2) 返回空 → 按 ID 差异轮询识别（文档多半已建好）；
 *   3) 仍无 且传入了 srcDoc → 复制源文档后清空（本环境 duplicate 最稳）；
 *   4) 仍无 → 活动文档兜底（仅当它确实是新建的）；
 *   5) 最后 → batchPlay("make") + 差异识别；
 *   6) 全失败 → 抛错（宁可中止，不可误操作用户文档）。 */
async function makeDoc(w, h, name, srcDoc) {
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  const docName = sanitizeDocName(name);
  diag("makeDoc: 请求 " + W + "×" + H + " name=" + docName);

  const mk = function (mode) {
    return app.createDocument({
      name: docName, width: W, height: H,
      resolution: 72, mode: mode, fill: "transparent"
    });
  };

  const before = snapshotDocIds();
  let nd = null;
  try {
    nd = await mk("RGBColorMode");
  } catch (e1) {
    diag("makeDoc: createDocument 异常 -> " + e1.message);
    try {
      nd = await mk("RGB");
    } catch (e2) {
      diag("makeDoc: createDocument(mode=RGB) 亦异常 -> " + e2.message);
    }
  }

  /* 1) 正常返回 */
  if (nd && nd.id != null) {
    const dm = docDims(nd);
    diag("makeDoc: createDocument ok, id=" + nd.id + " " + dm[0] + "×" + dm[1]);
    try { app.activeDocument = nd; } catch (eA) { /* ignore */ }
    return nd;
  }

  /* 2) 返回空：文档多半已建好，按 ID 差异轮询识别 */
  diag("makeDoc: createDocument 未返回文档对象，按文档差异识别…");
  for (let i = 0; i < 6; i++) {
    const nf = findNewDoc(before);
    if (nf) {
      const dm = docDims(nf);
      diag("makeDoc: 差异识别成功（第 " + (i + 1) + " 次）, id=" + nf.id + " " + dm[0] + "×" + dm[1]);
      try { app.activeDocument = nf; } catch (eA) { /* ignore */ }
      return nf;
    }
    await makeDocWait(80);
  }

  /* 3) 复制源文档再清空：本环境 duplicate 一直稳定可用，比 batchPlay("make") 可靠得多。
   *    做法：duplicate → 新建一个空图层 → 删除复制来的全部原图层 → 全选清空保底 → 校到目标尺寸。
   *    （保留"先建空层再删旧层"，避免"文档至少保留一层"的限制和背景层删成白底） */
  if (srcDoc) {
    try {
      const ndD = await makeDocByDup(srcDoc, W, H, docName);
      if (ndD && ndD.id != null) {
        const dm = docDims(ndD);
        diag("makeDoc: 复制清空方案成功 id=" + ndD.id + " " + dm[0] + "×" + dm[1]);
        try { app.activeDocument = ndD; } catch (eA) { /* ignore */ }
        return ndD;
      }
      diag("makeDoc: 复制清空方案未产出文档");
    } catch (eD) { diag("makeDoc: 复制清空方案异常 -> " + eD.message); }
  }

  /* 4) 活动文档兜底：仅当它确实是本次新建的（防把用户工作文档当新文档） */
  try {
    const ad = app.activeDocument;
    if (ad && ad.id != null && !before.has(ad.id)) {
      const dm = docDims(ad);
      diag("makeDoc: 以新建的活动文档兜底 id=" + ad.id + " " + dm[0] + "×" + dm[1]);
      return ad;
    }
  } catch (eA) { diag("makeDoc: 读取活动文档失败 " + eA.message); }

  /* 5) batchPlay 回退（本环境曾静默不生效，故必须实测识别） */
  diag("makeDoc: 改走 batchPlay(make) 回退");
  const before2 = snapshotDocIds();
  try {
    await batchPlay([{
      _obj: "make",
      _new: { _class: "document" },
      using: {
        _obj: "document",
        name: docName,
        width: { _unit: "pixelsUnit", _value: W },
        height: { _unit: "pixelsUnit", _value: H },
        resolution: { _unit: "densityUnit", _value: 72 },
        mode: { _class: "RGBColorMode" },
        fill: { _enum: "fill", _value: "transparent" },
        depth: 8,
        pixelAspectRatio: { _unit: "distanceUnit", _value: 1 }
      },
      documentID: 0
    }]);
  } catch (eB) { diag("makeDoc: batchPlay(make) 异常 -> " + eB.message); }
  for (let i = 0; i < 5; i++) {
    const nf = findNewDoc(before2);
    if (nf) {
      const dm = docDims(nf);
      diag("makeDoc: batchPlay 回退识别成功（第 " + (i + 1) + " 次）, id=" + nf.id + " " + dm[0] + "×" + dm[1]);
      try { app.activeDocument = nf; } catch (eA) { /* ignore */ }
      return nf;
    }
    await makeDocWait(80);
  }

  diag("makeDoc: 所有路径均未识别到新建文档（不会拿用户现有文档顶替）");
  throw new Error("新建文档失败：Photoshop 未返回新文档（请在设置中查看日志）");
}

/* 清空文档画布：全选 → 删除（保底清除残留像素，含背景层场景） */
async function clearDocCanvas(doc) {
  if (!doc) return;
  try { app.activeDocument = doc; } catch (eA) { /* ignore */ }
  try {
    await doc.selection.selectAll();
  } catch (eS) {
    try {
      await batchPlay([{
        _obj: "set",
        _target: [{ _ref: "channel", _property: "selection" }],
        to: { _enum: "ordinal", _value: "allEnum" },
        _options: { dialogOptions: "dontDisplay" }
      }]);
    } catch (eS2) { diag("clearDocCanvas: 建选区失败 " + eS2.message); }
  }
  try {
    await batchPlay([{
      _obj: "delete",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
      _options: { dialogOptions: "dontDisplay" }
    }]);
  } catch (eD) { diag("clearDocCanvas: 删除异常 " + eD.message); }
  try { await doc.selection.deselect(); } catch (eD2) { /* ignore */ }
}

/* 复制源文档 → 清空 → 校准尺寸：新建文档的高可靠替代方案
 * 仅在 makeDoc 的前置路径全部失败时调用；复制件是全新文档，绝不改动源文档。 */
async function makeDocByDup(srcDoc, W, H, name) {
  if (!srcDoc) return null;
  const before = snapshotDocIds();
  let nd = null;
  try {
    const dup = await srcDoc.duplicate();
    if (dup && dup.id != null && !before.has(dup.id)) nd = dup;
  } catch (e) { diag("makeDocByDup: duplicate 异常 -> " + e.message); }
  if (!nd) {
    for (let i = 0; i < 6; i++) {
      const nf = findNewDoc(before);
      if (nf) { nd = nf; break; }
      await makeDocWait(80);
    }
  }
  if (!nd || nd.id == null || before.has(nd.id)) { diag("makeDocByDup: 未识别到复制文档"); return null; }
  diag("makeDocByDup: 复制件 id=" + nd.id + "，开始清空");
  try { app.activeDocument = nd; } catch (eA) { /* ignore */ }

  /* 先补一个空图层，再删掉复制来的全部原图层 */
  let added = null;
  try {
    added = await nd.createLayer({ name: "拆图底层", opacity: 100, mode: "normal" });
  } catch (eC) { diag("makeDocByDup: createLayer 异常 -> " + eC.message); }
  try {
    const ls = nd.layers || [];
    for (let i = ls.length - 1; i >= 0; i--) {
      const L = ls[i];
      if (!L) continue;
      if (added && added.id != null && L.id === added.id) continue;
      try { await L.delete(); } catch (eD) { diag("makeDocByDup: 第 " + i + " 层删除被拒（保留）"); }
    }
  } catch (eL) { diag("makeDocByDup: 删层异常 -> " + eL.message); }

  await clearDocCanvas(nd);
  if (W > 0 && H > 0) {
    const dm = docDims(nd);
    if (dm[0] !== W || dm[1] !== H) {
      try { await nd.resizeCanvas(W, H, "topLeft"); } catch (eR) { diag("makeDocByDup: resize 异常 -> " + eR.message); }
    }
  }
  try {
    nd.name = String(name || nd.name || "PS Spark");
  } catch (eN) { /* 改名失败不影响使用 */ }
  return nd;
}

/* ---------------- 色框标记：动态选色 ---------------- */

const CANDIDATE_COLORS = [
  { name: "品红色", hex: "#FF00FF", rgb: [255, 0, 255] },
  { name: "青色",   hex: "#00E5FF", rgb: [0, 229, 255] },
  { name: "亮绿色", hex: "#39FF14", rgb: [57, 255, 20] },
  { name: "黄色",   hex: "#FFE600", rgb: [255, 230, 0] },
  { name: "橙色",   hex: "#FF7A00", rgb: [255, 122, 0] },
  { name: "红色",   hex: "#FF2D2D", rgb: [255, 45, 45] },
  { name: "蓝色",   hex: "#2D6BFF", rgb: [45, 107, 255] },
  { name: "紫色",   hex: "#B14DFF", rgb: [177, 77, 255] }
];

/*
 * 选色策略：
 *  - 将图像降采样到 64x64 取像素
 *  - score = 与全图平均色距离 - 图中相近像素占比 * 惩罚权重
 *  - 即「图中越少出现、离主色调越远」的颜色得分越高
 *  - 失败兜底：品红（自然图像中极少出现）
 */
/* getPixels 返回形态在不同 UXP 版本间有差异（对象直带 getData / 需取 .imageData / 直接带 data），做兼容读取 */
function describeObj(o) {
  try {
    if (o == null) return String(o);
    const own = Object.getOwnPropertyNames(o).slice(0, 30).join(",");
    let proto = "";
    try {
      const p = Object.getPrototypeOf(o);
      if (p) proto = Object.getOwnPropertyNames(p).slice(0, 30).join(",");
    } catch (e) { /* ignore */ }
    return "own=[" + own + "] proto=[" + proto + "]";
  } catch (e) { return "(无法解析对象结构)"; }
}

async function readPixelsCompat(opts) {
  const res = await imaging.getPixels(opts);
  const holders = [];
  if (res && typeof res.getData === "function") holders.push(res);
  if (res && res.imageData && typeof res.imageData.getData === "function") holders.push(res.imageData);
  for (const h of holders) {
    try {
      let raw;
      try { raw = await h.getData({ chunky: true }); }
      catch (e) { raw = await h.getData(); }
      if (raw && raw.length) {
        try { if (h.dispose) h.dispose(); } catch (e) { /* ignore */ }
        return new Uint8Array(raw);
      }
    } catch (e) { /* 尝试下一种形态 */ }
  }
  const d = (res && res.data && res.data.length) ? res.data
    : (res && res.imageData && res.imageData.data && res.imageData.data.length) ? res.imageData.data
      : null;
  if (d) return new Uint8Array(d);
  throw new Error("无法读取像素数据，getPixels 返回结构: " + describeObj(res));
}

async function pickBorderColor(docId, layerId) {
  try {
    const px = await readPixelsCompat({
      documentID: docId,
      layerID: layerId,
      targetSize: { width: 64, height: 64 },
      componentSize: 8,
      colorSpace: "RGB",
      applyAlpha: false
    });
    const channels = px.length >= 64 * 64 * 4 ? 4 : 3;

    let n = 0, rSum = 0, gSum = 0, bSum = 0;
    for (let i = 0; i + channels <= px.length; i += channels) {
      rSum += px[i]; gSum += px[i + 1]; bSum += px[i + 2]; n++;
    }
    if (n === 0) return CANDIDATE_COLORS[0];
    const avg = [rSum / n, gSum / n, bSum / n];

    let best = null, bestScore = -Infinity;
    for (const c of CANDIDATE_COLORS) {
      let near = 0;
      for (let i = 0; i + channels <= px.length; i += channels) {
        const dr = px[i] - c.rgb[0], dg = px[i + 1] - c.rgb[1], db = px[i + 2] - c.rgb[2];
        if (dr * dr + dg * dg + db * db < 48 * 48) near++;
      }
      const freq = near / n;
      const dAvg = Math.sqrt(
        (avg[0] - c.rgb[0]) * (avg[0] - c.rgb[0]) +
        (avg[1] - c.rgb[1]) * (avg[1] - c.rgb[1]) +
        (avg[2] - c.rgb[2]) * (avg[2] - c.rgb[2])
      );
      const score = dAvg - freq * 1200;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return best || CANDIDATE_COLORS[0];
  } catch (e) {
    log("取色分析失败，使用默认品红: " + e.message);
    return CANDIDATE_COLORS[0];
  }
}

/* 在活动文档的活动图层上，对相对矩形 rel 描边（选区外沿） */
async function strokeRect(rel, color, widthPx) {
  await selectRect(rel);
  await batchPlay([{
    _obj: "stroke",
    width: { _unit: "pixelsUnit", _value: widthPx },
    location: { _enum: "strokeLocation", _value: "outside" },
    using: { _obj: "RGBColor", red: color.rgb[0], grain: color.rgb[1], blue: color.rgb[2] },
    opacity: { _unit: "percentUnit", _value: 100 },
    mode: { _enum: "blendMode", _value: "normal" }
  }]);
  await deselect();
}

/* ---------------- 导出 / 蒙版 ---------------- */

/* 设置前景色（描边颜色双保险：部分版本忽略 stroke 的 using 颜色，会退回默认黑色） */
async function setForegroundColor(c) {
  try {
    await batchPlay([{
      _obj: "set",
      _target: [{ _ref: "color", _property: "foregroundColor" }],
      to: { _obj: "RGBColor", red: c.rgb[0], grain: c.rgb[1], blue: c.rgb[2] }
    }]);
  } catch (e) { diag("setForegroundColor warn: " + e.message); }
}

/*
 * 导出指定矩形区域（含上下文）为 PNG：
 * 1. 复制整份文档 → 裁剪到目标区域（不依赖剪贴板/选区栈，区域精确）
 * 2. 拍平后：可选动态选色并对 relRect（原选区在导出图中的相对位置）描边
 * 返回 { entry, color, actualW, actualH }
 */
async function exportRegionToPNG(eb, stroke) {
  const srcDoc = app.activeDocument;
  protectDoc(srcDoc); // 原文档绝不参与关闭
  const beforeIds = snapshotDocIds();

  log("导出时会短暂出现一个临时文档窗口，完成后自动关闭（正常现象）");
  await batchPlay([{
    _obj: "duplicate",
    _target: [{ _ref: "document", _enum: "ordinal", _value: "targetEnum" }],
    name: "psspark_export",
    _options: { dialogOptions: "dontDisplay" }
  }]);
  const tmpDoc = findNewDoc(beforeIds);
  if (!tmpDoc) throw new Error("复制文档失败：未识别到临时文档，已中止（原文档未受影响）");
  diag(`export: doc dup -> id=${tmpDoc && tmpDoc.id} ${tmpDoc.width}x${tmpDoc.height}`);

  await batchPlay([{
    _obj: "crop",
    to: {
      _obj: "rectangle",
      top: { _unit: "pixelsUnit", _value: Math.round(eb.top) },
      left: { _unit: "pixelsUnit", _value: Math.round(eb.left) },
      bottom: { _unit: "pixelsUnit", _value: Math.round(eb.bottom) },
      right: { _unit: "pixelsUnit", _value: Math.round(eb.right) }
    },
    angle: { _unit: "angleUnit", _value: 0 },
    "delete": true
  }]);
  const actualW = tmpDoc.width, actualH = tmpDoc.height;
  diag(`export: cropped -> ${actualW}x${actualH} (期望 ${Math.round(eb.width)}x${Math.round(eb.height)})`);

  // 拍平后取色分析（读整层=完整画面），再描边
  try { await batchPlay([{ _obj: "flattenImage" }]); } catch (e) { diag("export: flatten warn: " + e.message); }

  let color = null;
  if (stroke && stroke.relRect) {
    color = await pickBorderColor(tmpDoc.id, tmpDoc.layers[0].id);
    diag("export: pickBorderColor done -> " + color.hex);
    const w = Math.max(4, Math.min(24, Math.round(Math.min(eb.width, eb.height) * 0.02)));
    await setForegroundColor(color);
    await strokeRect(stroke.relRect, color, w);
    diag("export: strokeRect done");
    log(`色框颜色：${color.name} ${color.hex}`);
  }

  const folder = await fs.getDataFolder();
  const entry = await folder.createFile("psspark_export.png", { overwrite: true });
  await tmpDoc.saveAs.png(entry, { compression: 6 }, true);
  diag("export: saveAs.png done");
  await closeDocNoSave(tmpDoc);
  restoreActiveDoc(srcDoc);
  diag("export: tmp closed");
  return { entry, color, actualW, actualH };
}

/*
 * 在模态作用域内执行 PS 改动类操作。
 * · 自动重试：PS 正忙（"host is in a modal state"，如有未关闭的对话框）时等待后重试；
 * · 防嵌套：调用方自己已在 executeAsModal 内时，再包一层会直接报错，此时直接执行。
 */
async function psModal(fn, name, tries) {
  const n = Math.max(1, tries || 1);
  let last = null;
  for (let i = 0; i < n; i++) {
    try {
      return await core.executeAsModal(fn, { commandName: name });
    } catch (e) {
      last = e;
      const m = String((e && e.message) || e);
      const nested = /modal/i.test(m);
      if (nested && i < n - 1) {
        diag("psModal: " + name + " 第 " + (i + 1) + " 次失败（" + m + "），1.5 秒后重试");
        await new Promise(function (r) { setTimeout(r, 1500); });
        continue;
      }
      /* 重试耗尽仍报 modal → 说明是嵌套调用（调用方已有模态作用域），直接执行 */
      if (nested) {
        diag("psModal: " + name + " 判定为已处于模态作用域内，直接执行");
        return await fn();
      }
      throw e;
    }
  }
  throw last;
}

/* 上一次作用域导出的降级说明（空字符串=未降级）。UI 读取后提示用户。 */
let scopeExportDegraded = "";

/* 最近一次置入的缩放信息：{aspectMismatch, lw, lh, dstW, dstH}
 * 用途：拆图"原图像素重建"前判断结果图是否被等比缩放居中（缩放过则蒙版会错位，跳过重建）。 */
let lastPlaceMeta = { aspectMismatch: false, lw: 0, lh: 0, dstW: 0, dstH: 0 };
/* 最近一次写入的图层信息：{ id, name, bounds, smartObject, placedVia }
 * 供「局部重做」把查看器里画的矩形反算为画布坐标（预览图 = 该图层内容，线性映射）。 */
let lastPlacedLayer = null;

/* 本次会话里本插件落过的结果层 id（按落图顺序）。
 * 用途：导出「主源」时排除它们 —— 连续跑相似图时，第二次不该在上一次结果上继续改，
 * 否则每跑一次都是在上一次输出上叠，越跑越偏。跨会话不保留：重开 PS 后这些层算用户资产。
 * 用户当前选中的层即使在这里也保留（那是有意以它为源）。 */
const PLUGIN_RESULT_IDS = [];
function markPluginResultLayer(id) {
  if (id == null) return;
  if (PLUGIN_RESULT_IDS.indexOf(id) < 0) PLUGIN_RESULT_IDS.push(id);
}
function pluginResultLayerIds() { return PLUGIN_RESULT_IDS.slice(); }
/* 图层被删掉后 id 会残留：导出前按「当前文档里还存在的」过滤一次 */
function prunePluginResultLayers(doc) {
  if (!doc) return;
  try {
    for (let i = PLUGIN_RESULT_IDS.length - 1; i >= 0; i--) {
      if (!__findLayerById(doc.layers, PLUGIN_RESULT_IDS[i])) PLUGIN_RESULT_IDS.splice(i, 1);
    }
  } catch (e) { /* ignore */ }
}

/*
 * 导出「当前画面（合并可见）」或「当前选中图层」为 PNG data URI —— 供视觉模型看图（如拆图智能分析）。
 *
 * 三级路径：
 *   ① imaging.getPixels + encodeImageData（官方 API，不新建文档窗口、无视觉干扰）
 *      ⚠ 真机实测：这两个 API 必须在 executeAsModal 内调用，否则报
 *        "The requested functionality is only allowed from inside a modal scope"
 *        （这正是此前「点选中图层就报错」的原因：该分支没走模态、且没有兜底）。
 *   ② 选中图层专属兜底：复制该图层到临时透明文档 → 存 PNG（保留透明区）→ 关闭
 *   ③ 复制文档 → 全画布导出（既有稳定路径）
 *   ④ 「选中图层」全失败时降级为「当前画面」，并通过 scopeExportDegraded 告知 UI。
 *
 * 超长边降采样到 1024（视觉模型本身会下采样，传原图只增加体积与耗时）。
 */
async function exportScopePngDataURI(scope, maxSide) {
  scopeExportDegraded = "";
  const doc = app.activeDocument;
  if (!doc) throw new Error("请先打开一个文档");
  const W = Math.round(doc.width), H = Math.round(doc.height);
  /* maxSide：导出最大边（默认 1024，与线上请求一致）；传 0 = 不缩放（基准测试用） */
  const MAX_SIDE = (maxSide === 0) ? 0 : (maxSide || 1024);
  const scale = MAX_SIDE > 0 ? Math.min(1, MAX_SIDE / Math.max(W, H)) : 1;

  const opts = {
    documentID: doc.id,
    sourceBounds: { left: 0, top: 0, right: W, bottom: H },
    componentSize: 8,
    colorSpace: "RGB",
    applyAlpha: true
  };
  if (scale < 1) {
    opts.targetSize = { width: Math.max(1, Math.round(W * scale)), height: Math.max(1, Math.round(H * scale)) };
  }
  let layerObj = null;
  if (scope === "layer") {
    try {
      const al = doc.activeLayers;
      if (al && al.length) layerObj = al[0];
    } catch (e) { diag("scope export: 读取选中图层失败 " + e.message); }
    if (!layerObj) throw new Error("当前没有选中图层：请在 PS 图层面板点选一个图层，或把拆图对象切回「当前画面」");
    opts.layerID = layerObj.id;
  }

  /* ① imaging 主路径（必须模态执行） */
  try {
    const uri = await psModal(async function () {
      const res = await imaging.getPixels(opts);
      const holder = (res && res.imageData) ? res.imageData : res;
      if (!holder) throw new Error("getPixels 未返回图像数据: " + describeObj(res));
      let b64 = "";
      try {
        const out = await imaging.encodeImageData({ imageData: holder, base64: true, colorSpace: "RGB" });
        if (typeof out === "string") b64 = out;
        else if (out && out.length) b64 = base64FromBuffer(out);
      } finally {
        try { if (holder.dispose) holder.dispose(); } catch (eD) { /* ignore */ }
      }
      if (!b64) throw new Error("encodeImageData 未返回数据");
      const w = opts.targetSize ? opts.targetSize.width : W;
      const h = opts.targetSize ? opts.targetSize.height : H;
      diag("scope export ok(imaging): " + scope + " " + w + "x" + h + " -> " + b64.length + " chars");
      return "data:image/png;base64," + b64;
    }, "PS Spark: 读取画面像素", 2);
    if (uri) return uri;
  } catch (e) {
    diag("scope export(imaging) warn: " + ((e && e.message) || String(e)));
  }

  /* ② 选中图层兜底：复制该图层到临时透明文档导出（保留透明区，尺寸=原画布） */
  if (scope === "layer" && layerObj) {
    try {
      const uri = await psModal(async function () {
        return await exportLayerViaTmpDoc(doc, W, H);
      }, "PS Spark: 导出选中图层", 2);
      if (uri) {
        diag("scope export ok(layer tmpdoc): " + Math.round(uri.length / 1024) + " KB");
        return uri;
      }
    } catch (e) {
      diag("scope export(layer tmpdoc) warn: " + ((e && e.message) || String(e)));
    }
    scopeExportDegraded = "选中图层导出失败，已改为分析「当前画面」（完整可见内容）";
    diag("scope export: 图层路径均失败，降级为当前画面");
  }

  /* ③ 复制文档 → 全画布导出（会短暂出现临时文档窗口） */
  diag("scope export: fallback（复制文档导出）");
  const rect = { left: 0, top: 0, right: W, bottom: H, width: W, height: H };
  let uri = null;
  try {
    uri = await psModal(async function () {
      const ex = await exportRegionToPNG(rect, null);
      if (!ex || !ex.entry) throw new Error("画面导出失败");
      return await fileToDataURI(ex.entry);
    }, "PS Spark: 导出画面（回退）", 2);
  } catch (e2) {
    diag("scope export fallback warn: " + ((e2 && e2.message) || String(e2)));
    /* 模态包装仍失败（如 PS 正忙）时裸跑一次，失败就把真实错误抛给调用方 */
    const ex = await exportRegionToPNG(rect, null);
    if (!ex || !ex.entry) throw new Error("画面导出失败");
    uri = await fileToDataURI(ex.entry);
  }
  if (!uri) throw new Error("画面导出失败");
  return uri;
}

/*
 * 把「当前选中图层」复制到临时透明文档并导出 PNG：
 * · 临时文档尺寸 = 原画布，图层位置原样保留，其余区域透明 → 与「当前画面」区分明确；
 * · 不拍平（保住 alpha），不改动原文档；无论成功失败都关闭临时文档并还原活动文档。
 * · layerOverride 可选：指定要复制的图层（不传则取当前选中图层的第一个）。
 */
async function exportLayerViaTmpDoc(srcDoc, W, H, layerOverride) {
  protectDoc(srcDoc);
  let tmp = null;
  try {
    tmp = await makeDoc(W, H, "psspark_scope_tmp", srcDoc);
    if (!tmp || tmp.id == null) throw new Error("创建临时文档失败");
    const al = srcDoc.activeLayers;
    const layer = layerOverride || ((al && al.length) ? al[0] : null);
    if (!layer) throw new Error("没有选中图层");
    /* 临时文档自带一个空层：必须按"新增层"判定，不能取最后一层，否则会把空层当成复制结果 */
    const beforeIds = new Set((tmp.layers || []).map(function (l) { return l.id; }));
    let copied = null;
    try {
      const r = await layer.duplicate(tmp);
      if (r && r.id != null) copied = r;
    } catch (e1) {
      diag("exportLayer: DOM duplicate 失败（" + e1.message + "），改批处理复制");
    }
    if (!copied) {
      await batchPlay([{
        _obj: "duplicate",
        _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
        to: { _ref: "document", _id: tmp.id },
        version: 5,
        _options: { dialogOptions: "dontDisplay" }
      }]);
    }
    if (!copied) {
      const after = (tmp.layers || []).filter(function (l) { return !beforeIds.has(l.id); });
      copied = after.length ? after[after.length - 1] : null;
    }
    if (!copied) {
      throw new Error("图层复制失败（若选中的是锁定背景层，请先在 PS 中双击转为普通图层）");
    }
    diag("exportLayer: 已复制图层「" + (layer.name || "") + "」到临时文档");
    const folder = await fs.getDataFolder();
    const entry = await folder.createFile("psspark_scope.png", { overwrite: true });
    await tmp.saveAs.png(entry, { compression: 6 }, true);
    return await fileToDataURI(entry);
  } finally {
    if (tmp) {
      try { await closeDocNoSave(tmp); } catch (eC) { diag("exportLayer: 关闭临时文档 warn " + eC.message); }
    }
    try { app.activeDocument = srcDoc; } catch (eA) { /* ignore */ }
  }
}

/* ================= 槽位「＋ 当前图层」：把 PS 选中图层导出为槽位图片 =================
 * 背景：UXP 没有「从 PS 图层面板拖进插件面板」的跨面板拖放 API，
 *       等效交互 = 在图层面板选中图层（可多选）→ 面板上点一下按钮直接加入。
 * 每个图层单独导出为透明 PNG（保留 alpha）；超长边按 maxSide 等比降采样。
 */

/* 读取图层的像素范围（document 坐标）；不可用/为空时返回 null */
function readLayerPixelBounds(L) {
  function numOf(v) {
    if (typeof v === "number" && isFinite(v)) return v;
    if (v && typeof v === "object" && typeof v._value === "number") return v._value;
    return null;
  }
  try {
    const b = L && L.bounds;
    if (!b) return null;
    const l = numOf(b.left), t = numOf(b.top), r = numOf(b.right), bo = numOf(b.bottom);
    if (l === null || t === null || r === null || bo === null) return null;
    if (r - l < 1 || bo - t < 1) return null; /* 空图层（无像素） */
    return { left: l, top: t, right: r, bottom: bo };
  } catch (e) { return null; }
}

/* 单图层 → PNG data URI：imaging 主路径（模态内执行，裁剪到图层范围、防巨幅空白） */
async function _exportOneLayerPng(docId, layerId, bounds, docW, docH, maxSide) {
  const opts = {
    documentID: docId,
    layerID: layerId,
    componentSize: 8,
    colorSpace: "RGB",
    applyAlpha: true
  };
  let sw = docW, sh = docH;
  if (bounds) {
    const left = Math.max(0, Math.floor(bounds.left));
    const top = Math.max(0, Math.floor(bounds.top));
    const right = Math.min(docW, Math.ceil(bounds.right));
    const bottom = Math.min(docH, Math.ceil(bounds.bottom));
    if (right > left && bottom > top) {
      opts.sourceBounds = { left: left, top: top, right: right, bottom: bottom };
      sw = right - left; sh = bottom - top;
    }
  }
  const cap = maxSide || 2048;
  const scale = Math.min(1, cap / Math.max(sw, sh));
  if (scale < 1) {
    opts.targetSize = { width: Math.max(1, Math.round(sw * scale)), height: Math.max(1, Math.round(sh * scale)) };
  }

  const res = await imaging.getPixels(opts);
  const data = (res && res.imageData) ? res.imageData : res;
  if (!data) throw new Error("getPixels 未返回图像数据: " + describeObj(res));
  let b64 = "";
  try {
    const out = await imaging.encodeImageData({ imageData: data, base64: true, colorSpace: "RGB" });
    if (typeof out === "string") b64 = out;
    else if (out && out.length) b64 = base64FromBuffer(out);
  } finally {
    try { if (data.dispose) data.dispose(); } catch (eD) { /* ignore */ }
  }
  if (!b64) throw new Error("encodeImageData 未返回数据");
  diag("layerPick: 图层像素 " + sw + "x" + sh +
    (scale < 1 ? " → 降采样 " + opts.targetSize.width + "x" + opts.targetSize.height : "") +
    " → " + Math.round(b64.length / 1024) + "KB b64");
  return "data:image/png;base64," + b64;
}

/*
 * 导出「PS 当前选中图层（可多选）」为槽位图片数组。
 * 返回 { items:[{name,uri}], failed:[图层名], total:选中总数 }；
 * 单个图层失败不影响其它图层；全部失败时抛出首个错误信息汇总。
 */
async function exportActiveLayersToSlotItems(maxCount, maxSide) {
  const doc = app.activeDocument;
  if (!doc) throw new Error("请先打开一个文档");
  let selected = [];
  try {
    const al = doc.activeLayers;
    if (al) { for (let i = 0; i < al.length; i++) selected.push(al[i]); }
  } catch (e) { diag("layerPick: 读取选中图层失败 " + e.message); }
  if (!selected.length) {
    throw new Error("未选中图层：请先在 PS 图层面板中选中要添加的图层（可按住 Ctrl/⌘ 多选）");
  }
  const cap = (maxCount && maxCount > 0) ? maxCount : selected.length;
  const take = selected.slice(0, cap);
  const docW = Math.round(doc.width), docH = Math.round(doc.height);
  const items = [], failed = [];

  for (let i = 0; i < take.length; i++) {
    const L = take[i];
    const name = L.name || ("图层 " + (i + 1));
    let uri = null;
    try {
      uri = await psModal(function () {
        return _exportOneLayerPng(doc.id, L.id, readLayerPixelBounds(L), docW, docH, maxSide);
      }, "PS Spark: 导出图层到槽位", 2);
    } catch (e1) {
      diag("layerPick: imaging 路径失败（" + ((e1 && e1.message) || String(e1)) + "），回退临时文档导出");
      try {
        uri = await psModal(function () {
          return exportLayerViaTmpDoc(doc, docW, docH, L);
        }, "PS Spark: 导出图层到槽位（回退）", 2);
      } catch (e2) {
        failed.push(name);
        diag("layerPick fail: " + name + " -> " + ((e2 && e2.message) || String(e2)));
        continue;
      }
    }
    if (uri) {
      items.push({ name: name, uri: uri });
      diag("layerPick ok: " + name + " (" + Math.round(uri.length / 1024) + "KB)");
    }
  }
  if (!items.length) throw new Error("图层导出失败：" + (failed.join("、") || "未知原因"));
  return { items: items, failed: failed, total: selected.length };
}

/*
 * 把当前选中的多个图层合并导出为「与画布同尺寸、坐标不变」的透明 PNG。
 * 用于「原位合成」的资产：资产在原图中的位置得以保留，模型只需融合、不需重新摆放。
 * 做法：新建同尺寸透明文档 → 复制选中图层（保持坐标）→ 直接导出 PNG（PNG 无图层，保存即合并）。
 */
async function exportActiveLayersMergedCanvasPng(targetSize) {
  const doc = app.activeDocument;
  if (!doc) throw new Error("请先打开一个文档");
  let selected = [];
  try {
    const al = doc.activeLayers;
    if (al) { for (let i = 0; i < al.length; i++) selected.push(al[i]); }
  } catch (e) { diag("assetMerge: 读取选中图层失败 " + e.message); }
  if (!selected.length) throw new Error("未选中图层：请先在 PS 图层面板中选中素材图层（可多选）");
  const W = Math.round(doc.width), H = Math.round(doc.height);

  return await psModal(async function () {
    let tmp = null;
    let ok = 0;
    try {
      tmp = await makeDoc(W, H, "psspark_asset_tmp", doc);
      if (!tmp || tmp.id == null) throw new Error("创建临时文档失败");
      for (let i = 0; i < selected.length; i++) {
        try {
          await selected[i].duplicate(tmp);   /* 同尺寸文档间复制：坐标保持不变 */
          ok++;
        } catch (e1) {
          diag("assetMerge: 图层「" + (selected[i].name || "") + "」复制失败 " + e1.message);
        }
      }
      if (!ok) throw new Error("选中图层都无法复制（可能是锁定图层）");
      /* 基准测试：资产图缩放到与输入图一致的尺寸，保证多图输入坐标系统一 */
      if (targetSize && targetSize.w && targetSize.h &&
          (Math.round(tmp.width) !== Math.round(targetSize.w) || Math.round(tmp.height) !== Math.round(targetSize.h))) {
        try {
          await batchPlay([{
            _obj: "imageSize",
            width: { _unit: "pixelsUnit", _value: Math.round(targetSize.w) },
            height: { _unit: "pixelsUnit", _value: Math.round(targetSize.h) },
            scaleStyles: true,
            constrainProportions: true,
            interpolation: { _enum: "interpolationType", _value: "bicubicSmoother" },
            _options: { dialogOptions: "dontDisplay" }
          }]);
        } catch (eR) {
          try { await tmp.resizeImage(targetSize.w, targetSize.h); }
          catch (eR2) { diag("assetMerge: 缩放失败 " + ((eR && eR.message) || eR) + " / " + eR2.message); }
        }
      }
      const folder = await fs.getDataFolder();
      const entry = await folder.createFile("psspark_asset_merged.png", { overwrite: true });
      await tmp.saveAs.png(entry, { compression: 6 }, true);
      const uri = await fileToDataURI(entry);
      diag("assetMerge: 已合并 " + ok + " 层 → " + W + "×" + H + "（画布对齐）");
      return { uri: uri, w: W, h: H, count: ok };
    } finally {
      if (tmp) { try { await closeDocNoSave(tmp); } catch (eC) { diag("assetMerge: 关闭临时文档 warn " + eC.message); } }
      try { app.activeDocument = doc; } catch (eA) { /* ignore */ }
    }
  }, "PS Spark: 合并图层为资产", 2);
}

/* 载入当前图层的透明区域为选区（不同 PS 版本描述符不同，逐个尝试） */
async function selectLayerTransparency() {
  const tries = [
    { _obj: "select", _target: [{ _ref: "channel", _property: "selection" }], to: { _ref: "channel", _property: "transparency" }, _options: { dialogOptions: "dontDisplay" } },
    { _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _ref: "channel", _property: "transparency" }, _options: { dialogOptions: "dontDisplay" } }
  ];
  let last = null;
  for (let i = 0; i < tries.length; i++) {
    try { await batchPlay([tries[i]]); return true; } catch (e) { last = e; }
  }
  throw new Error("载入图层透明选区失败：" + ((last && last.message) || ""));
}

/* 选中指定图层（批处理优先；DOM 赋值兜底）。不改变当前选区。 */
async function selectLayerById(doc, id) {
  try {
    await batchPlay([{
      _obj: "select",
      _target: [{ _ref: "layer", _id: id }],
      makeVisible: false,
      _options: { dialogOptions: "dontDisplay" }
    }]);
    return true;
  } catch (e) {
    diag("selectLayerById: 批处理选中失败（" + e.message + "），尝试 DOM");
  }
  try {
    const ls = doc.layers || [];
    for (let i = 0; i < ls.length; i++) {
      if (ls[i] && ls[i].id === id) { doc.activeLayers = [ls[i]]; return true; }
    }
  } catch (e2) { diag("selectLayerById: DOM 选中失败 " + e2.message); }
  return false;
}

/* 删除指定图层（DOM 优先，失败改批处理） */
async function deleteLayerById(doc, id) {
  try {
    const ls = doc.layers || [];
    for (let i = 0; i < ls.length; i++) {
      if (ls[i] && ls[i].id === id) { await ls[i].delete(); return true; }
    }
  } catch (e) { diag("deleteLayerById: DOM 删除失败（" + e.message + "），改批处理"); }
  try {
    await batchPlay([{ _obj: "delete", _target: [{ _ref: "layer", _id: id }], _options: { dialogOptions: "dontDisplay" } }]);
    return true;
  } catch (e2) { diag("deleteLayerById: 批处理删除失败 " + e2.message); }
  return false;
}

/*
 * 把当前图层剪贴到它正下方的那一层（Ctrl+Alt+G）：下方层的 alpha/图层蒙版
 * 直接当形状遮罩用，不需要载入选区、不需要羽化、不需要新建蒙版。
 * 拆图元素层重建走这条路，正是为了绕开「命令"建立"当前不可用」「羽化不可用」。
 */
async function clipActiveLayerToBelow() {
  try {
    /* 剪贴蒙版 = groupEvent（Adobe 官方论坛 / ExtendScript 录制均为此写法：
     * 只给 target，不带 group/clipping 参数；多给字段反而不生效）。
     * _isCommand 标明这是命令调用。 */
    await batchPlay([{
      _obj: "groupEvent",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
      _isCommand: true,
      _options: { dialogOptions: "dontDisplay" }
    }]);
  } catch (e) {
    diag("clip: 创建剪贴蒙版失败 " + ((e && e.message) || String(e)));
    return false;
  }
  /* 命令不报错 ≠ 生效（PS 有静默不生效的先例）。剪贴层在描述符里 group=true，
   * 拿不到这个标记就当作失败，交给 v1 回退，绝不让原图整幅盖住元素层。 */
  try {
    const r = await batchPlay([{
      _obj: "get",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
      _options: { dialogOptions: "dontDisplay" }
    }]);
    const d = r && r[0];
    if (d && (d.group === true || d.clipping === true)) {
      diag("clip: 剪贴蒙版已生效");
      return true;
    }
    diag("clip: 剪贴命令未生效（group=" + (d && d.group) + "），回退");
    return false;
  } catch (eV) {
    diag("clip: 剪贴校验读取失败 " + ((eV && eV.message) || String(eV)));
    return false;
  }
}

/* 按 id 合并多个图层（合并到最下面那层），返回合并后的图层对象 */
async function mergeLayersByIds(doc, ids) {
  try {
    const ls = doc.layers || [];
    const arr = [];
    for (let i = 0; i < ls.length; i++) { if (ls[i] && ids.indexOf(ls[i].id) >= 0) arr.push(ls[i]); }
    if (arr.length < 2) return null;
    doc.activeLayers = arr;
    await batchPlay([{
      _obj: "mergeLayers",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
      _options: { dialogOptions: "dontDisplay" }
    }]);
    let out = null;
    try { out = doc.activeLayers[0]; } catch (e) { out = null; }
    return out || null;
  } catch (e) {
    diag("merge: 合并图层失败 " + ((e && e.message) || String(e)));
    return null;
  }
}

/*
 * 用「模型给出的透明通道 + 原图像素」重建元素层。
 *
 * 主路径（v2，默认）：置入原图 → 剪贴到生成层（下方层的 alpha/蒙版即形状）→ 合并两层。
 *   全程不碰选区/羽化/建蒙版，杜绝「命令"建立"当前不可用」「羽化命令不可用」。
 * 回退路径（v1，兼容）：载入生成层透明选区 → 羽化 → 给原图建蒙版。
 *   仅在剪贴不可用时尝试，且选区为空会自动放弃（不再硬报错）。
 * 需在 executeAsModal 内调用；失败会清理并保留生成层（返回 false）。
 */
async function rebuildLayerWithOriginalPixels(origEntry, genLayerId, layerName, W, H, docId, opts) {
  const useMask = !!(opts && opts.useMask);
  const doc = ensureActiveDoc(docId);
  if (!doc) return false;
  let gen = null;
  try {
    const ls = doc.layers || [];
    for (let i = 0; i < ls.length; i++) { if (ls[i] && ls[i].id === genLayerId) { gen = ls[i]; break; } }
  } catch (e) { diag("rebuild: 查找生成层失败 " + e.message); }
  if (!gen) { diag("rebuild: 未找到生成层，跳过"); return false; }

  /* 整幅不透明输出（模型没给透明背景、抠色也没成功）→ 不能剪贴：
   * 否则整张原图会盖满画布，元素层退化成原图副本。 */
  let bw = 0, bh = 0;
  try {
    const b = readLayerPixelBounds(gen);
    if (b) { bw = b.right - b.left; bh = b.bottom - b.top; }
  } catch (e) { /* ignore */ }
  let hasAlphaShape = useMask;
  if (!hasAlphaShape) {
    hasAlphaShape = !(W && H && bw >= W * 0.98 && bh >= H * 0.98);
  }
  if (!hasAlphaShape) {
    diag("rebuild: 生成层覆盖整幅且无有效蒙版（" + Math.round(bw) + "×" + Math.round(bh) + "），判定为不透明输出 → 保留生成层");
    return false;
  }

  let added = null, clipped = false;
  try {
    /* 1) 置入原图（落在生成层正上方，剪贴基底就是生成层） */
    await placeEntryAsLayer(origEntry, { left: 0, top: 0, width: W, height: H }, layerName, null, doc.id, { smartObject: false, quiet: true });
    try { added = doc.activeLayers[0]; } catch (e) { added = null; }
    if (!added) throw new Error("原图置入失败");
    if (added.id === gen.id) throw new Error("原图未生成新图层（置入未生效）");

    /* 2) 剪贴 + 合并：形状来自生成层，颜色来自原图，产物是一张干净的像素层 */
    clipped = await clipActiveLayerToBelow();
    if (clipped) {
      const merged = await mergeLayersByIds(doc, [gen.id, added.id]);
      if (merged) {
        try { merged.name = layerName; } catch (eN) { /* ignore */ }
        /* 合并会把蒙版烘焙进像素 → 元素层变成"没蒙版"的纯像素层。
         * 按结果层透明度重建一个可编辑蒙版，效果与"抠色蒙版"一致且不丢形状。 */
        await restoreMaskFromAlpha(doc, merged.id);
        diag("rebuild: 元素层已用原图像素合成（剪贴+合并，" + layerName + "）");
        return true;
      }
      /* 合并失败：删掉刚置入的原图层（剪贴关系随之消失），走回退路径 */
      diag("rebuild: 剪贴后合并失败，回退选区蒙版路径");
      try { await deleteLayerById(doc, added.id); } catch (eD0) { /* ignore */ }
      added = null;
    } else {
      /* 剪贴未生效：同样先清掉这层原图，避免回退路径再置入一层导致重影 */
      diag("rebuild: 剪贴未生效，清理后回退选区蒙版路径");
      try { await deleteLayerById(doc, added.id); } catch (eD1) { /* ignore */ }
      added = null;
    }
    return await rebuildViaSelectionMask(doc, gen, origEntry, layerName, W, H, opts);
  } catch (e) {
    diag("rebuild: 失败，保留生成层 -> " + ((e && e.message) || String(e)));
    if (added) { try { await deleteLayerById(doc, added.id); } catch (e2) { /* ignore */ } }
    try { await deselect(); } catch (e3) { /* ignore */ }
    return false;
  }
}

/* v1 回退：载入生成层选区 → 羽化 → 给原图加蒙版。任何一步失败都返回 false，不外抛。 */
async function rebuildViaSelectionMask(doc, gen, origEntry, layerName, W, H, opts) {
  const useMask = !!(opts && opts.useMask);
  let added = null;
  try {
    await placeEntryAsLayer(origEntry, { left: 0, top: 0, width: W, height: H }, layerName, null, doc.id, { smartObject: false, quiet: true });
    try { added = doc.activeLayers[0]; } catch (e) { added = null; }
    if (!added) throw new Error("原图置入失败");
    if (!(await selectLayerById(doc, gen.id))) throw new Error("无法选中生成层");
    if (useMask) await selectLayerMaskChannel();
    else await selectLayerTransparency();
    if (!(await selectionNonEmpty())) {
      diag("rebuild(v1): 生成层没有可见像素（选区为空），放弃重建、保留生成层");
      try { await deleteLayerById(doc, added.id); } catch (eDel) { /* ignore */ }
      try { await deselect(); } catch (eD2) { /* ignore */ }
      return false;
    }
    await featherSelection((opts && opts.feather != null) ? opts.feather : 1);
    if (!(await selectLayerById(doc, added.id))) throw new Error("无法选中原图层");
    const okMask = await applySelectionAsLayerMask();
    if (!okMask) {
      diag("rebuild(v1): 蒙版未建立，放弃重建、保留生成层");
      try { await deleteLayerById(doc, added.id); } catch (eDel2) { /* ignore */ }
      try { await deselect(); } catch (eD3) { /* ignore */ }
      return false;
    }
    try { await deselect(); } catch (eD4) { /* ignore */ }
    const delOk = await deleteLayerById(doc, gen.id);
    if (!delOk) diag("rebuild(v1): 删除生成层失败（保留，原图层在上）");
    try { added.name = layerName; } catch (eN) { /* ignore */ }
    diag("rebuild(v1): 元素层已用原图像素重建（" + layerName + "，删除生成层=" + delOk + "）");
    return true;
  } catch (e) {
    diag("rebuild(v1): 失败，保留生成层 -> " + ((e && e.message) || String(e)));
    if (added) { try { await deleteLayerById(doc, added.id); } catch (e2) { /* ignore */ } }
    try { await deselect(); } catch (e3) { /* ignore */ }
    return false;
  }
}

/*
 * 生成黑白蒙版 PNG（白=选区/可重绘区），与导出图同区域同尺寸：
 * 1. 复制整份文档（会携带当前选区，与导出图共用同一坐标体系）
 * 2. 直接在副本上基于选区填色：白=选区内，黑=选区外
 * 3. 拍平后裁剪到 cropBounds（与导出图同一裁剪矩形，保证尺寸一致）
 */
async function buildMaskPNG(cropBounds, targetSize, channelName) {
  const srcDoc = app.activeDocument;
  protectDoc(srcDoc);
  const beforeIds = snapshotDocIds();

  await batchPlay([{
    _obj: "duplicate",
    _target: [{ _ref: "document", _enum: "ordinal", _value: "targetEnum" }],
    name: "psspark_mask_tmp",
    _options: { dialogOptions: "dontDisplay" }
  }]);
  const maskDoc = findNewDoc(beforeIds);
  if (!maskDoc) throw new Error("复制文档失败：未能识别临时蒙版文档，已中止（原文档未受影响）");
  diag(`mask: doc dup -> id=${maskDoc && maskDoc.id} ${maskDoc.width}x${maskDoc.height}`);

  // 确认副本携带选区；没有则从备份通道恢复
  let selOk = false;
  try {
    const r = await batchPlay([{
      _obj: "get",
      _target: [{ _property: "selection" }, { _ref: "document", _enum: "ordinal", _value: "targetEnum" }],
      _options: { dialogOptions: "dontDisplay" }
    }]);
    selOk = !!(r && r[0] && r[0].selection);
  } catch (e) { selOk = false; }
  if (!selOk) {
    diag("mask: 副本无选区，尝试从通道恢复");
    /* 优先用本次运行自己的通道：旧通道可能属于上一张图/上一次选区，
       拿错通道会让蒙版落在别的区域，表现就是「模型没改我框的地方」。 */
    const tries = [];
    if (channelName) {
      /* 有本次运行的通道就只认它：旧通道可能属于别的选区，宁可不改也不能改错地方 */
      tries.push(channelName);
    } else {
      tries.push("pssparkSelClip");
      tries.push("pssparkSel");
    }
    for (let i = 0; i < tries.length && !selOk; i++) {
      try {
        await batchPlay([{ _obj: "set", _target: [{ _ref: "channel", _property: "selection" }], to: { _ref: "channel", _name: tries[i] } }]);
        selOk = true;
        diag("mask: 已从通道 " + tries[i] + " 恢复选区");
      } catch (e) {
        diag("mask: 通道 " + tries[i] + " 不可用: " + ((e && e.message) || String(e)));
      }
    }
  }

  const fillWhite = { _obj: "fill", using: { _enum: "fillContents", _value: "white" }, opacity: { _unit: "percentUnit", _value: 100 }, mode: { _enum: "blendMode", _value: "normal" } };
  const fillBlack = { _obj: "fill", using: { _enum: "fillContents", _value: "black" }, opacity: { _unit: "percentUnit", _value: 100 }, mode: { _enum: "blendMode", _value: "normal" } };

  /* 新建图层用来填黑白；个别状态下 PS 会报「命令"建立"当前不可用」，
   * 这时直接在现有图层上填色也成立（选区内外都会被覆盖，拍平后就是纯黑白蒙版）。 */
  const addFillLayer = async function () {
    try {
      await batchPlayRetry({ _obj: "make", _new: { _obj: "layer" } }, "mask.makeLayer");
    } catch (eMk) {
      diag("mask: 新建图层失败（" + ((eMk && eMk.message) || String(eMk)) + "），直接在现有图层填色");
    }
  };

  if (selOk) {
    await addFillLayer();
    await batchPlay([fillWhite]);                        // 白 = 选区内
    await batchPlay([{ _obj: "inverse" }]);
    await batchPlay([fillBlack]);                        // 黑 = 选区外
    await deselect();
  } else {
    // 无选区：整层填黑（保守，不重绘任何区域），并显著提示
    await addFillLayer();
    await batchPlay([fillBlack]);
    log("⚠ 蒙版未获得选区，使用全黑蒙版（模型不会修改任何区域）", "err");
  }

  try { await batchPlay([{ _obj: "flattenImage" }]); } catch (e) { diag("mask: flatten warn: " + e.message); }

  await batchPlay([{
    _obj: "crop",
    to: {
      _obj: "rectangle",
      top: { _unit: "pixelsUnit", _value: Math.round(cropBounds.top) },
      left: { _unit: "pixelsUnit", _value: Math.round(cropBounds.left) },
      bottom: { _unit: "pixelsUnit", _value: Math.round(cropBounds.bottom) },
      right: { _unit: "pixelsUnit", _value: Math.round(cropBounds.right) }
    },
    angle: { _unit: "angleUnit", _value: 0 },
    "delete": true
  }]);
  diag(`mask: cropped -> ${maskDoc.width}x${maskDoc.height} (期望 ${Math.round(cropBounds.width)}x${Math.round(cropBounds.height)})`);

  /* 基准测试：蒙版必须与输入图同尺寸（输入图可能被等比缩小），否则 edits 端点会拒绝 */
  if (targetSize && targetSize.w && targetSize.h &&
      (Math.round(maskDoc.width) !== Math.round(targetSize.w) || Math.round(maskDoc.height) !== Math.round(targetSize.h))) {
    diag(`mask: resize -> ${targetSize.w}x${targetSize.h}`);
    try {
      await batchPlay([{
        _obj: "imageSize",
        width: { _unit: "pixelsUnit", _value: Math.round(targetSize.w) },
        height: { _unit: "pixelsUnit", _value: Math.round(targetSize.h) },
        scaleStyles: true,
        constrainProportions: true,
        interpolation: { _enum: "interpolationType", _value: "bicubicSmoother" },
        _options: { dialogOptions: "dontDisplay" }
      }]);
    } catch (e) {
      try { await maskDoc.resizeImage(targetSize.w, targetSize.h); }
      catch (e2) { throw new Error("蒙版缩放失败：" + ((e && e.message) || e) + " / " + e2.message); }
    }
  }

  const mkW = maskDoc.width, mkH = maskDoc.height;

  const folder = await fs.getDataFolder();
  const entry = await folder.createFile("psspark_mask.png", { overwrite: true });
  await maskDoc.saveAs.png(entry, { compression: 6 }, true);
  await closeDocNoSave(maskDoc);
  restoreActiveDoc(srcDoc);
  diag("mask: tmp closed");
  return { entry, actualW: mkW, actualH: mkH };
}

/*
 * 扩图蒙版：白色 = 允许模型重绘（四周扩展边），黑色 = 必须保持原样（原图矩形）。
 * 约定与 buildMaskPNG 一致（白 = 要改），edits 端点收到蒙版后只在白区生成，
 * 原图矩形不会被重新构图 —— 这是「返回图被整体缩放/原图错位」的根因修复点之一。
 */
async function buildOutpaintMaskPNG(w, h, rect) {
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  const beforeIds = snapshotDocIds();
  let doc = null;
  try {
    doc = await makeDoc(W, H, "psspark_outpaint_mask");
    const dm = docDims(doc);
    if (dm[0] > 0 && (Math.abs(dm[0] - W) > 2 || Math.abs(dm[1] - H) > 2)) {
      throw new Error("扩图蒙版画布尺寸异常（" + dm[0] + "×" + dm[1] + "，期望 " + W + "×" + H + "）");
    }
    /* 先整张填白（= 全部可重绘） */
    await batchPlay([{
      _obj: "fill",
      using: { _enum: "fillContents", _value: "white" },
      opacity: { _unit: "percentUnit", _value: 100 },
      mode: { _enum: "blendMode", _value: "normal" }
    }]);
    /* 原图矩形填黑（= 保持不变） */
    await selectRect({
      left: Math.max(0, Math.round(rect.left)),
      top: Math.max(0, Math.round(rect.top)),
      right: Math.min(W, Math.round(rect.right)),
      bottom: Math.min(H, Math.round(rect.bottom))
    });
    await batchPlay([{
      _obj: "fill",
      using: { _enum: "fillContents", _value: "black" },
      opacity: { _unit: "percentUnit", _value: 100 },
      mode: { _enum: "blendMode", _value: "normal" }
    }]);
    await deselect();
    try { await batchPlay([{ _obj: "flattenImage" }]); } catch (eF) { diag("outpaint mask: flatten warn " + eF.message); }

    const folder = await fs.getDataFolder();
    const entry = await folder.createFile("psspark_outpaint_mask.png", { overwrite: true });
    await doc.saveAs.png(entry, { compression: 6 }, true);
    diag("outpaint mask: saved " + W + "x" + H + "，原图区 (" +
      Math.round(rect.left) + "," + Math.round(rect.top) + ")-(" +
      Math.round(rect.right) + "," + Math.round(rect.bottom) + ")");
    return entry;
  } finally {
    if (doc) { try { await closeDocNoSave(doc); } catch (eC) { diag("outpaint mask: close warn " + eC.message); } }
  }
}

/* 下载结果图到插件数据目录（固定文件名 psspark_result.png，每次覆盖），返回 File entry */
async function downloadResultToEntry(imgUrl, fileName) {
  log("下载结果图...");
  startProgress("下载结果图");
  const res = await xhrRequest({ method: "GET", url: imgUrl, responseType: "arraybuffer", timeout: 120000 });
  if (res.status !== 200) throw new Error(`下载结果图失败 HTTP ${res.status}`);
  const folder = await fs.getDataFolder();
  /* 候选多图时按候选序号命名（psspark_cand_2.png …），避免并发互相覆盖 */
  const entry = await folder.createFile(fileName || "psspark_result.png", { overwrite: true });
  await entry.write(res.response, { format: formats.binary });
  return entry;
}

/* 把本地 PNG（File entry）置入目标文档并写入图层。
 * 首选 placeEvent 置入（作为智能对象），全程不打开/关闭任何文档"页面"；
 * 失败时回退"打开文档→复制图层→关闭结果文档"（带多重防护，绝不触碰目标文档）。
 * clip 可选：{ channel, mask } —— 从通道恢复原选区；mask=true 时把选区套为结果图层蒙版（只保留选区内内容）。
 * targetDocId 可选：目标文档 ID（按 ID 定位并切回，防活动指针滞后/失效）。
 * 必须在 executeAsModal 内调用。 */
async function placeEntryAsLayer(entry, targetBounds, layerName, clip, targetDocId, opts) {
  startProgress("写入结果图层");
  /* 是否保持智能对象：显式传入优先；否则跟随设置（默认开）。
   * 智能对象可无损缩放/回改，代价是不能直接用画笔涂抹（需先栅格化）。 */
  const keepSO = (opts && opts.smartObject != null)
    ? !!opts.smartObject
    : (typeof getDefaults === "function" ? getDefaults().smartObject !== false : true);
  /* 活动文档指针可能滞后/失效（UXP 实测：canvasSize 等操作后可能为 null）——
   * 优先按 ID 定位目标文档并显式切回，绝不在"未知文档"上盲操作 */
  const targetDoc = ensureActiveDoc(targetDocId);
  if (!targetDoc) {
    throw new Error("未能定位目标文档（文档可能已被关闭）；结果图已下载，可稍后从历史重新插入");
  }
  protectDoc(targetDoc); // 目标文档永远不参与关闭
  await deselect();      // 避免选区影响变换/置入

  let newLayer = null, placedVia = "";

  /* —— 首选：placeEvent 直接置入当前文档（不会新建任何临时文档页面）。
   * 本环境实测 placeEvent 偶发"静默不生效"（不报错也不建层）→ 重试一次再走回退，
   * 减少"打开临时文档"回退的出现频率（回退会短暂闪现文档窗口）。 —— */
  let beforeCount = -1;
  try { beforeCount = targetDoc.layers.length; } catch (e) { diag("placeEvent: 读取图层数失败 " + e.message); }
  if (beforeCount >= 0) {
    for (let attempt = 1; attempt <= 2 && !newLayer; attempt++) {
      diag("step: placeEvent start (layers=" + beforeCount + ", attempt=" + attempt + ")");
      try {
        const token = await fs.createSessionToken(entry);
        await batchPlay([{
          _obj: "placeEvent",
          "null": { _path: token, _kind: "local" },
          freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
          offset: { _obj: "offset", horizontal: { _unit: "pixelsUnit", _value: 0 }, vertical: { _unit: "pixelsUnit", _value: 0 } },
          _options: { dialogOptions: "dontDisplay" }
        }]);
      } catch (e) {
        diag("step: placeEvent throw: " + e.message);
      }
      let after = -1;
      try { after = targetDoc.layers.length; } catch (e) { /* ignore */ }
      if (after === beforeCount + 1) {
        try { newLayer = targetDoc.activeLayers[0]; } catch (e) { newLayer = null; }
        if (!newLayer) { try { newLayer = targetDoc.layers[0]; } catch (e2) { newLayer = null; } } /* 层已建：兜底取顶层，避免重试多建一层 */
        if (newLayer) placedVia = "place";
        diag("step: placeEvent ok, layers=" + after + ", name=" + (newLayer && newLayer.name));
      } else {
        diag("step: placeEvent 未生效（layers " + beforeCount + " -> " + after + (attempt < 2 ? "，重试一次" : "，改用回退方案") + "）");
      }
    }
  }

  /* —— 回退：打开结果文档 → 复制图层 → 关闭结果文档 —— */
  if (!newLayer) {
    diag("step: fallback open-doc mode");
    const srcDoc = await app.open(entry);
    diag("step: app.open done, id=" + (srcDoc && srcDoc.id));
    if (!srcDoc || !srcDoc.id || srcDoc.id === targetDoc.id) {
      diag("结果图文档识别异常，中止写入以保护当前文档");
      throw new Error("结果图打开异常，已中止（当前文档未受影响）");
    }
    try {
      newLayer = await srcDoc.layers[0].duplicate(targetDoc);
      placedVia = "open-doc";
      diag("step: layer duplicated");
    } finally {
      await closeDocNoSave(srcDoc); // srcDoc 为刚打开的结果文档，不会被保护名单误伤
    }
  }
  restoreActiveDoc(targetDoc);
  try { if (newLayer) targetDoc.activeLayers = [newLayer]; } catch (e) { diag("activeLayers warn: " + e.message); }
  if (!newLayer) throw new Error("结果图层写入失败");

  /* 回退路径产物是普通像素层：按需转回智能对象，保证两条路径行为一致 */
  if (keepSO && placedVia === "open-doc") {
    try {
      await selectLayerById(newLayer.id);
      await batchPlay([{ _obj: "newPlacedLayer", _options: { dialogOptions: "dontDisplay" } }]);
      diag("fallback: 像素层已转为智能对象");
    } catch (eSO) {
      diag("fallback: 转智能对象失败（保持像素层） " + ((eSO && eSO.message) || String(eSO)));
    }
  }

  /* 尺寸/位置对齐：按导出区域 1:1（重绘）或适配画布居中（生成） */
  const r = await batchPlay([{ _obj: "get", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }], _options: { dialogOptions: "dontDisplay" } }]);
  const lb = r[0].boundsNoEffects || r[0].bounds;
  const res2 = targetDoc.resolution || 72;
  const l = toPx(lb.left, res2), t = toPx(lb.top, res2), ri = toPx(lb.right, res2), bo = toPx(lb.bottom, res2);
  const lw = ri - l, lh = bo - t;
  if (lw < 1 || lh < 1) throw new Error("结果图层尺寸异常");

  const docW = targetDoc.width, docH = targetDoc.height;
  let dstW, dstH, cx, cy;
  let coverMask = false; /* 等比铺满后要裁掉溢出部分（防变形又不留边） */
  if (targetBounds && opts && opts.stretch) {
    /* 拆图用：模型输出尺寸/比例不可控（实测 3000×3000 请求回 1206×962），
     * 必须铺满目标区域，否则蒙版与原图会错位、整层偏色。 */
    dstW = targetBounds.width; dstH = targetBounds.height;
    cx = targetBounds.left + dstW / 2;
    cy = targetBounds.top + dstH / 2;
    lastPlaceMeta = { aspectMismatch: false, stretched: true, lw: lw, lh: lh, dstW: dstW, dstH: dstH };
    const arDiff = Math.abs((lw / lh) / (dstW / dstH) - 1);
    /* fitCover：比例不一致时不再非等比拉伸（画布改过比例后抠图会被拉变形），
     * 改为等比放大铺满 + 图层蒙版裁掉溢出 —— 不变形，也不留空白。 */
    if (opts.fitCover && arDiff > 0.01) {
      const cs = fitCoverSize(lw, lh, targetBounds.width, targetBounds.height);
      dstW = cs.w; dstH = cs.h;
      cx = targetBounds.left + targetBounds.width / 2;
      cy = targetBounds.top + targetBounds.height / 2;
      coverMask = true;
      lastPlaceMeta = { aspectMismatch: false, covered: true, lw: lw, lh: lh, dstW: dstW, dstH: dstH };
      diag("placeEntry: 结果图 " + Math.round(lw) + "×" + Math.round(lh) + " 与目标 " +
        Math.round(targetBounds.width) + "×" + Math.round(targetBounds.height) +
        " 比例不符 → 等比铺满 + 蒙版裁边（不拉伸）");
    } else if (arDiff > 0.01) {
      diag("placeEntry: 结果图 " + Math.round(lw) + "×" + Math.round(lh) +
        " 按铺满模式拉伸到 " + Math.round(dstW) + "×" + Math.round(dstH) +
        "（比例差 " + Math.round(arDiff * 100) + "%，保证与原图对齐）");
      if (arDiff > 0.05) {
        log("⚠ 模型返回比例（" + Math.round(lw) + "×" + Math.round(lh) + "）与目标区域不一致，" +
          "已拉伸铺满以免错位；如需完全不变形请换支持该比例尺寸的模型", "err");
      }
    }
  } else if (targetBounds) {
    /* ⚠ 等比（contain）缩放，绝不非等比拉伸：
     * AI 输出图的比例与目标区域比例不一致时（实测发生：输出方图回贴竖幅导致素材被拉伸），
     * 若按 width/height 各自独立缩放百分比会变形。统一取最小缩放比，等比缩放后居中。
     * 比例一致时（scale 两轴相同）等价于精确覆盖，编辑类 1:1 回贴行为不变。 */
    const cs = containScale(lw, lh, targetBounds.width, targetBounds.height);
    dstW = cs.w; dstH = cs.h;
    cx = targetBounds.left + targetBounds.width / 2;
    cy = targetBounds.top + targetBounds.height / 2;
    const wantAR = targetBounds.width / targetBounds.height;
    const gotAR = lw / lh;
    const mismatch = Math.abs(wantAR - gotAR) / wantAR > 0.01;
    lastPlaceMeta = { aspectMismatch: mismatch, lw: lw, lh: lh, dstW: dstW, dstH: dstH };
    if (mismatch) {
      diag("placeEntry: 结果图 " + Math.round(lw) + "×" + Math.round(lh) +
        " 比例与目标区域 " + Math.round(targetBounds.width) + "×" + Math.round(targetBounds.height) +
        " 不一致 → 等比缩放居中写入（防拉伸）");
    }
  } else {
    const s = Math.min(1, docW / lw, docH / lh);
    dstW = lw * s; dstH = lh * s;
    cx = docW / 2; cy = docH / 2;
    lastPlaceMeta = { aspectMismatch: false, lw: lw, lh: lh, dstW: dstW, dstH: dstH };
  }

  await batchPlay([{
    _obj: "transform",
    _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
    freeTransformCenterState: { _enum: "quadCenterState", _value: "QCSAverage" },
    offset: {
      _obj: "offset",
      horizontal: { _unit: "pixelsUnit", _value: cx - (l + lw / 2) },
      vertical: { _unit: "pixelsUnit", _value: cy - (t + lh / 2) }
    },
    width: { _unit: "percentUnit", _value: dstW / lw * 100 },
    height: { _unit: "percentUnit", _value: dstH / lh * 100 }
  }]);

  /* 等比铺满后裁边：只保留目标矩形内的像素（可编辑蒙版，不破坏像素） */
  if (coverMask && targetBounds) {
    try {
      await selectRect({
        left: Math.round(targetBounds.left), top: Math.round(targetBounds.top),
        right: Math.round(targetBounds.right), bottom: Math.round(targetBounds.bottom)
      });
      if (!(await selectionNonEmpty())) throw new Error("目标矩形选区为空");
      await applySelectionAsLayerMask();
      await deselect();
      diag("placeEntry: 溢出部分已用蒙版裁掉（保留目标区域 " +
        Math.round(targetBounds.width) + "×" + Math.round(targetBounds.height) + "）");
    } catch (eC) {
      diag("placeEntry: 裁边失败（结果层保持完整，可能超出画布） " + ((eC && eC.message) || String(eC)));
      try { await deselect(); } catch (eD0) { /* ignore */ }
    }
  }

  /* 扩图专用：把「原图矩形」从结果层里挖掉（生成图层蒙版，可再编辑）。
   * 模型即便把画面重新构图/缩放过，原图区域也一定是用户自己的像素，
   * 位置与大小按原坐标锁死 —— 「结果与原图没对齐」由此杜绝。 */
  if (opts && opts.punchRect) {
    const pr = opts.punchRect;
    try {
      await selectRect({
        left: Math.round(pr.left), top: Math.round(pr.top),
        right: Math.round(pr.right), bottom: Math.round(pr.bottom)
      });
      if (!(await selectionNonEmpty())) throw new Error("矩形选区为空（挖空区域无效）");
      const fpx = (opts.punchFeather != null) ? opts.punchFeather
        : Math.max(1, Math.round(Math.min(pr.right - pr.left, pr.bottom - pr.top) * 0.002));
      if (fpx > 0) await featherSelection(fpx);
      await batchPlay([{ _obj: "inverse" }]);
      await applySelectionAsLayerMask();
      await deselect();
      diag("placeEntry: 原图区域已挖空 (" + Math.round(pr.left) + "," + Math.round(pr.top) + ")-(" +
        Math.round(pr.right) + "," + Math.round(pr.bottom) + ")，羽化 " + fpx + "px，下层原始像素保留");
    } catch (eP) {
      diag("placeEntry: 挖空原图区域失败（结果层保持完整） " + ((eP && eP.message) || String(eP)));
      try { await deselect(); } catch (eD) { /* ignore */ }
    }
  }

  try { newLayer.name = layerName; } catch (e) { diag("layer rename warn: " + e.message); }
  /* 智能对象：保持可无损缩放/回改（设置默认开启）；关闭时栅格化为像素层 */
  if (!keepSO) {
    try {
      await batchPlay([{ _obj: "rasterizeLayer", _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }] }]);
    } catch (e) { diag("rasterize warn: " + e.message); }
  } else {
    diag("keep: 结果层保持智能对象（" + layerName + "）");
  }

  /* 记录本次落层位置与尺寸：供「局部重做」把预览里的矩形反算回画布坐标 */
  lastPlacedLayer = {
    id: (newLayer && newLayer.id != null) ? newLayer.id : null,
    name: layerName,
    bounds: { left: cx - dstW / 2, top: cy - dstH / 2, width: dstW, height: dstH },
    smartObject: keepSO,
    placedVia: placedVia
  };
  markPluginResultLayer(lastPlacedLayer.id);

  /* 按原选区裁剪结果（只保留选区内内容，选区外透出原图） */
  if (clip && clip.channel) {
    try {
      await loadSelectionFromChannel(clip.channel);
      /* 先收缩再羽化：收缩掉「定位框线」压住的 1–2px，羽化让边缘过渡自然（不出硬接缝） */
      if (clip.contract) await contractSelection(clip.contract);
      if (clip.feather) await featherSelection(clip.feather);
      if (clip.mask) {
        await applySelectionAsLayerMask();
        log("已按原选区裁剪结果图层（选区外保留原图内容，蒙版可再编辑）", "ok");
      }
    } catch (e) {
      diag("clip warn: " + e.message);
      log("⚠ 按选区裁剪失败，结果图层保持完整: " + e.message, "err");
    }
    await deleteChannelQuiet(clip.channel);
  }

  /* quiet：内部辅助层（如拆图重建用的原图副本）不单独报「已生成图层」，避免同名两条日志 */
  if (!(opts && opts.quiet)) {
    log(`已生成图层「${layerName}」${placedVia === "place" ? "（已直接写入当前文档，未打开/关闭任何页面）" : ""}`, "ok");
  }
}

/*
 * 写入缩放计算（等比 contain）：把 lw×lh 的图层放进 tw×th 的目标区域。
 * 返回 { scale, w, h }：w/h 为等比缩放后的实际尺寸（不会变形；比例一致时 = 精确覆盖）。
 * 独立成函数便于单测（曾经的非等比拉伸 bug：width/height 各自独立缩放百分比）。
 */
function containScale(lw, lh, tw, th) {
  const s = Math.min(tw / lw, th / lh);
  return { scale: s, w: lw * s, h: lh * s };
}

/* 等比铺满（cover）：把 lw×lh 铺满 tw×th，允许溢出，由调用方用蒙版裁边。
 * 与 containScale 相对：cover 不变形也不留空白，代价是超出部分要被裁掉。 */
function fitCoverSize(lw, lh, tw, th) {
  const s = Math.max(tw / lw, th / lh);
  return { scale: s, w: lw * s, h: lh * s };
}

/* 下载 + 置入（常规调用形态），返回结果文件 entry（供任务存储/再次插入复用）。
 * targetDocId 可选：目标文档 ID（运行时捕获）——按 ID 定位并切回，防活动指针滞后/失效。 */
async function placeResultAsLayer(imgUrl, targetBounds, layerName, clip, targetDocId, opts) {
  const entry = await downloadResultToEntry(imgUrl);
  await placeEntryAsLayer(entry, targetBounds, layerName, clip, targetDocId, opts);
  return entry;
}

/* 设置当前活动图层的不透明度（0~100）。
 * 用途：原位合成·光影模式的「轻/中/重」——结果层与下层原图按比例融合，不透明度越低保留原图越多。
 * 必须在 executeAsModal 内调用。 */
async function setActiveLayerOpacity(pct) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  try {
    await batchPlay([{
      _obj: "set",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
      to: { _unit: "percentUnit", _value: v },
      _options: { dialogOptions: "dontDisplay" }
    }]);
    diag("setActiveLayerOpacity: " + v + "%");
    return true;
  } catch (e) {
    diag("setActiveLayerOpacity warn: " + e.message);
    return false;
  }
}

/* 把当前活动图层移到最底层（best-effort）：拆图的背景层要压在所有元素层下面 */
async function moveLayerToBack() {
  try {
    await batchPlay([{
      _obj: "move",
      _target: [{ _ref: "layer", _enum: "ordinal", _value: "targetEnum" }],
      adjustment: { _enum: "ordinal", _value: "backEnum" },
      _options: { dialogOptions: "dontDisplay" }
    }]);
    diag("moveLayerToBack: ok");
    return true;
  } catch (e) {
    diag("moveLayerToBack warn: " + e.message);
    return false;
  }
}

/* ---------------- 扩图：画布扩展 ---------------- */

/*
 * 两步扩展画布，使原内容最终位于 (left, top) 偏移处：
 *  ① 右/下锚点扩到 (W+left, H+top) —— 内容被推到 (left, top)
 *  ② 左/上锚点扩到最终尺寸 (outW, outH) —— 内容保持不动
 * （单次九宫锚点无法表达任意非对称偏移，故拆两步）
 * 主路径：DOM `doc.resizeCanvas(w, h, anchor)`；回退：batchPlay canvasSize。
 * 结束前读回尺寸校验——批处理画布类命令在本环境曾出现"静默不生效"（不报错也不执行），
 * 必须实测确认，未生效即抛明确错误（宁可不做，不可做错）。
 */
async function canvasResizeTo(docW, docH, outW, outH, left, top) {
  const doc = app.activeDocument;
  if (!doc) throw new Error("画布扩展失败：无活动文档");
  let beforeW = -1, beforeH = -1;
  try { beforeW = Math.round(doc.width); beforeH = Math.round(doc.height); } catch (e0) { /* ignore */ }

  async function viaDom() {
    if (left > 0 || top > 0) {
      await doc.resizeCanvas(Math.round(docW + left), Math.round(docH + top), "bottomRight");
    }
    await doc.resizeCanvas(Math.round(outW), Math.round(outH), "topLeft");
  }
  async function viaBatch() {
    if (left > 0 || top > 0) {
      await batchPlay([{
        _obj: "canvasSize",
        width: { _unit: "pixelsUnit", _value: Math.round(docW + left) },
        height: { _unit: "pixelsUnit", _value: Math.round(docH + top) },
        horizontal: { _enum: "horizontalLocation", _value: "right" },
        vertical: { _enum: "verticalLocation", _value: "bottom" },
        _options: { dialogOptions: "dontDisplay" }
      }]);
    }
    await batchPlay([{
      _obj: "canvasSize",
      width: { _unit: "pixelsUnit", _value: Math.round(outW) },
      height: { _unit: "pixelsUnit", _value: Math.round(outH) },
      horizontal: { _enum: "horizontalLocation", _value: "left" },
      vertical: { _enum: "verticalLocation", _value: "top" },
      _options: { dialogOptions: "dontDisplay" }
    }]);
  }

  try {
    await viaDom();
  } catch (e1) {
    diag("canvasResizeTo: DOM resizeCanvas 失败（" + e1.message + "），回退批处理");
    await viaBatch();
  }

  let aw = -1, ah = -1;
  try { aw = Math.round(doc.width); ah = Math.round(doc.height); } catch (e2) { /* ignore */ }
  diag("canvasResizeTo: " + beforeW + "×" + beforeH + " -> 期望 " + Math.round(outW) + "×" + Math.round(outH) + "，实测 " + aw + "×" + ah);
  if (aw > 0 && (Math.abs(aw - outW) > 2 || Math.abs(ah - outH) > 2)) {
    throw new Error("画布扩展未生效（实测 " + aw + "×" + ah + "，期望 " + Math.round(outW) + "×" + Math.round(outH) + "）");
  }
}

/* 提示词构造已迁往 registry.js（W2：buildFinalPrompt + 模板体系） */

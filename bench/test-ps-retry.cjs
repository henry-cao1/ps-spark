/*
 * test-ps-retry.cjs — PS 命令层加固回归测试（jsdom + mock batchPlay）
 *
 * 覆盖 2026-11-01 拆图「命令"建立"/"羽化"当前不可用」的修法：
 *   1) 「当前不可用」= 命令没执行 → 自动重试且安全
 *   2) 连续不可用有限次后仍抛出（不吞错、不死循环）
 *   3) 非「不可用」错误不重试（避免重复执行有副作用的命令）
 *   4) 空选区时羽化/建蒙版/抠色全部短路，不惊动 PS（这正是报错的源头）
 *   5) 剪贴蒙版「不报错但没生效」能被识别，交给 v1 回退
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "../ps-spark-plugin");

let pass = 0, fail = 0;
function ck(name, ok, detail) {
  if (ok) { pass++; console.log("PASS | " + name + (detail ? " -> " + detail : "")); }
  else { fail++; process.exitCode = 1; console.log("FAIL | " + name + (detail ? " -> " + detail : "")); }
}

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
  .replace(/<script src="[^"]+"><\/script>/g, "");
const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/", pretendToBeVisual: true });
const w = dom.window;

/* mock：plan 每项是返回值（数组）或 "ERR:<message>"；记录调用次数 */
let plan = [];
const calls = { n: 0, descs: [] };
const doc = {
  id: 1, name: "t.psd", width: 1000, height: 1000, resolution: 72,
  layers: [], activeLayers: [{ id: 11, name: "L", isBackgroundLayer: false }]
};
const psMock = {
  app: { activeDocument: doc, documents: [doc] },
  core: { executeAsModal: async function (fn) { return fn(); } },
  action: {
    batchPlay: async function (descs) {
      calls.n++;
      calls.descs.push(descs && descs[0] && descs[0]._obj);
      const step = plan.length ? plan.shift() : "OK";
      if (typeof step === "string" && step.indexOf("ERR:") === 0) {
        throw new Error(step.slice(4));
      }
      return (step === "OK") ? [{}] : step;
    }
  },
  imaging: {}
};

w.require = function (m) {
  if (m === "photoshop") return psMock;
  if (m === "uxp") {
    return {
      storage: {
        localFileSystem: { getEntry: async function () { throw new Error("no"); } },
        secureStorage: { getItem: async function () { return null; }, setItem: async function () {}, removeItem: async function () {} },
        formats: { utf8: "utf8", binary: "binary" }
      }
    };
  }
  throw new Error("unknown module " + m);
};

["diag.js", "services.js", "api.js", "ps.js"].forEach(function (f) {
  const s = w.document.createElement("script");
  s.textContent = fs.readFileSync(path.join(ROOT, "js", f), "utf8");
  w.document.body.appendChild(s);
});

/* batchPlay 在 ps.js 里直接引用全局 action 对象 → 换的是同一个对象的方法 */
function reset(nextPlan) {
  plan = nextPlan || [];
  calls.n = 0;
  calls.descs = [];
}

const UNAVAIL = 'ERR:命令"建立"当前不可用';
const UNAVAIL_FEATHER = 'ERR:命令"羽化"当前不可用';

(async function () {
  await new Promise((r) => setTimeout(r, 80));

  /* ---- 1) 不可用即可重试（PS 拒绝执行，命令没跑，重试安全） ---- */
  reset([UNAVAIL, "OK"]);
  let ok = true;
  try { await w.eval("batchPlay([{_obj:'make'}])"); } catch (e) { ok = false; }
  ck("「建立不可用」自动重试后成功", ok && calls.n === 2, "calls=" + calls.n);

  reset([UNAVAIL_FEATHER, "OK"]);
  ok = true;
  try { await w.eval("batchPlay([{_obj:'feather'}])"); } catch (e) { ok = false; }
  ck("「羽化不可用」同样自动重试", ok && calls.n === 2, "calls=" + calls.n);

  /* ---- 2) 持续不可用：有限重试后仍抛出 ---- */
  reset([UNAVAIL, UNAVAIL, UNAVAIL, "OK"]);
  let threw = false;
  try { await w.eval("batchPlay([{_obj:'make'}])"); } catch (e) { threw = true; }
  ck("持续不可用：最多重试 3 次后抛出（不死循环）", threw && calls.n === 3, "calls=" + calls.n);

  /* ---- 3) 其它错误不重试 ---- */
  reset(["ERR:Some other failure"]);
  threw = false;
  try { await w.eval("batchPlay([{_obj:'transform'}])"); } catch (e) { threw = true; }
  ck("非「不可用」错误不重试（避免重复副作用）", threw && calls.n === 1, "calls=" + calls.n);

  /* ---- 4) 空选区短路 ---- */
  const emptySel = [{ selection: { left: sel(0), top: sel(0), right: sel(0), bottom: sel(0) } }];
  const realSel = [{ selection: { left: sel(10), top: sel(20), right: sel(210), bottom: sel(220) } }];

  reset([emptySel]);
  ck("selectionNonEmpty：零面积选区判为空", (await w.eval("selectionNonEmpty()")) === false, "calls=" + calls.n);

  reset([realSel]);
  ck("selectionNonEmpty：正常选区判为有", (await w.eval("selectionNonEmpty()")) === true, "calls=" + calls.n);

  reset([emptySel]);
  calls.n = 0;
  let r = await w.eval("featherSelection(5)");
  ck("空选区跳过羽化：只查一次、不调 feather", r === false && calls.n === 1 && calls.descs[0] === "get",
    "calls=" + calls.n + " " + calls.descs.join(","));

  reset([emptySel]);
  calls.n = 0;
  r = await w.eval("applySelectionAsLayerMask()");
  ck("空选区不建蒙版：只查一次、不调 make", r === false && calls.n === 1 && calls.descs[0] === "get",
    "calls=" + calls.n + " " + calls.descs.join(","));

  /* ---- 5) 背景图层不加蒙版（「建立不可用」的另一大来源） ---- */
  doc.activeLayers = [{ id: 12, name: "Background", isBackgroundLayer: true }];
  reset([realSel]);
  calls.n = 0;
  r = await w.eval("applySelectionAsLayerMask()");
  ck("背景图层不加蒙版：返回 false 且不调 make", r === false && calls.descs.indexOf("make") < 0,
    "calls=" + calls.n + " " + calls.descs.join(","));
  doc.activeLayers = [{ id: 11, name: "L", isBackgroundLayer: false }];

  /* ---- 6) 抠色：魔棒点空 → 直接放弃（不再反选+建蒙版） ---- */
  reset(["OK", emptySel]);
  calls.n = 0;
  r = await w.eval("cutLayerByColorKey({tolerance:26})");
  ck("抠色：魔棒未选中区域时返回 false，不建蒙版",
    r === false && calls.descs.indexOf("inverse") < 0 && calls.descs.indexOf("make") < 0,
    "calls=" + calls.descs.join(","));

  /* ---- 7) 剪贴生效判定 ---- */
  reset(["OK", [{ group: true }]]);
  ck("剪贴：group=true 判定生效", (await w.eval("clipActiveLayerToBelow()")) === true, "calls=" + calls.n);

  reset(["OK", [{ group: false }]]);
  ck("剪贴：group=false 判定未生效（走回退）", (await w.eval("clipActiveLayerToBelow()")) === false, "calls=" + calls.n);

  reset(["OK", [{ clipping: true }]]);
  ck("剪贴：clipping=true 也判定生效", (await w.eval("clipActiveLayerToBelow()")) === true, "calls=" + calls.n);

  reset([UNAVAIL, UNAVAIL, UNAVAIL]);
  ck("剪贴命令持续报错时返回 false（不阻塞主流程）",
    (await w.eval("clipActiveLayerToBelow()")) === false, "calls=" + calls.n);

  /* ---- 8) 扩图超限明细（二次确认的数据源） ---- */
  let info = await w.eval("expandLimitInfo('gpt-image-2', 1000, 1000, 100, 100, 100, 100)");
  ck("扩图超限：未超限时 ok=true 且无条目",
    info && info.ok === true && info.reasons.length === 0, JSON.stringify({ ok: info && info.ok }));

  info = await w.eval("expandLimitInfo('gpt-image-2', 2000, 2000, 500, 500, 500, 500)");
  const pxR = (info.reasons || []).filter(function (r) { return r.kind === "pixels"; })[0];
  ck("扩图超限：像素超限给出 limit/actual/over",
    info && info.ok === false && !!pxR && pxR.limit === 1920 && pxR.actual === 3000 && pxR.over === 1080,
    JSON.stringify(pxR || {}));

  info = await w.eval("expandLimitInfo('gpt-image-2', 1000, 1000, 2000, 2000, 0, 0)");
  const rtR = (info.reasons || []).filter(function (r) { return r.kind === "ratio"; })[0];
  ck("扩图超限：长宽比超限单独成条",
    !!rtR && rtR.actual > rtR.limit, JSON.stringify(rtR || {}));

  ck("expandLimitWarning 仍返回同一句话（兼容旧调用）",
    (await w.eval("expandLimitWarning('gpt-image-2', 2000, 2000, 500, 500, 500, 500)")).indexOf("超过该模型上限 1920px") >= 0,
    "");

  /* ---- 9) 拆图纯色底探测（边框同色才去抠；探测按 128×128 取样） ---- */
  const PN = 128;
  const solid = new Uint8Array(PN * PN * 4);
  for (let i = 0; i < PN * PN; i++) {
    solid[i * 4] = 255; solid[i * 4 + 1] = 0; solid[i * 4 + 2] = 255; solid[i * 4 + 3] = 255;
  }
  const busy = new Uint8Array(PN * PN * 4);
  for (let y = 0; y < PN; y++) {
    for (let x = 0; x < PN; x++) {
      const i = (y * PN + x) * 4;
      const edge = (x < 8 || x >= PN - 8 || y < 8 || y >= PN - 8);
      if (edge) {
        busy[i] = (x * 7) % 255; busy[i + 1] = (y * 7) % 255; busy[i + 2] = (x * 3 + y * 5) % 255;
      } else { busy[i] = 20; busy[i + 1] = 40; busy[i + 2] = 60; }
      busy[i + 3] = 255;
    }
  }
  let probeData = solid;
  psMock.imaging.getPixels = async function () {
    return { getData: async function () { return probeData; } };
  };
  let probe = await w.eval("decompProbeKeyBg(1, 11)");
  ck("拆图探测：整片洋红 → ok 且识别为洋红",
    probe && probe.ok === true && probe.isMagenta === true && probe.hex === "#FF00FF",
    JSON.stringify(probe));

  probeData = busy;
  probe = await w.eval("decompProbeKeyBg(1, 11)");
  ck("拆图探测：四角颜色杂乱 → ok=false（模型没照做纯色底）",
    probe && probe.ok === false && probe.spread > 24, JSON.stringify(probe));

  psMock.imaging.getPixels = async function () { throw new Error("no imaging"); };
  probe = await w.eval("decompProbeKeyBg(1, 11)");
  ck("拆图探测：读像素失败 → 返回 null（按原逻辑继续）", probe === null, String(probe));

  /* ---- 11) 主源导出：排除「输入污染层」 ---- */
  const mkDoc = function (layers, activeIds) {
    return "({ id: 1, layers: " + JSON.stringify(layers) +
      ", activeLayers: " + JSON.stringify((activeIds || []).map(function (id) { return { id: id }; })) + " })";
  };
  let h = await w.eval("hideLayersNotIn(" + mkDoc([
    { id: 21, visible: true }, { id: 22, visible: true }, { id: 23, visible: true }
  ], [21]) + ", null, [23])");
  ck("污染层：hideIds 命中且未被选中 → 隐藏", h.length === 1 && h[0] === 23, JSON.stringify(h));

  h = await w.eval("hideLayersNotIn(" + mkDoc([
    { id: 21, visible: true }, { id: 22, visible: true }, { id: 23, visible: true }
  ], [23]) + ", null, [23])");
  ck("污染层：用户选中该结果层 → 保留（有意以它为源）", h.length === 0, JSON.stringify(h));

  h = await w.eval("hideLayersNotIn(" + mkDoc([
    { id: 21, visible: true }, { id: 22, visible: true }, { id: 23, visible: true }
  ], [21]) + ", [21, 22], [])");
  ck("污染层：并发任务新写入的层仍按 keep 隐藏", h.length === 1 && h[0] === 23, JSON.stringify(h));

  h = await w.eval("hideLayersNotIn(" + mkDoc([{ id: 21, visible: true }], [21]) + ", [], [])");
  ck("污染层：没有 keep 也没有 hideIds 时不碰图层", h.length === 0, JSON.stringify(h));

  w.eval("markPluginResultLayer(301); markPluginResultLayer(301); markPluginResultLayer(302)");
  ck("污染层：结果层登记去重且按顺序",
    JSON.stringify(w.eval("pluginResultLayerIds()")) === JSON.stringify([301, 302]),
    JSON.stringify(w.eval("pluginResultLayerIds()")));

  /* ---- 12) 编辑类回贴：比例不符时 cover 而非拉伸（画布改比例后抠图不变形） ---- */
  const fc = JSON.parse(w.eval("JSON.stringify(fitCoverSize(1024, 1024, 1920, 1080))"));
  ck("cover：方图铺满 16:9 → 高度溢出、宽度正好",
    Math.round(fc.w) === 1920 && Math.round(fc.h) === 1920,
    JSON.stringify(fc));
  ck("cover：缩放后比例保持不变（不拉伸）",
    Math.abs((fc.w / fc.h) - 1) < 1e-6, (fc.w / fc.h).toFixed(4));
  const fc2 = JSON.parse(w.eval("JSON.stringify(fitCoverSize(1536, 1024, 1000, 1000))"));
  ck("cover：3:2 铺满方图 → 宽度溢出、高度正好",
    Math.round(fc2.h) === 1000 && Math.round(fc2.w) === 1500,
    JSON.stringify(fc2));
  const ct = JSON.parse(w.eval("JSON.stringify(containScale(1024, 1024, 1920, 1080))"));
  ck("contain 与 cover 互补（同一组参数一个留边、一个裁边）",
    Math.round(ct.w) === 1080 && Math.round(fc.w) === 1920,
    "contain=" + Math.round(ct.w) + " cover=" + Math.round(fc.w));

  /* ---- 13) 页面无 JS 运行时错误 ---- */
  const errs = [];
  w.addEventListener("error", (e) => errs.push(String(e.message)));
  ck("页面无 JS 运行时错误", errs.length === 0, errs.join(" | "));

  console.log("\n结果：PASS " + pass + " · FAIL " + fail);
})();

function sel(v) { return { _unit: "pixelsUnit", _value: v }; }

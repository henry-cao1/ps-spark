/*
 * test-bench.cjs — P3 基准测试链路（jsdom + 内存文件系统 + mock API）
 *
 * 覆盖：冻结画面 → 建用例 → 单模型基准 → 复测多模型 → 失败不中断 → 对比视图 → 删除用例
 *
 * 运行：
 *   NODE_PATH=<node_modules> \
 *     node bench/test-bench.cjs
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
const errors = [];
w.addEventListener("error", (e) => errors.push(String(e.message)));
w.addEventListener("unhandledrejection", (e) => errors.push("unhandled: " + String(e.reason && e.reason.message || e.reason)));

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const stub = w.document.createElement("script");
stub.textContent = [
  "const __doc = { id: 1, name: '测试.psd', width: 1080, height: 810, resolution: 72, layers: [], activeLayers: [] };",
  "window.__PNG = '" + PNG_B64 + "';",
  "window.__pngBytes = (function(){ var b = atob(__PNG), a = new Uint8Array(b.length); for (var i=0;i<b.length;i++) a[i]=b.charCodeAt(i); return a.buffer; })();",
  "window.__failNext = false;",
  /* 内存文件系统：只实现 bench 用到的方法 */
  "window.__memRoot = (function(){",
  "  function mkFolder(name, parent){",
  "    return { name:name, isFolder:true, parent:parent||null, children:{},",
  "      getEntry: async function(n){ var c=this.children[n]; if(!c) throw new Error('no entry '+n); return c; },",
  "      createFolder: async function(n){ var c=mkFolder(n,this); this.children[n]=c; return c; },",
  "      createFile: async function(n){ var c=mkFile(n,this); this.children[n]=c; return c; },",
  "      getEntries: async function(){ var a=[]; for(var k in this.children) a.push(this.children[k]); return a; },",
  "      delete: async function(){ if(this.parent) delete this.parent.children[this.name]; } };",
  "  }",
  "  function mkFile(name, parent){",
  "    return { name:name, isFolder:false, parent:parent, _data:null,",
  "      write: async function(d,o){ this._data = (o && o.format==='utf8') ? String(d) : d; },",
  "      read: async function(o){ return (o && o.format==='utf8') ? String(this._data) : this._data; },",
  "      delete: async function(){ if(this.parent) delete this.parent.children[this.name]; } };",
  "  }",
  "  return mkFolder('PluginData', null);",
  "})();",
  "const __folder = { getEntry: async function(){ throw new Error('no'); }, createFile: async function(n){ return { name:n, read:async function(){ return new ArrayBuffer(4); }, write:async function(){}, copyTo:async function(){} }; } };",
  "window.require = function (m) {",
  "  if (m === 'photoshop') return { app: { activeDocument: __doc, documents: [__doc] }, core: { executeAsModal: async function(fn){ return fn(); } }, action: { batchPlay: async function(){ return [{}]; } }, imaging: {} };",
  "  if (m === 'uxp') return { storage: { localFileSystem: { getDataFolder: async function(){ return window.__memRoot; }, getEntry: async function(){ throw new Error('no'); }, createFile: async function(n){ return { name:n, read:async function(){ return new ArrayBuffer(4); }, write:async function(){}, copyTo:async function(){} }; } }, secureStorage: { getItem: async function(){ return null; }, setItem: async function(){}, removeItem: async function(){} }, formats: { utf8:'utf8', binary:'binary' } } };",
  "  throw new Error('unknown module ' + m);",
  "};"
].join("\n");
w.document.body.appendChild(stub);

["diag.js", "services.js", "api.js", "ps.js", "registry.js", "ui.js", "store.js", "app.js", "dev/bench.js", "dev/devmode.js"].forEach(function (f) {
  const s = w.document.createElement("script");
  s.textContent = fs.readFileSync(path.join(ROOT, "js", f), "utf8");
  w.document.body.appendChild(s);
});

/* 覆盖外部副作用：导出画面 / 生成请求 / 下载 */
w.eval(`
  window.exportScopePngDataURI = async function(){ return "data:image/png;base64," + window.__PNG; };
  window.callUnifiedGenerate = async function(){ return { url: "https://mock.local/result.png" }; };
  window.callApi = async function(){ return { url: "https://mock.local/result.png" }; };
  window.xhrRequest = async function(){
    if (window.__failNext) { window.__failNext = false; throw new Error("mock 网络错误"); }
    return { status: 200, response: window.__pngBytes };
  };
`);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(fn, timeout, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 4000)) {
    try { if (fn()) return true; } catch (e) { /* ignore */ }
    await sleep(25);
  }
  throw new Error("等待超时：" + (label || "条件"));
}

function memEntry(pathArr) {
  let n = w.__memRoot;
  for (const p of pathArr) {
    n = n.children[p];
    if (!n) return null;
  }
  return n;
}

(async function () {
  const d = w.document;
  await sleep(150);

  /* 打开工作台 → 基准 Tab */
  const cb = d.getElementById("devEnabled");
  cb.checked = true;
  cb.dispatchEvent(new w.Event("change"));
  d.getElementById("btnDevOpen").dispatchEvent(new w.Event("click"));
  d.getElementById("dwTabBench").dispatchEvent(new w.Event("click"));
  ck("入口：工作台已打开", !d.getElementById("devWorkbench").classList.contains("hidden"), "");
  await waitFor(() => d.querySelectorAll("#dwRetestModels input[type=checkbox]").length === 17, 3000, "复测模型列表");
  ck("基准：模型复测列表渲染 17 项", d.querySelectorAll("#dwRetestModels input[type=checkbox]").length === 17,
    String(d.querySelectorAll("#dwRetestModels input[type=checkbox]").length));
  const checkedIds = Array.prototype.map.call(
    d.querySelectorAll("#dwRetestModels input[type=checkbox]:checked"), (c) => c.value);
  ck("基准：默认勾选 2 个非基准模型", checkedIds.length === 2 && checkedIds.indexOf("gpt-image-2") < 0,
    checkedIds.join(","));
  ck("基准：初始无结果", d.querySelectorAll("#dwRuns .dw-run").length === 0, "");
  ck("基准：初始无用例", !w.Bench.current(), "");

  /* 冻结并运行基准 */
  ck("冻结：按钮可用", d.getElementById("dwFreeze").disabled === false, "");
  d.getElementById("dwFreeze").dispatchEvent(new w.Event("click"));
  await waitFor(() => w.Bench.runs().length >= 1, 5000, "第一次运行结果");
  ck("冻结：用例已创建", !!w.Bench.current(), w.Bench.current() ? w.Bench.current().id : "");
  ck("冻结：结果卡 1 张", d.querySelectorAll("#dwRuns .dw-run").length === 1,
    String(d.querySelectorAll("#dwRuns .dw-run").length));
  const c0 = w.Bench.current();
  ck("冻结：提示词已保存", !!c0 && c0.prompt.length > 10, c0 ? String(c0.prompt.length) + " 字" : "");
  ck("冻结：输入尺寸已记录", !!c0 && c0.source.width === 1 && c0.source.height === 1,
    c0 ? c0.source.width + "x" + c0.source.height : "");
  ck("冻结：首个结果自动成为基准", w.Bench.runs()[0].isBaseline === true, "");

  /* 文件落盘 */
  const root = ["dev", "bench"];
  const indexFile = memEntry(root.concat(["index.json"]));
  ck("落盘：index.json 存在", !!indexFile, "");
  const indexArr = indexFile ? JSON.parse(indexFile._data) : [];
  ck("落盘：索引含 1 个用例", indexArr.length === 1, String(indexArr.length));
  const caseDir = memEntry(root.concat(["cases", c0.id]));
  ck("落盘：case.json 存在", !!(caseDir && caseDir.children["case.json"]), "");
  ck("落盘：input.png 存在", !!(caseDir && caseDir.children["input.png"]), "");
  const runDirs = caseDir && caseDir.children.runs ? Object.keys(caseDir.children.runs.children) : [];
  ck("落盘：runs 目录含 1 次运行", runDirs.length === 1, String(runDirs.length));
  const run0 = caseDir && caseDir.children.runs ? caseDir.children.runs.children[runDirs[0]] : null;
  ck("落盘：meta.json + output.png", !!(run0 && run0.children["meta.json"] && run0.children["output.png"]), "");

  /* 复测：默认已勾选 2 个非基准模型 */
  ck("复测：按钮计数为 2", /图像 ×2/.test(d.getElementById("dwRetest").textContent),
    d.getElementById("dwRetest").textContent);
  d.getElementById("dwRetest").dispatchEvent(new w.Event("click"));
  await waitFor(() => w.Bench.runs().length >= 3, 8000, "复测结果");
  ck("复测：结果累计 3 张", w.Bench.runs().length === 3, String(w.Bench.runs().length));
  const models = w.Bench.runs().map((r) => r.model);
  ck("复测：模型互不重复", new Set(models).size === 3, models.join(","));

  /* 失败不中断：让下一次下载抛错，另一个模型仍应成功 */
  w.__failNext = true;
  const n0 = w.Bench.runs().length;
  d.getElementById("dwRetest").dispatchEvent(new w.Event("click"));
  await waitFor(() => w.Bench.runs().length >= n0 + 2, 8000, "失败批次");
  const added = w.Bench.runs().slice(n0);
  const failed = added.filter((r) => r.status === "error");
  const okd = added.filter((r) => r.status === "ok");
  ck("失败：记录为 error", failed.length === 1, failed.map((r) => r.error).join(" | "));
  ck("失败：错误原文保留", failed.length === 1 && /mock 网络错误/.test(String(failed[0].error || "")),
    failed.length ? String(failed[0].error) : "");
  ck("失败：同批其他模型继续成功", okd.length >= 1, String(okd.length));

  /* 对比视图 */
  d.querySelectorAll("#dwRuns .dw-run")[0].dispatchEvent(new w.Event("click"));
  await sleep(120);
  ck("对比：视图已打开", !!d.getElementById("bcWrap"), "");
  ck("对比：两张图都有 src", !!(d.getElementById("bcImgA").getAttribute("src") || "").startsWith("data:image/png"),
    (d.getElementById("bcImgA").getAttribute("src") || "").slice(0, 22));
  ck("对比：标题显示模型", /当前/.test(d.getElementById("bcCapA").textContent),
    d.getElementById("bcCapA").textContent.slice(0, 40));
  const stars = d.querySelectorAll("#bcFoot .bc-star");
  ck("对比：评分按钮 5 个", stars.length === 5, String(stars.length));
  stars[3].dispatchEvent(new w.Event("click"));
  await waitFor(() => {
    const rs = w.Bench.runs();
    return rs[rs.length - 1].rating === 4;
  }, 2000, "评分写入");
  ck("对比：评分写入 meta", w.Bench.runs()[w.Bench.runs().length - 1].rating === 4,
    String(w.Bench.runs()[w.Bench.runs().length - 1].rating));
  d.getElementById("bcModeSingle").dispatchEvent(new w.Event("click"));
  ck("对比：单图模式隐藏基准栏", d.getElementById("bcPaneB").classList.contains("hidden"), "");
  d.getElementById("bcBack").dispatchEvent(new w.Event("click"));
  ck("对比：返回后移除", !d.getElementById("bcWrap"), "");

  /* 删除用例 */
  d.getElementById("dwCaseDel").dispatchEvent(new w.Event("click"));
  await waitFor(() => w.Bench.index().length === 0, 3000, "删除用例");
  ck("删除：索引清空", w.Bench.index().length === 0, "");
  ck("删除：用例目录移除", !memEntry(root.concat(["cases", c0.id])), "");
  ck("删除：当前用例为空", !w.Bench.current(), "");

  /* 多输入：选区蒙版 + 拼合资产 */
  const dataUri = "data:image/png;base64," + PNG_B64;
  await w.Bench.newCase({
    instId: "local_redraw",
    instName: "局部重绘",
    branchId: "default",
    branchLabel: "默认",
    prompt: "只修改蒙版内的区域",
    params: { size: "auto" },
    dataUri: dataUri,
    maskUri: dataUri,
    assets: [dataUri],
    warnings: ["测试警告"]
  });
  const cMulti = w.Bench.current();
  ck("多输入：case.inputs 记录 mask 与 assets",
    !!(cMulti && cMulti.inputs && cMulti.inputs.mask && cMulti.inputs.assets.length === 1),
    cMulti ? JSON.stringify(cMulti.inputs) : "");
  const multiDir = memEntry(["dev", "bench", "cases", cMulti.id]);
  ck("多输入：mask 文件落盘", !!(multiDir && multiDir.children["mask.png"]), "");
  ck("多输入：assets 目录与文件",
    !!(multiDir && multiDir.children.assets && multiDir.children.assets.children["asset_1.png"]), "");
  ck("多输入：warnings 写入 case", !!(cMulti && cMulti.warnings && cMulti.warnings.length === 1), "");

  let captured = null;
  w.callApi = async function (path, payload, multipart) {
    captured = { path: path, payload: payload, multipart: multipart };
    return { url: "https://mock.local/result.png" };
  };
  await w.Bench.runOne("gpt-image-2", {});
  ck("多输入：编辑类走 edits 并带 mask",
    !!(captured && captured.path === "/v1/images/edits" && captured.payload.mask),
    captured ? captured.path : "no call");
  ck("多输入：mask 是 data URI",
    !!(captured && String(captured.payload.mask).indexOf("data:image/") === 0), "");

  /* 清除全部开发数据 */
  await w.Bench.clearAll();
  ck("清除：bench 目录已移除", !memEntry(root), "");
  ck("清除：索引已清空", w.Bench.index().length === 0, "");

  ck("页面无 JS 运行时错误", errors.length === 0, errors.join(" | "));

  console.log("\n结果：PASS " + pass + " · FAIL " + fail);
  process.exit(process.exitCode || 0);
})().catch(function (e) {
  console.log("FAIL | 测试异常 -> " + (e && e.stack || e));
  process.exit(1);
});

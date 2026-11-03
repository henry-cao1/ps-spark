/*
 * test-queue.cjs — 生图任务队列冒烟测试（jsdom）
 *
 * 覆盖：连点入队 / 快照不漂移 / 槽位放行 / 失败标记 / 等待中取消 / 运行中取消 / 编辑域选区通道
 * 运行：
 *   NODE_PATH=<node_modules> \
 *     node bench/test-queue.cjs
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
  .replace(/<script src="[^"]+"><\/script>/g, "");
const dom = new JSDOM(html, { runScripts: "dangerously", url: "http://localhost/", pretendToBeVisual: true });
const w = dom.window;
const errors = [];
w.addEventListener("error", (e) => errors.push(String(e.message)));

const stub = w.document.createElement("script");
stub.textContent = [
  "const __doc = { id: 1, name: 't.psd', width: 1080, height: 810, resolution: 72, layers: [], activeLayers: [] };",
  "window.require = function (m) {",
  "  if (m === 'photoshop') return { app: { activeDocument: __doc, documents: [__doc] }, core: { executeAsModal: async function(fn){ return fn(); } }, action: { batchPlay: async function(){ return [{}]; } }, imaging: {} };",
  "  if (m === 'uxp') return { storage: { localFileSystem: { getEntry: async function(){ throw new Error('no'); }, createFile: async function(n){ return { name:n, write:async function(){} }; } }, secureStorage: { getItem: async function(){ return null; }, setItem: async function(){}, removeItem: async function(){} }, formats: { utf8:'utf8', binary:'binary' } } };",
  "  throw new Error('unknown module ' + m);",
  "};"
].join("\n");
w.document.body.appendChild(stub);

["diag.js", "services.js", "api.js", "ps.js", "registry.js", "ui.js", "store.js", "app.js"].forEach(function (f) {
  const s = w.document.createElement("script");
  s.textContent = fs.readFileSync(path.join(ROOT, "js", f), "utf8");
  w.document.body.appendChild(s);
});

(async function () {
  await sleep(150);
  ck("页面加载无错误", errors.length === 0, errors.slice(0, 2).join(" | "));

  /* 固定当前实例为文生图，并准备一个可逐条放行的运行桩 */
  w.eval("App.tab='gen'; App.genInstance='text2img'; renderGenView();");
  const calls = [];
  const resolvers = new Map();
  let aborted = 0;
  let nextOk = true;

  w.runCurrentInstance = async function (opts) {
    calls.push(opts.instId);
    const t = opts.task;
    await new Promise(function (r) { resolvers.set(t.id, r); });
    return { ok: nextOk, task: t, docId: 1, cands: null, cancelled: false };
  };
  w.abortRun = function () { aborted++; };
  w.abortAllRequests = function () { aborted++; };

  const enqueue = async (text) => {
    w.eval('getInstanceState("text2img").userText = ' + JSON.stringify(text));
    return await w.enqueueCurrentRun();
  };
  const resolveTask = (t) => { const r = resolvers.get(t.id); if (r) { resolvers.delete(t.id); r(); } };
  const st = () => w.eval("TASKQ.list.map(function(t){return t.status;}).join(',')");

  /* 1) 连点三次：云端 2 路并发 → 两条在跑、一条等待 */
  const t1 = await enqueue("任务一");
  const t2 = await enqueue("任务二");
  const t3 = await enqueue("任务三");
  await sleep(60);
  ck("入队：连点三次不丢任务", w.eval("TASKQ.list.length") === 3, String(w.eval("TASKQ.list.length")));
  ck("入队：云端放行 2 条，其余等待", st() === "run,run,wait", st());
  ck("入队：界面出现队列条", !w.document.getElementById("queueWrap").classList.contains("hidden"), "");

  /* 2) 快照不随 UI 漂移 */
  ck("快照：保存入队时的提示词", t1.snap.userText === "任务一", t1.snap.userText);
  ck("快照：不同任务各自独立", t2.snap.userText === "任务二", t2.snap.userText);

  /* 3) 放行一条 → 空出的槽位立刻补上第三条 */
  resolveTask(t1);
  await sleep(120);
  ck("调度：完成后槽位补位", st() === "ok,run,run", st());
  ck("调度：按入队顺序启动", calls.join(",") === "text2img,text2img,text2img", calls.length + " 次");

  /* 4) 取消一条等待中的任务（第三条正在跑，改取消另外排队的） */
  const t4 = await enqueue("任务四");
  await sleep(30);
  w.taskCancel(t4.id);
  await sleep(20);
  ck("取消：等待中的直接标为已取消",
    w.eval('TASKQ.list.filter(function(t){return t.id==="' + t4.id + '";})[0].status') === "cancel", st());

  /* 5) 运行中取消：还有两条在跑 → 不 abort 别人的请求 */
  w.taskCancel(t3.id);
  await sleep(60);
  ck("取消：并发运行时不误伤另一条请求", aborted === 0, String(aborted));
  ck("取消：运行中被标为已取消",
    w.eval('TASKQ.list.filter(function(t){return t.id==="' + t3.id + '";})[0].status') === "cancel", st());

  /* 6) 只剩一条在跑时取消 → 真中断 */
  resolveTask(t2);
  await sleep(120);
  const t5 = await enqueue("最后一条");
  await sleep(30);
  w.taskCancel(t5.id);
  await sleep(30);
  ck("取消：单条运行时会中断请求", aborted === 1, String(aborted));

  /* 7) 失败任务标 err（不中断后续） */
  nextOk = false;
  const f1 = await enqueue("会失败");
  await sleep(40);
  resolveTask(f1);
  await sleep(120);
  const fTask = w.eval('TASKQ.list.filter(function(t){return t.id==="' + f1.id + '";})[0]');
  ck("失败：标记为 err 并带原因", fTask.status === "err" && !!fTask.error, fTask.status + " / " + (fTask.error || ""));
  nextOk = true;

  /* 8) 编辑域：入队时把选区存通道，执行前还原 */
  w.eval("App.tab='edit'; App.editInstance='local_redraw'; renderEditView(); getInstanceState('local_redraw').userText='把杯子换成陶瓷';");
  const restored = [], dropped = [];
  w.captureQueueSelection = function (t) { return Promise.resolve("pssparkQ" + t.id); };
  w.loadSelectionFromChannel = async function (n) { restored.push(n); };
  w.execModal = async function (fn) { return fn(); };
  w.batchPlay = async function (d) {
    const del = JSON.stringify(d);
    if (del.indexOf("\"_obj\":\"delete\"") >= 0) dropped.push(del.match(/pssparkQ\w+/)[0]);
    return [{}];
  };
  const e1 = await w.enqueueCurrentRun();
  await sleep(80);
  ck("编辑域：任务带域名与文档 id", e1 && e1.domain === "edit" && e1.docId === 1, e1 ? e1.domain + "/" + e1.docId : "无");
  ck("编辑域：执行前还原了选区通道", restored.indexOf("pssparkQ" + e1.id) >= 0, restored.join(","));
  resolveTask(e1);
  await sleep(160);
  ck("编辑域：执行后会清理通道", dropped.indexOf("pssparkQ" + e1.id) >= 0, dropped.join(","));
  ck("编辑域：任务正常完成", w.eval('TASKQ.list.filter(function(t){return t.id==="' + e1.id + '";})[0].status') === "ok", "");

  /* 8b) 入队快照：图层清单 + 导出时临时隐藏「之后新增的图层」 */
  w.eval('__doc.layers = [{ id: 11, name: "bg", visible: true, layers: [] }]; __doc.activeLayers = [];');
  const q1 = await w.enqueueCurrentRun();
  ck("队列：入队时记录当时的图层清单", !!q1.layerIds && q1.layerIds.indexOf(11) >= 0, JSON.stringify(q1.layerIds));
  w.eval('__doc.layers.push({ id: 22, name: "AI 结果", visible: true, layers: [] });');
  const hid = await w.hideLayersNotIn(w.eval("__doc"), q1.layerIds);
  ck("导出：入队后新增的图层被临时隐藏",
    hid.indexOf(22) >= 0 && w.eval("__doc.layers[1].visible") === false, JSON.stringify(hid));
  await w.restoreLayerVisibility(w.eval("__doc"), hid);
  ck("导出：隐藏过的图层会恢复可见", w.eval("__doc.layers[1].visible") === true, "");
  resolveTask(q1);
  await sleep(60);

  /* 8c) 编辑域槽位：无选区可并发；有选区独占 */
  w.getSelectionBounds = async function () { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }; };
  const q2 = await w.enqueueCurrentRun();
  ck("槽位：带选区的编辑任务独占（edit）", q2.slot === "edit", q2.slot + " hasSel=" + q2.hasSel);
  resolveTask(q2);
  await sleep(40);
  w.getSelectionBounds = async function () { return null; };
  const q3 = await w.enqueueCurrentRun();
  ck("槽位：整幅画面的编辑任务可并发（不占 edit 槽）", q3.slot !== "edit", q3.slot + " hasSel=" + q3.hasSel);
  resolveTask(q3);
  await sleep(40);

  /* 9) 运行中按钮仍可点：追加任务不能被禁用 */
  w.eval("App.tab='gen'; App.genInstance='text2img'; renderGenView(); running = true;");
  await w.eval("UI.refreshRunBar(document.getElementById('genHost'), instById('text2img'))");
  const rb = w.document.querySelector("#genHost .run-btn");
  ck("UI：运行中按钮不禁用", !!rb && rb.disabled === false, rb ? String(rb.disabled) : "没有按钮");
  ck("UI：运行中按钮改为「加入队列」", !!rb && rb.textContent.indexOf("加入队列") >= 0, rb ? rb.textContent : "");
  w.eval("running = false;");

  /* 10) 清空已完成，只留活动任务 */
  w.taskClearDone();
  const left = w.eval("TASKQ.list.map(function(t){return t.status;}).join(',')");
  ck("清空：只保留等待/运行中的", /^[waitrun,]*$/.test(left), left);

  ck("页面无 JS 运行时错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  console.log("\n结果：PASS " + pass + " · FAIL " + fail);
  process.exit(process.exitCode || 0);
})().catch(function (e) {
  console.log("FAIL | 测试异常 -> " + (e && e.stack || e));
  process.exit(1);
});

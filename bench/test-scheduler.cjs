/*
 * test-scheduler.cjs — 队列调度器测试（jsdom）
 *
 * 覆盖：
 *   1) 云端并发上限 2 路
 *   2) 本地 ComfyUI 串行（同时只跑 1 条）
 *   3) 落图严格按入队顺序（生成乱序完成也不影响写入顺序）
 *   4) 单条取消：并发的另一条不被 abort，取消的那条不落图
 *   5) 取消最后一条时才中断在途请求
 *
 * 运行：
 *   NODE_PATH=<node_modules> \
 *     node bench/test-scheduler.cjs
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
async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 2000)) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}

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

const statuses = () => w.eval("TASKQ.list.map(function(t){return t.status;}).join(',')");
const statusOf = (id) => w.eval('(TASKQ.list.filter(function(t){return t.id==="' + id + '";})[0]||{}).status');
const tail = (n) => w.eval("TASKQ.list.slice(-" + n + ").map(function(t){return t.status;}).join(',')");

(async function () {
  await sleep(150);
  ck("页面加载无错误", errors.length === 0, errors.slice(0, 2).join(" | "));

  w.eval("App.tab='gen'; App.genInstance='text2img'; renderGenView();");

  /* ---- 用桩替换真实生成：按入队顺序取延迟 + 真实落图闸门 ---- */
  const delays = [];
  let genCloud = 0, genLocal = 0, maxCloud = 0, maxLocal = 0;
  let aborts = 0;
  const placed = [];
  let localMode = false;

  w.resolveModel = function () { return localMode ? "comfy:test" : "nano-banana-2"; };
  w.abortRun = function () { aborts++; };
  w.abortAllRequests = function () { aborts++; };

  w.runCurrentInstance = async function (opts) {
    const t = opts.task;
    const run = { id: "r-" + t.id, instId: opts.instId, task: t, ok: true, cands: null, docId: 1 };
    if (t.slot === "local") { genLocal++; maxLocal = Math.max(maxLocal, genLocal); }
    else { genCloud++; maxCloud = Math.max(maxCloud, genCloud); }
    await sleep(delays.length ? delays.shift() : 150);
    if (t.slot === "local") genLocal--; else genCloud--;
    if (t.cancelled) { run.ok = false; run.cancelled = true; return run; }
    /* 落图阶段：走真实闸门，顺序由此决定 */
    await w.waitPlaceTurn(run);
    placed.push(t.id);
    return run;
  };

  const enqueue = async (text, delay) => {
    if (delay != null) delays.push(delay);
    w.eval('getInstanceState("text2img").userText = ' + JSON.stringify(text));
    return await w.enqueueCurrentRun();
  };

  /* 1) 云端并发上限 2：三条一起入队，应当 2 跑 1 等 */
  const c1 = await enqueue("云端一", 260);
  const c2 = await enqueue("云端二", 260);
  const c3 = await enqueue("云端三", 260);
  await sleep(30);
  ck("并发：云端同时最多 2 路", tail(3) === "run,run,wait", tail(3));
  ck("并发：第三条在排队", statusOf(c3.id) === "wait", statusOf(c3.id));
  await until(() => tail(3) === "ok,ok,ok");
  ck("并发：三条全部完成", tail(3) === "ok,ok,ok", tail(3));
  ck("并发：实测峰值不超过 2", maxCloud <= 2, "峰值 " + maxCloud);
  ck("并发：确实并发过（峰值 2）", maxCloud === 2, "峰值 " + maxCloud);

  /* 2) 落图顺序 = 入队顺序（故意让第 1 条最慢、第 3 条最快） */
  placed.length = 0;
  const d1 = await enqueue("慢", 300);
  const d2 = await enqueue("中", 120);
  const d3 = await enqueue("快", 40);
  await sleep(80);
  ck("顺序：生成阶段确实并发", w.eval("TASKQ.list.filter(function(t){return t.status==='run';}).length") === 2,
    statuses());
  await until(() => tail(3) === "ok,ok,ok");
  ck("顺序：三条都完成", tail(3) === "ok,ok,ok", tail(3));
  ck("顺序：落图按入队顺序，不被快慢带偏",
    placed.join(",") === [d1.id, d2.id, d3.id].join(","),
    placed.join(",") + " 期望 " + [d1.id, d2.id, d3.id].join(","));

  /* 3) 本地 ComfyUI 串行：三条同时只跑 1 条 */
  localMode = true;
  maxLocal = 0; genLocal = 0;
  const l1 = await enqueue("本地一", 120);
  const l2 = await enqueue("本地二", 120);
  const l3 = await enqueue("本地三", 120);
  await sleep(30);
  ck("本地：同时只跑 1 条", tail(3) === "run,wait,wait", tail(3));
  ck("本地：被识别为 local 槽位", l1.slot === "local", l1.slot);
  await until(() => tail(3) === "ok,ok,ok");
  ck("本地：串行跑完三条", tail(3) === "ok,ok,ok", tail(3));
  ck("本地：实测峰值 1", maxLocal === 1, "峰值 " + maxLocal);

  /* 4) 并发时取消其中一条：不打断另一条，被取消的不落图 */
  localMode = false;
  placed.length = 0;
  aborts = 0;
  const x1 = await enqueue("取消我", 400);
  const x2 = await enqueue("别打断我", 400);
  await sleep(40);
  w.taskCancel(x1.id);
  await sleep(20);
  ck("取消：并发时立刻标记为已取消", statusOf(x1.id) === "cancel", statusOf(x1.id));
  ck("取消：并发时不 abort 在途请求（会误伤另一条）", aborts === 0, "abort " + aborts + " 次");
  await until(() => statusOf(x2.id) === "ok");
  ck("取消：另一条正常完成", statusOf(x2.id) === "ok", statusOf(x2.id));
  ck("取消：被取消的那条不落图", placed.indexOf(x1.id) < 0, placed.join(","));
  ck("取消：另一条正常落图", placed.indexOf(x2.id) >= 0, placed.join(","));

  /* 5) 只剩一条在跑时取消：应中断在途请求 */
  aborts = 0;
  placed.length = 0;
  const y1 = await enqueue("独立取消", 400);
  await sleep(40);
  w.taskCancel(y1.id);
  await sleep(30);
  ck("取消：单条运行时才真中断请求", aborts === 1, "abort " + aborts + " 次");
  ck("取消：单条取消后不落图", placed.indexOf(y1.id) < 0, placed.join(","));

  /* 6) 槽位腾出后后续任务继续 */
  const z1 = await enqueue("收尾", 40);
  await until(() => statusOf(z1.id) === "ok");
  ck("收尾：取消后队列仍能继续", statusOf(z1.id) === "ok", statuses());

  ck("页面无 JS 运行时错误", errors.length === 0, errors.slice(0, 3).join(" | "));
  console.log("\n结果：PASS " + pass + " · FAIL " + fail);
  process.exit(process.exitCode || 0);
})().catch(function (e) {
  console.log("FAIL | 测试异常 -> " + (e && e.stack || e));
  process.exit(1);
});

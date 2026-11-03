/*
 * test-web.mjs — Web 测试台 API 冒烟测试
 *
 * 启动一个只读临时数据目录上的服务，验证：
 *   状态 / 用例列表 / 详情 / 图片 / 打分 / 基准 / 运行错误路径 / 删除 / 静态页
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = 7819;
const DATA = path.join(os.tmpdir(), "ps-spark-bench-webtest");
const CFG = path.join(os.tmpdir(), "ps-spark-bench-webcfg.json");

let pass = 0, fail = 0;
function ck(name, ok, detail) {
  if (ok) { pass++; console.log("PASS | " + name + (detail ? " -> " + detail : "")); }
  else { fail++; process.exitCode = 1; console.log("FAIL | " + name + (detail ? " -> " + detail : "")); }
}

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeFixture() {
  fs.rmSync(DATA, { recursive: true, force: true });
  const dir = path.join(DATA, "cases", "demo1");
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.mkdirSync(path.join(dir, "runs", "r1"), { recursive: true });
  const png = Buffer.from(PNG_B64, "base64");
  for (const f of ["input.png", "mask.png", "assets/asset_1.png", "runs/r1/output.png"]) {
    fs.writeFileSync(path.join(dir, f), png);
  }
  fs.writeFileSync(path.join(dir, "case.json"), JSON.stringify({
    schema: 1, id: "demo1", instId: "local_redraw", instName: "局部重绘",
    branch: "default", branchLabel: "默认", title: "局部重绘 · 默认",
    createdAt: "2026-10-19T01:50:00.000Z", prompt: "只修改蒙版内的区域", promptHash: "abcd1234",
    params: { size: "auto", quality: "auto" },
    source: { kind: "canvas", width: 1, height: 1, bytes: 68 },
    inputs: { input: "input.png", mask: "mask.png", assets: ["asset_1.png"] },
    warnings: ["测试警告"], baselineRunId: "r1"
  }, null, 1));
  fs.writeFileSync(path.join(dir, "runs", "r1", "meta.json"), JSON.stringify({
    runId: "r1", model: "gpt-image-2", status: "ok", isBaseline: true,
    createdAt: "2026-10-19T01:51:00.000Z", latencyMs: 34100, width: 1, height: 1,
    bytes: 68, rating: null, note: ""
  }, null, 1));
  fs.writeFileSync(path.join(DATA, "index.json"), JSON.stringify([{
    id: "demo1", title: "局部重绘 · 默认", instName: "局部重绘",
    createdAt: "2026-10-19T01:50:00.000Z", runCount: 1, lastRunAt: "2026-10-19T01:51:00.000Z", baselineRunId: "r1"
  }], null, 1));
}

async function j(pathname, opts) {
  const res = await fetch("http://127.0.0.1:" + PORT + pathname, opts);
  let body = null;
  try { body = await res.json(); } catch (e) { body = null; }
  return { status: res.status, body };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await j("/api/health");
      if (r.status === 200) return true;
    } catch (e) { /* retry */ }
    await sleep(100);
  }
  return false;
}

makeFixture();

/* 独立配置文件：不动用户的 bench/config.json */
let tmpCfg = { providers: { grsai: { baseUrl: "https://grsai.dakka.com.cn", apiKey: "" } }, models: [], timeoutSec: 5 };
try {
  const real = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));
  tmpCfg = real;
  tmpCfg.providers = tmpCfg.providers || {};
  tmpCfg.providers.grsai = tmpCfg.providers.grsai || {};
  tmpCfg.providers.grsai.apiKey = "";
} catch (e) { /* 用默认 */ }
fs.writeFileSync(CFG, JSON.stringify(tmpCfg, null, 1));

const child = spawn(process.execPath, [path.join(HERE, "web-server.mjs"), "--port", String(PORT), "--data", DATA, "--config", CFG], {
  cwd: HERE,
  stdio: ["ignore", "pipe", "pipe"],
  env: Object.assign({}, process.env, { GRSAI_API_KEY: "" })
});
let serverLog = "";
child.stdout.on("data", (d) => { serverLog += String(d); });
child.stderr.on("data", (d) => { serverLog += String(d); });

try {
  const up = await waitServer();
  ck("服务：启动并响应健康检查", up, serverLog.slice(0, 120));
  if (!up) throw new Error("服务未启动");

  const state = await j("/api/state");
  ck("状态：返回数据目录", state.body && state.body.dataDir === DATA, state.body ? state.body.dataDir : "");
  ck("状态：Key 未配置时 keyReady=false", state.body && state.body.keyReady === false, "");
  ck("状态：模型目录 17 个（16 云端 + 1 本地预设）", state.body && state.body.models.length === 17, String(state.body && state.body.models.length));
  ck("状态：本地预设按 comfy:<id> 命名", state.body && state.body.models.some((m) => m.id.indexOf("comfy:") === 0),
    (state.body && state.body.models.filter((m) => m.id.indexOf("comfy") === 0).map((m) => m.id).join(",")) || "");
  ck("状态：用例 1 个", state.body && state.body.cases.length === 1, "");

  const detail = await j("/api/cases/demo1");
  ck("详情：提示词完整", detail.body && detail.body.case.prompt === "只修改蒙版内的区域", "");
  ck("详情：maskUrl 存在", detail.body && !!detail.body.maskUrl, "");
  ck("详情：资产 1 个", detail.body && detail.body.assets.length === 1, "");
  ck("详情：warnings 透传", detail.body && detail.body.case.warnings.length === 1, "");
  ck("详情：结果 1 条", detail.body && detail.body.runs.length === 1, "");
  ck("详情：comfy 能力闸门拒绝带蒙版/资产的用例",
    detail.body && detail.body.comfy && detail.body.comfy.ok === false && /未声明/.test(detail.body.comfy.reason || ""),
    detail.body && detail.body.comfy ? detail.body.comfy.reason : "");
  ck("详情：返回每个本地预设的可用性",
    detail.body && detail.body.comfy && Array.isArray(detail.body.comfy.presets) && detail.body.comfy.presets.length === 1
      && detail.body.comfy.presets[0].ok === false, "");

  /* 文生图用例：comfy 应放行 */
  const genDir = path.join(DATA, "cases", "gen1");
  fs.mkdirSync(genDir, { recursive: true });
  fs.writeFileSync(path.join(genDir, "input.png"), Buffer.from(PNG_B64, "base64"));
  fs.writeFileSync(path.join(genDir, "case.json"), JSON.stringify({
    schema: 1, id: "gen1", instId: "text2img", instName: "文生图",
    branch: "default", branchLabel: "默认", title: "文生图 · 默认",
    createdAt: "2026-10-19T01:50:00.000Z", prompt: "一只雪地里的赤狐", promptHash: "gen11111",
    params: { size: "1024x1024" }, source: { kind: "canvas", width: 1, height: 1, bytes: 68 },
    inputs: { input: "input.png", mask: null, assets: [] }, warnings: []
  }, null, 1));
  const genDetail = await j("/api/cases/gen1");
  ck("详情：文生图用例放行 comfy", genDetail.body && genDetail.body.comfy && genDetail.body.comfy.ok === true,
    genDetail.body && genDetail.body.comfy ? String(genDetail.body.comfy.reason) : "");
  fs.rmSync(genDir, { recursive: true, force: true });

  const comfyRun = await j("/api/cases/demo1/run", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ models: ["comfy"] })
  });
  ck("运行：comfy 在不支持的用例上直接 400 说明原因",
    comfyRun.status === 400 && /未声明/.test((comfyRun.body && comfyRun.body.error) || ""),
    String(comfyRun.status) + " " + ((comfyRun.body && comfyRun.body.error) || ""));

  const img = await fetch("http://127.0.0.1:" + PORT + "/api/cases/demo1/file?name=input");
  ck("图片：输入 200 + png", img.status === 200 && img.headers.get("content-type") === "image/png", String(img.status));
  const mask = await fetch("http://127.0.0.1:" + PORT + "/api/cases/demo1/file?name=mask");
  ck("图片：蒙版可读", mask.status === 200, String(mask.status));
  const out = await fetch("http://127.0.0.1:" + PORT + "/api/cases/demo1/runs/r1/image");
  ck("图片：结果可读", out.status === 200, String(out.status));

  /* 打分 / 备注 */
  const rate = await j("/api/cases/demo1/runs/r1/rating", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rating: 4, note: "边缘自然" })
  });
  ck("打分：接口返回新值", rate.body && rate.body.rating === 4, String(rate.body && rate.body.rating));
  const metaAfter = JSON.parse(fs.readFileSync(path.join(DATA, "cases", "demo1", "runs", "r1", "meta.json"), "utf8"));
  ck("打分：写回 meta.json", metaAfter.rating === 4 && metaAfter.note === "边缘自然", "");

  /* 基准切换（指向不存在的结果应 404） */
  const badBase = await j("/api/cases/demo1/runs/nope/baseline", { method: "POST" });
  ck("基准：不存在的结果返回 404", badBase.status === 404, String(badBase.status));

  /* 运行：没有 Key 时应进入 error，而不是挂住 */
  const run = await j("/api/cases/demo1/run", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ models: ["gpt-image-2"] })
  });
  ck("运行：创建任务", run.status === 200 && !!run.body.jobId, run.body ? run.body.jobId : "");
  let job = null;
  for (let i = 0; i < 30; i++) {
    const r = await j("/api/jobs/" + encodeURIComponent(run.body.jobId));
    job = r.body;
    if (job && job.status !== "running") break;
    await sleep(100);
  }
  ck("运行：无 Key 明确报错", job && job.status === "error" && /API Key/.test(job.error || ""), job ? job.error : "");

  /* Key 保存接口（测试结束会恢复 config.json） */
  const saveKey = await j("/api/config/key", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey: "test-key-not-real" })
  });
  ck("Key：保存接口成功", saveKey.status === 200 && saveKey.body.keyReady === true, String(saveKey.status));
  const cfgNow = JSON.parse(fs.readFileSync(CFG, "utf8"));
  ck("Key：写入 config.json", cfgNow.providers.grsai.apiKey === "test-key-not-real", "");
  const state3 = await j("/api/state");
  ck("Key：状态同步为已配置", state3.body && state3.body.keyReady === true, "");

  /* 静态页 */
  const page = await fetch("http://127.0.0.1:" + PORT + "/");
  const html = await page.text();
  ck("静态页：返回 HTML", page.status === 200 && html.indexOf("PS Spark 模型测试台") >= 0, String(page.status));
  const css = await fetch("http://127.0.0.1:" + PORT + "/style.css");
  ck("静态页：CSS 可读", css.status === 200, String(css.status));

  /* 提示词包 → 批量建用例（不用在 PS 里一条条冻结） */
  const packText = [
    "[A1 单物]",
    "输入：一只橘猫坐在木窗台上，午后侧光。",
    "判定：□ 只有一只猫 □ 在窗台",
    "",
    "[A2 双物]",
    "输入：左边一个红杯子，右边一本蓝书。",
    "判定：□ 杯子在左"
  ].join("\n");
  const pack = await j("/api/cases/import-pack", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: packText, size: "512x512", pack: "t.txt" })
  });
  ck("提示词包：批量建用例", pack.status === 200 && pack.body.created === 2, String(pack.body && pack.body.created));
  const pc1 = await j("/api/cases/" + pack.body.cases[0].id);
  ck("提示词包：标题与提示词正确",
    pc1.body && pc1.body.case.prompt === "一只橘猫坐在木窗台上，午后侧光。" && /A1/.test(pc1.body.case.title),
    pc1.body ? pc1.body.case.title : "");
  const pImg = await fetch("http://127.0.0.1:" + PORT + "/api/cases/" + pack.body.cases[0].id + "/file?name=input");
  const pBuf = Buffer.from(await pImg.arrayBuffer());
  ck("提示词包：生成白底画布 PNG", pImg.status === 200 && pBuf[0] === 0x89 && pBuf.length > 200,
    pImg.status + " " + pBuf.length + "B");
  const packDup = await j("/api/cases/import-pack", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: packText, size: "512x512" })
  });
  ck("提示词包：重复导入自动跳过", packDup.body && packDup.body.created === 0 && packDup.body.skipped === 2,
    "created=" + (packDup.body && packDup.body.created) + " skipped=" + (packDup.body && packDup.body.skipped));
  for (const pc of pack.body.cases) await j("/api/cases/" + pc.id, { method: "DELETE" });

  /* 用例包：导出 → 导入（跨机跑同一份用例的前提） */
  const expRes = await fetch("http://127.0.0.1:" + PORT + "/api/cases/demo1/export");
  const bundle = await expRes.json();
  ck("用例包：导出含输入图与提示词",
    expRes.status === 200 && bundle.schema === "ps-spark-case-bundle" && !!bundle.input.b64 && !!bundle.case.prompt,
    String(expRes.status) + " " + (bundle.input ? Math.round(String(bundle.input.b64).length / 1024) + "KB" : ""));
  const impRes = await j("/api/cases/import", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(bundle)
  });
  ck("用例包：导入生成新用例", impRes.status === 200 && !!impRes.body.id && impRes.body.id !== "demo1", impRes.body && impRes.body.id);
  const impDetail = await j("/api/cases/" + impRes.body.id);
  ck("用例包：导入后提示词与输入一致",
    impDetail.body && impDetail.body.case.prompt === detail.body.case.prompt && !!impDetail.body.maskUrl,
    "");
  const badBundle = await j("/api/cases/import", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hello: 1 })
  });
  ck("用例包：非法包明确拒绝", badBundle.status === 400, String(badBundle.status));
  await j("/api/cases/" + impRes.body.id, { method: "DELETE" });

  /* 删除 */
  const del = await j("/api/cases/demo1", { method: "DELETE" });
  ck("删除：接口成功", del.status === 200, String(del.status));
  const state2 = await j("/api/state");
  ck("删除：用例列表清空", state2.body && state2.body.cases.length === 0, "");
} catch (e) {
  fail++;
  process.exitCode = 1;
  console.log("FAIL | 测试异常 -> " + (e && e.stack || e));
} finally {
  child.kill("SIGTERM");
  fs.rmSync(DATA, { recursive: true, force: true });
  try { fs.unlinkSync(CFG); } catch (e) { /* ignore */ }
}

console.log("\n结果：PASS " + pass + " · FAIL " + fail);
process.exit(process.exitCode || 0);

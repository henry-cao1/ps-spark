/*
 * test-comfy-live.cjs — 本地 ComfyUI 真机联调（需要 ComfyUI 已在跑）
 *
 * 与 test-comfy.cjs 的区别：这里不 mock XHR，走插件真实的取值链路
 *   callComfyUI() → /prompt → /history 轮询 → /view 地址
 *   downloadResultToEntry() → 落盘 PNG
 * 用途：确认 UXP 端这套代码在本机 ComfyUI 上真的能出图（PS 里只是同一段代码）。
 *
 * 运行：
 *   NODE_PATH=<node_modules> \
 *     node bench/test-comfy-live.cjs [--size=768x768] [--url=http://127.0.0.1:8188]
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "../ps-spark-plugin");
const arg = (name, def) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.split("=").slice(1).join("=") : def;
};
const BASE = arg("url", "http://127.0.0.1:8188").replace(/\/+$/, "");
const SIZE = arg("size", "768x768");
const PROMPT = arg("prompt", "a red fox sitting in fresh snow, soft morning light, photorealistic");

let pass = 0, fail = 0;
function ck(name, ok, detail) {
  if (ok) { pass++; console.log("PASS | " + name + (detail ? " -> " + detail : "")); }
  else { fail++; process.exitCode = 1; console.log("FAIL | " + name + (detail ? " -> " + detail : "")); }
}

(async function main() {
  /* 1) 服务在不在：不在就跳过，不把本机没开 ComfyUI 当失败 */
  try {
    const r = await fetch(BASE + "/system_stats", { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
  } catch (e) {
    /* fetch 只会给 "fetch failed"，真正原因在 cause 里（ECONNREFUSED / 超时 / DNS） */
    const cause = (e && e.cause && (e.cause.code || e.cause.message)) || "";
    console.log("SKIP | ComfyUI 连不上 " + BASE + " -> " + (cause || (e && e.message) || String(e)));
    console.log("       多半是没启动。开一个终端窗口跑：");
    console.log("       cd ~/ComfyUI && venv/bin/python main.py --listen 127.0.0.1 --port 8188 --bf16-vae");
    console.log("       或双击 ~/ComfyUI/安装并启动.command —— 那个窗口不能关，关了服务就停。");
    return;
  }

  /* 工作流随文档归档在 docs/dev/integration/，根目录旧位置做兼容回退 */
  const wfCandidates = [
    path.resolve(__dirname, "../docs/dev/integration/ComfyUI-Klein4B-workflow.json"),
    path.resolve(__dirname, "../ComfyUI-Klein4B-workflow.json")
  ];
  const wfPath = wfCandidates.find((p) => fs.existsSync(p));
  if (!wfPath) {
    console.log("SKIP | 找不到 ComfyUI-Klein4B-workflow.json（docs/dev/integration/）");
    return;
  }
  const wfText = fs.readFileSync(wfPath, "utf8");

  /* 2) 起 jsdom：url 与服务同源，避免 XHR 被 CORS 拦 */
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")
    .replace(/<script src="[^"]+"><\/script>/g, "");
  const dom = new JSDOM(html, { runScripts: "dangerously", url: BASE + "/", pretendToBeVisual: true });
  const w = dom.window;
  const errors = [];
  w.addEventListener("error", (e) => errors.push(String(e.message)));

  /* 3) 目录桩：把结果图写到临时目录，便于事后看图 */
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-spark-comfy-live-"));
  const written = [];
  /* 模拟 UXP 的 fs.getDataFolder() → folder.createFile() → entry.write() */
  const folder = {
    createFile: async function (name) {
      return {
        name: name,
        write: async function (buf) {
          const p = path.join(outDir, name);
          fs.writeFileSync(p, Buffer.from(buf));
          written.push(p);
        }
      };
    },
    getDataFolder: async function () { return folder; }
  };

  const stub = w.document.createElement("script");
  stub.textContent = [
    "const __doc = { id: 1, name: 't.psd', width: 1080, height: 810, resolution: 72, layers: [], activeLayers: [] };",
    "window.require = function (m) {",
    "  if (m === 'photoshop') return { app: { activeDocument: __doc, documents: [__doc] }, core: { executeAsModal: async function(fn){ return fn(); } }, action: { batchPlay: async function(){ return [{}]; } }, imaging: {} };",
    "  if (m === 'uxp') return { storage: { localFileSystem: window.__folder, secureStorage: { getItem: async function(){ return null; }, setItem: async function(){}, removeItem: async function(){} }, formats: { utf8:'utf8', binary:'binary' } } };",
    "  throw new Error('unknown module ' + m);",
    "};"
  ].join("\n");
  w.__folder = folder;
  w.document.body.appendChild(stub);

  ["diag.js", "services.js", "api.js", "ps.js", "registry.js", "ui.js", "store.js", "app.js"].forEach(function (f) {
    const s = w.document.createElement("script");
    s.textContent = fs.readFileSync(path.join(ROOT, "js", f), "utf8");
    w.document.body.appendChild(s);
  });
  await new Promise((r) => setTimeout(r, 150));

  /* 4) 写入配置（与设置面板保存同一条路径） */
  w.saveComfyConfig({ url: BASE, workflow: wfText, promptNode: "4" });
  const cfg = JSON.parse(w.localStorage.getItem("psspark.comfy"));
  const wfSaved = (cfg.presets && cfg.presets[0] && cfg.presets[0].workflow) || "";
  ck("配置：工作流已落盘", wfSaved.length > 500, wfSaved.length + " 字");

  /* 5) 真调用：提交 → 轮询 → 取地址 */
  const t0 = Date.now();
  let url = "";
  try {
    url = await w.callComfyUI(PROMPT, { size: SIZE });
  } catch (e) {
    ck("ComfyUI：出图", false, (e && e.message) || String(e));
    return;
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  ck("ComfyUI：出图", /\/view\?filename=/.test(url), url.slice(0, 90));
  console.log("  耗时 " + secs + "s（" + SIZE + "）");

  /* 6) 下载落盘：PS 里候选图也是走这一步 */
  let entry = null;
  try {
    entry = await w.downloadResultToEntry(url, "comfy-live.png");
  } catch (e) {
    ck("ComfyUI：下载结果图", false, (e && e.message) || String(e));
    return;
  }
  ck("ComfyUI：下载结果图", !!entry, entry ? entry.name : "");
  /* 目录里可能还有 diag 写的 psspark_debug.log，只认目标文件名 */
  const imgPath = written.filter((p) => p.endsWith("comfy-live.png"))[0];
  if (imgPath) {
    const buf = fs.readFileSync(imgPath);
    const isPng = buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const w0 = buf.readUInt32BE(16), h0 = buf.readUInt32BE(20);
    ck("ComfyUI：PNG 有效", isPng && buf.length > 50 * 1024,
      (buf.length / 1024 / 1024).toFixed(2) + "MB " + w0 + "×" + h0);
    ck("ComfyUI：尺寸按参数替换", (SIZE.split("x")[0] + "x" + SIZE.split("x")[1]) === (w0 + "x" + h0),
      SIZE + " → " + w0 + "×" + h0);
    console.log("  结果图 " + imgPath);
  }

  ck("页面：无 JS 运行时错误", errors.length === 0, errors.slice(0, 2).join(" | "));
  console.log("\n结果：PASS " + pass + " · FAIL " + fail);
  return true;
})().then(function (done) {
  /* jsdom 的 window 里还有 app.js 的进度定时器，不主动关掉进程不会退出 */
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.error("FAIL | 未捕获异常 -> " + (e && e.stack || e));
  process.exit(1);
});

setTimeout(function () {
  console.error("FAIL | 整体超时（8 分钟），可能是 XHR 没回调");
  process.exit(1);
}, 480000).unref();

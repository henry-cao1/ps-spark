/*
 * test-comfy.cjs — 本地 ComfyUI 接入冒烟测试（jsdom + mock XHR）
 *
 * 覆盖：设置保存 / 生图页模型切换 / 工作流提示词替换 / seed 随机化 / 尺寸替换 / 提交轮询取图
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "../ps-spark-plugin");

/* /object_info 的模拟应答：节点存在且没有额外必填项。
 * callComfyUI 提交前会做 preflight（缺节点/缺模型文件提前报错），
 * 返回 "{}" 会被当成「这台机器没装该节点」而拒绝提交。 */
function objectInfoBody(url) {
  const cls = decodeURIComponent(String(url).split("/object_info/")[1] || "");
  const out = {};
  out[cls] = { input: { required: {} } };
  return JSON.stringify(out);
}

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

const stub = w.document.createElement("script");
stub.textContent = [
  "const __doc = { id: 1, name: 't.psd', width: 1080, height: 810, resolution: 72, layers: [], activeLayers: [] };",
  "const __folder = { getEntry: async function(){ throw new Error('no'); }, createFile: async function(n){ return { name:n, read:async function(){ return new ArrayBuffer(4); }, write:async function(){}, copyTo:async function(){} }; } };",
  "window.require = function (m) {",
  "  if (m === 'photoshop') return { app: { activeDocument: __doc, documents: [__doc] }, core: { executeAsModal: async function(fn){ return fn(); } }, action: { batchPlay: async function(){ return [{}]; } }, imaging: {} };",
  "  if (m === 'uxp') return { storage: { localFileSystem: __folder, secureStorage: { getItem: async function(){ return null; }, setItem: async function(){}, removeItem: async function(){} }, formats: { utf8:'utf8', binary:'binary' } } };",
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
  const d = w.document;
  await new Promise((r) => setTimeout(r, 120));

  /* 先给默认预设一条最简工作流：没有工作流的预设不会进模型下拉 */
  d.getElementById("comfyUrl").value = "http://127.0.0.1:8188";
  d.getElementById("comfyWorkflow").value = JSON.stringify({
    "6": { class_type: "CLIPTextEncode", inputs: { text: "old prompt", clip: ["4", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } }
  });
  w.saveComfyFromForm();

  /* 1) 生图页参数区的模型行：本地预设按「本地 · 名称」列出 */
  const items = d.querySelectorAll('[data-model-use="gen"] .dd-item');
  const labels = Array.prototype.map.call(items, (n) => n.textContent);
  ck("生图页：参数区模型下拉已渲染", items.length >= 17, String(items.length));
  ck("生图页：包含「跟随设置」", labels.some((t) => t.indexOf("跟随设置") === 0), labels[0] || "");
  const heads = Array.prototype.map.call(d.querySelectorAll('[data-model-use="gen"] .dd-head'), (n) => n.textContent);
  ck("生图页：包含本地预设分组", heads.indexOf("本地（ComfyUI）") >= 0, heads.join(" / "));
  ck("生图页：本地预设带名称", labels.some((t) => t.indexOf("本地 · ") === 0), labels.filter((t) => t.indexOf("本地") === 0).join(" / "));

  /* 2) 切换到本地预设（用第一台的 id，而不是裸 comfy） */
  const P1 = w.eval("getComfyPresets()[0].id");
  w.setGenModelOverride("comfy:" + P1);
  w.renderGenView();
  ck("切换：resolveModel(gen) 指向预设", w.eval('resolveModel("gen")') === "comfy:" + P1, w.eval('resolveModel("gen")'));
  ck("切换：预设 id 可解析", w.eval('comfyPresetIdOf("comfy:' + P1 + '")') === P1, "");
  const active = d.querySelector('[data-model-use="gen"] .dd-item.active');
  ck("切换：参数区选中该预设", active && active.textContent.indexOf("本地 · ") === 0,
    active ? active.textContent : "none");

  /* 2.1) 编辑 / 拆图也有模型行 */
  w.eval("switchTab('edit')");
  ck("编辑页：模型行存在", !!d.querySelector('[data-model-use="edit"]'), "");
  w.eval("switchTab('decomp')");
  ck("拆图页：模型行存在", !!d.querySelector('[data-model-use="decomp"]'), "");
  w.eval("switchTab('gen')");

  /* 2.2) 编辑 / 拆图覆盖真实生效 */
  w.setModelOverride("edit", "gpt-image-2-vip");
  ck("编辑覆盖：resolveModel(edit)", w.eval('resolveModel("edit")') === "gpt-image-2-vip",
    w.eval('resolveModel("edit")'));
  w.setModelOverride("decomp", "nano-banana-pro");
  ck("拆图覆盖：resolveModel(decomp)", w.eval('resolveModel("decomp")') === "nano-banana-pro",
    w.eval('resolveModel("decomp")'));
  w.setModelOverride("edit", "");
  w.setModelOverride("decomp", "");

  /* 3) 设置保存 */
  const WF = JSON.stringify({
    "6": { class_type: "CLIPTextEncode", inputs: { text: "old prompt", clip: ["4", 0] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: "bad", clip: ["4", 0] }, _meta: { title: "Negative" } },
    "3": { class_type: "KSampler", inputs: { seed: 1, steps: 20 } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0] } }
  });
  d.getElementById("comfyUrl").value = "http://127.0.0.1:8188";
  d.getElementById("comfyWorkflow").value = WF;
  d.getElementById("comfyPromptNode").value = "";
  w.saveComfyFromForm();
  const saved = JSON.parse(w.localStorage.getItem("psspark.comfy"));
  ck("设置：存储升级为预设结构", saved.version === 2 && Array.isArray(saved.presets) && saved.presets.length === 1,
    "presets=" + (saved.presets || []).length);
  ck("设置：工作流写入预设", saved.presets[0].workflow === WF, String(saved.presets[0].workflow.length) + " 字");
  ck("设置：地址已保存", saved.presets[0].url === "http://127.0.0.1:8188", saved.presets[0].url);
  ck("设置：能力默认含文生图", saved.presets[0].caps.indexOf("t2i") >= 0, saved.presets[0].caps.join("/"));

  /* 3.1) 新增/复制/删除预设 */
  w.eval("comfyAddPreset(false)");
  ck("预设：新增后变 2 个", w.eval("getComfyPresets().length") === 2, String(w.eval("getComfyPresets().length")));
  const P2 = w.eval("getComfyPresets()[1].id");
  w.eval('upsertComfyPreset({ id: "' + P2 + '", name: "Win 机器", url: "http://192.168.1.9:8188", workflow: "{}", caps: ["i2i","inpaint"], alpha: "none" })');
  const p2 = w.eval('getComfyPreset("' + P2 + '")');
  ck("预设：能力可单独声明", p2.caps.join("/") === "i2i/inpaint", p2.caps.join("/"));
  ck("预设：透明能力可标注", p2.alpha === "none", p2.alpha);
  ck("预设：按用途选默认", (function () { w.eval('setComfyDefault("gen", "' + P1 + '")'); return w.eval('getComfyDefault("gen")') === P1; })(), "");

  /* 3.2) 能力以工作流节点为准：t2i 工作流勾了 i2i/inpaint/segment 应被剔除 */
  const P_CAP = w.eval('upsertComfyPreset({ name: "虚标能力", url: "http://127.0.0.1:8188", workflow: ' + JSON.stringify(WF) +
    ', caps: ["t2i","i2i","inpaint","segment"] }).id');
  const capsNow = w.eval('getComfyPreset("' + P_CAP + '").caps').join("/");
  ck("能力：工作流没有输入/蒙版节点时剔除虚标", capsNow === "t2i", capsNow);

  /* 3.3) 一条工作流绑多台：第一台离线时自动切第二台 */
  const P_MULTI = w.eval('upsertComfyPreset({ name: "多机预设", url: "http://10.9.9.1:8188", urls: ["http://10.9.9.2:8188"], workflow: ' +
    JSON.stringify(WF) + ', caps: ["t2i"] }).id');
  const multiCalls = [];
  w.xhrRequest = async function (opt) {
    const u = String(opt.url);
    multiCalls.push(u);
    if (u.indexOf("10.9.9.1") >= 0) throw new Error("connect ECONNREFUSED");
    if (u.indexOf("/system_stats") >= 0) return { status: 200, response: "{}" };
    if (u.endsWith("/prompt")) return { status: 200, response: JSON.stringify({ prompt_id: "pm" }) };
    if (u.indexOf("/history/") >= 0) {
      return { status: 200, response: JSON.stringify({ pm: { status: { status_str: "success" }, outputs: { "9": { images: [{ filename: "m.png", subfolder: "", type: "output" }] } } } }) };
    }
    if (u.indexOf("/object_info/") >= 0) return { status: 200, response: objectInfoBody(u) };
    return { status: 200, response: "{}" };
  };
  const multiUrl = await w.eval('callComfyUI("multi", {}, "' + P_MULTI + '")');
  const multiBase = (multiUrl.match(/^https?:\/\/[^\/]+/) || [""])[0];
  ck("多机：第一台离线自动切第二台", multiBase === "http://10.9.9.2:8188" &&
    multiCalls.some(function (u) { return u.indexOf("10.9.9.2") >= 0 && /\/prompt$/.test(u); }),
    multiBase + " | " + multiCalls.slice(0, 4).join(" , "));

  /* 4) callComfyUI：mock 提交/轮询 */
  const calls = [];
  w.xhrRequest = async function (opt) {
    calls.push(opt);
    if (String(opt.url).endsWith("/prompt")) {
      return { status: 200, response: JSON.stringify({ prompt_id: "p1" }) };
    }
    if (String(opt.url).indexOf("/history/") >= 0) {
      return {
        status: 200,
        response: JSON.stringify({
          p1: { status: { status_str: "success" }, outputs: { "9": { images: [{ filename: "out 1.png", subfolder: "sub", type: "output" }] } } }
        })
      };
    }
    if (String(opt.url).indexOf("/object_info/") >= 0) return { status: 200, response: objectInfoBody(opt.url) };
    return { status: 200, response: "{}" };
  };

  const t0 = Date.now();
  const url = await w.eval('callComfyUI("a red fox in snow", { size: "1024x768" })');
  ck("ComfyUI：返回 /view 地址", /\/view\?filename=out%201\.png/.test(url), url);
  ck("ComfyUI：提交了 /prompt", calls.some((c) => String(c.url).endsWith("/prompt")), "");
  ck("ComfyUI：单地址不做在线探测（零额外延迟）", !calls.some((c) => String(c.url).indexOf("/system_stats") >= 0), "");
  ck("ComfyUI：轮询了 /history", calls.some((c) => String(c.url).indexOf("/history/p1") >= 0), "");
  ck("ComfyUI：总耗时 >= 1.5s（轮询间隔）", Date.now() - t0 >= 1400, String(Date.now() - t0) + "ms");

  const submit = calls.filter((c) => String(c.url).endsWith("/prompt"))[0];
  const body = JSON.parse(submit.body);
  ck("ComfyUI：正向提示词被替换", body.prompt["6"].inputs.text === "a red fox in snow",
    body.prompt["6"].inputs.text);
  ck("ComfyUI：负面提示词未被改", body.prompt["7"].inputs.text === "bad", body.prompt["7"].inputs.text);
  ck("ComfyUI：seed 已随机化", body.prompt["3"].inputs.seed !== 1, String(body.prompt["3"].inputs.seed));
  ck("ComfyUI：尺寸已替换", body.prompt["5"].inputs.width === 1024 && body.prompt["5"].inputs.height === 768,
    body.prompt["5"].inputs.width + "x" + body.prompt["5"].inputs.height);

  /* 5) 未配置工作流时明确报错（对准当前编辑的预设 P2） */
  w.saveComfyConfig({ url: "http://127.0.0.1:8188", workflow: "", promptNode: "" });
  let msg = "";
  try { await w.eval('callComfyUI("x", {}, "' + P2 + '")'); } catch (e) { msg = e.message; }
  ck("ComfyUI：空工作流报错", /未配置工作流/.test(msg), msg);

  /* 6) 非法 JSON 报错 */
  w.saveComfyConfig({ url: "http://127.0.0.1:8188", workflow: "{oops", promptNode: "" });
  msg = "";
  try { await w.eval('callComfyUI("x", {}, "' + P2 + '")'); } catch (e) { msg = e.message; }
  ck("ComfyUI：非法 JSON 报错", /JSON 解析失败/.test(msg), msg);

  /* 7) 回归：文生图单张选「本地 ComfyUI」时，不能把 "comfy" 当云端模型 id 发出去
   *    旧行为 → POST /v1/images/generations {model:"comfy"} → HTTP 400 model not register */
  let guardMsg = "";
  try { await w.callApi("/v1/images/generations", { model: "comfy", prompt: "x" }, false); }
  catch (e) { guardMsg = e.message; }
  ck("云端接口：拒绝 comfy 模型 id", /本地 ComfyUI 未接入/.test(guardMsg), guardMsg);

  const t2i = w.eval("instById('text2img')");
  const snap = { userText: "一只雪地里的赤狐", params: { size: "1024x1024" }, slots: {}, locate: {}, tplOverride: "" };

  /* 本地参考图：单张走 i2i（需要带 INPUT 节点的预设），多图仍明确拒绝 */
  const P_I2I = w.eval('upsertComfyPreset({ name: "本地参考图", url: "http://127.0.0.1:8188", workflow: ' + JSON.stringify(JSON.stringify({
    "1": { class_type: "LoadImage", inputs: { image: "" }, _meta: { title: "INPUT" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["3", 0] }, _meta: { title: "PROMPT" } },
    "4": { class_type: "VAEEncode", inputs: { pixels: ["1", 0], vae: ["5", 0] } },
    "6": { class_type: "KSampler", inputs: { seed: 1, steps: 4, cfg: 1, denoise: 0.6, latent_image: ["4", 0] } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0] }, _meta: { title: "OUTPUT" } }
  })) + ', caps: ["i2i"] }).id');
  w.setGenModelOverride("comfy:" + P_I2I);
  let refHit = null;
  const realCC = w.callComfyUI;
  w.callComfyUI = async function (p, params) { refHit = { p: p, params: params }; return "http://127.0.0.1:8188/view?filename=ref.png&type=output"; };
  let refUrl = "", refErr = "";
  try {
    refUrl = await w.eval('requestGenerationOnce("comfy:' + P_I2I + '", "相似图", ["data:image/png;base64,AAAA"], {params:{size:"768x768"}})');
  } catch (e) { refErr = e.message; }
  w.callComfyUI = realCC;
  ck("参考图：本地单张走 i2i", !!refHit && /ref\.png/.test(refUrl) && /^data:image/.test(String(refHit.params.imageUri)),
    refErr || (refHit ? "imageUri=" + String(refHit.params.imageUri).slice(0, 22) : "未调用"));
  let manyMsg = "";
  try { await w.eval('requestGenerationOnce("comfy:' + P_I2I + '", "x", ["a", "b"], {params:{}})'); }
  catch (e) { manyMsg = e.message; }
  ck("参考图：本地多图明确拒绝", /只支持 1 张/.test(manyMsg), manyMsg);

  /* 回到文生图可用的本地预设（上一段把 gen 覆盖指到了 i2i 专用组） */
  w.setGenModelOverride("comfy:" + P1);
  let comfyHit = null, apiHit = null;
  const realCallComfyUI = w.callComfyUI;
  w.callComfyUI = async function (p, params) {
    comfyHit = { prompt: p, size: params && params.size };
    return "http://127.0.0.1:8188/view?filename=fake.png&type=output";
  };
  w.callApi = async function (path, payload) { apiHit = payload; return { url: "https://example.invalid/x.png" }; };
  w.placeResultAsLayer = async function (url) { return { name: "fake.png", url: url }; };

  let plainRes = null, plainErr = "";
  try { plainRes = await w.runGenerationsPlain(t2i, snap, {}, null); }
  catch (e) { plainErr = e.message; }
  ck("文生图单张：走本地 ComfyUI 而不是云端",
    !!comfyHit && !apiHit, plainErr || (comfyHit ? "size=" + comfyHit.size : "未调用 callComfyUI"));
  ck("文生图单张：结果已置入图层", !!(plainRes && plainRes.entry),
    plainRes && plainRes.entry ? plainRes.entry.name : (plainErr || "无 entry"));

  /* 8) 编辑域：图 + 蒙版上传，节点按角色注入，参数按预设覆盖 */
  w.callComfyUI = realCallComfyUI;
  const WF_INP = JSON.stringify({
    "1": { class_type: "LoadImage", inputs: { image: "placeholder.png" }, _meta: { title: "INPUT" } },
    "2": { class_type: "LoadImageMask", inputs: { image: "placeholder.png", channel: "red" }, _meta: { title: "MASK" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "old", clip: ["3", 0] }, _meta: { title: "PROMPT" } },
    "6": { class_type: "KSampler", inputs: { seed: 1, steps: 20, cfg: 7, denoise: 1 } },
    "9": { class_type: "SaveImage", inputs: { images: ["8", 0] }, _meta: { title: "OUTPUT" } }
  });
  const P3 = w.eval('upsertComfyPreset({ name: "重绘预设", url: "http://127.0.0.1:8188", workflow: ' + JSON.stringify(WF_INP) +
    ', caps: ["inpaint"], overrides: { steps: 8, cfg: 1.5, denoise: 0.6 } }).id');

  const upCalls = [], subCalls = [];
  w.xhrRequest = async function (opt) {
    const u = String(opt.url);
    if (u.indexOf("/upload/image") >= 0) {
      upCalls.push(opt);
      return { status: 200, response: JSON.stringify({ name: "psspark_" + upCalls.length + ".png", subfolder: "", type: "input" }) };
    }
    if (u.endsWith("/prompt")) {
      subCalls.push(opt);
      return { status: 200, response: JSON.stringify({ prompt_id: "p9" }) };
    }
    if (u.indexOf("/history/") >= 0) {
      return { status: 200, response: JSON.stringify({ p9: { status: { status_str: "success" }, outputs: { "9": { images: [{ filename: "o.png", subfolder: "", type: "output" }] } } } }) };
    }
    if (u.indexOf("/object_info/") >= 0) return { status: 200, response: objectInfoBody(u) };
    return { status: 200, response: "{}" };
  };

  let inpUrl = "";
  try {
    inpUrl = await w.eval('callComfyUI("把墙刷成蓝色", { imageUri: "data:image/png;base64,AAAA", maskUri: "data:image/png;base64,BBBB", size: "512x512", denoise: 0.75 }, "' + P3 + '")');
  } catch (e) { inpUrl = "ERR " + e.message; }
  ck("编辑域：出图地址", /\/view\?filename=o\.png/.test(inpUrl), inpUrl);
  ck("编辑域：上传了图与蒙版", upCalls.length === 2, String(upCalls.length));
  ck("编辑域：上传走 multipart", upCalls[0] && /multipart\/form-data/.test(String(upCalls[0].headers["Content-Type"])), "");

  const ib = JSON.parse(subCalls[0].body).prompt;
  ck("编辑域：INPUT 节点注入文件名", ib["1"].inputs.image === "psspark_1.png", ib["1"].inputs.image);
  ck("编辑域：MASK 节点注入文件名", ib["2"].inputs.image === "psspark_2.png", ib["2"].inputs.image);
  ck("编辑域：提示词按角色注入", ib["4"].inputs.text === "把墙刷成蓝色", ib["4"].inputs.text);
  ck("编辑域：调用参数覆盖预设（denoise）", ib["6"].inputs.denoise === 0.75, String(ib["6"].inputs.denoise));
  ck("编辑域：预设步数/cfg 生效", ib["6"].inputs.steps === 8 && ib["6"].inputs.cfg === 1.5,
    ib["6"].inputs.steps + "/" + ib["6"].inputs.cfg);

  /* 工作流缺 MASK 节点 → 明确报错，而不是把蒙版丢掉 */
  const P4 = w.eval('upsertComfyPreset({ name: "无蒙版", url: "http://127.0.0.1:8188", workflow: ' + JSON.stringify(JSON.stringify({
    "1": { class_type: "LoadImage", inputs: { image: "x.png" }, _meta: { title: "INPUT" } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "old" }, _meta: { title: "PROMPT" } },
    "9": { class_type: "SaveImage", inputs: {} }
  })) + ', caps: ["i2i"] }).id');
  let maskMsg = "";
  try { await w.eval('callComfyUI("x", { imageUri: "data:image/png;base64,AAAA", maskUri: "data:image/png;base64,BBBB" }, "' + P4 + '")'); }
  catch (e) { maskMsg = e.message; }
  ck("编辑域：缺 MASK 节点明确报错", /没有蒙版节点/.test(maskMsg), maskMsg);

  /* 9) 透明能力：本地看预设 alpha，云端只认确认过的；拆图提示词按能力改写 */
  ck("透明：本地预设 alpha=none 被识别", w.eval('modelAlphaSupport("comfy:' + P2 + '")') === "none",
    w.eval('modelAlphaSupport("comfy:' + P2 + '")'));
  ck("透明：云端确认模型为 native", w.eval('modelAlphaSupport("gpt-image-2.5")') === "native", "");
  ck("透明：未确认模型保持 unknown", w.eval('modelAlphaSupport("nano-banana-pro")') === "unknown", "");
  const pKey = w.eval('buildDecompLayerPrompt({ name: "树", prompt: "绿色树冠" }, true)');
  const pAl = w.eval('buildDecompLayerPrompt({ name: "树", prompt: "绿色树冠" }, false)');
  ck("透明：纯色底提示词要求洋红底", pKey.indexOf("#FF00FF") >= 0 && pKey.indexOf("不要画棋盘") >= 0, "");
  ck("透明：真透明提示词仍要求 alpha", pAl.indexOf("Alpha") >= 0 && pAl.indexOf("#FF00FF") < 0, "");

  w.setGenModelOverride("");
  /* 10) 内置模板：新机器一键建预设，重复添加不重复 */
  const beforeTpl = w.eval("getComfyPresets().length");
  const tplCount = w.eval("COMFY_TEMPLATES.length");
  const addedTpl = w.eval('comfyApplyTemplates("http://127.0.0.1:8188")');
  ck("模板：一键添加全部内置预设", addedTpl === tplCount && w.eval("getComfyPresets().length") === beforeTpl + tplCount,
    "added=" + addedTpl + "/" + tplCount);
  const tpls = w.eval('getComfyPresets().filter(function(p){return !!p.templateKey;})');
  const tpl = tpls.filter(function (x) { return x.caps.indexOf("t2i") >= 0; })[0];
  const tplI2I = tpls.filter(function (x) { return x.templateKey === "klein4b-i2i"; })[0];
  const tplInp = tpls.filter(function (x) { return x.templateKey === "klein4b-inpaint"; })[0];
  ck("模板：文生图模板字段完整", tpl && !!tpl.workflow && tpl.roles.prompt === "4",
    tpl ? (tpl.name + " · " + tpl.caps.join("/")) : "无");
  ck("模板：参考图模板带 INPUT", !!tplI2I && tplI2I.roles.input === "5" && /LoadImage/.test(tplI2I.workflow),
    tplI2I ? tplI2I.roles.input : "无");
  ck("模板：局部重绘模板带 INPUT+MASK", !!tplInp && tplInp.roles.mask === "6" && /LoadImageMask/.test(tplInp.workflow),
    tplInp ? (tplInp.roles.input + "/" + tplInp.roles.mask) : "无");
  ck("模板：重复添加不重复", w.eval("comfyApplyTemplates()") === 0, "");

  /* 11) 能力按工作流收紧 + 同一模型多条工作流合并为一个下拉项 */
  ck("模板：参考图只声明 i2i", tplI2I.caps.join("/") === "i2i", tplI2I.caps.join("/"));
  ck("模板：局部重绘只声明 inpaint", tplInp.caps.join("/") === "inpaint", tplInp.caps.join("/"));
  const klein = w.eval('comfyModelGroups().filter(function(g){return g.name === "Klein 4B";})[0]');
  ck("模型合并：三条工作流归为一组", !!klein && klein.presets.length === 3,
    klein ? klein.presets.length + " 条" : "无");
  ck("模型合并：按功能解析到对应工作流",
    w.eval('comfyResolvePresetId("comfy:' + tpl.id + '", "t2i")') === tpl.id &&
    w.eval('comfyResolvePresetId("comfy:' + tpl.id + '", "i2i")') === tplI2I.id &&
    w.eval('comfyResolvePresetId("comfy:' + tpl.id + '", "inpaint")') === tplInp.id, "");
  w.setGenModelOverride("comfy:" + tpl.id);
  w.eval("App.genInstance='text2img'; renderGenView();");
  const localLabels = Array.prototype.map.call(d.querySelectorAll('[data-model-use="gen"] .dd-item'),
    function (n) { return n.textContent; }).filter(function (t) { return t.indexOf("本地 · ") === 0; });
  ck("模型合并：下拉只显示一个 Klein 4B",
    localLabels.filter(function (t) { return t === "本地 · Klein 4B"; }).length === 1,
    localLabels.join(" / "));

  /* 选了「局部重绘」那条，跑相似图也要自动落到参考图工作流（而不是缺 MASK 报错） */
  let similarPreset = "";
  const realSimilarComfy = w.callComfyUI;
  w.callComfyUI = async function (p, params, id) { similarPreset = id; return "http://127.0.0.1:8188/view?filename=s.png"; };
  let similarErr = "";
  try {
    await w.eval('requestGenerationOnce("comfy:' + tplInp.id + '", "相似图", ["data:image/png;base64,AAAA"], {params:{size:"auto"}})');
  } catch (e) { similarErr = e.message; }
  w.callComfyUI = realSimilarComfy;
  ck("相似图：同一模型自动选参考图工作流", similarPreset === tplI2I.id, similarErr || similarPreset);

  /* 12) 本地编辑：不画色框；默认「整图重绘 + 蒙版合成」，可切回工作流自带蒙版 */
  const realExport = w.exportRegionToPNG, realMask = w.buildMaskPNG, realData = w.fileToDataURI;
  const realComfyCall = w.callComfyUI, realPlace = w.placeResultAsLayer;
  let strokeArg = "unset", maskCh = "", usedId = "", clipArg = null, placeOpts = null;
  w.exportRegionToPNG = async function (eb, stroke) {
    strokeArg = stroke;
    return { entry: { name: "x" }, color: stroke ? { name: "黄", hex: "#FFE600" } : null, actualW: 600, actualH: 400 };
  };
  w.buildMaskPNG = async function (eb, size, ch) { maskCh = ch; return { entry: { name: "m" } }; };
  w.fileToDataURI = async function () { return "data:image/png;base64,AAAA"; };
  w.callComfyUI = async function (p, params, id) { usedId = id; return "http://127.0.0.1:8188/view?filename=x.png"; };
  w.placeResultAsLayer = async function (url, bounds, name, clip, docId, opts) { clipArg = clip; placeOpts = opts; return { name: "r" }; };
  w.setModelOverride("edit", "comfy:" + tplInp.id);
  w.localStorage.removeItem("psspark.comfy.wholeRedraw");
  let editErr = "";
  try {
    await w.eval('runEditPipeline(instById("local_redraw"), ' +
      JSON.stringify({ userText: "换成一只橘猫", params: {}, slots: {}, locate: { box: true, clip: true }, tplOverride: "" }) +
      ', { sel:{ left:100, top:100, right:700, bottom:500, width:600, height:400 }, docW:3000, docH:2000, docId:1 })');
  } catch (e) { editErr = e.message; }
  ck("本地编辑：不画色框（色框只给云端）", strokeArg === null, editErr || String(strokeArg));
  ck("本地编辑：整图重绘不传蒙版、走参考图工作流",
    maskCh === "" && usedId === tplI2I.id, (maskCh || "(none)") + " / " + (usedId || "未调用"));
  ck("本地编辑：整图重绘落图时按选区蒙版裁切（带羽化）",
    !!clipArg && clipArg.mask === true && clipArg.channel === "pssparkSelClip" && clipArg.feather >= 2,
    JSON.stringify(clipArg));
  ck("编辑落图：一律铺满导出区域（stretch，防等比居中错位）",
    !!placeOpts && placeOpts.stretch === true, JSON.stringify(placeOpts));

  /* 切回「工作流自带蒙版」：恢复原行为（传蒙版、走 inpaint） */
  w.localStorage.setItem("psspark.comfy.wholeRedraw", "0");
  maskCh = ""; usedId = ""; clipArg = null; editErr = "";
  try {
    await w.eval('runEditPipeline(instById("local_redraw"), ' +
      JSON.stringify({ userText: "换成一只橘猫", params: {}, slots: {}, locate: { box: true, clip: true }, tplOverride: "" }) +
      ', { sel:{ left:100, top:100, right:700, bottom:500, width:600, height:400 }, docW:3000, docH:2000, docId:1 })');
  } catch (e) { editErr = e.message; }
  ck("本地编辑（蒙版模式）：蒙版使用本次运行通道", maskCh === "pssparkSelClip", editErr || maskCh);
  ck("本地编辑（蒙版模式）：自动选到 inpaint 工作流", usedId === tplInp.id, usedId || "未调用");
  w.localStorage.removeItem("psspark.comfy.wholeRedraw");
  w.exportRegionToPNG = realExport; w.buildMaskPNG = realMask; w.fileToDataURI = realData;
  w.callComfyUI = realComfyCall; w.placeResultAsLayer = realPlace;
  w.setModelOverride("edit", "");

  /* 13) 老数据里的重复预设：同名 + 同工作流在读取时合并（直接测迁移函数，不污染真实存储） */
  const dupRes = JSON.parse(w.eval('(function(){' +
    'var t = getComfyPresets().filter(function(p){return p.templateKey === "klein4b-t2i";})[0];' +
    'var a = comfyNormPreset({ id:"dupA", name:"Klein 4B 文生图", url:"http://a", workflow:t.workflow, caps:["t2i"] });' +
    'var b = comfyNormPreset({ id:"dupB", name:"Klein 4B 文生图", url:"http://b", workflow:t.workflow, caps:["t2i"] });' +
    'var store = { activeId:"dupB", presets:[a,b], defaultByUse:{ gen:"dupB", edit:"", decomp:"" } };' +
    'var r = comfyDedupeStore(store);' +
    'return JSON.stringify({ n:store.presets.length, id:store.presets[0].id, gen:store.defaultByUse.gen, changed:r.changed, urls:store.presets[0].urls });' +
    '})()'));
  ck("预设去重：同名同工作流自动合并",
    dupRes.n === 1 && dupRes.id === "dupA" && dupRes.gen === "dupA" && dupRes.changed && dupRes.urls.indexOf("http://b") >= 0,
    JSON.stringify(dupRes));
  w.setGenModelOverride("");

  /* 14) 拆图：请求尺寸必须落在模型支持表内（自定义像素值会被网关改写，导致蒙版错位） */
  ck("拆图尺寸：方图选 1024×1024", w.eval('decompPickSize(3000,3000,"gpt-image-2.5")') === "1024x1024",
    w.eval('decompPickSize(3000,3000,"gpt-image-2.5")'));
  ck("拆图尺寸：3:2 选 1536×1024", w.eval('decompPickSize(3000,2000,"gpt-image-2.5")') === "1536x1024",
    w.eval('decompPickSize(3000,2000,"gpt-image-2.5")'));
  ck("拆图尺寸：极端比例退回 auto", w.eval('decompPickSize(3000,600,"gpt-image-2.5")') === "auto",
    w.eval('decompPickSize(3000,600,"gpt-image-2.5")'));
  ck("拆图尺寸：背景层在同比例下取最大档（≤2K）",
    w.eval('decompPickSize(3000,3000,"gpt-image-2.5-flare",true)') === "2048x2048",
    w.eval('decompPickSize(3000,3000,"gpt-image-2.5-flare",true)'));
  ck("拆图尺寸：nano 走比例串", w.eval('decompPickSize(3000,3000,"nano-banana-pro")') === "1:1",
    w.eval('decompPickSize(3000,3000,"nano-banana-pro")'));
  const dcPrompt = w.eval('buildDecompLayerPrompt({name:"南瓜灯",prompt:"橙色南瓜"}, true)');
  ck("拆图提示词：只允许出现主体 + 边缘清晰",
    dcPrompt.indexOf("只允许出现") >= 0 && dcPrompt.indexOf("边缘清晰") >= 0 && dcPrompt.indexOf("#FF00FF") >= 0, "");

  /* 15b) 本地重绘方式开关 */
  ck("本地重绘：默认整图重绘", w.eval('localStorage.removeItem("psspark.comfy.wholeRedraw"); comfyWholeRedraw()') === true, "");
  ck("本地重绘：可切回工作流自带蒙版",
    w.eval('localStorage.setItem("psspark.comfy.wholeRedraw","0"); comfyWholeRedraw()') === false, "");
  w.eval('localStorage.removeItem("psspark.comfy.wholeRedraw")');

  /* 15) 本地整图重绘：导出范围扩大且有上下文 */
  const wb = JSON.parse(w.eval('JSON.stringify(computeWholeRedrawBounds({left:1400,top:1400,right:1600,bottom:1600,width:200,height:200},3000,3000))'));
  ck("整图重绘范围：短边不小于 768 且不越界",
    wb.width >= 768 && wb.height >= 768 && wb.width <= 3000 && wb.height <= 3000 &&
    wb.left >= 0 && wb.top >= 0 && wb.right <= 3000 && wb.bottom <= 3000,
    JSON.stringify(wb));
  const wb2 = JSON.parse(w.eval('JSON.stringify(computeWholeRedrawBounds({left:10,top:10,right:110,bottom:60,width:100,height:50},3000,3000))'));
  ck("整图重绘范围：贴边选区不越界", wb2.left === 0 && wb2.top === 0, JSON.stringify(wb2));

  /* 16) 扩图：参考图几何（缩放/偏移换算）+ 请求尺寸档位 */
  const g1 = JSON.parse(w.eval('JSON.stringify(outpaintRefGeometry(1080,810,270,270,203,203))'));
  ck("扩图几何：小画布不缩放，原图区按左右/上下偏移",
    g1.NW === 1620 && g1.NH === 1216 && g1.k === 1 && g1.RW === 1620 && g1.RH === 1216 &&
    g1.rl === 270 && g1.rt === 203 && g1.rw === 1080 && g1.rh === 810,
    JSON.stringify(g1));
  const g2 = JSON.parse(w.eval('JSON.stringify(outpaintRefGeometry(2471,2470,2471,2471,2470,2470))'));
  ck("扩图几何：超大画布等比压到 2048 内（比例不变）",
    g2.RW <= 2048 && g2.RH <= 2048 &&
    Math.abs((g2.RW / g2.RH) / (g2.NW / g2.NH) - 1) < 0.002 &&
    Math.abs((g2.rw / g2.RW) / (2471 / g2.NW) - 1) < 0.01,
    JSON.stringify(g2));
  ck("扩图几何：原图区 + 扩展边正好铺满参考图",
    g2.rl + g2.rw + Math.round(2471 * g2.k) === g2.RW &&
    g2.rt + g2.rh + Math.round(2470 * g2.k) === g2.RH,
    g2.rl + "+" + g2.rw + "+" + Math.round(2471 * g2.k) + "=" + g2.RW);
  ck("扩图尺寸：1:1 画布请求方图档位（不再传 auto）",
    w.eval('decompPickSize(' + g2.RW + ',' + g2.RH + ',"gpt-image-2.5",true)') === "1024x1024",
    w.eval('decompPickSize(' + g2.RW + ',' + g2.RH + ',"gpt-image-2.5",true)'));
  ck("扩图尺寸：4:3 画布请求 4:3 档位",
    w.eval('decompPickSize(' + g1.RW + ',' + g1.RH + ',"gpt-image-2.5",true)') === "1443x1090",
    w.eval('decompPickSize(' + g1.RW + ',' + g1.RH + ',"gpt-image-2.5",true)'));

  /* 17) 扩图全链路：导出几何 → 请求尺寸 → 蒙版 → 扩画布 → 铺满回贴 + 挖回原图区 */
  w.eval(`
    window.__op = {};
    __folder.getDataFolder = async function () { return __folder; };
    ensureActiveDoc = function () { return __doc; };
    protectDoc = function () {}; restoreActiveDoc = function () {};
    snapshotDocIds = function () { return [1]; };
    hideLayersNotIn = async function () { return []; };
    restoreLayerVisibility = async function () {};
    toPx = function (v) { if (v == null) return 0; if (typeof v === "number") return v; return v.value != null ? v.value : 0; };
    batchPlay = async function () { return [{ boundsNoEffects: { left: 0, top: 0, right: 1080, bottom: 810 } }]; };
    findNewDoc = function () { return { id: 901, layers: [], activeLayers: [] }; };
    makeDoc = async function (wd, ht, nm) { __op.tmp = { w: wd, h: ht }; return { id: 902, width: wd, height: ht, resolution: 72, saveAs: { png: async function () {} } }; };
    closeDocNoSave = async function () {};
    buildOutpaintMaskPNG = async function (wd, ht, rect) { __op.mask = { w: wd, h: ht, rect: rect }; return { name: "mask.png" }; };
    fileToDataURI = async function () { return "data:image/png;base64,AAAA"; };
    callApi = async function (u, p) { __op.api = { u: u, p: p }; return { url: "http://x/y.png" }; };
    canvasResizeTo = async function () { __op.resize = [].slice.call(arguments); };
    placeResultAsLayer = async function (u, tb, nm, clip, id, opts) { __op.place = { tb: tb, opts: opts }; return { name: "r" }; };
    placeWithGate = async function (r, nm, fn) { return fn(); };
    lastPlacedLayer = { bounds: { left: 0, top: 0, width: 1620, height: 1216 } };
  `);
  w.eval('window.__dupdoc = { id: 901, layers: [{ duplicate: async function () { return { name: "m" }; } }], activeLayers: [] };' +
    '__dupdoc.activeLayers = [__dupdoc.layers[0]]; findNewDoc = function () { return __dupdoc; };');
  let opErr = "";
  try {
    await w.eval('execOutpaint(instById("outpaint"), ' +
      JSON.stringify({ userText: "", params: { expand: { left: 25, right: 25, up: 25, down: 25 }, quality: "auto" }, tplOverride: "" }) +
      ', { docW: 1080, docH: 810, docId: 1, run: null })');
  } catch (e) { opErr = (e && e.message) || String(e); }
  const op = JSON.parse(w.eval("JSON.stringify(__op)"));
  ck("扩图：临时画布 = 扩展后尺寸（1080+270*2 × 810+203*2）",
    !opErr && op.tmp && op.tmp.w === 1620 && op.tmp.h === 1216, opErr || JSON.stringify(op.tmp));
  ck("扩图：请求尺寸走模型支持的 4:3 档（不再传 auto）",
    !opErr && op.api && op.api.p.size === "1443x1090", opErr || (op.api && op.api.p.size));
  ck("扩图：带蒙版（白=扩展边 / 黑=原图矩形）",
    !opErr && op.api && !!op.api.p.mask && op.mask &&
    op.mask.w === 1620 && op.mask.h === 1216 &&
    op.mask.rect.left === 270 && op.mask.rect.top === 203 &&
    op.mask.rect.right === 1350 && op.mask.rect.bottom === 1013,
    opErr || JSON.stringify(op.mask));
  ck("扩图：画布按左/上偏移扩展",
    !opErr && op.resize && op.resize.join(",") === "1080,810,1620,1216,270,203", opErr || (op.resize || []).join(","));
  ck("扩图：结果铺满整块画布", 
    !opErr && op.place && op.place.opts && op.place.opts.stretch === true,
    opErr || JSON.stringify(op.place && op.place.opts));
  ck("扩图：默认不建挖空蒙版（整体重绘融合更自然）",
    !opErr && op.place && op.place.opts && op.place.opts.punchRect == null,
    JSON.stringify(op.place && op.place.opts));

  /* 17b) 打开「保留原图区域」后应恢复挖空（原区域像素绝对不变） */
  w.eval('setOutpaintKeepOriginal(true)');
  w.eval("__op.place = null");
  try {
    await w.eval('execOutpaint(instById("outpaint"), ' +
      JSON.stringify({ userText: "", params: { expand: { left: 25, right: 25, up: 25, down: 25 }, quality: "auto" }, tplOverride: "" }) +
      ', { docW: 1080, docH: 810, docId: 1, run: null })');
  } catch (e2) { /* ignore */ }
  const opKeep = JSON.parse(w.eval("JSON.stringify(__op.place)"));
  ck("扩图：开启「保留原图区域」后挖回原图矩形",
    opKeep && opKeep.opts && opKeep.opts.punchRect &&
    opKeep.opts.punchRect.left === 270 && opKeep.opts.punchRect.top === 203,
    JSON.stringify(opKeep));
  w.eval('setOutpaintKeepOriginal(false)');

  /* 18) 扩图：百分比 / 像素两种口径 + 模型上限警告 */
  const es1 = JSON.parse(w.eval('JSON.stringify(expandSidesOf({mode:"percent",left:10,right:10,up:10,down:10},1000,500))'));
  ck("扩图口径：百分比按宽/高换算", es1.left === 100 && es1.right === 100 && es1.up === 50 && es1.down === 50,
    JSON.stringify(es1));
  const es2 = JSON.parse(w.eval('JSON.stringify(expandSidesOf({mode:"pixels",px:{left:300,right:20,up:10,down:50}},1000,500))'));
  ck("扩图口径：像素模式直接取绝对值", es2.left === 300 && es2.right === 20 && es2.up === 10 && es2.down === 50,
    JSON.stringify(es2));
  const es3 = JSON.parse(w.eval('JSON.stringify(expandSidesOf({left:25,right:25,up:25,down:25},1080,810))'));
  ck("扩图口径：老数据（无 mode）按百分比处理", es3.mode === "percent" && es3.left === 270 && es3.up === 203,
    JSON.stringify(es3));

  const p26 = JSON.parse(w.eval('JSON.stringify(imgModelPreset("gpt-image-2.6"))'));
  ck("模型目录：gpt-image-2.6 已登记为比例/1K",
    !!p26 && p26.group === "gpt" && p26.sizeKind === "ratio1k", JSON.stringify(p26));
  ck("模型目录：2.6 使用 1K 比例档位",
    w.eval('sizeHasValue(sizeOptionsForModel("gpt-image-2.6"),"1672x941")') === true, "");
  ck("模型目录：2.6 质量默认 auto",
    w.eval('defaultQualityForModel("gpt-image-2.6")') === "auto",
    w.eval('defaultQualityForModel("gpt-image-2.6")'));

  const lim1 = JSON.parse(w.eval('JSON.stringify(modelCanvasLimit("gpt-image-2.5"))'));
  ck("模型上限：gpt-image-2.5 = 1920px / 21:9",
    lim1.maxSide === 1920 && Math.abs(lim1.maxRatio - 1920 / 832) < 0.01, JSON.stringify(lim1));
  const lim2 = JSON.parse(w.eval('JSON.stringify(modelCanvasLimit("gpt-image-2.5-flare"))'));
  ck("模型上限：flare = 3840px / 3:1", lim2.maxSide === 3840 && Math.abs(lim2.maxRatio - 3) < 0.01,
    JSON.stringify(lim2));
  const lim3 = JSON.parse(w.eval('JSON.stringify(modelCanvasLimit("nano-banana-2"))'));
  ck("模型上限：nano-banana-2 = 4096px / 8:1", lim3.maxSide === 4096 && Math.abs(lim3.maxRatio - 8) < 0.01,
    JSON.stringify(lim3));

  ck("扩图警告：正常范围内不提示",
    w.eval('expandLimitWarning("gpt-image-2.5",1080,810,270,270,203,203)') === "",
    w.eval('expandLimitWarning("gpt-image-2.5",1080,810,270,270,203,203)'));
  const warnPx = w.eval('expandLimitWarning("gpt-image-2.5",2471,2470,2471,2471,2470,2470)');
  ck("扩图警告：像素超上限时提示", warnPx.indexOf("超过该模型上限 1920px") >= 0, warnPx);
  const warnAr = w.eval('expandLimitWarning("gpt-image-2.5",1000,500,500,500,0,0)');
  ck("扩图警告：比例超上限时提示", warnAr.indexOf("长宽比 4.0:1") >= 0 && warnAr.indexOf("8:1") >= 0, warnAr);

  /* 19) 编辑类输出尺寸：必须与导出区域同比例（抠图错位的根因） */
  ck("编辑尺寸：比例不符时改用同比例档（4:3 区域 + 1:1 参数）",
    w.eval('editOutputSize("gpt-image-2.5",1600,1200,"1024x1024")') === "1443x1090",
    w.eval('editOutputSize("gpt-image-2.5",1600,1200,"1024x1024")'));
  ck("编辑尺寸：比例一致时保留用户选择",
    w.eval('editOutputSize("gpt-image-2.5",1024,1024,"1024x1024")') === "1024x1024",
    w.eval('editOutputSize("gpt-image-2.5",1024,1024,"1024x1024")'));
  ck("编辑尺寸：auto 时保持 auto（接口按输入图出图，回贴靠 stretch 对齐）",
    w.eval('editOutputSize("nano-banana-pro",1600,1200,"auto")') === "auto",
    w.eval('editOutputSize("nano-banana-pro",1600,1200,"auto")'));

  /* 20) 二次确认层（扩图超限时挡住入队；UXP 没有 window.confirm） */
  const cfOv = d.getElementById("confirmOverlay");
  ck("确认层：默认隐藏", !!cfOv && cfOv.classList.contains("hidden"), "");
  const pAsk = w.askConfirm({
    head: "扩图超出模型上限", title: "测试标题",
    text: "第一行\n第二行", okText: "仍然继续", cancelText: "返回调整"
  });
  ck("确认层：打开后可见，且底层不绘制",
    !cfOv.classList.contains("hidden") && d.body.classList.contains("confirm-open"), "");
  ck("确认层：按钮文案按参数写入",
    d.getElementById("cfOk").textContent.length > 0 && d.getElementById("cfCancel").textContent.length > 0,
    d.getElementById("cfOk").textContent + " / " + d.getElementById("cfCancel").textContent);
  ck("确认层：正文按行写入（可逐行翻译）",
    d.getElementById("cfText").textContent.split("\n").length === 2,
    JSON.stringify(d.getElementById("cfText").textContent));
  d.getElementById("cfCancel").click();
  ck("确认层：取消返回 false 并关闭",
    (await pAsk) === false && cfOv.classList.contains("hidden") &&
    !d.body.classList.contains("confirm-open"), "");

  const pAsk2 = w.askConfirm({ title: "t" });
  d.getElementById("cfOk").click();
  ck("确认层：确认返回 true", (await pAsk2) === true, "");

  /* 21) 扩图超限确认：超限才弹，未超限直接放行 */
  const instOp = { id: "outpaint", modelUse: "edit" };
  const okPass = await w.confirmOutpaintLimit(instOp, {
    params: { expand: { mode: "pixels", px: { up: 10, right: 10, down: 10, left: 10 } } }
  });
  ck("扩图确认：未超限直接放行（不弹层）", okPass === true && cfOv.classList.contains("hidden"), "");
  ck("扩图确认：非扩图实例直接放行",
    (await w.confirmOutpaintLimit({ id: "text2img", modelUse: "gen" }, {})) === true, "");
  const pConf = w.confirmOutpaintLimit(instOp, {
    params: { expand: { mode: "pixels", px: { up: 500, right: 500, down: 500, left: 500 } } }
  });
  await new Promise((r) => setTimeout(r, 20));
  ck("扩图确认：超限时自动弹出确认层", !cfOv.classList.contains("hidden"), "");
  d.getElementById("cfCancel").click();
  ck("扩图确认：点「返回调整」→ false（不会入队）", (await pConf) === false, "");

  /* 22) 提示词粘贴 + 历史按钮禁用态（UXP 里 :disabled / title 都不可靠，走 class + 自绘浮层） */
  const taT = d.createElement("textarea");
  taT.value = "hello";
  let changed = 0;
  w.insertIntoTextarea(taT, " world", function () { changed++; });
  ck("粘贴：追加到末尾并触发 onChange", taT.value === "hello world" && changed === 1, taT.value);

  taT.value = "abcdef";
  try { taT.selectionStart = taT.selectionEnd = 3; } catch (e) { /* ignore */ }
  w.insertIntoTextarea(taT, "-X-", function () { changed++; });
  ck("粘贴：有光标时插到光标处", taT.value === "abc-X-def" && changed === 2, taT.value);

  ck("粘贴：页面里有「📋 粘贴」按钮",
    !!d.querySelector(".prompt-tools .p-btn"), "prompt-tools 未渲染");
  const cssTxt = d.querySelector("style") ? d.querySelector("style").textContent : "";
  ck("历史按钮：禁用态有独立 class 样式（不依赖 :disabled）",
    /\.hj-actions (button|\.btn)\.is-dis/.test(cssTxt), "缺 .hj-actions button.is-dis");
  ck("历史按钮：有自绘说明浮层样式", /\.hj-tip\s*\{/.test(cssTxt), "缺 .hj-tip");

  /* 23) 运行闸门：无选区时局部重绘放行（按整幅画面），换色仍要求选区 */
  w.eval("App.hasImageKey = true");
  w.eval("getSelectionBounds = async function () { return null; }");
  w.eval('getInstanceState("local_redraw").userText = "把背景换成海边";');
  const gGate = JSON.parse(await w.eval(
    '(async function () { return JSON.stringify(await evalRunGate(instById("local_redraw"))); })()'));
  ck("闸门：无选区时局部重绘可运行（按钮不锁死）", gGate.ok === true, JSON.stringify(gGate));
  ck("闸门：无选区时上下文提示「按整幅画面」",
    String(gGate.ctx || "").indexOf("按整幅画面") >= 0, String(gGate.ctx));
  const gColor = JSON.parse(await w.eval(
    '(async function () { return JSON.stringify(await evalRunGate(instById("recolor"))); })()'));
  ck("闸门：换色仍要求选区（该拦的还拦）",
    gColor.ok === false && /需要选区/.test(gColor.hint || ""), JSON.stringify(gColor));

  /* ---- 本机模型适配（换机器/Windows 后最常见的问题） ---- */
  const mm1 = w.eval('(function(){return comfyModelMatch("flux-2-klein-4b-Q8_0.gguf", ["Klein\\\\flux-2-klein-4b-Q4_K_M.gguf"]);})()');
  ck("适配：子目录 + 反斜杠 + 换了量化档也能对上",
    mm1 === "Klein\\flux-2-klein-4b-Q4_K_M.gguf", String(mm1));
  const mm2 = w.eval('(function(){return comfyModelMatch("FLUX.GGUF", ["flux.gguf"]);})()');
  ck("适配：大小写不敏感（NTFS 语义）", mm2 === "flux.gguf", String(mm2));
  const mm3 = w.eval('(function(){return comfyModelMatch("sdxl-base.safetensors", ["flux.gguf"]);})()');
  ck("适配：不同底模不会被硬套", mm3 === "", String(mm3));
  const mm4 = w.eval('(function(){return comfyModelMatch("klein.gguf", ["klein-a.gguf","klein-b.gguf"]);})()');
  ck("适配：两个候选都不确定时不猜（返回空）", mm4 === "", String(mm4));
  const sig = w.eval('(function(){' +
    'var a = comfyWorkflowModelSig({workflow:JSON.stringify({"1":{class_type:"UnetLoaderGGUF",inputs:{unet_name:"Klein\\\\m.gguf"}}})});' +
    'var b = comfyWorkflowModelSig({workflow:JSON.stringify({"1":{class_type:"UnetLoaderGGUF",inputs:{unet_name:"Klein/m.gguf"}}})});' +
    'return a + "||" + b;})()');
  ck("适配：同一模型的 \\ 与 / 写法归一到同一个分组键", sig.split("||")[0] === sig.split("||")[1], sig);

  const swap = JSON.parse(w.eval(`(function(){
    var wf = {
      "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "flux-2-klein-4b-Q8_0.gguf" } },
      "2": { class_type: "CLIPLoaderGGUF", inputs: { clip_name: "Qwen3-4B-Q6.gguf", type: "flux2" } },
      "4": { class_type: "CLIPTextEncode", inputs: { text: "" } }
    };
    var lists = { UNETLoader: ["Klein/flux-2-klein-4b-Q4_K_M.safetensors"], CLIPLoader: ["Qwen3-4B-Q8.safetensors"] };
    var req = {
      UNETLoader: { unet_name: [[ ]], weight_dtype: [["default","fp8"]] },
      CLIPLoader: { clip_name: [["Qwen3-4B-Q8.safetensors"]], type: [["flux2","sdxl"]] }
    };
    var probe = {
      has: function (c) { return c === "UNETLoader" || c === "CLIPLoader" || c === "CLIPTextEncode"; },
      required: function (c) { return req[c] || null; },
      list: function (c, f) { return lists[c] || []; }
    };
    return JSON.stringify(comfyAdaptWorkflow(JSON.stringify(wf), probe));
  })()`));
  const swapWf = JSON.parse(swap.workflow);
  ck("适配：本机没 GGUF 加载器 → 换成标准加载器",
    swapWf["1"].class_type === "UNETLoader" && swapWf["2"].class_type === "CLIPLoader",
    swapWf["1"].class_type + "/" + swapWf["2"].class_type);
  ck("适配：换加载器后模型名同步改写",
    swapWf["1"].inputs.unet_name === "Klein/flux-2-klein-4b-Q4_K_M.safetensors" &&
    swapWf["2"].inputs.clip_name === "Qwen3-4B-Q8.safetensors",
    swapWf["1"].inputs.unet_name + " | " + swapWf["2"].inputs.clip_name);
  ck("适配：补上新节点必填的默认参数（weight_dtype）",
    swapWf["1"].inputs.weight_dtype === "default", String(swapWf["1"].inputs.weight_dtype));
  ck("适配：原节点已有的参数不被覆盖（type=flux2）",
    swapWf["2"].inputs.type === "flux2", String(swapWf["2"].inputs.type));

  const miss = JSON.parse(w.eval(`(function(){
    var wf = { "1": { class_type: "SomeMissingNode", inputs: {} } };
    var probe = { has: function () { return false; }, required: function () { return null; }, list: function () { return []; } };
    return JSON.stringify(comfyAdaptWorkflow(JSON.stringify(wf), probe).missingClasses);
  })()`));
  ck("适配：既缺节点又换不了 → 明确报出来（不静默）", miss.indexOf("SomeMissingNode") >= 0, JSON.stringify(miss));

  /* ---- 适配落到存储：模拟一台 ComfyUI，验证「点一下就能改对」 ---- */
  w.eval(`(function(){
    var p = comfyEmptyPreset("适配测试模型");
    p.url = "http://127.0.0.1:8188";
    p.workflow = JSON.stringify({
      "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "flux-2-klein-4b-Q8_0.gguf" } },
      "9": { class_type: "SaveImage", inputs: { images: ["1", 0] } }
    });
    p.caps = ["t2i"];
    upsertComfyPreset(p);
  })()`);
  w.eval(`(function(){
    comfyProbe = async function () { return { ok: true, version: "test" }; };
    xhrRequest = async function (opt) {
      var m = String(opt.url || "").match(/object_info\\/(.+)$/);
      var cls = m ? decodeURIComponent(m[1]) : "";
      var lists = { UnetLoaderGGUF: ["Klein/flux-2-klein-4b-Q4_K_M.gguf", "qwen-image-Q4_K_M.gguf"] };
      if (lists[cls]) {
        var o = {}; o[cls] = { input: { required: { unet_name: [lists[cls]] } } };
        return { status: 200, response: JSON.stringify(o) };
      }
      return { status: 404, response: "{}" };
    };
  })()`);
  const adaptRun = JSON.parse(await w.eval(
    '(async function () { return JSON.stringify(await comfyAdaptStore(true)); })()'));
  const wfAfter = JSON.parse(w.eval('(function(){' +
    'var hit = getComfyPresets().filter(function(p){return p.name==="适配测试模型";})[0];' +
    'return JSON.stringify(hit ? hit.workflow : "{}");})()'));
  ck("适配：点一下就把预设改成本机文件（并落盘）",
    JSON.parse(wfAfter)["1"].inputs.unet_name === "Klein/flux-2-klein-4b-Q4_K_M.gguf",
    JSON.parse(wfAfter)["1"].inputs.unet_name);
  const hitAdapt = adaptRun.adapted.filter(function (a) { return a.name === "适配测试模型"; })[0];
  ck("适配：返回结果里带上改动明细（改了哪个节点→改成什么）",
    !!hitAdapt && hitAdapt.changes.length === 1 && hitAdapt.changes[0].node === "1",
    JSON.stringify(hitAdapt || adaptRun.adapted.length));

  /* 本机完全没有这个模型时：必须报「缺模型文件 + 本机有哪些」，不能算「无需改动」 */
  w.eval(`(function(){
    var p = comfyEmptyPreset("缺模型测试");
    p.url = "http://127.0.0.1:8188";
    p.workflow = JSON.stringify({
      "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: "sdxl-base.safetensors" } }
    });
    p.caps = ["t2i"];
    upsertComfyPreset(p);
  })()`);
  const adaptMiss = JSON.parse(await w.eval(
    '(async function () { return JSON.stringify(await comfyAdaptStore(true)); })()'));
  const missRec = adaptMiss.missing.filter(function (m) { return m.name === "缺模型测试"; })[0];
  ck("适配：本机没有该模型时明确报缺（不静默当成一致）",
    !!missRec && missRec.files.length === 1 && missRec.files[0].name === "sdxl-base.safetensors",
    JSON.stringify(missRec || adaptMiss.missing));
  ck("适配：顺带告诉用户本机有哪些同类文件",
    !!missRec && missRec.files[0].available.indexOf("Klein/flux-2-klein-4b-Q4_K_M.gguf") >= 0,
    missRec ? JSON.stringify(missRec.files[0].available) : "");
  const summary = w.eval('(function(){ return comfyAdaptSummary(' + JSON.stringify(adaptMiss) + '); })()');
  ck("适配：提示本机还有哪些模型没配工作流",
    adaptMiss.extra.indexOf("qwen-image-Q4_K_M.gguf") >= 0, JSON.stringify(adaptMiss.extra));
  ck("适配：状态行读得懂（缺什么 + 本机有什么）",
    summary.indexOf("缺模型文件") >= 0 && summary.indexOf("本机有") >= 0, summary);

  /* ---- 通用 Checkpoint 模板：换模型不用重导工作流 ---- */
  const genTpl = JSON.parse(w.eval('(function(){return JSON.stringify(COMFY_TEMPLATES.filter(function(t){return t.key==="generic-ckpt-t2i";})[0]);})()'));
  ck("模板：内置「通用 Checkpoint 文生图」", !!genTpl && genTpl.name.indexOf("通用") === 0, genTpl ? genTpl.name : "无");
  const genWf = JSON.parse(genTpl.workflow);
  ck("模板：通用 checkpoint 不写死模型名（留空待适配）",
    genWf["1"].class_type === "CheckpointLoaderSimple" && genWf["1"].inputs.ckpt_name === "",
    genWf["1"].class_type + "/" + JSON.stringify(genWf["1"].inputs.ckpt_name));
  ck("模板：通用模板带 NEGATIVE / SIZE / OUTPUT 角色",
    genTpl.roles.negative === "2" && genTpl.roles.size === "5" && genTpl.roles.output === "8",
    JSON.stringify(genTpl.roles));

  const autoFill = JSON.parse(w.eval(`(function(){
    var wf = JSON.parse(COMFY_TEMPLATES.filter(function(t){return t.key==="generic-ckpt-t2i";})[0].workflow);
    var probe = {
      has: function(){ return true; }, required: function(){ return null; },
      list: function(c,f){ return (c === "CheckpointLoaderSimple" && f === "ckpt_name") ? ["SDXL/base.safetensors","SD15/other.safetensors"] : []; }
    };
    return JSON.stringify(comfyAdaptWorkflow(JSON.stringify(wf), probe));
  })()`));
  ck("适配：留空的 checkpoint 自动选中本机第一个",
    JSON.parse(autoFill.workflow)["1"].inputs.ckpt_name === "SDXL/base.safetensors" &&
    autoFill.changes.length === 1 && autoFill.changes[0].kind === "auto",
    JSON.parse(autoFill.workflow)["1"].inputs.ckpt_name + " / " + JSON.stringify(autoFill.changes));

  w.eval(`(function(){
    xhrRequest = async function (opt) {
      if (String(opt.url).indexOf("/object_info/CheckpointLoaderSimple") >= 0) {
        var o = { CheckpointLoaderSimple: { input: { required: { ckpt_name: [["SDXL/base.safetensors","SD15/other.safetensors"]] } } } };
        return { status: 200, response: JSON.stringify(o) };
      }
      return { status: 404, response: "{}" };
    };
  })()`);
  const fixed = JSON.parse(await w.eval(`(async function(){
    var wf = { "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "gone.safetensors" } } };
    var n = await comfyRunFixModels(wf, "http://127.0.0.1:7777");
    return JSON.stringify({ n: n, name: wf["1"].inputs.ckpt_name });
  })()`));
  ck("运行兜底：本机没有的模型自动换成可用的（换机器免再适配）",
    fixed.n === 1 && fixed.name === "SDXL/base.safetensors", JSON.stringify(fixed));
  const kept = JSON.parse(await w.eval(`(async function(){
    var wf = { "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "SD15/other.safetensors" } } };
    var n = await comfyRunFixModels(wf, "http://127.0.0.1:7777");
    return JSON.stringify({ n: n, name: wf["1"].inputs.ckpt_name });
  })()`));
  ck("运行兜底：本机有的模型原样保留（不乱换）",
    kept.n === 0 && kept.name === "SD15/other.safetensors", JSON.stringify(kept));

  ck("页面无 JS 运行时错误", errors.length === 0, errors.join(" | "));

  console.log("\n结果：PASS " + pass + " · FAIL " + fail);
  process.exit(process.exitCode || 0);
})().catch(function (e) {
  console.log("FAIL | 测试异常 -> " + (e && e.stack || e));
  process.exit(1);
});

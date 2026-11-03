/*
 * test-dev-ui.cjs — P1 开发者工作台冒烟测试（jsdom）
 *
 * 运行：
 *   NODE_PATH=<node_modules> \
 *     node bench/test-dev-ui.cjs
 */
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.resolve(__dirname, "../ps-spark-plugin");
const RELEASE = path.resolve(__dirname, "../dist/ps-spark");

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
  "const __doc = { id: 1, name: '测试.psd', width: 1080, height: 810, resolution: 72, layers: [], activeLayers: [] };",
  "const __folder = { getEntry: async function(){ throw new Error('no'); }, createFile: async function(n){ return { name:n, read:async function(){ return new ArrayBuffer(4); }, write:async function(){}, copyTo:async function(){} }; } };",
  "window.require = function (m) {",
  "  if (m === 'photoshop') return { app: { activeDocument: __doc, documents: [__doc] }, core: { executeAsModal: async function(fn){ return fn(); } }, action: { batchPlay: async function(){ return [{}]; } }, imaging: {} };",
  "  if (m === 'uxp') return { storage: { localFileSystem: __folder, secureStorage: { getItem: async function(){ return null; }, setItem: async function(){}, removeItem: async function(){} }, formats: { utf8:'utf8', binary:'binary' } } };",
  "  throw new Error('unknown module ' + m);",
  "};"
].join("\n");
w.document.body.appendChild(stub);

/* 源码默认语言已改为 en；本套件的文案断言以中文为基线，在加载脚本前固定 zh */
w.localStorage.setItem("psspark.lang", "zh");

["brand.js", "diag.js", "services.js", "i18n.js", "api.js", "ps.js", "registry.js", "ui.js", "store.js", "app.js", "dev/bench.js", "dev/devmode.js"].forEach(function (f) {
  const s = w.document.createElement("script");
  s.textContent = fs.readFileSync(path.join(ROOT, "js", f), "utf8");
  w.document.body.appendChild(s);
});

setTimeout(function () {
  const d = w.document;

  /* 0) 设置 ▸ 功能说明：整个描述区一个折叠开关 */
  w.eval("fillSettingsForm()");
  const helpItems = d.querySelectorAll("#helpList .help-item");
  ck("功能说明：渲染 16 项", helpItems.length === 16, String(helpItems.length));
  ck("功能说明：不再有单项折叠按钮", d.querySelectorAll("#helpList .help-fold").length === 0, "");
  ck("功能说明：内层小折叠已移除", !d.getElementById("helpList").classList.contains("collapsed"), "");
  ck("功能说明：分区默认折叠", d.getElementById("secHelp").classList.contains("sec-collapsed"), "");
  const helpLegend = d.querySelector("#secHelp legend");
  helpLegend.dispatchEvent(new w.Event("click"));
  ck("功能说明：点标题整体展开", !d.getElementById("secHelp").classList.contains("sec-collapsed"), "");
  helpLegend.dispatchEvent(new w.Event("click"));
  ck("功能说明：再点整体折叠", d.getElementById("secHelp").classList.contains("sec-collapsed"), "");
  ck("功能说明：旧的内层按钮已隐藏", d.querySelector(".help-master").classList.contains("hidden"), "");

  /* 1) 设置页入口 */
  ck("开发构建：设置页出现「开发者」区块", !!d.getElementById("secDev"), "");
  ck("开发构建：开关默认关闭", d.getElementById("devEnabled").checked === false, "");
  ck("开发构建：工作台尚未注入 DOM", !d.getElementById("devWorkbench"), "");

  /* 2) 打开开关 */
  const cb = d.getElementById("devEnabled");
  cb.checked = true;
  cb.dispatchEvent(new w.Event("change"));
  ck("开关：写入 localStorage", w.localStorage.getItem("psspark.dev.enabled") === "1", String(w.localStorage.getItem("psspark.dev.enabled")));
  ck("开关：打开工作台按钮启用", d.getElementById("btnDevOpen").disabled === false, "");

  /* 3) 打开工作台 */
  d.getElementById("btnDevOpen").dispatchEvent(new w.Event("click"));
  const wb = d.getElementById("devWorkbench");
  ck("工作台：已注入并可见", !!wb && !wb.classList.contains("hidden"), "");
  ck("工作台：设置层被隐藏", d.getElementById("settingsOverlay").classList.contains("hidden"), "");

  const items = wb.querySelectorAll(".dw-item");
  ck("功能列表：16 项", items.length === 16, String(items.length));
  ck("功能列表：5 个分组标题", wb.querySelectorAll(".dw-group").length === 5, String(wb.querySelectorAll(".dw-group").length));
  ck("模型下拉：已渲染", d.querySelectorAll("#dwModel .dd-item").length >= 5,
    String(d.querySelectorAll("#dwModel .dd-item").length));

  /* 3.1) 单列 Tab 布局：任何时刻只允许一个 pane 可见（窄面板防重叠） */
  function visiblePanes() {
    return ["dwPaneList", "dwPaneSpec", "dwPaneBench"].filter(function (id) {
      return !d.getElementById(id).classList.contains("hidden");
    });
  }
  ck("布局：默认显示「模板」面板", visiblePanes().length === 1 && visiblePanes()[0] === "dwPaneSpec",
    visiblePanes().join(","));
  d.getElementById("dwTabList").dispatchEvent(new w.Event("click"));
  ck("布局：切到「功能」只显示列表", visiblePanes().length === 1 && visiblePanes()[0] === "dwPaneList",
    visiblePanes().join(","));
  d.getElementById("dwTabBench").dispatchEvent(new w.Event("click"));
  ck("布局：切到「基准」只显示基准", visiblePanes().length === 1 && visiblePanes()[0] === "dwPaneBench",
    visiblePanes().join(","));
  d.getElementById("dwTabSpec").dispatchEvent(new w.Event("click"));
  ck("布局：Tab 按钮高亮唯一", wb.querySelectorAll(".dw-tab.active").length === 1,
    String(wb.querySelectorAll(".dw-tab.active").length));

  /* 4) 选中原位合成，检查分支 */
  d.getElementById("dwTabList").dispatchEvent(new w.Event("click"));
  const target = Array.prototype.filter.call(items, function (n) { return n.textContent === "原位合成"; })[0];
  ck("功能列表：存在原位合成", !!target, "");
  if (target) target.dispatchEvent(new w.Event("click"));
  ck("布局：选中功能后自动回到「模板」", visiblePanes().length === 1 && visiblePanes()[0] === "dwPaneSpec",
    visiblePanes().join(","));
  const branchHost = d.getElementById("dwBranch");
  ck("分支：原位合成有 3 个分支", branchHost.querySelectorAll(".dd-item").length === 3,
    String(branchHost.querySelectorAll(".dd-item").length));
  ck("分支：默认第一个为「无资产」", /无资产/.test(branchHost.querySelector(".dd-val").textContent),
    branchHost.querySelector(".dd-val").textContent);

  /* 5) 切到对齐分支（自定义下拉：点选项），检查模板与预览 */
  const alignedOpt = Array.prototype.filter.call(branchHost.querySelectorAll(".dd-item"), function (n) {
    return /画布对齐/.test(n.textContent);
  })[0];
  ck("分支：存在「画布对齐」选项", !!alignedOpt, "");
  if (alignedOpt) alignedOpt.dispatchEvent(new w.Event("click"));
  function partValues() {
    return Array.prototype.map.call(d.querySelectorAll("#dwParts textarea"), function (t) { return t.value; }).join("\n");
  }
  const parts = partValues();
  ck("模板：对齐分支含【对齐】约束", /【对齐】/.test(parts), parts.slice(0, 40));
  ck("模板：段落以可编辑输入框呈现", d.querySelectorAll("#dwParts textarea").length >= 5,
    String(d.querySelectorAll("#dwParts textarea").length));
  const sample = d.getElementById("dwSample");
  sample.value = "把杯子和花瓶合进这个场景";
  sample.dispatchEvent(new w.Event("input"));
  const preview = d.getElementById("dwPreview").textContent;
  ck("预览：包含样例输入", /把杯子和花瓶合进这个场景/.test(preview), preview.slice(0, 60));
  ck("预览：包含对齐约束", /【对齐】/.test(preview), "");

  /* 5.5) P2：编辑 → 实时预览 → 保存 → 覆盖生效 → 恢复默认 */
  const ta0 = d.querySelector("#dwParts textarea");
  ta0.value = "自定义：把资产自然合入底图，并保留 {{user}} 的描述。";
  ta0.dispatchEvent(new w.Event("input"));
  ck("P2 编辑：预览实时更新", /自定义：把资产自然合入底图/.test(d.getElementById("dwPreview").textContent), "");
  ck("P2 编辑：保存按钮启用", d.getElementById("dwSave").disabled === false, "");
  ck("P2 编辑：状态提示未保存", /未保存/.test(d.getElementById("dwStatus").textContent), d.getElementById("dwStatus").textContent);

  d.getElementById("dwSave").dispatchEvent(new w.Event("click"));
  const ovRaw = w.localStorage.getItem("psspark.dev.prompt.composite.aligned");
  ck("P2 保存：写入本机覆盖", !!ovRaw && /自定义/.test(ovRaw), ovRaw ? "ok" : "null");
  ck("P2 保存：状态提示已保存", /已保存/.test(d.getElementById("dwStatus").textContent), d.getElementById("dwStatus").textContent);
  ck("P2 保存：功能列表出现「改」标记", /改/.test(d.querySelector("#dwList .dw-item.active").textContent), "");

  const built = w.eval("buildFinalPrompt")(
    w.eval('instById("composite")'), "样例描述", null, {},
    null, { hasAsset: true, aligned: true }
  );
  ck("P2 生效：实际发送链路使用自定义模板", /自定义：把资产自然合入底图/.test(built), built.slice(0, 50));
  ck("P2 生效：变量已插值", /样例描述/.test(built), "");

  d.getElementById("dwReset").dispatchEvent(new w.Event("click"));
  ck("P2 恢复默认：覆盖已删除", !w.localStorage.getItem("psspark.dev.prompt.composite.aligned"), "");
  const built2 = w.eval("buildFinalPrompt")(
    w.eval('instById("composite")'), "样例描述", null, {},
    null, { hasAsset: true, aligned: true }
  );
  ck("P2 恢复默认：回到内置模板", !/自定义/.test(built2) && /【对齐】/.test(built2), built2.slice(0, 40));

  /* 6) 返回设置 */
  d.getElementById("dwBack").dispatchEvent(new w.Event("click"));
  ck("返回：工作台隐藏", d.getElementById("devWorkbench").classList.contains("hidden"), "");
  ck("返回：设置层恢复", !d.getElementById("settingsOverlay").classList.contains("hidden"), "");

  /* 6.5) 滚动条占位：切页时不能因为「这页会滚、那页不滚」而让右边线跳 */
  const cssSrc = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  ck("滚动条：主区固定预留槽位（overflow-y:scroll）",
    /#main\s*\{[^}]*overflow-y:\s*scroll/.test(cssSrc), "");
  ck("滚动条：设置页同样固定预留", /\.overlay-body\s*\{[^}]*overflow-y:\s*scroll/.test(cssSrc), "");
  ck("滚动条：顶栏右缘按 --sbw 补偿", /#topbar\s*\{[^}]*var\(--sbw\)/.test(cssSrc), "");
  ck("滚动条：底栏右缘按 --sbw 补偿", /#bottom\s*\{[^}]*var\(--sbw\)/.test(cssSrc), "");
  ck("滚动条：队列条右缘按 --sbw 补偿", /#queueWrap\s*\{[^}]*var\(--sbw\)/.test(cssSrc), "");
  ck("间距：卡片内边距统一走 --pad", /\.card\s*\{[^}]*padding:\s*var\(--pad\)/.test(cssSrc), "");
  try {
    w.syncScrollGutter();
    ck("滚动条：同步函数可调用且不抛错", true, "");
  } catch (e) {
    ck("滚动条：同步函数可调用且不抛错", false, String(e && e.message));
  }

  /* 6.6) 品牌与开源信息（brand.js） */
  const tipText = d.getElementById("ossTipText").textContent;
  const tipBox = d.getElementById("ossTip");
  const REPO = "https://github.com/henry-cao1/ps-spark";
  ck("品牌：仓库公开后提示条写已开源并带仓库名", /已开源/.test(tipText) && tipText.indexOf("henry-cao1/ps-spark") >= 0, tipText);
  ck("品牌：提示条 title 带完整仓库地址并可点击", tipBox.title.indexOf(REPO) >= 0 && tipBox.title.indexOf("点击打开源码仓库") >= 0, tipBox.title);
  ck("品牌：版本行按 public 标志显示已开源", /已开源/.test(d.getElementById("versionInfo").textContent), d.getElementById("versionInfo").textContent);
  ck("品牌：public 标志为 true（仓库已公开）", w.eval("typeof BRAND !== 'undefined' && BRAND.public === true && brandIsPublic() === true"), "");

  const projRoot = path.resolve(__dirname, "..");
  ["LICENSE", "NOTICE", "README.md"].forEach(function (f) {
    const s = fs.readFileSync(path.join(projRoot, f), "utf8");
    ck(f + "：版权人为 Cao 且不含占位符",
      s.indexOf("Copyright (C) 2026 Cao") >= 0 && s.indexOf("YOUR_ORG") < 0 && s.indexOf("PS Spark Contributors") < 0,
      "");
  });
  ck("LICENSE/NOTICE：含源码仓库地址",
    fs.readFileSync(path.join(projRoot, "LICENSE"), "utf8").indexOf(REPO) >= 0 &&
    fs.readFileSync(path.join(projRoot, "NOTICE"), "utf8").indexOf(REPO) >= 0, "");

  /* 6.7) 多语言：静态文案全部有英文对照 + 切换可逆 */
  const htmlSrc = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const fresh = new JSDOM(htmlSrc.replace(/<script[\s\S]*?<\/script>/g, ""));
  const fd = fresh.window.document;
  const dict = w.eval("I18N.dict.en");
  const missing = [];
  const tw = fd.createTreeWalker(fd.body, 4, null);
  let tn = tw.nextNode();
  while (tn) {
    const z = tn.nodeValue.trim();
    if (/[\u4e00-\u9fa5]/.test(z) && !dict[z]) missing.push(z);
    tn = tw.nextNode();
  }
  ["placeholder", "title", "alt"].forEach(function (a) {
    fd.querySelectorAll("[" + a + "]").forEach(function (el) {
      const v = el.getAttribute(a);
      if (v && /[\u4e00-\u9fa5]/.test(v) && !dict[v]) missing.push(a + "=" + v);
    });
  });
  ck("i18n：静态文案全部有英文对照", missing.length === 0, missing.slice(0, 3).join(" | "));

  const tabs = function () {
    return Array.prototype.map.call(d.querySelectorAll("#topbar .tab[data-tab]"), function (x) { return x.textContent; }).join(",");
  };
  w.eval("i18nSetLang('zh'); i18nSetLang('en')");
  ck("i18n：切英文后顶栏变为英文", tabs() === "Generate,Edit,Split,History", tabs());
  ck("i18n：设置页标题翻译", d.querySelector("#settingsOverlay .t").textContent === "Settings",
    d.querySelector("#settingsOverlay .t").textContent);
  ck("i18n：placeholder 被翻译", d.getElementById("apiKey").getAttribute("placeholder").indexOf("saved locally") >= 0,
    d.getElementById("apiKey").getAttribute("placeholder"));
  ck("i18n：语言写入 localStorage", w.localStorage.getItem("psspark.lang") === "en", String(w.localStorage.getItem("psspark.lang")));
  /* 切换后再渲染（真实场景：点 chip / 重开设置）——必须同样全英文，不依赖事后补翻 */
  w.eval("App.genInstance='similar'; renderGenView(); renderEditView(); renderDecompView(); renderHistoryView(); fillSettingsForm(); renderHelpList();");
  const residual = [];
  Array.prototype.forEach.call(d.querySelectorAll("#main *, #settingsBody *, #queueWrap *"), function (el) {
    if (el.children.length) return;
    if (el.closest && el.closest("#secDev")) return; /* 仅开发构建，发布版不存在 */
    const tx = el.textContent.trim();
    if (!tx || !/[\u4e00-\u9fa5]/.test(tx)) return;
    if (tx === "Interface language / 界面语言" || tx === "Language / 语言") return;
    if (tx === "中文 / Chinese" || /^本地模型 \d+ \(/.test(tx)) return; /* 双语选项 + 用户自定义预设名 */
    residual.push(tx + "@" + ((el.closest("[id]") || {}).id || "?") +
      "/" + (el.parentElement ? el.parentElement.className : "") +
      "/" + (el.className || ""));
  });
  ck("i18n：英文模式无残留中文（语言标签除外）", residual.length === 0, residual.slice(0, 4).join(" | "));

  /* 运行条 / 参数勾选：这些文本带子元素，前面的叶子扫描覆盖不到 */
  w.eval("App.tab='edit';App.editGroup='redraw';App.editInstance='local_redraw';renderEditView();");
  const runBtn = d.querySelector("#editHost .run-btn");
  const modelTag = d.querySelector("#editHost .model-tag");
  const costBadge = d.querySelector("#editHost .cost-badge");
  ck("i18n：运行按钮 / 模型 / 开销已翻译",
    !!runBtn && runBtn.textContent === "Redraw" &&
    !!modelTag && modelTag.textContent.indexOf("Model:") === 0 &&
    !!costBadge && costBadge.textContent.indexOf("image ×") === 0,
    [runBtn && runBtn.textContent, modelTag && modelTag.textContent, costBadge && costBadge.textContent].join(" | "));
  const zhCheck = Array.prototype.some.call(d.querySelectorAll("#editHost label.check"), function (l) {
    return /[\u4e00-\u9fa5]/.test(l.textContent);
  });
  ck("i18n：参数勾选项已翻译", !zhCheck, "");

  const zhIn = function (sel) {
    const out = [];
    Array.prototype.forEach.call(d.querySelectorAll(sel + " *"), function (el) {
      if (el.children.length) return;
      const tx = el.textContent.trim();
      if (/[\u4e00-\u9fa5]/.test(tx)) out.push(tx);
    });
    return out;
  };
  w.eval("App.tab='decomp';App.decomp.step=2;App.decomp.layers=[{name:'背景',desc:'',bg:true,checked:true}];renderDecompView();");
  ck("i18n：拆图蓝图步骤无残留中文", zhIn("#view-decomp").length === 0, zhIn("#view-decomp").slice(0, 3).join(" | "));
  w.eval("App.decomp.step=3;renderDecompView();");
  ck("i18n：拆图执行步骤无残留中文", zhIn("#view-decomp").length === 0, zhIn("#view-decomp").slice(0, 3).join(" | "));
  w.eval("App.tab='edit';App.editGroup='creative';App.editInstance='composite';renderEditView();");
  ck("i18n：原位合成面板无残留中文", zhIn("#editHost").length === 0, zhIn("#editHost").slice(0, 3).join(" | "));
  w.eval("App.tab='gen';App.genInstance='text2img';renderGenView();");
  w.eval("i18nSetLang('zh')");
  ck("i18n：切回中文可还原", tabs() === "生成,编辑,拆图,历史" &&
    d.getElementById("apiKey").getAttribute("placeholder").indexOf("填写后自动保存") >= 0, tabs());
  w.eval("App.tab='edit';App.editGroup='redraw';App.editInstance='local_redraw';renderEditView();");
  const zhRun = d.querySelector("#editHost .run-btn");
  const zhHint = d.querySelector("#editHost .rb-hint");
  ck("i18n：中文模式下运行条保持中文",
    !!zhRun && zhRun.textContent === "重 绘" &&
    w.eval("i18nText('此功能需要选区：请先用选区工具框出区域')==='此功能需要选区：请先用选区工具框出区域'"),
    [zhRun && zhRun.textContent, zhHint && zhHint.textContent].join(" | "));
  w.eval("App.tab='gen';App.genInstance='text2img';renderGenView();");
  ck("i18n：英文下渲染的面板切回中文可还原",
    w.eval("(function(){i18nSetLang('en');renderGenView();" +
      "var c=document.querySelector('#genChips .chip'),en=c?c.textContent:'';" +
      "i18nSetLang('zh');return en==='Text to image'&&c&&c.textContent==='文生图';})()"),
    d.querySelector("#genChips .chip") ? d.querySelector("#genChips .chip").textContent : "?");
  ck("i18n：默认英文构建启动即为英文",
    w.eval("(function(){localStorage.removeItem('psspark.lang');var o=BRAND.defaultLang;BRAND.defaultLang='en';var l=i18nInit();var tab=document.querySelector('#topbar .tab').textContent;BRAND.defaultLang=o;i18nSetLang('zh');return l==='en'&&tab==='Generate';})()"), "");
  ck("i18n：BRAND.defaultLang=en 时默认英文",
    w.eval("(function(){var o=BRAND.defaultLang;BRAND.defaultLang='en';var v=i18nDefaultLang();BRAND.defaultLang=o;return v==='en';})()"), "");
  ck("i18n：本机保存的语言优先于默认值",
    w.eval("(function(){localStorage.setItem('psspark.lang','zh');var v=i18nSavedLang();localStorage.removeItem('psspark.lang');return v==='zh';})()"), "");

  /* 6c) 扩图面板：百分比/像素两种口径 + 超限警告，英文模式下也要全英文 */
  w.eval("i18nSetLang('en')");
  w.eval("App.tab='edit'; App.editGroup='struct'; App.editInstance='outpaint';" +
    "getInstanceState('outpaint').params = Object.assign({}, getInstanceState('outpaint').params," +
    "{ expand: { mode: 'percent', left: 100, right: 100, up: 100, down: 100 } }); renderEditView();");
  const opHost = d.getElementById("editHost");
  const opWarn = opHost.querySelector(".warn-note");
  ck("扩图面板：超限时给出警告", !!opWarn && opWarn.textContent.indexOf("⚠") === 0,
    opWarn ? opWarn.textContent.slice(0, 60) : "(none)");
  const opZh = Array.prototype.filter.call(opHost.querySelectorAll("*"), function (e) {
    return e.children.length === 0 && e.textContent.trim() && /[\u4e00-\u9fa5]/.test(e.textContent);
  }).map(function (e) { return e.textContent.trim(); });
  ck("i18n：扩图面板（含超限警告）无残留中文", opZh.length === 0, opZh.slice(0, 3).join(" | "));

  /* 6d) 二次确认层（扩图超限）：标题/正文/按钮在英文模式下也要全英文 */
  w.eval("askConfirm({ head: '扩图超出模型上限', title: '这张图会先缩小再放大，效果可能打折'," +
    " text: '扩展后画布 2272×2272 超出「gpt-image-2」的原生处理能力。\\n" +
    "· 超过上限 1920px（当前 2272px，多出 352px）'," +
    " okText: '仍然继续', cancelText: '返回调整' })");
  const cfZh = ["cfHead", "cfTitle", "cfText", "cfOk", "cfCancel"].map(function (id) {
    const el2 = d.getElementById(id);
    return el2 ? el2.textContent : "";
  }).filter(function (t) { return /[\u4e00-\u9fa5]/.test(t); });
  ck("i18n：确认层（标题/正文/按钮）无残留中文", cfZh.length === 0, cfZh.join(" | "));
  ck("i18n：确认层按钮已翻译",
    d.getElementById("cfOk").textContent === "Continue anyway" &&
    d.getElementById("cfCancel").textContent === "Back to adjust",
    d.getElementById("cfOk").textContent + " / " + d.getElementById("cfCancel").textContent);
  d.getElementById("cfCancel").click();

  w.eval("App.editInstance=''; i18nSetLang('zh')");

  ck("页面无 JS 运行时错误", errors.length === 0, errors.join(" | "));

  /* 7) 发布包隔离（若已构建） */
  if (fs.existsSync(RELEASE)) {
    const relHtml = fs.readFileSync(path.join(RELEASE, "index.html"), "utf8");
    ck("发布包：无 devmode 脚本引用", relHtml.indexOf("devmode") < 0, "");
    ck("发布包：无 DEV 标记", relHtml.indexOf("DEV:") < 0, "");
    ck("发布包：无 js/dev 目录", !fs.existsSync(path.join(RELEASE, "js", "dev")), "");
    const jsDir = path.join(RELEASE, "js");
    let leaked = [];
    fs.readdirSync(jsDir).filter(function (f) { return f.endsWith(".js"); }).forEach(function (f) {
      const s = fs.readFileSync(path.join(jsDir, f), "utf8");
      if (/DevMode|psspark\.dev\.|devWorkbench|开发者工作台/.test(s)) leaked.push(f);
    });
    ck("发布包：JS 无开发者模式标识", leaked.length === 0, leaked.join(","));
    const relBrand = fs.readFileSync(path.join(RELEASE, "js", "brand.js"), "utf8");
    ck("发布包：默认语言为中文", /built = "zh"/.test(relBrand), "");
  }

  /* 8) 开源（GitHub）构建：默认英文 */
  const OSS = path.resolve(__dirname, "../dist/oss/ps-spark");
  if (fs.existsSync(OSS)) {
    const ossBrand = fs.readFileSync(path.join(OSS, "js", "brand.js"), "utf8");
    ck("oss 构建：默认语言为英文", /built = "en"/.test(ossBrand), "");
    ck("oss 构建：不含开发标记", !fs.existsSync(path.join(OSS, "js", "dev")), "");
  }

  console.log("\n结果：PASS " + pass + " · FAIL " + fail);
  process.exit(process.exitCode || 0);
}, 200);

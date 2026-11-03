/*
 * devmode.js — 开发者模式（仅开发构建加载）
 *
 * 设计约束：
 *   1. 所有 DOM / 样式在运行时创建，index.html 不出现任何开发者入口；
 *   2. 发布构建不打包本文件，并会扫描产物中的 DevMode / psspark.dev. 等标记；
 *   3. P2 已开放逐段编辑、变量校验、保存 / 恢复默认 / 试跑，覆盖写 localStorage
 *      并通过 setPromptOverrideProvider 进入真实生成链路；P3 接基准测试。
 */
(function () {
  "use strict";

  var DEV_CHANNEL = "__DEV_CHANNEL__" !== "false";
  var KEY_ENABLED = "psspark.dev.enabled";
  var KEY_LAST = "psspark.dev.lastInst";
  if (!DEV_CHANNEL) return;

  var state = { instId: null, branchId: null, query: "", tab: "spec" };
  var built = false;
  var modelDD = null;

  /* ---------------- 基础工具 ---------------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function withVars(s) {
    return esc(s).replace(/\{\{(\w+)\}\}/g, '<span class="dw-var">{{$1}}</span>');
  }
  function readFlag() {
    try { return localStorage.getItem(KEY_ENABLED) === "1"; } catch (e) { return false; }
  }
  function writeFlag(on) {
    try { localStorage.setItem(KEY_ENABLED, on ? "1" : "0"); } catch (e) { /* ignore */ }
  }

  /* ---------------- 样式（只注入一次） ---------------- */

  function injectStyle() {
    if (document.getElementById("dwStyle")) return;
    var st = document.createElement("style");
    st.id = "dwStyle";
    st.textContent = [
      /* 整层覆盖：四边拉伸而不是 width/height:100%，UXP 对百分比高度解析不稳 */
      "#devWorkbench{position:absolute;top:0;left:0;right:0;bottom:0;background:var(--bg);z-index:25;display:flex;flex-direction:column;overflow:hidden;}",
      /* 底层用 display:none 彻底不参与绘制：UXP 对绝对定位覆盖层重绘不可靠，visibility:hidden 仍会穿透 */
      "body.dev-open #settingsOverlay,body.dev-open #topbar,body.dev-open #main,body.dev-open #bottom{display:none !important;}",
      ".dw-head{display:flex;align-items:center;gap:8px;padding:8px;border-bottom:1px solid var(--border);flex-shrink:0;overflow:hidden;}",
      ".dw-head button{padding:4px 10px;border-radius:5px;border:1px solid var(--border);background:var(--panel);color:var(--text);cursor:pointer;font:inherit;flex:0 0 auto;}",
      ".dw-title{font-weight:600;font-size:12px;white-space:nowrap;}",
      ".dw-badge{font-size:10px;color:#fff;background:var(--accent);border-radius:3px;padding:1px 5px;flex:0 0 auto;}",
      ".dw-ver{margin-left:auto;color:var(--dim);font-size:10px;white-space:nowrap;}",
      /* Tab：窄面板下唯一可靠的分区方式（不用三栏 + wrap） */
      ".dw-tabs{display:flex;padding:6px 8px 0;flex-shrink:0;}",
      ".dw-tab{flex:1 1 0%;min-width:0;margin-right:4px;padding:6px 0;border:1px solid var(--border);border-bottom:none;border-radius:6px 6px 0 0;background:var(--panel2);color:var(--dim);font:inherit;font-size:11px;cursor:pointer;}",
      ".dw-tab:last-child{margin-right:0;}",
      ".dw-tab.active{background:var(--panel);color:var(--text);}",
      ".dw-body{position:relative;flex:1;min-height:0;margin:0 8px 8px;border:1px solid var(--border);border-radius:0 6px 6px 6px;overflow:hidden;background:var(--panel2);}",
      /* 面板用普通块级流，不用纵向 flex：UXP 的 flex 引擎会把输入框压成一条线（实测） */
      /* 四边拉伸定位，保证滚动区高度确定；height:100% 在 UXP 内层容器不可靠 */
      ".dw-pane{position:absolute;top:0;left:0;right:0;bottom:0;padding:8px 8px 12px;overflow-y:auto;}",
      /* 输入框显式给高度，不依赖 flex/line-height 推算（只作用于文本框，别碰 checkbox） */
      ".dw-pane input[type=text]{display:block;width:100%;height:30px;min-height:30px;line-height:18px;padding:5px 6px;}",
      ".dw-cap{color:var(--dim);font-size:10px;margin:2px 0 5px;}",
      ".dw-list{margin-top:6px;}",
      ".dw-group{color:var(--dim);font-size:10px;margin:9px 0 3px;}",
      ".dw-item{display:flex;align-items:center;padding:5px 6px;border-radius:4px;cursor:pointer;font-size:11px;}",
      ".dw-item .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".dw-dot{flex:0 0 auto;margin-left:4px;font-size:9px;line-height:1.5;color:var(--accent-hover);border:1px solid var(--accent);border-radius:3px;padding:0 3px;}",
      ".dw-item:hover{background:var(--panel);}",
      ".dw-item.active{background:var(--accent);color:#fff;}",
      ".dw-inst-head{display:flex;align-items:baseline;gap:6px;margin-bottom:6px;}",
      ".dw-inst-head .n{font-size:13px;font-weight:600;}",
      ".dw-dim{color:var(--dim);font-size:10px;}",
      ".dw-parts{display:block;}",
      ".dw-part{border:1px solid var(--border);border-radius:5px;padding:6px 7px;margin-bottom:5px;background:var(--panel);font-size:11px;line-height:1.65;word-break:break-word;}",
      ".dw-part.cond{border-style:dashed;}",
      ".dw-part-head{display:flex;align-items:center;margin-bottom:4px;}",
      ".dw-part .tag{display:inline-block;font-size:9px;color:var(--dim);border:1px solid var(--border);border-radius:3px;padding:0 4px;}",
      ".dw-part-var{margin-left:auto;font-size:9px;color:var(--dim);max-width:55%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
      ".dw-part textarea{display:block;width:100%;background:var(--panel2);color:var(--text);border:1px solid var(--border);border-radius:4px;padding:5px 6px;font:inherit;font-size:11px;line-height:1.65;resize:none;outline:none;user-select:text;overflow-y:auto;}",
      ".dw-part textarea:focus{border-color:var(--accent);}",
      ".dw-var{color:var(--accent-hover);background:rgba(124,77,255,.18);border-radius:2px;padding:0 2px;}",
      ".dw-preview{margin-top:5px;border:1px solid var(--border);border-radius:5px;padding:7px;background:var(--panel);font-size:11px;line-height:1.7;white-space:pre-wrap;word-break:break-word;user-select:text;}",
      ".dw-note{color:var(--dim);font-size:10px;line-height:1.7;margin-top:8px;}",
      ".dw-note.ok{color:var(--ok);}",
      ".dw-note.err{color:var(--err);}",
      ".dw-check{font-size:10px;line-height:1.7;margin-top:6px;color:#e8c87a;flex:0 0 auto;}",
      ".dw-foot{flex-shrink:0;padding:6px 8px 8px;border-top:1px solid var(--border);background:var(--bg);}",
      ".dw-status{font-size:10px;line-height:1.6;color:var(--dim);min-height:15px;margin-bottom:5px;word-break:break-word;}",
      ".dw-status.dirty{color:#e8c87a;}",
      ".dw-status.ok{color:var(--ok);}",
      ".dw-status.err{color:var(--err);}",
      ".dw-actions{display:flex;}",
      ".dw-actions button{flex:1 1 0%;min-width:0;height:30px;margin-right:5px;padding:0;border-radius:5px;border:1px solid var(--border);background:var(--panel);color:var(--text);font:inherit;font-size:11px;cursor:pointer;}",
      ".dw-actions button:last-child{margin-right:0;}",
      ".dw-actions button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;}",
      ".dw-actions button[disabled]{opacity:.45;cursor:default;}",
      ".dw-actions button.primary[disabled]{background:var(--panel);border-color:var(--border);color:var(--dim);opacity:1;}",
      /* 基准测试 */
      ".dw-mini{height:26px;padding:0 8px;margin-left:5px;border-radius:5px;border:1px solid var(--border);background:var(--panel);color:var(--dim);font:inherit;font-size:10px;cursor:pointer;flex:0 0 auto;}",
      ".dw-mini:hover{color:var(--err);border-color:var(--err);}",
      ".dw-btn.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;}",
      ".dw-btn:disabled{opacity:.45;cursor:default;}",
      ".dw-btn.primary:disabled{background:var(--panel);border-color:var(--border);color:var(--dim);opacity:1;}",
      ".dw-runs{margin-top:2px;}",
      ".dw-run{display:flex;align-items:center;padding:5px;border:1px solid var(--border);border-radius:5px;margin-bottom:5px;cursor:pointer;background:var(--panel);}",
      ".dw-run:hover{border-color:var(--accent);}",
      ".dw-run.err{border-color:#6b3030;}",
      ".dw-run-thumb{width:48px;height:48px;flex:0 0 48px;margin-right:7px;background:var(--panel2);border-radius:4px;display:flex;align-items:center;justify-content:center;overflow:hidden;}",
      ".dw-run-thumb img{display:block;max-width:48px;max-height:48px;}",
      ".dw-run-x{color:var(--err);font-size:18px;}",
      ".dw-run-more{color:var(--dim);font-size:16px;}",
      ".dw-run-info{flex:1;min-width:0;}",
      ".dw-run-model{display:flex;align-items:center;font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;}",
      ".dw-run-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;}",
      ".dw-run-set{margin-left:auto;flex:0 0 auto;height:20px;padding:0 5px;border-radius:4px;border:1px solid var(--border);background:var(--panel2);color:var(--dim);font:inherit;font-size:9px;cursor:pointer;}",
      ".dw-run-set:hover{color:var(--accent-hover);border-color:var(--accent);}",
      ".dw-run-meta{font-size:10px;color:var(--dim);margin-top:2px;line-height:1.5;word-break:break-all;}",
      ".dw-tag{display:inline-block;margin-left:4px;font-size:9px;font-weight:400;color:var(--accent-hover);border:1px solid var(--accent);border-radius:3px;padding:0 3px;}",
      ".dw-case-info{font-size:10px;line-height:1.7;color:var(--dim);}",
      ".dw-case-info b{color:var(--text);font-weight:600;}",
      ".dw-case-info .p{color:var(--text);margin-top:3px;word-break:break-word;}",
      ".dw-models{max-height:150px;overflow-y:auto;border:1px solid var(--border);border-radius:5px;padding:4px;margin-bottom:6px;}",
      ".dw-model-row{display:flex;align-items:center;padding:3px 2px;font-size:11px;cursor:pointer;}",
      ".dw-model-row input{margin:0 6px 0 0;flex:0 0 auto;}",
      ".dw-model-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}",
      ".dw-row{display:flex;align-items:center;gap:6px;margin-bottom:6px;flex:0 0 auto;}",
      ".dw-row .dd{flex:1;min-width:0;}",
      ".dw-case{border:1px dashed var(--border);border-radius:5px;padding:8px;color:var(--dim);font-size:10px;line-height:1.7;margin-bottom:8px;flex:0 0 auto;}",
      ".dw-btn{width:100%;margin-top:6px;padding:6px 0;border-radius:5px;border:1px solid var(--border);background:var(--panel);color:var(--text);font:inherit;font-size:11px;cursor:pointer;flex:0 0 auto;}",
      ".dw-btn[disabled]{opacity:.45;cursor:default;}",
      ".dw-warn{border:1px solid #6b5320;background:#3a2f16;color:#e8c87a;border-radius:5px;padding:6px 7px;font-size:10px;line-height:1.7;margin-bottom:8px;flex:0 0 auto;}"
    ].join("\n");
    document.head.appendChild(st);
  }

  /* ---------------- 设置页入口 ---------------- */

  function mountSettings() {
    if (document.getElementById("secDev")) return;
    var body = document.getElementById("settingsBody");
    if (!body) return;

    var fs = document.createElement("fieldset");
    fs.id = "secDev";
    fs.innerHTML =
      '<legend>开发者（内部）</legend>' +
      '<div class="dw-warn">仅开发构建可见。这里的能力与数据不会出现在发布版；改动只保存在本机。</div>' +
      '<label class="check"><input type="checkbox" id="devEnabled"> 启用开发者模式</label>' +
      '<div class="status-line" id="devStatus"></div>' +
      '<div class="btnRow">' +
      '  <button id="btnDevOpen" type="button">打开开发者工作台</button>' +
      '  <button id="btnDevClear" type="button">清除开发数据</button>' +
      "</div>";

    var diag = document.getElementById("secDiag");
    body.insertBefore(fs, diag || null);

    document.getElementById("devEnabled").addEventListener("change", function () {
      setEnabled(this.checked);
    });
    document.getElementById("btnDevOpen").addEventListener("click", openWorkbench);
    document.getElementById("btnDevClear").addEventListener("click", clearDevData);

    setEnabled(readFlag(), true);
  }

  function setEnabled(on, silent) {
    writeFlag(on);
    var cb = document.getElementById("devEnabled");
    var btn = document.getElementById("btnDevOpen");
    var st = document.getElementById("devStatus");
    if (cb) cb.checked = on;
    if (btn) btn.disabled = !on;
    if (st) {
      st.textContent = on
        ? "已启用 · 提示词与测试数据保存在本机"
        : "未启用 · 工作台入口已隐藏";
      st.className = "status-line" + (on ? " ok" : "");
    }
    if (!silent) {
      try { diag("dev mode " + (on ? "on" : "off")); } catch (e) { /* ignore */ }
    }
  }

  function clearDevData() {
    var removed = 0;
    try {
      var keys = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf("psspark.dev.") === 0) keys.push(k);
      }
      keys.forEach(function (k) { localStorage.removeItem(k); removed++; });
    } catch (e) { /* ignore */ }
    setEnabled(false);
    if (document.getElementById("dwParts")) {
      drafts = {};
      dirty = {};
      renderList();
      renderEditor();
    }
    if (window.Bench) {
      /* 基准数据在 PluginData/dev/bench，一并删除 */
      Bench.clearAll().then(function () { renderBench(); }).catch(function () { /* ignore */ });
    }
    try { log("开发者数据已清除（" + removed + " 项）", "ok"); } catch (e2) { /* ignore */ }
  }

  /* ---------------- 工作台 ---------------- */

  function mountWorkbench() {
    if (document.getElementById("devWorkbench")) return;
    var root = el("div");
    root.id = "devWorkbench";
    root.className = "hidden";
    root.innerHTML =
      '<div class="dw-head">' +
      '  <button id="dwBack" type="button">‹ 返回</button>' +
      '  <span class="dw-title">开发者工作台</span>' +
      '  <span class="dw-badge">DEV</span>' +
      '  <span class="dw-ver">P3 · 基准</span>' +
      "</div>" +
      '<div class="dw-tabs">' +
      '  <button class="dw-tab" id="dwTabList" type="button">功能</button>' +
      '  <button class="dw-tab active" id="dwTabSpec" type="button">模板</button>' +
      '  <button class="dw-tab" id="dwTabBench" type="button">基准</button>' +
      "</div>" +
      '<div class="dw-body" id="dwBody">' +
      '  <div class="dw-pane hidden" id="dwPaneList">' +
      '    <div class="dw-cap">功能（16）</div>' +
      '    <input type="text" id="dwSearch" placeholder="搜索功能…">' +
      '    <div class="dw-list" id="dwList"></div>' +
      "  </div>" +
      '  <div class="dw-pane" id="dwPaneSpec">' +
      '    <div class="dw-inst-head"><span class="n" id="dwInstName"></span><span class="dw-dim" id="dwInstGroup"></span></div>' +
      '    <div class="dw-row hidden" id="dwBranchRow"><span class="dw-dim">分支</span><div id="dwBranch" style="flex:1;min-width:0"></div></div>' +
      '    <div class="dw-cap">模板段落（可直接编辑）</div>' +
      '    <div class="dw-parts" id="dwParts"></div>' +
      '    <div class="dw-check hidden" id="dwCheck"></div>' +
      '    <div class="dw-cap" style="margin-top:8px">实际发送预览</div>' +
      '    <input type="text" id="dwSample" placeholder="输入样例描述，仅用于预览">' +
      '    <div class="dw-preview" id="dwPreview"></div>' +
      '    <div class="dw-note" id="dwNote">编辑后点「保存」立即生效；「试跑」只用当前草稿构建提示词，不发送请求。未填样例时，含 {{user}} 的段落会省略。</div>' +
      "  </div>" +
      '  <div class="dw-pane hidden" id="dwPaneBench">' +
      '    <div class="dw-cap">用例（冻结当前画面 + 当前模板与参数）</div>' +
      '    <div class="dw-case-info" id="dwCaseInfo">尚未创建用例</div>' +
      '    <div class="dw-row" style="margin-top:6px"><div id="dwCaseDD" style="flex:1;min-width:0"></div><button class="dw-mini" id="dwCaseDel" type="button" disabled>删除</button></div>' +
      '    <div class="dw-cap" style="margin-top:8px">基准模型</div>' +
      '    <div id="dwModel"></div>' +
      '    <button class="dw-btn primary" id="dwFreeze" type="button">冻结当前画面并运行 · 图像 ×1</button>' +
      '    <button class="dw-btn" id="dwStop" type="button" disabled>停止</button>' +
      '    <div class="dw-cap" style="margin-top:10px">结果（点击看对比）</div>' +
      '    <div class="dw-runs" id="dwRuns"></div>' +
      '    <div class="dw-cap" style="margin-top:10px">复测模型（可多选）</div>' +
      '    <div class="dw-models" id="dwRetestModels"></div>' +
      '    <button class="dw-btn" id="dwRetest" type="button" disabled>开始复测 · 图像 ×0</button>' +
      '    <div class="dw-note" id="dwBenchNote">先冻结当前画面跑一个基准，再勾选其他模型复测；失败会记录原因且不中断其他模型。</div>' +
      "  </div>" +
      "</div>" +
      '<div class="dw-foot" id="dwFoot">' +
      '  <div class="dw-status" id="dwStatus"></div>' +
      '  <div class="dw-actions">' +
      '    <button id="dwSave" type="button" class="primary" disabled>保存</button>' +
      '    <button id="dwReset" type="button" disabled>恢复默认</button>' +
      '    <button id="dwTry" type="button">试跑</button>' +
      "  </div>" +
      "</div>";
    document.body.appendChild(root);

    document.getElementById("dwBack").addEventListener("click", closeWorkbench);
    document.getElementById("dwTabList").addEventListener("click", function () { switchTab("list"); });
    document.getElementById("dwTabSpec").addEventListener("click", function () { switchTab("spec"); });
    document.getElementById("dwTabBench").addEventListener("click", function () { switchTab("bench"); });
    document.getElementById("dwSearch").addEventListener("input", function () {
      state.query = this.value || "";
      renderList();
    });
    document.getElementById("dwSample").addEventListener("input", renderPreview);
    document.getElementById("dwSave").addEventListener("click", saveDraft);
    document.getElementById("dwReset").addEventListener("click", resetDraft);
    document.getElementById("dwTry").addEventListener("click", tryRun);

    fillModels();
    document.getElementById("dwFreeze").addEventListener("click", benchFreeze);
    document.getElementById("dwRetest").addEventListener("click", benchRetest);
    document.getElementById("dwStop").addEventListener("click", function () {
      if (window.Bench) Bench.stop();
    });
    document.getElementById("dwCaseDel").addEventListener("click", benchDeleteCase);
    if (window.Bench) {
      Bench.init({ onChange: renderBench, onStatus: setBenchStatus })
        .then(function () { renderBench(); })
        .catch(function (e) {
          setBenchStatus("基准模块初始化失败：" + ((e && e.message) || e), "err");
        });
    } else {
      setBenchStatus("基准模块未加载（仅开发构建可用）", "err");
    }
    var last = null;
    try { last = localStorage.getItem(KEY_LAST); } catch (e) { last = null; }
    state.instId = (last && instById(last)) ? last : (REGISTRY[0] && REGISTRY[0].id);
    renderList();
    renderEditor();
  }

  function fillModels() {
    var host = document.getElementById("dwModel");
    if (!host) return;
    var list = (IMAGE_MODEL_PRESETS || []).map(function (m) { return [m.id, m.label || m.id]; });
    if (!list.length) return;
    var prefer = null;
    try { prefer = localStorage.getItem("psspark.dev.bench.model"); } catch (e) { prefer = null; }
    var has = false;
    for (var i = 0; i < list.length; i++) if (list[i][0] === prefer) { has = true; break; }
    modelDD = UI.makeDropdown(list, has ? prefer : list[0][0], function (v) {
      try { localStorage.setItem("psspark.dev.bench.model", v); } catch (e) { /* ignore */ }
    });
    host.appendChild(modelDD.el);
  }

  /* 窄面板下三栏必然挤压，改为单列 Tab：同一时刻只绘制一个 pane */
  function switchTab(tab) {
    state.tab = tab;
    var map = { list: "dwPaneList", spec: "dwPaneSpec", bench: "dwPaneBench" };
    var tabs = { list: "dwTabList", spec: "dwTabSpec", bench: "dwTabBench" };
    Object.keys(map).forEach(function (k) {
      var pane = document.getElementById(map[k]);
      var btn = document.getElementById(tabs[k]);
      if (pane) pane.classList.toggle("hidden", k !== tab);
      if (btn) btn.classList.toggle("active", k === tab);
    });
    /* 切换后回到顶部，避免沿用上一个面板的滚动位置 */
    var pane = document.getElementById(map[tab]);
    if (pane) pane.scrollTop = 0;
    /* 底部操作条只服务模板编辑 */
    var foot = document.getElementById("dwFoot");
    if (foot) foot.classList.toggle("hidden", tab !== "spec");
  }

  function openWorkbench() {
    if (!document.getElementById("devWorkbench")) mountWorkbench();
    var inst = document.getElementById("devWorkbench");
    document.getElementById("settingsOverlay").classList.add("hidden");
    document.body.classList.add("dev-open");
    inst.classList.remove("hidden");
    switchTab(state.tab || "spec");
    if (window.Bench) {
      Bench.refresh().then(function () { renderBench(); }).catch(function () { /* ignore */ });
    }
    try { diag("dev workbench open"); } catch (e) { /* ignore */ }
  }

  function closeWorkbench() {
    var inst = document.getElementById("devWorkbench");
    if (inst) inst.classList.add("hidden");
    document.body.classList.remove("dev-open");
    document.getElementById("settingsOverlay").classList.remove("hidden");
    if (window.Bench) Bench.closeCompare();
  }

  /* ---------------- 左栏：功能列表 ---------------- */

  var GROUPS = [
    { id: "gen", label: "生成" },
    { id: "redraw", label: "编辑 · 重绘" },
    { id: "repair", label: "编辑 · 修复" },
    { id: "creative", label: "编辑 · 创意" },
    { id: "struct", label: "编辑 · 结构" }
  ];

  function groupOf(inst) {
    return inst.domain === "gen" ? "gen" : inst.group;
  }

  function renderList() {
    var host = document.getElementById("dwList");
    if (!host) return;
    host.innerHTML = "";
    var q = state.query.trim().toLowerCase();
    var total = 0;
    GROUPS.forEach(function (g) {
      var items = REGISTRY.filter(function (r) {
        if (groupOf(r) !== g.id) return false;
        if (!q) return true;
        return (r.name + " " + (r.alias || "") + " " + (r.desc || "")).toLowerCase().indexOf(q) >= 0;
      });
      if (!items.length) return;
      host.appendChild(el("div", "dw-group", g.label));
      items.forEach(function (inst) {
        total++;
        var row = el("div", "dw-item" + (state.instId === inst.id ? " active" : ""));
        row.appendChild(el("span", "nm", inst.name));
        if (hasOverride(inst.id)) row.appendChild(el("span", "dw-dot", "改"));
        row.title = inst.desc || "";
        row.addEventListener("click", function () {
          state.instId = inst.id;
          state.branchId = null;
          try { localStorage.setItem(KEY_LAST, inst.id); } catch (e) { /* ignore */ }
          renderList();
          renderEditor();
          switchTab("spec");
        });
        host.appendChild(row);
      });
    });
    if (!total) host.appendChild(el("div", "dw-note", "没有匹配的功能"));
  }

  /* ---------------- 中栏：模板编辑与预览 ---------------- */

  /* 覆盖存储：每个功能 + 分支一份 parts 数组（与 promptSpec.parts 同构） */
  var KEY_PROMPT = "psspark.dev.prompt.";
  var VAR_KEYS = {
    user: 1, hasUser: 1, noUser: 1, colorName: 1, colorHex: 1, hasColor: 1,
    targetColor: 1, hasAsset: 1, aligned: 1, assetCount: 1
  };
  var drafts = {};   // "inst|branch" → parts（本次会话的草稿，未落盘）
  var dirty = {};    // "inst|branch" → true

  function draftKey(instId, branchId) { return instId + "|" + branchId; }
  function storeKey(instId, branchId) { return KEY_PROMPT + instId + "." + branchId; }

  function cloneParts(parts) {
    return (parts || []).map(function (p) {
      if (typeof p === "string") return p;
      return { text: (p && p.text) || "", if: (p && p.if) || null };
    });
  }

  function readOverride(instId, branchId) {
    try {
      var raw = localStorage.getItem(storeKey(instId, branchId));
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || !Array.isArray(obj.parts)) return null;
      return cloneParts(obj.parts);
    } catch (e) { return null; }
  }

  function writeOverride(instId, branchId, parts) {
    try {
      localStorage.setItem(storeKey(instId, branchId), JSON.stringify({ v: 1, ts: Date.now(), parts: parts }));
      return true;
    } catch (e) { return false; }
  }

  function clearOverride(instId, branchId) {
    try { localStorage.removeItem(storeKey(instId, branchId)); } catch (e) { /* ignore */ }
  }

  function hasOverride(instId) {
    var inst = instById(instId);
    var bs = (inst && inst.promptSpec && inst.promptSpec.branches) || [];
    for (var i = 0; i < bs.length; i++) {
      try { if (localStorage.getItem(storeKey(instId, bs[i].id))) return true; } catch (e) { /* ignore */ }
    }
    return false;
  }

  function defaultParts(inst, branchId) {
    var spec = inst.promptSpec || { parts: {} };
    return cloneParts((spec.parts || {})[branchId] || []);
  }

  function currentParts(inst) {
    var k = draftKey(inst.id, state.branchId);
    if (!drafts[k]) {
      drafts[k] = readOverride(inst.id, state.branchId) || defaultParts(inst, state.branchId);
    }
    return drafts[k];
  }

  function partText(p) { return typeof p === "string" ? p : ((p && p.text) || ""); }

  function varsIn(text) {
    var out = [], seen = {};
    String(text || "").replace(/\{\{(\w+)\}\}/g, function (m, k) {
      if (!seen[k]) { seen[k] = 1; out.push(k); }
      return m;
    });
    return out;
  }

  function validateParts(parts) {
    var issues = [], unknown = {}, empty = true;
    (parts || []).forEach(function (p) {
      var t = partText(p);
      if (t.trim()) empty = false;
      varsIn(t).forEach(function (k) { if (!VAR_KEYS[k]) unknown[k] = 1; });
      var open = (t.match(/\{\{/g) || []).length;
      var close = (t.match(/\}\}/g) || []).length;
      if (open !== close) issues.push("占位符 {{ }} 未闭合");
    });
    var uk = Object.keys(unknown);
    if (uk.length) {
      issues.push("未知变量 " + uk.map(function (k) { return "{{" + k + "}}"; }).join(" ") + "（会原样发送）");
    }
    if (empty) issues.push("模板全部为空");
    return issues.filter(function (v, i, a) { return a.indexOf(v) === i; });
  }

  function setStatus(text, cls) {
    var st = document.getElementById("dwStatus");
    if (!st) return;
    st.textContent = text || "";
    st.className = "dw-status" + (cls ? " " + cls : "");
  }

  function updateFoot(inst) {
    var k = draftKey(inst.id, state.branchId);
    var issues = validateParts(currentParts(inst));
    var hasOv = !!readOverride(inst.id, state.branchId);

    var save = document.getElementById("dwSave");
    var reset = document.getElementById("dwReset");
    if (save) save.disabled = !dirty[k];
    if (reset) reset.disabled = !dirty[k] && !hasOv;

    var chk = document.getElementById("dwCheck");
    if (chk) {
      chk.textContent = issues.length ? "⚠ " + issues.join("；") : "";
      chk.classList.toggle("hidden", !issues.length);
    }

    if (issues.length) setStatus(issues.join("；"), "err");
    else if (dirty[k]) setStatus("已修改，未保存 · 点「保存」后立即生效", "dirty");
    else if (hasOv) setStatus("使用自定义模板（仅本机）", "ok");
    else setStatus("使用内置模板");
  }

  function groupLabel(inst) {
    for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].id === groupOf(inst)) return GROUPS[i].label;
    return "";
  }

  function extraForBranch(branch) {
    var w = (branch && branch.when) || null;
    if (!w) return null;
    var ex = {};
    if (Object.prototype.hasOwnProperty.call(w, "hasAsset")) ex.hasAsset = w.hasAsset;
    if (Object.prototype.hasOwnProperty.call(w, "aligned")) ex.aligned = w.aligned;
    return ex;
  }

  function autoRows(ta) {
    var lines = 0;
    String(ta.value).split("\n").forEach(function (l) {
      lines += Math.max(1, Math.ceil(l.length / 30));
    });
    var rows = Math.max(2, Math.min(16, lines + 1));
    ta.rows = rows;
    /* UXP 对动态 rows 的重排不稳定，直接给高度更可靠 */
    try { ta.style.height = (rows * 18 + 14) + "px"; } catch (e) { /* ignore */ }
  }

  function renderEditor() {
    var inst = instById(state.instId);
    if (!inst) return;
    document.getElementById("dwInstName").textContent = inst.name;
    document.getElementById("dwInstGroup").textContent = groupLabel(inst);

    var spec = inst.promptSpec || { branches: [{ id: "default", label: "默认", when: null }], parts: {} };
    var branches = spec.branches || [];
    if (!branches.length) branches = [{ id: "default", label: "默认", when: null }];
    var ok = branches.some(function (b) { return b.id === state.branchId; });
    if (!ok) state.branchId = branches[0].id;

    var row = document.getElementById("dwBranchRow");
    var branchHost = document.getElementById("dwBranch");
    branchHost.innerHTML = "";
    var branchOpts = branches.map(function (b) { return [b.id, b.label || b.id]; });
    var branchDD = UI.makeDropdown(branchOpts, state.branchId, function (v) {
      state.branchId = v;
      renderEditor();
    });
    branchHost.appendChild(branchDD.el);
    row.classList.toggle("hidden", branches.length <= 1);

    renderPartsEditor(inst);
    renderPreview();
    updateFoot(inst);
  }

  function renderPartsEditor(inst) {
    var parts = currentParts(inst);
    var host = document.getElementById("dwParts");
    host.innerHTML = "";
    if (!parts.length) {
      host.appendChild(el("div", "dw-note", "该功能没有可编辑的模板段"));
      return;
    }

    parts.forEach(function (p, idx) {
      var cond = (typeof p === "string") ? null : p.if;
      var box = el("div", "dw-part" + (cond ? " cond" : ""));

      var head = el("div", "dw-part-head");
      head.appendChild(el("span", "tag", cond ? ("仅在 " + cond + " 时包含") : ("段落 " + (idx + 1))));
      var vs = varsIn(partText(p));
      if (vs.length) {
        head.appendChild(el("span", "dw-part-var",
          vs.map(function (v) { return "{{" + v + "}}"; }).join(" ")));
      }
      box.appendChild(head);

      var ta = document.createElement("textarea");
      ta.value = partText(p);
      autoRows(ta);
      ta.addEventListener("input", function () {
        if (typeof parts[idx] === "string") parts[idx] = ta.value;
        else parts[idx].text = ta.value;
        var k = draftKey(inst.id, state.branchId);
        drafts[k] = parts;
        dirty[k] = true;
        autoRows(ta);
        renderPreview();
        updateFoot(inst);
      });
      box.appendChild(ta);
      host.appendChild(box);
    });
  }

  function renderPreview() {
    var inst = instById(state.instId);
    if (!inst) return;
    var spec = inst.promptSpec || { branches: [] };
    var branch = (spec.branches || []).filter(function (b) { return b.id === state.branchId; })[0] || null;

    var sampleEl = document.getElementById("dwSample");
    var sample = sampleEl ? sampleEl.value : "";
    var params = {};
    try { params = paramDefaultsFor(inst); } catch (e) { params = {}; }

    var useColor = (inst.locate || []).indexOf("box") >= 0;
    var color = useColor ? { name: "红色", hex: "#FF0000" } : null;
    var extra = extraForBranch(branch);

    var text = "";
    try {
      text = buildPromptFromParts(inst, currentParts(inst), sample, color, params, null, extra);
    } catch (e) {
      text = "预览失败：" + (e && e.message ? e.message : String(e));
    }
    document.getElementById("dwPreview").innerHTML = withVars(text);
  }

  /* ---------------- 保存 / 恢复默认 / 试跑 ---------------- */

  function saveDraft() {
    var inst = instById(state.instId);
    if (!inst) return;
    var parts = currentParts(inst);
    var hasText = parts.some(function (p) { return partText(p).trim(); });
    if (!hasText) {
      setStatus("模板不能全部为空，未保存", "err");
      return;
    }
    if (!writeOverride(inst.id, state.branchId, parts)) {
      setStatus("保存失败：本机存储不可用", "err");
      return;
    }
    var k = draftKey(inst.id, state.branchId);
    dirty[k] = false;
    drafts[k] = parts;
    renderList();
    updateFoot(inst);
    setStatus("已保存 · 该功能下次生成即使用新模板", "ok");
  }

  function resetDraft() {
    var inst = instById(state.instId);
    if (!inst) return;
    clearOverride(inst.id, state.branchId);
    var k = draftKey(inst.id, state.branchId);
    delete drafts[k];
    delete dirty[k];
    renderEditor();
    renderList();
    setStatus("已恢复内置模板", "ok");
  }

  function tryRun() {
    var inst = instById(state.instId);
    if (!inst) return;
    renderPreview();
    var sample = document.getElementById("dwSample");
    var hasSample = !!(sample && sample.value.trim());
    var note = document.getElementById("dwNote");
    if (note) {
      note.textContent = "试跑完成：" +
        (hasSample ? "已用当前草稿构建提示词" : "未填样例，含 {{user}} 的段落按空处理") +
        "（仅构建文本，未发送请求）";
    }
    var pv = document.getElementById("dwPreview");
    try { if (pv && pv.scrollIntoView) pv.scrollIntoView({ block: "nearest" }); } catch (e) { /* ignore */ }
  }

  /* ---------------- 基准测试（P3） ---------------- */

  var caseDD = null;

  function benchTime(iso) {
    var s = String(iso || "");
    return s.length >= 16 ? s.slice(0, 16).replace("T", " ") : s;
  }

  function benchDur(ms) {
    if (ms == null || isNaN(ms)) return "—";
    return ms < 1000 ? Math.round(ms) + "ms" : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
  }

  function setBenchStatus(text, cls) {
    var note = document.getElementById("dwBenchNote");
    if (!note) return;
    note.textContent = text || "";
    note.className = "dw-note" + (cls ? " " + cls : "");
  }

  function collectRetestModels() {
    var host = document.getElementById("dwRetestModels");
    var out = [];
    if (!host) return out;
    var cbs = host.querySelectorAll("input[type=checkbox]");
    for (var i = 0; i < cbs.length; i++) if (cbs[i].checked) out.push(cbs[i].value);
    return out;
  }

  function updateRetestBtn() {
    var btn = document.getElementById("dwRetest");
    if (!btn) return;
    var n = collectRetestModels().length;
    btn.textContent = "开始复测 · 图像 ×" + n;
    btn.disabled = n === 0 || !window.Bench || Bench.busy() || !Bench.current();
  }

  function renderRetestModels() {
    var host = document.getElementById("dwRetestModels");
    if (!host || !window.Bench) return;
    var all = IMAGE_MODEL_PRESETS || [];
    var saved = Bench.modelsToRetest();
    if (!saved.length && all.length) {
      /* 默认勾选两个「非当前基准」模型，避免复测时重复跑同一个 */
      var cur = modelDD ? modelDD.getValue() : null;
      var others = all.filter(function (m) { return m.id !== cur; });
      saved = (others.length ? others : all).slice(0, 2).map(function (m) { return m.id; });
      Bench.saveModelsToRetest(saved);
    }
    host.innerHTML = "";
    all.forEach(function (m) {
      var row = el("label", "dw-model-row");
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.value = m.id;
      cb.checked = saved.indexOf(m.id) >= 0;
      cb.addEventListener("change", function () {
        Bench.saveModelsToRetest(collectRetestModels());
        updateRetestBtn();
      });
      row.appendChild(cb);
      row.appendChild(el("span", "dw-model-name", m.label || m.id));
      host.appendChild(row);
    });
    updateRetestBtn();
  }

  function renderRuns() {
    var host = document.getElementById("dwRuns");
    if (!host || !window.Bench) return;
    host.innerHTML = "";
    var runs = Bench.runs();
    if (!runs.length) {
      host.appendChild(el("div", "dw-note", "还没有结果。点上方「冻结当前画面并运行」开始。"));
      return;
    }
    runs.slice().reverse().forEach(function (r, idx) {
      var card = el("div", "dw-run" + (r.status === "ok" ? "" : " err"));
      var thumb = el("div", "dw-run-thumb");
      if (r.status === "ok" && idx < 6) {
        /* 只给最近 6 张加载缩略图：UXP 无缩略图能力，data URI 是整张大图，避免内存堆积 */
        var img = document.createElement("img");
        thumb.appendChild(img);
        Bench.thumbFor(r).then(function (uri) { if (uri) img.src = uri; });
      } else if (r.status === "ok") {
        thumb.appendChild(el("span", "dw-run-more", "…"));
      } else {
        thumb.appendChild(el("span", "dw-run-x", "×"));
      }
      card.appendChild(thumb);

      var info = el("div", "dw-run-info");
      var line = el("div", "dw-run-model");
      line.appendChild(el("span", "dw-run-nm", r.model));
      if (r.isBaseline) line.appendChild(el("span", "dw-tag", "基准"));
      else if (r.status === "ok") {
        var sb = el("button", "dw-run-set", "设基准");
        sb.type = "button";
        sb.addEventListener("click", function (ev) {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          Bench.setBaseline(r.runId).then(function () { renderBench(); });
        });
        line.appendChild(sb);
      }
      info.appendChild(line);

      var meta = r.status === "ok"
        ? (benchDur(r.latencyMs) + " · " + (r.width ? r.width + "×" + r.height : "尺寸未知") +
          " · " + (r.bytes ? Math.round(r.bytes / 1024) + "KB" : "—"))
        : ("失败：" + String(r.error || "未知错误").slice(0, 60));
      info.appendChild(el("div", "dw-run-meta", meta));
      card.appendChild(info);

      card.addEventListener("click", function () { Bench.openCompare(r.runId); });
      host.appendChild(card);
    });
  }

  function renderCaseDD() {
    var host = document.getElementById("dwCaseDD");
    if (!host || !window.Bench) return;
    host.innerHTML = "";
    var idx = Bench.index();
    if (!idx.length) { caseDD = null; return; }
    var opts = idx.map(function (e) {
      return [e.id, (e.title || e.instName || e.id) + " · " + (e.runCount || 0) + " 次"];
    });
    var cur = Bench.state.caseId || opts[0][0];
    caseDD = UI.makeDropdown(opts, cur, function (v) {
      Bench.selectCase(v).then(function () { renderBench(); });
    }, { disabled: Bench.busy() });
    host.appendChild(caseDD.el);
  }

  function renderBench() {
    if (!window.Bench) return;
    var c = Bench.current();
    var info = document.getElementById("dwCaseInfo");
    var del = document.getElementById("dwCaseDel");
    if (info) {
      info.innerHTML = "";
      if (!c) {
        info.textContent = "尚未创建用例。选好功能、分支与提示词后，点下方按钮冻结当前画面。";
      } else {
        var l1 = el("div");
        l1.appendChild(el("b", null, c.title || c.instName || "未命名"));
        l1.appendChild(document.createTextNode(" · " + benchTime(c.createdAt)));
        info.appendChild(l1);
        info.appendChild(el("div", null,
          "输入 " + ((c.source && c.source.width) ? c.source.width + "×" + c.source.height : "—") +
          " · 提示词 " + String(c.prompt || "").length + " 字 · " +
          Bench.runs().length + " 次运行"));
        info.appendChild(el("div", "p",
          String(c.prompt || "").slice(0, 90) + (String(c.prompt || "").length > 90 ? "…" : "")));
      }
    }
    if (del) del.disabled = !c || Bench.busy();
    renderCaseDD();
    renderRuns();
    renderRetestModels();

    var freeze = document.getElementById("dwFreeze");
    if (freeze) {
      freeze.disabled = Bench.busy();
      freeze.textContent = Bench.busy() ? "运行中…（可点下方停止）" : "冻结当前画面并运行 · 图像 ×1";
    }
    var stop = document.getElementById("dwStop");
    if (stop) stop.disabled = !Bench.busy();
    updateRetestBtn();
  }

  /* 用当前功能/分支/草稿构建最终提示词（与「试跑」同一套逻辑） */
  function benchPrompt(inst) {
    var sample = document.getElementById("dwSample");
    var userText = sample ? sample.value : "";
    var params = {};
    try { params = paramDefaultsFor(inst) || {}; } catch (e) { params = {}; }
    var spec = inst.promptSpec || { branches: [] };
    var branch = (spec.branches || []).filter(function (b) { return b.id === state.branchId; })[0] || null;
    var extra = extraForBranch(branch);
    var useColor = (inst.locate || []).indexOf("box") >= 0;
    var color = useColor ? { name: "红色", hex: "#FF0000" } : null;
    return {
      prompt: buildPromptFromParts(inst, currentParts(inst), userText, color, params, null, extra),
      params: params,
      branch: branch,
      userText: userText
    };
  }

  async function benchFreeze() {
    if (!window.Bench) { setBenchStatus("基准模块未加载", "err"); return; }
    if (Bench.busy()) return;
    var inst = instById(state.instId);
    if (!inst || !modelDD) return;

    var built = null;
    try { built = benchPrompt(inst); } catch (e) {
      setBenchStatus("提示词构建失败：" + ((e && e.message) || e), "err");
      return;
    }
    if (!String(built.prompt || "").trim()) {
      setBenchStatus("当前模板为空，先到「模板」补内容", "err");
      return;
    }

    setBenchStatus("正在导出当前画面…");
    try {
      var uri = await exportScopePngDataURI("canvas", 1536);
      var size = Bench.measure(uri);
      var warnings = [];
      var maskUri = null;
      var assets = [];

      var doc = app && app.activeDocument ? app.activeDocument : null;
      var W = doc ? Math.round(doc.width) : 0;
      var H = doc ? Math.round(doc.height) : 0;

      /* 选区蒙版：只有存在真实选区时才导出（与线上生成路径一致；无选区 = 整图） */
      if (inst.mask === "auto") {
        var sel = null;
        try { sel = await getSelectionBounds(); } catch (eSel) { sel = null; }
        if (sel) {
          setBenchStatus("正在导出选区蒙版…");
          try {
            var m = await buildMaskPNG({ left: 0, top: 0, right: W, bottom: H, width: W, height: H }, size);
            maskUri = await fileToDataURI(m.entry);
          } catch (eMask) {
            warnings.push("蒙版导出失败：" + ((eMask && eMask.message) || eMask));
          }
        } else if (inst.selection === "required") {
          warnings.push("该功能需要选区，当前无选区，已按整图测试");
        }
      }

      /* 拼合 / 参考图类：把当前选中图层导出为画布对齐的透明资产（最多 4 张） */
      var hasFileSlot = (inst.slots || []).some(function (s) {
        return s.role !== "main" && (s.sources || []).indexOf("file") >= 0;
      });
      if (hasFileSlot) {
        setBenchStatus("正在导出选中图层作为资产…");
        try {
          var a = await exportActiveLayersMergedCanvasPng(size);
          if (a && a.uri) assets.push(a.uri);
        } catch (eAsset) {
          warnings.push("未导出资产（先在图层栏选中素材图层）：" + ((eAsset && eAsset.message) || eAsset));
        }
      }

      var model = modelDD.getValue();
      setBenchStatus("已冻结" + (maskUri ? "（含蒙版）" : "") + (assets.length ? "（含资产 " + assets.length + " 张）" : "") +
        "，开始运行 " + model + " …");
      await Bench.newCase({
        instId: inst.id,
        instName: inst.name,
        branchId: state.branchId,
        branchLabel: built.branch ? (built.branch.label || built.branch.id) : "",
        prompt: built.prompt,
        params: built.params,
        dataUri: uri,
        maskUri: maskUri,
        assets: assets,
        warnings: warnings,
        userText: built.userText
      });
      renderBench();
      await Bench.runOne(model, { baseline: true });
      renderBench();
      setBenchStatus("基准完成。可勾选其他模型复测，或点结果卡看对比。", "ok");
    } catch (e) {
      setBenchStatus("失败：" + ((e && e.message) || e), "err");
    }
  }

  async function benchRetest() {
    if (!window.Bench) return;
    var models = collectRetestModels();
    if (!models.length) { setBenchStatus("先勾选至少一个模型", "err"); return; }
    try {
      await Bench.runMany(models);
      renderBench();
    } catch (e) {
      setBenchStatus("复测失败：" + ((e && e.message) || e), "err");
    }
  }

  async function benchDeleteCase() {
    if (!window.Bench) return;
    var c = Bench.current();
    if (!c) return;
    await Bench.deleteCase(c.id);
    renderBench();
    setBenchStatus("已删除用例：" + (c.title || c.id), "ok");
  }

  /* ---------------- 初始化 ---------------- */

  /* 把「本机覆盖」接到实际生成链路：关闭开关即回默认，未保存的草稿不影响生成 */
  function installPromptOverride() {
    if (typeof setPromptOverrideProvider !== "function") return;
    setPromptOverrideProvider(function (inst, ctx) {
      if (!readFlag()) return null;
      var spec = inst && inst.promptSpec;
      if (!spec) return null;
      var branch = promptBranchFor(spec, ctx);
      if (!branch) return null;
      return readOverride(inst.id, branch.id);
    });
  }

  function init() {
    if (built && document.getElementById("secDev")) return;
    built = true;
    injectStyle();
    mountSettings();
    installPromptOverride();
    try { log("开发者模式已加载（内部构建）"); } catch (e) { /* ignore */ }
    try { diag("dev mode ready"); } catch (e2) { /* ignore */ }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.DevMode = {
    isEnabled: readFlag,
    init: init,
    open: openWorkbench,
    close: closeWorkbench
  };
})();

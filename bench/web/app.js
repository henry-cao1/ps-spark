/* Web 测试台前端：原生 JS，无构建步骤 */
(function () {
  "use strict";

  var state = {
    cases: [],
    caseId: null,
    caseData: null,
    runs: [],
    assets: [],
    models: [],
    selected: new Set(),
    jobId: null,
    jobTimer: null,
    keyReady: false,
    busy: false,
    query: "",
    comfy: { ok: true, reason: null }
  };

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  async function api(path, opts) {
    var res = await fetch(path, opts);
    var json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    if (!res.ok) throw new Error((json && json.error) || ("HTTP " + res.status));
    return json;
  }

  function toast(msg, isErr) {
    var t = $("toast");
    t.textContent = msg;
    t.className = "toast" + (isErr ? " err" : "");
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.className = "toast hidden"; }, 2600);
  }

  function fmtTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return (d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function fmtDur(ms) {
    if (ms == null) return "—";
    return ms < 1000 ? Math.round(ms) + "ms" : (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + "s";
  }

  function fmtBytes(n) {
    if (!n) return "—";
    return n > 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + "MB" : Math.round(n / 1024) + "KB";
  }

  /* ---------------- 用例列表 ---------------- */

  function renderCaseList() {
    var host = $("caseList");
    host.innerHTML = "";
    var q = String(state.query || "").trim().toLowerCase();
    var list = state.cases.filter(function (c) {
      if (!q) return true;
      var hay = [(c.title || ""), (c.instName || ""), (c.promptPreview || "")].join(" ").toLowerCase();
      return hay.indexOf(q) >= 0;
    });
    $("caseCount").textContent = q ? (list.length + "/" + state.cases.length) : String(state.cases.length);
    if (!state.cases.length) {
      host.appendChild(el("div", "hint", "还没有用例"));
      return;
    }
    if (!list.length) {
      host.appendChild(el("div", "hint", "没有匹配「" + q + "」的用例"));
      return;
    }
    list.forEach(function (c) {
      var item = el("div", "case-item" + (c.id === state.caseId ? " active" : ""));
      item.appendChild(el("div", "t", c.title || c.instName || c.id));
      var m = el("div", "m", fmtTime(c.createdAt) + " · " + (c.branchLabel || "默认"));
      item.appendChild(m);
      var r = el("div", "r");
      r.appendChild(el("span", null, "结果 " + (c.okCount || 0) + "/" + (c.runCount || 0)));
      if (c.hasMask) r.appendChild(el("span", null, "含蒙版"));
      if (c.hasAssets) r.appendChild(el("span", null, "含资产"));
      item.appendChild(r);
      item.addEventListener("click", function () { selectCase(c.id); });
      host.appendChild(item);
    });
  }

  async function refreshCases() {
    var s = await api("/api/state");
    state.cases = s.cases || [];
    state.models = s.models || [];
    state.keyReady = !!s.keyReady;
    $("dataDir").textContent = s.dataDir ? ("数据目录：" + s.dataDir) : "数据目录：未找到";
    $("dataDir").title = s.dataDir || "";
    var pill = $("keyState");
    pill.textContent = state.keyReady ? "Key 已配置" : "Key 未配置";
    pill.className = "pill " + (state.keyReady ? "ok" : "err");
    var kh = $("keyHint");
    if (kh) kh.classList.toggle("hidden", state.keyReady);
    renderCaseList();
  }

  /* ---------------- 用例详情 ---------------- */

  async function selectCase(id) {
    try {
      var d = await api("/api/cases/" + encodeURIComponent(id));
      state.caseId = id;
      state.caseData = d.case;
      state.runs = d.runs || [];
      state.assets = d.assets || [];
      state.maskUrl = d.maskUrl || null;
      state.comfy = d.comfy || { ok: true, reason: null };
      if (!state.comfy.ok) state.selected.delete("comfy");
      if (history.replaceState) history.replaceState(null, "", "?case=" + encodeURIComponent(id));
      $("empty").classList.add("hidden");
      $("caseView").classList.remove("hidden");
      $("btnDeleteCase").disabled = false;
      $("btnExportCase").disabled = false;
      renderCase();
      renderCaseList();
      renderRuns();
    } catch (e) {
      toast("读取用例失败：" + e.message, true);
    }
  }

  function renderCase() {
    var c = state.caseData;
    if (!c) return;
    $("caseTitle").textContent = c.title || c.instName || "未命名";
    $("caseBadge").textContent = (c.instName || "") + (c.branchLabel ? " · " + c.branchLabel : "");
    var meta = $("caseMeta");
    meta.innerHTML = "";
    var add = function (label, value) {
      var s = el("span");
      s.appendChild(el("b", null, label));
      s.appendChild(document.createTextNode(" " + value));
      meta.appendChild(s);
    };
    add("创建", fmtTime(c.createdAt));
    add("输入", (c.source && c.source.width) ? (c.source.width + "×" + c.source.height) : "尺寸未知");
    add("提示词", String(c.prompt || "").length + " 字");
    add("运行", state.runs.length + " 次");
    if (c.baselineRunId) add("基准", String(c.baselineRunId).slice(0, 8));

    $("prompt").textContent = c.prompt || "";
    $("promptLen").textContent = "（" + String(c.prompt || "").length + " 字）";
    $("params").textContent = JSON.stringify(c.params || {}, null, 2);

    var warn = $("caseWarn");
    if (warn) {
      var ws = c.warnings || [];
      if (ws.length) {
        warn.textContent = "⚠ " + ws.join("；");
        warn.classList.remove("hidden");
      } else {
        warn.classList.add("hidden");
      }
    }

    renderInputs();
    renderModels();
    updateRunButton();
  }

  function thumbCard(url, caption, kind) {
    var card = el("div", "thumb-card");
    var box = el("div", "thumb");
    var img = document.createElement("img");
    img.src = url;
    img.alt = caption;
    img.loading = "lazy";
    box.appendChild(img);
    box.addEventListener("click", function () { openLightbox(url, caption); });
    card.appendChild(box);
    card.appendChild(el("div", "cap", caption));
    return card;
  }

  function renderInputs() {
    var host = $("inputs");
    host.innerHTML = "";
    if (!state.caseId) return;
    var id = encodeURIComponent(state.caseId);
    host.appendChild(thumbCard("/api/cases/" + id + "/file?name=input", "输入画面", "input"));
    if (state.maskUrl) host.appendChild(thumbCard(state.maskUrl, "蒙版（白=重绘区）", "mask"));
    state.assets.forEach(function (a, i) {
      host.appendChild(thumbCard(a.url, "资产 " + (i + 1), "asset"));
    });
    if (!state.assets.length && !state.maskUrl) {
      host.appendChild(el("div", "hint", "整图输入（无蒙版 / 资产）"));
    }
  }

  /* ---------------- 模型选择 ---------------- */

  function renderModels() {
    var host = $("modelGroups");
    host.innerHTML = "";
    var groups = {};
    state.models.forEach(function (m) {
      var g = m.group || "其他";
      (groups[g] = groups[g] || []).push(m);
    });
    Object.keys(groups).forEach(function (g) {
      var box = el("div", "model-group");
      box.appendChild(el("div", "g-title", g === "gpt" ? "GPT Image 系列" : (g === "nano" ? "Nano Banana 系列" : (g === "local" ? "本地" : g))));
      var chips = el("div", "chips");
      groups[g].forEach(function (m) {
        var blocked = m.id === "comfy" && state.comfy && !state.comfy.ok;
        var chip = el("div", "chip" + (state.selected.has(m.id) ? " on" : "") + (blocked ? " off" : ""));
        chip.appendChild(el("span", "box"));
        chip.appendChild(el("span", null, m.label));
        if (blocked) {
          chip.title = state.comfy.reason || "当前用例不支持本地 ComfyUI";
          chip.addEventListener("click", function () {
            toast(chip.title, true);
          });
        } else {
          chip.addEventListener("click", function () {
            if (state.selected.has(m.id)) state.selected.delete(m.id);
            else state.selected.add(m.id);
            chip.classList.toggle("on");
            updateRunButton();
          });
        }
        chips.appendChild(chip);
      });
      box.appendChild(chips);
      host.appendChild(box);
    });
  }

  function updateRunButton() {
    var n = state.selected.size;
    var btn = $("btnRun");
    btn.textContent = "运行选中（" + n + "）";
    btn.disabled = !n || !state.caseId || state.busy || !state.keyReady;
    if (!state.keyReady && n) btn.title = "未配置 API Key";
    else btn.title = "";
  }

  /* ---------------- 运行 ---------------- */

  async function runSelected() {
    if (!state.caseId || !state.selected.size || state.busy) return;
    state.busy = true;
    updateRunButton();
    $("jobBox").classList.remove("hidden");
    $("jobText").textContent = "提交任务…";
    $("jobLog").textContent = "";
    $("barFill").style.width = "0%";
    try {
      var r = await api("/api/cases/" + encodeURIComponent(state.caseId) + "/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: Array.from(state.selected) })
      });
      state.jobId = r.jobId;
      pollJob();
    } catch (e) {
      state.busy = false;
      updateRunButton();
      toast("运行失败：" + e.message, true);
      $("jobText").textContent = "运行失败：" + e.message;
    }
  }

  async function pollJob() {
    if (!state.jobId) return;
    try {
      var j = await api("/api/jobs/" + encodeURIComponent(state.jobId));
      var pct = j.total ? Math.round((j.done / j.total) * 100) : 0;
      $("barFill").style.width = pct + "%";
      var running = (j.running || []);
      $("jobText").textContent = j.status === "running"
        ? ("运行中" + (j.concurrency ? "（并发 " + j.concurrency + "）" : "") + "：" + (running.length ? running.join("、") : "…"))
        : (j.status === "done" ? "运行完成" : "运行失败");
      $("jobCount").textContent = j.done + "/" + j.total;
      $("jobLog").textContent = (j.logs || []).join("\n");
      $("jobLog").scrollTop = $("jobLog").scrollHeight;

      if (j.status === "running") {
        state.jobTimer = setTimeout(pollJob, 700);
        return;
      }

      state.busy = false;
      state.jobId = null;
      updateRunButton();
      if (j.error) toast(j.error, true);
      await refreshCases();
      await selectCase(state.caseId);
      if (j.status === "done") toast("运行完成 · " + j.done + " 个模型");
    } catch (e) {
      state.busy = false;
      state.jobId = null;
      updateRunButton();
      toast("读取任务状态失败：" + e.message, true);
    }
  }

  /* ---------------- 结果 ---------------- */

  function renderRuns() {
    var host = $("runGrid");
    host.innerHTML = "";
    $("runCount").textContent = "（" + state.runs.length + "）";
    if (!state.runs.length) {
      host.appendChild(el("div", "hint", "还没有结果。选择模型后点「运行选中」。"));
      return;
    }
    var list = state.runs.slice().sort(function (a, b) {
      return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
    });
    list.forEach(function (r) {
      host.appendChild(runCard(r));
    });
  }

  function runCard(r) {
    var card = el("div", "run-card" + (r.isBaseline ? " baseline" : "") + (r.status === "ok" ? "" : " error"));

    var box = el("div", "run-img");
    if (r.status === "ok") {
      var img = document.createElement("img");
      img.src = "/api/cases/" + encodeURIComponent(state.caseId) + "/runs/" + encodeURIComponent(r.runId) + "/image";
      img.alt = r.model;
      img.loading = "lazy";
      box.appendChild(img);
      box.addEventListener("click", function () {
        openLightbox(img.src, r.model + " · " + fmtDur(r.latencyMs));
      });
    } else {
      box.appendChild(el("div", "fail", "失败\n" + (r.error || "未知错误")));
    }
    card.appendChild(box);

    var body = el("div", "run-body");
    var head = el("div", "run-head");
    head.appendChild(el("div", "run-model", r.model));
    if (r.isBaseline) head.appendChild(el("span", "run-base", "基准"));
    else if (r.status === "ok") {
      var b = el("button", "run-base-btn", "设为基准");
      b.type = "button";
      b.addEventListener("click", function (ev) {
        ev.stopPropagation();
        setBaseline(r.runId);
      });
      head.appendChild(b);
    }
    body.appendChild(head);

    body.appendChild(el("div", "run-meta",
      fmtDur(r.latencyMs) + " · " +
      (r.width ? r.width + "×" + r.height : "尺寸未知") + " · " +
      fmtBytes(r.bytes)));

    /* 本地模型：把复现参数露出来（seed + 工作流指纹 + 模型文件） */
    if (r.provenance) {
      var pv = r.provenance;
      var line = "seed " + (pv.seed == null ? "随机" : pv.seed) +
        " · wf " + (pv.workflowHash || "—") +
        (pv.samplers && pv.samplers[0] ? (" · " + pv.samplers[0].steps + "步/" + pv.samplers[0].cfg + "cfg") : "");
      var pvEl = el("div", "run-meta prov", line);
      pvEl.title = (pv.presetName || "") + " · " + (pv.url || "") +
        (pv.modelFiles && pv.modelFiles.length ? ("\n模型：" + pv.modelFiles.join("、")) : "");
      body.appendChild(pvEl);
    }

    if (r.status !== "ok") {
      body.appendChild(el("div", "run-err", r.error || "未知错误"));
    } else {
      var stars = el("div", "stars");
      for (var i = 1; i <= 5; i++) {
        (function (n) {
          var s = el("button", "star" + ((r.rating || 0) >= n ? " on" : ""), "★");
          s.type = "button";
          s.title = n + " 星";
          s.addEventListener("click", function () {
            rate(r, r.rating === n ? 0 : n);
          });
          stars.appendChild(s);
        })(i);
      }
      body.appendChild(stars);

      var note = document.createElement("input");
      note.type = "text";
      note.className = "note";
      note.placeholder = "备注（失焦保存）";
      note.value = r.note || "";
      note.addEventListener("change", function () { saveNote(r, note.value); });
      body.appendChild(note);
    }

    card.appendChild(body);
    return card;
  }

  async function rate(run, rating) {
    try {
      await api("/api/cases/" + encodeURIComponent(state.caseId) + "/runs/" + encodeURIComponent(run.runId) + "/rating", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating: rating })
      });
      run.rating = rating;
      renderRuns();
    } catch (e) {
      toast("打分失败：" + e.message, true);
    }
  }

  async function saveNote(run, note) {
    try {
      await api("/api/cases/" + encodeURIComponent(state.caseId) + "/runs/" + encodeURIComponent(run.runId) + "/rating", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: note })
      });
      run.note = note;
      toast("备注已保存");
    } catch (e) {
      toast("保存备注失败：" + e.message, true);
    }
  }

  async function setBaseline(runId) {
    try {
      await api("/api/cases/" + encodeURIComponent(state.caseId) + "/runs/" + encodeURIComponent(runId) + "/baseline", {
        method: "POST"
      });
      await selectCase(state.caseId);
      toast("已设为基准");
    } catch (e) {
      toast("设置基准失败：" + e.message, true);
    }
  }

  async function deleteCase() {
    if (!state.caseId) return;
    if (!confirm("删除当前用例及其全部结果？此操作不可恢复。")) return;
    try {
      await api("/api/cases/" + encodeURIComponent(state.caseId), { method: "DELETE" });
      state.caseId = null;
      state.caseData = null;
      state.runs = [];
      $("caseView").classList.add("hidden");
      $("empty").classList.remove("hidden");
      $("btnDeleteCase").disabled = true;
      $("btnExportCase").disabled = true;
      await refreshCases();
      if (state.cases[0]) await selectCase(state.cases[0].id);
    } catch (e) {
      toast("删除失败：" + e.message, true);
    }
  }

  /* ---------------- Lightbox ---------------- */

  function openLightbox(url, caption) {
    $("lightImg").src = url;
    $("lightCap").textContent = caption || "";
    $("lightbox").classList.remove("hidden");
  }

  function closeLightbox() {
    $("lightbox").classList.add("hidden");
    $("lightImg").removeAttribute("src");
  }

  /* ---------------- 启动 ---------------- */

  async function saveKey() {
    var input = $("keyInput");
    var key = input ? input.value.trim() : "";
    if (!key) { toast("请填写 API Key", true); return; }
    try {
      await api("/api/config/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key })
      });
      if (input) input.value = "";
      await refreshCases();
      updateRunButton();
      toast("Key 已保存，可以开始运行");
    } catch (e) {
      toast("保存失败：" + e.message, true);
    }
  }

  async function init() {
    try {
      await refreshCases();
    } catch (e) {
      toast("无法连接服务：" + e.message, true);
      return;
    }
    var q = new URLSearchParams(location.search).get("case");
    var id = q && state.cases.some(function (c) { return c.id === q; }) ? q : (state.cases[0] && state.cases[0].id);
    if (id) await selectCase(id);
  }

  $("btnRefresh").addEventListener("click", async function () {
    try {
      await refreshCases();
      if (state.caseId) await selectCase(state.caseId);
      toast("已刷新");
    } catch (e) { toast("刷新失败：" + e.message, true); }
  });

  /* 本地 ComfyUI 在当前用例不支持时不计入批量勾选 */
  function selectable(m) {
    return !(m.id === "comfy" && state.comfy && !state.comfy.ok);
  }

  $("btnAll").addEventListener("click", function () {
    state.models.forEach(function (m) { if (selectable(m)) state.selected.add(m.id); });
    renderModels();
    updateRunButton();
  });

  $("btnNone").addEventListener("click", function () {
    state.selected.clear();
    renderModels();
    updateRunButton();
  });

  $("btnUnrun").addEventListener("click", function () {
    /* 已经有成功结果的模型不再勾选，节省重复请求 */
    var done = new Set(state.runs.filter(function (r) { return r.status === "ok"; }).map(function (r) { return r.model; }));
    state.selected.clear();
    state.models.forEach(function (m) { if (!done.has(m.id) && selectable(m)) state.selected.add(m.id); });
    renderModels();
    updateRunButton();
  });

  $("btnRun").addEventListener("click", runSelected);
  $("btnDeleteCase").addEventListener("click", deleteCase);

  $("caseSearch").addEventListener("input", function (e) {
    state.query = e.target.value || "";
    renderCaseList();
  });

  /* 导出当前用例的结果表（Excel 直接打开；带 BOM 避免中文乱码） */
  function csvCell(v) {
    var s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  $("btnExportCsv").addEventListener("click", function () {
    if (!state.caseId) return;
    var head = ["用例", "模型", "状态", "耗时(ms)", "宽", "高", "字节", "评分", "备注", "seed", "工作流指纹", "预设", "错误"];
    var rows = state.runs.map(function (r) {
      var pv = r.provenance || {};
      return [
        (state.caseData && state.caseData.title) || state.caseId,
        r.model, r.status, r.latencyMs, r.width, r.height, r.bytes,
        r.rating == null ? "" : r.rating, r.note || "",
        pv.seed == null ? "" : pv.seed, pv.workflowHash || "", pv.presetName || "",
        r.error || ""
      ];
    });
    var csv = "\ufeff" + [head].concat(rows).map(function (row) { return row.map(csvCell).join(","); }).join("\r\n");
    var blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "ps-spark-" + state.caseId + ".csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
    toast("已导出 " + rows.length + " 行");
  });

  /* 用例包：跨机搬同一份用例（图片 + 参数 + 可复现参数） */
  $("btnExportCase").addEventListener("click", function () {
    if (!state.caseId) return;
    location.href = "/api/cases/" + encodeURIComponent(state.caseId) + "/export";
  });

  $("btnImportCase").addEventListener("click", function () { $("caseFile").click(); });

  /* 提示词包：一行一条或 [A1] 分块，直接批量建文生图用例 */
  $("btnImportPack").addEventListener("click", function () { $("packFile").click(); });
  $("packFile").addEventListener("change", async function (ev) {
    var f = ev.target.files && ev.target.files[0];
    if (!f) return;
    try {
      var text = await f.text();
      var size = prompt("这批用例生成多大尺寸？（宽x高）", "1024x1024");
      if (size == null) return;
      var r = await api("/api/cases/import-pack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text, size: size.trim(), pack: f.name })
      });
      await refreshCases();
      if (r.cases && r.cases[0]) await selectCase(r.cases[0].id);
      var msg = "已建 " + r.created + " 条用例";
      if (r.skipped) msg += "，跳过重复 " + r.skipped + " 条";
      if (r.ignored && r.ignored.length) msg += "；" + r.ignored.length + " 条没建（缺「输入：」行，如 " + r.ignored[0] + "）";
      toast(msg);
    } catch (e) {
      toast("导入提示词包失败：" + e.message, true);
    } finally {
      ev.target.value = "";
    }
  });
  $("caseFile").addEventListener("change", async function (ev) {
    var f = ev.target.files && ev.target.files[0];
    if (!f) return;
    try {
      var txt = await f.text();
      var bundle = JSON.parse(txt);
      var r = await api("/api/cases/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bundle)
      });
      await refreshCases();
      await selectCase(r.id);
      toast("已导入：" + (r.title || r.id));
    } catch (e) {
      toast("导入失败：" + e.message, true);
    } finally {
      ev.target.value = "";
    }
  });
  $("keySave").addEventListener("click", saveKey);
  $("keyInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") saveKey();
  });
  $("lightbox").addEventListener("click", closeLightbox);

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeLightbox();
  });

  init();
})();

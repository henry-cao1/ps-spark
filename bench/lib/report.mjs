/* report.mjs — 生成单文件 HTML 报告（图片按相对路径引用，双击即可看） */

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export function buildReport(run) {
  const data = JSON.stringify(run).replace(/</g, "\\u003c");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>模型基准测试 ${esc(run.id)}</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --line:#e3e6ea; --text:#1f2328; --dim:#6b7280; --accent:#534AB7; --ok:#1a7f37; --bad:#b42318; --warn:#9a6700; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  header { padding:20px 24px 12px; background:#fff; border-bottom:1px solid var(--line); }
  h1 { font-size:18px; margin:0 0 4px; font-weight:600; }
  .meta { color:var(--dim); font-size:12px; }
  main { padding:16px 24px 60px; }
  h2 { font-size:14px; margin:20px 0 8px; font-weight:600; }
  table { border-collapse:collapse; background:var(--card); border:1px solid var(--line); border-radius:8px; overflow:hidden; }
  th, td { border-bottom:1px solid var(--line); padding:6px 10px; text-align:left; vertical-align:middle; }
  th { background:#fafbfc; font-weight:600; font-size:12px; color:var(--dim); white-space:nowrap; }
  td.num { font-variant-numeric:tabular-nums; white-space:nowrap; }
  .matrix th.case, .matrix td.case { position:sticky; left:0; background:#fff; min-width:150px; z-index:1; }
  .matrix th.case { background:#fafbfc; }
  .cell { cursor:pointer; }
  .cell:hover { outline:2px solid var(--accent); outline-offset:-2px; }
  .thumb { width:120px; height:90px; object-fit:cover; border-radius:4px; background:#eee; display:block; }
  .badges { display:flex; gap:4px; flex-wrap:wrap; margin-top:4px; font-size:10px; }
  .b { padding:1px 5px; border-radius:999px; background:#eef0f3; color:var(--dim); }
  .b.ok { background:#e7f6ec; color:var(--ok); }
  .b.bad { background:#fdecea; color:var(--bad); }
  .b.warn { background:#fff4e5; color:var(--warn); }
  .stars { margin-top:4px; user-select:none; }
  .stars span { cursor:pointer; color:#d0d4da; font-size:13px; }
  .stars span.on { color:#e0a800; }
  .modal { position:fixed; inset:0; background:rgba(0,0,0,.55); display:none; align-items:center; justify-content:center; padding:20px; z-index:50; }
  .modal.on { display:flex; }
  .modal .box { background:#fff; border-radius:10px; max-width:900px; width:100%; max-height:90vh; overflow:auto; }
  .modal .hd { display:flex; justify-content:space-between; align-items:center; padding:12px 16px; border-bottom:1px solid var(--line); }
  .modal .bd { padding:16px; display:grid; grid-template-columns:1fr 260px; gap:16px; }
  .modal img { width:100%; border-radius:6px; background:#f2f2f2; }
  .modal .kv { font-size:12px; }
  .modal .kv div { display:flex; justify-content:space-between; padding:3px 0; border-bottom:1px dashed var(--line); }
  .modal pre { white-space:pre-wrap; font-size:11px; background:#f6f7f9; padding:8px; border-radius:6px; max-height:180px; overflow:auto; }
  button { font:inherit; cursor:pointer; border:1px solid var(--line); background:#fff; border-radius:6px; padding:5px 10px; }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  .toolbar { display:flex; gap:8px; align-items:center; margin:8px 0; }
  .empty { color:var(--dim); padding:10px; }
</style>
</head>
<body>
<header>
  <h1>模型基准测试报告 · ${esc(run.id)}</h1>
  <div class="meta">
    ${esc(run.startedAt)} · 模型 ${run.models.length} 个 · 用例 ${run.cases.length} 个 · 请求 ${run.results.length} 次 ·
    成功率 <b id="okrate">-</b> ${run.mode === "mock" ? ' · <span style="color:#b42318">MOCK 数据（仅验证流程）</span>' : ""}
  </div>
</header>
<main>
  <div class="toolbar">
    <button class="primary" id="exportBtn">导出人工评分 JSON</button>
    <button id="failBtn">只看失败</button>
    <span class="meta">点任意单元格看大图与完整提示词；星标为人工评分（1–5）</span>
  </div>
  <h2>模型汇总</h2>
  <table id="summary"></table>
  <h2>用例 × 模型</h2>
  <table class="matrix" id="matrix"></table>
</main>

<div class="modal" id="modal">
  <div class="box">
    <div class="hd"><b id="mTitle"></b><button id="mClose">关闭</button></div>
    <div class="bd">
      <div><img id="mImg" alt=""><pre id="mPrompt"></pre></div>
      <div class="kv" id="mKv"></div>
    </div>
  </div>
</div>

<script>
const RUN = ${data};
const RKEY = "bench.rate." + RUN.id;
const ratings = JSON.parse(localStorage.getItem(RKEY) || "{}");

function keyOf(c, m) { return c + "|" + m; }
function ratingOf(c, m) { return ratings[keyOf(c, m)] || 0; }
function median(a) { if (!a.length) return null; a = a.slice().sort((x,y)=>x-y); const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function fmt(n, d) { return n == null || isNaN(n) ? "-" : Number(n).toFixed(d == null ? 0 : d); }
function pct(n) { return n == null ? "-" : (n*100).toFixed(0) + "%"; }

/* ---- 汇总 ---- */
const byModel = {};
RUN.models.forEach(m => { byModel[m.id] = { ok:0, all:0, lat:[], outside:[], cost:0, rates:[], cAll:0, cPass:0 }; });
RUN.results.forEach(r => {
  const s = byModel[r.model]; if (!s) return;
  s.all++;
  if (r.status === "ok") s.ok++;
  if (r.latencyMs) s.lat.push(r.latencyMs);
  if (r.outsideChange != null) s.outside.push(r.outsideChange);
  if (r.cost) s.cost += r.cost;
  if (r.checksPass != null) { s.cAll++; if (r.checksPass) s.cPass++; }
  const rt = ratingOf(r.caseId, r.model); if (rt) s.rates.push(rt);
});
const sum = document.getElementById("summary");
sum.innerHTML = "<tr><th>模型</th><th>成功率</th><th>硬指标通过</th><th>中位耗时</th><th>平均框外变化</th><th>人工均分</th><th>估算成本</th></tr>" +
  RUN.models.map(m => {
    const s = byModel[m.id];
    const avgOut = s.outside.length ? s.outside.reduce((a,b)=>a+b,0)/s.outside.length : null;
    const avgRate = s.rates.length ? s.rates.reduce((a,b)=>a+b,0)/s.rates.length : null;
    return "<tr><td>" + m.label + "<div class='meta'>" + m.id + "</div></td>" +
      "<td class='num'>" + pct(s.all ? s.ok/s.all : null) + "</td>" +
      "<td class='num'>" + (s.cAll ? pct(s.cPass/s.cAll) : "-") + "</td>" +
      "<td class='num'>" + (median(s.lat) ? (median(s.lat)/1000).toFixed(1) + "s" : "-") + "</td>" +
      "<td class='num'>" + (avgOut == null ? "-" : avgOut.toFixed(1) + "%") + "</td>" +
      "<td class='num'>" + (avgRate == null ? "-" : avgRate.toFixed(1)) + "</td>" +
      "<td class='num'>" + (s.cost ? "¥" + s.cost.toFixed(2) : "-") + "</td></tr>";
  }).join("");

const all = RUN.results;
document.getElementById("okrate").textContent = pct(all.length ? all.filter(r=>r.status==="ok").length/all.length : null);

/* ---- 矩阵 ---- */
let onlyFail = false;
function renderMatrix() {
  const t = document.getElementById("matrix");
  let html = "<tr><th class='case'>用例</th>" + RUN.models.map(m => "<th>" + m.label + "</th>").join("") + "</tr>";
  RUN.cases.forEach(c => {
    html += "<tr><th class='case'>" + c.title + "<div class='meta'>" + c.instance + "</div></th>";
    RUN.models.forEach(m => {
      const r = all.find(x => x.caseId === c.id && x.model === m.id);
      if (!r) { html += "<td class='empty'>-</td>"; return; }
      if (onlyFail && r.status === "ok") { html += "<td class='empty'>—</td>"; return; }
      const rt = ratingOf(c.id, m.id);
      const stars = [1,2,3,4,5].map(n => "<span class='" + (n<=rt?"on":"") + "' data-c='" + c.id + "' data-m='" + m.id + "' data-v='" + n + "'>★</span>").join("");
      html += "<td class='cell' data-c='" + c.id + "' data-m='" + m.id + "'>" +
        (r.image ? "<img class='thumb' loading='lazy' src='" + r.image + "' alt=''>" : "<div class='thumb'></div>") +
        "<div class='badges'>" +
        (r.status === "ok" ? "<span class='b ok'>OK</span>" : "<span class='b bad'>FAIL</span>") +
        (r.latencyMs ? "<span class='b'>" + (r.latencyMs/1000).toFixed(1) + "s</span>" : "") +
        (r.width ? "<span class='b'>" + r.width + "×" + r.height + "</span>" : "") +
        (r.outsideChange != null ? "<span class='b " + (r.outsideChange > 8 ? "warn" : "ok") + "'>框外 " + r.outsideChange.toFixed(1) + "%</span>" : "") +
        (r.blankScore != null && r.blankScore < 3 ? "<span class='b bad'>疑似空图</span>" : "") +
        (r.checks || []).map(ch => "<span class='b " + (ch.pass ? "ok" : "bad") + "'>" + ch.name + (ch.detail ? " " + ch.detail : "") + "</span>").join("") +
        "</div><div class='stars'>" + stars + "</div></td>";
    });
    html += "</tr>";
  });
  t.innerHTML = html;
  t.querySelectorAll(".stars span").forEach(el => el.addEventListener("click", ev => {
    ev.stopPropagation();
    const k = keyOf(el.dataset.c, el.dataset.m);
    ratings[k] = Number(el.dataset.v);
    localStorage.setItem(RKEY, JSON.stringify(ratings));
    renderMatrix();
  }));
  t.querySelectorAll(".cell").forEach(el => el.addEventListener("click", () => openDetail(el.dataset.c, el.dataset.m)));
}
renderMatrix();

document.getElementById("failBtn").addEventListener("click", () => { onlyFail = !onlyFail; renderMatrix(); });
document.getElementById("exportBtn").addEventListener("click", () => {
  const out = { runId: RUN.id, exportedAt: new Date().toISOString(), ratings: {} };
  Object.keys(ratings).forEach(k => { const [c,m] = k.split("|"); (out.ratings[c] = out.ratings[c] || {})[m] = ratings[k]; });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
  a.download = "ratings-" + RUN.id + ".json";
  a.click();
});

/* ---- 详情 ---- */
function openDetail(cid, mid) {
  const r = all.find(x => x.caseId === cid && x.model === mid);
  const c = RUN.cases.find(x => x.id === cid);
  if (!r) return;
  document.getElementById("mTitle").textContent = (c ? c.title : cid) + " · " + mid;
  const img = document.getElementById("mImg");
  if (r.image) { img.src = r.image; img.style.display = "block"; } else { img.removeAttribute("src"); img.style.display = "none"; }
  document.getElementById("mPrompt").textContent = r.prompt || "(无提示词记录)";
  const rows = [
    ["状态", r.status === "ok" ? "成功" : "失败"],
    ["错误", r.error || "-"],
    ["耗时", r.latencyMs ? (r.latencyMs/1000).toFixed(2) + " s" : "-"],
    ["尺寸", r.width ? r.width + " × " + r.height : "-"],
    ["比例误差", r.aspectError == null ? "-" : (r.aspectError*100).toFixed(1) + "%"],
    ["含透明通道", r.hasAlpha == null ? "-" : (r.hasAlpha ? "是" : "否")],
    ["空图评分", r.blankScore == null ? "-" : r.blankScore.toFixed(1)],
    ["框外变化", r.outsideChange == null ? "-" : r.outsideChange.toFixed(2) + "%"],
    ["整体变化", r.diffRatio == null ? "-" : (r.diffRatio*100).toFixed(1) + "%"],
    ["提示词长度", (r.prompt || "").length + " 字"],
    ["估算成本", r.cost == null ? "-" : "¥" + r.cost.toFixed(3)]
  ];
  document.getElementById("mKv").innerHTML = rows.map(([k,v]) => "<div><span>" + k + "</span><b>" + String(v) + "</b></div>").join("");
  document.getElementById("modal").classList.add("on");
}
document.getElementById("mClose").addEventListener("click", () => document.getElementById("modal").classList.remove("on"));
document.getElementById("modal").addEventListener("click", e => { if (e.target.id === "modal") e.currentTarget.classList.remove("on"); });
</script>
</body>
</html>`;
}

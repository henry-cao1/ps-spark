/*
 * store.js — Job/Asset 最小存储（W5）
 *
 * 目录结构（插件数据目录下，仅管理自建目录，绝不触碰其它文件）：
 *   history/jobs.json                    任务索引（最新在前，摘要字段）
 *   history/<jobId>/job.json             任务详情（含参数快照，供"重新生成"跨会话复用）
 *   history/<jobId>/psspark_result.png     结果图（扩展名以真实格式为准，GIF 结果即 .gif）
 *   history/<jobId>/psspark_result_thumb.png  卡片缩略图（始终 png，长边 256）
 *
 * 原则：一切操作 try/catch + diag——存储失败绝不中断主流程。
 * 清理策略（v1.1 最小版）：索引上限 200 条，超出裁剪最旧（收藏豁免）并静默删除其文件；完整清理 UI 归 v1.3。
 */

const Store = {
  jobs: [],      /* 内存索引（最新在前） */
  ready: false
};

const STORE_MAX_JOBS = 200;

/* ---- 缓存位置（默认：插件数据目录/history；自定义：所选目录/PS SparkHistory） ---- */

const STORE_CUSTOM_ROOT_KEY = "psspark.historyCustomRoot";
let __storeCustomRootEntry = null; /* null=使用默认位置 / Folder=自定义位置 */

function __storeCustomRootPath() {
  try { return localStorage.getItem(STORE_CUSTOM_ROOT_KEY) || ""; } catch (e) { return ""; }
}
function __storeSetCustomRootPath(p) {
  try {
    if (p) localStorage.setItem(STORE_CUSTOM_ROOT_KEY, p);
    else localStorage.removeItem(STORE_CUSTOM_ROOT_KEY);
  } catch (e) { /* ignore */ }
}

/* 绝对路径 → file URL。UXP 在 Windows 上只认 file:///C:/… 这种正斜杠三斜杠写法，
   拼成 "file:" + "C:\Users\…" 会解析失败（mac 上 "/Users/…" 恰好能过，所以只在 Win 暴露）。 */
function __storeFileUrl(p) {
  let s = String(p || "").trim().replace(/\\/g, "/");
  if (!s) return "";
  if (/^file:/i.test(s)) {
    s = s.replace(/^file:\/+/i, "");
    return "file:///" + s.replace(/^\/+/, "");
  }
  /* UNC 路径 \\server\share → file://server/share（两个斜杠是主机名，不能转成三斜杠的本地路径） */
  if (s.indexOf("//") === 0) return "file:" + s;
  return "file:///" + s.replace(/^\/+/, "");
}

async function storeResolveRoot() {
  const p = __storeCustomRootPath();
  if (!p) { __storeCustomRootEntry = null; return; }
  try {
    const ent = await fs.getEntryWithUrl(__storeFileUrl(p));
    if (ent && ent.isFolder) {
      __storeCustomRootEntry = ent;
      diag("store: 使用自定义缓存位置 " + p);
      return;
    }
    throw new Error("不是有效文件夹");
  } catch (e) {
    diag("store: 自定义缓存位置不可用（" + e.message + "），已回退默认位置");
    __storeSetCustomRootPath("");
    __storeCustomRootEntry = null;
  }
}

function storeCustomRootInfo() {
  if (__storeCustomRootEntry) {
    return { custom: true, path: __storeCustomRootEntry.nativePath || "" };
  }
  return { custom: false, path: "" };
}

async function __storeHistoryFolder(create) {
  let root = null, sub = "history";
  if (__storeCustomRootEntry) { root = __storeCustomRootEntry; sub = "PS SparkHistory"; }
  else { root = await fs.getDataFolder(); sub = "history"; }
  let h = null;
  try { h = await root.getEntry(sub); } catch (e) { h = null; }
  if (!h && create) h = await root.createFolder(sub);
  return h;
}

function __storeId() {
  return "j" + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);
}

/* 归档缩略图命名：psspark_result.png -> psspark_result_thumb.png（同目录旁挂一张）。
 * 缩略图只服务历史卡片（长边 256、约 20KB）；插入图层 / 重建必须用原图，
 * 所以凡是「列目录里的图」「按名找图」的地方都要把它排掉，否则会被当成候选结果。
 * gif 同样算结果图（gpt-image-2.6 会出 GIF），缩略图统一落成 png 首帧。 */
function storeThumbName(fileName) {
  const s = String(fileName || "psspark_result.png");
  const m = /^(.*)\.(png|jpe?g|webp|gif)$/i.exec(s);
  return (m ? m[1] : s) + "_thumb.png";
}
function storeIsThumbName(name) { return /_thumb\.png$/i.test(String(name || "")); }

/* 去掉扩展名的基名：psspark_result.gif → psspark_result。
 * 判断「哪张是主结果」要用它，不能写死 .png（GIF 结果就叫 psspark_result.gif）。 */
function storeNameBase(name) {
  return String(name || "").replace(/\.[^.]+$/, "");
}

/* 目录项是不是一张结果图（排除缩略图）。历史扫描 / 兜底找图共用同一套判断。 */
function storeIsResultImageName(name) {
  return /\.(png|jpe?g|webp|gif)$/i.test(String(name || "")) && !storeIsThumbName(name);
}

async function __storeWriteIndex() {
  try {
    const h = await __storeHistoryFolder(true);
    const f = await h.createFile("jobs.json", { overwrite: true });
    await f.write(JSON.stringify(Store.jobs, null, 1), { format: formats.utf8 });
  } catch (e) { diag("store: 索引写入失败 " + e.message); }
}

async function __storeWriteJobDetail(job) {
  try {
    const h = await __storeHistoryFolder(true);
    let jd = null;
    try { jd = await h.getEntry(job.id); } catch (e) { jd = null; }
    if (!jd) jd = await h.createFolder(job.id);
    const f = await jd.createFile("job.json", { overwrite: true });
    await f.write(JSON.stringify(job, null, 1), { format: formats.utf8 });
  } catch (e) { diag("store: 任务详情写入失败 " + e.message); }
}

async function __storeRmTree(folder) {
  try {
    const items = await folder.getEntries();
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.isFolder) await __storeRmTree(it);
      else await it.delete();
    }
    await folder.delete();
  } catch (e) { diag("store: 删除目录警告 " + e.message); }
}

/* 索引裁剪：超上限时保留最新的（收藏豁免），并静默清理被裁任务的文件 */
function __storeTrim() {
  if (Store.jobs.length <= STORE_MAX_JOBS) return;
  const keep = [], drop = [];
  Store.jobs.forEach(function (j) {
    if (j.favorite) keep.push(j);
    else if (keep.length < STORE_MAX_JOBS) keep.push(j); /* 含收藏在内按序保留 */
    else drop.push(j);
  });
  if (drop.length) {
    Store.jobs = keep;
    drop.forEach(function (j) {
      (async function () {
        try {
          const h = await __storeHistoryFolder(false);
          if (!h) return;
          let jd = null;
          try { jd = await h.getEntry(j.id); } catch (e) { jd = null; }
          if (jd) await __storeRmTree(jd);
          diag("store: 已清理超限任务 " + j.id);
        } catch (e) { /* ignore */ }
      })();
    });
  }
}

/* ---- 对外 API ---- */

async function storeInit() {
  try {
    await storeResolveRoot();
    const h = await __storeHistoryFolder(false);
    if (!h) { Store.ready = true; diag("store: 首次使用（暂无历史目录）"); return; }
    try {
      const idx = await h.getEntry("jobs.json");
      const raw = await idx.read({ format: formats.utf8 });
      const arr = JSON.parse(typeof raw === "string" ? raw : String(raw));
      if (Array.isArray(arr)) Store.jobs = arr;
      diag("store: 载入 " + Store.jobs.length + " 条任务记录");
    } catch (e) {
      diag("store: 索引缺失/损坏，从空开始 (" + e.message + ")");
    }
    /* 上次运行被强行退出（关 PS / 崩溃）的任务会永远停在 running：
     * 历史里显示「运行中」且插入按钮永久不可点。启动时统一收尾。 */
    await storeSweepStale();
    Store.ready = true;
  } catch (e) {
    diag("store init warn: " + e.message);
    Store.ready = false;
  }
}

/* 把残留的 running 任务标记为失败（索引落盘） */
async function storeSweepStale() {
  let changed = false;
  (Store.jobs || []).forEach(function (j) {
    if (j && j.status === "running") {
      j.status = "failed";
      j.error = "上次运行未完成（Photoshop 已关闭或中断）";
      changed = true;
    }
  });
  if (changed) {
    await __storeWriteIndex();
    diag("store: 已把上次中断的任务标记为失败");
  }
  return changed;
}

/* 运行开始时创建任务（内存态；成功/失败时落盘） */
function storeCreateJob(inst, snap, model) {
  const job = {
    id: __storeId(),
    time: new Date().toISOString(),
    source: { domain: inst.domain, instanceId: inst.id, instanceName: inst.name },
    model: model || "",
    params: {
      userText: snap.userText || "",
      tplOverride: snap.tplOverride || "",
      params: snap.params || {},
      locate: snap.locate || {}
    },
    status: "running",
    cost: { image: (inst.cost && inst.cost.image != null) ? inst.cost.image : 1, text: 0 },
    favorite: false,
    assets: []
  };
  Store.jobs.unshift(job);
  __storeTrim();
  return job;
}

/* 成功：复制结果图 + 写任务详情 + 更新索引。
 * entries：单个 entry，或 [{ entry, fileName }] 数组（多候选：psspark_result.png / psspark_cand_2.png …） */
async function storeCompleteJob(job, entries, extra) {
  if (!job) return;
  job.status = "success";
  job.layerName = (extra && extra.layerName) || "";
  job.secs = (extra && extra.secs != null) ? extra.secs : null;
  if (extra && extra.placeTarget) job.placeTarget = extra.placeTarget;
  job.prompt = (extra && extra.prompt) ? String(extra.prompt).slice(0, 1200) : "";

  const list = [];
  if (entries) {
    if (Array.isArray(entries)) {
      entries.forEach(function (it) {
        if (!it) return;
        if (it.entry) list.push({ entry: it.entry, file: it.fileName || (it.entry && it.entry.name) || "psspark_result.png" });
        else list.push({ entry: it, file: (it && it.name) || "psspark_result.png" });
      });
    } else {
      list.push({ entry: entries, file: (entries && entries.name) || "psspark_result.png" });
    }
  }
  if (list.length) {
    job.assets = list.map(function (it, i) {
      return { id: job.id + "-a" + (i + 1), form: "single", file: it.file, status: "done" };
    });
    try {
      const h = await __storeHistoryFolder(true);
      let jd = null;
      try { jd = await h.getEntry(job.id); } catch (e) { jd = null; }
      if (!jd) jd = await h.createFolder(job.id);
      for (let i = 0; i < list.length; i++) {
        try { await list[i].entry.copyTo(jd, { overwrite: true }); }
        catch (e2) { diag("store: 结果图 " + list[i].file + " 归档失败 " + e2.message); }
      }
      diag("store: 结果图已归档 -> history/" + job.id + "/ （" + list.length + " 张）");
      /* 缩略图：只在「结果图此刻已经在画布图层上」时顺手取一张（约 100ms，不新建文档）。
       * extra.thumb = { docId, layerId, file }；没有图层（例如多候选还没选）就跳过，
       * 等用户插入那次再补 —— 历史页永远不会为了缩略图去打开图片。 */
      const tb = extra && extra.thumb;
      if (tb && tb.layerId != null && typeof writeLayerThumb === "function") {
        try {
          await writeLayerThumb(tb.docId, tb.layerId, jd, storeThumbName(tb.file || "psspark_result.png"));
        } catch (e4) {
          diag("store: 归档缩略图跳过 -> " + ((e4 && e4.message) || String(e4)));
        }
      }
    } catch (e) { diag("store: 结果图归档失败 " + e.message); }
  }
  await __storeWriteJobDetail(job);
  await __storeWriteIndex();
}

function storeFailJob(job, msg) {
  if (!job) return;
  job.status = "failed";
  job.error = String(msg || "").slice(0, 300);
  __storeWriteIndex();
}

async function storeToggleFavorite(job) {
  if (!job) return false;
  job.favorite = !job.favorite;
  await __storeWriteJobDetail(job);
  await __storeWriteIndex();
  diag("store: 任务 " + job.id + " 收藏 -> " + job.favorite);
  return job.favorite;
}

async function storeDeleteJob(job) {
  if (!job) return;
  const i = Store.jobs.indexOf(job);
  if (i >= 0) Store.jobs.splice(i, 1);
  try {
    const h = await __storeHistoryFolder(false);
    if (h) {
      let jd = null;
      try { jd = await h.getEntry(job.id); } catch (e) { jd = null; }
      if (jd) await __storeRmTree(jd);
    }
  } catch (e) { diag("store: 删除任务文件警告 " + e.message); }
  await __storeWriteIndex();
  diag("store: 任务 " + job.id + " 已删除（历史副本；PS 图层不受影响）");
}

/* ---- 历史浏览 / 缓存管理（W6） ---- */

/* 取任务归档的结果文件 entry（历史缩略图 / 插入为新图层用） */
async function storeJobFileEntry(job, fileName) {
  if (!job) return null;
  try {
    const h = await __storeHistoryFolder(false);
    if (!h) return null;
    let jd = null;
    try { jd = await h.getEntry(job.id); } catch (e) { jd = null; }
    if (!jd) return null;
    let f = null;
    try { f = await jd.getEntry(fileName || "psspark_result.png"); } catch (e) { f = null; }
    /* 指定名不存在（旧记录 / 归档名与 assets 记录不一致）时，退回目录里实际存在的第一张图：
     * 缩略图和「插入为新图层」都不该因为一个名字对不上而整条失效。 */
    if (!f) {
      try {
        const items = await jd.getEntries();
        const imgs = items
          .filter(function (it) { return !it.isFolder && storeIsResultImageName(it.name); })
          .map(function (it) { return it.name; })
          .sort(function (a, b) {
            const ra = storeNameBase(a) === "psspark_result";
            const rb = storeNameBase(b) === "psspark_result";
            if (ra !== rb) return ra ? -1 : 1;
            return a < b ? -1 : (a > b ? 1 : 0);
          });
        if (imgs.length) f = await jd.getEntry(imgs[0]);
      } catch (e2) { f = null; }
    }
    return f;
  } catch (e) { diag("store: 读取任务文件失败 " + e.message); return null; }
}

/* 取某张归档图的缩略图 entry（没有就返回 null）。
 * 缩略图缺失不影响功能：历史卡片会显示占位，点插入/保存时再补。 */
async function storeJobThumbEntry(job, fileName) {
  if (!job || !job.id) return null;
  try {
    const h = await __storeHistoryFolder(false);
    if (!h) return null;
    let jd = null;
    try { jd = await h.getEntry(job.id); } catch (e) { jd = null; }
    if (!jd) return null;
    try { return await jd.getEntry(storeThumbName(fileName)); } catch (e2) { return null; }
  } catch (e) { return null; }
}

/* 任务目录里任意一张缩略图（主图缺、但用户插入过别的候选时用得上）。
 * 优先 psspark_result_thumb.png，其次文件名排序第一张。
 * 返回 { entry, file }：file 是这张缩略图对应的**原图**名，点开预览要用它，
 * 否则会出现「卡片是候选 3、点开却是候选 1」。没有就 null。 */
async function storeJobAnyThumb(job) {
  if (!job || !job.id) return null;
  try {
    const h = await __storeHistoryFolder(false);
    if (!h) return null;
    let jd = null;
    try { jd = await h.getEntry(job.id); } catch (e) { jd = null; }
    if (!jd) return null;
    let items = [];
    try { items = await jd.getEntries(); } catch (e2) { items = []; }
    const thumbs = items
      .filter(function (it) { return !it.isFolder && storeIsThumbName(it.name); })
      .map(function (it) { return it.name; })
      .sort();
    if (!thumbs.length) return null;
    const pref = storeThumbName("psspark_result.png");
    const pick = thumbs.indexOf(pref) >= 0 ? pref : thumbs[0];
    let entry = null;
    try { entry = await jd.getEntry(pick); } catch (e3) { return null; }
    /* 缩略图名 → 目录里真实存在的原图名（原图可能是 .png/.jpg/.webp） */
    const base = pick.replace(/_thumb\.png$/i, "");
    let file = base + ".png";
    try {
      items.forEach(function (it) {
        if (it.isFolder || storeIsThumbName(it.name)) return;
        if (String(it.name).replace(/\.[^.]+$/, "") === base) file = it.name;
      });
    } catch (e4) { /* 保持默认 .png */ }
    return { entry: entry, file: file };
  } catch (e) { return null; }
}

/* 插入为新图层之后：用刚生成的图层给这张归档图补一张缩略图。
 * 旧记录（没有缩略图）也是靠这条路径慢慢补上，且不会额外打开任何文档。 */
async function storeSetJobThumb(job, fileName, docId, layerId) {
  if (!job || !job.id || layerId == null) return null;
  const name = fileName || "psspark_result.png";
  if (storeIsThumbName(name)) return null;
  try {
    const h = await __storeHistoryFolder(false);
    if (!h) return null;
    let jd = null;
    try { jd = await h.getEntry(job.id); } catch (e) { jd = null; }
    if (!jd) return null;
    if (typeof writeLayerThumb !== "function") return null;
    return await writeLayerThumb(docId, layerId, jd, storeThumbName(name));
  } catch (e) {
    diag("store: 补缩略图跳过 " + name + " -> " + ((e && e.message) || String(e)));
    return null;
  }
}

/* ⚠ 只在用户手动点「补缩略图」时调用（历史页头部），不要自动调。
 * 它需要临时打开归档图才能缩放，会连续开关文档、画面一直闪；
 * 新任务在保存时、插入时都已经有缩略图了，只有旧记录需要补。
 * 已有 → 直接返回；没有 → 排队生成（ps.js 串行队列，内部失败只记日志）。 */
async function storeEnsureJobThumb(job, fileName, opts) {
  if (!job || !job.id) return null;
  const name = fileName || "psspark_result.png";
  if (storeIsThumbName(name)) return null;
  const thumbName = storeThumbName(name);
  try {
    const h = await __storeHistoryFolder(false);
    if (!h) return null;
    let jd = null;
    try { jd = await h.getEntry(job.id); } catch (e) { jd = null; }
    if (!jd) return null;
    try {
      const had = await jd.getEntry(thumbName);
      if (had) return had;
    } catch (eHad) { /* 没有，接着生成 */ }
    const src = await storeJobFileEntry(job, name);
    if (!src) return null;
    if (typeof queueEntryThumb !== "function") return null;
    return await queueEntryThumb(src, jd, thumbName, !!(opts && opts.priority));
  } catch (e) {
    diag("store: 缩略图补生成异常 " + name + " -> " + ((e && e.message) || String(e)));
    return null;
  }
}

/* 列出某个任务实际归档的图片文件。
 * job.assets 可能来自旧版本、或写入索引时丢失，光看它会误判「没有结果」→ 插入按钮被禁用。
 * 这里直接扫任务目录，顺带把 assets 补回内存。 */
async function storeJobAssetNames(job) {
  if (!job || !job.id) return [];
  const names = [];
  try {
    const h = await __storeHistoryFolder(false);
    if (h) {
      let jd = null;
      try { jd = await h.getEntry(job.id); } catch (e) { jd = null; }
      if (jd) {
        const items = await jd.getEntries();
        items.forEach(function (it) {
          /* 缩略图是给卡片看的，不是结果图：混进来会让候选多出一张、插入插入到缩略图 */
          if (!it.isFolder && storeIsResultImageName(it.name)) names.push(it.name);
        });
      }
    }
  } catch (e) { diag("store: 扫描任务文件失败 " + e.message); }
  if (!names.length && job.assets && job.assets.length) {
    job.assets.forEach(function (a) { if (a && a.file) names.push(a.file); });
  }
  names.sort(function (a, b) {
    const ra = storeNameBase(a) === "psspark_result";
    const rb = storeNameBase(b) === "psspark_result";
    if (ra !== rb) return ra ? -1 : 1;
    return a < b ? -1 : (a > b ? 1 : 0);
  });
  return names;
}

async function __storeEntrySize(ent) {
  let total = 0;
  try {
    if (ent.isFolder) {
      const items = await ent.getEntries();
      for (let i = 0; i < items.length; i++) total += await __storeEntrySize(items[i]);
    } else {
      total = (typeof ent.size === "number") ? ent.size : 0;
    }
  } catch (e) { /* ignore */ }
  return total;
}

/* 缓存统计（任务数 / 收藏数 / 失败数 / 占用字节） */
async function storeStats() {
  let favorites = 0, failed = 0;
  Store.jobs.forEach(function (j) {
    if (j.favorite) favorites++;
    if (j.status === "failed") failed++;
  });
  let bytes = 0;
  try {
    const h = await __storeHistoryFolder(false);
    if (h) bytes = await __storeEntrySize(h);
  } catch (e) { /* ignore */ }
  return { count: Store.jobs.length, favorites: favorites, failed: failed, bytes: bytes };
}

/* 清理未收藏缓存（仅作用于插件自建历史目录；收藏任务豁免）。
 * 返回 { removed, kept }。 */
async function storeCleanup() {
  const keep = [], removed = [];
  Store.jobs.forEach(function (j) { (j.favorite ? keep : removed).push(j); });
  let h = null;
  try { h = await __storeHistoryFolder(false); } catch (e) { /* ignore */ }
  for (let i = 0; i < removed.length; i++) {
    const j = removed[i];
    try {
      if (h) {
        let jd = null;
        try { jd = await h.getEntry(j.id); } catch (e) { jd = null; }
        if (jd) await __storeRmTree(jd);
      }
    } catch (e) { /* ignore */ }
  }
  Store.jobs = keep;
  await __storeWriteIndex();
  diag("store: 清理完成——删除 " + removed.length + " 条，保留 " + keep.length + " 条（含收藏）");
  return { removed: removed.length, kept: keep.length };
}

/* 递归拷贝目录内容（用于切换缓存位置时迁移） */
async function __storeCopyTree(srcFolder, dstParent) {
  const items = await srcFolder.getEntries();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.isFolder) {
      let nf = null;
      try { nf = await dstParent.getEntry(it.name); } catch (e) { nf = null; }
      if (!nf) nf = await dstParent.createFolder(it.name);
      await __storeCopyTree(it, nf);
    } else {
      await it.copyTo(dstParent, { overwrite: true });
    }
  }
}

/* 切换缓存位置：先把现有历史迁移到新位置（失败则保持原位置），成功后切换并重新载入。 */
async function storeSetCustomRoot(folderEntry) {
  if (!folderEntry) return false;
  try {
    const oldH = await __storeHistoryFolder(false);
    let dst = null;
    try { dst = await folderEntry.getEntry("PS SparkHistory"); } catch (e) { dst = null; }
    if (!dst) dst = await folderEntry.createFolder("PS SparkHistory");
    if (oldH) await __storeCopyTree(oldH, dst);
    __storeSetCustomRootPath(folderEntry.nativePath || "");
    __storeCustomRootEntry = folderEntry;
    diag("store: 缓存位置已切换 -> " + (folderEntry.nativePath || ""));
    await storeInit();
    return true;
  } catch (e) {
    diag("store: 切换缓存位置失败 " + e.message);
    return false;
  }
}

/* 恢复默认缓存位置（把自定义位置中的历史迁回默认目录，best-effort） */
async function storeResetRoot() {
  try {
    const custH = await __storeHistoryFolder(false); /* 当前（自定义）位置 */
    __storeCustomRootEntry = null;
    __storeSetCustomRootPath("");
    const defH = await __storeHistoryFolder(true);   /* 默认位置（不存在则创建） */
    if (custH && defH) {
      try { await __storeCopyTree(custH, defH); } catch (e) { diag("store: 回迁拷贝警告 " + e.message); }
    }
    diag("store: 已恢复默认缓存位置");
    await storeInit();
    return true;
  } catch (e) {
    diag("store: 恢复默认位置失败 " + e.message);
    return false;
  }
}

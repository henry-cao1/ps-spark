/*
 * make-dev-preview.cjs — 生成可在普通 Chromium 中打开的开发者工作台预览页
 * 仅用于本地视觉校验（不参与插件构建、不打包）。
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "../ps-spark-plugin");
const OUT = path.resolve(__dirname, "preview/dev-preview.html");
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const stub = `
<script>
(function () {
  var doc = { id: 1, name: "测试.psd", width: 1080, height: 810, resolution: 72, layers: [], activeLayers: [] };
  window.require = function (m) {
    if (m === "photoshop") return {
      app: { activeDocument: doc, documents: [doc] },
      core: { executeAsModal: function (fn) { return Promise.resolve(fn()); } },
      action: { batchPlay: function () { return Promise.resolve([{}]); } },
      imaging: {}
    };
    if (m === "uxp") return {
      storage: {
        localFileSystem: {
          getEntry: function () { return Promise.reject(new Error("no")); },
          createFile: function (n) { return Promise.resolve({ name: n, read: function () { return Promise.resolve(new ArrayBuffer(4)); }, write: function () { return Promise.resolve(); }, copyTo: function () { return Promise.resolve(); } }); }
        },
        secureStorage: { getItem: function () { return Promise.resolve(null); }, setItem: function () { return Promise.resolve(); }, removeItem: function () { return Promise.resolve(); } },
        formats: { utf8: "utf8", binary: "binary" }
      }
    };
    throw new Error("unknown module " + m);
  };
})();
</script>`;

let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
html = html.replace(/<script src="js\/([^"]+)"><\/script>\s*/g, function (_, f) {
  return '<script src="file://' + path.join(ROOT, "js", f) + '"></script>\n';
});
html = html.replace("</head>", stub + "\n</head>");
html = html.replace(
  "</body>",
  `<script>
setTimeout(function () {
  try {
    if (window.DevMode) window.DevMode.open();
    var h = (location.hash || "").replace("#", "");
    if (h === "list" || h === "bench") {
      document.getElementById(h === "list" ? "dwTabList" : "dwTabBench").click();
    }
  } catch (e) { document.title = "preview-error: " + e.message; return; }
  setTimeout(function () {
    function w(id) { var n = document.getElementById(id); return n ? Math.round(n.getBoundingClientRect().width) : -1; }
    document.title = "vp=" + window.innerWidth + " doc=" + document.documentElement.clientWidth +
      " wb=" + w("devWorkbench") + " body=" + w("dwBody") +
      " tabs=" + w("dwTabList") + " pane=" + w("dwPaneSpec") + " prev=" + w("dwPreview");
    document.body.setAttribute("data-metrics", document.title);
  }, 300);
}, 300);
</script>
</body>`
);
fs.writeFileSync(OUT, html);
console.log(OUT);

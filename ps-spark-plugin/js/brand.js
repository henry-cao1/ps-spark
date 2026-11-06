/*
 * brand.js — 品牌与开源信息（唯一改这里）
 *
 * 发布前只需要填 repo / issues 两个地址；界面上的「源码地址」与
 * 「本软件开源，如购买请退款」提示都会自动跟随。
 * issues 留空时自动使用 <repo>/issues。
 */
const BRAND = {
  name: "PS Spark",
  version: "1.7.1",
  license: "AGPL-3.0",
  /* 默认界面语言：源码直接侧载时用 en；构建时由 tools/build.mjs 注入 zh / en */
  defaultLang: (function () {
    var built = "__DEFAULT_LANG__";
    return built === "zh" ? "zh" : "en";
  })(),
  /* 版权人：按作者署名，不使用仓库账号名 */
  author: "Cao",
  copyright: "Copyright (C) 2026 Cao",
  repo: "https://github.com/henry-cao1/ps-spark",
  issues: "",
  /* 仓库是否已公开：true 时提示条可点击跳转源码仓库 */
  public: true,
  /* 购买渠道退款说明用的联系方式，可留空 */
  contact: "",
  notice: "本软件已开源，如购买请退款"
};

function brandRepoUrl() {
  return String(BRAND.repo || "").replace(/\/+$/, "");
}

/* 仓库可访问 = 地址已填 + 已公开 */
function brandIsPublic() {
  return !!BRAND.public && !!brandRepoUrl();
}

function brandIssuesUrl() {
  if (BRAND.issues) return BRAND.issues;
  const r = brandRepoUrl();
  return r ? (r + "/issues") : "";
}

/* 打开外链：UXP 用 shell.openExternal，预览页用 window.open */
function openExternal(url) {
  if (!url) return;
  try {
    if (typeof require === "function") {
      const uxp = require("uxp");
      if (uxp && uxp.shell && uxp.shell.openExternal) {
        uxp.shell.openExternal(url);
        return;
      }
    }
  } catch (e) { /* 预览环境没有 uxp */ }
  try { window.open(url, "_blank"); } catch (e2) { /* ignore */ }
}

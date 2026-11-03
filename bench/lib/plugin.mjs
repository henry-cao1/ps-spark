/*
 * plugin.mjs — 把插件自己的 registry.js / services.js 装进一个 VM 里复用。
 *
 * 目的：benchmark 测的必须是"线上真正发出去的提示词与参数规则"，而不是另写一套。
 * 做法：提供最小 DOM / localStorage / diag 桩，直接执行插件源码，再取全局函数。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

export function loadPlugin(pluginDir) {
  const noop = () => {};
  const sandbox = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    Math, Date, JSON, Promise, Uint8Array, ArrayBuffer,
    navigator: { userAgent: "node-bench" },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    diag: noop,
    log: noop,
    $: () => null,
    document: {
      getElementById: () => null,
      createElement: () => ({
        classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
        appendChild: noop, addEventListener: noop, style: {}
      }),
      addEventListener: noop
    }
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const ctx = vm.createContext(sandbox);
  for (const f of ["services.js", "registry.js"]) {
    const file = path.join(pluginDir, "js", f);
    vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: f });
  }

  const api = vm.runInContext(`({
    REGISTRY,
    instById,
    buildFinalPrompt,
    paramDefaultsFor,
    resolveParams,
    variantsOf,
    costTextFor,
    resolveModel,
    HELP_HOW,
    normalizeSizeForModel,
    normalizeQualityForModel,
    isNanoModel,
    IMAGE_MODEL_PRESETS,
    sizeOptionsForModel,
    qualityOptionsForModel
  })`, ctx);

  api._ctx = ctx;
  return api;
}

/* 按插件规则生成一次请求要用的提示词与尺寸 —— benchmark 与线上同源的关键 */
export function buildRequest(plugin, inst, userPrompt, params, extra) {
  const p = Object.assign({}, plugin.paramDefaultsFor(inst), params || {});
  const prompt = plugin.buildFinalPrompt(inst, userPrompt || "", null, p, "", extra || null);
  const modelUse = inst.modelUse === "text" ? "text" : (inst.modelUse || "gen");
  return { prompt, params: p, modelUse };
}

#!/usr/bin/env node
/*
 * test-prompts.mjs — P0 等价性校验
 *
 * 校验两件事：
 *   1. 声明式 promptSpec 渲染结果，与旧的 promptTpl.wrap / tpl.text 逐字符一致；
 *   2. 结构完整性：每个功能都有 promptSpec，每个分支都有模板，且没有遗留占位符。
 *
 * 用法：node test-prompts.mjs
 */
import { loadPlugin } from "./lib/plugin.mjs";
import { fileURLToPath } from "node:url";

const plugin = loadPlugin(fileURLToPath(new URL("../ps-spark-plugin", import.meta.url)));

const CONTEXTS = [
  { key: "empty", user: "", color: null, params: {}, extra: null, tplOverride: null },
  { key: "basic", user: "测试要求：把物体改成白色", color: { name: "红色", hex: "#FF0000" }, params: {}, extra: null, tplOverride: null },
  { key: "recolor", user: "把杯子放在桌上", color: null, params: { color: "#123456" }, extra: null, tplOverride: null },
  { key: "noAsset", user: "把杯子放在桌上", color: null, params: {}, extra: { hasAsset: false }, tplOverride: null },
  { key: "asset", user: "把杯子放在桌上", color: null, params: {}, extra: { hasAsset: true }, tplOverride: null },
  { key: "assetEmpty", user: "", color: null, params: {}, extra: { hasAsset: true }, tplOverride: null },
  { key: "aligned", user: "对齐合成", color: null, params: {}, extra: { hasAsset: true, aligned: true }, tplOverride: null },
  { key: "override", user: "自定义模板", color: null, params: {}, extra: null, tplOverride: "OVERRIDE TEXT" }
];

/* 旧实现：仅用于对照，不参与生产 */
function legacyPrompt(inst, c) {
  const tpl = inst.promptTpl || {};
  const u = (c.user || "").trim();
  const ov = (c.tplOverride || "").trim();
  switch (inst.prompt) {
    case "none": return tpl.text || "";
    case "auto": return ov || tpl.text || "";
    case "optional":
    case "required":
      return tpl.wrap ? tpl.wrap(u, { color: c.color, params: c.params, extra: c.extra || null }) : u;
    default:
      return u;
  }
}

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++;
  console.log("FAIL " + name + (detail ? " -> " + detail : ""));
}

/* 1) 结构完整性 */
for (const inst of plugin.REGISTRY) {
  check(inst.id + " 有 promptSpec", !!inst.promptSpec, "缺少 promptSpec");
  if (!inst.promptSpec) continue;
  const branches = inst.promptSpec.branches || [];
  check(inst.id + " 至少一个分支", branches.length > 0, "");
  for (const b of branches) {
    const parts = (inst.promptSpec.parts || {})[b.id];
    check(inst.id + "/" + b.id + " 有模板", Array.isArray(parts) && parts.length > 0, "");
  }
}

/* 2) 逐字符等价 */
let compared = 0;
for (const inst of plugin.REGISTRY) {
  for (const c of CONTEXTS) {
    const oldText = legacyPrompt(inst, c);
    const newText = plugin.buildFinalPrompt(inst, c.user, c.color, c.params, c.tplOverride, c.extra);
    compared++;
    check(inst.id + "/" + c.key + " 与旧实现一致", oldText === newText,
      "\n  old=" + JSON.stringify(oldText.slice(0, 160)) + "\n  new=" + JSON.stringify(newText.slice(0, 160)));
    check(inst.id + "/" + c.key + " 无未替换变量", !/\{\{\w+\}\}/.test(newText), newText.match(/\{\{\w+\}\}/g)?.join(",") || "");
  }
}

/* 3) 分支覆盖：原位合成必须覆盖三种形态 */
const composite = plugin.instById("composite");
if (composite) {
  const cases = [
    { name: "无资产", c: CONTEXTS[3], expect: "把画面中新贴入" },
    { name: "带资产", c: CONTEXTS[4], expect: "【底图约束】" },
    { name: "画布对齐", c: CONTEXTS[6], expect: "【对齐】" }
  ];
  for (const x of cases) {
    const text = plugin.buildFinalPrompt(composite, x.c.user, x.c.color, x.c.params, x.c.tplOverride, x.c.extra);
    check("原位合成/" + x.name + " 命中正确分支", text.indexOf(x.expect) >= 0, text.slice(0, 80));
  }
}

console.log("P0 提示词校验：PASS " + pass + " · FAIL " + fail + " · 对比 " + compared + " 条");
process.exit(fail ? 1 : 0);

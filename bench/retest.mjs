#!/usr/bin/env node
/*
 * retest.mjs — 一键复测：读取某次运行的 prompts.json，用同样的提示词与模型再跑一次
 *
 * 用法：
 *   npm run retest                       # 复测最近一次运行
 *   npm run retest -- out/20261018161305 # 复测指定运行
 *   npm run retest -- --repeat 2         # 额外参数原样传给 run.mjs
 *   npm run retest -- --models 1,2       # 换模型复测
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const latestFile = path.join(HERE, "out", "latest.txt");

let args = process.argv.slice(2);
let runDir = null;

/* 第一个参数若是存在的目录，视为指定运行目录；否则全部转发给 run.mjs */
if (args[0] && !args[0].startsWith("-") && fs.existsSync(args[0]) && fs.statSync(args[0]).isDirectory()) {
  runDir = path.resolve(args.shift());
}
if (!runDir) {
  if (!fs.existsSync(latestFile)) {
    console.error("还没有任何运行记录。先执行 npm run smoke 或 npm run bench。");
    process.exit(1);
  }
  runDir = fs.readFileSync(latestFile, "utf8").trim();
}

const prompts = path.join(runDir, "prompts.json");
if (!fs.existsSync(prompts)) {
  console.error("该运行目录里没有 prompts.json：" + runDir);
  console.error("请确认这是一个由当前版本工具产生的运行目录（旧版本没有提示词文件）。");
  process.exit(1);
}

const meta = JSON.parse(fs.readFileSync(prompts, "utf8"));
console.log("一键复测：" + runDir);
console.log("  提示词 " + (meta.prompts || []).length + " 条 · 模型 " + (meta.models || []).length + " 个" +
  (args.length ? " · 附加参数 " + args.join(" ") : ""));

/* 上次是 mock 自检：自动沿用 mock，避免误用真实 Key / 找不到假模型 */
if (meta.mode === "mock" && args.indexOf("--mock") < 0 && args.indexOf("--config") < 0) {
  args.push("--mock");
  console.log("  上次为 mock 运行 → 自动加 --mock");
}

const child = spawn(process.execPath, [path.join(HERE, "run.mjs"), "--prompts", prompts].concat(args), {
  stdio: "inherit",
  cwd: HERE
});
child.on("exit", (code) => process.exit(code == null ? 1 : code));
child.on("error", (e) => {
  console.error("启动失败：" + e.message);
  process.exit(1);
});

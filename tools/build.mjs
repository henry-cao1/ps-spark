/*
 * build.mjs — 跨平台打包（macOS / Windows 通用）
 *
 * 用法：
 *   node tools/build.mjs                    # 发布构建（剥离开发者模式，默认中文）
 *   node tools/build.mjs --channel=dev      # 开发构建（含开发者工作台，默认中文）
 *   node tools/build.mjs --target=oss       # 开源（GitHub）构建：release + 默认英文
 *
 * 产物：
 *   发布：dist/ps-spark/ · ps-spark.ccx · ps-spark-win.zip
 *   开发：dist/dev/ps-spark/ · ps-spark-dev.ccx · ps-spark-dev-win.zip
 *   开源：dist/oss/ps-spark/ · ps-spark.ccx · ps-spark-win.zip（默认语言 English）
 *
 * 发布构建会做三件事：排除 js/dev、删除 DEV 标记块、扫描禁止字符串；任一命中即失败。
 */

import { cp, rm, mkdir, readFile, writeFile, readdir, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "ps-spark-plugin");
const DIST = path.join(ROOT, "dist");

const ENTRIES = ["index.html", "manifest.json", "js", "icons"];
const FORBIDDEN = ["DEV:BEGIN", "DEV:END", "DevMode", "psspark.dev.", "devWorkbench", "开发者工作台", "js/dev/", "__DEFAULT_LANG__"];

/* 插件 id = 存储隔离键：UXP 的 localStorage / secureStorage / 侧载目录都按 id 分家，
 * 改一次就等于所有 Key、预设、历史都读不回来。Windows 包曾把 id 手改成
 * com.psspark.ps.spark，和 macOS 包不一致，升级后用户要重填一遍配置。
 * 所以这里把它做成构建期硬校验：id 不对、版本对不上、或源码里残留旧 id，都直接失败。 */
const PLUGIN_ID = "com.psspark.ps.assistant";
const ID_ALIASES = ["com.psspark.ps.spark", "com.grsai.ps.assistant"];

async function verifyIdentity() {
  const manifest = JSON.parse(await readFile(path.join(SRC, "manifest.json"), "utf8"));
  if (manifest.id !== PLUGIN_ID) {
    throw new Error("manifest.id 必须是 " + PLUGIN_ID + "，当前是 " + manifest.id);
  }
  const brand = await readFile(path.join(SRC, "js", "brand.js"), "utf8");
  const brandVer = (brand.match(/version:\s*"([^"]+)"/) || [])[1];
  if (brandVer && brandVer !== manifest.version) {
    throw new Error("版本不一致：manifest=" + manifest.version + " · brand.js=" + brandVer);
  }
  const bad = [];
  for (const f of await walk(SRC)) {
    if (!/\.(html|js|json|css|txt)$/i.test(f)) continue;
    const s = await readFile(f, "utf8");
    for (const alias of ID_ALIASES) {
      if (s.indexOf(alias) >= 0) bad.push(path.relative(ROOT, f) + " 含旧 id「" + alias + "」");
    }
  }
  if (bad.length) throw new Error("插件 id 校验失败：\n  " + bad.join("\n  "));
  return manifest;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const s = argv[i];
    if (s.indexOf("--") !== 0) continue;
    if (s.indexOf("=") > 2) {
      const eq = s.indexOf("=");
      out[s.slice(2, eq)] = s.slice(eq + 1);
      continue;
    }
    const k = s.slice(2);
    const next = argv[i + 1];
    if (next && next.indexOf("--") !== 0) { out[k] = next; i++; }
    else out[k] = true;
  }
  return out;
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

/* 删除成对标记块；标记不闭合直接失败，避免"删了一半"的包 */
function stripDevBlocks(text, file) {
  const pairs = [
    ["<!-- DEV:BEGIN -->", "<!-- DEV:END -->"],
    ["/* DEV:BEGIN */", "/* DEV:END */"]
  ];
  let s = text;
  for (const pair of pairs) {
    let idx = s.indexOf(pair[0]);
    while (idx >= 0) {
      const end = s.indexOf(pair[1], idx + pair[0].length);
      if (end < 0) throw new Error(file + "：DEV 标记未闭合");
      s = s.slice(0, idx) + s.slice(end + pair[1].length);
      idx = s.indexOf(pair[0]);
    }
  }
  if (s.indexOf("DEV:BEGIN") >= 0 || s.indexOf("DEV:END") >= 0) {
    throw new Error(file + "：存在未配对的 DEV 标记");
  }
  return s;
}

async function processOutput(outDir, isDev, lang) {
  const files = await walk(outDir);
  for (const f of files) {
    if (!/\.(html|js|css)$/i.test(f)) continue;
    const rel = path.relative(outDir, f).split(path.sep).join("/");
    let s = await readFile(f, "utf8");
    const before = s;
    if (!isDev) s = stripDevBlocks(s, rel);
    s = s.replace(/__DEV_CHANNEL__/g, isDev ? "true" : "false");
    /* 默认界面语言：oss 构建 en，其余 zh（brand.js 的 defaultLang 读取此标记） */
    s = s.replace(/"__DEFAULT_LANG__"/g, '"' + (lang === "en" ? "en" : "zh") + '"');
    if (s !== before) await writeFile(f, s);
  }
}

async function verifyRelease(outDir) {
  const files = await walk(outDir);
  const bad = [];
  for (const f of files) {
    const rel = path.relative(outDir, f).split(path.sep).join("/");
    if (rel === "js/dev" || rel.indexOf("js/dev/") === 0) bad.push(rel + "（开发目录未被排除）");
    if (!/\.(html|js|css|json)$/i.test(f)) continue;
    const s = await readFile(f, "utf8");
    for (const token of FORBIDDEN) {
      if (s.indexOf(token) >= 0) bad.push(rel + " 含「" + token + "」");
    }
  }
  if (bad.length) {
    throw new Error("发布包隔离校验失败：\n  " + bad.join("\n  "));
  }
  return files.length;
}

async function stage(outDir, isDev) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  for (const name of ENTRIES) {
    const from = path.join(SRC, name);
    if (!existsSync(from)) throw new Error("缺少文件：" + name);
    await cp(from, path.join(outDir, name), {
      recursive: true,
      filter: (src) => {
        if (isDev) return true;
        const rel = path.relative(SRC, src).split(path.sep).join("/");
        return rel !== "js/dev" && rel.indexOf("js/dev/") !== 0;
      }
    });
  }
}

function zipDir(dir, outFile) {
  if (process.platform === "win32") {
    const ps = `Compress-Archive -Path '${dir}\\*' -DestinationPath '${outFile}' -Force`;
    execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "inherit" });
  } else {
    execFileSync("zip", ["-rqX", outFile].concat(ENTRIES), { cwd: dir, stdio: "inherit" });
  }
}

async function main() {
  const args = parseArgs(process.argv);
  /* --target=oss：开源（GitHub）构建，强制 release 且默认语言为英文 */
  const isOss = args.target === "oss";
  const wantEn = isOss || args.lang === "en";
  const channel = (!isOss && args.channel === "dev") ? "dev" : "release";
  const isDev = channel === "dev";
  const lang = wantEn ? "en" : "zh";

  const outRoot = isDev ? path.join(DIST, "dev") : (isOss ? path.join(DIST, "oss") : DIST);
  const ARTIFACT = "ps-spark";
  const outDir = path.join(outRoot, ARTIFACT);
  const suffix = isDev ? "-dev" : "";

  const manifest = await verifyIdentity();
  const label = isOss ? "oss" : channel;
  console.log(`打包 ${manifest.name} v${manifest.version} · ${label}（${process.platform}）· 默认语言 ${lang} · id ${manifest.id}`);
  await stage(outDir, isDev);

  /* AGPL 合规：分发产物里必须带许可证与第三方声明 */
  for (const f of ["LICENSE", "NOTICE"]) {
    const src = path.join(ROOT, f);
    if (existsSync(src)) await copyFile(src, path.join(outDir, f));
  }
  await processOutput(outDir, isDev, lang);

  /* 产物自检：装到 PS 里的是哪个 id，就看这一行 */
  const outManifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8"));
  if (outManifest.id !== PLUGIN_ID) {
    throw new Error("产物 manifest.id 不是 " + PLUGIN_ID + "：" + outManifest.id);
  }
  if (outManifest.version !== manifest.version) {
    throw new Error("产物版本与源码不一致：" + outManifest.version + " ≠ " + manifest.version);
  }

  if (!isDev) {
    const count = await verifyRelease(outDir);
    console.log(`隔离校验通过：${count} 个文件，无开发者模式残留`);
  }

  const ccx = path.join(outRoot, ARTIFACT + suffix + ".ccx");
  const winZip = path.join(outRoot, ARTIFACT + suffix + "-win.zip");
  zipDir(outDir, ccx);
  zipDir(outDir, winZip);

  console.log("完成：");
  console.log("  " + outDir);
  console.log("  " + ccx);
  console.log("  " + winZip);
  if (isDev) console.log("提示：开发构建包含开发者工作台，仅限内部使用，不要作为交付包。");
}

main().catch((e) => {
  console.error("打包失败：" + e.message);
  process.exit(1);
});

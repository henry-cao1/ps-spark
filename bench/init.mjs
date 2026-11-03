#!/usr/bin/env node
/*
 * init.mjs — 首次使用向导：生成 config.json（不覆盖已有文件）
 * 只写服务商地址与模型清单，不写密钥；密钥从环境变量读取。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, "config.json");

const TEMPLATE = {
  concurrency: 2,
  timeoutSec: 300,
  providers: {
    grsai: {
      type: "openai",
      baseUrl: "https://grsai.dakka.com.cn",
      apiKey: "",
      apiKeyEnv: "GRSAI_API_KEY",
      generationsPath: "/v1/images/generations",
      editsPath: "/v1/images/edits",
      unifiedPath: "/v1/api/generate"
    },
    siliconflow: {
      type: "openai",
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKey: "",
      apiKeyEnv: "SILICONFLOW_API_KEY",
      generationsPath: "/images/generations",
      editsPath: "/images/edits"
    }
  },
  models: [
    { id: "gpt-image-2.5", provider: "grsai", label: "GPT Image 2.5", pricePerImage: 0.32 },
    { id: "nano-banana-pro", provider: "grsai", label: "Nano Banana Pro", pricePerImage: 0.9 },
    { id: "nano-banana-2", provider: "grsai", label: "Nano Banana 2", pricePerImage: 0.45 },
    { id: "nano-banana-fast", provider: "grsai", label: "Nano Banana Fast", pricePerImage: 0.07 },
    { id: "gpt-image-2.5-flare", provider: "grsai", label: "GPT Image 2.5 Flare", pricePerImage: 0.35 }
  ]
};

if (fs.existsSync(FILE)) {
  console.log("config.json 已存在，未覆盖：" + FILE);
} else {
  fs.writeFileSync(FILE, JSON.stringify(TEMPLATE, null, 2));
  console.log("已生成：" + FILE);
}

console.log("\n下一步：");
console.log("  1) 填入 API Key（二选一）：");
console.log("     export GRSAI_API_KEY=sk-xxx        # Windows PowerShell: $env:GRSAI_API_KEY=\"sk-xxx\"");
console.log("     或直接在 config.json 的 providers.grsai.apiKey 中填写（该文件已被 git 忽略）");
console.log("  2) npm run list        查看可选模型与 Key 状态");
console.log("  3) npm run dry         只看用例、次数与预估成本，不发请求");
console.log("  4) npm run smoke       小样本真实测试（2 用例 × 2 模型）");
console.log("  5) npm run bench       跑完整改图套件（12 用例）");
console.log("\n说明：pricePerImage 仅用于预估成本，按平台实价自行调整。");

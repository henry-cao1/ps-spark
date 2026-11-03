/*
 * test-pool.mjs — 并发池单元测试
 */
import { runPool } from "./lib/pool.mjs";

let pass = 0, fail = 0;
function ck(name, ok, detail) {
  if (ok) { pass++; console.log("PASS | " + name + (detail ? " -> " + detail : "")); }
  else { fail++; process.exitCode = 1; console.log("FAIL | " + name + (detail ? " -> " + detail : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 1) 并发上限 */
let active = 0, peak = 0;
const seen = [];
await runPool([1, 2, 3, 4, 5, 6, 7, 8], 3, async (x) => {
  active++;
  peak = Math.max(peak, active);
  await sleep(30);
  seen.push(x);
  active--;
});
ck("并发上限 = 3", peak === 3, String(peak));
ck("全部任务执行", seen.length === 8, String(seen.length));
ck("任务不重复", new Set(seen).size === 8, String(new Set(seen).size));

/* 2) limit=1 串行 */
active = 0; peak = 0;
await runPool([1, 2, 3], 1, async () => {
  active++;
  peak = Math.max(peak, active);
  await sleep(10);
  active--;
});
ck("limit=1 时串行", peak === 1, String(peak));

/* 3) 空列表 */
let ran = false;
await runPool([], 3, async () => { ran = true; });
ck("空列表不执行任务", ran === false, "");

/* 4) limit 超过任务数 */
active = 0; peak = 0;
await runPool([1, 2], 10, async () => {
  active++;
  peak = Math.max(peak, active);
  await sleep(10);
  active--;
});
ck("limit 被任务数截断", peak === 2, String(peak));

/* 5) worker 抛错会向上传播 */
let caught = "";
try {
  await runPool([1], 2, async () => { throw new Error("boom"); });
} catch (e) { caught = e.message; }
ck("worker 异常向上传播", caught === "boom", caught);

console.log("\n结果：PASS " + pass + " · FAIL " + fail);
process.exit(process.exitCode || 0);

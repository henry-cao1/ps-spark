/*
 * pool.mjs — 简单并发池（Node 单线程，靠 await 让出）
 *
 * runPool(items, limit, worker)：最多 limit 个 worker 同时处理 items，
 * 顺序不保证；worker 抛错会中断整池（需要容错时在 worker 内自己 catch）。
 */
export async function runPool(items, limit, worker) {
  const list = Array.from(items || []);
  if (!list.length) return;
  const n = Math.max(1, Math.min(parseInt(limit, 10) || 1, list.length));
  let next = 0;

  const runners = [];
  for (let i = 0; i < n; i++) {
    runners.push((async () => {
      for (;;) {
        const idx = next++;
        if (idx >= list.length) return;
        await worker(list[idx], idx);
      }
    })());
  }
  await Promise.all(runners);
}

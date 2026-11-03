/*
 * metrics.mjs — 可自动化的客观指标。
 *
 * 设计原则：只测"不依赖人眼也能判定"的东西，主观画质留给报告里的人评分。
 *   · 尺寸 / 比例是否符合预期
 *   · 是否含透明通道
 *   · 是否接近纯色（空图 / 白图，通常是失败或拒答）
 *   · 编辑类：蒙版外像素变化率（模型是否守住了"框外不变"）
 */
let PNG = null;
try { ({ PNG } = await import("pngjs")); } catch (e) { /* 未安装则跳过像素指标 */ }

export const hasPixelMetrics = !!PNG;

export function decode(buf) {
  if (!PNG) return null;
  try { return PNG.sync.read(buf); } catch (e) { return null; }
}

export function imageInfo(buf) {
  const png = decode(buf);
  if (!png) return { width: null, height: null, hasAlpha: null, decoded: false };
  let alpha = false;
  for (let i = 3; i < png.data.length; i += 4) {
    if (png.data[i] < 250) { alpha = true; break; }
  }
  return { width: png.width, height: png.height, hasAlpha: alpha, decoded: true };
}

/* 亮度标准差：接近 0 说明几乎是纯色（多半是失败图/空白图） */
export function blankScore(png) {
  if (!png) return null;
  const d = png.data;
  let n = 0, sum = 0, sum2 = 0;
  const step = Math.max(4, Math.floor((png.width * png.height) / 20000)) * 4;
  for (let i = 0; i < d.length; i += step) {
    const y = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    sum += y; sum2 += y * y; n++;
  }
  if (!n) return null;
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sum2 / n - mean * mean));
}

export function alphaRatio(png) {
  if (!png) return null;
  const d = png.data;
  let n = 0, a = 0;
  for (let i = 3; i < d.length; i += 4) { n++; if (d[i] < 250) a++; }
  return n ? a / n : null;
}

function resizeNearest(src, w, h) {
  if (src.width === w && src.height === h) return src;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y * src.height / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x * src.width / w));
      const si = (sy * src.width + sx) * 4, di = (y * w + x) * 4;
      out[di] = src.data[si]; out[di + 1] = src.data[si + 1];
      out[di + 2] = src.data[si + 2]; out[di + 3] = src.data[si + 3];
    }
  }
  return { width: w, height: h, data: out };
}

/* 蒙版外平均变化（0–100，越低越"守规矩"）。蒙版白色 = 允许修改的区域。 */
export function outsideChange(inputPng, outBuf, maskPng) {
  const out0 = decode(outBuf);
  if (!inputPng || !out0) return null;
  const out = resizeNearest(out0, inputPng.width, inputPng.height);
  const m = maskPng ? resizeNearest(maskPng, inputPng.width, inputPng.height) : null;
  const a = inputPng.data, b = out.data;
  let n = 0, sum = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (m && m.data[i] > 128) continue; /* 蒙版内允许改，不计入 */
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    sum += d / 3; n++;
  }
  if (!n) return null;
  return (sum / n) / 255 * 100;
}

/* 整体变化率（用于判断"是不是完全没改"） */
export function diffRatio(inputPng, outBuf) {
  const out0 = decode(outBuf);
  if (!inputPng || !out0) return null;
  const out = resizeNearest(out0, inputPng.width, inputPng.height);
  const a = inputPng.data, b = out.data;
  let n = 0, changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d / 3 > 6) changed++;
    n++;
  }
  return n ? changed / n : null;
}

export function aspectError(w, h, expected) {
  if (!w || !h || !expected) return null;
  return Math.abs((w / h) / expected - 1);
}

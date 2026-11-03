/* mock.mjs — 离线自检用的假模型：不需要任何 Key 就能跑通整条流水线 */
import { PNG } from "pngjs";

function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v; }

export function mockGenerate({ modelId, caseDef, inputBuf, maskBuf, rep }) {
  const bad = /bad|weak|slow/.test(modelId);
  const w = 768, h = 768;
  let base = null;
  if (inputBuf) {
    try { base = PNG.sync.read(inputBuf); } catch (e) { base = null; }
  }
  if (!base) {
    base = new PNG({ width: w, height: h });
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        base.data[i] = clamp(40 + (x / w) * 120);
        base.data[i + 1] = clamp(60 + (y / h) * 110);
        base.data[i + 2] = clamp(120 + Math.sin((x + y) / 90) * 50);
        base.data[i + 3] = 255;
      }
    }
    /* 几个色块充当主体 */
    const blobs = [[300, 260, 120, [230, 120, 70]], [470, 430, 90, [90, 200, 160]], [250, 500, 70, [250, 210, 90]]];
    for (const [cx, cy, r, c] of blobs) {
      for (let y = Math.max(0, cy - r); y < Math.min(h, cy + r); y++) {
        for (let x = Math.max(0, cx - r); x < Math.min(w, cx + r); x++) {
          if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
          const i = (y * w + x) * 4;
          base.data[i] = c[0]; base.data[i + 1] = c[1]; base.data[i + 2] = c[2];
        }
      }
    }
  }

  const out = { width: base.width, height: base.height, data: Buffer.from(base.data) };
  let mask = null;
  if (maskBuf) { try { mask = PNG.sync.read(maskBuf); } catch (e) { mask = null; } }

  if (mask) {
    /* 编辑类：在蒙版内做可见改动；bad 模型额外全局偏移（用于验证 outsideChange 指标） */
    for (let y = 0; y < out.height; y++) {
      for (let x = 0; x < out.width; x++) {
        const i = (y * out.width + x) * 4;
        const mi = (Math.min(mask.height - 1, y) * mask.width + Math.min(mask.width - 1, x)) * 4;
        const inside = mask.data[mi] > 128;
        if (inside) {
          out.data[i] = clamp(150 + Math.sin((x + rep * 7) / 30) * 40);
          out.data[i + 1] = clamp(170 + Math.cos(y / 40) * 30);
          out.data[i + 2] = clamp(120 + Math.sin((x - y) / 50) * 30);
        } else if (bad) {
          out.data[i] = clamp(out.data[i] + 14);
          out.data[i + 1] = clamp(out.data[i + 1] + 6);
        }
      }
    }
  } else if (bad) {
    /* 生成类：bad 模型给整体偏色 + 低对比（模拟质量差） */
    for (let i = 0; i < out.data.length; i += 4) {
      out.data[i] = clamp(out.data[i] * 0.7 + 60);
      out.data[i + 1] = clamp(out.data[i + 1] * 0.72 + 55);
      out.data[i + 2] = clamp(out.data[i + 2] * 0.74 + 50);
    }
  }

  return { buffer: PNG.sync.write(out), latencyMs: bad ? 2400 : 1500 };
}

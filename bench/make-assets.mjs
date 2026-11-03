/* make-assets.mjs — 生成基准测试用的固定输入图（可重复生成，保证跨模型对比一致） */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, "assets");
fs.mkdirSync(DIR, { recursive: true });

function save(name, png) {
  fs.writeFileSync(path.join(DIR, name), PNG.sync.write(png));
  console.log("写入 assets/" + name + "  " + png.width + "×" + png.height);
}
function set(png, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const i = (y * png.width + x) * 4;
  png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = a == null ? 255 : a;
}
function rect(png, x0, y0, x1, y1, c) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(png, x, y, c[0], c[1], c[2], c[3]);
}

/* 场景：渐变天空 + 地面 + 一个明确的红色物体（用于擦除/重绘/参考） */
const W = 1024, H = 768;
const scene = new PNG({ width: W, height: H });
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (y < 480) {
      const t = y / 480;
      set(scene, x, y, Math.round(120 + 90 * t), Math.round(170 + 50 * t), Math.round(215 + 25 * t));
    } else {
      const t = (y - 480) / (H - 480);
      set(scene, x, y, Math.round(96 - 40 * t), Math.round(120 - 50 * t), Math.round(70 - 30 * t));
    }
  }
}
/* 地面纹理 */
for (let y = 480; y < H; y += 7) for (let x = 0; x < W; x += 11) {
  const i = (y * W + x) * 4;
  scene.data[i] = Math.max(0, scene.data[i] - 8);
  scene.data[i + 1] = Math.max(0, scene.data[i + 1] - 10);
}
/* 红色方块（待擦除/待重绘目标） */
rect(scene, 650, 150, 850, 350, [214, 69, 65]);
rect(scene, 650, 150, 850, 162, [236, 105, 100]);
/* 阴影 */
for (let y = 350; y < 385; y++) for (let x = 650; x < 860; x++) {
  const i = (y * W + x) * 4;
  scene.data[i] = Math.round(scene.data[i] * 0.82);
  scene.data[i + 1] = Math.round(scene.data[i + 1] * 0.82);
  scene.data[i + 2] = Math.round(scene.data[i + 2] * 0.82);
}
/* 其它干扰元素（让画面不空） */
rect(scene, 140, 470, 300, 500, [235, 232, 220]);
for (let y = 500; y < 560; y++) for (let x = 210; x < 230; x++) set(scene, x, y, 110, 95, 80);
save("scene.png", scene);

/* 蒙版：白 = 允许修改（方块 + 少量外扩） */
const mask = new PNG({ width: W, height: H });
rect(mask, 0, 0, W, H, [0, 0, 0]);
rect(mask, 636, 136, 864, 364, [255, 255, 255]);
save("scene_mask.png", mask);

/* 商品素材：透明背景 + 绿色圆角块（用于原位合成） */
const P = 512;
const product = new PNG({ width: P, height: P });
rect(product, 0, 0, P, P, [0, 0, 0, 0]);
for (let y = 120; y < 400; y++) for (let x = 130; x < 390; x++) {
  const dx = Math.max(0, Math.abs(x - 260) - 110);
  const dy = Math.max(0, Math.abs(y - 260) - 110);
  if (dx * dx + dy * dy > 30 * 30) continue;
  const shade = 0.85 + 0.15 * Math.sin((x - y) / 60);
  set(product, x, y, Math.round(70 * shade), Math.round(180 * shade), Math.round(120 * shade), 255);
}
for (let y = 210; y < 310; y++) for (let x = 210; x < 310; x++) {
  if ((x - 260) ** 2 + (y - 260) ** 2 > 42 * 42) continue;
  set(product, x, y, 245, 245, 240, 255);
}
save("product.png", product);

/* 老照片：低饱和 + 划痕（用于修图类） */
const old = new PNG({ width: 768, height: 768 });
for (let y = 0; y < 768; y++) for (let x = 0; x < 768; x++) {
  const v = 140 + 40 * Math.sin(x / 90) + 25 * Math.cos(y / 60);
  set(old, x, y, Math.round(v * 1.02), Math.round(v * 0.98), Math.round(v * 0.88));
}
for (let k = 0; k < 40; k++) {
  const x0 = (k * 97) % 768, y0 = (k * 53) % 768;
  for (let t = 0; t < 40; t++) set(old, x0 + t, y0 + Math.round(t * 0.6), 225, 220, 210);
}
save("old_photo.png", old);

/* ===== 以下为「改图类」用例素材 ===== */

/* 海报：含可读价格文字（7 段数码管画法，无需字体），用于内容修图/改文字 */
const PW = 800, PH = 800;
const poster = new PNG({ width: PW, height: PH });
rect(poster, 0, 0, PW, PH, [246, 241, 230]);
rect(poster, 60, 60, PW - 60, 78, [40, 40, 40]);
rect(poster, 60, 120, 420, 136, [150, 150, 150]);
const FONT = {
  0: ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  1: ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  2: ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  3: ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  4: ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  5: ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  6: ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  7: ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  8: ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  9: ["01110", "10001", "10001", "01111", "00001", "00010", "01100"]
};
function bitmapText(png, text, x, y, cell, color) {
  let cx = x;
  for (const ch of String(text)) {
    const glyph = FONT[ch];
    if (!glyph) { cx += cell * 6; continue; }
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (glyph[r][c] !== "1") continue;
        rect(png, cx + c * cell, y + r * cell, cx + (c + 1) * cell, y + (r + 1) * cell, color);
      }
    }
    cx += cell * 6;
  }
}
/* “199” */
bitmapText(poster, "199", 190, 330, 24, [30, 30, 30]);
/* “元”用方框 + 两横近似 */
rect(poster, 668, 360, 748, 372, [30, 30, 30]);
rect(poster, 698, 330, 718, 480, [30, 30, 30]);
rect(poster, 668, 470, 748, 482, [30, 30, 30]);
save("poster.png", poster);

const posterMask = new PNG({ width: PW, height: PH });
rect(posterMask, 0, 0, PW, PH, [0, 0, 0]);
rect(posterMask, 165, 310, 770, 500, [255, 255, 255]);
save("poster_mask.png", posterMask);

/* 低清图：把 scene 缩到 1/5 再放大，模拟模糊/低分辨率 */
const small = new PNG({ width: Math.round(W / 5), height: Math.round(H / 5) });
for (let y = 0; y < small.height; y++) for (let x = 0; x < small.width; x++) {
  const sx = Math.min(W - 1, x * 5), sy = Math.min(H - 1, y * 5);
  const i = (sy * W + sx) * 4, j = (y * small.width + x) * 4;
  small.data[j] = scene.data[i]; small.data[j + 1] = scene.data[i + 1];
  small.data[j + 2] = scene.data[i + 2]; small.data[j + 3] = 255;
}
const blurry = new PNG({ width: W, height: H });
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const sx = Math.min(small.width - 1, Math.floor(x / 5)), sy = Math.min(small.height - 1, Math.floor(y / 5));
  const i = (sy * small.width + sx) * 4, j = (y * W + x) * 4;
  blurry.data[j] = small.data[i]; blurry.data[j + 1] = small.data[i + 1];
  blurry.data[j + 2] = small.data[i + 2]; blurry.data[j + 3] = 255;
}
save("blurry.png", blurry);

/* 线稿：白底黑线（圆 / 矩形 / 三角） */
const LW = 800, LH = 800;
const lineart = new PNG({ width: LW, height: LH });
rect(lineart, 0, 0, LW, LH, [255, 255, 255]);
function dot(png, x, y, c) { set(png, x, y, c[0], c[1], c[2], 255); }
for (let a = 0; a < 360; a += 0.5) {
  const r = Math.PI * a / 180;
  dot(lineart, Math.round(250 + Math.cos(r) * 110), Math.round(280 + Math.sin(r) * 110), [20, 20, 20]);
  dot(lineart, Math.round(250 + Math.cos(r) * 111), Math.round(280 + Math.sin(r) * 111), [20, 20, 20]);
}
for (let x = 430; x <= 680; x++) { dot(lineart, x, 180, [20, 20, 20]); dot(lineart, x, 400, [20, 20, 20]); }
for (let y = 180; y <= 400; y++) { dot(lineart, 430, y, [20, 20, 20]); dot(lineart, 680, y, [20, 20, 20]); }
for (let t = 0; t < 1; t += 0.005) {
  dot(lineart, Math.round(180 + t * 440), Math.round(680 - t * 180), [20, 20, 20]);
  dot(lineart, Math.round(620 - t * 440), Math.round(680 - t * 180), [20, 20, 20]);
  dot(lineart, Math.round(180 + t * 440), Math.round(680), [20, 20, 20]);
}
save("lineart.png", lineart);

/* 风格参考：暖色笔触感（用于艺术融合） */
const SW = 512, SH = 512;
const style = new PNG({ width: SW, height: SH });
for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
  const n = Math.sin(x / 18) * Math.cos(y / 23) + Math.sin((x + y) / 31);
  const r = 190 + n * 45, g = 120 + n * 30, b = 70 + n * 25;
  set(style, x, y, Math.max(0, Math.min(255, Math.round(r))), Math.max(0, Math.min(255, Math.round(g))), Math.max(0, Math.min(255, Math.round(b))), 255);
}
save("style.png", style);

/* 第二个场景：室内（用于图像融合） */
const scene2 = new PNG({ width: W, height: H });
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const wall = y < 520;
  if (wall) set(scene2, x, y, 226, 220, 208);
  else set(scene2, x, y, 150, 112, 78);
}
rect(scene2, 120, 140, 520, 440, [180, 205, 220]);
rect(scene2, 120, 140, 520, 156, [120, 120, 120]);
rect(scene2, 320, 140, 336, 440, [120, 120, 120]);
rect(scene2, 120, 290, 520, 306, [120, 120, 120]);
for (let y = 520; y < 760; y += 9) for (let x = 0; x < W; x += 13) {
  const i = (y * W + x) * 4;
  scene2.data[i] = Math.max(0, scene2.data[i] - 12);
  scene2.data[i + 1] = Math.max(0, scene2.data[i + 1] - 10);
}
save("scene2.png", scene2);

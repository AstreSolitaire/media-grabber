// 生成扩展图标。不引入图形库，直接手写最小 PNG 编码 + 4 倍超采样抗锯齿。

import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // 过滤器 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- 图形

function inRoundRect(x, y, rx0, ry0, rx1, ry1, r) {
  if (x < rx0 || x > rx1 || y < ry0 || y > ry1) return false;
  const cx = Math.min(Math.max(x, rx0 + r), rx1 - r);
  const cy = Math.min(Math.max(y, ry0 + r), ry1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const s = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
  const t = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
  if (s < 0 !== t < 0 && s !== 0 && t !== 0) return false;
  const d = (cx - bx) * (py - by) - (cy - by) * (px - bx);
  return d === 0 || d < 0 === s + t <= 0;
}

/** 画一个 N 倍的图，坐标都按 0..1 归一化。 */
function render(size) {
  const SS = 4;
  const W = size * SS;
  const px = Buffer.alloc(W * W * 4);
  const cx = 0.5;
  const shaftHalf = 0.062;
  const shaftTop = 0.20;
  const headTop = 0.47;
  const headBottom = 0.63;
  const headHalf = 0.20;
  const trayY = 0.735;
  const trayH = 0.062;
  const trayHalf = 0.235;

  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const v = (y + 0.5) / W;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      if (inRoundRect(u, v, 0, 0, 1, 1, 0.235)) {
        // 底：从左上到右下的渐变
        const t = Math.min(1, Math.max(0, (u + v) / 2));
        r = Math.round(37 + (96 - 37) * t);
        g = Math.round(99 + (165 - 99) * t);
        b = Math.round(235 + (250 - 235) * t);
        a = 255;
      }

      const arrow =
        (u >= cx - shaftHalf && u <= cx + shaftHalf && v >= shaftTop && v <= headBottom) ||
        inTriangle(u, v, cx, headBottom, cx - headHalf, headTop, cx + headHalf, headTop) ||
        (v >= trayY && v <= trayY + trayH && u >= cx - trayHalf && u <= cx + trayHalf);

      if (arrow && a > 0) {
        if (inRoundRect(u, v, cx - shaftHalf, shaftTop, cx + shaftHalf, headBottom, 0.055)) {
          r = g = b = 255;
        } else if (inRoundRect(u, v, cx - trayHalf, trayY, cx + trayHalf, trayY + trayH, trayH / 2)) {
          r = g = b = 255;
        } else {
          r = g = b = 255;
        }
        a = 255;
      }

      const o = (y * W + x) * 4;
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = a;
    }
  }

  // 降采样
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const o = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          const al = px[o + 3] / 255;
          r += px[o] * al;
          g += px[o + 1] * al;
          b += px[o + 2] * al;
          a += px[o + 3];
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const o = (y * size + x) * 4;
      if (alpha < 0.5) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      } else {
        const norm = alpha / 255;
        out[o] = Math.round(r / n / norm);
        out[o + 1] = Math.round(g / n / norm);
        out[o + 2] = Math.round(b / n / norm);
        out[o + 3] = Math.round(alpha);
      }
    }
  }
  return out;
}

const dir = path.join(import.meta.dirname, '..', 'extension', 'icons');
await mkdir(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const data = render(size);
  const file = path.join(dir, `icon${size}.png`);
  await writeFile(file, encodePng(size, size, data));
  console.log('已生成', file);
}

// Generates PNG icons for the extension by rasterizing the logo geometry.
// No external dependencies: draws into an RGBA buffer and encodes a PNG with
// Node's zlib. Run: node assets/gen-icons.mjs  (kept for regeneration).

import zlib from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Colors (RGBA 0-255).
const C = {
  outline: [232, 235, 242, 255], // #e8ebf2
  tile: [31, 36, 48, 255],      // #1f2430
  accent: [61, 132, 255, 255],  // #3d84ff
  mid: [170, 180, 197, 255],    // #aab4c5
  low: [119, 132, 154, 255],    // #77849a
  dot: [18, 161, 80, 255]       // #12a150
};

// Logo defined on a 128 grid; we scale to target size.
const G = 128;
const shapes = [
  { type: "rrect", x: 6, y: 6, w: 116, h: 116, r: 28, color: C.outline },
  { type: "rrect", x: 11, y: 11, w: 106, h: 106, r: 23, color: C.tile },
  { type: "rrect", x: 30, y: 34, w: 68, h: 16, r: 8, color: C.accent },
  { type: "rrect", x: 30, y: 58, w: 52, h: 14, r: 7, color: C.mid },
  { type: "rrect", x: 30, y: 80, w: 40, h: 14, r: 7, color: C.low },
  { type: "circle", cx: 92, cy: 87, r: 7, color: C.dot }
];

// Coverage of a rounded rect at a point (with anti-alias via supersampling).
function coverage(shape, px, py) {
  const SS = 3; // 3x3 supersample
  let hits = 0;
  for (let sx = 0; sx < SS; sx++) {
    for (let sy = 0; sy < SS; sy++) {
      const x = px + (sx + 0.5) / SS;
      const y = py + (sy + 0.5) / SS;
      if (inside(shape, x, y)) hits++;
    }
  }
  return hits / (SS * SS);
}

function inside(shape, x, y) {
  if (shape.type === "circle") {
    const dx = x - shape.cx;
    const dy = y - shape.cy;
    return dx * dx + dy * dy <= shape.r * shape.r;
  }
  // rounded rect
  const { x: rx, y: ry, w, h, r } = shape;
  if (x < rx || x > rx + w || y < ry || y > ry + h) return false;
  const inX = x >= rx + r && x <= rx + w - r;
  const inY = y >= ry + r && y <= ry + h - r;
  if (inX || inY) return true;
  // corners
  const cornerX = x < rx + r ? rx + r : rx + w - r;
  const cornerY = y < ry + r ? ry + r : ry + h - r;
  const dx = x - cornerX;
  const dy = y - cornerY;
  return dx * dx + dy * dy <= r * r;
}

function over(dst, src, a) {
  // src over dst with src alpha a (0-1); dst is opaque-ish RGBA
  const sa = (src[3] / 255) * a;
  const da = dst[3] / 255;
  const outA = sa + da * (1 - sa);
  for (let i = 0; i < 3; i++) {
    dst[i] = Math.round((src[i] * sa + dst[i] * da * (1 - sa)) / (outA || 1));
  }
  dst[3] = Math.round(outA * 255);
}

function render(size) {
  const scale = size / G;
  const buf = new Uint8Array(size * size * 4); // transparent
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = x / scale;
      const gy = y / scale;
      const px = [0, 0, 0, 0];
      for (const shape of shapes) {
        // sample coverage in grid space; convert pixel to grid box
        const cov = coverageGrid(shape, gx, gy, scale);
        if (cov > 0) over(px, shape.color, cov);
      }
      const idx = (y * size + x) * 4;
      buf[idx] = px[0];
      buf[idx + 1] = px[1];
      buf[idx + 2] = px[2];
      buf[idx + 3] = px[3];
    }
  }
  return buf;
}

// Coverage sampling in grid coordinates for one device pixel.
function coverageGrid(shape, gx, gy, scale) {
  const SS = 3;
  let hits = 0;
  const step = 1 / scale / SS;
  for (let sx = 0; sx < SS; sx++) {
    for (let sy = 0; sy < SS; sy++) {
      const x = gx + (sx + 0.5) * step;
      const y = gy + (sy + 0.5) * step;
      if (inside(shape, x, y)) hits++;
    }
  }
  return hits / (SS * SS);
}

// --- Minimal PNG encoder (truecolor + alpha) ---
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // raw scanlines with filter byte 0
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const rgba = render(size);
  const png = encodePNG(size, rgba);
  const out = join(here, `icon${size}.png`);
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes)`);
}

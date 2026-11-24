// Generates the PWA icons (PNG) without any image library: a teal tile with a white
// "rising bars + coin" mark. Run: node scripts/make-icons.mjs
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const BG = [15, 159, 122];
const FG = [255, 255, 255];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Mark geometry in a 0..1 unit square (safe zone ~ 0.2..0.8 for maskable icons).
function inMark(u, v) {
  const bars = [
    [0.27, 0.58, 0.37, 0.74],
    [0.41, 0.48, 0.51, 0.74],
    [0.55, 0.38, 0.65, 0.74],
  ];
  for (const [x0, y0, x1, y1] of bars) if (u >= x0 && u <= x1 && v >= y0 && v <= y1) return true;
  const dx = u - 0.66, dy = v - 0.29, r = Math.hypot(dx, dy);
  if (r <= 0.075 && r >= 0.04) return true; // coin ring
  if (u >= 0.25 && u <= 0.75 && v >= 0.765 && v <= 0.795) return true; // baseline
  return false;
}

function tile({ rounded, maskable }) {
  return (x, y, size) => {
    const u = x / size, v = y / size;
    // Maskable icons fill the full square; others get rounded corners with transparency.
    if (rounded && !maskable) {
      const rad = 0.22, cx = Math.min(Math.max(u, rad), 1 - rad), cy = Math.min(Math.max(v, rad), 1 - rad);
      if (Math.hypot(u - cx, v - cy) > rad) return [0, 0, 0, 0];
    }
    const s = maskable ? 0.8 : 1; // shrink mark into the maskable safe zone
    const mu = 0.5 + (u - 0.5) / s, mv = 0.5 + (v - 0.5) / s;
    return inMark(mu, mv) ? [...FG, 255] : [...BG, 255];
  };
}

mkdirSync("public/icons", { recursive: true });
writeFileSync("public/icons/icon-192.png", png(192, tile({ rounded: true })));
writeFileSync("public/icons/icon-512.png", png(512, tile({ rounded: true })));
writeFileSync("public/icons/maskable-512.png", png(512, tile({ maskable: true })));
writeFileSync("public/icons/apple-touch-icon.png", png(180, tile({ maskable: true })));
writeFileSync("public/favicon-32.png", png(32, tile({ rounded: true })));
console.log("Icons written to public/icons");

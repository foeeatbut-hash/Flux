'use strict';
/**
 * Значки Flux Studio и Flux Studio — Владелец (решение владельца 11 ноября 2026: значки программ должны различаться).
 *
 * Тот же знак Flux (build/icon.png), но другая цветовая гамма и метка в углу:
 *   - Flux Studio — синяя гамма и метка «< >» (код: программа разработчика);
 *   - Flux Studio — Владелец — янтарная гамма и метка-звезда (печать владельца).
 * У Flux значок прежний (build/icon.png): он не перерисовывается.
 * Результат — studio/icons/<имя>.ico (16–256 px) и <имя>.png (256 px, для окна и панели задач), в репозитории; без зависимостей:
 * PNG читается и пишется на zlib из Node.
 *
 *   node scripts/gen-studio-icons.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buffer => { let c = 0xffffffff; for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function decodePng(file) {
  const data = fs.readFileSync(file);
  let offset = 8, width = 0, height = 0; const parts = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset), type = data.toString('ascii', offset + 4, offset + 8), body = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') { width = body.readUInt32BE(0); height = body.readUInt32BE(4); if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) throw new Error('Нужен PNG RGBA 8 бит без чересстрочности'); }
    if (type === 'IDAT') parts.push(body);
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(parts)), stride = width * 4, out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? out[y * stride + x - 4] : 0, up = y ? out[(y - 1) * stride + x] : 0, upLeft = y && x >= 4 ? out[(y - 1) * stride + x - 4] : 0;
      let add = 0;
      if (filter === 1) add = left; else if (filter === 2) add = up; else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) { const p = left + up - upLeft, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft); add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft; }
      out[y * stride + x] = (line[x] + add) & 0xff;
    }
  }
  return { width, height, data: out };
}

function encodePng({ width, height, data }) {
  const stride = width * 4, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const chunk = (type, body) => { const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, 'ascii'); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0); return Buffer.concat([head, body, tail]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function hueShift(r, g, b, degrees) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 510;
  if (d === 0) return [r, g, b];
  const s = d / 255 / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + degrees + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r1 + m) * 255, (g1 + m) * 255, (b1 + m) * 255];
}

/** Расстояние от точки до отрезка: толстая линия с закруглёнными концами */
const lineDistance = (px, py, ax, ay, bx, by) => { const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))); return Math.hypot(px - ax - t * dx, py - ay - t * dy); };

/** Метка в правом нижнем углу холста 512×512: возвращает [r, g, b, a] точки (0–255) или null */
function badge(kind, x, y) {
  const cx = 392, cy = 392, radius = 104;
  const distance = Math.hypot(x - cx, y - cy);
  if (distance > radius) return null;
  const fill = kind === 'owner' ? [120, 53, 15] : [23, 37, 84];
  if (distance > radius - 14) return [255, 255, 255, 255];
  if (kind === 'developer') {
    // «< >»: две угловые скобки белой линией (по два отрезка на скобку)
    const w = 11;
    const seg = (ax, ay, bx, by) => lineDistance(x, y, ax, ay, bx, by) < w;
    const ink = seg(cx - 22, cy - 40, cx - 58, cy) || seg(cx - 58, cy, cx - 22, cy + 40) || seg(cx + 22, cy - 40, cx + 58, cy) || seg(cx + 58, cy, cx + 22, cy + 40);
    return ink ? [255, 255, 255, 255] : [...fill, 255];
  }
  // звезда о пяти лучах: внутри ломаной с чередующимися радиусами 62 и 26
  const points = Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 26 : 62; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i], [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside ? [255, 255, 255, 255] : [...fill, 255];
}

function render(source, kind, size) {
  const degrees = kind === 'developer' ? 55 : -122;
  const out = Buffer.alloc(size * size * 4), scale = source.width / size, samples = 4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < samples; sy++) for (let sx = 0; sx < samples; sx++) {
      const px = (x + (sx + .5) / samples) * scale, py = (y + (sy + .5) / samples) * scale;
      const i = (Math.min(source.height - 1, Math.floor(py)) * source.width + Math.min(source.width - 1, Math.floor(px))) * 4;
      let pr = source.data[i], pg = source.data[i + 1], pb = source.data[i + 2];
      const pa = source.data[i + 3];
      [pr, pg, pb] = hueShift(pr, pg, pb, degrees);
      const mark = badge(kind, px, py);
      if (mark) { pr = mark[0]; pg = mark[1]; pb = mark[2]; r += pr; g += pg; b += pb; a += 255; continue; }
      r += pr * pa / 255; g += pg * pa / 255; b += pb * pa / 255; a += pa;
    }
    const n = samples * samples, alpha = a / n;
    const o = (y * size + x) * 4;
    out[o] = alpha ? Math.round(Math.min(255, r / n / (alpha / 255))) : 0; out[o + 1] = alpha ? Math.round(Math.min(255, g / n / (alpha / 255))) : 0;
    out[o + 2] = alpha ? Math.round(Math.min(255, b / n / (alpha / 255))) : 0; out[o + 3] = Math.round(alpha);
  }
  return { width: size, height: size, data: out };
}

function ico(images) {
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16; const entries = [], bodies = [];
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16); entry[0] = size >= 256 ? 0 : size; entry[1] = size >= 256 ? 0 : size; entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8); entry.writeUInt32LE(offset, 12); offset += png.length; entries.push(entry); bodies.push(png);
  }
  return Buffer.concat([head, ...entries, ...bodies]);
}

function generate(outDir = path.join(root, 'studio/icons')) {
  const source = decodePng(path.join(root, 'build/icon.png'));
  fs.mkdirSync(outDir, { recursive: true });
  for (const kind of ['developer', 'owner']) {
    const pngs = SIZES.map(size => ({ size, png: encodePng(render(source, kind, size)) }));
    fs.writeFileSync(path.join(outDir, `studio-${kind}.ico`), ico(pngs));
    fs.writeFileSync(path.join(outDir, `studio-${kind}.png`), pngs[pngs.length - 1].png);
  }
}

module.exports = { generate, SIZES, decodePng };
if (require.main === module) { generate(); console.log('Значки записаны в studio/icons'); }

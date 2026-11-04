import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "scripts", "icon-source.png");

function chunk(tag, data) {
  const body = Buffer.concat([Buffer.from(tag), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function rounded(x, y) {
  const inset = 0.08;
  const r = 0.18;
  const x0 = inset;
  const x1 = 1 - inset;
  const y0 = inset;
  const y1 = 1 - inset;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function pixel(x, y, size) {
  const nx = (x + 0.5) / size;
  const ny = (y + 0.5) / size;
  if (!rounded(nx, ny)) return [0, 0, 0, 0];
  const page = nx > 0.28 && nx < 0.78 && ny > 0.22 && ny < 0.78;
  const spine = nx > 0.24 && nx < 0.32 && ny > 0.2 && ny < 0.8;
  const rule = page && ((ny > 0.36 && ny < 0.4) || (ny > 0.46 && ny < 0.49) || (ny > 0.54 && ny < 0.57));
  if (spine) return [8, 48, 38, 255];
  if (rule) return [15, 110, 86, 255];
  if (page) return [247, 244, 238, 255];
  return [15, 110, 86, 255];
}

function png(size) {
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0;
    for (let x = 0; x < size; x += 1) {
      const px = pixel(x, y, size);
      row.set(px, 1 + x * 4);
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png(1024));
console.log(`wrote ${out}`);

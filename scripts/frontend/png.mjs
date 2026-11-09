// Shrinks a browser screenshot to an indexed (256-colour) PNG without any dependency: decode, median-cut the colours,
// map each colour to its nearest palette entry, encode with zlib level 9. Interface screenshots are mostly flat
// colours, so frequent colours keep an exact entry and only anti-aliased edges are rounded. Deterministic: the same
// pixels always give the same bytes.
import { crc32, deflateSync, inflateSync } from "node:zlib";

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decode(png) {
  if (!png.subarray(0, 8).equals(signature)) throw new Error("not a PNG");
  let offset = 8, width = 0, height = 0, colorType = 0, depth = 0, interlace = 0;
  const data = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") { width = body.readUInt32BE(0); height = body.readUInt32BE(4); depth = body[8]; colorType = body[9]; interlace = body[12]; }
    else if (type === "IDAT") data.push(body);
    else if (type === "IEND") break;
    offset += 12 + length;
  }
  if (depth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) return null;
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const pixels = Buffer.alloc(width * height * 3);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels] : 0, up = previous[x], upLeft = x >= channels ? previous[x - channels] : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      line[x] = (line[x] + add) & 0xff;
    }
    for (let x = 0; x < width; x++) {
      // Screenshots are opaque; alpha, if present, is dropped.
      pixels[(y * width + x) * 3] = line[x * channels];
      pixels[(y * width + x) * 3 + 1] = line[x * channels + 1];
      pixels[(y * width + x) * 3 + 2] = line[x * channels + 2];
    }
    previous = line;
  }
  return { width, height, pixels };
}

/** Median cut over the colour histogram; a box of one colour is never split, so flat colours stay exact. */
function palette(colors, size) {
  const boxes = [{ colors }];
  const range = box => {
    let best = { channel: 0, span: -1 };
    for (let channel = 0; channel < 3; channel++) {
      let min = 255, max = 0;
      for (const c of box.colors) { const v = c[channel]; if (v < min) min = v; if (v > max) max = v; }
      if (max - min > best.span) best = { channel, span: max - min };
    }
    return best;
  };
  const weight = box => box.colors.reduce((sum, c) => sum + Math.sqrt(c[3]), 0);
  for (const box of boxes) { box.range = range(box); box.weight = weight(box); }
  while (boxes.length < size) {
    let pick = -1, score = 0;
    boxes.forEach((box, index) => { const s = box.range.span * box.weight; if (box.colors.length > 1 && s > score) { score = s; pick = index; } });
    if (pick < 0) break;
    const box = boxes[pick], channel = box.range.channel;
    box.colors.sort((a, b) => a[channel] - b[channel] || a[4] - b[4]);
    const half = box.weight / 2;
    let run = 0, cut = 1;
    for (let i = 0; i < box.colors.length - 1; i++) { run += Math.sqrt(box.colors[i][3]); if (run >= half) { cut = i + 1; break; } }
    const parts = [{ colors: box.colors.slice(0, cut) }, { colors: box.colors.slice(cut) }];
    for (const part of parts) { part.range = range(part); part.weight = weight(part); }
    boxes.splice(pick, 1, ...parts);
  }
  return boxes.map(box => {
    let r = 0, g = 0, b = 0, n = 0;
    for (const c of box.colors) { r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; n += c[3]; }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
}

function chunk(type, body) {
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/** The screenshot as an indexed PNG, or the original when it cannot be read or would not get smaller. */
export function indexPng(png, size = 256) {
  const image = decode(png);
  if (!image) return png;
  const { width, height, pixels } = image;
  const counts = new Map();
  for (let i = 0; i < pixels.length; i += 3) {
    const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const colors = [...counts].sort((a, b) => a[0] - b[0]).map(([key, count]) => [key >> 16, (key >> 8) & 0xff, key & 0xff, count, key]);
  const entries = palette(colors, size);
  // Each colour maps to its nearest entry (weighted towards green, as the eye is).
  const index = new Map();
  for (const [r, g, b, , key] of colors) {
    let best = 0, distance = Infinity;
    entries.forEach(([pr, pg, pb], i) => {
      const d = 2 * (r - pr) ** 2 + 4 * (g - pg) ** 2 + 3 * (b - pb) ** 2;
      if (d < distance) { distance = d; best = i; }
    });
    index.set(key, best);
  }
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      raw[y * (width + 1) + 1 + x] = index.get((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 3;
  const plte = Buffer.from(entries.flat());
  const out = Buffer.concat([signature, chunk("IHDR", header), chunk("PLTE", plte),
    chunk("IDAT", deflateSync(raw, { level: 9, memLevel: 9 })), chunk("IEND", Buffer.alloc(0))]);
  return out.length < png.length ? out : png;
}

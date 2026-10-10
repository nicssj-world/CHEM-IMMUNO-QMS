// Regenerates every app / PWA / favicon icon from the approved transparent CHEM-IMMUNO CBH artwork.
//
//   npx tsx scripts/branding/generate-pwa-icons.ts
//
// The source (assets/branding/chem-immuno-cbh-transparent-source.png) is the owner-supplied artwork, kept byte for byte. Its
// alpha is not clean enough to ship as is: the icon body is 252–253 instead of fully opaque, and faint specks sit outside the
// rounded square. This script rebuilds ONLY the alpha channel; the artwork's colours inside the icon are copied unchanged.
//
//   1. Silhouette = the largest connected region with alpha >= 128, holes filled (drops the stray specks).
//   2. New alpha = that silhouette with a smooth ~1 px anti-aliased edge: 255 inside, 0 outside. No white is ever painted.
//   3. Colours outside the silhouette are extended from its edge (push–pull fill), so resampling never pulls in a dark or white
//      fringe; the maskable / Apple icons get a blurred backing that continues the icon's own gradient instead of a white square.
//
// Outputs (all from the cleaned master):
//   * favicon.ico (16/32/48/64), favicon-64, icon-192, icon-512 — transparent outside the rounded square.
//   * icon-maskable-512 — full-bleed opaque: Android/Chrome crop maskable icons to their own shape and require the whole canvas
//     to be painted. The rounded square sits inside the 80 % safe zone on its own extended gradient (no white backing).
//   * apple-touch-icon (180) — full-bleed opaque: iOS ignores alpha on home-screen icons (transparent pixels turn black) and
//     applies its own rounded mask, so the icon fills the square and its corners continue the icon's gradient.
import sharp, { type Sharp } from 'sharp';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(__dirname, '..', '..');
const SOURCE = path.join(root, 'assets/branding/chem-immuno-cbh-transparent-source.png');
const MASTER = path.join(root, 'assets/branding/chem-immuno-cbh-transparent-master.png');
const PUBLIC = path.join(root, 'public');
/** Transparent margin around the rounded square in the master, as a share of the icon's longer side. */
const MASTER_MARGIN = 0.03;
/** Width of the rounded square inside the maskable canvas; keeps all logo text inside the 80 % safe-zone circle. */
const MASKABLE_ART = 0.76;

type Rgba = { data: Uint8Array; width: number; height: number };

async function readRgba(file: string): Promise<Rgba> {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height };
}

/** Largest 4-connected region of `solid`, with enclosed holes filled. */
function silhouette(solid: Uint8Array, width: number, height: number): Uint8Array {
  const label = new Int32Array(width * height);
  const queue = new Int32Array(width * height);
  let best = 0, bestSize = 0, next = 0;
  for (let start = 0; start < solid.length; start++) {
    if (!solid[start] || label[start]) continue;
    next++;
    let head = 0, tail = 0, size = 0;
    queue[tail++] = start; label[start] = next;
    while (head < tail) {
      const p = queue[head++]; size++;
      const x = p % width, y = (p - x) / width;
      for (const n of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1]) {
        if (n >= 0 && solid[n] && !label[n]) { label[n] = next; queue[tail++] = n; }
      }
    }
    if (size > bestSize) { bestSize = size; best = next; }
  }
  // Everything not reachable from the border without crossing the region is inside it.
  const outside = new Uint8Array(width * height);
  let head = 0, tail = 0;
  const push = (p: number) => { if (label[p] !== best && !outside[p]) { outside[p] = 1; queue[tail++] = p; } };
  for (let x = 0; x < width; x++) { push(x); push((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { push(y * width); push(y * width + width - 1); }
  while (head < tail) {
    const p = queue[head++];
    const x = p % width, y = (p - x) / width;
    if (x > 0) push(p - 1); if (x < width - 1) push(p + 1); if (y > 0) push(p - width); if (y < height - 1) push(p + width);
  }
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < mask.length; p++) mask[p] = outside[p] ? 0 : 1;
  return mask;
}

/** Smooth anti-aliased alpha from a binary mask: a light blur, then a steep ramp around the 50 % level (~1 px wide). */
async function smoothAlpha(mask: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const blurred = await sharp(Buffer.from(mask.map(v => v * 255)), { raw: { width, height, channels: 1 } }).blur(1.2).extractChannel(0).raw().toBuffer();
  const alpha = new Uint8Array(width * height);
  for (let p = 0; p < alpha.length; p++) {
    const v = (blurred[p] / 255 - 0.5) * 2.6 + 0.5;
    alpha[p] = v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
  }
  return alpha;
}

/** Push–pull fill: colours where `known` is set are kept; every other pixel gets a smooth extension of the nearby known colours. */
function extendColours(rgb: Float32Array, known: Float32Array, width: number, height: number): Float32Array {
  if (width <= 1 && height <= 1) return rgb;
  const w2 = Math.ceil(width / 2), h2 = Math.ceil(height / 2);
  const rgb2 = new Float32Array(w2 * h2 * 3), known2 = new Float32Array(w2 * h2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x, q = (y >> 1) * w2 + (x >> 1), k = known[p];
    if (!k) continue;
    known2[q] += k;
    for (let c = 0; c < 3; c++) rgb2[q * 3 + c] += rgb[p * 3 + c] * k;
  }
  for (let q = 0; q < known2.length; q++) if (known2[q]) for (let c = 0; c < 3; c++) rgb2[q * 3 + c] /= known2[q];
  for (let q = 0; q < known2.length; q++) known2[q] = Math.min(1, known2[q]);
  const coarse = extendColours(rgb2, known2, w2, h2);
  const out = new Float32Array(rgb.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = y * width + x, q = (y >> 1) * w2 + (x >> 1), k = known[p];
    for (let c = 0; c < 3; c++) out[p * 3 + c] = rgb[p * 3 + c] * k + coarse[q * 3 + c] * (1 - k);
  }
  return out;
}

async function cleanMaster() {
  const src = await readRgba(SOURCE);
  const { width, height, data } = src;
  const solid = new Uint8Array(width * height);
  for (let p = 0; p < solid.length; p++) solid[p] = data[p * 4 + 3] >= 128 ? 1 : 0;
  const mask = silhouette(solid, width, height);
  const alpha = await smoothAlpha(mask, width, height);
  const rgb = new Float32Array(width * height * 3), known = new Float32Array(width * height);
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    known[p] = 1;
    for (let c = 0; c < 3; c++) rgb[p * 3 + c] = data[p * 4 + c];
  }
  const filled = extendColours(rgb, known, width, height);
  // Crop to the icon and centre it on a square canvas with a small transparent margin.
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (alpha[y * width + x]) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const iw = x1 - x0 + 1, ih = y1 - y0 + 1;
  const side = Math.max(iw, ih) + 2 * Math.round(Math.max(iw, ih) * MASTER_MARGIN);
  const ox = Math.floor((side - iw) / 2), oy = Math.floor((side - ih) / 2);
  const master = new Uint8Array(side * side * 4);
  const backing = new Uint8Array(side * side * 3);
  // The backing (colours only) covers the whole square: extend again from the cropped icon to the new canvas edges.
  const crop = new Float32Array(side * side * 3), cropKnown = new Float32Array(side * side);
  for (let y = 0; y < ih; y++) for (let x = 0; x < iw; x++) {
    const s = (y0 + y) * width + (x0 + x), d = (oy + y) * side + (ox + x);
    for (let c = 0; c < 3; c++) {
      // Inside the icon: the artwork's own colours, unchanged. Around it: the extended edge colours.
      const value = mask[s] ? data[s * 4 + c] : filled[s * 3 + c];
      master[d * 4 + c] = Math.round(value);
      crop[d * 3 + c] = value;
    }
    master[d * 4 + 3] = alpha[s];
    cropKnown[d] = mask[s];
  }
  const cropFilled = extendColours(crop, cropKnown, side, side);
  for (let d = 0; d < side * side; d++) {
    for (let c = 0; c < 3; c++) {
      backing[d * 3 + c] = Math.max(0, Math.min(255, Math.round(cropFilled[d * 3 + c])));
      if (master[d * 4 + 3] === 0) master[d * 4 + c] = backing[d * 3 + c];
    }
  }
  await sharp(Buffer.from(master), { raw: { width: side, height: side, channels: 4 } }).png({ compressionLevel: 9 }).toFile(MASTER);
  return { side, iw, ih, backing };
}

const png = (image: Sharp) => image.png({ compressionLevel: 9 }).toBuffer();
/**
 * Transparent icon at `size`. Lanczos keeps small icons sharp but rings faintly (alpha 1–5) just outside the edge; those
 * invisible remnants are cleared so the corners are truly transparent.
 */
async function resized(size: number) {
  const { data, info } = await sharp(MASTER).resize(size, size, { kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true });
  for (let p = 3; p < data.length; p += 4) if (data[p] < 8) { data[p] = 0; data[p - 1] = data[p - 2] = data[p - 3] = 0; }
  return png(sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }));
}

/**
 * Opaque full-bleed icon. A centred square window is chosen so the rounded square spans `art` of the output. Behind the
 * artwork sits a heavily blurred continuation of the icon's own colours (so no white, no black, no hard streaks), and the
 * unchanged transparent master is composited on top.
 */
async function fullBleed(size: number, art: number, backing: Uint8Array, side: number, iw: number) {
  const window = Math.round(iw / art);
  const before = Math.floor((window - side) / 2), after = window - side - before;
  const place = (image: Sharp) => window <= side
    ? image.extract({ left: -before, top: -before, width: window, height: window })
    : image.extend({ top: before, bottom: after, left: before, right: after, extendWith: 'copy' });
  const background = await place(sharp(Buffer.from(backing), { raw: { width: side, height: side, channels: 3 } })).raw().toBuffer();
  const smooth = await sharp(background, { raw: { width: window, height: window, channels: 3 } }).blur(Math.max(2, window * 0.04)).png().toBuffer();
  const artwork = await (window <= side
    ? sharp(MASTER).extract({ left: -before, top: -before, width: window, height: window })
    : sharp(MASTER).extend({ top: before, bottom: after, left: before, right: after, background: { r: 0, g: 0, b: 0, alpha: 0 } })).png().toBuffer();
  const flat = await sharp(smooth).composite([{ input: artwork }]).removeAlpha().png().toBuffer();
  return png(sharp(flat).resize(size, size, { kernel: 'lanczos3' }));
}

function ico(frames: { size: number; bytes: Buffer }[]) {
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, bytes }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry); header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bytes.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  });
  return Buffer.concat([header, ...frames.map(frame => frame.bytes)]);
}

async function main() {
  const { side, iw, ih, backing } = await cleanMaster();
  await writeFile(path.join(PUBLIC, 'favicon-64.png'), await resized(64));
  await writeFile(path.join(PUBLIC, 'icon-192.png'), await resized(192));
  await writeFile(path.join(PUBLIC, 'icon-512.png'), await resized(512));
  await writeFile(path.join(PUBLIC, 'favicon.ico'), ico(await Promise.all([16, 32, 48, 64].map(async size => ({ size, bytes: await resized(size) })))));
  await writeFile(path.join(PUBLIC, 'icon-maskable-512.png'), await fullBleed(512, MASKABLE_ART, backing, side, iw));
  await writeFile(path.join(PUBLIC, 'apple-touch-icon.png'), await fullBleed(180, 1, backing, side, iw));
  console.log(`Master ${side}x${side} (icon ${iw}x${ih}); generated favicon.ico 16/32/48/64, favicon-64, icon-192, icon-512 (transparent), icon-maskable-512 and apple-touch-icon 180 (full-bleed, no white).`);
}

main().catch(error => { console.error(error); process.exit(1); });

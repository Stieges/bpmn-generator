/**
 * PNG preview of a rendered diagram — the pure part: scale, part geometry, crop, CRC32, encoder
 * and the SVG root size.
 *
 * This module imports only `node:` builtins at the top and does nothing when it is loaded, so the
 * CLI can import it statically (the package-integrity check follows static imports only) without
 * paying for, or depending on, the optional renderer. The renderer itself is imported lazily, only
 * when `--png` is given.
 *
 * Parts of a large diagram are always pixel crops of ONE full render, never separate renders of a
 * rewritten viewBox (nor the renderer's own crop / fitTo tricks). Two reasons: every part then has
 * exactly the same scale and antialiasing as the whole image, so overlapping edges match pixel for
 * pixel; and resvg 2.6.2 can panic (a wasm `unreachable` trap) when all of the content lies outside
 * a cut-down viewBox, which a part of an empty corner of a large diagram readily does.
 *
 * No Node API newer than 20.0 is used here: `engines` is `>=20`, and CI installs the latest 20.x,
 * so a newer API would pass CI and still break users on early 20.x releases.
 */

import { deflateSync } from 'node:zlib';

/**
 * Frozen preview settings, in diagram units (1 unit = 1 SVG user unit) unless named `Px`.
 * Deliberately not in config.json: they are not layout tunables, and a config change would churn
 * the layout hashes for no reason.
 *  - `scale`: pixels per diagram unit for a diagram that fits under the cap.
 *  - `maxSidePx`: no side of the full image is larger; above it the whole render is scaled down.
 *  - `partUnits` / `overlapUnits`: nominal part size and minimum overlap of adjacent parts. They
 *    are converted to pixels with the effective scale, so a capped render gives smaller parts.
 *  - `background`: the image is flattened on this opaque colour.
 */
export const PNG_PREVIEW = Object.freeze({
  scale: 2,
  maxSidePx: 8192,
  partUnits: 1600,
  overlapUnits: 160,
  background: '#ffffff',
});

const isPositive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Effective render scale: `scale`, reduced so that neither side exceeds `maxSidePx`.
 * Width or height that is not a finite positive number (an SVG without a size) gives `scale`.
 *
 * @param {number} widthUnits
 * @param {number} heightUnits
 * @param {{ scale: number, maxSidePx: number }} [opts]
 * @returns {number}
 */
export function previewScale(widthUnits, heightUnits, { scale, maxSidePx } = PNG_PREVIEW) {
  if (!isPositive(widthUnits) || !isPositive(heightUnits)) return scale;
  return Math.min(scale, maxSidePx / widthUnits, maxSidePx / heightUnits);
}

/**
 * `width` and `height` of the ROOT `<svg>` element, as numbers (decimals allowed, an optional
 * `px` suffix tolerated). Only the first `<svg …>` start tag is read, so a nested element's size,
 * or an attribute such as `stroke-width`, is never taken for the root size.
 *
 * Returns null when the root has no usable size — notably for the "No elements" SVG of an empty
 * diagram, which has neither width nor height (bpmn/svg.js). Percentages count as no size.
 *
 * @param {string} svg
 * @returns {{ width: number, height: number } | null}
 */
export function svgSize(svg) {
  const root = /<svg\b[^>]*>/.exec(String(svg));
  if (!root) return null;
  const read = (name) => {
    const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(root[0]);
    if (!m) return null;
    const text = (m[1] ?? m[2]).trim();
    if (!/^(?:\d+\.?\d*|\.\d+)(?:px)?$/.test(text)) return null;
    const value = Number.parseFloat(text);
    return isPositive(value) ? value : null;
  };
  const width = read('width');
  const height = read('height');
  return width === null || height === null ? null : { width, height };
}

/**
 * Offsets and size of the parts along one axis. With `n` parts of equal `size`, the first starting
 * at 0 and the last ending at `len`:
 *  - `n = ceil((len − overlap) / (part − overlap))` is the fewest parts of at most `part` pixels
 *    that overlap by at least `overlap`;
 *  - `size = ceil((len + (n − 1)·overlap) / n)` spreads the slack evenly, so `size ≤ part`;
 *  - `offset_i = round(i·(len − size) / (n − 1))`. The exact overlap is at least `overlap`, and
 *    rounding moves each offset by less than half a pixel, so the integer overlap stays ≥ `overlap`.
 * A length that fits one part gives a single part of the full length at offset 0.
 */
function planAxis(len, partPx, overlapPx) {
  if (len <= partPx) return { size: len, offsets: [0] };
  const n = Math.ceil((len - overlapPx) / (partPx - overlapPx));
  const size = Math.ceil((len + (n - 1) * overlapPx) / n);
  const offsets = [];
  for (let i = 0; i < n; i++) offsets.push(Math.round((i * (len - size)) / (n - 1)));
  return { size, offsets };
}

/**
 * Pixel rectangles of the parts of a `widthPx × heightPx` image, row-major (left→right, then
 * top→bottom). Empty when the image fits one part on both axes — the full image is then the only
 * output. All parts have the same width and the same height; adjacent parts overlap by at least
 * `overlapPx`, and together they cover the image.
 *
 * @param {number} widthPx   positive integer
 * @param {number} heightPx  positive integer
 * @param {{ partPx: number, overlapPx: number }} sizes  integers, 0 ≤ overlapPx < partPx
 * @returns {Array<{ x: number, y: number, w: number, h: number }>}
 * @throws {RangeError} when overlapPx ≥ partPx or an argument is not a valid integer
 */
export function planParts(widthPx, heightPx, { partPx, overlapPx }) {
  if (!Number.isInteger(partPx) || !Number.isInteger(overlapPx) || overlapPx < 0 || partPx < 1)
    throw new RangeError(`planParts: partPx and overlapPx must be integers with partPx ≥ 1 and overlapPx ≥ 0 (got ${partPx}, ${overlapPx})`);
  if (overlapPx >= partPx)
    throw new RangeError(`planParts: overlapPx (${overlapPx}) must be smaller than partPx (${partPx})`);
  if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx) || widthPx < 1 || heightPx < 1)
    throw new RangeError(`planParts: image size must be positive integers (got ${widthPx} × ${heightPx})`);
  if (widthPx <= partPx && heightPx <= partPx) return [];
  const xs = planAxis(widthPx, partPx, overlapPx);
  const ys = planAxis(heightPx, partPx, overlapPx);
  const parts = [];
  for (const y of ys.offsets) {
    for (const x of xs.offsets) parts.push({ x, y, w: xs.size, h: ys.size });
  }
  return parts;
}

/**
 * Copy the rectangle `rect` out of a tightly packed RGBA image `width` pixels wide.
 *
 * @param {Uint8Array} rgba
 * @param {number} width
 * @param {{ x: number, y: number, w: number, h: number }} rect
 * @returns {Uint8Array} `rect.w × rect.h × 4` bytes
 * @throws {RangeError} when the rectangle is not inside the image
 */
export function cropRgba(rgba, width, { x, y, w, h }) {
  const height = rgba.length / (width * 4);
  if (!Number.isInteger(height) || ![x, y, w, h].every(Number.isInteger) || x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height)
    throw new RangeError(`cropRgba: rectangle ${w} × ${h} at (${x}, ${y}) is outside the ${width} × ${height} image`);
  const out = new Uint8Array(w * h * 4);
  const rowBytes = w * 4;
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * width + x) * 4;
    out.set(rgba.subarray(from, from + rowBytes), row * rowBytes);
  }
  return out;
}

// CRC-32 (ISO 3309 / ITU-T V.42, polynomial 0xEDB88320 reflected) as the PNG chunk checksum.
// Own table instead of zlib.crc32, which only exists from Node 20.15; `engines` is `>=20`.
// Built on first use, so loading the module stays free of work.
let crcTable = null;

function table() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

/**
 * CRC-32 of `bytes`, as an unsigned 32-bit number.
 *
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function crc32(bytes) {
  const t = table();
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One PNG chunk: length, type, data, CRC over type and data. */
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Encode a tightly packed RGBA image as a PNG.
 *
 * The file is 8-bit RGB (colour type 2), not RGBA: the image is rendered on an opaque background
 * (PNG_PREVIEW.background), so alpha is 255 everywhere and carrying it would only add a quarter
 * to the raw data. Every row uses filter 0 (None); the payload is `zlib.deflateSync` at level 9.
 * A diagram is mostly flat colour, which deflate compresses well without row filters.
 *
 * The filtered raw data is built in one allocation, row by row, without intermediate copies.
 *
 * @param {Uint8Array} rgba  `width × height × 4` bytes
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 * @throws {RangeError} when the buffer length does not match the size
 */
export function encodePng(rgba, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgba.length !== width * height * 4)
    throw new RangeError(`encodePng: ${rgba.length} bytes are not a ${width} × ${height} RGBA image`);
  const stride = 1 + width * 3;
  const raw = Buffer.allocUnsafe(stride * height);
  let o = 0;
  let i = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter type None
    for (let x = 0; x < width; x++, i += 4) {
      raw[o++] = rgba[i];
      raw[o++] = rgba[i + 1];
      raw[o++] = rgba[i + 2];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // colour type: truecolour (RGB)
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method: adaptive (per-row filter byte)
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Width and height from a PNG's IHDR chunk, which the format requires to come first.
 *
 * @param {Buffer} png
 * @returns {{ width: number, height: number }}
 * @throws {Error} when the signature is wrong or the IHDR chunk is missing or short
 */
export function pngSize(png) {
  if (png.length < 8 || !PNG_SIGNATURE.equals(png.subarray(0, 8)))
    throw new Error('pngSize: not a PNG (bad signature)');
  if (png.length < 8 + 8 + 13 || png.readUInt32BE(8) !== 13 || png.subarray(12, 16).toString('latin1') !== 'IHDR')
    throw new Error('pngSize: missing or short IHDR chunk');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

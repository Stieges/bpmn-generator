/**
 * PNG preview of a rendered diagram: the pure part (scale, part geometry, crop, CRC32, encoder
 * and the SVG root size), the renderer (optional @resvg/resvg-wasm with the bundled font) and the
 * writer the CLI calls.
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

import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

// The dirname property of import.meta would do, but it only exists from Node 20.11.
const __dirname = dirname(fileURLToPath(import.meta.url));

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

// ---------------------------------------------------------------------------------------------
// Renderer: @resvg/resvg-wasm (optional dependency) with the bundled Arimo font.
// ---------------------------------------------------------------------------------------------

/**
 * The bundled font. Arimo is metric-compatible with Arial, the family the diagram SVG names, so
 * label widths match the layout's text measurement. Written with string literals only: the docs
 * gate's package-integrity check reads this call to confirm that the file ships in the package.
 * The same relative path holds in the checkout, the npm package and the skill bundle.
 */
const FONT_PATH = join(__dirname, '..', 'fonts', 'Arimo-Regular.ttf');

const RENDERER_PACKAGE = '@resvg/resvg-wasm';

/** The renderer or its font is not usable; `--png` cannot run at all. */
export class PngUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PngUnavailableError';
    this.code = 'PNG_UNAVAILABLE';
  }
}

/** Rendering or encoding one SVG failed; `cause` holds the original error. */
export class PngRenderError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PngRenderError';
  }
}

/**
 * Family names from a TrueType font's `name` table — also the check that the bytes are a
 * TrueType font at all.
 *
 * resvg draws nothing, and reports nothing, for text whose family it cannot resolve, so the
 * generic families must be mapped to the name the font itself declares, not a name assumed here.
 * Typographic family (name ID 16) is preferred over the legacy family (ID 1), as fontdb does;
 * Windows-platform records (3, UTF-16BE; US English first) over Macintosh Roman ones (1, 0).
 *
 * @param {Uint8Array} bytes
 * @returns {string|null} the family name, or null when the bytes are not a TrueType font with one
 */
function trueTypeFamily(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 12) return null;
  const tag = buf.readUInt32BE(0);
  if (tag !== 0x00010000 && tag !== 0x74727565 /* 'true' */) return null;
  const numTables = buf.readUInt16BE(4);
  if (12 + numTables * 16 > buf.length) return null;
  let name = null;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) === 'name') {
      name = { offset: buf.readUInt32BE(rec + 8), length: buf.readUInt32BE(rec + 12) };
      break;
    }
  }
  if (!name || name.offset + 6 > buf.length || name.offset + name.length > buf.length) return null;
  const base = name.offset;
  const count = buf.readUInt16BE(base + 2);
  const strings = base + buf.readUInt16BE(base + 4);
  if (base + 6 + count * 12 > buf.length) return null;
  let best = null;
  for (let i = 0; i < count; i++) {
    const r = base + 6 + i * 12;
    const platform = buf.readUInt16BE(r);
    const encoding = buf.readUInt16BE(r + 2);
    const language = buf.readUInt16BE(r + 4);
    const nameId = buf.readUInt16BE(r + 6);
    const length = buf.readUInt16BE(r + 8);
    const start = strings + buf.readUInt16BE(r + 10);
    if ((nameId !== 1 && nameId !== 16) || start + length > buf.length) continue;
    let text;
    let rank;
    if (platform === 3 && (encoding === 1 || encoding === 10) && length % 2 === 0) {
      text = Buffer.from(buf.subarray(start, start + length)).swap16().toString('utf16le');
      rank = language === 0x0409 ? 0 : 1;
    } else if (platform === 1 && encoding === 0) {
      text = buf.toString('latin1', start, start + length);
      rank = 2;
    } else {
      continue;
    }
    text = text.trim();
    if (!text) continue;
    const score = (nameId === 16 ? 0 : 10) + rank;
    if (!best || score < best.score) best = { score, text };
  }
  return best ? best.text : null;
}

/** Read the font file and its family name, or throw PngUnavailableError naming the path. */
function loadFont(fontPath) {
  let bytes;
  try {
    bytes = readFileSync(fontPath);
  } catch (err) {
    throw new PngUnavailableError(`--png cannot read the bundled font ${fontPath}: ${err.code ?? err.message}`, { cause: err });
  }
  if (bytes.length === 0) throw new PngUnavailableError(`--png found an empty font file at ${fontPath}`);
  const family = trueTypeFamily(bytes);
  if (!family) throw new PngUnavailableError(`--png found no TrueType font with a family name at ${fontPath}`);
  return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), family };
}

// initWasm may run only once per loaded package (a second call throws "Already initialized").
// One start promise per package object, so concurrent loads wait for the same start instead of
// one of them rendering before the wasm is ready.
const wasmStarts = new WeakMap();

function startWasm(resvg) {
  let start = wasmStarts.get(resvg);
  if (!start) {
    const wasmPath = createRequire(import.meta.url).resolve(`${RENDERER_PACKAGE}/index_bg.wasm`);
    start = Promise.resolve()
      .then(() => resvg.initWasm(readFileSync(wasmPath)))
      .catch((err) => {
        // Started elsewhere in this process (another module that uses the same package): fine.
        if (/already initiali[sz]ed/i.test(String(err?.message))) return;
        wasmStarts.delete(resvg);
        throw err;
      });
    wasmStarts.set(resvg, start);
  }
  return start;
}

/** Pixels with luma (ITU-R BT.601) below 128 in a tightly packed RGBA image. */
function countDarkPixels(rgba) {
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2] < 128) n++;
  }
  return n;
}

// The family the diagram SVG really names on its root. Checking with "Arimo" would only prove
// that the font loads, not that "Arial, sans-serif" resolves to it — and an unresolved family
// draws no text at all, silently.
const TEXT_CHECK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="24" font-family="Arial, sans-serif">'
  + '<rect width="60" height="24" fill="#fff"/><text x="4" y="17" font-size="12">Hg</text></svg>';

// "Hg" at 12 units and scale 2 covers well over a hundred dark pixels; 20 leaves room for any
// antialiasing difference and still fails a render that drew no glyph.
const TEXT_CHECK_MIN_DARK = 20;

/**
 * @typedef {{ renderRgba(svg: string, scale: number): { rgba: Uint8Array, width: number, height: number } }} PngRenderer
 */

function makeRenderer(Resvg, font) {
  const fontOptions = {
    fontBuffers: [font.bytes],
    // The wasm build cannot see system fonts at all; the bundled font is the only one, and every
    // generic family resolves to it, so output is the same on every machine.
    defaultFontFamily: font.family,
    sansSerifFamily: font.family,
    serifFamily: font.family,
    monospaceFamily: font.family,
  };
  return {
    renderRgba(svg, scale) {
      let resvg = null;
      let image = null;
      try {
        resvg = new Resvg(svg, {
          fitTo: { mode: 'zoom', value: scale },
          background: PNG_PREVIEW.background,
          font: fontOptions,
        });
        image = resvg.render();
        // Every read of `pixels` copies the whole image out of wasm memory: read it once.
        const rgba = image.pixels;
        return { rgba, width: image.width, height: image.height };
      } catch (err) {
        throw new PngRenderError(`the renderer failed: ${err?.message ?? String(err)}`, { cause: err });
      } finally {
        // wasm memory is not garbage-collected; a drill-down renders many diagrams in one process.
        image?.free();
        resvg?.free();
      }
    },
  };
}

async function createRenderer(importModule, fontPath) {
  let resvg;
  try {
    const mod = await importModule(RENDERER_PACKAGE);
    // import() resolves the package's ESM build (named exports); `default` covers a
    // CommonJS build or a wrapped module.
    resvg = mod?.default ?? mod;
    if (typeof resvg?.initWasm !== 'function' || typeof resvg?.Resvg !== 'function')
      throw new Error(`${RENDERER_PACKAGE} exports neither initWasm nor Resvg`);
  } catch (err) {
    throw new PngUnavailableError(
      '--png needs the optional dependency @resvg/resvg-wasm 2.6.2, which is not installed: install it next to the other dependencies of this package (`npm install` without --omit=optional)',
      { cause: err });
  }
  const font = loadFont(fontPath);
  try {
    await startWasm(resvg);
  } catch (err) {
    throw new PngUnavailableError(`--png could not start the renderer: ${err?.message ?? String(err)}`, { cause: err });
  }
  const renderer = makeRenderer(resvg.Resvg, font);
  let dark;
  try {
    dark = countDarkPixels(renderer.renderRgba(TEXT_CHECK_SVG, 2).rgba);
  } catch (err) {
    throw new PngUnavailableError(`--png could not render a test image: ${err.message}`, { cause: err });
  }
  if (dark < TEXT_CHECK_MIN_DARK) throw new PngUnavailableError('the bundled font did not render text');
  return renderer;
}

let defaultRenderer = null;

/**
 * Load the renderer: import the optional package, start its wasm, load the bundled font and
 * check once that text really renders.
 *
 * The call with default arguments is memoised: every later call returns the same promise. A
 * rejected load is NOT kept: the next call tries again. A long-lived process (an MCP or HTTP
 * server) may get the dependency installed after a failed attempt, and a retry costs only a
 * failed import; a wasm start that did succeed is kept per package and not repeated.
 *
 * @param {{ importModule?: (specifier: string) => Promise<any>, fontPath?: string }} [opts]
 * @returns {Promise<PngRenderer>}
 * @throws {PngUnavailableError}
 */
export function loadPngRenderer({ importModule, fontPath } = {}) {
  const isDefault = importModule === undefined && fontPath === undefined;
  if (isDefault && defaultRenderer) return defaultRenderer;
  const load = createRenderer(importModule ?? ((s) => import(s)), fontPath ?? FONT_PATH);
  if (!isDefault) return load;
  defaultRenderer = load;
  load.catch(() => { if (defaultRenderer === load) defaultRenderer = null; });
  return load;
}

/**
 * Render an SVG once and encode the whole image plus, for a large diagram, its parts — all in
 * memory, nothing is written.
 *
 * The scale is PNG_PREVIEW.scale, capped so that no side exceeds maxSidePx; an SVG without a root
 * size renders at `opts.scale`. Parts are pixel crops of that one render, planned on the RENDERED
 * size (the SVG size is rounded to 0.1 units, so the pixel size can differ by one from W·scale),
 * with part size and overlap converted from diagram units at the same effective scale.
 *
 * @param {string} svg
 * @param {PngRenderer} renderer
 * @param {typeof PNG_PREVIEW} [opts]
 * @returns {{ png: Buffer, width: number, height: number, scale: number,
 *             parts: Array<{ png: Buffer, x: number, y: number, w: number, h: number }> }}
 * @throws {PngRenderError}
 */
export function renderPreview(svg, renderer, opts = PNG_PREVIEW) {
  try {
    const size = svgSize(svg);
    const scale = size ? previewScale(size.width, size.height, opts) : opts.scale;
    const { rgba, width, height } = renderer.renderRgba(svg, scale);
    const png = encodePng(rgba, width, height);
    const rects = planParts(width, height, {
      partPx: Math.round(opts.partUnits * scale),
      overlapPx: Math.round(opts.overlapUnits * scale),
    });
    const parts = rects.map((r) => ({ png: encodePng(cropRgba(rgba, width, r), r.w, r.h), ...r }));
    return { png, width, height, scale, parts };
  } catch (err) {
    if (err instanceof PngRenderError) throw err;
    throw new PngRenderError(`the renderer failed: ${err?.message ?? String(err)}`, { cause: err });
  }
}

// ---------------------------------------------------------------------------------------------
// Writer: the files of `--png`.
// ---------------------------------------------------------------------------------------------

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Delete the part files an earlier run left for `base`: files in `dirname(base)` named exactly
 * `<basename>.part-<i>-of-<n>.png`. A diagram that shrank from twelve parts to four, or to none,
 * would otherwise leave old parts beside the new ones, and whoever globs `<base>.part-*` would
 * read a mix of two runs. Nothing else is touched: not another base that merely starts with the
 * same name (`<base>x.part-…`), not a file with a further suffix, and not a match that has an
 * `.svg` of the same name beside it — `out.part-1-of-2.png` next to `out.part-1-of-2.svg` is the
 * whole-diagram preview of a diagram whose base is `out.part-1-of-2`, not a part of `out`.
 *
 * @param {string} base  output path without extension
 * @param {{ readdir?: (dir: string) => string[], unlink?: (path: string) => void,
 *           exists?: (path: string) => boolean }} [fs]
 * @returns {string[]} the removed paths
 */
export function removeStaleParts(base, { readdir = readdirSync, unlink = unlinkSync, exists = existsSync } = {}) {
  const dir = dirname(base);
  const pattern = new RegExp(`^${escapeRegExp(basename(base))}\\.part-\\d+-of-\\d+\\.png$`);
  const removed = [];
  for (const name of readdir(dir)) {
    if (!pattern.test(name)) continue;
    if (exists(join(dir, name.replace(/\.png$/, '.svg')))) continue;
    const path = join(dir, name);
    unlink(path);
    removed.push(path);
  }
  return removed;
}

/**
 * Write `<base>.png`, plus `<base>.part-<i>-of-<n>.png` for a large diagram (1-based, left→right
 * then top→bottom), for each target.
 *
 * Per target, the order is fixed: render and encode every image in memory, then remove the stale
 * parts of that base, then write. Nothing is written before every image of the target is encoded.
 * When the target fails anyway — in rendering, or in writing after some of its files are already
 * on disk — `<base>.png` and every `<base>.part-<i>-of-<n>.png` are removed, best effort: a failed
 * target leaves no PNG of that base at all, neither an older run's image beside the new model
 * files nor a partial new set. A failure on one target is reported in its result and does not stop
 * the next target (a drill-down writes many diagrams).
 *
 * Never throws: every failure, rendering or writing, becomes `{ ok: false, message }`; an error
 * during the clean-up is ignored, since the result already reports the failure.
 *
 * @param {Array<{ svg: string, base: string }>} targets
 * @param {PngRenderer} renderer
 * @param {{ writeFile?: (path: string, data: Buffer) => void, removeStale?: (base: string) => string[],
 *           unlink?: (path: string) => void }} [io]
 * @returns {Array<{ base: string, ok: true, files: string[], scale: number, parts: number }
 *                | { base: string, ok: false, message: string }>}
 */
export function writePngPreviews(targets, renderer, { writeFile = writeFileSync, removeStale = removeStaleParts, unlink = unlinkSync } = {}) {
  return targets.map(({ svg, base }) => {
    try {
      const preview = renderPreview(svg, renderer);
      const n = preview.parts.length;
      const outputs = [
        { path: `${base}.png`, png: preview.png },
        ...preview.parts.map((part, i) => ({ path: `${base}.part-${i + 1}-of-${n}.png`, png: part.png })),
      ];
      removeStale(base);
      for (const { path, png } of outputs) writeFile(path, png);
      return { base, ok: true, files: outputs.map((o) => o.path), scale: preview.scale, parts: n };
    } catch (err) {
      try { unlink(`${base}.png`); } catch { /* absent, or not removable: the failure is reported */ }
      try { removeStale(base); } catch { /* as above */ }
      return { base, ok: false, message: err?.message ?? String(err) };
    }
  });
}

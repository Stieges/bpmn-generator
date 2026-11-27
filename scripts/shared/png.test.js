import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { inflateSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PNG_PREVIEW, previewScale, svgSize, planParts, cropRgba, crc32, encodePng, pngSize,
  PngUnavailableError, PngRenderError, loadPngRenderer, renderPreview,
  removeStaleParts, writePngPreviews,
} from './png.js';
import { runPipeline } from '../bpmn/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'tests', 'fixtures');

/** Split a PNG into its chunks: `{ type, data, crc }`, after checking the 8-byte signature. */
function chunks(png) {
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const out = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.subarray(at + 4, at + 8).toString('latin1');
    const data = png.subarray(at + 8, at + 8 + length);
    const crc = png.readUInt32BE(at + 8 + length);
    out.push({ type, data, crc, typeAndData: png.subarray(at + 4, at + 8 + length) });
    at += 12 + length;
  }
  return out;
}

/** Per axis, the distinct offsets and sizes of a part grid. */
function axis(parts, pos, len) {
  const byPos = new Map();
  for (const p of parts) byPos.set(p[pos], p[len]);
  return [...byPos.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * The 1-D checks for one axis of a part grid. `segments` are `[offset, size]` pairs sorted by
 * offset; `len` is the image length on that axis.
 */
function checkAxis(segments, len, partPx, overlapPx) {
  const sizes = new Set(segments.map(([, size]) => size));
  if (sizes.size !== 1) return `sizes differ: ${[...sizes]}`;
  const size = segments[0][1];
  if (segments[0][0] !== 0) return `first offset ${segments[0][0]}`;
  const [lastOffset, lastSize] = segments[segments.length - 1];
  if (lastOffset + lastSize !== len) return `last part ends at ${lastOffset + lastSize}, not ${len}`;
  if (size > partPx) return `size ${size} > partPx ${partPx}`;
  if (segments.length === 1) return size === len ? null : `single part of size ${size} for len ${len}`;
  for (let i = 1; i < segments.length; i++) {
    const overlap = segments[i - 1][0] + segments[i - 1][1] - segments[i][0];
    // Overlap ≥ overlapPx also means no gap, so the union covers [0, len).
    if (overlap < overlapPx) return `overlap ${overlap} < ${overlapPx} at part ${i}`;
  }
  return null;
}

describe('png — pure helpers', () => {
  test('the preview constants are frozen', () => {
    expect(PNG_PREVIEW).toEqual({ scale: 2, maxSidePx: 8192, partUnits: 1600, overlapUnits: 160, background: '#ffffff' });
    expect(Object.isFrozen(PNG_PREVIEW)).toBe(true);
  });

  test('previewScale keeps 2 below the cap and caps each side at 8192', () => {
    expect(previewScale(1000, 500)).toBe(2);
    expect(previewScale(4096, 4096)).toBe(2);
    expect(previewScale(4932, 230)).toBe(8192 / 4932);
    expect(previewScale(300, 9000)).toBe(8192 / 9000);
    expect(previewScale(10000, 20000)).toBe(8192 / 20000);
    // Inputs that are not finite or not positive fall back to the plain scale.
    for (const [w, h] of [[0, 100], [100, -1], [NaN, 100], [100, Infinity], [undefined, undefined]]) {
      expect(previewScale(w, h)).toBe(2);
    }
    expect(previewScale(1000, 500, { scale: 3, maxSidePx: 1500 })).toBe(1.5);
  });

  test('svgSize reads the root size and returns null without one', () => {
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg" width="812.4" height="230" viewBox="0 0 812.4 230" font-family="Arial, sans-serif"><rect width="10" height="10"/></svg>'))
      .toEqual({ width: 812.4, height: 230 });
    // stroke-width and nested elements must not be read as the root size.
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg" stroke-width="3" height="40" width="60"><rect width="5" height="5"/></svg>'))
      .toEqual({ width: 60, height: 40 });
    expect(svgSize('<?xml version="1.0"?>\n<svg width=\'120\' height=\'80.5\'></svg>')).toEqual({ width: 120, height: 80.5 });
    // The "No elements" SVG of an empty diagram has no size.
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg"><text y="20">No elements</text></svg>')).toBeNull();
    // A size on a nested element is not the root size.
    expect(svgSize('<svg xmlns="http://www.w3.org/2000/svg"><svg width="50" height="50"/></svg>')).toBeNull();
    expect(svgSize('<svg width="50"></svg>')).toBeNull();
    expect(svgSize('<svg width="0" height="10"></svg>')).toBeNull();
    expect(svgSize('<svg width="100%" height="10"></svg>')).toBeNull();
    expect(svgSize('not an svg')).toBeNull();
  });

  test('planParts: no parts when the image fits one part', () => {
    expect(planParts(3200, 3200, { partPx: 3200, overlapPx: 320 })).toEqual([]);
    expect(planParts(1, 1, { partPx: 3200, overlapPx: 320 })).toEqual([]);
  });

  test('planParts covers the image, overlaps by at least overlapPx and keeps every part within partPx', () => {
    const lengths = [];
    for (let len = 1; len <= 20000; len += len < 400 ? 1 : 37) lengths.push(len);
    lengths.push(20000);
    const pairs = [[3200, 320], [2657, 266], [100, 10], [10, 9], [7, 0], [50, 49]];
    const failures = [];
    for (const [partPx, overlapPx] of pairs) {
      // 1-D: a one-row image exposes the x axis of every length. Lengths beyond 40 parts per
      // axis add nothing for the tiny part sizes but cost time.
      for (const len of lengths.filter((l) => l <= partPx * 40)) {
        const parts = planParts(len, 1, { partPx, overlapPx });
        if (len <= partPx) {
          if (parts.length !== 0) failures.push(`${len}/${partPx}/${overlapPx}: expected no parts`);
          continue;
        }
        if (parts.some((p) => p.y !== 0 || p.h !== 1)) failures.push(`${len}: y axis of a 1-px row`);
        const why = checkAxis(axis(parts, 'x', 'w'), len, partPx, overlapPx);
        if (why) failures.push(`${len}/${partPx}/${overlapPx}: ${why}`);
      }
      // 2-D on a coarser grid, for the realistic part sizes: a full row-major grid, both axes checked.
      if (partPx < 1000) continue;
      const coarse = lengths.filter((_, i) => i % 25 === 0);
      for (const w of coarse) {
        for (const h of coarse) {
          const parts = planParts(w, h, { partPx, overlapPx });
          if (w <= partPx && h <= partPx) {
            if (parts.length !== 0) failures.push(`${w}x${h}: expected no parts`);
            continue;
          }
          const xs = axis(parts, 'x', 'w');
          const ys = axis(parts, 'y', 'h');
          if (parts.length !== xs.length * ys.length) failures.push(`${w}x${h}: not a full grid`);
          for (const [i, p] of parts.entries()) {
            const want = { x: xs[i % xs.length][0], y: ys[Math.floor(i / xs.length)][0] };
            if (p.x !== want.x || p.y !== want.y) { failures.push(`${w}x${h}: part ${i} not row-major`); break; }
          }
          for (const [why, label] of [[checkAxis(xs, w, partPx, overlapPx), 'x'], [checkAxis(ys, h, partPx, overlapPx), 'y']]) {
            if (why) failures.push(`${w}x${h} ${label}/${partPx}/${overlapPx}: ${why}`);
          }
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });

  test('planParts: one axis that fits gives a single full-length part on that axis', () => {
    const parts = planParts(5000, 300, { partPx: 3200, overlapPx: 320 });
    expect(parts).toEqual([{ x: 0, y: 0, w: 2660, h: 300 }, { x: 2340, y: 0, w: 2660, h: 300 }]);
  });

  test('planParts: wide-pipeline at the cap gives four parts in one row', () => {
    // 4932 × 230 units at the capped scale 8192/4932; part and overlap sizes follow from it.
    const s = previewScale(4932, 230);
    const partPx = Math.round(PNG_PREVIEW.partUnits * s);
    const overlapPx = Math.round(PNG_PREVIEW.overlapUnits * s);
    expect([partPx, overlapPx]).toEqual([2658, 266]);
    const parts = planParts(8192, 382, { partPx, overlapPx });
    expect(parts).toHaveLength(4);
    expect(parts.every((p) => p.w <= partPx)).toBe(true);
    expect(parts.every((p) => p.y === 0 && p.h === 382)).toBe(true);
    expect(parts[0].x).toBe(0);
    expect(parts[3].x + parts[3].w).toBe(8192);
  });

  test('planParts rejects overlap ≥ part size', () => {
    expect(() => planParts(5000, 5000, { partPx: 100, overlapPx: 100 })).toThrow(RangeError);
    expect(() => planParts(5000, 5000, { partPx: 100, overlapPx: 150 })).toThrow(RangeError);
    expect(() => planParts(50, 50, { partPx: 100, overlapPx: 100 })).toThrow(RangeError);
  });

  test('crc32 matches the PNG spec check value', () => {
    expect(crc32(Buffer.from('IEND'))).toBe(0xAE426082);
    expect(crc32(Buffer.from('123456789'))).toBe(0xCBF43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  test('encodePng round-trips', () => {
    const width = 3;
    const height = 2;
    const rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) rgba.set([i * 10, i * 10 + 1, i * 10 + 2, 255 - i], i * 4);
    const png = encodePng(rgba, width, height);
    expect(Buffer.isBuffer(png)).toBe(true);

    const parts = chunks(png);
    expect(parts.map((c) => c.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
    for (const c of parts) expect(c.crc).toBe(crc32(c.typeAndData));

    const ihdr = parts[0].data;
    expect(ihdr).toHaveLength(13);
    expect(ihdr.readUInt32BE(0)).toBe(3);
    expect(ihdr.readUInt32BE(4)).toBe(2);
    expect([...ihdr.subarray(8)]).toEqual([8, 2, 0, 0, 0]); // bit depth 8, RGB, deflate, filter 0, no interlace
    expect(parts[2].data).toHaveLength(0);

    // Each row: filter byte 0, then R G B per pixel; alpha is dropped.
    const expected = [
      0, 0, 1, 2, 10, 11, 12, 20, 21, 22,
      0, 30, 31, 32, 40, 41, 42, 50, 51, 52,
    ];
    expect([...inflateSync(parts[1].data)]).toEqual(expected);
    expect(pngSize(png)).toEqual({ width: 3, height: 2 });
  });

  test('encodePng rejects a buffer of the wrong length', () => {
    expect(() => encodePng(new Uint8Array(5), 3, 2)).toThrow(RangeError);
  });

  test('pngSize rejects a bad signature or a missing IHDR', () => {
    const good = encodePng(new Uint8Array(4 * 4), 2, 2);
    const badSignature = Buffer.from(good);
    badSignature[1] = 0x51;
    expect(() => pngSize(badSignature)).toThrow(/signature/);
    expect(() => pngSize(good.subarray(0, 20))).toThrow(/IHDR/);
    const notIhdr = Buffer.from(good);
    notIhdr.write('IDAT', 12, 'latin1');
    expect(() => pngSize(notIhdr)).toThrow(/IHDR/);
    expect(() => pngSize(Buffer.alloc(0))).toThrow(/signature/);
  });

  test('cropRgba takes the right pixels', () => {
    const width = 4;
    const rgba = new Uint8Array(width * 4 * 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < width; x++) rgba.set([x, y, x + y, 255], (y * width + x) * 4);
    }
    const out = cropRgba(rgba, width, { x: 1, y: 1, w: 2, h: 2 });
    expect(out).toBeInstanceOf(Uint8Array);
    expect([...out]).toEqual([
      1, 1, 2, 255, 2, 1, 3, 255,
      1, 2, 3, 255, 2, 2, 4, 255,
    ]);
    expect(() => cropRgba(rgba, width, { x: 3, y: 0, w: 2, h: 1 })).toThrow(RangeError);
    expect(() => cropRgba(rgba, width, { x: 0, y: 3, w: 1, h: 2 })).toThrow(RangeError);
  });
});

/** Pixels whose luma (ITU-R BT.601) is below 128 in a tightly packed RGBA image. */
function darkPixels(rgba) {
  let n = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2] < 128) n++;
  }
  return n;
}

/** The SVG that `runPipeline` renders for a fixture model. */
async function fixtureSvg(name) {
  const result = await runPipeline(JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')));
  expect(typeof result.svg).toBe('string');
  return result.svg;
}

describe('png — renderer', () => {
  let tmp;
  beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'png-renderer-')); });
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

  test('loadPngRenderer reports a missing renderer', async () => {
    const importModule = () => Promise.reject(Object.assign(
      new Error("Cannot find package '@resvg/resvg-wasm'"), { code: 'ERR_MODULE_NOT_FOUND' }));
    const err = await loadPngRenderer({ importModule }).catch((e) => e);
    expect(err).toBeInstanceOf(PngUnavailableError);
    expect(err.code).toBe('PNG_UNAVAILABLE');
    expect(err.message).toContain('@resvg/resvg-wasm');
    expect(err.message).toContain('npm install');
  });

  test('loadPngRenderer reports a missing font', async () => {
    const fontPath = join(tmp, 'no-such-font.ttf');
    const err = await loadPngRenderer({ fontPath }).catch((e) => e);
    expect(err).toBeInstanceOf(PngUnavailableError);
    expect(err.message).toContain(fontPath);
  });

  test('loadPngRenderer refuses a file that is not a font', async () => {
    const fontPath = join(tmp, 'not-a-font.ttf');
    writeFileSync(fontPath, 'This is a plain text file, not a TrueType font.\n');
    const err = await loadPngRenderer({ fontPath }).catch((e) => e);
    expect(err).toBeInstanceOf(PngUnavailableError);
    expect(err.message).toContain(fontPath);
  });

  test('the default renderer is loaded once', async () => {
    const first = await loadPngRenderer();
    const second = await loadPngRenderer();
    expect(second).toBe(first);
    expect(typeof first.renderRgba).toBe('function');
  });

  test('text renders', async () => {
    const renderer = await loadPngRenderer();
    const svg = await fixtureSvg('example-bestellung-versand.json');
    const withoutText = svg.replace(/<text\b[^>]*>[\s\S]*?<\/text>/g, '');
    expect(withoutText.length).toBeLessThan(svg.length);
    const full = renderer.renderRgba(svg, 2);
    const bare = renderer.renderRgba(withoutText, 2);
    expect([bare.width, bare.height]).toEqual([full.width, full.height]);
    // Measured once on this fixture at scale 2 (resvg-wasm 2.6.2, Arimo Regular, 5020 × 2396 px):
    // the text adds 0.174 % of all pixels as dark pixels (luma < 128). A threshold of 0.05 % is
    // about a third of that, so antialiasing or small layout changes cannot trip it, and it is
    // far above 0, so a render that drops the text (no usable font draws nothing, without any
    // error) fails. 0.2 % would have been above the measured value for this wide, sparse diagram.
    const ratio = (darkPixels(full.rgba) - darkPixels(bare.rgba)) / (full.width * full.height);
    expect(ratio).toBeGreaterThan(0.0005);
  });

  test('the empty-diagram SVG renders its text', async () => {
    const renderer = await loadPngRenderer();
    // The exact string bpmn/svg.js returns for a diagram without elements: no width, height or
    // font-family, so the renderer's default size and default font family apply.
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text y="20">No elements</text></svg>';
    const { rgba } = renderer.renderRgba(svg, 2);
    expect(darkPixels(rgba)).toBeGreaterThan(0);
  });

  test('renderPreview at scale 2 for a small diagram', async () => {
    const renderer = await loadPngRenderer();
    const svg = await fixtureSvg('simple-approval.json');
    const { width: W, height: H } = svgSize(svg);
    const out = renderPreview(svg, renderer);
    expect(out.scale).toBe(2);
    expect(Math.abs(out.width - 2 * W)).toBeLessThanOrEqual(1);
    expect(Math.abs(out.height - 2 * H)).toBeLessThanOrEqual(1);
    expect(out.parts).toEqual([]);
    expect(pngSize(out.png)).toEqual({ width: out.width, height: out.height });
  });

  test('renderPreview caps wide-pipeline at 8192 px and cuts four parts', async () => {
    const renderer = await loadPngRenderer();
    const svg = await fixtureSvg('wide-pipeline.json');
    const out = renderPreview(svg, renderer);
    expect(out.scale).toBeLessThan(2);
    expect(out.width).toBeLessThanOrEqual(8192);
    expect(pngSize(out.png)).toEqual({ width: out.width, height: out.height });
    expect(out.parts).toHaveLength(4);
    for (const part of out.parts) expect(pngSize(part.png)).toEqual({ width: part.w, height: part.h });
    const last = out.parts[3];
    expect(last.x + last.w).toBe(out.width);
  });

  test('a render error is a PngRenderError and the next render still works', async () => {
    // The failing renderer is a fake: no input found here makes the real wasm trap. The test covers
    // the wrapping and that the shared renderer stays usable for the next call.
    const svg = await fixtureSvg('simple-approval.json');
    const failing = { renderRgba() { throw new WebAssembly.RuntimeError('unreachable'); } };
    const err = (() => { try { renderPreview(svg, failing); } catch (e) { return e; } return null; })();
    expect(err).toBeInstanceOf(PngRenderError);
    expect(err.cause).toBeDefined();
    expect(err.cause.message).toBe('unreachable');
    expect(err.message).toContain('unreachable');
    const out = renderPreview(svg, await loadPngRenderer());
    expect(pngSize(out.png)).toEqual({ width: out.width, height: out.height });
  });
});

describe('png — writer', () => {
  // A renderer stand-in that returns a flat image of the given size, without wasm.
  const flatRenderer = (width, height) => ({
    renderRgba: () => ({ rgba: new Uint8Array(width * height * 4).fill(255), width, height }),
  });
  const svgOf = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"></svg>`;

  test('removeStaleParts removes only the parts of this base', () => {
    const files = [
      'out.part-1-of-9.png', 'out.part-12-of-12.png', 'out.png', 'outx.part-1-of-2.png',
      'out.part-1-of-9.png.bak', 'out.part-a-of-2.png', 'o.t.part-1-of-2.png', 'out.svg',
    ];
    const removed = [];
    const result = removeStaleParts(join('dir', 'out'), {
      readdir: (d) => { expect(d).toBe('dir'); return files; },
      unlink: (p) => removed.push(p),
      exists: () => false,
    });
    expect(result).toEqual([join('dir', 'out.part-1-of-9.png'), join('dir', 'out.part-12-of-12.png')]);
    expect(removed).toEqual(result);
    // The base name is matched literally, not as a pattern: "o.t" does not match "out".
    expect(removeStaleParts('o.t', { readdir: () => ['out.part-1-of-2.png', 'o.t.part-1-of-2.png'], unlink() {}, exists: () => false }))
      .toEqual(['o.t.part-1-of-2.png']);
  });

  test('writePngPreviews encodes everything before it removes or writes anything', () => {
    const calls = [];
    const renderer = {
      renderRgba: (svg, scale) => { calls.push('render'); return flatRenderer(3400, 10).renderRgba(svg, scale); },
    };
    const [result] = writePngPreviews([{ svg: svgOf(1700, 5), base: 'w' }], renderer, {
      writeFile: (p) => calls.push(`write ${p}`),
      removeStale: (base) => { calls.push(`remove ${base}`); return []; },
    });
    expect(result).toEqual({
      base: 'w', ok: true, scale: 2, parts: 2,
      files: ['w.png', 'w.part-1-of-2.png', 'w.part-2-of-2.png'],
    });
    expect(calls).toEqual(['render', 'remove w', ...result.files.map((f) => `write ${f}`)]);
  });

  test('writePngPreviews never throws and goes on after a failed target', () => {
    const written = [];
    const failing = { renderRgba: () => { throw new WebAssembly.RuntimeError('unreachable'); } };
    let first = true;
    const renderer = {
      renderRgba: (svg, scale) => {
        if (first) { first = false; return failing.renderRgba(); }
        return flatRenderer(20, 10).renderRgba(svg, scale);
      },
    };
    const results = writePngPreviews(
      [{ svg: svgOf(10, 5), base: 'a' }, { svg: svgOf(10, 5), base: 'b' }],
      renderer,
      { writeFile: (p) => written.push(p), removeStale: () => [], unlink() {} });
    expect(results[0]).toEqual({ base: 'a', ok: false, message: 'the renderer failed: unreachable' });
    expect(results[1]).toMatchObject({ base: 'b', ok: true, files: ['b.png'], parts: 0, scale: 2 });
    expect(written).toEqual(['b.png']);

    const writeFails = writePngPreviews([{ svg: svgOf(10, 5), base: 'c' }], flatRenderer(20, 10), {
      writeFile: () => { throw Object.assign(new Error("EACCES: permission denied, open 'c.png'"), { code: 'EACCES' }); },
      removeStale: () => [],
      unlink() {},
    });
    expect(writeFails).toEqual([{ base: 'c', ok: false, message: "EACCES: permission denied, open 'c.png'" }]);
  });

  test('removeStaleParts keeps a file that is the main preview of another diagram', () => {
    // `out.part-1-of-2.png` is a part name for base `out`, but beside `out.part-1-of-2.svg` it is
    // the whole-diagram preview of a diagram whose base is `out.part-1-of-2`.
    const removed = [];
    const result = removeStaleParts(join('dir', 'out'), {
      readdir: () => ['out.part-1-of-2.png', 'out.part-1-of-2.svg', 'out.part-2-of-2.png'],
      unlink: (p) => removed.push(p),
      exists: (p) => p === join('dir', 'out.part-1-of-2.svg'),
    });
    expect(result).toEqual([join('dir', 'out.part-2-of-2.png')]);
    expect(removed).toEqual(result);
  });

  test('a write that fails mid-way leaves no PNG of that base', () => {
    const calls = [];
    const [result] = writePngPreviews([{ svg: svgOf(1700, 5), base: 'w' }], flatRenderer(3400, 10), {
      writeFile: (p) => {
        if (p === 'w.part-1-of-2.png') throw new Error("ENOSPC: no space left on device, write 'w.part-1-of-2.png'");
        calls.push(`write ${p}`);
      },
      removeStale: (base) => { calls.push(`remove ${base}`); return []; },
      unlink: (p) => calls.push(`unlink ${p}`),
    });
    expect(result).toEqual({ base: 'w', ok: false, message: "ENOSPC: no space left on device, write 'w.part-1-of-2.png'" });
    // The new whole image was written, then the failure removed it and every part of the base.
    expect(calls).toEqual(['remove w', 'write w.png', 'unlink w.png', 'remove w']);
  });

  test('the clean-up after a failure never throws', () => {
    const failing = { renderRgba: () => { throw new WebAssembly.RuntimeError('unreachable'); } };
    const results = writePngPreviews([{ svg: svgOf(10, 5), base: 'z' }], failing, {
      writeFile() {},
      removeStale: () => { throw new Error('EACCES'); },
      unlink: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    });
    expect(results).toEqual([{ base: 'z', ok: false, message: 'the renderer failed: unreachable' }]);
  });
});

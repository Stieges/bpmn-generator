/**
 * `node bpmn/pipeline.js … --png`: the PNG preview on the command line. Every run spawns the real
 * program (cwd scripts/) with its output in a temp directory, so nothing is written into the
 * repository. The test hooks under tests/fixtures/png/ hide the optional renderer or replace it
 * with one that fails on every real diagram.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pngSize, svgSize } from '../shared/png.js';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = resolve(here, '..');
const fixtures = resolve(scripts, '..', 'tests/fixtures');
const PIPELINE = join(here, 'pipeline.js');
const HIDE_RESVG = pathToFileURL(join(fixtures, 'png', 'hide-resvg.mjs')).href;
// Written to stderr by the hide hook whenever @resvg/resvg-wasm is requested.
const HIDE_MARKER = '[hide-resvg] @resvg/resvg-wasm requested';
const FAILING_RESVG = pathToFileURL(join(fixtures, 'png', 'failing-resvg.mjs')).href;

const fixture = (name) => join(fixtures, name);

/** Run the CLI; `hook` is a module for `node --import` (or none). */
const run = (args, { hook } = {}) => {
  const r = spawnSync(process.execPath, [...(hook ? ['--import', hook] : []), PIPELINE, ...args],
    { cwd: scripts, encoding: 'utf8' });
  return { status: r.status, out: r.stdout, err: r.stderr };
};

let tmp;
beforeAll(() => { tmp = realpathSync(mkdtempSync(join(tmpdir(), 'png-cli-'))); });
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

/** A fresh, empty directory under the temp root. */
const dir = (name) => {
  const d = join(tmp, name);
  mkdirSync(d);
  return d;
};
const pngsIn = (d) => readdirSync(d).filter((f) => f.endsWith('.png')).sort();

describe('pipeline CLI --png: simple-approval with and without the flag', () => {
  // One run each, shared by the assertions below.
  let plain;
  let withPng;
  beforeAll(() => {
    plain = { dir: dir('plain') };
    plain.run = run([fixture('simple-approval.json'), join(plain.dir, 'out')]);
    withPng = { dir: dir('with-png') };
    withPng.run = run([fixture('simple-approval.json'), join(withPng.dir, 'out'), '--png']);
  });

  test('without --png the model files are byte-identical to a --png run and no PNG is written', () => {
    expect(plain.run.status).toBe(0);
    expect(withPng.run.status).toBe(0);
    for (const ext of ['bpmn', 'svg']) {
      expect(readFileSync(join(withPng.dir, `out.${ext}`))).toEqual(readFileSync(join(plain.dir, `out.${ext}`)));
    }
    expect(pngsIn(plain.dir)).toEqual([]);
    expect(plain.run.out).not.toMatch(/PNG/);
    // The flag adds exactly one stdout line and nothing else.
    const pngLine = `✓ PNG preview → ${join(withPng.dir, 'out')}.png\n`;
    expect(withPng.run.out.replace(pngLine, '').split(withPng.dir).join(plain.dir)).toBe(plain.run.out);
    expect(withPng.run.err).toBe(plain.run.err);
  });

  test('--png writes the whole diagram', () => {
    expect(withPng.run.status).toBe(0);
    expect(pngsIn(withPng.dir)).toEqual(['out.png']);
    const svg = svgSize(readFileSync(join(withPng.dir, 'out.svg'), 'utf8'));
    const png = pngSize(readFileSync(join(withPng.dir, 'out.png')));
    expect(Math.abs(png.width - 2 * svg.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(png.height - 2 * svg.height)).toBeLessThanOrEqual(1);
    expect(withPng.run.out).toMatch(/✓ PNG preview → .*\.png$/m);
  });
});

describe('pipeline CLI --png', () => {
  test('without --png the renderer is never loaded', () => {
    const d = dir('hidden-no-flag');
    const r = run([fixture('simple-approval.json'), join(d, 'out')], { hook: HIDE_RESVG });
    expect(r.status).toBe(0);
    expect(r.err).not.toContain(HIDE_MARKER);
    expect(existsSync(join(d, 'out.bpmn'))).toBe(true);
    expect(existsSync(join(d, 'out.svg'))).toBe(true);
  });

  test('--png on a wide diagram writes the parts', () => {
    const d = dir('wide');
    const r = run([fixture('wide-pipeline.json'), join(d, 'out'), '--png']);
    expect(r.status).toBe(0);
    expect(pngsIn(d)).toEqual(['out.part-1-of-4.png', 'out.part-2-of-4.png', 'out.part-3-of-4.png', 'out.part-4-of-4.png', 'out.png']);
    expect(pngSize(readFileSync(join(d, 'out.png'))).width).toBeLessThanOrEqual(8192);
    expect(r.out).toContain('(+4 parts)');
    // Under the cap the effective scale is printed.
    expect(r.out).toMatch(/\(\+4 parts\) at scale 1\.\d\d$/m);
  });

  test('--png with the renderer missing: exit 1, message, no files written', () => {
    const d = dir('hidden');
    const r = run([fixture('simple-approval.json'), join(d, 'out'), '--png'], { hook: HIDE_RESVG });
    expect(r.status).toBe(1);
    // The hook saw the request, so the marker check in the test without --png means something.
    expect(r.err).toContain(HIDE_MARKER);
    expect(r.err).toContain('@resvg/resvg-wasm');
    expect(r.err).toContain('npm install');
    expect(r.err).not.toContain('in scripts/');
    expect(r.err).toContain('No files written');
    expect(readdirSync(d)).toEqual([]);
  });

  test('a render failure keeps the model files', () => {
    const plainDir = dir('failing-plain');
    expect(run([fixture('simple-approval.json'), join(plainDir, 'out')]).status).toBe(0);
    const d = dir('failing');
    // An earlier run's preview of the same base must not survive beside the new model files.
    writeFileSync(join(d, 'out.png'), 'old preview');
    writeFileSync(join(d, 'out.part-1-of-2.png'), 'old part');
    const r = run([fixture('simple-approval.json'), join(d, 'out'), '--png'], { hook: FAILING_RESVG });
    expect(r.status).toBe(1);
    expect(r.err).toContain('PNG preview failed');
    expect(r.err).toContain('were written');
    for (const ext of ['bpmn', 'svg']) {
      expect(readFileSync(join(d, `out.${ext}`))).toEqual(readFileSync(join(plainDir, `out.${ext}`)));
    }
    expect(existsSync(join(d, 'out.png'))).toBe(false);
    expect(existsSync(join(d, 'out.part-1-of-2.png'))).toBe(false);
    expect(pngsIn(d)).toEqual([]);
    // process.exitCode, not process.exit: the summary still prints.
    expect(r.out).toContain('Files:');
  });

  test('--png with --doc and --dot: the PNG step comes last', () => {
    // What this observes: a failed render leaves the documentation and the DOT export in place,
    // which is the point of running the PNG step last.
    const d = dir('failing-doc-dot');
    const r = run([fixture('simple-approval.json'), join(d, 'out'), '--png', '--doc', '--dot'], { hook: FAILING_RESVG });
    expect(r.status).toBe(1);
    expect(existsSync(join(d, 'out.md'))).toBe(true);
    expect(existsSync(join(d, 'out.dot'))).toBe(true);
    expect(pngsIn(d)).toEqual([]);
  });

  test('--strict stops a warned model before any PNG', () => {
    const input = fixture('negative/empty-lane.json');
    const plainDir = dir('strict-plain');
    const plain = run([input, join(plainDir, 'out'), '--strict']);
    expect(plain.status).toBe(1);
    expect(plain.err).toContain('--strict');
    expect(readdirSync(plainDir)).toEqual([]);

    const d = dir('strict-png');
    const r = run([input, join(d, 'out'), '--strict', '--png']);
    expect(r.status).toBe(1);
    expect(r.err).toBe(plain.err);
    expect(readdirSync(d)).toEqual([]);
  });

  test('--png adds no warning', () => {
    const input = fixture('example-bestellung-versand.json');
    const without = run([input, join(dir('order-plain'), 'out'), '--strict']);
    const withPng = run([input, join(dir('order-png'), 'out'), '--strict', '--png']);
    expect(withPng.status).toBe(without.status);
    expect(withPng.err.split('\n')).toEqual(without.err.split('\n'));
  });

  test('--png with --drill-down writes one PNG per diagram', () => {
    const d = dir('drill-down');
    const r = run([fixture('expanded-subprocess.json'), join(d, 'out'), '--drill-down', '--png']);
    expect(r.status).toBe(0);
    const subSvgs = readdirSync(d).filter((f) => /^out_.+\.svg$/.test(f));
    expect(subSvgs.length).toBeGreaterThan(0);
    const expected = ['out.png', ...subSvgs.map((f) => f.replace(/\.svg$/, '.png'))].sort();
    expect(pngsIn(d)).toEqual(expected);
    for (const f of expected) expect(r.out).toContain(`✓ PNG preview → ${join(d, f)}`);
  });

  test('stale parts from an earlier run are removed', () => {
    const d = dir('stale');
    writeFileSync(join(d, 'out.part-1-of-9.png'), 'stale');
    writeFileSync(join(d, 'outx.part-1-of-2.png'), 'other base');
    const r = run([fixture('simple-approval.json'), join(d, 'out'), '--png']);
    expect(r.status).toBe(0);
    expect(existsSync(join(d, 'out.part-1-of-9.png'))).toBe(false);
    expect(readFileSync(join(d, 'outx.part-1-of-2.png'), 'utf8')).toBe('other base');
    expect(pngsIn(d)).toEqual(['out.png', 'outx.part-1-of-2.png']);
  });

  test('--png with --import-dot is refused', () => {
    const d = dir('import-dot');
    const dot = join(tmp, 'order.dot');
    writeFileSync(dot, 'digraph G { start -> check_order; check_order -> end; }\n');
    const r = run([dot, join(d, 'out'), '--import-dot', '--png']);
    expect(r.status).toBe(1);
    expect(r.err).toContain('✗ --png needs a diagram; --import-dot writes Logic-Core JSON only');
    expect(readdirSync(d)).toEqual([]);
  });
});

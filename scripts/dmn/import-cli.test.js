import { describe, test, expect, beforeAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDecisionCoreSchema } from './schema-gate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '..', '..', 'tests', 'fixtures');
const GOOD = join(FIXTURES, 'dmn', 'discount-decision.expected.dmn');
const LOSSY = join(FIXTURES, 'dmn', 'foreign-kitchen-sink.dmn');
const BPMN = join(FIXTURES, 'simple-approval.expected.bpmn');

let dir;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'dmn-import-cli-')); });

const run = (args, input) =>
  spawnSync('node', ['import.js', ...args], { cwd: __dirname, encoding: 'utf8', input });

describe('dmn/import.js CLI (spawned)', () => {
  test('a good .dmn file: exit 0, schema-valid JSON written', () => {
    const out = join(dir, 'good.json');
    const r = run([GOOD, out]);
    expect(r.status).toBe(0);
    const dc = JSON.parse(readFileSync(out, 'utf8'));
    expect(validateDecisionCoreSchema(dc).valid).toBe(true);
  });

  test('stdin "-" works, and with no output path the JSON goes to stdout', () => {
    const r = run(['-'], readFileSync(GOOD, 'utf8'));
    expect(r.status).toBe(0);
    expect(validateDecisionCoreSchema(JSON.parse(r.stdout)).valid).toBe(true);
  });

  test('non-XML input: exit != 0, the "not XML" message, no stack', () => {
    const r = run(['-'], 'this is not xml');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not XML/);
    expect(r.stderr).not.toMatch(/not a DMN document/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  test('well-formed non-DMN XML (BPMN): exit != 0, the "not a DMN document" message', () => {
    const r = run([BPMN, join(dir, 'bpmn.json')]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/not a DMN document/);
    expect(r.stderr).not.toMatch(/not XML/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
    expect(existsSync(join(dir, 'bpmn.json'))).toBe(false);
  });

  test('a missing input file has its own clean error', () => {
    const r = run([join(dir, 'nope.dmn')]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/cannot read input file/);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  test('--strict on a lossy file: exit 1, report on stderr, nothing written', () => {
    const out = join(dir, 'strict.json');
    const r = run([LOSSY, out, '--strict']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/IM\d\d/);
    expect(existsSync(out)).toBe(false);
  });

  test('the same file without --strict: exit 0, file written, report on stderr', () => {
    const out = join(dir, 'lenient.json');
    const r = run([LOSSY, out]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/IM\d\d/);
    expect(validateDecisionCoreSchema(JSON.parse(readFileSync(out, 'utf8'))).valid).toBe(true);
  });

  test('importing the module does not run the CLI', () => {
    const r = spawnSync('node', ['--input-type=module', '-e',
      `await import(${JSON.stringify(join(__dirname, 'import.js'))}); console.log('imported')`],
    { encoding: 'utf8', timeout: 20000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('imported');
    expect(r.stderr).toBe('');
  });
});

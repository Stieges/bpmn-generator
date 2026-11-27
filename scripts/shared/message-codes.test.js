import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MESSAGE_CODES, coded, codeOf, withCode } from './message-codes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = resolve(__dirname, '..');

// references/ inside scripts/ is the prepack build artifact (JSON and Markdown, no source). It is
// skipped like node_modules: resource-paths.test.js creates and removes it while this file walks
// the tree in a parallel worker, and a directory listed and then removed fails the walk (ENOENT).
function sources(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || (dir === SCRIPTS && e.name === 'references')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

describe('registry', () => {
  test('holds exactly the registered codes', () => {
    expect(Object.keys(MESSAGE_CODES).sort()).toEqual([
      'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C10', 'C11', 'C12', 'C13',
      'F01', 'F02', 'F03', 'F04', 'F05', 'H01', 'H02', 'H03', 'H04', 'H05', 'H06', 'H07', 'H08', 'H09', 'H10', 'H11', 'H12', 'H13', 'H14', 'H15', 'H16', 'H17', 'H18',
      'MG01', 'MG02', 'MG03', 'MG04', 'MG05', 'MG06', 'MG07', 'N01',
    ]);
  });

  test('every entry has a family and a summary; the registry is frozen', () => {
    for (const [code, entry] of Object.entries(MESSAGE_CODES)) {
      expect(['catalogue', 'format', 'hint', 'migrate', 'notice']).toContain(entry.family);
      expect(typeof entry.summary).toBe('string');
      expect(entry.summary.length).toBeGreaterThan(0);
      expect(code).toMatch(/^[A-Z]{1,2}\d{2}$/);
    }
    expect(Object.isFrozen(MESSAGE_CODES)).toBe(true);
  });
});

describe('coded, codeOf, withCode', () => {
  test('coded prefixes a registered code and refuses another', () => {
    expect(coded('C11', 'x')).toBe('[C11] x');
    expect(() => coded('Z99', 'x')).toThrow('unregistered message code "Z99"');
  });

  test('codeOf reads a registered leading prefix only', () => {
    expect(codeOf('[C01] node "a" …')).toBe('C01');
    expect(codeOf('[F05] x')).toBe('F05');
    expect(codeOf('[catalog] …')).toBeNull();
    expect(codeOf('[decisions #0] …')).toBeNull();
    expect(codeOf('S02 …')).toBeNull();
    expect(codeOf('[Z99] x')).toBeNull();
    expect(codeOf('x [C01] y')).toBeNull();
    expect(codeOf('[C01]x')).toBeNull();
  });

  test('withCode keeps the class and the class code, sets messageCode, prefixes once', () => {
    const err = withCode(new TypeError('m'), 'C13');
    expect(err).toBeInstanceOf(TypeError);
    expect(err.messageCode).toBe('C13');
    expect(err.message).toBe('[C13] m');
    expect(withCode(err, 'C13').message).toBe('[C13] m');
    const rejected = Object.assign(new Error('r'), { code: 'CATALOG_REJECTED' });
    expect(withCode(rejected, 'C12').code).toBe('CATALOG_REJECTED');
    expect(() => withCode(new Error('m'), 'Z99')).toThrow('unregistered message code "Z99"');
  });
});

describe('fences', () => {
  const files = sources(SCRIPTS).map((p) => [relative(SCRIPTS, p), readFileSync(p, 'utf8')]);

  test('fence 1: every [Xnn] literal and every coded(…) / withCode(…) names a registered code', () => {
    const bad = [];
    for (const [file, text] of files) {
      for (const m of text.matchAll(/['"`]\[([A-Z]{1,2}\d{2})\] /g)) {
        if (!Object.hasOwn(MESSAGE_CODES, m[1])) bad.push(`${file}: literal [${m[1]}]`);
      }
      for (const m of text.matchAll(/\bcoded\(\s*['"]([^'"]+)['"]/g)) {
        if (!Object.hasOwn(MESSAGE_CODES, m[1])) bad.push(`${file}: coded('${m[1]}')`);
      }
      for (const m of text.matchAll(/\bwithCode\([^;]*?,\s*['"]([A-Z]{1,2}\d{2})['"]\s*\)/g)) {
        if (!Object.hasOwn(MESSAGE_CODES, m[1])) bad.push(`${file}: withCode(…, '${m[1]}')`);
      }
    }
    expect(bad).toEqual([]);
  });

  // Codes carried by an object or a constant, or in the middle of a literal. Only the registry families
  // (C, F, H, MG, N) are read here: rule ids (S, M, P, WF), DI and NC codes are not registry codes.
  const OBJECT_FORMS = {
    'code field or variable': /\bcode\s*[:=]\s*(?:[^;\n]*?\?\s*)?['"]((?:[CFHN]|MG)\d{2})['"]/g,
    'errorFindings(…, code)': /\berrorFindings\([^;]*?,\s*['"]((?:[CFHN]|MG)\d{2})['"]\s*\)/g,
    'constant *_CODE': /_CODE\s*=\s*['"]((?:[CFHN]|MG)\d{2})['"]/g,
    'prefix inside a literal': /['"`][^'"`\n]*?\[((?:[CFHN]|MG)\d{2})\] /g,
  };

  test('fence 1b: every code carried by an object, a constant or a mid-literal prefix is registered', () => {
    const bad = [];
    for (const [file, text] of files) {
      for (const [form, re] of Object.entries(OBJECT_FORMS)) {
        for (const m of text.matchAll(re)) {
          if (!Object.hasOwn(MESSAGE_CODES, m[1])) bad.push(`${file}: ${form} ${m[1]}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  test('fence 1b finds at least one of each form, and no rule id, DI or NC code', () => {
    const all = files.map(([, t]) => t).join('\n');
    for (const [form, re] of Object.entries(OBJECT_FORMS)) {
      expect([form, [...all.matchAll(re)].length > 0]).toEqual([form, true]);
    }
    const seen = new Set(Object.values(OBJECT_FORMS).flatMap((re) => [...all.matchAll(re)].map((m) => m[1])));
    for (const c of seen) expect(c).toMatch(/^(?:[CFHN]|MG)\d{2}$/);
    for (const c of ['H01', 'F01', 'F02', 'F03', 'F05', 'N01', 'MG01']) expect(seen.has(c)).toBe(true);
    expect('code: "S02"').not.toMatch(OBJECT_FORMS['code field or variable']);
    expect("code: 'NC03'").not.toMatch(OBJECT_FORMS['code field or variable']);
    expect("code: 'WF01'").not.toMatch(OBJECT_FORMS['code field or variable']);
    expect("code: 'M01'").not.toMatch(OBJECT_FORMS['code field or variable']);
    expect("code: 'MG99'").toMatch(OBJECT_FORMS['code field or variable']);
  });

  test('fence 1 sees the sources it is meant to read', () => {
    expect(files.some(([f]) => f === join('bpmn', 'model-v2.js'))).toBe(true);
  });

  test('fence 2: every code has a table row in the "Message codes" section of the API reference', () => {
    const doc = readFileSync(resolve(SCRIPTS, '../references/api-reference.md'), 'utf8');
    const start = doc.indexOf('\n## Message codes');
    expect(start).toBeGreaterThan(-1);
    const rest = doc.slice(start + 1);
    const next = rest.indexOf('\n## ', 3);
    const section = next < 0 ? rest : rest.slice(0, next);
    const missing = Object.keys(MESSAGE_CODES).filter((c) => !new RegExp(`^\\| ${c} \\|`, 'm').test(section));
    expect(missing).toEqual([]);
  });
});

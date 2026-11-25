import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  CATALOG_LIMITS, CatalogRejectedError, catalogErrors, loadCatalog, SHIPPED_SCHEMES,
  resolveScheme, canonicalJson, catalogFingerprint,
} from './catalog.js';
import { catalogSchemaPath, demiSchemePath } from './resource-paths.js';

// Design 5.6.
const actors56 = [
  { id: 'abt_schaden', name: 'Schadenabteilung', kind: 'unit' },
  { id: 'abt_finanzen', name: 'Finanzen', kind: 'unit' },
  { id: 'sb_schaden', name: 'Sachbearbeitung Schaden', kind: 'role', unit: 'abt_schaden' },
  { id: 'regress', name: 'Regressspezialist', kind: 'role', unit: 'abt_schaden' },
  { id: 'zahlung', name: 'Zahlungsverkehr', kind: 'role', unit: 'abt_finanzen' },
];
const catalog56 = { scheme: 'demi', actors: actors56 };

describe('catalogErrors', () => {
  test('the design 5.6 catalogue is valid', () => {
    expect(catalogErrors(catalog56)).toEqual([]);
  });

  test.each([
    ['kind position', { id: 'a', name: 'A', kind: 'position' }, '/actors/0/kind'],
    ['id starting with a digit', { id: '1abc', name: 'A' }, '/actors/0/id'],
    ['id with a dot', { id: 'a.b', name: 'A' }, '/actors/0/id'],
    ['unit on a unit', { id: 'a', name: 'A', kind: 'unit', unit: 'b' }, '/actors/0'],
  ])('%s gives one error naming the path', (_label, actor, path) => {
    const errors = catalogErrors({ actors: [actor] });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^\[C12\] "/);
    expect(errors[0]).toContain(path);
  });

  test('a unit on a role or on an actor without kind is fine', () => {
    expect(catalogErrors({ actors: [{ id: 'a', name: 'A', unit: 'u' }, { id: 'b', name: 'B', kind: 'role', unit: 'u' }] })).toEqual([]);
  });

  test('a non-object and a too-deep catalogue are refused by the bounds', () => {
    expect(catalogErrors(null)[0]).toMatch(/^\[C12\] "\/" /);
    const deep = { actors: [{ id: 'a', name: 'A', extra: { x: { y: { z: 1 } } } }] };
    expect(catalogErrors(deep)[0]).toMatch(/^\[C12\] "\/" is nested deeper than 5 levels/);
  });

  test('an embedded scheme is checked, an unknown top-level key is refused', () => {
    expect(catalogErrors({ actors: [], scheme: { scheme: 'raci', types: [{ key: 'R', label: 'Responsible', performs: true }] } })).toEqual([]);
    expect(catalogErrors({ actors: [], scheme: { scheme: 'raci', types: [] } })).not.toEqual([]);
    expect(catalogErrors({ actors: [], persons: [] })[0]).toContain('unknown key');
  });
});

describe('schemes', () => {
  test('SHIPPED_SCHEMES lists demi', () => {
    expect(SHIPPED_SCHEMES).toEqual(['demi']);
  });

  test('undefined and "demi" resolve to the shipped file, M is Mitarbeit', () => {
    const demi = JSON.parse(readFileSync(demiSchemePath(), 'utf8'));
    expect(resolveScheme(undefined)).toEqual(demi);
    expect(resolveScheme('demi')).toEqual(demi);
    expect(demi.types.find((t) => t.key === 'M').label).toBe('Mitarbeit');
    expect(demi.types.filter((t) => t.performs)).toHaveLength(1);
  });

  test('an unknown name is null, an object is itself', () => {
    expect(resolveScheme('raci')).toBeNull();
    const own = { scheme: 'x', types: [{ key: 'A', label: 'A' }] };
    expect(resolveScheme(own)).toBe(own);
  });

  test('the demi file passes $defs/Scheme of the catalogue schema', () => {
    const schema = JSON.parse(readFileSync(catalogSchemaPath(), 'utf8'));
    const ajv = new Ajv2020({ strict: true });
    ajv.addSchema(schema);
    const validate = ajv.getSchema(`${schema.$id}#/$defs/Scheme`);
    expect(validate(JSON.parse(readFileSync(demiSchemePath(), 'utf8')))).toBe(true);
  });
});

describe('canonicalJson and fingerprint', () => {
  test('keys sorted at every level, no whitespace, non-ASCII unescaped', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 'Ä', c: 2 }] })).toBe('{"a":[{"c":2,"d":"Ä"}],"b":1}');
  });

  test('the pinned fingerprint of design 5.6 with demi', () => {
    expect(catalogFingerprint(actors56, resolveScheme('demi')))
      .toBe('sha256:1839c85404873913d420764884aa77ed37f54a3341df18b7e641c0f85f70c9a4');
  });

  test('permuting the keys of each actor changes nothing; order of actors does', () => {
    const permuted = actors56.map((a) => Object.fromEntries(Object.entries(a).reverse()));
    expect(catalogFingerprint(permuted, resolveScheme('demi'))).toBe(catalogFingerprint(actors56, resolveScheme('demi')));
    expect(catalogFingerprint([...actors56].reverse(), resolveScheme('demi'))).not.toBe(catalogFingerprint(actors56, resolveScheme('demi')));
  });
});

describe('loadCatalog', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'catalog-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const write = (text) => { const p = join(dir, 'c.json'); writeFileSync(p, text); return p; };

  test('limits', () => {
    expect(CATALOG_LIMITS).toEqual({ inlineBytes: 1048576, fileBytes: 1048576, depth: 5, messages: 20, schemaErrors: 5, token: 80 });
  });

  test('loads a file with a BOM', () => {
    expect(loadCatalog(write('﻿' + JSON.stringify(catalog56)))).toEqual(catalog56);
  });

  test('a trailing comma is refused with a position and without content', () => {
    const p = write('{ "actors": [ ], }');
    expect(() => loadCatalog(p)).toThrow(CatalogRejectedError);
    expect(() => loadCatalog(p)).toThrow(/position|line \d+, column \d+/);
    expect(() => loadCatalog(p)).toThrow(/at line/);
  });

  test('a 2 MiB file is refused', () => {
    expect(() => loadCatalog(write(' '.repeat(2 * 1024 * 1024)))).toThrow('larger than 1024 KiB');
  });

  test('a schema failure throws CatalogRejectedError with code and the errors', () => {
    try {
      loadCatalog(write(JSON.stringify({ actors: [{ id: '1x', name: 'A' }] })));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CatalogRejectedError);
      expect(err.code).toBe('CATALOG_REJECTED');
      expect(err.name).toBe('CatalogRejectedError');
      expect(err.message).toMatch(/^\[C12\] catalog .* is refused: "\/actors\/0\/id" /);
      expect(err.message).not.toContain('refused: [C12]');
      expect(err.messageCode).toBe('C12');
    }
  });

  test('every refusal carries its code: C11 for the file, C12 for the content', () => {
    const codes = (fn) => { try { fn(); } catch (err) { return [err.messageCode, err.message, err.code]; } return null; };
    const [c1, m1, k1] = codes(() => loadCatalog(join(dir, 'nope.json')));
    expect([c1, k1]).toEqual(['C11', 'CATALOG_REJECTED']);
    expect(m1).toMatch(/^\[C11\] catalog .* cannot be read \(ENOENT\)$/);
    const [c2, m2] = codes(() => loadCatalog(write('{"actors": [},')));
    expect(c2).toBe('C11');
    expect(m2).toMatch(/^\[C11\] catalog .* is not valid JSON at line \d+, column \d+$/);
    const [c3, m3] = codes(() => loadCatalog(write(' '.repeat(2 * 1024 * 1024))));
    expect(c3).toBe('C11');
    expect(m3).toMatch(/^\[C11\] .*larger than 1024 KiB/);
  });

  test('a directory is C11, not a stack trace', () => {
    try {
      loadCatalog(dir);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CatalogRejectedError);
      expect(err.messageCode).toBe('C11');
      expect(err.message).toMatch(/^\[C11\] /);
    }
  });

  test('a refusal lists at most 5 entries, each without its own prefix', () => {
    const actors = Array.from({ length: 8 }, (_, i) => ({ id: `${i}x`, name: 'A' }));
    try {
      loadCatalog(write(JSON.stringify({ actors })));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err.message.match(/\[C1\d\]/g)).toEqual(['[C12]']);
      expect(err.message.split('; ')).toHaveLength(5);
    }
  });

  test('catalogErrors: the cap entry is coded and the list is bounded', () => {
    const actors = Array.from({ length: 30 }, (_, i) => ({ id: `${i}x`, name: 'A' }));
    const errors = catalogErrors({ actors });
    expect(errors.every((e) => e.startsWith('[C12] '))).toBe(true);
    expect(errors).toHaveLength(CATALOG_LIMITS.messages + 1);
    expect(errors.at(-1)).toMatch(/^\[C12\] … and \d+ more$/);
  });

  test('a missing file is a rejection', () => {
    expect(() => loadCatalog(join(dir, 'nope.json'))).toThrow(CatalogRejectedError);
  });
});

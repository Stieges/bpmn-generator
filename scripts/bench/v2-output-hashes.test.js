/**
 * The two format 2.0 golden diagrams (schaden × rollen, schaden × einheiten): each pair equals its
 * golden files byte for byte and its entry in tests/bench/v2-output-hashes.json. See
 * v2-output-hashes.mjs; regenerate with `node bench/v2-output-hashes.mjs` only when the change is intended.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { V2_PAIRS, V2_SNAPSHOT_PATH, FIXTURES_V2_DIR, goldenBase, generateV2, computeV2Hashes } from './v2-output-hashes.mjs';

const CATALOG_HASH = 'sha256:1839c85404873913d420764884aa77ed37f54a3341df18b7e641c0f85f70c9a4';

describe('format 2.0 golden diagrams', () => {
  test('exactly the two pairs of design 9', () => {
    expect(V2_PAIRS).toEqual([['schaden.json', 'rollen'], ['schaden.json', 'einheiten']]);
  });

  test.each(V2_PAIRS)('%s × %s equals its golden files byte for byte', async (name, viewName) => {
    const r = await generateV2(name, viewName);
    const base = join(FIXTURES_V2_DIR, goldenBase(name, viewName));
    expect(r.bpmnXml).toBe(readFileSync(`${base}.expected.bpmn`, 'utf8'));
    expect(r.svg).toBe(readFileSync(`${base}.expected.svg`, 'utf8'));
  }, 60000);

  test.each(V2_PAIRS)('%s × %s: no hints, view, catalogue fingerprint and the information assignment', async (name, viewName) => {
    const r = await generateV2(name, viewName);
    expect(r.validation.hints).toEqual([]);
    expect(r.bpmnXml).toContain(`bg:view="${viewName}"`);
    expect(r.bpmnXml).toContain(`bg:catalog="${CATALOG_HASH}"`);
    expect(r.bpmnXml).toContain('<bg:assignment type="I" actor="sb_schaden" />');
  }, 60000);

  test('every pair hashes to the committed snapshot', async () => {
    const expected = JSON.parse(readFileSync(V2_SNAPSHOT_PATH, 'utf8'));
    expect(await computeV2Hashes()).toEqual(expected);
  }, 60000);
});

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { dmnToDecisionCore } from './import.js';
import { validateDecisionCoreSchema } from './schema-gate.js';

/**
 * Property: `report.lossless === true` implies the imported `dc` passes the Decision-Core schema
 * gate, and the importer never throws. Checked over every single-deletion mutant of the reference
 * file — each attribute removed on its own, each element (with its subtree) removed on its own.
 * A deletion mutant is what "a foreign file that leaves something out" looks like, which is the
 * input the old `lossless: true` + schema-invalid result came from.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures', 'dmn');

const TAG = /<(\/?)([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
const ATTR = /\s[A-Za-z_][\w:.-]*="[^"]*"/g;

/** Deterministic single-deletion mutants of a well-formed XML string. */
function mutants(xml) {
  const out = [];
  const stack = [];
  const elements = [];
  for (const m of xml.matchAll(TAG)) {
    const [whole, closing, , attrs, selfClose] = m;
    const start = m.index;
    if (closing) {
      const open = stack.pop();
      elements.push([open, start + whole.length]);
    } else if (selfClose) {
      elements.push([start, start + whole.length]);
    } else {
      stack.push(start);
    }
    if (!closing) {
      const attrsStart = start + whole.indexOf(attrs);
      for (const a of attrs.matchAll(ATTR)) {
        const s = attrsStart + a.index;
        out.push(xml.slice(0, s) + xml.slice(s + a[0].length));
      }
    }
  }
  for (const [s, e] of elements) out.push(xml.slice(0, s) + xml.slice(e));
  return out;
}

describe('importer property — lossless implies schema-valid', () => {
  for (const file of ['discount-decision.expected.dmn']) {
    test(`${file}: every single-deletion mutant`, async () => {
      // Our own output is never lossless (DMNDI = IM06, generated variable ids = IM05), so the
      // property would be vacuous on it. Strip both and the base IS lossless; each mutant then
      // either stays lossless (and must be schema-valid) or says why it is not.
      const xml = readFileSync(path.join(FIXTURES, file), 'utf8')
        .replace(/<dmndi:DMNDI>[\s\S]*<\/dmndi:DMNDI>/, '')
        .replace(/<dmn:(variable|literalExpression)\b[^>]*>/g, (m) => m.replace(/ id="[^"]*"/, ''));
      const base = await dmnToDecisionCore(xml);
      expect(base.report.lossless).toBe(true);
      const all = mutants(xml);
      expect(all.length).toBeGreaterThan(50);
      const bad = [];
      for (const m of all) {
        let res;
        try {
          res = await dmnToDecisionCore(m);
        } catch (err) {
          bad.push(`threw: ${err.message}`);
          continue;
        }
        if (res.report.lossless) {
          const gate = validateDecisionCoreSchema(res.dc);
          if (!gate.valid) bad.push(`lossless but invalid: ${gate.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
        }
      }
      expect([...new Set(bad)]).toEqual([]);
    }, 20000);
  }

  test('an empty <definitions> is not lossless', async () => {
    const { report } = await dmnToDecisionCore(
      '<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" id="d" name="D" namespace="urn:x"/>');
    expect(report.lossless).toBe(false);
  });
});

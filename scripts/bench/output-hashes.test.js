/**
 * The fence behind "the output with layout.bendRule and layout.nodeLabelsAvoidFlows off does not
 * change unnoticed": the BPMN XML and SVG hashes of every top-level fixture × four modes against a
 * snapshot of that output on current master (see output-hashes.mjs for its history).
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { computeHashes, SNAPSHOT_PATH } from './output-hashes.mjs';

describe('default output, both opt-in layout switches off', () => {
  test('every fixture × mode hashes to the committed snapshot', async () => {
    const expected = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
    const actual = await computeHashes();
    const diffs = [];
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      for (const k of ['xml', 'svg']) {
        if (expected[key]?.[k] !== actual[key]?.[k]) diffs.push(`${key} (${k})`);
      }
    }
    // The message names fixture × mode; the remedy is in the test's own words.
    expect(diffs.length ? `default output changed for: ${diffs.join('; ')}. Inspect the diff like a golden ` +
      '(CLAUDE.md, "React to a golden-file failure"); regenerate with `node bench/output-hashes.mjs` only when the change is intended.' : '')
      .toBe('');
  }, 120000); // ~4 s alone, ~17 s under the full parallel run (92 pipeline runs); 7x headroom for a slow CI runner
});

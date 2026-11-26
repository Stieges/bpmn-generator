/**
 * Slice-0 fixture `nested-lanes-role-system.json`: a flat lane plus a parent lane with two child
 * lanes, activities carrying `role` and `system`. Pins that this 1.x form lays out clean; the
 * layout of nested lanes itself is pinned in nested-lanes-matrix.test.js.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../../tests/fixtures/nested-lanes-role-system.json');

const count = (xml, re) => (xml.match(re) || []).length;

describe('nested lanes with role and system', () => {
  test('slice-0 fixture lays out clean', async () => {
    const lc = JSON.parse(readFileSync(FIXTURE, 'utf8'));
    const r = await runPipeline(lc);
    expect(r.validation.warnings).toEqual([]);
    expect(r.diagnostics.issues).toEqual([]);
    expect(r.validation.xmlWarnings).toEqual([]);
    expect(count(r.bpmnXml, /<bpmn:resource\b/g)).toBe(3);
    expect(count(r.bpmnXml, /<bg:system\b/g)).toBe(2);
  });
});

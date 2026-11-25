/**
 * Slice-0 fixture `nested-lanes-role-system.json`: a flat lane plus a parent lane with two child
 * lanes, activities carrying `role` and `system`. Pins that this 1.x form lays out clean, and
 * characterises the one known broken neighbour (a gateway inside the first of two child lanes).
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

  test('known defect: a gateway inside the first of two child lanes', async () => {
    // Characterisation of today's broken layout. When the layout is fixed, this test must be
    // inverted: the model then lays out clean, with no DI03 issue.
    const lc = {
      id: 'Process_Defekt', name: 'Antrag bearbeiten',
      lanes: [
        { id: 'lane_service', name: 'Kundenservice' },
        { id: 'lane_fach', name: 'Fachabteilung', children: [
          { id: 'lane_pruefung', name: 'Prüfung' }, { id: 'lane_freigabe', name: 'Freigabe' }] },
      ],
      nodes: [
        { id: 's', type: 'startEvent', name: 'Antrag eingegangen', lane: 'lane_service' },
        { id: 't1', type: 'userTask', name: 'Antrag erfassen', lane: 'lane_service' },
        { id: 't2', type: 'userTask', name: 'Antrag prüfen', lane: 'lane_pruefung' },
        { id: 'g', type: 'exclusiveGateway', name: 'Betrag über Grenze?', lane: 'lane_pruefung' },
        { id: 't3', type: 'userTask', name: 'Antrag freigeben', lane: 'lane_freigabe' },
        { id: 't4', type: 'userTask', name: 'Antrag ablehnen', lane: 'lane_freigabe' },
        { id: 'e', type: 'endEvent', name: 'Antrag entschieden', lane: 'lane_freigabe' },
      ],
      edges: [
        { source: 's', target: 't1' }, { source: 't1', target: 't2' }, { source: 't2', target: 'g' },
        { source: 'g', target: 't3', label: 'ja' }, { source: 'g', target: 't4', label: 'nein' },
        { source: 't3', target: 'e' }, { source: 't4', target: 'e' },
      ],
    };
    const r = await runPipeline(lc);
    expect((r.diagnostics?.issues || []).some((i) => i.code === 'DI03' || i.rule === 'DI03')).toBe(true);
  });
});

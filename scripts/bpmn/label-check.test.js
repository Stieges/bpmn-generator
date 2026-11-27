/**
 * H18: a label crossed by a flow, an edge label nearer to a foreign shape than to its own flow, two
 * labels overlapping or too close. label-check.js reads the boxes and routes the DI writes; the
 * geometry functions are tested on synthetic boxes, the pipeline on the six-node review model and on
 * the pinned fixture bpmn-generator-pipeline.json (loop-back fu6 through the label of gw_ok).
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './pipeline.js';
import { generateV2 } from '../bench/v2-output-hashes.mjs';
import {
  findLabelIssues, labelHint, segmentEntersBox, boxGap, boxSegmentDistance, labelGeometry,
  LABEL_CROSS_DEPTH_PX, LABEL_OWN_ROUTE_MAX_PX, LABEL_NEARER_MARGIN_PX, LABEL_MIN_GAP_PX,
} from './label-check.js';

const here = dirname(fileURLToPath(import.meta.url));
const PIPELINE = resolve(here, 'pipeline.js');
const FIXTURES = resolve(here, '..', '..', 'tests', 'fixtures');
const FIXTURES_V2 = resolve(here, '..', '..', 'tests', 'fixtures-v2');

const h18 = (r) => r.validation.hints.filter((h) => h.code === 'H18');
const box = (x, y, w, h) => ({ x, y, w, h });
const P = (x, y) => ({ x, y });

/** The six-node review model: the loop-back f6 runs through the two-line label of gateway g. */
const REVIEW = {
  language: 'en', id: 'Process_F3', name: 'Review',
  nodes: [
    { id: 's', type: 'startEvent', name: 'Request received' },
    { id: 'a', type: 'userTask', name: 'Draft text' },
    { id: 'r', type: 'userTask', name: 'Review draft' },
    { id: 'g', type: 'exclusiveGateway', name: 'Draft accepted by the editor?' },
    { id: 'b', type: 'userTask', name: 'Revise draft' },
    { id: 'e', type: 'endEvent', name: 'Text published' },
  ],
  edges: [
    { id: 'f1', source: 's', target: 'a' }, { id: 'f2', source: 'a', target: 'r' },
    { id: 'f3', source: 'r', target: 'g' },
    { id: 'f4', source: 'g', target: 'e', label: 'yes' },
    { id: 'f5', source: 'g', target: 'b', label: 'no' },
    { id: 'f6', source: 'b', target: 'a' },
  ],
};

describe('thresholds', () => {
  test('are the documented values', () => {
    expect(LABEL_CROSS_DEPTH_PX).toBe(2);
    expect(LABEL_OWN_ROUTE_MAX_PX).toBe(6);
    expect(LABEL_NEARER_MARGIN_PX).toBe(10);
    expect(LABEL_MIN_GAP_PX).toBe(2);
  });
});

describe('geometry', () => {
  const b = box(100, 100, 60, 20);

  test('segmentEntersBox: a crossing at least the depth inside counts; grazing, touching and outside do not', () => {
    expect(segmentEntersBox(P(50, 110), P(200, 110), b)).toBe(true);
    expect(segmentEntersBox(P(50, 102.5), P(200, 102.5), b)).toBe(true);
    expect(segmentEntersBox(P(50, 102), P(200, 102), b)).toBe(false);   // exactly the depth: on the shrunk outline
    expect(segmentEntersBox(P(50, 101), P(200, 101), b)).toBe(false);   // 1 px in
    expect(segmentEntersBox(P(50, 100), P(200, 100), b)).toBe(false);   // along the outline
    expect(segmentEntersBox(P(50, 90), P(200, 90), b)).toBe(false);
    expect(segmentEntersBox(P(130, 50), P(130, 105), b)).toBe(true);    // ends 5 px inside
    expect(segmentEntersBox(P(130, 50), P(130, 101.5), b)).toBe(false); // ends 1.5 px inside
    expect(segmentEntersBox(P(90, 90), P(170, 130), b)).toBe(true);     // diagonal through the middle
    expect(segmentEntersBox(P(150, 90), P(170, 101), b)).toBe(false);   // diagonal past the corner
    expect(segmentEntersBox(P(50, 101), P(200, 101), b, 0)).toBe(true); // depth 0: strictly inside
  });

  test('boxGap: the gap between boxes, 0 when touching, negative when overlapping', () => {
    expect(boxGap(b, box(165, 100, 10, 10))).toBe(5);
    expect(boxGap(b, box(160, 100, 10, 10))).toBe(0);
    expect(boxGap(b, box(155, 110, 10, 20))).toBe(-5);
    expect(boxGap(b, box(163, 124, 10, 10))).toBe(5);  // diagonal: 3 and 4 px
  });

  test('boxSegmentDistance: 0 through or touching, else the shortest distance', () => {
    expect(boxSegmentDistance(b, P(50, 110), P(200, 110))).toBe(0);
    expect(boxSegmentDistance(b, P(50, 130), P(200, 130))).toBe(10);
    expect(boxSegmentDistance(b, P(170, 50), P(170, 200))).toBe(10);
    expect(boxSegmentDistance(b, P(163, 124), P(200, 124))).toBe(5);
  });
});

describe('findLabelIssues on synthetic geometry', () => {
  const gate = { id: 'g', owner: 'g', ownerKind: 'gateway', box: box(100, 160, 80, 27) };
  const flow = (id, route, source = 'x', target = 'y') => ({ id, kind: 'sequence flow', source, target, route });

  test('(a) a flow through a node label, its own source included; its own label is not counted', () => {
    const issues = findLabelIssues({
      labels: [gate, { id: 'f1', owner: 'f1', ownerKind: 'sequence flow', box: box(200, 170, 20, 14) }],
      flows: [flow('f1', [P(0, 175), P(300, 175)]), flow('f2', [P(140, 150), P(140, 300)], 'g', 'z')],
    });
    expect(issues.map((i) => [i.case, i.flow.id, i.label.owner])).toEqual([
      ['cross', 'f1', 'g'], ['cross', 'f2', 'g'],
    ]);
  });

  test('(a) a flow through another flow\'s label', () => {
    const issues = findLabelIssues({
      labels: [{ id: 'f1', owner: 'f1', ownerKind: 'sequence flow', box: box(200, 170, 20, 14) }],
      flows: [flow('f1', [P(0, 190), P(300, 190)]), flow('f2', [P(210, 100), P(210, 300)])],
    });
    expect(issues.map((i) => [i.case, i.flow.id, i.label.owner])).toEqual([['cross', 'f2', 'f1']]);
  });

  test('(b) an edge label far from its route and clearly nearer to a foreign shape; not to its source or target', () => {
    const L = { id: 'f1', owner: 'f1', ownerKind: 'sequence flow', box: box(100, 60, 20, 14) };
    const route = [P(0, 100), P(300, 100)];                  // 26 px below the label
    const near = { id: 't', box: box(100, 0, 100, 50) };      // 10 px above it
    expect(findLabelIssues({ labels: [L], flows: [flow('f1', route)], shapes: [near] }).map((i) => [i.case, i.shape.id, i.own, i.distance]))
      .toEqual([['nearer', 't', 26, 10]]);
    // the same shape as the flow's source: nothing
    expect(findLabelIssues({ labels: [L], flows: [flow('f1', route, 't')], shapes: [near] })).toEqual([]);
    // beside its own route (6 px): nothing, however near the shape
    const close = { ...L, box: box(100, 80, 20, 14) };
    expect(findLabelIssues({ labels: [close], flows: [flow('f1', route)], shapes: [{ id: 't', box: box(100, 60, 100, 18) }] })).toEqual([]);
    // nearer, but not by more than the margin: 26 px own, 16 px to the shape
    expect(findLabelIssues({ labels: [L], flows: [flow('f1', route)], shapes: [{ id: 't', box: box(100, 0, 100, 44) }] })).toEqual([]);
  });

  test('(c) overlapping and too close labels, each pair once; 2 px apart is fine', () => {
    const a = { id: 'a', owner: 'a', ownerKind: 'event', box: box(0, 0, 50, 14) };
    const b = { id: 'b', owner: 'b', ownerKind: 'gateway', box: box(40, 5, 50, 14) };
    const c = { id: 'c', owner: 'c', ownerKind: 'event', box: box(91, 5, 50, 14) };
    const d = { id: 'd', owner: 'd', ownerKind: 'event', box: box(0, 16, 50, 14) };
    const issues = findLabelIssues({ labels: [a, b, c, d] });
    expect(issues.map((i) => [i.case, i.label.owner, i.other.owner, i.gap])).toEqual([
      ['crowded', 'a', 'b', -9], ['crowded', 'b', 'c', 1], ['crowded', 'b', 'd', -3],
    ]);
  });

  test('the hint names the case and both elements', () => {
    const L = { id: 'f1', owner: 'f1', ownerKind: 'sequence flow', box: box(100, 60, 20, 14) };
    const [nearer] = findLabelIssues({ labels: [L], flows: [flow('f1', [P(0, 100), P(300, 100)])], shapes: [{ id: 't', box: box(100, 0, 100, 50) }] });
    expect(labelHint(nearer)).toEqual({
      code: 'H18',
      message: 'The label of the sequence flow "f1" sits nearer to "t" (10 px) than to its own flow (26 px), so it reads as belonging to "t". Move the label next to its flow in a modeler.',
      elements: ['f1', 't'],
    });
    const a = { id: 'a', owner: 'a', ownerKind: 'event', box: box(0, 0, 50, 14) };
    const [over] = findLabelIssues({ labels: [a, { id: 'b', owner: 'b', ownerKind: 'gateway', box: box(40, 5, 50, 14) }] });
    expect(labelHint(over)).toEqual({
      code: 'H18',
      message: 'The label of the event "a" overlaps the label of the gateway "b". Move one of the labels in a modeler, or shorten a name.',
      elements: ['a', 'b'],
    });
    const [close] = findLabelIssues({ labels: [a, { id: 'm', owner: 'm', ownerKind: 'message flow', box: box(51.5, 0, 50, 14) }] });
    expect(labelHint(close).message).toBe('The label of the event "a" is too close to (1.5 px from) the label of the message flow "m". Move one of the labels in a modeler, or shorten a name.');
  });

  test('tidy geometry gives nothing', () => {
    expect(findLabelIssues({
      labels: [gate, { id: 'f1', owner: 'f1', ownerKind: 'sequence flow', box: box(200, 160, 20, 14) }],
      flows: [flow('f1', [P(190, 178), P(300, 178)]), flow('f2', [P(0, 140), P(300, 140)])],
      shapes: [{ id: 't', box: box(300, 150, 100, 80) }],
    })).toEqual([]);
  });
});

describe('H18 from runPipeline: the six-node review model', () => {
  let r;
  beforeAll(async () => { r = await runPipeline(structuredClone(REVIEW)); }, 30_000);

  test('f6 crosses the label of g, and nothing else is reported', () => {
    expect(h18(r)).toEqual([{
      code: 'H18',
      message: 'The sequence flow "f6" crosses the label of the gateway "g": the line runs through the text. Move the label or the flow in a modeler, or shorten the name.',
      elements: ['f6', 'g'],
    }]);
  });

  test('the boxes and routes checked are the ones the DI writes', () => {
    const { labels, flows } = labelGeometry(structuredClone(REVIEW), r.coordMap);
    for (const L of labels) {
      const shape = r.bpmnXml.match(new RegExp(`bpmnElement="${L.owner}"[^>]*>[\\s\\S]*?<bpmndi:BPMNLabel>\\s*<dc:Bounds x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`));
      expect(shape.slice(1).map(Number)).toEqual([L.box.x, L.box.y, L.box.w, L.box.h]);
    }
    expect(labels.map((L) => L.owner)).toEqual(['s', 'g', 'e', 'f4', 'f5']);
    const g = labels.find((L) => L.owner === 'g').box;
    expect([g.y, g.y + g.h]).toEqual([170.5, 197.5]);
    expect(flows.find((f) => f.id === 'f6').route).toEqual([P(698, 186), P(228, 186)]);
  });

  test('CLI --strict passes, prints the hint and writes the files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h18-'));
    try {
      const input = join(dir, 'review.json');
      writeFileSync(input, JSON.stringify(REVIEW));
      const out = join(dir, 'review');
      const res = spawnSync(process.execPath, [PIPELINE, input, out, '--strict'], { encoding: 'utf8' });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('ℹ [H18] The sequence flow "f6" crosses the label of the gateway "g"');
      expect(existsSync(`${out}.bpmn`) && existsSync(`${out}.svg`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a one-line gateway name gives a label the loop-back misses: no hint', async () => {
    const m = structuredClone(REVIEW);
    m.nodes.find((n) => n.id === 'g').name = 'Accepted?';
    expect(h18(await runPipeline(m))).toEqual([]);
  }, 30_000);
});

describe('H18 on the fixtures', () => {
  const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));

  test('bpmn-generator-pipeline.json: the loop-back fu6 crosses the label of gw_ok; five findings, all crossings, last in hints', async () => {
    const r = await runPipeline(fixture('bpmn-generator-pipeline.json'));
    expect(h18(r).map((h) => h.elements)).toEqual([
      ['fu6', 'gw_ok'], ['fo8', 'gw_maxiter'], ['fo9', 'gw_maxiter'], ['fo10', 'fo9'], ['mf3', 'fo3'],
    ]);
    expect(h18(r)[0].message).toBe('The sequence flow "fu6" crosses the label of the gateway "gw_ok": the line runs through the text. Move the label or the flow in a modeler, or shorten the name.');
    expect(h18(r)[4].message).toBe('The message flow "mf3" crosses the label of the sequence flow "fo3": the line runs through the text. Move the label or the flow in a modeler, or shorten the name.');
    const codes = r.validation.hints.map((h) => h.code);
    expect(codes.slice(codes.indexOf('H18'))).toEqual(['H18', 'H18', 'H18', 'H18', 'H18']);
  }, 30_000);

  test('the format 2.0 goldens: in schaden × einheiten the "ja" flow runs through the label "nein"; the others get none', async () => {
    expect(h18(await generateV2('schaden.json', 'einheiten'))).toEqual([{
      code: 'H18',
      message: 'The sequence flow "flow_gw_regr" crosses the label of the sequence flow "flow_gw_zahlen": the line runs through the text. Move the label or the flow in a modeler, or shorten the name.',
      elements: ['flow_gw_regr', 'flow_gw_zahlen'],
    }]);
    expect(h18(await generateV2('schaden.json', 'rollen'))).toEqual([]);
    expect(h18(await generateV2('organigramm.json', 'organigramm'))).toEqual([]);
  }, 60_000);

  test('simple-approval.json, a tidy diagram, gets none', async () => {
    expect(h18(await runPipeline(fixture('simple-approval.json')))).toEqual([]);
  }, 30_000);
});

describe('the hints H15 to H18 together', () => {
  // schaden.json in a pool, three black-box partners with one message flow each (no participant order
  // avoids a DI05), a receive task nobody sends to, and a word longer than a line.
  const combo = () => {
    const base = JSON.parse(readFileSync(join(FIXTURES_V2, 'schaden.json'), 'utf8'));
    const nodes = structuredClone(base.nodes);
    nodes.find((n) => n.id === 'zahlen').name = 'Zahlungsfreigabeanweisungsbearbeitungsvorgang anweisen';
    nodes.splice(nodes.length - 1, 0, {
      id: 'rt', type: 'receiveTask', name: 'Bestätigung empfangen', assignments: [{ type: 'D', actor: 'zahlung' }],
    });
    const edges = base.edges.filter((e) => !(e.source === 'zahlen' && e.target === 'end'));
    edges.push({ source: 'zahlen', target: 'rt' }, { id: 'f_rt', source: 'rt', target: 'end' });
    return {
      $schemaVersion: '2.0', catalog: 'schaden-catalog.json',
      pools: [{ id: base.id, name: base.name, nodes, edges }],
      collapsedPools: [{ id: 'P_A', name: 'Kunde' }, { id: 'P_B', name: 'Werkstatt' }, { id: 'P_C', name: 'Bank' }],
      messageFlows: [
        { id: 'm1', source: 'pruefen', target: 'P_A' }, { id: 'm2', source: 'regr', target: 'P_B' },
        { id: 'm3', source: 'zahlen', target: 'P_C' },
      ],
    };
  };
  const catalog = () => JSON.parse(readFileSync(join(FIXTURES_V2, 'schaden-catalog.json'), 'utf8'));

  test('they come in the order H15, H16, H17, H18 in validation.hints', async () => {
    const r = await runPipeline(combo(), { catalog: catalog(), view: resolve(here, '../../views/einheiten-view.json') });
    expect(r.validation.errors).toEqual([]);
    expect(r.validation.hints.map((h) => h.code).filter((c) => /^H1[5-8]$/.test(c))).toEqual(['H15', 'H16', 'H17', 'H18']);
  }, 60_000);

  test('CLI --strict exits 0 and writes the files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'h15-18-'));
    try {
      writeFileSync(join(dir, 'combo.json'), JSON.stringify(combo()));
      writeFileSync(join(dir, 'schaden-catalog.json'), JSON.stringify(catalog()));
      const out = join(dir, 'combo');
      const res = spawnSync(process.execPath, [PIPELINE, join(dir, 'combo.json'), out, '--strict', '--view=einheiten'], { encoding: 'utf8' });
      expect(res.status).toBe(0);
      for (const code of ['H15', 'H16', 'H17', 'H18']) expect(res.stdout).toContain(`[${code}]`);
      expect(existsSync(`${out}.bpmn`) && existsSync(`${out}.svg`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

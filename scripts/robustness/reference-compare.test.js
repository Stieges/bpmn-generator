/**
 * compareToReference: how close an extracted Logic-Core is to a reference model of the same
 * process — the measure the schema gate, the rules and compliance cannot give, because each of them
 * judges whether a model holds together, not whether it is the process that was described.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareToReference, nameSimilarity } from './reference-compare.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const load = (f) => JSON.parse(readFileSync(join(fixtures, f), 'utf8'));
const kinds = (r) => [...new Set(r.findings.map((f) => f.kind))].sort();

describe('nameSimilarity', () => {
  test('compounds, inflection and umlaut spelling still match', () => {
    expect(nameSimilarity('Urlaubsantrag stellen', 'Antrag stellen')).toBeGreaterThanOrEqual(0.6);
    expect(nameSimilarity('Antrag prüfen', 'Antrag pruefen')).toBe(1);
    expect(nameSimilarity('Rechnung prüfen', 'Prüft die Rechnung')).toBeGreaterThanOrEqual(0.6);
  });
  test('different steps do not', () => {
    expect(nameSimilarity('Urlaubskonto buchen', 'Mitarbeiter informieren')).toBeLessThan(0.6);
    expect(nameSimilarity('Rechnung prüfen', 'Antrag prüfen')).toBeLessThan(0.6);
  });
});

describe('compareToReference', () => {
  test.each(['example-urlaubsantrag.json', 'example-kreditantrag.json', 'example-schadenmeldung.json', 'example-rechnungspruefung.json'])(
    '%s against itself: full recall and precision, no finding', (f) => {
      const lc = load(f);
      const r = compareToReference(lc, lc);
      expect(r.metrics.activities.recall).toBe(1);
      expect(r.metrics.activities.precision).toBe(1);
      expect(r.findings).toEqual([]);
    });

  // The run from the smoke test: the manager's review and its timer moved into a collapsed
  // subprocess (the manager's lane is empty at the top level), and "submit again" after "revise".
  const weakerLeaveRequest = () => {
    const lc = load('example-urlaubsantrag.json');
    const p = lc.pools[0];
    const inner = new Set(['u_pruefen', 'u_timer', 'u_eskal', 'u_end3']);
    const moved = p.nodes.filter((n) => inner.has(n.id)).map(({ lane, ...n }) => n);
    p.nodes = p.nodes.filter((n) => !inner.has(n.id));
    const innerEdges = p.edges.filter((e) => inner.has(e.source) && inner.has(e.target));
    p.edges = p.edges.filter((e) => !(inner.has(e.source) && inner.has(e.target)))
      .map((e) => ({ ...e, source: inner.has(e.source) ? 'u_sub' : e.source, target: inner.has(e.target) ? 'u_sub' : e.target }));
    p.nodes.push({ id: 'u_sub', type: 'subProcess', name: 'Antrag abstimmen', lane: 'ma', isExpanded: false,
      nodes: [{ id: 'u_sub_s', type: 'startEvent' }, ...moved, { id: 'u_sub_e', type: 'endEvent' }], edges: innerEdges });
    p.nodes.find((n) => n.id === 'u_gw').lane = 'ma';            // the decision drawn with the employee
    p.nodes.push({ id: 'u_again', type: 'userTask', name: 'Urlaubsantrag erneut stellen', lane: 'ma' });
    const back = p.edges.find((e) => e.source === 'u_aendern');
    p.edges.push({ id: 'f_again', source: 'u_again', target: back.target });
    back.target = 'u_again';
    return lc;
  };

  test('the weaker leave request: empty lane, nested step and duplicate step are named', () => {
    const r = compareToReference(weakerLeaveRequest(), load('example-urlaubsantrag.json'));
    expect(kinds(r)).toEqual(expect.arrayContaining(['duplicate-step', 'empty-lane', 'nested-activity']));
    expect(r.findings.find((f) => f.kind === 'empty-lane').message).toContain('Vorgesetzter');
    expect(r.findings.find((f) => f.kind === 'nested-activity').message).toContain('Antrag prüfen');
    expect(r.findings.find((f) => f.kind === 'duplicate-step').message).toContain('Urlaubsantrag erneut stellen');
    expect(r.metrics.activities.recall).toBe(1);
    expect(r.metrics.activities.precision).toBeLessThan(1);
  });

  test('an external partner modelled as an expanded pool instead of a black box', () => {
    const ref = load('example-kreditantrag.json');
    const cand = JSON.parse(JSON.stringify(ref));
    const bb = cand.collapsedPools.shift();
    cand.pools.push({ id: bb.id, name: bb.name, nodes: [{ id: 'k_s', type: 'startEvent' }, { id: 'k_e', type: 'endEvent' }],
      edges: [{ id: 'k_f', source: 'k_s', target: 'k_e' }] });
    const r = compareToReference(cand, ref);
    expect(r.findings).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'participant-kind' })]));
  });

  test('a missing lane and a missing step', () => {
    const ref = load('example-urlaubsantrag.json');
    const cand = JSON.parse(JSON.stringify(ref));
    const p = cand.pools[0];
    p.lanes = p.lanes.filter((l) => l.name !== 'Personalabteilung');
    p.nodes = p.nodes.filter((n) => n.lane !== 'hr').map((n) => n);
    const keep = new Set(p.nodes.map((n) => n.id));
    p.edges = p.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
    const r = compareToReference(cand, ref);
    expect(kinds(r)).toEqual(expect.arrayContaining(['missing-activity', 'missing-lane']));
    expect(r.metrics.activities.recall).toBeLessThan(1);
  });

  test('without a reference, only the checks that need none run', () => {
    const r = compareToReference(load('example-urlaubsantrag.json'), null);
    expect(r.metrics.activities.recall).toBeNull();
    expect(r.findings).toEqual([]);
  });
});

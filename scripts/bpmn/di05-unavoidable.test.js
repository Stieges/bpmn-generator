/**
 * An unavoidable DI05 (a message flow crossing an uninvolved participant in every order of the
 * stacked participants) is still reported, gains a clause, is named by hint H15 and does not fail
 * --strict. Format 2.x only; a 1.x model's responses stay as they were.
 */

import { describe, test, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPipeline } from './pipeline.js';
import {
  checkDiagramIntegrity, classifyUnavoidableDi05, minimumCrossings, formatDiWarnings,
  UNAVOIDABLE_DI05_MAX_PARTICIPANTS, UNAVOIDABLE_DI05_CLAUSE,
} from './di-check.js';

const here = dirname(fileURLToPath(import.meta.url));
const V2 = resolve(here, '../../tests/fixtures-v2');
const V1 = resolve(here, '../../tests/fixtures');
const PIPELINE = resolve(here, 'pipeline.js');
const hub = () => JSON.parse(readFileSync(join(V2, 'message-hub.json'), 'utf8'));
const hubCatalog = () => JSON.parse(readFileSync(join(V2, 'message-hub-catalog.json'), 'utf8'));

const H15 = 'No order of the participants avoids every crossing: stacked in one column a participant has at most two neighbours, and "Pool_Desk" exchanges messages with 3 participants. DI05 on "m4" is reported but does not fail --strict. Accept the crossing, or reduce the message partners (for example, merge black-box participants that play the same part).';
const DI05_M4 = 'Message flow "m4" crosses 1 uninvolved participant(s): P_Supplier. No order of the participants avoids every crossing.';

// message-hub with ten more black-box partners of Pool_Desk: 14 participants, 11 DI05 in the best order.
function bigHub() {
  const lc = hub();
  const senders = ['a', 'b', 'e'];
  for (let i = 1; i <= 10; i++) {
    lc.collapsedPools.push({ id: `P_Partner${i}`, name: `Partner ${i}` });
    lc.messageFlows.push({ id: `mx${i}`, source: senders[i % 3], target: `P_Partner${i}` });
  }
  return lc;
}

// Every order, the brute-force answer minimumCrossings must give.
function bruteForce(n, weight) {
  let best = Infinity;
  const order = [...Array(n).keys()];
  const visit = (k) => {
    if (k === n) {
      const pos = [];
      order.forEach((p, i) => { pos[p] = i; });
      let c = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) c += weight[i][j] * (Math.abs(pos[i] - pos[j]) - 1);
      best = Math.min(best, c);
      return;
    }
    for (let i = k; i < n; i++) {
      [order[k], order[i]] = [order[i], order[k]];
      visit(k + 1);
      [order[k], order[i]] = [order[i], order[k]];
    }
  };
  visit(0);
  return best;
}

function randomWeights(n, rnd) {
  const w = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const r = rnd();
    const k = r < 0.55 ? 0 : r < 0.9 ? 1 : 2;
    w[i][j] = w[j][i] = k;
  }
  return w;
}

// A black-box column: participants `order` stacked top to bottom at full width, one vertical
// message flow per pair, from the middle of one band to the middle of the other.
function column(order, pairs, { widths } = {}) {
  const poolCoords = {};
  order.forEach((id, i) => { poolCoords[id] = { x: 0, y: i * 100, w: widths?.[id] ?? 800, h: 60 }; });
  const messageFlows = pairs.map(([s, t], i) => ({ id: `f${i + 1}`, source: s, target: t }));
  const edgeCoords = {};
  for (const mf of messageFlows) {
    const a = poolCoords[mf.source], b = poolCoords[mf.target];
    edgeCoords[mf.id] = [{ x: 400, y: a.y + 30 }, { x: 400, y: b.y + 30 }];
  }
  const lc = { pools: [], collapsedPools: order.map((id) => ({ id, name: id })), messageFlows };
  const coordMap = { coords: {}, poolCoords, laneCoords: {}, edgeCoords };
  return { lc, coordMap, issues: checkDiagramIntegrity(coordMap, lc).issues };
}

describe('minimumCrossings', () => {
  test('matches the brute force over every order, 3 to 7 participants', () => {
    let seed = 20261127;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let n = 3; n <= 7; n++) {
      for (let k = 0; k < 40; k++) {
        const w = randomWeights(n, rnd);
        expect([n, k, minimumCrossings(n, w)]).toEqual([n, k, bruteForce(n, w)]);
      }
    }
  });

  test('every pair linked: C(n, 3) crossings in every order', () => {
    const complete = (n) => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : 1)));
    expect(minimumCrossings(4, complete(4))).toBe(4);
    expect(minimumCrossings(8, complete(8))).toBe(56);
  });

  test('the search is bounded at 16 participants, and the worst case there stays well under a second', () => {
    expect(UNAVOIDABLE_DI05_MAX_PARTICIPANTS).toBe(16);
    const n = UNAVOIDABLE_DI05_MAX_PARTICIPANTS;
    const w = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 0 : 3)));
    const t0 = performance.now();
    expect(minimumCrossings(n, w)).toBe(3 * 560);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('classifyUnavoidableDi05', () => {
  test('a participant with three partners: the crossing the best order leaves is marked', () => {
    const { lc, coordMap, issues } = column(['B', 'A', 'C', 'D'], [['A', 'B'], ['A', 'C'], ['A', 'D']]);
    expect(issues.map((i) => i.elements)).toEqual([['f3', 'C']]);
    const before = issues[0].message;
    expect(classifyUnavoidableDi05(coordMap, lc, issues)).toEqual({ flows: ['f3'], hubs: [{ id: 'A', partners: 3 }], cycle: null });
    expect(issues[0].message).toBe(before + UNAVOIDABLE_DI05_CLAUSE);
    expect(UNAVOIDABLE_DI05_CLAUSE).toBe(' No order of the participants avoids every crossing.');
  });

  test('a cycle of three partners is unavoidable too, and the hint names the cycle', () => {
    const { lc, coordMap, issues } = column(['A', 'B', 'C'], [['A', 'B'], ['B', 'C'], ['C', 'A']]);
    expect(classifyUnavoidableDi05(coordMap, lc, issues)).toEqual({ flows: ['f3'], hubs: [], cycle: ['A', 'B', 'C'] });
  });

  test('a chain of partners fits a column: a crossing there is not marked', () => {
    const { lc, coordMap, issues } = column(['A', 'C', 'B', 'D'], [['A', 'B'], ['B', 'C'], ['C', 'D']]);
    expect(issues.length).toBeGreaterThan(0);
    const before = issues.map((i) => i.message);
    expect(classifyUnavoidableDi05(coordMap, lc, issues)).toBeNull();
    expect(issues.map((i) => i.message)).toEqual(before);
  });

  test('an order with more crossings than the best one: every DI05 is marked, no order avoids them all', () => {
    const { lc, coordMap, issues } = column(['A', 'B', 'C', 'D'], [['A', 'B'], ['A', 'C'], ['A', 'D']]);
    expect(issues.map((i) => i.elements)).toEqual([['f2', 'B'], ['f3', 'B', 'C']]);
    expect(classifyUnavoidableDi05(coordMap, lc, issues)).toEqual({ flows: ['f2', 'f3'], hubs: [{ id: 'A', partners: 3 }], cycle: null });
    expect(issues.every((i) => i.message.endsWith(UNAVOIDABLE_DI05_CLAUSE))).toBe(true);
  });

  test('a flow from a node inside a subprocess: DI05 gives it no participant, so neither does the search', () => {
    const order = ['B', 'A', 'C', 'D'];
    const poolCoords = {};
    order.forEach((id, i) => { poolCoords[id] = { x: 0, y: i * 100, w: 800, h: 60 }; });
    const lc = {
      pools: [{ id: 'A', nodes: [{ id: 'sp', type: 'subProcess', nodes: [{ id: 'inner', type: 'task' }] }], edges: [] }],
      collapsedPools: ['B', 'C', 'D'].map((id) => ({ id, name: id })),
      messageFlows: [{ id: 'f1', source: 'inner', target: 'B' }, { id: 'f2', source: 'A', target: 'C' }, { id: 'f3', source: 'A', target: 'D' }],
    };
    const mid = (id) => poolCoords[id].y + 30;
    const edgeCoords = { f1: [{ x: 400, y: mid('A') }, { x: 400, y: mid('B') }], f2: [{ x: 400, y: mid('A') }, { x: 400, y: mid('C') }], f3: [{ x: 400, y: mid('A') }, { x: 400, y: mid('D') }] };
    const coordMap = { coords: {}, poolCoords, laneCoords: {}, edgeCoords };
    const { issues } = checkDiagramIntegrity(coordMap, lc);
    expect(issues.filter((i) => i.code === 'DI05').map((i) => i.elements)).toEqual([['f3', 'C']]);
    expect(classifyUnavoidableDi05(coordMap, lc, issues)).toBeNull();
    // The same flow from the participant itself is mapped, and the crossing is marked.
    lc.messageFlows[0].source = 'A';
    expect(classifyUnavoidableDi05(coordMap, lc, issues)?.flows).toEqual(['f3']);
  });

  test('participants that are not one full-width column: not marked', () => {
    const { lc, coordMap, issues } = column(['B', 'A', 'C', 'D'], [['A', 'B'], ['A', 'C'], ['A', 'D']], { widths: { D: 300 } });
    expect(issues.length).toBe(1);
    expect(classifyUnavoidableDi05(coordMap, lc, issues)).toBeNull();
  });

  test('a DI05 the order does not explain: not marked', () => {
    const { lc, coordMap, issues } = column(['B', 'A', 'C', 'D'], [['A', 'B'], ['A', 'C'], ['A', 'D']]);
    issues.push({ code: 'DI05', severity: 'WARNING', message: 'x', elements: ['f1', 'D'] });
    expect(classifyUnavoidableDi05(coordMap, lc, issues)).toBeNull();
  });

  test('an unrouted flow is left out, as DI05 leaves it out: without A–B the chain C, A, D fits, nothing is marked', () => {
    const { lc, coordMap, issues } = column(['B', 'A', 'C', 'D'], [['A', 'B'], ['A', 'C'], ['A', 'D']]);
    delete coordMap.edgeCoords.f1;
    expect(classifyUnavoidableDi05(coordMap, lc, issues)).toBeNull();
  });

  test('above the bound the answer is unknown: not marked', () => {
    const ids = Array.from({ length: UNAVOIDABLE_DI05_MAX_PARTICIPANTS + 1 }, (_, i) => `P${String(i).padStart(2, '0')}`);
    // P01 talks to P00, P02 and P03: one crossing in the best order, as with four participants.
    const { lc, coordMap, issues } = column(ids, [['P01', 'P00'], ['P01', 'P02'], ['P01', 'P03']]);
    expect(issues.map((i) => i.elements)).toEqual([['f3', 'P02']]);
    expect(classifyUnavoidableDi05(coordMap, lc, issues)).toBeNull();
    const smaller = column(ids.slice(0, UNAVOIDABLE_DI05_MAX_PARTICIPANTS), [['P01', 'P00'], ['P01', 'P02'], ['P01', 'P03']]);
    expect(classifyUnavoidableDi05(smaller.coordMap, smaller.lc, smaller.issues)?.flows).toEqual(['f3']);
  });
});

describe('formatDiWarnings with more DI05 than the group threshold', () => {
  const di05 = (flow, marked) => ({ code: 'DI05', severity: 'WARNING', message: `Message flow "${flow}" crosses 1 uninvolved participant(s): C.${marked ? UNAVOIDABLE_DI05_CLAUSE : ''}`, elements: [flow, 'C'] });
  const lc = { pools: [], collapsedPools: [{ id: 'A' }], messageFlows: [1, 2, 3].map((k) => ({ id: `f${k}`, source: 'A', target: 'B' })) };
  const head = (issues) => formatDiWarnings(issues, lc, { groupThreshold: 2 })[0];

  test('none marked: the grouped line is as before', () => {
    expect(head([di05('f1'), di05('f2'), di05('f3')])).toBe('DI05 3 message flows cross uninvolved participants — by source participant:');
  });

  test('all marked: the grouped line says no order avoids them', () => {
    expect(head([di05('f1', true), di05('f2', true), di05('f3', true)]))
      .toBe('DI05 3 message flows cross uninvolved participants (no order of the participants avoids them; see H15) — by source participant:');
  });

  test('some marked: the grouped line says how many', () => {
    expect(head([di05('f1', true), di05('f2'), di05('f3', true)]))
      .toBe('DI05 3 message flows cross uninvolved participants (no order of the participants avoids 2 of them; see H15) — by source participant:');
  });
});

describe('runPipeline and the CLI', () => {
  test('message-hub (format 2.0, view rollen): DI05 with the clause, H15 last in hints', async () => {
    const r = await runPipeline(hub(), { catalog: hubCatalog(), view: resolve(here, '../../views/rollen-view.json') });
    expect(r.bpmnXml).toBeTruthy();
    expect(r.diagnostics.issues.filter((i) => i.code === 'DI05'))
      .toEqual([{ code: 'DI05', severity: 'WARNING', message: DI05_M4, elements: ['m4', 'P_Supplier'] }]);
    expect(r.validation.hints.at(-1)).toEqual({ code: 'H15', message: H15, elements: ['m4'] });
    expect(r.validation.hints.filter((h) => h.code === 'H15')).toHaveLength(1);
  });

  test('a format 1.x model keeps its DI05 text and gets no H15', async () => {
    const lc = JSON.parse(readFileSync(join(V1, 'realistic-collaboration.json'), 'utf8'));
    const r = await runPipeline(lc);
    const di05 = r.diagnostics.issues.filter((i) => i.code === 'DI05');
    expect(di05).toHaveLength(1);
    expect(di05[0].message).not.toContain(UNAVOIDABLE_DI05_CLAUSE.trim());
    expect(r.validation.hints).toEqual([]);
  });

  test('CLI --strict --view=rollen writes the files; the DI05 is reported, H15 printed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'di05-hub-'));
    try {
      const out = join(dir, 'hub');
      const res = spawnSync(process.execPath, [PIPELINE, join(V2, 'message-hub.json'), out, '--strict', '--view=rollen'], { encoding: 'utf8' });
      expect(res.status).toBe(0);
      expect(res.stdout).toContain(`ℹ [H15] ${H15}\n`);
      expect(res.stderr).toContain(`  · DI05 ${DI05_M4}\n`);
      expect(res.stderr).not.toContain('--strict');
      expect(existsSync(`${out}.bpmn`) && existsSync(`${out}.svg`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('CLI --strict with poolOrder declared: no order avoids every crossing, so all 3 DI05 are marked and the files are written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'di05-hub-'));
    try {
      const view = join(dir, 'declared-view.json');
      writeFileSync(view, JSON.stringify({ view: 'declared', version: '1.0', lanes: 'role', layout: { poolOrder: 'declared' } }));
      const out = join(dir, 'hub');
      const res = spawnSync(process.execPath, [PIPELINE, join(V2, 'message-hub.json'), out, '--strict', `--view=${view}`], { encoding: 'utf8' });
      expect(res.stdout).toContain('DI05 on "m2", "m3", "m4" is reported but does not fail --strict.');
      for (const line of [
        'DI05 Message flow "m2" crosses 1 uninvolved participant(s): P_Customer. No order of the participants avoids every crossing.',
        'DI05 Message flow "m3" crosses 1 uninvolved participant(s): P_Customer. No order of the participants avoids every crossing.',
        'DI05 Message flow "m4" crosses 2 uninvolved participant(s): P_Customer, P_Supplier. No order of the participants avoids every crossing.',
      ]) expect(res.stderr).toContain(`  · ${line}\n`);
      expect(res.stderr).not.toContain('--strict');
      expect(res.status).toBe(0);
      expect(existsSync(`${out}.bpmn`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('H15 names at most 10 flows, elements all of them; the grouped CLI line keeps the reason', async () => {
    const r = await runPipeline(bigHub(), { catalog: hubCatalog(), view: resolve(here, '../../views/rollen-view.json') });
    const di05 = r.diagnostics.issues.filter((i) => i.code === 'DI05');
    expect(di05).toHaveLength(11);
    const h15 = r.validation.hints.at(-1);
    expect(h15.code).toBe('H15');
    expect(h15.elements).toEqual(di05.map((i) => i.elements[0]));
    expect(h15.message).toContain(`DI05 on ${h15.elements.slice(0, 10).map((id) => `"${id}"`).join(', ')} and 1 more is reported`);

    const dir = mkdtempSync(join(tmpdir(), 'di05-hub-'));
    try {
      const input = join(dir, 'big-hub.json');
      writeFileSync(input, JSON.stringify({ ...bigHub(), catalog: join(V2, 'message-hub-catalog.json') }));
      const out = join(dir, 'big-hub');
      const res = spawnSync(process.execPath, [PIPELINE, input, out, '--strict', '--view=rollen'], { encoding: 'utf8' });
      expect(res.stderr).toContain('  · DI05 11 message flows cross uninvolved participants (no order of the participants avoids them; see H15) — by source participant:\n');
      expect(res.status).toBe(0);
      expect(existsSync(`${out}.bpmn`)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import { describe, test, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

import { checkNetIntegrity } from './net-check.js';
import { bpmnToPN } from './workflow-net.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, '..', '..', 'tests', 'fixtures');

// Directory-driven, not a hard-coded list: a new fixture is covered the day it lands, with
// nobody having to remember to add it here. `.expected.*` goldens and non-Logic-Core JSON
// side-cars (DMN Decision-Core, robustness config) live in the same directory or its
// subdirectories, so filter both the extension and the shape.
function loadLogicCoreFixtures() {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.json') && !e.name.includes('.expected.'))
    .map(e => {
      const lc = JSON.parse(readFileSync(path.join(FIXTURES_DIR, e.name), 'utf8'));
      return { name: e.name, lc };
    })
    .filter(({ lc }) => Array.isArray(lc.pools) || Array.isArray(lc.nodes));
}

function processesOf(lc) {
  return lc.pools ? lc.pools : [lc];
}

describe('checkNetIntegrity — the fence over every fixture', () => {
  const fixtures = loadLogicCoreFixtures();

  // Sanity: the directory scan itself must find something, or every case below silently
  // passes for the wrong reason (nothing to iterate).
  test('at least one Logic-Core fixture was found', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const { name, lc } of fixtures) {
    for (const proc of processesOf(lc)) {
      test(`${name}${lc.pools ? ` [${proc.id}]` : ''} — no ERROR-severity net-integrity finding`, () => {
        const pn = bpmnToPN(proc);
        const { issues } = checkNetIntegrity(pn, proc);
        // toEqual([]), not toHaveLength(0): on failure Jest prints the actual findings, which
        // is the whole point — a fence that names its own violation gets fixed, one that just
        // says "expected 0" gets deleted instead.
        expect(issues.filter(i => i.severity === 'ERROR')).toEqual([]);
      });
    }
  }
});

describe('checkNetIntegrity — vacuity: the pass actually detects a broken net', () => {
  test('a hand-built net with an unproduced, unconsumed place trips NC03a and NC03b', () => {
    // A properly wired start -> only -> end skeleton (source produced/consumed, sink
    // produced/consumed, every transition has both an incoming and an outgoing place), plus
    // one deliberately dangling place, p_orphan, that nothing produces and nothing consumes.
    // Wiring the rest correctly isolates the single defect this test means to exercise —
    // otherwise a naive net trips NC02/NC02b too, for reasons that have nothing to do with
    // what this test is checking. If this test ever silently passes, the directory loop above
    // has become a no-op.
    const pn = {
      places: new Map([
        ['p_source', { id: 'p_source' }],
        ['p1', { id: 'p1' }],
        ['p_sink', { id: 'p_sink' }],
        ['p_orphan', { id: 'p_orphan' }],
      ]),
      transitions: new Map([
        ['t_start', { id: 't_start', label: 'Start', bpmnNodeId: 'start' }],
        ['t_only', { id: 't_only', label: 'Only', bpmnNodeId: 'only' }],
      ]),
      arcs: [
        { from: 'p_source', to: 't_start', type: 'P→T' },
        { from: 't_start', to: 'p1', type: 'T→P' },
        { from: 'p1', to: 't_only', type: 'P→T' },
        { from: 't_only', to: 'p_sink', type: 'T→P' },
      ],
      sourcePlace: 'p_source',
      sinkPlace: 'p_sink',
      skipped: [],
      flatNodes: [{ id: 'start', type: 'startEvent' }, { id: 'only', type: 'task' }],
      flatEdges: [],
    };
    const { ok, issues } = checkNetIntegrity(pn, { id: 'proc', nodes: pn.flatNodes });
    expect(ok).toBe(false);
    const codes = issues.map(i => i.code).sort();
    expect(codes).toEqual(['NC03a', 'NC03b']);
  });
});

describe('checkNetIntegrity — judges the translation, never the model', () => {
  test('deadlock-process.json is deliberately unsound (S05/WF03 catch it) but must be a clean translation', () => {
    const lc = JSON.parse(
      readFileSync(path.join(FIXTURES_DIR, 'deadlock-process.json'), 'utf8')
    );
    for (const proc of processesOf(lc)) {
      const pn = bpmnToPN(proc);
      const { ok, issues } = checkNetIntegrity(pn, proc);
      expect(issues.filter(i => i.severity === 'ERROR')).toEqual([]);
      expect(ok).toBe(true);
    }
  });
});

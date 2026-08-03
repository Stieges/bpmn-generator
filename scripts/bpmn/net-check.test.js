import { describe, test, expect } from '@jest/globals';
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

import { checkNetIntegrity } from './net-check.js';
import { bpmnToPN, checkWorkflowNetSoundness } from './workflow-net.js';
import { runRules } from './rules.js';

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

describe('NC02 is ERROR now that boundary events have a translation', () => {
  test('a dropped input arc fails the fence rather than warning past it', () => {
    // Stage 5 flipped NC02's severity. That flip is only meaningful if the code still fires —
    // a fence that passes because nothing detects anything is the failure mode this whole
    // guard exists against. Hand-built so the ONE defect is the translation defect NC02 is
    // scoped to after the narrowing: `orphan` HAS an incoming sequence flow in the Logic-Core
    // (`fx`), its place exists, and the P→T arc that should consume it is missing from the net.
    // Nothing else about the model is wrong, so anything else reported here is a false alarm.
    const fx = { id: 'fx', source: 'only', target: 'orphan' };
    const fy = { id: 'fy', source: 'orphan', target: 'drain' };
    const pn = {
      places: new Map([
        ['p_source', { id: 'p_source' }],
        ['p_only_orphan', { id: 'p_only_orphan' }],
        ['p_orphan_drain', { id: 'p_orphan_drain' }],
        ['p_sink', { id: 'p_sink' }],
      ]),
      transitions: new Map([
        ['t_only', { id: 't_only', label: 'Only', bpmnNodeId: 'only' }],
        ['t_orphan', { id: 't_orphan', label: 'Orphan', bpmnNodeId: 'orphan' }],
        ['t_drain', { id: 't_drain', label: 'Drain', bpmnNodeId: 'drain' }],
      ]),
      arcs: [
        { from: 'p_source', to: 't_only', type: 'P→T' },
        { from: 't_only', to: 'p_only_orphan', type: 'T→P' },
        // The dropped arc would be { from: 'p_only_orphan', to: 't_orphan', type: 'P→T' }.
        { from: 't_orphan', to: 'p_orphan_drain', type: 'T→P' },
        { from: 'p_orphan_drain', to: 't_drain', type: 'P→T' },
        { from: 't_drain', to: 'p_sink', type: 'T→P' },
      ],
      sourcePlace: 'p_source',
      sinkPlace: 'p_sink',
      skipped: [],
      flatNodes: [{ id: 'only', type: 'startEvent' }, { id: 'orphan', type: 'task' },
        { id: 'drain', type: 'endEvent' }],
      flatEdges: [fx, fy],
    };
    const { ok, issues } = checkNetIntegrity(pn, { id: 'proc', nodes: pn.flatNodes });
    expect(issues.map(i => `${i.code}/${i.severity}`)).toEqual(['NC02/ERROR', 'NC03b/ERROR']);
    expect(issues[0].elements).toEqual(['orphan', 't_orphan']);
    expect(ok).toBe(false);
  });
});

describe('NC02/NC02b judge the translation, not the model', () => {
  // The narrowing these two tests pin down. "This transition can never fire" is true both of a
  // translation that dropped an arc and of a model that routes nothing into the node, and only
  // the first is this pass's business. Unnarrowed, the second case dominated: measured over
  // 4000 random rule-engine-clean processes, NC02/NC02b produced 6601 + 6612 ERRORs across 3380
  // of 3983 nets while NC01, NC03a, NC03b, NC04 and NC06 never fired once.
  const strandedNodes = () => ({
    id: 'P',
    nodes: [
      { id: 's', type: 'startEvent' },
      { id: 't', type: 'task' },
      { id: 'e', type: 'endEvent' },
      // Nothing routes to `fork`; `sink` routes nowhere. Both are MODEL defects, and both are
      // translated entirely faithfully.
      { id: 'fork', type: 'parallelGateway' },
      { id: 'sink', type: 'task' },
    ],
    edges: [
      { id: 'f1', source: 's', target: 't' },
      { id: 'f2', source: 't', target: 'e' },
      { id: 'f3', source: 'fork', target: 'sink' },
    ],
  });

  test('a node with no incoming sequence flow is not an NC02 finding', () => {
    const proc = strandedNodes();
    const pn = bpmnToPN(proc);
    // The translation really did leave `t_fork` unfireable and `t_sink` token-destroying …
    expect(pn.arcs.some(a => a.type === 'P→T' && a.to === 't_fork')).toBe(false);
    expect(pn.arcs.some(a => a.type === 'T→P' && a.from === 't_sink')).toBe(false);
    // … and that is exactly what the model says, so neither is reported.
    expect(checkNetIntegrity(pn, proc).issues.filter(i => i.severity === 'ERROR')).toEqual([]);
  });

  test('the layers that DO own those two nodes still report them', () => {
    // The other half of the claim: the model defect is not being swept under the carpet, it is
    // reported by the layers that own it. If either stops covering this shape, the exemption
    // above turns into a blind spot, and this test is what says so.
    //
    // Note which layer covers which. `sink` (no outgoing flow) is S07's literal wording.
    // `fork` (no INCOMING flow, but an outgoing one) used to be covered by nothing in the
    // always-on rule layers — S04's `connected` set was sources ∪ targets, so one outgoing flow
    // was enough to pass it — and was WF01's alone, in the opt-in Workflow-Net layer. S04 now
    // asks about incoming flows only and names it too, so the always-on gap is closed; WF01 is
    // still asserted here because it is the exhaustive check (a node no PATH from the start
    // reaches, not merely one with no incoming edge), and the exemption above must stay backed
    // by both.
    expect(runRules(strandedNodes()).warnings.join(' ')).toContain('"sink" has no outgoing flow');
    expect(runRules(strandedNodes()).warnings.join(' ')).toContain('"fork" () has no incoming flow');
    expect(checkWorkflowNetSoundness(strandedNodes()).issues
      .filter(i => i.rule === 'WF01').map(i => i.message).join(' '))
      .toContain('"fork"');
  });
});

describe('the NC02 narrowing must not blind the boundary-event wiring', () => {
  // The trap the narrowing had to avoid. A boundary event has NO incoming sequence flow by
  // definition (OMG §10.4.4) — its trigger is `attachedTo` — so a naive "no incoming flow ⇒
  // exempt" rule would exempt every boundary event and blind NC02 to precisely the defect that
  // gave boundary events a Petri-net translation in the first place: before `wireBoundaryEvents`
  // (workflow-net.js), `t_b` reached the net with no input arc at all, unfireable in every
  // marking, silently deleting the whole escalation path from every analysis.
  const withBoundary = () => ({
    id: 'P',
    nodes: [
      { id: 's', type: 'startEvent' },
      { id: 't', type: 'userTask' },
      { id: 'b', type: 'boundaryEvent', attachedTo: 't' },
      { id: 'esc', type: 'task' },
      { id: 'e', type: 'endEvent' },
      { id: 'e2', type: 'endEvent' },
    ],
    edges: [
      { id: 'f1', source: 's', target: 't' },
      { id: 'f2', source: 't', target: 'e' },
      { id: 'f3', source: 'b', target: 'esc' },
      { id: 'f4', source: 'esc', target: 'e2' },
    ],
  });

  test('the current wiring is clean', () => {
    const proc = withBoundary();
    const pn = bpmnToPN(proc);
    expect(pn.arcs.filter(a => a.type === 'P→T' && a.to === 't_b').map(a => a.from))
      .toEqual(['p_s_t']);
    expect(checkNetIntegrity(pn, proc).issues).toEqual([]);
  });

  test('re-breaking the wiring is still an NC02 ERROR, exemption or no exemption', () => {
    const proc = withBoundary();
    const pn = bpmnToPN(proc);
    // Reproduce the pre-Stage-5 net exactly: `connectTransition` wired a boundary event from
    // its incoming sequence flows, of which it has none, so the transition existed with only
    // outgoing arcs. Nothing else is touched.
    pn.arcs = pn.arcs.filter(a => !(a.type === 'P→T' && a.to === 't_b'));

    const nc02 = checkNetIntegrity(pn, proc).issues.filter(i => i.code === 'NC02');
    expect(nc02).toHaveLength(1);
    expect(nc02[0].severity).toBe('ERROR');
    expect(nc02[0].elements).toEqual(['b', 't_b']);
    // And the message names the attachment, so the reader is not sent looking for a missing
    // sequence flow that the model never had.
    expect(nc02[0].message).toContain('its host "t" as its trigger');
  });
});

describe('NC04 is ERROR now that every sequence flow has a place of its own', () => {
  // The model NC04 used to exist for — two flows between one node pair — is now translated
  // faithfully, and `net-check.test.js`'s directory-wide fence plus
  // `pipeline.test.js`'s parallel-pair cases cover that it comes out clean.
  //
  // What is left for NC04 to say is narrower than the other codes, and this test is where that
  // narrowness is made legible rather than left to be rediscovered. NC04 reads `pn.placeOfEdge`
  // — it may NOT re-derive `p_<src>_<tgt>`, which would report every legal parallel pair as a
  // collision — so it asserts `namePlaces`' own invariant (distinct edges never share a place
  // id) against `namePlaces`' own output. Under the current naming rule it therefore cannot
  // fire on a real net, by construction. That is the intended end state for a regression
  // fence, and it is exactly why the assertion below has to exist: the fence's entire value is
  // that a future naming rule breaking the invariant fails loudly. Delete this test and the
  // ERROR severity protects nothing.
  test('two edges assigned one place fail the fence rather than warning past it', () => {
    const f2 = { id: 'f2', source: 'gw', target: 't', label: 'Yes' };
    const f3 = { id: 'f3', source: 'gw', target: 't', label: 'No' };
    const proc = {
      id: 'P',
      nodes: [
        { id: 's', type: 'startEvent' },
        { id: 'gw', type: 'exclusiveGateway' },
        { id: 't', type: 'task' },
        { id: 'e', type: 'endEvent' },
      ],
      edges: [{ id: 'f1', source: 's', target: 'gw' }, f2, f3,
        { id: 'f4', source: 't', target: 'e' }],
    };
    const pn = bpmnToPN(proc);
    // Sanity first: the real translation gives them two places, so the collision below is
    // genuinely injected and not something the fixture arrived with.
    expect(pn.placeOfEdge.get(f2)).not.toBe(pn.placeOfEdge.get(f3));

    pn.placeOfEdge.set(f3, pn.placeOfEdge.get(f2));
    const { ok, issues } = checkNetIntegrity(pn, proc);
    const nc04 = issues.filter(i => i.code === 'NC04');
    expect(nc04).toHaveLength(1);
    expect(nc04[0].severity).toBe('ERROR');
    expect(nc04[0].elements).toEqual(['p_gw_t#0', 'f2', 'f3']);
    expect(ok).toBe(false);
  });
});

describe('NC06(b) is provably unreachable on a real net — vacuity fence, same shape as NC04', () => {
  // NC06(b) asks whether an edge-derived place id collides with the reserved `p_source` /
  // `p_sink` keys. `namePlaces` (workflow-net.js) always mints an edge's place id as
  // `p_${edge.source}_${edge.target}` (or that string with a `#<k>` suffix) — the string
  // ALWAYS contains the literal `_` that separates the source and target node ids, at least
  // once. `sourcePlace`/`sinkPlace` are the literal strings 'p_source' and 'p_sink': strip
  // their `p_` prefix and neither `source` nor `sink` contains an underscore at all. No pair
  // of (non-empty, per `references/input-schema.json`'s id pattern) node ids can concatenate
  // with a literal `_` between them and produce a string with zero underscores, so this branch
  // can never fire on a net `bpmnToPN` produced, by construction — exactly the argument NC04's
  // own vacuity test makes for its own collision. Kept anyway, not deleted, because the
  // argument is a fact about the CURRENT naming rule, not a law: a future `namePlaces` change
  // (e.g. a scheme without the separating `_`) could reopen this branch, and the fence has to
  // already exist to catch it, not be written in response to it.
  test('an edge place id forced to the reserved sink key fails the fence rather than staying silent', () => {
    const proc = {
      id: 'P',
      nodes: [
        { id: 's', type: 'startEvent' },
        { id: 't', type: 'task' },
        { id: 'e', type: 'endEvent' },
      ],
      edges: [{ id: 'f1', source: 's', target: 't' }, { id: 'f2', source: 't', target: 'e' }],
    };
    const pn = bpmnToPN(proc);
    const f2 = proc.edges[1];
    // Sanity first: the real translation never produces the reserved key on its own.
    expect(pn.placeOfEdge.get(f2)).not.toBe(pn.sinkPlace);

    pn.placeOfEdge.set(f2, pn.sinkPlace);
    const { ok, issues } = checkNetIntegrity(pn, proc);
    const nc06 = issues.filter(i => i.code === 'NC06');
    expect(nc06).toHaveLength(1);
    expect(nc06[0].severity).toBe('ERROR');
    expect(nc06[0].elements).toEqual([pn.sinkPlace, 'f2']);
    expect(ok).toBe(false);
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

/**
 * Phase D — output formatting tests.
 *
 * Verification items 1-7 from the task brief map onto the `describe` blocks below in order.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { enumerateScenarios } from './enumerate.js';
import { enumerateCollaboration } from './collaboration.js';
import {
  formatScenarioResult, formatCollaborationResult,
  parseDecisionTransition, extractScenarioDecisions, computeHappyPath,
  deriveHappyPathEdges, distanceFromHappyPath, happyPathDecisionMap,
  describeEnumerationCompleteness,
} from './format.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../tests/fixtures', `${name}.json`), 'utf8'));

/** The `##` headings that are decision GROUPS. `## Enumeration summary` is a `##` section too
 *  (added when the whole-branch review found the completeness signals never reached either
 *  output), and a bare `/^## /` count would silently include it — so it is named and excluded
 *  here rather than the summary being demoted to `###`, which would misrepresent it as a
 *  subsection of the group that happens to precede it. */
const groupHeadingsOf = (markdown) =>
  (markdown.match(/^## .+$/gm) || []).filter(h => h !== '## Enumeration summary');

// A fixture with TWO independent XOR gateways (gwA then gwB, no cycles) — the simple-approval
// fixture only has one, which cannot exercise "differs at 1 gateway vs. differs at 2".
const twoGatewayProc = {
  id: 'Process_TwoGateways',
  nodes: [
    { id: 'start', type: 'startEvent', name: 'Start' },
    { id: 'gwA', type: 'exclusiveGateway', name: 'A?' },
    { id: 'taskA1', type: 'task', name: 'A1' },
    { id: 'taskA2', type: 'task', name: 'A2' },
    { id: 'mid', type: 'task', name: 'Mid' },
    { id: 'gwB', type: 'exclusiveGateway', name: 'B?' },
    { id: 'taskB1', type: 'task', name: 'B1' },
    { id: 'taskB2', type: 'task', name: 'B2' },
    { id: 'endMerge', type: 'task', name: 'End Merge' },
    { id: 'end', type: 'endEvent', name: 'End' },
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'gwA' },
    { id: 'e2', source: 'gwA', target: 'taskA1', label: 'A1' },
    { id: 'e3', source: 'gwA', target: 'taskA2', label: 'A2' },
    { id: 'e4', source: 'taskA1', target: 'mid' },
    { id: 'e5', source: 'taskA2', target: 'mid' },
    { id: 'e6', source: 'mid', target: 'gwB' },
    { id: 'e7', source: 'gwB', target: 'taskB1', label: 'B1' },
    { id: 'e8', source: 'gwB', target: 'taskB2', label: 'B2' },
    { id: 'e9', source: 'taskB1', target: 'endMerge' },
    { id: 'e10', source: 'taskB2', target: 'endMerge' },
    { id: 'e11', source: 'endMerge', target: 'end' },
  ],
};

// Same shape, but with isHappyPath explicitly marking the A2 / B1 combination — the OPPOSITE
// of what the BFS fallback would derive (which picks the lexicographically smallest edge id
// at each gateway, i.e. A1 / B1) — so a test that used the derived answer by accident cannot
// pass this one too.
const markedTwoGatewayProc = {
  ...twoGatewayProc,
  edges: twoGatewayProc.edges.map(e => ({
    ...e,
    isHappyPath: ['e1', 'e3', 'e5', 'e6', 'e7', 'e9', 'e11'].includes(e.id) || undefined,
  })),
};

describe('Part 1 — decision-label derivation (item 1)', () => {
  test('parseDecisionTransition recognizes only XOR-split transitions', () => {
    expect(parseDecisionTransition('t_gw1_choice_0')).toEqual({ gatewayId: 'gw1', choiceIndex: 0 });
    expect(parseDecisionTransition('t_gw1_choice_12')).toEqual({ gatewayId: 'gw1', choiceIndex: 12 });
    expect(parseDecisionTransition('t_task1_merge_0')).toBeNull();
    expect(parseDecisionTransition('t_task1')).toBeNull();
  });

  test('simple-approval: each scenario\'s decision label names the taken edge, merge transitions excluded', () => {
    const proc = fixture('simple-approval').pools[0];
    const result = enumerateScenarios(proc);
    const { json } = formatScenarioResult(result, proc);

    expect(json.scenarios).toHaveLength(2);
    // Scenario 0: straight through, gw1 chose "Yes" (f3).
    const straight = json.scenarios.find(s => s.nodes.length === 5);
    expect(straight.decisions).toEqual([
      { kind: 'bpmn-gateway', gatewayId: 'gw1', poolId: null, choiceIndex: 0, edgeId: 'f3', label: 'Yes' },
    ]);
    // Scenario 1: one revision, gw1 chose "No" (f4) then "Yes" (f3).
    const revised = json.scenarios.find(s => s.nodes.length === 8);
    expect(revised.decisions.map(d => d.label)).toEqual(['No', 'Yes']);

    // t_task1_merge_0 / t_task1_merge_1 (task1 has 2 incoming edges) must NOT appear as
    // decision points anywhere.
    for (const s of json.scenarios) {
      expect(s.transitions.some(t => t.includes('_merge_'))).toBe(true); // sanity: the fixture DOES have one
      expect(s.decisions.every(d => !d.gatewayId.includes('task1'))).toBe(true);
    }
  });
});

describe('Part 2 — happy path, marked case (item 2)', () => {
  test('marked isHappyPath edges are used verbatim, not derived, and the matching scenario sorts first at distance 0', () => {
    const result = enumerateScenarios(markedTwoGatewayProc);
    const { json } = formatScenarioResult(result, markedTwoGatewayProc);

    expect(json.happyPath.derived).toBe(false);
    expect(json.happyPath.decisions.map(d => d.label)).toEqual(['A2', 'B1']);

    const first = json.scenarios[0];
    expect(first.decisions.map(d => d.label)).toEqual(['A2', 'B1']);
    expect(first.happyPathDistance).toBe(0);
  });
});

describe('Part 2 — happy path, derived case (item 3)', () => {
  test('simple-approval has no isHappyPath markings', () => {
    const proc = fixture('simple-approval').pools[0];
    expect(proc.edges.some(e => e.isHappyPath)).toBe(false);
  });

  test('BFS fallback excludes the backward edge f5, flags itself as derived, and is deterministic', () => {
    const proc = fixture('simple-approval').pools[0];
    const result = enumerateScenarios(proc);
    const { json } = formatScenarioResult(result, proc);

    expect(json.happyPath.derived).toBe(true);
    expect(json.happyPath.edges.map(e => e.id)).toEqual(['f1', 'f2', 'f3', 'f6']);
    expect(json.happyPath.edges.some(e => e.id === 'f5')).toBe(false);

    // Re-running produces the identical path. simple-approval has no expanded subprocess
    // children, so `proc.nodes`/`proc.edges` are already flat — no need to reach into
    // `bpmn/workflow-net.js`'s internal flatten for this fixture.
    const again = deriveHappyPathEdges(proc.nodes, proc.edges);
    expect(again.map(e => e.id)).toEqual(['f1', 'f2', 'f3', 'f6']);
    const onceMore = deriveHappyPathEdges(proc.nodes, proc.edges);
    expect(onceMore.map(e => e.id)).toEqual(again.map(e => e.id));
  });
});

describe('Part 3 — distance and sort order (item 4)', () => {
  test('scenarios differing at 1 gateway sort before scenarios differing at 2; equal distances tie-break by index', () => {
    const result = enumerateScenarios(twoGatewayProc);
    const { json } = formatScenarioResult(result, twoGatewayProc);

    expect(json.scenarios).toHaveLength(4);
    expect(json.happyPath.decisions.map(d => d.label)).toEqual(['A1', 'B1']); // BFS picks e2/e7 (lexicographically smallest)

    const distances = json.scenarios.map(s => s.happyPathDistance);
    expect(distances).toEqual([0, 1, 1, 2]);

    // The two distance-1 scenarios tie-break by original `index`.
    const distanceOneScenarios = json.scenarios.filter(s => s.happyPathDistance === 1);
    expect(distanceOneScenarios[0].index).toBeLessThan(distanceOneScenarios[1].index);
  });

  test('distanceFromHappyPath scores a skipped happy-path gateway the same as a differing choice', () => {
    const happyMap = happyPathDecisionMap([
      { poolId: null, gatewayId: 'gwA', label: 'A1' },
      { poolId: null, gatewayId: 'gwB', label: 'B1' },
    ]);
    const differsAtBoth = distanceFromHappyPath(
      [{ poolId: null, gatewayId: 'gwA', label: 'A2' }], happyMap,
    ); // gwB never reached at all
    expect(differsAtBoth).toBe(2);
  });
});

describe('Part 3 — grouping collapses correctly (item 5)', () => {
  test('two scenarios with the same decision-label sequence land in one Markdown group; JSON still lists them separately', () => {
    const proc = fixture('simple-approval').pools[0];
    const result = enumerateScenarios(proc);
    const { json, markdown } = formatScenarioResult(result, proc);

    // JSON: flat, full detail, still 2 scenarios.
    expect(json.scenarios).toHaveLength(2);
    expect(new Set(json.scenarios.map(s => s.groupKey)).size).toBe(2); // these two happen to differ

    // Markdown: exactly 2 groups (one per distinct decision sequence), each showing its
    // members. There is no artificial merge here, so this doubles as a shape check on the
    // rendering itself.
    const groupHeadings = groupHeadingsOf(markdown);
    expect(groupHeadings).toHaveLength(json.groupCount);
    expect(json.groupCount).toBe(2);

    // Build an artificial pair with an IDENTICAL decision sequence to confirm the grouping
    // logic itself (not just "this fixture happens to have 2 groups").
    const withDuplicateKey = {
      ...json,
      scenarios: [
        { ...json.scenarios[0], index: 0, groupKey: 'SAME' },
        { ...json.scenarios[0], index: 1, groupKey: 'SAME' },
      ],
    };
    const groups = new Map();
    for (const s of withDuplicateKey.scenarios) {
      if (!groups.has(s.groupKey)) groups.set(s.groupKey, []);
      groups.get(s.groupKey).push(s);
    }
    expect(groups.size).toBe(1);
    expect(groups.get('SAME')).toHaveLength(2);
  });

  test('a group with interleavingCount > 1 for any member surfaces the count in Markdown', () => {
    // simple-approval's scenarios are fully sequential (interleavingCount 1), so build a
    // scenario carrying interleavingCount > 1 directly to check the rendering path.
    const proc = fixture('simple-approval').pools[0];
    const result = enumerateScenarios(proc);
    result.scenarios[0].interleavingCount = 6;
    const { markdown } = formatScenarioResult(result, proc);
    expect(markdown).toMatch(/×6 interleavings/);
  });
});

describe('Part 1 — composite (multi-pool) scenario labeling (item 6)', () => {
  test('pool-prefix and __recv_ stripping recovers a decision label inside one pool of a collaboration', () => {
    const lc = fixture('realistic-collaboration');
    const result = enumerateCollaboration(lc);
    const { json } = formatCollaborationResult(result, lc);

    const withDecisions = json.scenarios.filter(s => s.decisions.length > 0);
    expect(withDecisions.length).toBeGreaterThan(0);

    const decision = withDecisions[0].decisions[0];
    expect(decision.gatewayId).toBe('in_gw');
    expect(decision.poolId).toBe('Process_Intake');
    expect(['Yes', 'No']).toContain(decision.label);
  });

  test('extractScenarioDecisions strips pool prefix and __recv_ suffix directly', () => {
    const context = {
      flatNodes: [{ id: 'in_gw', type: 'exclusiveGateway' }],
      flatEdges: [
        { id: 'inf4', source: 'in_gw', target: 'in_forward', label: 'Yes' },
        { id: 'inf5', source: 'in_gw', target: 'in_reject', label: 'No' },
      ],
    };
    const decisions = extractScenarioDecisions(
      ['Process_Intake::t_in_gw_choice_0__recv_mf1'],
      ['Process_Intake'],
      () => context,
    );
    expect(decisions).toEqual([
      { kind: 'bpmn-gateway', gatewayId: 'in_gw', poolId: 'Process_Intake', choiceIndex: 0, edgeId: 'inf4', label: 'Yes' },
    ]);
  });
});

describe('Part 4 — truncation is visible, never silent (item 7)', () => {
  test('an artificially tiny group-render cap states explicitly how many groups were omitted', () => {
    const proc = fixture('simple-approval').pools[0];
    const result = enumerateScenarios(proc);
    const { markdown, json } = formatScenarioResult(result, proc, { maxGroupsRendered: 1 });

    expect(json.groupCount).toBe(2); // JSON view is unaffected by the cap
    const groupHeadings = groupHeadingsOf(markdown);
    expect(groupHeadings).toHaveLength(1); // Markdown view is capped

    expect(markdown).toMatch(/1 more group not shown, see the JSON view\./);
  });

  test('no omission message when the cap is not hit', () => {
    const proc = fixture('simple-approval').pools[0];
    const result = enumerateScenarios(proc);
    const { markdown } = formatScenarioResult(result, proc, { maxGroupsRendered: 50 });
    expect(markdown).not.toMatch(/not shown/);
  });
});

describe('computeHappyPath — direct unit coverage', () => {
  test('returns derived:false and the marked chain when isHappyPath edges are present', () => {
    const hp = computeHappyPath(markedTwoGatewayProc.nodes, markedTwoGatewayProc.edges, null);
    expect(hp.derived).toBe(false);
    expect(hp.edges.map(e => e.id)).toEqual(['e1', 'e3', 'e5', 'e6', 'e7', 'e9', 'e11']);
  });

  test('returns derived:true and an empty happy path when start/end events are absent', () => {
    const hp = computeHappyPath([{ id: 'a', type: 'task' }], [], null);
    expect(hp.derived).toBe(true);
    expect(hp.found).toBe(false);
    expect(hp.edges).toEqual([]);
    expect(hp.decisions).toEqual([]);
  });

  test('found:true with a non-empty path', () => {
    const hp = computeHappyPath(twoGatewayProc.nodes, twoGatewayProc.edges, null);
    expect(hp.found).toBe(true);
  });
});

describe('Regression — reviewer findings', () => {
  test('CRITICAL: a plain task node whose id collides with the _choice_<i> shape is NOT read as a fabricated decision (format.js:62)', () => {
    // Node ids only have to match input-schema.json's ^[a-zA-Z_][a-zA-Z0-9_-]*$ — an
    // ordinary task legally named "my" produces transition id "t_my_choice_1" for its
    // (non-existent) choice, indistinguishable BY SHAPE ALONE from a real gateway split.
    const context = {
      flatNodes: [{ id: 'my', type: 'task', name: 'Ordinary Task' }],
      flatEdges: [{ id: 'e1', source: 'my', target: 'next' }],
    };
    const decisions = extractScenarioDecisions(['t_my_choice_1'], [null], () => context);
    expect(decisions).toEqual([]);
  });

  test('IMPORTANT 1: an inclusiveGateway split contributes NO decision point, so the happy path scores distance 0 against itself (format.js:264-266 vs :73)', () => {
    // bpmnToPN never emits a t_<gw>_choice_<i> transition for an inclusiveGateway — it
    // falls through to the forced-AND default (single transition, all branches fire
    // together). Counting it on the happy-path side but never on the scenario side used to
    // give every scenario a constant +1 penalty it could never pay off.
    const proc = {
      id: 'P',
      nodes: [
        { id: 'start', type: 'startEvent' },
        { id: 'gwOr', type: 'inclusiveGateway', name: 'Or?' },
        { id: 'taskX', type: 'task', name: 'X' },
        { id: 'taskY', type: 'task', name: 'Y' },
        { id: 'endMerge', type: 'task', name: 'Merge' },
        { id: 'end', type: 'endEvent' },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'gwOr' },
        { id: 'e2', source: 'gwOr', target: 'taskX', label: 'X' },
        { id: 'e3', source: 'gwOr', target: 'taskY', label: 'Y' },
        { id: 'e4', source: 'taskX', target: 'endMerge' },
        { id: 'e5', source: 'taskY', target: 'endMerge' },
        { id: 'e6', source: 'endMerge', target: 'end' },
      ],
    };
    const result = enumerateScenarios(proc);
    const { json } = formatScenarioResult(result, proc);

    expect(json.happyPath.decisions).toEqual([]); // no inclusiveGateway entry
    expect(json.scenarios).toHaveLength(1);
    expect(json.scenarios[0].decisions).toEqual([]);
    expect(json.scenarios[0].happyPathDistance).toBe(0); // NOT 1
  });

  test('IMPORTANT 2: two edges out of the same gateway sharing an identical label are NOT collapsed, and do NOT both score distance 0 (format.js:148, :328)', () => {
    // M04 only requires an XOR split's outgoing edges to carry A label, not a DISTINCT one
    // — two edges legally sharing the label text "Yes" must still be told apart by edgeId.
    const proc = {
      id: 'P',
      nodes: [
        { id: 'start', type: 'startEvent' },
        { id: 'gw1', type: 'exclusiveGateway', name: 'Gw' },
        { id: 'taskA', type: 'task', name: 'A' },
        { id: 'taskB', type: 'task', name: 'B' },
        { id: 'end', type: 'endEvent' },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'gw1' },
        { id: 'e2', source: 'gw1', target: 'taskA', label: 'Yes' },
        { id: 'e3', source: 'gw1', target: 'taskB', label: 'Yes' },
        { id: 'e4', source: 'taskA', target: 'end' },
        { id: 'e5', source: 'taskB', target: 'end' },
      ],
    };
    const result = enumerateScenarios(proc);
    const { json } = formatScenarioResult(result, proc);

    expect(json.scenarios).toHaveLength(2);
    expect(json.groupCount).toBe(2); // NOT collapsed into 1 despite identical labels
    const distances = json.scenarios.map(s => s.happyPathDistance).sort();
    expect(distances).toEqual([0, 1]); // NOT both 0
    // The two scenarios differ by edgeId, not by (the identical) label.
    expect(json.scenarios[0].decisions[0].edgeId).not.toBe(json.scenarios[1].decisions[0].edgeId);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// B10 — the three misattributed notes
// ═══════════════════════════════════════════════════════════════════════

describe('completeness notes attribute each finding to its actual reason', () => {
  const notesFor = (lc) => describeEnumerationCompleteness(enumerateCollaboration(lc)).notes;

  test('an unmapped endpoint is not reported as a black-box choice', () => {
    const notes = notesFor(fixture('messageflow-to-subprocess'));
    const ungatedNote = notes.find(n => n.includes('mf_container') && n.includes('enforce no ordering'));
    expect(ungatedNote).toBeDefined();
    // The whole point: `gates: false` here is a defect, not a modelling decision, and the note
    // must not describe it as the latter.
    // The old wording attributed every ungated flow to "(a black-box endpoint)". The new note
    // may still mention black boxes — it contrasts itself against them — but must not claim to
    // be one.
    expect(ungatedNote).not.toMatch(/\(a black-box endpoint\)/);
    expect(ungatedNote).toMatch(/could not be mapped/);
    expect(ungatedNote).toMatch(/not a modelling choice/);
  });

  test('a container endpoint is named as such, with the rule that explains it', () => {
    const note = notesFor(fixture('messageflow-to-subprocess'))
      .find(n => n.includes('message flow endpoint(s) could not be mapped to a node'));
    expect(note).toMatch(/mf_container\/source=fulfil/);
    expect(note).toMatch(/names a subProcess, which is not a valid MessageFlow endpoint \(S14\)/);
  });

  test('a genuine black-box endpoint keeps today\'s wording', () => {
    const note = notesFor(fixture('realistic-collaboration'))
      .find(n => n.includes('enforce no ordering'));
    expect(note).toMatch(/a black-box endpoint/);
    expect(note).not.toMatch(/could not be mapped/);
  });

  test('a skip reason is explained by its own reason, not by eventBasedGateway\'s', () => {
    // Stage 1 added `subProcessWithoutStartOrEnd`; the old single note appended the
    // eventBasedGateway race-semantics sentence to whatever the reason happened to be.
    const notes = notesFor(fixture('subprocess-collapsed-children'));
    const note = notes.find(n => n.includes('subProcessWithoutStartOrEnd'));
    expect(note).toBeDefined();
    expect(note).not.toMatch(/race semantics/);
    expect(note).toMatch(/no well-defined entry or exit marking/);
  });

  test('an approximation is disclosed on its own channel, not as a skip', () => {
    // Stage 5. The distinction is the point: a skipped node never appears in any scenario, an
    // approximated one does — just not in every scenario the semantics allow. Reporting the
    // second as the first tells the reader the node is missing when it is present.
    const notes = notesFor(fixture('boundary-event-shapes'));
    const note = notes.find(n => n.includes('nonInterruptingBoundaryEvent'));
    expect(note).toBeDefined();
    expect(note).toMatch(/modelled by approximation/);
    expect(note).toMatch(/P_Boundary::bnd_n/);
    expect(note).not.toMatch(/not modelled at all/);
    // Each approximation reason gets its own explanation, for the same reason skip reasons do.
    const containerNote = notes.find(n => n.includes('boundaryEventOnContainer'));
    expect(containerNote).toBeDefined();
    expect(containerNote).toMatch(/competes with the subprocess's ENTRY/);
    expect(containerNote).not.toMatch(/non-interrupting/);
  });

  test('an approximation is a note, never a warning — the enumeration finished', () => {
    const { warnings } = describeEnumerationCompleteness(
      enumerateCollaboration(fixture('boundary-event-shapes')));
    expect(warnings).toEqual([]);
  });
});

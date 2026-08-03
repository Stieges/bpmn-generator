/**
 * Phase A2 — multi-pool scenario enumeration tests.
 *
 * As in `enumerate.test.js`, the counts are hand-traced rather than recorded from a run;
 * where one fails, the traversal is wrong, not the expectation. The traces are in
 * .superpowers/sdd/2026-08-01-scenario-enumeration/task-2-report.md.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  enumerateCollaboration, composeCollaboration, transitionsForNode, messagePlaceId, scopedId,
} from './collaboration.js';
import { enumerateScenarios, groupBySharedInput, indexArcs } from './enumerate.js';
import {
  bpmnToPN, checkWorkflowNetSoundness, getEnabledTransitions, fireTransition,
} from '../bpmn/workflow-net.js';
import { checkNetIntegrity } from '../bpmn/net-check.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  JSON.parse(readFileSync(resolve(__dirname, '../../tests/fixtures', `${name}.json`), 'utf8'));

/** first index of a BPMN node id in a scenario's node list, -1 when absent */
const at = (scenario, nodeId) => scenario.nodes.indexOf(nodeId);

// ═══════════════════════════════════════════════════════════════════════
// The non-negotiable one: bpmnToPN is untouched
// ═══════════════════════════════════════════════════════════════════════

describe('collaboration composition — bpmnToPN keeps its behaviour', () => {
  test('the per-pool nets carry no message place and no message arc', () => {
    // The composition lives outside bpmnToPN, so a net built from a pool of a
    // collaboration must look exactly as it did before this feature existed.
    const lc = fixture('realistic-collaboration');
    for (const pool of lc.pools) {
      const pn = bpmnToPN(pool);
      for (const placeId of pn.places.keys()) expect(placeId.startsWith('pmsg_')).toBe(false);
      for (const a of pn.arcs) {
        expect(a.from.startsWith('pmsg_')).toBe(false);
        expect(a.to.startsWith('pmsg_')).toBe(false);
      }
      for (const tId of pn.transitions.keys()) expect(tId).not.toMatch(/__recv_/);
    }
  });

  test('WF01-WF03 results are identical before and after composing', () => {
    // Composition must not mutate the nets it was handed. Running the soundness check,
    // composing in between, and running it again is the direct test of that.
    const lc = fixture('realistic-collaboration');
    const before = checkWorkflowNetSoundness(lc);
    composeCollaboration(lc);
    enumerateCollaboration(lc);
    const after = checkWorkflowNetSoundness(lc);
    expect(after).toEqual(before);
    // And the fixture's WF verdict itself, pinned: five pools, no ERROR anywhere.
    expect(Object.keys(after.stats).sort()).toEqual(lc.pools.map(p => p.id).sort());
    expect(after.issues.filter(i => i.severity === 'ERROR')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Composition mechanics
// ═══════════════════════════════════════════════════════════════════════

describe('collaboration composition — mechanics', () => {
  test('each pool keeps its own source and sink, despite identical local ids', () => {
    // bpmnToPN calls them p_source/p_sink in every pool (workflow-net.js:75-78). Without
    // the pool prefix the five pools would share one source token and four of them could
    // never start — the defect this test exists to keep out.
    const lc = fixture('realistic-collaboration');
    const net = composeCollaboration(lc);

    const marked = [...net.initialMarking.entries()].filter(([, n]) => n > 0).map(([p]) => p);
    expect(marked.sort()).toEqual(lc.pools.map(p => scopedId(p.id, 'p_source')).sort());
    expect(new Set(net.pools.map(p => p.sinkPlace)).size).toBe(lc.pools.length);
  });

  test('every message-flow endpoint of realistic-collaboration resolves as expected', () => {
    // Checked rather than assumed (the node → transition map is not 1:1 in general).
    // In this fixture every endpoint is a plain node with exactly one transition, except
    // ap_wait, which is split because two message flows target it (see below).
    const r = enumerateCollaboration(fixture('realistic-collaboration'));
    const byId = new Map(r.stats.messageFlows.map(m => [m.id, m]));

    expect([...byId.keys()]).toEqual(['mf1', 'mf2', 'mf3', 'mf4', 'mf5', 'mf6', 'mf7', 'mf8']);
    expect(r.stats.unresolvedEndpoints).toEqual([]);
    for (const m of r.stats.messageFlows) {
      expect(m.senderTransitions.length).toBe(m.senderIsBlackBox ? 0 : 1);
      expect(m.receiverTransitions.length).toBe(m.receiverIsBlackBox ? 0 : 1);
    }
    expect(byId.get('mf6').receiverTransitions).toEqual(['Process_Applicant::t_ap_wait__recv_mf6']);
    expect(byId.get('mf8').receiverTransitions).toEqual(['Process_Applicant::t_ap_wait__recv_mf8']);
  });

  test('a node backed by several transitions gets the message arc on all of them', () => {
    // An XOR split as the sender: bpmnToPN makes one transition per outgoing edge
    // (workflow-net.js:111-122), and any one of them firing IS that node executing, so
    // every one must produce the message token.
    const lc = {
      pools: [
        {
          id: 'P_Split',
          nodes: [
            { id: 's', type: 'startEvent' }, { id: 'gw', type: 'exclusiveGateway' },
            { id: 'e1', type: 'endEvent' }, { id: 'e2', type: 'endEvent' },
          ],
          edges: [
            { id: 'k1', source: 's', target: 'gw' },
            { id: 'k2', source: 'gw', target: 'e1', label: 'a' },
            { id: 'k3', source: 'gw', target: 'e2', label: 'b' },
          ],
        },
        {
          id: 'P_Wait',
          nodes: [
            { id: 'w0', type: 'startEvent' }, { id: 'w', type: 'receiveTask' },
            { id: 'w9', type: 'endEvent' },
          ],
          edges: [{ id: 'k4', source: 'w0', target: 'w' }, { id: 'k5', source: 'w', target: 'w9' }],
        },
      ],
      messageFlows: [{ id: 'mx', source: 'gw', target: 'w' }],
    };

    expect(transitionsForNode(bpmnToPN(lc.pools[0]), 'gw')).toEqual(['t_gw_choice_0', 't_gw_choice_1']);

    const r = enumerateCollaboration(lc);
    expect(r.stats.messageFlows[0].senderTransitions).toEqual(
      ['P_Split::t_gw_choice_0', 'P_Split::t_gw_choice_1']);
    // Both branches let the partner through: two scenarios, each completing both pools.
    expect(r.scenarios).toHaveLength(2);
    for (const s of r.scenarios) expect(at(s, 'w')).toBeGreaterThan(at(s, 'gw'));
    expect(r.stats.deadEndPaths).toBe(0);
  });

  // A node that is split because two gated flows target it, and that ALSO sends a flow
  // and receives a third, ungated one. Splitting deletes the pre-split transition id, so
  // every record still naming it dangles — the sender side and the ungated receiver side
  // are not covered by the gated-receiver remap.
  const splitNodeThatAlsoSends = () => ({
    pools: [
      {
        id: 'PR',
        nodes: [
          { id: 'r0', type: 'startEvent' }, { id: 'R', type: 'receiveTask' },
          { id: 'r9', type: 'endEvent' },
        ],
        edges: [{ id: 'r1', source: 'r0', target: 'R' }, { id: 'r2', source: 'R', target: 'r9' }],
      },
      {
        id: 'PA',
        nodes: [{ id: 'a0', type: 'startEvent' }, { id: 'a1', type: 'sendTask' }, { id: 'a9', type: 'endEvent' }],
        edges: [{ id: 'ax', source: 'a0', target: 'a1' }, { id: 'ay', source: 'a1', target: 'a9' }],
      },
      {
        id: 'PB',
        nodes: [{ id: 'b0', type: 'startEvent' }, { id: 'b1', type: 'sendTask' }, { id: 'b9', type: 'endEvent' }],
        edges: [{ id: 'bx', source: 'b0', target: 'b1' }, { id: 'by', source: 'b1', target: 'b9' }],
      },
      {
        id: 'PC',
        nodes: [{ id: 'c0', type: 'startEvent' }, { id: 'c1', type: 'receiveTask' }, { id: 'c9', type: 'endEvent' }],
        edges: [{ id: 'cx', source: 'c0', target: 'c1' }, { id: 'cy', source: 'c1', target: 'c9' }],
      },
    ],
    collapsedPools: [{ id: 'BB', name: 'External' }],
    messageFlows: [
      { id: 'ma', source: 'a1', target: 'R' },   // gated, splits R
      { id: 'mb', source: 'b1', target: 'R' },   // gated, splits R
      { id: 'mc', source: 'R', target: 'c1' },   // the split node as SENDER
      { id: 'md', source: 'BB', target: 'R' },   // the split node as UNGATED receiver
    ],
  });

  test('splitting a node leaves no message record pointing at a transition that no longer exists', () => {
    const lc = splitNodeThatAlsoSends();
    const net = composeCollaboration(lc);
    const r = enumerateCollaboration(lc);

    // The general invariant, which is what a downstream consumer relies on.
    for (const m of r.stats.messageFlows) {
      for (const t of [...m.senderTransitions, ...m.receiverTransitions]) {
        expect(net.transitions.has(t)).toBe(true);
      }
    }
    // The specific stale case: `mc` used to read ['PR::t_R'], an id deleted by the split,
    // so correlating it against a trace said "never sent" while messagesSent said "sent".
    const byId = new Map(r.stats.messageFlows.map(m => [m.id, m]));
    expect(byId.get('mc').senderTransitions).toEqual(
      ['PR::t_R__recv_ma', 'PR::t_R__recv_mb']);
    expect(byId.get('md').receiverTransitions).toEqual(
      ['PR::t_R__recv_ma', 'PR::t_R__recv_mb']);
    // A gated receiver still maps to its OWN clone, not to all of them.
    expect(byId.get('ma').receiverTransitions).toEqual(['PR::t_R__recv_ma']);
    expect(byId.get('mb').receiverTransitions).toEqual(['PR::t_R__recv_mb']);

    // And the two answers now agree: every scenario that says it sent mc contains a
    // transition mc's record names.
    for (const s of r.scenarios) {
      expect(s.messagesSent.includes('mc'))
        .toBe(byId.get('mc').senderTransitions.some(t => s.transitions.includes(t)));
    }
    expect(r.scenarios.some(s => s.messagesSent.includes('mc'))).toBe(true);
  });

  test('a pool without an id cannot take an id another pool already uses', () => {
    // `pool_0` is a legal pool id; handing it to an anonymous pool as a fallback would
    // fuse the two pools' sources into one place.
    const lc = {
      pools: [
        {
          nodes: [{ id: 'n0', type: 'startEvent' }, { id: 'n9', type: 'endEvent' }],
          edges: [{ id: 'n1', source: 'n0', target: 'n9' }],
        },
        {
          id: 'pool_0',
          nodes: [{ id: 'k0', type: 'startEvent' }, { id: 'k9', type: 'endEvent' }],
          edges: [{ id: 'k1', source: 'k0', target: 'k9' }],
        },
      ],
    };
    const net = composeCollaboration(lc);
    expect(new Set(net.pools.map(p => p.poolId)).size).toBe(2);
    expect(new Set(net.pools.map(p => p.sourcePlace)).size).toBe(2);
    expect([...net.initialMarking.entries()].filter(([, n]) => n > 0)).toHaveLength(2);
    expect(enumerateCollaboration(lc).scenarios).toHaveLength(1);
  });

  test('a message place cannot collide with a sequence-flow place', () => {
    const net = composeCollaboration(fixture('realistic-collaboration'));
    for (const mf of fixture('realistic-collaboration').messageFlows) {
      const pid = messagePlaceId(mf.id);
      expect(net.places.has(pid)).toBe(true);
      expect(pid.startsWith('pmsg_')).toBe(true);
    }
    // No prefixed per-pool place can start with pmsg_, because it starts with "<pool>::".
    for (const [pid, p] of net.places) {
      if (p.poolId) expect(pid.startsWith(`${p.poolId}::`)).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Cross-pool synchronisation
// ═══════════════════════════════════════════════════════════════════════

describe('collaboration enumeration — send before receive', () => {
  const lc = fixture('realistic-collaboration');
  const result = enumerateCollaboration(lc);

  test('realistic-collaboration yields exactly one joint scenario, over all five pools', () => {
    // The only completing path: in_gw takes "Yes". The "No" branch forwards nothing, so
    // Assessment, Decision and Archive never receive their messages — a genuine
    // cross-pool dead end, counted as one (see the termination block below).
    expect(result.scenarios).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect(result.poolIds).toEqual(
      ['Process_Applicant', 'Process_Intake', 'Process_Assessment', 'Process_Decision', 'Process_Archive']);
    expect(new Set(result.scenarios[0].poolIds)).toEqual(new Set(result.poolIds));
  });

  test('no receiving node ever precedes its sender, for any gating message flow', () => {
    const gating = result.stats.messageFlows.filter(m => m.gates);
    expect(gating.map(m => m.id)).toEqual(['mf1', 'mf2', 'mf5', 'mf6', 'mf7', 'mf8']);

    // Checked on transitions, not on node ids: ap_wait is the target of two flows and is
    // split accordingly, so "did ap_wait run?" is the wrong question — "did it run on
    // THIS message?" is the right one.
    const firstOf = (s, ids) => s.transitions.findIndex(t => ids.includes(t));
    for (const s of result.scenarios) {
      for (const m of gating) {
        const iRecv = firstOf(s, m.receiverTransitions);
        if (iRecv === -1) continue;           // this message was never received here
        const iSend = firstOf(s, m.senderTransitions);
        expect(iSend).toBeGreaterThanOrEqual(0);
        expect(iSend).toBeLessThan(iRecv);
      }
    }
  });

  test('the mf1 → mf2 chain is ordered end to end', () => {
    const s = result.scenarios[0];
    expect(at(s, 'ap_submit')).toBeLessThan(at(s, 'in_start'));
    expect(at(s, 'in_forward')).toBeLessThan(at(s, 'as_start'));
    expect(at(s, 'as_report')).toBeLessThan(at(s, 'de_start'));
    expect(at(s, 'de_notify')).toBeLessThan(at(s, 'ap_wait'));
    expect(at(s, 'de_notify')).toBeLessThan(at(s, 'ar_start'));
  });

  test('a message that is never sent is a dead end, not a scenario', () => {
    // Without composition each pool completes on its own; the whole point of A2 is that
    // the joint view sees the branch where the partner is left waiting.
    const perPool = lc.pools.map(p => enumerateScenarios(p).scenarios.length);
    expect(perPool.every(n => n > 0)).toBe(true);
    expect(result.stats.deadEndPaths).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Black-box participants
// ═══════════════════════════════════════════════════════════════════════

describe('collaboration enumeration — black-box participants', () => {
  test('Process_Register neither blocks the assessment nor caps it', () => {
    const r = enumerateCollaboration(fixture('realistic-collaboration'));

    expect(r.collapsedPoolIds).toEqual(['Process_Register']);
    // mf4 (register → as_query) enforces no order: the environment always answers.
    expect(r.stats.ungatedMessageFlows.sort()).toEqual(['mf3', 'mf4']);
    // The assessment still runs to its own end, and every pool reaches its sink.
    const s = r.scenarios[0];
    expect(at(s, 'as_query')).toBeGreaterThan(-1);
    expect(at(s, 'as_end')).toBeGreaterThan(at(s, 'as_query'));
    for (const nodeId of ['ap_end', 'in_end_ok', 'as_end', 'de_end', 'ar_end']) {
      expect(at(s, nodeId)).toBeGreaterThan(-1);
    }
  });

  test('the token sent to a black box is named, not hidden', () => {
    // mf3 goes to the collapsed pool, so nothing consumes it. That must not disqualify
    // an otherwise finished run, and it must not disappear either.
    const r = enumerateCollaboration(fixture('realistic-collaboration'));
    expect(r.stats.unconsumedMessagePlaces).toContain(messagePlaceId('mf3'));
    expect(r.scenarios[0].residualPlaces).toEqual([messagePlaceId('mf3')]);
    expect(r.scenarios[0].messagesSent).toContain('mf3');
    expect(r.scenarios[0].messagesReceived).not.toContain('mf3');
  });

  test('a black-box-gated receive may fire more than once — the artificial cap the seeding variant would have imposed', () => {
    // This is why the black box never gates instead of being seeded with one token: the
    // receive sits in a loop, so it runs twice at cycle bound 1. One seeded token would
    // have deadlocked the second lap for a reason the model does not contain.
    const lc = {
      pools: [{
        id: 'P_A',
        nodes: [
          { id: 'a0', type: 'startEvent' }, { id: 'recv', type: 'receiveTask' },
          { id: 'agw', type: 'exclusiveGateway' }, { id: 'a9', type: 'endEvent' },
        ],
        edges: [
          { id: 'w1', source: 'a0', target: 'recv' }, { id: 'w2', source: 'recv', target: 'agw' },
          { id: 'w3', source: 'agw', target: 'recv', label: 'again' },
          { id: 'w4', source: 'agw', target: 'a9', label: 'done' },
        ],
      }],
      collapsedPools: [{ id: 'BB', name: 'External' }],
      messageFlows: [{ id: 'bm', source: 'BB', target: 'recv' }],
    };
    const r = enumerateCollaboration(lc, { cycleBound: 1 });

    expect(r.stats.ungatedMessageFlows).toEqual(['bm']);
    expect(r.scenarios).toHaveLength(2);
    expect(r.scenarios[0].nodes).toEqual(['a0', 'recv', 'agw', 'recv', 'agw', 'a9']);
    expect(r.scenarios[1].nodes).toEqual(['a0', 'recv', 'agw', 'a9']);
    expect(r.stats.deadEndPaths).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Joint termination
// ═══════════════════════════════════════════════════════════════════════

describe('collaboration enumeration — joint termination', () => {
  // P_Ask waits for an answer P_Answer only sends on one of its two branches — so one
  // joint path completes and the other leaves P_Ask waiting forever.
  const twoPools = () => ({
    pools: [
      {
        id: 'P_Ask',
        nodes: [
          { id: 'x0', type: 'startEvent' }, { id: 'ask', type: 'sendTask' },
          { id: 'hear', type: 'receiveTask' }, { id: 'x9', type: 'endEvent' },
        ],
        edges: [
          { id: 'x1', source: 'x0', target: 'ask' }, { id: 'x2', source: 'ask', target: 'hear' },
          { id: 'x3', source: 'hear', target: 'x9' },
        ],
      },
      {
        id: 'P_Answer',
        nodes: [
          { id: 'y0', type: 'startEvent' }, { id: 'work', type: 'userTask' },
          { id: 'ygw', type: 'exclusiveGateway' }, { id: 'reply', type: 'sendTask' },
          { id: 'y9', type: 'endEvent' }, { id: 'y8', type: 'endEvent' },
        ],
        edges: [
          { id: 'y1', source: 'y0', target: 'work' }, { id: 'y2', source: 'work', target: 'ygw' },
          { id: 'y3', source: 'ygw', target: 'reply', label: 'answer' },
          { id: 'y4', source: 'reply', target: 'y9' },
          { id: 'y5', source: 'ygw', target: 'y8', label: 'drop' },
        ],
      },
    ],
    messageFlows: [
      { id: 'q', source: 'ask', target: 'y0' },
      { id: 'a', source: 'reply', target: 'hear' },
    ],
  });

  test('one pool finishing is not a scenario — every real pool must reach its sink', () => {
    // On the "drop" branch P_Answer reaches its own sink and P_Ask hangs on `hear`
    // forever. That is exactly the cross-pool deadlock a per-pool analysis cannot see,
    // and it must be counted as a dead end rather than recorded as a finished joint run.
    const r = enumerateCollaboration(twoPools());

    expect(r.scenarios).toHaveLength(1);
    expect(r.stats.deadEndPaths).toBe(1);
    expect(r.stats.cappedPaths).toBe(0);
    expect(r.scenarios[0].nodes).toEqual(
      ['x0', 'ask', 'y0', 'work', 'ygw', 'reply', 'y9', 'hear', 'x9']);

    // Each pool on its own completes on both branches — the dead end only exists jointly.
    for (const pool of twoPools().pools) {
      const solo = enumerateScenarios(pool);
      expect(solo.scenarios.length).toBeGreaterThan(0);
      expect(solo.stats.deadEndPaths).toBe(0);
    }
  });

  test('a scenario is recorded only once the net has run dry', () => {
    // The single-process rule generalised: not "a sink was touched" but "nothing can fire
    // any more, and every pool's sink holds a token". P_Answer's tail (y9) sits after the
    // reply and must still appear in the trace.
    const r = enumerateCollaboration(twoPools());
    const s = r.scenarios[0];
    const net = composeCollaboration(twoPools());
    const marking = s.transitions.reduce((m, t) => fireTransition(m, t, net.arcs),
      new Map(net.initialMarking));
    expect(getEnabledTransitions(marking, net.transitions, net.arcs)).toEqual([]);
    for (const p of net.pools) expect(marking.get(p.sinkPlace)).toBe(1);
    expect(s.residualPlaces).toEqual([]);
    expect(s.sinkTokens).toEqual({ P_Ask: 1, P_Answer: 1 });
  });

  test('improper completion at the shared sink is visible, not filtered away', () => {
    // bpmnToPN wires every end event to ONE sink (workflow-net.js:161/181), so an AND
    // fork ending at two end events lands two tokens there. residualPlaces excludes the
    // sinks — a token there is the point — which used to make this read as a clean
    // finish. sinkTokens is where it shows.
    const lc = {
      pools: [{
        id: 'P_TwoEnds',
        nodes: [
          { id: 's', type: 'startEvent' }, { id: 'fork', type: 'parallelGateway' },
          { id: 'x', type: 'userTask' }, { id: 'y', type: 'userTask' },
          { id: 'e1', type: 'endEvent' }, { id: 'e2', type: 'endEvent' },
        ],
        edges: [
          { id: 'a1', source: 's', target: 'fork' }, { id: 'a2', source: 'fork', target: 'x' },
          { id: 'a3', source: 'fork', target: 'y' }, { id: 'a4', source: 'x', target: 'e1' },
          { id: 'a5', source: 'y', target: 'e2' },
        ],
      }],
    };
    const s = enumerateCollaboration(lc).scenarios[0];

    expect(s.nodes).toEqual(['s', 'fork', 'x', 'e1', 'y', 'e2']);
    expect(s.residualPlaces).toEqual([]);          // by design: sinks are excluded there
    expect(s.sinkTokens).toEqual({ P_TwoEnds: 2 }); // and this is where >1 becomes visible
    // Still no verdict of our own — naming it improper completion is WF03's job.
    expect(JSON.stringify(s)).not.toMatch(/improper|deadlock|unsound|WF0/i);
  });

  test('a normal single-end run reports exactly one token per sink', () => {
    const r = enumerateCollaboration(fixture('realistic-collaboration'));
    expect(r.scenarios[0].sinkTokens).toEqual({
      Process_Applicant: 1, Process_Intake: 1, Process_Assessment: 1,
      Process_Decision: 1, Process_Archive: 1,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Cycle bounds across pools
// ═══════════════════════════════════════════════════════════════════════

describe('collaboration enumeration — per-pool cycle bounds suffice', () => {
  // The case the plan could not settle up front: a partner that keeps sending inside its
  // own loop, into a pool with no cycle of its own. If composition could add firings, the
  // receiver would run away here.
  const loopSender = () => ({
    pools: [
      {
        id: 'P_Send',
        nodes: [
          { id: 's', type: 'startEvent' }, { id: 'send', type: 'sendTask' },
          { id: 'gw', type: 'exclusiveGateway' }, { id: 'e', type: 'endEvent' },
        ],
        edges: [
          { id: 'z1', source: 's', target: 'send' }, { id: 'z2', source: 'send', target: 'gw' },
          { id: 'z3', source: 'gw', target: 'send', label: 'again' },
          { id: 'z4', source: 'gw', target: 'e', label: 'done' },
        ],
      },
      {
        id: 'P_Recv',
        nodes: [
          { id: 'r0', type: 'startEvent' }, { id: 'r', type: 'receiveTask' },
          { id: 'r9', type: 'endEvent' },
        ],
        edges: [{ id: 'y1', source: 'r0', target: 'r' }, { id: 'y2', source: 'r', target: 'r9' }],
      },
    ],
    messageFlows: [{ id: 'm', source: 'send', target: 'r' }],
  });

  test('the receiver fires exactly once however often the partner loops', () => {
    // The reason no extra bound is needed: a message place only ever ADDS an input
    // requirement to a receiver, never a token on one of its sequence-flow places. The
    // receiver's firing count therefore stays bounded by its own graph, which has no
    // cycle at all — so one firing, at every bound.
    for (const cycleBound of [0, 1, 3, 5]) {
      const r = enumerateCollaboration(loopSender(), { cycleBound });
      expect(r.truncated).toBe(false);
      for (const s of r.scenarios) {
        expect(s.nodes.filter(n => n === 'r')).toHaveLength(1);
        expect(s.nodes.filter(n => n === 'send').length).toBeLessThanOrEqual(cycleBound + 1);
      }
    }
  });

  test('the scenario count grows with the bound of the looping pool, and stays finite', () => {
    const counts = [0, 1, 2, 3].map(cycleBound =>
      enumerateCollaboration(loopSender(), { cycleBound }).scenarios.length);
    expect(counts).toEqual([1, 2, 3, 4]); // one scenario per number of laps allowed
    // The back edge belongs to the sending pool and is reported with it; the receiving
    // pool contributes none, and needs none.
    const r = enumerateCollaboration(loopSender(), { cycleBound: 1 });
    expect(r.stats.backwardEdges).toEqual([{
      id: 'z3', source: 'gw', target: 'send',
      placeId: 'P_Send::p_gw_send', poolId: 'P_Send',
    }]);
    expect(r.scenarios[0].cycleUseCounts).toEqual({ 'P_Send::p_gw_send': 1 });
  });

  test('message tokens the partner over-produces accumulate without gating anything', () => {
    // The one visible consequence of a looping sender: the message place ends up holding
    // the surplus. It is reported as residual, it does not stop the run, and it is not a
    // new unbounded dimension — its size is the sender's own bound.
    const r = enumerateCollaboration(loopSender(), { cycleBound: 1 });
    const looped = r.scenarios.find(s => s.nodes.filter(n => n === 'send').length === 2);
    expect(looped.residualPlaces).toEqual([messagePlaceId('m')]);
    expect(looped.messagesReceived).toEqual(['m']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The partial-overlap invariant (named risk from Task 1's review)
// ═══════════════════════════════════════════════════════════════════════

describe('collaboration enumeration — groupBySharedInput under partial overlap', () => {
  /** every group the walk would form, over all reachable states, plus its input sets */
  const groupsOverStateSpace = (lc, maxDepth = 40) => {
    const net = composeCollaboration(lc);
    const { inputs } = indexArcs(net.transitions, net.arcs);
    const seen = new Set();
    const found = [];
    const key = (m) => [...m.entries()].filter(([, n]) => n > 0)
      .map(([p, n]) => `${p}=${n}`).sort().join(',');
    const walk = (marking, depth) => {
      if (depth > maxDepth || seen.has(key(marking))) return;
      seen.add(key(marking));
      const enabled = getEnabledTransitions(marking, net.transitions, net.arcs).slice().sort();
      for (const g of groupBySharedInput(enabled, inputs)) found.push({ marking, group: g });
      for (const t of enabled) walk(fireTransition(marking, t, net.arcs), depth + 1);
    };
    walk(net.initialMarking, 0);
    return { net, inputs, found };
  };

  const overlapPairs = ({ inputs, found }) => {
    const pairs = [];
    for (const { group } of found) {
      for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
        const A = new Set(inputs.get(group[i]) || []), B = new Set(inputs.get(group[j]) || []);
        const shared = [...A].filter(p => B.has(p));
        if (shared.length && (shared.length !== A.size || shared.length !== B.size)) {
          pairs.push([group[i], group[j]]);
        }
      }
    }
    return pairs;
  };

  test('realistic-collaboration never puts two partially overlapping transitions in one group', () => {
    // Measured, not assumed: ap_wait's two split transitions do overlap partially, but
    // only one of them is ever enabled (mf8's sender hangs off a boundary timer that
    // bpmnToPN leaves unfireable), so no group ever contains both.
    expect(overlapPairs(groupsOverStateSpace(fixture('realistic-collaboration')))).toEqual([]);
  });

  // An implicit merge (two incoming sequence flows) that is ALSO the target of two
  // message flows: bpmnToPN's merge split crossed with this module's message split gives
  // four transitions for one node, whose input sets overlap pairwise but not fully.
  const mergeTimesMessages = () => ({
    pools: [
      {
        id: 'P_R',
        nodes: [
          { id: 'q0', type: 'startEvent' }, { id: 'fork', type: 'parallelGateway' },
          { id: 'x', type: 'userTask' }, { id: 'y', type: 'userTask' },
          { id: 'R', type: 'receiveTask' }, { id: 'q9', type: 'endEvent' },
        ],
        edges: [
          { id: 'q1', source: 'q0', target: 'fork' }, { id: 'q2', source: 'fork', target: 'x' },
          { id: 'q3', source: 'fork', target: 'y' }, { id: 'q4', source: 'x', target: 'R' },
          { id: 'q5', source: 'y', target: 'R' }, { id: 'q6', source: 'R', target: 'q9' },
        ],
      },
      {
        id: 'P_S1',
        nodes: [{ id: 'u0', type: 'startEvent' }, { id: 'u1', type: 'sendTask' }, { id: 'u9', type: 'endEvent' }],
        edges: [{ id: 'u_a', source: 'u0', target: 'u1' }, { id: 'u_b', source: 'u1', target: 'u9' }],
      },
      {
        id: 'P_S2',
        nodes: [{ id: 'v0', type: 'startEvent' }, { id: 'v1', type: 'sendTask' }, { id: 'v9', type: 'endEvent' }],
        edges: [{ id: 'v_a', source: 'v0', target: 'v1' }, { id: 'v_b', source: 'v1', target: 'v9' }],
      },
    ],
    messageFlows: [
      { id: 'ma', source: 'u1', target: 'R' },
      { id: 'mb', source: 'v1', target: 'R' },
    ],
  });

  test('an implicit merge that is also a message target breaks the invariant — reproduced', () => {
    const state = groupsOverStateSpace(mergeTimesMessages());
    const pairs = overlapPairs(state);
    expect(pairs.length).toBeGreaterThan(0);
    // e.g. {p_x_R, pmsg_ma} against {p_y_R, pmsg_ma}: one shared place, one not.
    const [a, b] = pairs[0];
    const A = state.inputs.get(a), B = state.inputs.get(b);
    expect(A.filter(p => B.includes(p)).length).toBe(1);
    expect(A.length).toBe(2);
    expect(B.length).toBe(2);
  });

  test('the grouping stays safe: no alternative is lost, only orders can repeat', () => {
    // The consequence of the broken invariant, spelled out. Both consistent pairings of
    // the two messages onto the two merge branches are enumerated — nothing is collapsed
    // away. What over-grouping can cost is redundancy, never coverage.
    const r = enumerateCollaboration(mergeTimesMessages());

    expect(r.scenarios).toHaveLength(2);
    expect(r.stats.deadEndPaths).toBe(0);
    for (const s of r.scenarios) {
      expect(s.messagesReceived.sort()).toEqual(['ma', 'mb']);
      expect(s.nodes.filter(n => n === 'R')).toHaveLength(2);
    }
    const pairings = r.scenarios.map(s => s.transitions.filter(t => t.includes('__recv_')).sort().join('|'));
    expect(new Set(pairings).size).toBe(2); // the two pairings are distinct, not duplicates
  });
});

// ═══════════════════════════════════════════════════════════════════════
// The composed contract
// ═══════════════════════════════════════════════════════════════════════

describe('collaboration enumeration — the composed scenario shape', () => {
  const r = enumerateCollaboration(fixture('realistic-collaboration'));

  test('every scenario carries Task 1 fields plus poolIds, messages and residuals', () => {
    for (const s of r.scenarios) {
      expect(Object.keys(s).sort()).toEqual([
        'cycleUseCounts', 'index', 'interleavingCount', 'messagesReceived', 'messagesSent',
        'nodes', 'poolIds', 'residualPlaces', 'sinkTokens', 'transitions',
      ]);
      expect(Object.keys(s.sinkTokens)).toEqual(r.poolIds);
      expect(s.nodes).toHaveLength(s.transitions.length);
      expect(s.poolIds).toHaveLength(s.transitions.length);
      for (let i = 0; i < s.transitions.length; i++) {
        expect(s.transitions[i].startsWith(`${s.poolIds[i]}::`)).toBe(true);
      }
      expect(typeof s.interleavingCount === 'number' || s.interleavingCount === null).toBe(true);
    }
  });

  test('a single-pool document composes to the same trace the single-process enumerator gives', () => {
    // The contract extension has to be an extension: with no message flow to compose,
    // the joint walk must reproduce the Task 1 result node for node.
    const lc = fixture('simple-approval');
    const single = enumerateScenarios(lc.pools[0]);
    const joint = enumerateCollaboration(lc);

    expect(joint.scenarios.map(s => s.nodes)).toEqual(single.scenarios.map(s => s.nodes));
    expect(joint.stats.scenarioCount).toBe(single.stats.scenarioCount);
    expect(joint.poolIds).toEqual([lc.pools[0].id]);
    expect(joint.scenarios[0].messagesSent).toEqual([]);
  });

  test('the enumeration is deterministic across runs', () => {
    const a = enumerateCollaboration(fixture('realistic-collaboration'));
    const b = enumerateCollaboration(fixture('realistic-collaboration'));
    expect(b.scenarios.map(s => s.transitions)).toEqual(a.scenarios.map(s => s.transitions));
  });

  test('caps are visible on the composed run too', () => {
    const capped = enumerateCollaboration(fixture('realistic-collaboration'), { maxScenarios: 0 });
    expect(capped.scenarios).toHaveLength(0);
    expect(capped.truncated).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// B10 — a message flow naming a subprocess container
// ═══════════════════════════════════════════════════════════════════════

describe('B10 — a container is refused as a message-flow endpoint', () => {
  const lc = () => fixture('messageflow-to-subprocess');

  test('the container has an entry/exit PAIR, which is what makes the naive wiring a double send', () => {
    // The premise of the guard, stated as a fact about the net rather than assumed: since
    // Stage 1, `fulfil` owns two transitions, both carrying its `bpmnNodeId`.
    const pn = bpmnToPN(lc().pools[1]);
    expect(transitionsForNode(pn, 'fulfil').sort()).toEqual(['t_fulfil#enter', 't_fulfil#exit']);
  });

  test('no arc runs from either container transition into the message place', () => {
    const net = composeCollaboration(lc());
    const placeId = messagePlaceId('mf_container');
    const touching = net.arcs.filter(a => a.from === placeId || a.to === placeId);
    // Zero, not one: this is the evidence the double send cannot happen. Without the guard
    // `resolve()` would return both transitions and pass 1 would push a `T→P` arc from each.
    expect(touching).toEqual([]);
    expect(net.arcs.some(a => a.from === scopedId('Pool_Vendor', 't_fulfil#exit'))).toBe(true);
    expect(net.arcs.some(a => a.from === scopedId('Pool_Vendor', 't_fulfil#exit') && a.to === placeId)).toBe(false);
    expect(net.arcs.some(a => a.from === scopedId('Pool_Vendor', 't_fulfil#enter') && a.to === placeId)).toBe(false);
  });

  test('the container flow does not gate, and says why', () => {
    const net = composeCollaboration(lc());
    const mp = net.messagePlaces.find(m => m.messageFlowId === 'mf_container');
    // `gates` needs no change for this to hold — `'container' !== 'node'` — but the brief asks
    // for it to be confirmed rather than assumed, so it is asserted here.
    expect(mp.gates).toBe(false);
    expect(mp.senderKind).toBe('container');
    expect(mp.senderTransitions).toEqual([]);
    expect(mp.senderIsBlackBox).toBe(false);
    expect(net.unresolved).toEqual([
      { messageFlowId: 'mf_container', endpoint: 'source', id: 'fulfil', reason: 'container' },
    ]);
  });

  test('a flow naming a node INSIDE the container still gates normally', () => {
    const net = composeCollaboration(lc());
    const mp = net.messagePlaces.find(m => m.messageFlowId === 'mf_inner');
    expect(mp.gates).toBe(true);
    expect(mp.senderKind).toBe('node');
    expect(mp.receiverKind).toBe('node');
    expect(net.arcs).toContainEqual({
      from: messagePlaceId('mf_inner'), to: scopedId('Pool_Vendor', 't_inner_recv'), type: 'P→T',
    });
  });

  test('stats distinguish an unmapped endpoint from a black box', () => {
    const stats = enumerateCollaboration(lc()).stats;
    const byId = new Map(stats.messageFlows.map(m => [m.id, m]));
    expect(byId.get('mf_container').ungatedReason).toBe('unmappedEndpoint');
    expect(byId.get('mf_inner').ungatedReason).toBeNull();
    expect(stats.ungatedMessageFlows).toEqual(['mf_container']);
    expect(stats.unresolvedEndpoints[0].reason).toBe('container');
  });

  test('a black-box endpoint is still reported as a choice, not as a defect', () => {
    const stats = enumerateCollaboration(fixture('realistic-collaboration')).stats;
    const ungated = stats.messageFlows.filter(m => !m.gates);
    expect(ungated.length).toBeGreaterThan(0);
    for (const mf of ungated) expect(mf.ungatedReason).toBe('blackBox');
  });

  test('the collaboration still enumerates to completion', () => {
    const run = enumerateCollaboration(lc());
    expect(run.scenarios.length).toBeGreaterThan(0);
    expect(run.stats.deadEndPaths).toBe(0);
    // The ungated message place keeps its token — nothing consumes it. That is a residual, not
    // an unfinished process (module header), and both pools' sinks hold exactly one token.
    expect(run.scenarios[0].sinkTokens).toEqual({ Pool_Customer: 1, Pool_Vendor: 1 });
  });

  test('checkNetIntegrity still passes on both pools of the fixture', () => {
    for (const pool of lc().pools) {
      expect(checkNetIntegrity(bpmnToPN(pool), pool).ok).toBe(true);
    }
  });
});

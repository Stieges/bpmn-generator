/**
 * Feedback / rework edges must not pull the loop XOR left of the happy path.
 * Mini-fixture mirrors SME circulate: auto-join at Collect / Circulate targets,
 * Review-closed? gateway after Finalize, outs back to those joins + Yes forward.
 */
import { describe, test, expect } from '@jest/globals';
import { loadConfig } from '../shared/utils.js';
import { identifyFeedbackEdges, preprocessLogicCore, normalizeEdgeIds } from './topology.js';
import { runPipeline } from './pipeline.js';

loadConfig();

const smeLoopMini = () => ({
  id: 'sme_loop_mini',
  name: 'SME Loop Mini',
  lanes: [
    { id: 'lane_author', name: 'Policy Author' },
    { id: 'lane_themis', name: 'Themis' },
    { id: 'lane_sme', name: 'SME Reviewer' },
  ],
  nodes: [
    { id: 'Start', type: 'startEvent', name: 'Start', lane: 'lane_themis' },
    { id: 'T21', type: 'userTask', name: 'Circulate Review Doc', lane: 'lane_themis' },
    { id: 'T22', type: 'userTask', name: 'Verify Roster', lane: 'lane_author' },
    { id: 'T23', type: 'userTask', name: 'Send Review Email', lane: 'lane_author' },
    { id: 'T24', type: 'userTask', name: 'Collect SME Feedback', lane: 'lane_sme' },
    { id: 'T25', type: 'userTask', name: 'Finalize Closeout', lane: 'lane_author' },
    { id: 'GW', type: 'exclusiveGateway', name: 'Review closed?', lane: 'lane_author' },
    { id: 'T26', type: 'userTask', name: 'Send Approval Email', lane: 'lane_author' },
    { id: 'End', type: 'endEvent', name: 'End', lane: 'lane_author' },
  ],
  edges: [
    { id: 'e0', source: 'Start', target: 'T21' },
    { id: 'e1', source: 'T21', target: 'T22' },
    { id: 'e2', source: 'T22', target: 'T23' },
    { id: 'e3', source: 'T23', target: 'T24' },
    { id: 'e4', source: 'T24', target: 'T25' },
    { id: 'e5', source: 'T25', target: 'GW' },
    { id: 'e6', source: 'GW', target: 'T26', label: 'Yes', isHappyPath: true },
    { id: 'e7', source: 'GW', target: 'T21', label: 'Re-circulate' },
    { id: 'e8', source: 'GW', target: 'T24', label: 'More feedback', isDefault: true },
    { id: 'e9', source: 'T26', target: 'End' },
  ],
});

describe('identifyFeedbackEdges', () => {
  test('marks GW→early targets as feedback after auto-join', () => {
    const lc = smeLoopMini();
    normalizeEdgeIds(lc);
    preprocessLogicCore(lc);
    const fb = identifyFeedbackEdges(lc.nodes, lc.edges);
    expect(fb.has('e7')).toBe(true);
    expect(fb.has('e8')).toBe(true);
    expect(fb.has('e6')).toBe(false);
    expect(fb.has('e5')).toBe(false);
  });
});

describe('SME circulate loop layout', () => {
  test('Review-closed? gateway stays right of Finalize Closeout', async () => {
    const result = await runPipeline(smeLoopMini());
    expect(result.validation.errors).toEqual([]);
    expect(result.coordMap?.coords?.T25).toBeTruthy();
    expect(result.coordMap?.coords?.GW).toBeTruthy();
    const t25 = result.coordMap.coords.T25;
    const gw = result.coordMap.coords.GW;
    const t26 = result.coordMap.coords.T26;
    // Gateway must not sit left of Finalize (the pre-fix failure mode).
    expect(gw.x).toBeGreaterThan(t25.x - 1);
    // Yes path continues rightward.
    expect(t26.x).toBeGreaterThan(gw.x - 1);
  }, 60000);
});

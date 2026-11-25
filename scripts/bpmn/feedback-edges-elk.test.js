/**
 * DFS feedback (rework) edges and ELK layering — `layout.feedbackEdges`.
 * The review-loop model: auto-joins where the loop re-enters (Prepare / Collect), a
 * "Review closed?" gateway after Finalize, two outs back to those joins and a Yes forward.
 * Left to ELK's own cycle breaking (mode 'elk'), the gateway landed left of Finalize.
 */
import { describe, test, expect, afterEach } from '@jest/globals';
import { CFG, loadConfig } from '../shared/utils.js';
import {
  identifyFeedbackEdges, identifyFeedbackEdgesDeep, feedbackEdgeMode, preprocessLogicCore, normalizeEdgeIds,
} from './topology.js';
import { runPipeline } from './pipeline.js';
import { exitSide, entrySide } from './bend-rule.js';

loadConfig();
const savedMode = CFG.layout.feedbackEdges;
afterEach(() => { CFG.layout.feedbackEdges = savedMode; });

const reviewLoop = () => ({
  id: 'review_loop',
  name: 'Review Loop',
  lanes: [
    { id: 'lane_author', name: 'Author' },
    { id: 'lane_office', name: 'Review Office' },
    { id: 'lane_reviewer', name: 'Reviewer' },
  ],
  nodes: [
    { id: 'Start', type: 'startEvent', name: 'Start', lane: 'lane_office' },
    { id: 'T21', type: 'userTask', name: 'Prepare Review', lane: 'lane_office' },
    { id: 'T22', type: 'userTask', name: 'Verify Roster', lane: 'lane_author' },
    { id: 'T23', type: 'userTask', name: 'Send Review Request', lane: 'lane_author' },
    { id: 'T24', type: 'userTask', name: 'Collect Feedback', lane: 'lane_reviewer' },
    { id: 'T25', type: 'userTask', name: 'Finalize Review', lane: 'lane_author' },
    { id: 'GW', type: 'exclusiveGateway', name: 'Review closed?', lane: 'lane_author' },
    { id: 'T26', type: 'userTask', name: 'Send Approval', lane: 'lane_author' },
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
    { id: 'e7', source: 'GW', target: 'T21', label: 'Restart review' },
    { id: 'e8', source: 'GW', target: 'T24', label: 'More feedback', isDefault: true },
    { id: 'e9', source: 'T26', target: 'End' },
  ],
});

describe('identifyFeedbackEdges', () => {
  test('marks the gateway outs back to earlier auto-joins', () => {
    const lc = reviewLoop();
    normalizeEdgeIds(lc);
    preprocessLogicCore(lc);
    const fb = identifyFeedbackEdges(lc.nodes, lc.edges);
    expect(fb.has('e7')).toBe(true);
    expect(fb.has('e8')).toBe(true);
    expect(fb.has('e6')).toBe(false);
    expect(fb.has('e5')).toBe(false);
  });

  test('finds a cycle no start event reaches (behind a boundary event, or disconnected)', () => {
    const nodes = [
      { id: 's', type: 'startEvent' }, { id: 't', type: 'task' },
      { id: 'b', type: 'boundaryEvent', attachedTo: 't' }, { id: 'x', type: 'task' }, { id: 'y', type: 'task' },
      { id: 'p', type: 'task' }, { id: 'q', type: 'task' },
    ];
    const edges = [
      { id: 'st', source: 's', target: 't' },
      { id: 'bx', source: 'b', target: 'x' }, { id: 'xy', source: 'x', target: 'y' }, { id: 'yx', source: 'y', target: 'x' },
      { id: 'pq', source: 'p', target: 'q' }, { id: 'qp', source: 'q', target: 'p' },
    ];
    const fb = identifyFeedbackEdges(nodes, edges);
    expect(fb.has('yx')).toBe(true);
    expect(fb.has('qp') || fb.has('pq')).toBe(true);
    expect(fb.size).toBe(2);
  });

  test('a very long chain does not overflow the stack', () => {
    const n = 50000;
    const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, type: i ? 'task' : 'startEvent' }));
    const edges = Array.from({ length: n - 1 }, (_, i) => ({ id: `e${i}`, source: `n${i}`, target: `n${i + 1}` }));
    edges.push({ id: 'back', source: `n${n - 1}`, target: 'n1' });
    expect([...identifyFeedbackEdges(nodes, edges)]).toEqual(['back']);
  });

  test('Deep finds a loop inside an expanded subprocess; mode elk finds none', () => {
    const proc = {
      nodes: [
        { id: 's', type: 'startEvent' }, { id: 'e', type: 'endEvent' },
        { id: 'sp', type: 'subProcess', isExpanded: true,
          nodes: [{ id: 'cs', type: 'startEvent' }, { id: 'c1', type: 'task' }, { id: 'c2', type: 'task' }],
          edges: [{ id: 'c_a', source: 'cs', target: 'c1' }, { id: 'c_b', source: 'c1', target: 'c2' }, { id: 'c_back', source: 'c2', target: 'c1' }] },
      ],
      edges: [{ id: 'a', source: 's', target: 'sp' }, { id: 'b', source: 'sp', target: 'e' }],
    };
    expect([...identifyFeedbackEdgesDeep(proc)]).toEqual(['c_back']);
    CFG.layout.feedbackEdges = 'elk';
    expect(feedbackEdgeMode()).toBe('elk');
    expect(identifyFeedbackEdgesDeep(proc).size).toBe(0);
  });
});

describe('review loop layout', () => {
  for (const mode of ['reverse', 'drop']) {
    test(`${mode}: the Review-closed? gateway stays right of Finalize`, async () => {
      CFG.layout.feedbackEdges = mode;
      const { coords } = (await runPipeline(reviewLoop())).coordMap;
      expect(coords.GW.x).toBeGreaterThan(coords.T25.x - 1);
      expect(coords.T26.x).toBeGreaterThan(coords.GW.x - 1);
      // Fan-out align must not park the loop targets under the Yes column.
      expect(coords.T21.x).toBeLessThan(coords.T25.x);
      expect(coords.T24.x).toBeLessThan(coords.T25.x + 1);
    }, 60000);
  }

  test('reverse keeps the loop at least as short as drop', async () => {
    const width = async (mode) => {
      CFG.layout.feedbackEdges = mode;
      const { coords } = (await runPipeline(reviewLoop())).coordMap;
      return Math.max(...Object.values(coords).map((c) => c.x + c.w));
    };
    expect(await width('reverse')).toBeLessThanOrEqual(await width('drop'));
  }, 60000);
});

describe('§5.2 back-edge route', () => {
  test('with every repair off, a rework loop leaves right, re-enters right and misses its own shapes', async () => {
    const lc = {
      id: 'p', name: 'P',
      nodes: [
        { id: 's', type: 'startEvent', name: 'S' }, { id: 'a', type: 'task', name: 'Draft' },
        { id: 'b', type: 'task', name: 'Check' }, { id: 'g', type: 'exclusiveGateway', name: 'OK?' },
        { id: 'c', type: 'task', name: 'Fix' }, { id: 'e', type: 'endEvent', name: 'E' },
      ],
      edges: [
        { id: 'f1', source: 's', target: 'a' }, { id: 'f2', source: 'a', target: 'b' },
        { id: 'f3', source: 'b', target: 'g' }, { id: 'f4', source: 'g', target: 'e', label: 'yes' },
        { id: 'f5', source: 'g', target: 'c', label: 'no' }, { id: 'f6', source: 'c', target: 'a' },
      ],
    };
    const r = await runPipeline(lc, { bendRule: false, foreignShapeRepair: false, visualRefinement: false });
    const pts = r.coordMap.edgeCoords.f6;
    expect(exitSide(pts)).toBe('right');
    expect(entrySide(pts)).toBe('right');   // a return flow re-enters from the right (Miragon)
    expect((r.diagnostics.issues || []).filter((i) => i.code === 'DI09')).toEqual([]);
  }, 60000);
});

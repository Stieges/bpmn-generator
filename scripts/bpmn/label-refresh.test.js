/**
 * A route pass that replaces an edge's route must take its label along. The crossing guard
 * (guardAgainstLegacy) reverts single edges to their legacy route; no committed fixture makes it
 * revert one, so this file forces a revert of a labelled edge and checks the label follows.
 */
import { describe, test, expect, jest } from '@jest/globals';
import { readFileSync } from 'fs';
import { CFG } from '../shared/utils.js';

const actual = await import('./edge-simplify.js');
let revertedId = null;
let guardRoute = null;

jest.unstable_mockModule('./edge-simplify.js', () => ({
  ...actual,
  // Revert the first labelled edge whose legacy route differs from the current one, as the guard
  // does when that edge's new route costs a crossing.
  guardAgainstLegacy: (routes, legacyRoutes, coords, edges) => {
    const e = edges.find(x => x.label && legacyRoutes[x.id]
      && JSON.stringify(legacyRoutes[x.id]) !== JSON.stringify(routes[x.id]));
    if (!e) return { routes, reverted: [] };
    revertedId = e.id;
    guardRoute = legacyRoutes[e.id];
    return { routes: { ...routes, [e.id]: legacyRoutes[e.id] }, reverted: [e.id] };
  },
}));

const { runPipeline } = await import('./pipeline.js');
const { computeSequenceFlowLabel } = await import('./coordinates.js');

describe('edge labels follow a route the crossing guard reverted', () => {
  test('simple-approval: the reverted edge is labelled on its final route', async () => {
    const lc = JSON.parse(readFileSync('../tests/fixtures/simple-approval.json', 'utf8'));
    // The endpoint re-clip runs after the guard and would refresh the label on its own when it
    // moves the reverted route — switched off so the guard is the last pass to touch the route.
    const reclip = CFG.layout.endpointReclip;
    let r;
    try {
      CFG.layout.endpointReclip = false;
      r = await runPipeline(lc, { visualRefinement: false });
    } finally {
      CFG.layout.endpointReclip = reclip;
    }
    expect(revertedId).not.toBeNull();
    const edge = (lc.pools || [lc]).flatMap(p => p.edges || []).find(e => e.id === revertedId);
    expect(r.coordMap.edgeCoords[revertedId]).toBe(guardRoute);
    const want = computeSequenceFlowLabel(edge, r.coordMap.edgeCoords[revertedId], r.coordMap.coords);
    expect(r.coordMap.edgeLabels[revertedId]).toEqual(want);
  });
});

/**
 * DMN Layout — Decision-Core → ELK Graph → laid-out graph.
 *
 * Structurally mirrors scripts/bpmn/layout.js (same ELK bootstrap: the bundled build, the
 * 'properties' key for layout options, a new ELK() instance per call) but the shape is different —
 * a DRD is a flat DAG with no lanes or pools, laid out top-to-bottom by dependency direction
 * (elk.direction: 'UP') rather than left-to-right by process flow.
 */

import ELK from 'elkjs/lib/elk.bundled.js';
import { CFG } from '../shared/utils.js';
import { DRD_SHAPE, DRD_SPACING } from './constants.js';

/**
 * Decision-Core → ELK graph (plain object, not yet laid out).
 *
 * Requirement edges point source -> target exactly as Decision-Core declares them (the required
 * element is the source, the requiring element the target). Under elk.direction: 'UP' this places
 * the source (e.g. an InputData) at the larger y and the target (e.g. the Decision that requires
 * it) at the smaller y, with no y-flip needed on this module's side — confirmed empirically against
 * this project's installed elkjs, both for a 3-node chain and for a branching graph (see
 * docs/superpowers/research/dmn-external-ground-truth.md §C.10 and layout.test.js).
 *
 * @param {object} dc - Decision-Core JSON
 * @returns {object} ELK graph
 */
function decisionCoreToElk(dc) {
  const nodes = dc.nodes ?? [];
  const requirements = dc.requirements ?? [];

  return {
    id: 'root',
    properties: {
      ...CFG.elk.dmn,
      'elk.spacing.nodeNode': `${DRD_SPACING.nodeNode}`,
      'elk.layered.spacing.nodeNodeBetweenLayers': `${DRD_SPACING.layerNode}`,
      'elk.padding': `[top=${DRD_SPACING.margin},left=${DRD_SPACING.margin},bottom=${DRD_SPACING.margin},right=${DRD_SPACING.margin}]`,
    },
    children: nodes.map(n => {
      const sz = DRD_SHAPE[n.type] || DRD_SHAPE.decision;
      return { id: n.id, width: sz.w, height: sz.h };
    }),
    // `r.id || `req_${i}`` is deliberately a DIFFERENT fallback formula from Global Constraint 8's
    // requirementKey (`req.id || `req_${req.source}_${req.target}``, defined later in Task 3's
    // coordinates.js and used to key edgeCoords/the DMNDI element map). That divergence would be
    // exactly the #36-shaped bug Constraint 8 exists to prevent if anything downstream joined on
    // this id — nothing does. ELK's own edge routes (`result.edges[].sections`) are discarded by
    // runDmnElkLayout's caller (see that function's doc comment); this id only has to be unique
    // within one ELK graph for ELK's internal bookkeeping, never compared against requirementKey's
    // output. Do not "fix" this to import requirementKey — coordinates.js does not exist yet at
    // this point in the plan, and layout.js must not depend on it either way (Task 3 depends on
    // Task 2, not the reverse).
    edges: requirements.map((r, i) => ({
      id: r.id || `req_${i}`,
      sources: [r.source],
      targets: [r.target],
    })),
  };
}

/**
 * Run ELK layout on a Decision-Core-derived graph. A new ELK() instance per call, mirroring
 * scripts/bpmn/layout.js's runElkLayout.
 *
 * ELK's own edge routes (`result.edges[].sections`) are NOT used downstream — DMN requirement
 * connections are drawn as straight lines, clipped to each shape's border by
 * scripts/shared/geometry.js's clipStraight in a later task's dmn/coordinates.js, not as ELK's
 * routed polylines. Only the node positions (`result.children[].x/y/width/height`) matter to this
 * pipeline; the caller is expected to discard `result.edges`.
 *
 * @param {object} graph - ELK graph, e.g. from decisionCoreToElk()
 * @returns {Promise<object>} laid-out ELK graph
 */
async function runDmnElkLayout(graph) {
  const elk = new ELK();
  return elk.layout(graph);
}

export { decisionCoreToElk, runDmnElkLayout };

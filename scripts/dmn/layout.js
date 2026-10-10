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
import { orderedRequirements } from './requirement-order.js';

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
    // Edges are built from `orderedRequirements(dc)`, not `dc.requirements`: ELK's layered algorithm is
    // sensitive to edge order, so the array order would otherwise leak into the GEOMETRY (and from
    // there into the emitted bytes). `requirement-order.js` is dependency-free precisely so that this
    // module and `coordinates.js` can share the one ordering.
    //
    // `r.id || `req_${i}`` is deliberately a DIFFERENT fallback from `requirementKey`
    // (`req.id || `req_${req.source}_${req.target}``, which keys edgeCoords and the DMNDI element
    // map). Nothing joins on this id: ELK's own edge routes (`result.edges[].sections`) are
    // discarded by runDmnElkLayout's caller; the id only has to be unique within one ELK graph.
    edges: orderedRequirements(dc).map((r, i) => ({
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

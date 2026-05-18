/**
 * BPMN Layout — ELK Graph Construction
 * Converts Logic-Core JSON to ELK graph structure for auto-layout.
 */

import { isEvent, isGateway, isBoundaryEvent, isArtifact } from './types.js';
import { CFG, SHAPE, LANE_HEADER_W, LANE_PADDING, EXTERNAL_LABEL_H, POOL_GAP } from './utils.js';
import ELK from 'elkjs/lib/elk.bundled.js';
import { preprocessLogicCore } from './topology.js';

function logicCoreToElk(lc, opts = {}) {
  // Pre-process: sort nodes topologically, order lanes by flow
  preprocessLogicCore(lc);

  // Decide if wrapping should be applied at the current subgraph level
  const wrappingOpts = resolveWrappingOpts(lc, opts);

  // Multi-pool mode
  if (lc.pools && lc.pools.length > 0) {
    return buildMultiPoolElk(lc, wrappingOpts);
  }
  // Single-pool mode
  return buildSingleProcessElk(lc, wrappingOpts);
}

/**
 * Decide whether to inject `elk.layered.wrapping.strategy: MULTI_EDGE` into
 * the top-level layered layout properties. Returns an object that can be
 * spread into the properties block (empty object if no wrapping).
 *
 * @param {Object} lc    — Logic-Core
 * @param {Object} opts  — { elkWrapping: boolean }
 * @returns {Object}     — layout property overrides (possibly empty)
 */
function resolveWrappingOpts(lc, opts) {
  if (!opts.elkWrapping) return {};
  const mode = CFG.visualRefinement?.elkWrapping ?? 'auto';
  if (mode === 'off') return {};

  const threshold = CFG.visualRefinement?.elkWrappingNodeThreshold ?? 20;
  const allNodes = lc.nodes ?? (lc.pools ?? []).flatMap(p => p.nodes ?? []);
  const nodeCount = allNodes.length;

  if (mode === 'auto' && nodeCount <= threshold) return {};

  return {
    'elk.layered.wrapping.strategy': 'MULTI_EDGE',
    'elk.layered.wrapping.additionalEdgeSpacing': '40',
  };
}

function buildSingleProcessElk(proc, wrappingOpts = {}) {
  const nodes = proc.nodes || [];
  const edges = proc.edges || [];
  const lanes = proc.lanes || [];

  const hasPools = lanes.length > 0;

  if (hasPools) {
    return buildLanedProcessElk(proc, wrappingOpts);
  }

  return {
    id: 'root',
    properties: { ...elkDefaults(), ...wrappingOpts },
    children: nodes.filter(n => !isBoundaryEvent(n) && !isArtifact(n.type))
                   .map(n => buildElkNode(n)),
    edges: edges.map((e, i) => buildElkEdge(e, i)),
  };
}

function buildLanedProcessElk(proc, wrappingOpts = {}) {
  const nodes = proc.nodes || [];
  const edges = proc.edges || [];
  const lanes = proc.lanes || [];

  // ═══════════════════════════════════════════════════════════════
  // FLAT LAYOUT APPROACH:
  // All nodes go into ONE flat ELK graph. ELK's partitioning feature
  // assigns nodes to horizontal bands (= lanes) while computing
  // globally consistent X positions (layers).
  //
  // This ensures the happy path flows left→right across ALL lanes,
  // and cross-lane edges are routed properly.
  // ═══════════════════════════════════════════════════════════════

  // Build lane → partition index mapping (order lanes as given)
  const lanePartition = {};
  lanes.forEach((lane, idx) => { lanePartition[lane.id] = idx; });

  const flatChildren = nodes
    .filter(n => !isBoundaryEvent(n) && !isArtifact(n.type))
    .map(n => {
      const elkNode = buildElkNode(n);
      // Assign partition based on lane
      const partIdx = lanePartition[n.lane];
      if (partIdx !== undefined) {
        elkNode.properties = {
          ...elkNode.properties,
          'elk.partitioning.partition': String(partIdx),
        };
      }
      return elkNode;
    });

  // ALL edges (intra-lane + cross-lane) in one flat list
  const flatEdges = edges.map((e, i) => buildElkEdge(e, i));

  return {
    id: 'pool',
    properties: {
      ...CFG.elk.layered,
      'elk.partitioning.activate': 'true',   // enable lane partitioning
      'elk.padding': `[top=${LANE_PADDING},left=${LANE_PADDING + LANE_HEADER_W},bottom=${LANE_PADDING},right=${LANE_PADDING}]`,
      ...wrappingOpts,  // merge last so it wins on conflicts
    },
    children: flatChildren,
    edges: flatEdges,
  };
}

function buildMultiPoolElk(lc, wrappingOpts = {}) {
  const pools = lc.pools || [];
  const collapsedPools = lc.collapsedPools || [];
  const poolElkChildren = [];

  for (const pool of pools) {
    const lanes = pool.lanes || [];
    if (lanes.length > 0) {
      poolElkChildren.push({
        id: pool.id,
        labels: [{ text: pool.name || pool.id }],
        ...buildLanedProcessElk(pool, wrappingOpts),
      });
    } else {
      const nodes = pool.nodes || [];
      const edges = pool.edges || [];
      poolElkChildren.push({
        id: pool.id,
        labels: [{ text: pool.name || pool.id }],
        properties: {
          ...elkDefaults(),
          'elk.padding': `[top=${LANE_PADDING},left=${LANE_PADDING + LANE_HEADER_W},bottom=${LANE_PADDING},right=${LANE_PADDING}]`,
          ...wrappingOpts,  // merge wrapping into laneless pool's layered layout
        },
        children: nodes.filter(n => !isBoundaryEvent(n) && !isArtifact(n.type))
                       .map(n => buildElkNode(n)),
        edges: edges.map((e, i) => buildElkEdge(e, i)),
      });
    }
  }

  // Collapsed pools (black-box participants, no internal process)
  for (const cp of collapsedPools) {
    poolElkChildren.push({
      id: cp.id,
      labels: [{ text: cp.name || cp.id }],
      width:  SHAPE._collapsedPool.w,
      height: SHAPE._collapsedPool.h,
      properties: {},
    });
  }

  return {
    id: 'collaboration',
    properties: {
      ...CFG.elk.rectpacking,
      'elk.spacing.nodeNode': `${POOL_GAP}`,
      'elk.padding': '[top=20,left=20,bottom=20,right=20]',
    },
    children: poolElkChildren,
    edges: [],
  };
}

function buildElkNode(node) {
  const needsExternalLabel = isEvent(node.type) || isGateway(node.type);
  const props = {
    'elk.nodeLabels.placement': 'INSIDE V_CENTER H_CENTER',
    'elk.portConstraints': 'FREE',
  };

  // Layer constraints: start events → first layer, end events → last layer
  if (node.type === 'startEvent') {
    props['elk.layered.layerConstraint'] = 'FIRST';
  } else if (node.type === 'endEvent') {
    props['elk.layered.layerConstraint'] = 'LAST';
  }

  // Expanded SubProcess: hierarchical compound node with children + edges
  if (node.isExpanded && node.nodes && node.nodes.length > 0) {
    const minSz = SHAPE._expandedSubProcess || { w: 350, h: 200 };
    const childNodes = node.nodes.filter(n => !isBoundaryEvent(n) && !isArtifact(n.type))
                                 .map(n => buildElkNode(n));
    const childEdges = (node.edges || []).map((e, i) => buildElkEdge(e, i));
    return {
      id: node.id,
      width: minSz.w,
      height: minSz.h,
      labels: [{ text: node.name || node.id }],
      properties: {
        ...props,
        ...elkDefaults(),
        'elk.padding': '[top=40,left=20,bottom=20,right=20]',
      },
      children: childNodes,
      edges: childEdges,
      _shapeH: minSz.h,
      _isExpanded: true,
    };
  }

  const sz = SHAPE[node.type] || SHAPE.task;
  return {
    id: node.id,
    width:  sz.w,
    height: sz.h + (needsExternalLabel ? EXTERNAL_LABEL_H : 0),
    labels: [{ text: node.name || node.id }],
    properties: props,
    _shapeH: sz.h,
  };
}

function buildElkEdge(edge, idx) {
  const props = {
    'elk.priority': edge.isHappyPath ? '10' : '1',
  };
  if (edge.isHappyPath) {
    props['elk.layered.priority.straightness'] = '10';
    props['elk.layered.priority.direction'] = '10';
  }
  return {
    id: edge.id || `edge_${idx}`,
    sources: [edge.source],
    targets: [edge.target],
    labels: edge.label ? [{ text: edge.label }] : [],
    properties: props,
  };
}

function elkDefaults() {
  return { ...CFG.elk.layered };
}

async function runElkLayout(elkGraph) {
  const elk = new ELK();
  return await elk.layout(elkGraph);
}

export { runElkLayout, logicCoreToElk, buildSingleProcessElk, buildLanedProcessElk, buildMultiPoolElk, buildElkNode, buildElkEdge, elkDefaults };

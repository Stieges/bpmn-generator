/**
 * BPMN Layout — ELK Graph Construction
 * Converts Logic-Core JSON to ELK graph structure for auto-layout.
 */

import { isEvent, isGateway, isBoundaryEvent, isArtifact } from './types.js';
import { SHAPE, LANE_HEADER_W, LANE_PADDING, EXTERNAL_LABEL_H, POOL_GAP, COLLAB_PADDING, ARTIFACT_GAP, artifactSize } from './constants.js';
import { CFG } from '../shared/utils.js';
import { boundText } from '../shared/safe-text.js';
import ELK from 'elkjs/lib/elk.bundled.js';
import { preprocessLogicCore, assignEdgeIds } from './topology.js';

/**
 * Public entry: fills MISSING edge ids on the caller's object (in place, idempotent, deterministic via
 * `assignEdgeIds`); `runPipeline` instead works on a copy.
 */
function logicCoreToElk(lc, opts = {}) {
  // Public entry: complete any id-less edge so geometry, XML and SVG all key on the same id (#64).
  assignEdgeIds(lc);
  // Pre-process: sort nodes topologically, order lanes by flow,
  // order participants by who talks to whom
  preprocessLogicCore(lc, { poolOrder: opts.poolOrder });

  // Decide if wrapping should be applied at the current subgraph level
  const wrappingOpts = resolveWrappingOpts(lc, opts);

  // Multi-pool mode
  if (lc.pools && lc.pools.length > 0) {
    return buildMultiPoolElk(lc, wrappingOpts);
  }
  // Single-pool mode
  return buildSingleProcessElk(lc, wrappingOpts);
}

const WRAPPING_MODES = new Set(['off', 'auto', 'always']);
const WRAPPING_PREFIX = 'elk.layered.wrapping.';

/**
 * ELK wrapping mode for one call: the option when given, else `config.json -> layout.elkWrapping`
 * (default 'off'). `true`/`false` are shorthands for 'auto'/'off'. Independent of visual
 * refinement: wrapping trades width for height and changes every route of a long chain, so it is
 * asked for on its own.
 *
 * @param {boolean|'off'|'auto'|'always'} [option]
 * @returns {'off'|'auto'|'always'}
 */
function resolveElkWrapping(option) {
  const value = option ?? CFG.layout?.elkWrapping ?? 'off';
  if (value === true) return 'auto';
  if (value === false) return 'off';
  if (WRAPPING_MODES.has(value)) return value;
  throw new TypeError(`elkWrapping must be 'off', 'auto' or 'always' (got ${JSON.stringify(value)})`);
}

/** Nodes that take part in the ELK graph: boundary events and artifacts are placed afterwards. */
function countElkNodes(nodes) {
  return (nodes ?? []).filter(n => !isBoundaryEvent(n) && !isArtifact(n.type)).length;
}

/**
 * `elk.layered.wrapping.strategy: MULTI_EDGE` properties for the top-level layered layout, or
 * `{}`. 'auto' wraps only above `layout.elkWrappingNodeThreshold` nodes of the ELK graph
 * (default 20).
 *
 * @param {Object} lc    - Logic-Core
 * @param {Object} opts  - { elkWrapping }
 * @returns {Object}     - layout property overrides (possibly empty)
 */
function resolveWrappingOpts(lc, opts) {
  const mode = resolveElkWrapping(opts.elkWrapping);
  if (mode === 'off') return {};

  const threshold = CFG.layout?.elkWrappingNodeThreshold ?? 20;
  const nodeCount = countElkNodes(lc.nodes ?? (lc.pools ?? []).flatMap(p => p.nodes ?? []));

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
    edges: buildElkEdges(nodes, edges),
  };
}

/**
 * Build the ELK edge list for a node/edge set.
 *
 * Boundary events are not ELK children — they are placed on their host's border
 * after layout (coordinates.js §5.0e).  Their sequence flows must therefore be
 * re-anchored to the host activity, otherwise ELK rejects the graph with
 * "Referenced shape does not exist".  Anchoring on the host (instead of dropping
 * the edge) also keeps the escalation target in a layer after its host.
 * The edge keeps its own id, so its route lands under the real edge id and the
 * endpoint is clipped back onto the boundary event in §5.1.
 */
function buildElkEdges(nodes, edges) {
  const hostOf = {};
  for (const n of nodes) {
    if (isBoundaryEvent(n) && n.attachedTo) hostOf[n.id] = n.attachedTo;
  }
  const known = new Set(nodes.filter(n => !isBoundaryEvent(n) && !isArtifact(n.type)).map(n => n.id));

  return edges
    .map(e => {
      const source = hostOf[e.source] || e.source;
      const target = hostOf[e.target] || e.target;
      return source === target ? null : { ...e, source, target };
    })
    .filter(e => e && known.has(e.source) && known.has(e.target))
    .map((e, i) => buildElkEdge(e, i));
}

function buildLanedProcessElk(proc, wrappingOpts = {}) {
  const nodes = proc.nodes || [];
  const edges = proc.edges || [];
  const lanes = proc.lanes || [];

  // ═══════════════════════════════════════════════════════════════
  // FLAT LAYOUT APPROACH — one axis each:
  //   x (layers)  ← ELK, from the sequence flow
  //   y (bands)   ← us, from the lane order (coordinates.js §5.0a)
  //
  // ELK's `partitioning` feature is deliberately NOT used for lanes. In
  // elk.layered a partition is a LAYER group along the flow direction, not a
  // horizontal band: giving lane i partition i forces every node of the first
  // lane before every node of the second one. A lane that does its work in the
  // middle of the process (an approval that flows back into the main path) then
  // gets pushed past the end event and its outgoing flow runs backwards.
  // Lane bands are derived from node positions afterwards anyway, so ELK never
  // needed to know about lanes in the first place.
  // ═══════════════════════════════════════════════════════════════

  const flatChildren = nodes
    .filter(n => !isBoundaryEvent(n) && !isArtifact(n.type))
    .map(n => buildElkNode(n));

  // ALL edges (intra-lane + cross-lane) in one flat list
  const flatEdges = buildElkEdges(nodes, edges);

  return {
    id: 'pool',
    properties: {
      ...CFG.elk.layered,
      // Left padding carries THREE things: the pool's own header strip, the
      // lane's header strip, and clearance for the first element. The lane strip
      // used to be missing from the budget, leaving 3 px between an event's
      // external label and the lane name — buildElkNode reserves height for
      // external labels but no width, so a 36 px event carries a 90 px label
      // that overhangs it by 27 px on each side and nothing accounts for it.
      'elk.padding': `[top=${LANE_PADDING},left=${LANE_PADDING + 2 * LANE_HEADER_W},bottom=${LANE_PADDING},right=${LANE_PADDING}]`,
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
        // Spread FIRST: buildLanedProcessElk returns the literal id 'pool'
        // (it is also used as a standalone root). Spreading it after `id`
        // would give every laned pool the same ELK id and collapse them
        // onto identical coordinates.
        ...buildLanedProcessElk(pool, wrappingOpts),
        id: pool.id,
        labels: [{ text: pool.name || pool.id }],
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
        edges: buildElkEdges(nodes, edges),
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

  // Stack in the order preprocessLogicCore computed — expanded pools and black
  // boxes interleaved, so partners end up adjacent.
  const order = lc._participantOrder;
  if (order) {
    const rank = {};
    order.forEach((id, i) => { rank[id] = i; });
    poolElkChildren.sort((a, b) => (rank[a.id] ?? 1e9) - (rank[b.id] ?? 1e9));
  }

  return {
    id: 'collaboration',
    properties: {
      ...CFG.elk.rectpacking,
      'elk.spacing.nodeNode': `${POOL_GAP}`,
      'elk.padding': `[top=${COLLAB_PADDING},left=${COLLAB_PADDING},bottom=${COLLAB_PADDING},right=${COLLAB_PADDING}]`,
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
    const childEdges = buildElkEdges(node.nodes, node.edges || []);
    const artifactReserve = artifactReserveHeight(node.nodes);
    return {
      id: node.id,
      width: minSz.w,
      height: minSz.h,
      labels: [{ text: node.name || node.id }],
      properties: {
        ...props,
        ...elkDefaults(),
        'elk.padding': `[top=40,left=20,bottom=${20 + artifactReserve},right=20]`,
      },
      children: childNodes,
      edges: childEdges,
      _shapeH: minSz.h,
      _isExpanded: true,
      _artifactReserve: artifactReserve,
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

/**
 * Height an expanded subprocess keeps free below its children for the artifacts it declares
 * directly (nested containers reserve for their own).
 *
 * Artifacts are not in the ELK graph, so without this ELK sizes the container as if they did not
 * exist, and coordinates.js then has nowhere inside it to put them: an unassociated one has no anchor
 * at all, and an associated one hangs below its anchor and overflows whenever that anchor sits near
 * the bottom. The band is sized for the worst case — every artifact stacked under one anchor — rather
 * than from the associations, which are a collaboration-level list that buildElkNode never sees.
 * Over-reserving costs whitespace; under-reserving puts a shape outside its container (DI06).
 */
function artifactReserveHeight(nodes) {
  const artifacts = nodes.filter(n => isArtifact(n.type));
  if (artifacts.length === 0) return 0;
  const tallest = Math.max(...artifacts.map(n => artifactSize(n.type).h));
  return artifacts.length * (tallest + ARTIFACT_GAP);
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
    id: edge.id,
    sources: [edge.source],
    targets: [edge.target],
    labels: edge.label ? [{ text: edge.label }] : [],
    properties: props,
  };
}

function elkDefaults() {
  return { ...CFG.elk.layered };
}

/**
 * Stack collaboration participants in a single vertical column.
 *
 * ELK's rectpacking opens a second column as soon as the aspect ratio suggests
 * it (4+ participants).  BPMN pools are conventionally stacked vertically, and
 * the DI post-processing in coordinates.js §5.0b assumes exactly that: it
 * equalizes all pools to one x.  A second column therefore collapses onto the
 * first.  We resolve the contradiction on the DI side and lay the participants
 * out deterministically: same x, y accumulated from height + POOL_GAP.
 *
 * Runs on the ELK result, where each pool's children are still relative to
 * their pool — moving the pool moves its whole content.
 */
function stackCollaborationVertically(layouted) {
  if (layouted.id !== 'collaboration') return layouted;
  const children = layouted.children || [];
  if (children.length === 0) return layouted;

  const pad = COLLAB_PADDING;
  let y = pad;
  for (const c of children) {
    c.x = pad;
    c.y = y;
    y += (c.height || 0) + POOL_GAP;
  }
  layouted.width  = pad * 2 + Math.max(...children.map(c => c.width || 0));
  layouted.height = y - POOL_GAP + pad;
  return layouted;
}

/** Remove every wrapping property from an ELK graph, recursively. Returns how many were removed. */
function stripWrapping(node) {
  let removed = 0;
  for (const key of Object.keys(node.properties ?? {})) {
    if (key.startsWith(WRAPPING_PREFIX)) { delete node.properties[key]; removed++; }
  }
  for (const child of node.children ?? []) removed += stripWrapping(child);
  return removed;
}

/**
 * Run ELK on a graph built by `logicCoreToElk`.
 *
 * MULTI_EDGE wrapping can throw inside elkjs on some models (more than 20 nodes plus a back
 * edge). When it does, the layout is retried once without any wrapping property, and the result
 * carries `layoutInfos` naming the fallback so a caller sees that wrapping was skipped. An error
 * with no wrapping property to remove is re-thrown unchanged.
 *
 * @returns {Promise<Object>} the laid-out graph; `layoutInfos` (string[]) is set only on fallback
 */
async function runElkLayout(elkGraph) {
  const elk = new ELK();
  // elkjs may mutate its input, so keep a pristine copy to retry from. A JSON round trip is enough:
  // the graph is plain data (pipeline.js copies coordMap.edgeCoords with structuredClone for the
  // same reason, and either works on plain data).
  const pristine = hasWrapping(elkGraph) ? JSON.parse(JSON.stringify(elkGraph)) : null;
  let layouted;
  let fallback = null;
  try {
    layouted = await elk.layout(elkGraph);
  } catch (err) {
    if (!pristine || stripWrapping(pristine) === 0) throw err;
    // A fresh instance: the one that threw may hold half-built state from the failed run.
    layouted = await new ELK().layout(pristine);
    fallback = `ELK wrapping skipped: layout failed with wrapping on (${boundText(err?.message ?? err, 200)}); laid out without it`;
  }
  const result = stackCollaborationVertically(layouted);
  if (fallback) result.layoutInfos = [fallback];
  return result;
}

function hasWrapping(node) {
  return Object.keys(node.properties ?? {}).some(k => k.startsWith(WRAPPING_PREFIX))
    || (node.children ?? []).some(hasWrapping);
}

export { resolveElkWrapping, runElkLayout, logicCoreToElk, buildSingleProcessElk, buildLanedProcessElk, buildMultiPoolElk, buildElkNode, buildElkEdge, elkDefaults };

/**
 * BPMN Generator Pipeline v2.0 — Enterprise Edition
 * OMG BPMN 2.0.2 compliant (formal/2013-12-09, ISO/IEC 19510:2013)
 *
 * Reference implementations:
 *   - bpmn-js BpmnRenderer.js / PathMap.js / ElementFactory.js
 *   - OMG BPMN 2.0.2 specification chapters 7–13
 *
 * Fixes over v1:
 *   - Single <laneSet> per process (spec §10.5)
 *   - gatewayDirection: Diverging/Converging/Mixed (spec §10.5.1)
 *   - conditionExpression as child element (spec §10.3.1)
 *   - incoming/outgoing flow references on all flow nodes
 *   - Deadlock detection (XOR-split → AND-join)
 *   - Multi-pool collaboration support
 *   - Message flows between pools
 *   - Boundary events (timer, error, message, signal, escalation, compensation)
 *   - Loop / multi-instance markers
 *   - Data objects, data stores, text annotations, groups
 *   - Edge endpoint clipping to actual shape boundaries
 *   - Proper SVG rendering for all BPMN element types
 *
 * Usage:
 *   node pipeline.js input.json [output-basename]
 *   cat input.json | node pipeline.js - output-basename
 */

import ELK from 'elkjs/lib/elk.bundled.js';
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// ═══════════════════════════════════════════════════════════════════════
// §1  OMG / bpmn-js VISUAL CONSTANTS (loaded from config.json)
// ═══════════════════════════════════════════════════════════════════════

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadConfig(customPath) {
  const defaults = JSON.parse(readFileSync(resolve(__dirname, 'config.json'), 'utf8'));
  if (!customPath) return defaults;
  const custom = JSON.parse(readFileSync(resolve(customPath), 'utf8'));
  // Deep merge: custom overrides defaults per top-level key
  const merged = { ...defaults };
  for (const key of Object.keys(custom)) {
    if (typeof custom[key] === 'object' && !Array.isArray(custom[key]) && typeof defaults[key] === 'object') {
      merged[key] = { ...defaults[key], ...custom[key] };
    } else {
      merged[key] = custom[key];
    }
  }
  return merged;
}

const CFG = loadConfig(process.env.BPMN_CONFIG);

const SHAPE          = CFG.shape;
const SW             = CFG.strokeWidth;
const CLR            = CFG.color;
const LANE_HEADER_W  = CFG.layout.laneHeaderWidth;
const LANE_PADDING   = CFG.layout.lanePadding;
const LABEL_DISTANCE = CFG.layout.labelDistance;
const TASK_RX        = CFG.layout.taskBorderRadius;
const INNER_OUTER_GAP = CFG.layout.innerOuterGap;
const EXTERNAL_LABEL_H = CFG.layout.externalLabelHeight;
const POOL_GAP       = CFG.layout.poolGap;

// ═══════════════════════════════════════════════════════════════════════
// §2  VALIDATION — structural soundness, deadlock detection
// ═══════════════════════════════════════════════════════════════════════

function validateLogicCore(lc) {
  const errors = [], warnings = [];
  const processes = lc.pools ? lc.pools : [lc];

  for (const proc of processes) {
    const prefix = lc.pools ? `[${proc.name || proc.id}] ` : '';
    const nodes  = proc.nodes || [];
    const edges  = proc.edges || [];
    const nodeIds = new Set(nodes.map(n => n.id));
    const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));

    // §2.1  Existence checks
    if (!nodes.some(n => n.type === 'startEvent'))
      errors.push(`${prefix}Missing startEvent.`);
    if (!nodes.some(n => n.type === 'endEvent'))
      errors.push(`${prefix}Missing endEvent.`);

    // §2.2  Edge referential integrity
    for (const e of edges) {
      if (!nodeIds.has(e.source)) errors.push(`${prefix}Edge "${e.id||''}" unknown source: "${e.source}"`);
      if (!nodeIds.has(e.target)) errors.push(`${prefix}Edge "${e.id||''}" unknown target: "${e.target}"`);
    }

    // §2.3  Isolated nodes (no edges at all, excluding artifacts connected via associations)
    const connected = new Set([...edges.map(e => e.source), ...edges.map(e => e.target)]);
    for (const n of nodes) {
      if (!connected.has(n.id) && n.type !== 'startEvent' && !isBoundaryEvent(n) && !isArtifact(n.type))
        warnings.push(`${prefix}Node "${n.id}" (${n.name||''}) appears isolated.`);
    }

    // §2.4  Deadlock detection: XOR-split → AND-join (OMG spec violation)
    const outgoing = buildAdjacency(edges, 'source', 'target');
    const incoming = buildAdjacency(edges, 'target', 'source');

    for (const n of nodes) {
      if (n.type === 'exclusiveGateway' && !n.has_join) {
        // This is a splitting XOR — get its direct branch targets
        const xorBranches = (outgoing[n.id] || []).map(e => e.target);
        if (xorBranches.length < 2) continue;

        // For each branch, find all reachable nodes
        const branchReachSets = xorBranches.map(branchStart => {
          const visited = new Set();
          const queue = [branchStart];
          while (queue.length > 0) {
            const cur = queue.shift();
            if (visited.has(cur) || cur === n.id) continue;
            visited.add(cur);
            for (const edge of (outgoing[cur] || [])) {
              if (!visited.has(edge.target)) queue.push(edge.target);
            }
          }
          return visited;
        });

        // Check: is there a parallelGateway (AND-join) that is reachable
        // from 2+ branches of this XOR? That's a deadlock.
        for (const candidate of nodes) {
          if (candidate.type !== 'parallelGateway') continue;
          const cid = candidate.id;
          // Count how many XOR branches can reach this AND gateway
          let branchesReachingAnd = 0;
          for (const reachSet of branchReachSets) {
            if (reachSet.has(cid)) branchesReachingAnd++;
          }
          // Also check: does this AND actually have >1 incoming edges? (it's a join)
          const andIncoming = (incoming[cid] || []).length;
          if (branchesReachingAnd > 1 && andIncoming > 1) {
            errors.push(`${prefix}Deadlock: XOR-split "${n.id}" feeds AND-join "${cid}" via ${branchesReachingAnd} branches — only one XOR branch fires, AND waits forever.`);
          }
        }
      }
    }

    // §2.5  Gateway naming (only XOR gateways need questions)
    for (const n of nodes) {
      if (n.type === 'exclusiveGateway' && !n.has_join && !(n.name || '').includes('?'))
        warnings.push(`${prefix}XOR gateway "${n.id}" should be a question (e.g. "Antrag gültig?").`);
    }

    // §2.6  Task naming convention (Verb + Substantiv)
    const taskTypes = ['task', 'userTask', 'serviceTask', 'scriptTask', 'manualTask',
                       'businessRuleTask', 'sendTask', 'receiveTask'];
    for (const n of nodes) {
      if (taskTypes.includes(n.type) && n.name && !n.name.trim().includes(' '))
        warnings.push(`${prefix}Task "${n.name}" should follow "Verb + Substantiv" convention.`);
    }

    // §2.7  Gateway outgoing edge labels
    for (const n of nodes) {
      if (n.type === 'exclusiveGateway' && !n.has_join) {
        const outEdges = edges.filter(e => e.source === n.id);
        if (outEdges.length > 1) {
          for (const e of outEdges) {
            if (!e.label) warnings.push(`${prefix}Edge "${e.id||''}" from XOR gateway "${n.id}" missing label.`);
          }
        }
      }
    }

    // §2.8  Path termination check
    for (const n of nodes) {
      if (n.type !== 'endEvent' && (outgoing[n.id] || []).length === 0 &&
          !isBoundaryEvent(n) && n.type !== 'dataObjectReference' &&
          n.type !== 'dataStoreReference' && n.type !== 'textAnnotation') {
        if (n.type !== 'startEvent' || edges.some(e => e.source === n.id) === false) {
          // startEvent with no outgoing is caught by isolation check
          if (n.type !== 'startEvent')
            warnings.push(`${prefix}Node "${n.id}" has no outgoing flow — path may not terminate.`);
        }
      }
    }
  }

  // §2.9  Message flow validation (cross-pool)
  if (lc.messageFlows) {
    const allNodeIds = new Set();
    for (const p of (lc.pools || [lc])) {
      for (const n of (p.nodes || [])) allNodeIds.add(n.id);
    }
    const allPoolIds = new Set([
      ...(lc.pools || []).map(p => p.id),
      ...(lc.collapsedPools || []).map(cp => cp.id),
    ]);
    for (const mf of lc.messageFlows) {
      if (!allNodeIds.has(mf.source) && !allPoolIds.has(mf.source))
        errors.push(`MessageFlow "${mf.id||''}" unknown source: "${mf.source}"`);
      if (!allNodeIds.has(mf.target) && !allPoolIds.has(mf.target))
        errors.push(`MessageFlow "${mf.id||''}" unknown target: "${mf.target}"`);
    }
  }

  return { errors, warnings };
}

// ── Validation helpers ──────────────────────────────────────────────

function buildAdjacency(edges, fromKey, toKey) {
  const adj = {};
  for (const e of edges) {
    if (!adj[e[fromKey]]) adj[e[fromKey]] = [];
    adj[e[fromKey]].push(e);
  }
  return adj;
}

function countIncoming(nodeId, incomingMap) {
  return (incomingMap[nodeId] || []).length;
}

function traceReachable(startId, outgoing, nodeMap, maxDepth = 50) {
  const visited = new Set();
  const queue = [startId];
  let depth = 0;
  while (queue.length > 0 && depth < maxDepth) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of (outgoing[current] || [])) {
      if (!visited.has(edge.target)) queue.push(edge.target);
    }
    depth++;
  }
  visited.delete(startId);
  return visited;
}

function isReachableWithout(from, to, outgoing, exclude, nodeMap, maxDepth = 50) {
  const visited = new Set(exclude);
  const queue = [from];
  let depth = 0;
  while (queue.length > 0 && depth < maxDepth) {
    const current = queue.shift();
    if (current === to) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of (outgoing[current] || [])) {
      if (!visited.has(edge.target)) queue.push(edge.target);
    }
    depth++;
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
// §3  GATEWAY DIRECTION INFERENCE (OMG spec §10.5.1)
// ═══════════════════════════════════════════════════════════════════════

function inferGatewayDirections(nodes, edges) {
  const outCount = {}, inCount = {};
  for (const e of edges) {
    outCount[e.source] = (outCount[e.source] || 0) + 1;
    inCount[e.target]  = (inCount[e.target]  || 0) + 1;
  }
  for (const n of nodes) {
    if (!isGateway(n.type)) continue;
    const outs = outCount[n.id] || 0;
    const ins  = inCount[n.id]  || 0;

    if (n.has_join && outs <= 1 && ins > 1) {
      n._direction = 'Converging';
    } else if (!n.has_join && outs > 1 && ins <= 1) {
      n._direction = 'Diverging';
    } else if (outs > 1 && ins > 1) {
      n._direction = 'Mixed';
    } else if (n.has_join) {
      n._direction = 'Converging';
    } else {
      n._direction = 'Diverging';
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// §3b  PRE-PROCESSING: Node sort, lane ordering (improves ELK model order)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Sort nodes in topological happy-path order.
 * ELK's Sugiyama respects input order for layer assignment (model order).
 * By sorting: startEvents first → happy-path chain → branch nodes → endEvents last,
 * we get a natural left-to-right flow.
 */
function sortNodesTopologically(proc) {
  const nodes = proc.nodes || [];
  const edges = proc.edges || [];
  if (nodes.length === 0) return;

  const outgoing = {};
  for (const e of edges) {
    if (!outgoing[e.source]) outgoing[e.source] = [];
    outgoing[e.source].push(e);
  }

  // BFS from start events, prioritizing happy path edges
  const visited = new Set();
  const sorted = [];
  const queue = [];

  // Start events first
  for (const n of nodes) {
    if (n.type === 'startEvent') {
      queue.push(n.id);
    }
  }

  while (queue.length > 0) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    sorted.push(id);

    // Follow edges, happy path first
    const outs = (outgoing[id] || []).sort((a, b) => {
      if (a.isHappyPath && !b.isHappyPath) return -1;
      if (!a.isHappyPath && b.isHappyPath) return 1;
      return 0;
    });
    for (const e of outs) {
      if (!visited.has(e.target)) queue.push(e.target);
    }
  }

  // Add any remaining unvisited nodes (disconnected, artifacts)
  for (const n of nodes) {
    if (!visited.has(n.id)) sorted.push(n.id);
  }

  // Reorder proc.nodes in-place
  const nodeMap = Object.fromEntries(nodes.map(n => [n.id, n]));
  proc.nodes = sorted.map(id => nodeMap[id]).filter(Boolean);
}

/**
 * Reorder lanes based on process flow:
 * - Lane containing start event → first (top)
 * - Lanes sorted by average happy-path position of their nodes
 * - Lane containing most end events → last (bottom)
 */
function orderLanesByFlow(proc) {
  const lanes = proc.lanes || [];
  const nodes = proc.nodes || [];
  const edges = proc.edges || [];
  if (lanes.length <= 1) return;

  // Build node index (position in sorted nodes array = flow order)
  const nodeIndex = {};
  nodes.forEach((n, i) => { nodeIndex[n.id] = i; });

  // Score each lane by average node index (lower = earlier in flow)
  const laneScores = {};
  const laneStartCount = {};
  const laneEndCount = {};

  for (const lane of lanes) {
    const laneNodes = nodes.filter(n => n.lane === lane.id);
    if (laneNodes.length === 0) {
      laneScores[lane.id] = 9999;
      laneStartCount[lane.id] = 0;
      laneEndCount[lane.id] = 0;
      continue;
    }

    // Average position in the topologically sorted order
    const avgIdx = laneNodes.reduce((s, n) => s + (nodeIndex[n.id] || 0), 0) / laneNodes.length;
    laneScores[lane.id] = avgIdx;
    laneStartCount[lane.id] = laneNodes.filter(n => n.type === 'startEvent').length;
    laneEndCount[lane.id] = laneNodes.filter(n => n.type === 'endEvent').length;
  }

  // Sort: start-event lanes first, then by average flow position
  proc.lanes = [...lanes].sort((a, b) => {
    // Lanes with start events come first
    if (laneStartCount[a.id] > 0 && laneStartCount[b.id] === 0) return -1;
    if (laneStartCount[b.id] > 0 && laneStartCount[a.id] === 0) return 1;
    // Then by average flow position
    return laneScores[a.id] - laneScores[b.id];
  });
}

/**
 * Pre-process a Logic-Core before ELK graph construction.
 * Applies to each process (pool) independently.
 */
function preprocessLogicCore(lc) {
  const processes = lc.pools ? lc.pools : [lc];
  for (const proc of processes) {
    sortNodesTopologically(proc);
    orderLanesByFlow(proc);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// §4  LOGIC-CORE → ELK GRAPH
// ═══════════════════════════════════════════════════════════════════════

function logicCoreToElk(lc) {
  // Pre-process: sort nodes topologically, order lanes by flow
  preprocessLogicCore(lc);

  // Multi-pool mode
  if (lc.pools && lc.pools.length > 0) {
    return buildMultiPoolElk(lc);
  }
  // Single-pool mode
  return buildSingleProcessElk(lc);
}

function buildSingleProcessElk(proc) {
  const nodes = proc.nodes || [];
  const edges = proc.edges || [];
  const lanes = proc.lanes || [];

  const hasPools = lanes.length > 0;

  if (hasPools) {
    return buildLanedProcessElk(proc);
  }

  return {
    id: 'root',
    properties: elkDefaults(),
    children: nodes.filter(n => !isBoundaryEvent(n) && !isArtifact(n.type))
                   .map(n => buildElkNode(n)),
    edges: edges.map((e, i) => buildElkEdge(e, i)),
  };
}

function buildLanedProcessElk(proc) {
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
    },
    children: flatChildren,
    edges: flatEdges,
  };
}

function buildMultiPoolElk(lc) {
  const pools = lc.pools || [];
  const collapsedPools = lc.collapsedPools || [];
  const poolElkChildren = [];

  for (const pool of pools) {
    const lanes = pool.lanes || [];
    if (lanes.length > 0) {
      poolElkChildren.push({
        id: pool.id,
        labels: [{ text: pool.name || pool.id }],
        ...buildLanedProcessElk(pool),
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
  const sz = SHAPE[node.type] || SHAPE.task;
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
  return {
    id: edge.id || `edge_${idx}`,
    sources: [edge.source],
    targets: [edge.target],
    labels: edge.label ? [{ text: edge.label }] : [],
    properties: {
      'elk.priority': edge.isHappyPath ? '10' : '1',
    },
  };
}

function elkDefaults() {
  return { ...CFG.elk.layered };
}

// ═══════════════════════════════════════════════════════════════════════
// §5  ELK LAYOUT → COORDINATE MAP
// ═══════════════════════════════════════════════════════════════════════

async function runElkLayout(elkGraph) {
  const elk = new ELK();
  return await elk.layout(elkGraph);
}

function buildCoordinateMap(elkResult, lc) {
  const coords     = {};
  const laneCoords = {};
  const poolCoords = {};
  const edgeCoords = {};

  const allProcesses = lc.pools ? lc.pools : [lc];
  const allCollapsedPools = lc.collapsedPools || [];
  const allLaneIds = new Set();
  const allPoolIds = new Set();
  for (const p of allProcesses) {
    allPoolIds.add(p.id);
    for (const l of (p.lanes || [])) allLaneIds.add(l.id);
  }
  for (const cp of allCollapsedPools) allPoolIds.add(cp.id);

  const collectNodes = (node, offX = 0, offY = 0) => {
    const ax = (node.x || 0) + offX;
    const ay = (node.y || 0) + offY;

    if (node.id === 'collaboration' || node.id === 'root') {
      for (const c of node.children || []) collectNodes(c, ax, ay);
      for (const e of node.edges   || []) collectEdge(e, ax, ay);
      return;
    }

    if (allPoolIds.has(node.id)) {
      poolCoords[node.id] = { x: ax, y: ay, w: node.width, h: node.height };
      for (const c of node.children || []) collectNodes(c, ax, ay);
      for (const e of node.edges   || []) collectEdge(e, ax, ay);
      return;
    }

    if (node.id === 'pool') {
      poolCoords['_singlePool'] = { x: ax, y: ay, w: node.width, h: node.height };
      for (const c of node.children || []) collectNodes(c, ax, ay);
      for (const e of node.edges   || []) collectEdge(e, ax, ay);
      return;
    }

    if (allLaneIds.has(node.id)) {
      laneCoords[node.id] = { x: ax, y: ay, w: node.width, h: node.height };
      for (const c of node.children || []) collectNodes(c, ax, ay);
      for (const e of node.edges   || []) collectEdge(e, ax, ay);
      return;
    }

    // Regular node — use actual shape dimensions, not ELK dimensions
    const shapeH = node._shapeH || node.height;
    const lcNode = findNodeInAllProcesses(node.id, allProcesses);
    const specSz = SHAPE[lcNode?.type] || { w: node.width, h: shapeH };
    coords[node.id] = { x: ax, y: ay, w: specSz.w, h: specSz.h };

    for (const c of node.children || []) collectNodes(c, ax, ay);
    for (const e of node.edges   || []) collectEdge(e, ax, ay);
  };

  const collectEdge = (edge, offX = 0, offY = 0) => {
    const pts = [];
    for (const sec of edge.sections || []) {
      pts.push({ x: sec.startPoint.x + offX, y: sec.startPoint.y + offY });
      for (const bp of sec.bendPoints || []) pts.push({ x: bp.x + offX, y: bp.y + offY });
      pts.push({ x: sec.endPoint.x + offX, y: sec.endPoint.y + offY });
    }
    edgeCoords[edge.id] = pts;
  };

  collectNodes(elkResult);

  // §5.0  Compute lane bounds from node positions (flat layout approach)
  //       Since we use ELK partitioning, nodes are direct children of the pool.
  //       Lane bounds are computed by grouping nodes by their lane assignment
  //       and calculating the bounding box + padding for each group.
  for (const proc of allProcesses) {
    const lanes = proc.lanes || [];
    if (lanes.length === 0) continue;
    const procNodes = proc.nodes || [];

    // Group nodes by lane
    const laneNodeGroups = {};
    for (const lane of lanes) laneNodeGroups[lane.id] = [];
    for (const n of procNodes) {
      if (n.lane && laneNodeGroups[n.lane] && coords[n.id]) {
        laneNodeGroups[n.lane].push(coords[n.id]);
      }
    }

    // Find the pool bounding box for x/width reference
    const poolC = poolCoords[proc.id] || poolCoords['_singlePool'];
    const poolX = poolC ? poolC.x : 0;
    const poolW = poolC ? poolC.w : Math.max(...Object.values(coords).map(c => c.x + c.w)) + LANE_PADDING;

    // Compute lane bounds from node positions
    for (const lane of lanes) {
      const nodeCoords = laneNodeGroups[lane.id];
      if (nodeCoords.length === 0) {
        // Empty lane — give it minimum height
        laneCoords[lane.id] = { x: poolX + LANE_HEADER_W, y: 0, w: poolW - LANE_HEADER_W, h: 60 };
        continue;
      }
      const minY = Math.min(...nodeCoords.map(c => c.y)) - LANE_PADDING;
      const maxY = Math.max(...nodeCoords.map(c => c.y + c.h)) + LANE_PADDING + EXTERNAL_LABEL_H;

      laneCoords[lane.id] = {
        x: poolX + LANE_HEADER_W,
        y: minY,
        w: poolW - LANE_HEADER_W,
        h: maxY - minY,
      };
    }

    // Fix lane overlaps: if two lanes overlap vertically, insert gap
    const laneSorted = lanes.map(l => l.id).filter(id => laneCoords[id])
      .sort((a, b) => laneCoords[a].y - laneCoords[b].y);

    for (let i = 1; i < laneSorted.length; i++) {
      const prev = laneCoords[laneSorted[i - 1]];
      const curr = laneCoords[laneSorted[i]];
      const prevBottom = prev.y + prev.h;
      if (curr.y < prevBottom + 2) {
        // Shift this lane and all its nodes down
        const delta = prevBottom + 2 - curr.y;
        curr.y += delta;
        // Shift all nodes in this lane
        for (const n of procNodes) {
          if (n.lane === laneSorted[i] && coords[n.id]) {
            coords[n.id].y += delta;
          }
        }
        // Shift edge waypoints that are within this lane's Y range
        for (const e of (proc.edges || [])) {
          const pts = edgeCoords[e.id];
          if (!pts) continue;
          for (const p of pts) {
            if (p.y >= curr.y - delta && p.y < curr.y) {
              p.y += delta;
            }
          }
        }
        // Recalculate lane height after shift
        const nodeCoords = laneNodeGroups[laneSorted[i]];
        if (nodeCoords.length > 0) {
          const minY = Math.min(...nodeCoords.map(c => c.y)) - LANE_PADDING;
          const maxY = Math.max(...nodeCoords.map(c => c.y + c.h)) + LANE_PADDING + EXTERNAL_LABEL_H;
          curr.y = minY;
          curr.h = maxY - minY;
        }
      }
    }

    // Equalize all lane widths
    const allLcs = lanes.map(l => laneCoords[l.id]).filter(Boolean);
    if (allLcs.length > 0) {
      const maxW = Math.max(...allLcs.map(l => l.w));
      const minX = Math.min(...allLcs.map(l => l.x));
      for (const lc_ of allLcs) {
        lc_.x = minX;
        lc_.w = maxW;
      }

      // Recalculate pool bounds from lane bounds
      const poolKey = proc.id;
      const pc = poolCoords[poolKey] || poolCoords['_singlePool'];
      if (pc) {
        pc.x = minX - LANE_HEADER_W;
        pc.y = Math.min(...allLcs.map(l => l.y));
        pc.w = maxW + LANE_HEADER_W;
        pc.h = Math.max(...allLcs.map(l => l.y + l.h)) - pc.y;
      }
    }
  }

  // §5.0b  Equalize pool widths across entire collaboration (BPMN convention)
  const allPoolCoordValues = Object.values(poolCoords);
  if (allPoolCoordValues.length > 1) {
    const maxPoolW = Math.max(...allPoolCoordValues.map(p => p.w));
    const minPoolX = Math.min(...allPoolCoordValues.map(p => p.x));
    for (const pc of allPoolCoordValues) {
      pc.x = minPoolX;
      pc.w = maxPoolW;
    }
    // Also extend lanes to match pool width
    for (const lc_ of Object.values(laneCoords)) {
      lc_.w = maxPoolW - LANE_HEADER_W;
    }
  }

  // §5.1  Orthogonal edge endpoint clipping
  //
  // ELK produces orthogonal routes (90° bends). We must preserve this when
  // clipping endpoints to the actual (smaller) shape boundaries.
  // Strategy: detect whether the first/last segment is horizontal or vertical,
  // then project the endpoint onto the shape boundary along that axis only.
  //
  const allProcessNodes = allProcesses.flatMap(p => p.nodes || []);
  const allProcessEdges = allProcesses.flatMap(p => p.edges || []);
  for (const edge of allProcessEdges) {
    const eid = edge.id;
    const pts = edgeCoords[eid];
    if (!pts || pts.length < 2) continue;

    const srcCoord = coords[edge.source];
    const tgtCoord = coords[edge.target];
    const srcNode  = allProcessNodes.find(n => n.id === edge.source);
    const tgtNode  = allProcessNodes.find(n => n.id === edge.target);

    if (srcCoord && srcNode) {
      pts[0] = clipOrthogonal(srcCoord, srcNode.type, pts[0], pts[1], 'source');
    }
    if (tgtCoord && tgtNode) {
      const last = pts.length - 1;
      pts[last] = clipOrthogonal(tgtCoord, tgtNode.type, pts[last], pts[last - 1], 'target');
    }
  }

  // §5.2  Synthetic routing for edges without ELK routing data
  //        (cross-lane edges in rectpacking mode have no sections)
  for (const edge of allProcessEdges) {
    const eid = edge.id;
    const pts = edgeCoords[eid];
    if (pts && pts.length >= 2) continue;  // already routed

    const srcC = coords[edge.source];
    const tgtC = coords[edge.target];
    if (!srcC || !tgtC) continue;

    const srcCx = srcC.x + srcC.w / 2;
    const srcCy = srcC.y + srcC.h / 2;
    const tgtCx = tgtC.x + tgtC.w / 2;
    const tgtCy = tgtC.y + tgtC.h / 2;

    const dx = Math.abs(tgtCx - srcCx);
    const dy = Math.abs(tgtCy - srcCy);

    if (dy > dx) {
      // Primarily vertical (cross-lane): go down from source bottom, horizontal, up to target
      const srcExit = { x: srcCx, y: srcCy > tgtCy ? srcC.y : srcC.y + srcC.h };
      const tgtEntry = { x: tgtCx, y: srcCy > tgtCy ? tgtC.y + tgtC.h : tgtC.y };
      const midY = (srcExit.y + tgtEntry.y) / 2;
      edgeCoords[eid] = [
        srcExit,
        { x: srcCx, y: midY },
        { x: tgtCx, y: midY },
        tgtEntry,
      ];
    } else {
      // Primarily horizontal: right side → horizontal → up/down → horizontal → left side
      const srcExit = { x: srcC.x + srcC.w, y: srcCy };
      const tgtEntry = { x: tgtC.x, y: tgtCy };
      const midX = (srcExit.x + tgtEntry.x) / 2;
      edgeCoords[eid] = [
        srcExit,
        { x: midX, y: srcCy },
        { x: midX, y: tgtCy },
        tgtEntry,
      ];
    }
  }

  // §5.3  Force orthogonal: any remaining diagonal segments get converted
  //        to horizontal-then-vertical (or vice versa) dog-legs.
  for (const eid of Object.keys(edgeCoords)) {
    const pts = edgeCoords[eid];
    if (!pts || pts.length < 2) continue;
    edgeCoords[eid] = enforceOrthogonal(pts);
  }

  return { coords, laneCoords, poolCoords, edgeCoords };
}

/**
 * Force all segments in a polyline to be either horizontal or vertical.
 * Diagonal segments are converted to L-shaped dog-legs:
 *   - If the segment is more horizontal than vertical: go horizontal first, then vertical
 *   - If more vertical: go vertical first, then horizontal
 */
function enforceOrthogonal(pts) {
  if (pts.length < 2) return pts;
  const result = [pts[0]];

  for (let i = 1; i < pts.length; i++) {
    const prev = result[result.length - 1];
    const cur  = pts[i];
    const dx   = Math.abs(cur.x - prev.x);
    const dy   = Math.abs(cur.y - prev.y);

    // Already orthogonal (within tolerance)
    if (dx < 1 || dy < 1) {
      // Snap to exact axis
      if (dx < 1) {
        result.push({ x: prev.x, y: cur.y });
      } else {
        result.push({ x: cur.x, y: prev.y });
      }
      continue;
    }

    // Diagonal — insert a bend point to make it orthogonal
    // Prefer horizontal-first for left→right flow direction
    if (dx >= dy) {
      // Go horizontal to target x, then vertical to target y
      result.push({ x: cur.x, y: prev.y });
      result.push(cur);
    } else {
      // Go vertical to target y, then horizontal to target x
      result.push({ x: prev.x, y: cur.y });
      result.push(cur);
    }
  }
  return result;
}

function findNodeInAllProcesses(nodeId, processes) {
  for (const p of processes) {
    const found = (p.nodes || []).find(n => n.id === nodeId);
    if (found) return found;
  }
  return null;
}

/**
 * Orthogonal clipping: project endpoint onto shape boundary while keeping
 * the segment axis (horizontal or vertical) intact.
 *
 * @param shape   {x,y,w,h} of the actual BPMN shape
 * @param type    BPMN element type
 * @param edgePt  the endpoint to clip (start or end of the path)
 * @param nextPt  the adjacent point (determines segment direction)
 * @param role    'source' or 'target'
 */
function clipOrthogonal(shape, type, edgePt, nextPt, role) {
  const cx = shape.x + shape.w / 2;
  const cy = shape.y + shape.h / 2;

  // Determine if segment is horizontal or vertical
  const dx = Math.abs(nextPt.x - edgePt.x);
  const dy = Math.abs(nextPt.y - edgePt.y);
  const isHorizontal = dx >= dy;

  if (isEvent(type)) {
    const r = shape.w / 2;
    return clipCircleOrthogonal(cx, cy, r, nextPt, isHorizontal);
  }
  if (isGateway(type)) {
    return clipDiamondOrthogonal(shape, nextPt, isHorizontal);
  }
  // Activity / rectangle
  return clipRectOrthogonal(shape, nextPt, isHorizontal);
}

/**
 * Circle: for horizontal approach, place point at cx ± r on the y-level of nextPt.
 * For vertical approach, place at cy ± r on the x-level of nextPt.
 */
function clipCircleOrthogonal(cx, cy, r, nextPt, isHorizontal) {
  if (isHorizontal) {
    // Horizontal segment: keep y from nextPt, compute x on circle boundary
    const y = nextPt.y;
    const dyc = y - cy;
    // Clamp: if nextPt.y is outside the circle, snap to center height
    if (Math.abs(dyc) >= r) {
      return { x: nextPt.x > cx ? cx + r : cx - r, y: cy };
    }
    const xOffset = Math.sqrt(r * r - dyc * dyc);
    const x = nextPt.x > cx ? cx + xOffset : cx - xOffset;
    return { x, y };
  } else {
    // Vertical segment: keep x from nextPt, compute y on circle boundary
    const x = nextPt.x;
    const dxc = x - cx;
    if (Math.abs(dxc) >= r) {
      return { x: cx, y: nextPt.y > cy ? cy + r : cy - r };
    }
    const yOffset = Math.sqrt(r * r - dxc * dxc);
    const y = nextPt.y > cy ? cy + yOffset : cy - yOffset;
    return { x, y };
  }
}

/**
 * Diamond: for horizontal approach, find x where the diamond edge crosses the y-level.
 * For vertical, find y where the diamond edge crosses the x-level.
 * Diamond with center (cx,cy) and half-widths (hw,hh):
 *   |x-cx|/hw + |y-cy|/hh = 1
 */
function clipDiamondOrthogonal(shape, nextPt, isHorizontal) {
  const cx = shape.x + shape.w / 2;
  const cy = shape.y + shape.h / 2;
  const hw = shape.w / 2, hh = shape.h / 2;

  if (isHorizontal) {
    const y = nextPt.y;
    const dyc = Math.abs(y - cy);
    if (dyc >= hh) {
      // Outside diamond vertically, snap to tip
      return { x: cx, y: nextPt.y > cy ? cy + hh : cy - hh };
    }
    const xOffset = hw * (1 - dyc / hh);
    const x = nextPt.x > cx ? cx + xOffset : cx - xOffset;
    return { x, y };
  } else {
    const x = nextPt.x;
    const dxc = Math.abs(x - cx);
    if (dxc >= hw) {
      return { x: nextPt.x > cx ? cx + hw : cx - hw, y: cy };
    }
    const yOffset = hh * (1 - dxc / hw);
    const y = nextPt.y > cy ? cy + yOffset : cy - yOffset;
    return { x, y };
  }
}

/**
 * Rectangle: for horizontal approach, x = left or right edge, y stays.
 * For vertical, y = top or bottom edge, x stays.
 */
function clipRectOrthogonal(shape, nextPt, isHorizontal) {
  if (isHorizontal) {
    const y = nextPt.y;
    // Clamp y to be within the rect
    const clampedY = Math.max(shape.y, Math.min(shape.y + shape.h, y));
    const x = nextPt.x > shape.x + shape.w / 2 ? shape.x + shape.w : shape.x;
    return { x, y: clampedY };
  } else {
    const x = nextPt.x;
    const clampedX = Math.max(shape.x, Math.min(shape.x + shape.w, x));
    const y = nextPt.y > shape.y + shape.h / 2 ? shape.y + shape.h : shape.y;
    return { x: clampedX, y };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// §6  BPMN 2.0 XML GENERATION (OMG-compliant)
// ═══════════════════════════════════════════════════════════════════════

function generateBpmnXml(lc, coordMap) {
  const { coords, laneCoords, poolCoords, edgeCoords } = coordMap;
  const isMultiPool = lc.pools && lc.pools.length > 0;
  const processes   = isMultiPool ? lc.pools : [lc];
  const collapsedPools = lc.collapsedPools || [];
  const associations = lc.associations || [];

  const x = [];

  // §6.1  XML Header & namespace declarations
  x.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  x.push(`<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"`);
  x.push(`  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"`);
  x.push(`  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"`);
  x.push(`  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"`);
  x.push(`  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"`);
  x.push(`  id="Definitions_1"`);
  x.push(`  targetNamespace="http://bpmn.io/schema/bpmn">`);
  x.push('');

  // §6.1b  Top-level definitions: message, signal, error, escalation (OMG spec §9)
  const topLevelDefs = collectTopLevelDefinitions(processes);
  for (const def of topLevelDefs) {
    x.push(`  <${def.tag} id="${def.id}" name="${esc(def.name)}" />`);
  }
  if (topLevelDefs.length > 0) x.push('');

  // §6.2  Collaboration element
  const hasAnyLanes = processes.some(p => (p.lanes || []).length > 0);
  const needsCollaboration = isMultiPool || hasAnyLanes || collapsedPools.length > 0;

  if (needsCollaboration) {
    x.push(`  <collaboration id="Collaboration_1">`);

    // Expanded pool participants (with processRef)
    for (const proc of processes) {
      const partId = `Participant_${proc.id}`;
      x.push(`    <participant id="${partId}" processRef="${proc.id}" name="${esc(proc.name || '')}" />`);
    }

    // Collapsed pool participants (no processRef — black box, OMG spec §9.3)
    for (const cp of collapsedPools) {
      const partId = `Participant_${cp.id}`;
      x.push(`    <participant id="${partId}" name="${esc(cp.name || '')}" />`);
    }

    // Message flows (OMG spec §9.4)
    if (lc.messageFlows) {
      for (const mf of lc.messageFlows) {
        const srcRef = resolveMessageFlowRef(mf.source, processes, collapsedPools);
        const tgtRef = resolveMessageFlowRef(mf.target, processes, collapsedPools);
        x.push(`    <messageFlow id="${mf.id}" name="${esc(mf.name || '')}" sourceRef="${srcRef}" targetRef="${tgtRef}" />`);
      }
    }
    x.push(`  </collaboration>`);
    x.push('');
  }

  // §6.4  Process elements (only for expanded pools)
  for (const proc of processes) {
    const nodes = proc.nodes || [];
    const edges = proc.edges || [];
    const lanes = proc.lanes || [];

    inferGatewayDirections(nodes, edges);

    // Build incoming/outgoing maps
    const incomingMap = {}, outgoingMap = {};
    for (const e of edges) {
      const eid = e.id || `flow_${e.source}_${e.target}`;
      if (!outgoingMap[e.source]) outgoingMap[e.source] = [];
      outgoingMap[e.source].push(eid);
      if (!incomingMap[e.target]) incomingMap[e.target] = [];
      incomingMap[e.target].push(eid);
    }

    // Build default flow map (gateway → default edge id)
    // For XOR/Inclusive gateways with >1 outgoing: auto-assign last flow as default
    // if no explicit isDefault is set (OMG spec §10.5.1)
    const defaultFlowMap = {};
    for (const e of edges) {
      if (e.isDefault) {
        defaultFlowMap[e.source] = e.id || `flow_${e.source}_${e.target}`;
      }
    }
    for (const n of nodes) {
      if ((n.type === 'exclusiveGateway' || n.type === 'inclusiveGateway') &&
          n._direction === 'Diverging' && !defaultFlowMap[n.id]) {
        const gwOutEdges = edges.filter(e => e.source === n.id);
        if (gwOutEdges.length > 1) {
          // Pick the last outgoing edge as default (typically the "else" branch)
          const defaultEdge = gwOutEdges[gwOutEdges.length - 1];
          defaultFlowMap[n.id] = defaultEdge.id || `flow_${defaultEdge.source}_${defaultEdge.target}`;
        }
      }
    }

    x.push(`  <process id="${proc.id}" isExecutable="false">`);

    // Process-level documentation
    if (proc.documentation) {
      x.push(`    <documentation>${esc(proc.documentation)}</documentation>`);
    }

    // §6.5  LaneSet — ONE laneSet per process (OMG spec §10.5)
    if (lanes.length > 0) {
      x.push(`    <laneSet id="LaneSet_${proc.id || '1'}">`);
      for (const lane of lanes) {
        x.push(`      <lane id="${lane.id}" name="${esc(lane.name || lane.id)}">`);
        nodes.filter(n => n.lane === lane.id)
             .forEach(n => x.push(`        <flowNodeRef>${n.id}</flowNodeRef>`));
        x.push(`      </lane>`);
      }
      x.push(`    </laneSet>`);
    }

    // §6.6  Flow nodes
    for (const node of nodes) {
      const tag  = bpmnXmlTag(node.type);
      const attrs = [`id="${node.id}"`, `name="${esc(node.name || '')}"`];

      // Gateway direction (OMG spec §10.5.1)
      if (isGateway(node.type) && node._direction) {
        attrs.push(`gatewayDirection="${node._direction}"`);
      }

      // Default flow attribute on splitting gateways (OMG spec §10.5.1)
      if (isGateway(node.type) && defaultFlowMap[node.id]) {
        attrs.push(`default="${defaultFlowMap[node.id]}"`);
      }

      // Boundary event attachment
      if (isBoundaryEvent(node)) {
        attrs.push(`attachedToRef="${node.attachedTo}"`);
        if (node.cancelActivity === false) attrs.push(`cancelActivity="false"`);
      }

      const incoming = incomingMap[node.id] || [];
      const outgoing = outgoingMap[node.id] || [];
      const eventDef = getEventDefinitionXml(node, topLevelDefs);
      const needsBody = incoming.length > 0 || outgoing.length > 0 || eventDef ||
                        node.loopType || node.multiInstance || node.documentation;

      if (!needsBody) {
        x.push(`    <${tag} ${attrs.join(' ')} />`);
      } else {
        x.push(`    <${tag} ${attrs.join(' ')}>`);

        // Documentation (OMG spec §8.3.1)
        if (node.documentation) {
          x.push(`      <documentation>${esc(node.documentation)}</documentation>`);
        }

        for (const inc of incoming) x.push(`      <incoming>${inc}</incoming>`);
        for (const out of outgoing) x.push(`      <outgoing>${out}</outgoing>`);

        if (eventDef) x.push(eventDef);

        // Loop / Multi-instance (OMG spec §10.2.2)
        if (node.loopType === 'standard') {
          x.push(`      <standardLoopCharacteristics />`);
        } else if (node.multiInstance === 'parallel') {
          x.push(`      <multiInstanceLoopCharacteristics isSequential="false" />`);
        } else if (node.multiInstance === 'sequential') {
          x.push(`      <multiInstanceLoopCharacteristics isSequential="true" />`);
        }

        x.push(`    </${tag}>`);
      }
    }

    // §6.7  Sequence flows
    // Build set of default flow IDs for conditionExpression logic
    const defaultFlowIds = new Set(Object.values(defaultFlowMap));
    for (const edge of edges) {
      const eid = edge.id || `flow_${edge.source}_${edge.target}`;
      const attrs = [`id="${eid}"`, `sourceRef="${edge.source}"`, `targetRef="${edge.target}"`];
      if (edge.label) attrs.push(`name="${esc(edge.label)}"`);

      // Determine if this flow needs a conditionExpression:
      // Non-default outgoing flows from XOR/Inclusive gateways (OMG spec §10.5.1)
      const sourceNode = nodes.find(n => n.id === edge.source);
      const needsCondition = edge.condition ||
        (sourceNode && (sourceNode.type === 'exclusiveGateway' || sourceNode.type === 'inclusiveGateway') &&
         sourceNode._direction === 'Diverging' && !defaultFlowIds.has(eid));

      if (needsCondition) {
        const expr = edge.condition || edge.label || '';
        x.push(`    <sequenceFlow ${attrs.join(' ')}>`);
        x.push(`      <conditionExpression xsi:type="tFormalExpression">${esc(expr)}</conditionExpression>`);
        x.push(`    </sequenceFlow>`);
      } else {
        x.push(`    <sequenceFlow ${attrs.join(' ')} />`);
      }
    }

    // §6.8  Data objects
    for (const node of nodes) {
      if (node.type === 'dataObjectReference') {
        x.push(`    <dataObject id="${node.id}_do" />`);
      }
    }

    // §6.8b  Associations (OMG spec §7.2)
    const procAssociations = associations.filter(a => {
      const srcInProc = nodes.some(n => n.id === a.source);
      const tgtInProc = nodes.some(n => n.id === a.target);
      return srcInProc || tgtInProc;
    });
    for (const assoc of procAssociations) {
      const dir = assoc.directed ? ` associationDirection="One"` : '';
      x.push(`    <association id="${assoc.id}" sourceRef="${assoc.source}" targetRef="${assoc.target}"${dir} />`);
    }

    x.push(`  </process>`);
    x.push('');
  }

  // §6.9  BPMN Diagram Interchange (DI)
  x.push(`  <bpmndi:BPMNDiagram id="BPMNDiagram_1">`);
  x.push(`    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="${needsCollaboration ? 'Collaboration_1' : processes[0].id}">`);

  // Pool shapes (expanded + collapsed)
  if (needsCollaboration) {
    for (const proc of processes) {
      const partId = `Participant_${proc.id}`;
      const pc = poolCoords[proc.id] || poolCoords['_singlePool'];
      if (pc) {
        let px = pc.x, py = pc.y, pw = pc.w, ph = pc.h;
        const lanes = proc.lanes || [];
        if (lanes.length > 0) {
          const lcs = lanes.map(l => laneCoords[l.id]).filter(Boolean);
          if (lcs.length) {
            px = Math.min(...lcs.map(l => l.x)) - LANE_HEADER_W;
            py = Math.min(...lcs.map(l => l.y));
            pw = Math.max(...lcs.map(l => l.x + l.w)) - px;
            ph = Math.max(...lcs.map(l => l.y + l.h)) - py;
          }
        }
        x.push(`      <bpmndi:BPMNShape id="${partId}_di" bpmnElement="${partId}" isHorizontal="true">`);
        x.push(`        <dc:Bounds x="${rn(px)}" y="${rn(py)}" width="${rn(pw)}" height="${rn(ph)}" />`);
        x.push(`      </bpmndi:BPMNShape>`);
      }

      for (const lane of (proc.lanes || [])) {
        const lcc = laneCoords[lane.id];
        if (!lcc) continue;
        x.push(`      <bpmndi:BPMNShape id="${lane.id}_di" bpmnElement="${lane.id}" isHorizontal="true">`);
        x.push(`        <dc:Bounds x="${rn(lcc.x)}" y="${rn(lcc.y)}" width="${rn(lcc.w)}" height="${rn(lcc.h)}" />`);
        x.push(`      </bpmndi:BPMNShape>`);
      }
    }

    // Collapsed pool shapes
    for (const cp of collapsedPools) {
      const partId = `Participant_${cp.id}`;
      const pc = poolCoords[cp.id];
      if (pc) {
        x.push(`      <bpmndi:BPMNShape id="${partId}_di" bpmnElement="${partId}" isHorizontal="true">`);
        x.push(`        <dc:Bounds x="${rn(pc.x)}" y="${rn(pc.y)}" width="${rn(pc.w)}" height="${rn(pc.h)}" />`);
        x.push(`      </bpmndi:BPMNShape>`);
      }
    }
  }

  // Node shapes with DI Label Bounds
  for (const proc of processes) {
    for (const node of (proc.nodes || [])) {
      const c = coords[node.id];
      if (!c) continue;
      const markerAttr = (node.type === 'exclusiveGateway') ? ' isMarkerVisible="true"' : '';
      x.push(`      <bpmndi:BPMNShape id="${node.id}_di" bpmnElement="${node.id}"${markerAttr}>`);
      x.push(`        <dc:Bounds x="${rn(c.x)}" y="${rn(c.y)}" width="${rn(c.w)}" height="${rn(c.h)}" />`);

      // DI Label Bounds (OMG spec §12.1) — calculate actual label position
      if ((isEvent(node.type) || isGateway(node.type)) && node.name) {
        const labelW = Math.min(node.name.length * 6.5 + 10, 90);
        const labelX = c.x + c.w / 2 - labelW / 2;
        const labelY = c.y + c.h + LABEL_DISTANCE;
        x.push(`        <bpmndi:BPMNLabel>`);
        x.push(`          <dc:Bounds x="${rn(labelX)}" y="${rn(labelY)}" width="${rn(labelW)}" height="${rn(20)}" />`);
        x.push(`        </bpmndi:BPMNLabel>`);
      }
      x.push(`      </bpmndi:BPMNShape>`);
    }
  }

  // Edge shapes
  for (const proc of processes) {
    for (const edge of (proc.edges || [])) {
      const eid = edge.id || `flow_${edge.source}_${edge.target}`;
      const pts = edgeCoords[eid] || [];
      x.push(`      <bpmndi:BPMNEdge id="${eid}_di" bpmnElement="${eid}">`);
      if (pts.length >= 2) {
        for (const p of pts) x.push(`        <di:waypoint x="${rn(p.x)}" y="${rn(p.y)}" />`);
      } else {
        const s = coords[edge.source], t = coords[edge.target];
        if (s && t) {
          x.push(`        <di:waypoint x="${rn(s.x + s.w/2)}" y="${rn(s.y + s.h/2)}" />`);
          x.push(`        <di:waypoint x="${rn(t.x + t.w/2)}" y="${rn(t.y + t.h/2)}" />`);
        }
      }
      // Edge label DI bounds
      if (edge.label && pts.length >= 2) {
        const mi = Math.min(1, pts.length - 1);
        const lx = pts[mi].x, ly = pts[mi].y;
        x.push(`        <bpmndi:BPMNLabel>`);
        x.push(`          <dc:Bounds x="${rn(lx)}" y="${rn(ly - 12)}" width="${rn(edge.label.length * 6.5 + 8)}" height="${rn(16)}" />`);
        x.push(`        </bpmndi:BPMNLabel>`);
      }
      x.push(`      </bpmndi:BPMNEdge>`);
    }
  }

  // Message flow DI
  if (lc.messageFlows) {
    for (const mf of lc.messageFlows) {
      const srcCoord = coords[mf.source] || poolCoords[mf.source];
      const tgtCoord = coords[mf.target] || poolCoords[mf.target];
      x.push(`      <bpmndi:BPMNEdge id="${mf.id}_di" bpmnElement="${mf.id}">`);
      if (srcCoord && tgtCoord) {
        const sx = (srcCoord.x || 0) + (srcCoord.w || 0) / 2;
        const sy = (srcCoord.y || 0) + (srcCoord.h || 0);
        const tx = (tgtCoord.x || 0) + (tgtCoord.w || 0) / 2;
        const ty = tgtCoord.y || 0;
        x.push(`        <di:waypoint x="${rn(sx)}" y="${rn(sy)}" />`);
        x.push(`        <di:waypoint x="${rn(tx)}" y="${rn(ty)}" />`);
      }
      x.push(`      </bpmndi:BPMNEdge>`);
    }
  }

  // Association DI
  for (const assoc of associations) {
    const srcC = coords[assoc.source];
    const tgtC = coords[assoc.target];
    if (srcC && tgtC) {
      x.push(`      <bpmndi:BPMNEdge id="${assoc.id}_di" bpmnElement="${assoc.id}">`);
      x.push(`        <di:waypoint x="${rn(srcC.x + srcC.w/2)}" y="${rn(srcC.y + srcC.h/2)}" />`);
      x.push(`        <di:waypoint x="${rn(tgtC.x + tgtC.w/2)}" y="${rn(tgtC.y + tgtC.h/2)}" />`);
      x.push(`      </bpmndi:BPMNEdge>`);
    }
  }

  x.push(`    </bpmndi:BPMNPlane>`);
  x.push(`  </bpmndi:BPMNDiagram>`);
  x.push(`</definitions>`);
  return x.join('\n');
}

function resolveMessageFlowRef(ref, processes, collapsedPools) {
  for (const p of processes) {
    if (p.id === ref) return `Participant_${ref}`;
  }
  for (const cp of (collapsedPools || [])) {
    if (cp.id === ref) return `Participant_${ref}`;
  }
  return ref; // node id
}

// §6.10  Collect top-level definitions (OMG spec §8.4, §9)
function collectTopLevelDefinitions(processes) {
  const defs = [];
  const seen = new Set();

  for (const proc of processes) {
    for (const node of (proc.nodes || [])) {
      const marker = node.marker || inferEventMarker(node.name || '');
      if (!marker || seen.has(marker)) continue;

      const tag = {
        message: 'message', timer: null, error: 'error', signal: 'signal',
        escalation: 'escalation', compensation: null, conditional: null,
        link: null, cancel: null, terminate: null, multiple: null, parallelMultiple: null,
      }[marker];

      if (tag) {
        seen.add(marker);
        const id = `${tag.charAt(0).toUpperCase() + tag.slice(1)}_${defs.length + 1}`;
        const name = marker.charAt(0).toUpperCase() + marker.slice(1);
        defs.push({ tag, id, name, marker });
      }
    }
  }
  return defs;
}

function getEventDefinitionXml(node, topLevelDefs) {
  const marker = node.marker || inferEventMarker(node.name || '');
  if (!marker) return null;
  const indent = '      ';

  // Find matching top-level definition for ref attribute
  const topDef = (topLevelDefs || []).find(d => d.marker === marker);
  const refAttr = topDef ? ` ${topDef.tag}Ref="${topDef.id}"` : '';

  switch (marker) {
    case 'message':      return `${indent}<messageEventDefinition${refAttr} />`;
    case 'timer':        return `${indent}<timerEventDefinition />`;
    case 'error':        return `${indent}<errorEventDefinition${refAttr} />`;
    case 'signal':       return `${indent}<signalEventDefinition${refAttr} />`;
    case 'escalation':   return `${indent}<escalationEventDefinition${refAttr} />`;
    case 'compensation': return `${indent}<compensateEventDefinition />`;
    case 'conditional':  return `${indent}<conditionalEventDefinition />`;
    case 'link':         return `${indent}<linkEventDefinition />`;
    case 'cancel':       return `${indent}<cancelEventDefinition />`;
    case 'terminate':    return `${indent}<terminateEventDefinition />`;
    default: return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// §7  SVG GENERATION (OMG BPMN 2.0 compliant visual rendering)
// ═══════════════════════════════════════════════════════════════════════

function generateSvg(lc, coordMap) {
  const { coords, laneCoords, poolCoords, edgeCoords } = coordMap;
  const processes = lc.pools ? lc.pools : [lc];
  const allNodes  = processes.flatMap(p => p.nodes || []);
  const allEdges  = processes.flatMap(p => p.edges || []);
  const allLanes  = processes.flatMap(p => p.lanes || []);

  // §7.1  Compute canvas bounds
  const PADDING = 50;
  const allPts = [
    ...Object.values(coords).flatMap(c => [
      { x: c.x, y: c.y },
      { x: c.x + c.w, y: c.y + c.h + 30 },
    ]),
    ...Object.values(laneCoords).flatMap(l => [
      { x: l.x - LANE_HEADER_W, y: l.y },
      { x: l.x + l.w, y: l.y + l.h },
    ]),
    ...Object.values(poolCoords).flatMap(p => [
      { x: p.x, y: p.y },
      { x: p.x + p.w, y: p.y + p.h },
    ]),
    ...Object.values(edgeCoords).flatMap(pts => pts),
  ];
  if (!allPts.length)
    return `<svg xmlns="http://www.w3.org/2000/svg"><text y="20">No elements</text></svg>`;

  const minX = Math.min(...allPts.map(p => p.x)) - PADDING;
  const minY = Math.min(...allPts.map(p => p.y)) - PADDING;
  const maxX = Math.max(...allPts.map(p => p.x)) + PADDING;
  const maxY = Math.max(...allPts.map(p => p.y)) + PADDING;
  const W = maxX - minX;
  const H = maxY - minY;
  const tx = v => rn(v - minX);
  const ty = v => rn(v - minY);

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${rn(W)}" height="${rn(H)}" viewBox="0 0 ${rn(W)} ${rn(H)}" font-family="Arial, sans-serif">`);

  // §7.2  SVG Defs — markers for all connection types
  out.push(`<defs>
  <!-- Sequence flow: filled triangle (OMG spec Fig 10.43) -->
  <marker id="seq-end" viewBox="0 0 20 20" refX="11" refY="10"
    markerWidth="10" markerHeight="10" orient="auto">
    <path d="M 1 5 L 11 10 L 1 15 Z" fill="${CLR.stroke}" stroke="${CLR.stroke}" stroke-width="1"/>
  </marker>
  <!-- Default flow: diagonal slash at source (OMG spec Fig 10.47) -->
  <marker id="seq-default-src" viewBox="0 0 20 20" refX="6" refY="10"
    markerWidth="10" markerHeight="10" orient="auto">
    <path d="M 6 3 L 10 17" stroke="${CLR.stroke}" stroke-width="1.5"/>
  </marker>
  <!-- Conditional flow: open diamond at source (OMG spec Fig 10.48) -->
  <marker id="seq-conditional-src" viewBox="0 0 20 20" refX="1" refY="10"
    markerWidth="12" markerHeight="12" orient="auto">
    <path d="M 1 10 L 8 6 L 15 10 L 8 14 Z" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="1"/>
  </marker>
  <!-- Message flow: open circle at source (OMG spec Fig 9.5) -->
  <marker id="msg-start" viewBox="0 0 20 20" refX="6" refY="6"
    markerWidth="20" markerHeight="20" orient="auto">
    <circle cx="6" cy="6" r="3.5" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="1"/>
  </marker>
  <!-- Message flow: open arrowhead at target -->
  <marker id="msg-end" viewBox="0 0 20 20" refX="8.5" refY="5"
    markerWidth="20" markerHeight="20" orient="auto">
    <path d="m 1 5 l 0 -3 l 7 3 l -7 3 z" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="1" stroke-linecap="butt"/>
  </marker>
  <!-- Association: open chevron -->
  <marker id="assoc-end" viewBox="0 0 20 20" refX="11" refY="10"
    markerWidth="10" markerHeight="10" orient="auto">
    <path d="M 1 5 L 11 10 L 1 15" fill="none" stroke="${CLR.stroke}" stroke-width="1.5"/>
  </marker>
</defs>`);

  // §7.3  Canvas background
  out.push(`<rect width="${rn(W)}" height="${rn(H)}" fill="${CLR.canvasBg}"/>`);

  // §7.4  Pool outlines + headers (multi-pool)
  const isMultiPool = lc.pools && lc.pools.length > 0;
  const collapsedPools = lc.collapsedPools || [];

  if (isMultiPool) {
    for (const proc of lc.pools) {
      const pc = poolCoords[proc.id];
      if (!pc) continue;
      renderPoolSvg(out, proc, pc, laneCoords, tx, ty);
    }
  } else if (allLanes.length > 0) {
    // Single pool with lanes
    const allLc = allLanes.map(l => laneCoords[l.id]).filter(Boolean);
    if (allLc.length) {
      const px = Math.min(...allLc.map(l => l.x)) - LANE_HEADER_W;
      const py = Math.min(...allLc.map(l => l.y));
      const pw = Math.max(...allLc.map(l => l.x + l.w)) - px;
      const ph = Math.max(...allLc.map(l => l.y + l.h)) - py;

      out.push(`<rect x="${tx(px)}" y="${ty(py)}" width="${pw}" height="${ph}" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="${SW.pool}"/>`);
      out.push(`<rect x="${tx(px)}" y="${ty(py)}" width="${LANE_HEADER_W}" height="${ph}" fill="${CLR.poolHeader}" stroke="${CLR.stroke}" stroke-width="${SW.pool}"/>`);
      const plcx = tx(px) + LANE_HEADER_W / 2;
      const plcy = ty(py) + ph / 2;
      out.push(`<text x="${plcx}" y="${plcy}" text-anchor="middle" dominant-baseline="middle" font-size="12" font-weight="bold" fill="${CLR.label}" transform="rotate(-90,${plcx},${plcy})">${esc(lc.name || 'Process')}</text>`);
    }
  }

  // §7.4b  Collapsed pools (black-box bands, bpmn-js 600×60)
  for (const cp of collapsedPools) {
    const pc = poolCoords[cp.id];
    if (!pc) continue;
    out.push(`<rect x="${tx(pc.x)}" y="${ty(pc.y)}" width="${pc.w}" height="${pc.h}" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="${SW.pool}"/>`);
    const cx = tx(pc.x) + pc.w / 2;
    const cy = ty(pc.y) + pc.h / 2;
    out.push(`<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" font-size="12" font-weight="bold" fill="${CLR.label}">${esc(cp.name || cp.id)}</text>`);
  }

  // §7.5  Lane bodies
  for (const lane of allLanes) {
    const lcc = laneCoords[lane.id];
    if (!lcc) continue;
    out.push(`<rect x="${tx(lcc.x)}" y="${ty(lcc.y)}" width="${lcc.w}" height="${lcc.h}" fill="${CLR.fill}" fill-opacity="0.25" stroke="${CLR.stroke}" stroke-width="${SW.lane}"/>`);
    // Lane header band
    out.push(`<rect x="${tx(lcc.x - LANE_HEADER_W)}" y="${ty(lcc.y)}" width="${LANE_HEADER_W}" height="${lcc.h}" fill="${CLR.laneHeader}" stroke="${CLR.stroke}" stroke-width="${SW.lane}"/>`);
    const lcx = tx(lcc.x - LANE_HEADER_W) + LANE_HEADER_W / 2;
    const lcy = ty(lcc.y) + lcc.h / 2;
    out.push(`<text x="${lcx}" y="${lcy}" text-anchor="middle" dominant-baseline="middle" font-size="11" fill="${CLR.label}" transform="rotate(-90,${lcx},${lcy})">${esc(lane.name || lane.id)}</text>`);
  }

  // §7.6  Sequence flows
  for (const edge of allEdges) {
    const eid = edge.id || `flow_${edge.source}_${edge.target}`;
    const pts = edgeCoords[eid] || [];
    renderSequenceFlow(out, edge, pts, coords, tx, ty);
  }

  // §7.7  Message flows (dashed, orthogonal routing, OMG spec Fig 9.5)
  if (lc.messageFlows) {
    for (const mf of lc.messageFlows) {
      const srcCoord = coords[mf.source] || poolCoords[mf.source];
      const tgtCoord = coords[mf.target] || poolCoords[mf.target];
      if (!srcCoord || !tgtCoord) continue;

      // Source: bottom-center of shape; Target: top-center of shape
      const sx = tx((srcCoord.x || 0) + (srcCoord.w || 0) / 2);
      const sy = ty((srcCoord.y || 0) + (srcCoord.h || 0));
      const ex = tx((tgtCoord.x || 0) + (tgtCoord.w || 0) / 2);
      const ey = ty(tgtCoord.y || 0);

      // Determine if source is above or below target
      const goingDown = sy < ey;
      let pathD;

      if (Math.abs(sx - ex) < 2) {
        // Vertically aligned — straight line
        pathD = `M ${sx} ${sy} L ${ex} ${ey}`;
      } else {
        // Dog-leg: vertical → horizontal → vertical
        const midY = rn((sy + ey) / 2);
        pathD = `M ${sx} ${sy} L ${sx} ${midY} L ${ex} ${midY} L ${ex} ${ey}`;
      }

      out.push(`<path d="${pathD}" stroke="${CLR.stroke}" stroke-width="${SW.connection}" fill="none" stroke-dasharray="10,12" marker-start="url(#msg-start)" marker-end="url(#msg-end)"/>`);
      if (mf.name) {
        const mx = rn((sx + ex) / 2), my = rn((sy + ey) / 2);
        renderEdgeLabel(out, mf.name, mx, my);
      }
    }
  }

  // §7.8  Associations (dotted lines, OMG spec §7.2)
  const allAssociations = lc.associations || [];
  for (const assoc of allAssociations) {
    const srcC = coords[assoc.source];
    const tgtC = coords[assoc.target];
    if (!srcC || !tgtC) continue;
    const sx = tx(srcC.x + srcC.w / 2), sy = ty(srcC.y + srcC.h / 2);
    const ex = tx(tgtC.x + tgtC.w / 2), ey = ty(tgtC.y + tgtC.h / 2);
    const markerEnd = assoc.directed ? ` marker-end="url(#assoc-end)"` : '';
    out.push(`<path d="M ${sx} ${sy} L ${ex} ${ey}" stroke="${CLR.stroke}" stroke-width="1.5" fill="none" stroke-dasharray="0.5,5"${markerEnd}/>`);
  }

  // §7.9  Nodes
  for (const node of allNodes) {
    const c = coords[node.id];
    if (!c) continue;
    out.push(renderNode(node, c, tx, ty));
  }

  out.push(`</svg>`);
  return out.join('\n');
}

function renderPoolSvg(out, proc, pc, laneCoords, tx, ty) {
  const lanes = proc.lanes || [];
  let px = pc.x, py = pc.y, pw = pc.w, ph = pc.h;

  if (lanes.length > 0) {
    const lcs = lanes.map(l => laneCoords[l.id]).filter(Boolean);
    if (lcs.length) {
      px = Math.min(...lcs.map(l => l.x)) - LANE_HEADER_W;
      py = Math.min(...lcs.map(l => l.y));
      pw = Math.max(...lcs.map(l => l.x + l.w)) - px;
      ph = Math.max(...lcs.map(l => l.y + l.h)) - py;
    }
  }

  out.push(`<rect x="${tx(px)}" y="${ty(py)}" width="${pw}" height="${ph}" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="${SW.pool}"/>`);
  out.push(`<rect x="${tx(px)}" y="${ty(py)}" width="${LANE_HEADER_W}" height="${ph}" fill="${CLR.poolHeader}" stroke="${CLR.stroke}" stroke-width="${SW.pool}"/>`);
  const plcx = tx(px) + LANE_HEADER_W / 2;
  const plcy = ty(py) + ph / 2;
  out.push(`<text x="${plcx}" y="${plcy}" text-anchor="middle" dominant-baseline="middle" font-size="12" font-weight="bold" fill="${CLR.label}" transform="rotate(-90,${plcx},${plcy})">${esc(proc.name || 'Process')}</text>`);
}

function renderSequenceFlow(out, edge, pts, coords, tx, ty) {
  let pathD;
  if (pts.length >= 2) {
    pathD = `M ${tx(pts[0].x)} ${ty(pts[0].y)} ` +
            pts.slice(1).map(p => `L ${tx(p.x)} ${ty(p.y)}`).join(' ');
  } else {
    const s = coords[edge.source], t = coords[edge.target];
    if (!s || !t) return;
    pathD = `M ${tx(s.x + s.w/2)} ${ty(s.y + s.h/2)} L ${tx(t.x + t.w/2)} ${ty(t.y + t.h/2)}`;
  }

  const markerEnd = `marker-end="url(#seq-end)"`;
  const markerStart = edge.isDefault     ? `marker-start="url(#seq-default-src)"`
                    : edge.isConditional ? `marker-start="url(#seq-conditional-src)"`
                    : '';

  out.push(`<path d="${pathD}" stroke="${CLR.stroke}" stroke-width="${SW.connection}" fill="none" ${markerStart} ${markerEnd}/>`);

  // Edge label — position near first segment after source (gateway convention)
  if (edge.label) {
    let labelX, labelY;
    if (pts.length >= 3) {
      // Place at first bend point (right after the gateway)
      labelX = tx(pts[1].x); labelY = ty(pts[1].y);
    } else if (pts.length >= 2) {
      // Short edge: place at 30% from source
      const p0 = pts[0], p1 = pts[1];
      labelX = tx(p0.x + (p1.x - p0.x) * 0.3);
      labelY = ty(p0.y + (p1.y - p0.y) * 0.3);
    } else {
      const s = coords[edge.source], t = coords[edge.target];
      if (s && t) {
        labelX = tx((s.x + s.w/2 + t.x + t.w/2) / 2);
        labelY = ty((s.y + s.h/2 + t.y + t.h/2) / 2);
      }
    }
    if (labelX != null) renderEdgeLabel(out, edge.label, labelX, labelY);
  }
}

function renderEdgeLabel(out, label, midX, midY) {
  const w = label.length * 6.5 + 8;
  out.push(`<rect x="${rn(midX - w/2)}" y="${rn(midY - 8)}" width="${rn(w)}" height="16" rx="2" fill="white" fill-opacity="0.9"/>`);
  out.push(`<text x="${rn(midX)}" y="${rn(midY + 4)}" text-anchor="middle" font-size="10" fill="${CLR.label}">${esc(label)}</text>`);
}

// ─────────────────────────────────────────────────────────────────────
// NODE RENDERERS
// ─────────────────────────────────────────────────────────────────────
function renderNode(node, c, tx, ty) {
  const type = node.type || 'task';
  if (isEvent(type))         return renderEvent(node, c, tx, ty);
  if (isGateway(type))       return renderGateway(node, c, tx, ty);
  if (isDataArtifact(type))  return renderDataArtifact(node, c, tx, ty);
  return renderActivity(node, c, tx, ty);
}

// ── Events (OMG spec §10.4) ─────────────────────────────────────────
function renderEvent(node, c, tx, ty) {
  const type   = node.type;
  const cx     = tx(c.x + c.w / 2);
  const cy     = ty(c.y + c.h / 2);
  const r      = c.w / 2;
  const o      = [];

  const isStart = type === 'startEvent';
  const isEnd   = type === 'endEvent';
  const isInter = type.includes('intermediate') || type === 'boundaryEvent';
  const isThrow = type === 'intermediateThrowEvent';
  const isNonInterrupting = node.isInterrupting === false || node.cancelActivity === false;

  const sw = isEnd ? SW.endEvent : isStart ? SW.startEvent : SW.intermediate;
  const dash = isNonInterrupting ? ` stroke-dasharray="5,3"` : '';

  // Outer circle
  o.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${CLR.fill}" fill-opacity="0.95" stroke="${CLR.stroke}" stroke-width="${sw}"${dash}/>`);

  // Intermediate/boundary: inner ring (3px gap, OMG spec Table 10.87)
  if (isInter) {
    const ri = r - INNER_OUTER_GAP;
    o.push(`<circle cx="${cx}" cy="${cy}" r="${ri}" fill="none" stroke="${CLR.stroke}" stroke-width="${SW.intermediate}"${dash}/>`);
  }

  // Marker icon inside
  const marker = node.marker || inferEventMarker(node.name || '');
  if (marker && marker !== 'terminate') {
    o.push(renderEventMarker(marker, cx, cy, r, isThrow || isEnd));
  }
  if (isEnd && marker === 'terminate') {
    o.push(`<circle cx="${cx}" cy="${cy}" r="${rn(r * 0.55)}" fill="${CLR.stroke}"/>`);
  }

  // External label below shape
  const labelY = ty(c.y + c.h) + LABEL_DISTANCE;
  o.push(renderExternalLabel(node.name || '', cx, labelY, 90));

  return o.join('\n');
}

// ── Gateways (OMG spec §10.5) ───────────────────────────────────────
function renderGateway(node, c, tx, ty) {
  const type = node.type;
  const x = tx(c.x), y = ty(c.y), w = c.w, h = c.h;
  const cx = x + w/2, cy = y + h/2;
  const o = [];

  // Diamond shape
  o.push(`<polygon points="${cx},${y} ${x+w},${cy} ${cx},${y+h} ${x},${cy}" fill="${CLR.fill}" fill-opacity="0.95" stroke="${CLR.stroke}" stroke-width="${SW.gateway}"/>`);

  // Internal marker
  const d = 9;
  if (type === 'exclusiveGateway') {
    // X mark (OMG spec Fig 10.59)
    o.push(`<line x1="${cx-d}" y1="${cy-d}" x2="${cx+d}" y2="${cy+d}" stroke="${CLR.stroke}" stroke-width="3" stroke-linecap="round"/>`);
    o.push(`<line x1="${cx+d}" y1="${cy-d}" x2="${cx-d}" y2="${cy+d}" stroke="${CLR.stroke}" stroke-width="3" stroke-linecap="round"/>`);
  } else if (type === 'parallelGateway') {
    // + mark (OMG spec Fig 10.69)
    o.push(`<line x1="${cx}" y1="${cy-d}" x2="${cx}" y2="${cy+d}" stroke="${CLR.stroke}" stroke-width="3.5" stroke-linecap="round"/>`);
    o.push(`<line x1="${cx-d}" y1="${cy}" x2="${cx+d}" y2="${cy}" stroke="${CLR.stroke}" stroke-width="3.5" stroke-linecap="round"/>`);
  } else if (type === 'inclusiveGateway') {
    // Bold circle (OMG spec Fig 10.64)
    o.push(`<circle cx="${cx}" cy="${cy}" r="${rn(h * 0.24)}" fill="none" stroke="${CLR.stroke}" stroke-width="2.5"/>`);
  } else if (type === 'eventBasedGateway') {
    // Circle + pentagon (OMG spec Fig 10.73)
    o.push(`<circle cx="${cx}" cy="${cy}" r="${rn(h * 0.22)}" fill="none" stroke="${CLR.stroke}" stroke-width="1.5"/>`);
    o.push(renderPentagon(cx, cy, h * 0.14, CLR.stroke));
  } else if (type === 'complexGateway') {
    // Asterisk (OMG spec Fig 10.67)
    for (const a of [0, 45, 90, 135]) {
      const rad = a * Math.PI / 180;
      const ddx = Math.cos(rad) * d, ddy = Math.sin(rad) * d;
      o.push(`<line x1="${rn(cx-ddx)}" y1="${rn(cy-ddy)}" x2="${rn(cx+ddx)}" y2="${rn(cy+ddy)}" stroke="${CLR.stroke}" stroke-width="2.5" stroke-linecap="round"/>`);
    }
  }

  // External label below diamond
  const labelY = ty(c.y + c.h) + LABEL_DISTANCE;
  o.push(renderExternalLabel(node.name || '', cx, labelY, 90));

  return o.join('\n');
}

// ── Activities (OMG spec §10.2) ─────────────────────────────────────
function renderActivity(node, c, tx, ty) {
  const type = node.type || 'task';
  const x = tx(c.x), y = ty(c.y), w = c.w, h = c.h;
  const cx = x + w/2, cy = y + h/2;
  const o = [];

  const sw = type === 'callActivity' ? SW.callActivity : SW.task;
  const dash = node.isEventSubProcess ? ` stroke-dasharray="7,3"` : '';

  // Main rectangle (rx=10 per bpmn-js)
  o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${TASK_RX}" ry="${TASK_RX}" fill="${CLR.fill}" fill-opacity="0.95" stroke="${CLR.stroke}" stroke-width="${sw}"${dash}/>`);

  // Type icon top-left (~15×15px)
  const icon = renderTaskIcon(type, x + 5, y + 5);
  if (icon) o.push(icon);

  // Bottom-center markers (loop, MI, subprocess)
  const markers = renderBottomMarkers(node, cx, y + h, x, w);
  if (markers) o.push(markers);

  // Label centered inside
  const hasIcon    = icon !== null;
  const topPad     = hasIcon ? 18 : 0;
  const bottomPad  = markers ? 16 : 0;
  const usableH    = h - topPad - bottomPad;
  const maxChars   = Math.floor(w / 6.5);
  const lines      = wrapText(node.name || '', maxChars);
  const lineH      = 14;
  const textAreaCy = y + topPad + usableH / 2;
  const startY     = textAreaCy - ((lines.length - 1) * lineH) / 2;

  for (let i = 0; i < lines.length; i++) {
    o.push(`<text x="${cx}" y="${rn(startY + i * lineH)}" text-anchor="middle" dominant-baseline="middle" font-size="12" fill="${CLR.label}">${esc(lines[i])}</text>`);
  }

  return o.join('\n');
}

// §7.9  Bottom markers (loop, multi-instance, collapsed subprocess, ad-hoc, compensation)
function renderBottomMarkers(node, cx, bottomY, actX, actW) {
  const markers = [];

  // Loop marker (OMG spec Fig 10.20)
  if (node.loopType === 'standard') {
    markers.push(renderLoopMarker(0, 0));
  }
  // Multi-instance parallel ⫴ (OMG spec Fig 10.22)
  if (node.multiInstance === 'parallel') {
    markers.push(renderMIParallelMarker(0, 0));
  }
  // Multi-instance sequential ≡ (OMG spec Fig 10.23)
  if (node.multiInstance === 'sequential') {
    markers.push(renderMISequentialMarker(0, 0));
  }
  // Collapsed subprocess [+] (OMG spec Fig 10.17)
  if (node.type === 'subProcess' || node.type === 'callActivity') {
    markers.push(renderSubProcessMarker(0, 0));
  }
  // Ad-hoc ~
  if (node.isAdHoc) {
    markers.push(renderAdHocMarker(0, 0));
  }
  // Compensation ◁◁
  if (node.isCompensation) {
    markers.push(renderCompensationMarker(0, 0));
  }

  if (markers.length === 0) return null;

  // Position markers side by side at bottom center
  const totalW = markers.length * 16;
  const startX = cx - totalW / 2;
  const my     = bottomY - 18;

  const parts = markers.map((m, i) =>
    `<g transform="translate(${rn(startX + i * 16)},${rn(my)})">${m}</g>`
  );

  return parts.join('\n');
}

function renderLoopMarker(ox, oy) {
  return `<path d="M 4,8 A 5,5 0 1,0 11,5 L 13,2 L 11,5 L 8,5" fill="none" stroke="${CLR.stroke}" stroke-width="1.5" stroke-linecap="round"/>`;
}

function renderMIParallelMarker(ox, oy) {
  return `<line x1="3" y1="1" x2="3" y2="13" stroke="${CLR.stroke}" stroke-width="2"/>`
       + `<line x1="7" y1="1" x2="7" y2="13" stroke="${CLR.stroke}" stroke-width="2"/>`
       + `<line x1="11" y1="1" x2="11" y2="13" stroke="${CLR.stroke}" stroke-width="2"/>`;
}

function renderMISequentialMarker(ox, oy) {
  return `<line x1="1" y1="3" x2="13" y2="3" stroke="${CLR.stroke}" stroke-width="2"/>`
       + `<line x1="1" y1="7" x2="13" y2="7" stroke="${CLR.stroke}" stroke-width="2"/>`
       + `<line x1="1" y1="11" x2="13" y2="11" stroke="${CLR.stroke}" stroke-width="2"/>`;
}

function renderSubProcessMarker(ox, oy) {
  return `<rect x="1" y="1" width="12" height="12" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="1"/>`
       + `<line x1="7" y1="3" x2="7" y2="11" stroke="${CLR.stroke}" stroke-width="1.5"/>`
       + `<line x1="3" y1="7" x2="11" y2="7" stroke="${CLR.stroke}" stroke-width="1.5"/>`;
}

function renderAdHocMarker(ox, oy) {
  return `<path d="M 2,7 C 4,3 6,3 8,7 C 10,11 12,11 14,7" fill="none" stroke="${CLR.stroke}" stroke-width="1.5"/>`;
}

function renderCompensationMarker(ox, oy) {
  return `<polygon points="1,7 7,2 7,12" fill="none" stroke="${CLR.stroke}" stroke-width="1.5"/>`
       + `<polygon points="7,7 13,2 13,12" fill="none" stroke="${CLR.stroke}" stroke-width="1.5"/>`;
}

// ── Data Objects & Artifacts (OMG spec §10.6) ───────────────────────
function renderDataArtifact(node, c, tx, ty) {
  const type = node.type;
  const x = tx(c.x), y = ty(c.y), w = c.w, h = c.h;
  const cx = x + w/2;
  const o = [];

  if (type === 'dataObjectReference') {
    // Data object: rectangle with folded corner (OMG spec Fig 10.82)
    const fold = 10;
    o.push(`<path d="M ${x},${y} L ${x+w-fold},${y} L ${x+w},${y+fold} L ${x+w},${y+h} L ${x},${y+h} Z" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="${SW.dataObject}"/>`);
    o.push(`<path d="M ${x+w-fold},${y} L ${x+w-fold},${y+fold} L ${x+w},${y+fold}" fill="none" stroke="${CLR.stroke}" stroke-width="${SW.dataObject}"/>`);
    // Collection marker (three vertical lines)
    if (node.isCollection) {
      const bx = cx - 6, by = y + h - 12;
      o.push(`<line x1="${bx}" y1="${by}" x2="${bx}" y2="${by+8}" stroke="${CLR.stroke}" stroke-width="1.5"/>`);
      o.push(`<line x1="${bx+6}" y1="${by}" x2="${bx+6}" y2="${by+8}" stroke="${CLR.stroke}" stroke-width="1.5"/>`);
      o.push(`<line x1="${bx+12}" y1="${by}" x2="${bx+12}" y2="${by+8}" stroke="${CLR.stroke}" stroke-width="1.5"/>`);
    }
    // Label below
    o.push(renderExternalLabel(node.name || '', cx, ty(c.y + c.h) + 5, 70));
  } else if (type === 'dataStoreReference') {
    // Data store: cylinder (OMG spec Fig 10.85)
    const ry = 6;
    o.push(`<ellipse cx="${cx}" cy="${y+ry}" rx="${w/2}" ry="${ry}" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="${SW.dataObject}"/>`);
    o.push(`<path d="M ${x},${y+ry} L ${x},${y+h-ry}" stroke="${CLR.stroke}" stroke-width="${SW.dataObject}" fill="none"/>`);
    o.push(`<path d="M ${x+w},${y+ry} L ${x+w},${y+h-ry}" stroke="${CLR.stroke}" stroke-width="${SW.dataObject}" fill="none"/>`);
    o.push(`<ellipse cx="${cx}" cy="${y+h-ry}" rx="${w/2}" ry="${ry}" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="${SW.dataObject}"/>`);
    o.push(renderExternalLabel(node.name || '', cx, ty(c.y + c.h) + 5, 70));
  } else if (type === 'textAnnotation') {
    // Open bracket [ shape (OMG spec Fig 10.86)
    o.push(`<path d="M ${x+15},${y} L ${x},${y} L ${x},${y+h} L ${x+15},${y+h}" fill="none" stroke="${CLR.stroke}" stroke-width="${SW.annotation}"/>`);
    o.push(`<text x="${x+20}" y="${rn(y+h/2+4)}" font-size="11" fill="${CLR.label}">${esc(node.name || '')}</text>`);
  } else if (type === 'group') {
    // Dashed rounded rectangle (OMG spec Fig 10.88)
    o.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" ry="10" fill="none" stroke="${CLR.stroke}" stroke-width="1.5" stroke-dasharray="8,4,2,4"/>`);
    o.push(`<text x="${cx}" y="${rn(y-5)}" text-anchor="middle" font-size="12" font-weight="bold" fill="${CLR.label}">${esc(node.name || '')}</text>`);
  }

  return o.join('\n');
}

// ─────────────────────────────────────────────────────────────────────
// EVENT MARKERS (OMG spec Table 10.87)
// ─────────────────────────────────────────────────────────────────────
function renderEventMarker(marker, cx, cy, r, filled) {
  const f  = filled ? CLR.stroke : CLR.fill;
  const fi = filled ? CLR.fill   : CLR.stroke; // inverted stroke for filled envelopes
  const s  = CLR.stroke;
  const sw = 1.5;
  const sc = r / 18;

  switch (marker) {
    case 'message': {
      const mw = rn(14*sc), mh = rn(10*sc);
      const mx = cx - mw/2, my = cy - mh/2;
      return `<rect x="${mx}" y="${my}" width="${mw}" height="${mh}" fill="${f}" stroke="${filled ? fi : s}" stroke-width="${sw}"/>`
           + `<path d="M ${mx},${my} L ${cx},${rn(my+mh*0.6)} L ${rn(mx+mw)},${my}" fill="none" stroke="${filled ? fi : s}" stroke-width="${sw}"/>`;
    }
    case 'timer': {
      const tr = rn(r * 0.55);
      let timerSvg = `<circle cx="${cx}" cy="${cy}" r="${tr}" fill="${CLR.fill}" stroke="${s}" stroke-width="${sw}"/>`;
      // 12 tick marks
      for (let i = 0; i < 12; i++) {
        const a = (i * 30) * Math.PI / 180;
        const ix = cx + Math.cos(a) * (tr - 2);
        const iy = cy + Math.sin(a) * (tr - 2);
        const ox = cx + Math.cos(a) * tr;
        const oy = cy + Math.sin(a) * tr;
        timerSvg += `<line x1="${rn(ix)}" y1="${rn(iy)}" x2="${rn(ox)}" y2="${rn(oy)}" stroke="${s}" stroke-width="0.5"/>`;
      }
      // Clock hands
      timerSvg += `<line x1="${cx}" y1="${rn(cy-tr+3)}" x2="${cx}" y2="${cy}" stroke="${s}" stroke-width="1.5" stroke-linecap="round"/>`;
      timerSvg += `<line x1="${cx}" y1="${cy}" x2="${rn(cx+tr*0.4)}" y2="${rn(cy-tr*0.3)}" stroke="${s}" stroke-width="1.5" stroke-linecap="round"/>`;
      return timerSvg;
    }
    case 'signal': {
      const sh = r * 0.65, sw2 = sh * 1.1;
      const pts = `${cx},${rn(cy-sh*0.6)} ${rn(cx+sw2/2)},${rn(cy+sh*0.4)} ${rn(cx-sw2/2)},${rn(cy+sh*0.4)}`;
      return `<polygon points="${pts}" fill="${f}" stroke="${s}" stroke-width="${sw}"/>`;
    }
    case 'error': {
      const eh = r * 0.65;
      return `<path d="M ${rn(cx-eh*0.3)},${rn(cy+eh*0.5)} L ${rn(cx-eh*0.1)},${rn(cy-eh*0.25)} L ${rn(cx+eh*0.2)},${rn(cy)} L ${rn(cx+eh*0.3)},${rn(cy-eh*0.5)} L ${rn(cx+eh*0.1)},${rn(cy+eh*0.2)} L ${rn(cx-eh*0.2)},${rn(cy)} Z" fill="${f}" stroke="${s}" stroke-width="${sw}"/>`;
    }
    case 'escalation': {
      const eh = r * 0.6;
      return `<path d="M ${cx},${rn(cy-eh)} L ${rn(cx+eh*0.5)},${rn(cy+eh*0.5)} L ${cx},${rn(cy)} L ${rn(cx-eh*0.5)},${rn(cy+eh*0.5)} Z" fill="${f}" stroke="${s}" stroke-width="${sw}"/>`;
    }
    case 'compensation': {
      const cw = r * 0.35, ch = r * 0.5;
      return `<polygon points="${rn(cx-cw*2)},${cy} ${rn(cx-cw)},${rn(cy-ch)} ${rn(cx-cw)},${rn(cy+ch)}" fill="${f}" stroke="${s}" stroke-width="${sw}"/>`
           + `<polygon points="${rn(cx-cw)},${cy} ${cx},${rn(cy-ch)} ${cx},${rn(cy+ch)}" fill="${f}" stroke="${s}" stroke-width="${sw}"/>`;
    }
    case 'conditional': {
      const cw = rn(10*sc), ch = rn(12*sc);
      const mx = cx - cw/2, my = cy - ch/2;
      let svg = `<rect x="${mx}" y="${my}" width="${cw}" height="${ch}" fill="${CLR.fill}" stroke="${s}" stroke-width="1"/>`;
      for (let i = 0; i < 4; i++) {
        svg += `<line x1="${mx+2}" y1="${rn(my+2+i*3)}" x2="${rn(mx+cw-2)}" y2="${rn(my+2+i*3)}" stroke="${s}" stroke-width="0.8"/>`;
      }
      return svg;
    }
    case 'link': {
      const lh = r*0.45, lw = r*0.65;
      return `<path d="M ${rn(cx-lw)},${rn(cy-lh*0.5)} L ${cx},${rn(cy-lh*0.5)} L ${cx},${rn(cy-lh)} L ${rn(cx+lw)},${cy} L ${cx},${rn(cy+lh)} L ${cx},${rn(cy+lh*0.5)} L ${rn(cx-lw)},${rn(cy+lh*0.5)} Z" fill="${f}" stroke="${s}" stroke-width="${sw}"/>`;
    }
    case 'cancel': {
      const cd = r * 0.45;
      return `<line x1="${rn(cx-cd)}" y1="${rn(cy-cd)}" x2="${rn(cx+cd)}" y2="${rn(cy+cd)}" stroke="${s}" stroke-width="3" stroke-linecap="round"/>`
           + `<line x1="${rn(cx+cd)}" y1="${rn(cy-cd)}" x2="${rn(cx-cd)}" y2="${rn(cy+cd)}" stroke="${s}" stroke-width="3" stroke-linecap="round"/>`;
    }
    case 'multiple': {
      return renderPentagon(cx, cy, r * 0.55, s);
    }
    case 'parallelMultiple': {
      const pd = r * 0.5;
      return `<line x1="${cx}" y1="${rn(cy-pd)}" x2="${cx}" y2="${rn(cy+pd)}" stroke="${s}" stroke-width="2.5" stroke-linecap="round"/>`
           + `<line x1="${rn(cx-pd)}" y1="${cy}" x2="${rn(cx+pd)}" y2="${cy}" stroke="${s}" stroke-width="2.5" stroke-linecap="round"/>`;
    }
    default: return '';
  }
}

function inferEventMarker(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes('nachricht') || n.includes('message') || n.includes('mail') || n.includes('e-mail')) return 'message';
  if (n.includes('timer') || n.includes('zeit') || n.includes('frist') || n.includes('warte') || n.includes('deadline')) return 'timer';
  if (n.includes('fehler') || n.includes('error') || n.includes('exception') || n.includes('störung')) return 'error';
  if (n.includes('signal')) return 'signal';
  if (n.includes('eskalation') || n.includes('escalation')) return 'escalation';
  if (n.includes('kompensation') || n.includes('compensation')) return 'compensation';
  if (n.includes('bedingung') || n.includes('conditional') || n.includes('condition')) return 'conditional';
  if (n.includes('abbruch') || n.includes('cancel') || n.includes('abgebrochen') || n.includes('stornierung')) return 'cancel';
  if (n.includes('terminat') || n.includes('beendet') || n.includes('sofortiger abbruch')) return 'terminate';
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// TASK TYPE ICONS (approximations of bpmn-js PathMap glyphs)
// ─────────────────────────────────────────────────────────────────────
function renderTaskIcon(type, ox, oy) {
  const s = CLR.stroke, f = CLR.fill;
  switch (type) {
    case 'userTask':
      return `<g transform="translate(${ox},${oy})">`
        + `<circle cx="7.5" cy="5" r="3" fill="${f}" stroke="${s}" stroke-width="1.2"/>`
        + `<path d="M 2,16 Q 2,9 7.5,9 Q 13,9 13,16" fill="${f}" stroke="${s}" stroke-width="1.2" stroke-linecap="round"/>`
        + `</g>`;
    case 'serviceTask':
      return `<g transform="translate(${ox},${oy})">`
        + `<circle cx="5" cy="8" r="3.5" fill="${f}" stroke="${s}" stroke-width="1.2"/>`
        + `<circle cx="11" cy="5" r="3.5" fill="${f}" stroke="${s}" stroke-width="1.2"/>`
        + `<rect x="3.5" y="6" width="3" height="4" fill="${f}"/>`
        + `<rect x="9.5" y="3" width="3" height="4" fill="${f}"/>`
        + `<line x1="5" y1="8" x2="11" y2="5" stroke="${s}" stroke-width="1"/>`
        + `</g>`;
    case 'scriptTask':
      return `<g transform="translate(${ox},${oy})">`
        + `<path d="M 3,1 Q 1,1 1,3 L 1,14 Q 1,16 3,16 L 13,16 Q 15,16 15,14 L 15,3 Q 15,1 13,1 Z" fill="${f}" stroke="${s}" stroke-width="1"/>`
        + `<line x1="4" y1="5" x2="12" y2="5" stroke="${s}" stroke-width="0.8"/>`
        + `<line x1="4" y1="8" x2="12" y2="8" stroke="${s}" stroke-width="0.8"/>`
        + `<line x1="4" y1="11" x2="9" y2="11" stroke="${s}" stroke-width="0.8"/>`
        + `</g>`;
    case 'sendTask':
      return `<g transform="translate(${ox},${oy})">`
        + `<rect x="1" y="3" width="14" height="11" fill="${s}" stroke="${s}" stroke-width="1"/>`
        + `<path d="M 1,3 L 8,10 L 15,3" fill="none" stroke="${f}" stroke-width="1.2"/>`
        + `</g>`;
    case 'receiveTask':
      return `<g transform="translate(${ox},${oy})">`
        + `<rect x="1" y="3" width="14" height="11" fill="${f}" stroke="${s}" stroke-width="1.2"/>`
        + `<path d="M 1,3 L 8,10 L 15,3" fill="none" stroke="${s}" stroke-width="1.2"/>`
        + `</g>`;
    case 'manualTask':
      return `<g transform="translate(${ox},${oy})">`
        + `<path d="M 1,9 C 1,6 3,4 5,5 L 5,3 C 5,1.5 7,1.5 7,3 L 7,5 C 7,3.5 9,3.5 9,5 C 9,3.5 11,3.5 11,5 L 11,9 C 11,13 9,16 7,16 L 4,16 C 2,16 1,14 1,12 Z" fill="${f}" stroke="${s}" stroke-width="1"/>`
        + `</g>`;
    case 'businessRuleTask':
      return `<g transform="translate(${ox},${oy})">`
        + `<rect x="1" y="2" width="14" height="13" fill="${f}" stroke="${s}" stroke-width="1"/>`
        + `<rect x="1" y="2" width="14" height="4" fill="${s}" stroke="${s}" stroke-width="1"/>`
        + `<line x1="7" y1="6" x2="7" y2="15" stroke="${s}" stroke-width="0.8"/>`
        + `<line x1="1" y1="10" x2="15" y2="10" stroke="${s}" stroke-width="0.8"/>`
        + `</g>`;
    default: return null;
  }
}

function renderPentagon(cx, cy, r, stroke) {
  const pts = Array.from({length: 5}, (_, i) => {
    const a = (i * 72 - 90) * Math.PI / 180;
    return `${rn(cx + r * Math.cos(a))},${rn(cy + r * Math.sin(a))}`;
  }).join(' ');
  return `<polygon points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`;
}

function renderExternalLabel(text, cx, y, maxW) {
  if (!text) return '';
  const lines = wrapText(text, Math.floor(maxW / 6));
  return lines.map((line, i) =>
    `<text x="${cx}" y="${rn(y + i*13 + 10)}" text-anchor="middle" font-size="11" fill="${CLR.label}">${esc(line)}</text>`
  ).join('\n');
}

// ═══════════════════════════════════════════════════════════════════════
// §8  HELPERS
// ═══════════════════════════════════════════════════════════════════════

function isEvent(type) {
  return type?.includes('Event') || false;
}

function isGateway(type) {
  return type?.includes('Gateway') || false;
}

function isBoundaryEvent(node) {
  return node.type === 'boundaryEvent' || !!node.attachedTo;
}

function isArtifact(type) {
  return ['dataObjectReference', 'dataStoreReference', 'textAnnotation', 'group'].includes(type);
}

function isDataArtifact(type) {
  return isArtifact(type);
}

function bpmnXmlTag(type) {
  const map = {
    task: 'task', userTask: 'userTask', serviceTask: 'serviceTask',
    scriptTask: 'scriptTask', sendTask: 'sendTask', receiveTask: 'receiveTask',
    manualTask: 'manualTask', businessRuleTask: 'businessRuleTask',
    callActivity: 'callActivity', subProcess: 'subProcess',
    startEvent: 'startEvent', endEvent: 'endEvent',
    intermediateCatchEvent: 'intermediateCatchEvent',
    intermediateThrowEvent: 'intermediateThrowEvent',
    boundaryEvent: 'boundaryEvent',
    exclusiveGateway: 'exclusiveGateway', parallelGateway: 'parallelGateway',
    inclusiveGateway: 'inclusiveGateway', eventBasedGateway: 'eventBasedGateway',
    complexGateway: 'complexGateway',
    dataObjectReference: 'dataObjectReference',
    dataStoreReference: 'dataStoreReference',
    textAnnotation: 'textAnnotation',
    group: 'group',
  };
  return map[type] || 'task';
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function rn(n) {
  return Math.round(n * 10) / 10; // one decimal place for SVG precision
}

function wrapText(text, maxChars) {
  if (!text) return [''];
  if (text.length <= maxChars) return [text];
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length > maxChars) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [text];
}

// ═══════════════════════════════════════════════════════════════════════
// §9  MAIN — Pipeline orchestration
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// §10  PUBLIC API — programmatic usage via import
// ═══════════════════════════════════════════════════════════════════════

/**
 * Run the full BPMN pipeline programmatically.
 * @param {object} logicCore - Logic-Core JSON object
 * @returns {Promise<{bpmnXml: string, svg: string, coordMap: object, validation: {errors: string[], warnings: string[]}}>}
 */
async function runPipeline(logicCore) {
  const lc = JSON.parse(JSON.stringify(logicCore)); // deep clone to avoid mutation
  const { errors, warnings } = validateLogicCore(lc);
  if (errors.length) {
    return { bpmnXml: null, svg: null, coordMap: null, validation: { errors, warnings } };
  }

  const allProcesses = lc.pools ? lc.pools : [lc];
  for (const proc of allProcesses) {
    inferGatewayDirections(proc.nodes || [], proc.edges || []);
  }

  const elkGraph  = logicCoreToElk(lc);
  const elkResult = await runElkLayout(elkGraph);
  const coordMap  = buildCoordinateMap(elkResult, lc);
  const bpmnXml   = generateBpmnXml(lc, coordMap);
  const svg       = generateSvg(lc, coordMap);

  return { bpmnXml, svg, coordMap, validation: { errors: [], warnings } };
}

export {
  runPipeline,
  validateLogicCore,
  inferGatewayDirections,
  sortNodesTopologically,
  orderLanesByFlow,
  preprocessLogicCore,
  logicCoreToElk,
  runElkLayout,
  buildCoordinateMap,
  generateBpmnXml,
  generateSvg,
  enforceOrthogonal,
  clipOrthogonal,
  loadConfig,
  CFG,
};

// ═══════════════════════════════════════════════════════════════════════
// §11  CLI ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  const args       = process.argv.slice(2);
  const inputArg   = args[0];
  const outputBase = args[1] || 'output';

  if (!inputArg) {
    console.error('Usage: node pipeline.js <input.json | -> [output-basename]');
    process.exit(1);
  }

  // Read input
  let rawJson;
  if (inputArg === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    rawJson = Buffer.concat(chunks).toString();
  } else {
    rawJson = readFileSync(resolve(inputArg), 'utf8');
  }

  const result = await runPipeline(JSON.parse(rawJson));

  if (result.validation.warnings.length) {
    console.warn('\n⚠ Warnings:');
    result.validation.warnings.forEach(w => console.warn('  · ' + w));
  }
  if (!result.bpmnXml) {
    console.error('\n✗ Errors (pipeline blocked):');
    result.validation.errors.forEach(e => console.error('  · ' + e));
    process.exit(1);
  }
  console.log('✓ Logic-Core validated (structural soundness OK)');

  const xmlPath = `${outputBase}.bpmn`;
  writeFileSync(xmlPath, result.bpmnXml, 'utf8');
  console.log(`✓ BPMN 2.0 XML → ${xmlPath}`);

  const svgPath = `${outputBase}.svg`;
  writeFileSync(svgPath, result.svg, 'utf8');
  console.log(`✓ SVG preview → ${svgPath}`);

  // Summary
  const lc = JSON.parse(readFileSync(resolve(inputArg), 'utf8'));
  const allProcesses = lc.pools ? lc.pools : [lc];
  const totalNodes = allProcesses.reduce((s, p) => s + (p.nodes || []).length, 0);
  const totalEdges = allProcesses.reduce((s, p) => s + (p.edges || []).length, 0);
  const totalLanes = allProcesses.reduce((s, p) => s + (p.lanes || []).length, 0);
  const totalMsgFlows = (lc.messageFlows || []).length;
  const totalCollapsed = (lc.collapsedPools || []).length;
  const totalAssociations = (lc.associations || []).length;
  console.log(`\n📊 Summary:`);
  console.log(`  Processes:     ${allProcesses.length}`);
  if (totalCollapsed) console.log(`  Black-Box:     ${totalCollapsed}`);
  console.log(`  Nodes:         ${totalNodes}`);
  console.log(`  Edges:         ${totalEdges}`);
  console.log(`  Lanes:         ${totalLanes}`);
  if (totalMsgFlows)    console.log(`  MsgFlows:      ${totalMsgFlows}`);
  if (totalAssociations) console.log(`  Associations:  ${totalAssociations}`);
  console.log(`  Files:         ${xmlPath}, ${svgPath}`);
}

// Only run CLI when executed directly (not imported)
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch(err => { console.error('Pipeline error:', err); process.exit(1); });
}

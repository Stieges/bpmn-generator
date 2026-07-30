/**
 * DOT Format Support — Export (Logic-Core → DOT) and Import (DOT → Logic-Core)
 * Graphviz DOT language for visualization and interchange.
 */

import { isEvent, isGateway, isArtifact } from './types.js';

// ═══════════════════════════════════════════════════════════════════════
// EXPORT: Logic-Core → DOT
// ═══════════════════════════════════════════════════════════════════════

/**
 * Convert a Logic-Core JSON to Graphviz DOT format.
 * @param {object} lc - Logic-Core JSON
 * @returns {string} DOT string
 */
function logicCoreToDot(lc) {
  const lines = [];
  const isMultiPool = lc.pools && lc.pools.length > 0;

  lines.push('digraph BPMN {');
  lines.push('  rankdir=LR;');
  lines.push('  node [fontname="Arial", fontsize=10];');
  lines.push('  edge [fontname="Arial", fontsize=9];');
  lines.push('');

  const processes = isMultiPool ? lc.pools : [lc];

  for (const proc of processes) {
    const useSubgraph = isMultiPool || (proc.lanes && proc.lanes.length > 0);

    if (useSubgraph) {
      lines.push(`  subgraph cluster_${sanitizeDotId(proc.id)} {`);
      lines.push(`    label="${escapeDot(proc.name || proc.id)}";`);
      lines.push('    style=solid;');
      lines.push('    color="#333333";');
      lines.push('');
    }

    const indent = useSubgraph ? '    ' : '  ';
    const lanes = proc.lanes || [];

    if (lanes.length > 0) {
      for (const lane of lanes) {
        lines.push(`${indent}subgraph cluster_${sanitizeDotId(lane.id)} {`);
        lines.push(`${indent}  label="${escapeDot(lane.name || lane.id)}";`);
        lines.push(`${indent}  style=dashed;`);
        lines.push(`${indent}  color="#999999";`);

        const laneNodes = (proc.nodes || []).filter(n => n.lane === lane.id);
        for (const node of laneNodes) {
          lines.push(`${indent}  ${dotNode(node)}`);
        }
        lines.push(`${indent}}`);
      }
      // Nodes without lane assignment
      const unassigned = (proc.nodes || []).filter(n => !n.lane);
      for (const node of unassigned) {
        lines.push(`${indent}${dotNode(node)}`);
      }
    } else {
      for (const node of (proc.nodes || [])) {
        lines.push(`${indent}${dotNode(node)}`);
      }
    }

    lines.push('');

    for (const edge of (proc.edges || [])) {
      const attrs = [];
      if (edge.label) attrs.push(`label="${escapeDot(edge.label)}"`);
      if (edge.isDefault) attrs.push('style=bold');
      if (edge.isHappyPath) attrs.push('color="#2D7BB6"');
      const attrStr = attrs.length > 0 ? ` [${attrs.join(', ')}]` : '';
      lines.push(`${indent}${sanitizeDotId(edge.source)} -> ${sanitizeDotId(edge.target)}${attrStr};`);
    }

    if (useSubgraph) {
      lines.push('  }');
    }
    lines.push('');
  }

  // Collapsed pools
  for (const cp of (lc.collapsedPools || [])) {
    lines.push(`  ${sanitizeDotId(cp.id)} [label="${escapeDot(cp.name || cp.id)}", shape=box, style="filled,bold", fillcolor="#E8E8E8"];`);
  }

  // Message flows
  for (const mf of (lc.messageFlows || [])) {
    const attrs = ['style=dashed', 'color="#666666"'];
    if (mf.name) attrs.push(`label="${escapeDot(mf.name)}"`);
    lines.push(`  ${sanitizeDotId(mf.source)} -> ${sanitizeDotId(mf.target)} [${attrs.join(', ')}];`);
  }

  lines.push('}');
  return lines.join('\n');
}

function dotNode(node) {
  const id = sanitizeDotId(node.id);
  const label = escapeDot(node.name || node.id);
  const type = node.type || 'task';

  if (isEvent(type)) {
    const isEnd = type === 'endEvent';
    return `${id} [label="${label}", shape=${isEnd ? 'doublecircle' : 'circle'}, width=0.4, fixedsize=true];`;
  }
  if (isGateway(type)) {
    return `${id} [label="${label}", shape=diamond, width=0.5, height=0.5];`;
  }
  if (isArtifact(type)) {
    if (type === 'textAnnotation') return `${id} [label="${label}", shape=note];`;
    if (type === 'dataObjectReference') return `${id} [label="${label}", shape=note, style=filled, fillcolor="#FFFFCC"];`;
    if (type === 'dataStoreReference') return `${id} [label="${label}", shape=cylinder];`;
    return `${id} [label="${label}", shape=box, style=dashed];`;
  }
  // Activity
  const style = type === 'callActivity' ? 'bold' : 'rounded';
  return `${id} [label="${label}", shape=box, style=${style}];`;
}

function sanitizeDotId(id) {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

function escapeDot(s) {
  return (s || '').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ═══════════════════════════════════════════════════════════════════════
// IMPORT: DOT → Logic-Core (subset parser)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse a DOT subset into a Logic-Core JSON.
 * Supports: digraph, subgraph cluster_, node declarations, edges.
 * NOT a full DOT parser — handles the output of logicCoreToDot.
 *
 * @param {string} dotString - DOT format string
 * @returns {object} Logic-Core JSON
 */
function dotToLogicCore(dotString) {
  const lines = dotString.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('//'));

  const nodes = [];
  const edges = [];
  const pools = [];
  const nodeSet = new Set();

  let currentCluster = null;
  let currentLane = null;
  const clusterStack = [];

  for (const line of lines) {
    // Skip graph-level directives
    if (line.match(/^(di)?graph\s/)) continue;
    if (line === '{' || line === '}') {
      if (line === '}' && clusterStack.length > 0) {
        const closed = clusterStack.pop();
        if (closed.type === 'lane') currentLane = null;
        if (closed.type === 'pool') currentCluster = null;
      }
      continue;
    }
    if (line.match(/^rankdir=/)) continue;
    if (line.match(/^(node|edge)\s*\[/)) continue;

    // Subgraph cluster
    const clusterMatch = line.match(/^subgraph\s+cluster_(\S+)\s*\{?$/);
    if (clusterMatch) {
      const clusterId = clusterMatch[1];
      if (currentCluster) {
        // Nested = lane
        currentLane = { id: clusterId, name: clusterId };
        clusterStack.push({ type: 'lane', id: clusterId });
      } else {
        currentCluster = { id: clusterId, name: clusterId, nodes: [], edges: [], lanes: [] };
        clusterStack.push({ type: 'pool', id: clusterId });
      }
      continue;
    }

    // Label for current cluster
    const labelMatch = line.match(/^label="([^"]*)"/);
    if (labelMatch) {
      if (currentLane) {
        currentLane.name = labelMatch[1];
        if (currentCluster && !currentCluster.lanes.find(l => l.id === currentLane.id)) {
          currentCluster.lanes.push(currentLane);
        }
      } else if (currentCluster) {
        currentCluster.name = labelMatch[1];
      }
      continue;
    }

    // Skip style/color directives
    if (line.match(/^(style|color|fillcolor)=/)) continue;

    // Edge: source -> target [attrs];
    const edgeMatch = line.match(/^(\S+)\s*->\s*(\S+)\s*(?:\[([^\]]*)\])?\s*;?$/);
    if (edgeMatch) {
      const edge = {
        id: `flow_${edgeMatch[1]}_${edgeMatch[2]}`,
        source: edgeMatch[1],
        target: edgeMatch[2],
      };
      if (edgeMatch[3]) {
        const labelM = edgeMatch[3].match(/label="([^"]*)"/);
        if (labelM) edge.label = labelM[1];
        if (edgeMatch[3].includes('style=dashed')) edge._isMessageFlow = true;
        if (edgeMatch[3].includes('style=bold')) edge.isDefault = true;
      }
      if (edge._isMessageFlow) {
        // Will be collected as message flow later
      } else if (currentCluster) {
        currentCluster.edges.push(edge);
      } else {
        edges.push(edge);
      }
      continue;
    }

    // Node declaration: id [attrs];
    const nodeMatch = line.match(/^(\S+)\s*\[([^\]]*)\]\s*;?$/);
    if (nodeMatch) {
      const nodeId = nodeMatch[1];
      const attrs = nodeMatch[2];
      const labelM = attrs.match(/label="([^"]*)"/);
      const shapeM = attrs.match(/shape=(\w+)/);

      const node = {
        id: nodeId,
        name: labelM ? labelM[1] : nodeId,
        type: inferTypeFromDotShape(shapeM ? shapeM[1] : 'box', nodeId),
      };

      if (currentLane) node.lane = currentLane.id;

      if (currentCluster) {
        currentCluster.nodes.push(node);
      } else {
        nodes.push(node);
      }
      nodeSet.add(nodeId);
      continue;
    }
  }

  // Collect closed pools
  for (const cluster of clusterStack.filter(c => c.type === 'pool')) {
    if (!pools.find(p => p.id === cluster.id)) {
      pools.push(cluster);
    }
  }

  // If we found pools in the parsing, use multi-pool mode
  if (pools.length > 0) {
    return { pools, messageFlows: [], collapsedPools: [] };
  }

  // Single process
  return {
    id: 'Process_1',
    name: 'Process',
    nodes,
    edges,
    lanes: [],
  };
}

function inferTypeFromDotShape(shape, nodeId) {
  const id = (nodeId || '').toLowerCase();
  switch (shape) {
    case 'circle':
      return id.includes('end') ? 'endEvent' : 'startEvent';
    case 'doublecircle':
      return 'endEvent';
    case 'diamond':
      if (id.includes('parallel') || id.includes('and')) return 'parallelGateway';
      if (id.includes('inclusive') || id.includes('or')) return 'inclusiveGateway';
      return 'exclusiveGateway';
    case 'note':
      return 'textAnnotation';
    case 'cylinder':
      return 'dataStoreReference';
    default:
      if (id.includes('service')) return 'serviceTask';
      if (id.includes('user')) return 'userTask';
      if (id.includes('script')) return 'scriptTask';
      if (id.includes('send')) return 'sendTask';
      if (id.includes('receive')) return 'receiveTask';
      if (id.includes('rule')) return 'businessRuleTask';
      return 'task';
  }
}

export { logicCoreToDot, dotToLogicCore };

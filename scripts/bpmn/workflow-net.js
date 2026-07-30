/**
 * L2 — Workflow-Net Soundness Checker
 *
 * Converts BPMN Logic-Core to a Place/Transition-Net (Petri-Net)
 * and performs state-space exploration (BFS) to verify soundness.
 *
 * Soundness properties (van der Aalst):
 *   WF01 — Liveness:        Every transition fires at least once in some trace
 *   WF02 — 1-Boundedness:   No place ever holds more than 1 token
 *   WF03 — Proper Completion: Final marking is always reachable (no deadlocks)
 *
 * Scope:
 *   ✅ XOR gateways (exclusive choice)
 *   ✅ AND gateways (parallel fork/join)
 *   ✅ SubProcesses (flattened)
 *   ⚠️  OR gateways → warning only (not formally verifiable in classical WF-nets)
 *   ❌ Event-Based Gateways → skipped (race conditions)
 *   ❌ Timer/Signal Events → skipped (external triggers)
 *
 * Reference: van der Aalst, "Workflow Nets" (1998), "Soundness of WF-Nets" (2011)
 */

import { isGateway } from './types.js';

// ═══════════════════════════════════════════════════════════════════════
// BPMN → Petri-Net Conversion
// ═══════════════════════════════════════════════════════════════════════

/**
 * Convert a Logic-Core process to a Place/Transition-Net.
 *
 * Model:
 *   - Each BPMN node → a Transition
 *   - Each SequenceFlow → a Place (between source-transition and target-transition)
 *   - Source place (before startEvent) gets initial token
 *   - Sink place (after endEvent) is the target marking
 *
 * AND-Gateway (parallel):
 *   - Split: 1 input place → transition → N output places (fork)
 *   - Join: N input places → transition → 1 output place (synchronization)
 *
 * XOR-Gateway (exclusive):
 *   - Split: 1 input place → transition → N output places, but only one fires
 *   - Modeled as N separate transitions (one per outgoing edge)
 *
 * @param {object} proc - Process with nodes and edges
 * @returns {{ places, transitions, arcs, initialMarking, sinkPlace, orGateways, skipped }}
 */
function bpmnToPN(proc) {
  const nodes = proc.nodes || [];
  const edges = proc.edges || [];

  const places = new Map();     // placeId → { id, label }
  const transitions = new Map(); // transId → { id, label, bpmnNodeId }
  const arcs = [];               // { from, to, type: 'P→T' | 'T→P' }
  const orGateways = [];
  const skipped = [];

  // Flatten expanded subprocesses
  const flatNodes = flattenNodes(nodes);
  const flatEdges = flattenEdges(nodes, edges);
  const nodeMap = new Map(flatNodes.map(n => [n.id, n]));

  // Create places for each edge (flow)
  for (const edge of flatEdges) {
    const placeId = `p_${edge.source}_${edge.target}`;
    places.set(placeId, { id: placeId, label: edge.label || '' });
  }

  // Source place (before start event)
  const startNodes = flatNodes.filter(n => n.type === 'startEvent');
  const endNodes = flatNodes.filter(n => n.type === 'endEvent');

  // Create a global source place and sink place
  const sourcePlace = 'p_source';
  const sinkPlace = 'p_sink';
  places.set(sourcePlace, { id: sourcePlace, label: 'source' });
  places.set(sinkPlace, { id: sinkPlace, label: 'sink' });

  // Process each node
  for (const node of flatNodes) {
    // Skip elements that don't participate in control flow
    if (node.type === 'dataObjectReference' || node.type === 'dataStoreReference' ||
        node.type === 'textAnnotation' || node.type === 'group') {
      skipped.push({ id: node.id, reason: 'artifact' });
      continue;
    }

    // OR gateways: warn but don't model formally
    if (node.type === 'inclusiveGateway') {
      orGateways.push(node.id);
    }

    // Event-Based Gateways: skip formal verification
    if (node.type === 'eventBasedGateway') {
      skipped.push({ id: node.id, reason: 'eventBasedGateway' });
      // Still create a transition so the net is connected
      const tId = `t_${node.id}`;
      transitions.set(tId, { id: tId, label: node.name || node.id, bpmnNodeId: node.id });
      connectTransition(tId, node.id, flatEdges, places, arcs);
      continue;
    }

    // XOR-Gateway split: model as N separate transitions (non-deterministic choice)
    if (node.type === 'exclusiveGateway') {
      const outEdges = flatEdges.filter(e => e.source === node.id);
      const inEdges = flatEdges.filter(e => e.target === node.id);

      if (outEdges.length > 1) {
        // XOR split: one transition per outgoing edge
        for (let i = 0; i < outEdges.length; i++) {
          const tId = `t_${node.id}_choice_${i}`;
          transitions.set(tId, { id: tId, label: `${node.name || node.id}[${i}]`, bpmnNodeId: node.id });

          // All incoming places → this transition
          for (const ie of inEdges) {
            const inPlace = `p_${ie.source}_${ie.target}`;
            arcs.push({ from: inPlace, to: tId, type: 'P→T' });
          }
          // This transition → the specific outgoing place
          const outPlace = `p_${outEdges[i].source}_${outEdges[i].target}`;
          arcs.push({ from: tId, to: outPlace, type: 'T→P' });
        }
        continue; // Don't create the default transition
      }
    }

    // Check for implicit merge: non-gateway node with multiple incoming edges
    // In BPMN, a task with 2+ incoming flows acts as implicit XOR merge (any one activates it)
    // In Petri-Nets, a transition with 2+ input places requires ALL tokens (AND semantics)
    // Fix: create one transition per incoming edge for implicit merges
    const inEdges = flatEdges.filter(e => e.target === node.id);
    const outEdges = flatEdges.filter(e => e.source === node.id);
    const isImplicitMerge = !isGateway(node.type) && inEdges.length > 1;

    if (isImplicitMerge) {
      for (let i = 0; i < inEdges.length; i++) {
        const tId = `t_${node.id}_merge_${i}`;
        transitions.set(tId, { id: tId, label: `${node.name || node.id}[m${i}]`, bpmnNodeId: node.id });

        // Only this specific incoming place → transition
        const inPlace = `p_${inEdges[i].source}_${inEdges[i].target}`;
        if (places.has(inPlace)) {
          arcs.push({ from: inPlace, to: tId, type: 'P→T' });
        }

        // All outgoing places
        for (const oe of outEdges) {
          const outPlace = `p_${oe.source}_${oe.target}`;
          if (places.has(outPlace)) {
            arcs.push({ from: tId, to: outPlace, type: 'T→P' });
          }
        }

        // Start event: source place → transition
        if (node.type === 'startEvent') {
          arcs.push({ from: sourcePlace, to: tId, type: 'P→T' });
        }
        // End event: transition → sink place
        if (node.type === 'endEvent') {
          arcs.push({ from: tId, to: sinkPlace, type: 'T→P' });
        }
      }
      continue;
    }

    // Default: one transition per node
    const tId = `t_${node.id}`;
    transitions.set(tId, { id: tId, label: node.name || node.id, bpmnNodeId: node.id });

    // Connect: incoming places → transition → outgoing places
    connectTransition(tId, node.id, flatEdges, places, arcs);

    // Start event: source place → transition
    if (node.type === 'startEvent') {
      arcs.push({ from: sourcePlace, to: tId, type: 'P→T' });
    }

    // End event: transition → sink place
    if (node.type === 'endEvent') {
      arcs.push({ from: tId, to: sinkPlace, type: 'T→P' });
    }
  }

  // Initial marking: 1 token on source place
  const initialMarking = new Map();
  for (const [pid] of places) {
    initialMarking.set(pid, 0);
  }
  initialMarking.set(sourcePlace, 1);

  return { places, transitions, arcs, initialMarking, sinkPlace, sourcePlace, orGateways, skipped };
}

function connectTransition(tId, nodeId, edges, places, arcs) {
  const inEdges = edges.filter(e => e.target === nodeId);
  const outEdges = edges.filter(e => e.source === nodeId);

  for (const ie of inEdges) {
    const placeId = `p_${ie.source}_${ie.target}`;
    if (places.has(placeId)) {
      arcs.push({ from: placeId, to: tId, type: 'P→T' });
    }
  }
  for (const oe of outEdges) {
    const placeId = `p_${oe.source}_${oe.target}`;
    if (places.has(placeId)) {
      arcs.push({ from: tId, to: placeId, type: 'T→P' });
    }
  }
}

/**
 * Flatten expanded subprocesses into a flat node list.
 */
function flattenNodes(nodes) {
  const result = [];
  for (const n of nodes) {
    if (n.type === 'subProcess' && n.isExpanded && n.nodes?.length) {
      result.push(...flattenNodes(n.nodes));
    } else {
      result.push(n);
    }
  }
  return result;
}

/**
 * Flatten edges: include subprocess-internal edges.
 */
function flattenEdges(nodes, edges) {
  const result = [...edges];
  for (const n of nodes) {
    if (n.type === 'subProcess' && n.isExpanded && n.nodes?.length) {
      result.push(...flattenEdges(n.nodes, n.edges || []));
    }
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// State-Space Exploration (BFS)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Encode a marking as a string for Set-based duplicate detection.
 */
function encodeMarking(marking) {
  const entries = [];
  for (const [place, tokens] of marking) {
    if (tokens > 0) entries.push(`${place}=${tokens}`);
  }
  entries.sort();
  return entries.join(',');
}

/**
 * Get enabled transitions for a given marking.
 */
function getEnabledTransitions(marking, transitions, arcs) {
  const enabled = [];
  for (const [tId] of transitions) {
    const inputArcs = arcs.filter(a => a.to === tId && a.type === 'P→T');
    const isEnabled = inputArcs.length > 0 && inputArcs.every(a => (marking.get(a.from) || 0) >= 1);
    if (isEnabled) enabled.push(tId);
  }
  return enabled;
}

/**
 * Fire a transition: consume from input places, produce on output places.
 */
function fireTransition(marking, tId, arcs) {
  const newMarking = new Map(marking);
  for (const a of arcs) {
    if (a.to === tId && a.type === 'P→T') {
      newMarking.set(a.from, (newMarking.get(a.from) || 0) - 1);
    }
    if (a.from === tId && a.type === 'T→P') {
      newMarking.set(a.to, (newMarking.get(a.to) || 0) + 1);
    }
  }
  return newMarking;
}

/**
 * Run state-space exploration (BFS) on a Petri-Net.
 *
 * @param {object} pn - Petri-Net from bpmnToPN()
 * @param {object} options - { maxStates: number }
 * @returns {{ issues, stats }}
 */
function checkSoundness(pn, options = {}) {
  const maxStates = options.maxStates || 10_000;
  const { places, transitions, arcs, initialMarking, sinkPlace, sourcePlace, orGateways } = pn;

  const issues = [];
  const visitedEncodings = new Set();
  const firedTransitions = new Set();
  let maxTokens = 0;
  let maxTokenPlace = null;
  let deadlockStates = [];
  let sinkReached = false;
  let statesExplored = 0;
  let truncated = false;

  // BFS
  const queue = [initialMarking];
  visitedEncodings.add(encodeMarking(initialMarking));

  while (queue.length > 0) {
    if (statesExplored >= maxStates) {
      truncated = true;
      break;
    }

    const marking = queue.shift();
    statesExplored++;

    // Check boundedness
    for (const [pid, tokens] of marking) {
      if (tokens > maxTokens) {
        maxTokens = tokens;
        maxTokenPlace = pid;
      }
    }

    // Check if sink reached
    if ((marking.get(sinkPlace) || 0) >= 1) {
      sinkReached = true;
      // Check proper completion: only sink has tokens
      let improperCompletion = false;
      for (const [pid, tokens] of marking) {
        if (pid !== sinkPlace && tokens > 0) {
          improperCompletion = true;
          break;
        }
      }
      if (improperCompletion) {
        const remaining = [];
        for (const [pid, tokens] of marking) {
          if (pid !== sinkPlace && tokens > 0) remaining.push(`${pid}=${tokens}`);
        }
        issues.push({
          rule: 'WF03',
          severity: 'WARNING',
          message: `Improper completion: sink reached but tokens remain at: ${remaining.slice(0, 3).join(', ')}`,
        });
      }
    }

    // Get enabled transitions
    const enabled = getEnabledTransitions(marking, transitions, arcs);

    if (enabled.length === 0) {
      // Check if this is a deadlock (not at final marking)
      const sinkTokens = marking.get(sinkPlace) || 0;
      if (sinkTokens === 0) {
        // Deadlock: no transition enabled and not at sink
        const state = [];
        for (const [pid, tokens] of marking) {
          if (tokens > 0) state.push(`${pid}=${tokens}`);
        }
        if (deadlockStates.length < 3) { // Limit reported deadlocks
          deadlockStates.push(state.join(', '));
        }
      }
      continue;
    }

    // Fire each enabled transition (explore all interleavings)
    for (const tId of enabled) {
      firedTransitions.add(tId);
      const newMarking = fireTransition(marking, tId, arcs);
      const encoded = encodeMarking(newMarking);
      if (!visitedEncodings.has(encoded)) {
        visitedEncodings.add(encoded);
        queue.push(newMarking);
      }
    }
  }

  // ── Evaluate results ──

  // WF01 — Liveness: every transition should fire at least once
  const deadTransitions = [];
  for (const [tId, tInfo] of transitions) {
    if (!firedTransitions.has(tId)) {
      deadTransitions.push(tInfo);
    }
  }
  if (deadTransitions.length > 0) {
    const names = deadTransitions.slice(0, 5).map(t => `"${t.label}" (${t.bpmnNodeId})`).join(', ');
    issues.push({
      rule: 'WF01',
      severity: 'WARNING',
      message: `Dead transition(s) never fire: ${names}${deadTransitions.length > 5 ? ` (+${deadTransitions.length - 5} more)` : ''}`,
    });
  }

  // WF02 — Boundedness
  if (maxTokens > 1) {
    issues.push({
      rule: 'WF02',
      severity: 'WARNING',
      message: `Unbounded place "${maxTokenPlace}" accumulated ${maxTokens} tokens (expected ≤1). Possible token accumulation at parallel join.`,
    });
  }

  // WF03 — Deadlock detection
  if (deadlockStates.length > 0) {
    for (const state of deadlockStates) {
      issues.push({
        rule: 'WF03',
        severity: 'ERROR',
        message: `Deadlock state reachable: {${state}} — no enabled transition, sink not reached.`,
      });
    }
  }

  // WF03 — Sink unreachable
  if (!sinkReached && !truncated) {
    issues.push({
      rule: 'WF03',
      severity: 'ERROR',
      message: `Final marking (sink) is unreachable from initial marking. Process cannot complete.`,
    });
  }

  // OR-Gateway warning
  if (orGateways.length > 0) {
    issues.push({
      rule: 'WF_OR',
      severity: 'INFO',
      message: `OR-Gateway(s) ${orGateways.map(id => `"${id}"`).join(', ')} not formally verifiable in WF-Net analysis. Results may be incomplete.`,
    });
  }

  return {
    issues,
    stats: {
      statesExplored,
      truncated,
      places: places.size,
      transitions: transitions.size,
      arcs: arcs.length,
      firedTransitions: firedTransitions.size,
      deadTransitions: deadTransitions.length,
      maxTokens,
      deadlockStates: deadlockStates.length,
      sinkReached,
      orGateways: orGateways.length,
      skipped: pn.skipped.length,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════

/**
 * Check Workflow-Net soundness for a Logic-Core document.
 * Runs per-process analysis.
 *
 * @param {object} lc - Logic-Core JSON
 * @param {object} options - { maxStates: number }
 * @returns {{ issues: Array<{rule, severity, message, process?}>, stats: object }}
 */
export function checkWorkflowNetSoundness(lc, options = {}) {
  const processes = lc.pools ? lc.pools : [lc];
  const allIssues = [];
  const allStats = {};

  for (const proc of processes) {
    const prefix = lc.pools ? `[${proc.name || proc.id}] ` : '';
    const pn = bpmnToPN(proc);
    const result = checkSoundness(pn, options);

    for (const issue of result.issues) {
      allIssues.push({
        ...issue,
        message: prefix + issue.message,
        process: proc.id,
      });
    }
    allStats[proc.id || 'default'] = result.stats;
  }

  return { issues: allIssues, stats: allStats };
}

export { bpmnToPN, checkSoundness };

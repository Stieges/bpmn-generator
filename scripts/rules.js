/**
 * BPMN Fachliches Regelwerk — Modulare Regel-Engine
 *
 * 3 Schichten: Soundness (ERROR), Style (WARNING), Pragmatik (INFO)
 * Jede Regel hat: id, layer, defaultSeverity, description, ref, check(proc, lc)
 *
 * Quellen:
 *   - OMG BPMN 2.0.2 (ISO/IEC 19510:2013)
 *   - 7PMG (Mendling/Reijers/van der Aalst, 2010)
 *   - Bruce Silver: BPMN Method & Style
 *   - modeling-guidelines.org
 *   - BEF4LLM (Kourani et al., 2025)
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { isEvent, isGateway, isBoundaryEvent, isArtifact } from './types.js';
import { checkWorkflowNetSoundness } from './workflow-net.js';

// ═══════════════════════════════════════════════════════════════════════
// Helpers (internal)
// ═══════════════════════════════════════════════════════════════════════

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
// Schicht 1 — Strukturelle Soundness (ERROR)
// ═══════════════════════════════════════════════════════════════════════

const SOUNDNESS_RULES = [
  {
    id: 'S01', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'Jeder Prozess hat mindestens ein Start-Event',
    ref: { omg: '§10.4.2', pmg: 'G3' },
    scope: 'process',
    check: (proc) => {
      const starts = (proc.nodes || []).filter(n => n.type === 'startEvent');
      return starts.length >= 1
        ? { pass: true }
        : { pass: false, message: `Missing startEvent.` };
    }
  },
  {
    id: 'S02', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'Jeder Prozess hat mindestens ein End-Event',
    ref: { omg: '§10.4.2', pmg: 'G3' },
    scope: 'process',
    check: (proc) => {
      const ends = (proc.nodes || []).filter(n => n.type === 'endEvent');
      return ends.length >= 1
        ? { pass: true }
        : { pass: false, message: `Missing endEvent.` };
    }
  },
  {
    id: 'S03', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'Edge referential integrity — alle Quellen und Ziele existieren',
    ref: { omg: '§7.6.1' },
    scope: 'process',
    check: (proc) => {
      const nodeIds = new Set((proc.nodes || []).map(n => n.id));
      const msgs = [];
      for (const e of (proc.edges || [])) {
        if (!nodeIds.has(e.source)) msgs.push(`Edge "${e.id || ''}" unknown source: "${e.source}"`);
        if (!nodeIds.has(e.target)) msgs.push(`Edge "${e.id || ''}" unknown target: "${e.target}"`);
      }
      return msgs.length === 0
        ? { pass: true }
        : { pass: false, message: msgs.join('; ') };
    }
  },
  {
    id: 'S04', layer: 'soundness', defaultSeverity: 'WARNING',
    description: 'Isolierte Nodes erkennen (keine Kanten)',
    ref: { pmg: 'G2' },
    scope: 'process',
    check: (proc) => {
      const edges = proc.edges || [];
      const connected = new Set([...edges.map(e => e.source), ...edges.map(e => e.target)]);
      const msgs = [];
      for (const n of (proc.nodes || [])) {
        if (!connected.has(n.id) && n.type !== 'startEvent' && !isBoundaryEvent(n) && !isArtifact(n.type))
          msgs.push(`Node "${n.id}" (${n.name || ''}) appears isolated.`);
      }
      return msgs.length === 0
        ? { pass: true }
        : { pass: false, message: msgs.join('; ') };
    }
  },
  {
    id: 'S05', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'Deadlock: XOR-Split darf nicht in AND-Join münden',
    ref: { omg: '§10.5', pmg: 'G4' },
    scope: 'process',
    check: (proc) => {
      const nodes = proc.nodes || [], edges = proc.edges || [];
      const outgoing = buildAdjacency(edges, 'source', 'target');
      const incoming = buildAdjacency(edges, 'target', 'source');
      const msgs = [];

      for (const n of nodes) {
        if (n.type === 'exclusiveGateway' && !n.has_join) {
          const xorBranches = (outgoing[n.id] || []).map(e => e.target);
          if (xorBranches.length < 2) continue;

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

          for (const candidate of nodes) {
            if (candidate.type !== 'parallelGateway') continue;
            const cid = candidate.id;
            let branchesReachingAnd = 0;
            for (const reachSet of branchReachSets) {
              if (reachSet.has(cid)) branchesReachingAnd++;
            }
            const andIncoming = (incoming[cid] || []).length;
            if (branchesReachingAnd > 1 && andIncoming > 1) {
              msgs.push(`Deadlock: XOR-split "${n.id}" feeds AND-join "${cid}" via ${branchesReachingAnd} branches — only one XOR branch fires, AND waits forever.`);
            }
          }
        }
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join('; ') };
    }
  },
  {
    id: 'S06', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'Deadlock: Inclusive-Split darf nicht in AND-Join münden',
    ref: { omg: '§10.5' },
    scope: 'process',
    check: (proc) => {
      const nodes = proc.nodes || [], edges = proc.edges || [];
      const outgoing = buildAdjacency(edges, 'source', 'target');
      const incoming = buildAdjacency(edges, 'target', 'source');
      const msgs = [];

      for (const n of nodes) {
        if (n.type === 'inclusiveGateway' && !n.has_join) {
          const branches = (outgoing[n.id] || []).map(e => e.target);
          if (branches.length < 2) continue;
          const branchSets = branches.map(start => {
            const vis = new Set(); const q = [start];
            while (q.length) { const c = q.shift(); if (vis.has(c) || c === n.id) continue; vis.add(c); for (const e of (outgoing[c] || [])) q.push(e.target); }
            return vis;
          });
          for (const cand of nodes) {
            if (cand.type !== 'parallelGateway') continue;
            let ct = 0;
            for (const s of branchSets) if (s.has(cand.id)) ct++;
            if (ct > 1 && (incoming[cand.id] || []).length > 1)
              msgs.push(`Deadlock: Inclusive-split "${n.id}" feeds AND-join "${cand.id}" via ${ct} branches.`);
          }
        }
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join('; ') };
    }
  },
  {
    id: 'S07', layer: 'soundness', defaultSeverity: 'WARNING',
    description: 'Pfade terminieren — Nodes ohne ausgehende Kante (außer EndEvents)',
    ref: { omg: '§13.2', pmg: 'G3' },
    scope: 'process',
    check: (proc) => {
      const nodes = proc.nodes || [], edges = proc.edges || [];
      const outgoing = buildAdjacency(edges, 'source', 'target');
      const msgs = [];
      for (const n of nodes) {
        if (n.type !== 'endEvent' && (outgoing[n.id] || []).length === 0 &&
            !isBoundaryEvent(n) && n.type !== 'dataObjectReference' &&
            n.type !== 'dataStoreReference' && n.type !== 'textAnnotation') {
          if (n.type !== 'startEvent')
            msgs.push(`Node "${n.id}" has no outgoing flow — path may not terminate.`);
        }
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join('; ') };
    }
  },
  {
    id: 'S08', layer: 'soundness', defaultSeverity: 'WARNING',
    description: 'Boundary-Event-Pfade müssen ein EndEvent erreichen',
    ref: { silver: 'M14' },
    scope: 'process',
    check: (proc) => {
      const nodes = proc.nodes || [], edges = proc.edges || [];
      const outgoing = buildAdjacency(edges, 'source', 'target');
      const msgs = [];
      for (const n of nodes) {
        if (!isBoundaryEvent(n)) continue;
        const out = outgoing[n.id] || [];
        if (out.length === 0) continue;
        const vis = new Set(); const q = out.map(e => e.target);
        let reachesEnd = false;
        while (q.length && !reachesEnd) {
          const c = q.shift();
          if (vis.has(c)) continue; vis.add(c);
          const cNode = nodes.find(nn => nn.id === c);
          if (cNode && cNode.type === 'endEvent') { reachesEnd = true; break; }
          for (const e of (outgoing[c] || [])) q.push(e.target);
        }
        if (!reachesEnd) msgs.push(`Boundary event "${n.id}" path does not reach an endEvent.`);
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join('; ') };
    }
  },
  {
    id: 'S09', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'Message Flows nur zwischen Pools (nie innerhalb)',
    ref: { omg: '§7.6.2' },
    scope: 'global',
    check: (proc, lc) => {
      if (!lc.messageFlows || !lc.pools) return { pass: true };
      const nodePoolMap = {};
      for (const p of lc.pools) {
        for (const n of (p.nodes || [])) nodePoolMap[n.id] = p.id;
      }
      const msgs = [];
      for (const mf of lc.messageFlows) {
        const srcPool = nodePoolMap[mf.source] || mf.source;
        const tgtPool = nodePoolMap[mf.target] || mf.target;
        if (srcPool === tgtPool)
          msgs.push(`MessageFlow "${mf.id || ''}" is within pool "${srcPool}" — message flows must cross pool boundaries.`);
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join('; ') };
    }
  },
  {
    id: 'S10', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'Message Flow referential integrity',
    ref: { omg: '§7.6.2' },
    scope: 'global',
    check: (proc, lc) => {
      if (!lc.messageFlows) return { pass: true };
      const allNodeIds = new Set();
      for (const p of (lc.pools || [lc])) {
        for (const n of (p.nodes || [])) allNodeIds.add(n.id);
      }
      const allPoolIds = new Set([
        ...(lc.pools || []).map(p => p.id),
        ...(lc.collapsedPools || []).map(cp => cp.id),
      ]);
      const msgs = [];
      for (const mf of lc.messageFlows) {
        if (!allNodeIds.has(mf.source) && !allPoolIds.has(mf.source))
          msgs.push(`MessageFlow "${mf.id || ''}" unknown source: "${mf.source}"`);
        if (!allNodeIds.has(mf.target) && !allPoolIds.has(mf.target))
          msgs.push(`MessageFlow "${mf.id || ''}" unknown target: "${mf.target}"`);
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join('; ') };
    }
  },
  {
    id: 'S11', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'Expanded SubProcess muss Start- und End-Event haben',
    ref: { omg: '§10.2' },
    scope: 'process',
    check: (proc) => {
      const msgs = [];
      for (const node of (proc.nodes || [])) {
        if (node.isExpanded && node.nodes) {
          const subPrefix = `[SubProcess "${node.name || node.id}"] `;
          const subNodes = node.nodes || [];
          const subEdges = node.edges || [];
          if (!subNodes.some(n => n.type === 'startEvent'))
            msgs.push(`${subPrefix}Missing startEvent.`);
          if (!subNodes.some(n => n.type === 'endEvent'))
            msgs.push(`${subPrefix}Missing endEvent.`);
          const subIds = new Set(subNodes.map(n => n.id));
          for (const e of subEdges) {
            if (!subIds.has(e.source)) msgs.push(`${subPrefix}Edge "${e.id || ''}" unknown source: "${e.source}"`);
            if (!subIds.has(e.target)) msgs.push(`${subPrefix}Edge "${e.id || ''}" unknown target: "${e.target}"`);
          }
        }
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join('; ') };
    }
  },
];

// ═══════════════════════════════════════════════════════════════════════
// Schicht 2 — Method & Style (WARNING)
// ═══════════════════════════════════════════════════════════════════════

const STYLE_RULES = [
  {
    id: 'M01', layer: 'style', defaultSeverity: 'WARNING',
    description: 'Activity-Labels: Verb + Substantiv',
    ref: { silver: 'Ch.3', pmg: 'G5' },
    scope: 'process',
    check: (proc) => {
      const taskTypes = ['task', 'userTask', 'serviceTask', 'scriptTask', 'manualTask',
                         'businessRuleTask', 'sendTask', 'receiveTask'];
      const msgs = [];
      for (const n of (proc.nodes || [])) {
        if (taskTypes.includes(n.type) && n.name && !n.name.trim().replace(/\n/g, ' ').includes(' '))
          msgs.push(`Task "${n.name}" should follow "Verb + Substantiv" convention.`);
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join('; ') };
    }
  },
  {
    id: 'M02', layer: 'style', defaultSeverity: 'WARNING',
    description: 'XOR-Gateway-Labels: Frageform (endet mit ?)',
    ref: { silver: 'Ch.3' },
    scope: 'process',
    check: (proc) => {
      const msgs = [];
      const edges = proc.edges || [];
      for (const n of (proc.nodes || [])) {
        if (n.type !== 'exclusiveGateway' || n.has_join) continue;
        const outCount = edges.filter(e => e.source === n.id).length;
        if (outCount <= 1) continue; // converging/merge gateway — no label needed
        if (!(n.name || '').replace(/\n/g, ' ').includes('?'))
          msgs.push(`XOR gateway "${n.id}" should be a question (e.g. "Antrag gültig?").`);
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join('; ') };
    }
  },
  {
    id: 'M03', layer: 'style', defaultSeverity: 'WARNING',
    description: 'Converging Gateway: keine Labels an ausgehenden Kanten',
    ref: { silver: 'Ch.4' },
    scope: 'process',
    check: (proc) => {
      const nodes = proc.nodes || [], edges = proc.edges || [];
      const msgs = [];
      for (const n of nodes) {
        if (isGateway(n.type) && n.has_join) {
          const outEdges = edges.filter(e => e.source === n.id);
          for (const e of outEdges) {
            if (e.label) msgs.push(`Converging gateway "${n.id}" has labeled outgoing edge "${e.label}" — labels belong on diverging gateways.`);
          }
        }
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join('; ') };
    }
  },
  {
    id: 'M04', layer: 'style', defaultSeverity: 'WARNING',
    description: 'XOR-Gateway ausgehende Kanten müssen Labels haben',
    ref: { silver: 'Ch.4' },
    scope: 'process',
    check: (proc) => {
      const nodes = proc.nodes || [], edges = proc.edges || [];
      const msgs = [];
      for (const n of nodes) {
        if (n.type === 'exclusiveGateway' && !n.has_join) {
          const outEdges = edges.filter(e => e.source === n.id);
          if (outEdges.length > 1) {
            for (const e of outEdges) {
              if (!e.label) msgs.push(`Edge "${e.id || ''}" from XOR gateway "${n.id}" missing label.`);
            }
          }
        }
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join('; ') };
    }
  },
  // Platzhalter für zukünftige Style-Regeln
  {
    id: 'M05', layer: 'style', defaultSeverity: 'OFF', // NOT_IMPLEMENTED
    description: 'Message-Flow-Labels: nur Substantive',
    ref: { silver: 'Ch.5' },
    scope: 'global',
    check: () => ({ pass: true }),
  },
  {
    id: 'M06', layer: 'style', defaultSeverity: 'OFF', // NOT_IMPLEMENTED
    description: 'Event-Labels: Partizip/Zustand oder Substantiv',
    ref: { silver: 'Ch.3' },
    scope: 'process',
    check: () => ({ pass: true }),
  },
  {
    id: 'M07', layer: 'style', defaultSeverity: 'WARNING',
    description: 'Vermeide OR-Gateways (inclusive)',
    ref: { pmg: 'G5' },
    scope: 'process',
    check: (proc) => {
      const orGateways = (proc.nodes || []).filter(n => n.type === 'inclusiveGateway');
      return orGateways.length === 0
        ? { pass: true }
        : { pass: false, message: orGateways.map(n => `Inclusive (OR) gateway "${n.id}" (${n.name || ''}) — OR-Gateways are error-prone, prefer XOR or AND.`).join('; ') };
    }
  },
  {
    id: 'M08', layer: 'style', defaultSeverity: 'WARNING',
    description: 'Jeder XOR-Split hat einen Default-Flow',
    ref: { silver: 'Ch.4' },
    scope: 'process',
    check: (proc) => {
      const nodes = proc.nodes || [], edges = proc.edges || [];
      const outgoing = buildAdjacency(edges, 'source', 'target');
      const msgs = [];
      for (const n of nodes) {
        if (n.type !== 'exclusiveGateway' || n.has_join) continue;
        const outs = outgoing[n.id] || [];
        if (outs.length < 3) continue; // 2 mutual-exclusive paths (Ja/Nein) don't need a default
        const hasDefault = outs.some(e => e.isDefault);
        if (!hasDefault)
          msgs.push(`XOR gateway "${n.id}" (${n.name || ''}) has ${outs.length} outgoing flows but no default flow.`);
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join('; ') };
    }
  },
];

// ═══════════════════════════════════════════════════════════════════════
// Schicht 3 — Pragmatische Qualität (INFO)
// ═══════════════════════════════════════════════════════════════════════

const PRAGMATICS_RULES = [
  {
    id: 'P01', layer: 'pragmatics', defaultSeverity: 'INFO',
    description: 'Modellgröße ≤ 50 Elemente pro Prozess',
    ref: { pmg: 'G1' },
    scope: 'process',
    check: (proc, lc, config) => {
      const threshold = config?.overrides?.P01?.threshold || 50;
      const count = (proc.nodes || []).length;
      return count <= threshold
        ? { pass: true }
        : { pass: false, message: `Process has ${count} elements (threshold: ${threshold}). Consider splitting into sub-processes.` };
    }
  },
  {
    id: 'P02', layer: 'pragmatics', defaultSeverity: 'INFO',
    description: 'Gateway-Verschachtelungstiefe ≤ 3',
    ref: {},
    scope: 'process',
    check: (proc, lc, config) => {
      const threshold = config?.overrides?.P02?.threshold || 3;
      const nodes = proc.nodes || [], edges = proc.edges || [];
      const outgoing = buildAdjacency(edges, 'source', 'target');
      const gwTypes = new Set(['exclusiveGateway','parallelGateway','inclusiveGateway','eventBasedGateway','complexGateway']);
      const isGw = id => { const nd = nodes.find(x => x.id === id); return nd && gwTypes.has(nd.type); };
      let maxDepth = 0;
      function dfs(nodeId, depth, visited) {
        if (visited.has(nodeId)) return;
        visited.add(nodeId);
        const curDepth = isGw(nodeId) ? depth + 1 : depth;
        if (curDepth > maxDepth) maxDepth = curDepth;
        for (const e of (outgoing[nodeId] || [])) {
          dfs(e.target, curDepth, visited);
        }
      }
      const starts = nodes.filter(n => n.type === 'startEvent');
      for (const s of starts) dfs(s.id, 0, new Set());
      return maxDepth <= threshold
        ? { pass: true }
        : { pass: false, message: `Gateway nesting depth is ${maxDepth} (threshold: ${threshold}). Consider simplifying with sub-processes.` };
    }
  },
  {
    id: 'P03', layer: 'pragmatics', defaultSeverity: 'INFO',
    description: 'Control-Flow Complexity Score (CFC)',
    ref: { pmg: 'Metrik' },
    scope: 'process',
    check: (proc, lc, config) => {
      const threshold = config?.overrides?.P03?.threshold || 30;
      const nodes = proc.nodes || [], edges = proc.edges || [];
      const outgoing = buildAdjacency(edges, 'source', 'target');
      let cfc = 0;
      for (const n of nodes) {
        const outs = (outgoing[n.id] || []).length;
        if (outs < 2) continue;
        if (n.type === 'exclusiveGateway' || n.type === 'eventBasedGateway') cfc += outs;
        else if (n.type === 'parallelGateway') cfc += 1;
        else if (n.type === 'inclusiveGateway') cfc += Math.pow(2, outs) - 1;
      }
      return cfc <= threshold
        ? { pass: true }
        : { pass: false, message: `Control-Flow Complexity (CFC) is ${cfc} (threshold: ${threshold}). Consider splitting into sub-processes.` };
    }
  },
];

// ═══════════════════════════════════════════════════════════════════════
// Schicht 4 — Workflow-Net Soundness (opt-in, formal verification)
// ═══════════════════════════════════════════════════════════════════════

const WORKFLOW_NET_RULES = [
  {
    id: 'WF01', layer: 'workflow_net', defaultSeverity: 'WARNING',
    description: 'Liveness — jede Transition feuert mindestens einmal',
    ref: { vdaalst: 'Soundness Def. 1' },
    scope: 'global',
    check: () => ({ pass: true }), // Handled by runWfNetRules
  },
  {
    id: 'WF02', layer: 'workflow_net', defaultSeverity: 'WARNING',
    description: '1-Boundedness — kein Place akkumuliert mehr als 1 Token',
    ref: { vdaalst: 'Soundness Def. 2' },
    scope: 'global',
    check: () => ({ pass: true }), // Handled by runWfNetRules
  },
  {
    id: 'WF03', layer: 'workflow_net', defaultSeverity: 'ERROR',
    description: 'Proper Completion — keine Deadlocks, Sink erreichbar',
    ref: { vdaalst: 'Soundness Def. 3' },
    scope: 'global',
    check: () => ({ pass: true }), // Handled by runWfNetRules
  },
];

// ═══════════════════════════════════════════════════════════════════════
// Rule Registry + Runner
// ═══════════════════════════════════════════════════════════════════════

const RULES = [...SOUNDNESS_RULES, ...STYLE_RULES, ...PRAGMATICS_RULES, ...WORKFLOW_NET_RULES];

/**
 * Load a rule profile from JSON file.
 * Profile format: { profile, version, layers: { soundness, style, pragmatics }, overrides: { ruleId: { severity } } }
 */
function loadRuleProfile(profilePath) {
  try {
    return JSON.parse(readFileSync(resolve(profilePath), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Check if a rule is enabled given a profile.
 */
function isRuleEnabled(rule, profile) {
  if (!profile) return true;
  const layerConfig = profile.layers?.[rule.layer];
  if (layerConfig && layerConfig.enabled === false) return false;
  const override = profile.overrides?.[rule.id];
  if (override?.severity === 'OFF') return false;
  return true;
}

/**
 * Get effective severity for a rule given a profile.
 */
function getEffectiveSeverity(rule, profile) {
  const override = profile?.overrides?.[rule.id];
  return override?.severity || rule.defaultSeverity;
}

/**
 * Run all rules against a Logic-Core document.
 * @param {object} lc - Logic-Core JSON
 * @param {object|null} profile - Rule profile (or null for defaults)
 * @returns {{ errors: string[], warnings: string[], infos: string[], metrics: object }}
 */
function runRules(lc, profile = null) {
  const errors = [], warnings = [], infos = [];
  const metrics = {};
  const processes = lc.pools ? lc.pools : [lc];

  for (const rule of RULES) {
    if (!isRuleEnabled(rule, profile)) continue;
    const severity = getEffectiveSeverity(rule, profile);
    if (severity === 'OFF') continue;

    if (rule.scope === 'global') {
      // Run once for the whole model
      const result = rule.check(null, lc, profile);
      if (!result.pass) {
        classifyResult(result.message, severity, errors, warnings, infos, '');
      }
    } else {
      // Run per process
      for (const proc of processes) {
        const prefix = lc.pools ? `[${proc.name || proc.id}] ` : '';
        const result = rule.check(proc, lc, profile);
        if (!result.pass) {
          classifyResult(result.message, severity, errors, warnings, infos, prefix);
        }
      }
    }
  }

  // Workflow-Net rules (opt-in via profile)
  const wfNetEnabled = profile?.layers?.workflow_net?.enabled === true;
  if (wfNetEnabled) {
    const wfResult = checkWorkflowNetSoundness(lc);
    for (const issue of wfResult.issues) {
      // Map WF rule severity through profile overrides
      const wfRule = WORKFLOW_NET_RULES.find(r => r.id === issue.rule);
      const severity = wfRule ? getEffectiveSeverity(wfRule, profile) : issue.severity;
      if (severity === 'OFF') continue;
      if (severity === 'ERROR') errors.push(issue.message);
      else if (severity === 'WARNING') warnings.push(issue.message);
      else if (severity === 'INFO') infos.push(issue.message);
    }
    metrics.workflowNet = wfResult.stats;
  }

  return { errors, warnings, infos, metrics };
}

function classifyResult(message, severity, errors, warnings, infos, prefix) {
  const msgs = message.split('; ');
  for (const msg of msgs) {
    const fullMsg = prefix + msg;
    if (severity === 'ERROR') errors.push(fullMsg);
    else if (severity === 'WARNING') warnings.push(fullMsg);
    else if (severity === 'INFO') infos.push(fullMsg);
  }
}

export { RULES, SOUNDNESS_RULES, STYLE_RULES, PRAGMATICS_RULES, WORKFLOW_NET_RULES, loadRuleProfile, runRules, buildAdjacency, countIncoming, traceReachable, isReachableWithout };

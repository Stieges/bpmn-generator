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

import { loadRuleProfile, isRuleEnabled, getEffectiveSeverity } from '../shared/rule-profile.js';
import { isEvent, isGateway, isBoundaryEvent, isArtifact, isContainerNode, CONTAINER_TYPES } from './types.js';
import { checkWorkflowNetSoundness } from './workflow-net.js';
import { runOptimizationAnalysis } from './optimize.js';
import { CFG } from '../shared/utils.js';

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

/**
 * Every node, at every nesting level, across every pool of a Logic-Core document — or of the
 * single process, when there are no pools — indexed by id.
 *
 * One walk, shared by the three message-flow rules (S10, S12, S14) that all ask the same
 * question of the same graph. They had grown three private copies of it; S12's and S14's were
 * byte-identical, and the copies are how the three came to disagree about what "a node" is (S12
 * gained the `isExpanded` fix that S10 did not have). A rule object that only needs to *look
 * something up* loses nothing by not restating the walk; the ones carrying real judgment (S05's
 * `starvedParallelJoins`, S13's container-scoped collect) keep theirs, because there the walk
 * IS the rule.
 *
 * Returns the node objects, not just their types: S14 has to ask `isContainerNode`, which reads
 * `nodes` as well as `type`.
 *
 * Recursion is unconditional on `n.nodes` — not gated on `isExpanded`, a BPMNShape attribute
 * (BPMNDI.xsd:55, BPMNDI.cmof:34) with no semantic counterpart, and not gated on the container's
 * declared type either, matching every other descent in the repo. Gating on `isExpanded` made a
 * collapsed container's children invisible for purely graphical reasons.
 *
 * Deliberately NOT `redesign-core.js`'s `collectIds`: that one also returns pool, lane and edge
 * ids. S10 admits pool ids separately and on purpose (a Participant IS an InteractionNode,
 * BPMN20.cmof:863); a lane or an edge id is an endpoint no reading of the standard allows, and
 * folding them into the same set would silently accept both.
 *
 * @param {object} lc - Logic-Core document (pools, or a single process)
 * @returns {Map<string, object>} node id → node
 */
function nodesById(lc) {
  const byId = new Map();
  const collectFrom = (container) => {
    for (const n of (container.nodes || [])) {
      byId.set(n.id, n);
      if (n.nodes) collectFrom(n);
    }
  };
  for (const p of (lc.pools || [lc])) collectFrom(p);
  return byId;
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

/**
 * Every node reachable from one branch of a split gateway, the branch's own
 * first node included.
 *
 * The split itself is never expanded: a loop running back to it would otherwise
 * make one branch look as if it could reach the other, which is exactly how a
 * real deadlock would disappear from view.
 */
function reachFromBranch(branchStart, splitId, outgoing) {
  const visited = new Set();
  const queue = [branchStart];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (visited.has(cur) || cur === splitId) continue;
    visited.add(cur);
    for (const edge of (outgoing[cur] || [])) {
      if (!visited.has(edge.target)) queue.push(edge.target);
    }
  }
  return visited;
}

/** Human-readable handle for a sequence flow — its id, or its endpoints. */
function flowRef(edge) {
  return edge.id || `${edge.source}→${edge.target}`;
}

/**
 * S05/S06 — parallel joins that a mutually exclusive split can starve.
 *
 * Both rules used to ask *"do two branches of this split reach the AND-join?"*.
 * That is a reachability question, not a token question, and it rejects sound
 * models: two branches that re-converge at a merge **before** the parallel block
 * both reach the join, yet by then the choice is resolved, a single token enters
 * the AND-fork and forks into exactly the tokens the join waits for. There is no
 * deadlock, and S05 blocked generation entirely (severity ERROR ⇒ no output).
 *
 * The question that actually identifies a deadlock is asked per **incoming flow**
 * of the join, because a parallel join fires only once every incoming flow
 * carries a token:
 *
 *   1. for each incoming flow, collect which branches of the split can supply it
 *      — either by reaching its source, or by BEING that branch's own edge (the
 *      split may flow straight into the join; see the `suppliers` comment);
 *   2. ignore the flows no branch can supply (`influenced` below) — those are fed
 *      from outside this split's subgraph, typically by a concurrent thread of an
 *      enclosing AND block, and no choice at the split can starve them;
 *   3. if all remaining flows agree on their supplying-branch set, then every
 *      choice either feeds all of them or none of them — no starvation;
 *   4. if two of them disagree, some branch supplies one but never the other, and
 *      the join waits for a token this run can no longer produce.
 *
 * Step 4 is strictly stronger than "two incoming flows have *disjoint* supplying
 * branches": with three branches A/B/C where A feeds only flow 1, C only flow 2
 * and B both, no pair of flows is disjoint, yet choosing A still deadlocks. See
 * the "no two arms are exclusive" test in pipeline.test.js.
 *
 * Deliberately conservative in one place: a flow counts as suppliable by a branch
 * as soon as its SOURCE node is reachable from that branch, without proving the
 * flow itself can still fire. That over-approximates the supplying sets, which
 * makes them more likely to agree — so the residual error is a missed deadlock,
 * never a fabricated one. The exhaustive check is WF03 (opt-in, workflow_net
 * layer); this rule is the cheap always-on guard and must not cry wolf.
 *
 * @param {object} proc - one process (pool) of a Logic-Core document
 * @param {string} splitType - 'exclusiveGateway' or 'inclusiveGateway'
 * @param {string} label - how the split is named in the message ('XOR'/'Inclusive')
 * @returns {string[]} one message per (split, join) pair that can starve
 */
function starvedParallelJoins(proc, splitType, label) {
  const nodes = proc.nodes || [], edges = proc.edges || [];
  const outgoing = buildAdjacency(edges, 'source', 'target');
  const incoming = buildAdjacency(edges, 'target', 'source');
  const msgs = [];

  for (const split of nodes) {
    if (split.type !== splitType) continue;
    // A gateway diverges when it has more than one outgoing flow. `has_join` is
    // only a direction *hint* (input-schema.json) and says nothing about the
    // outgoing side — a Mixed gateway (BPMN 2.0.2, Gateway::gatewayDirection)
    // merges and splits at once and is still a split.
    const branchEdges = outgoing[split.id] || [];
    if (branchEdges.length < 2) continue;

    const branchReach = branchEdges.map(be => reachFromBranch(be.target, split.id, outgoing));

    for (const join of nodes) {
      if (join.type !== 'parallelGateway') continue;
      const joinIn = incoming[join.id] || [];
      if (joinIn.length < 2) continue;

      const suppliers = joinIn.map(e => {
        const set = new Set();
        for (let i = 0; i < branchReach.length; i++) {
          // Two ways a branch supplies an incoming flow. Reaching its source is
          // the ordinary one. The second is easy to lose: when the split's own
          // branch edge IS the incoming flow (`gx --no--> gj`, the everyday skip
          // path), its source is the split, and `reachFromBranch` deliberately
          // never puts the split in any reach set — so without this the flow
          // would look unsupplied, be discarded as "fed from outside" and take a
          // real deadlock with it.
          //
          // Matched by object identity, not by endpoints: a split may carry two
          // separate flows to the same join (`gx --yes--> gj`, `gx --no--> gj`),
          // and those are two different branches. Comparing `e.source`/`e.target`
          // would credit both branches with both flows, make the supplying sets
          // agree, and lose that deadlock too.
          if (branchReach[i].has(e.source) || branchEdges[i] === e) set.add(i);
        }
        return set;
      });
      const influenced = joinIn.map((_, i) => i).filter(i => suppliers[i].size > 0);
      if (influenced.length < 2) continue;

      // A witness: one branch, one flow it supplies, one flow it never supplies.
      let witness = null;
      for (let a = 0; a < influenced.length && !witness; a++) {
        for (let b = a + 1; b < influenced.length && !witness; b++) {
          const [ia, ib] = [influenced[a], influenced[b]];
          const onlyA = [...suppliers[ia]].find(x => !suppliers[ib].has(x));
          if (onlyA !== undefined) { witness = { branch: onlyA, fed: ia, starved: ib }; break; }
          const onlyB = [...suppliers[ib]].find(x => !suppliers[ia].has(x));
          if (onlyB !== undefined) witness = { branch: onlyB, fed: ib, starved: ia };
        }
      }
      if (!witness) continue;

      // The branch is named by its own outgoing flow AND its target: naming only
      // the target reads as nonsense when that target IS the join (the skip-path
      // shape `gx --no--> gj`), and naming only the flow is unhelpful for the
      // ordinary case where the reader is looking for a node.
      const branchEdge = branchEdges[witness.branch];
      msgs.push(
        `Deadlock: ${label}-split "${split.id}" feeds AND-join "${join.id}" on mutually exclusive paths — ` +
        `its branch "${flowRef(branchEdge)}" → "${branchEdge.target}" supplies incoming flow ` +
        `"${flowRef(joinIn[witness.fed])}" but never "${flowRef(joinIn[witness.starved])}", ` +
        `so the join never receives all its tokens.`
      );
    }
  }
  return msgs;
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
    description: 'Deadlock: XOR-Split darf keinen AND-Join auf exklusiven Pfaden speisen',
    ref: {
      omg: '§10.5 Gateways',
      // Cited by class rather than by page: an ExclusiveGateway activates exactly
      // one of its outgoing flows, a ParallelGateway join consumes one token from
      // every incoming flow. Combining the two on paths that are still mutually
      // exclusive at the join is the deadlock 7PMG G4 warns about.
      cmof: 'ExclusiveGateway superClass="Gateway", ParallelGateway superClass="Gateway", '
        + 'Gateway isAbstract superClass="FlowNode" with gatewayDirection : GatewayDirection '
        + '{Unspecified, Converging, Diverging, Mixed} — "Mixed" is why this rule tests the '
        + 'outgoing degree instead of trusting the has_join hint.',
      pmg: 'G4',
    },
    scope: 'process',
    // See starvedParallelJoins() above for why this is asked per incoming flow
    // and not per join node.
    check: (proc) => {
      const msgs = starvedParallelJoins(proc, 'exclusiveGateway', 'XOR');
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join('; ') };
    }
  },
  {
    id: 'S06', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'Deadlock: Inclusive-Split darf keinen AND-Join auf exklusiven Pfaden speisen',
    // Same shape as S05: an InclusiveGateway may activate a single outgoing
    // flow, so any branch that can fire alone can starve the join exactly as an
    // exclusive branch does. What S06 does NOT cover is the opposite inclusive
    // hazard — several branches firing and re-converging at an XOR merge, which
    // puts several tokens into the parallel block. That is a boundedness /
    // proper-completion defect (WF02/WF03), not a deadlock.
    ref: {
      omg: '§10.5 Gateways',
      cmof: 'InclusiveGateway superClass="Gateway" with default : SequenceFlow — an inclusive '
        + 'split may activate a single outgoing flow, so one branch alone can starve a '
        + 'ParallelGateway superClass="Gateway" join downstream.',
    },
    scope: 'process',
    check: (proc) => {
      const msgs = starvedParallelJoins(proc, 'inclusiveGateway', 'Inclusive');
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
      // `nodesById` walks every nesting level on purpose. A message flow may legally name a node
      // one or more levels down — a send/receive task or a message event inside a subprocess —
      // and that is precisely the endpoint S14 recommends when an author has aimed a flow at the
      // container instead. Collecting one level per pool reported such an endpoint as a dangling
      // reference, so the advice S14 gives would have walked the reader straight into a
      // different false ERROR. Pool ids are admitted below, deliberately and separately.
      const allNodeIds = nodesById(lc);
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
  {
    id: 'S12', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'Message Flow source/target darf kein Gateway sein (OMG §7.6.2 Table 7.4)',
    ref: { omg: '§7.6.2 Table 7.4', cmof: 'MessageFlow.sourceRef/targetRef type=InteractionNode; Gateway extends FlowNode (not InteractionNode)' },
    scope: 'global',
    check: (proc, lc) => {
      if (!lc.messageFlows) return { pass: true };
      // Every node at every nesting level — `nodesById`'s descent is not gated on `isExpanded`,
      // a BPMNShape attribute with no semantic counterpart, so a gateway one level down inside a
      // collapsed container can no longer be a message-flow endpoint and go unreported.
      const byId = nodesById(lc);
      const isGatewayType = (t) => typeof t === 'string' && t.toLowerCase().includes('gateway');
      const msgs = [];
      for (const mf of lc.messageFlows) {
        const srcType = byId.get(mf.source)?.type;
        const tgtType = byId.get(mf.target)?.type;
        // mf.source may be a Pool id (Participant); only flag if it's a known Gateway node
        if (srcType && isGatewayType(srcType))
          msgs.push(`MessageFlow "${mf.id || ''}" source "${mf.source}" is a ${srcType} — Gateways cannot be MessageFlow sources (use a Task or Event instead).`);
        if (tgtType && isGatewayType(tgtType))
          msgs.push(`MessageFlow "${mf.id || ''}" target "${mf.target}" is a ${tgtType} — Gateways cannot be MessageFlow targets (use a Task or Event instead).`);
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join('; ') };
    }
  },
  {
    id: 'S13', layer: 'soundness', defaultSeverity: 'ERROR',
    description: 'Boundary Event muss an einer existierenden Aktivität hängen (OMG §10.4.3)',
    ref: { omg: '§10.4.3 Table 10.86', cmof: 'BoundaryEvent.attachedToRef : Activity [1..1]' },
    scope: 'process',
    check: (proc) => {
      // attachedToRef is mandatory in the OMG schema. Without this check a
      // dangling reference produced a boundaryEvent with no attachedToRef, no DI
      // shape, and an outgoing flow with no waypoints — invalid BPMN that
      // validated green.
      // Every activity, and which container it sits in. The container matters:
      // BPMN requires a boundary event and its host to share one, so knowing
      // that the id exists somewhere is not enough. Collecting recursively while
      // only CHECKING the top level — the earlier shape of this rule — was
      // exactly backwards: it let a dangling boundary event one level down pass,
      // and accepted a top-level one reaching into a subprocess.
      const containerOf = new Map();
      const collect = (container, containerId) => {
        for (const n of (container.nodes || [])) {
          containerOf.set(n.id, containerId);
          if (n.nodes) collect(n, n.id);
        }
      };
      collect(proc, proc.id ?? '(process)');

      const msgs = [];
      const check = (container, containerId) => {
        for (const n of (container.nodes || [])) {
          if (n.nodes) check(n, n.id);
          if (n.type !== 'boundaryEvent') continue;
          if (!n.attachedTo) {
            msgs.push(`Boundary Event "${n.id}" hat kein attachedTo — jedes Boundary Event muss an einer Aktivität hängen.`);
          } else if (!containerOf.has(n.attachedTo)) {
            msgs.push(`Boundary Event "${n.id}" verweist mit attachedTo auf "${n.attachedTo}" — dieser Knoten existiert nicht.`);
          } else if (containerOf.get(n.attachedTo) !== containerId) {
            msgs.push(`Boundary Event "${n.id}" liegt in "${containerId}", seine Aktivität "${n.attachedTo}" aber in "${containerOf.get(n.attachedTo)}" — beide müssen im selben Container liegen.`);
          }
        }
      };
      check(proc, proc.id ?? '(process)');

      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join('; ') };
    }
  },
  {
    id: 'S14', layer: 'soundness', defaultSeverity: 'WARNING',
    description: 'Message Flow source/target darf kein Container sein — weder der Klasse nach '
      + '(SubProcess/Transaction/AdHocSubProcess/CallActivity) noch der Struktur nach (ein Knoten '
      + 'mit eigenem `nodes`-Array) (OMG §7.6.2 Table 7.4)',
    ref: {
      omg: '§7.6.2 Table 7.4',
      cmof: 'MessageFlow.sourceRef/targetRef type=InteractionNode (BPMN20.cmof:851-852). '
        + 'Task superClass="Activity InteractionNode" (:1191) and Event superClass="FlowNode '
        + 'InteractionNode" (:287) get it by an explicit second superclass; Participant is '
        + 'superClass="InteractionNode BaseElement" (:863). Activity is superClass="FlowNode" '
        + 'only (:1095), and SubProcess (:1147, superClass="Activity FlowElementsContainer"), '
        + 'CallActivity (:1188, superClass="Activity"), AdHocSubProcess (:1222, '
        + 'superClass="SubProcess") and Transaction (:1233, superClass="SubProcess") inherit '
        + 'from it — none of them is an InteractionNode. The line numbers are a convenience '
        + 'for a local copy of BPMN20.cmof (references/omg-spec/ is not tracked); the class '
        + 'and superclass names are the reference, and hold in any copy of the file. The rule '
        + 'also covers the structural case — a node of any type carrying its own `nodes` array, '
        + 'which `references/input-schema.json` permits and which `bpmnToPN` translates into an '
        + 'entry/exit pair, i.e. a container whatever it calls itself.',
    },
    scope: 'global',
    // Why WARNING and not ERROR: the soundness layer already carries WARNING-severity rules
    // (S04, S07, S08), so this is consistent with the layer rather than an exception to it; it
    // keeps every model that validates today generating; and `rules/strict-profile.json` is the
    // existing, documented way to escalate it for anyone who wants the build to stop.
    check: (proc, lc) => {
      if (!lc.messageFlows) return { pass: true };
      // `isContainerNode` (types.js) — by CLASS **or** by carrying a scope, and both legs matter:
      //   - the CLASS leg is why this is not `n.nodes?.length`. A collapsed subProcess carrying
      //     no `nodes` array, and a callActivity (which by its nature never carries children),
      //     are the same schema violation as an expanded subprocess. The CMOF argument is about
      //     the class, not about how much of it the author wrote down, and `isExpanded` says
      //     nothing here either (BPMNDI.xsd:55 / BPMNDI.cmof:34, a BPMNShape attribute).
      //   - the STRUCTURAL leg is why this is not `CONTAINER_TYPES.has(type)`, which is what this
      //     rule used to ask. `references/input-schema.json` declares `nodes` on every `Node`, so
      //     a `userTask` carrying a `nodes` array is schema-valid — and `bpmnToPN`'s own
      //     `isContainer` is purely structural, so such a node gets an entry/exit PAIR and a
      //     message flow naming it would double-send. `composeCollaboration`
      //     (`scripts/scenarios/collaboration.js`) already refused it (`reason: 'container'`) and
      //     silently dropped the synchronisation while this rule emitted nothing: the same
      //     two-layer disagreement the shared `CONTAINER_TYPES` closed in the other direction,
      //     arrived at through the leg that was not shared. Both layers now ask one predicate.
      const byId = nodesById(lc);

      const msgs = [];
      const complain = (mf, endpoint, node) => {
        // Never the literal word "subProcess": with the structural leg the offender may be any
        // node type at all, and telling a `userTask`'s author that "Activity extends FlowNode
        // only" would be an argument about a class their node is not in.
        const why = CONTAINER_TYPES.has(node.type)
          ? `is a ${node.type} — not an InteractionNode (BPMN20.cmof: Activity extends FlowNode `
            + 'only, unlike Task and Event)'
          : `is a ${node.type} that carries its own \`nodes\` — a container in everything but its `
            + 'declared type. Only Activity subclasses may contain a scope, and none of those is '
            + 'an InteractionNode (BPMN20.cmof: Activity extends FlowNode only, unlike Task and '
            + 'Event)';
        msgs.push(`MessageFlow "${mf.id || ''}" ${endpoint} "${node.id}" ${why}. `
          + 'Point the flow at a black-box participant, at a send/receive task inside the '
          + 'container, or at a message start/end event inside it. Collapsing the container does '
          + 'not help — isExpanded is a BPMNShape attribute.');
      };
      for (const mf of lc.messageFlows) {
        const src = byId.get(mf.source);
        const tgt = byId.get(mf.target);
        if (src && isContainerNode(src)) complain(mf, 'source', src);
        if (tgt && isContainerNode(tgt)) complain(mf, 'target', tgt);
      }
      return msgs.length === 0 ? { pass: true } : { pass: false, message: msgs.join('; ') };
    }
  },
];

// ═══════════════════════════════════════════════════════════════════════
// Schicht 2 — Method & Style (WARNING)
// ═══════════════════════════════════════════════════════════════════════

// M01 Objekt+Verb-Heuristik. Bewusst konservativ und nur WARNING — das ist KEIN
// echter POS-Tagger (exakte Wortartanalyse bleibt M05/M06, aktuell OFF). Die
// deutsche BA-Konvention setzt das Verb ans Ende im Infinitiv ("Antrag prüfen");
// zusätzlich akzeptieren wir das englische Verb-first-Muster ("Review application")
// über eine kleine kuratierte Liste, um False-Positives zu vermeiden.
const M01_GERMAN_VERB_SUFFIX = /(en|eln|ern|ieren)$/i;
const M01_ENGLISH_VERBS = new Set([
  'review', 'approve', 'send', 'receive', 'check', 'create', 'update', 'delete',
  'reject', 'submit', 'notify', 'validate', 'process', 'archive', 'assign', 'verify',
  'confirm', 'record', 'issue', 'close', 'open', 'prepare', 'request', 'forward',
  'escalate', 'sign', 'evaluate', 'calculate', 'generate', 'publish', 'cancel',
  'release', 'collect', 'enter', 'add', 'remove', 'store', 'fetch', 'handle',
]);

// Returns true when a task label does NOT look like Objekt+Verb / Verb+Object.
function violatesVerbObject(name) {
  const cleaned = String(name)
    .replace(/\([^)]*\)/g, ' ')   // (meta) entfernen, z.B. "(KVNeo)"
    .replace(/\[[^\]]*\]/g, ' ')  // [meta] entfernen
    .replace(/[/\n]+/g, ' ')      // Slash/Newline → Leerzeichen ("erfassen/ändern")
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = cleaned ? cleaned.split(' ') : [];
  if (tokens.length < 2) return true;                       // Einzelwort → Verstoß
  const first = tokens[0].toLowerCase().replace(/[^a-zäöüß]/gi, '');
  if (M01_ENGLISH_VERBS.has(first)) return false;           // englisch: Verb zuerst
  const last = tokens[tokens.length - 1];
  if (last.length >= 4 && M01_GERMAN_VERB_SUFFIX.test(last)) return false; // deutsch: Infinitiv am Ende
  return true;
}

const STYLE_RULES = [
  {
    id: 'M01', layer: 'style', defaultSeverity: 'WARNING',
    description: 'Activity-Labels: Objekt + Verb (Verb im Infinitiv)',
    ref: { silver: 'Ch.3', pmg: 'G5' },
    scope: 'process',
    check: (proc) => {
      const taskTypes = ['task', 'userTask', 'serviceTask', 'scriptTask', 'manualTask',
                         'businessRuleTask', 'sendTask', 'receiveTask'];
      const msgs = [];
      for (const n of (proc.nodes || [])) {
        if (taskTypes.includes(n.type) && n.name && violatesVerbObject(n.name))
          msgs.push(`Task "${n.name}" folgt nicht der Objekt+Verb-Konvention (z.B. "Antrag prüfen"). Heuristik — exakte Wortartprüfung: M05/M06.`);
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
  {
    id: 'M09', layer: 'style', defaultSeverity: 'WARNING',
    description: 'Lane-Node-Zuweisung: Format B (lane.nodeIds) ohne Format A (node.lane)',
    ref: {},
    scope: 'process',
    check: (proc) => {
      const lanes = proc.lanes || [], nodes = proc.nodes || [];
      if (lanes.length === 0) return { pass: true };
      const msgs = [];
      for (const lane of lanes) {
        if (!lane.nodeIds || lane.nodeIds.length === 0) continue;
        const missingFormatA = lane.nodeIds.filter(nid => {
          const node = nodes.find(n => n.id === nid);
          return node && node.lane !== lane.id;
        });
        if (missingFormatA.length > 0)
          msgs.push(`Lane "${lane.id}" uses nodeIds (Format B) but ${missingFormatA.length} node(s) lack node.lane (Format A): ${missingFormatA.slice(0, 3).join(', ')}${missingFormatA.length > 3 ? '...' : ''}`);
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
  {
    id: 'M10', layer: 'style', defaultSeverity: 'WARNING',
    description: 'Lane and pool names should be ≤ 25 characters for readable swimlane headers',
    ref: { silver: '§4.2' },
    scope: 'global',
    check: (proc, lc) => {
      const LIMIT = 25;
      const offenders = [];
      const pools = lc.pools ?? [lc];
      for (const pool of pools) {
        if (pool.name && pool.name.length > LIMIT) {
          offenders.push(`pool "${pool.name}" (${pool.name.length} chars)`);
        }
        for (const lane of pool.lanes ?? []) {
          if (lane.name && lane.name.length > LIMIT) {
            offenders.push(`lane "${lane.name}" (${lane.name.length} chars)`);
          }
        }
      }
      return offenders.length === 0
        ? { pass: true }
        : { pass: false, message: `Names exceed ${LIMIT} chars — shorten for readability: ${offenders.join('; ')}` };
    }
  },
  {
    id: 'M11', layer: 'style', defaultSeverity: 'WARNING',
    description: 'decisionRef belongs on a businessRuleTask — that is the element that invokes a decision',
    // Our own convention, not Bruce Silver: `decisionRef` is a generator extension
    // (see EXTENSION_NS in utils.js). BPMN allows extensionElements on any
    // BaseElement, so putting it elsewhere is legal XML and round-trips fine — it
    // just does not mean anything, and no engine will act on it. Hence WARNING,
    // not ERROR: the file is valid, the modelling is not.
    ref: { omg: '§10.2.5 Business Rule Task', note: 'generator extension, no OMG attribute exists' },
    scope: 'process',
    check: (proc) => {
      const offenders = [];
      const walk = (container) => {
        for (const n of (container.nodes || [])) {
          if (n.nodes) walk(n);
          if (n.decisionRef && n.type !== 'businessRuleTask') {
            offenders.push(`"${n.id}" (${n.type})`);
          }
        }
      };
      walk(proc);
      return offenders.length === 0
        ? { pass: true }
        : { pass: false, message: `decisionRef on a non-businessRuleTask has no meaning: ${offenders.join(', ')}` };
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
// Schicht 5 — Process Optimization Advisory (opt-in, "Soll"/optimize mode)
// ═══════════════════════════════════════════════════════════════════════
// Registry entries only (severity/profile/documentation). The real graph
// analysis lives in optimize.js and runs via runOptimizationAnalysis() below,
// mirroring the Workflow-Net opt-in pattern. Sources: published Reijers &
// Limam Mansar (2005) + BABOK v3 §10.34 — never internal material.

const OPTIMIZATION_RULES = [
  {
    id: 'O01', layer: 'optimization', defaultSeverity: 'ADVISORY',
    description: 'Exception isolation — Ausnahmen vom Hauptfluss trennen',
    ref: { reijers: 'exception' }, tradeoff: { quality: '+' },
    scope: 'global', check: () => ({ pass: true }), // handled by runOptimizationAnalysis
  },
  {
    id: 'O02', layer: 'optimization', defaultSeverity: 'ADVISORY',
    description: 'Knock-out ordering — Prüfungen nach Aufwand/Wahrscheinlichkeit ordnen',
    ref: { reijers: 'knock-out' }, tradeoff: { cost: '−' },
    scope: 'global', check: () => ({ pass: true }),
  },
  {
    id: 'O03', layer: 'optimization', defaultSeverity: 'ADVISORY',
    description: 'Handoffs / task composition — Rollen-Übergaben reduzieren',
    ref: { reijers: 'task-composition', babok: '§10.34' }, tradeoff: { time: '−' },
    scope: 'global', check: () => ({ pass: true }),
  },
  {
    id: 'O04', layer: 'optimization', defaultSeverity: 'ADVISORY',
    description: 'Parallelism candidate — sequentielle Aufgaben ggf. parallelisieren',
    ref: { reijers: 'parallelism' }, tradeoff: { time: '−' },
    scope: 'global', check: () => ({ pass: true }),
  },
];

// ═══════════════════════════════════════════════════════════════════════
// Rule Registry + Runner
// ═══════════════════════════════════════════════════════════════════════

const RULES = [...SOUNDNESS_RULES, ...STYLE_RULES, ...PRAGMATICS_RULES, ...WORKFLOW_NET_RULES, ...OPTIMIZATION_RULES];

// loadRuleProfile / isRuleEnabled / getEffectiveSeverity now live in
// rule-profile.js — nothing about them was BPMN-specific, and the DMN engine
// needs exactly the same three. They are re-exported below so every existing
// importer of rules.js keeps working.

/**
 * Derive a rule profile for a given mode. The "optimize"/"soll" mode enables the
 * opt-in Optimization Advisory layer on top of any base profile; "document"
 * (default) leaves the profile untouched.
 * @param {object|null} baseProfile
 * @param {string} [mode='document']
 * @returns {object|null}
 */
function profileForMode(baseProfile, mode = 'document') {
  if (mode !== 'optimize' && mode !== 'soll') return baseProfile;
  const p = baseProfile ? JSON.parse(JSON.stringify(baseProfile)) : {};
  p.layers = p.layers || {};
  p.layers.optimization = { ...(p.layers.optimization || {}), enabled: true };
  return p;
}

/**
 * Run all rules against a Logic-Core document.
 * @param {object} lc - Logic-Core JSON
 * @param {object|null} profile - Rule profile (or null for defaults)
 * @returns {{ errors: string[], warnings: string[], infos: string[], metrics: object }}
 */
function runRules(lc, profile = null) {
  const errors = [], warnings = [], infos = [], advisories = [];
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

  // Optimization Advisory rules (opt-in via profile / "optimize" mode)
  const optimizationEnabled = profile?.layers?.optimization?.enabled === true;
  if (optimizationEnabled) {
    const optResult = runOptimizationAnalysis(lc, CFG.optimization || {});
    advisories.push(...optResult.advisories);
    metrics.optimization = optResult.metrics;
  }

  return { errors, warnings, infos, advisories, metrics };
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

export { RULES, SOUNDNESS_RULES, STYLE_RULES, PRAGMATICS_RULES, WORKFLOW_NET_RULES, OPTIMIZATION_RULES, loadRuleProfile, profileForMode, runRules, buildAdjacency, countIncoming, traceReachable, isReachableWithout };

/**
 * Process Optimization Advisory (opt-in "Soll"/optimize mode).
 *
 * Detects redesign OPPORTUNITIES from the process graph and emits them as
 * non-blocking ADVISORY findings — never auto-applied. Each finding carries a
 * devil's-quadrangle trade-off tag (time/cost/quality/flexibility).
 *
 * Sources (published; do NOT cite internal material):
 *   - Reijers & Limam Mansar (2005), "Best practices in business process
 *     redesign: an overview and qualitative evaluation of successful redesign
 *     heuristics", Omega 33(4). — task/flow heuristics + devil's quadrangle.
 *   - BABOK v3 (2015) §10.34 Process Analysis — Lean/waste metrics.
 *
 * These are HEURISTICS, not proofs. They flag candidates for human review; the
 * model lacks runtime/volume data (effort, probabilities, true data-dependency),
 * so nothing is asserted as certain and nothing is reordered automatically.
 */

import { isGateway, TASK_TYPES } from './types.js';
import { resolveLaneId } from './topology.js';

const EXCEPTION_MARKERS = new Set(['error', 'terminate', 'escalation', 'cancel']);
// German-first exception stems (match inflected forms: eskaliert/eskalation,
// storniert/storno, ablehnung/abgelehnt, verworfen/verwerfen, abgebrochen/abbruch).
const EXCEPTION_NAME_RE = /fehler|error|abbruch|abgebroch|eskal|storn|ablehn|abgelehnt|reject|cancel|verwerf|verworf/i;
const WAIT_MARKERS = new Set(['timer', 'message']);

const DEFAULTS = {
  minParallelChain: 3,   // O04: linear same-lane task run length to flag
  minKnockoutChain: 2,   // O02: consecutive knock-out gateways to flag
  maxHandoffs: 6,        // O03: lane-crossing edges above which to advise
  minExceptionEnds: 2,   // O01: interleaved exception ends to advise
};

const out = (edges) => { const m = {}; for (const e of edges) (m[e.source] ??= []).push(e); return m; };
const inc = (edges) => { const m = {}; for (const e of edges) (m[e.target] ??= []).push(e); return m; };
const byId = (nodes) => { const m = {}; for (const n of nodes) m[n.id] = n; return m; };
// The shared `TASK_TYPES` (types.js), not a private copy of the same eight names, and
// deliberately NOT the wider `isActivity`. Every advisory that reads this predicate is about a
// leaf work step: O04 nominates a linear same-lane chain for parallelisation, and the transform
// that would carry that advisory out — `previewParallelize` (redesign.js) — refuses a chain
// containing a subprocess on purpose, because parallelising a scope is not a reordering. An
// advisory the toolbox is guaranteed to refuse is worse than no advisory, so the two layers ask
// the same question. O01/O02's knock-out heuristic is scoped the same way for the same reason
// (Reijers & Limam Mansar's knock-out best practice is stated over tasks). That containers are
// therefore never nominated is a real, deliberate gap, not an oversight: closing it means
// widening the transform first.
const isTask = (n) => n && TASK_TYPES.has(n.type);
const isEnd = (n) => n && n.type === 'endEvent';
// An exception end = negative termination (reject / error / abort), by marker or name.
const isExcEnd = (n) => isEnd(n) && (EXCEPTION_MARKERS.has(n.marker) || EXCEPTION_NAME_RE.test(n.name || ''));

// A branch is a "reject" branch of a knock-out if it terminates the case
// NEGATIVELY: the target is an exception end directly, or a single reject-task
// that leads straight to one. (A task leading to a normal end is completion, not
// a knock-out — this keeps the heuristic precise and low-noise.)
function isRejectBranch(targetId, outMap, nmap) {
  const n = nmap[targetId];
  if (isExcEnd(n)) return true;
  if (isTask(n)) {
    const o = outMap[targetId] || [];
    return o.length === 1 && isExcEnd(nmap[o[0].target]);
  }
  return false;
}

// O01 — Exception isolation. Exception ends that branch off the mainline flow.
function checkExceptionIsolation(proc, cfg) {
  const nodes = proc.nodes || [], edges = proc.edges || [];
  const nmap = byId(nodes), incMap = inc(edges);
  const excEndIds = [];
  let interleaved = 0;
  for (const n of nodes) {
    const isExcEnd = isEnd(n) && (EXCEPTION_MARKERS.has(n.marker) || EXCEPTION_NAME_RE.test(n.name || ''));
    if (!isExcEnd) continue;
    // predecessor is a splitting gateway or task that also continues the main flow
    for (const e of (incMap[n.id] || [])) {
      const pred = nmap[e.source];
      if (pred && (isGateway(pred.type) || isTask(pred))) { excEndIds.push(n.id); interleaved++; break; }
    }
  }
  if (interleaved >= (cfg.minExceptionEnds ?? DEFAULTS.minExceptionEnds)) {
    return {
      id: 'O01',
      transform: 'isolateException',
      targets: excEndIds,
      message: `${interleaved} Ausnahme-Enden zweigen aus dem Hauptfluss ab — Exception-Isolation prüfen (Boundary-Event/Event-Subprocess statt inline) [Reijers 2005: exception]. Trade-off: Klarheit ↑.`,
      tradeoff: { quality: '+' },
      ref: { reijers: 'exception' },
      judgment: true,
    };
  }
  return null;
}

// O02 — Knock-out ordering. Chain of XOR checks that can each terminate the case.
function checkKnockoutOrdering(proc, cfg) {
  const nodes = proc.nodes || [], edges = proc.edges || [];
  const nmap = byId(nodes), outMap = out(edges);
  const chainIds = [];
  let chain = 0;
  for (const n of nodes) {
    if (n.type !== 'exclusiveGateway') continue;
    const outs = outMap[n.id] || [];
    if (outs.length < 2) continue;
    const hasKnockout = outs.some(e => isRejectBranch(e.target, outMap, nmap));
    const continues = outs.some(e => !isRejectBranch(e.target, outMap, nmap));
    if (hasKnockout && continues) { chainIds.push(n.id); chain++; }
  }
  if (chain >= (cfg.minKnockoutChain ?? DEFAULTS.minKnockoutChain)) {
    return {
      id: 'O02',
      transform: 'reorderKnockouts',
      targets: chainIds,
      message: `Knock-out-Kette erkannt (${chain} Prüfungen, die den Fall je beenden können) — Reihenfolge nach steigendem Aufwand / sinkender Durchlaufwahrscheinlichkeit prüfen [Reijers 2005: knock-out]. Trade-off: Kosten ↓.`,
      tradeoff: { cost: '−' },
      ref: { reijers: 'knock-out' },
      judgment: true,
    };
  }
  return null;
}

// O03 — Handoffs (Lean waste). Count lane-crossing sequence flows.
function checkHandoffs(proc, cfg, handoffCount, handoffTargetIds) {
  if (handoffCount > (cfg.maxHandoffs ?? DEFAULTS.maxHandoffs)) {
    return {
      id: 'O03',
      transform: 'relane',
      targets: handoffTargetIds,
      message: `${handoffCount} Rollen-Übergaben (Lane-wechselnde Flüsse) — Übergaben reduzieren / Aufgaben je Rolle bündeln [BABOK §10.34 Lean; Reijers 2005: task composition]. Trade-off: Zeit ↓, Fehler ↓.`,
      tradeoff: { time: '−' },
      ref: { reijers: 'task-composition', babok: '§10.34' },
      judgment: true,
    };
  }
  return null;
}

// O04 — Parallelism candidate. Maximal linear same-lane task run (no gateway/branch).
function checkParallelismCandidate(proc, cfg) {
  const nodes = proc.nodes || [], edges = proc.edges || [];
  const nmap = byId(nodes), outMap = out(edges), incMap = inc(edges);
  const min = cfg.minParallelChain ?? DEFAULTS.minParallelChain;
  const linear = (id) => isTask(nmap[id]) && (outMap[id] || []).length === 1 && (incMap[id] || []).length === 1;
  const seen = new Set();
  let best = null;
  for (const n of nodes) {
    if (!isTask(n) || seen.has(n.id)) continue;
    // walk forward while linear + same lane + task.
    // Bahn formatuebergreifend aufloesen: bei einem Format-B-Modell (Zuordnung nur
    // ueber Lane.nodeIds) waere rohes n.lane bei JEDEM Knoten undefined, und
    // `undefined === undefined` machte die "gleiche Bahn"-Bedingung zum No-Op —
    // eine bahnuebergreifende Kette wuerde dann faelschlich als
    // Parallelisierungs-Kandidat gemeldet (False Positive).
    const run = [n.id];
    const nLane = resolveLaneId(proc, n);
    let cur = n.id;
    while (true) {
      const nx = (outMap[cur] || [])[0]?.target;
      if (nx && linear(nx) && resolveLaneId(proc, nmap[nx]) === nLane && !run.includes(nx)) { run.push(nx); cur = nx; }
      else break;
    }
    if (run.length >= min) { run.forEach(id => seen.add(id)); if (!best || run.length > best.length) best = run; }
  }
  if (best) {
    const names = best.map(id => `"${nmap[id].name || id}"`).join(' → ');
    return {
      id: 'O04',
      transform: 'parallelize',
      targets: best,
      message: `Sequenz gleicher Rolle ohne Verzweigung (${names}) — Parallelisierung prüfen; keine Datenabhängigkeit im Modell erkennbar (Kandidat, prüfen) [Reijers 2005: parallelism]. Trade-off: Zeit ↓.`,
      tradeoff: { time: '−' },
      ref: { reijers: 'parallelism' },
      judgment: true,
    };
  }
  return null;
}

// Lean metrics (BABOK §10.34): handoffs, rework loops, wait states, gateway complexity.
function computeMetrics(proc) {
  const nodes = proc.nodes || [], edges = proc.edges || [];
  const nmap = byId(nodes);
  let handoffCount = 0;
  const handoffTargetIds = [];
  for (const e of edges) {
    const s = nmap[e.source], t = nmap[e.target];
    // Bahn formatuebergreifend aufloesen (node.lane ODER Lane.nodeIds) — sonst
    // meldet diese Kennzahl bei Format-B-Modellen 0, waehrend der relane-Eingriff
    // die echte Zahl liefert. Eine Kennzahl, eine Antwort.
    const sLane = resolveLaneId(proc, s), tLane = resolveLaneId(proc, t);
    if (sLane && tLane && sLane !== tLane) { handoffCount++; handoffTargetIds.push(t.id); }
  }
  const waitStates = nodes.filter(n =>
    (n.type === 'intermediateCatchEvent' || n.type === 'boundaryEvent') && WAIT_MARKERS.has(n.marker)
  ).length;
  const reworkLoops = countBackEdges(nodes, edges);
  const gatewayComplexity = nodes.filter(n => isGateway(n.type)).reduce((s, n) => {
    const fanout = edges.filter(e => e.source === n.id).length;
    return s + Math.max(0, fanout - 1);
  }, 0);
  return { handoffCount, handoffTargetIds, waitStates, reworkLoops, gatewayComplexity };
}

// Rework loops ≈ back edges (DFS): edges pointing to an ancestor on the current stack.
function countBackEdges(nodes, edges) {
  const outMap = out(edges);
  const starts = nodes.filter(n => n.type === 'startEvent').map(n => n.id);
  const roots = starts.length ? starts : (nodes[0] ? [nodes[0].id] : []);
  const state = {}; // 0=unvisited,1=on-stack,2=done
  let back = 0;
  const dfs = (id) => {
    state[id] = 1;
    for (const e of (outMap[id] || [])) {
      const t = e.target;
      if (state[t] === 1) back++;
      else if (!state[t]) dfs(t);
    }
    state[id] = 2;
  };
  for (const r of roots) if (!state[r]) dfs(r);
  return back;
}

/**
 * Run the optimization analysis over a Logic-Core (all processes / pools).
 * @param {object} lc - Logic-Core JSON
 * @param {object} [cfg] - thresholds (from CFG.optimization); falls back to DEFAULTS
 * @returns {{ advisories: object[], metrics: object }}
 */
export function runOptimizationAnalysis(lc, cfg = {}) {
  const processes = lc.pools ? lc.pools : [lc];
  const advisories = [];
  const agg = { handoffCount: 0, waitStates: 0, reworkLoops: 0, gatewayComplexity: 0 };

  for (const proc of processes) {
    const m = computeMetrics(proc);
    agg.handoffCount += m.handoffCount;
    agg.waitStates += m.waitStates;
    agg.reworkLoops += m.reworkLoops;
    agg.gatewayComplexity += m.gatewayComplexity;

    const findings = [
      checkExceptionIsolation(proc, cfg),
      checkKnockoutOrdering(proc, cfg),
      checkHandoffs(proc, cfg, m.handoffCount, m.handoffTargetIds),
      checkParallelismCandidate(proc, cfg),
    ].filter(Boolean);
    for (const f of findings) advisories.push(lc.pools ? { ...f, pool: proc.name || proc.id } : f);
  }

  return { advisories, metrics: agg };
}

/**
 * Redesign-Kern — Gemeinsames für alle Eingriffe.
 *
 * Rein deterministisch, ohne Sprachmodell. Dieses Modul darf
 * agents/llm-provider.js weder direkt noch transitiv importieren.
 */

import { runRules } from './rules.js';

/** Tiefer Klon; die Eingabe eines Aufrufers wird nie mutiert. */
export function cloneLc(lc) {
  return JSON.parse(JSON.stringify(lc));
}

/**
 * Festes Rollback-Gate — bewusst PROFILUNABHÄNGIG.
 * Das Default-Profil hat die Workflow-Netz-Schicht aus, das strict-Profil macht
 * Stil-Regeln zu Fehlern. Beides würde das Rollback-Verhalten vom Nutzerprofil
 * abhängig machen und die Determinismus-Zusage brechen.
 */
export const SOUNDNESS_GATE = {
  profile: 'redesign-gate',
  layers: {
    soundness:    { enabled: true },
    workflow_net: { enabled: true },
    style:        { enabled: false },
    pragmatics:   { enabled: false },
    optimization: { enabled: false },
  },
};

/** Prüft ein Modell gegen das feste Gate. Stil-Verstöße blockieren nie. */
export function checkGate(lc) {
  const r = runRules(lc, SOUNDNESS_GATE);
  return { ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings };
}

/**
 * Sammelt rekursiv alle Knoten-IDs eines Knoten-Arrays, inklusive der Kind-Knoten
 * und -Kanten expandierter Sub-Prozesse (node.nodes / node.edges). Ein Sub-Prozess
 * kann wiederum einen Sub-Prozess enthalten — daher Rekursion, nicht nur eine Ebene.
 */
function collectNodeIdsRecursive(nodes, ids) {
  for (const n of (nodes || [])) {
    ids.add(n.id);
    if (n.type === 'subProcess' && (n.nodes || n.edges)) {
      collectNodeIdsRecursive(n.nodes, ids);
      for (const e of (n.edges || [])) ids.add(e.id);
    }
  }
}

/** Alle vergebenen Pool-, Knoten-, Kanten- und Lane-IDs (inkl. verschachtelter Sub-Prozesse). */
export function collectIds(lc) {
  const ids = new Set();
  const procs = lc.pools ? lc.pools : [lc];
  for (const p of procs) {
    if (p.id) ids.add(p.id);
    collectNodeIdsRecursive(p.nodes, ids);
    for (const e of (p.edges || [])) ids.add(e.id);
    for (const l of (p.lanes || [])) ids.add(l.id);
  }
  for (const cp of (lc.collapsedPools || [])) {
    if (cp.id) ids.add(cp.id);
  }
  for (const mf of (lc.messageFlows || [])) ids.add(mf.id);
  return ids;
}

/**
 * Deterministische, kollisionsfreie ID: <prefix> bzw. <prefix>_2, _3, …
 * Kein Zufall, kein Zeitstempel — sonst faellt die Determinismus-Zusage.
 */
export function nextId(lc, prefix) {
  const ids = collectIds(lc);
  if (!ids.has(prefix)) return prefix;
  let i = 2;
  while (ids.has(`${prefix}_${i}`)) i++;
  return `${prefix}_${i}`;
}

/**
 * Schutzliste. Trifft über Kennung UND Anzeigenamen — eine Lane per Name zu
 * schuetzen darf nicht wirkungslos verpuffen, nur weil intern eine ID steht.
 */
export function isProtected(node, policy = {}, lc = null) {
  const nodes = policy.protectNodes || [];
  const lanes = policy.protectLanes || [];
  if (nodes.includes(node.id) || (node.name && nodes.includes(node.name))) return true;
  if (node.lane && lanes.includes(node.lane)) return true;
  if (node.lane && lc) {
    const procs = lc.pools ? lc.pools : [lc];
    for (const p of procs) {
      const lane = (p.lanes || []).find(l => l.id === node.lane);
      if (lane && lane.name && lanes.includes(lane.name)) return true;
    }
  }
  return false;
}

/** Einheitliche Verweigerungsform für preview(). */
export function refusal(reason) {
  return { feasible: 'none', scope: [], reason };
}

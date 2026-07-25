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
 * abhängig machen und die Determinismus-Zusage brechen — SOUNDNESS_GATE ist
 * daher ein fest verdrahtetes Objekt, das NIE aus dem Profil des Aufrufers
 * abgeleitet wird, auch nicht teilweise.
 *
 * style ist ABSICHTLICH aktiviert (enabled: true), obwohl das Ergebnis nie
 * daran scheitern kann: die Stil-Schicht hat ausschliesslich defaultSeverity
 * WARNING (siehe rules.js STYLE_RULES; M05/M06 sind ohnehin severity=OFF),
 * checkGate().ok prueft ausschliesslich r.errors — Warnungen bleiben also
 * folgenlos fuers Rollback. Ohne diese Aktivierung wuerden Stil-Verstoesse,
 * die ein Eingriff neu einfuehrt (z. B. applyMergeTasks vergibt einen vom
 * Aufrufer gewaehlten Namen, der nicht der Objekt+Verb-Konvention folgt),
 * NIRGENDS auftauchen: checkGate() lieferte immer warnings:[], SKILL.md
 * verspricht aber ausdruecklich, dass Stil-Warnungen "come back in the
 * result's `warnings` array" — das war schlicht falsch, solange die Schicht
 * hier abgeschaltet war.
 */
export const SOUNDNESS_GATE = {
  profile: 'redesign-gate',
  layers: {
    soundness:    { enabled: true },
    workflow_net: { enabled: true },
    style:        { enabled: true },
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
 * Warnungen, die zwischen `before` und `after` NEU hinzugekommen sind — nicht
 * einfach alle Warnungen von `after`. checkGate(after) allein liefert nur
 * eine Momentaufnahme NACH dem Eingriff: ein Stil-Verstoss, der schon VOR dem
 * Eingriff im Modell stand (und mit dem Eingriff nichts zu tun hat), würde
 * sonst faelschlich als "neue" Warnung ausgewiesen. redesign-cli.js beschriftet
 * die Ausgabe ausdruecklich als "⚠ Neue Warnungen:" — dieses Versprechen war
 * bisher nicht eingeloest, weil apply() bislang schlicht gate.warnings (die
 * volle Nach-Zustand-Liste) durchreichte.
 */
export function warningsDelta(before, after) {
  const beforeSet = new Set(checkGate(before).warnings);
  return checkGate(after).warnings.filter(w => !beforeSet.has(w));
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
 * Effektive aktuelle Bahn eines Knotens, formatuebergreifend: das Schema erlaubt
 * die Zuordnung entweder über node.lane (Format A) ODER über Lane.nodeIds
 * (Format B) — ein Modell kann eines von beiden nutzen (oder, inkonsistent,
 * gar keines). Wer hier nur node.lane liest, uebersieht Format-B-only-Modelle.
 * `container` darf entweder das komplette Logic-Core (mit optionalem
 * `container.pools`, dann werden ALLE Pools/Prozesse durchsucht) oder bereits
 * ein einzelner Prozess/Pool sein (dann wird nur dessen `lanes` durchsucht) —
 * so laesst sich dieselbe Funktion sowohl fuer Multi-Pool-Aufloesung
 * (isProtected) als auch fuer Single-Pool-Aufrufer (redesign.js, die bereits
 * auf einem konkreten proc arbeiten) verwenden.
 *
 * Einzige Stelle im Code, die beide Formate aufloest — siehe redesign.js,
 * das diese Funktion re-exportiert statt die Logik zu duplizieren.
 */
export function resolveLaneId(container, node) {
  if (node.lane) return node.lane;
  if (!container) return undefined;
  const procs = container.pools ? container.pools : [container];
  for (const p of procs) {
    const lane = (p.lanes || []).find(l => Array.isArray(l.nodeIds) && l.nodeIds.includes(node.id));
    if (lane) return lane.id;
  }
  return undefined;
}

/**
 * Schutzliste. Trifft über Kennung UND Anzeigenamen — eine Lane per Name zu
 * schuetzen darf nicht wirkungslos verpuffen, nur weil intern eine ID steht.
 * Die Bahn des Knotens wird ueber resolveLaneId() formatuebergreifend
 * aufgeloest (node.lane ODER Lane.nodeIds) — sonst schuetzt protectLanes in
 * einem Format-B-only-Modell gar nichts, obwohl der Aufrufer es zugesagt hat.
 */
export function isProtected(node, policy = {}, lc = null) {
  const nodes = policy.protectNodes || [];
  const lanes = policy.protectLanes || [];
  if (nodes.includes(node.id) || (node.name && nodes.includes(node.name))) return true;
  const laneId = resolveLaneId(lc, node);
  if (laneId && lanes.includes(laneId)) return true;
  if (laneId && lc) {
    const procs = lc.pools ? lc.pools : [lc];
    for (const p of procs) {
      const lane = (p.lanes || []).find(l => l.id === laneId);
      if (lane && lane.name && lanes.includes(lane.name)) return true;
    }
  }
  return false;
}

/** Einheitliche Verweigerungsform für preview(). */
export function refusal(reason) {
  return { feasible: 'none', scope: [], reason };
}

/**
 * Redesign-Werkzeugkasten — benannte Prozess-Eingriffe.
 *
 * Jeder Eingriff hat zwei Funktionen:
 *   preview(lc, params) → { feasible: 'full'|'partial'|'none', scope, reason }
 *   apply(lc, params)   → { lc, change, warnings }
 *
 * Rein deterministisch, ohne Sprachmodell. Der Werkzeugkasten entscheidet nie,
 * OB ein Eingriff gemacht wird — das tut der Aufrufer.
 */

import { cloneLc, checkGate, nextId, isProtected, refusal } from './redesign-core.js';

const procOf = (lc) => (lc.pools ? lc.pools[0] : lc);

function findNodes(proc, ids) {
  const map = {};
  for (const n of (proc.nodes || [])) map[n.id] = n;
  return ids.map(id => map[id]);
}

/**
 * Ist ids eine zusammenhängende, lineare Kette (jeweils genau eine Kante)?
 * Prüft nicht nur die Kettenkanten selbst, sondern auch, dass kein Kettenmitglied
 * zusätzliche Kanten von/zu Knoten AUSSERHALB der Kette hat: JEDES Mitglied,
 * einschliesslich des ersten, muss genau eine eingehende Kante haben (sonst
 * Fan-in von aussen — beim ersten Mitglied re-targeted applyParallelize sonst
 * nur die zuerst gefundene Kante auf den neuen Split und laesst jede weitere
 * eingehende Kante unveraendert am alten Ziel haengen, wodurch sie den Split
 * umgeht). Das letzte Mitglied darf genau eine ausgehende Kante haben (sonst
 * Fan-out). Ohne diese Prüfung würde applyParallelize eine externe Kante in
 * einen Zwischenschritt kappen bzw. umhängen und ein totes Modell-Fragment
 * erzeugen.
 *
 * Ein erstes Mitglied mit NULL eingehenden Kanten (z. B. weil es selbst ein
 * startEvent ist) wird ebenfalls verweigert, nicht stillschweigend akzeptiert:
 * der neue Split-Gateway braucht einen definierten Vorgänger, an den die
 * bisherige Kante umgehängt wird. Ohne eine solche Kante entstünde ein Split
 * ohne eingehenden Fluss — strukturell ungültig (Flow-Node ohne Vorgänger).
 * Der praxisrelevante Fall "Kette am Prozessanfang" (erstes Mitglied direkt
 * nach dem Start-Event) hat ohnehin genau eine eingehende Kante vom Start-Event
 * und ist von dieser Regel nicht betroffen.
 */
function isLinearChain(proc, ids) {
  const edges = proc.edges || [];
  for (let i = 0; i < ids.length - 1; i++) {
    const between = edges.filter(e => e.source === ids[i] && e.target === ids[i + 1]);
    if (between.length !== 1) return false;
    const outs = edges.filter(e => e.source === ids[i]);
    if (outs.length !== 1) return false;
  }
  for (let i = 0; i < ids.length; i++) {
    const ins = edges.filter(e => e.target === ids[i]);
    if (ins.length !== 1) return false;
  }
  const lastOuts = edges.filter(e => e.source === ids[ids.length - 1]);
  if (lastOuts.length !== 1) return false;
  return true;
}

/**
 * Datenabhängigkeit zwischen Schritten.
 * Rückgabe: 'dependent' (nachgewiesen abhängig) | 'proven' (nachweislich unabhängig)
 *         | 'unprovable' (ungerichtete Assoziationen vorhanden) | 'unmodelled' (nichts modelliert)
 */
function dependencyState(lc, ids) {
  const assocs = lc.associations || [];
  const touching = assocs.filter(a => ids.includes(a.source) || ids.includes(a.target));
  if (touching.length === 0) return 'unmodelled';
  if (touching.some(a => !a.directed)) return 'unprovable';
  // Schreibt ein Schritt ein Datenobjekt, das ein späterer Schritt liest?
  const writes = {}, reads = {};
  for (const a of touching) {
    if (ids.includes(a.source)) (writes[a.target] ??= []).push(a.source);
    if (ids.includes(a.target)) (reads[a.source] ??= []).push(a.target);
  }
  for (const obj of Object.keys(writes)) {
    if (reads[obj] && reads[obj].length) return 'dependent';
  }
  return 'proven';
}

export function previewParallelize(lc, { nodeIds = [], policy = {} } = {}) {
  const proc = procOf(lc);
  if (nodeIds.length < 2) return refusal('Mindestens zwei Schritte nötig.');
  const nodes = findNodes(proc, nodeIds);
  const missing = nodeIds.filter((id, i) => !nodes[i]);
  if (missing.length) return refusal(`Unbekannte Kennung: ${missing.join(', ')}`);
  const prot = nodes.filter(n => isProtected(n, policy, lc));
  if (prot.length) return refusal(`Geschütztes Element betroffen: ${prot.map(n => n.id).join(', ')}`);
  if (!isLinearChain(proc, nodeIds)) return refusal('Die Schritte bilden keine zusammenhängende Kette.');

  const dep = dependencyState(lc, nodeIds);
  if (dep === 'dependent') return refusal('Nachgewiesene Datenabhängigkeit zwischen den Schritten.');
  if (dep === 'unprovable') {
    return refusal('Ungerichtete Assoziationen tragen keine Lese-/Schreib-Semantik — Unabhängigkeit nicht beweisbar.');
  }
  return { feasible: 'full', scope: [...nodeIds], reason: '', provenIndependent: dep === 'proven' };
}

export function applyParallelize(lc, params = {}) {
  const pv = previewParallelize(lc, params);
  if (pv.feasible === 'none') throw new Error(pv.reason);

  const out = cloneLc(lc);
  const proc = procOf(out);
  const ids = pv.scope;
  const first = ids[0], last = ids[ids.length - 1];
  const edges = proc.edges || [];

  const inEdge = edges.find(e => e.target === first);
  const outEdge = edges.find(e => e.source === last);
  const lane = (proc.nodes.find(n => n.id === first) || {}).lane;

  const splitId = nextId(out, 'gw_par_split');
  proc.nodes.push({ id: splitId, type: 'parallelGateway', name: '', lane });
  const joinId = nextId(out, 'gw_par_join');
  proc.nodes.push({ id: joinId, type: 'parallelGateway', name: '', lane, has_join: true });

  // Alte Kettenkanten entfernen
  const removed = [];
  for (let i = 0; i < ids.length - 1; i++) {
    const idx = edges.findIndex(e => e.source === ids[i] && e.target === ids[i + 1]);
    if (idx >= 0) removed.push(edges.splice(idx, 1)[0].id);
  }
  if (inEdge) inEdge.target = splitId;
  if (outEdge) outEdge.source = joinId;

  // "added" muss VOLLSTAENDIG sein: Quellmodell und Ergebnis duerfen sich
  // ausschliesslich in den hier verzeichneten Elementen unterscheiden. Neben den
  // zwei Gateways gehoeren daher auch die neu geschaffenen Verbindungskanten hinein
  // (symmetrisch zu "removed", das die entfernten Kettenkanten-IDs auflistet).
  const added = [splitId, joinId];
  for (const id of ids) {
    const eIn = nextId(out, `flow_${splitId}_${id}`);
    edges.push({ id: eIn, source: splitId, target: id });
    added.push(eIn);
    const eOut = nextId(out, `flow_${id}_${joinId}`);
    edges.push({ id: eOut, source: id, target: joinId });
    added.push(eOut);
  }

  const gate = checkGate(out);
  if (!gate.ok) throw new Error(`Rollback: Ergebnis waere nicht sound — ${gate.errors.join('; ')}`);

  return {
    lc: out,
    change: { transform: 'parallelize', targets: ids, added, removed,
              note: `${ids.length} Schritte parallel gefuehrt` },
    warnings: gate.warnings,
  };
}

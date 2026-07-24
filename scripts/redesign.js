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

  // "modified" schliesst die Lücke zwischen "added"/"removed": inEdge/outEdge
  // behalten ihre ID, aber source/target wurden umgehängt (auf splitId/joinId).
  // Ohne diesen Eintrag bliebe die Vorgabe "Quelle und Ergebnis unterscheiden
  // sich ausschliesslich in den verzeichneten Elementen" fuer diese zwei Kanten
  // verletzt — sie tauchen sonst in keinem der drei Arrays auf.
  const modified = [];
  if (inEdge) modified.push(inEdge.id);
  if (outEdge) modified.push(outEdge.id);

  const gate = checkGate(out);
  if (!gate.ok) throw new Error(`Rollback: Ergebnis waere nicht sound — ${gate.errors.join('; ')}`);

  return {
    lc: out,
    change: { transform: 'parallelize', targets: ids, added, removed, modified,
              note: `${ids.length} Schritte parallel gefuehrt` },
    warnings: gate.warnings,
  };
}

const TASK_TYPES = new Set(['task', 'userTask', 'serviceTask', 'scriptTask', 'manualTask',
                            'businessRuleTask', 'sendTask', 'receiveTask']);

export function previewMergeTasks(lc, { nodeIds = [], name = '', policy = {} } = {}) {
  const proc = procOf(lc);
  if (nodeIds.length < 2) return refusal('Mindestens zwei Schritte nötig.');
  if (!name || !name.trim()) {
    return refusal('Name des gebündelten Schritts ist Pflicht — eine Benennung wäre ein fachliches Urteil.');
  }
  const nodes = findNodes(proc, nodeIds);
  if (nodes.some(n => !n)) return refusal('Unbekannte Kennung.');
  if (nodes.some(n => !TASK_TYPES.has(n.type))) return refusal('Nur Aufgaben lassen sich bündeln.');
  const prot = nodes.filter(n => isProtected(n, policy, lc));
  if (prot.length) return refusal(`Geschütztes Element betroffen: ${prot.map(n => n.id).join(', ')}`);
  const types = new Set(nodes.map(n => n.type));
  if (types.size > 1) return refusal(`Unterschiedliche Typen (${[...types].join(', ')}) — welcher überlebt, ist ein Urteil.`);
  const lanes = new Set(nodes.map(n => n.lane));
  if (lanes.size > 1) return refusal('Schritte liegen in verschiedenen Bahnen.');
  if (nodes.some(n => n.loopType || n.multiInstance)) {
    return refusal('Schleifen- oder Mehrfach-Marker vorhanden — Bündeln würde die Semantik verändern.');
  }
  const boundaries = (proc.nodes || []).filter(n => n.type === 'boundaryEvent' && nodeIds.includes(n.attachedTo));
  if (boundaries.length) {
    return refusal(`Angehängtes Boundary-Event (${boundaries.map(b => b.id).join(', ')}) würde heimatlos.`);
  }
  if (!isLinearChain(proc, nodeIds)) return refusal('Die Schritte bilden keine zusammenhängende Kette.');

  // Nur die zu ENTFERNENDEN Knoten zaehlen (nodeIds[1..], siehe applyMergeTasks:
  // ids[0] ueberlebt und behaelt seine Assoziationen). Verweist eine Assoziation
  // auf einen Knoten, der geloescht wuerde, faende S03/S10-artige Referenz-
  // Integritaetspruefung fuer Assoziationen nicht statt (kein Regel-Pendant in
  // rules.js) — das Rollback-Gate wuerde also NICHT greifen, und bpmn-xml.js
  // wuerde eine <bpmn:Association> mit einem sourceRef/targetRef auf eine nicht
  // mehr existierende ID emittieren: strukturell ungueltiges BPMN, das Importer
  // zum Absturz bringen kann. Die grafische Kante wird dabei still weggelassen,
  // der Defekt ist im Diagramm unsichtbar.
  const drop = nodeIds.slice(1);
  const assocs = lc.associations || [];
  const orphaned = assocs.filter(a => drop.includes(a.source) || drop.includes(a.target));
  if (orphaned.length) {
    return refusal(`Assoziation(en) (${orphaned.map(a => a.id).join(', ')}) verweisen auf Schritte, ` +
                   `die entfernt würden — Bündeln würde das Modell strukturell ungültig machen.`);
  }
  return { feasible: 'full', scope: [...nodeIds], reason: '' };
}

export function applyMergeTasks(lc, params = {}) {
  const pv = previewMergeTasks(lc, params);
  if (pv.feasible === 'none') throw new Error(pv.reason);

  const out = cloneLc(lc);
  const proc = procOf(out);
  const ids = pv.scope;
  const keep = ids[0], drop = ids.slice(1);
  const edges = proc.edges || [];

  proc.nodes.find(n => n.id === keep).name = params.name;

  const removed = [];
  for (let i = 0; i < ids.length - 1; i++) {
    const idx = edges.findIndex(e => e.source === ids[i] && e.target === ids[i + 1]);
    if (idx >= 0) removed.push(edges.splice(idx, 1)[0].id);
  }
  const lastOut = edges.find(e => e.source === ids[ids.length - 1]);
  if (lastOut) lastOut.source = keep;
  proc.nodes = proc.nodes.filter(n => !drop.includes(n.id));
  removed.push(...drop);

  const gate = checkGate(out);
  if (!gate.ok) throw new Error(`Rollback: Ergebnis waere nicht sound — ${gate.errors.join('; ')}`);

  // "modified" schliesst die Lücke zwischen "added"/"removed": der ueberlebende
  // Knoten (keep) behaelt seine ID, aber sein Name wurde geaendert — er taucht
  // sonst in keinem der beiden anderen Arrays auf, obwohl er sich veraendert hat.
  return {
    lc: out,
    change: { transform: 'mergeTasks', targets: ids, added: [], removed, modified: [keep],
              note: `${ids.length} Schritte gebündelt zu "${params.name}"` },
    warnings: gate.warnings,
  };
}

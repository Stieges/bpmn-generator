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

import { cloneLc, checkGate, nextId, isProtected, refusal, resolveLaneId } from './redesign-core.js';

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
  // Zusätzlich: die abgehende Kante des letzten entfernten Knotens wird umgehängt
  // (source wechselt vom letzten Kettenmitglied zu keep) — auch diese Kante behält
  // ihre ID, ändert aber ihren Inhalt. Sie muss ebenfalls in modified verzeichnet sein.
  const modified = [keep];
  if (lastOut) modified.push(lastOut.id);

  return {
    lc: out,
    change: { transform: 'mergeTasks', targets: ids, added: [], removed, modified,
              note: `${ids.length} Schritte gebündelt zu "${params.name}"` },
    warnings: gate.warnings,
  };
}

/**
 * Effektive aktuelle Bahn eines Knotens, formatuebergreifend (node.lane ODER
 * Lane.nodeIds). Duennes Alias auf resolveLaneId() aus redesign-core.js —
 * das ist die einzige Stelle, die beide Formate aufloest (auch isProtected()
 * nutzt sie), damit hier keine zweite, potenziell abweichende Implementierung
 * entsteht. Wer nur node.lane liest, uebersieht Format-B-only-Modelle: die
 * "liegt bereits in dieser Bahn"-Pruefung in previewRelane wuerde dann einen
 * No-Op faelschlich als Verschiebung akzeptieren.
 */
const currentLaneOf = resolveLaneId;

/**
 * Zaehlt Rollenwechsel: eine Kante gilt als Uebergabe, wenn Quelle und Ziel
 * unterschiedlichen Bahnen zugeordnet sind. Nutzt currentLaneOf (nicht nur
 * node.lane), sonst waeren Uebergaben in einem Format-B-only-Modell unsichtbar
 * und handoffsBefore/handoffsAfter würden faelschlich immer 0 melden.
 */
function countHandoffs(proc) {
  const map = {};
  for (const n of (proc.nodes || [])) map[n.id] = n;
  let c = 0;
  for (const e of (proc.edges || [])) {
    const s = map[e.source], t = map[e.target];
    if (!s || !t) continue;
    const sLane = currentLaneOf(proc, s), tLane = currentLaneOf(proc, t);
    if (sLane && tLane && sLane !== tLane) c++;
  }
  return c;
}

export function previewRelane(lc, { nodeId, lane, policy = {} } = {}) {
  const proc = procOf(lc);
  const node = (proc.nodes || []).find(n => n.id === nodeId);
  if (!node) return refusal(`Unbekannte Kennung: ${nodeId}`);
  if (isProtected(node, policy, lc)) return refusal(`Geschütztes Element betroffen: ${nodeId}`);
  const target = (proc.lanes || []).find(l => l.id === lane || l.name === lane);
  if (!target) return refusal(`Unbekannte Zielbahn: ${lane}`);
  // isProtected deckt nur die AKTUELLE Bahn des Knotens ab (schuetzt, was schon
  // dort liegt). Eine geschuetzte ZIELbahn braucht eine eigene Pruefung, sonst
  // liesse sich ein Schritt anstandslos IN eine geschuetzte Bahn hineinschieben
  // — die Bahn waere danach nicht mehr das, was policy.protectLanes zusicherte.
  const protectLanes = policy.protectLanes || [];
  if (protectLanes.includes(target.id) || (target.name && protectLanes.includes(target.name))) {
    return refusal(`Geschütztes Element betroffen: Zielbahn ${lane}`);
  }
  if (currentLaneOf(proc, node) === target.id) return refusal('Der Schritt liegt bereits in dieser Bahn.');
  return { feasible: 'full', scope: [nodeId], reason: '' };
}

export function applyRelane(lc, params = {}) {
  const pv = previewRelane(lc, params);
  if (pv.feasible === 'none') throw new Error(pv.reason);

  const out = cloneLc(lc);
  const proc = procOf(out);
  const before = countHandoffs(proc);
  const node = proc.nodes.find(n => n.id === params.nodeId);
  const target = proc.lanes.find(l => l.id === params.lane || l.name === params.lane);

  node.lane = target.id;

  // Zweites Zuordnungsformat mitpflegen (Lane.nodeIds), sonst entsteht ein
  // widerspruechliches Modell: M09 prueft genau diese Konsistenz, ist aber eine
  // Stil-Regel (Layer "style") und liegt damit in der Schicht, die das feste
  // Rollback-Gate (SOUNDNESS_GATE) bewusst abschaltet — eine Inkonsistenz
  // zwischen node.lane und Lane.nodeIds wuerde also NICHT durch checkGate
  // abgefangen, sondern still ins Ergebnis durchsickern und dort z. B. bei
  // einem nachgelagerten Re-Import (import.js) zu widerspruechlichen
  // Lane-Zuordnungen fuehren. Aus JEDER Bahn entfernen (nicht nur der bisher
  // via node.lane bekannten), damit auch ein bereits inkonsistentes
  // Ausgangsmodell (Knoten in mehreren Lane.nodeIds gleichzeitig) geheilt statt
  // fortgeschrieben wird.
  const modifiedLaneIds = [];
  for (const l of proc.lanes) {
    if (!Array.isArray(l.nodeIds)) continue;
    const hadBefore = l.nodeIds.includes(node.id);
    l.nodeIds = l.nodeIds.filter(id => id !== node.id);
    if (l.id === target.id) l.nodeIds.push(node.id);
    const hasAfter = l.nodeIds.includes(node.id);
    if (hadBefore !== hasAfter) modifiedLaneIds.push(l.id);
  }

  const gate = checkGate(out);
  if (!gate.ok) throw new Error(`Rollback: Ergebnis waere nicht sound — ${gate.errors.join('; ')}`);
  const after = countHandoffs(proc);

  // "modified": der Knoten behaelt seine ID, aber sein Inhalt (lane) hat sich
  // geaendert — er taucht in keinem der beiden anderen Arrays auf. Dieselbe
  // Lücke gilt fuer jede Lane, deren nodeIds-Array sich tatsaechlich veraendert
  // hat (modifiedLaneIds): auch diese Lane-Objekte behalten ihre ID, aber ihr
  // Inhalt unterscheidet sich zwischen Quelle und Ergebnis.
  const modified = [node.id, ...modifiedLaneIds];

  return {
    lc: out,
    change: { transform: 'relane', targets: [params.nodeId], added: [], removed: [], modified,
              handoffsBefore: before, handoffsAfter: after,
              note: `Übergaben ${before} → ${after}` },
    warnings: gate.warnings,
  };
}

/**
 * Ausnahme-Ende-Erkennung fuer Knock-out-Ketten: ein Ende gilt als
 * "Ausnahme" (Ablehnung/Abbruch/Fehler), wenn es einen entsprechenden Marker
 * traegt ODER sein Name danach klingt. Dieselbe Erkennung entscheidet, welche
 * ausgehende Kante eines Gateways die "Weiter"-Kante ist — siehe
 * continuationEdges().
 */
const EXCEPTION_END_MARKERS = new Set(['error', 'terminate', 'escalation', 'cancel']);
const EXCEPTION_END_NAME_RE = /fehler|error|abbruch|abgebroch|eskal|storn|ablehn|abgelehnt|reject|cancel|verwerf|verworf/i;

function buildNodeMap(proc) {
  const map = {};
  for (const n of (proc.nodes || [])) map[n.id] = n;
  return map;
}

function isExceptionEnd(nodeById, id) {
  const n = nodeById[id];
  return !!n && n.type === 'endEvent' &&
    (EXCEPTION_END_MARKERS.has(n.marker) || EXCEPTION_END_NAME_RE.test(n.name || ''));
}

/**
 * Alle ausgehenden Kanten eines Gateways, die NICHT zu einem Ausnahme-Ende
 * fuehren — die Kandidaten fuer die "Weiter"-Kante. Liefert bewusst ein Array
 * (nicht eine einzelne Kante per .find()), damit der Aufrufer selbst
 * unterscheiden kann: genau ein Treffer (eindeutige Weiter-Kante), keiner
 * (alle Zweige sind Ausnahmen — kein Fortsetzungspfad) oder mehrere
 * (mehrdeutig, welcher Zweig weiterfuehrt). Ein direkter .find()-Zugriff wie
 * im urspruenglichen Entwurf liefert bei "keiner" `undefined` und stuerzt beim
 * naechsten .target-Zugriff mit TypeError ab, statt sauber zu verweigern —
 * siehe knockoutChainIssue(), das genau diese drei Faelle VOR dem Zugriff
 * unterscheidet.
 */
function continuationEdges(proc, nodeById, gwId) {
  return (proc.edges || []).filter(e => e.source === gwId && !isExceptionEnd(nodeById, e.target));
}

/**
 * Strukturelle Vorbedingung: bilden `ids` (in genau dieser Reihenfolge) eine
 * gueltige, umkehrbare Knock-out-Kette? Liefert null, wenn ja, sonst den
 * Verweigerungsgrund. Geprüft wird:
 *   - jedes Gateway hat genau EINE Weiter-Kante (nicht keine, nicht mehrdeutige)
 *   - aufeinanderfolgende Gateways sind ueber genau diese Kante verbunden
 *     (ids[i] -weiter-> ids[i+1])
 *   - die Weiter-Kante des LETZTEN Mitglieds fuehrt aus der Kette HINAUS
 *     (kein Ruecksprung in die Kette)
 *   - das ERSTE Mitglied hat GENAU EINEN Einstieg von ausserhalb der Kette
 *
 * Ohne diese Pruefung koennte applyReorderKnockouts entweder abstuerzen
 * (TypeError auf undefined.target, wenn ein Gateway keine oder mehrere
 * Weiter-Kanten hat — siehe die "kein Fortsetzungspfad"-Testfaelle) oder ein
 * strukturell irrefuehrendes Modell erzeugen: ein Fan-in am Kettenanfang
 * wuerde applyParallelize's urspruenglichen .find()-Fehler wiederholen (siehe
 * dessen "Fan-in am ERSTEN Kettenmitglied"-Regressionstest, Commit bd25f60),
 * und eine in Wahrheit nicht zusammenhaengende "Kette" wuerde still falsch
 * verdrahtet. Das feste Rollback-Gate faengt das NICHT zuverlaessig ab: ein
 * dadurch entstehender toter Zweig ist WF01 (dead transition), Default-
 * Severity WARNING — checkGate().ok bleibt bei reinen Warnungen true, das
 * Rollback greift also nicht. Diese Pruefung muss daher VOR jedem Zugriff auf
 * das Ergebnis von continuationEdges()[0] laufen, nicht erst danach.
 */
function knockoutChainIssue(proc, ids) {
  const nodeById = buildNodeMap(proc);
  for (const id of ids) {
    const cont = continuationEdges(proc, nodeById, id);
    if (cont.length === 0) {
      return `Prüfung "${id}" hat keinen Fortsetzungspfad — alle Zweige enden in einem Ausnahme-Ende.`;
    }
    if (cont.length > 1) {
      return `Prüfung "${id}" hat mehr als einen möglichen Fortsetzungspfad — nicht eindeutig, welcher Zweig weiterführt.`;
    }
  }
  for (let i = 0; i < ids.length - 1; i++) {
    const cont = continuationEdges(proc, nodeById, ids[i])[0];
    if (cont.target !== ids[i + 1]) {
      return `Die Prüfungen bilden in der übergebenen Reihenfolge keine zusammenhängende Kette ` +
             `("${ids[i]}" führt nicht weiter zu "${ids[i + 1]}").`;
    }
  }
  const lastCont = continuationEdges(proc, nodeById, ids[ids.length - 1])[0];
  if (ids.includes(lastCont.target)) {
    return `Der Fortsetzungspfad der letzten Prüfung ("${ids[ids.length - 1]}") führt zurück in die Kette ` +
           `statt hinaus.`;
  }
  const entries = (proc.edges || []).filter(e => e.target === ids[0] && !ids.includes(e.source));
  if (entries.length === 0) {
    return `Die erste Prüfung ("${ids[0]}") hat keinen erkennbaren Einstieg von außerhalb der Kette.`;
  }
  if (entries.length > 1) {
    return `Die erste Prüfung ("${ids[0]}") hat mehr als einen Einstieg von außerhalb der Kette — nicht eindeutig.`;
  }
  return null;
}

/**
 * Eingriff „Prüfreihenfolge drehen". Zentrale Zusage: dieser Eingriff
 * BERECHNET KEINE Reihenfolge und ERFINDET KEINE — er wendet eine vom
 * Aufrufer uebergebene an und verweigert sonst. Das Modell traegt weder
 * Aufwand noch Ablehnungswahrscheinlichkeit je Pruefung; jede "optimale"
 * Reihenfolge waere ein erfundener Wert ohne Grundlage im Logic-Core.
 */
export function previewReorderKnockouts(lc, { gatewayIds = [], order = null, policy = {} } = {}) {
  const proc = procOf(lc);
  if (gatewayIds.length < 2) return refusal('Mindestens zwei Prüfungen nötig.');
  const nodes = findNodes(proc, gatewayIds);
  if (nodes.some(n => !n)) return refusal('Unbekannte Kennung.');
  if (nodes.some(n => n.type !== 'exclusiveGateway')) return refusal('Nur exklusive Gateways.');
  const prot = nodes.filter(n => isProtected(n, policy, lc));
  if (prot.length) return refusal(`Geschütztes Element betroffen: ${prot.map(n => n.id).join(', ')}`);
  const chainIssue = knockoutChainIssue(proc, gatewayIds);
  if (chainIssue) return refusal(chainIssue);
  if (!order) {
    return refusal('Keine Reihenfolge übergeben — der Eingriff berechnet keine und erfindet keine.');
  }
  const same = order.length === gatewayIds.length &&
               [...order].sort().join() === [...gatewayIds].sort().join();
  if (!same) return refusal('Die Reihenfolge ist keine Permutation der übergebenen Prüfungen.');
  if (order.every((id, i) => id === gatewayIds[i])) {
    return refusal('Die übergebene Reihenfolge entspricht bereits der aktuellen — kein Eingriff nötig.');
  }
  return { feasible: 'full', scope: [...order], reason: '' };
}

export function applyReorderKnockouts(lc, params = {}) {
  const pv = previewReorderKnockouts(lc, params);
  if (pv.feasible === 'none') throw new Error(pv.reason);

  const out = cloneLc(lc);
  const proc = procOf(out);
  const oldOrder = params.gatewayIds;
  const newOrder = pv.scope;
  const nodeById = buildNodeMap(proc);

  // Struktur bereits durch previewReorderKnockouts (knockoutChainIssue)
  // geprüft: entry und die Weiter-Kante der letzten alten Prüfung existieren
  // garantiert und sind eindeutig. `if (entry)` bleibt trotzdem als billige
  // Absicherung stehen, falls dieser Pfad je ohne den Preview-Aufruf erreicht wird.
  const entry = (proc.edges || []).find(e => e.target === oldOrder[0] && !oldOrder.includes(e.source));
  const exit = continuationEdges(proc, nodeById, oldOrder[oldOrder.length - 1])[0].target;

  // Bedingungs-Labels ("Nein"/"Ja") und Standardfluss-Markierung (isDefault)
  // haengen an der KANTE, nicht an ihrer Position in der Kette: weil hier nur
  // e.target auf vorhandenen Kanten-Objekten umgehaengt wird (statt Kanten neu
  // zu erzeugen), wandern label/isDefault automatisch mit der Pruefung, der
  // sie gehoeren — kein gesonderter Kopierschritt noetig.
  const modified = [];
  if (entry) { entry.target = newOrder[0]; modified.push(entry.id); }
  for (let i = 0; i < newOrder.length; i++) {
    const c = continuationEdges(proc, nodeById, newOrder[i])[0];
    c.target = i < newOrder.length - 1 ? newOrder[i + 1] : exit;
    modified.push(c.id);
  }

  const gate = checkGate(out);
  if (!gate.ok) throw new Error(`Rollback: Ergebnis waere nicht sound — ${gate.errors.join('; ')}`);

  return {
    lc: out,
    change: { transform: 'reorderKnockouts', targets: newOrder, added: [], removed: [], modified,
              note: `Reihenfolge ${oldOrder.join(' → ')} → ${newOrder.join(' → ')}` },
    warnings: gate.warnings,
  };
}

/**
 * Boundary-Event-Marker, die eine Unterbrechung ausdruecken (nicht: eine
 * Geschaeftsentscheidung). Absichtlich dieselben acht OMG-Ereignistypen wie an
 * Boundary-Events zulaessig (Timer, Error, Message, Signal, Escalation,
 * Compensation, Cancel, Conditional).
 */
const BOUNDARY_MARKERS = new Set(['timer', 'error', 'message', 'signal', 'escalation',
                                  'compensation', 'cancel', 'conditional']);

/**
 * Eingriff „Ausnahme herausnehmen" (isolateException). Der heikelste Eingriff im
 * Werkzeugkasten: ein Inline-Zweig ("Aufgabe -> XOR 'Frist überschritten?' -> Ja ->
 * Ende") bedeutet "wir haben geprüft und ENTSCHIEDEN" — eine fachliche
 * Entscheidung. Ein Boundary-Event am selben Punkt bedeutet "etwas hat die
 * Aufgabe UNTERBROCHEN, während sie lief" — eine Störung. Im Graphen sehen
 * beide identisch aus (derselbe Name-Regex EXCEPTION_END_NAME_RE weiter oben
 * erkennt beide gleichermaßen als "Ausnahme-Ende"), und eine Umformung vom
 * einen ins andere würde die BEDEUTUNG des Prozesses stillschweigend
 * verändern, ohne dass sich am Graphen etwas Sichtbares ändert. Deshalb sind
 * `marker` UND `cancelActivity` Pflichtparameter — previewIsolateException
 * leitet KEINEN von beiden aus dem Namen des End-Events, des Gateways oder
 * sonst irgendeiner Graph-Heuristik ab. Fehlt einer, wird verweigert, es gibt
 * keinen stillen Fallback.
 */
export function previewIsolateException(lc, { endId, attachTo, marker, cancelActivity, policy = {} } = {}) {
  const proc = procOf(lc);
  const end = (proc.nodes || []).find(n => n.id === endId);
  if (!end) return refusal(`Unbekannte Kennung: ${endId}`);
  if (end.type !== 'endEvent') return refusal('Ziel ist kein End-Ereignis.');
  const host = (proc.nodes || []).find(n => n.id === attachTo);
  if (!host) return refusal(`Unbekannte Aufgabe: ${attachTo}`);
  if (!TASK_TYPES.has(host.type)) return refusal('Boundary-Ereignisse hängen nur an Aufgaben.');
  if (isProtected(host, policy, lc) || isProtected(end, policy, lc)) {
    return refusal('Geschütztes Element betroffen.');
  }
  if (!marker || !BOUNDARY_MARKERS.has(marker)) {
    return refusal('Marker ist Pflicht (timer|error|message|…) — die Semantik ist nicht aus dem Graphen ' +
                   'oder dem Namen ableitbar.');
  }
  // cancelActivity ist ebenso Pflicht wie marker (siehe Docstring oben) — KEIN
  // Default (weder true noch false). Ob eine Störung die Aufgabe abbricht oder
  // nur nebenläufig protokolliert, ist dieselbe Art fachlicher Entscheidung
  // wie der Marker selbst und darf ebenso wenig erraten werden.
  if (typeof cancelActivity !== 'boolean') {
    return refusal('cancelActivity ist Pflicht (true|false) — ob die Störung die Aufgabe unterbricht oder ' +
                   'nebenläufig weiterläuft, ist eine fachliche Entscheidung, die nicht erraten wird.');
  }

  // Guard 1: apply entfernt ALLE eingehenden Kanten von endId (nicht nur die
  // vom betroffenen Gateway) — siehe dort. Fuer jede betroffene Quelle muss
  // deshalb geprueft werden, ob ihr NACH der Entfernung noch mindestens eine
  // ausgehende Kante bleibt. S07 ("Pfade ohne ausgehende Kante") hat
  // defaultSeverity WARNING, nicht ERROR — das feste Rollback-Gate
  // (checkGate().ok prueft ausschliesslich errors.length) blockt NICHT bei
  // reinen Warnungen, eine dadurch entstehende Sackgasse wuerde also still ins
  // Ergebnis durchsickern. Ein Gateway, dem nach dem Entfernen genau EINE
  // Kante bleibt, ist dagegen unproblematisch und wird bewusst NICHT
  // verweigert: das ist der Regelfall dieses Eingriffs (ein XOR mit zwei
  // Zweigen wird zu einem trivialen Durchlauf-Gateway mit einem Zweig —
  // strukturell gueltig, hoechstens stilistisch fragwuerdig, das bereits M02
  // als WARNUNG abdeckt).
  const incomingToEnd = (proc.edges || []).filter(e => e.target === endId);
  const outgoingCount = {};
  for (const e of (proc.edges || [])) outgoingCount[e.source] = (outgoingCount[e.source] || 0) + 1;
  const removedCount = {};
  for (const e of incomingToEnd) removedCount[e.source] = (removedCount[e.source] || 0) + 1;
  const stranded = Object.keys(removedCount)
    .filter(src => (outgoingCount[src] || 0) - removedCount[src] <= 0);
  if (stranded.length) {
    return refusal(`Eingriff würde "${stranded.join(', ')}" ohne jeden ausgehenden Fluss zurücklassen ` +
                   `(Sackgasse) — S07 prüft das nur als WARNUNG, das feste Rollback-Gate greift dafür nicht.`);
  }

  // Guard 2: Assoziationen koennen laut Schema auf JEDE Kennung zeigen, auch
  // auf eine Kante statt auf einen Knoten (dieselbe Luecke wie bei
  // applyMergeTasks' Assoziations-Pruefung oben: kein S03/S10-Pendant fuer
  // Assoziationen in rules.js). Zeigt eine Assoziation auf eine der gleich zu
  // entfernenden Kanten, wuerde sie danach ins Leere zeigen — unbemerkt vom
  // Rollback-Gate, aber sichtbar als strukturell ungueltiges BPMN beim Export.
  const removedEdgeIds = new Set(incomingToEnd.map(e => e.id));
  const orphanedAssocs = (lc.associations || [])
    .filter(a => removedEdgeIds.has(a.source) || removedEdgeIds.has(a.target));
  if (orphanedAssocs.length) {
    return refusal(`Assoziation(en) (${orphanedAssocs.map(a => a.id).join(', ')}) verweisen auf Kanten, ` +
                   `die entfernt würden — der Eingriff würde das Modell strukturell ungültig machen.`);
  }

  return { feasible: 'full', scope: [endId, attachTo], reason: '' };
}

export function applyIsolateException(lc, params = {}) {
  const pv = previewIsolateException(lc, params);
  if (pv.feasible === 'none') throw new Error(pv.reason);

  const out = cloneLc(lc);
  const proc = procOf(out);
  const { endId, attachTo, marker, cancelActivity } = params;
  const host = proc.nodes.find(n => n.id === attachTo);

  // currentLaneOf statt host.lane: das Schema erlaubt Lane-Zuordnung auch nur
  // ueber Lane.nodeIds (Format B) ohne node.lane — ein neues Boundary-Event
  // braucht trotzdem eine Bahn. Wer hier raw host.lane laese, saehe in einem
  // Format-B-only-Modell `undefined` und das neue Boundary-Event bekaeme gar
  // keine Bahn zugewiesen.
  const lane = currentLaneOf(proc, host);
  const bndId = nextId(out, `bnd_${attachTo}_${marker}`);
  proc.nodes.push({ id: bndId, type: 'boundaryEvent', name: '', lane,
                    attachedTo: attachTo, marker, cancelActivity });

  // Bisherige Zufuehrung zum Ausnahme-Ende entfernen, neu vom Boundary-Ereignis
  // fuehren. previewIsolateException (Guard 1) hat bereits sichergestellt,
  // dass keine betroffene Quelle dadurch ohne ausgehenden Fluss zurueckbleibt.
  const removed = [];
  for (let i = proc.edges.length - 1; i >= 0; i--) {
    if (proc.edges[i].target === endId) removed.push(proc.edges.splice(i, 1)[0].id);
  }
  const newEdge = nextId(out, `flow_${bndId}_${endId}`);
  proc.edges.push({ id: newEdge, source: bndId, target: endId });

  const gate = checkGate(out);
  if (!gate.ok) throw new Error(`Rollback: Ergebnis waere nicht sound — ${gate.errors.join('; ')}`);

  // "modified": bewusst leer. Anders als bei parallelize/mergeTasks/relane wird
  // hier kein bestehendes Element inhaltlich veraendert — der Host (attachTo)
  // bleibt unangetastet, und keine ueberlebende Kante wird umgehaengt (die
  // alten Kanten zu endId werden entfernt, nicht modifiziert; die neue Kante
  // vom Boundary-Event ist komplett neu). "added" und "removed" nennen daher
  // bereits jeden Unterschied zwischen Quelle und Ergebnis vollstaendig.
  return {
    lc: out,
    change: { transform: 'isolateException', targets: [endId, attachTo],
              added: [bndId, newEdge], removed, modified: [],
              note: `Ausnahme "${(proc.nodes.find(n => n.id === endId) || {}).name || endId}" ` +
                    `an ${attachTo} gehängt (${marker})` },
    warnings: gate.warnings,
  };
}

import { describe, test, expect } from '@jest/globals';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cloneLc, checkGate, nextId, isProtected, refusal, collectIds } from './redesign-core.js';
import { runRules, loadRuleProfile } from './rules.js';
import { previewParallelize, applyParallelize, previewMergeTasks, applyMergeTasks,
         previewRelane, applyRelane, previewReorderKnockouts, applyReorderKnockouts,
         previewIsolateException, applyIsolateException } from './redesign.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const lcMin = {
  id: 'P',
  nodes: [
    { id: 's', type: 'startEvent', lane: 'L' },
    { id: 't1', type: 'userTask', name: 'Antrag prüfen', lane: 'L' },
    { id: 'e', type: 'endEvent', lane: 'L' },
  ],
  edges: [
    { id: 'f1', source: 's', target: 't1' },
    { id: 'f2', source: 't1', target: 'e' },
  ],
  lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
};

describe('redesign-core', () => {
  test('cloneLc liefert eine unabhaengige Kopie', () => {
    const copy = cloneLc(lcMin);
    copy.nodes[0].id = 'geaendert';
    expect(lcMin.nodes[0].id).toBe('s');
  });

  test('nextId ist deterministisch und kollisionsfrei', () => {
    const a = nextId(lcMin, 'gw_and');
    const b = nextId(lcMin, 'gw_and');
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-zA-Z_][a-zA-Z0-9_-]*$/);
    const withA = { ...lcMin, nodes: [...lcMin.nodes, { id: a, type: 'parallelGateway' }] };
    expect(nextId(withA, 'gw_and')).not.toBe(a);
  });

  test('collectIds sieht IDs verschachtelter Sub-Prozess-Kinder (auch mehrstufig)', () => {
    const withSub = {
      ...lcMin,
      nodes: [
        ...lcMin.nodes,
        {
          id: 'sub1', type: 'subProcess', name: 'Teilprozess', lane: 'L', isExpanded: true,
          nodes: [
            { id: 'sub1_start', type: 'startEvent' },
            { id: 'inner_child', type: 'userTask', name: 'Inneres pruefen' },
            {
              id: 'sub2', type: 'subProcess', name: 'Verschachtelt', isExpanded: true,
              nodes: [{ id: 'deep_child', type: 'userTask', name: 'Tiefes pruefen' }],
              edges: [{ id: 'deep_f1', source: 'deep_child', target: 'deep_child' }],
            },
            { id: 'sub1_end', type: 'endEvent' },
          ],
          edges: [
            { id: 'sub1_f1', source: 'sub1_start', target: 'inner_child' },
            { id: 'sub1_f2', source: 'inner_child', target: 'sub2' },
          ],
        },
      ],
    };
    const ids = collectIds(withSub);
    // Erste Ebene und zweite (verschachtelte) Ebene muessen beide gesehen werden.
    expect(ids.has('inner_child')).toBe(true);
    expect(ids.has('sub1_f1')).toBe(true);
    expect(ids.has('deep_child')).toBe(true);
    expect(ids.has('deep_f1')).toBe(true);

    // nextId darf keine bereits vergebene Sub-Prozess-Kind-ID zurueckgeben.
    expect(nextId(withSub, 'inner_child')).not.toBe('inner_child');
    expect(nextId(withSub, 'deep_child')).not.toBe('deep_child');
  });

  test('collectIds sieht Pool-IDs (lc.pools[].id)', () => {
    const withPools = {
      pools: [
        { id: 'pool_a', name: 'Antragsteller', nodes: lcMin.nodes, edges: lcMin.edges, lanes: lcMin.lanes },
        { id: 'pool_b', name: 'Bearbeiter', nodes: [], edges: [], lanes: [] },
      ],
    };
    const ids = collectIds(withPools);
    expect(ids.has('pool_a')).toBe(true);
    expect(ids.has('pool_b')).toBe(true);

    // nextId darf keine bereits vergebene Pool-ID zurueckgeben.
    expect(nextId(withPools, 'pool_a')).not.toBe('pool_a');
  });

  test('checkGate akzeptiert ein sauberes Modell', () => {
    const r = checkGate(lcMin);
    expect(r.ok).toBe(true);
  });

  test('checkGate lehnt ein Modell ohne endEvent ab', () => {
    const broken = { ...lcMin, nodes: lcMin.nodes.filter(n => n.type !== 'endEvent'),
                     edges: [{ id: 'f1', source: 's', target: 't1' }] };
    const r = checkGate(broken);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  test('checkGate laesst reine Stil-Verstoesse durch, obwohl das strict-Profil dieselbe Verletzung zum Fehler macht (profilunabhaengig)', () => {
    const styleIssue = { ...lcMin, nodes: lcMin.nodes.map(n => n.id === 't1' ? { ...n, name: 'Pruefung' } : n) };

    // Beweis, dass der Stil-Verstoss real ist: unter dem strict-Profil (rules/strict-profile.json)
    // wird M01 (Objekt+Verb) per Override zu ERROR. Waere er das nicht, waere der Test unten
    // vacuous — er wuerde auch bestehen, wenn checkGate die Stil-Schicht faelschlich einschaltete.
    const strictProfile = loadRuleProfile(resolve(__dirname, '../rules/strict-profile.json'));
    expect(strictProfile).not.toBeNull();
    const strictResult = runRules(styleIssue, strictProfile);
    expect(strictResult.errors.length).toBeGreaterThan(0);
    expect(strictResult.errors.some(e => e.includes('Objekt+Verb'))).toBe(true);

    // Das feste Rollback-Gate ignoriert das Profil des Aufrufers vollstaendig: derselbe
    // Verstoss, der unter strict ein ERROR ist, bleibt hier folgenlos.
    const r = checkGate(styleIssue);
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  test('isProtected trifft ueber Kennung und Anzeigenamen', () => {
    const node = { id: 't1', name: 'Antrag prüfen', lane: 'L' };
    expect(isProtected(node, { protectNodes: ['t1'] })).toBe(true);
    expect(isProtected(node, { protectNodes: ['Antrag prüfen'] })).toBe(true);
    expect(isProtected(node, { protectLanes: ['L'] })).toBe(true);
    expect(isProtected(node, { protectLanes: ['Sachbearbeiter'] }, lcMin)).toBe(true);
    expect(isProtected(node, { protectNodes: ['anderes'] })).toBe(false);
  });

  test('isProtected loest die Lane-Zugehoerigkeit auch ueber Format B (Lane.nodeIds) ' +
       'auf, wenn der Knoten selbst kein node.lane traegt', () => {
    // Kritischer Fall: das Schema erlaubt Lane-Zuordnung ENTWEDER ueber
    // node.lane (Format A) ODER ueber Lane.nodeIds (Format B), ohne dass der
    // Knoten je node.lane setzt. Eine Implementierung, die nur node.lane
    // liest, sieht diesen Knoten in KEINER Bahn — protectLanes waere dann
    // wirkungslos, obwohl die Bahn im Modell klar benannt ist.
    const lcFormatBOnly = {
      id: 'P',
      nodes: [
        { id: 's', type: 'startEvent' },
        { id: 't1', type: 'userTask', name: 'Antrag prüfen' },
        { id: 'e', type: 'endEvent' },
      ],
      edges: [
        { id: 'f1', source: 's', target: 't1' },
        { id: 'f2', source: 't1', target: 'e' },
      ],
      lanes: [{ id: 'L', name: 'Sachbearbeiter', nodeIds: ['s', 't1', 'e'] }],
    };
    const node = lcFormatBOnly.nodes.find(n => n.id === 't1');
    expect(node.lane).toBeUndefined();
    expect(isProtected(node, { protectLanes: ['L'] }, lcFormatBOnly)).toBe(true);
    expect(isProtected(node, { protectLanes: ['Sachbearbeiter'] }, lcFormatBOnly)).toBe(true);
    expect(isProtected(node, { protectLanes: ['irgendeine-andere-bahn'] }, lcFormatBOnly)).toBe(false);
  });

  test('refusal liefert die vereinbarte Form', () => {
    const r = refusal('kein Grund');
    expect(r).toEqual({ feasible: 'none', scope: [], reason: 'kein Grund' });
  });
});

const lcChain = {
  id: 'P',
  nodes: [
    { id: 's', type: 'startEvent', lane: 'L' },
    { id: 'a', type: 'userTask', name: 'Adresse prüfen', lane: 'L' },
    { id: 'b', type: 'userTask', name: 'Telefon prüfen', lane: 'L' },
    { id: 'c', type: 'userTask', name: 'E-Mail prüfen', lane: 'L' },
    { id: 'e', type: 'endEvent', lane: 'L' },
  ],
  edges: [
    { id: 'f0', source: 's', target: 'a' },
    { id: 'f1', source: 'a', target: 'b' },
    { id: 'f2', source: 'b', target: 'c' },
    { id: 'f3', source: 'c', target: 'e' },
  ],
  lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
};

describe('parallelize', () => {
  test('preview meldet Machbarkeit fuer eine lineare Kette', () => {
    const r = previewParallelize(lcChain, { nodeIds: ['a', 'b', 'c'] });
    expect(r.feasible).toBe('full');
    expect(r.scope).toEqual(['a', 'b', 'c']);
  });

  test('preview verweigert bei unbekannter Kennung', () => {
    const r = previewParallelize(lcChain, { nodeIds: ['a', 'gibtsnicht'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/unbekannt/i);
  });

  test('preview verweigert bei geschuetztem Element ueber den Anzeigenamen', () => {
    const r = previewParallelize(lcChain, { nodeIds: ['a', 'b', 'c'],
                                            policy: { protectLanes: ['Sachbearbeiter'] } });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/geschützt/i);
  });

  test('preview verweigert bei nicht zusammenhaengender Kette', () => {
    const r = previewParallelize(lcChain, { nodeIds: ['a', 'c'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/zusammenhäng/i);
  });

  test('preview verweigert bei geschuetzter Bahn in einem Format-B-only-Modell ' +
       '(Lane.nodeIds, kein node.lane) — beweist, dass der isProtected()-Fix auch ' +
       'andere Transforms als previewRelane erreicht', () => {
    const chainFormatBOnly = {
      id: 'P',
      nodes: [
        { id: 's', type: 'startEvent' },
        { id: 'a', type: 'userTask', name: 'Adresse prüfen' },
        { id: 'b', type: 'userTask', name: 'Telefon prüfen' },
        { id: 'e', type: 'endEvent' },
      ],
      edges: [
        { id: 'f0', source: 's', target: 'a' },
        { id: 'f1', source: 'a', target: 'b' },
        { id: 'f2', source: 'b', target: 'e' },
      ],
      lanes: [{ id: 'L', name: 'Sachbearbeiter', nodeIds: ['s', 'a', 'b', 'e'] }],
    };
    const r = previewParallelize(chainFormatBOnly, { nodeIds: ['a', 'b'],
                                                      policy: { protectLanes: ['L'] } });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/geschützt/i);
  });

  test('preview verweigert bei Fan-in: zusaetzliche Kante von aussen in einen Zwischenschritt', () => {
    // Knoten 'x' liegt ausserhalb der Kette a-b-c, hat aber selbst eine Kante nach 'b'.
    // Ohne die Fan-in-Pruefung wuerde applyParallelize diese externe Kante ignorieren
    // und einen strukturell falschen Rest (totes Fragment) erzeugen.
    const fanIn = {
      ...lcChain,
      nodes: [...lcChain.nodes, { id: 'x', type: 'userTask', name: 'Extra pruefen', lane: 'L' }],
      edges: [...lcChain.edges, { id: 'fx', source: 'x', target: 'b' }],
    };
    const r = previewParallelize(fanIn, { nodeIds: ['a', 'b', 'c'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/zusammenhäng/i);
  });

  test('preview verweigert bei Fan-out: zusaetzliche ausgehende Kante am letzten Kettenmitglied', () => {
    // 'c' (letztes Kettenmitglied) hat neben c->e noch eine zweite ausgehende Kante
    // nach 'y'. Der Join darf nicht blind an die Stelle von c->e treten, waehrend
    // c->y unberuecksichtigt bleibt.
    const fanOut = {
      ...lcChain,
      nodes: [...lcChain.nodes, { id: 'y', type: 'userTask', name: 'Weiteres pruefen', lane: 'L' }],
      edges: [...lcChain.edges, { id: 'fy', source: 'c', target: 'y' }],
    };
    const r = previewParallelize(fanOut, { nodeIds: ['a', 'b', 'c'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/zusammenhäng/i);
  });

  test('preview verweigert bei Fan-in am ERSTEN Kettenmitglied (Regression)', () => {
    // Reproduktion des Fund-Szenarios: s->a->b->c->e, Kette=[a,b,c], PLUS eine
    // zusaetzliche Kante x->a (x hat sonst keine Kanten). Vor dem Fix fand
    // applyParallelize per edges.find() nur die ERSTE Kante nach 'a' (s->a),
    // haengte sie auf den Split um und liess x->a unveraendert direkt auf 'a'
    // zeigen — der Split wird umgangen, exakt das urspruengliche Bug-Muster.
    const fanInFirst = {
      ...lcChain,
      nodes: [...lcChain.nodes, { id: 'x', type: 'userTask', name: 'Extra pruefen', lane: 'L' }],
      edges: [...lcChain.edges, { id: 'fx', source: 'x', target: 'a' }],
    };
    const r = previewParallelize(fanInFirst, { nodeIds: ['a', 'b', 'c'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/zusammenhäng/i);

    // apply muss ebenfalls verweigern (nicht nur preview) — kein stilles Durchrutschen.
    expect(() => applyParallelize(fanInFirst, { nodeIds: ['a', 'b', 'c'] })).toThrow(/zusammenhäng/i);
  });

  test('preview verweigert, wenn das erste Kettenmitglied gar keine eingehende Kante hat', () => {
    // Grenzfall: 'a' hat ueberhaupt keine eingehende Kante (z.B. weil s->a entfernt
    // wurde). Der neue Split-Gateway haette dann selbst keinen Vorgaenger — bewusst
    // eine Verweigerung, nicht eine stillschweigende Akzeptanz (siehe Docstring von
    // isLinearChain).
    const noIncoming = {
      ...lcChain,
      edges: lcChain.edges.filter(e => e.id !== 'f0'),
    };
    const r = previewParallelize(noIncoming, { nodeIds: ['a', 'b', 'c'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/zusammenhäng/i);
  });

  test('apply erzeugt AND-Split und AND-Join und bleibt sound', () => {
    const r = applyParallelize(lcChain, { nodeIds: ['a', 'b', 'c'] });
    const types = r.lc.nodes.filter(n => n.type === 'parallelGateway');
    expect(types.length).toBe(2);
    expect(checkGate(r.lc).ok).toBe(true);
    expect(r.change.transform).toBe('parallelize');

    // "added" muss vollstaendig sein (Symmetrie zu "removed"): beide Gateway-IDs
    // UND alle sechs neu geschaffenen Verbindungskanten (2 pro Kettenmitglied:
    // eine vom Split, eine zum Join). Die zwei retargetierten Alt-Kanten (s->a,
    // c->e) behalten ihre urspruengliche ID und zaehlen NICHT als "added".
    const splitNode = types.find(n => !n.has_join);
    const joinNode = types.find(n => n.has_join);
    expect(r.change.added).toEqual(expect.arrayContaining([splitNode.id, joinNode.id]));

    const newEdgeIds = r.lc.edges
      .filter(e => e.source === splitNode.id || e.target === joinNode.id)
      .map(e => e.id);
    expect(newEdgeIds.length).toBe(6);
    expect(r.change.added).toEqual(expect.arrayContaining(newEdgeIds));
    expect(r.change.added.length).toBe(2 + newEdgeIds.length);

    // "modified": s->a (f0) und c->e (f3) behalten ihre ID, aber ihr source/
    // target wurde umgehaengt (auf den Split- bzw. Join-Gateway) — Quelle und
    // Ergebnis unterscheiden sich hier NICHT nur in "added"/"removed".
    expect(r.change.modified).toEqual(expect.arrayContaining(['f0', 'f3']));
    expect(r.change.modified.length).toBe(2);
  });

  test('apply mutiert die Eingabe nicht', () => {
    const before = JSON.stringify(lcChain);
    applyParallelize(lcChain, { nodeIds: ['a', 'b', 'c'] });
    expect(JSON.stringify(lcChain)).toBe(before);
  });

  test('apply ist deterministisch, auch bei den neuen Kennungen', () => {
    const r1 = applyParallelize(lcChain, { nodeIds: ['a', 'b', 'c'] });
    const r2 = applyParallelize(lcChain, { nodeIds: ['a', 'b', 'c'] });
    expect(JSON.stringify(r1.lc)).toBe(JSON.stringify(r2.lc));
  });

  test('apply veraendert nur das Beabsichtigte', () => {
    const r = applyParallelize(lcChain, { nodeIds: ['a', 'b', 'c'] });
    const startBefore = lcChain.nodes.find(n => n.id === 's');
    const startAfter = r.lc.nodes.find(n => n.id === 's');
    expect(startAfter).toEqual(startBefore);
    expect(r.lc.lanes).toEqual(lcChain.lanes);
  });

  test('apply verweigert, wenn preview nicht machbar meldet', () => {
    expect(() => applyParallelize(lcChain, { nodeIds: ['a', 'c'] })).toThrow(/zusammenhäng/i);
  });

  test('verweigert bei ungerichteter Assoziation zwischen den Schritten', () => {
    const undirected = { ...lcChain, associations: [{ id: 'as1', source: 'a', target: 'b' }] };
    const r = previewParallelize(undirected, { nodeIds: ['a', 'b', 'c'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/ungerichtet/i);
  });

  test('verweigert bei nachgewiesener Datenabhaengigkeit', () => {
    const dependent = { ...lcChain,
      nodes: [...lcChain.nodes, { id: 'do1', type: 'dataObjectReference', name: 'Ergebnis', lane: 'L' }],
      associations: [{ id: 'as1', source: 'a', target: 'do1', directed: true },
                     { id: 'as2', source: 'do1', target: 'b', directed: true }] };
    const r = previewParallelize(dependent, { nodeIds: ['a', 'b', 'c'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/abhängig/i);
  });

  test('ohne Assoziationen laeuft der Eingriff, meldet aber ungeprueft', () => {
    const r = previewParallelize(lcChain, { nodeIds: ['a', 'b', 'c'] });
    expect(r.feasible).toBe('full');
    expect(r.provenIndependent).toBe(false);
  });
});

const lcMerge = {
  id: 'P',
  nodes: [
    { id: 's', type: 'startEvent', lane: 'L' },
    { id: 'm1', type: 'userTask', name: 'Daten erfassen', lane: 'L' },
    { id: 'm2', type: 'userTask', name: 'Daten sichern', lane: 'L' },
    { id: 'e', type: 'endEvent', lane: 'L' },
  ],
  edges: [
    { id: 'g0', source: 's', target: 'm1' },
    { id: 'g1', source: 'm1', target: 'm2' },
    { id: 'g2', source: 'm2', target: 'e' },
  ],
  lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
};

describe('mergeTasks', () => {
  test('verweigert ohne Namen — Benennung waere ein Urteil', () => {
    const r = previewMergeTasks(lcMerge, { nodeIds: ['m1', 'm2'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/name/i);
  });

  test('verweigert bei angehaengtem Boundary-Event', () => {
    const withBoundary = { ...lcMerge, nodes: [...lcMerge.nodes,
      { id: 'bnd', type: 'boundaryEvent', attachedTo: 'm1', marker: 'timer', lane: 'L' }] };
    const r = previewMergeTasks(withBoundary, { nodeIds: ['m1', 'm2'], name: 'Daten erfassen und sichern' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/boundary/i);
  });

  test('verweigert bei unterschiedlichen Typen', () => {
    const mixed = { ...lcMerge, nodes: lcMerge.nodes.map(n => n.id === 'm2' ? { ...n, type: 'serviceTask' } : n) };
    const r = previewMergeTasks(mixed, { nodeIds: ['m1', 'm2'], name: 'X tun' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/typ/i);
  });

  test('verweigert bei Schleifen- oder Mehrfach-Marker', () => {
    const looped = { ...lcMerge, nodes: lcMerge.nodes.map(n => n.id === 'm1' ? { ...n, loopType: 'standard' } : n) };
    const r = previewMergeTasks(looped, { nodeIds: ['m1', 'm2'], name: 'X tun' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/marker/i);
  });

  test('buendelt zwei gleichartige Schritte und bleibt sound', () => {
    const r = applyMergeTasks(lcMerge, { nodeIds: ['m1', 'm2'], name: 'Daten erfassen und sichern' });
    expect(r.lc.nodes.find(n => n.id === 'm2')).toBeUndefined();
    expect(r.lc.nodes.find(n => n.id === 'm1').name).toBe('Daten erfassen und sichern');
    expect(checkGate(r.lc).ok).toBe(true);
    expect(r.change.removed).toContain('m2');

    // "modified": m1 (der ueberlebende Knoten) behaelt seine ID, aber sein
    // Name wurde geaendert — er taucht sonst in keinem der beiden anderen
    // Arrays auf, obwohl Quelle und Ergebnis sich hier unterscheiden. Zusätzlich:
    // die abgehende Kante (g2) des letzten entfernten Knotens (m2) wird umgehängt
    // — ihre source wechselt von m2 zu m1 — sie behält ihre ID aber ihre Inhalte
    // unterscheiden sich zwischen Quelle und Ergebnis.
    expect(r.change.modified).toContain('m1');
    expect(r.change.modified).toContain('g2');
    expect(r.change.modified.length).toBe(2);
  });

  test('preview verweigert bei weniger als zwei Schritten', () => {
    const r = previewMergeTasks(lcMerge, { nodeIds: ['m1'], name: 'X tun' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/mindestens zwei/i);
  });

  test('preview verweigert bei unbekannter Kennung', () => {
    const r = previewMergeTasks(lcMerge, { nodeIds: ['m1', 'gibtsnicht'], name: 'X tun' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/unbekannt/i);
  });

  test('preview verweigert bei geschuetztem Element', () => {
    const r = previewMergeTasks(lcMerge, { nodeIds: ['m1', 'm2'], name: 'X tun',
                                           policy: { protectNodes: ['m1'] } });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/geschützt/i);
  });

  test('preview verweigert, wenn die Schritte in verschiedenen Bahnen liegen', () => {
    const otherLane = { ...lcMerge,
      lanes: [...lcMerge.lanes, { id: 'L2', name: 'Andere Bahn' }],
      nodes: lcMerge.nodes.map(n => n.id === 'm2' ? { ...n, lane: 'L2' } : n) };
    const r = previewMergeTasks(otherLane, { nodeIds: ['m1', 'm2'], name: 'X tun' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/bahn/i);
  });

  test('preview verweigert, wenn eine Assoziation auf einen zu entfernenden Schritt zeigt', () => {
    // 'm2' wuerde entfernt (nur 'm1' ueberlebt). Eine Assoziation, die 'm2'
    // referenziert, wuerde nach dem Merge auf eine nicht mehr existierende ID
    // zeigen: bpmn-xml.js emittiert dann eine <bpmn:Association> mit ungueltigem
    // sourceRef/targetRef, und keine Regel in rules.js prueft das (kein S03/S10-
    // Pendant fuer Assoziationen), also greift das Rollback-Gate nicht.
    const withAssoc = { ...lcMerge,
      nodes: [...lcMerge.nodes, { id: 'do1', type: 'dataObjectReference', name: 'Protokoll', lane: 'L' }],
      associations: [{ id: 'as1', source: 'm2', target: 'do1', directed: true }] };
    const r = previewMergeTasks(withAssoc, { nodeIds: ['m1', 'm2'], name: 'Daten erfassen und sichern' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/assoziation/i);
    expect(r.reason).toMatch(/as1/);
  });

  test('Assoziation auf den UEBERLEBENDEN Knoten (m1) blockiert nicht', () => {
    // Gegenprobe zum vorigen Test: 'm1' ist ids[0] und ueberlebt den Merge —
    // seine Assoziationen bleiben gueltig, also darf hier nicht verweigert werden.
    const withAssoc = { ...lcMerge,
      nodes: [...lcMerge.nodes, { id: 'do1', type: 'dataObjectReference', name: 'Protokoll', lane: 'L' }],
      associations: [{ id: 'as1', source: 'm1', target: 'do1', directed: true }] };
    const r = previewMergeTasks(withAssoc, { nodeIds: ['m1', 'm2'], name: 'Daten erfassen und sichern' });
    expect(r.feasible).toBe('full');
  });
});

const lcTwoLanes = {
  id: 'P',
  nodes: [
    { id: 's', type: 'startEvent', lane: 'A' },
    { id: 'x', type: 'userTask', name: 'Fall prüfen', lane: 'A' },
    { id: 'e', type: 'endEvent', lane: 'B' },
  ],
  edges: [
    { id: 'h0', source: 's', target: 'x' },
    { id: 'h1', source: 'x', target: 'e' },
  ],
  lanes: [{ id: 'A', name: 'Vorpruefung' }, { id: 'B', name: 'Entscheidung' }],
};

describe('relane', () => {
  test('verweigert bei unbekannter Zielbahn', () => {
    const r = previewRelane(lcTwoLanes, { nodeId: 'x', lane: 'gibtsnicht' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/bahn/i);
  });

  test('verweigert bei unbekannter Kennung', () => {
    const r = previewRelane(lcTwoLanes, { nodeId: 'gibtsnicht', lane: 'B' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/unbekannt/i);
  });

  test('verweigert bei geschuetztem Knoten (aktuelle Bahn betroffen)', () => {
    const r = previewRelane(lcTwoLanes, { nodeId: 'x', lane: 'B', policy: { protectNodes: ['x'] } });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/geschützt/i);
    // /x/ allein waere ein Fehl-Positiv-Magnet — die Regel matcht praktisch
    // jeden Fliesstext (z. B. schon "geschützt" selbst enthaelt kein x, aber
    // fast jede andere denkbare Nachricht wuerde durchrutschen, auch eine
    // ohne Bezug zur Knoten-ID). Stattdessen exakt die Betroffenen-ID im
    // erwarteten Nachrichtenformat pruefen, damit der Test bei einer falschen
    // ID (z. B. vertauscht mit einer anderen Kennung) tatsaechlich rot wird.
    expect(r.reason).toBe('Geschütztes Element betroffen: x');
  });

  test('verweigert bei geschuetzter Zielbahn', () => {
    // Anders als bei den geschuetzten Knoten oben: hier ist nicht die AKTUELLE
    // Bahn des Knotens geschuetzt, sondern die ZIELbahn. isProtected() allein
    // prueft nur node.lane (die Herkunft) — ohne die eigene Zielbahn-Pruefung
    // in previewRelane liesse sich ein Schritt anstandslos in eine per Policy
    // geschuetzte Bahn hineinschieben.
    const r = previewRelane(lcTwoLanes, { nodeId: 'x', lane: 'B', policy: { protectLanes: ['Entscheidung'] } });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/geschützt/i);
    expect(r.reason).toMatch(/zielbahn/i);
  });

  test('verweigert, wenn der Schritt schon in der Zielbahn liegt', () => {
    const r = previewRelane(lcTwoLanes, { nodeId: 'x', lane: 'A' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/bereits/i);
  });

  test('verweigert bei geschuetzter AKTUELLER Bahn in einem Format-B-only-Modell ' +
       '(Lane.nodeIds, kein node.lane)', () => {
    // Regressionstest fuer den urspruenglichen Fehler: isProtected() las nur
    // node.lane. In einem Modell, das die Lane-Zuordnung ausschliesslich ueber
    // Lane.nodeIds ausdrueckt (kein node.lane gesetzt), fand isProtected keine
    // Bahn fuer 'x' und protectLanes lief ins Leere — previewRelane haette
    // 'full' gemeldet und den Schritt aus einer als geschuetzt zugesagten Bahn
    // herausverschoben, ohne das jemals zu melden.
    const formatBOnly = {
      id: 'P',
      nodes: [
        { id: 's', type: 'startEvent' },
        { id: 'x', type: 'userTask', name: 'Fall prüfen' },
        { id: 'e', type: 'endEvent' },
      ],
      edges: [
        { id: 'h0', source: 's', target: 'x' },
        { id: 'h1', source: 'x', target: 'e' },
      ],
      lanes: [{ id: 'A', name: 'Vorpruefung', nodeIds: ['s', 'x'] },
              { id: 'B', name: 'Entscheidung', nodeIds: ['e'] }],
    };
    const node = formatBOnly.nodes.find(n => n.id === 'x');
    expect(node.lane).toBeUndefined();
    const r = previewRelane(formatBOnly, { nodeId: 'x', lane: 'B',
                                           policy: { protectLanes: ['Vorpruefung'] } });
    expect(r.feasible).toBe('none');
    // Exakte Nachricht pruefen (nicht nur "irgendwas mit 'geschützt'"), damit
    // der Test wirklich beweist, dass der geschuetzte KNOTEN (aktuelle Bahn)
    // den Ausschlag gab — previewRelane hat eine separate, textlich andere
    // Meldung fuer eine geschuetzte ZIELbahn (siehe Test oben).
    expect(r.reason).toBe('Geschütztes Element betroffen: x');
  });

  test('verschiebt den Schritt und bleibt sound', () => {
    const r = applyRelane(lcTwoLanes, { nodeId: 'x', lane: 'B' });
    expect(r.lc.nodes.find(n => n.id === 'x').lane).toBe('B');
    expect(checkGate(r.lc).ok).toBe(true);
    expect(r.change.transform).toBe('relane');
    expect(r.change.targets).toEqual(['x']);
    expect(r.change.added).toEqual([]);
    expect(r.change.removed).toEqual([]);
    // "modified": 'x' behaelt seine ID, aber sein Inhalt (lane) hat sich
    // geaendert — er taucht in added/removed nicht auf, muss aber trotzdem
    // aus den drei Arrays rekonstruierbar sein.
    expect(r.change.modified).toEqual(['x']);
  });

  test('apply mutiert die Eingabe nicht', () => {
    const before = JSON.stringify(lcTwoLanes);
    applyRelane(lcTwoLanes, { nodeId: 'x', lane: 'B' });
    expect(JSON.stringify(lcTwoLanes)).toBe(before);
  });

  test('pflegt auch das zweite Zuordnungsformat (Lane.nodeIds), wenn beide Formate vorliegen', () => {
    const formatB = {
      ...lcTwoLanes,
      lanes: [{ id: 'A', name: 'Vorpruefung', nodeIds: ['s', 'x'] },
              { id: 'B', name: 'Entscheidung', nodeIds: ['e'] }],
    };
    const r = applyRelane(formatB, { nodeId: 'x', lane: 'B' });
    const a = r.lc.lanes.find(l => l.id === 'A');
    const b = r.lc.lanes.find(l => l.id === 'B');
    expect(a.nodeIds).not.toContain('x');
    expect(a.nodeIds).toEqual(['s']);
    expect(b.nodeIds).toContain('x');
    expect(b.nodeIds).toEqual(['e', 'x']);
    // Format A bleibt ebenfalls gepflegt — beide Formate muessen nach dem
    // Eingriff konsistent sein, nicht nur eines von beiden.
    expect(r.lc.nodes.find(n => n.id === 'x').lane).toBe('B');
    // Beide Lane-Objekte haben ihren Inhalt (nodeIds) geaendert und muessen
    // daher in "modified" auftauchen, zusaetzlich zum verschobenen Knoten.
    expect(r.change.modified).toEqual(expect.arrayContaining(['x', 'A', 'B']));
    expect(r.change.modified.length).toBe(3);
    expect(checkGate(r.lc).ok).toBe(true);
  });

  test('funktioniert auch, wenn NUR Format B (Lane.nodeIds) genutzt wird — kein node.lane gesetzt', () => {
    // Kritischer Fall laut Vorgabe: das Schema erlaubt die Zuordnung ueber
    // Lane.nodeIds OHNE node.lane. Wer die aktuelle Bahn nur ueber node.lane
    // bestimmt, wuerde hier "keine Bahn" sehen und die "liegt bereits dort"-
    // Pruefung sowie die Uebergabe-Zaehlung falsch auswerten.
    const formatBOnly = {
      id: 'P',
      nodes: [
        { id: 's', type: 'startEvent' },
        { id: 'x', type: 'userTask', name: 'Fall prüfen' },
        { id: 'e', type: 'endEvent' },
      ],
      edges: [
        { id: 'h0', source: 's', target: 'x' },
        { id: 'h1', source: 'x', target: 'e' },
      ],
      lanes: [{ id: 'A', name: 'Vorpruefung', nodeIds: ['s', 'x'] },
              { id: 'B', name: 'Entscheidung', nodeIds: ['e'] }],
    };

    // "bereits in dieser Bahn" muss auch ueber Format B erkannt werden.
    const already = previewRelane(formatBOnly, { nodeId: 'x', lane: 'A' });
    expect(already.feasible).toBe('none');
    expect(already.reason).toMatch(/bereits/i);

    const r = applyRelane(formatBOnly, { nodeId: 'x', lane: 'B' });
    expect(r.lc.lanes.find(l => l.id === 'A').nodeIds).toEqual(['s']);
    expect(r.lc.lanes.find(l => l.id === 'B').nodeIds).toEqual(['e', 'x']);
    // apply schreibt zusaetzlich Format A fort, auch wenn das Ausgangsmodell
    // es nie genutzt hat — nach dem Eingriff sind beide Formate konsistent.
    expect(r.lc.nodes.find(n => n.id === 'x').lane).toBe('B');
    expect(checkGate(r.lc).ok).toBe(true);
  });

  test('weist die Veraenderung der Uebergaben aus, auch wenn sie steigt', () => {
    // s, x, e liegen alle in Bahn A; Bahn B ist (noch) leer. Vorher also 0
    // Uebergaben. Wird 'x' allein nach B verschoben, werden BEIDE angrenzenden
    // Kanten (s->x und x->e) zu Bahnwechseln: die Uebergaben steigen von 0 auf 2.
    const lcAllOneLane = {
      id: 'P',
      nodes: [
        { id: 's', type: 'startEvent', lane: 'A' },
        { id: 'x', type: 'userTask', name: 'Fall prüfen', lane: 'A' },
        { id: 'e', type: 'endEvent', lane: 'A' },
      ],
      edges: [
        { id: 'h0', source: 's', target: 'x' },
        { id: 'h1', source: 'x', target: 'e' },
      ],
      lanes: [{ id: 'A', name: 'Vorpruefung' }, { id: 'B', name: 'Entscheidung' }],
    };
    const r = applyRelane(lcAllOneLane, { nodeId: 'x', lane: 'B' });
    expect(typeof r.change.handoffsBefore).toBe('number');
    expect(typeof r.change.handoffsAfter).toBe('number');
    expect(r.change.handoffsBefore).toBe(0);
    expect(r.change.handoffsAfter).toBe(2);
    expect(r.change.handoffsAfter).toBeGreaterThan(r.change.handoffsBefore);
  });
});

// Fixture aus der Aufgabenstellung — wortgleich übernommen, damit die drei
// dort vorgegebenen Testfälle 1:1 nachvollziehbar bleiben.
const lcKo = {
  id: 'P',
  nodes: [
    { id: 's', type: 'startEvent', lane: 'L' },
    { id: 'g1', type: 'exclusiveGateway', name: 'Vollständig?', lane: 'L' },
    { id: 'r1', type: 'endEvent', name: 'Abgelehnt', marker: 'terminate', lane: 'L' },
    { id: 'g2', type: 'exclusiveGateway', name: 'Zulässig?', lane: 'L' },
    { id: 'r2', type: 'endEvent', name: 'Fehler', marker: 'error', lane: 'L' },
    { id: 't', type: 'userTask', name: 'Antrag bearbeiten', lane: 'L' },
    { id: 'e', type: 'endEvent', name: 'Fertig', lane: 'L' },
  ],
  edges: [
    { id: 'k0', source: 's', target: 'g1' },
    { id: 'k1', source: 'g1', target: 'r1', label: 'Nein' },
    { id: 'k2', source: 'g1', target: 'g2', label: 'Ja' },
    { id: 'k3', source: 'g2', target: 'r2', label: 'Nein' },
    { id: 'k4', source: 'g2', target: 't', label: 'Ja' },
    { id: 'k5', source: 't', target: 'e' },
  ],
  lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
};

describe('reorderKnockouts', () => {
  test('verweigert ohne uebergebene Reihenfolge und erfindet keine', () => {
    const r = previewReorderKnockouts(lcKo, { gatewayIds: ['g1', 'g2'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/reihenfolge/i);
  });

  test('verweigert, wenn die Reihenfolge keine Permutation ist', () => {
    const r = previewReorderKnockouts(lcKo, { gatewayIds: ['g1', 'g2'], order: ['g2', 'g3'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/permutation/i);
  });

  test('dreht die Reihenfolge, behaelt Labels und bleibt sound', () => {
    const r = applyReorderKnockouts(lcKo, { gatewayIds: ['g1', 'g2'], order: ['g2', 'g1'] });
    const firstEdge = r.lc.edges.find(e => e.source === 's');
    expect(firstEdge.target).toBe('g2');
    const rejectG2 = r.lc.edges.find(e => e.source === 'g2' && e.target === 'r2');
    expect(rejectG2.label).toBe('Nein');
    expect(checkGate(r.lc).ok).toBe(true);

    // g1's eigenes Ablehn-Label bleibt ebenfalls an g1 haengen, unabhaengig
    // von seiner neuen Position in der Kette.
    const rejectG1 = r.lc.edges.find(e => e.source === 'g1' && e.target === 'r1');
    expect(rejectG1.label).toBe('Nein');

    // Die neue Kette: s -> g2 (Nein->r2 / Ja weiter) -> g1 (Nein->r1 / Ja weiter) -> t -> e.
    const g2Cont = r.lc.edges.find(e => e.source === 'g2' && e.target !== 'r2');
    expect(g2Cont.target).toBe('g1');
    expect(g2Cont.label).toBe('Ja');
    const g1Cont = r.lc.edges.find(e => e.source === 'g1' && e.target !== 'r1');
    expect(g1Cont.target).toBe('t');
    expect(g1Cont.label).toBe('Ja');

    expect(r.change.transform).toBe('reorderKnockouts');
    expect(r.change.targets).toEqual(['g2', 'g1']);
    expect(r.change.added).toEqual([]);
    expect(r.change.removed).toEqual([]);
    // "modified": die IDs bleiben gleich (k0, k2, k4), nur source/target bzw.
    // target wurden umgehaengt — sie muessen vollstaendig verzeichnet sein,
    // sonst waere die Zusage "added/removed/modified nennen jeden Unterschied"
    // fuer genau diese drei Kanten verletzt.
    expect(r.change.modified).toEqual(expect.arrayContaining(['k0', 'k2', 'k4']));
    expect(r.change.modified.length).toBe(3);
  });

  test('preview verweigert bei weniger als zwei Prüfungen', () => {
    const r = previewReorderKnockouts(lcKo, { gatewayIds: ['g1'], order: ['g1'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/mindestens zwei/i);
  });

  test('preview verweigert bei unbekannter Kennung', () => {
    const r = previewReorderKnockouts(lcKo, { gatewayIds: ['g1', 'gibtsnicht'], order: ['gibtsnicht', 'g1'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/unbekannt/i);
  });

  test('preview verweigert, wenn ein Knoten kein exklusives Gateway ist', () => {
    const withTask = { ...lcKo, nodes: lcKo.nodes.map(n => n.id === 'g2' ? { ...n, type: 'userTask' } : n) };
    const r = previewReorderKnockouts(withTask, { gatewayIds: ['g1', 'g2'], order: ['g2', 'g1'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/exklusiv/i);
  });

  test('preview verweigert bei geschuetztem Element', () => {
    const r = previewReorderKnockouts(lcKo, { gatewayIds: ['g1', 'g2'], order: ['g2', 'g1'],
                                              policy: { protectNodes: ['g1'] } });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/geschützt/i);
  });

  test('preview verweigert, wenn die uebergebene Reihenfolge bereits der aktuellen entspricht', () => {
    const r = previewReorderKnockouts(lcKo, { gatewayIds: ['g1', 'g2'], order: ['g1', 'g2'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/bereits/i);
  });

  test('preview verweigert, wenn ein Gateway keinen Fortsetzungspfad hat ' +
       '(alle Zweige enden in einem Ausnahme-Ende) — Regression fuer den TypeError-Fall', () => {
    // g2 hat ZWEI ausgehende Kanten, beide zu Ausnahme-Enden (marker 'error').
    // contEdge(g2) faende in der urspruenglichen Skizze keine Kante und liefert
    // undefined; ein direkter .target-Zugriff darauf wuerde einen TypeError
    // werfen statt sauber zu verweigern. previewReorderKnockouts muss das VOR
    // jedem .target-Zugriff abfangen — applyReorderKnockouts ebenso, da apply
    // preview intern aufruft und dessen Verweigerung respektieren muss.
    const lcAllReject = {
      id: 'P',
      nodes: [
        { id: 's', type: 'startEvent', lane: 'L' },
        { id: 'g1', type: 'exclusiveGateway', name: 'Vollständig?', lane: 'L' },
        { id: 'r1', type: 'endEvent', name: 'Abgelehnt', marker: 'terminate', lane: 'L' },
        { id: 'g2', type: 'exclusiveGateway', name: 'Zulässig?', lane: 'L' },
        { id: 'r2a', type: 'endEvent', name: 'Fehler A', marker: 'error', lane: 'L' },
        { id: 'r2b', type: 'endEvent', name: 'Fehler B', marker: 'error', lane: 'L' },
      ],
      edges: [
        { id: 'k0', source: 's', target: 'g1' },
        { id: 'k1', source: 'g1', target: 'r1', label: 'Nein' },
        { id: 'k2', source: 'g1', target: 'g2', label: 'Ja' },
        { id: 'k3', source: 'g2', target: 'r2a', label: 'Nein' },
        { id: 'k4', source: 'g2', target: 'r2b', label: 'Ja' },
      ],
      lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
    };
    const r = previewReorderKnockouts(lcAllReject, { gatewayIds: ['g1', 'g2'], order: ['g2', 'g1'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/fortsetzungspfad/i);
    expect(r.reason).toMatch(/g2/);

    // apply muss ebenfalls sauber verweigern (werfen), nicht mit TypeError abstuerzen.
    expect(() => applyReorderKnockouts(lcAllReject, { gatewayIds: ['g1', 'g2'], order: ['g2', 'g1'] }))
      .toThrow(/fortsetzungspfad/i);
  });

  test('preview verweigert bei mehrdeutigem Fortsetzungspfad (mehr als eine Nicht-Ausnahme-Kante)', () => {
    // g2 hat zwei ausgehende Kanten, die BEIDE keine Ausnahme-Enden sind
    // (zwei Aufgaben) — welche davon die "Weiter"-Kante ist, ist nicht
    // eindeutig bestimmbar, ohne selbst ein fachliches Urteil zu faellen.
    const lcAmbiguous = {
      id: 'P',
      nodes: [
        { id: 's', type: 'startEvent', lane: 'L' },
        { id: 'g1', type: 'exclusiveGateway', name: 'Vollständig?', lane: 'L' },
        { id: 'r1', type: 'endEvent', name: 'Abgelehnt', marker: 'terminate', lane: 'L' },
        { id: 'g2', type: 'exclusiveGateway', name: 'Zulässig?', lane: 'L' },
        { id: 't', type: 'userTask', name: 'Antrag bearbeiten', lane: 'L' },
        { id: 't2', type: 'userTask', name: 'Sonderfall bearbeiten', lane: 'L' },
      ],
      edges: [
        { id: 'k0', source: 's', target: 'g1' },
        { id: 'k1', source: 'g1', target: 'r1', label: 'Nein' },
        { id: 'k2', source: 'g1', target: 'g2', label: 'Ja' },
        { id: 'k3', source: 'g2', target: 't', label: 'Ja' },
        { id: 'k4', source: 'g2', target: 't2', label: 'Sonderfall' },
      ],
      lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
    };
    const r = previewReorderKnockouts(lcAmbiguous, { gatewayIds: ['g1', 'g2'], order: ['g2', 'g1'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/mehr als einen möglichen fortsetzungspfad/i);
  });

  test('preview verweigert, wenn die angegebenen Pruefungen keine zusammenhaengende Kette bilden', () => {
    // g1s Weiter-Kante zeigt auf einen Zwischenschritt 'z', nicht direkt auf
    // g2 — die beiden Gateways sind zwar beide gueltige Knock-outs, aber
    // NICHT in der behaupteten Reihenfolge miteinander verkettet.
    const lcNotChained = {
      id: 'P',
      nodes: [
        { id: 's', type: 'startEvent', lane: 'L' },
        { id: 'g1', type: 'exclusiveGateway', name: 'Vollständig?', lane: 'L' },
        { id: 'r1', type: 'endEvent', name: 'Abgelehnt', marker: 'terminate', lane: 'L' },
        { id: 'z', type: 'userTask', name: 'Zwischenschritt', lane: 'L' },
        { id: 'g2', type: 'exclusiveGateway', name: 'Zulässig?', lane: 'L' },
        { id: 'r2', type: 'endEvent', name: 'Fehler', marker: 'error', lane: 'L' },
        { id: 't', type: 'userTask', name: 'Antrag bearbeiten', lane: 'L' },
        { id: 'e', type: 'endEvent', name: 'Fertig', lane: 'L' },
      ],
      edges: [
        { id: 'k0', source: 's', target: 'g1' },
        { id: 'k1', source: 'g1', target: 'r1', label: 'Nein' },
        { id: 'k2', source: 'g1', target: 'z', label: 'Ja' },
        { id: 'kz', source: 'z', target: 'g2' },
        { id: 'k3', source: 'g2', target: 'r2', label: 'Nein' },
        { id: 'k4', source: 'g2', target: 't', label: 'Ja' },
        { id: 'k5', source: 't', target: 'e' },
      ],
      lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
    };
    const r = previewReorderKnockouts(lcNotChained, { gatewayIds: ['g1', 'g2'], order: ['g2', 'g1'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/zusammenhängende kette/i);
  });

  test('preview verweigert bei Fan-in am Kettenanfang (mehr als ein Einstieg von aussen)', () => {
    // Regression analog zu applyParallelize (Commit bd25f60): eine zweite
    // eingehende Kante am ersten Kettenmitglied darf nicht stillschweigend
    // ignoriert werden — sonst haengt apply per .find() nur die zuerst
    // gefundene Kante um und die zweite bleibt am alten Platz haengen.
    const lcFanIn = {
      ...lcKo,
      nodes: [...lcKo.nodes, { id: 'w', type: 'userTask', name: 'Vorschritt', lane: 'L' }],
      edges: [...lcKo.edges, { id: 'kw', source: 'w', target: 'g1' }],
    };
    const r = previewReorderKnockouts(lcFanIn, { gatewayIds: ['g1', 'g2'], order: ['g2', 'g1'] });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/mehr als einen einstieg/i);
  });

  test('apply mutiert die Eingabe nicht', () => {
    const before = JSON.stringify(lcKo);
    applyReorderKnockouts(lcKo, { gatewayIds: ['g1', 'g2'], order: ['g2', 'g1'] });
    expect(JSON.stringify(lcKo)).toBe(before);
  });

  test('apply ist deterministisch', () => {
    const r1 = applyReorderKnockouts(lcKo, { gatewayIds: ['g1', 'g2'], order: ['g2', 'g1'] });
    const r2 = applyReorderKnockouts(lcKo, { gatewayIds: ['g1', 'g2'], order: ['g2', 'g1'] });
    expect(JSON.stringify(r1.lc)).toBe(JSON.stringify(r2.lc));
  });

  test('bewahrt die Standardfluss-Markierung (isDefault) an der umgehaengten Kante', () => {
    const lcDefault = { ...lcKo, edges: lcKo.edges.map(e => e.id === 'k4' ? { ...e, isDefault: true } : e) };
    const r = applyReorderKnockouts(lcDefault, { gatewayIds: ['g1', 'g2'], order: ['g2', 'g1'] });
    // k4 war g2s Weiter-Kante (ehemals g2->t) und zeigt nach dem Dreh auf g1;
    // isDefault muss an der Kante (id k4) haengen bleiben, nicht verloren gehen.
    const k4After = r.lc.edges.find(e => e.id === 'k4');
    expect(k4After.isDefault).toBe(true);
    expect(k4After.target).toBe('g1');
    expect(checkGate(r.lc).ok).toBe(true);
  });

  test('dreht eine dreigliedrige Kette korrekt (mittleres Element betroffen)', () => {
    const lcKo3 = {
      id: 'P',
      nodes: [
        { id: 's', type: 'startEvent', lane: 'L' },
        { id: 'g1', type: 'exclusiveGateway', name: 'Vollständig?', lane: 'L' },
        { id: 'r1', type: 'endEvent', name: 'Abgelehnt 1', marker: 'terminate', lane: 'L' },
        { id: 'g2', type: 'exclusiveGateway', name: 'Zulässig?', lane: 'L' },
        { id: 'r2', type: 'endEvent', name: 'Abgelehnt 2', marker: 'terminate', lane: 'L' },
        { id: 'g3', type: 'exclusiveGateway', name: 'Budget vorhanden?', lane: 'L' },
        { id: 'r3', type: 'endEvent', name: 'Abgelehnt 3', marker: 'terminate', lane: 'L' },
        { id: 't', type: 'userTask', name: 'Antrag bearbeiten', lane: 'L' },
        { id: 'e', type: 'endEvent', name: 'Fertig', lane: 'L' },
      ],
      edges: [
        { id: 'k0', source: 's', target: 'g1' },
        { id: 'k1', source: 'g1', target: 'r1', label: 'Nein' },
        { id: 'k2', source: 'g1', target: 'g2', label: 'Ja' },
        { id: 'k3', source: 'g2', target: 'r2', label: 'Nein' },
        { id: 'k4', source: 'g2', target: 'g3', label: 'Ja' },
        { id: 'k5', source: 'g3', target: 'r3', label: 'Nein' },
        { id: 'k6', source: 'g3', target: 't', label: 'Ja' },
        { id: 'k7', source: 't', target: 'e' },
      ],
      lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
    };
    const r = applyReorderKnockouts(lcKo3, { gatewayIds: ['g1', 'g2', 'g3'], order: ['g2', 'g1', 'g3'] });
    expect(checkGate(r.lc).ok).toBe(true);
    expect(r.change.targets).toEqual(['g2', 'g1', 'g3']);

    // Neue Kette: s -> g2 -> g1 -> g3 -> t -> e; jedes Gateway behaelt sein
    // eigenes Ablehn-Label, unabhaengig von seiner neuen Position.
    const first = r.lc.edges.find(e => e.source === 's');
    expect(first.target).toBe('g2');
    const g2Cont = r.lc.edges.find(e => e.source === 'g2' && e.target !== 'r2');
    expect(g2Cont.target).toBe('g1');
    expect(g2Cont.label).toBe('Ja');
    const g1Cont = r.lc.edges.find(e => e.source === 'g1' && e.target !== 'r1');
    expect(g1Cont.target).toBe('g3');
    expect(g1Cont.label).toBe('Ja');
    const g3Cont = r.lc.edges.find(e => e.source === 'g3' && e.target !== 'r3');
    expect(g3Cont.target).toBe('t');
    expect(g3Cont.label).toBe('Ja');

    // Ablehn-Kanten bleiben unveraendert an ihrem jeweiligen Gateway haengen.
    expect(r.lc.edges.find(e => e.source === 'g1' && e.target === 'r1').label).toBe('Nein');
    expect(r.lc.edges.find(e => e.source === 'g2' && e.target === 'r2').label).toBe('Nein');
    expect(r.lc.edges.find(e => e.source === 'g3' && e.target === 'r3').label).toBe('Nein');

    // "modified": Einstiegskante (k0) plus die drei Weiter-Kanten (k4, k2,
    // k6) — k6 aendert seinen Wert dabei nicht wirklich (g3 bleibt letztes
    // Kettenmitglied, zeigt vorher wie nachher auf 't'), zaehlt aber wie bei
    // applyParallelize/applyMergeTasks als angefasste Kante, weil sie
    // programmatisch angefasst wird.
    expect(r.change.modified).toEqual(expect.arrayContaining(['k0', 'k4', 'k2', 'k6']));
    expect(r.change.modified.length).toBe(4);
  });
});

// Fixture aus der Aufgabenstellung — wortgleich übernommen.
const lcExc = {
  id: 'P',
  nodes: [
    { id: 's', type: 'startEvent', lane: 'L' },
    { id: 'task', type: 'userTask', name: 'Antrag prüfen', lane: 'L' },
    { id: 'gw', type: 'exclusiveGateway', name: 'Frist überschritten?', lane: 'L' },
    { id: 'xend', type: 'endEvent', name: 'Fall eskaliert', lane: 'L' },
    { id: 'e', type: 'endEvent', name: 'Fertig', lane: 'L' },
  ],
  edges: [
    { id: 'j0', source: 's', target: 'task' },
    { id: 'j1', source: 'task', target: 'gw' },
    { id: 'j2', source: 'gw', target: 'xend', label: 'Ja' },
    { id: 'j3', source: 'gw', target: 'e', label: 'Nein' },
  ],
  lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
};

// Reviewer-Repro fuer den Critical-Fund: ein Ausnahme-Ende, das sich ZWEI
// unabhaengige Aufgaben (task1, task2) mit je eigenem Gateway teilen — ein
// realistisches Muster, denn genau dafuer gibt es ueberhaupt einen separaten
// End-Knoten statt eines pro Aufgabe. task1s "Nein"-Zweig fuehrt zu task2,
// dessen eigenes Gateway (gw2) ebenfalls in xend muendet.
const lcSharedExc = {
  id: 'P',
  nodes: [
    { id: 's', type: 'startEvent', lane: 'L' },
    { id: 'task1', type: 'userTask', name: 'Antrag prüfen', lane: 'L' },
    { id: 'gw1', type: 'exclusiveGateway', name: 'Frist 1 überschritten?', lane: 'L' },
    { id: 'task2', type: 'userTask', name: 'Freigabe erteilen', lane: 'L' },
    { id: 'gw2', type: 'exclusiveGateway', name: 'Frist 2 überschritten?', lane: 'L' },
    { id: 'xend', type: 'endEvent', name: 'Fall eskaliert', lane: 'L' },
    { id: 'e2', type: 'endEvent', name: 'Fertig', lane: 'L' },
  ],
  edges: [
    { id: 'j0', source: 's', target: 'task1' },
    { id: 'j1', source: 'task1', target: 'gw1' },
    { id: 'j2', source: 'gw1', target: 'xend', label: 'Ja' },
    { id: 'j3', source: 'gw1', target: 'task2', label: 'Nein' },
    { id: 'j4', source: 'task2', target: 'gw2' },
    { id: 'j5', source: 'gw2', target: 'xend', label: 'Ja' },
    { id: 'j6', source: 'gw2', target: 'e2', label: 'Nein' },
  ],
  lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
};

// Host, dessen EIGENER Ausnahme-Pfad über eine Zwischen-Aufgabe läuft
// ("Vorgesetzten benachrichtigen"), bevor er das Ausnahme-Ende erreicht — die
// Zwischen-Aufgabe entscheidet per eigenem Gateway (gw2), ob die Eskalation
// bestätigt wird oder sich doch erledigt hat (gw2 braucht zwei Zweige, sonst
// bliebe 'notify' nach dem Herausnehmen ohne jeden ausgehenden Fluss zurück —
// ein durch Guard 1 zu Recht verweigerter, DAVON UNABHÄNGIGER Sackgassen-Fall,
// siehe den "Sackgasse"-Test oben). Die frühere BFS-Heuristik
// (hostExceptionEdges) brach an JEDEM fremden Aufgaben-Knoten ab — auch wenn
// dieser Knoten in Wahrheit Teil des HOST-eigenen Pfades war ('notify' ist
// keine fremde Aufgabe) — und erreichte j5 (gw2 -> xend) deshalb nie: der
// Eingriff wurde faelschlich verweigert, obwohl der Pfad eindeutig zu 'task'
// gehoert. Mit edgeIds ist das kein Rate-Problem mehr.
const lcExcViaIntermediateTask = {
  id: 'P',
  nodes: [
    { id: 's', type: 'startEvent', lane: 'L' },
    { id: 'task', type: 'userTask', name: 'Antrag prüfen', lane: 'L' },
    { id: 'gw', type: 'exclusiveGateway', name: 'Frist überschritten?', lane: 'L' },
    { id: 'notify', type: 'userTask', name: 'Vorgesetzten benachrichtigen', lane: 'L' },
    { id: 'gw2', type: 'exclusiveGateway', name: 'Eskalation bestätigt?', lane: 'L' },
    { id: 'xend', type: 'endEvent', name: 'Fall eskaliert', lane: 'L' },
    { id: 'e', type: 'endEvent', name: 'Fertig', lane: 'L' },
    { id: 'e2', type: 'endEvent', name: 'Doch erledigt', lane: 'L' },
  ],
  edges: [
    { id: 'j0', source: 's', target: 'task' },
    { id: 'j1', source: 'task', target: 'gw' },
    { id: 'j2', source: 'gw', target: 'notify', label: 'Ja' },
    { id: 'j3', source: 'gw', target: 'e', label: 'Nein' },
    { id: 'j4', source: 'notify', target: 'gw2' },
    { id: 'j5', source: 'gw2', target: 'xend', label: 'Bestätigt' },
    { id: 'j6', source: 'gw2', target: 'e2', label: 'Doch ok' },
  ],
  lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
};

// Ein Host mit ZWEI verschachtelten, ausschliesslich ihm gehoerenden
// Ausnahme-Zweigen zum selben Ende — beide muessen entfernt werden.
const lcHostMultiExc = {
  id: 'P',
  nodes: [
    { id: 's', type: 'startEvent', lane: 'L' },
    { id: 'task', type: 'userTask', name: 'Antrag prüfen', lane: 'L' },
    { id: 'gwA', type: 'exclusiveGateway', name: 'Prüfung A fehlgeschlagen?', lane: 'L' },
    { id: 'gwB', type: 'exclusiveGateway', name: 'Prüfung B fehlgeschlagen?', lane: 'L' },
    { id: 'xend', type: 'endEvent', name: 'Fall eskaliert', lane: 'L' },
    { id: 'e', type: 'endEvent', name: 'Fertig', lane: 'L' },
  ],
  edges: [
    { id: 'j0', source: 's', target: 'task' },
    { id: 'j1', source: 'task', target: 'gwA' },
    { id: 'j2', source: 'gwA', target: 'xend', label: 'Ja' },
    { id: 'j3', source: 'gwA', target: 'gwB', label: 'Nein' },
    { id: 'j4', source: 'gwB', target: 'xend', label: 'Ja' },
    { id: 'j5', source: 'gwB', target: 'e', label: 'Nein' },
  ],
  lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
};

describe('isolateException', () => {
  test('verweigert ohne ausdrueckliche Semantik-Parameter', () => {
    const r = previewIsolateException(lcExc, { endId: 'xend', attachTo: 'task' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/marker/i);
  });

  test('leitet die Semantik nicht aus dem Namen ab', () => {
    const r = previewIsolateException(lcExc, { endId: 'xend', attachTo: 'task', marker: null });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/marker/i);
  });

  test('verweigert bei ungueltigem Marker (nicht Teil der OMG-Boundary-Event-Typen)', () => {
    const r = previewIsolateException(lcExc, { endId: 'xend', attachTo: 'task',
                                               marker: 'irgendwas', cancelActivity: true });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/marker/i);
  });

  test('verweigert ohne cancelActivity — auch das ist Pflicht, kein Default', () => {
    const r = previewIsolateException(lcExc, { endId: 'xend', attachTo: 'task', marker: 'timer' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/cancelactivity/i);
  });

  test('verweigert bei nicht-booleschem cancelActivity — kein Fallback auf truthy/falsy', () => {
    const r = previewIsolateException(lcExc, { endId: 'xend', attachTo: 'task',
                                               marker: 'timer', cancelActivity: 'ja' });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/cancelactivity/i);
  });

  test('verweigert bei unbekannter End-Kennung', () => {
    const r = previewIsolateException(lcExc, { endId: 'gibtsnicht', attachTo: 'task',
                                               marker: 'timer', cancelActivity: true });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/unbekannt/i);
  });

  test('verweigert, wenn das Ziel kein End-Ereignis ist', () => {
    const r = previewIsolateException(lcExc, { endId: 'gw', attachTo: 'task',
                                               marker: 'timer', cancelActivity: true });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/end-ereignis/i);
  });

  test('verweigert bei unbekannter Aufgabe', () => {
    const r = previewIsolateException(lcExc, { endId: 'xend', attachTo: 'gibtsnicht',
                                               marker: 'timer', cancelActivity: true });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/unbekannt/i);
  });

  test('verweigert, wenn attachTo kein Aufgaben-Typ ist (z.B. ein Gateway)', () => {
    const r = previewIsolateException(lcExc, { endId: 'xend', attachTo: 'gw',
                                               marker: 'timer', cancelActivity: true });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/aufgaben/i);
  });

  test('verweigert bei geschuetztem Host', () => {
    const r = previewIsolateException(lcExc, { endId: 'xend', attachTo: 'task',
                                               marker: 'timer', cancelActivity: true,
                                               policy: { protectNodes: ['task'] } });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/geschützt/i);
  });

  test('verweigert bei geschuetztem Ausnahme-Ende', () => {
    const r = previewIsolateException(lcExc, { endId: 'xend', attachTo: 'task',
                                               marker: 'timer', cancelActivity: true,
                                               policy: { protectNodes: ['xend'] } });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/geschützt/i);
  });

  test('haengt die Ausnahme als Boundary-Event an und bleibt sound', () => {
    const r = applyIsolateException(lcExc, { endId: 'xend', attachTo: 'task',
                                             marker: 'timer', cancelActivity: true });
    const bnd = r.lc.nodes.find(n => n.type === 'boundaryEvent');
    expect(bnd.attachedTo).toBe('task');
    expect(bnd.marker).toBe('timer');
    expect(bnd.cancelActivity).toBe(true);
    expect(checkGate(r.lc).ok).toBe(true);
    expect(r.change.added).toContain(bnd.id);

    // Inhalte pruefen, nicht nur Laengen: genau die alte Kante zum Ausnahme-
    // Ende (j2) verschwindet, genau eine neue Kante vom Boundary-Event zum
    // unveraendert bestehen bleibenden Ausnahme-Ende (xend) entsteht.
    expect(r.change.removed).toEqual(['j2']);
    const newEdge = r.lc.edges.find(e => e.source === bnd.id);
    expect(newEdge.target).toBe('xend');
    expect(r.change.added).toEqual(expect.arrayContaining([bnd.id, newEdge.id]));
    expect(r.change.added.length).toBe(2);

    // "modified": nichts Bestehendes aendert seinen Inhalt — der Host bleibt
    // unangetastet, keine ueberlebende Kante wird umgehaengt.
    expect(r.change.modified).toEqual([]);

    // gw hat noch eine Kante (die "Nein"-Kante zu 'e') — der urspruengliche
    // Knoten selbst bleibt unveraendert.
    const gwAfter = r.lc.nodes.find(n => n.id === 'gw');
    const gwBefore = lcExc.nodes.find(n => n.id === 'gw');
    expect(gwAfter).toEqual(gwBefore);
    expect(r.lc.edges.filter(e => e.source === 'gw').length).toBe(1);

    // xend selbst bleibt inhaltlich unangetastet (nur seine eingehende Kante
    // wechselt die Quelle).
    const xendAfter = r.lc.nodes.find(n => n.id === 'xend');
    const xendBefore = lcExc.nodes.find(n => n.id === 'xend');
    expect(xendAfter).toEqual(xendBefore);
  });

  test('loest die Bahn ueber currentLaneOf auf, nicht ueber rohes node.lane ' +
       '(Format-B-only-Modell, kein node.lane am Host gesetzt)', () => {
    const formatBOnly = {
      id: 'P',
      nodes: [
        { id: 's', type: 'startEvent' },
        { id: 'task', type: 'userTask', name: 'Antrag prüfen' },
        { id: 'gw', type: 'exclusiveGateway', name: 'Frist überschritten?' },
        { id: 'xend', type: 'endEvent', name: 'Fall eskaliert' },
        { id: 'e', type: 'endEvent', name: 'Fertig' },
      ],
      edges: [
        { id: 'j0', source: 's', target: 'task' },
        { id: 'j1', source: 'task', target: 'gw' },
        { id: 'j2', source: 'gw', target: 'xend', label: 'Ja' },
        { id: 'j3', source: 'gw', target: 'e', label: 'Nein' },
      ],
      lanes: [{ id: 'L', name: 'Sachbearbeiter', nodeIds: ['s', 'task', 'gw', 'xend', 'e'] }],
    };
    expect(formatBOnly.nodes.find(n => n.id === 'task').lane).toBeUndefined();
    const r = applyIsolateException(formatBOnly, { endId: 'xend', attachTo: 'task',
                                                    marker: 'timer', cancelActivity: true });
    const bnd = r.lc.nodes.find(n => n.type === 'boundaryEvent');
    // Ein reines Auslesen von host.lane haette hier `undefined` ergeben — die
    // Bahn muss ueber Lane.nodeIds (Format B) aufgeloest werden.
    expect(bnd.lane).toBe('L');
    expect(checkGate(r.lc).ok).toBe(true);
  });

  test('verweigert, wenn das Herausnehmen eine Quelle ohne jeden ausgehenden Fluss zuruecklaesst ' +
       '(Sackgasse, die S07 nur als WARNUNG erkennt und das Rollback-Gate daher nicht abfaengt)', () => {
    // task's EINZIGE ausgehende Kante fuehrt direkt zum Ausnahme-Ende — task
    // haette nach dem Herausnehmen ueberhaupt keinen "normalen" Fortsetzungspfad
    // mehr. checkGate().ok wuerde das NICHT bemerken (S07 = WARNING), previewIsolateException
    // muss das eigenstaendig verweigern.
    const lcStranded = {
      id: 'P',
      nodes: [
        { id: 's', type: 'startEvent', lane: 'L' },
        { id: 'task', type: 'userTask', name: 'Antrag prüfen', lane: 'L' },
        { id: 'xend', type: 'endEvent', name: 'Fall eskaliert', lane: 'L' },
      ],
      edges: [
        { id: 'j0', source: 's', target: 'task' },
        { id: 'j1', source: 'task', target: 'xend' },
      ],
      lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
    };
    const r = previewIsolateException(lcStranded, { endId: 'xend', attachTo: 'task',
                                                     marker: 'timer', cancelActivity: true });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/sackgasse|ausgehenden fluss/i);
    expect(r.reason).toMatch(/task/);

    // apply muss ebenfalls verweigern (werfen), nicht stillschweigend ein
    // strukturell totes Modell erzeugen.
    expect(() => applyIsolateException(lcStranded, { endId: 'xend', attachTo: 'task',
                                                      marker: 'timer', cancelActivity: true }))
      .toThrow(/sackgasse|ausgehenden fluss/i);
  });

  test('verweigert NICHT, wenn dem Gateway nach dem Herausnehmen genau eine Kante bleibt ' +
       '(Regelfall dieses Eingriffs, kein Sackgassen-Fall)', () => {
    // Gegenprobe zum vorigen Test: gw behaelt nach dem Entfernen von j2 noch
    // j3 (-> e) — das ist der normale, erwuenschte Fall (siehe Haupttest oben)
    // und darf nicht faelschlich als Sackgasse verweigert werden.
    const r = previewIsolateException(lcExc, { endId: 'xend', attachTo: 'task',
                                               marker: 'timer', cancelActivity: true });
    expect(r.feasible).toBe('full');
  });

  test('verweigert, wenn eine Assoziation auf eine der zu entfernenden Kanten zeigt', () => {
    // 'j2' (gw->xend) wuerde entfernt. Eine Assoziation, die 'j2' referenziert
    // (statt eines Knotens — das Schema laesst das syntaktisch zu), wuerde nach
    // dem Eingriff auf eine nicht mehr existierende ID zeigen. Kein S03/S10-
    // Pendant fuer Assoziationen in rules.js faengt das ab, siehe applyMergeTasks'
    // analoge Pruefung.
    const withAssoc = { ...lcExc,
      nodes: [...lcExc.nodes, { id: 'note1', type: 'textAnnotation', name: 'Frist siehe SLA', lane: 'L' }],
      associations: [{ id: 'as1', source: 'j2', target: 'note1', directed: false }] };
    const r = previewIsolateException(withAssoc, { endId: 'xend', attachTo: 'task',
                                                   marker: 'timer', cancelActivity: true });
    expect(r.feasible).toBe('none');
    expect(r.reason).toMatch(/assoziation/i);
    expect(r.reason).toMatch(/as1/);
  });

  test('apply mutiert die Eingabe nicht', () => {
    const before = JSON.stringify(lcExc);
    applyIsolateException(lcExc, { endId: 'xend', attachTo: 'task', marker: 'timer', cancelActivity: true });
    expect(JSON.stringify(lcExc)).toBe(before);
  });

  test('apply ist deterministisch, auch bei der neuen Boundary-Event-Kennung', () => {
    const r1 = applyIsolateException(lcExc, { endId: 'xend', attachTo: 'task', marker: 'timer', cancelActivity: true });
    const r2 = applyIsolateException(lcExc, { endId: 'xend', attachTo: 'task', marker: 'timer', cancelActivity: true });
    expect(JSON.stringify(r1.lc)).toBe(JSON.stringify(r2.lc));
  });

  test('cancelActivity: false wird respektiert (kein impliziter Default auf true)', () => {
    const r = applyIsolateException(lcExc, { endId: 'xend', attachTo: 'task',
                                             marker: 'error', cancelActivity: false });
    const bnd = r.lc.nodes.find(n => n.type === 'boundaryEvent');
    expect(bnd.cancelActivity).toBe(false);
    expect(checkGate(r.lc).ok).toBe(true);
  });

  describe('geteiltes Ausnahme-Ende — edgeIds statt Graph-Heuristik (Round-3-Fund: BFS beanspruchte fremde Kanten am gemeinsamen Gateway)', () => {
    test('ohne edgeIds verweigert previewIsolateException als mehrdeutig und nennt die Kandidaten-IDs', () => {
      const r = previewIsolateException(lcSharedExc, { endId: 'xend', attachTo: 'task1',
                                                        marker: 'timer', cancelActivity: true });
      expect(r.feasible).toBe('none');
      expect(r.reason).toMatch(/mehrdeutig/i);
      expect(r.reason).toMatch(/j2/);
      expect(r.reason).toMatch(/j5/);

      expect(() => applyIsolateException(lcSharedExc, { endId: 'xend', attachTo: 'task1',
                                                         marker: 'timer', cancelActivity: true }))
        .toThrow(/mehrdeutig/i);
    });

    test('edgeIds nennt nur die Kante des Hosts -> Isolieren von task1 entfernt NICHT den unabhängigen Ausnahme-Pfad von task2', () => {
      const r = applyIsolateException(lcSharedExc, { endId: 'xend', attachTo: 'task1',
                                                     marker: 'timer', cancelActivity: true,
                                                     edgeIds: ['j2'] });

      // Nur task1s eigene Kante zum Ausnahme-Ende (j2) wird entfernt — j5
      // (gw2 -> xend, task2s Eskalationspfad) bleibt unangetastet.
      expect(r.change.removed).toEqual(['j2']);
      expect(r.change.removed).not.toContain('j5');
      expect(r.change.targets).toEqual(['xend', 'task1']);

      // gw2 (task2s Gateway) behält BEIDE ursprünglichen Zweige unverändert.
      const gw2Out = r.lc.edges.filter(e => e.source === 'gw2');
      expect(gw2Out.map(e => e.id).sort()).toEqual(['j5', 'j6']);
      expect(gw2Out.find(e => e.id === 'j5').target).toBe('xend');
      expect(gw2Out.find(e => e.id === 'j5').label).toBe('Ja');
      expect(gw2Out.find(e => e.id === 'j6').target).toBe('e2');

      // task2 und gw2 selbst bleiben inhaltlich unverändert.
      expect(r.lc.nodes.find(n => n.id === 'task2'))
        .toEqual(lcSharedExc.nodes.find(n => n.id === 'task2'));
      expect(r.lc.nodes.find(n => n.id === 'gw2'))
        .toEqual(lcSharedExc.nodes.find(n => n.id === 'gw2'));

      // Das neue Boundary-Event hängt an task1, nicht an task2.
      const bnd = r.lc.nodes.find(n => n.type === 'boundaryEvent');
      expect(bnd.attachedTo).toBe('task1');

      // xend hat jetzt genau zwei eingehende Kanten: die neue vom Boundary-
      // Event (task1s isolierter Pfad) und die unveränderte von gw2 (task2s Pfad).
      const xendIn = r.lc.edges.filter(e => e.target === 'xend');
      expect(xendIn.map(e => e.source).sort()).toEqual([bnd.id, 'gw2'].sort());

      expect(checkGate(r.lc).ok).toBe(true);

      // note beschreibt, was tatsächlich geändert wurde (welche Kante entfernt
      // wurde), nicht was faelschlich mitentfernt haette werden koennen.
      expect(r.change.note).toMatch(/j2/);
      expect(r.change.note).not.toMatch(/j5/);
    });

    test('symmetrisch: edgeIds für task2s eigene Kante lässt task1s Ausnahme-Pfad unangetastet', () => {
      const r = applyIsolateException(lcSharedExc, { endId: 'xend', attachTo: 'task2',
                                                     marker: 'error', cancelActivity: true,
                                                     edgeIds: ['j5'] });
      expect(r.change.removed).toEqual(['j5']);
      expect(r.change.removed).not.toContain('j2');

      const gw1Out = r.lc.edges.filter(e => e.source === 'gw1');
      expect(gw1Out.map(e => e.id).sort()).toEqual(['j2', 'j3']);
      expect(gw1Out.find(e => e.id === 'j2').target).toBe('xend');

      const bnd = r.lc.nodes.find(n => n.type === 'boundaryEvent');
      expect(bnd.attachedTo).toBe('task2');
      expect(checkGate(r.lc).ok).toBe(true);
    });

    test('mehrere eingehende Kanten des Ausnahme-Endes, die ALLE zum Host gehören, werden per edgeIds vollständig entfernt', () => {
      const r = applyIsolateException(lcHostMultiExc, { endId: 'xend', attachTo: 'task',
                                                        marker: 'timer', cancelActivity: true,
                                                        edgeIds: ['j2', 'j4'] });
      expect([...r.change.removed].sort()).toEqual(['j2', 'j4']);

      // xend hat danach nur noch die eine neue Kante vom Boundary-Event.
      const xendIn = r.lc.edges.filter(e => e.target === 'xend');
      expect(xendIn.length).toBe(1);
      const bnd = r.lc.nodes.find(n => n.type === 'boundaryEvent');
      expect(xendIn[0].source).toBe(bnd.id);

      // gwA und gwB bleiben mit ihrem jeweils anderen Zweig verbunden.
      expect(r.lc.edges.find(e => e.id === 'j3')).toMatchObject({ source: 'gwA', target: 'gwB' });
      expect(r.lc.edges.find(e => e.id === 'j5')).toMatchObject({ source: 'gwB', target: 'e' });

      expect(checkGate(r.lc).ok).toBe(true);
    });

    test('verweigert, wenn attachTo überhaupt keinen Ausnahme-Pfad zu endId hat ' +
         '(0-Treffer-Fall: nichts zu isolieren, statt stillschweigend nur ein Boundary-Event ohne Wirkung anzuhängen)', () => {
      const lcNoExceptionPath = {
        id: 'P',
        nodes: [
          { id: 's', type: 'startEvent', lane: 'L' },
          { id: 'task', type: 'userTask', name: 'Nur Normalfluss', lane: 'L' },
          { id: 'xend', type: 'endEvent', name: 'Fall eskaliert', lane: 'L' },
          { id: 'e', type: 'endEvent', name: 'Fertig', lane: 'L' },
        ],
        edges: [
          { id: 'j0', source: 's', target: 'task' },
          { id: 'j1', source: 'task', target: 'e' },
        ],
        lanes: [{ id: 'L', name: 'Sachbearbeiter' }],
      };
      const r = previewIsolateException(lcNoExceptionPath, { endId: 'xend', attachTo: 'task',
                                                              marker: 'timer', cancelActivity: true });
      expect(r.feasible).toBe('none');
      expect(r.reason).toMatch(/ausnahme-pfad/i);
      expect(r.reason).toMatch(/task/);

      expect(() => applyIsolateException(lcNoExceptionPath, { endId: 'xend', attachTo: 'task',
                                                               marker: 'timer', cancelActivity: true }))
        .toThrow(/ausnahme-pfad/i);
    });

    test('vormals fälschlich verweigerter Fall: Hosts eigener Ausnahme-Pfad läuft über eine ' +
         'Zwischen-Aufgabe — mit edgeIds gelingt der Eingriff jetzt', () => {
      // Die frühere BFS-Heuristik brach an JEDER fremden Aufgabe ab, auch wenn
      // diese Teil des Host-eigenen Pfades war ('notify' ist keine fremde
      // Aufgabe, sondern der einzige Weg von 'task' zu 'xend') — sie erreichte
      // j5 (gw2 -> xend) deshalb nie und previewIsolateException verweigerte
      // fälschlich mit "kein Ausnahme-Pfad gefunden". Mit explizitem edgeIds
      // gibt es dieses Rate-Problem nicht mehr.
      const pv = previewIsolateException(lcExcViaIntermediateTask, {
        endId: 'xend', attachTo: 'task', marker: 'escalation', cancelActivity: true, edgeIds: ['j5'],
      });
      expect(pv.feasible).toBe('full');

      const r = applyIsolateException(lcExcViaIntermediateTask, {
        endId: 'xend', attachTo: 'task', marker: 'escalation', cancelActivity: true, edgeIds: ['j5'],
      });
      expect(r.change.removed).toEqual(['j5']);
      const bnd = r.lc.nodes.find(n => n.type === 'boundaryEvent');
      expect(bnd.attachedTo).toBe('task');
      expect(bnd.marker).toBe('escalation');
      const newEdge = r.lc.edges.find(e => e.source === bnd.id);
      expect(newEdge.target).toBe('xend');
      // 'notify' und 'gw2' selbst bleiben inhaltlich unangetastet — der
      // Eingriff verschiebt nur die Kante zum Ausnahme-Ende, nicht die
      // Zwischen-Aufgabe oder ihr Gateway. gw2 behält seinen anderen Zweig (j6).
      expect(r.lc.nodes.find(n => n.id === 'notify'))
        .toEqual(lcExcViaIntermediateTask.nodes.find(n => n.id === 'notify'));
      expect(r.lc.nodes.find(n => n.id === 'gw2'))
        .toEqual(lcExcViaIntermediateTask.nodes.find(n => n.id === 'gw2'));
      expect(r.lc.edges.filter(e => e.source === 'gw2').map(e => e.id)).toEqual(['j6']);
      expect(checkGate(r.lc).ok).toBe(true);
    });

    test('edgeIds, die eine Kante nennen, die NICHT auf endId zielt, wird mit konkretem Grund verweigert', () => {
      // 'j1' (task -> gw) existiert, zielt aber nicht auf 'xend' — previewIsolateException
      // darf das nicht stillschweigend ignorieren oder mit dem falschen Kanten
      // arbeiten, sondern muss verweigern und die falsche Kante benennen.
      const r = previewIsolateException(lcExc, { endId: 'xend', attachTo: 'task',
                                                 marker: 'timer', cancelActivity: true,
                                                 edgeIds: ['j1'] });
      expect(r.feasible).toBe('none');
      expect(r.reason).toMatch(/j1/);
      expect(r.reason).toMatch(/zielen nicht auf|xend/i);

      expect(() => applyIsolateException(lcExc, { endId: 'xend', attachTo: 'task',
                                                   marker: 'timer', cancelActivity: true,
                                                   edgeIds: ['j1'] }))
        .toThrow(/j1/);
    });

    test('edgeIds mit unbekannter Kanten-Kennung wird mit konkretem Grund verweigert', () => {
      const r = previewIsolateException(lcExc, { endId: 'xend', attachTo: 'task',
                                                 marker: 'timer', cancelActivity: true,
                                                 edgeIds: ['gibtsnicht'] });
      expect(r.feasible).toBe('none');
      expect(r.reason).toMatch(/gibtsnicht/i);
      expect(r.reason).toMatch(/unbekannt/i);
    });
  });
});

// CLI-Zugang (scripts/redesign-cli.js). Spawnt den echten Prozess (Muster aus
// pipeline.test.js' runCli), um main()s tatsaechliche Verdrahtung zu pruefen:
// Vorschau als Standard, Rueckgabewert bei Verweigerung, und dass die
// Zieldatei in KEINEM Verweigerungsfall entsteht — inklusive der Faelle, in
// denen ein Pflichtparameter (name/order/marker/cancelActivity/edgeIds bei
// Mehrdeutigkeit) schlicht fehlt und die CLI ihn bewusst NICHT defaulted,
// sondern die Verweigerung dem jeweiligen Transform ueberlaesst.
describe('redesign-cli', () => {
  const runCli = async (lc, args) => {
    const { spawnSync } = await import('node:child_process');
    const os = await import('node:os');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redesign-cli-'));
    const inPath = path.join(dir, 'in.json');
    const outPath = path.join(dir, 'out.json');
    fs.writeFileSync(inPath, JSON.stringify(lc), 'utf8');
    const res = spawnSync('node', ['redesign-cli.js', inPath, ...args, '-o', outPath],
                          { cwd: __dirname, encoding: 'utf8' });
    const wrote = fs.existsSync(outPath);
    return {
      status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', wrote,
      readOut: () => JSON.parse(fs.readFileSync(outPath, 'utf8')),
    };
  };

  describe('parallelize', () => {
    test('Vorschau (Standard, kein --apply) schreibt nichts und meldet Machbarkeit', async () => {
      const r = await runCli(lcChain, ['parallelize', '--nodes', 'a,b,c']);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/machbar/i);
      expect(r.wrote).toBe(false);
    });

    test('Verweigerung (keine zusammenhaengende Kette) endet mit Fehler-Rueckgabewert und schreibt nicht', async () => {
      const r = await runCli(lcChain, ['parallelize', '--nodes', 'a,c', '--apply']);
      expect(r.status).not.toBe(0);
      expect(r.wrote).toBe(false);
      expect(r.stderr).toMatch(/zusammenhäng/i);
    });

    test('mit --apply wird das Ergebnis geschrieben (AND-Split/-Join im Output)', async () => {
      const r = await runCli(lcChain, ['parallelize', '--nodes', 'a,b,c', '--apply']);
      expect(r.status).toBe(0);
      expect(r.wrote).toBe(true);
      const out = r.readOut();
      expect(out.nodes.filter(n => n.type === 'parallelGateway').length).toBe(2);
    });

    test('--policy mit geschuetztem Knoten verweigert und schreibt nicht', async () => {
      const r = await runCli(lcChain, ['parallelize', '--nodes', 'a,b,c',
                                       '--policy', JSON.stringify({ protectNodes: ['a'] }), '--apply']);
      expect(r.status).not.toBe(0);
      expect(r.wrote).toBe(false);
      expect(r.stderr).toMatch(/geschützt/i);
    });

    test('ungueltiges --policy-JSON wird als Bedienungsfehler gemeldet, nicht als Absturz', async () => {
      const r = await runCli(lcChain, ['parallelize', '--nodes', 'a,b,c', '--policy', 'kein-json', '--apply']);
      expect(r.status).not.toBe(0);
      expect(r.wrote).toBe(false);
      expect(r.stderr).toMatch(/policy/i);
    });
  });

  describe('mergeTasks', () => {
    test('fehlender Pflichtparameter --name verweigert mit der eigenen Meldung des Transforms, nicht mit einem stillen Default', async () => {
      const r = await runCli(lcMerge, ['mergeTasks', '--nodes', 'm1,m2', '--apply']);
      expect(r.status).not.toBe(0);
      expect(r.wrote).toBe(false);
      expect(r.stderr).toMatch(/name/i);
    });

    test('mit --name wird gebuendelt und geschrieben', async () => {
      const r = await runCli(lcMerge, ['mergeTasks', '--nodes', 'm1,m2',
                                       '--name', 'Daten erfassen und sichern', '--apply']);
      expect(r.status).toBe(0);
      expect(r.wrote).toBe(true);
      const out = r.readOut();
      expect(out.nodes.find(n => n.id === 'm1').name).toBe('Daten erfassen und sichern');
      expect(out.nodes.find(n => n.id === 'm2')).toBeUndefined();
    });

    test('Fund-Reproduktion: --name unmittelbar gefolgt von --apply darf NICHT "--apply" ' +
         'als Namen uebernehmen — mergeTasks muss seine EIGENE "Name fehlt"-Verweigerung ' +
         'auslösen, nicht stillschweigend erfolgreich schreiben', async () => {
      const r = await runCli(lcMerge, ['mergeTasks', '--nodes', 'm1,m2', '--name', '--apply']);
      expect(r.status).not.toBe(0);
      expect(r.wrote).toBe(false);
      expect(r.stderr).toMatch(/name/i);
    });
  });

  describe('relane', () => {
    test('fehlendes --lane verweigert (unbekannte Zielbahn) statt zu erraten', async () => {
      const r = await runCli(lcTwoLanes, ['relane', '--node', 'x', '--apply']);
      expect(r.status).not.toBe(0);
      expect(r.wrote).toBe(false);
      expect(r.stderr).toMatch(/bahn/i);
    });

    test('mit --node und --lane wird verschoben und geschrieben', async () => {
      const r = await runCli(lcTwoLanes, ['relane', '--node', 'x', '--lane', 'B', '--apply']);
      expect(r.status).toBe(0);
      expect(r.wrote).toBe(true);
      const out = r.readOut();
      expect(out.nodes.find(n => n.id === 'x').lane).toBe('B');
    });

    test('Fund-Reproduktion (gleiches Slurping-Muster wie bei --name): --lane unmittelbar ' +
         'gefolgt von --apply darf NICHT "--apply" als Zielbahn uebernehmen — previewRelane ' +
         'muss seine eigene "unbekannte Zielbahn"-Verweigerung auslösen', async () => {
      const r = await runCli(lcTwoLanes, ['relane', '--node', 'x', '--lane', '--apply']);
      expect(r.status).not.toBe(0);
      expect(r.wrote).toBe(false);
      expect(r.stderr).toMatch(/bahn/i);
    });
  });

  describe('reorderKnockouts', () => {
    test('fehlendes --order verweigert — der Eingriff berechnet und erraet keine Reihenfolge', async () => {
      const r = await runCli(lcKo, ['reorderKnockouts', '--nodes', 'g1,g2', '--apply']);
      expect(r.status).not.toBe(0);
      expect(r.wrote).toBe(false);
      expect(r.stderr).toMatch(/reihenfolge/i);
    });

    test('Vorschau mit gueltigem --order meldet Machbarkeit, schreibt aber ohne --apply nichts', async () => {
      const r = await runCli(lcKo, ['reorderKnockouts', '--nodes', 'g1,g2', '--order', 'g2,g1']);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/machbar/i);
      expect(r.wrote).toBe(false);
    });

    test('mit --apply wird die Reihenfolge gedreht und geschrieben', async () => {
      const r = await runCli(lcKo, ['reorderKnockouts', '--nodes', 'g1,g2', '--order', 'g2,g1', '--apply']);
      expect(r.status).toBe(0);
      expect(r.wrote).toBe(true);
      const out = r.readOut();
      const firstEdge = out.edges.find(e => e.source === 's');
      expect(firstEdge.target).toBe('g2');
    });
  });

  describe('isolateException', () => {
    test('fehlender Pflichtparameter --marker verweigert', async () => {
      const r = await runCli(lcExc, ['isolateException', '--end', 'xend', '--attach-to', 'task', '--apply']);
      expect(r.status).not.toBe(0);
      expect(r.wrote).toBe(false);
      expect(r.stderr).toMatch(/marker/i);
    });

    test('fehlender Pflichtparameter --cancel-activity verweigert (kein Default auf true/false)', async () => {
      const r = await runCli(lcExc, ['isolateException', '--end', 'xend', '--attach-to', 'task',
                                     '--marker', 'timer', '--apply']);
      expect(r.status).not.toBe(0);
      expect(r.wrote).toBe(false);
      expect(r.stderr).toMatch(/cancelactivity/i);
    });

    test('mit allen Pflichtparametern wird das Boundary-Event angehaengt und geschrieben', async () => {
      const r = await runCli(lcExc, ['isolateException', '--end', 'xend', '--attach-to', 'task',
                                     '--marker', 'timer', '--cancel-activity', 'true', '--apply']);
      expect(r.status).toBe(0);
      expect(r.wrote).toBe(true);
      const out = r.readOut();
      const bnd = out.nodes.find(n => n.type === 'boundaryEvent');
      expect(bnd.attachedTo).toBe('task');
      expect(bnd.marker).toBe('timer');
      expect(bnd.cancelActivity).toBe(true);
    });

    test('geteiltes Ausnahme-Ende ohne --edges verweigert als mehrdeutig und nennt die Kandidaten-Kanten', () => {
      return runCli(lcSharedExc, ['isolateException', '--end', 'xend', '--attach-to', 'task1',
                                  '--marker', 'timer', '--cancel-activity', 'true', '--apply']).then(r => {
        expect(r.status).not.toBe(0);
        expect(r.wrote).toBe(false);
        expect(r.stderr).toMatch(/mehrdeutig/i);
        expect(r.stderr).toMatch(/j2/);
        expect(r.stderr).toMatch(/j5/);
      });
    });

    test('--edges loest die Mehrdeutigkeit auf und beruehrt den fremden Ausnahme-Pfad nicht', async () => {
      const r = await runCli(lcSharedExc, ['isolateException', '--end', 'xend', '--attach-to', 'task1',
                                           '--marker', 'timer', '--cancel-activity', 'true',
                                           '--edges', 'j2', '--apply']);
      expect(r.status).toBe(0);
      expect(r.wrote).toBe(true);
      const out = r.readOut();
      const gw2Out = out.edges.filter(e => e.source === 'gw2').map(e => e.id).sort();
      expect(gw2Out).toEqual(['j5', 'j6']);
    });
  });

  describe('allgemeine CLI-Fehler', () => {
    test('unbekannter Eingriff endet mit Fehler-Rueckgabewert und schreibt nicht', async () => {
      const r = await runCli(lcChain, ['bogusTransform', '--apply']);
      expect(r.status).not.toBe(0);
      expect(r.wrote).toBe(false);
    });

    test('fehlende Argumente (kein Eingriff angegeben) enden mit Fehler-Rueckgabewert', async () => {
      const r = await runCli(lcChain, []);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/usage/i);
      expect(r.wrote).toBe(false);
    });

    test('fehlende Eingabedatei endet mit Fehler-Rueckgabewert und schreibt nicht ' +
         '(readFileSync schlaegt fehl, sauber im try/catch abgefangen)', async () => {
      const { spawnSync } = await import('node:child_process');
      const os = await import('node:os');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redesign-cli-'));
      const missingPath = path.join(dir, 'gibtsnicht.json');
      const outPath = path.join(dir, 'out.json');
      const res = spawnSync('node', ['redesign-cli.js', missingPath, 'parallelize',
                                     '--nodes', 'a,b,c', '--apply', '-o', outPath],
                            { cwd: __dirname, encoding: 'utf8' });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/eingabe/i);
      expect(fs.existsSync(outPath)).toBe(false);
    });

    test('unparsebare (kaputte) Eingabedatei endet mit Fehler-Rueckgabewert und schreibt nicht ' +
         '(JSON.parse schlaegt fehl, sauber im try/catch abgefangen)', async () => {
      const { spawnSync } = await import('node:child_process');
      const os = await import('node:os');
      const fs = await import('node:fs');
      const path = await import('node:path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redesign-cli-'));
      const inPath = path.join(dir, 'in.json');
      const outPath = path.join(dir, 'out.json');
      fs.writeFileSync(inPath, '{ das ist kein JSON', 'utf8');
      const res = spawnSync('node', ['redesign-cli.js', inPath, 'parallelize',
                                     '--nodes', 'a,b,c', '--apply', '-o', outPath],
                            { cwd: __dirname, encoding: 'utf8' });
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/eingabe/i);
      expect(fs.existsSync(outPath)).toBe(false);
    });
  });
});

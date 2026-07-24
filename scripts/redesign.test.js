import { describe, test, expect } from '@jest/globals';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cloneLc, checkGate, nextId, isProtected, refusal, collectIds } from './redesign-core.js';
import { runRules, loadRuleProfile } from './rules.js';
import { previewParallelize, applyParallelize, previewMergeTasks, applyMergeTasks } from './redesign.js';

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
  });
});

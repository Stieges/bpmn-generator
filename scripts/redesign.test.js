import { describe, test, expect } from '@jest/globals';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { cloneLc, checkGate, nextId, isProtected, refusal, collectIds } from './redesign-core.js';
import { runRules, loadRuleProfile } from './rules.js';

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

import { describe, test, expect } from '@jest/globals';
import { cloneLc, checkGate, nextId, isProtected, refusal } from './redesign-core.js';

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

  test('checkGate laesst reine Stil-Verstoesse durch (profilunabhaengig)', () => {
    const styleIssue = { ...lcMin, nodes: lcMin.nodes.map(n => n.id === 't1' ? { ...n, name: 'Pruefung' } : n) };
    const r = checkGate(styleIssue);
    expect(r.ok).toBe(true);
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

/**
 * Issue #64 — an edge without an id gets one, once, at the entry (normalizeEdgeIds), and nothing
 * downstream invents its own. Layout, XML, SVG and the DI check must agree on that id.
 */
import { describe, test, expect } from '@jest/globals';
import { runPipeline } from './pipeline.js';
import { normalizeEdgeIds, assignEdgeIds } from './topology.js';
import { logicCoreToElk } from './layout.js';

const n = (id, type = 'task') => ({ id, type, name: id });
const base = (extra = {}) => ({
  id: 'p', name: 'P',
  nodes: [n('s', 'startEvent'), n('w'), n('e', 'endEvent')],
  edges: [{ source: 's', target: 'w' }, { source: 'w', target: 'e' }],
  ...extra,
});
const flowIds = (xml) => [...xml.matchAll(/<bpmn:sequenceFlow id="([^"]*)"/g)].map(m => m[1]);
const diIds = (xml) => [...xml.matchAll(/<bpmndi:BPMNEdge[^>]*bpmnElement="([^"]*)"/g)].map(m => m[1]);

describe('#64 id-less edges', () => {
  test('reproduction: clean run, distinct ids matching the DI, no DI07', async () => {
    const r = await runPipeline(base());
    expect(r.validation.errors).toEqual([]);
    expect(r.diagnostics.issues.filter(i => i.code === 'DI07')).toEqual([]);
    expect(r.diagnostics.ok).toBe(true);
    expect(flowIds(r.bpmnXml)).toEqual(['flow_s_w', 'flow_w_e']);
    expect(diIds(r.bpmnXml).sort()).toEqual(['flow_s_w', 'flow_w_e']);
    expect(r.validation.xmlWarnings || []).toEqual([]);
  });

  test('parallel id-less edges get flow_a_b and flow_a_b_2', async () => {
    const lc = base({ edges: [{ source: 's', target: 'w' }, { source: 's', target: 'w' }, { source: 'w', target: 'e' }] });
    const r = await runPipeline(lc);
    expect(flowIds(r.bpmnXml)).toEqual(['flow_s_w', 'flow_s_w_2', 'flow_w_e']);
    expect(diIds(r.bpmnXml).sort()).toEqual(['flow_s_w', 'flow_s_w_2', 'flow_w_e']);
    expect((r.validation.xmlWarnings || []).filter(w => /duplicate/i.test(w))).toEqual([]);
    expect(r.diagnostics.issues.filter(i => i.code === 'DI07')).toEqual([]);
  });

  test('author ids are untouched; a generated id colliding with an existing id is suffixed', () => {
    const lc = base({
      nodes: [n('s', 'startEvent'), n('w'), n('e', 'endEvent'), n('flow_s_w')],
      edges: [{ id: 'mine', source: 's', target: 'w' }, { source: 's', target: 'w' }, { id: 'flow_w_e', source: 'w', target: 'e' }, { source: 'w', target: 'e' }],
    });
    const out = normalizeEdgeIds(lc);
    expect(out.edges.map(e => e.id)).toEqual(['mine', 'flow_s_w_2', 'flow_w_e', 'flow_w_e_2']);
  });

  test('id-less edges inside a subprocess and a grandchild', () => {
    const lc = base({
      nodes: [n('s', 'startEvent'), {
        id: 'sp', type: 'subProcess', name: 'sp', isExpanded: true,
        nodes: [n('a', 'startEvent'), { id: 'sp2', type: 'subProcess', name: 'sp2', isExpanded: true,
          nodes: [n('x', 'startEvent'), n('y', 'endEvent')], edges: [{ source: 'x', target: 'y' }] }, n('b', 'endEvent')],
        edges: [{ source: 'a', target: 'sp2' }, { source: 'sp2', target: 'b' }],
      }, n('e', 'endEvent')],
      edges: [{ source: 's', target: 'sp' }, { source: 'sp', target: 'e' }],
    });
    const out = normalizeEdgeIds(lc);
    const sp = out.nodes[1];
    expect(sp.edges.map(e => e.id)).toEqual(['flow_a_sp2', 'flow_sp2_b']);
    expect(sp.nodes[1].edges.map(e => e.id)).toEqual(['flow_x_y']);
  });

  test('subprocess children run cleanly through the pipeline', async () => {
    const lc = base({
      nodes: [n('s', 'startEvent'), {
        id: 'sp', type: 'subProcess', name: 'sp', isExpanded: true,
        nodes: [n('a', 'startEvent'), n('b', 'endEvent')], edges: [{ source: 'a', target: 'b' }],
      }, n('e', 'endEvent')],
      edges: [{ source: 's', target: 'sp' }, { source: 'sp', target: 'e' }],
    });
    const r = await runPipeline(lc);
    expect(r.diagnostics.issues.filter(i => i.code === 'DI07')).toEqual([]);
    expect(flowIds(r.bpmnXml)).toEqual(expect.arrayContaining(['flow_a_b', 'flow_s_sp', 'flow_sp_e']));
  });

  test('deterministic and does not mutate the caller', async () => {
    const lc = base();
    const before = JSON.stringify(lc);
    const a = await runPipeline(lc);
    const b = await runPipeline(lc);
    expect(JSON.stringify(lc)).toBe(before);
    expect(a.bpmnXml).toBe(b.bpmnXml);
    expect(a.svg).toBe(b.svg);
    expect(normalizeEdgeIds(lc)).not.toBe(lc);
    expect(JSON.stringify(lc)).toBe(before);
  });

  test('idempotent', () => {
    const once = normalizeEdgeIds(base());
    expect(normalizeEdgeIds(once)).toEqual(once);
  });

  test('pools: id-less edges per pool and a collision across pools', async () => {
    const lc = {
      id: 'c', name: 'C',
      pools: [
        { id: 'p1', name: 'P1', nodes: [n('s', 'startEvent'), n('e', 'endEvent')], edges: [{ source: 's', target: 'e' }] },
        { id: 'p2', name: 'P2', nodes: [n('s2', 'startEvent'), n('e2', 'endEvent')], edges: [{ source: 's2', target: 'e2' }] },
      ],
    };
    const r = await runPipeline(lc);
    expect(flowIds(r.bpmnXml).sort()).toEqual(['flow_s2_e2', 'flow_s_e']);
    expect(r.diagnostics.issues.filter(i => i.code === 'DI07')).toEqual([]);
  });

  test('public entry logicCoreToElk completes id-less edges itself', () => {
    const lc = base();
    const g = logicCoreToElk(lc);
    const ids = JSON.stringify(g).match(/"id":"flow_[^"]*"/g);
    expect(ids).toEqual(expect.arrayContaining(['"id":"flow_s_w"', '"id":"flow_w_e"']));
    expect(lc.edges.every(e => e.id)).toBe(true);
    expect(assignEdgeIds(lc)).toBe(lc);
  });
});

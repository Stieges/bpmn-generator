/**
 * Issue #64 — an edge without an id gets one, once, at the entry (normalizeEdgeIds), and nothing
 * downstream invents its own. Layout, XML, SVG and the DI check must agree on that id.
 */
import { describe, test, expect } from '@jest/globals';
import { runPipeline } from './pipeline.js';
import { normalizeEdgeIds, assignEdgeIds } from './topology.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { logicCoreToElk, runElkLayout } from './layout.js';
import { buildCoordinateMap } from './coordinates.js';
import { generateBpmnXml } from './bpmn-xml.js';
import { generateSvg } from './svg.js';

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

describe('#64 ruling 3: normalised BEFORE validation and the net check', () => {
  test('a rule finding about an id-less edge names the generated flow id', async () => {
    const lc = {
      id: 'p', name: 'P',
      nodes: [n('s', 'startEvent'), { id: 'xor', type: 'exclusiveGateway', name: 'XOR' }, n('t1'), n('t2'),
        { id: 'and', type: 'parallelGateway', name: 'AND' }, n('e', 'endEvent')],
      edges: [
        { source: 's', target: 'xor' }, { source: 'xor', target: 't1' }, { source: 'xor', target: 't2' },
        { source: 't1', target: 'and' }, { source: 't2', target: 'and' }, { source: 'and', target: 'e' },
      ],
    };
    const r = await runPipeline(lc);
    const msg = r.validation.errors.find(e => e.includes('Deadlock'));
    expect(msg).toBeDefined();
    expect(msg).toMatch(/flow_xor_t[12]/);
    expect(msg).not.toMatch(/"xor→/);
  });
});

describe('#64 direct public entries complete id-less edges', () => {
  const idLess = () => base({ edges: [{ source: 's', target: 'w' }, { source: 's', target: 'w' }, { source: 'w', target: 'e' }] });
  const layoutOf = async (lc) => {
    const ready = normalizeEdgeIds(lc);
    const elk = await runElkLayout(logicCoreToElk(ready));
    return { ready, elk, coordMap: buildCoordinateMap(elk, ready) };
  };
  const expected = ['flow_s_w', 'flow_s_w_2', 'flow_w_e'];

  test('buildCoordinateMap keys edge geometry by the generated ids', async () => {
    const { ready, elk } = await layoutOf(idLess());
    const raw = idLess();
    const cm = buildCoordinateMap(elk, raw);
    expect(Object.keys(cm.edgeCoords).sort()).toEqual(expected);
    expect(raw.edges.map(e => e.id)).toEqual(['flow_s_w', 'flow_s_w_2', 'flow_w_e']);
    expect(ready.edges.map(e => e.id)).toEqual(raw.edges.map(e => e.id));
  });

  test('generateBpmnXml: sequenceFlow ids equal BPMNEdge bpmnElement ids, no undefined', async () => {
    const { coordMap } = await layoutOf(idLess());
    const xml = await generateBpmnXml(idLess(), coordMap);
    expect(xml).not.toContain('undefined');
    expect(flowIds(xml).sort()).toEqual(expected);
    expect(diIds(xml).sort()).toEqual(flowIds(xml).sort());
  });

  test('generateSvg: draws every edge from its geometry, no undefined', async () => {
    const { ready, coordMap } = await layoutOf(idLess());
    const svg = generateSvg(idLess(), coordMap);
    expect(svg).not.toContain('undefined');
    expect(svg).toBe(generateSvg(ready, coordMap));
    expect((svg.match(/marker-end="url\(#seq-end\)"/g) || []).length).toBe(3);
  });
});

describe('#64 no downstream fallback for a missing sequence-flow id', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  test('layout, bpmn-xml, svg and coordinates carry no `.id || ` fallback for edges', () => {
    for (const f of ['layout.js', 'bpmn-xml.js', 'svg.js', 'coordinates.js']) {
      const lines = readFileSync(path.join(dir, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/\.id\s*\|\|\s*`/.test(line)) return;
        // Allowed: message flows, whose ids the schema requires (mf_<source>_<target>).
        if (/mf\.id\s*\|\|\s*`mf_/.test(line)) return;
        throw new Error(`${f}:${i + 1} reintroduces an id fallback: ${line.trim()}`);
      });
    }
  });
});

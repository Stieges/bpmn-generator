/**
 * DRD SVG (svg.js) — the geometry contract, DMN side: mirrors bpmn/pipeline.test.js's
 * "geometry contract — the two renderers agree". dmn-xml.js writes the coordMap into DMNDI for
 * tools, svg.js draws it for humans; both are compared against the CONTRACT (coordMap), so they
 * agree by construction or the test names the element that drifted. The DMN canvas is anchored at
 * the origin by coordinates.js, so — unlike the BPMN SVG — not even an offset is allowed.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDmnPipeline } from './pipeline.js';
import { generateDmnSvg } from './svg.js';
import { DRD_GLYPH, drdScaledPath } from './pathmap.js';
import { requirementKey } from './requirement-order.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../tests/fixtures/dmn');
const loadFixture = (name) => JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
const FIXTURES = ['discount-decision.json', 'claim-approval.json', 'roundtrip-all-fields.json'];

const r1 = (n) => (Math.round(n * 10) / 10).toFixed(1);
const box = (b) => `${r1(b.x)},${r1(b.y)} ${r1(b.w)}x${r1(b.h)}`;
const poly = (pts) => pts.map((p) => `${r1(p.x)},${r1(p.y)}`).join(' ');
const attr = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

/** DMNDI: { shapes: { nodeId: box }, edges: { requirementId: polyline } } */
function dmndi(xml) {
  const shapes = {};
  for (const m of xml.matchAll(/<dmndi:DMNShape [^>]*dmnElementRef="([^"]+)"[^>]*>\s*<dc:Bounds ([^/]*)\/>/g)) {
    const b = m[2];
    shapes[m[1]] = box({ x: +attr(b, 'x'), y: +attr(b, 'y'), w: +attr(b, 'width'), h: +attr(b, 'height') });
  }
  const edges = {};
  for (const m of xml.matchAll(/<dmndi:DMNEdge [^>]*dmnElementRef="([^"]+)"[^>]*>([\s\S]*?)<\/dmndi:DMNEdge>/g)) {
    edges[m[1]] = poly([...m[2].matchAll(/<di:waypoint x="([^"]+)" y="([^"]+)"/g)].map((w) => ({ x: +w[1], y: +w[2] })));
  }
  return { shapes, edges };
}

/** SVG: { shapes: { nodeId: { type, rect|path+translate } }, edges: { requirementKey: { type, polyline } } } */
function svgParts(svg) {
  const shapes = {};
  for (const m of svg.matchAll(/<g class="dmn-shape" data-element-id="([^"]+)" data-type="([^"]+)">\n(?:<title>[^<]*<\/title>\n)?(<(?:rect|path) [^>]*>)/g)) {
    const el = m[3];
    if (el.startsWith('<rect')) {
      shapes[m[1]] = { type: m[2], rect: box({ x: +attr(el, 'x'), y: +attr(el, 'y'), w: +attr(el, 'width'), h: +attr(el, 'height') }), rx: attr(el, 'rx') };
    } else {
      const [, tx, ty] = attr(el, 'transform').match(/translate\(([-\d.]+), ([-\d.]+)\)/);
      shapes[m[1]] = { type: m[2], at: `${r1(+tx)},${r1(+ty)}`, d: attr(el, 'd') };
    }
  }
  const edges = {};
  for (const m of svg.matchAll(/<polyline class="dmn-requirement" ([^>]*)\/>/g)) {
    const pts = attr(m[1], 'points').split(' ').map((p) => { const [x, y] = p.split(','); return { x: +x, y: +y }; });
    edges[attr(m[1], 'data-element-id')] = { type: attr(m[1], 'data-type'), points: poly(pts), dash: attr(m[1], 'stroke-dasharray') ?? null, marker: attr(m[1], 'marker-end') };
  }
  return { shapes, edges };
}

describe('DRD SVG — the geometry contract: DMNDI and SVG are the same coordMap', () => {
  for (const fixture of FIXTURES) {
    test(`${fixture} — the DMNDI is coordMap, unchanged`, async () => {
      const r = await runDmnPipeline(loadFixture(fixture));
      const { coords, edgeCoords } = r.diagrams[0].coordMap;
      const di = dmndi(r.xml);
      expect(Object.keys(di.shapes).sort()).toEqual(Object.keys(coords).sort());
      for (const [id, c] of Object.entries(coords)) expect(`${id}: ${di.shapes[id]}`).toBe(`${id}: ${box(c)}`);
      expect(Object.keys(di.edges).sort()).toEqual(Object.keys(edgeCoords).sort());
      for (const [id, pts] of Object.entries(edgeCoords)) expect(`${id}: ${di.edges[id]}`).toBe(`${id}: ${poly(pts)}`);
    });

    test(`${fixture} — the SVG is coordMap, without even an offset`, async () => {
      const dc = loadFixture(fixture);
      const r = await runDmnPipeline(dc);
      const { coords, edgeCoords } = r.diagrams[0].coordMap;
      const svg = svgParts(r.svg);
      expect(Object.keys(svg.shapes).sort()).toEqual(Object.keys(coords).sort());
      for (const node of dc.nodes) {
        const c = coords[node.id];
        const s = svg.shapes[node.id];
        expect(s.type).toBe(node.type);
        const glyph = DRD_GLYPH[node.type];
        if (glyph) {
          // A path shape: its origin is the shape's corner, its path dmn-js's template scaled to
          // the shape's own w × h.
          expect(`${node.id}: ${s.at}`).toBe(`${node.id}: ${r1(c.x)},${r1(c.y)}`);
          expect(s.d).toBe(drdScaledPath(glyph.path, { ...glyph, containerWidth: c.w, containerHeight: c.h }));
        } else {
          expect(`${node.id}: ${s.rect}`).toBe(`${node.id}: ${box(c)}`);
        }
      }
      expect(Object.keys(svg.edges).sort()).toEqual(Object.keys(edgeCoords).sort());
      for (const [id, pts] of Object.entries(edgeCoords)) expect(`${id}: ${svg.edges[id].points}`).toBe(`${id}: ${poly(pts)}`);
      // The canvas is the diagram's size.
      const { size } = r.diagrams[0];
      expect(r.svg).toContain(`viewBox="0 0 ${Math.round(size.w * 10) / 10} ${Math.round(size.h * 10) / 10}"`);
    });

    test(`${fixture} — DMNDI and SVG agree with each other`, async () => {
      const r = await runDmnPipeline(loadFixture(fixture));
      const di = dmndi(r.xml);
      const svg = svgParts(r.svg);
      for (const [id, pts] of Object.entries(svg.edges)) expect(`${id}: ${pts.points}`).toBe(`${id}: ${di.edges[id]}`);
      for (const [id, s] of Object.entries(svg.shapes)) if (s.rect) expect(`${id}: ${s.rect}`).toBe(`${id}: ${di.shapes[id]}`);
    });
  }
});

describe('DRD SVG — what each element looks like (dmn-js DrdRenderer)', () => {
  test('decision: square rectangle; input data: 22 px corners; knowledge source and BKM: their dmn-js paths', async () => {
    const r = await runDmnPipeline(loadFixture('discount-decision.json'));
    const s = svgParts(r.svg).shapes;
    expect(s.dec_discountLevel.rx).toBe('0');
    expect(s.in_orderValue.rx).toBe('22');
    expect(s.ks_discountPolicy.d).toMatch(/^m 0,[\d.]+ l 0,[\d.]+ c /); // the wavy bottom: two curves
    expect(s.bkm_loyaltyBonus.d).toMatch(/^m 0,[\d.]+ l [\d.]+,-[\d.]+ l /); // the clipped corners
  });

  test('information: solid + filled arrow; knowledge: dashed + open chevron; authority: dashed + filled circle', async () => {
    const r = await runDmnPipeline(loadFixture('discount-decision.json'));
    const e = svgParts(r.svg).edges;
    expect(e.ir_1).toMatchObject({ type: 'information', dash: null, marker: 'url(#dmn-information-end)' });
    expect(e.kr_1).toMatchObject({ type: 'knowledge', dash: '5', marker: 'url(#dmn-knowledge-end)' });
    expect(e.ar_1).toMatchObject({ type: 'authority', dash: '5', marker: 'url(#dmn-authority-end)' });
    expect(r.svg).toMatch(/<marker id="dmn-information-end"[^>]*><path d="M 1 5 L 11 10 L 1 15 Z" fill="#000000" stroke="none"/);
    expect(r.svg).toMatch(/<marker id="dmn-knowledge-end"[^>]*><path d="M 1 3 L 11 10 L 1 17" fill="none"/);
    expect(r.svg).toMatch(/<marker id="dmn-authority-end"[^>]*><circle cx="3" cy="3" r="3" fill="#000000"/);
  });

  test('every name is drawn inside its shape, and every text is escaped', async () => {
    const dc = loadFixture('discount-decision.json');
    dc.nodes.find((n) => n.id === 'in_orderValue').name = '<v> & "n"';
    const r = await runDmnPipeline(dc);
    expect(r.svg).toContain('&lt;v&gt; &amp; &quot;n&quot;');
    expect(r.svg).not.toContain('<v>');
    const { coords } = r.diagrams[0].coordMap;
    for (const m of r.svg.matchAll(/<g class="dmn-shape" data-element-id="([^"]+)"[\s\S]*?<\/g>/g)) {
      const c = coords[m[1]];
      for (const t of m[0].matchAll(/<text x="([-\d.]+)" y="([-\d.]+)"/g)) {
        expect(Math.abs(+t[1] - (c.x + c.w / 2))).toBeLessThanOrEqual(0.051);
        expect(+t[2]).toBeGreaterThan(c.y);
        expect(+t[2]).toBeLessThan(c.y + c.h);
      }
    }
  });

  test('requirement keys of id-less requirements are the ones the DMNDI uses', async () => {
    const dc = loadFixture('claim-approval.json'); // its requirements carry no id
    const r = await runDmnPipeline(dc);
    const ids = Object.keys(svgParts(r.svg).edges).sort();
    expect(ids).toEqual(dc.requirements.map(requirementKey).sort());
  });

  test('generateDmnSvg refuses an empty diagram list instead of drawing nothing', () => {
    expect(() => generateDmnSvg({ nodes: [] }, [])).toThrow(/no diagram/);
  });
});

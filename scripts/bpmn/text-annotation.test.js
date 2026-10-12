import { describe, test, expect } from '@jest/globals';
import { runPipeline } from './pipeline.js';
import { artifactSize, textAnnotationTextStyle, edgeLabelLayout } from './coordinates.js';
import { SHAPE, ARTIFACT_GAP } from './constants.js';

// A text annotation's box grows to fit its text (coordinates.js artifactSize); before, it was a
// fixed 100 × 30 and the text ran out of it — one line ~700 px wide in our SVG, a column of lines
// down across the lane border in bpmn.io. Idea and first implementation: kndrio/bpmn-generator.

const LONG = 'Pruefung nach Vier-Augen-Prinzip gemaess Arbeitsanweisung AA-17, Abschnitt 4.2; '
  + 'bei Betraegen ueber 10.000 EUR zusaetzlich Rueckfrage beim Fachbereich';

const model = (extraNodes, associations) => ({
  id: 'Process_ann', name: 'Annotations',
  lanes: [{ id: 'L1', name: 'Sachbearbeitung' }, { id: 'L2', name: 'Fachbereich' }],
  nodes: [
    { id: 's', type: 'startEvent', name: 'Antrag eingegangen', lane: 'L1' },
    { id: 't1', type: 'userTask', name: 'Antrag pruefen', lane: 'L1' },
    { id: 't2', type: 'userTask', name: 'Bescheid erstellen', lane: 'L1' },
    { id: 't3', type: 'userTask', name: 'Bescheid freigeben', lane: 'L2' },
    { id: 'e', type: 'endEvent', name: 'Bescheid versandt', lane: 'L2' },
    ...extraNodes,
  ],
  edges: [
    { id: 'f1', source: 's', target: 't1' },
    { id: 'f2', source: 't1', target: 't2' },
    { id: 'f3', source: 't2', target: 't3' },
    { id: 'f4', source: 't3', target: 'e' },
  ],
  associations,
});

/** The DI bounds of one shape, as numbers. */
function diBounds(xml, id) {
  const m = xml.match(new RegExp(`<bpmndi:BPMNShape [^>]*bpmnElement="${id}"[^>]*>\\s*<dc:Bounds x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`));
  if (!m) throw new Error(`no DI shape for ${id}`);
  const [x, y, w, h] = m.slice(1).map(Number);
  return { x, y, w, h };
}

/**
 * Our SVG's annotation `id`: its box (the bracket's translate group, `w`×`h`) and the text lines
 * drawn in its element group.
 */
function svgAnnotation(svg, id, w, h) {
  const g = svg.match(new RegExp(`<g data-element-id="${id}">([\\s\\S]*?)\\n</g>`));
  if (!g) throw new Error(`no annotation ${id} in the SVG`);
  const t = g[1].match(/<g transform="translate\(([\d.-]+),([\d.-]+)\)">/);
  const texts = [...g[1].matchAll(/<text x="([^"]+)" y="([^"]+)"[^>]*>([^<]*)<\/text>/g)]
    .map(m => ({ x: Number(m[1]), y: Number(m[2]), text: m[3] }));
  return { box: { x: Number(t[1]), y: Number(t[2]), w, h }, texts };
}

/** Width of an SVG text line at the annotation's font size, with the label layout's Arial metrics. */
const estWidth = (s) => edgeLabelLayout(s, { fontSize: textAnnotationTextStyle().fontSize, lineHeight: 1.2, wrapWidth: 1e6 }).w;

describe('text annotation — the box fits its text', () => {
  test('a long annotation wraps, and its box is the same in coordMap, DI and SVG', async () => {
    const lc = model([{ id: 'n1', type: 'textAnnotation', name: LONG, lane: 'L1' }], [{ id: 'a1', source: 'n1', target: 't1' }]);
    const r = await runPipeline(lc);
    const c = r.coordMap.coords.n1;
    const { maxWidth, padding, fontSize, lineHeight } = textAnnotationTextStyle();

    expect(c.lines.length).toBeGreaterThan(1);
    // Lines break at blanks and after hyphens (bpmn-js semanticShorten); no character is lost.
    expect(c.lines.join('').replace(/\s+/g, '')).toBe(LONG.replace(/\s+/g, ''));
    expect(c.w).toBe(maxWidth);
    expect(c.h).toBeGreaterThanOrEqual(2 * padding + c.lines.length * fontSize * lineHeight);

    // DI bounds are the coordMap box: bpmn.io lays the same text out into exactly this box.
    expect(diBounds(r.bpmnXml, 'n1')).toEqual({ x: c.x, y: c.y, w: c.w, h: c.h });
    expect(r.diagnostics.ok).toBe(true);

    // Our SVG draws the same box and every line inside it.
    const { box, texts } = svgAnnotation(r.svg, 'n1', c.w, c.h);
    expect(texts.map(t => t.text)).toEqual(c.lines);
    for (const t of texts) {
      expect(t.y - fontSize).toBeGreaterThanOrEqual(box.y);
      expect(t.y + 3).toBeLessThanOrEqual(box.y + box.h);
      expect(t.x).toBeGreaterThanOrEqual(box.x);
      expect(t.x + estWidth(t.text)).toBeLessThanOrEqual(box.x + box.w);
    }
  });

  test('two annotations of different length on one anchor do not overlap', async () => {
    const lc = model([
      { id: 'n1', type: 'textAnnotation', name: LONG, lane: 'L1' },
      { id: 'n2', type: 'textAnnotation', name: 'Kurz', lane: 'L1' },
    ], [{ id: 'a1', source: 'n1', target: 't1' }, { id: 'a2', source: 'n2', target: 't1' }]);
    const r = await runPipeline(lc);
    const a = r.coordMap.coords.n1, b = r.coordMap.coords.n2;
    expect(a.h).toBeGreaterThan(b.h);
    // n2 starts below n1's bottom, one gap further — not one *n2* height below n1's top.
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.h + ARTIFACT_GAP);
    expect(diBounds(r.bpmnXml, 'n2').y).toBe(b.y);
  });

  test('a long annotation inside an expanded subprocess stays inside it (no DI06)', async () => {
    for (const associated of [true, false]) {
      const lc = {
        id: 'Process_sp', name: 'Subprocess',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start' },
          {
            id: 'sp', type: 'subProcess', name: 'Pruefen', isExpanded: true,
            nodes: [
              { id: 'ss', type: 'startEvent', name: 'Beginn' },
              { id: 'st', type: 'task', name: 'Unterlagen pruefen' },
              { id: 'se', type: 'endEvent', name: 'Geprueft' },
              { id: 'sn', type: 'textAnnotation', name: LONG },
            ],
            edges: [{ id: 'sf1', source: 'ss', target: 'st' }, { id: 'sf2', source: 'st', target: 'se' }],
          },
          { id: 'e', type: 'endEvent', name: 'Ende' },
        ],
        edges: [{ id: 'f1', source: 's', target: 'sp' }, { id: 'f2', source: 'sp', target: 'e' }],
        associations: associated ? [{ id: 'a1', source: 'sn', target: 'st' }] : [],
      };
      const r = await runPipeline(lc);
      const di06 = r.diagnostics.issues.filter(i => i.code === 'DI06');
      expect({ associated, di06 }).toEqual({ associated, di06: [] });
      const n = r.coordMap.coords.sn, sp = r.coordMap.coords.sp;
      expect(n.lines.length).toBeGreaterThan(1);
      expect(n.y + n.h).toBeLessThanOrEqual(sp.y + sp.h);
      expect(n.x).toBeGreaterThanOrEqual(sp.x);
      expect(n.x + n.w).toBeLessThanOrEqual(sp.x + sp.w);
    }
  });

  test('a short annotation keeps the configured shape size and one line', async () => {
    expect(artifactSize({ type: 'textAnnotation', name: 'Kurz' }))
      .toEqual({ w: SHAPE.textAnnotation.w, h: SHAPE.textAnnotation.h, lines: ['Kurz'] });
    expect(artifactSize({ type: 'textAnnotation', name: '' }))
      .toEqual({ w: SHAPE.textAnnotation.w, h: SHAPE.textAnnotation.h, lines: [''] });
    const lc = model([{ id: 'n2', type: 'textAnnotation', name: 'Four eyes', lane: 'L1' }], [{ id: 'a2', source: 'n2', target: 't2' }]);
    const r = await runPipeline(lc);
    const c = r.coordMap.coords.n2;
    expect({ w: c.w, h: c.h, lines: c.lines }).toEqual({ w: 100, h: 30, lines: ['Four eyes'] });
    // Drawn as bpmn-js draws it ('bpmn:TextAnnotation', `left-top`, padding 7): first baseline ¾ of
    // a line below the padding.
    const { box, texts } = svgAnnotation(r.svg, 'n2', 100, 30);
    const st = textAnnotationTextStyle();
    expect(texts).toEqual([{ x: box.x + st.padding, y: Math.round((box.y + st.padding + 0.75 * st.fontSize * st.lineHeight) * 10) / 10, text: 'Four eyes' }]);
  });

  test('a medium annotation widens instead of wrapping, up to the maximum', () => {
    const { maxWidth } = textAnnotationTextStyle();
    const sz = artifactSize({ type: 'textAnnotation', name: 'Vier-Augen-Prinzip beachten' });
    expect(sz.lines).toEqual(['Vier-Augen-Prinzip beachten']);
    expect(sz.w).toBeGreaterThan(SHAPE.textAnnotation.w);
    expect(sz.w).toBeLessThanOrEqual(maxWidth);
    expect(sz.h).toBe(SHAPE.textAnnotation.h);
  });

  test('every other artifact type keeps its fixed size', () => {
    for (const type of ['dataObjectReference', 'dataStoreReference', 'group']) {
      expect(artifactSize({ type, name: LONG })).toEqual(SHAPE[type]);
    }
  });
});

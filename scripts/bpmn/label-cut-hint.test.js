/**
 * H16: a label the SVG (and bpmn.io, which breaks text the same way) cuts inside a word, because
 * the word is wider than the line and has no blank, hyphen or soft hyphen to break at. The breaking
 * itself is bpmn.io's and is not under test here beyond what the soft hyphen (U+00AD) does to it.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import { runPipeline } from './pipeline.js';
import { bpmnToLogicCore } from './import.js';
import { layoutText } from '../shared/text-layout.js';

const SHY = '­';
const STYLE = { fontSize: 11, lineHeight: 1.2, wrapWidth: 90 };

const task = (id, name) => ({ id, type: 'userTask', name, lane: 'L1' });
const chain = (ids) => ids.slice(1).map((t, i) => ({ id: `f_${ids[i]}_${t}`, source: ids[i], target: t }));

/** One process, one lane; every task name is generic German. */
function model(tasks, extra = {}) {
  const nodes = [{ id: 's', type: 'startEvent', name: 'Fall eingegangen', lane: 'L1' }, ...tasks, { id: 'z', type: 'endEvent', name: 'Fall abgeschlossen', lane: 'L1' }];
  return { id: 'Process_cut', name: 'Prozess', lanes: [{ id: 'L1', name: 'Sachbearbeitung' }], nodes, edges: chain(nodes.map((n) => n.id)), ...extra };
}

/** The `<text>` lines of one element's group in our SVG. */
function svgLines(svg, id) {
  const g = svg.match(new RegExp(`<g data-element-id="${id}">([\\s\\S]*?)\\n</g>`));
  if (!g) throw new Error(`no ${id} in the SVG`);
  return [...g[1].matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
}
const xmlName = (xml, id) => xml.match(new RegExp(`<bpmn:\\w+ id="${id}"[^>]*? name="([^"]*)"`))?.[1];
const h16 = (r) => r.validation.hints.filter((h) => h.code === 'H16');

describe('layoutText cuts', () => {
  test('a word that fits, a word with a break point and a blank-separated line cut nothing', () => {
    expect(layoutText('Antrag prüfen', STYLE).cuts).toEqual([]);
    expect(layoutText('Kosten-Nutzen-Analyse durchführen', STYLE).cuts).toEqual([]);
    expect(layoutText('Pauschal' + SHY + 'einwilligung prüfen', STYLE).cuts).toEqual([]);
  });

  test('a word cut over several lines is named once, whole; every cut word is named', () => {
    const r = layoutText('Pauschaleinwilligungsprüfung und Schweigepflichtentbindung', STYLE);
    expect(r.cuts).toEqual(['Pauschaleinwilligungsprüfung', 'Schweigepflichtentbindung']);
    expect(r.lines.join('|').replace(/\|/g, '')).toBe('Pauschaleinwilligungsprüfung undSchweigepflichtentbindung'.replace(' und', ' und'));
  });

  test('the lines are the cut ones', () => {
    const { cuts, lines } = layoutText('Schweigepflichtentbindung anfordern', STYLE);
    expect(cuts).toEqual(['Schweigepflichtentbindung']);
    expect(lines).toEqual(['Schweigepflichte', 'ntbindung', 'anfordern']);
  });
});

describe('H16 from runPipeline', () => {
  let r;
  beforeAll(async () => {
    r = await runPipeline(model([
      task('a', 'Pauschaleinwilligung prüfen'),
      task('b', 'Schweigepflichtentbindung anfordern'),
      task('c', 'Pauschaleinwilligungsprüfung Schweigepflichtentbindung'),
      task('d', 'Kosten prüfen'),
    ]));
  }, 60000);

  test('one hint per label, naming the element and every cut word, in drawing order', () => {
    expect(h16(r).map((h) => [h.elements, h.message])).toEqual([
      [['a'], 'The text of "a" is broken inside the word "Pauschaleinwilligung": it is wider than the line and has no place to break. Put a soft hyphen (U+00AD) in the name where the word may break, or shorten the word.'],
      [['b'], 'The text of "b" is broken inside the word "Schweigepflichtentbindung": it is wider than the line and has no place to break. Put a soft hyphen (U+00AD) in the name where the word may break, or shorten the word.'],
      [['c'], 'The text of "c" is broken inside the words "Pauschaleinwilligungsprüfung", "Schweigepflichtentbindung": they are wider than the line and have no place to break. Put a soft hyphen (U+00AD) in the name where the word may break, or shorten the word.'],
    ]);
  });

  test('H16 is the last hint, never a warning and not an error', () => {
    expect(r.validation.hints.at(-1).code).toBe('H16');
    expect(r.validation.errors).toEqual([]);
    expect(r.validation.warnings.join('\n')).not.toContain('H16');
  });

  test('the hint matches the SVG: a labelled element is cut mid-word exactly where it is named', () => {
    const cut = new Set(h16(r).flatMap((h) => h.elements));
    for (const id of ['a', 'b', 'c', 'd']) {
      const lines = svgLines(r.svg, id);
      const midWord = lines.slice(0, -1).some((l, i) => !/[\s-]$/.test(l) && !/^[\s]/.test(lines[i + 1]) && !l.endsWith('-'));
      expect({ id, cut: cut.has(id) }).toEqual({ id, cut: id !== 'd' });
      if (id !== 'd') expect(midWord).toBe(true);
    }
  });
});

describe('H16 covers the labels the SVG wraps', () => {
  test('events, gateways, flow labels, annotations, lanes and pools', async () => {
    const LONG = 'Schweigepflichtentbindung';
    const m = {
      id: 'Process_all', name: 'Prozess',
      lanes: [{ id: 'L1', name: 'Sachbearbeitung' }],
      nodes: [
        { id: 's', type: 'startEvent', name: LONG, lane: 'L1' },
        { id: 'g', type: 'exclusiveGateway', name: 'Pauschaleinwilligungsprüfung?', lane: 'L1' },
        task('t', 'Antrag prüfen'),
        { id: 'z', type: 'endEvent', name: 'Fall abgeschlossen', lane: 'L1' },
        { id: 'n', type: 'textAnnotation', name: 'Pauschaleinwilligungsprüfung ' + 'x'.repeat(0) + 'Schweigepflichtentbindungserklärung', lane: 'L1' },
      ],
      edges: [
        { id: 'f1', source: 's', target: 'g' },
        { id: 'f2', source: 'g', target: 't', label: 'Pauschaleinwilligung' },
        { id: 'f3', source: 'g', target: 'z', label: 'Nein' },
        { id: 'f4', source: 't', target: 'z' },
      ],
      associations: [{ id: 'as1', source: 't', target: 'n' }],
    };
    const r = await runPipeline(m);
    const byEl = Object.fromEntries(h16(r).map((h) => [h.elements[0], h.message]));
    expect(Object.keys(byEl).sort()).toEqual(['f2', 'g', 'n', 's']);
    expect(byEl.s).toMatch(/^The label of "s" is broken inside the word "Schweigepflichtentbindung"/);
    expect(byEl.g).toMatch(/^The label of "g" is broken inside the word "Pauschaleinwilligungsprüfung\?"/);
    expect(byEl.f2).toMatch(/^The label of the flow "f2" is broken inside the word "Pauschaleinwilligung"/);
    expect(byEl.n).toMatch(/^The text of "n" is broken inside the words? /);
  }, 60000);

  test('lane and participant names', async () => {
    const m = model([task('t', 'Antrag prüfen')]);
    m.lanes = [{ id: 'L1', name: 'Qualitätssicherungsverantwortlichenabteilung' }];
    m.name = 'Qualitätssicherungsverantwortlichenprozess';
    const r = await runPipeline(m);
    const kinds = h16(r).map((h) => h.message.split(' is broken')[0]);
    expect(kinds).toEqual(expect.arrayContaining([expect.stringMatching(/^The name of the lane "L1"/)]));
  }, 60000);
});

describe('a soft hyphen (U+00AD) in a name', () => {
  let r;
  const names = {
    brk: 'Pauschal' + SHY + 'einwilligung prüfen',          // breaks at the soft hyphen
    keep: 'Kurz' + SHY + 'name',                             // no break at all
    far: 'Schweigepflicht' + SHY + 'entbindung anfordern',  // first part wider than the line
  };
  beforeAll(async () => {
    r = await runPipeline(model(Object.entries(names).map(([id, n]) => task(id, n))));
  }, 60000);

  test('survives into the .bpmn name attribute unchanged, and through the import', async () => {
    for (const [id, n] of Object.entries(names)) expect(xmlName(r.bpmnXml, id)).toBe(n);
    expect(xmlName(r.bpmnXml, 'brk').charCodeAt(8)).toBe(0xAD);
    expect(r.bpmnXml).not.toContain('&#xAD;');
    const back = await bpmnToLogicCore(r.bpmnXml);
    const nodes = back.nodes ?? back.pools.flatMap((p) => p.nodes);
    for (const [id, n] of Object.entries(names)) expect(nodes.find((x) => x.id === id).name).toBe(n);
  });

  test('where the break falls at it, the SVG line ends with a visible hyphen and the next line starts clean', () => {
    expect(svgLines(r.svg, 'brk')).toEqual(['Pauschal-', 'einwilligung', 'prüfen']);
    expect(h16(r).map((h) => h.elements[0])).not.toContain('brk');
  });

  test('where no break happens, the SVG shows no hyphen; the soft hyphen itself stays in the text, invisible', () => {
    expect(svgLines(r.svg, 'keep')).toEqual(['Kurz' + SHY + 'name']);
    expect(svgLines(r.svg, 'keep')[0]).not.toContain('-');
    expect(h16(r).map((h) => h.elements[0])).not.toContain('keep');
  });

  test('a first part wider than the line falls back to the hard cut; the next line keeps an invisible soft hyphen; H16 names the part', () => {
    expect(svgLines(r.svg, 'far')).toEqual(['Schweigepflich', 't' + SHY + 'entbindung', 'anfordern']);
    const hint = h16(r).find((h) => h.elements[0] === 'far');
    expect(hint.message).toContain('the word "Schweigepflicht":');
  });
});

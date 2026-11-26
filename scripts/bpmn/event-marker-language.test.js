/**
 * Event markers under a declared language: the rules, the XML writer and the SVG writer read one
 * marker per event; a model without a supported language keeps the legacy inference.
 */
import { describe, test, expect } from '@jest/globals';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { inferEventMarker, markerOf, resolvedMarkerOf, renderEventMarker } from './icons.js';
import { resolveEventMarkers, namingHints } from './naming/index.js';
import { MARKER_ALLOWED_ON } from './naming/markers.js';
import { runPipeline, generateDiagramSet } from './pipeline.js';
import { runRules } from './rules.js';
import { validateLogicCore } from './validate.js';
import { bpmnToLogicCore } from './import.js';
import { isEvent } from './types.js';
import { MESSAGE_CODES } from '../shared/message-codes.js';
import { checkResponseContract } from '../../.github/scripts/docs-gate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPTS = join(here, '..');
const REPO = join(SCRIPTS, '..');
const FIXTURES = join(REPO, 'tests', 'fixtures');
const LANGUAGES = JSON.parse(readFileSync(join(FIXTURES, 'rules-characterization', 'fixture-languages.json'), 'utf8'));
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name.endsWith('.json') ? name : `${name}.json`), 'utf8'));

const PIPELINE_TIMEOUT = 240_000;

/** Every event of a model, at every nesting level, in document order. */
function eventsOf(model) {
  const out = [];
  const walk = (nodes) => { for (const n of nodes ?? []) { if (isEvent(n.type)) out.push(n); walk(n.nodes); } };
  for (const p of model.pools ?? [model]) walk(p.nodes);
  return out;
}
const findNode = (model, id) => {
  let hit = null;
  const walk = (nodes) => { for (const n of nodes ?? []) { if (n.id === id) hit = n; walk(n.nodes); } };
  for (const p of model.pools ?? [model]) walk(p.nodes);
  return hit;
};
const legacyMarker = (n) => n.marker || inferEventMarker(n.name || '');
const withLanguage = (model, language) => ({ ...structuredClone(model), language });
/** The opening tag and body of the XML element with this id, up to its closing tag. */
const xmlElement = (xml, id) => {
  const m = new RegExp(`<bpmn:(\\w+) id="${id}"[^>]*?(?:/>|>[\\s\\S]*?</bpmn:\\1>)`).exec(xml);
  return m ? m[0] : null;
};
const hintsOf = (result, code) => result.validation.hints.filter((h) => h.code === code);

/** A German model: a start event, a task with a timer and an error boundary event, three ends. */
function inlineGerman() {
  return {
    id: 'Process_Inline',
    name: 'Antragsbearbeitung',
    language: 'de',
    nodes: [
      { id: 'start', type: 'startEvent', name: 'Zeitung gelesen' },
      { id: 'pruefen', type: 'userTask', name: 'Antrag prüfen' },
      { id: 'b_frist', type: 'boundaryEvent', name: 'Fristablauf', attachedTo: 'pruefen', cancelActivity: true },
      { id: 'b_fehler', type: 'boundaryEvent', name: 'Fehlerfall', attachedTo: 'pruefen', cancelActivity: true },
      { id: 'mahnen', type: 'userTask', name: 'Antragsteller mahnen' },
      { id: 'beheben', type: 'userTask', name: 'Ursache beheben' },
      { id: 'ende', type: 'endEvent', name: 'Antrag geprüft' },
      { id: 'ende_frist', type: 'endEvent', name: 'Antragsteller gemahnt' },
      { id: 'ende_fehler', type: 'endEvent', name: 'Ursache behoben' },
    ],
    edges: [
      { id: 'f1', source: 'start', target: 'pruefen' },
      { id: 'f2', source: 'pruefen', target: 'ende' },
      { id: 'f3', source: 'b_frist', target: 'mahnen' },
      { id: 'f4', source: 'mahnen', target: 'ende_frist' },
      { id: 'f5', source: 'b_fehler', target: 'beheben' },
      { id: 'f6', source: 'beheben', target: 'ende_fehler' },
    ],
  };
}

describe('MARKER_ALLOWED_ON', () => {
  test('is the table of BPMN 2.0.2, Tables 10.84–10.90 and 10.93', () => {
    const all = ['startEvent', 'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent', 'endEvent'];
    expect(MARKER_ALLOWED_ON).toEqual({
      message: all,
      timer: ['startEvent', 'intermediateCatchEvent', 'boundaryEvent'],
      error: ['boundaryEvent', 'endEvent'],
      signal: all,
      escalation: ['intermediateThrowEvent', 'boundaryEvent', 'endEvent'],
      conditional: ['startEvent', 'intermediateCatchEvent', 'boundaryEvent'],
    });
    expect(readFileSync(join(here, 'naming', 'markers.js'), 'utf8')).toContain('BPMN 2.0.2, Tables 10.84–10.90 and 10.93');
  });
});

describe('proof (b): the legacy inference has one home', () => {
  test('only bpmn/icons.js and bpmn/naming/** call inferEventMarker', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        if (!e.name.endsWith('.js') || e.name.endsWith('.test.js')) continue;
        const rel = relative(SCRIPTS, p).split(sep).join('/');
        if (rel === 'bpmn/icons.js' || rel.startsWith('bpmn/naming/')) continue;
        if (readFileSync(p, 'utf8').includes('inferEventMarker(')) offenders.push(rel);
      }
    };
    walk(SCRIPTS);
    expect(offenders).toEqual([]);
  });
});

describe('proof (c): without a language both helpers are the legacy expression', () => {
  test('the map names 28 fixtures', () => {
    expect(Object.keys(LANGUAGES)).toHaveLength(28);
  });

  test.each(Object.keys(LANGUAGES))('%s', (file) => {
    const events = eventsOf(fixture(file));
    for (const n of events) {
      const legacy = legacyMarker(n);
      expect(markerOf(n)).toBe(legacy);
      expect(markerOf(n, null)).toBe(legacy);
      expect(markerOf(n, 'fr')).toBe(legacy);
      expect(resolvedMarkerOf(n)).toBe(legacy);
    }
  });

  test('a stray _marker is read by the writers\' helper only', () => {
    const n = { id: 'e', type: 'endEvent', name: 'Deadline missed', _marker: 'signal' };
    expect(markerOf(n)).toBe('timer');
    expect(markerOf(n, 'fr')).toBe('timer');
    expect(markerOf(n, 'German')).toBe('timer');
    expect(markerOf(n, 'en')).toBe('signal');
    expect(resolvedMarkerOf(n)).toBe('signal');
    expect(resolvedMarkerOf({ ...n, _marker: null })).toBeNull();
    expect(markerOf({ ...n, _marker: null }, 'en')).toBeNull();
    expect(markerOf({ ...n, marker: 'error' }, 'en')).toBe('error');
    expect(resolvedMarkerOf({ ...n, marker: 'error' })).toBe('error');
  });

  test('under a language, without _marker, the strategy decides', () => {
    expect(markerOf({ id: 'e', type: 'endEvent', name: 'Deadline missed' }, 'en')).toBeNull();
    expect(markerOf({ id: 'e', type: 'boundaryEvent', name: 'Deadline missed' }, 'en')).toBe('timer');
    expect(markerOf({ id: 'e', type: 'boundaryEvent', name: 'Fristablauf' }, 'de')).toBe('timer');
    expect(markerOf({ id: 'e', type: 'startEvent' }, 'de')).toBeNull();
  });
});

describe('proof (d): the marker differences under each fixture\'s true language', () => {
  const EXPECTED = [
    { fixture: 'example-schadenmeldung', name: 'Prüfung beendet', type: 'endEvent', legacy: 'terminate', now: null },
    { fixture: 'subprocess-child-fidelity', name: 'Deadline missed', type: 'endEvent', legacy: 'timer', now: null },
  ];

  test('markerOf differs from the legacy expression for exactly two events', () => {
    const differences = [];
    for (const [file, language] of Object.entries(LANGUAGES)) {
      for (const n of eventsOf(fixture(file))) {
        const legacy = legacyMarker(n);
        const now = markerOf(n, language);
        if (now !== legacy) differences.push({ fixture: file.replace('.json', ''), name: n.name, type: n.type, legacy, now });
      }
    }
    expect(differences).toEqual(EXPECTED);
  });

  test('runPipeline reports one H11 for each of the two and none elsewhere', async () => {
    const h10 = {};
    const h11 = {};
    for (const [file, language] of Object.entries(LANGUAGES)) {
      const result = await runPipeline(withLanguage(fixture(file), language));
      const key = file.replace('.json', '');
      const inferred = hintsOf(result, 'H10');
      const changed = hintsOf(result, 'H11');
      if (inferred.length) h10[key] = inferred.map((h) => h.elements);
      if (changed.length) h11[key] = changed.map((h) => h.message);
    }
    expect(h11).toEqual({
      'example-schadenmeldung': [
        '[Versicherung] Event "Prüfung beendet" (sp_end): its name gave marker "terminate" before a language was declared; under language "de" it gives no marker. Set "marker" explicitly.',
      ],
      'subprocess-child-fidelity': [
        expect.stringMatching(/Event "Deadline missed" \(c_end2\): its name gave marker "timer" before a language was declared; under language "en" it gives no marker\. Set "marker" explicitly\.$/),
      ],
    });
    expect(h10).toEqual({ 'example-bestellung-versand': [['b_end2']] });
  }, PIPELINE_TIMEOUT);

  test('without language no fixture gets a naming hint', async () => {
    for (const file of ['example-schadenmeldung', 'subprocess-child-fidelity', 'example-bestellung-versand']) {
      const result = await runPipeline(fixture(file));
      expect(result.validation.hints.filter((h) => h.code === 'H10' || h.code === 'H11')).toEqual([]);
    }
  }, PIPELINE_TIMEOUT);
});

describe('resolveEventMarkers', () => {
  test('without a supported language it only removes stray _marker keys', () => {
    for (const language of [undefined, 'fr', 'German', 'DE', 5, null, 'de" x="1']) {
      const lc = {
        id: 'P', language,
        nodes: [
          { id: 'a', type: 'endEvent', name: 'Fehler', _marker: 'timer' },
          { id: 't', type: 'userTask', name: 'Antrag prüfen', _marker: 'timer' },
          { id: 's', type: 'subProcess', name: 'S', nodes: [{ id: 'b', type: 'startEvent', name: 'Frist', _marker: null }] },
        ],
      };
      expect(resolveEventMarkers(lc)).toEqual({ inferred: [], changed: [] });
      expect(JSON.stringify(lc)).not.toContain('_marker');
    }
  });

  test('never throws on a root or nodes of the wrong shape', () => {
    for (const lc of [null, undefined, 5, 'de', [], { language: 'de' }, { language: 'de', nodes: 5 }, { language: 'de', pools: 'x' },
      { language: 'de', pools: [null, 5, { nodes: [null, 7, 'x'] }] }]) {
      expect(resolveEventMarkers(lc)).toEqual({ inferred: [], changed: [] });
    }
  });

  test('writes _marker on every event without a marker, at every nesting level', () => {
    const lc = {
      language: 'de',
      pools: [{
        id: 'P1', name: 'Bank',
        nodes: [
          { id: 'e1', type: 'startEvent', name: 'Nachricht eingegangen', _marker: 'error' },
          { id: 'e2', type: 'endEvent', name: 'Fehler gemeldet', marker: 'terminate', _marker: 'error' },
          { id: 't', type: 'userTask', name: 'Frist prüfen', _marker: 'timer' },
          { id: 's', type: 'subProcess', name: 'Prüfung', nodes: [
            { id: 'e3', type: 'endEvent', name: 'Prüfung beendet' },
            { id: 'e4', type: 'boundaryEvent', name: 'Fristablauf' },
            { id: 'e5', type: 'endEvent' },
          ] },
        ],
      }],
    };
    const marked = resolveEventMarkers(lc);
    const nodes = lc.pools[0].nodes;
    expect(nodes[0]._marker).toBe('message');
    expect(Object.hasOwn(nodes[1], '_marker')).toBe(false);
    expect(Object.hasOwn(nodes[2], '_marker')).toBe(false);
    expect(Object.hasOwn(nodes[3], '_marker')).toBe(false);
    expect(nodes[3].nodes.map((n) => n._marker)).toEqual([null, 'timer', null]);
    expect(marked.inferred).toEqual([
      { id: 'e1', name: 'Nachricht eingegangen', type: 'startEvent', marker: 'message', legacy: 'message', pool: 'Bank' },
      { id: 'e4', name: 'Fristablauf', type: 'boundaryEvent', marker: 'timer', legacy: 'timer', pool: 'Bank' },
    ]);
    expect(marked.changed).toEqual([
      { id: 'e3', name: 'Prüfung beendet', type: 'endEvent', marker: null, legacy: 'terminate', pool: 'Bank' },
    ]);
  });

  test('a single process has no pool', () => {
    const lc = { language: 'en', nodes: [{ id: 'e', type: 'boundaryEvent', name: 'Deadline missed' }] };
    expect(resolveEventMarkers(lc).inferred).toEqual([
      { id: 'e', name: 'Deadline missed', type: 'boundaryEvent', marker: 'timer', legacy: 'timer', pool: null },
    ]);
  });
});

describe('namingHints', () => {
  const a = { id: 'a', name: 'Fristablauf', type: 'boundaryEvent', marker: 'timer', legacy: 'timer', pool: null };
  const b = { id: 'b', name: 'Zeitung gelesen', type: 'startEvent', marker: null, legacy: 'timer', pool: 'Bank' };
  const c = { id: 'c', name: 'Mail zur Frist', type: 'startEvent', marker: 'message', legacy: 'timer', pool: null };
  const d = { id: 'd', name: 'Fehlerfall', type: 'boundaryEvent', marker: 'error', legacy: 'error', pool: 'Bank' };

  test('H10 per inferred marker, then H11 per changed one; an event in both lists gets H11 only', () => {
    expect(namingHints({ language: 'de-CH' }, { inferred: [a, c, d], changed: [b, c] })).toEqual([
      { code: 'H10', message: 'Event "Fristablauf" (a): marker "timer" inferred from its name (language "de-CH").', elements: ['a'] },
      { code: 'H10', message: '[Bank] Event "Fehlerfall" (d): marker "error" inferred from its name (language "de-CH").', elements: ['d'] },
      { code: 'H11', message: '[Bank] Event "Zeitung gelesen" (b): its name gave marker "timer" before a language was declared; under language "de-CH" it gives no marker. Set "marker" explicitly.', elements: ['b'] },
      { code: 'H11', message: 'Event "Mail zur Frist" (c): its name gave marker "timer" before a language was declared; under language "de-CH" it gives "message". Set "marker" explicitly.', elements: ['c'] },
    ]);
  });

  test('nothing to report gives no hint', () => {
    expect(namingHints({ language: 'de' })).toEqual([]);
    expect(namingHints({ language: 'de' }, {})).toEqual([]);
    expect(namingHints({}, { inferred: [], changed: [] })).toEqual([]);
  });

  test('H10 and H11 are registered hint codes', () => {
    expect(MESSAGE_CODES.H10.family).toBe('hint');
    expect(MESSAGE_CODES.H11.family).toBe('hint');
  });
});

describe('Review Focus 5: XML, SVG and rules agree under a declared language', () => {
  test('example-bestellung-versand + de: the inferred escalation reaches XML, SVG, S17 and one H10', async () => {
    const model = withLanguage(fixture('example-bestellung-versand'), 'de');
    const event = eventsOf(model).find((n) => n.name === 'Eskalation erfasst');
    expect(event.marker).toBeUndefined();
    const result = await runPipeline(model);
    expect(result.validation.errors).toEqual([]);
    expect(xmlElement(result.bpmnXml, event.id)).toContain('escalationEventDefinition');
    const c = result.coordMap.coords[event.id];
    const icon = renderEventMarker('escalation', c.w, c.h, true, event.color);
    expect(icon).not.toBe('');
    expect(result.svg).toContain(icon);
    const h10 = hintsOf(result, 'H10');
    expect(h10).toHaveLength(1);
    expect(h10[0].elements).toEqual([event.id]);
    expect(h10[0].message).toContain(`Event "Eskalation erfasst" (${event.id}): marker "escalation" inferred from its name (language "de").`);
    expect(hintsOf(result, 'H11')).toEqual([]);

    // S17 sees the same marker: two escalation definitions make the event's reference ambiguous.
    const ambiguous = { ...structuredClone(model), definitions: [
      { id: 'Esc_1', type: 'escalation', name: 'Eins' }, { id: 'Esc_2', type: 'escalation', name: 'Zwei' },
    ] };
    const s17 = (warnings) => warnings.filter((w) => w.includes(`Event "${event.id}"`) && w.includes('has marker "escalation"'));
    const piped = await runPipeline(ambiguous);
    expect(s17(piped.validation.warnings)).toHaveLength(1);
    expect(s17(validateLogicCore(ambiguous).warnings)).toEqual(s17(piped.validation.warnings));
  }, PIPELINE_TIMEOUT);

  test('example-schadenmeldung + de: no terminate definition; an explicit marker wins and gives no hint', async () => {
    const plain = await runPipeline(fixture('example-schadenmeldung'));
    expect(plain.bpmnXml).toContain('terminateEventDefinition');

    const german = await runPipeline(withLanguage(fixture('example-schadenmeldung'), 'de'));
    expect(german.validation.errors).toEqual([]);
    expect(german.bpmnXml).not.toContain('terminateEventDefinition');
    expect(hintsOf(german, 'H11').map((h) => h.elements)).toEqual([['sp_end']]);

    const explicit = withLanguage(fixture('example-schadenmeldung'), 'de');
    findNode(explicit, 'sp_end').marker = 'terminate';
    const result = await runPipeline(explicit);
    expect(xmlElement(result.bpmnXml, 'sp_end')).toContain('terminateEventDefinition');
    expect(result.validation.hints.filter((h) => h.elements.includes('sp_end'))).toEqual([]);
    const c = result.coordMap.coords.sp_end;
    expect(result.svg).toContain(renderEventMarker('terminate', c.w, c.h, true, undefined));
    expect(german.svg).not.toContain(renderEventMarker('terminate', c.w, c.h, true, undefined));
  }, PIPELINE_TIMEOUT);

  test('inline de model: compounds keep their marker, "Zeitung" is no timer; the import carries both', async () => {
    const model = inlineGerman();
    const result = await runPipeline(model);
    expect(result.validation.errors).toEqual([]);
    expect(xmlElement(result.bpmnXml, 'b_frist')).toContain('timerEventDefinition');
    expect(xmlElement(result.bpmnXml, 'b_fehler')).toContain('errorEventDefinition');
    expect(xmlElement(result.bpmnXml, 'start')).not.toContain('EventDefinition');
    expect(hintsOf(result, 'H10')).toEqual([
      { code: 'H10', message: 'Event "Fristablauf" (b_frist): marker "timer" inferred from its name (language "de").', elements: ['b_frist'] },
      { code: 'H10', message: 'Event "Fehlerfall" (b_fehler): marker "error" inferred from its name (language "de").', elements: ['b_fehler'] },
    ]);
    expect(hintsOf(result, 'H11')).toEqual([
      { code: 'H11', message: 'Event "Zeitung gelesen" (start): its name gave marker "timer" before a language was declared; under language "de" it gives no marker. Set "marker" explicitly.', elements: ['start'] },
    ]);
    const sFrist = result.coordMap.coords.b_frist;
    expect(result.svg).toContain(renderEventMarker('timer', sFrist.w, sFrist.h, false, undefined));

    const imported = await bpmnToLogicCore(result.bpmnXml);
    expect(imported.language).toBe('de');
    const markers = Object.fromEntries(eventsOf(imported).map((n) => [n.id, n.marker ?? null]));
    expect(markers).toEqual({ start: null, b_frist: 'timer', b_fehler: 'error', ende: null, ende_frist: null, ende_fehler: null });
    // Generated again, the imported model gives the same markers and no naming hint for them.
    const again = await runPipeline(imported);
    expect(xmlElement(again.bpmnXml, 'b_frist')).toContain('timerEventDefinition');
    expect(xmlElement(again.bpmnXml, 'b_fehler')).toContain('errorEventDefinition');
    expect(xmlElement(again.bpmnXml, 'start')).not.toContain('EventDefinition');
    expect(hintsOf(again, 'H10')).toEqual([]);
  }, PIPELINE_TIMEOUT);

  test('the result carries no _marker and the caller\'s model is never mutated', async () => {
    for (const model of [inlineGerman(), withLanguage(fixture('example-schadenmeldung'), 'de')]) {
      const before = structuredClone(model);
      const result = await runPipeline(model);
      expect(model).toEqual(before);
      expect(JSON.stringify(model)).not.toContain('_marker');
      expect(result.bpmnXml).not.toContain('_marker');
      expect(result.svg).not.toContain('_marker');
      validateLogicCore(model);
      runRules(model);
      expect(model).toEqual(before);
    }
  }, PIPELINE_TIMEOUT);

  test('validateLogicCore on a de model gives the S16/S17 findings of runPipeline', async () => {
    // S16: under "de" the end event "Prüfung beendet" has no marker, so its errorRef is refused.
    const model = withLanguage(fixture('example-schadenmeldung'), 'de');
    model.definitions = [{ id: 'Err_1', type: 'error', name: 'Fehler' }];
    findNode(model, 'sp_end').errorRef = 'Err_1';
    const about = (list) => list.filter((m) => m.includes('"sp_end"'));
    const direct = validateLogicCore(model);
    const piped = await runPipeline(model);
    const directAll = [...direct.errors, ...direct.warnings];
    expect(about(directAll).some((m) => m.includes('its marker is absent, not "error"'))).toBe(true);
    expect(about([...piped.validation.errors, ...piped.validation.warnings])).toEqual(about(directAll));

    // The same model without language: the legacy marker, in the legacy wording.
    const legacy = structuredClone(model);
    delete legacy.language;
    const plain = validateLogicCore(legacy);
    expect(about([...plain.errors, ...plain.warnings]).some((m) => m.includes('its marker is "terminate", not "error"'))).toBe(true);
  }, PIPELINE_TIMEOUT);
});

describe('Review Focus 2: drill-down', () => {
  test('example-schadenmeldung + de: the child diagram has no terminate definition', async () => {
    const plain = await generateDiagramSet(fixture('example-schadenmeldung'));
    const childId = Object.keys(plain.subProcesses).find((id) => plain.subProcesses[id].bpmnXml.includes('Prüfung beendet'));
    expect(childId).toBeDefined();
    expect(plain.subProcesses[childId].bpmnXml).toContain('terminateEventDefinition');
    expect(plain.subProcesses[childId].validation.hints.filter((h) => /^H1[01]$/.test(h.code))).toEqual([]);

    const german = await generateDiagramSet(withLanguage(fixture('example-schadenmeldung'), 'de'));
    const child = german.subProcesses[childId];
    expect(child.validation.errors).toEqual([]);
    expect(child.bpmnXml).not.toContain('terminateEventDefinition');
    expect(hintsOf(child, 'H11').map((h) => h.elements)).toEqual([['sp_end']]);
  }, PIPELINE_TIMEOUT);
});

describe('Review Focus 1: a language that is no supported tag behaves like no language', () => {
  test('invalid values and "fr": hints, XML and SVG of the run without the field', async () => {
    const base = await runPipeline(fixture('example-schadenmeldung'));
    for (const language of ['German', 'DE', 5, null, 'de" x="1']) {
      const result = await runPipeline(withLanguage(fixture('example-schadenmeldung'), language));
      expect(result.validation.hints).toEqual(base.validation.hints);
      expect(result.bpmnXml).toBe(base.bpmnXml);
      expect(result.svg).toBe(base.svg);
    }
    // "fr" is a valid tag without naming data: the XML names it (the attribute and its namespace
    // declaration) and nothing else differs.
    const french = await runPipeline(withLanguage(fixture('example-schadenmeldung'), 'fr'));
    expect(french.validation.hints).toEqual(base.validation.hints);
    expect(french.svg).toBe(base.svg);
    expect(french.bpmnXml).toContain(' bg:language="fr"');
    expect(french.bpmnXml.replace(' bg:language="fr"', '').replace(' xmlns:bg="http://bpmn-generator/schema/1.0"', '')).toBe(base.bpmnXml);
  }, PIPELINE_TIMEOUT);

  test('a stray _marker on a model without language changes nothing', async () => {
    const clean = fixture('subprocess-child-fidelity');
    const stray = structuredClone(clean);
    for (const n of eventsOf(stray)) n._marker = 'timer';
    const before = structuredClone(stray);
    const a = await runPipeline(clean);
    const b = await runPipeline(stray);
    expect(stray).toEqual(before);
    expect(b.bpmnXml).toBe(a.bpmnXml);
    expect(b.svg).toBe(a.svg);
    expect(b.validation).toEqual(a.validation);
    expect(b.coordMap).toEqual(a.coordMap);
    expect(runRules(stray)).toEqual(runRules(clean));
    expect(validateLogicCore(stray)).toEqual(validateLogicCore(clean));
    expect(stray).toEqual(before);
  }, PIPELINE_TIMEOUT);
});

describe('the modules load in any order', () => {
  const url = (rel) => pathToFileURL(join(SCRIPTS, rel)).href;
  test.each(['bpmn/icons.js', 'bpmn/rules.js', 'bpmn/svg.js', 'bpmn/bpmn-xml.js', 'bpmn/naming/index.js'])(
    'a fresh process imports %s first and reads no naming data', (rel) => {
      const code = `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        const seen = [];
        for (const k of ['readFileSync', 'openSync']) {
          const orig = fs[k];
          fs[k] = (p, ...a) => { seen.push(String(p)); return orig(p, ...a); };
        }
        syncBuiltinESMExports();
        const mod = await import(${JSON.stringify(url(rel))});
        const icons = await import(${JSON.stringify(url('bpmn/icons.js'))});
        const naming = await import(${JSON.stringify(url('bpmn/naming/index.js'))});
        console.log(JSON.stringify({
          exports: Object.keys(mod).length,
          legacy: icons.markerOf({ type: 'endEvent', name: 'Deadline missed' }),
          resolved: naming.resolveEventMarkers({ nodes: [{ id: 'e', type: 'endEvent', name: 'Deadline missed' }] }),
          naming: seen.filter(p => /[\\\\/]references[\\\\/]naming/.test(p)),
        }));
      `;
      const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' }).trim());
      expect(out.exports).toBeGreaterThan(0);
      expect(out.legacy).toBe('timer');
      expect(out.resolved).toEqual({ inferred: [], changed: [] });
      expect(out.naming).toEqual([]);
    });
});

describe('the response contract', () => {
  test('accepts H10 and H11 hints of a real response', async () => {
    const gen = await runPipeline(inlineGerman());
    expect(hintsOf(gen, 'H10').length).toBeGreaterThan(0);
    expect(hintsOf(gen, 'H11').length).toBeGreaterThan(0);
    const response = {
      correlationId: 'test', status: 'success', bpmnXml: gen.bpmnXml, svg: gen.svg,
      validation: gen.validation, diagnostics: gen.diagnostics, callbackStatus: 'not_requested',
    };
    const schema = JSON.parse(readFileSync(join(REPO, 'references', 'api-schema.json'), 'utf8'));
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    expect(checkResponseContract([['GenerateResponse', 'generate of a de model', response]], schema, ajv)).toEqual([]);
    const hintCode = new RegExp(schema.$defs.Validation.properties.hints.items.properties.code.pattern);
    expect(hintCode.source).toBe('^H(0[1-9]|1[0-9])$');
    expect(hintCode.test('H10')).toBe(true);
    expect(hintCode.test('H00')).toBe(false);
    expect(hintCode.test('H20')).toBe(false);
  }, PIPELINE_TIMEOUT);
});

describe('format 2.0 and blocked results', () => {
  test('a format 2.0 model with language de: inferred definition in the XML and an H10 hint', async () => {
    const v2 = JSON.parse(readFileSync(join(REPO, 'tests', 'fixtures-v2', 'schaden.json'), 'utf8'));
    const catalog = JSON.parse(readFileSync(join(REPO, 'tests', 'fixtures-v2', 'schaden-catalog.json'), 'utf8'));
    const model = { ...structuredClone(v2), language: 'de' };
    model.nodes.find((n) => n.id === 'start').name = 'Nachricht eingegangen';
    const result = await runPipeline(model, { catalog: structuredClone(catalog) });
    expect(result.validation.errors).toEqual([]);
    expect(xmlElement(result.bpmnXml, 'start')).toContain('messageEventDefinition');
    const h10 = hintsOf(result, 'H10');
    expect(h10).toHaveLength(1);
    expect(h10[0].message).toContain('start');
  }, PIPELINE_TIMEOUT);

  test('a blocked de result keeps hints: []', async () => {
    const model = withLanguage(fixture('simple-approval'), 'de');
    model.pools[0].edges.push({ source: 'start1', target: 'does_not_exist' });
    const result = await runPipeline(model);
    expect(result.bpmnXml).toBeNull();
    expect(result.validation.errors.length).toBeGreaterThan(0);
    expect(result.validation.hints).toEqual([]);
  }, PIPELINE_TIMEOUT);
});

/**
 * `marker: "none"`: a plain event on purpose. It suppresses every marker inference (under a
 * declared language and without one), is drawn and written without an event definition, carries
 * `bg:marker="none"` in the XML so both importers read it back, and is reported by S15 on an
 * event type that needs a definition (boundary, intermediate catch).
 */
import { describe, test, expect } from '@jest/globals';
import { runPipeline } from './pipeline.js';
import { validateLogicCoreSchema, validateModelSchema } from './schema-gate.js';
import { validateLogicCore } from './validate.js';
import { bpmnToLogicCore, bpmnToLogicCoreLegacy } from './import.js';
import { markerOf, resolvedMarkerOf, renderEventMarker } from './icons.js';
import { MARKER_NONE_ALLOWED_ON, allowsMarkerNone } from './naming/markers.js';
import { resolveEventMarkers, namingHints } from './naming/index.js';

const PIPELINE_TIMEOUT = 120_000;
const READERS = [['moddle', bpmnToLogicCore], ['legacy', bpmnToLogicCoreLegacy]];
const PLAIN_TYPES = ['startEvent', 'endEvent', 'intermediateThrowEvent'];

const xmlElement = (xml, id) => {
  const m = new RegExp(`<bpmn:(\\w+) id="${id}"[^>]*?(?:/>|>[\\s\\S]*?</bpmn:\\1>)`).exec(xml);
  return m ? m[0] : null;
};
const findNode = (model, id) => {
  let hit = null;
  const walk = (nodes) => { for (const n of nodes ?? []) { if (n.id === id) hit = n; walk(n.nodes); } };
  for (const p of model.pools ?? [model]) walk(p.nodes);
  return hit;
};
const s15 = (warnings, id) => warnings.filter((w) => w.includes(`Node "${id}"`) && w.includes('"none"'));
const naming = (result) => result.validation.hints.filter((h) => h.code === 'H10' || h.code === 'H11');

/**
 * Start, an intermediate throw event, a task with a boundary event, an intermediate catch event and
 * two ends; every event named so that both the legacy inference and the language would give a marker.
 */
const NAMES = {
  de: { s: 'Frist abgelaufen', th: 'Eskalation erfasst', t: 'Bestellung prüfen', b: 'Frist abgelaufen',
    c: 'Nachricht erhalten', e: 'Fehler aufgetreten', eb: 'Bestellung erledigt' },
  en: { s: 'Deadline passed', th: 'Escalation raised', t: 'Check order', b: 'Deadline passed',
    c: 'Message received', e: 'Error occurred', eb: 'Order done' },
};
function model({ language, marker = {} } = {}) {
  const n = NAMES[language === 'en' ? 'en' : 'de'];
  const m = {
    id: 'P', name: 'Bestellung',
    nodes: [
      { id: 's', type: 'startEvent', name: n.s },
      { id: 'th', type: 'intermediateThrowEvent', name: n.th },
      { id: 't', type: 'userTask', name: n.t },
      { id: 'b', type: 'boundaryEvent', attachedTo: 't', name: n.b },
      { id: 'c', type: 'intermediateCatchEvent', name: n.c },
      { id: 'e', type: 'endEvent', name: n.e },
      { id: 'eb', type: 'endEvent', name: n.eb },
    ],
    edges: [
      { source: 's', target: 'th' }, { source: 'th', target: 't' }, { source: 't', target: 'c' },
      { source: 'c', target: 'e' }, { source: 'b', target: 'eb' },
    ],
  };
  if (language) m.language = language;
  for (const [id, value] of Object.entries(marker)) findNode(m, id).marker = value;
  return m;
}
const allNone = (ids) => Object.fromEntries(ids.map((id) => [id, 'none']));

describe('schema: "none" is a marker value in 1.x and 2.0', () => {
  test.each(PLAIN_TYPES)('1.x accepts marker "none" on a %s', (type) => {
    const lc = { id: 'p', nodes: [{ id: 'n', type, marker: 'none' }], edges: [] };
    expect(validateLogicCoreSchema(lc)).toEqual({ valid: true, errors: [] });
  });
  test.each(PLAIN_TYPES)('2.0 accepts marker "none" on a %s', (type) => {
    const m = { $schemaVersion: '2.0', id: 'p', nodes: [{ id: 'n', type, marker: 'none' }], edges: [] };
    expect(validateModelSchema(m, { accept: ['1', '2'] })).toEqual({ valid: true, errors: [], format: '2' });
  });
  test('an unknown marker is still refused', () => {
    const lc = { id: 'p', nodes: [{ id: 'n', type: 'endEvent', marker: 'nothing' }], edges: [] };
    expect(validateLogicCoreSchema(lc).valid).toBe(false);
  });
  test('the event types a plain event may be: start, end, intermediate throw', () => {
    expect(MARKER_NONE_ALLOWED_ON).toEqual(PLAIN_TYPES);
  });
});

/** A process with an ordinary subprocess and an event subprocess, each starting with `startName`. */
function withEventSubProcess({ language, startMarker, nested = false } = {}) {
  const esp = { id: 'esp', type: 'subProcess', name: 'Frist überwachen', isEventSubProcess: true, isExpanded: true,
    nodes: [{ id: 'es', type: 'startEvent', name: 'Frist abgelaufen' }, { id: 'ee', type: 'endEvent', name: 'Frist gemeldet' }],
    edges: [{ source: 'es', target: 'ee' }] };
  if (startMarker) esp.nodes[0].marker = startMarker;
  const sp = { id: 'sp', type: 'subProcess', name: 'Teil', isExpanded: true,
    nodes: [{ id: 'cs', type: 'startEvent', name: 'Frist abgelaufen', ...(startMarker ? { marker: startMarker } : {}) },
      { id: 'ce', type: 'endEvent', name: 'Teil erledigt' }, ...(nested ? [esp] : [])],
    edges: [{ source: 'cs', target: 'ce' }] };
  const lc = { id: 'p', name: 'P', nodes: [{ id: 's', type: 'startEvent', name: 'Beginn' }, sp,
    { id: 'e', type: 'endEvent', name: 'Ende' }, ...(nested ? [] : [esp])],
  edges: [{ source: 's', target: 'sp' }, { source: 'sp', target: 'e' }] };
  if (language) lc.language = language;
  return lc;
}

describe('the start event of an event subprocess needs a trigger', () => {
  test('allowsMarkerNone: not on such a start, yes on the start of an ordinary subprocess', () => {
    const start = { id: 'x', type: 'startEvent' };
    expect(allowsMarkerNone(start, null)).toBe(true);
    expect(allowsMarkerNone(start, { type: 'subProcess' })).toBe(true);
    expect(allowsMarkerNone(start, { type: 'subProcess', isEventSubProcess: true })).toBe(false);
    expect(allowsMarkerNone(start, { type: 'transaction', isEventSubProcess: true })).toBe(false);
    expect(allowsMarkerNone({ id: 'y', type: 'endEvent' }, { type: 'subProcess', isEventSubProcess: true })).toBe(true);
    expect(allowsMarkerNone({ id: 'z', type: 'boundaryEvent' }, null)).toBe(false);
  });
  test.each([[false], [true]])('S15 reports "none" on it (nested in a subprocess: %s), not on an ordinary subprocess start', (nested) => {
    const { warnings } = validateLogicCore(withEventSubProcess({ startMarker: 'none', nested }));
    expect(s15(warnings, 'es')).toEqual([
      'Node "es" (Frist abgelaufen) is a startEvent of an event subprocess and carries "marker": "none", but OMG '
        + 'requires the start event of an event subprocess to carry an event definition (its trigger). The event is '
        + 'written without one — set "marker" to its trigger, or use a start, end or intermediate throw event outside '
        + 'an event subprocess for a plain event.',
    ]);
    expect(s15(warnings, 'cs')).toEqual([]);
  });
  test.each([[false], [true]])('H10 offers "none" for the ordinary start only (nested: %s)', (nested) => {
    const lc = withEventSubProcess({ language: 'de', nested });
    const marked = resolveEventMarkers(lc);
    const h10 = Object.fromEntries(namingHints(lc, marked).filter((h) => h.code === 'H10').map((h) => [h.elements[0], h.message]));
    expect(h10.cs).toBe('Event "Frist abgelaufen" (cs): marker "timer" inferred from its name (language "de"). '
      + 'To change it, set "marker" to the symbol you want, or to "none" for a plain event.');
    expect(h10.es).toBe('Event "Frist abgelaufen" (es): marker "timer" inferred from its name (language "de"). '
      + 'To change it, set "marker" to the symbol you want.');
  });
});

describe('S16 names "none"', () => {
  test('a messageRef on a "none" event: the marker is named as a plain event; without marker the text is as before', () => {
    const lc = (marker) => ({ id: 'p', definitions: [{ id: 'M1', type: 'message', name: 'Bestellung' }],
      nodes: [{ id: 's', type: 'startEvent', name: 'Beginn', messageRef: 'M1', ...(marker ? { marker } : {}) },
        { id: 'e', type: 'endEvent', name: 'Ende' }], edges: [{ source: 's', target: 'e' }] });
    const s16 = (r) => r.errors.filter((m) => m.includes('carries "messageRef"'));
    expect(s16(validateLogicCore(lc('none')))).toEqual([
      'Node "s" (Beginn) carries "messageRef" ("M1"), but its marker is "none" (a plain event), not "message". The reference is not written — set marker "message" or remove the field.',
    ]);
    expect(s16(validateLogicCore(lc()))).toEqual([
      'Node "s" (Beginn) carries "messageRef" ("M1"), but its marker is absent, not "message". The reference is not written — set marker "message" or remove the field.',
    ]);
  });
});

describe('the readers of a marker see no marker', () => {
  test('markerOf and resolvedMarkerOf give null for "none", with and without a language', () => {
    const n = { id: 'e', type: 'endEvent', name: 'Fehler aufgetreten', marker: 'none' };
    expect(markerOf(n)).toBeNull();
    expect(markerOf(n, 'de')).toBeNull();
    expect(markerOf(n, 'en')).toBeNull();
    expect(resolvedMarkerOf(n)).toBeNull();
    expect(resolvedMarkerOf({ ...n, _marker: 'error' })).toBeNull();
  });
});

describe('S15 reports "none" where BPMN needs an event definition', () => {
  test('boundary and intermediate catch events are reported, start, end and throw are not', () => {
    const { warnings } = validateLogicCore(model({ marker: allNone(['s', 'th', 'b', 'c', 'e']) }));
    expect(s15(warnings, 'b')).toEqual([
      'Node "b" (Frist abgelaufen) is a boundaryEvent and carries "marker": "none", but OMG requires a boundary '
        + 'event or an intermediate catch event to carry an event definition (its trigger). The event is written without '
        + 'one — set "marker" to its trigger, or use a start, end or intermediate throw event for a plain event.',
    ]);
    expect(s15(warnings, 'c')).toHaveLength(1);
    expect(s15(warnings, 'c')[0]).toContain('is an intermediateCatchEvent and carries "marker": "none"');
    for (const id of ['s', 'th', 'e']) expect(s15(warnings, id)).toEqual([]);
  });
  test('inside a subprocess too', () => {
    const lc = { id: 'p', nodes: [
      { id: 's', type: 'startEvent' },
      { id: 'sp', type: 'subProcess', name: 'Teil', isExpanded: true, nodes: [
        { id: 'cs', type: 'startEvent' }, { id: 'cc', type: 'intermediateCatchEvent', name: 'Warten', marker: 'none' },
        { id: 'ce', type: 'endEvent' }],
      edges: [{ source: 'cs', target: 'cc' }, { source: 'cc', target: 'ce' }] },
      { id: 'e', type: 'endEvent' }], edges: [{ source: 's', target: 'sp' }, { source: 'sp', target: 'e' }] };
    expect(s15(validateLogicCore(lc).warnings, 'cc')).toHaveLength(1);
  });
  test('a model without "none" gets no such warning', () => {
    const { warnings } = validateLogicCore(model());
    expect(warnings.filter((w) => w.includes('"none"'))).toEqual([]);
  });
});

describe.each([['without language', undefined], ['de', 'de'], ['en', 'en']])('"none" suppresses inference (%s)', (_label, language) => {
  test('no H10/H11 for the event, no event definition, no icon, bg:marker="none"', async () => {
    const plain = await runPipeline(model({ language }));
    const none = await runPipeline(model({ language, marker: allNone(['s', 'th', 'e']) }));
    expect(none.validation.errors).toEqual([]);
    for (const id of ['s', 'th', 'e']) {
      expect(naming(none).filter((h) => h.elements.includes(id))).toEqual([]);
      const el = xmlElement(none.bpmnXml, id);
      expect(el).not.toContain('EventDefinition');
      expect(el).toContain('bg:marker="none"');
    }
    // The model without "none" writes no bg:marker at all.
    expect(plain.bpmnXml).not.toContain('bg:marker');
    // The icon each name gives in the plain run is gone with "none" (the boundary event keeps its timer).
    const count = (svg, icon) => svg.split(icon).length - 1;
    for (const [id, icon, throwing] of [['s', 'timer', false], ['th', 'escalation', true], ['e', 'error', true]]) {
      const c = none.coordMap.coords[id];
      const drawn = renderEventMarker(icon, c.w, c.h, throwing, undefined);
      expect(count(plain.svg, drawn)).toBeGreaterThan(0);
      expect(count(none.svg, drawn)).toBe(count(plain.svg, drawn) - 1);
    }
    // An event without "none" keeps what it had.
    expect(xmlElement(none.bpmnXml, 'b')).toBe(xmlElement(plain.bpmnXml, 'b'));
  }, PIPELINE_TIMEOUT);
});

describe('the legacy inference without "none" still decides (control)', () => {
  test('the same names without "none" give event definitions', async () => {
    const plain = await runPipeline(model());
    expect(xmlElement(plain.bpmnXml, 's')).toContain('timerEventDefinition');
    expect(xmlElement(plain.bpmnXml, 'e')).toContain('errorEventDefinition');
    expect(xmlElement(plain.bpmnXml, 'th')).toContain('escalationEventDefinition');
  }, PIPELINE_TIMEOUT);
  test.each(['de', 'en'])('under %s the names give H10 without "none"', async (language) => {
    const plain = await runPipeline(model({ language }));
    expect(naming(plain).filter((h) => h.code === 'H10').map((h) => h.elements[0])).toEqual(expect.arrayContaining(['s', 'th', 'e']));
  }, PIPELINE_TIMEOUT);
});

describe('XML', () => {
  test('bg is declared once on definitions, also next to bg:language', async () => {
    for (const language of [undefined, 'de']) {
      const { bpmnXml } = await runPipeline(model({ language, marker: { e: 'none' } }));
      const defs = /<bpmn:definitions [^>]*>/.exec(bpmnXml)[0];
      expect(defs.match(/xmlns:bg=/g)).toHaveLength(1);
      expect(bpmnXml.match(/bg:marker="none"/g)).toHaveLength(1);
    }
  }, PIPELINE_TIMEOUT);
  test('"none" on a task writes nothing', async () => {
    const lc = model();
    findNode(lc, 't').marker = 'none';
    const { bpmnXml } = await runPipeline(lc);
    expect(bpmnXml).not.toContain('bg:marker');
  }, PIPELINE_TIMEOUT);
});

describe('round trip through both importers', () => {
  test.each(READERS)('%s: "none" comes back as "none", nothing else gains a field', async (_name, read) => {
    const lc = model({ marker: allNone(['s', 'th', 'e', 'b']) });
    const { bpmnXml } = await runPipeline(lc);
    const back = await read(bpmnXml);
    for (const id of ['s', 'th', 'e', 'b']) expect(findNode(back, id).marker).toBe('none');
    expect(findNode(back, 'c').marker).toBe('message');
    expect(findNode(back, 'eb').marker).toBeUndefined();
    for (const id of ['s', 'th', 'e', 'b']) expect(findNode(back, id).extensions).toBeUndefined();
    // Generated again from the import: the same XML.
    expect((await runPipeline(back)).bpmnXml).toBe(bpmnXml);
  }, PIPELINE_TIMEOUT);

  test.each(READERS)('%s: inside a subprocess', async (_name, read) => {
    const lc = { id: 'p', nodes: [
      { id: 's', type: 'startEvent' },
      { id: 'sp', type: 'subProcess', name: 'Teil', isExpanded: true, nodes: [
        { id: 'cs', type: 'startEvent', name: 'Frist abgelaufen', marker: 'none' }, { id: 'ce', type: 'endEvent' }],
      edges: [{ source: 'cs', target: 'ce' }] },
      { id: 'e', type: 'endEvent' }], edges: [{ source: 's', target: 'sp' }, { source: 'sp', target: 'e' }] };
    const back = await read((await runPipeline(lc)).bpmnXml);
    expect(findNode(back, 'cs').marker).toBe('none');
  }, PIPELINE_TIMEOUT);

  test.each(READERS)('%s: any prefix bound to the namespace counts; an event definition wins over the attribute', async (_name, read) => {
    const { bpmnXml } = await runPipeline(model({ marker: { e: 'none' } }));
    const renamed = bpmnXml.replace('xmlns:bg=', 'xmlns:gen=').replace(/bg:marker=/g, 'gen:marker=');
    expect(findNode(await read(renamed), 'e').marker).toBe('none');
    // A foreign tool gave the event a definition and left the attribute: the definition decides.
    const el = xmlElement(bpmnXml, 'e');
    expect(el.endsWith('</bpmn:endEvent>')).toBe(true);
    const withDef = bpmnXml.replace(el, el.replace('</bpmn:endEvent>', '<bpmn:terminateEventDefinition /></bpmn:endEvent>'));
    expect(withDef).toMatch(/<bpmn:endEvent id="e"[^>]*bg:marker="none"/);
    expect(findNode(await read(withDef), 'e').marker).toBe('terminate');
    // Both importers give the same model: the superseded attribute is no foreign attribute either.
    expect(findNode(await read(withDef), 'e').extensions).toBeUndefined();
    // An attribute in another namespace is no marker.
    const foreign = bpmnXml.replace(/bg:marker="none"/, 'xx:marker="none" xmlns:xx="urn:other"');
    expect(findNode(await read(foreign), 'e').marker).toBeUndefined();
  }, PIPELINE_TIMEOUT);
});

describe('format 2.0', () => {
  const CATALOG = { scheme: 'demi', actors: [{ id: 'sb', name: 'Sachbearbeitung', kind: 'role' }] };
  const MODEL = { $schemaVersion: '2.0', catalog: '../c.json', id: 'P', name: 'Schaden regulieren', language: 'de',
    nodes: [
      { id: 's', type: 'startEvent', name: 'Frist abgelaufen', marker: 'none' },
      { id: 't', type: 'userTask', name: 'Schaden prüfen', assignments: [{ type: 'D', actor: 'sb' }] },
      { id: 'e', type: 'endEvent', name: 'Fehler aufgetreten', marker: 'none' }],
    edges: [{ source: 's', target: 't' }, { source: 't', target: 'e' }] };
  test('a 2.0 model with "none" writes plain events with bg:marker and no naming hint', async () => {
    const result = await runPipeline(structuredClone(MODEL), { catalog: structuredClone(CATALOG) });
    expect(result.validation.errors).toEqual([]);
    for (const id of ['s', 'e']) {
      expect(xmlElement(result.bpmnXml, id)).not.toContain('EventDefinition');
      expect(xmlElement(result.bpmnXml, id)).toContain('bg:marker="none"');
    }
    expect(naming(result)).toEqual([]);
    for (const [, read] of READERS) expect(findNode(await read(result.bpmnXml), 'e').marker).toBe('none');
  }, PIPELINE_TIMEOUT);
});

/**
 * Symbol fidelity: does our SVG draw what bpmn.io draws for the BPMN XML we write? No browser.
 *
 * The oracle is the XML, read back through bpmn-moddle, and the decision logic of bpmn-js 18.6.2's
 * `lib/draw/BpmnRenderer.js` (read once from unpkg, encoded below; each expectation names the
 * handler it comes from). For every element the pipeline emits, the expected STRUCTURE — ring
 * count, dashed or solid, which icon, which bottom markers, which source-end marker — is derived
 * from the element's semantics and DI exactly as that renderer derives it, and compared with the
 * markup our SVG carries under the same `data-element-id`.
 *
 * Structure, not looks: which icon is drawn is checked; how our icon for that kind is drawn (size,
 * stroke, path) is not — the icon markup is taken from icons.js itself, so a cosmetic change there
 * moves both sides. That is deliberate. Stroke widths, icon sizes and marker order are the
 * separate, cosmetic stage of the symbol comparison; this fence is about the SVG telling a reader
 * something the XML does not (#83, #84, #85), which is a semantic defect.
 *
 * Two places where SVG and XML still disagree are pinned rather than skipped, so a fix turns them
 * red: an event with the `multiple`/`parallelMultiple` marker, which the XML cannot carry yet (#87),
 * and `isAdHoc`, which is unserialised (types.js `isAdHoc` row) while svg.js draws the tilde.
 *
 * Run over the symbol catalog (tests/fixtures/symbols/symbol-catalog.json — one small pool per
 * element class, built for the symbol comparison) and over every top-level fixture.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { BpmnModdle } from 'bpmn-moddle';

import { runPipeline } from './pipeline.js';
import { SHAPE, SW, CLR, INNER_OUTER_GAP } from './constants.js';
import {
  renderEventMarker, renderTaskIcon, renderLoopMarker, renderMIParallelMarker,
  renderMISequentialMarker, renderSubProcessMarker, renderAdHocMarker, renderCompensationMarker,
} from './icons.js';
import { rn } from '../shared/utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', '..', 'tests', 'fixtures');
const CATALOG = path.join(FIXTURES, 'symbols', 'symbol-catalog.json');
const moddle = new BpmnModdle();

// ── reading our SVG ──────────────────────────────────────────────────────────────────────────────

const DRAWABLE = /<(circle|rect|line|path|polygon|ellipse)\b([^>]*?)\/?>/g;
const attrsOf = (s) => Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const shapesIn = (markup) => [...markup.matchAll(DRAWABLE)].map((m) => ({ tag: m[1], a: attrsOf(m[2]) }));

/** `id` → the markup of its `<g data-element-id>` group (nodes) or `<path data-element-id>` (connections). */
function svgIndex(svg) {
  const groups = new Map();
  const opener = /<g data-element-id="([^"]*)">/g;
  for (const m of svg.matchAll(opener)) {
    let depth = 1, i = m.index + m[0].length;
    while (depth > 0) {
      const open = svg.indexOf('<g', i), close = svg.indexOf('</g>', i);
      if (open !== -1 && open < close) { depth++; i = open + 2; } else { depth--; i = close + 4; }
    }
    groups.set(m[1], svg.slice(m.index + m[0].length, i - 4));
  }
  const paths = new Map([...svg.matchAll(/<path data-element-id="([^"]*)"([^>]*)\/>/g)].map((m) => [m[1], attrsOf(m[2])]));
  return { groups, paths };
}

/** Bottom-marker groups of an activity, by kind, in drawn order. */
const MARKER_KIND = new Map([
  [renderLoopMarker(0, 0), 'loop'], [renderMIParallelMarker(0, 0), 'mi-parallel'],
  [renderMISequentialMarker(0, 0), 'mi-sequential'], [renderSubProcessMarker(0, 0), 'subprocess'],
  [renderAdHocMarker(0, 0), 'adhoc'], [renderCompensationMarker(0, 0), 'compensation'],
]);
const MARKER_GROUP = /<g transform="translate\([^)]*\)">(.*?)<\/g>/g;
const bottomMarkers = (frag) => [...frag.matchAll(MARKER_GROUP)].map((m) => MARKER_KIND.get(m[1]) ?? `unknown:${m[1]}`);

// ── reading the XML ──────────────────────────────────────────────────────────────────────────────

async function readXml(xml) {
  const { rootElement } = await moddle.fromXML(xml);
  const elements = new Map();
  const visit = (container) => {
    for (const el of [...(container.flowElements || []), ...(container.artifacts || [])]) {
      elements.set(el.id, el);
      if (el.flowElements || el.artifacts) visit(el);
    }
  };
  for (const root of rootElement.rootElements) {
    if (root.$type === 'bpmn:Process') visit(root);
    if (root.$type === 'bpmn:Collaboration') for (const mf of root.messageFlows || []) elements.set(mf.id, mf);
  }
  // The main diagram only: a collapsed subprocess's children sit on a plane of their own, which
  // bpmn.io shows on drill-down and our single SVG does not draw at all.
  const di = new Map();
  const main = (rootElement.diagrams || [])[0];
  for (const pe of main?.plane.planeElement || []) if (pe.bpmnElement) di.set(pe.bpmnElement.id, pe);
  return { elements, di };
}

const is = (el, ...types) => types.some((t) => el.$instanceOf(t));

// ── bpmn-js 18.6.2 expectations (lib/draw/BpmnRenderer.js) ──────────────────────────────────────

/** `renderEventIcon`: several definitions → multiple/parallelMultiple, else the first of this order. */
const ICON_ORDER = [
  ['bpmn:MessageEventDefinition', 'message'], ['bpmn:TimerEventDefinition', 'timer'],
  ['bpmn:ConditionalEventDefinition', 'conditional'], ['bpmn:SignalEventDefinition', 'signal'],
  ['bpmn:EscalationEventDefinition', 'escalation'], ['bpmn:LinkEventDefinition', 'link'],
  ['bpmn:ErrorEventDefinition', 'error'], ['bpmn:CancelEventDefinition', 'cancel'],
  ['bpmn:CompensateEventDefinition', 'compensation'], ['bpmn:TerminateEventDefinition', 'terminate'],
];
function expectedEventIcon(el) {
  const defs = el.eventDefinitions || [];
  if (defs.length > 1) return el.parallelMultiple ? 'parallelMultiple' : 'multiple';
  for (const [type, kind] of ICON_ORDER) if (defs.some((d) => d.$type === type)) return kind;
  return null;
}

/**
 * Handlers 'bpmn:StartEvent' (dashed when !isInterrupting), 'bpmn:IntermediateEvent' (two rings,
 * never dashed), 'bpmn:BoundaryEvent' (two rings, dashed when !cancelActivity), 'bpmn:EndEvent'.
 * The icon is filled for a throw event (`isThrowEvent`: IntermediateThrowEvent, EndEvent).
 */
function expectedEvent(el) {
  const twoRings = is(el, 'bpmn:IntermediateCatchEvent', 'bpmn:IntermediateThrowEvent', 'bpmn:BoundaryEvent');
  const dashed = is(el, 'bpmn:StartEvent') ? !el.isInterrupting
    : is(el, 'bpmn:BoundaryEvent') ? !el.cancelActivity : false;
  return { rings: twoRings ? 2 : 1, dashed, icon: expectedEventIcon(el) };
}

/**
 * Gateway handlers. 'bpmn:ExclusiveGateway' draws its X only when the DI says `isMarkerVisible`;
 * 'bpmn:EventBasedGateway' draws a ring at offset 0.20·h always, then for `Parallel` an outlined
 * plus, else a second ring at offset 0.26·h unless `instantiate`, and the pentagon.
 */
function expectedGateway(el, di, w, h) {
  if (is(el, 'bpmn:EventBasedGateway')) {
    const ring = (off) => Math.round((w + h) / 4 - off);
    const parallel = el.eventGatewayType === 'Parallel';
    const rings = parallel || el.instantiate ? [ring(h * 0.20)] : [ring(h * 0.20), ring(h * 0.26)];
    return { inner: parallel ? 'plus-outline' : 'pentagon', rings };
  }
  if (is(el, 'bpmn:ExclusiveGateway')) return { inner: di?.isMarkerVisible ? 'x' : 'none' };
  if (is(el, 'bpmn:ParallelGateway')) return { inner: 'plus' };
  if (is(el, 'bpmn:InclusiveGateway')) return { inner: 'circle' };
  if (is(el, 'bpmn:ComplexGateway')) return { inner: 'asterisk' };
  return { inner: 'none' };
}

/** The task-type handlers ('bpmn:UserTask' …); 'bpmn:ReceiveTask' switches on `instantiate`. */
const TASK_ICON = [
  ['bpmn:UserTask', 'userTask'], ['bpmn:ServiceTask', 'serviceTask'], ['bpmn:SendTask', 'sendTask'],
  ['bpmn:ReceiveTask', 'receiveTask'], ['bpmn:ManualTask', 'manualTask'],
  ['bpmn:ScriptTask', 'scriptTask'], ['bpmn:BusinessRuleTask', 'businessRuleTask'],
];

/**
 * `renderSubProcess` (SubProcess, Transaction, CallActivity): dashed border for an event
 * subprocess, [+] when collapsed; 'bpmn:Transaction' adds an inner border; 'bpmn:CallActivity' a
 * 5-wide one. `renderTaskMarkers`: compensation, ad-hoc (the AdHocSubProcess CLASS), loop or MI.
 */
function expectedActivity(el, di) {
  const container = is(el, 'bpmn:SubProcess', 'bpmn:CallActivity');
  const expanded = container && !!di?.isExpanded;
  const markers = new Set();
  if (container && !expanded) markers.add('subprocess');
  if (el.isForCompensation) markers.add('compensation');
  if (is(el, 'bpmn:AdHocSubProcess')) markers.add('adhoc');
  const loop = el.loopCharacteristics;
  if (loop?.$type === 'bpmn:StandardLoopCharacteristics') markers.add('loop');
  if (loop?.$type === 'bpmn:MultiInstanceLoopCharacteristics') markers.add(loop.isSequential ? 'mi-sequential' : 'mi-parallel');
  const icon = TASK_ICON.find(([t]) => el.$type === t)?.[1] ?? null;
  return {
    icon, instantiate: icon === 'receiveTask' && !!el.instantiate, markers, expanded,
    dashed: is(el, 'bpmn:SubProcess') && !!el.triggeredByEvent,
    innerBorder: is(el, 'bpmn:Transaction'),
    thick: is(el, 'bpmn:CallActivity'),
  };
}

/** 'bpmn:SequenceFlow': the conditional diamond for a conditionExpression leaving an Activity, the
 * default slash (it wins) for the flow its Gateway or Activity source names as `default`. */
function expectedSequenceFlowMarker(el) {
  const src = el.sourceRef;
  if (src && src.default === el && is(src, 'bpmn:Gateway', 'bpmn:Activity')) return 'default';
  if (el.conditionExpression && src && is(src, 'bpmn:Activity')) return 'conditional';
  return null;
}

// ── comparing ────────────────────────────────────────────────────────────────────────────────────

/** Logic-Core node by id, at any depth — for the pinned known differences only. */
function lcIndex(lc) {
  const out = new Map();
  const walk = (nodes) => { for (const n of nodes || []) { out.set(n.id, n); walk(n.nodes); } };
  for (const p of lc.pools ?? [lc]) walk(p.nodes);
  return out;
}

/**
 * Every finding as one string — `[]` when our SVG and bpmn.io agree on every element's structure.
 * Collected rather than thrown, so one run names every disagreement in the model.
 */
async function symbolDisagreements(lc) {
  const r = await runPipeline(lc);
  const { elements, di } = await readXml(r.bpmnXml);
  const { groups, paths } = svgIndex(r.svg);
  const lcNodes = lcIndex(lc);
  const out = [];
  const say = (id, what, ours, theirs) => out.push(`${id}: ${what} — ours ${JSON.stringify(ours)}, bpmn.io ${JSON.stringify(theirs)}`);
  const seen = new Set();

  for (const [id, el] of elements) {
    if (!di.has(id)) continue;   // not on the main diagram — see readXml
    const node = lcNodes.get(id);
    const frag = groups.get(id);
    const shapes = frag ? shapesIn(frag) : [];

    if (is(el, 'bpmn:Event')) {
      if (frag === undefined) { say(id, 'drawn', false, true); continue; }
      seen.add('event');
      const want = expectedEvent(el);
      const outer = shapes[0];
      const r0 = +outer.a.r;
      let rings = 0;
      while (shapes[rings]?.tag === 'circle' && +shapes[rings].a.r >= r0 - INNER_OUTER_GAP - 0.01) rings++;
      if (rings !== want.rings) say(id, 'ring count', rings, want.rings);
      const dashed = 'stroke-dasharray' in outer.a;
      if (dashed !== want.dashed) say(id, 'dashed ring', dashed, want.dashed);

      // #87, pinned: the XML carries no definition for these markers, our SVG still draws one.
      let icon = want.icon;
      if (['multiple', 'parallelMultiple'].includes(node?.marker)) {
        if (want.icon !== null) say(id, '#87 is fixed — unpin it here', want.icon, null);
        icon = node.marker;
      }
      const filled = is(el, 'bpmn:IntermediateThrowEvent', 'bpmn:EndEvent');
      const cx = +outer.a.cx, cy = +outer.a.cy;
      const iconMarkup = icon === null ? ''
        : icon === 'terminate' ? `<circle cx="${cx}" cy="${cy}" r="${rn(r0 * 0.55)}" fill="${CLR.stroke}"/>`
        : renderEventMarker(icon, cx, cy, r0, filled);
      if (icon && !frag.includes(iconMarkup)) say(id, 'icon', 'another or none', icon);
      if (shapes.length !== rings + shapesIn(iconMarkup).length) say(id, 'symbols beside rings and icon', shapes.length - rings, shapesIn(iconMarkup).length);
    } else if (is(el, 'bpmn:Gateway')) {
      if (frag === undefined) { say(id, 'drawn', false, true); continue; }
      seen.add('gateway');
      const want = expectedGateway(el, di.get(id), SHAPE[node?.type]?.w ?? 50, SHAPE[node?.type]?.h ?? 50);
      const inner = shapes.slice(1);
      const lines = inner.filter((s) => s.tag === 'line');
      const circles = inner.filter((s) => s.tag === 'circle');
      let got = 'none';
      if (is(el, 'bpmn:EventBasedGateway')) {
        got = inner.some((s) => s.tag === 'path') ? 'plus-outline' : inner.some((s) => s.tag === 'polygon') ? 'pentagon' : 'none';
        const radii = circles.map((c) => +c.a.r);
        if (JSON.stringify(radii) !== JSON.stringify(want.rings)) say(id, 'ring radii', radii, want.rings);
      } else if (lines.length === 4) got = 'asterisk';
      else if (lines.length === 2) got = lines.every((l) => l.a.x1 !== l.a.x2 && l.a.y1 !== l.a.y2) ? 'x' : 'plus';
      else if (circles.length === 1 && inner.length === 1) got = 'circle';
      if (got !== want.inner) say(id, 'inner symbol', got, want.inner);
    } else if (is(el, 'bpmn:Activity')) {
      if (frag === undefined) { say(id, 'drawn', false, true); continue; }
      seen.add('activity');
      const want = expectedActivity(el, di.get(id));
      // Pinned: `isAdHoc` is unserialised (types.js), svg.js draws the tilde regardless.
      if (node?.isAdHoc && !want.expanded) want.markers.add('adhoc');
      const body = shapesIn(frag.replace(MARKER_GROUP, ''));   // everything but the bottom markers
      const rects = body.filter((s) => s.tag === 'rect');
      const main = rects[0];
      const dashed = 'stroke-dasharray' in main.a;
      if (dashed !== want.dashed) say(id, 'dashed border', dashed, want.dashed);
      const inner = rects.length > 1;
      if (inner !== want.innerBorder) say(id, 'inner (transaction) border', inner, want.innerBorder);
      const thick = main.a['stroke-width'] === String(SW.callActivity);
      if (thick !== want.thick) say(id, 'thick (call activity) border', thick, want.thick);
      const markers = bottomMarkers(frag);
      const sorted = (xs) => [...xs].sort();
      if (JSON.stringify(sorted(markers)) !== JSON.stringify(sorted(want.markers))) say(id, 'bottom markers', sorted(markers), sorted(want.markers));
      const iconMarkup = want.icon && !want.expanded
        ? renderTaskIcon(want.icon, +main.a.x, +main.a.y, { instantiate: want.instantiate }) ?? '' : '';
      if (iconMarkup && !frag.includes(iconMarkup)) say(id, 'task icon', 'another or none', want.instantiate ? 'receiveTask (instantiate)' : want.icon);
      const expectedBody = (want.innerBorder ? 2 : 1) + shapesIn(iconMarkup).length;
      if (body.length !== expectedBody) say(id, 'symbols beside border and icon', body.length, expectedBody);
    } else if (is(el, 'bpmn:DataObjectReference')) {
      if (frag === undefined) { say(id, 'drawn', false, true); continue; }
      seen.add('data');
      // renderDataObject: the collection marker when the DataObject `isCollection`
      const collection = shapes.filter((s) => s.tag === 'line').length === 3;
      const want = !!el.dataObjectRef?.isCollection;
      if (collection !== want) say(id, 'collection marker', collection, want);
    } else if (is(el, 'bpmn:DataStoreReference')) {
      if (frag === undefined) { say(id, 'drawn', false, true); continue; }
      seen.add('data');
      if (!shapes.some((s) => s.tag === 'ellipse')) say(id, 'data store cylinder', false, true);
    } else if (is(el, 'bpmn:Group')) {
      if (frag === undefined) { say(id, 'drawn', false, true); continue; }
      seen.add('artifact');
      // 'bpmn:Group': a dashed rounded rectangle
      if (!(shapes[0]?.tag === 'rect' && 'stroke-dasharray' in shapes[0].a)) say(id, 'dashed group frame', false, true);
    } else if (is(el, 'bpmn:TextAnnotation')) {
      if (frag === undefined) { say(id, 'drawn', false, true); continue; }
      seen.add('artifact');
    } else if (is(el, 'bpmn:SequenceFlow')) {
      const p = paths.get(id);
      if (!p) { say(id, 'drawn', false, true); continue; }
      seen.add('sequenceFlow');
      const got = p['marker-start'] === 'url(#seq-default-src)' ? 'default'
        : p['marker-start'] === 'url(#seq-conditional-src)' ? 'conditional' : null;
      const want = expectedSequenceFlowMarker(el);
      if (got !== want) say(id, 'source-end marker', got, want);
    } else if (is(el, 'bpmn:MessageFlow')) {
      const p = paths.get(id);
      if (!p) { say(id, 'drawn', false, true); continue; }
      seen.add('messageFlow');
      if (!('stroke-dasharray' in p) || !p['marker-start'] || !p['marker-end']) say(id, 'dashed, circle start, open arrow end', false, true);
    } else if (is(el, 'bpmn:Association')) {
      const p = paths.get(id);
      if (!p) { say(id, 'drawn', false, true); continue; }
      seen.add('association');
      // renderAssociation: end marker for direction One or Both, start marker for Both
      const dir = el.associationDirection;
      if (!!p['marker-end'] !== (dir === 'One' || dir === 'Both')) say(id, 'association end marker', !!p['marker-end'], dir);
      if (!!p['marker-start'] !== (dir === 'Both')) say(id, 'association start marker', !!p['marker-start'], dir);
    }
  }
  return { findings: out, seen, diagnostics: r.diagnostics, coordMap: r.coordMap };
}

// ── the fences ───────────────────────────────────────────────────────────────────────────────────

describe('symbol fidelity — our SVG draws what bpmn-js 18.6.2 draws for our XML', () => {
  const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));

  test('the symbol catalog: every element agrees', async () => {
    const { findings, seen } = await symbolDisagreements(catalog);
    expect(findings).toEqual([]);
    // The catalog is only a fence while it still holds every class the comparison was built from.
    expect([...seen].sort()).toEqual(['activity', 'artifact', 'association', 'data', 'event', 'gateway', 'messageFlow', 'sequenceFlow']);
  }, 60000);

  const fixtures = readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort();
  test.each(fixtures)('%s: every element agrees', async (name) => {
    const lc = JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
    const probe = await runPipeline(JSON.parse(JSON.stringify(lc)));
    if (!probe.coordMap) return;  // blocked on purpose (deadlock-process) — nothing is drawn
    const { findings } = await symbolDisagreements(lc);
    expect(findings).toEqual([]);
  }, 60000);
});

describe('#83 — a non-interrupting event-subprocess start event is non-interrupting in the XML', () => {
  test('isInterrupting="false" is written for every such start event in the catalog', async () => {
    const catalog = JSON.parse(readFileSync(CATALOG, 'utf8'));
    const nonInterrupting = [...lcIndex(catalog).values()].filter((n) => n.type === 'startEvent' && n.isInterrupting === false);
    expect(nonInterrupting.length).toBeGreaterThan(0);
    const r = await runPipeline(catalog);
    for (const n of nonInterrupting) {
      expect([n.id, new RegExp(`<bpmn:startEvent id="${n.id}"[^>]*isInterrupting="false"`).test(r.bpmnXml)]).toEqual([n.id, true]);
    }
  }, 60000);

  // OMG §10.3.5: isInterrupting is meaningful only on the start event of an event subprocess.
  const withStart = (container) => ({
    id: 'P', nodes: [
      { id: 's', type: 'startEvent' },
      { id: 'sub', type: 'subProcess', name: 'Sub', isExpanded: true, ...container,
        nodes: [{ id: 'cs', type: 'startEvent', isInterrupting: false }, { id: 'ce', type: 'endEvent' }],
        edges: [{ id: 'cf', source: 'cs', target: 'ce' }] },
      { id: 'e', type: 'endEvent' },
    ],
    edges: [{ id: 'f1', source: 's', target: 'sub' }, { id: 'f2', source: 'sub', target: 'e' }],
  });

  test('a start event of a plain subprocess: not written, not dashed, reported', async () => {
    const r = await runPipeline(withStart({}));
    expect(r.bpmnXml).not.toMatch(/isInterrupting/);
    expect(shapesIn(svgIndex(r.svg).groups.get('cs'))[0].a['stroke-dasharray']).toBeUndefined();
    expect(r.validation.warnings.join('\n')).toMatch(/Node "cs".*outside an event subprocess.*isInterrupting/);
  });

  test('a top-level start event: not written, not dashed, reported', async () => {
    const lc = { id: 'P', nodes: [{ id: 's', type: 'startEvent', isInterrupting: false }, { id: 'e', type: 'endEvent' }],
      edges: [{ id: 'f', source: 's', target: 'e' }] };
    const r = await runPipeline(lc);
    expect(r.bpmnXml).not.toMatch(/isInterrupting/);
    expect(shapesIn(svgIndex(r.svg).groups.get('s'))[0].a['stroke-dasharray']).toBeUndefined();
    expect(r.validation.warnings.join('\n')).toMatch(/Node "s".*outside an event subprocess/);
  });

  test('the start event of an event subprocess: written, dashed, not reported', async () => {
    const r = await runPipeline(withStart({ isEventSubProcess: true }));
    expect(r.bpmnXml).toMatch(/<bpmn:startEvent id="cs"[^>]*isInterrupting="false"/);
    expect(shapesIn(svgIndex(r.svg).groups.get('cs'))[0].a['stroke-dasharray']).toBeDefined();
    expect(r.validation.warnings.join('\n')).not.toMatch(/outside an event subprocess/);
  });
});

describe('#84 — the conditional marker follows the conditionExpression', () => {
  const lc = (edgeExtra) => ({
    id: 'P', nodes: [
      { id: 's', type: 'startEvent' }, { id: 't', type: 'task', name: 'Antrag pruefen' },
      { id: 'a', type: 'task', name: 'Annehmen' }, { id: 'b', type: 'task', name: 'Ablehnen' },
      { id: 'e1', type: 'endEvent' }, { id: 'e2', type: 'endEvent' },
    ],
    edges: [
      { id: 'f0', source: 's', target: 't' },
      { id: 'fa', source: 't', target: 'a', ...edgeExtra },
      { id: 'fb', source: 't', target: 'b' },
      { id: 'fa2', source: 'a', target: 'e1' }, { id: 'fb2', source: 'b', target: 'e2' },
    ],
  });

  const condOf = (xml, id) => xml.match(new RegExp(`<bpmn:sequenceFlow id="${id}"[^>]*>\\s*<bpmn:conditionExpression[^>]*>([^<]*)<`))?.[1];

  test('isConditional with a label and no condition: the label is the condition, both draw it', async () => {
    const r = await runPipeline(lc({ isConditional: true, label: 'Betrag > 1000' }));
    expect(condOf(r.bpmnXml, 'fa')).toBe('Betrag &gt; 1000');
    expect(svgIndex(r.svg).paths.get('fa')['marker-start']).toBe('url(#seq-conditional-src)');
  });

  test('isConditional with neither label nor condition: nothing to write, nothing drawn', async () => {
    const r = await runPipeline(lc({ isConditional: true }));
    expect(condOf(r.bpmnXml, 'fa')).toBeUndefined();
    expect(svgIndex(r.svg).paths.get('fa')['marker-start']).toBeUndefined();
  });

  // OMG §10.3.1: a conditionExpression only on a flow leaving an Activity or an exclusive,
  // inclusive or complex Gateway; §10.5: a default flow's condition is ignored — the default wins.
  const fromSource = (sourceType, edgeExtra, { nested = false } = {}) => {
    const body = {
      nodes: [
        { id: 's', type: 'startEvent' }, { id: 'g', type: sourceType, name: 'Quelle' },
        { id: 'a', type: 'task', name: 'Annehmen' }, { id: 'b', type: 'task', name: 'Ablehnen' },
        { id: 'e1', type: 'endEvent' }, { id: 'e2', type: 'endEvent' },
      ],
      edges: [
        { id: 'f0', source: 's', target: 'g' },
        { id: 'fa', source: 'g', target: 'a', ...edgeExtra },
        { id: 'fb', source: 'g', target: 'b' },
        { id: 'fa2', source: 'a', target: 'e1' }, { id: 'fb2', source: 'b', target: 'e2' },
      ],
    };
    if (!nested) return { id: 'P', ...body };
    return { id: 'P', nodes: [
      { id: 'os', type: 'startEvent' },
      { id: 'sub', type: 'subProcess', name: 'Pruefung', isExpanded: true, ...body },
      { id: 'oe', type: 'endEvent' },
    ], edges: [{ id: 'o1', source: 'os', target: 'sub' }, { id: 'o2', source: 'sub', target: 'oe' }] };
  };
  const dropped = async (lc, warning) => {
    const r = await runPipeline(lc);
    expect(condOf(r.bpmnXml, 'fa')).toBeUndefined();
    expect(svgIndex(r.svg).paths.get('fa')['marker-start']).not.toBe('url(#seq-conditional-src)');
    expect(r.validation.warnings.join('\n')).toMatch(warning);
    expect((await symbolDisagreements(lc)).findings).toEqual([]);
  };

  test('a flow leaving a parallel gateway: no condition, no marker, reported', async () => {
    await dropped(fromSource('parallelGateway', { condition: 'x > 1' }), /Flow "fa" leaves "g", a parallelGateway/);
  });

  test('a flow leaving a parallel gateway via isConditional + label: likewise', async () => {
    await dropped(fromSource('parallelGateway', { isConditional: true, label: 'x > 1' }), /Flow "fa" leaves "g", a parallelGateway, and carries isConditional/);
  });

  test('a flow leaving a start event: no condition, no marker, reported', async () => {
    const lc = fromSource('task', {});
    lc.edges.find((e) => e.id === 'f0').condition = 'x > 1';
    const r = await runPipeline(lc);
    expect(condOf(r.bpmnXml, 'f0')).toBeUndefined();
    expect(svgIndex(r.svg).paths.get('f0')['marker-start']).toBeUndefined();
    expect(r.validation.warnings.join('\n')).toMatch(/Flow "f0" leaves "s", a startEvent/);
  });

  test('a flow leaving an event-based gateway inside a subprocess: no condition, reported', async () => {
    const lc = fromSource('eventBasedGateway', { condition: 'x > 1' }, { nested: true });
    lc.nodes[1].nodes.find((n) => n.id === 'a').type = 'intermediateCatchEvent';
    lc.nodes[1].nodes.find((n) => n.id === 'a').marker = 'message';
    lc.nodes[1].nodes.find((n) => n.id === 'b').type = 'intermediateCatchEvent';
    lc.nodes[1].nodes.find((n) => n.id === 'b').marker = 'timer';
    await dropped(lc, /Flow "fa" leaves "g", a eventBasedGateway/);
  });

  test('default and conditional on one flow: the default wins, the condition is dropped and reported', async () => {
    const lc = fromSource('exclusiveGateway', { condition: 'x > 1', isDefault: true });
    const r = await runPipeline(lc);
    expect(condOf(r.bpmnXml, 'fa')).toBeUndefined();
    expect(r.bpmnXml).toMatch(/<bpmn:exclusiveGateway id="g"[^>]*default="fa"/);
    expect(svgIndex(r.svg).paths.get('fa')['marker-start']).toBe('url(#seq-default-src)');
    expect(r.validation.warnings.join('\n')).toMatch(/Flow "fa" is marked as the default flow of "g"/);
    expect((await symbolDisagreements(lc)).findings).toEqual([]);
  });

  // The inferred default is chosen only among flows without an authored condition (re-review of
  // #84): it must never take a condition the author wrote.
  test('every outgoing flow conditioned, none marked: no inferred default, every condition kept', async () => {
    const lc = fromSource('exclusiveGateway', { condition: '${x>1}' });
    lc.edges.find((e) => e.id === 'fb').condition = '${x<=1}';
    const r = await runPipeline(lc);
    expect(r.bpmnXml).not.toMatch(/<bpmn:exclusiveGateway id="g"[^>]*default=/);
    expect(condOf(r.bpmnXml, 'fa')).toBe('${x&gt;1}');
    expect(condOf(r.bpmnXml, 'fb')).toBe('${x&lt;=1}');
    expect(svgIndex(r.svg).paths.get('fb')['marker-start']).toBeUndefined();
    expect(r.validation.warnings.join('\n')).not.toMatch(/default flow of "g"/);
    expect((await symbolDisagreements(lc)).findings).toEqual([]);
  });

  test('one unconditioned flow: it becomes the inferred default, the conditions are kept', async () => {
    const lc = fromSource('exclusiveGateway', {});
    lc.nodes.push({ id: 'c', type: 'task', name: 'Pruefen' }, { id: 'e3', type: 'endEvent' });
    lc.edges.find((e) => e.id === 'fb').condition = '${x<=1}';
    lc.edges.push({ id: 'fc', source: 'g', target: 'c', condition: '${x>9}' }, { id: 'fc2', source: 'c', target: 'e3' });
    const r = await runPipeline(lc);
    expect(r.bpmnXml).toMatch(/<bpmn:exclusiveGateway id="g"[^>]*default="fa"/);
    expect(condOf(r.bpmnXml, 'fa')).toBeUndefined();
    expect(condOf(r.bpmnXml, 'fb')).toBe('${x&lt;=1}');
    expect(condOf(r.bpmnXml, 'fc')).toBe('${x&gt;9}');
    expect(svgIndex(r.svg).paths.get('fa')['marker-start']).toBe('url(#seq-default-src)');
    expect(r.validation.warnings.join('\n')).not.toMatch(/default flow of "g"/);
  });

  test('every outgoing flow conditioned inside a subprocess: no inferred default, conditions kept', async () => {
    const lc = fromSource('inclusiveGateway', { condition: '${x>1}' }, { nested: true });
    lc.nodes[1].edges.find((e) => e.id === 'fb').condition = '${y>1}';
    const r = await runPipeline(lc);
    expect(r.bpmnXml).not.toMatch(/<bpmn:inclusiveGateway id="g"[^>]*default=/);
    expect(condOf(r.bpmnXml, 'fa')).toBe('${x&gt;1}');
    expect(condOf(r.bpmnXml, 'fb')).toBe('${y&gt;1}');
    expect((await symbolDisagreements(lc)).findings).toEqual([]);
  });

  test('default and conditional on a flow leaving an activity, nested: the slash, no diamond', async () => {
    const lc = fromSource('task', { condition: 'x > 1', isDefault: true }, { nested: true });
    const r = await runPipeline(lc);
    expect(condOf(r.bpmnXml, 'fa')).toBeUndefined();
    expect(svgIndex(r.svg).paths.get('fa')['marker-start']).toBe('url(#seq-default-src)');
    expect(r.validation.warnings.join('\n')).toMatch(/Flow "fa" is marked as the default flow of "g"/);
  });

  test('inside a subprocess: condition and default are written, read back and drawn', async () => {
    const inner = lc({ condition: '${ok}', label: 'ok' });
    const nested = {
      id: 'Outer', nodes: [
        { id: 'os', type: 'startEvent' },
        { id: 'sub', type: 'subProcess', name: 'Pruefung', isExpanded: true, nodes: inner.nodes,
          edges: [...inner.edges.filter((e) => e.id !== 'fb'), { id: 'fb', source: 't', target: 'b', isDefault: true }] },
        { id: 'oe', type: 'endEvent' },
      ],
      edges: [{ id: 'o1', source: 'os', target: 'sub' }, { id: 'o2', source: 'sub', target: 'oe' }],
    };
    const r = await runPipeline(nested);
    expect(condOf(r.bpmnXml, 'fa')).toBe('${ok}');
    expect(r.bpmnXml).toMatch(/<bpmn:task id="t"[^>]*default="fb"/);
    const paths = svgIndex(r.svg).paths;
    expect(paths.get('fa')['marker-start']).toBe('url(#seq-conditional-src)');
    expect(paths.get('fb')['marker-start']).toBe('url(#seq-default-src)');
    expect((await symbolDisagreements(nested)).findings).toEqual([]);
  });

  test('a condition on a flow leaving an activity: both carry it', async () => {
    const r = await runPipeline(lc({ condition: '${ok}', label: 'ok' }));
    expect(r.bpmnXml).toMatch(/<bpmn:sequenceFlow id="fa"[^>]*>\s*<bpmn:conditionExpression[^>]*>\$\{ok\}</);
    expect(svgIndex(r.svg).paths.get('fa')['marker-start']).toBe('url(#seq-conditional-src)');
    expect((await symbolDisagreements(lc({ condition: '${ok}' }))).findings).toEqual([]);
  });
});

describe('#86 — artifacts stay inside their participant', () => {
  test('artifacts-laneless-pool: no DI finding, every artifact inside its own pool', async () => {
    const lc = JSON.parse(readFileSync(path.join(FIXTURES, 'artifacts-laneless-pool.json'), 'utf8'));
    const r = await runPipeline(lc);
    expect(r.diagnostics.issues).toEqual([]);
    const pool = r.coordMap.poolCoords.Pool_Antrag;
    for (const id of ['formular', 'anlagen', 'register', 'hinweis', 'block']) {
      const c = r.coordMap.coords[id];
      const inside = c.x >= pool.x && c.y >= pool.y && c.x + c.w <= pool.x + pool.w && c.y + c.h <= pool.y + pool.h;
      expect([id, inside]).toEqual([id, true]);
    }
  });

  test('the symbol catalog: no DI finding at all', async () => {
    const { diagnostics } = await symbolDisagreements(JSON.parse(readFileSync(CATALOG, 'utf8')));
    expect(diagnostics.issues).toEqual([]);
  }, 60000);

  test('an unattached group gets the bounded default size, not more', async () => {
    const lc = JSON.parse(readFileSync(path.join(FIXTURES, 'artifacts-laneless-pool.json'), 'utf8'));
    const r = await runPipeline(lc);
    const g = r.coordMap.coords.block;
    expect({ w: g.w, h: g.h }).toEqual({ w: SHAPE.group.w, h: SHAPE.group.h });
    expect(SHAPE.group.w * SHAPE.group.h).toBeLessThanOrEqual(200 * 120);
  });
});

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
import { generateSvg } from './svg.js';
import { generateBpmnXml } from './bpmn-xml.js';
import { validateLogicCoreSchema } from './schema-gate.js';
import { SYM, SHAPE } from './constants.js';
import {
  renderEventMarker, renderTaskIcon, renderGatewaySymbol, renderDataObjectShape,
} from './icons.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', '..', 'tests', 'fixtures');
const CATALOG = path.join(FIXTURES, 'symbols', 'symbol-catalog.json');
const moddle = new BpmnModdle();

// ── reading our SVG ──────────────────────────────────────────────────────────────────────────────

const DRAWABLE = /<(circle|rect|line|path|polygon|ellipse)\b([^>]*?)\/?>/g;
const attrsOf = (s) => Object.fromEntries([...s.matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const shapesIn = (markup) => [...markup.matchAll(DRAWABLE)].map((m) => ({ tag: m[1], a: attrsOf(m[2]) }));

/** The content of the balanced `<g …>` that starts at `start` in `s`, and where it ends. */
function balancedGroup(s, start) {
  const open = s.indexOf('>', start) + 1;
  let depth = 1, i = open;
  while (depth > 0) {
    const o = s.indexOf('<g', i), c = s.indexOf('</g>', i);
    if (o !== -1 && o < c) { depth++; i = o + 2; } else { depth--; i = c + 4; }
  }
  return { inner: s.slice(open, i - 4), end: i };
}

/** `id` → the markup of its `<g data-element-id>` group (nodes) or `<path data-element-id>` (connections). */
function svgIndex(svg) {
  const groups = new Map();
  for (const m of svg.matchAll(/<g data-element-id="([^"]*)">/g)) groups.set(m[1], balancedGroup(svg, m.index).inner);
  const paths = new Map([...svg.matchAll(/<path data-element-id="([^"]*)"([^>]*)\/>/g)].map((m) => [m[1], attrsOf(m[2])]));
  return { groups, paths };
}

/**
 * An element's markup split the way svg.js writes it: `base`, the shape in canvas coordinates, and
 * `inner`, the element-relative `<g transform="translate(x, y)">` holding icon and markers (`''` if none).
 */
function splitElement(frag) {
  const at = frag.indexOf('<g transform="translate(');
  if (at < 0) return { base: frag, inner: '', origin: null };
  const { inner, end } = balancedGroup(frag, at);
  const [, x, y] = frag.slice(at).match(/translate\(([\d.-]+),([\d.-]+)\)/);
  return { base: frag.slice(0, at) + frag.slice(end), inner, origin: { x: +x, y: +y } };
}

/** The `data-marker` groups of an activity's inner markup, in drawn order, with their markup. */
const markersIn = (inner) => [...inner.matchAll(/<g data-marker="([^"]+)">/g)]
  .map((m) => ({ name: m[1], markup: balancedGroup(inner, m.index).inner }));
const withoutMarkers = (inner) => {
  let out = inner;
  for (const { name, markup } of markersIn(inner)) out = out.replace(`<g data-marker="${name}">${markup}</g>`, '');
  return out;
};

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
 * Handlers 'bpmn:StartEvent' (dashed when !isInterrupting, stroke 2), 'bpmn:IntermediateEvent' (two
 * rings, never dashed, stroke 1.5), 'bpmn:BoundaryEvent' (two rings, dashed when !cancelActivity,
 * stroke 1.5), 'bpmn:EndEvent' (stroke 4). The icon is filled for a throw event (`isThrowEvent`).
 */
function expectedEvent(el) {
  const twoRings = is(el, 'bpmn:IntermediateCatchEvent', 'bpmn:IntermediateThrowEvent', 'bpmn:BoundaryEvent');
  const dashed = is(el, 'bpmn:StartEvent') ? !el.isInterrupting
    : is(el, 'bpmn:BoundaryEvent') ? !el.cancelActivity : false;
  const strokeWidth = is(el, 'bpmn:EndEvent') ? 4 : is(el, 'bpmn:StartEvent') ? 2 : 1.5;
  return { rings: twoRings ? 2 : 1, dashed, strokeWidth, icon: expectedEventIcon(el) };
}

/** The task-type handlers ('bpmn:UserTask' …); 'bpmn:ReceiveTask' switches on `instantiate`. */
const TASK_ICON = [
  ['bpmn:UserTask', 'userTask'], ['bpmn:ServiceTask', 'serviceTask'], ['bpmn:SendTask', 'sendTask'],
  ['bpmn:ReceiveTask', 'receiveTask'], ['bpmn:ManualTask', 'manualTask'],
  ['bpmn:ScriptTask', 'scriptTask'], ['bpmn:BusinessRuleTask', 'businessRuleTask'],
];

/**
 * `renderSubProcess` (SubProcess, Transaction, CallActivity): an event subprocess's frame is dotted
 * (dash '0, 5.5', stroke 2.5), [+] when collapsed; 'bpmn:Transaction' strokes 1.5 and adds an
 * inner border; 'bpmn:CallActivity' strokes 5; any other activity 2 (`shapeStyle`).
 *
 * `renderTaskMarkers`, ported independently of icons.js so marker ORDER and POSITION are checked:
 * the markers in bpmn-js's push order — [+], compensation, ad-hoc, then loop/MI — and each
 * marker's x offset from the activity's centre, from its offset table and the adjustments it makes.
 */
function expectedActivity(el, di, { adHoc = false } = {}) {
  const container = is(el, 'bpmn:SubProcess', 'bpmn:CallActivity');
  const expanded = container && !!di?.isExpanded;
  const collapsed = container && !expanded;
  const o = collapsed
    ? { seq: -21, parallel: -22, compensation: -25, loop: -18, adhoc: 10 }
    : { seq: -5, parallel: -6, compensation: -7, loop: 0, adhoc: -8 };
  const markers = collapsed ? ['sub-process'] : [];
  if (el.isForCompensation) markers.push('compensation');
  if (is(el, 'bpmn:AdHocSubProcess') || adHoc) {
    markers.push('adhoc');
    if (!collapsed) o.compensation -= 18;
  }
  const loop = el.loopCharacteristics;
  if (loop) {
    o.compensation -= 18;
    if (markers.includes('adhoc')) Object.assign(o, { seq: -23, loop: -18, parallel: -24 });
    markers.push(loop.$type === 'bpmn:StandardLoopCharacteristics' ? 'loop' : loop.isSequential ? 'sequential' : 'parallel');
  }
  if (markers.includes('compensation') && markers.length === 1) o.compensation = -8;
  // The x where each marker's path or rect starts, relative to the activity's centre.
  const offsetX = { 'sub-process': -7.5, compensation: o.compensation, adhoc: o.adhoc, loop: o.loop, sequential: o.seq, parallel: o.parallel };
  const icon = TASK_ICON.find(([t]) => el.$type === t)?.[1] ?? null;
  const strokeWidth = is(el, 'bpmn:CallActivity') ? 5 : el.triggeredByEvent ? 2.5 : is(el, 'bpmn:Transaction') ? 1.5 : 2;
  return {
    icon, instantiate: icon === 'receiveTask' && !!el.instantiate, markers, offsetX, expanded, strokeWidth,
    dashed: is(el, 'bpmn:SubProcess') && !!el.triggeredByEvent,
    innerBorder: is(el, 'bpmn:Transaction'),
  };
}

/**
 * Every connection is drawn with `drawConnectionSegments` → diagram-js `createLine(points, attrs, 5)`
 * (diagram-js 15.3, lib/util/RenderUtil.js `drawPath`): through the waypoints, each bend replaced by
 * a cubic curve that starts and ends min(5, both segment lengths) from the corner, its control
 * points at half that distance. Ported here independently of svg.js; coordinates at svg.js's
 * one-decimal precision.
 */
const BPMN_JS_CORNER_RADIUS = 5;
function expectedConnectionD(points) {
  const len = (dx, dy) => Math.hypot(dx, dy);
  const at = (a, b, l) => { const d = len(b.x - a.x, b.y - a.y); return { x: a.x + (b.x - a.x) * l / d, y: a.y + (b.y - a.y) * l / d }; };
  const r1 = (n) => Math.round(n * 10) / 10;
  const f = (p) => `${r1(p.x)} ${r1(p.y)}`;
  const d = [`M ${f(points[0])}`];
  for (let i = 1; i < points.length; i++) {
    const [b, p, a] = [points[i - 1], points[i], points[i + 1]];
    const r = a ? Math.min(BPMN_JS_CORNER_RADIUS, len(p.x - b.x, p.y - b.y), len(a.x - p.x, a.y - p.y)) : 0;
    if (!r) { d.push(`L ${f(p)}`); continue; }
    d.push(`L ${f(at(p, b, r))}`, `C ${f(at(p, b, r / 2))} ${f(at(p, a, r / 2))} ${f(at(p, a, r))}`);
  }
  return d.join(' ');
}
const waypointsOf = (p) => [...(p['data-waypoints'] ?? '').matchAll(/([-\d.]+),([-\d.]+)/g)].map((m) => ({ x: +m[1], y: +m[2] }));

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

    const bounds = di.get(id)?.bounds;
    const w = bounds?.width, h = bounds?.height;
    if (is(el, 'bpmn:Event')) {
      if (frag === undefined) { say(id, 'drawn', false, true); continue; }
      seen.add('event');
      const want = expectedEvent(el);
      const { base, inner } = splitElement(frag);
      const rings = shapesIn(base).filter((x) => x.tag === 'circle');
      if (rings.length !== want.rings) say(id, 'ring count', rings.length, want.rings);
      const dashed = 'stroke-dasharray' in rings[0].a;
      if (dashed !== want.dashed) say(id, 'dashed ring', dashed, want.dashed);
      if (+rings[0].a['stroke-width'] !== want.strokeWidth) say(id, 'ring stroke width', +rings[0].a['stroke-width'], want.strokeWidth);
      // #87, pinned: the XML carries no definition for these markers, our SVG still draws one.
      let icon = want.icon;
      if (['multiple', 'parallelMultiple'].includes(node?.marker)) {
        if (want.icon !== null) say(id, '#87 is fixed — unpin it here', want.icon, null);
        icon = node.marker;
      }
      const throwing = is(el, 'bpmn:IntermediateThrowEvent', 'bpmn:EndEvent');
      const expected = icon ? renderEventMarker(icon, w, h, throwing, node?.color) : '';
      if (inner !== expected) say(id, 'icon', inner ? 'another' : 'none', icon);
    } else if (is(el, 'bpmn:Gateway')) {
      if (frag === undefined) { say(id, 'drawn', false, true); continue; }
      seen.add('gateway');
      const { base, inner } = splitElement(frag);
      const diamond = shapesIn(base)[0];
      if (diamond?.tag !== 'polygon' || +diamond.a['stroke-width'] !== 2) say(id, 'diamond, stroke 2', diamond?.a['stroke-width'], 2);
      // The symbol from the XML's own fields, as the gateway handlers read them.
      const sem = { eventGatewayType: el.eventGatewayType, instantiate: !!el.instantiate };
      const type = el.$type.replace('bpmn:', '').replace(/^./, (c) => c.toLowerCase());
      const expected = renderGatewaySymbol(type, w, h, sem, { markerVisible: !!di.get(id)?.isMarkerVisible }, node?.color);
      if (inner !== expected) say(id, 'inner symbol', inner ? 'another' : 'none', type);
      if (is(el, 'bpmn:EventBasedGateway')) {
        // The structure, independently of icons.js: rings at offsets 0.20·h (+0.26·h unless parallel or instantiating)
        const ring = (off) => Math.round((w + h) / 4 - off);
        const wantRings = el.eventGatewayType === 'Parallel' || el.instantiate ? [ring(h * 0.20)] : [ring(h * 0.20), ring(h * 0.26)];
        const radii = shapesIn(inner).filter((x) => x.tag === 'circle').map((c) => +c.a.r);
        if (JSON.stringify(radii) !== JSON.stringify(wantRings)) say(id, 'ring radii', radii, wantRings);
      }
    } else if (is(el, 'bpmn:Activity')) {
      if (frag === undefined) { say(id, 'drawn', false, true); continue; }
      seen.add('activity');
      // Pinned: `isAdHoc` is unserialised (#99), svg.js draws the tilde regardless.
      const want = expectedActivity(el, di.get(id), { adHoc: !!node?.isAdHoc });
      const { base, inner } = splitElement(frag);
      const rects = shapesIn(base).filter((x) => x.tag === 'rect');
      const main = rects[0];
      const dashed = 'stroke-dasharray' in main.a;
      if (dashed !== want.dashed) say(id, 'dashed border', dashed, want.dashed);
      if (+main.a['stroke-width'] !== want.strokeWidth) say(id, 'border stroke width', +main.a['stroke-width'], want.strokeWidth);
      const innerBorder = rects.length > 1;
      if (innerBorder !== want.innerBorder) say(id, 'inner (transaction) border', innerBorder, want.innerBorder);
      if (shapesIn(base).length !== rects.length) say(id, 'symbols outside the element group', shapesIn(base).length - rects.length, 0);
      const markers = markersIn(inner);
      const names = markers.map((m) => m.name);
      if (JSON.stringify(names) !== JSON.stringify(want.markers)) say(id, 'bottom markers (in order)', names, want.markers);
      for (const m of markers) {
        const start = m.markup.match(/(?:x="|d="m ?)([\d.-]+)/);
        const got = start ? Math.round((+start[1] - w / 2) * 1000) / 1000 : null;
        if (got !== want.offsetX[m.name]) say(id, `${m.name} marker x offset from centre`, got, want.offsetX[m.name]);
      }
      const iconMarkup = want.icon && !want.expanded ? renderTaskIcon(want.icon, { instantiate: want.instantiate }, node?.color) ?? '' : '';
      if (withoutMarkers(inner) !== iconMarkup) say(id, 'task icon', withoutMarkers(inner) ? 'another' : 'none', want.icon);
    } else if (is(el, 'bpmn:DataObjectReference')) {
      if (frag === undefined) { say(id, 'drawn', false, true); continue; }
      seen.add('data');
      // renderDataObject: the page, plus the collection bars when the DataObject `isCollection`
      const { inner } = splitElement(frag);
      const expected = renderDataObjectShape(w, h, { collection: !!el.dataObjectRef?.isCollection, fillOpacity: SYM.fillOpacity }, node?.color);
      if (inner !== expected) say(id, 'data object (collection marker)', inner, !!el.dataObjectRef?.isCollection);
    } else if (is(el, 'bpmn:DataStoreReference')) {
      if (frag === undefined) { say(id, 'drawn', false, true); continue; }
      seen.add('data');
      if (shapesIn(splitElement(frag).inner).length !== 1) say(id, 'data store: one path (cylinder with rims)', false, true);
    } else if (is(el, 'bpmn:Group')) {
      if (frag === undefined) { say(id, 'drawn', false, true); continue; }
      seen.add('artifact');
      // 'bpmn:Group': a rounded rectangle, stroke 1.5, dash '10, 6, 0, 6'
      const g = shapesIn(frag)[0];
      if (!(g?.tag === 'rect' && g.a['stroke-dasharray'] === '10, 6, 0, 6' && +g.a['stroke-width'] === 1.5)) say(id, 'group frame', g?.a, 'dash 10, 6, 0, 6 / 1.5');
    } else if (is(el, 'bpmn:TextAnnotation')) {
      if (frag === undefined) { say(id, 'drawn', false, true); continue; }
      seen.add('artifact');
    }
    if (is(el, 'bpmn:SequenceFlow') || is(el, 'bpmn:MessageFlow') || is(el, 'bpmn:Association')) {
      const p = paths.get(id);
      if (p) {
        const pts = waypointsOf(p);
        if (pts.length < 2) say(id, 'data-waypoints', p['data-waypoints'], 'two or more points');
        else if (p.d !== expectedConnectionD(pts)) say(id, 'rounded corners (radius 5)', p.d, expectedConnectionD(pts));
      }
    }
    if (is(el, 'bpmn:SequenceFlow')) {
      const p = paths.get(id);
      if (!p) { say(id, 'drawn', false, true); continue; }
      seen.add('sequenceFlow');
      const got = p['marker-start'] === 'url(#seq-default-src)' ? 'default'
        : p['marker-start'] === 'url(#seq-conditional-src)' ? 'conditional' : null;
      const want = expectedSequenceFlowMarker(el);
      if (got !== want) say(id, 'source-end marker', got, want);
      // drawConnectionSegments → lineStyle: stroke 2, solid
      if (+p['stroke-width'] !== 2 || 'stroke-dasharray' in p) say(id, 'solid line, stroke 2', p['stroke-width'], 2);
    } else if (is(el, 'bpmn:MessageFlow')) {
      const p = paths.get(id);
      if (!p) { say(id, 'drawn', false, true); continue; }
      seen.add('messageFlow');
      // 'bpmn:MessageFlow': dash '10, 11', stroke 1.5, circle at the start, open arrow at the end
      if (p['stroke-dasharray'] !== '10, 11' || +p['stroke-width'] !== 1.5 || !p['marker-start'] || !p['marker-end']) {
        say(id, 'dash 10, 11 / stroke 1.5 / both markers', [p['stroke-dasharray'], p['stroke-width']], ['10, 11', 1.5]);
      }
    } else if (is(el, 'bpmn:Association')) {
      const p = paths.get(id);
      if (!p) { say(id, 'drawn', false, true); continue; }
      seen.add('association');
      // renderAssociation: dotted (dash '0, 5', round caps), end marker for One or Both, start for Both
      const dir = el.associationDirection;
      if (p['stroke-dasharray'] !== '0, 5' || p['stroke-linecap'] !== 'round') say(id, 'dotted line', p['stroke-dasharray'], '0, 5');
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

describe('element colours are validated and escaped', () => {
  // A value that would end an attribute if it were written raw.
  const quoted = '#fff" data-x="1<';
  const model = (color) => ({
    id: 'P', nodes: [
      { id: 's', type: 'startEvent', color },
      { id: 't', type: 'userTask', name: 'Pruefen', color, loopType: 'standard' },
      { id: 'g', type: 'exclusiveGateway', color },
      { id: 'd', type: 'dataObjectReference', name: 'Akte', color },
      { id: 'e', type: 'endEvent', marker: 'message', color },
    ],
    edges: [{ id: 'f1', source: 's', target: 't' }, { id: 'f2', source: 't', target: 'g' }, { id: 'f3', source: 'g', target: 'e' }],
  });

  test('the schema gate accepts hex colours and refuses anything else', () => {
    expect(validateLogicCoreSchema(model({ fill: '#ffe0b2', stroke: '#E65100' })).valid).toBe(true);
    expect(validateLogicCoreSchema(model({ fill: '#abc' })).valid).toBe(true);
    for (const v of [quoted, 'red', 'rgb(0,0,0)', '#ffff', '']) {
      expect([v, validateLogicCoreSchema(model({ fill: v })).valid]).toEqual([v, false]);
    }
  });

  test('a colour that bypassed the gate reaches no attribute unescaped — SVG and BPMN XML', async () => {
    const good = await runPipeline(model({ fill: '#ffe0b2', stroke: '#e65100' }));
    // The same geometry, the model's colours swapped after layout: the renderers alone are under test.
    const lc = model({ fill: quoted, stroke: quoted });
    const svg = generateSvg(JSON.parse(JSON.stringify(lc)), good.coordMap);
    expect(svg.includes(quoted)).toBe(false);
    expect(svg).toContain('#fff&quot; data-x=&quot;1&lt;');
    const xml = await generateBpmnXml(JSON.parse(JSON.stringify(lc)), good.coordMap);
    expect(xml.includes(quoted)).toBe(false);
    // bpmn-moddle escapes attribute values itself (as character references).
    expect(xml).toMatch(/bioc:fill="#fff(?:&#34;|&quot;) data-x=(?:&#34;|&quot;)1(?:&lt;|&#60;)"/);
  });
});

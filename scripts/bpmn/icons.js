/*
 * Contains renderer parameters derived from bpmn-js 18.6.2 (lib/draw/BpmnRenderer.js).
 * Copyright (c) 2014-present Camunda Services GmbH. Used under the bpmn.io license (MIT-based);
 * the full text is in THIRD_PARTY_NOTICES.md.
 */

/**
 * BPMN Icons — event icons, task-type icons, task markers and gateway symbols, drawn the way
 * bpmn-js 18.6.2 draws them (`lib/draw/BpmnRenderer.js`; glyph paths from `pathmap.js`).
 *
 * Every function returns markup RELATIVE TO THE ELEMENT'S TOP-LEFT CORNER, given the element's
 * width and height — bpmn-js's own frame — and svg.js wraps it in one `translate(x, y)` group.
 * Each function names the bpmn-js handler it mirrors. Colours and stroke widths that are a project
 * choice come from config.json (`color`, `strokeWidth`); the per-glyph scale, position and stroke
 * are bpmn-js's and stay with the glyph.
 */

import { CLR } from './constants.js';
import { esc } from '../shared/utils.js';
import { scaledPath, num } from './pathmap.js';

/**
 * The element's colours: its own `color` (bioc), else config.json's — bpmn-js `getStrokeColor` /
 * `getFillColor`, which colour an icon like the element that carries it.
 */
function palette(col) {
  // Escaped here, once: every colour this module writes goes into an attribute.
  return { S: esc(col?.stroke || CLR.stroke), F: esc(col?.fill || CLR.fill) };
}

/** `path`/`circle` bound to one element's palette, so every glyph part is coloured like it. */
function drawers(col) {
  const { S, F } = palette(col);
  return {
    S, F,
    path: (d, o = {}) => rawPath(d, { stroke: S, ...o }),
    circle: (w, h, off, o = {}) => rawCircle(w, h, off, { fill: F, stroke: S, ...o }),
  };
}

/** One `<path>` — bpmn-js `drawPath` (lineStyle: round caps and joins, no fill unless given). */
function rawPath(d, { fill = 'none', stroke, sw = 2, extra = '' }) {
  return `<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"${extra}/>`;
}

/** bpmn-js `drawCircle(w, h, offset)`: centred, r = round((w + h) / 4 − offset). */
function rawCircle(w, h, offset, { fill, stroke, sw = 2, extra = '' }) {
  return `<circle cx="${num(w / 2)}" cy="${num(h / 2)}" r="${Math.round((w + h) / 4 - offset)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${extra}/>`;
}

const scaled = (id, w, h, scale, mx, my) =>
  scaledPath(id, { xScaleFactor: scale, yScaleFactor: scale, containerWidth: w, containerHeight: h, position: { mx, my } });

// ─────────────────────────────────────────────────────────────────────
// Event icons — `eventIconRenderers`
// ─────────────────────────────────────────────────────────────────────

/**
 * The icon of an event `marker` inside a `w`×`h` event, `''` for none. `throwing` is bpmn-js's
 * `isThrowEvent` (intermediate throw, end): those icons are filled with the stroke colour.
 */
function renderEventMarker(marker, w, h, throwing = false, col) {
  const { S, F, path, circle } = drawers(col);
  const filled = throwing ? S : F;
  switch (marker) {
    case 'message': // 'bpmn:MessageEventDefinition'
      return path(scaled('EVENT_MESSAGE', w, h, 0.9, 0.235, 0.315),
        { fill: filled, stroke: throwing ? F : S, sw: 1 });
    case 'timer': { // 'bpmn:TimerEventDefinition'
      let out = circle(w, h, 0.2 * h, { sw: 2 })
        + path(scaled('EVENT_TIMER_WH', w, h, 0.75, 0.5, 0.5), { sw: 2 });
      for (let i = 0; i < 12; i++) {
        out += path(scaled('EVENT_TIMER_LINE', w, h, 0.75, 0.5, 0.5),
          { sw: 1, extra: ` transform="rotate(${i * 30},${num(h / 2)},${num(w / 2)})"` });
      }
      return out;
    }
    case 'escalation': // 'bpmn:EscalationEventDefinition'
      return path(scaled('EVENT_ESCALATION', w, h, 1, 0.5, 0.2), { fill: filled, sw: 1 });
    case 'conditional': // 'bpmn:ConditionalEventDefinition'
      return path(scaled('EVENT_CONDITIONAL', w, h, 1, 0.5, 0.222), { fill: F, sw: 1 });
    case 'link': // 'bpmn:LinkEventDefinition'
      return path(scaled('EVENT_LINK', w, h, 1, 0.57, 0.263), { fill: filled, sw: 1 });
    case 'error': // 'bpmn:ErrorEventDefinition'
      return path(scaled('EVENT_ERROR', w, h, 1.1, 0.2, 0.722), { fill: filled, sw: 1 });
    case 'cancel': // 'bpmn:CancelEventDefinition' — the plus, rotated by 45° about the element origin
      return path(scaled('EVENT_CANCEL_45', w, h, 1, 0.638, -0.055),
        { fill: throwing ? S : 'none', sw: 1, extra: ' transform="rotate(45)"' });
    case 'compensation': // 'bpmn:CompensateEventDefinition'
      return path(scaled('EVENT_COMPENSATION', w, h, 1, 0.22, 0.5), { fill: filled, sw: 1 });
    case 'signal': // 'bpmn:SignalEventDefinition'
      return path(scaled('EVENT_SIGNAL', w, h, 0.9, 0.5, 0.2), { fill: filled, sw: 1 });
    case 'multiple': // 'bpmn:MultipleEventDefinition'
      return path(scaled('EVENT_MULTIPLE', w, h, 1.1, 0.211, 0.36), { fill: filled, sw: 1 });
    case 'parallelMultiple': // 'bpmn:ParallelMultipleEventDefinition' — never filled
      return path(scaled('EVENT_PARALLEL_MULTIPLE', w, h, 1.2, 0.458, 0.194), { fill: F, sw: 1 });
    case 'terminate': // 'bpmn:TerminateEventDefinition'
      return circle(w, h, 8, { fill: S, sw: 4 });
    default: return '';
  }
}

function inferEventMarker(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes('nachricht') || n.includes('message') || n.includes('mail') || n.includes('e-mail')) return 'message';
  if (n.includes('timer') || n.includes('zeit') || n.includes('frist') || n.includes('warte') || n.includes('deadline')) return 'timer';
  if (n.includes('fehler') || n.includes('error') || n.includes('exception') || n.includes('störung')) return 'error';
  if (n.includes('signal')) return 'signal';
  if (n.includes('eskalation') || n.includes('escalation')) return 'escalation';
  if (n.includes('kompensation') || n.includes('compensation')) return 'compensation';
  if (n.includes('bedingung') || n.includes('conditional') || n.includes('condition')) return 'conditional';
  if (n.includes('abbruch') || n.includes('cancel') || n.includes('abgebrochen') || n.includes('stornierung')) return 'cancel';
  if (n.includes('terminat') || n.includes('beendet') || n.includes('sofortiger abbruch')) return 'terminate';
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// Task-type icons — the task handlers ('bpmn:UserTask', …)
// ─────────────────────────────────────────────────────────────────────

/** The type icon of a task, top-left; `null` for a type without one. `node` carries `instantiate`. */
function renderTaskIcon(type, node = {}, col) {
  const { S, F, path, circle } = drawers(col);
  const at = (id, x, y) => scaledPath(id, { abspos: { x, y } });
  switch (type) {
    case 'userTask': // 'bpmn:UserTask'
      return path(at('TASK_TYPE_USER_1', 15, 12), { fill: F, sw: 0.5 })
        + path(at('TASK_TYPE_USER_2', 15, 12), { fill: F, sw: 0.5 })
        + path(at('TASK_TYPE_USER_3', 15, 12), { fill: S, sw: 0.5 });
    case 'serviceTask': // 'bpmn:ServiceTask' — two cogs, each on a white disc
      return `<circle cx="11" cy="11" r="5" fill="${F}" stroke="none"/>`
        + path(at('TASK_TYPE_SERVICE', 12, 18), { fill: F, sw: 1 })
        + `<circle cx="16" cy="15" r="5" fill="${F}" stroke="none"/>`
        + path(at('TASK_TYPE_SERVICE', 17, 22), { fill: F, sw: 1 });
    case 'scriptTask': // 'bpmn:ScriptTask'
      return path(at('TASK_TYPE_SCRIPT', 15, 20), { fill: F, sw: 1 });
    case 'sendTask': // 'bpmn:SendTask' — filled envelope
      return path(scaledPath('TASK_TYPE_SEND', { containerWidth: 21, containerHeight: 14, position: { mx: 0.285, my: 0.357 } }),
        { fill: S, stroke: F, sw: 1 });
    case 'receiveTask': // 'bpmn:ReceiveTask' — instantiating: a ring with a small envelope
      if (node.instantiate === true) {
        return circle(28, 28, 20 * 0.22, { sw: 1 })
          + path(at('TASK_TYPE_INSTANTIATING_SEND', 7.77, 9.52), { fill: F, sw: 1 });
      }
      return path(scaledPath('TASK_TYPE_SEND', { xScaleFactor: 0.9, yScaleFactor: 0.9, containerWidth: 21, containerHeight: 14, position: { mx: 0.3, my: 0.4 } }),
        { fill: F, sw: 1 });
    case 'manualTask': // 'bpmn:ManualTask'
      return path(at('TASK_TYPE_MANUAL', 17, 15), { fill: F, sw: 0.5 });
    case 'businessRuleTask': // 'bpmn:BusinessRuleTask' — table, then its filled header
      return path(at('TASK_TYPE_BUSINESS_RULE_MAIN', 8, 8), { fill: F, sw: 1 })
        + path(at('TASK_TYPE_BUSINESS_RULE_HEADER', 8, 8), { fill: S, sw: 1 });
    default: return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Task markers — `renderTaskMarkers` and `taskMarkerRenderers`
// ─────────────────────────────────────────────────────────────────────

const MARKER = {
  SubProcessMarker: (w, h, o, p) => `<rect x="${num(w / 2 - 7.5)}" y="${num(h - 20)}" width="14" height="14" fill="${p.F}" stroke="${p.S}" stroke-width="1"/>`
    + p.path(scaledPath('MARKER_SUB_PROCESS', { abspos: { x: w / 2 - 7.5, y: h - 20 } }), { fill: p.F }),
  ParallelMarker: (w, h, o, p) => p.path(scaledPath('MARKER_PARALLEL', { abspos: { x: w / 2 + o.parallel, y: h - 20 } }), { fill: p.F }),
  SequentialMarker: (w, h, o, p) => p.path(scaledPath('MARKER_SEQUENTIAL', { abspos: { x: w / 2 + o.seq, y: h - 19 } }), { fill: p.F }),
  CompensationMarker: (w, h, o, p) => p.path(scaledPath('MARKER_COMPENSATION', { abspos: { x: w / 2 + o.compensation, y: h - 13 } }), { fill: p.F, sw: 1 }),
  LoopMarker: (w, h, o, p) => p.path(scaledPath('MARKER_LOOP', { abspos: { x: w / 2 + o.loop, y: h - 7 } }),
    { sw: 1.5, extra: ' stroke-miterlimit="0.5"' }),
  AdhocMarker: (w, h, o, p) => p.path(scaledPath('MARKER_ADHOC', { abspos: { x: w / 2 + o.adhoc, y: h - 15 } }), { fill: p.S, sw: 1 }),
};
const MARKER_NAME = {
  SubProcessMarker: 'sub-process', ParallelMarker: 'parallel', SequentialMarker: 'sequential',
  CompensationMarker: 'compensation', LoopMarker: 'loop', AdhocMarker: 'adhoc',
};

/**
 * The bottom markers of a `w`×`h` activity, in bpmn-js's order and at its offsets
 * (`renderTaskMarkers`). `collapsed` adds the [+] of a collapsed subprocess, transaction or call
 * activity. Each marker is one `<g data-marker="…">`, bpmn-js's `data-marker` names.
 * `isAdHoc` draws the tilde although the XML cannot carry it yet (#99).
 */
function renderTaskMarkers(node, w, h, { collapsed = false } = {}, col) {
  const p = drawers(col);
  const markers = collapsed ? ['SubProcessMarker'] : [];
  const o = collapsed
    ? { seq: -21, parallel: -22, compensation: -25, loop: -18, adhoc: 10 }
    : { seq: -5, parallel: -6, compensation: -7, loop: 0, adhoc: -8 };
  if (node.isCompensation) markers.push('CompensationMarker');
  if (node.isAdHoc) {
    markers.push('AdhocMarker');
    if (!collapsed) o.compensation -= 18;
  }
  // One loopCharacteristics per Activity, and `loopType` wins (S15) — as the XML is written.
  const loop = node.loopType ? 'loop' : (node.multiInstance ? (mi(node.multiInstance) === 'sequential' ? 'seq' : 'par') : null);
  if (loop) {
    o.compensation -= 18;
    if (markers.includes('AdhocMarker')) Object.assign(o, { seq: -23, loop: -18, parallel: -24 });
    markers.push(loop === 'loop' ? 'LoopMarker' : loop === 'seq' ? 'SequentialMarker' : 'ParallelMarker');
  }
  if (markers.includes('CompensationMarker') && markers.length === 1) o.compensation = -8;
  return markers.map((m) => `<g data-marker="${MARKER_NAME[m]}">${MARKER[m](w, h, o, p)}</g>`).join('');
}
const mi = (v) => (typeof v === 'string' ? v : v?.type);

// ─────────────────────────────────────────────────────────────────────
// Gateway symbols — the gateway handlers
// ─────────────────────────────────────────────────────────────────────

/**
 * The inner symbol of a `w`×`h` gateway. `node` carries `eventGatewayType` and `instantiate` for an
 * event-based gateway; `markerVisible` is the DI's `isMarkerVisible` (bpmn-xml.js sets it on every
 * exclusive gateway).
 */
function renderGatewaySymbol(type, w, h, node = {}, { markerVisible = true } = {}, col) {
  const { S, F, path, circle } = drawers(col);
  switch (type) {
    case 'exclusiveGateway': // 'bpmn:ExclusiveGateway'
      return markerVisible ? path(scaled('GATEWAY_EXCLUSIVE', w, h, 0.4, 0.32, 0.3), { fill: S, sw: 1 }) : '';
    case 'parallelGateway': // 'bpmn:ParallelGateway'
      return path(scaled('GATEWAY_PARALLEL', w, h, 0.6, 0.46, 0.2), { fill: S, sw: 1 });
    case 'inclusiveGateway': // 'bpmn:InclusiveGateway'
      return circle(w, h, h * 0.24, { sw: 2.5 });
    case 'complexGateway': // 'bpmn:ComplexGateway'
      return path(scaled('GATEWAY_COMPLEX', w, h, 0.5, 0.46, 0.26), { fill: S, sw: 1 });
    case 'eventBasedGateway': { // 'bpmn:EventBasedGateway'
      let out = circle(w, h, h * 0.20, { fill: 'none', sw: 1 });
      if (node.eventGatewayType === 'Parallel') {
        out += path(scaled('GATEWAY_PARALLEL', w, h, 0.4, 0.474, 0.296), { sw: 1 });
      } else {
        if (node.instantiate !== true) out += circle(w, h, h * 0.26, { fill: 'none', sw: 1 });
        out += path(scaled('GATEWAY_EVENT_BASED', w, h, 0.18, 0.36, 0.44), { sw: 2 });
      }
      return out;
    }
    default: return '';
  }
}

// ─────────────────────────────────────────────────────────────────────
// Data — 'bpmn:DataObject', 'bpmn:DataStoreReference'
// ─────────────────────────────────────────────────────────────────────

/** A data object's folded page and, for a collection, its three bars (`renderDataObject`). */
function renderDataObjectShape(w, h, { collection = false, fillOpacity } = {}, col) {
  const { S: stroke, F: fill, path } = drawers(col);
  const op = fillOpacity !== undefined ? ` fill-opacity="${fillOpacity}"` : '';
  let out = path(scaled('DATA_OBJECT_PATH', w, h, 1, 0.474, 0.296), { fill, stroke, extra: op });
  if (collection) {
    out += path(scaledPath('DATA_OBJECT_COLLECTION_PATH', { abspos: { x: 0.33 * w, y: h - 18 } }), { fill, stroke, sw: 2 });
  }
  return out;
}

/** A data store's cylinder with its stacked rims (`'bpmn:DataStoreReference'`). */
function renderDataStoreShape(w, h, { fillOpacity } = {}, col) {
  const { S: stroke, F: fill, path } = drawers(col);
  const op = fillOpacity !== undefined ? ` fill-opacity="${fillOpacity}"` : '';
  return path(scaled('DATA_STORE', w, h, 1, 0, 0.133), { fill, stroke, sw: 2, extra: op });
}

/** A text annotation's open bracket (`'bpmn:TextAnnotation'`). */
function renderTextAnnotationShape(w, h, { sw = 2 } = {}, col) {
  const { S: stroke, path } = drawers(col);
  return path(scaled('TEXT_ANNOTATION', w, h, 1, 0, 0), { stroke, sw });
}

export {
  renderEventMarker, inferEventMarker, renderTaskIcon, renderTaskMarkers, renderGatewaySymbol,
  renderDataObjectShape, renderDataStoreShape, renderTextAnnotationShape,
};

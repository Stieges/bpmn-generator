/**
 * The spanning fence: every field the schema declares, driven through the real pipeline and read
 * back through BOTH importers, checked against the contract its row in `types.js` states.
 *
 * Why this file exists, and why it is shaped like this
 * ---------------------------------------------------
 * The measured root cause of a whole defect class was that BPMN per-field knowledge lived as ~30
 * hand-written restatements. Every guard built against it so far checks one restatement against
 * another — `types.test.js` checks the table against `references/input-schema.json` and against
 * bpmn-moddle's metamodel, `pipeline.test.js` checks the serialiser against the table. Three such
 * fences were simultaneously green over a live `isCollection` defect, because an internally
 * consistent table is consistent with itself regardless of what it claims about the world.
 *
 * WHAT "SPANNING" MEANS HERE, AND WHAT IT DOES NOT. It spans the four PLACES a per-node or per-edge
 * field passes through (schema, write site, both read sites) — not every level of the model. Fields
 * that belong to a process, a pool or a lane (`lanes`, a pool's `name`, a process's `documentation`)
 * have no row in either table and no case here, so the four-places class remains unfenced at
 * container level. That was the brief's scope, not an oversight; it is tracked as backlog item 9 in
 * `docs/superpowers/plans/2026-08-03-field-authority-and-spanning-fence.md`. Do not read the file
 * name as total coverage.
 *
 * This fence is different in exactly one respect, and it is the respect that matters: **its oracle
 * is execution.** It runs the real `runPipeline`, re-reads the real XML through `bpmnToLogicCore`
 * (bpmn-moddle, the primary path) AND `bpmnToLogicCoreLegacy` (the DOM parser, the fallback), and
 * compares what came back with what went in. Nothing here asserts the table against the table.
 *
 * Three properties are deliberate:
 *
 * 1. **The exclusion list IS `roundTrip`, and there is no second one.** A row is exercised unless
 *    its own `roundTrip` column says `'none'`, and a `'none'` row is exercised in the other
 *    direction (the field must NOT survive), so implementing it later turns this fence red instead
 *    of improving something silently. There is no local skip list, no `it.skip`, no per-field
 *    opt-out. If a case here cannot be written, the row is wrong — that is a finding for the
 *    table's owner, not a line to add here.
 *
 * 2. **A `'lossy'` row's assertion is row-specific and bound to its own `reason` text.** A shared
 *    presence check across every lossy row would be a fence that passes on nearly anything. So each
 *    lossy row has an entry in `LOSSY_CONTRACTS` below that (a) states what comes back for a given
 *    input, per importer path and per depth, and (b) carries a `quote`: a verbatim fragment of that
 *    row's `reason` in `types.js`, asserted to still appear there. Rewrite the reason's mechanism
 *    and the quote check fails, which forces the assertion to be re-read rather than left to drift.
 *    See `LOSSY_CONTRACTS`'s own comment for why the assertions live here and not in `types.js`.
 *
 * 3. **Failure messages name field × sample × type × depth × importer path.** Every assertion goes
 *    through `sameAs`, which puts that string into the compared value itself, so a Jest diff reads
 *    `isEventSubProcess=true on transaction at depth 1 via legacy` and not `expected true, got
 *    undefined` with nothing to locate it by. A fence whose failure does not say where to look gets
 *    deleted rather than fixed.
 *
 * Relation to the field-set round-trip guard over `tests/fixtures/subprocess-child-fidelity.json`
 * (`pipeline.test.js`, "subprocess children — nothing is lost on the way down"): they complement,
 * neither subsumes the other. That one is composition × realistic — one hand-built model where many
 * fields, a boundary event, a grandchild and a data reference interact, and it would catch a loss
 * that only happens when two features meet. This one is isolation × exhaustive — one field at a
 * time, every class the table allows, every depth, both importers, generated from the schema so a
 * new field cannot be forgotten. Keep both.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

import { runPipeline } from './pipeline.js';
import { bpmnToLogicCore, bpmnToLogicCoreLegacy } from './import.js';
import {
  OMG_NODE_FIELD_SCOPE, OMG_EDGE_FIELD_SCOPE, nodeFieldSpec,
  DEFAULT_FLOW_SOURCE_TYPES, isArtifact,
} from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'references', 'input-schema.json');
const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

// Read, never restated — the same discipline as `types.test.js`'s `loadNodeTypeEnum`. A test file
// with its own copy of the NodeType list is the second-partial-list problem moved into the tests.
const NODE_TYPE_ENUM = SCHEMA.$defs?.NodeType?.enum;
if (!Array.isArray(NODE_TYPE_ENUM) || NODE_TYPE_ENUM.length === 0) {
  throw new Error('references/input-schema.json: $defs.NodeType.enum not found — fence cannot run');
}
const UNIVERSE = new Set(NODE_TYPE_ENUM);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1. The completeness check
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// The structural half of the stage, and the reason the four-places defect becomes impossible to
// reintroduce unnoticed. `references/input-schema.json` declares every Node property flat on every
// type; a property with no row in `OMG_NODE_FIELD_SCOPE` is a field with no stated authority —
// nothing says which class may carry it, nothing says whether it survives — and it is therefore
// invisible to everything below. So the schema is compared against the table here, at the head of
// the fence that consumes it, and a new property fails CI naming itself.
//
// `types.test.js` makes the same comparison, and the duplication is deliberate rather than an
// oversight: there it guards the TABLE (a row is missing), here it guards this FENCE's coverage (a
// field is going unexercised). They would be split by any refactor that moved one of the two, and
// the cost of the overlap is one assertion.

describe('the completeness check — no schema field escapes the fence', () => {
  const NODE_NON_FIELDS = new Set(['id', 'type']);
  const EDGE_NON_FIELDS = new Set(['id']);

  const declaredNode = Object.keys(SCHEMA.$defs.Node.properties).filter((k) => !NODE_NON_FIELDS.has(k));
  const declaredEdge = Object.keys(SCHEMA.$defs.Edge.properties).filter((k) => !EDGE_NON_FIELDS.has(k));

  const registeredNode = new Set(OMG_NODE_FIELD_SCOPE.map((s) => s.field));
  const registeredEdge = new Set(OMG_EDGE_FIELD_SCOPE.map((s) => s.field));

  const HOWTO = (table) => `add a row to ${table} in scripts/bpmn/types.js stating its `
    + '`shape` (how it serialises), `allowed` (which classes may carry it) and `roundTrip` '
    + '(what survives Logic-Core → XML → Logic-Core) — with a `reason` for anything below `exact`';

  test('every $defs.Node property except id/type has a row in OMG_NODE_FIELD_SCOPE', () => {
    const unregistered = declaredNode.filter((f) => !registeredNode.has(f));
    expect([`unregistered $defs.Node properties — ${HOWTO('OMG_NODE_FIELD_SCOPE')}`, unregistered])
      .toEqual([`unregistered $defs.Node properties — ${HOWTO('OMG_NODE_FIELD_SCOPE')}`, []]);
  });

  test('every $defs.Edge property except id has a row in OMG_EDGE_FIELD_SCOPE', () => {
    const unregistered = declaredEdge.filter((f) => !registeredEdge.has(f));
    expect([`unregistered $defs.Edge properties — ${HOWTO('OMG_EDGE_FIELD_SCOPE')}`, unregistered])
      .toEqual([`unregistered $defs.Edge properties — ${HOWTO('OMG_EDGE_FIELD_SCOPE')}`, []]);
  });

  // THE PREMISE the two checks above depend on, asserted rather than assumed.
  //
  // They read `$defs.Node.properties` and `$defs.Edge.properties` and nothing else. That is total
  // only while those two schemas declare their properties FLAT — no `oneOf`/`allOf`/`if`/`then`
  // branch introducing a property from somewhere else, and `additionalProperties: false` closing the
  // set. Today both hold, by convention; the convention was asserted nowhere, and the plan's backlog
  // item 8 contemplates adding exactly that scoping to this schema.
  //
  // Asserting the premise rather than walking the branches, deliberately. Walking them means
  // implementing a JSON-Schema applicator resolver inside a test whose subject is not JSON Schema —
  // and worse, it would quietly succeed: a property declared inside an `if`/`then` is a CONDITIONAL
  // declaration ("this field exists only on these types"), and the table has its own vocabulary for
  // that (`allowed`), which a flat merge would paper over. So when that schema change lands, this
  // check must fail, so that the fence is taught the new shape and the two statements of per-type
  // scoping are reconciled ON PURPOSE, in the same commit — not shrunk in silence.
  const APPLICATORS = ['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', '$ref',
    'patternProperties', 'dependentSchemas', 'unevaluatedProperties'];

  test.each(['Node', 'Edge'])(
    '$defs.%s declares its properties flat — the premise the completeness check rests on', (def) => {
      const schema = SCHEMA.$defs[def];
      const found = APPLICATORS.filter((k) => k in schema);
      expect({
        [`applicator keywords in $defs.${def} (teach the completeness check the new shape before adding one)`]: found,
        additionalProperties: schema.additionalProperties,
      }).toEqual({
        [`applicator keywords in $defs.${def} (teach the completeness check the new shape before adding one)`]: [],
        additionalProperties: false,
      });
    });

  // The reverse direction: a row for a field the schema does not declare is a contract nobody can
  // author, and it would silently generate cases for a field that can never appear in real input.
  test('no row names a field the schema does not declare', () => {
    const strayNode = [...registeredNode].filter((f) => !declaredNode.includes(f));
    const strayEdge = [...registeredEdge].filter((f) => !declaredEdge.includes(f));
    expect({ node: strayNode, edge: strayEdge }).toEqual({ node: [], edge: [] });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. The inputs — one authored value per field, and what makes it not an exclusion list
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// A round trip needs a value to send round, and no table can generate one: `marker` needs a member
// of the EventMarker enum, `timerExpression` an object with a `type` the write site recognises,
// `linkName` a sibling `marker: 'link'` for the mechanism to engage at all. So each field carries a
// list of SAMPLES here.
//
// This list is emphatically NOT a second exclusion list, and two fences below make that structural:
// every row with `roundTrip !== 'none'` must have at least one sample, and every sample key must
// name a real row. A field cannot be quietly dropped from the fence by omitting its sample; the
// fence fails naming it.
//
// A sample is `{ label, value, extra?, model?, childless? }`:
//   - `value: undefined` means "do not author the field". That is not a gap but a deliberate case:
//     three of the mechanisms the table records are FABRICATIONS — the serialiser inventing a
//     `condition` from a `label`, an auto-`default` on the last outgoing edge, a `linkName` from
//     the node's name — and a fabrication can only be observed by authoring nothing and finding
//     something.
//   - `extra` adds sibling fields to the subject (a `marker` the field depends on).
//   - `model` merges into the process itself (the `lanes` a `lane` value must refer to).
//   - `childless` suppresses the default children a container subject otherwise gets.
//
// Where a row's `reason` names the values that behave differently, the samples are exactly those
// values — `implementation`'s two OMG defaults plus one ordinary URI, `marker`'s two unmappable
// members plus one mappable. That is what keeps a lossy row's assertion from being satisfiable by
// an input chosen to avoid the mechanism it describes.
const HOST_ID = 'host';
const LANE_ID = 'lane_a';
const LANES = { lanes: [{ id: LANE_ID, name: 'Sachbearbeitung' }, { id: 'lane_b', name: 'Leitung' }] };

// Deliberately free of `<`, `>` and `&`. The legacy DOM parser never unescapes a text node — a
// defect `conditionExpression`'s and `loopType`'s reasons both record — so an entity in a value
// under test would mix that one parser defect into every other row's result. The two rows whose
// reasons name the escaping loss assert it explicitly, with a value chosen for it.
const PLAIN = 'Antrag vollstaendig';

const SAMPLES = {
  // ── node fields ────────────────────────────────────────────────────────────────────────────
  // Booleans are sampled with `true` only, except where the row's own mechanism is about the other
  // value (`cancelActivity`, `has_join`). The table states the write loop's contract as "write the
  // value when it is truthy", so a `false` is by that stated contract indistinguishable from an
  // absent field on the way out — a property of the loop, already written down, not a per-field
  // fidelity question this fence can answer per row.
  isCompensation: [{ label: 'true', value: true }],
  implementation: [
    { label: '##WebService', value: '##WebService' },
    { label: '##unspecified', value: '##unspecified' },
    { label: 'an ordinary URI', value: 'http://intern/svc/pruefung' },
  ],
  isEventSubProcess: [{ label: 'true', value: true }],
  calledElement: [{ label: 'a process id', value: 'RatingProcess' }],
  scriptFormat: [{ label: 'groovy', value: 'groovy' }],
  eventGatewayType: [
    { label: 'Exclusive (OMG default)', value: 'Exclusive' },
    { label: 'Parallel', value: 'Parallel' },
  ],
  instantiate: [{ label: 'true', value: true }],
  name: [{ label: 'a label', value: 'Antrag pruefen' }],
  attachedTo: [{ label: 'the host id', value: HOST_ID }],
  cancelActivity: [
    { label: 'false (the only value written)', value: false },
    { label: 'true (the XSD default)', value: true },
  ],
  // Both branches of the row's mechanism have to be reachable, or the assertion only ever checks
  // the absent one. `joining` makes the factory route two branches into the subject, so
  // `inferGatewayDirections` calls it Converging and `gatewayDirection="Converging"` is written —
  // the one value that maps back. Without it every case would assert "no attribute, no field",
  // which is true and proves nothing about the half of the sentence the reason is actually about.
  has_join: [
    { label: 'true, one incoming', value: true },
    { label: 'false, one incoming', value: false },
    { label: 'true, two incoming', value: true, joining: true },
    { label: 'false, two incoming', value: false, joining: true },
  ],
  isCollection: [{ label: 'true', value: true }],
  isExpanded: [
    { label: 'true, with children', value: true },
    { label: 'true, childless', value: true, childless: true },
  ],
  color: [{ label: 'fill and stroke', value: { fill: '#ffe0b2', stroke: '#e65100' } }],
  documentation: [{ label: 'a sentence', value: 'Fachliche Erlaeuterung zum Schritt.' }],
  lane: [{ label: 'a declared lane', value: LANE_ID, model: LANES }],
  script: [{ label: 'a script body', value: 'score = 1' }],
  loopType: [
    { label: 'the "standard" shorthand', value: 'standard' },
    { label: '{ testBefore: true, loopMaximum: 3 }', value: { testBefore: true, loopMaximum: 3 } },
    { label: '{ testBefore: false } only', value: { testBefore: false } },
    { label: 'a loopCondition carrying "<"', value: { loopCondition: 'x<3' } },
  ],
  multiInstance: [
    { label: 'the "parallel" shorthand', value: 'parallel' },
    { label: '{ type: "parallel" } only', value: { type: 'parallel' } },
    { label: '{ type: "sequential", loopCardinality }', value: { type: 'sequential', loopCardinality: '3' } },
  ],
  nodes: [{
    // BOTH artifact classes are in this list, and that is the sample's whole point: a flow-node
    // child round-trips on both paths, so flow nodes alone would leave the row's stated mechanism
    // unexercised — and the two artifact classes do NOT behave alike. A `textAnnotation` carries its
    // label in `<bpmn:text>`, which `buildFlowNode` writes at any depth; a `group` carries it in a
    // CategoryValue that only `buildProcess`'s top-level loop builds, so a nested group comes back
    // with an empty name. Sampling only the annotation is how the row came to claim a fidelity the
    // `group` class does not have.
    label: 'three flow-node children, a flow, an annotation and a group',
    value: [
      { id: 'kid_s', type: 'startEvent', name: 'Kind Start' },
      { id: 'kid_t', type: 'userTask', name: 'Kind Schritt' },
      { id: 'kid_e', type: 'endEvent', name: 'Kind Ende' },
      { id: 'kid_note', type: 'textAnnotation', name: 'Hinweis im Kind' },
      { id: 'kid_grp', type: 'group', name: 'Gruppe im Kind' },
    ],
    extra: {
      edges: [
        { id: 'kid_f1', source: 'kid_s', target: 'kid_t' },
        { id: 'kid_f2', source: 'kid_t', target: 'kid_e' },
      ],
    },
  }],
  edges: [{
    label: 'a child edge carrying condition and isDefault',
    value: [
      { id: 'kid_f1', source: 'kid_s', target: 'kid_t', label: 'Ja', condition: PLAIN, isDefault: true },
      { id: 'kid_f2', source: 'kid_t', target: 'kid_e' },
    ],
    extra: {
      nodes: [
        { id: 'kid_s', type: 'startEvent', name: 'Kind Start' },
        { id: 'kid_t', type: 'userTask', name: 'Kind Schritt' },
        { id: 'kid_e', type: 'endEvent', name: 'Kind Ende' },
      ],
    },
  }],
  marker: [
    { label: 'message (mappable)', value: 'message' },
    { label: 'multiple (no single EventDefinition class)', value: 'multiple' },
    { label: 'parallelMultiple (likewise)', value: 'parallelMultiple' },
  ],
  linkName: [
    { label: 'with marker link', value: 'ZumZweitenTeil', extra: { marker: 'link' } },
    { label: 'with marker message', value: 'ZumZweitenTeil', extra: { marker: 'message' } },
    { label: 'unauthored, with marker link', value: undefined, extra: { marker: 'link' } },
  ],
  conditionExpression: [
    { label: 'with marker conditional', value: PLAIN, extra: { marker: 'conditional' } },
    { label: 'carrying "<", with marker conditional', value: 'x<1', extra: { marker: 'conditional' } },
    { label: 'with marker message', value: PLAIN, extra: { marker: 'message' } },
  ],
  timerExpression: [
    { label: 'a duration, with marker timer', value: { type: 'duration', value: 'PT1H' }, extra: { marker: 'timer' } },
    { label: 'a date, with marker timer', value: { type: 'date', value: '2026-08-03T09:00:00' }, extra: { marker: 'timer' } },
    { label: 'a cycle, with marker timer', value: { type: 'cycle', value: 'R3/PT10M' }, extra: { marker: 'timer' } },
    { label: 'an unrecognised type, with marker timer', value: { type: 'bogus', value: 'PT2H' }, extra: { marker: 'timer' } },
    { label: 'with marker message', value: { type: 'duration', value: 'PT1H' }, extra: { marker: 'message' } },
  ],
  decisionRef: [{ label: 'a decision id', value: 'dec_bonitaet' }],
  isAdHoc: [{ label: 'true', value: true }],
  isInterrupting: [{ label: 'true', value: true }],
  extensions: [{ label: 'a foreign attribute bag', value: { 'acme:owner': 'Fachbereich' } }],

  // ── edge fields ────────────────────────────────────────────────────────────────────────────
  // `source`/`target` are sampled as `undefined`: their value is structural — the id of the node the
  // factory builds — so the factory writes it and the assertion compares against the id it used.
  // Authoring a literal here would be a second statement of the same fact.
  source: [{ label: 'the built source', value: undefined }],
  target: [{ label: 'the built target', value: undefined }],
  label: [{ label: 'a branch label', value: 'Ja' }],
  condition: [{ label: 'a condition body', value: PLAIN }],
  isDefault: [
    { label: 'true on the FIRST of two outgoing edges', value: true },
    { label: 'unauthored on either edge', value: undefined },
  ],
  isConditional: [{ label: 'true', value: true }],
  isHappyPath: [{ label: 'true', value: true }],
};

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 3. The fixture factory
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// A minimal VALID model per subject type, at each placement. Generalised from `pipeline.test.js`'s
// `wire()` and its `place()` sibling rather than started over: `wire()` is the same three-node chain
// with the subject in the middle, and `place()` is the artifact branch of `buildNodeModel` below.
// What is new here is everything the round trip needs that a rule-engine fixture does not: the
// subject may BE the start or the end event (a `startEvent` cannot sit in the middle of a chain),
// a boundary event needs a host and an outgoing flow of its own, a container subject needs children,
// an edge subject needs a source whose class the row varies, and every one of those must also work
// one level down.
//
// Depth 1 is one wrapper around the whole depth-0 model: the inner chain keeps its own start and end
// events, which is what an expanded subprocess actually looks like. Both container classes are used,
// because `transaction` inheriting `SubProcess`'s behaviour has already been wrong twice on the read
// side (Stage 0's regression), and a fence that only ever wrapped in a `subProcess` would not have
// seen it.
const SUBJECT = 'subject';
const SIBLING_EDGE = 'sibling_edge';
const SIBLING_NODE = 'sibling_node';
const SUBJECT_EDGE = 'subject_edge';
const WRAPPER = 'wrapper';

const PLACEMENTS = [
  { label: 'depth 0', depth: 0, wrapper: null },
  { label: 'depth 1 (subProcess)', depth: 1, wrapper: 'subProcess' },
  { label: 'depth 1 (transaction)', depth: 1, wrapper: 'transaction' },
];

const CONTAINERS = new Set(['subProcess', 'transaction']);

const defaultChildren = (prefix) => ({
  nodes: [
    { id: `${prefix}_s`, type: 'startEvent', name: 'Start' },
    { id: `${prefix}_t`, type: 'userTask', name: 'Schritt' },
    { id: `${prefix}_e`, type: 'endEvent', name: 'Ende' },
  ],
  edges: [
    { id: `${prefix}_f1`, source: `${prefix}_s`, target: `${prefix}_t` },
    { id: `${prefix}_f2`, source: `${prefix}_t`, target: `${prefix}_e` },
  ],
});

/** The subject node itself, with whatever its class structurally requires. */
function makeSubject(type, field, sample) {
  const node = { id: SUBJECT, type, name: 'Subjekt', ...(sample.extra || {}) };
  if (sample.value !== undefined) node[field] = sample.value;
  // A boundary event without `attachedToRef` is invalid BPMN ([1..1]); for the `attachedTo` row the
  // sample's value IS this id, so the two agree by construction rather than by coincidence.
  if (type === 'boundaryEvent') node.attachedTo = node.attachedTo ?? HOST_ID;
  // A textAnnotation/group carries no `name` (BaseElement declares only `id`) — but the label does
  // travel, by `<bpmn:text>` and by a CategoryValue, and both importers read it back as `name`. So
  // leaving the default name on is right; the `name` row's own `allowed` excludes those two classes.
  if (CONTAINERS.has(type) && !sample.childless) {
    const kids = defaultChildren('kid');
    node.nodes = node.nodes ?? kids.nodes;
    node.edges = node.edges ?? kids.edges;
  }
  return node;
}

/** The depth-0 process body for a NODE row: `{ nodes, edges }`. */
function buildNodeBody(type, field, sample) {
  const subject = makeSubject(type, field, sample);

  if (isArtifact(type)) {
    // Not a sequence-flow endpoint at all (that is S09/S10's subject) — wiring one into the chain
    // serialises something the model does not mean. Placed beside the flow, exactly as
    // `pipeline.test.js`'s `place()` does.
    return {
      nodes: [
        { id: 'flow_s', type: 'startEvent', name: 'Start' },
        { id: 'flow_t', type: 'userTask', name: 'Schritt' },
        { id: 'flow_e', type: 'endEvent', name: 'Ende' },
        subject,
      ],
      edges: [
        { id: 'f1', source: 'flow_s', target: 'flow_t' },
        { id: 'f2', source: 'flow_t', target: 'flow_e' },
      ],
    };
  }

  if (type === 'boundaryEvent') {
    return {
      nodes: [
        { id: 'flow_s', type: 'startEvent', name: 'Start' },
        { id: HOST_ID, type: 'userTask', name: 'Traeger' },
        subject,
        { id: 'handler', type: 'userTask', name: 'Behandlung' },
        { id: 'flow_e', type: 'endEvent', name: 'Ende' },
      ],
      edges: [
        { id: 'f1', source: 'flow_s', target: HOST_ID },
        { id: 'f2', source: HOST_ID, target: 'flow_e' },
        { id: 'f3', source: SUBJECT, target: 'handler' },
        { id: 'f4', source: 'handler', target: 'flow_e' },
      ],
    };
  }

  if (type === 'startEvent') {
    return {
      nodes: [subject, { id: 'flow_t', type: 'userTask', name: 'Schritt' }, { id: 'flow_e', type: 'endEvent', name: 'Ende' }],
      edges: [{ id: 'f1', source: SUBJECT, target: 'flow_t' }, { id: 'f2', source: 'flow_t', target: 'flow_e' }],
    };
  }

  if (type === 'endEvent') {
    return {
      nodes: [{ id: 'flow_s', type: 'startEvent', name: 'Start' }, { id: 'flow_t', type: 'userTask', name: 'Schritt' }, subject],
      edges: [{ id: 'f1', source: 'flow_s', target: 'flow_t' }, { id: 'f2', source: 'flow_t', target: SUBJECT }],
    };
  }

  if (sample.joining) {
    // Two branches into the subject, so a gateway subject is genuinely converging.
    return {
      nodes: [
        { id: 'flow_s', type: 'startEvent', name: 'Start' },
        { id: 'pre_split', type: 'parallelGateway', name: 'Aufteilen' },
        { id: 'branch_a', type: 'userTask', name: 'Zweig A' },
        { id: 'branch_b', type: 'userTask', name: 'Zweig B' },
        subject,
        { id: 'flow_e', type: 'endEvent', name: 'Ende' },
      ],
      edges: [
        { id: 'f1', source: 'flow_s', target: 'pre_split' },
        { id: 'f2', source: 'pre_split', target: 'branch_a' },
        { id: 'f3', source: 'pre_split', target: 'branch_b' },
        { id: 'f4', source: 'branch_a', target: SUBJECT },
        { id: 'f5', source: 'branch_b', target: SUBJECT },
        { id: 'f6', source: SUBJECT, target: 'flow_e' },
      ],
    };
  }

  return {
    nodes: [{ id: 'flow_s', type: 'startEvent', name: 'Start' }, subject, { id: 'flow_e', type: 'endEvent', name: 'Ende' }],
    edges: [{ id: 'f1', source: 'flow_s', target: SUBJECT }, { id: 'f2', source: SUBJECT, target: 'flow_e' }],
  };
}

/**
 * The depth-0 process body for an EDGE row.
 *
 * An edge row's `allowed` names the SOURCE node types the field is meaningful for (see
 * `OMG_EDGE_FIELD_SCOPE`'s doc comment), except `target`, where the varying class is the target —
 * so the varying node changes role with the field, and everything else is anchored to a userTask.
 *
 * The subject edge is the FIRST of two outgoing edges wherever the source class may branch, and the
 * membership test is `DEFAULT_FLOW_SOURCE_TYPES` — the table's own set, not a hand list. First,
 * not last, on purpose: `buildDefaultFlowMap` fabricates an auto-default onto the LAST outgoing
 * edge of a diverging XOR/OR gateway, so a subject edge sitting last could pass `isDefault` by
 * being fabricated rather than by being preserved.
 */
function buildEdgeBody(type, field, sample) {
  const varying = field === 'target' ? 'target' : 'source';
  const nodes = [];
  const edges = [];

  const anchorStart = { id: 'flow_s', type: 'startEvent', name: 'Start' };
  const anchorEnd = { id: 'flow_e', type: 'endEvent', name: 'Ende' };
  const varyingNode = { id: varying === 'source' ? 'src' : 'tgt', type, name: 'Variabel' };
  if (type === 'boundaryEvent') varyingNode.attachedTo = HOST_ID;

  const srcId = varying === 'source' ? varyingNode.id : 'src';
  const tgtId = varying === 'target' ? varyingNode.id : 'tgt';
  const otherNode = varying === 'source'
    ? { id: 'tgt', type: 'userTask', name: 'Ziel' }
    : { id: 'src', type: 'userTask', name: 'Quelle' };

  nodes.push(anchorStart, varyingNode, otherNode, anchorEnd);

  // The varying node needs a host when it is a boundary event, wherever it sits.
  if (type === 'boundaryEvent') {
    nodes.push({ id: HOST_ID, type: 'userTask', name: 'Traeger' });
    edges.push({ id: 'h1', source: 'flow_s', target: HOST_ID }, { id: 'h2', source: HOST_ID, target: 'flow_e' });
  } else if (type !== 'startEvent') {
    edges.push({ id: 'f_in', source: 'flow_s', target: srcId });
  }

  const subjectEdge = { id: SUBJECT_EDGE, source: srcId, target: tgtId };
  if (sample.value !== undefined) subjectEdge[field] = sample.value;
  edges.push(subjectEdge);

  if (DEFAULT_FLOW_SOURCE_TYPES.has(nodes.find((n) => n.id === srcId).type)) {
    nodes.push({ id: SIBLING_NODE, type: 'userTask', name: 'Zweiter Zweig' });
    edges.push({ id: SIBLING_EDGE, source: srcId, target: SIBLING_NODE, label: 'Nein' });
    edges.push({ id: 'f_sib_out', source: SIBLING_NODE, target: 'flow_e' });
  }

  if (tgtId !== 'flow_e' && type !== 'endEvent') edges.push({ id: 'f_out', source: tgtId, target: 'flow_e' });

  return { nodes, edges };
}

/** Wrap a depth-0 body one level down, or return it as the process itself. */
function place(body, placement, sample) {
  const model = { id: 'P', name: 'Fachprozess', ...(sample.model || {}) };
  if (!placement.wrapper) return { ...model, ...body };
  return {
    ...model,
    nodes: [
      { id: 'outer_s', type: 'startEvent', name: 'Start' },
      { id: WRAPPER, type: placement.wrapper, name: 'Huelle', isExpanded: true, nodes: body.nodes, edges: body.edges },
      { id: 'outer_e', type: 'endEvent', name: 'Ende' },
    ],
    edges: [
      { id: 'outer_f1', source: 'outer_s', target: WRAPPER },
      { id: 'outer_f2', source: WRAPPER, target: 'outer_e' },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 4. Reading the round trip back
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const walkNodes = (lc) => {
  const out = [];
  const walk = (nodes) => { for (const n of nodes ?? []) { out.push(n); walk(n.nodes); } };
  walk(lc.nodes);
  for (const p of lc.pools ?? []) walk(p.nodes);
  return out;
};

const walkEdges = (lc) => {
  const out = [];
  const fromNodes = (nodes) => {
    for (const n of nodes ?? []) { out.push(...(n.edges ?? [])); fromNodes(n.nodes); }
  };
  out.push(...(lc.edges ?? []));
  fromNodes(lc.nodes);
  for (const p of lc.pools ?? []) { out.push(...(p.edges ?? [])); fromNodes(p.nodes); }
  return out;
};

const nodeById = (lc, id) => walkNodes(lc).find((n) => n.id === id);
const edgeById = (lc, id) => walkEdges(lc).find((e) => e.id === id);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 5. The assertions
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Every comparison in this file goes through here, and the reason is the failure message. Jest's
 * default diff for `expect(undefined).toEqual(true)` says nothing about WHICH of ~1300 generated
 * cases produced it. Folding the locator into the compared value makes the diff self-describing:
 *
 *   - Expected: ["isEventSubProcess=true on transaction at depth 1 (subProcess) via legacy", true]
 *   - Received: ["isEventSubProcess=true on transaction at depth 1 (subProcess) via legacy", undefined]
 *
 * The same idiom `pipeline.test.js` already uses for its two-path assertions, made the only way to
 * assert here so a future case cannot quietly be added without it.
 */
function sameAs(ctx, actual, expected, what = '') {
  const where = `${ctx.where}${what ? ` — ${what}` : ''}`;
  expect([where, actual]).toEqual([where, expected]);
}

const IMPORTER_PATHS = ['moddle', 'legacy'];

/**
 * Run one assertion block per importer path and report the verdicts TOGETHER.
 *
 * A plain loop with inline assertions aborts on the first path that throws, so a field dropped from
 * BOTH importers in one commit reads as `via moddle` and nothing else. The author fixes
 * `moddle-import.js`, re-runs, and the fence is still red — with the second half of the same defect
 * appearing only then, as if it were new. That is precisely the "a failure that does not say where
 * to look" shape this fence was built to avoid, so the failure has to speak for both paths at once.
 *
 * The verdict line comes first (`moddle: FAILED, legacy: ok`) because it answers the one question
 * that decides what to do next: is this one importer's defect, or the shared write side's? Each
 * path's own Jest diff follows verbatim underneath, so nothing is lost — only the code frame, which
 * pointed at `sameAs` rather than at the case anyway.
 */
function reportBothPaths(blocks) {
  const failures = [];
  for (const [path, run] of blocks) {
    try {
      run();
    } catch (err) {
      failures.push({ path, message: err.message });
    }
  }
  if (failures.length === 0) return;
  const failed = new Set(failures.map((f) => f.path));
  const verdict = blocks.map(([path]) => `${path}: ${failed.has(path) ? 'FAILED' : 'ok'}`).join(', ');
  const detail = failures.map((f) => `──────── ${f.path} ────────\n${f.message}`).join('\n\n');
  throw new Error(`${verdict}\n\n${detail}`);
}

/**
 * The 15 `roundTrip: 'lossy'` contracts.
 *
 * WHY THEY LIVE HERE and not beside the row in `types.js`. The brief left the choice open between a
 * per-row assertion function in `types.js` and a lookup keyed by field in the test. Three things
 * decided it:
 *
 *   1. `types.js` is a runtime module with no dependencies — CLAUDE.md's architecture map says so
 *      in as many words — and it is imported by the serialiser, both importers, the rule engine and
 *      `scripts/scenarios/`. Fifteen closures whose only caller is Jest would ship in the npm
 *      package and in the `.skill` bundle, and would be the first thing in that file that is not
 *      about what BPMN says.
 *   2. An assertion needs a vocabulary the table does not have: which importer path produced the
 *      value, which depth the subject sat at, what the fixture factory named the sibling edge. Those
 *      are facts about THIS fence, not about the field. Putting them in `types.js` would make the
 *      table's shape depend on the test's shape, which is backwards — the table is the authority,
 *      the fence is a consumer.
 *   3. The real risk of the split — an assertion drifting away from the `reason` it is supposed to
 *      encode — is not solved by adjacency anyway. Two things next to each other drift just as
 *      quietly as two things in different files; what stops drift is a check.
 *
 * So the drift is closed by a check instead of by proximity: every entry carries `quote`, a verbatim
 * fragment of that row's `reason` naming the mechanism the assertion implements, and a fence below
 * asserts that the fragment still occurs in the row's `reason`. Rewrite the reason and the quote
 * fails; the author then has to look at the assertion the quote was taken from. Two further fences
 * make the mapping total: every `lossy` row has an entry, and every entry names a `lossy` row.
 *
 * `assert(ctx)` receives everything a mechanism can turn on:
 *   `ctx.value`      what was authored (`undefined` when the sample authored nothing)
 *   `ctx.out`        the re-imported subject node/edge (`undefined` if it vanished)
 *   `ctx.lc`         the whole re-imported Logic-Core, for a mechanism that moves a value elsewhere
 *   `ctx.xml`        the emitted XML, for a mechanism whose evidence is the attribute itself
 *   `ctx.input`      the authored subject node/edge
 *   `ctx.type`       the class under test
 *   `ctx.depth`      0 or 1
 *   `ctx.path`       'moddle' | 'legacy'
 */
const LOSSY_CONTRACTS = {
  implementation: {
    quote: 'both importers drop `##WebService` and `##unspecified`',
    assert: (ctx) => {
      const isOmgDefault = ctx.value === '##WebService' || ctx.value === '##unspecified';
      sameAs(ctx, ctx.out?.implementation, isOmgDefault ? undefined : ctx.value);
    },
  },

  eventGatewayType: {
    quote: '`Exclusive` is OMG\'s default for eventGatewayType and both importers drop it',
    assert: (ctx) => {
      sameAs(ctx, ctx.out?.eventGatewayType, ctx.value === 'Exclusive' ? undefined : ctx.value);
    },
  },

  cancelActivity: {
    quote: 'Only `cancelActivity: false` is serialised',
    assert: (ctx) => {
      sameAs(ctx, ctx.out?.cancelActivity, ctx.value === false ? false : undefined);
    },
  },

  has_join: {
    // The row's mechanism is "the attribute written is `node._direction`, and only Converging maps
    // back" — so the oracle is the attribute that was actually written, read out of the XML, not the
    // value that was authored. That is what makes this assertion a check of the stated mechanism
    // rather than a restatement of the authored input.
    quote: 'Only `Converging` maps back to',
    assert: (ctx) => {
      const written = new RegExp(`<bpmn:${ctx.type} id="${SUBJECT}"[^>]*gatewayDirection="Converging"`).test(ctx.xml);
      sameAs(ctx, ctx.out?.has_join, written ? true : undefined, `gatewayDirection="Converging" written: ${written}`);
    },
  },

  lane: {
    quote: 'NOT WRITTEN AT ALL at depth >= 1',
    assert: (ctx) => {
      sameAs(ctx, ctx.out?.lane, ctx.depth === 0 ? ctx.value : undefined);
    },
  },

  isExpanded: {
    quote: 'WRITTEN ONLY WHEN THE CONTAINER ALSO CARRIES CHILDREN',
    assert: (ctx) => {
      // Depth is deliberately NOT in this predicate any more, and that is the whole point of the
      // stage that changed it: the row used to lose the field at depth >= 1 as well, and asserting
      // `hasChildren && depth === 0` would let that regress unnoticed. Children alone decide.
      const hasChildren = (ctx.input.nodes ?? []).length > 0;
      sameAs(ctx, ctx.out?.isExpanded, hasChildren ? true : undefined,
        `children: ${hasChildren}, depth: ${ctx.depth}`);
    },
  },

  nodes: {
    quote: 'A NESTED `group` LOSES ITS `name`',
    assert: (ctx) => {
      const back = walkNodes(ctx.lc);
      for (const child of ctx.value) {
        const got = back.find((n) => n.id === child.id);
        sameAs(ctx, got?.id, child.id, `child ${child.id} (${child.type}) survives at depth ${ctx.depth}`);
        sameAs(ctx, got.type, child.type, `child ${child.id}: its class survives`);
        // A group's label travels as a CategoryValue, which `buildCategoryForGroup` builds only in
        // `buildProcess`'s top-level loop — never in `buildFlowNode`'s recursion. A `nodes` child is
        // nested by definition, so every group in this sample loses its name at every placement.
        const labelLost = child.type === 'group';
        sameAs(ctx, got.name, labelLost ? '' : child.name,
          `child ${child.id}: its label${labelLost ? ' is lost — no CategoryValue is built below the top level' : ' survives'}`);
      }
    },
  },

  loopType: {
    quote: 'An object whose only sub-properties are false collapses to the string shorthand',
    assert: (ctx) => {
      const v = ctx.value;
      if (v === 'standard') return sameAs(ctx, ctx.out?.loopType, 'standard');
      if (Object.keys(v).every((k) => v[k] === false)) return sameAs(ctx, ctx.out?.loopType, 'standard');
      if ('loopCondition' in v && ctx.path === 'legacy') {
        // The legacy DOM parser never unescapes a text node — one parser defect, recorded in this
        // row's reason and in `conditionExpression`'s. Asserted, not avoided.
        return sameAs(ctx, ctx.out?.loopType, { ...v, loopCondition: 'x&lt;3' });
      }
      return sameAs(ctx, ctx.out?.loopType, v);
    },
  },

  multiInstance: {
    quote: 'The object form collapses to the string shorthand when it carries nothing else',
    assert: (ctx) => {
      const v = ctx.value;
      if (typeof v === 'string') return sameAs(ctx, ctx.out?.multiInstance, v);
      const bare = Object.keys(v).length === 1 && 'type' in v;
      return sameAs(ctx, ctx.out?.multiInstance, bare ? v.type : v);
    },
  },

  edges: {
    quote: 'written with id, name, sourceRef and targetRef only',
    assert: (ctx) => {
      const authored = ctx.value;
      const back = walkEdges(ctx.lc);
      for (const want of authored) {
        const got = back.find((e) => e.id === want.id);
        sameAs(ctx, got && { id: got.id, source: got.source, target: got.target, label: got.label },
          { id: want.id, source: want.source, target: want.target, label: want.label },
          `child edge ${want.id}: id/source/target/name survive`);
        if (want.condition !== undefined) sameAs(ctx, got?.condition, undefined, `child edge ${want.id}: condition is lost`);
        if (want.isDefault !== undefined) sameAs(ctx, got?.isDefault, undefined, `child edge ${want.id}: isDefault is lost`);
      }
    },
  },

  marker: {
    quote: '`multiple` and `parallelMultiple` have no',
    assert: (ctx) => {
      const unmappable = ctx.value === 'multiple' || ctx.value === 'parallelMultiple';
      sameAs(ctx, ctx.out?.marker, unmappable ? undefined : ctx.value);
    },
  },

  linkName: {
    quote: 'Written only when `marker === "link"`',
    assert: (ctx) => {
      if (ctx.input.marker !== 'link') return sameAs(ctx, ctx.out?.linkName, undefined, 'marker is not link');
      // The second half of the same reason: with no `linkName` authored, `buildEventDefinition`
      // writes the node's `name` into the LinkEventDefinition and it comes back as `linkName` —
      // the field appears where the author wrote none.
      const expected = ctx.value === undefined ? ctx.input.name : ctx.value;
      return sameAs(ctx, ctx.out?.linkName, expected, ctx.value === undefined ? 'unauthored: the node name is read back as linkName' : '');
    },
  },

  conditionExpression: {
    quote: 'it is exact through `moddle-import.js` (the primary path) and NOT through the legacy',
    assert: (ctx) => {
      if (ctx.input.marker !== 'conditional') return sameAs(ctx, ctx.out?.conditionExpression, undefined, 'marker is not conditional');
      const escaped = ctx.path === 'legacy' && ctx.value.includes('<');
      return sameAs(ctx, ctx.out?.conditionExpression, escaped ? ctx.value.replace('<', '&lt;') : ctx.value);
    },
  },

  timerExpression: {
    quote: 'An unrecognised `type` falls through to `timeDuration`',
    assert: (ctx) => {
      if (ctx.input.marker !== 'timer') return sameAs(ctx, ctx.out?.timerExpression, undefined, 'marker is not timer');
      const known = ['duration', 'date', 'cycle'].includes(ctx.value.type);
      return sameAs(ctx, ctx.out?.timerExpression, known ? ctx.value : { type: 'duration', value: ctx.value.value });
    },
  },

  label: {
    quote: 'At depth >= 1 nothing is fabricated',
    assert: (ctx) => {
      sameAs(ctx, ctx.out?.label, ctx.value, 'the label itself survives as `name`');
      // The fabrication the row records: the label is copied into a conditionExpression the author
      // never wrote. `buildProcess` does it for a diverging XOR/OR source only, and the child-edge
      // branch of `buildFlowNode` writes no conditionExpression at all — so at depth 1 nothing is
      // fabricated either, which is the neighbouring `condition` row's mechanism seen from here.
      const fabricates = ctx.depth === 0 && ['exclusiveGateway', 'inclusiveGateway'].includes(ctx.type);
      sameAs(ctx, ctx.out?.condition, fabricates ? ctx.value : undefined,
        fabricates ? 'the label is fabricated into a condition the author never wrote' : 'no fabrication');
    },
  },

  condition: {
    quote: 'Lost at depth >= 1',
    assert: (ctx) => {
      sameAs(ctx, ctx.out?.condition, ctx.depth === 0 ? ctx.value : undefined);
    },
  },

  isDefault: {
    quote: 'An explicitly marked edge does survive — at depth 0 only',
    assert: (ctx) => {
      const fabricator = ['exclusiveGateway', 'inclusiveGateway'].includes(ctx.type) && ctx.depth === 0;
      if (ctx.value === true) {
        sameAs(ctx, ctx.out?.isDefault, ctx.depth === 0 ? true : undefined, 'an explicitly marked edge survives at depth 0');
        return;
      }
      // Nothing authored: the last outgoing edge of a diverging XOR/OR gateway comes back marked.
      sameAs(ctx, ctx.out?.isDefault, undefined, 'the first edge stays unmarked');
      sameAs(ctx, edgeById(ctx.lc, SIBLING_EDGE)?.isDefault, fabricator ? true : undefined,
        'the LAST outgoing edge is fabricated into the default');
    },
  },
};

// There was a PRECONDITION here, and its removal is the point. A `textAnnotation` or `group` inside
// a container used not to come back from `moddle-import.js` at all — the child walk read
// `flowElements`, bpmn-moddle puts an Artifact in `artifacts` — so at depth >= 1 on that path such
// a subject did not EXIST and no per-field claim about it (`color`, `documentation`, `extensions`)
// could be evaluated. Rather than skip those cases, the fence asserted the loss POSITIVELY: the
// subject must be absent. Closing the importer gap turned that assertion red, which is exactly what
// it was written to do — an improvement could not pass in silence either. The `nodes` row now reads
// `roundTrip: 'exact'` and every artifact subject is asserted like any other.

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 6. Case generation
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const ROWS = [
  ...OMG_NODE_FIELD_SCOPE.map((s) => ({ ...s, table: 'node' })),
  ...OMG_EDGE_FIELD_SCOPE.map((s) => ({ ...s, table: 'edge' })),
];

function generateCases() {
  const cases = [];
  for (const row of ROWS) {
    const samples = SAMPLES[row.field] ?? [];
    // `allowed ∩ NodeType enum` — the same universe policy `types.test.js`'s metamodel fence uses,
    // for the same reason: a class the schema cannot express and `bpmnXmlTag` cannot emit is one no
    // caller can be right or wrong about.
    const types = [...row.allowed].filter((t) => UNIVERSE.has(t)).sort();
    for (const sample of samples) {
      for (const type of types) {
        for (const placement of PLACEMENTS) {
          cases.push({
            name: `${row.table} ${row.field} [${sample.label}] on ${type} at ${placement.label}`,
            row, sample, type, placement,
          });
        }
      }
    }
  }
  return cases;
}

const CASES = generateCases();

/** One pipeline run and two importer reads, shared by every assertion about the case. */
async function runCase({ row, sample, type, placement }) {
  const body = row.table === 'node'
    ? buildNodeBody(type, row.field, sample)
    : buildEdgeBody(type, row.field, sample);
  const lc = place(body, placement, sample);
  const result = await runPipeline(lc);
  const authored = row.table === 'node'
    ? walkNodes(lc).find((n) => n.id === SUBJECT)
    : walkEdges(lc).find((e) => e.id === SUBJECT_EDGE);
  return {
    xml: result.bpmnXml,
    input: authored,
    reimported: {
      moddle: await bpmnToLogicCore(result.bpmnXml),
      legacy: bpmnToLogicCoreLegacy(result.bpmnXml),
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 7. The fences over the fence's own inputs
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// A generated suite has one failure mode a hand-written one does not: generating nothing, and
// passing. Every guard-on-the-guard below exists for that.

describe('the fence covers what the table says it covers', () => {
  test('cases were actually generated', () => {
    // A floor, not the exact number: the exact count is reported per stage, and pinning it here
    // would turn every legitimate new row into a failing assertion about arithmetic.
    expect(CASES.length).toBeGreaterThan(300);
  });

  // Every row, including the `'none'` ones: a `'none'` row is exercised in the other direction (the
  // field is authored and must not come back), so it needs a value to author just as much.
  test('every row has at least one sample — a field cannot opt out of the fence by omission', () => {
    const missing = ROWS.filter((r) => !(SAMPLES[r.field]?.length > 0)).map((r) => `${r.table} ${r.field}`);
    expect(missing).toEqual([]);
  });

  test('every SAMPLES key names a real row', () => {
    const known = new Set(ROWS.map((r) => r.field));
    expect(Object.keys(SAMPLES).filter((f) => !known.has(f))).toEqual([]);
  });

  test('every row is exercised by at least one generated case', () => {
    const exercised = new Set(CASES.map((c) => `${c.row.table} ${c.row.field}`));
    const unexercised = ROWS.map((r) => `${r.table} ${r.field}`).filter((k) => !exercised.has(k));
    expect(unexercised).toEqual([]);
  });

  test('every case runs at both depths', () => {
    const depths = new Set(CASES.map((c) => c.placement.label));
    expect([...depths].sort()).toEqual(['depth 0', 'depth 1 (subProcess)', 'depth 1 (transaction)']);
  });

  test('every lossy row has a contract, and every contract names a lossy row', () => {
    const lossy = ROWS.filter((r) => r.roundTrip === 'lossy').map((r) => r.field).sort();
    expect(Object.keys(LOSSY_CONTRACTS).sort()).toEqual(lossy);
  });

  // The anti-drift check. A lossy contract implements a mechanism that is written down in the row's
  // `reason`; the quote is the thread between the two. If the reason is rewritten, this fails, and
  // whoever rewrote it has to read the assertion that quoted it.
  test.each(ROWS.filter((r) => r.roundTrip === 'lossy'))(
    '$table $field: the contract quotes its row\'s reason verbatim', (row) => {
      const { quote } = LOSSY_CONTRACTS[row.field];
      expect([row.field, row.reason.includes(quote)]).toEqual([row.field, true]);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 8. The round trip
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('the spanning round trip — every field, every allowed class, both depths, both importers', () => {
  test.each(CASES)('$name', async (testCase) => {
    const { row, sample, type, placement } = testCase;
    const { xml, input, reimported } = await runCase(testCase);

    // Both paths are always evaluated, and their verdicts are reported together — see
    // `reportBothPaths`. Asserting inline would abort on the first failing path, so a field dropped
    // from BOTH importers in one commit would read as a moddle-only defect, and the author would fix
    // one importer and find the fence still red.
    reportBothPaths(IMPORTER_PATHS.map((path) => [path, () => {
      const lc = reimported[path];
      const out = row.table === 'node' ? nodeById(lc, SUBJECT) : edgeById(lc, SUBJECT_EDGE);
      const ctx = {
        field: row.field, value: sample.value, sample, type, depth: placement.depth,
        path, xml, input, out, lc,
        where: `${row.field}=${sample.label} on ${type} at ${placement.label} via ${path}`,
      };

      // The subject must have survived AS AN ELEMENT before any field claim about it means
      // anything — otherwise a row whose contract is "the field is absent" would pass because the
      // whole node disappeared.
      sameAs(ctx, out?.id, row.table === 'node' ? SUBJECT : SUBJECT_EDGE, 'the subject itself survives');

      if (row.roundTrip === 'exact') {
        // `source`/`target` author nothing: their value is the id the factory wired, so the input
        // is the oracle. Everything else compares against what was authored.
        const expected = sample.value === undefined ? input[row.field] : sample.value;
        sameAs(ctx, out[row.field], expected);
      } else if (row.roundTrip === 'lossy') {
        LOSSY_CONTRACTS[row.field].assert(ctx);
      } else {
        // `'none'`: the field must NOT survive. Implementing it later turns this red and forces the
        // row and its reason to be updated — nothing improves silently either.
        sameAs(ctx, out[row.field], undefined, 'roundTrip "none": the field must not survive');
      }
    }]));
  });
});

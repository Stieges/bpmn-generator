/**
 * BPMN Type Predicates & Tag Mapping
 * Pure functions, no dependencies.
 */

// The five OMG Event subclasses this project's NodeType enum carries (references/input-schema.json).
// Backs isEvent below. Kept explicit rather than a substring test so a future NodeType addition
// that happens to contain the word "Event" without being one (or the reverse) cannot silently
// change classification — see the fence in types.test.js, which checks this set against the enum.
// Exported (not just used locally) so the fence in types.test.js can check the reverse direction
// too: not only "does every enum member land in some class" but "does every class member
// actually exist in the enum". A set kept private could accumulate a stray entry with nothing
// to catch it — see CONTAINER_TYPES's `adHocSubProcess`, below, for exactly that case.
export const EVENT_TYPES = new Set([
  'startEvent', 'endEvent', 'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent',
]);

// The five OMG Gateway subclasses in the NodeType enum. Same rationale as EVENT_TYPES.
export const GATEWAY_TYPES = new Set([
  'exclusiveGateway', 'parallelGateway', 'inclusiveGateway', 'eventBasedGateway', 'complexGateway',
]);

export function isEvent(type) {
  return EVENT_TYPES.has(type);
}

export function isGateway(type) {
  return GATEWAY_TYPES.has(type);
}

export function isBoundaryEvent(node) {
  return node.type === 'boundaryEvent' || !!node.attachedTo;
}

// Backs isArtifact below. Exported for the same reverse-direction reason as EVENT_TYPES/
// GATEWAY_TYPES — see the comment there.
export const ARTIFACT_TYPES = new Set(['dataObjectReference', 'dataStoreReference', 'textAnnotation', 'group']);

/**
 * Layout sense of "artifact": drawable, but kept out of the ELK graph because it
 * is not part of the sequence flow. Wider than the BPMN class of the same name —
 * data references are FlowElements in the spec. Use isBpmnArtifact for anything
 * that has to be right against the XSD.
 */
export function isArtifact(type) {
  return ARTIFACT_TYPES.has(type);
}

/**
 * The BPMN 2.0 Artifact class proper (OMG Semantic.xsd, tArtifact): TextAnnotation,
 * Group, Association. These extend BaseElement, which declares only `id` — `name`
 * is introduced further down by FlowElement and is therefore ILLEGAL on them.
 * They also belong in <bpmn:artifacts>, not <bpmn:flowElements>.
 *
 * Deliberately excludes dataObjectReference/dataStoreReference: those really are
 * FlowElements and really do carry `name`.
 */
export function isBpmnArtifact(type) {
  return ['textAnnotation', 'group'].includes(type);
}

/**
 * The OMG Activity subclasses that carry (or call) a scope of their own.
 *
 * The single source for this list. It is read by `rules.js`'s S14 and by
 * `scripts/scenarios/collaboration.js`'s container guard, which are the two layers that must
 * agree about one model: S14 tells the author a message flow may not name one of these, and the
 * Petri-net composition refuses to wire it. A second copy of the list is exactly how those two
 * drift apart — and they did, in the first cut of this rule, where the composition asked "does
 * the node have children?" while S14 asked "what class is it?". A `callActivity` never carries
 * children, so it warned and was wired at the same time.
 *
 * None of these is an `InteractionNode`, which is what makes them illegal MessageFlow endpoints:
 * `MessageFlow.sourceRef`/`targetRef` are typed `InteractionNode` (BPMN20.cmof:851-852), `Task`
 * (:1191) and `Event` (:287) name it as an explicit second superclass and `Participant` (:863)
 * likewise, but `Activity` is `superClass="FlowNode"` alone (:1095) and `SubProcess` (:1147),
 * `CallActivity` (:1188), `AdHocSubProcess` (:1222) and `Transaction` (:1233) all descend from
 * it. `grep -n InteractionNode BPMN20.cmof` returns exactly `Event`, `ConversationNode`,
 * `Participant` and `Task` — the property is granted per class, never inherited.
 *
 * `adHocSubProcess` is deliberately kept despite NOT being a member of `references/
 * input-schema.json`'s `NodeType` enum — that schema instead expresses ad-hoc as `isAdHoc: true`
 * on a plain `subProcess` node, and neither importer (`import.js`, `moddle-import.js`) ever
 * produces the string `'adHocSubProcess'`, nor does `bpmnXmlTag` map it to anything but the
 * `task` fallback. So this is a real class (`AdHocSubProcess`, BPMN20.cmof:1222) the schema does
 * not yet expose, not a dead list entry: `pipeline.test.js`'s "S14 accepts the legal endpoint
 * classes and rejects every container class" test already builds a hand-written Logic-Core node
 * with this exact type string (bypassing the schema gate, which only runs at the HTTP boundary)
 * and relies on `CONTAINER_TYPES` classifying it correctly. Removing it here would silently
 * change what that test — and any other direct Logic-Core caller using the same string — gets
 * back. Reconciling the schema, the importers and the serializer with this class is a bigger,
 * separate decision; `types.test.js`'s reverse-direction fence allowlists this one entry with
 * this same reasoning rather than either silently passing or wrongly failing on it.
 */
export const CONTAINER_TYPES = new Set(['subProcess', 'transaction', 'adHocSubProcess', 'callActivity']);

/**
 * Is this node a container — by its declared class, or by carrying a scope?
 *
 * Both legs are load-bearing, and neither subsumes the other:
 *   - the CLASS leg catches a `callActivity` (which by its nature never has `nodes`) and a
 *     collapsed `subProcess` written without a `nodes` array. Legality must not depend on how
 *     much of the container the author happened to write down;
 *   - the STRUCTURAL leg catches anything that carries a scope regardless of what it calls
 *     itself, which is what makes an unrecognised future container type fail safe rather than be
 *     silently wired.
 *
 * Deliberately NOT the same question as `workflow-net.js`'s own `isContainer`. That one asks
 * "will this be refined into a subnet?" and is purely structural on purpose — a `callActivity`
 * with no children has no interior to translate and must stay one atomic transition. This one
 * asks "is this a container CLASS?", which is what the InteractionNode argument turns on.
 */
export function isContainerNode(node) {
  return CONTAINER_TYPES.has(node?.type)
    || (Array.isArray(node?.nodes) && node.nodes.length > 0);
}

// The eight OMG Task subclasses in the NodeType enum — `Task` itself plus its seven named
// specializations (UserTask, ServiceTask, ScriptTask, SendTask, ReceiveTask, ManualTask,
// BusinessRuleTask), all `superClass="Task"` in BPMN20.cmof. This is the "leaf activity" half of
// `isActivity` below, and also half of `isInteractionNode` — see its doc comment for why the two
// need different unions of the same eight types.
// Exported, because "a leaf activity, not a container" is a question two callers outside this
// module genuinely ask and used to answer with their own private copy of this list
// (`optimize.js`, `redesign.js`). It is deliberately NOT the same question as `isActivity`:
// those callers restrict themselves to leaf work steps for reasons of their own, written down at
// each call site, whereas a rule quoting the OMG `Activity` type — S13's `attachedToRef`, for
// instance — must use `isActivity` and include the containers. Keeping both available and named
// for what they mean is what stops the next caller from picking a list by copying whichever one
// happened to be nearest.
export const TASK_TYPES = new Set([
  'task', 'userTask', 'serviceTask', 'scriptTask', 'sendTask', 'receiveTask',
  'manualTask', 'businessRuleTask',
]);

/**
 * The OMG `Activity` subclasses in the NodeType enum: every task type plus every container type.
 * `CallActivity` (BPMN20.cmof:1188), `SubProcess` (:1147, and its `Transaction`/`AdHocSubProcess`
 * specializations) and every `Task` subclass all descend from `Activity` — nothing else in the
 * enum does.
 *
 * Derived from CONTAINER_TYPES rather than restated, so the two lists cannot drift — the failure
 * this stage exists to close. This is what S13 (`BoundaryEvent.attachedToRef : Activity [1..1]`),
 * `redesign.js:703`'s "boundary events attach only to activities" refusal, and
 * `optimize.js:42`'s task-type check all actually need: a boundary event legally attaches to a
 * subprocess, not only to a task, and the refusal at redesign.js:703 was wrong for exactly that
 * reason — the previous `TASK_TYPES` (there, private) omitted the container classes.
 */
export const ACTIVITY_TYPES = new Set([...TASK_TYPES, ...CONTAINER_TYPES]);

export function isActivity(type) {
  return ACTIVITY_TYPES.has(type);
}

/**
 * The node types that may carry OMG's `implementation` attribute.
 *
 * Narrower than `ACTIVITY_TYPES` and deliberately not derived from it: BPMN20.cmof grants
 * `implementation` per class to `UserTask` (:1263), `ServiceTask` (:1240), `SendTask` (:1229),
 * `ReceiveTask` (:1214) and `BusinessRuleTask` (:1177) — the task types that invoke something —
 * and to nothing else. A plain `Task`, a `scriptTask`, a `manualTask` and every container are all
 * Activities that may NOT carry it. Anyone tempted to "simplify" this to `isActivity` should
 * re-read that sentence; the set was verified against the installed bpmn-moddle by feeding the
 * attribute to every node type and recording which ones round-tripped without an
 * `unknown attribute <implementation>` warning.
 */
export const IMPLEMENTATION_TYPES = new Set([
  'userTask', 'serviceTask', 'sendTask', 'receiveTask', 'businessRuleTask',
]);

/**
 * Every OMG `FlowNode` subclass in the NodeType enum: activities, events and gateways — everything
 * except the four artifact/data-reference types.
 *
 * Named for the OMG class because that is what the two questions it answers turn on:
 *   - `Lane#flowNodeRef` is typed `FlowNode`, so lane membership is expressible for exactly these
 *     (`bpmn-xml.js`'s `buildLane` already filters on this, by hand, one type at a time);
 *   - `SequenceFlow#sourceRef`/`targetRef` are typed `FlowNode` too, which is what the `source`
 *     and `target` rows of `OMG_EDGE_FIELD_SCOPE` below need.
 * Derived from the three classification sets rather than restated, for the same anti-drift reason
 * `ACTIVITY_TYPES` is derived from `CONTAINER_TYPES`.
 */
export const FLOW_NODE_TYPES = new Set([...ACTIVITY_TYPES, ...EVENT_TYPES, ...GATEWAY_TYPES]);

/**
 * Every NodeType, flow node or artifact. The `allowed` set for the handful of fields OMG puts on
 * `BaseElement`/`FlowElement` and therefore grants to everything we can emit — `documentation` is
 * the one real case, `color` (a BPMNDI concern) the other.
 */
export const ALL_NODE_TYPES = new Set([...FLOW_NODE_TYPES, ...ARTIFACT_TYPES]);

/**
 * The classes OMG grants `name` to. Everything except the two real Artifacts: `TextAnnotation` and
 * `Group` extend `BaseElement`, which declares only `id` — see `isBpmnArtifact`. Their labels do
 * survive, by a different mechanism; the `name` row below says which.
 */
export const NAMED_NODE_TYPES = new Set([
  ...FLOW_NODE_TYPES, 'dataObjectReference', 'dataStoreReference',
]);

/**
 * The classes OMG grants the `default` attribute to: every `Activity`, plus the three gateways
 * whose outgoing flows may carry conditions (`ExclusiveGateway`, `InclusiveGateway`,
 * `ComplexGateway`). Notably NOT `ParallelGateway` or `EventBasedGateway`, neither of which
 * branches on a condition.
 *
 * Wider than the `exclusiveGateway || inclusiveGateway` test `bpmn-xml.js`'s `buildDefaultFlowMap`
 * applies today — an activity with two conditional outgoing flows may name a default flow, and
 * `edge.isDefault` on such an activity is legal input the serialiser currently only half honours
 * (`buildDefaultFlowMap` records it from any source, `buildProcess` then writes `gwEl.default`
 * regardless of class, so this set is the honest statement of where that is legal).
 */
export const DEFAULT_FLOW_SOURCE_TYPES = new Set([
  ...ACTIVITY_TYPES, 'exclusiveGateway', 'inclusiveGateway', 'complexGateway',
]);

/**
 * Which node classes may carry each OMG-scoped per-node field — the single source of truth for a
 * question that had been answered separately in two places, and answered wrong in one of them.
 *
 * `references/input-schema.json` declares every one of these as a generic property of `Node`,
 * valid on any `NodeType`, because JSON Schema's `properties` has no notion of "only when `type`
 * is one of …" without a conditional block per field. That is why they reach the serialiser at
 * all. OMG scopes each one far more narrowly, so the narrowing has to happen after the schema —
 * and it has to happen in exactly one place, or the two copies drift. They did: `bpmn-xml.js`'s
 * `buildFlowNode` guarded four of these inline and left `isForCompensation` and `implementation`
 * unguarded, emitting `<bpmn:parallelGateway isForCompensation="true">` and
 * `<bpmn:startEvent implementation="…">` — attributes outside those classes' content models, i.e.
 * XSD-invalid output produced from schema-valid input.
 *
 * Two consumers, one table, which is the point:
 *   - `bpmn-xml.js` `buildFlowNode` — drops a field the node's class may not carry, so the
 *     emitted XML is valid.
 *   - `rules.js` S15 — reports it, so the drop is not silent.
 * A rule that disagreed with the serialiser about which fields are legal where would be worse
 * than no rule at all; sharing the table makes disagreeing impossible.
 *
 * `field` is the Logic-Core name, `attr` the OMG attribute it serialises to (they differ for the
 * boolean pair), `allowed` the node types that may carry it, `scope` prose for the message,
 * `type` the JavaScript typeof the field's value must have, and `on` which ELEMENT the attribute
 * is written to.
 *
 * `on` is `'self'` for five of the six — the attribute lands on the node's own element. It is
 * `'dataObject'` for `isCollection`, and that is not a refinement but a correction of a live
 * defect: OMG puts `isCollection` on **DataObject**, not on DataObjectReference (bpmn-moddle's
 * metamodel grants DataObjectReference only `dataObjectRef`), so writing it on the reference
 * produced `<bpmn:dataObjectReference isCollection="true">` and `unknown attribute <isCollection>`
 * on every round trip. Note that `allowed` still says `dataObjectReference`, and correctly: in
 * Logic-Core the reference and its object are ONE node, so `isCollection` is authored on the
 * reference — only the emission target differs. The distinction is exactly what `on` records.
 *
 * `type` is carried here rather than inferred from the value at serialisation time, and that is
 * the second defect this table was extended to fix. A `typeof value === 'boolean' ? true : value`
 * in the serialiser passes any truthy non-boolean straight through, so
 * `{ type: 'task', isCompensation: 'yes' }` emitted `isForCompensation="yes"` — not a boolean, not
 * valid against the XSD, and silent, because bpmn-moddle reports attributes it does not KNOW, not
 * values of the wrong shape. The serialiser was guessing the intended type from the data it was
 * handed; the table already knows which class each field belongs on, so knowing its type belongs
 * here too, where it is declared once instead of inferred per call.
 *
 * Each `allowed` set reproduces the guard that was already in `buildFlowNode`, except
 * `isCompensation` and `implementation` — so no field's serialisation behaviour changes as a side
 * effect of centralising them. `isEventSubProcess` has since been widened to `transaction` as
 * well; see its own comment below for why that was a correction and not a change of policy.
 *
 * Every `allowed` set is fenced in BOTH directions against `bpmn-moddle`'s own metamodel by
 * `types.test.js`'s "the OMG-metamodel fence" — too wide AND too narrow. Do not narrow one by hand
 * to silence a finding: the fence reads which classes actually declare or inherit the attribute and
 * will name the entry you touched.
 *
 * ── The table's other five columns, and what a row therefore CLAIMS ─────────────────────────────
 *
 * The six columns above answer "which class, what type, which element". They were enough while the
 * table covered six fields that all serialise the same way — as a plain attribute written straight
 * from the field's value. It now covers every `$defs.Node` property except `id` and `type`, and
 * those fields reach the XML through six different mechanisms. Five more columns say which, and
 * say it in a form the fences can check:
 *
 *   `shape`      — HOW the field serialises. One of:
 *                    'attr'            an XML attribute on some element;
 *                    'childElement'    a child element of the node's own element;
 *                    'eventDefinition' a property of the `<bpmn:*EventDefinition>` under an Event;
 *                    'extension'       our own `extensionElements` namespace (no OMG counterpart);
 *                    'di'              a BPMNDI concern — `<bpmndi:BPMNShape>`, not the semantics;
 *                    'layoutOnly'      consumed by layout, never serialised;
 *                    'unserialised'    nothing writes it at all (today).
 *                  `shape` NAMES the mechanism; it does not describe it. See "how far a row's
 *                  claim extends", below.
 *
 *   `writeSite`  — WHICH function writes it. `'fieldLoop'` means `bpmn-xml.js`'s generic loop over
 *                  this table (`buildFlowNode` for `on: 'self'`, `buildDataObject` for
 *                  `on: 'dataObject'`); anything else names the dedicated function, and `'none'`
 *                  means nothing writes it. This is the column that makes the loop's membership
 *                  explicit instead of inferred: a field whose emission condition is not "write the
 *                  value when it is truthy" cannot join the loop without changing behaviour, and
 *                  `cancelActivity` is exactly that field (only `false` is written; `true` is the
 *                  XSD default and stays implicit). Its guard still comes from this table — see
 *                  `enforcedBy` — but its write stays where it is.
 *
 *   `enforcedBy` — WHO reads `allowed`, and therefore whether an out-of-scope value is dropped and
 *                  reported. One of:
 *                    'table'      the write site consults `spec.allowed` from this row, and the
 *                                 scope it enforces is OMG's. These rows, and only these, are what
 *                                 rule S15 walks: S15's message says the field "is dropped when the
 *                                 BPMN is written" and names an OMG class, and both halves of that
 *                                 sentence are true only here.
 *                    'convention' the write site consults `spec.allowed` exactly as above, but the
 *                                 scope comes from this project's own published contract rather
 *                                 than from OMG — `decisionRef` is the only case, and rule M11
 *                                 reports it, in the layer that owns our conventions. Separated
 *                                 from `'table'` so that one field on one node produces one
 *                                 message and not two.
 *                    'writeSite'  the class restriction is hard-coded at the write site (an
 *                                 `isGateway` test, a `node.type === 'scriptTask'` branch, a
 *                                 special case in `buildNodeAttrs`). The row states the scope for
 *                                 the reader and for the fences; nothing consults it. Not a defect
 *                                 by itself — but every such row is a place a future edit can make
 *                                 the table and the code disagree, which is why they are named.
 *                    'moddle'     the guard is bpmn-moddle's own descriptor (`marker` is only
 *                                 pushed onto an element whose descriptor declares
 *                                 `eventDefinitions`).
 *                    'none'       nothing restricts it. Each such row says in its comment what that
 *                                 costs; `nodes` is the one that costs a crash.
 *
 *   `roundTrip`  — the CONTRACT: what survives Logic-Core → XML → Logic-Core, through both
 *                  importers — `import.js` AND `moddle-import.js`, which is stricter than it
 *                  sounds and caught two rows that were true of one path only. One of `'exact'`
 *                  (deep-equal), `'lossy'` (something specific is known to be lost — the `reason`
 *                  says exactly what), `'none'` (the field does not survive at all).
 *                  **This column is the exclusion list for the spanning fence in
 *                  `field-fidelity.test.js`. There is no second list.** A row that cannot be
 *                  round-tripped is skipped by the fence only because THIS column says so, and
 *                  only with a `reason` a stranger can act on.
 *
 *   `reason`     — mandatory on every row below `'exact'`, and on every `enforcedBy: 'none'` row.
 *                  Written for someone who was not here: what is lost, why, and (where one exists)
 *                  which planned stage closes it.
 *
 * ── Three conventions that make the columns testable ───────────────────────────────────────────
 *
 * 1. **`roundTrip` is the contract for the types in `allowed`, not for every NodeType.** Outside
 *    `allowed` a field is out of scope by definition, and "does an out-of-scope field survive?" is
 *    not a fidelity question but a scoping one, already answered by `allowed` and reported by S15.
 *    This is what keeps rows like `lane` honest: an artifact's `lane` genuinely does not survive
 *    (`Lane#flowNodeRef` is typed `FlowNode`, so an artifact can never be listed there), and the
 *    row says so by leaving the artifact types out of `allowed` rather than by degrading the
 *    contract for the 21 types where it holds exactly.
 *
 * 2. **How far a row's claim extends for a structural mapping.** `marker` selects which
 *    `<bpmn:*EventDefinition>` child is built; `timerExpression` becomes one of `timeDate`,
 *    `timeDuration` or `timeCycle`; `loopType` becomes a `<bpmn:standardLoopCharacteristics>`. A
 *    table can name such a mechanism but must not re-implement it, so a row asserts exactly two
 *    things and no more: (a) which node classes may carry the field — checked against the
 *    metamodel through `attr`, which for these rows names the BPMN *property the mechanism attaches
 *    to* (`eventDefinitions`, `loopCharacteristics`) precisely because that is the thing the
 *    metamodel can scope; and (b) the `roundTrip` contract, which an end-to-end round trip tests
 *    without the table having to describe the transformation at all. `attr` may be an ARRAY when a
 *    mechanism targets one of several properties (`timerExpression`); the fence then requires the
 *    `on` class to carry every one of them. Nothing here interprets a mapping — the write sites do.
 *
 * 3. **What governs `allowed` for a non-`attr` shape.** The same oracle wherever it can reach:
 *    `types.test.js`'s metamodel fence checks `allowed` against bpmn-moddle for EVERY row whose
 *    `on` is `'self'` and whose `attr` resolves to a real metamodel property — regardless of
 *    `shape`. That covers `marker`, `loopType`, `multiInstance`, `script`, `documentation` and
 *    `has_join` as strictly as it covers the plain attributes. `allowed` is hand-stated only where
 *    the mechanism has no BPMN-semantic counterpart to check against — `decisionRef` (our own
 *    extension namespace), `color`/`isExpanded` (BPMNDI, checked against `bpmndi.json` on the `on`
 *    side instead), `lane` (`flowNodeRef` is typed `FlowNode`, a constraint the JSON metamodel
 *    expresses as a type name and not as a per-class property), and the rows nothing implements
 *    yet. Those hand-stated sets are not unfenced: they are fenced BEHAVIOURALLY, by the round trip
 *    `field-fidelity.test.js` runs per row — a class that cannot really carry the field fails to
 *    round-trip it, and the row's `roundTrip` contract is what fails.
 *
 * ── Order ──────────────────────────────────────────────────────────────────────────────────────
 *
 * One flat array, grouped by `shape` under banner comments, `$defs.Node` declaration order within a
 * group. Flat because both consumers iterate it and `moddle-import.js` does a `.find()` on it —
 * splitting it would buy nothing and cost three call sites. Grouped by `shape` because the rows in
 * a group share a write site, so a reviewer can check a whole group against one function, which is
 * the review this table exists to make possible.
 */
export const OMG_NODE_FIELD_SCOPE = [
  // ── shape: 'attr', written by the generic loop in buildFlowNode ────────────────────────────────
  // The loop's contract: write `attrs[attr] = value` when the value is truthy, the node's class is
  // in `allowed`, and `typeof value === type`. A field that needs anything else does not belong
  // here — see `cancelActivity` below.
  { field: 'isCompensation', attr: 'isForCompensation', type: 'boolean', on: 'self', allowed: ACTIVITY_TYPES, scope: 'an Activity',
    shape: 'attr', writeSite: 'fieldLoop', enforcedBy: 'table', roundTrip: 'exact' },
  { field: 'implementation', attr: 'implementation', type: 'string', on: 'self', allowed: IMPLEMENTATION_TYPES, scope: 'a userTask, serviceTask, sendTask, receiveTask or businessRuleTask',
    shape: 'attr', writeSite: 'fieldLoop', enforcedBy: 'table', roundTrip: 'lossy',
    reason: 'OMG\'s two default values are deliberately not read back: both importers drop '
      + '`##WebService` and `##unspecified` rather than materialise a field the author never wrote '
      + '(import.js:367, moddle-import.js:275). Writing either of those two literals therefore '
      + 'loses the field on re-import. Every other value round-trips exactly.' },
  // `triggeredByEvent` is declared on `SubProcess` and INHERITED by `Transaction` (BPMN20.cmof:1233,
  // `superClass="SubProcess"`) and `AdHocSubProcess` (:1222, likewise) — verified against the
  // installed bpmn-moddle metamodel, which is what `types.test.js`'s reverse-direction fence now
  // reads. The set said `subProcess` alone, so a `transaction` carrying the field was silently
  // dropped by `buildFlowNode` while S15 told the author "OMG defines triggeredByEvent only on a
  // subProcess" — a claim that is simply untrue.
  //
  // `adHocSubProcess` is deliberately NOT granted it, and this is the one place the fence's
  // enum-scoped policy has teeth: that class is outside `references/input-schema.json`'s `NodeType`
  // enum (see CONTAINER_TYPES's comment), and `bpmnXmlTag` consequently falls back to `'task'` for
  // it. Granting the field would therefore emit `<bpmn:task triggeredByEvent="true">` — and
  // `triggeredByEvent` is NOT a Task attribute, so that is XSD-invalid output. Reconciling the
  // schema, the importers and `bpmnXmlTag` with this class is the separate decision CONTAINER_TYPES
  // already defers; until it is taken, the narrow set is the correct one and the fence says nothing
  // about types the schema does not expose.
  { field: 'isEventSubProcess', attr: 'triggeredByEvent', type: 'boolean', on: 'self', allowed: new Set(['subProcess', 'transaction']), scope: 'a subProcess or a transaction',
    shape: 'attr', writeSite: 'fieldLoop', enforcedBy: 'table', roundTrip: 'exact' },
  { field: 'calledElement', attr: 'calledElement', type: 'string', on: 'self', allowed: new Set(['callActivity']), scope: 'a callActivity',
    shape: 'attr', writeSite: 'fieldLoop', enforcedBy: 'table', roundTrip: 'exact' },
  { field: 'scriptFormat', attr: 'scriptFormat', type: 'string', on: 'self', allowed: new Set(['scriptTask']), scope: 'a scriptTask',
    shape: 'attr', writeSite: 'fieldLoop', enforcedBy: 'table', roundTrip: 'exact' },
  { field: 'eventGatewayType', attr: 'eventGatewayType', type: 'string', on: 'self', allowed: new Set(['eventBasedGateway']), scope: 'an eventBasedGateway',
    shape: 'attr', writeSite: 'fieldLoop', enforcedBy: 'table', roundTrip: 'lossy',
    reason: '`Exclusive` is OMG\'s default for eventGatewayType and both importers drop it on the '
      + 'way back in (import.js:378, moddle-import.js:287), so an explicitly written '
      + '`eventGatewayType: "Exclusive"` does not survive as a literal field. The semantics do — an '
      + 'absent attribute means Exclusive. `Parallel` round-trips exactly.' },
  // `instantiate` is granted by bpmn-moddle to `ReceiveTask` as well as `EventBasedGateway`, and
  // OMG agrees: an instantiating Receive Task is how a process starts on an incoming message
  // without a message start event (BPMN 2.0.2 §10.2.4). The write site and BOTH importers used to
  // say `eventBasedGateway` alone, so `{ type: 'receiveTask', instantiate: true }` was dropped in
  // silence on the way out and could never be read back in — a schema-valid, OMG-legal model this
  // pipeline could not express. Widening the metamodel fence to every `shape: 'attr'` row is what
  // made that visible; it failed on this row first, before any of the widening below was written.
  { field: 'instantiate', attr: 'instantiate', type: 'boolean', on: 'self', allowed: new Set(['eventBasedGateway', 'receiveTask']), scope: 'an eventBasedGateway or a receiveTask',
    shape: 'attr', writeSite: 'fieldLoop', enforcedBy: 'table', roundTrip: 'exact' },

  // ── shape: 'attr', written at their own site ───────────────────────────────────────────────────
  // Each of these is a plain attribute whose emission needs something the generic loop does not do.
  // The class knowledge still lives here; only the write does not.
  //
  // `name` is the one row whose `allowed` excludes classes for which the FIELD nonetheless survives.
  // `TextAnnotation` and `Group` extend BaseElement, which declares only `id`, so neither OMG class
  // carries `name` and the set is correct as written. Their labels travel by other mechanisms —
  // `buildNodeAttrs` writes a textAnnotation's into `<bpmn:text>` and `buildCategoryForGroup` puts
  // a group's into a CategoryValue the Group references — and both importers read both back. So the
  // right reading of this row is "the OMG `name` attribute is legal on these 23 classes", not "the
  // Logic-Core field `name` is lost on the other two". `enforcedBy: 'writeSite'` is what keeps S15
  // from making the second, wrong claim.
  { field: 'name', attr: 'name', type: 'string', on: 'self', allowed: NAMED_NODE_TYPES, scope: 'any node except a textAnnotation or a group',
    shape: 'attr', writeSite: 'buildNodeAttrs', enforcedBy: 'writeSite', roundTrip: 'exact' },
  { field: 'attachedTo', attr: 'attachedToRef', type: 'string', on: 'self', allowed: new Set(['boundaryEvent']), scope: 'a boundaryEvent',
    shape: 'attr', writeSite: 'buildFlowNode', enforcedBy: 'writeSite', roundTrip: 'exact',
    // Written in a second pass (`bpmn-xml.js`'s attachedToRef resolution loop), because the target
    // must exist as a moddle element before it can be referenced — which is why it cannot join the
    // generic loop even though it is an ordinary IDREF attribute.
  },
  // Only `false` is ever written: `cancelActivity` defaults to true in the XSD, so an interrupting
  // boundary event is spelled by the attribute's ABSENCE. That is why this row cannot join the
  // generic loop — the loop skips falsy values, which is right for every other attribute and
  // exactly wrong for this one. The class guard is this row's `allowed`; only the emission
  // condition stays at the write site.
  { field: 'cancelActivity', attr: 'cancelActivity', type: 'boolean', on: 'self', allowed: new Set(['boundaryEvent']), scope: 'a boundaryEvent',
    shape: 'attr', writeSite: 'buildFlowNode', enforcedBy: 'table', roundTrip: 'lossy',
    reason: 'Only `cancelActivity: false` is serialised — `true` is the XSD default and is left '
      + 'implicit, so a literal `cancelActivity: true` comes back absent. The semantics survive '
      + '(no attribute means interrupting); the literal field does not.' },
  // The boolean becomes `gatewayDirection`, and only `Converging` maps back — `Diverging` is
  // recomputed from the graph by `inferGatewayDirections`, and the value actually written comes
  // from that inference (`node._direction`), not from `has_join` itself. Meaning survives; the
  // literal field does not.
  { field: 'has_join', attr: 'gatewayDirection', type: 'boolean', on: 'self', allowed: GATEWAY_TYPES, scope: 'a Gateway',
    shape: 'attr', writeSite: 'buildFlowNode', enforcedBy: 'writeSite', roundTrip: 'lossy',
    reason: 'gatewayDirection is recomputed by inferGatewayDirections from the graph, so the '
      + 'attribute written is `node._direction` and not this field. Only `Converging` maps back to '
      + '`has_join: true`; a gateway the author marked `has_join: false`, or one the inference '
      + 'calls Diverging or Mixed, comes back without the field.' },

  // ── shape: 'attr' / 'di', written onto an element that is not the node's own ───────────────────
  // `on` records the indirection. For these rows the metamodel fence checks the OMG side of the
  // indirection — that the class named by `on` really carries `attr` — because `allowed` names the
  // Logic-Core AUTHORING node, which has no metamodel counterpart to be checked against.
  { field: 'isCollection', attr: 'isCollection', type: 'boolean', on: 'dataObject', allowed: new Set(['dataObjectReference']), scope: 'a dataObjectReference',
    shape: 'attr', writeSite: 'fieldLoop', enforcedBy: 'table', roundTrip: 'exact' },
  // A BPMNDI concern, not a semantic one: whether a container is drawn open is `BPMNShape#isExpanded`
  // (bpmndi.json), and the file's semantics are identical either way — which is why `buildFlowNode`
  // deliberately does NOT gate a subprocess's children on it.
  { field: 'isExpanded', attr: 'isExpanded', type: 'boolean', on: 'bpmnShape', allowed: new Set(['subProcess', 'transaction']), scope: 'a subProcess or a transaction',
    shape: 'di', writeSite: 'buildDiagram', enforcedBy: 'writeSite', roundTrip: 'lossy',
    reason: 'Written only when the node ALSO carries children (`node.isExpanded && node.nodes` in '
      + 'bpmn-xml.js\'s DI loop), so `isExpanded: true` on a childless or collapsed-with-no-`nodes` '
      + 'container is dropped. "Collapsed but drillable" is expressible; "expanded but empty" is '
      + 'not. Additionally lost at depth >= 1 even WITH children: that DI loop walks the process\'s '
      + 'own node list, so a nested container\'s `<bpmndi:BPMNShape>` carries no `isExpanded` at '
      + 'all — the same top-level-only DI walk the `color` row records from the read side. Found by '
      + '`field-fidelity.test.js`.' },
  // BPMN-in-Color: two attributes in the `bioc:` namespace on the BPMNShape. A de-facto convention
  // (bpmn.io / Camunda), not part of OMG's metamodel at all, which is why the fence checks the `on`
  // class against bpmndi.json but exempts the `bioc:`-prefixed attribute names themselves.
  // `roundTrip: 'exact'` is true as of this stage and was NOT true before it: `moddle-import.js`
  // read the colours out of `$attrs`, which is the bag for attributes bpmn-moddle does not
  // recognise — and it recognises these, because it ships the bpmn.io colour package as a
  // registered extension. So the primary importer returned the node with no `color` at all while
  // `import.js`'s DOM parser recovered it. See that read's own comment.
  { field: 'color', attr: ['bioc:stroke', 'bioc:fill'], type: 'object', on: 'bpmnShape', allowed: ALL_NODE_TYPES, scope: 'any node',
    shape: 'di', writeSite: 'buildDiagram', enforcedBy: 'none', roundTrip: 'lossy',
    reason: 'Exact at depth 0, on every one of the 25 classes. LOST AT DEPTH >= 1, on BOTH importer '
      + 'paths, and the loss is on the READ side only: the DI loop writes `bioc:stroke`/`bioc:fill` '
      + 'onto a nested node\'s `<bpmndi:BPMNShape>` exactly as it does for a top-level one, and '
      + 'neither importer looks a DI shape up for a node below the top level, so a coloured node '
      + 'inside a subProcess or transaction comes back with no `color` at all. Measured by '
      + '`field-fidelity.test.js` at both wrapper classes; found by it and reported rather than '
      + 'fixed — no backlog stage covers the DI read yet, so it is stated debt awaiting one. '
      + 'enforcedBy none: every drawable node gets a '
      + 'BPMNShape, so there is no class to restrict — `allowed` is the whole enum and nothing needs '
      + 'to consult it.' },

  // ── shape: 'childElement' ──────────────────────────────────────────────────────────────────────
  { field: 'documentation', attr: 'documentation', type: 'string', on: 'self', allowed: ALL_NODE_TYPES, scope: 'any node',
    shape: 'childElement', writeSite: 'buildFlowNode', enforcedBy: 'writeSite', roundTrip: 'exact' },
  { field: 'lane', attr: 'flowNodeRef', type: 'string', on: 'lane', allowed: FLOW_NODE_TYPES, scope: 'a FlowNode (not an artifact or a data reference)',
    shape: 'childElement', writeSite: 'buildLane', enforcedBy: 'writeSite', roundTrip: 'lossy',
    reason: 'Exact at depth 0, on all 21 FlowNode classes. NOT WRITTEN AT ALL at depth >= 1: '
      + '`buildLane` filters the process\'s OWN node list, so a `lane` on a node inside a subProcess '
      + 'or transaction never reaches a `<bpmn:flowNodeRef>` and comes back absent on both importer '
      + 'paths — the lane element is emitted empty. Unlike the neighbouring depth losses this one '
      + 'is not simply a gap to close: a LaneSet belongs to a Process OR to a SubProcess, so a '
      + 'nested node\'s lane would have to become the container\'s own laneSet rather than a '
      + 'reference from the outer one, and the pipeline has no notion of a per-container laneSet '
      + 'today. Found by `field-fidelity.test.js`; the modelling question is stated here, not '
      + 'decided.',
    // `allowed` is hand-stated because `Lane#flowNodeRef` expresses its restriction as a TYPE
    // (`FlowNode`) rather than as a per-class property, which is the one shape the metamodel fence's
    // `carries()` resolver cannot read. An artifact or data reference carrying `lane` is therefore
    // outside `allowed` on purpose: it is legal Logic-Core, it is drawn in that lane (coordMap
    // answers that), and it is correctly absent from `<bpmn:flowNodeRef>` — see `buildLane`.
  },
  { field: 'script', attr: 'script', type: 'string', on: 'self', allowed: new Set(['scriptTask']), scope: 'a scriptTask',
    shape: 'childElement', writeSite: 'buildFlowNode', enforcedBy: 'table', roundTrip: 'exact' },
  // `loopType` and `multiInstance` both become the ONE `loopCharacteristics` property, which is why
  // they share an `attr` and why `buildFlowNode` writes them with an `else if`. Both were unguarded
  // until this stage: a `loopType` on a `startEvent` produced no element and no moddle warning,
  // because moddle drops a property it has no descriptor for in silence.
  { field: 'loopType', attr: 'loopCharacteristics', type: 'mixed', on: 'self', allowed: ACTIVITY_TYPES, scope: 'an Activity',
    shape: 'childElement', writeSite: 'buildFlowNode', enforcedBy: 'table', roundTrip: 'lossy',
    reason: 'Two distinct losses, both measured on both importer paths. (1) An object whose only '
      + 'sub-properties are false collapses to the string shorthand: `{ testBefore: false }` comes '
      + 'back as `"standard"`, because `testBefore` is written only when true and the importers '
      + 'then find an attribute-less `<bpmn:standardLoopCharacteristics>`, which is exactly what '
      + 'the shorthand means. Equivalent input, not a deep-equal value. `{ testBefore: true }`, '
      + '`loopMaximum`, `loopCondition` and the `"standard"` shorthand itself are all exact. '
      + '(2) `loopCondition` loses XML entity unescaping on the LEGACY `import.js` path only: '
      + '`x<3` comes back as `x&lt;3`. `moddle-import.js`, the primary path, is exact. That is a '
      + 'defect in the legacy DOM parser\'s text handling (it never unescapes a text node), not in '
      + 'this field — see `conditionExpression`\'s reason for the same asymmetry and the list of '
      + 'other fields it touches. A node carrying BOTH loopType and multiInstance keeps only '
      + 'loopType — OMG has one loopCharacteristics slot, not two.' },
  { field: 'multiInstance', attr: 'loopCharacteristics', type: 'mixed', on: 'self', allowed: ACTIVITY_TYPES, scope: 'an Activity',
    shape: 'childElement', writeSite: 'buildFlowNode', enforcedBy: 'table', roundTrip: 'lossy',
    reason: 'The object form collapses to the string shorthand when it carries nothing else: '
      + '`{ type: "parallel" }` comes back as `"parallel"`, because the importers only build an '
      + 'object when a loopCardinality or completionCondition is present. Both are equivalent '
      + 'input, so no meaning is lost — but the value is not deep-equal. Dropped entirely when the '
      + 'same node also carries `loopType` (one loopCharacteristics slot).' },
  { field: 'nodes', attr: 'flowElements', type: 'array', on: 'self', allowed: new Set(['subProcess', 'transaction']), scope: 'a subProcess or a transaction',
    shape: 'childElement', writeSite: 'buildFlowNode', enforcedBy: 'none', roundTrip: 'lossy',
    reason: 'A flow-node child round-trips exactly, at any depth. AN ARTIFACT CHILD DOES NOT, on '
      + 'the PRIMARY path only: a `textAnnotation` or `group` inside a container is written (it '
      + 'appears as a child element of the `<bpmn:subProcess>`) and `moddle-import.js`\'s child walk '
      + 'never reads it back, because bpmn-moddle places an Artifact in `artifacts` and that walk '
      + 'reads `flowElements`. This is the same defect that was closed at top level and left open '
      + 'one level down — see the round-trip limitation in CLAUDE.md, which records the top-level '
      + 'half. `import.js`, the legacy DOM path, recovers both classes. A data reference '
      + '(`dataObjectReference`/`dataStoreReference`) is unaffected: those are FlowElements and '
      + 'really do live in `flowElements`. Found by `field-fidelity.test.js`; reported, not fixed — '
      + 'the nested-artifact read has no backlog stage yet, so it is stated debt awaiting one. '
      + 'enforcedBy none, and it costs a crash: `buildFlowNode` recurses on `node.nodes` for '
      + 'ANY node type, and the recursion itself throws — the child element is built and then '
      + 'pushed into `el.get("flowElements")`, which is `undefined` on a class that is not a '
      + 'FlowElementsContainer. Measured: a schema-valid `{ type: "userTask", nodes: [...] }` '
      + 'raises `TypeError: Cannot read properties of undefined (reading \'push\')` inside '
      + '`buildFlowNode`\'s child loop, past a green rule engine and before the layout is reached. '
      + 'Gating the recursion on this row and reporting the dropped children is '
      + 'a decided, queued change (plan "Root fix", Stage 3); it is not made here because it is a '
      + 'behaviour change that needs its own red-first test.' },
  { field: 'edges', attr: 'flowElements', type: 'array', on: 'self', allowed: new Set(['subProcess', 'transaction']), scope: 'a subProcess or a transaction',
    shape: 'childElement', writeSite: 'buildFlowNode', enforcedBy: 'none', roundTrip: 'lossy',
    reason: 'A nested sequence flow is written with id, name, sourceRef and targetRef only — the '
      + 'child-edge branch of `buildFlowNode` has no conditionExpression and no per-container '
      + '`default`, so `condition` and `isDefault` are lost at depth >= 1 while surviving at depth '
      + '0. Decided and queued (plan "Root fix", Stage 6). enforcedBy none: same ungated recursion '
      + 'as `nodes`.' },

  // ── shape: 'eventDefinition' ───────────────────────────────────────────────────────────────────
  // These four are properties of the `<bpmn:*EventDefinition>` an Event carries, not of the Event.
  // `marker` selects WHICH definition class is built; the other three fill in a property of it, and
  // each is therefore written only when `marker` has the matching value. That conditionality is
  // what their `roundTrip: 'lossy'` reasons record — none of them is lost for the marker it belongs
  // to, and all of them are lost for every other marker.
  { field: 'marker', attr: 'eventDefinitions', type: 'string', on: 'self', allowed: EVENT_TYPES, scope: 'an Event',
    shape: 'eventDefinition', writeSite: 'buildEventDefinition', enforcedBy: 'moddle', roundTrip: 'lossy',
    reason: '`references/input-schema.json`\'s EventMarker enum has 12 members; '
      + '`buildEventDefinition`\'s typeMap covers 10. `multiple` and `parallelMultiple` have no '
      + 'single `<bpmn:*EventDefinition>` class — OMG expresses them as two or more '
      + 'eventDefinitions on one event — so both are dropped without an element and without a '
      + 'warning. Every other marker round-trips exactly.' },
  { field: 'linkName', attr: 'name', type: 'string', on: 'linkEventDefinition', allowed: EVENT_TYPES, scope: 'an Event',
    shape: 'eventDefinition', writeSite: 'buildEventDefinition', enforcedBy: 'writeSite', roundTrip: 'lossy',
    reason: 'Written only when `marker === "link"`; on any other marker the field is silently '
      + 'ignored. In the other direction the link event GAINS one: when `linkName` is absent, '
      + '`buildEventDefinition` writes the node\'s `name` into the LinkEventDefinition and the '
      + 'importers read it straight back out as `linkName`, so the field appears on re-import '
      + 'where the author wrote none.' },
  { field: 'conditionExpression', attr: 'condition', type: 'string', on: 'conditionalEventDefinition', allowed: EVENT_TYPES, scope: 'an Event',
    shape: 'eventDefinition', writeSite: 'buildEventDefinition', enforcedBy: 'writeSite', roundTrip: 'lossy',
    reason: 'Written only when `marker === "conditional"`; on any other marker the field is '
      + 'silently ignored. With that marker it is exact through `moddle-import.js` (the primary '
      + 'path) and NOT through the legacy `import.js`, which returns `x&lt;1` for `x<1`: its DOM '
      + 'parser accumulates a text node character by character and never unescapes entities '
      + '(import.js, the `parseXml` text branch). That is one parser-level defect, not a '
      + 'conditionExpression one — measured, it also hits `loopType.loopCondition`, and by '
      + 'inspection every other value read out of a text node on that path (`documentation`, '
      + '`script`, `decisionRef`, `multiInstance.loopCardinality`/`.completionCondition`, '
      + '`edge.condition`, a timer expression, a textAnnotation\'s name). Fixing it is a change to '
      + 'the shared parser affecting ~10 fields and belongs in its own stage; stated here rather '
      + 'than claimed away, because this row would otherwise assert more than holds.' },
  { field: 'timerExpression', attr: ['timeDate', 'timeDuration', 'timeCycle'], type: 'object', on: 'timerEventDefinition', allowed: EVENT_TYPES, scope: 'an Event',
    shape: 'eventDefinition', writeSite: 'buildEventDefinition', enforcedBy: 'writeSite', roundTrip: 'lossy',
    reason: 'Written only when `marker === "timer"`; on any other marker the field is silently '
      + 'ignored. With that marker it round-trips exactly — `type` selects one of the three `attr` '
      + 'properties and the importers invert that choice. An unrecognised `type` falls through to '
      + '`timeDuration`, so it comes back as a duration.' },

  // ── shape: 'extension' ─────────────────────────────────────────────────────────────────────────
  // No OMG counterpart exists, so `attr` names our own element and the metamodel fence exempts the
  // row by shape rather than by an allowlist entry.
  { field: 'decisionRef', attr: 'decisionRef', type: 'string', on: 'self', allowed: new Set(['businessRuleTask']), scope: 'a businessRuleTask',
    shape: 'extension', writeSite: 'buildFlowNode', enforcedBy: 'convention', roundTrip: 'exact',
    // `'convention'`, not `'table'`, and the one word is load-bearing. The write site DOES consult
    // `allowed` — the field is dropped off a businessRuleTask exactly like a `'table'` row — but
    // the scope it enforces is not OMG's. BPMN 2.0 has no attribute here at all; the scope comes
    // from this project's own published contract (`references/input-schema.json`: "For
    // businessRuleTask"). S15's message quotes OMG and would be quoting nothing, and rule M11
    // already owns this field in the layer that owns OUR conventions — so S15 skips this row and
    // M11 reports it. Without the distinction both rules fired on one field on one node, which is
    // the two-sentences-about-one-field problem `isFieldWrongType`'s own doc argues against.
    // `allowed` is hand-stated, and `references/input-schema.json` is the authority it is stated
    // from: the property's own description reads "For businessRuleTask: id of the decision this
    // task invokes". BPMN 2.0 has no standard attribute here (the DMN side of the link,
    // Decision#usingTask, points the other way), so there is nothing in the metamodel to derive it
    // from. Until this stage the write was unguarded, and a `decisionRef` on a userTask was
    // emitted, re-imported and never questioned — a field the published contract scopes to one
    // class, silently honoured on all 25.
  },

  // ── shape: 'unserialised' — nothing writes these ───────────────────────────────────────────────
  // `attr` is null for every row here, and the fences assert that: a row that names a target it
  // does not write is exactly the kind of claim this table exists to stop. What each field WOULD
  // serialise to, if implemented, is in its reason.
  { field: 'isAdHoc', attr: null, type: 'boolean', on: 'self', allowed: new Set(['subProcess']), scope: 'a subProcess',
    shape: 'unserialised', writeSite: 'none', enforcedBy: 'none', roundTrip: 'none',
    reason: 'Render-only: `svg.js` draws the ad-hoc tilde marker and nothing serialises it, so the '
      + 'preview is right and every real tool sees a plain subProcess. OMG expresses ad-hoc as a '
      + 'CLASS (`bpmn:adHocSubProcess`), not an attribute, so implementing it means emitting that '
      + 'class — which also means ending `bpmnXmlTag`\'s silent `|| \'task\'` fallback for it. '
      + 'Decided and queued (plan "Root fix", backlog items 5 and 6).' },
  { field: 'isInterrupting', attr: null, type: 'boolean', on: 'self', allowed: new Set(['startEvent']), scope: 'a startEvent',
    shape: 'unserialised', writeSite: 'none', enforcedBy: 'none', roundTrip: 'none',
    reason: 'Render-only: `svg.js` draws the dashed ring of a non-interrupting event-subprocess '
      + 'start event and nothing serialises it. OMG has the attribute ready — `StartEvent'
      + '#isInterrupting`, default true — so this is a write plus two reads, not a design question. '
      + 'Decided and queued (plan "Root fix", backlog item 6).' },
  { field: 'extensions', attr: null, type: 'object', on: 'self', allowed: ALL_NODE_TYPES, scope: 'any node',
    shape: 'unserialised', writeSite: 'none', enforcedBy: 'none', roundTrip: 'none',
    reason: 'Import-side preservation only: `moddle-import.js` copies a foreign element\'s `$attrs` '
      + 'into this field so a round trip can SHOW what was there, but no write-back exists, so the '
      + 'attributes are lost the moment the Logic-Core is serialised again. A Logic-Core authored '
      + 'with `extensions` never reaches the XML at all.' },
];

/**
 * The one row for `field`, or `undefined`. A named lookup rather than a `.find()` at each call
 * site: the write sites that consult `allowed` (`buildFlowNode`'s loopCharacteristics, script and
 * decisionRef branches) each need exactly one row, and a mistyped field name should fail loudly at
 * the fence rather than quietly widen a guard to "no row, therefore no restriction".
 */
export function nodeFieldSpec(field) {
  return OMG_NODE_FIELD_SCOPE.find((s) => s.field === field);
}

/**
 * The same table for `$defs.Edge`'s properties — every one except `id`.
 *
 * Same eleven columns, with one deliberate difference in what `allowed` MEANS. A node row's
 * `allowed` names the classes that may carry the field, and the metamodel can check it directly.
 * An edge has exactly one class (`SequenceFlow`), so "which class" would be a constant and would
 * say nothing. What actually varies — and what both a reader and Stage 2's fence need — is which
 * SOURCE NODE types the field is meaningful for, so that is what `allowed` names here.
 *
 * `on` therefore does more work than on a node row:
 *   - `'sequenceFlow'` — the property lands on the edge's own element. `allowed` is the set of
 *     source node types for which authoring the field makes sense, hand-stated, and it is the
 *     metamodel-checkable claim `carries('SequenceFlow', attr)` that the fence enforces instead.
 *   - `'sourceGateway'` — the structural case the node table has no shape for: `isDefault` is
 *     authored on the EDGE and serialised as the `default` attribute of the edge's SOURCE element.
 *     Here `allowed` IS metamodel-checkable, and strictly: every type in it must carry `default`,
 *     and the fence compares the set against the metamodel in both directions like a node row.
 *     The measured result is wider than the serialiser's own `exclusiveGateway || inclusiveGateway`
 *     test — see DEFAULT_FLOW_SOURCE_TYPES.
 *
 * Not consumed by `buildFlowNode` or S15 (neither walks edges); read by the fences, and by Stage
 * 2's spanning fence, which is what the `roundTrip` column is for.
 */
export const OMG_EDGE_FIELD_SCOPE = [
  { field: 'source', attr: 'sourceRef', type: 'string', on: 'sequenceFlow', allowed: FLOW_NODE_TYPES, scope: 'a FlowNode',
    shape: 'attr', writeSite: 'buildProcess', enforcedBy: 'writeSite', roundTrip: 'exact' },
  { field: 'target', attr: 'targetRef', type: 'string', on: 'sequenceFlow', allowed: FLOW_NODE_TYPES, scope: 'a FlowNode',
    shape: 'attr', writeSite: 'buildProcess', enforcedBy: 'writeSite', roundTrip: 'exact' },
  { field: 'label', attr: 'name', type: 'string', on: 'sequenceFlow', allowed: FLOW_NODE_TYPES, scope: 'a FlowNode',
    shape: 'attr', writeSite: 'buildProcess', enforcedBy: 'writeSite', roundTrip: 'lossy',
    reason: 'The label is also FABRICATED INTO `condition`: when the source is a diverging XOR or '
      + 'OR gateway and the edge is not the default, `buildProcess` copies `label` into a '
      + '`<bpmn:conditionExpression>` (bpmn-xml.js, the `needsCondition` branch). The label itself '
      + 'survives as `name`, but the re-imported Logic-Core carries a `condition` the author never '
      + 'wrote, so LC -> XML -> LC is not idempotent for such an edge. Removal is decided and '
      + 'queued (plan "Root fix", backlog item 7); three goldens move when it lands.' },
  { field: 'condition', attr: 'conditionExpression', type: 'string', on: 'sequenceFlow', allowed: DEFAULT_FLOW_SOURCE_TYPES, scope: 'an Activity or a conditional Gateway (exclusive, inclusive, complex)',
    shape: 'childElement', writeSite: 'buildProcess', enforcedBy: 'none', roundTrip: 'lossy',
    reason: 'Exact at depth 0. Lost at depth >= 1: the child-edge branch of `buildFlowNode` writes '
      + 'id, name, sourceRef and targetRef only, so a condition on an edge inside a subProcess or '
      + 'transaction never reaches the XML. Decided and queued (plan "Root fix", Stage 6). '
      + 'enforcedBy none: `buildProcess` writes a conditionExpression from any source class.' },
  { field: 'isDefault', attr: 'default', type: 'boolean', on: 'sourceGateway', allowed: DEFAULT_FLOW_SOURCE_TYPES, scope: 'an Activity or a conditional Gateway (exclusive, inclusive, complex)',
    shape: 'attr', writeSite: 'buildProcess', enforcedBy: 'none', roundTrip: 'lossy',
    reason: 'The serialiser FABRICATES it: when a diverging XOR or OR gateway has more than one '
      + 'outgoing flow and none is marked, `buildDefaultFlowMap` makes the LAST one the default. So '
      + 'an edge that carried no `isDefault` can come back carrying one, and which edge that is '
      + 'depends on array order. An explicitly marked edge does survive. Removal is decided and '
      + 'queued (plan "Root fix", backlog item 7); three goldens move when it lands. enforcedBy '
      + 'none: `buildDefaultFlowMap` records `isDefault` from a source of any class, and '
      + '`buildProcess` then writes `default` onto that element whatever it is.' },
  { field: 'isConditional', attr: null, type: 'boolean', on: 'sequenceFlow', allowed: DEFAULT_FLOW_SOURCE_TYPES, scope: 'an Activity or a conditional Gateway (exclusive, inclusive, complex)',
    shape: 'unserialised', writeSite: 'none', enforcedBy: 'none', roundTrip: 'none',
    reason: 'Render-only: `svg.js` draws the conditional-flow diamond at the source end and '
      + 'nothing serialises it, so the preview is right and every real tool sees an ordinary flow. '
      + 'OMG expresses it as the PRESENCE of a conditionExpression on a flow leaving an Activity, '
      + 'so implementing it means emitting one. Decided and queued (plan "Root fix", backlog '
      + 'item 6).' },
  { field: 'isHappyPath', attr: null, type: 'boolean', on: 'sequenceFlow', allowed: FLOW_NODE_TYPES, scope: 'a FlowNode',
    shape: 'layoutOnly', writeSite: 'none', enforcedBy: 'none', roundTrip: 'none',
    reason: 'Layout input, not model content: `topology.js`\'s `identifyHappyPathNodes` reads it to '
      + 'decide which chain to keep straight, and `scripts/scenarios/format.js` reads it to pick '
      + 'the happy path to group around. BPMN has no notion of a preferred path, so there is '
      + 'nothing to serialise and nothing to read back — this row is `none` by design, not by '
      + 'omission, and it should stay that way.' },
];

/**
 * Does `node` carry `field`, and is its type one the OMG attribute is not defined on?
 *
 * "Carries" is `!= null` rather than truthiness on purpose: `isCompensation: false` and
 * `implementation: ''` are still the author saying something about a class that has no such
 * attribute, and reporting them is honest. The serialiser's own guards remain truthiness-based,
 * so a `false` is dropped either way — this predicate only decides what S15 talks about.
 */
export function isFieldOutOfScope(node, { field, allowed }) {
  return node?.[field] != null && !allowed.has(node.type);
}

/**
 * Does `node` carry `field` with a value of the wrong JavaScript type?
 *
 * Separate from `isFieldOutOfScope` because they are different mistakes with different remedies —
 * the field on the wrong class is "you meant a different node", the wrong type is "you meant a
 * different value" — and a caller reporting both at once would say two confusing things about one
 * field. `rules.js` asks the scope question first and only asks this one if the class is right.
 *
 * `references/input-schema.json` already declares each field's type, so the HTTP path rejects a
 * wrong one at the schema gate. The library and CLI paths do not run that gate, which is exactly
 * why this exists: `runPipeline` is a public API and must not depend on a caller having gone
 * through the HTTP server to be safe.
 */
export function isFieldWrongType(node, { field, type }) {
  const value = node?.[field];
  if (value == null) return false;
  return !matchesFieldType(value, type);
}

/**
 * Does `value` have the shape the table's `type` column declares?
 *
 * Split out of `isFieldWrongType` because the serialiser needs the same question answered about a
 * value it is about to write, and the two must not answer it differently — the reason the scope
 * question lives in one table in the first place.
 *
 * Three of the five `type` values need more than `typeof`:
 *   - `'array'`  — `typeof []` is `'object'`, which would make every object pass as an array.
 *   - `'mixed'`  — `loopType` and `multiInstance` are each `oneOf` a string shorthand and an object
 *                  in `references/input-schema.json`, so there is no single JavaScript type to
 *                  check. Deliberately NOT split into two rows: one Logic-Core field that reaches
 *                  one write site is one row, and inventing `loopType.string` / `loopType.object`
 *                  rows would put a shape distinction the serialiser handles internally into a
 *                  table that is supposed to be about classes. The consequence is stated rather
 *                  than hidden: a wrongly-shaped value of these two fields is not caught here. The
 *                  schema gate catches it on the HTTP path, and the write site ignores what it does
 *                  not recognise (`typeof node.loopType === 'object'` guards every sub-property).
 *   - `'object'` — must exclude arrays and null for the same reason `'array'` exists.
 */
export function matchesFieldType(value, type) {
  if (type === 'mixed') return true;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return typeof value === 'object' && !Array.isArray(value);
  return typeof value === type;
}

/**
 * Is this node type an OMG `InteractionNode` — legal at a MessageFlow's `sourceRef`/`targetRef`?
 *
 * Per BPMN20.cmof, `InteractionNode` (:859) is granted per class, never inherited, to exactly
 * four classes: `Event` (:287, `superClass="FlowNode InteractionNode"`), `Task` (:1191,
 * `superClass="Activity InteractionNode"`), `Participant` (:863) and `ConversationNode` (:626 —
 * conversation-diagram only, outside this project's NodeType and irrelevant here). `Activity` on
 * its own is not one (`superClass="FlowNode"` alone, :1095), which is why `SubProcess` (:1147),
 * `CallActivity` (:1188), `AdHocSubProcess` (:1222) and `Transaction` (:1233) — all container
 * types, see CONTAINER_TYPES — do NOT qualify, even though they are Activities. This is the
 * asymmetry `isActivity` above must not collapse: an activity is not automatically an
 * interaction node, and a message flow naming a container is illegal even though the same
 * container legally hosts a boundary event.
 *
 * Takes a node **type**, not a node, and therefore only ever answers the Task/Event half of the
 * union. The Participant half is deliberately left to the caller: a MessageFlow endpoint naming a
 * pool refers to a Participant, which lives in `lc.pools`/`Pool`, not in the NodeType enum this
 * function (and its fence) are defined over — there is no node with `type: 'participant'` to
 * classify. Folding that case in here would mean silently accepting a node vs. a pool id as the
 * same shape of argument, which the two call sites (a flow endpoint resolved against `nodes`,
 * one resolved against `pools`) do not actually share. A caller checking a MessageFlow endpoint
 * must therefore ask "is this id a node, and if so isInteractionNode(node.type) — or is this id a
 * pool" as two separate questions, not one.
 */
export function isInteractionNode(type) {
  return TASK_TYPES.has(type) || EVENT_TYPES.has(type);
}

/**
 * Is this node exempt from "must be reached by an incoming sequence flow" — the check S04
 * ("appears isolated") and S07 ("no outgoing flow") each approximate today, differently, which is
 * why both misfire on the same inputs: an event subprocess, a compensation activity, or a group
 * artifact each currently trips both warnings, because neither rule's hand-rolled approximation
 * recognises them as legitimately reached some other way. `types.test.js`'s `isSequenceFlowExempt`
 * tests exercise each member below directly, in isolation from S04/S07 — this stage does not
 * change those rules, only names the predicate they will call in Stage 2.
 *
 * The membership, each with its own reason a sequence flow cannot be the thing that reaches it:
 *   - `startEvent`     — by definition the entry point; nothing precedes it in its own scope.
 *   - a boundary event  — attached to its host (`attachedToRef`), triggered by the host's
 *                         execution, never targeted by a SequenceFlow.
 *   - an artifact       — not a FlowNode's target at all; associations, not sequence flows,
 *                         connect to it (`isArtifact`, the layout-sense predicate, on purpose —
 *                         a dataObjectReference is exempt here for the same reason a
 *                         textAnnotation is, regardless of the FlowElement/Artifact split that
 *                         matters to `isBpmnArtifact`).
 *   - `isCompensation` on an Activity — OMG `isForCompensation` (serialised at bpmn-xml.js's
 *                         `buildFlowNode`, `attrs.isForCompensation`), reached by a compensation
 *                         association when the compensation fires, not by a SequenceFlow.
 *   - `isEventSubProcess` on a subProcess — OMG `triggeredByEvent` (serialised the same way,
 *                         `attrs.triggeredByEvent`), entered by its own start event when the
 *                         triggering event occurs, never by a SequenceFlow crossing into it.
 *
 * Takes a **node**, not a type: `isCompensation`/`isEventSubProcess` are instance fields
 * (references/input-schema.json), not a function of the type string alone — two `subProcess`
 * nodes can differ only in `isEventSubProcess` and need different verdicts here.
 *
 * Both instance flags are ALSO guarded on the node's class, and both guards are load-bearing in
 * the same way. `references/input-schema.json` declares each as a generic property of `Node`,
 * valid on any `NodeType`; OMG scopes them far more narrowly — `isForCompensation` is an
 * attribute of `Activity`, `triggeredByEvent` one of `SubProcess`. Ungurded, either flag becomes
 * a universal opt-out of the two always-on rules that call this predicate: a
 * `{ type: 'parallelGateway', isCompensation: true }` with no edges at all would be silent in
 * both S04 and S07, so a genuinely isolated gateway would be reported by nothing. The exemption
 * has to be as narrow as the OMG attribute it stands for, not as wide as the schema's field.
 * `bpmn-xml.js`'s `buildFlowNode` already applies the same narrowing on the way out for
 * `isEventSubProcess`, which is where the pattern comes from.
 */
export function isSequenceFlowExempt(node) {
  if (!node) return false;
  return node.type === 'startEvent'
    || isBoundaryEvent(node)
    || isArtifact(node.type)
    || (isActivity(node.type) && !!node.isCompensation)
    || (node.type === 'subProcess' && !!node.isEventSubProcess);
}

export function isDataArtifact(type) {
  return isArtifact(type);
}

export function bpmnXmlTag(type) {
  const map = {
    task: 'task', userTask: 'userTask', serviceTask: 'serviceTask',
    scriptTask: 'scriptTask', sendTask: 'sendTask', receiveTask: 'receiveTask',
    manualTask: 'manualTask', businessRuleTask: 'businessRuleTask',
    callActivity: 'callActivity', subProcess: 'subProcess', transaction: 'transaction',
    startEvent: 'startEvent', endEvent: 'endEvent',
    intermediateCatchEvent: 'intermediateCatchEvent',
    intermediateThrowEvent: 'intermediateThrowEvent',
    boundaryEvent: 'boundaryEvent',
    exclusiveGateway: 'exclusiveGateway', parallelGateway: 'parallelGateway',
    inclusiveGateway: 'inclusiveGateway', eventBasedGateway: 'eventBasedGateway',
    complexGateway: 'complexGateway',
    dataObjectReference: 'dataObjectReference',
    dataStoreReference: 'dataStoreReference',
    textAnnotation: 'textAnnotation',
    group: 'group',
  };
  return map[type] || 'task';
}

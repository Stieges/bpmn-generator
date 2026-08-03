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
 * boolean pair), `allowed` the node types that may carry it, `scope` prose for the message.
 * Each `allowed` set reproduces the guard that was already in `buildFlowNode`, except
 * `isCompensation` (added this phase) and `implementation` (added here) — so no field's
 * serialisation behaviour changes as a side effect of centralising them.
 */
export const OMG_NODE_FIELD_SCOPE = [
  { field: 'isCompensation', attr: 'isForCompensation', allowed: ACTIVITY_TYPES, scope: 'an Activity' },
  { field: 'implementation', attr: 'implementation', allowed: IMPLEMENTATION_TYPES, scope: 'a userTask, serviceTask, sendTask, receiveTask or businessRuleTask' },
  { field: 'isEventSubProcess', attr: 'triggeredByEvent', allowed: new Set(['subProcess']), scope: 'a subProcess' },
  { field: 'calledElement', attr: 'calledElement', allowed: new Set(['callActivity']), scope: 'a callActivity' },
  { field: 'scriptFormat', attr: 'scriptFormat', allowed: new Set(['scriptTask']), scope: 'a scriptTask' },
  { field: 'isCollection', attr: 'isCollection', allowed: new Set(['dataObjectReference']), scope: 'a dataObjectReference' },
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

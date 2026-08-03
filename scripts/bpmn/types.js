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
const TASK_TYPES = new Set([
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
 *   - `isCompensation`  — OMG `isForCompensation` (serialised at bpmn-xml.js's `buildFlowNode`,
 *                         `attrs.isForCompensation`), reached by a compensation association when
 *                         the compensation fires, not by a SequenceFlow.
 *   - `isEventSubProcess` on a subProcess — OMG `triggeredByEvent` (serialised the same way,
 *                         `attrs.triggeredByEvent`), entered by its own start event when the
 *                         triggering event occurs, never by a SequenceFlow crossing into it.
 *
 * Takes a **node**, not a type: `isCompensation`/`isEventSubProcess` are instance fields
 * (references/input-schema.json), not a function of the type string alone — two `subProcess`
 * nodes can differ only in `isEventSubProcess` and need different verdicts here.
 */
export function isSequenceFlowExempt(node) {
  if (!node) return false;
  return node.type === 'startEvent'
    || isBoundaryEvent(node)
    || isArtifact(node.type)
    || !!node.isCompensation
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

/**
 * BPMN Type Predicates & Tag Mapping
 * Pure functions, no dependencies.
 */

export function isEvent(type) {
  return type?.includes('Event') || false;
}

export function isGateway(type) {
  return type?.includes('Gateway') || false;
}

export function isBoundaryEvent(node) {
  return node.type === 'boundaryEvent' || !!node.attachedTo;
}

/**
 * Layout sense of "artifact": drawable, but kept out of the ELK graph because it
 * is not part of the sequence flow. Wider than the BPMN class of the same name —
 * data references are FlowElements in the spec. Use isBpmnArtifact for anything
 * that has to be right against the XSD.
 */
export function isArtifact(type) {
  return ['dataObjectReference', 'dataStoreReference', 'textAnnotation', 'group'].includes(type);
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

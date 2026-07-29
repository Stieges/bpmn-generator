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

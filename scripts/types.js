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

export function isArtifact(type) {
  return ['dataObjectReference', 'dataStoreReference', 'textAnnotation', 'group'].includes(type);
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

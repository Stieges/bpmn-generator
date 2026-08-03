import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

import {
  isEvent, isGateway, isBoundaryEvent, isArtifact, isBpmnArtifact,
  isContainerNode, CONTAINER_TYPES, ACTIVITY_TYPES, isActivity,
  isInteractionNode, isSequenceFlowExempt,
} from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'references', 'input-schema.json');

// The single source of truth for "what node types exist" — read, not restated. A test that
// hard-codes its own copy of the NodeType list is exactly the second-partial-list problem this
// stage exists to close, just moved into the test file instead of the rule engine.
function loadNodeTypeEnum() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const enumValues = schema.$defs?.NodeType?.enum;
  if (!Array.isArray(enumValues) || enumValues.length === 0) {
    throw new Error('references/input-schema.json: $defs.NodeType.enum not found or empty — fence cannot run');
  }
  return enumValues;
}

describe('the NodeType fence — every enum member is classified, and exactly once', () => {
  const nodeTypes = loadNodeTypeEnum();

  test('the schema fixture itself is non-trivial', () => {
    expect(nodeTypes.length).toBeGreaterThan(0);
  });

  // The four classes this stage adds/backs with explicit sets, over the classification
  // question "what kind of node is this" (not the layout question "does it belong on the
  // sequence-flow graph", which is isArtifact's own, separate, wider concern).
  const classesOf = (type) => ({
    activity: isActivity(type),
    event: isEvent(type),
    gateway: isGateway(type),
    artifact: isArtifact(type),
  });

  test('no NodeType enum member is unclassified', () => {
    // toEqual([]) rather than toHaveLength(0): on failure this prints the offending type names,
    // which is the point — see the fence's own worked failure in the stage report.
    const unclassified = nodeTypes.filter((type) => {
      const c = classesOf(type);
      return !(c.activity || c.event || c.gateway || c.artifact);
    });
    expect(unclassified).toEqual([]);
  });

  test('no NodeType enum member falls into more than one of activity/event/gateway/artifact', () => {
    const overlapping = nodeTypes
      .map((type) => ({ type, ...classesOf(type) }))
      .filter(({ activity, event, gateway, artifact }) => {
        const hits = [activity, event, gateway, artifact].filter(Boolean).length;
        return hits > 1;
      })
      .map(({ type, ...c }) => `${type}: ${JSON.stringify(c)}`);
    expect(overlapping).toEqual([]);
  });
});

describe('isEvent / isGateway — explicit sets, same verdicts as the old substring test', () => {
  const nodeTypes = loadNodeTypeEnum();

  test('isEvent agrees with `type.includes("Event")` for every enum member', () => {
    const disagreements = nodeTypes.filter((type) => isEvent(type) !== type.includes('Event'));
    expect(disagreements).toEqual([]);
  });

  test('isGateway agrees with `type.includes("Gateway")` for every enum member', () => {
    const disagreements = nodeTypes.filter((type) => isGateway(type) !== type.includes('Gateway'));
    expect(disagreements).toEqual([]);
  });

  test('unknown or missing type is not an event or a gateway', () => {
    expect(isEvent(undefined)).toBe(false);
    expect(isEvent('notARealType')).toBe(false);
    expect(isGateway(undefined)).toBe(false);
    expect(isGateway('notARealType')).toBe(false);
  });
});

describe('ACTIVITY_TYPES / isActivity', () => {
  test('is exactly the union of the eight task types and CONTAINER_TYPES', () => {
    const expected = new Set([
      'task', 'userTask', 'serviceTask', 'scriptTask', 'sendTask', 'receiveTask',
      'manualTask', 'businessRuleTask',
      ...CONTAINER_TYPES,
    ]);
    expect(ACTIVITY_TYPES).toEqual(expected);
  });

  test('a container is an activity — a boundary event legally attaches to a subProcess', () => {
    expect(isActivity('subProcess')).toBe(true);
    expect(isActivity('callActivity')).toBe(true);
    expect(isActivity('transaction')).toBe(true);
  });

  test('a plain task is an activity', () => {
    expect(isActivity('userTask')).toBe(true);
  });

  test('a gateway, event or artifact is not an activity', () => {
    expect(isActivity('exclusiveGateway')).toBe(false);
    expect(isActivity('startEvent')).toBe(false);
    expect(isActivity('textAnnotation')).toBe(false);
  });
});

describe('isInteractionNode — Task ∪ Event, per BPMN20.cmof', () => {
  test('every task type is an interaction node', () => {
    for (const type of ['task', 'userTask', 'serviceTask', 'scriptTask', 'sendTask', 'receiveTask', 'manualTask', 'businessRuleTask']) {
      expect(isInteractionNode(type)).toBe(true);
    }
  });

  test('every event type is an interaction node', () => {
    for (const type of ['startEvent', 'endEvent', 'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent']) {
      expect(isInteractionNode(type)).toBe(true);
    }
  });

  test('a container is NOT an interaction node — Activity alone does not carry the property', () => {
    expect(isInteractionNode('subProcess')).toBe(false);
    expect(isInteractionNode('callActivity')).toBe(false);
    expect(isInteractionNode('transaction')).toBe(false);
  });

  test('a gateway or an artifact is not an interaction node', () => {
    expect(isInteractionNode('exclusiveGateway')).toBe(false);
    expect(isInteractionNode('textAnnotation')).toBe(false);
    expect(isInteractionNode('group')).toBe(false);
  });
});

describe('isSequenceFlowExempt', () => {
  test('a start event is exempt', () => {
    expect(isSequenceFlowExempt({ id: 'se', type: 'startEvent' })).toBe(true);
  });

  test('a boundary event is exempt, by type or by carrying attachedTo', () => {
    expect(isSequenceFlowExempt({ id: 'be', type: 'boundaryEvent' })).toBe(true);
    expect(isSequenceFlowExempt({ id: 'be2', type: 'intermediateCatchEvent', attachedTo: 'host' })).toBe(true);
  });

  test('an artifact is exempt', () => {
    expect(isSequenceFlowExempt({ id: 'grp', type: 'group' })).toBe(true);
    expect(isSequenceFlowExempt({ id: 'ann', type: 'textAnnotation' })).toBe(true);
    expect(isSequenceFlowExempt({ id: 'do', type: 'dataObjectReference' })).toBe(true);
  });

  // The two members the brief calls out as currently missed — reproduced in isolation here as a
  // unit-level guard; the reproduction against the live rule engine (S04/S07 misfiring) is Stage
  // 2's, since this stage does not change any call site.
  test('a compensation activity is exempt — reached by a compensation association, not a sequence flow', () => {
    expect(isSequenceFlowExempt({ id: 'storno', type: 'userTask', isCompensation: true })).toBe(true);
  });

  test('an event subprocess is exempt — entered by its own start event when triggered', () => {
    expect(isSequenceFlowExempt({ id: 'esp', type: 'subProcess', isEventSubProcess: true, nodes: [] })).toBe(true);
  });

  test('a plain subProcess without isEventSubProcess is NOT exempt', () => {
    expect(isSequenceFlowExempt({ id: 'sp', type: 'subProcess', nodes: [] })).toBe(false);
  });

  test('a plain task without isCompensation is NOT exempt', () => {
    expect(isSequenceFlowExempt({ id: 't', type: 'userTask' })).toBe(false);
  });

  test('a gateway or an ordinary intermediate event is not exempt', () => {
    expect(isSequenceFlowExempt({ id: 'gw', type: 'exclusiveGateway' })).toBe(false);
    expect(isSequenceFlowExempt({ id: 'ice', type: 'intermediateCatchEvent' })).toBe(false);
  });

  test('a missing node is not exempt', () => {
    expect(isSequenceFlowExempt(undefined)).toBe(false);
    expect(isSequenceFlowExempt(null)).toBe(false);
  });
});

// Sanity checks over the pre-existing predicates this stage did not change, guarding against a
// refactor accidentally touching their behaviour while restructuring the file around them.
describe('pre-existing predicates — unchanged', () => {
  test('isBoundaryEvent, isArtifact, isBpmnArtifact, isContainerNode still behave as documented', () => {
    expect(isBoundaryEvent({ type: 'boundaryEvent' })).toBe(true);
    expect(isBoundaryEvent({ type: 'task', attachedTo: 'x' })).toBe(true);
    expect(isBoundaryEvent({ type: 'task' })).toBe(false);
    expect(isArtifact('dataObjectReference')).toBe(true);
    expect(isBpmnArtifact('dataObjectReference')).toBe(false);
    expect(isBpmnArtifact('textAnnotation')).toBe(true);
    expect(isContainerNode({ type: 'callActivity' })).toBe(true);
    expect(isContainerNode({ type: 'task', nodes: [{ id: 'x' }] })).toBe(true);
    expect(isContainerNode({ type: 'task' })).toBe(false);
  });
});

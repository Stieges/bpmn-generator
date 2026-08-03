import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

import {
  isEvent, isGateway, isBoundaryEvent, isArtifact, isBpmnArtifact,
  isContainerNode, CONTAINER_TYPES, ACTIVITY_TYPES, isActivity,
  isInteractionNode, isSequenceFlowExempt,
  EVENT_TYPES, GATEWAY_TYPES, ARTIFACT_TYPES,
  OMG_NODE_FIELD_SCOPE,
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

// The same read-do-not-restate move for per-node field types. `OMG_NODE_FIELD_SCOPE.type` and
// `references/input-schema.json` both state what shape each scoped field's value must have, and
// two statements of one fact is the duplication this table was built to remove — just moved up a
// level. The schema is the authority (it is the published contract, and the HTTP gate enforces
// it), so the table is checked against it rather than the other way round.
//
// Why the table carries `type` at all instead of deriving it from the schema at runtime:
// `scripts/bpmn/types.js` is a no-dependency module — CLAUDE.md's architecture map says so — and
// making it read and parse a JSON file at import time to answer a question it can state in one
// word would be a real cost (file I/O, a path resolution, a parse failure mode) for no behavioural
// gain. Declared in the table, fenced here: the drift cannot survive CI, and the runtime module
// stays pure.
function loadNodeFieldTypes() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const props = schema.$defs?.Node?.properties;
  if (!props || typeof props !== 'object') {
    throw new Error('references/input-schema.json: $defs.Node.properties not found — fence cannot run');
  }
  return props;
}

describe('the scoped-field fence — the table and input-schema.json agree on every type', () => {
  const nodeProps = loadNodeFieldTypes();

  test('the table itself is non-empty and well-formed', () => {
    expect(OMG_NODE_FIELD_SCOPE.length).toBeGreaterThan(0);
    for (const spec of OMG_NODE_FIELD_SCOPE) {
      expect(typeof spec.field).toBe('string');
      expect(typeof spec.attr).toBe('string');
      expect(['boolean', 'string']).toContain(spec.type);
      expect(spec.allowed instanceof Set && spec.allowed.size > 0).toBe(true);
      expect(typeof spec.scope).toBe('string');
    }
  });

  for (const spec of OMG_NODE_FIELD_SCOPE) {
    test(`${spec.field} is declared on Node in input-schema.json`, () => {
      // A field the serialiser scopes but the schema never declares would be unreachable from any
      // valid input — either the table names something that no longer exists, or the schema
      // dropped a field the serialiser still writes.
      expect(nodeProps[spec.field]).toBeDefined();
    });

    test(`${spec.field}: the table's type matches the schema's`, () => {
      expect(spec.type).toBe(nodeProps[spec.field]?.type);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// The OMG-metamodel fence: `OMG_NODE_FIELD_SCOPE`'s `allowed` sets vs. bpmn-moddle's own metamodel.
//
// Every other fence in this file checks the table against ITSELF or against our own schema, so all
// of them only ever catch an `allowed` set that is too WIDE. The round-trip oracle in
// pipeline.test.js catches the same direction from the other side (bpmn-moddle answers
// `unknown attribute <…>` for an attribute a class may not carry). Nothing caught the opposite
// mistake — a class OMG genuinely grants the field to that `allowed` omits — because bpmn-moddle is
// necessarily silent about an attribute we never emit. That gap was live: `isEventSubProcess`
// allowed `subProcess` alone, so a `transaction` had the field dropped by `buildFlowNode` while S15
// asserted "OMG defines triggeredByEvent only on a subProcess", which is false — Transaction
// specialises SubProcess and inherits it.
//
// The oracle is `bpmn-moddle`'s shipped metamodel, already a runtime dependency, read here rather
// than restated: the same read-do-not-restate move the schema fences above make.
//
// **Inheritance is resolved, not just declaration.** `triggeredByEvent` is DECLARED only on
// `SubProcess`; `Transaction` and `AdHocSubProcess` carry it by `superClass`. Comparing against
// declaration sites alone would have reproduced exactly the bug this fence exists to catch.
//
// **The class-name gap, and the policy for it.** OMG spells classes `SubProcess`/`UserTask`;
// Logic-Core spells types `subProcess`/`userTask`. The mapping is initial-lowercase, and it is
// lossy in both directions:
//   - OMG has classes Logic-Core has no type for at all (`GlobalUserTask`, `DataObject`,
//     `ItemDefinition`, the abstract `Activity`);
//   - `CONTAINER_TYPES` has `adHocSubProcess`, which `references/input-schema.json`'s `NodeType`
//     enum does not expose — the pre-existing allowlisted exception, see CONTAINER_TYPES's comment.
//
// Policy, decided here and applied uniformly: **the comparison universe is the `NodeType` enum, and
// both sides are intersected with it before comparing.** Rationale — `allowed` is consumed by
// exactly two callers (`buildFlowNode`, S15) that only ever see Logic-Core nodes, so a class the
// schema cannot express and `bpmnXmlTag` cannot emit is a type about which neither caller can be
// right or wrong. Making a claim about it would be untestable through this project's own surface.
// The consequence is explicit and worth stating rather than hiding: `adHocSubProcess` is invisible
// to this fence on BOTH sides, so `isCompensation`'s `allowed` (= ACTIVITY_TYPES, which contains
// it) passes and `isEventSubProcess`'s (which deliberately does not) passes too. The existing
// `ALLOWLISTED_NON_ENUM_TYPES` fence below is what keeps that exception from silently growing, and
// `types.js`'s comment on the `isEventSubProcess` entry records why granting it there would emit
// invalid XML today.
//
// **`on: 'dataObject'` is checked differently, not skipped.** `isCollection`'s `allowed` names the
// Logic-Core AUTHORING node (`dataObjectReference` — in Logic-Core the reference and its object are
// one node), while the attribute is emitted onto the companion `<bpmn:dataObject>`. So for a
// non-`self` entry the fence checks the OMG side of that indirection instead: that the class named
// by `on` really does carry `attr`. The authoring-side claim has no metamodel counterpart to check
// it against and is fenced by the schema tests above.
describe('the OMG-metamodel fence — no `allowed` set is too wide OR too narrow', () => {
  const require = createRequire(import.meta.url);
  const METAMODEL = require('bpmn-moddle/resources/bpmn/json/bpmn.json');

  const byName = new Map(METAMODEL.types.map((t) => [t.name, t]));

  test('the metamodel fixture itself is non-trivial — a silent empty read must not pass this fence', () => {
    expect(METAMODEL.types.length).toBeGreaterThan(100);
    expect(byName.has('SubProcess')).toBe(true);
    expect(byName.has('Transaction')).toBe(true);
  });

  // Declared on the class, or inherited from any superclass. `superClass` entries may be prefixed
  // (`bpmn:Activity`); the prefix is stripped. `seen` guards against a malformed cyclic hierarchy
  // rather than any real one — an infinite loop here would hang CI instead of failing it.
  function carries(className, attr, seen = new Set()) {
    if (seen.has(className)) return false;
    seen.add(className);
    const type = byName.get(className);
    if (!type) return false;
    if ((type.properties || []).some((p) => p.name === attr)) return true;
    return (type.superClass || []).some((s) => carries(s.replace(/^[^:]+:/, ''), attr, seen));
  }

  const toLogicCoreType = (className) => className.charAt(0).toLowerCase() + className.slice(1);

  const universe = new Set(loadNodeTypeEnum());
  const inUniverse = (types) => [...types].filter((t) => universe.has(t)).sort();

  for (const spec of OMG_NODE_FIELD_SCOPE.filter((s) => s.on === 'self')) {
    test(`${spec.field}: allowed matches every NodeType bpmn-moddle grants ${spec.attr} to`, () => {
      const fromMetamodel = METAMODEL.types
        .filter((t) => carries(t.name, spec.attr))
        .map((t) => toLogicCoreType(t.name));
      // Sanity: the attribute must exist somewhere in the metamodel at all. Without this, a typo in
      // `attr` would make both sides empty on the metamodel side and the fence would pass by
      // comparing nothing — the exact failure shape a fence must not have.
      expect(fromMetamodel.length).toBeGreaterThan(0);
      expect(inUniverse(spec.allowed)).toEqual(inUniverse(fromMetamodel));
    });
  }

  for (const spec of OMG_NODE_FIELD_SCOPE.filter((s) => s.on !== 'self')) {
    test(`${spec.field}: the emission target "${spec.on}" is an OMG class that carries ${spec.attr}`, () => {
      const className = spec.on.charAt(0).toUpperCase() + spec.on.slice(1);
      expect(byName.has(className)).toBe(true);
      expect(carries(className, spec.attr)).toBe(true);
    });
  }

  test('every `on` value is either "self" or names a real OMG class', () => {
    const bad = OMG_NODE_FIELD_SCOPE
      .filter((s) => s.on !== 'self' && !byName.has(s.on.charAt(0).toUpperCase() + s.on.slice(1)))
      .map((s) => `${s.field}: on=${s.on}`);
    expect(bad).toEqual([]);
  });
});

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

describe('the NodeType fence, reverse direction — every classification-set member is a real enum type', () => {
  const nodeTypeSet = new Set(loadNodeTypeEnum());

  // `adHocSubProcess` is the one documented exception: a real OMG class (`AdHocSubProcess`,
  // BPMN20.cmof:1222) that `CONTAINER_TYPES` (and therefore `ACTIVITY_TYPES`) has carried since
  // before this stage, but that references/input-schema.json's NodeType enum does not expose —
  // the schema instead spells ad-hoc as `isAdHoc: true` on a plain `subProcess`. Neither importer
  // ever produces the string, but `pipeline.test.js`'s S14 test builds a hand-written Logic-Core
  // node with this exact type (bypassing the schema gate, which only runs at the HTTP boundary)
  // and depends on CONTAINER_TYPES classifying it as a container. So this is not a stray entry to
  // delete — see the long comment on CONTAINER_TYPES in types.js for the full argument — and this
  // allowlist is what keeps the fence honest about that rather than either silently passing over
  // it or wrongly failing on a type the codebase deliberately still supports.
  const ALLOWLISTED_NON_ENUM_TYPES = new Set(['adHocSubProcess']);

  // Named per set, not merged into one flat list, so a failure's message says which
  // classification acquired the stray member — that is the whole point of this direction.
  const classificationSets = { ACTIVITY_TYPES, EVENT_TYPES, GATEWAY_TYPES, ARTIFACT_TYPES };

  for (const [setName, set] of Object.entries(classificationSets)) {
    test(`every member of ${setName} is a NodeType enum member (or the documented allowlist)`, () => {
      const strays = [...set].filter((type) => !nodeTypeSet.has(type) && !ALLOWLISTED_NON_ENUM_TYPES.has(type));
      expect(strays).toEqual([]);
    });
  }

  test('the allowlist itself does not silently grow — every allowlisted type is still absent from the enum', () => {
    // If a schema change ever adds 'adHocSubProcess' to NodeType, this fails loudly so the
    // allowlist (and CONTAINER_TYPES's comment explaining it) gets cleaned up rather than
    // silently going stale.
    const noLongerNeeded = [...ALLOWLISTED_NON_ENUM_TYPES].filter((type) => nodeTypeSet.has(type));
    expect(noLongerNeeded).toEqual([]);
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

  // Both instance flags are guarded on the node's CLASS, and the guards are what keep the
  // exemption as narrow as the OMG attribute rather than as wide as the schema's field.
  // `references/input-schema.json` declares `isCompensation` on `Node`, so it is schema-valid on
  // any NodeType — but OMG's `isForCompensation` is an Activity attribute. Ungurded, the flag
  // would be a universal opt-out of both S04 and S07 and a genuinely isolated gateway carrying it
  // would be reported by nothing.
  test.each(['exclusiveGateway', 'parallelGateway', 'intermediateCatchEvent', 'endEvent', 'textAnnotation'])(
    'isCompensation on a %s does not exempt it — isForCompensation is an Activity attribute',
    (type) => {
      // textAnnotation is exempt anyway (it is an artifact), so assert the flag is not what did it.
      const expected = type === 'textAnnotation';
      expect(isSequenceFlowExempt({ id: 'n', type, isCompensation: true })).toBe(expected);
    });

  test.each(['userTask', 'task', 'serviceTask', 'subProcess', 'transaction', 'callActivity'])(
    'isCompensation on a %s does exempt it — every Activity subclass may carry isForCompensation',
    (type) => {
      expect(isSequenceFlowExempt({ id: 'n', type, isCompensation: true })).toBe(true);
    });

  test('isEventSubProcess outside a subProcess does not exempt either', () => {
    // The neighbouring guard, asserted for the same reason: `triggeredByEvent` is a SubProcess
    // attribute, and `bpmn-xml.js`'s buildFlowNode already narrows it the same way on the way out.
    expect(isSequenceFlowExempt({ id: 'n', type: 'userTask', isEventSubProcess: true })).toBe(false);
    expect(isSequenceFlowExempt({ id: 'n', type: 'callActivity', isEventSubProcess: true })).toBe(false);
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

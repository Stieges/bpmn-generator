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
  OMG_NODE_FIELD_SCOPE, OMG_EDGE_FIELD_SCOPE, nodeFieldSpec, matchesFieldType,
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

// The Edge half of the same read-do-not-restate move. Separate function rather than a parameter,
// so a failure message names which of the two `$defs` blocks went missing.
function loadEdgeFieldTypes() {
  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  const props = schema.$defs?.Edge?.properties;
  if (!props || typeof props !== 'object') {
    throw new Error('references/input-schema.json: $defs.Edge.properties not found — fence cannot run');
  }
  return props;
}

// ---------------------------------------------------------------------------------------------
// The two field-authority tables, and the three fences over them.
//
// `OMG_NODE_FIELD_SCOPE` and `OMG_EDGE_FIELD_SCOPE` state, per Logic-Core field, which node classes
// may carry it, how it serialises, who guards it and what survives a round trip. Everything below
// checks those claims against something OUTSIDE the table — `references/input-schema.json` for the
// field set and the value types, `bpmn-moddle`'s shipped metamodel for the class scopes. A fence
// that checked the table against itself would be green over any internally consistent lie, which is
// exactly how three earlier guards were simultaneously green over a live `isCollection` defect.
//
// Column vocabulary, kept here as data so a new value cannot slip in without a decision:
const SHAPES = ['attr', 'childElement', 'eventDefinition', 'extension', 'di', 'labelRouting', 'layoutOnly', 'unserialised'];
const ROUND_TRIPS = ['exact', 'presence', 'lossy', 'none'];
const ENFORCERS = ['table', 'writeSite', 'moddle', 'none'];
const VALUE_TYPES = ['boolean', 'string', 'object', 'array', 'mixed'];
// The two shapes that mean "there is no serialisation target". `attr` must be null for exactly
// these, in both directions — a row naming a target it never writes is precisely the kind of
// unchecked claim these tables exist to end.
const TARGETLESS_SHAPES = ['unserialised', 'layoutOnly'];

const ALL_ROWS = [
  ...OMG_NODE_FIELD_SCOPE.map((s) => ({ ...s, table: 'OMG_NODE_FIELD_SCOPE' })),
  ...OMG_EDGE_FIELD_SCOPE.map((s) => ({ ...s, table: 'OMG_EDGE_FIELD_SCOPE' })),
];

const attrsOf = (spec) => (spec.attr == null ? [] : [].concat(spec.attr));

describe('the table shape fence — every row is well-formed and every claim below `exact` is explained', () => {
  test('both tables are non-empty', () => {
    expect(OMG_NODE_FIELD_SCOPE.length).toBeGreaterThan(0);
    expect(OMG_EDGE_FIELD_SCOPE.length).toBeGreaterThan(0);
  });

  test.each(ALL_ROWS)('$table $field: columns are present and drawn from the declared vocabulary', (spec) => {
    expect(typeof spec.field).toBe('string');
    expect(VALUE_TYPES).toContain(spec.type);
    expect(SHAPES).toContain(spec.shape);
    expect(ROUND_TRIPS).toContain(spec.roundTrip);
    expect(ENFORCERS).toContain(spec.enforcedBy);
    expect(typeof spec.writeSite).toBe('string');
    expect(typeof spec.scope).toBe('string');
    expect(typeof spec.on).toBe('string');
    expect(spec.allowed instanceof Set && spec.allowed.size > 0).toBe(true);
    for (const attr of attrsOf(spec)) expect(typeof attr).toBe('string');
  });

  // `roundTrip` IS the exclusion list for the spanning fence in `field-fidelity.test.js`. There is
  // no second list, so a row that skips part of that fence can only do so by carrying a reason —
  // and the reason has to be long enough to be a sentence rather than a shrug.
  test.each(ALL_ROWS.filter((s) => s.roundTrip !== 'exact'))(
    '$table $field: roundTrip "$roundTrip" carries a reason a stranger can act on', (spec) => {
      expect(typeof spec.reason).toBe('string');
      expect(spec.reason.length).toBeGreaterThan(40);
    });

  // Same discipline for the other column that can quietly remove a guarantee: `enforcedBy: 'none'`
  // means nothing stops the field being written on a class that may not carry it, which is either
  // harmless-and-explained or a queued defect. Either way it is stated, not assumed.
  test.each(ALL_ROWS.filter((s) => s.enforcedBy === 'none'))(
    '$table $field: enforcedBy "none" carries a reason', (spec) => {
      expect(typeof spec.reason).toBe('string');
      expect(spec.reason.length).toBeGreaterThan(40);
    });

  test.each(ALL_ROWS)('$table $field: `attr` is null exactly when the shape has no target', (spec) => {
    const targetless = TARGETLESS_SHAPES.includes(spec.shape);
    expect(spec.attr === null).toBe(targetless);
  });

  // `writeSite: 'fieldLoop'` is what enrols a row in `bpmn-xml.js`'s generic loop, and the loop
  // writes `attrs[attr] = value` — so a row that joins it and is not a plain attribute would emit
  // something structurally wrong. Enforced here rather than trusted at the write site.
  test.each(ALL_ROWS.filter((s) => s.writeSite === 'fieldLoop'))(
    '$table $field: a fieldLoop row is a plain attribute, guarded by the table', (spec) => {
      expect(spec.shape).toBe('attr');
      expect(spec.enforcedBy).toBe('table');
    });

  // The converse of `bpmn-xml.js`'s `fieldAllowedOn`, which throws on an unknown field: every
  // guarded row must be reachable by name, or a write site's guard silently disappears.
  test.each(OMG_NODE_FIELD_SCOPE)('nodeFieldSpec finds $field', (spec) => {
    expect(nodeFieldSpec(spec.field)).toBe(spec);
  });

  test('nodeFieldSpec does not invent a row for an unknown field', () => {
    expect(nodeFieldSpec('notARealField')).toBeUndefined();
  });

  test('no field is registered twice, in either table', () => {
    for (const table of [OMG_NODE_FIELD_SCOPE, OMG_EDGE_FIELD_SCOPE]) {
      const names = table.map((s) => s.field);
      expect(names.length).toBe(new Set(names).size);
    }
  });
});

describe('the scoped-field fence — the tables and input-schema.json agree on every field and type', () => {
  const nodeProps = loadNodeFieldTypes();
  const edgeProps = loadEdgeFieldTypes();

  // The two properties that are not "a field" at all: `id` is identity and `type` is the
  // discriminator every row's `allowed` is expressed in terms of. An Edge has no `type`.
  const NODE_NON_FIELDS = new Set(['id', 'type']);
  const EDGE_NON_FIELDS = new Set(['id']);

  // THE completeness check, and the reason this stage exists. `references/input-schema.json`
  // declares 31 Node properties flat on every type, with zero conditional keywords — that is why
  // any of them can reach the serialiser on any class. A property the schema declares and the table
  // does not register is a field with no stated authority: nothing says which class may carry it,
  // nothing says whether it survives a round trip, and both facts then get re-decided ad hoc at
  // each of the four places that touch it. Adding a property to the schema now fails CI naming
  // itself.
  test('every $defs.Node property except id/type has a row', () => {
    const declared = Object.keys(nodeProps).filter((k) => !NODE_NON_FIELDS.has(k)).sort();
    const registered = OMG_NODE_FIELD_SCOPE.map((s) => s.field).sort();
    expect(registered).toEqual(declared);
  });

  test('every $defs.Edge property except id has a row', () => {
    const declared = Object.keys(edgeProps).filter((k) => !EDGE_NON_FIELDS.has(k)).sort();
    const registered = OMG_EDGE_FIELD_SCOPE.map((s) => s.field).sort();
    expect(registered).toEqual(declared);
  });

  // The schema's own way of saying what shape a value has, translated to the table's `type`
  // vocabulary. Read rather than restated, for the reason the whole file is built on — but the
  // translation is deliberately narrow: `$ref`/`enum` resolve to the JavaScript type of their
  // members, `oneOf` resolves to `'mixed'` (the table's word for "no single JavaScript type"), and
  // anything else returns null so the assertion below says "unhandled" instead of passing.
  function schemaValueType(schema, def) {
    if (!def) return null;
    if (def.$ref) {
      const target = def.$ref.replace('#/$defs/', '');
      return schemaValueType(schema, schema.$defs?.[target]);
    }
    if (def.oneOf) return 'mixed';
    if (def.enum) return typeof def.enum[0];
    if (def.type === 'array') return 'array';
    if (['boolean', 'string', 'object'].includes(def.type)) return def.type;
    return null;
  }

  const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));

  test.each(OMG_NODE_FIELD_SCOPE)('$field: the table\'s type matches the schema\'s', (spec) => {
    expect(spec.type).toBe(schemaValueType(schema, nodeProps[spec.field]));
  });

  test.each(OMG_EDGE_FIELD_SCOPE)('edge $field: the table\'s type matches the schema\'s', (spec) => {
    expect(spec.type).toBe(schemaValueType(schema, edgeProps[spec.field]));
  });
});

describe('matchesFieldType — the one answer both the serialiser and S15 use', () => {
  test('array and object are distinguished, which typeof cannot do', () => {
    expect(matchesFieldType([], 'array')).toBe(true);
    expect(matchesFieldType({}, 'array')).toBe(false);
    expect(matchesFieldType({}, 'object')).toBe(true);
    expect(matchesFieldType([], 'object')).toBe(false);
  });

  test('mixed accepts both shapes of a oneOf field — stated, not silently permissive', () => {
    expect(matchesFieldType('standard', 'mixed')).toBe(true);
    expect(matchesFieldType({ testBefore: true }, 'mixed')).toBe(true);
  });

  test('boolean and string are still exact', () => {
    expect(matchesFieldType('yes', 'boolean')).toBe(false);
    expect(matchesFieldType(true, 'boolean')).toBe(true);
    expect(matchesFieldType(1, 'string')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// The OMG-metamodel fence: every `allowed` set that has a metamodel counterpart, vs. bpmn-moddle's
// own metamodel.
//
// Every other fence in this file checks the tables against THEMSELVES or against our own schema, so
// all of them only ever catch an `allowed` set that is too WIDE. The round-trip oracle in
// pipeline.test.js catches the same direction from the other side (bpmn-moddle answers
// `unknown attribute <…>` for an attribute a class may not carry). Nothing caught the opposite
// mistake — a class OMG genuinely grants the field to that `allowed` omits — because bpmn-moddle is
// necessarily silent about an attribute we never emit. That gap has now been live twice:
// `isEventSubProcess` allowed `subProcess` alone while Transaction inherits `triggeredByEvent`; and
// `instantiate` allowed `eventBasedGateway` alone while OMG grants it to `ReceiveTask` too, so an
// instantiating Receive Task — the standard way to start a process on an incoming message without a
// message start event — could not be expressed at all. The second one was found by widening this
// fence from six hand-picked rows to every row with a metamodel counterpart, and it failed on
// `instantiate` before a line of the widening was written.
//
// The oracle is `bpmn-moddle`'s shipped metamodel, already a runtime dependency, read here rather
// than restated. BOTH metamodel files are read: `bpmn.json` for the semantics and `bpmndi.json` for
// the two rows whose emission target is a `<bpmndi:BPMNShape>` — a DI claim deserves the same
// external check as a semantic one, and `BPMNShape#isExpanded` is right there to check it against.
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
// callers that only ever see Logic-Core nodes, so a class the schema cannot express and
// `bpmnXmlTag` cannot emit is a type about which no caller can be right or wrong. Making a claim
// about it would be untestable through this project's own surface. The consequence is explicit and
// worth stating rather than hiding: `adHocSubProcess` is invisible to this fence on BOTH sides, so
// `isCompensation`'s `allowed` (= ACTIVITY_TYPES, which contains it) passes and
// `isEventSubProcess`'s (which deliberately does not) passes too. The existing
// `ALLOWLISTED_NON_ENUM_TYPES` fence below is what keeps that exception from silently growing, and
// `types.js`'s comment on the `isEventSubProcess` entry records why granting it there would emit
// invalid XML today.
//
// **Which rows the strict two-directional comparison covers, and why not the rest.** It covers
// every row — of either table — whose `on` is `'self'` and whose `attr` names a property the
// metamodel actually has. That is deliberately wider than `shape: 'attr'`: `marker`'s
// `eventDefinitions`, `loopType`/`multiInstance`'s `loopCharacteristics`, `script`, `documentation`
// and `has_join`'s `gatewayDirection` are all real metamodel properties whose per-class scope is
// exactly as checkable as a plain attribute's, and leaving them out would have meant hand-stating
// six class scopes that an oracle was sitting right there to derive.
//
// The remainder is not skipped, it is checked differently:
//   - `on !== 'self'` — `allowed` names the Logic-Core AUTHORING node (for `isCollection`, the
//     reference; for `lane`, the member; for `isDefault`, the source), while the property lives on
//     another element entirely. So the fence checks the OMG side of that indirection instead: the
//     class named by `on` really carries `attr`. `isDefault`'s `on: 'sourceGateway'` is the one
//     case where `allowed` is ALSO metamodel-checkable — it names real classes — and it is checked
//     in both directions like a `'self'` row.
//   - `shape: 'extension'` — `decisionRef` lives in our own namespace precisely because BPMN 2.0
//     has no attribute for it, so "the metamodel does not know this name" is the row's premise,
//     not a finding. Exempted by shape rather than by an allowlist entry, so the exemption cannot
//     be borrowed by an unrelated row.
//   - `attr: null` — nothing is written, so there is nothing to scope.
//   - foreign-namespace attribute names (`bioc:`) — a de-facto bpmn.io/Camunda convention, not part
//     of OMG's metamodel at all. Exempted, with the prefix itself asserted so that a typo'd
//     `bpmn:`-prefixed name cannot buy the same exemption.
describe('the OMG-metamodel fence — no `allowed` set is too wide OR too narrow', () => {
  const require = createRequire(import.meta.url);
  const METAMODEL = require('bpmn-moddle/resources/bpmn/json/bpmn.json');
  const DI_METAMODEL = require('bpmn-moddle/resources/bpmn/json/bpmndi.json');

  const allTypes = [...METAMODEL.types, ...DI_METAMODEL.types];
  const byName = new Map(allTypes.map((t) => [t.name, t]));

  test('the metamodel fixture itself is non-trivial — a silent empty read must not pass this fence', () => {
    expect(METAMODEL.types.length).toBeGreaterThan(100);
    expect(byName.has('SubProcess')).toBe(true);
    expect(byName.has('Transaction')).toBe(true);
    expect(byName.has('BPMNShape')).toBe(true);
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
  // `on` is spelled in Logic-Core's initial-lowercase style; the metamodel spells classes
  // initial-uppercase. That is a straight inversion for `dataObject` -> `DataObject`, but not for
  // the acronym classes: BPMNDI's shape is `BPMNShape`, not `BpmnShape`. So the lookup is resolved
  // case-insensitively against the real class names rather than by a capitalisation rule that is
  // right most of the time — a rule that is right most of the time is how `on` values would start
  // being chosen to please the fence instead of to name the element.
  const byLowerName = new Map(allTypes.map((t) => [t.name.toLowerCase(), t.name]));
  const toClassName = (name) => byLowerName.get(name.toLowerCase()) ?? (name.charAt(0).toUpperCase() + name.slice(1));
  const existsInMetamodel = (attr) => allTypes.some((t) => (t.properties || []).some((p) => p.name === attr));
  const isForeign = (attr) => attr.includes(':');

  const universe = new Set(loadNodeTypeEnum());
  const inUniverse = (types) => [...types].filter((t) => universe.has(t)).sort();
  const grantedTo = (attr) => allTypes.filter((t) => carries(t.name, attr)).map((t) => toLogicCoreType(t.name));

  // The strict, two-directional comparison. `on: 'self'` for a node row means the node's own
  // element; for an edge row `'sourceGateway'` means the source node's element — same question,
  // "which node classes may carry this", so the same comparison applies.
  const SELF_SCOPED = new Set(['self', 'sourceGateway']);
  const strictRows = ALL_ROWS.filter((s) => SELF_SCOPED.has(s.on)
    && attrsOf(s).length === 1
    && !isForeign(s.attr)
    && s.shape !== 'extension'
    && existsInMetamodel(s.attr));

  test('the strict comparison actually covers the table, rather than quietly matching nothing', () => {
    // A guard on the guard: if a refactor broke `existsInMetamodel` or renamed `on`, `strictRows`
    // would silently empty and every case below would vanish with it — a fence that passes by
    // checking nothing, which is the one failure shape a fence must not have.
    expect(strictRows.length).toBeGreaterThan(15);
    expect(strictRows.map((s) => s.field)).toContain('instantiate');
    expect(strictRows.map((s) => s.field)).toContain('isDefault');
  });

  test.each(strictRows)('$table $field: allowed matches every NodeType bpmn-moddle grants $attr to', (spec) => {
    const fromMetamodel = grantedTo(spec.attr);
    // Sanity: the attribute must exist somewhere in the metamodel at all. Without this, a typo in
    // `attr` would make both sides empty on the metamodel side and the fence would pass by
    // comparing nothing — the exact failure shape a fence must not have.
    expect(fromMetamodel.length).toBeGreaterThan(0);
    expect(inUniverse(spec.allowed)).toEqual(inUniverse(fromMetamodel));
  });

  // The indirection rows. `allowed` has no metamodel counterpart here (it names the authoring node,
  // not the class the property lives on), so what IS checkable is the other half of the row: that
  // the class named by `on` genuinely carries every property `attr` names.
  const indirectRows = ALL_ROWS.filter((s) => !SELF_SCOPED.has(s.on) && attrsOf(s).some((a) => !isForeign(a)));

  test.each(indirectRows)('$table $field: the emission target "$on" is a real class that carries $attr', (spec) => {
    expect(byName.has(toClassName(spec.on))).toBe(true);
    for (const attr of attrsOf(spec).filter((a) => !isForeign(a))) {
      expect([attr, carries(toClassName(spec.on), attr)]).toEqual([attr, true]);
    }
  });

  // A row whose `on` is `'self'` and whose `attr` the metamodel does not know is either a genuine
  // non-OMG mechanism or a typo. The two are told apart by `shape`, and only `'extension'` (our own
  // namespace, no OMG counterpart by definition) is a legitimate answer.
  test('every self-scoped row whose attr the metamodel does not know is declared `shape: extension`', () => {
    const unknown = ALL_ROWS
      .filter((s) => SELF_SCOPED.has(s.on) && attrsOf(s).length > 0)
      .filter((s) => attrsOf(s).some((a) => !isForeign(a) && !existsInMetamodel(a)))
      .filter((s) => s.shape !== 'extension')
      .map((s) => `${s.table} ${s.field}: attr=${s.attr}`);
    expect(unknown).toEqual([]);
  });

  test('every `on` value names a real class in one of the two metamodels, or is "self"', () => {
    const bad = ALL_ROWS
      .filter((s) => s.on !== 'self' && s.on !== 'sourceGateway' && !byName.has(toClassName(s.on)))
      .map((s) => `${s.table} ${s.field}: on=${s.on}`);
    expect(bad).toEqual([]);
  });

  // The only foreign-namespace prefix any row is allowed to claim. Without this, `bpmn:isExpanded`
  // or a mistyped `bpnm:fill` would be exempted from every check above by the mere presence of a
  // colon.
  test('the only foreign attribute namespace in either table is `bioc:`', () => {
    const prefixes = ALL_ROWS.flatMap(attrsOf).filter(isForeign).map((a) => a.split(':')[0]);
    expect([...new Set(prefixes)]).toEqual(['bioc']);
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

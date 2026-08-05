/**
 * Stage 5 — the round-trip fence: Decision-Core → DMN XML → Decision-Core.
 *
 * Stage 4's fences (`import.test.js`, `import-coverage.test.js`) check what the importer does with a
 * FOREIGN file. This one checks the far side: that our OWN output is re-readable, and that the
 * representable subset is exact. Both are needed and neither implies the other — a writer that
 * silently dropped `aggregation` would leave every foreign-file fence green.
 *
 * TWO HALVES, and the first is what earns the second.
 *
 *   1. COMPLETENESS. `tests/fixtures/dmn/roundtrip-all-fields.json` instantiates every property
 *      declared anywhere in `references/decision-core-schema.json`, and the check DERIVES the
 *      required set from the schema rather than restating it. That is what makes a new schema
 *      property fail CI naming itself, which is the property that let this plan decline a DMN
 *      field-authority table (no `DMN_NODE_FIELD_SCOPE` mirroring `bpmn/types.js`'s
 *      `OMG_NODE_FIELD_SCOPE`). A hand-written list of fields to exercise would deliver nothing:
 *      it would be the same person forgetting the same field twice.
 *
 *   2. THE ROUND TRIP over that fixture. Because half 1 holds, "the round trip is exact" is a
 *      statement about the whole model rather than about whichever fields the fixture happened to
 *      carry.
 *
 * WHAT THIS FILE ASSERTS RATHER THAN WISHES FOR. Three claims in the stage brief turned out to be
 * false as written, measured here rather than argued around. Each is pinned by a test of its own, so
 * it reads as a finding in the suite and cannot quietly become a tolerance:
 *
 *   - `report.lossless === true` is UNREACHABLE for our own output, for two reasons that are both by
 *     design and both already stated in `import-scope.js`: our writer always emits a `<dmndi:DMNDI>`
 *     tree (IM06), and it GENERATES the `<variable>`/`<literalExpression>` ids the importer then
 *     reports as unrepresented (IM05). Every one of those is content the writer regenerates
 *     identically on the next emit — so the honest claim is "no finding OUTSIDE those two classes",
 *     and that is asserted positively below.
 *   - `xml₁ === xml₂` does NOT hold, and the cause is not the DRG: the two documents are
 *     byte-identical up to `<dmndi:DMNDI>` and differ only in the ORDER of `<dmndi:DMNEdge>`
 *     children, because `buildDmnDiagrams` keys `edgeCoords` in `dc.requirements` array order while
 *     the importer rebuilds that array grouped by target. So the fixed point is reached one step
 *     later, and `xml₂ === xml₃` is the claim that has no ordering ambiguity.
 *   - `$schemaVersion` does not survive at all. It is a finding, kept in the fixture and asserted AS
 *     A LOSS in its own test.
 *
 * The fixture is NOT trimmed to make any of these pass, and nothing was added to
 * `canonicalizeDecisionCore` to reclassify a loss as a representational choice. See the stage report.
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { runDmnPipeline } from './pipeline.js';
import { dmnToDecisionCore, applyDecisionCoreDefaults, canonicalizeDecisionCore } from './import.js';
import { validateDecisionCoreSchema } from './schema-gate.js';
import { requirementKey } from './coordinates.js';
import { decisionCoreSchemaPath } from '../shared/resource-paths.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, '..', '..', 'tests', 'fixtures', 'dmn', 'roundtrip-all-fields.json');

const SCHEMA = JSON.parse(readFileSync(decisionCoreSchemaPath(), 'utf8'));
const readFixture = () => JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// The schema walk — one traversal, two consumers
// ═══════════════════════════════════════════════════════════════════════════════════════════════
//
// `declaredProperties` walks the SCHEMA alone; `instantiatedProperties` walks the schema and an
// INSTANCE in lockstep. They are deliberately the same shape, because the completeness check is the
// set difference between them and a divergence in how the two navigate would show up as a phantom
// gap (or, worse, as a phantom coverage).
//
// A type's name is its `$defs` key where it has one, and its JSON-pointer-ish path where it does not
// (`Node.parameters[]`, `DecisionTable.annotations[]`). Anonymous object schemas are INCLUDED rather
// than skipped: they declare properties too, and "every declared property" with a carve-out for the
// inline ones would be exactly the kind of exclusion this fence exists to refuse.

/** The applicator keywords the two walks below implement. See the premise test for why this list matters. */
const HANDLED_APPLICATORS = ['$ref', 'oneOf', 'items'];

// How the premise scan navigates a JSON Schema. It has to be schema-AWARE rather than a blind
// key sweep, and the two reasons are both live in this schema: `DecisionRule` declares a property
// literally named `then`, and every object closes itself with `additionalProperties: false`. A blind
// sweep reports both as applicators — the first is a property NAME, the second is the keyword in its
// non-applicator form (a boolean, not a subschema).
const SUBSCHEMA_MAPS = ['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas'];
const SUBSCHEMA_LISTS = ['oneOf', 'anyOf', 'allOf', 'prefixItems'];
const SUBSCHEMA_SINGLE = ['items', 'not', 'if', 'then', 'else', 'contains', 'additionalProperties',
  'propertyNames', 'unevaluatedItems', 'unevaluatedProperties'];
const ALL_APPLICATORS = ['$ref', ...SUBSCHEMA_LISTS, ...SUBSCHEMA_SINGLE, 'patternProperties',
  'dependentSchemas'];

/**
 * Resolve a subschema, THROWING on a `$ref` this walk cannot follow.
 *
 * FAILING LOUD IS THE WHOLE POINT, and the earlier revision failed OPEN in exactly the way the
 * premise test's own comment says it exists to prevent. `SCHEMA.$defs[name]` returning `undefined`
 * left both walks bailing at their `if (!s …)` guard, which removed the type from `declared` and
 * `present` ALIKE — so the set difference stayed empty and the completeness check passed having
 * required nothing. Measured: moving `$defs.DecisionRule` into a draft-07-style `definitions` block,
 * re-pointing `DecisionTable.properties.rules.items.$ref` at `#/definitions/DecisionRule` and adding
 * a brand-new `brandNewNeverUsed` property to it left all 15 tests green — and the schema gate green
 * too, because ajv resolves that pointer perfectly well. The fence had zero coverage of an entire
 * `$defs` type and said nothing.
 *
 * The premise test cannot catch this: `$ref` is in `HANDLED_APPLICATORS`, and its value is a string
 * so the `appliesSubschema` test never even considers it. `'definitions'` was already in
 * `SUBSCHEMA_MAPS` for that scan while this function handled only `$defs` — the inconsistency was
 * internal to this file, which is why the guard belongs here, at the one place that resolves.
 *
 * A pointer form this walk does not implement is a schema change that must be TAUGHT to the walk,
 * not absorbed by it.
 */
const REF_PREFIX = '#/$defs/';

function deref(node) {
  if (node && typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (!ref.startsWith(REF_PREFIX)) {
      throw new Error(`roundtrip.test.js: $ref "${ref}" is not of the form "${REF_PREFIX}<name>", which is `
        + 'the only pointer form the completeness walks resolve. Teach `deref` the new form before '
        + 'using it in decision-core-schema.json — silently skipping it would remove the whole type '
        + 'from BOTH the declared and the instantiated set, and the completeness check would pass '
        + 'having required nothing.');
    }
    const name = ref.slice(REF_PREFIX.length);
    const schema = SCHEMA.$defs?.[name];
    if (!schema) {
      // Belt to the prefix check's braces. This half is already unreachable in practice: a
      // `#/$defs/<name>` pointing at nothing makes ajv fail to compile the schema, and `schema-gate.js`
      // compiles at module load, so the whole suite fails to run before this line is reached
      // (measured). The prefix check above is the one that catches the case ajv is HAPPY with —
      // a well-formed pointer into a location this walk does not follow.
      throw new Error(`roundtrip.test.js: $ref "${ref}" resolves to nothing — decision-core-schema.json `
        + `declares no $defs.${name}.`);
    }
    return { schema, name };
  }
  return { schema: node, name: null };
}

/**
 * typeName → `{ schema, properties: Set<string> }`.
 *
 * The schema object is handed back rather than re-derived by the callers, so the `type`-enum check
 * below does not have to reconstruct a `$ref` from a type NAME — which for an anonymous type
 * (`Node.parameters[]`) it cannot do, and which under the new throwing `deref` would fail rather
 * than silently skip.
 */
function declaredProperties() {
  const out = new Map();
  const visit = (node, fallbackName) => {
    const { schema: s, name } = deref(node);
    const typeName = name ?? fallbackName;
    if (!s || typeof s !== 'object') return;
    if (s.properties) {
      if (out.has(typeName)) return;                   // a $defs type reached twice is the same type
      out.set(typeName, { schema: s, properties: new Set(Object.keys(s.properties)) });
      for (const [k, sub] of Object.entries(s.properties)) visit(sub, `${typeName}.${k}`);
    }
    if (s.items) visit(s.items, `${typeName}[]`);
    for (const branch of s.oneOf ?? []) visit(branch, typeName);
  };
  visit(SCHEMA, 'root');
  return out;
}

/**
 * typeName → `{ properties: Set<string>, enumValues: Map<property, Set<value>> }` — what instances
 * inside `doc` actually carry.
 *
 * `enumValues` is collected on the SAME traversal rather than by a second sweep, and that is the fix
 * for a real hole: the earlier `type`-enum check gathered every `.type` string found ANYWHERE in the
 * document into one global set, so `Node.type` was satisfied by a Requirement's `"authority"` and
 * `Requirement.type` by a Node's `"decision"`. Measured — adding `"authority"` to `Node.type.enum`
 * and `"decision"` to `Requirement.type.enum`, two entirely unexercised element classes, left all 15
 * tests green. This walk is already type-keyed; that check was the one place the file's stated "one
 * traversal, two consumers" design was violated.
 */
function instantiatedProperties(doc) {
  const out = new Map();
  const entry = (typeName) => {
    if (!out.has(typeName)) out.set(typeName, { properties: new Set(), enumValues: new Map() });
    return out.get(typeName);
  };
  const record = (typeName, prop, value, sub) => {
    const e = entry(typeName);
    e.properties.add(prop);
    // Values are kept only where the schema constrains the property to an enum — the rest are free
    // text and a set of them would say nothing.
    if (!Array.isArray(sub?.enum) || typeof value !== 'string') return;
    if (!e.enumValues.has(prop)) e.enumValues.set(prop, new Set());
    e.enumValues.get(prop).add(value);
  };
  const visit = (value, node, fallbackName) => {
    const { schema: s, name } = deref(node);
    const typeName = name ?? fallbackName;
    if (!s || value == null) return;
    if (s.properties && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, sub] of Object.entries(s.properties)) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
        record(typeName, k, value[k], sub);
        visit(value[k], sub, `${typeName}.${k}`);
      }
    }
    if (s.items && Array.isArray(value)) for (const item of value) visit(item, s.items, `${typeName}[]`);
    // A `oneOf` branch is followed when the instance matches its `type`. Nothing here validates —
    // ajv already did, at the schema gate — so a cheap type test is enough to pick the branch whose
    // properties could have been instantiated.
    for (const branch of s.oneOf ?? []) {
      if (branch.type === 'array' && Array.isArray(value)) visit(value, branch, typeName);
      else if (branch.type && branch.type !== 'array' && typeof value === branch.type) visit(value, branch, typeName);
    }
  };
  visit(doc, SCHEMA, 'root');
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1. Completeness — derived from the schema, never from a hand-written list
// ═══════════════════════════════════════════════════════════════════════════════════════════════

describe('roundtrip-all-fields.json — completeness against decision-core-schema.json', () => {
  test('the fixture passes the schema gate', () => {
    const result = validateDecisionCoreSchema(readFixture());
    expect([result.valid, result.errors ?? []]).toEqual([true, []]);
  });

  // THE PREMISE the two walks rest on, asserted rather than assumed — the same move
  // `bpmn/field-fidelity.test.js` makes for its own flat-properties assumption, and needed more
  // here because this schema genuinely uses applicators (`$ref` throughout, `oneOf` on
  // `usingTask`/`usingProcess`). A property introduced under an `allOf` or an `if`/`then` would be
  // invisible to `declaredProperties`, and the completeness check would go green while the fixture
  // exercised nothing. So a keyword the walks do not implement must fail here, loudly, BEFORE it can
  // shrink the fence in silence.
  test('the schema uses only applicator keywords the walks implement, and closes every object', () => {
    const found = new Set();
    const unclosed = [];
    const scan = (node, where) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      // `additionalProperties: false` is what makes `Object.keys(properties)` the TOTAL set of a
      // type's fields — without it, "every declared property is instantiated" would be silent about
      // whatever else an instance may legally carry. Asserted here, at the head of the walk that
      // depends on it.
      if (node.properties && node.additionalProperties !== false) unclosed.push(where);
      for (const [k, v] of Object.entries(node)) {
        // A keyword in its non-applicator form (`additionalProperties: false`) applies no subschema
        // and constrains nothing the walks must follow.
        const appliesSubschema = typeof v === 'object' && v !== null;
        if (ALL_APPLICATORS.includes(k) && !HANDLED_APPLICATORS.includes(k) && appliesSubschema) found.add(k);
        if (SUBSCHEMA_MAPS.includes(k)) for (const [name, sub] of Object.entries(v)) scan(sub, `${where}.${k}.${name}`);
        else if (SUBSCHEMA_LISTS.includes(k)) (v ?? []).forEach((sub, i) => scan(sub, `${where}.${k}[${i}]`));
        else if (SUBSCHEMA_SINGLE.includes(k)) scan(v, `${where}.${k}`);
      }
    };
    scan(SCHEMA, '#');
    expect(['unhandled applicator keywords — teach the walks in roundtrip.test.js the new shape '
      + 'before adding one', [...found].sort(), 'object schemas not closed with additionalProperties: false', unclosed])
      .toEqual(['unhandled applicator keywords — teach the walks in roundtrip.test.js the new shape '
        + 'before adding one', [], 'object schemas not closed with additionalProperties: false', []]);
  });

  test('every declared property of every schema type is instantiated at least once', () => {
    const declared = declaredProperties();
    const present = instantiatedProperties(readFixture());
    const missing = [];
    for (const [typeName, { properties }] of declared) {
      const have = present.get(typeName)?.properties ?? new Set();
      for (const prop of properties) if (!have.has(prop)) missing.push(`${typeName}.${prop}`);
    }
    expect(['schema properties no instance in tests/fixtures/dmn/roundtrip-all-fields.json carries '
      + '— add them there (and, if they turn out not to survive the round trip, report the loss '
      + 'rather than removing them again)', missing.sort()])
      .toEqual(['schema properties no instance in tests/fixtures/dmn/roundtrip-all-fields.json carries '
        + '— add them there (and, if they turn out not to survive the round trip, report the loss '
        + 'rather than removing them again)', []]);
  });

  // Enum VALUES, for the two enums whose members are element CLASSES rather than modes.
  //
  // Why those two and not every enum in the schema: `Node.type` and `Requirement.type` decide what
  // KIND of thing an instance is, and each kind takes a different path through writer and importer
  // (`buildDrgElement`'s four branches, `attachRequirements`' three) — an unexercised member is an
  // unexercised code path. `hitPolicy`, `aggregation` and `preferredOrientation` decide how ONE
  // element behaves and share a single path (`readOwn` over an attribute list), so exhausting them
  // would force an absurd fixture — a CrossTable, a RULE ORDER table — for no coverage at all.
  //
  // The selector is mechanical (`the enum named `type``) rather than a list of two pointers, so a
  // third discriminator added later is covered the day it lands.
  //
  // Values are read from `instantiatedProperties`' own type-keyed traversal, NOT gathered globally.
  // The earlier revision collected every `.type` string found anywhere in the document into one set,
  // which made the two enums satisfy each other: measured, adding `"authority"` to `Node.type.enum`
  // and `"decision"` to `Requirement.type.enum` — two element classes the fixture does not contain —
  // left every test green, because a Requirement carries `"authority"` and a Node carries
  // `"decision"`. Disjoint enums made that harmless today and would not have kept it harmless.
  test('every value of every `type` enum appears on an instance OF THAT TYPE', () => {
    const declared = declaredProperties();
    const present = instantiatedProperties(readFixture());
    const uninstantiated = [];
    const checked = [];
    for (const [typeName, { schema }] of declared) {
      const enumValues = schema.properties?.type?.enum;
      if (!enumValues) continue;
      checked.push(typeName);
      const seen = present.get(typeName)?.enumValues.get('type') ?? new Set();
      for (const value of enumValues) if (!seen.has(value)) uninstantiated.push(`${typeName}.type = "${value}"`);
    }
    // Vacuity guard: a refactor that stopped finding any `type` enum would otherwise leave this test
    // green while checking nothing. Not pinned to an exact list of type names — the selector is meant
    // to pick up a third discriminator without being edited.
    expect(checked.length).toBeGreaterThan(0);
    expect([`\`type\` enum values no instance of its own type carries (checked: ${checked.sort().join(', ')})`,
      uninstantiated.sort()])
      .toEqual([`\`type\` enum values no instance of its own type carries (checked: ${checked.sort().join(', ')})`,
        []]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. The round trip
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * `dc.requirements` is compared ORDER-INDEPENDENTLY, and this is the stage's second judgment call.
 *
 * `dmn-xml.js`'s `attachRequirements` iterates `dc.requirements` once and pushes each into a
 * per-TARGET collection, so only WITHIN-target order reaches the XML; the importer rebuilds the flat
 * array by walking targets and then kinds. Two arrays that differ only in that permutation are the
 * same document, and the XML proves it — see the DRG-half byte comparison below.
 *
 * Sorted HERE rather than normalised inside `canonicalizeDecisionCore`, deliberately. That function
 * is called by production consumers of the importer, and a sort there would silently reorder every
 * caller's requirements to hide a difference only this test cares about — while also destroying the
 * one thing the order DOES still control, which is the emission order of `<dmndi:DMNEdge>` (the
 * xml₁/xml₂ non-identity below). A normalisation is a claim that something is representational; this
 * one would be a claim about the comparison, not about the model, and it belongs where the
 * comparison is.
 */
const sortRequirements = (dc) => (dc.requirements
  ? { ...dc, requirements: [...dc.requirements].sort((a, b) => requirementKey(a).localeCompare(requirementKey(b))) }
  : dc);

/** The document up to `<dmndi:DMNDI>` — everything that carries meaning rather than geometry. */
const drgHalf = (xml) => xml.slice(0, xml.indexOf('<dmndi:DMNDI'));

describe('Decision-Core → DMN XML → Decision-Core', () => {
  let fixture, first, xml1, dc, report, second, xml2, xml3;

  beforeAll(async () => {
    fixture = readFixture();
    first = await runDmnPipeline(fixture);
    xml1 = first.xml;

    ({ dc, report } = await dmnToDecisionCore(xml1));

    second = await runDmnPipeline(dc);
    xml2 = second.xml;

    const { dc: dc2 } = await dmnToDecisionCore(xml2);
    const third = await runDmnPipeline(dc2);
    xml3 = third.xml;
  });

  // All FOUR channels, on both emits. The earlier revision was named for this and asserted only
  // `report.parserWarnings` — which is a fifth thing entirely (the IMPORTER's moddle warnings), so
  // the guard was a name rather than a check. Nothing was broken behind it; that is not the same as
  // it having been checked. A fixture that instantiates every field is exactly the one most likely
  // to trip a rule or to place an element the serialiser objects to, and a warning in any of these
  // would mean the round trip is being measured over a model the pipeline already complains about.
  test.each([['the first emit, from the fixture', () => first], ['the second emit, from the re-import', () => second]])(
    'the pipeline is silent on all four channels — %s', (_label, get) => {
      const result = get();
      expect({
        errors: result.validation.errors,
        warnings: result.validation.warnings,
        xmlWarnings: result.validation.xmlWarnings,
        diagnostics: result.diagnostics.issues,
      }).toEqual({ errors: [], warnings: [], xmlWarnings: [], diagnostics: [] });
    });

  test('the importer raises no parser warnings over our own output', () => {
    // The fifth channel, and a separate claim: dmn-moddle re-reading what dmn-moddle wrote. An
    // entry here would be the IM08 class — content the parser could not build an object for — on our
    // own file.
    expect(report.parserWarnings).toEqual([]);
  });

  test('the re-imported Decision-Core passes our own schema gate', () => {
    // The failure this pins is real and has a live sibling: `readDecisionTable` reads a rule's
    // `<description>` into `DecisionRule.documentation`, a property the schema does not declare, so
    // a foreign file carrying one imports into a `dc` this gate REJECTS. That path is unreachable
    // from our own writer (it emits no rule description), which is why this fixture cannot cover it
    // — see the stage report's finding list.
    const result = validateDecisionCoreSchema(dc);
    expect([result.valid, result.errors ?? []]).toEqual([true, []]);
  });

  test('everything except $schemaVersion survives the round trip unchanged', () => {
    const expected = canonicalizeDecisionCore(applyDecisionCoreDefaults(readFixture()).dc);
    // The one measured loss, removed from the EXPECTED side only, and asserted as a loss in its own
    // test below so that it cannot be mistaken for a tolerance. Deleting it from the fixture instead
    // would make this pass by removing the evidence.
    delete expected.$schemaVersion;
    expect(sortRequirements(canonicalizeDecisionCore(dc))).toEqual(sortRequirements(expected));
  });

  test('FINDING — $schemaVersion does not survive: the writer never emits it', () => {
    // Kept as a failing-on-fix assertion rather than as an exclusion: `dmn-xml.js` has no branch for
    // `$schemaVersion` and DMN 1.3 has no attribute for it, so the field is silently dropped on
    // every emit. If that is ever addressed, this test fails and names itself.
    expect(readFixture().$schemaVersion).toBe('1.0');
    expect(dc.$schemaVersion).toBeUndefined();
  });

  test('the XSD default materialised on import is exactly the one hitPolicy', () => {
    // `hitPolicy: "UNIQUE"` is dropped by moddle on write (its descriptor default) and put back by
    // `applyDecisionCoreDefaults` on read. This pins that it is the ONLY thing being put back —
    // without it, the equality above could be passing because a second default quietly papered over
    // a second loss.
    expect(report.defaultsMaterialised).toEqual([
      { path: 'nodes[4].decisionTable', attr: 'hitPolicy', value: 'UNIQUE' },
    ]);
  });
});

// ── report.lossless: what is actually claimable about our own output ────────────────────────────

describe('the import report over our own output', () => {
  let fixture, report;

  beforeAll(async () => {
    fixture = readFixture();
    const { xml } = await runDmnPipeline(fixture);
    ({ report } = await dmnToDecisionCore(xml));
  });

  /**
   * The two classes of finding our own writer necessarily produces, DERIVED from the fixture so a
   * fixture edit updates them:
   *
   *   IM06 anywhere under `definitions.dmnDI` — `generateDmnXml` always writes a DMNDI tree, and the
   *     importer drops diagram interchange by design (`import-scope.js`'s <DMNDI> row; IM06's own
   *     remedy says "import-then-emit returns a correct model with a differently arranged diagram").
   *   IM05 on a GENERATED id — `<node>_var` for every variable, `<node>_expr` for a literal
   *     decisionLogic (`dmn-xml.js`'s `nextDcId`). The <informationItem> and <literalExpression>
   *     rows both state that the writer regenerates the identical value on emit, which is why the
   *     xml₂/xml₃ fixed point below holds despite them.
   *
   * Neither is content the model lost — both are regenerated identically — which is the whole reason
   * `lossless: false` here is not the alarm it would be for a foreign file.
   */
  const generatedIdPaths = (fx) => {
    const paths = [];
    fx.nodes.forEach((node, i) => {
      if (node.type !== 'knowledgeSource' && (node.variable || node.typeRef)) paths.push(`definitions.drgElement[${i}].variable.id`);
      if (node.type === 'decision' && !node.decisionTable && node.expression != null) paths.push(`definitions.drgElement[${i}].decisionLogic.id`);
    });
    return paths;
  };

  test('FINDING — lossless is false for our own output, and only because of DI and generated ids', () => {
    const stray = report.unrepresented.filter((f) => !(
      (f.code === 'IM06' && f.path.startsWith('definitions.dmnDI'))
      || (f.code === 'IM05' && generatedIdPaths(fixture).includes(f.path))));
    // THE POSITIVE CLAIM this stage actually establishes, in place of the unreachable
    // `lossless === true`: no content of the model itself failed to survive.
    expect(['findings outside the two writer-generated classes', stray.map((f) => `${f.code} ${f.path}`)])
      .toEqual(['findings outside the two writer-generated classes', []]);
    expect(report.lossless).toBe(false);
  });

  test('the generated-id findings are exactly the ids the writer generates', () => {
    const im05 = report.unrepresented.filter((f) => f.code === 'IM05').map((f) => f.path).sort();
    expect(im05).toEqual(generatedIdPaths(fixture).sort());
  });
});

// ── the XML as the artefact ─────────────────────────────────────────────────────────────────────

describe('the XML is the artefact', () => {
  let xml1, xml2, xml3;

  beforeAll(async () => {
    const first = await runDmnPipeline(readFixture());
    xml1 = first.xml;
    const { dc } = await dmnToDecisionCore(xml1);
    xml2 = (await runDmnPipeline(dc)).xml;
    const { dc: dc2 } = await dmnToDecisionCore(xml2);
    xml3 = (await runDmnPipeline(dc2)).xml;
  });

  test('the semantic half of the document is byte-identical after a round trip', () => {
    // Everything up to <dmndi:DMNDI>: the decisions, their tables, every clause, every rule, every
    // requirement — in the same order, with the same ids and the same generated `_var`/`_expr`
    // values. This is the byte-level claim the stage is really after.
    expect(drgHalf(xml2)).toBe(drgHalf(xml1));
  });

  test('FINDING — xml₁ !== xml₂: the DMNEdge order follows dc.requirements array order', () => {
    // `buildDmnDiagrams` keys `edgeCoords` by walking `dc.requirements` in array order, and
    // `buildDmnDI` emits `<dmndi:DMNEdge>` in that key order — so the importer's target-grouped
    // rebuild of the array permutes the DI edge list. Same edges, same waypoints, different order.
    expect(xml2).not.toBe(xml1);
    const sortedLines = (x) => x.split('\n').map((l) => l.trim()).sort();
    expect(sortedLines(xml2)).toEqual(sortedLines(xml1));
  });

  test('one round trip reaches a fixed point — xml₂ === xml₃', () => {
    // The claim `xml₁ === xml₂` was meant to carry, stated where it is true: once the requirement
    // array has been through the importer's grouping once, it is stable, so every further round trip
    // is byte-for-byte identical. Nothing about the model degrades on repeated import/emit.
    expect(xml3).toBe(xml2);
  });
});

// ── judgment call 3: XSD validation of the field-complete fixture ────────────────────────────────
//
// YES, and the argument is coverage rather than symmetry with `dmn-xml.test.js`. This fixture is the
// only one that emits `@aggregation`, a multi-valued `<usingProcess>`, `<inputValues>` and
// `<defaultOutputEntry>` — four constructs whose ELEMENT ORDER inside their parent is fixed by the
// XSD's sequence and which nothing else in the suite places. dmn-moddle writes them in descriptor
// order and re-reads its own output regardless of whether that order is conformant, so the
// round-trip check above would stay green on a document a real tool rejects. xmllint is the only
// oracle here that is not us.

function xmllintAvailable() {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const xsdPath = path.resolve(HERE, '../../references/omg-spec/normative/dmn/DMN13.xsd');
const describeIfXmllint = (xmllintAvailable() && existsSync(xsdPath)) ? describe : describe.skip;

describeIfXmllint('the field-complete fixture against the normative XSD', () => {
  test('roundtrip-all-fields.json produces XSD-valid DMN 1.3', async () => {
    const { xml } = await runDmnPipeline(readFixture());
    expect(() => execFileSync('xmllint', ['--noout', '--schema', xsdPath, '-'], {
      input: xml, stdio: ['pipe', 'pipe', 'pipe'],
    })).not.toThrow();
  });
});

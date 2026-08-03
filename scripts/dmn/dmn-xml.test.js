import { describe, test, expect } from '@jest/globals';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DmnModdle } from 'dmn-moddle';

import { generateDmnXml, validateDmnXml, assertIdAllowed } from './dmn-xml.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../tests/fixtures/dmn');
const loadFixture = (name) => JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
const good = () => loadFixture('discount-decision.json');

/** A minimal one-node, zero-requirement diagram list — the smallest legal Task 3 output shape. */
const oneNodeDiagram = (nodeId) => [{
  id: 'DMNDiagram_1', name: 'Diagram 1', size: { w: 300, h: 200 },
  coordMap: { coords: { [nodeId]: { x: 10, y: 10, w: 180, h: 80 } }, edgeCoords: {} },
}];

describe('assertIdAllowed', () => {
  test('throws for a NO_ID_TYPE that carries an id', () => {
    expect(() => assertIdAllowed('dmn:DMNElementReference', { id: 'x1', href: '#d1' }))
      .toThrow(/must not carry an id/);
  });

  test('passes silently for a normal type with an id, and for a NO_ID_TYPE with no id', () => {
    expect(() => assertIdAllowed('dmn:Decision', { id: 'd1' })).not.toThrow();
    expect(() => assertIdAllowed('dmn:DMNElementReference', { href: '#d1' })).not.toThrow();
  });
});

describe('generateDmnXml — minimal Definitions', () => {
  test('a single decision with no logic produces required attributes and no drgElement children beyond it', async () => {
    const dc = { id: 'Definitions_1', name: 'Minimal', namespace: 'http://x/minimal',
      nodes: [{ id: 'd1', type: 'decision', name: 'D1' }] };
    const xml = await generateDmnXml(dc, oneNodeDiagram('d1'));
    expect(xml).toContain('namespace="http://x/minimal"');
    expect(xml).toContain('name="Minimal"');
    expect(xml).toContain('<dmn:decision id="d1" name="D1"');
    // No literal <decisionLogic> wrapper element — DMN13.xsd has no such element
    // (dmn13-xsd-ground-truth.md §F16); the slot serialises as whichever concrete
    // expression type is assigned, or is absent entirely when there is none.
    expect(xml).not.toMatch(/<[a-zA-Z]*:?decisionLogic[\s>]/);
  });

  test('name falls back to id when absent — tNamedElement requires it', async () => {
    const dc = { id: 'Definitions_1', namespace: 'http://x/minimal',
      nodes: [{ id: 'd1', type: 'decision', name: 'D1' }] };
    const xml = await generateDmnXml(dc, oneNodeDiagram('d1'));
    expect(xml).toContain('name="Definitions_1"');
  });

  test('a missing namespace throws rather than silently emitting XSD-invalid XML — tDefinitions/@namespace is required', async () => {
    // Reachable directly: the JSON schema requires `namespace` and normally gates this before it
    // reaches generateDmnXml, but generateDmnXml is exported and callable on its own (Task 6,
    // tests, future callers). Without this guard the function emits <dmn:definitions> with no
    // namespace attribute, validateDmnXml reports zero warnings (dmn-moddle's own round trip does
    // not notice the omission), and only xmllint against DMN13.xsd catches it downstream.
    const dc = { id: 'Definitions_1', name: 'No namespace',
      nodes: [{ id: 'd1', type: 'decision', name: 'D1' }] };
    await expect(generateDmnXml(dc, oneNodeDiagram('d1'))).rejects.toThrow(/namespace/i);
  });
});

describe('generateDmnXml — businessKnowledgeModel', () => {
  test('parameters and body serialise under encapsulatedLogic, round-trip through dmn-moddle', async () => {
    const dc = good(); // discount-decision.json — has bkm_loyaltyBonus with parameters + body
    const diagrams = oneNodeDiagram('bkm_loyaltyBonus');
    const xml = await generateDmnXml(dc, diagrams);
    const moddleForRead = new DmnModdle();
    const { rootElement, warnings } = await moddleForRead.fromXML(xml);
    expect(warnings).toEqual([]);
    const bkm = rootElement.get('drgElement').find((e) => e.id === 'bkm_loyaltyBonus');
    expect(bkm.encapsulatedLogic).toBeDefined();
    // tFunctionDefinition's expression slot is `body` (type dmn:Expression), not `expression` —
    // verified against the real descriptor (Task 5, Step 6a); the research had no coverage for
    // this type. The fixture's actual body text (tests/fixtures/dmn/discount-decision.json,
    // bkm_loyaltyBonus.body) — read it yourself before trusting this string if the fixture
    // ever changes; it does not contain the substring "loyaltyBonus".
    expect(bkm.encapsulatedLogic.body.text).toBe('if since < date("2020-01-01") then 5 else 0');
  });
});

describe('generateDmnXml — variable is never emitted on a knowledgeSource', () => {
  test('a knowledgeSource carrying typeRef produces no variable element and round-trips clean', async () => {
    const dc = {
      id: 'Definitions_1', name: 'KS typeRef test', namespace: 'http://x/ks-typeref',
      nodes: [{ id: 'ks1', type: 'knowledgeSource', name: 'KS 1', typeRef: 'string' }],
    };
    const xml = await generateDmnXml(dc, oneNodeDiagram('ks1'));
    expect(xml).not.toMatch(/<dmn:knowledgeSource\b[^>]*>\s*<dmn:variable\b/);
    const { warnings } = await validateDmnXml(xml);
    expect(warnings).toEqual([]);
  });
});

describe('generateDmnXml — attribute discipline: no id on the four id-less types', () => {
  test('annotation columns, annotation entries and every requirement reference carry no id attribute', async () => {
    const dc = good();
    const diagrams = oneNodeDiagram('dec_discountLevel');
    const xml = await generateDmnXml(dc, diagrams);
    // tRuleAnnotationClause (the "Note" column header) and tRuleAnnotation (each rule's
    // annotationEntry) — dc:DecisionTable/annotation and dmn:DecisionRule/annotationEntry.
    expect(xml).not.toMatch(/<dmn:annotation\b[^>]*\bid=/);
    expect(xml).not.toMatch(/<dmn:annotationEntry\b[^>]*\bid=/);
    // tDMNElementReference — every requiredInput/requiredDecision/requiredKnowledge/
    // requiredAuthority in this fixture (5 requirements of all 3 kinds).
    expect(xml).not.toMatch(/<dmn:required(Input|Decision|Knowledge|Authority)\b[^>]*\bid=/);
    // usingTask on dec_discountLevel is also a tDMNElementReference.
    expect(xml).not.toMatch(/<dmn:usingTask\b[^>]*\bid=/);
    // Round-trip must be clean — no "unknown attribute id" warnings, which is exactly the #36
    // mechanism: dmn-moddle parks an illegal attribute in $attrs and writes it straight back
    // out rather than rejecting it, so a warning here would be the discipline having failed.
    const { warnings } = await validateDmnXml(xml);
    expect(warnings).toEqual([]);
  });
});

describe('generateDmnXml — hitPolicy/preferredOrientation normalisation (measured, not assumed)', () => {
  test('matches the behaviour observed and recorded in tests/fixtures/dmn/README.md', async () => {
    const dc = good();
    const xml = await generateDmnXml(dc, oneNodeDiagram('dec_discountLevel'));
    const tableTagMatch = xml.match(/<dmn:decisionTable\b[^>]*>/);
    expect(tableTagMatch).not.toBeNull();
    const tableTag = tableTagMatch[0];
    expect(tableTag).not.toMatch(/hitPolicy=/);
    expect(tableTag).toContain('preferredOrientation="Rule-as-Row"');
  });
});

describe('generateDmnXml — DMNDiagram* loop runs for more than one diagram', () => {
  test('two diagrams sharing a node produce two DMNDiagram elements, each containing its own distinct shapes', async () => {
    const dc = good();
    // dec_discountLevel is deliberately in BOTH diagrams — the case C10 fixes: prior code
    // generated `${nodeId}_di` by plain interpolation, so two diagrams sharing a node emitted
    // the same DMNShape id twice (a real xsd:ID duplicate). Disjoint node sets, as this test used
    // to have, could never exercise that path.
    const diagrams = [
      { id: 'DMNDiagram_1', name: 'Overview', size: { w: 300, h: 200 },
        coordMap: { coords: { dec_discountLevel: { x: 10, y: 10, w: 180, h: 80 } }, edgeCoords: {} } },
      { id: 'DMNDiagram_2', name: 'Loyalty view', size: { w: 300, h: 200 },
        coordMap: { coords: {
          dec_discountLevel: { x: 10, y: 10, w: 180, h: 80 },
          bkm_loyaltyBonus: { x: 10, y: 100, w: 135, h: 46 },
        }, edgeCoords: {} } },
    ];
    const xml = await generateDmnXml(dc, diagrams);

    // Split into each <dmndi:DMNDiagram>...</dmndi:DMNDiagram> block so containment is checked
    // PER DIAGRAM, not "anywhere in the document" — the weakness in the prior version of this
    // test, which would still pass even if both shapes landed in the same diagram element.
    const blocks = [...xml.matchAll(
      /<dmndi:DMNDiagram\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/dmndi:DMNDiagram>/g
    )];
    expect(blocks.map((b) => b[1])).toEqual(['DMNDiagram_1', 'DMNDiagram_2']);
    const [block1, block2] = blocks.map((b) => b[2]);

    expect(block1).toMatch(/<dmndi:DMNShape\b[^>]*dmnElementRef="dec_discountLevel"/);
    expect(block1).not.toMatch(/dmnElementRef="bkm_loyaltyBonus"/);
    expect(block2).toMatch(/<dmndi:DMNShape\b[^>]*dmnElementRef="dec_discountLevel"/);
    expect(block2).toMatch(/<dmndi:DMNShape\b[^>]*dmnElementRef="bkm_loyaltyBonus"/);

    // The two shapes referencing the SAME node (dec_discountLevel, one per diagram) must not
    // share an xsd:ID — this is the duplicate-id case itself, not just a proxy for it.
    const shapeIds = [...xml.matchAll(/<dmndi:DMNShape\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(shapeIds).size).toBe(shapeIds.length);
    expect(shapeIds).toContain('dec_discountLevel_di');
    expect(shapeIds).toContain('dec_discountLevel_di_2');

    const { warnings } = await validateDmnXml(xml);
    expect(warnings).toEqual([]);
  });

  test('a node id ending in "_di" does not collide with its own generated DMNShape id', async () => {
    // Failure mode #1 from the review: a Decision-Core with nodes `foo` and `foo_di` used to
    // emit <dmn:decision id="foo_di"> AND <dmndi:DMNShape id="foo_di"> — two elements sharing
    // one xsd:ID. nextDcId/usedIds (added for _var/_expr by C7, extended to _di ids by C10) must
    // suffix the generated shape id instead of colliding with the node's own literal id.
    const dc = {
      id: 'Definitions_1', name: 'Di collision test', namespace: 'http://x/di-collision',
      nodes: [
        { id: 'foo', type: 'decision', name: 'Foo' },
        { id: 'foo_di', type: 'decision', name: 'Foo di' },
      ],
    };
    const diagrams = [{
      id: 'DMNDiagram_1', name: 'D1', size: { w: 300, h: 200 },
      coordMap: {
        coords: {
          foo: { x: 10, y: 10, w: 180, h: 80 },
          foo_di: { x: 10, y: 100, w: 180, h: 80 },
        },
        edgeCoords: {},
      },
    }];
    const xml = await generateDmnXml(dc, diagrams);

    const shapeIds = [...xml.matchAll(/<dmndi:DMNShape\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(shapeIds).size).toBe(shapeIds.length);
    // Neither generated shape id may equal the literal node id `foo_di` — that is exactly the
    // collision under test.
    expect(shapeIds).not.toContain('foo_di');

    const { warnings } = await validateDmnXml(xml);
    expect(warnings.filter((w) => /duplicate id/i.test(w))).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

/** Semantic field names actually present on a moddle element, excluding bookkeeping keys. */
function fieldsOf(moddleEl) {
  const skip = new Set(['$type', '$parent', '$descriptor', '$attrs', 'id']);
  const out = new Set();
  for (const [k, v] of Object.entries(moddleEl)) {
    if (skip.has(k)) continue;
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out.add(k);
  }
  return out;
}

/**
 * Assert that every field present on `srcObj` — a plain Decision-Core JS object taken directly
 * from the fixture, not a hand-picked list — reaches `moddleEl`'s field set (`fieldsOf`). `rename`
 * covers fields whose serialised name legitimately differs (e.g. Decision-Core's plural
 * `inputs` vs. moddle's `input`); `exclude` covers fields with no SAME-LEVEL XML counterpart at
 * all. Every `exclude`/`rename` entry is commented at its call site with why, per the review
 * finding that a static list can go stale silently: add a field to the fixture (or the schema)
 * with no entry here and this assertion fails on its own, naming exactly the field that did not
 * make the round trip — the completeness guarantee CLAUDE.md's "Adding a per-node field" section
 * asks for, and the reason Step 11 asked for a field-set comparison in the first place.
 */
function assertFieldsSurvive(srcObj, moddleEl, { rename = {}, exclude = new Set() } = {}) {
  const actual = fieldsOf(moddleEl);
  const expected = [...new Set(
    Object.keys(srcObj).filter((f) => !exclude.has(f)).map((f) => rename[f] ?? f)
  )];
  const missing = expected.filter((f) => !actual.has(f));
  expect(missing).toEqual([]);
}

describe('generateDmnXml — field-set round trip (discount-decision.json, full fixture)', () => {
  test('every populated field on dec_discountLevel survives write + re-read', async () => {
    const dc = good();
    const diagrams = oneNodeDiagram('dec_discountLevel');
    const xml = await generateDmnXml(dc, diagrams);
    const reader = new DmnModdle();
    const { rootElement, warnings } = await reader.fromXML(xml);
    expect(warnings).toEqual([]);

    const decision = rootElement.get('drgElement').find((e) => e.id === 'dec_discountLevel');
    const srcDecision = dc.nodes.find((n) => n.id === 'dec_discountLevel');

    assertFieldsSurvive(srcDecision, decision, {
      exclude: new Set([
        // fieldsOf() treats id as bookkeeping — it is still decision.id itself, just not part of
        // the field SET being compared here.
        'id',
        // structural — selects the moddle type (dmn:Decision) at construction time; not a field
        // carried on the instance.
        'type',
      ]),
      rename: {
        typeRef: 'variable',            // folds into the nested InformationItem, not a same-level field
        documentation: 'description',   // tDMNElement/description (not on this node today, but correct if it is later)
        decisionTable: 'decisionLogic', // decisionTable and expression both fill the same decisionLogic
        expression: 'decisionLogic',    // slot; Decision-Core makes them mutually exclusive, XSD does not care which
      },
    });

    // Requirements pointing at dec_discountLevel come from a DIFFERENT part of the Decision-Core
    // input (dc.requirements, not the node object itself) and nest onto the target as a side
    // effect of attachRequirements — so they get their own derivation from that array rather than
    // folding into assertFieldsSurvive above, which only ever sees one object at a time.
    const REQ_FIELD = { information: 'informationRequirement', knowledge: 'knowledgeRequirement', authority: 'authorityRequirement' };
    const expectedReqFields = new Set(
      dc.requirements.filter((r) => r.target === 'dec_discountLevel').map((r) => REQ_FIELD[r.type])
    );
    expect(expectedReqFields.size).toBeGreaterThan(0); // guard against a fixture edit silently emptying this check
    const decisionFields = fieldsOf(decision);
    for (const f of expectedReqFields) expect(decisionFields).toContain(f);

    // One level deeper: the decision table itself must not have silently dropped a class of
    // child. hitPolicy is excluded here — dropped whenever it equals the descriptor default
    // 'UNIQUE' (measured library normalisation, recorded in tests/fixtures/dmn/README.md; also
    // asserted directly in the "hitPolicy/preferredOrientation normalisation" describe above),
    // not an omission this test should flag.
    assertFieldsSurvive(srcDecision.decisionTable, decision.decisionLogic, {
      exclude: new Set(['id', 'hitPolicy']),
      rename: { inputs: 'input', outputs: 'output', annotations: 'annotation', rules: 'rule' },
    });
    expect(decision.decisionLogic.rule).toHaveLength(3); // r1, r2, r3 in the fixture

    // One level deeper still: in_1 in the fixture carries both `label` and `typeRef` — the two
    // InputClause/inputExpression fields buildDecisionTable dropped until this task fixed it
    // (label lives on the InputClause, typeRef on its inputExpression; see the field-set
    // discipline note in CLAUDE.md's "Adding a per-node field").
    const srcInput0 = srcDecision.decisionTable.inputs[0];
    const input0 = decision.decisionLogic.input[0];
    assertFieldsSurvive(srcInput0, input0, {
      exclude: new Set([
        'id',
        // typeRef lands on the NESTED inputExpression (tExpression/@typeRef), not a same-level
        // InputClause field — checked directly by value below instead.
        'typeRef',
      ]),
      rename: { expression: 'inputExpression' }, // the literal text lands inside the wrapper element
    });
    expect(input0.label).toBe('Order value');
    expect(input0.inputExpression.typeRef).toBe('number');
    expect(input0.inputExpression.text).toBe('orderValue');

    // OutputClause: out_1 carries name/typeRef/allowedValues — allowedValues renames to
    // outputValues (tOutputClause's own child element name).
    const srcOutput0 = srcDecision.decisionTable.outputs[0];
    const output0 = decision.decisionLogic.output[0];
    assertFieldsSurvive(srcOutput0, output0, {
      exclude: new Set(['id']),
      rename: { allowedValues: 'outputValues', defaultValue: 'defaultOutputEntry' },
    });
  });
});

describe('generateDmnXml — hitPolicy round trip for a non-default value', () => {
  test('a non-UNIQUE hitPolicy survives serialisation (README.md:31 predicts this)', async () => {
    // The field-set round trip above excludes hitPolicy because the fixture's dec_discountLevel
    // uses the implicit default 'UNIQUE', which dmn-moddle's writer drops (moddle-xml skips any
    // attribute value equal to its descriptor default — see tests/fixtures/dmn/README.md's
    // "Golden-file normalisation" section, specifically line 31: "only a non-default hit policy
    // (e.g. 'FIRST', 'PRIORITY') would survive the round trip"). That leaves the non-default case
    // completely unasserted. Deep-clone the fixture (not a new fixture file — see task brief) and
    // set hitPolicy to a non-default value to close that gap.
    const dc = structuredClone(good());
    const srcDecision = dc.nodes.find((n) => n.id === 'dec_discountLevel');
    srcDecision.decisionTable.hitPolicy = 'FIRST';

    const diagrams = oneNodeDiagram('dec_discountLevel');
    const xml = await generateDmnXml(dc, diagrams);
    const reader = new DmnModdle();
    const { rootElement, warnings } = await reader.fromXML(xml);
    expect(warnings).toEqual([]);

    const decision = rootElement.get('drgElement').find((e) => e.id === 'dec_discountLevel');

    // Run WITHOUT the hitPolicy exclusion this time — if the library dropped it, `missing` in
    // assertFieldsSurvive would name 'hitPolicy' and this assertion would fail, proving the gap
    // instead of just documenting it.
    assertFieldsSurvive(srcDecision.decisionTable, decision.decisionLogic, {
      exclude: new Set(['id']),
      rename: { inputs: 'input', outputs: 'output', annotations: 'annotation', rules: 'rule' },
    });
    // Confirm the actual serialised value, not just that the field is present.
    expect(decision.decisionLogic.hitPolicy).toBe('FIRST');
    expect(xml).toMatch(/<dmn:decisionTable\b[^>]*\bhitPolicy="FIRST"/);
  });
});

describe('generateDmnXml — informationRequirement source-type arms', () => {
  test('a decision source uses requiredDecision and an inputData source uses requiredInput', async () => {
    const dc = good();
    const diagrams = oneNodeDiagram('dec_finalPercentage');
    const xml = await generateDmnXml(dc, diagrams);
    const reader = new DmnModdle();
    const { rootElement, warnings } = await reader.fromXML(xml);
    expect(warnings).toEqual([]);

    const decision = rootElement.get('drgElement').find((e) => e.id === 'dec_finalPercentage');
    const reqs = decision.get('informationRequirement');
    // ir_2: dec_discountLevel (decision) -> dec_finalPercentage
    const fromDecision = reqs.find((r) => r.requiredDecision?.href === '#dec_discountLevel');
    expect(fromDecision).toBeDefined();
    expect(fromDecision.requiredInput).toBeUndefined();
    // ir_3: in_customerSince (inputData) -> dec_finalPercentage
    const fromInputData = reqs.find((r) => r.requiredInput?.href === '#in_customerSince');
    expect(fromInputData).toBeDefined();
    expect(fromInputData.requiredDecision).toBeUndefined();
  });

  test('a knowledgeSource source for an information requirement throws, naming the illegal type', async () => {
    const dc = good();
    // ks_discountPolicy is a knowledgeSource; DMN 1.3 §6.2.3 Table 2 permits only decision or
    // inputData as the source of an InformationRequirement — a knowledgeSource may only be the
    // source of an AuthorityRequirement.
    dc.requirements.push({ id: 'ir_illegal', type: 'information', source: 'ks_discountPolicy', target: 'dec_discountLevel' });
    const diagrams = oneNodeDiagram('dec_discountLevel');
    await expect(generateDmnXml(dc, diagrams)).rejects.toThrow(/knowledgeSource/);
  });
});

describe('generateDmnXml — generated ids cannot collide with a document id', () => {
  test('a node "foo" and a node "foo_var" produce distinct ids and a clean round trip', async () => {
    const dc = {
      id: 'Definitions_1', name: 'Collision test', namespace: 'http://x/collision',
      nodes: [
        { id: 'foo', type: 'decision', name: 'Foo', variable: 'fooVar', typeRef: 'string' },
        { id: 'foo_var', type: 'inputData', name: 'Foo var', typeRef: 'string' },
      ],
    };
    const diagrams = [{
      id: 'DMNDiagram_1', name: 'Diagram 1', size: { w: 400, h: 200 },
      coordMap: {
        coords: {
          foo: { x: 10, y: 10, w: 180, h: 80 },
          foo_var: { x: 220, y: 10, w: 180, h: 80 },
        },
        edgeCoords: {},
      },
    }];
    const xml = await generateDmnXml(dc, diagrams);
    const reader = new DmnModdle();
    const { rootElement, warnings } = await reader.fromXML(xml);
    expect(warnings).toEqual([]);

    // node "foo_var" itself keeps its own id — its dmn:InputData element is unaffected.
    const fooVarNode = rootElement.get('drgElement').find((e) => e.id === 'foo_var');
    expect(fooVarNode).toBeDefined();
    expect(fooVarNode.$type).toBe('dmn:InputData');

    // node "foo"'s generated variable id would naively be "foo_var" — the exact string already
    // taken by the other node above. The fix must suffix it instead.
    const fooNode = rootElement.get('drgElement').find((e) => e.id === 'foo');
    expect(fooNode.variable).toBeDefined();
    expect(fooNode.variable.id).not.toBe('foo_var');
    expect(fooNode.variable.id).toBe('foo_var_2');

    // No two elements anywhere in the document share an id — the xsd:ID uniqueness property
    // this fix exists to protect, checked directly rather than just trusting zero warnings.
    const allIds = [];
    (function collect(el) {
      if (el && typeof el === 'object') {
        if (typeof el.id === 'string') allIds.push(el.id);
        for (const key of Object.keys(el)) {
          if (key === '$parent' || key.startsWith('$')) continue;
          const v = el[key];
          if (Array.isArray(v)) v.forEach(collect);
          else if (v && typeof v === 'object') collect(v);
        }
      }
    })(rootElement);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  test('the ordinary no-collision case is unaffected — ids come out exactly as {id}_var/{id}_expr', async () => {
    const dc = good(); // discount-decision.json — no naming collision, verified by inspection
    const diagrams = [
      ...oneNodeDiagram('dec_discountLevel'),
    ];
    // Exercise both a table-backed decision (variable id) and an expression-backed decision
    // (expression id) from the same fixture.
    const dcWithBoth = {
      ...dc,
      nodes: dc.nodes,
    };
    const xmlTable = await generateDmnXml(dcWithBoth, oneNodeDiagram('dec_discountLevel'));
    expect(xmlTable).toMatch(/<dmn:variable\b[^>]*\bid="dec_discountLevel_var"/);

    const xmlExpr = await generateDmnXml(dcWithBoth, oneNodeDiagram('dec_finalPercentage'));
    expect(xmlExpr).toMatch(/<dmn:variable\b[^>]*\bid="dec_finalPercentage_var"/);
    expect(xmlExpr).toMatch(/id="dec_finalPercentage_expr"/);
  });
});

function xmllintAvailable() {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const xsdPath = resolve(__dirname, '../../references/omg-spec/normative/dmn/DMN13.xsd');

// Two independent dependencies: the xmllint binary and the schema file. Guard
// on both — a worktree or fresh clone can have xmllint installed but not yet
// carry the (tracked, but not necessarily checked out in every worktree)
// schema files, and the reverse (schema present, no xmllint) is the common
// dev-machine-without-libxml2 case. Mirrors the existsSync-return pattern
// scripts/bpmn/pipeline.test.js already uses twice for the OMG spec directory.
const describeIfXmllint = (xmllintAvailable() && existsSync(xsdPath)) ? describe : describe.skip;

describeIfXmllint('generateDmnXml — validates against the normative XSD', () => {
  test('discount-decision.json produces XSD-valid DMN 1.3', async () => {
    const dc = good();
    const xml = await generateDmnXml(dc, oneNodeDiagram('dec_discountLevel'));
    expect(() => execFileSync('xmllint', ['--noout', '--schema', xsdPath, '-'], {
      input: xml, stdio: ['pipe', 'pipe', 'pipe'],
    })).not.toThrow();
  });
});

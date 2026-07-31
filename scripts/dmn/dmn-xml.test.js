import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DmnModdle } from 'dmn-moddle';

import { generateDmnXml, validateDmnXml } from './dmn-xml.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../tests/fixtures/dmn');
const loadFixture = (name) => JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
const good = () => loadFixture('discount-decision.json');

/** A minimal one-node, zero-requirement diagram list — the smallest legal Task 3 output shape. */
const oneNodeDiagram = (nodeId) => [{
  id: 'DMNDiagram_1', name: 'Diagram 1', size: { w: 300, h: 200 },
  coordMap: { coords: { [nodeId]: { x: 10, y: 10, w: 180, h: 80 } }, edgeCoords: {} },
}];

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
  test('two diagrams produce two DMNDiagram elements, each with its own shape', async () => {
    const dc = good();
    const diagrams = [
      { id: 'DMNDiagram_1', name: 'Overview', size: { w: 300, h: 200 },
        coordMap: { coords: { dec_discountLevel: { x: 10, y: 10, w: 180, h: 80 } }, edgeCoords: {} } },
      { id: 'DMNDiagram_2', name: 'Loyalty view', size: { w: 300, h: 200 },
        coordMap: { coords: { bkm_loyaltyBonus: { x: 10, y: 10, w: 135, h: 46 } }, edgeCoords: {} } },
    ];
    const xml = await generateDmnXml(dc, diagrams);
    const diagramTags = [...xml.matchAll(/<dmndi:DMNDiagram\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
    expect(diagramTags).toEqual(['DMNDiagram_1', 'DMNDiagram_2']);
    expect(xml).toMatch(/<dmndi:DMNShape\b[^>]*dmnElementRef="dec_discountLevel"/);
    expect(xml).toMatch(/<dmndi:DMNShape\b[^>]*dmnElementRef="bkm_loyaltyBonus"/);
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

describe('generateDmnXml — field-set round trip (discount-decision.json, full fixture)', () => {
  test('every populated field on dec_discountLevel survives write + re-read', async () => {
    const dc = good();
    const diagrams = oneNodeDiagram('dec_discountLevel');
    const xml = await generateDmnXml(dc, diagrams);
    const reader = new DmnModdle();
    const { rootElement, warnings } = await reader.fromXML(xml);
    expect(warnings).toEqual([]);

    const decision = rootElement.get('drgElement').find((e) => e.id === 'dec_discountLevel');
    const fields = fieldsOf(decision);
    // dec_discountLevel in the fixture carries: name, question, allowedAnswers, variable,
    // decisionLogic (a decisionTable), usingTask, informationRequirement, authorityRequirement.
    for (const expected of [
      'name', 'question', 'allowedAnswers', 'variable',
      'decisionLogic', 'usingTask', 'informationRequirement', 'authorityRequirement',
    ]) {
      expect(fields).toContain(expected);
    }

    // One level deeper: the decision table itself must not have silently dropped a class of
    // child. hitPolicy is asserted separately in Step 9 (it may legitimately be normalised
    // away); everything else must be there.
    const tableFields = fieldsOf(decision.decisionLogic);
    for (const expected of ['input', 'output', 'annotation', 'rule']) {
      expect(tableFields).toContain(expected);
    }
    expect(decision.decisionLogic.rule).toHaveLength(3); // r1, r2, r3 in the fixture

    // One level deeper still: in_1 in the fixture carries both `label` and `typeRef` — the two
    // InputClause/inputExpression fields buildDecisionTable dropped until this task fixed it
    // (label lives on the InputClause, typeRef on its inputExpression; see the field-set
    // discipline note in CLAUDE.md's "Adding a per-node field"). OutputClause is checked the same
    // way: out_1 carries name/typeRef/allowedValues, all already covered by buildDecisionTable.
    const input0 = decision.decisionLogic.input[0];
    expect(fieldsOf(input0)).toContain('label');
    expect(input0.label).toBe('Order value');
    expect(input0.inputExpression.typeRef).toBe('number');

    const output0 = decision.decisionLogic.output[0];
    const outputFields = fieldsOf(output0);
    for (const expected of ['name', 'typeRef', 'outputValues']) {
      expect(outputFields).toContain(expected);
    }
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

const describeIfXmllint = xmllintAvailable() ? describe : describe.skip;

describeIfXmllint('generateDmnXml — validates against the normative XSD', () => {
  test('discount-decision.json produces XSD-valid DMN 1.3', async () => {
    const dc = good();
    const xml = await generateDmnXml(dc, oneNodeDiagram('dec_discountLevel'));
    const xsdPath = resolve(__dirname, '../../references/omg-spec/normative/dmn/DMN13.xsd');
    expect(() => execFileSync('xmllint', ['--noout', '--schema', xsdPath, '-'], {
      input: xml, stdio: ['pipe', 'pipe', 'pipe'],
    })).not.toThrow();
  });
});

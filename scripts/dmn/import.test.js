import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  parseDmnXml, moddleToDecisionCore, dmnToDecisionCore,
  applyDecisionCoreDefaults, canonicalizeDecisionCore, formatImportReport, HANDLERS,
} from './import.js';
import { validateDecisionCoreSchema } from './schema-gate.js';
import { DMN_ELEMENT_COVERAGE } from './import-scope.js';

/**
 * Stage 3's own tests. One per IM code, each an inline snippet asserting the exact
 * `{code, xsdElement, path}` — the report is the contract the whole importer exists to honour, so
 * it is tested by code rather than by "some finding was produced".
 *
 * Stages 4 and 5 add the behavioural and round-trip fences on top; this file deliberately does NOT
 * claim field completeness from `discount-decision`, which instantiates only part of the schema.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, '..', '..', 'tests', 'fixtures', 'dmn');

const NS = 'xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" '
  + 'xmlns:dmndi="https://www.omg.org/spec/DMN/20191111/DMNDI/" '
  + 'xmlns:dc="http://www.omg.org/spec/DMN/20180521/DC/" '
  + 'xmlns:di="http://www.omg.org/spec/DMN/20180521/DI/"';

const doc = (inner) =>
  `<definitions ${NS} id="Definitions_1" name="D" namespace="http://bpmn-generator.local/t">${inner}</definitions>`;

/** The subset of a Finding the assertions pin. `reason` is prose and is checked only for presence. */
const shape = (f) => ({ code: f.code, xsdElement: f.xsdElement, path: f.path });

async function report(inner) {
  const { report: r } = await dmnToDecisionCore(doc(inner));
  return r;
}

describe('the import report — one test per IM code', () => {
  test('IM01 — a DRG element class with no Decision-Core equivalent', async () => {
    const r = await report('<decisionService id="ds1" name="Scoring service"/>');
    expect(r.unrepresented.map(shape)).toContainEqual({
      code: 'IM01', xsdElement: 'decisionService', path: 'definitions.drgElement[0]',
    });
    expect(r.lossless).toBe(false);
  });

  test('IM02 — decision logic in a form Decision-Core cannot hold', async () => {
    const r = await report(
      '<decision id="d1" name="D1"><context id="ctx1">'
      + '<contextEntry id="ce1"><literalExpression id="le1"><text>1</text></literalExpression></contextEntry>'
      + '</context></decision>');
    expect(r.unrepresented.map(shape)).toContainEqual({
      code: 'IM02', xsdElement: 'context', path: 'definitions.drgElement[0].decisionLogic',
    });
  });

  test('IM03 — a document-level construct outside the decision graph', async () => {
    const r = await report('<itemDefinition id="it1" name="Tier"/><decision id="d1" name="D1"/>');
    expect(r.unrepresented.map(shape)).toContainEqual({
      code: 'IM03', xsdElement: 'itemDefinition', path: 'definitions.itemDefinition[0]',
    });
  });

  test('IM04 — extension content', async () => {
    const r = await report(
      '<decision id="d1" name="D1"><extensionElements>'
      + '<vendor:thing xmlns:vendor="http://vendor.example/">x</vendor:thing>'
      + '</extensionElements></decision>');
    expect(r.unrepresented.map(shape)).toContainEqual({
      code: 'IM04', xsdElement: 'decision', path: 'definitions.drgElement[0].extensionElements',
    });
  });

  test('IM04 — an extension ATTRIBUTE, which dmn-moddle parks in $attrs rather than in the '
    + 'extensionAttribute property', async () => {
    const r = await report('<decision id="d1" name="D1" xmlns:vendor="http://vendor.example/" vendor:flag="1"/>');
    expect(r.unrepresented.map(shape)).toContainEqual({
      code: 'IM04', xsdElement: 'decision', path: 'definitions.drgElement[0].$attrs["vendor:flag"]',
    });
  });

  test('IM05 — a property with no Decision-Core slot, on a type we do import', async () => {
    const r = await report('<decision id="d1" name="D1" label="Shown instead of the name"/>');
    expect(r.unrepresented.map(shape)).toContainEqual({
      code: 'IM05', xsdElement: 'decision', path: 'definitions.drgElement[0].label',
    });
  });

  test('IM06 — diagram interchange', async () => {
    const r = await report(
      '<decision id="d1" name="D1"/>'
      + '<dmndi:DMNDI><dmndi:DMNDiagram id="dg1">'
      + '<dmndi:DMNShape id="s1" dmnElementRef="d1"><dc:Bounds x="0" y="0" width="1" height="1"/></dmndi:DMNShape>'
      + '</dmndi:DMNDiagram></dmndi:DMNDI>');
    expect(r.unrepresented.map(shape)).toContainEqual({
      code: 'IM06', xsdElement: 'DMNDI', path: 'definitions.dmnDI',
    });
  });

  test('IM07 — an id dmn-moddle surfaces that Decision-Core cannot hold', async () => {
    // Measured: dmn-moddle ACCEPTS `a:b` as an xsd:ID even though a colon is illegal in an NCName.
    // Its id validation is both narrower than NCName (it rejects Unicode letters -> IM08) and wider
    // (it accepts a colon), which is what keeps IM07 reachable after Stage 2's widening.
    const r = await report('<decision id="a:b" name="D1"/>');
    expect(r.unrepresented.map(shape)).toContainEqual({
      code: 'IM07', xsdElement: 'decision', path: 'definitions.drgElement[0]',
    });
  });

  test('IM07 — a DRG element with no id at all, which Decision-Core requires', async () => {
    const r = await report('<decision name="Nameless in the id sense"/>');
    expect(r.unrepresented.map(shape)).toContainEqual({
      code: 'IM07', xsdElement: 'decision', path: 'definitions.drgElement[0]',
    });
  });

  test('IM08 — the parser never surfaced it', async () => {
    const r = await report('<organizationUnit id="ou1" name="Finance"/><decision id="d1" name="D1"/>');
    expect(r.unrepresented.map(shape)).toContainEqual({
      code: 'IM08', xsdElement: 'organizationUnit', path: 'definitions',
    });
    expect(r.parserWarnings.length).toBe(1);
    expect(r.parserWarnings[0]).toMatch(/organizationUnit/);
  });

  test('every finding carries the full shape, and a reason a stranger can act on', async () => {
    const r = await report('<decisionService id="ds1" name="S"/><itemDefinition id="it1" name="T"/>');
    expect(r.unrepresented.length).toBeGreaterThan(0);
    for (const f of r.unrepresented) {
      expect(Object.keys(f).sort())
        .toEqual(['code', 'id', 'moddleType', 'name', 'path', 'reason', 'xsdElement']);
      expect(typeof f.reason).toBe('string');
      expect(f.reason.trim().length).toBeGreaterThan(0);
      expect(f.id === null || typeof f.id === 'string').toBe(true);
      expect(f.name === null || typeof f.name === 'string').toBe(true);
    }
  });
});

describe('lossless, and the counts', () => {
  test('a document with nothing unrepresentable is lossless', async () => {
    // No `id` on the <literalExpression>: the <literalExpression> row lists `id` as an IM05 loss
    // (every slot it can fill is a bare string, and the writer generates a fresh id on emit), so a
    // document that carries one is genuinely lossy — see the next test.
    const r = await report('<decision id="d1" name="D1"><literalExpression><text>1</text></literalExpression></decision>');
    expect(r.unrepresented).toEqual([]);
    expect(r.parserWarnings).toEqual([]);
    expect(r.lossless).toBe(true);
  });

  test('lossless is exactly "no findings and no parser warnings"', async () => {
    const r = await report('<decision id="d1" name="D1" label="L"/>');
    expect(r.lossless).toBe(false);
    expect(r.counts.unrepresented).toBe(r.unrepresented.length);
    expect(r.counts.parserWarnings).toBe(r.parserWarnings.length);
    expect(r.counts.byCode.IM05).toBe(1);
  });
});

describe('the suppression rule inside a reported subtree', () => {
  test('a dropped subtree yields one finding per element CLASS, not per occurrence', async () => {
    const r = await report(
      '<decision id="d1" name="D1"><context id="ctx1">'
      + '<contextEntry id="ce1"><literalExpression id="l1"><text>1</text></literalExpression></contextEntry>'
      + '<contextEntry id="ce2"><literalExpression id="l2"><text>2</text></literalExpression></contextEntry>'
      + '<contextEntry id="ce3"><literalExpression id="l3"><text>3</text></literalExpression></contextEntry>'
      + '</context></decision>');
    const entries = r.unrepresented.filter((f) => f.xsdElement === 'contextEntry');
    expect(entries.length).toBe(1);
    expect(entries[0].path).toBe('definitions.drgElement[0].decisionLogic.contextEntry[0]');
  });

  test('no property finding is raised inside a subtree that is already dropped whole', async () => {
    const r = await report(
      '<decision id="d1" name="D1"><context id="ctx1" label="Boxed context">'
      + '<contextEntry id="ce1"><literalExpression id="l1" label="cell"><text>1</text></literalExpression></contextEntry>'
      + '</context></decision>');
    expect(r.unrepresented.filter((f) => f.code === 'IM05')).toEqual([]);
  });

  test('a literal expression\'s typeRef is an IM05 loss as decision LOGIC and not as an '
    + 'inputExpression — the fate is per-position, and the container wins', async () => {
    const asLogic = await report(
      '<decision id="d1" name="D"><literalExpression typeRef="number"><text>1</text></literalExpression></decision>');
    expect(asLogic.unrepresented.map(shape)).toContainEqual({
      code: 'IM05', xsdElement: 'literalExpression',
      path: 'definitions.drgElement[0].decisionLogic.typeRef',
    });

    const inClause = await dmnToDecisionCore(doc(
      '<decision id="d1" name="D"><decisionTable id="t"><input id="i1">'
      + '<inputExpression typeRef="number"><text>v</text></inputExpression></input>'
      + '<output id="o1"/></decisionTable></decision>'));
    expect(inClause.dc.nodes[0].decisionTable.inputs[0].typeRef).toBe('number');
    expect(inClause.report.unrepresented.filter((f) => f.path.endsWith('.typeRef'))).toEqual([]);
  });

  test('a reported element nested in one of its OWN class reports once — the outer root counts '
    + 'itself as seen', async () => {
    // Measured before the fix: the reported root never added its own class to `seen`, so a
    // same-class CHILD reported a second time while same-class SIBLINGS deduped correctly. The
    // second line carried the parent row's prose attached to a component of it, which reads as a
    // separate loss and is not one.
    const nested = await report('<itemDefinition id="a" name="A"><itemComponent id="b" name="B"/></itemDefinition>');
    expect(nested.unrepresented.filter((f) => f.xsdElement === 'itemDefinition').map((f) => f.path))
      .toEqual(['definitions.itemDefinition[0]']);

    const inContext = await report(
      '<decision id="d1" name="D"><context id="c1"><contextEntry id="ce1">'
      + '<context id="c2"><contextEntry id="ce2"><literalExpression><text>1</text></literalExpression></contextEntry></context>'
      + '</contextEntry></context></decision>');
    expect(inContext.unrepresented.filter((f) => f.xsdElement === 'context')).toHaveLength(1);
    expect(inContext.unrepresented.filter((f) => f.xsdElement === 'contextEntry')).toHaveLength(1);
  });

  test('every DMNDiagram is reported — a view is a fact, a shape is not', async () => {
    const r = await report(
      '<decision id="d1" name="D1"/><dmndi:DMNDI>'
      + '<dmndi:DMNDiagram id="dg1">'
      + '<dmndi:DMNShape id="s1" dmnElementRef="d1"><dc:Bounds x="0" y="0" width="1" height="1"/></dmndi:DMNShape>'
      + '<dmndi:DMNShape id="s2" dmnElementRef="d1"><dc:Bounds x="9" y="9" width="1" height="1"/></dmndi:DMNShape>'
      + '</dmndi:DMNDiagram>'
      + '<dmndi:DMNDiagram id="dg2"/></dmndi:DMNDI>');
    expect(r.unrepresented.filter((f) => f.xsdElement === 'DMNDiagram').map((f) => f.path))
      .toEqual(['definitions.dmnDI.diagrams[0]', 'definitions.dmnDI.diagrams[1]']);
    expect(r.unrepresented.filter((f) => f.xsdElement === 'DMNShape').length).toBe(1);
  });
});

/**
 * The seam that made C1 invisible: `detectFindings` raises element findings only for `reported`
 * rows, and `decisionTable` / `literalExpression` / `functionDefinition` are all `mapped`. So a
 * mapped expression class landing in a slot the converter has no branch for was seen by neither
 * side — the walk stayed quiet because the row is mapped, the converter stayed quiet because it
 * simply fell through. Only the converter knows which POSITIONS it reads, so only the converter can
 * report this.
 */
describe('a mapped expression class in a position the converter does not read', () => {
  test('a <decisionTable> as a BKM body is reported, not silently dropped', async () => {
    const { dc, report: r } = await dmnToDecisionCore(doc(
      '<businessKnowledgeModel id="b1" name="B"><encapsulatedLogic>'
      + '<decisionTable id="t1"><output id="o1"/></decisionTable>'
      + '</encapsulatedLogic></businessKnowledgeModel>'));
    expect(dc.nodes[0].body).toBeUndefined();
    expect(r.lossless).toBe(false);
    expect(r.unrepresented.map(shape)).toContainEqual({
      code: 'IM02', xsdElement: 'decisionTable',
      path: 'definitions.drgElement[0].encapsulatedLogic.body',
    });
  });

  test('a <functionDefinition> as decision logic is reported', async () => {
    const { dc, report: r } = await dmnToDecisionCore(doc(
      '<decision id="d1" name="D"><functionDefinition id="f1">'
      + '<literalExpression id="l1"><text>1</text></literalExpression>'
      + '</functionDefinition></decision>'));
    expect(dc.nodes[0].expression).toBeUndefined();
    expect(dc.nodes[0].decisionTable).toBeUndefined();
    expect(r.unrepresented.map(shape)).toContainEqual({
      code: 'IM02', xsdElement: 'functionDefinition', path: 'definitions.drgElement[0].decisionLogic',
    });
  });

  test('a <functionDefinition> as a function body is reported', async () => {
    const r = await report(
      '<businessKnowledgeModel id="b1" name="B"><encapsulatedLogic>'
      + '<functionDefinition id="f2"><literalExpression id="l1"><text>1</text></literalExpression></functionDefinition>'
      + '</encapsulatedLogic></businessKnowledgeModel>');
    expect(r.unrepresented.map(shape)).toContainEqual({
      code: 'IM02', xsdElement: 'functionDefinition',
      path: 'definitions.drgElement[0].encapsulatedLogic.body',
    });
  });

  test('the control case still works — a `reported` class in the same slot reports once, from the '
    + 'walk, and the converter does not double it', async () => {
    const r = await report(
      '<decision id="d1" name="D"><context id="c1">'
      + '<contextEntry id="ce1"><literalExpression><text>1</text></literalExpression></contextEntry>'
      + '</context></decision>');
    expect(r.unrepresented.filter((f) => f.path === 'definitions.drgElement[0].decisionLogic'))
      .toHaveLength(1);
  });
});

describe('malformed source content the report must still name', () => {
  test('a <decisionTable> with no output clause cannot be held and is reported, not emitted '
    + 'half-built for our own schema gate to trip over', async () => {
    const { dc, report: r } = await dmnToDecisionCore(doc(
      '<decision id="d1" name="D"><decisionTable id="t1">'
      + '<input id="i1"><inputExpression><text>v</text></inputExpression></input>'
      + '</decisionTable></decision>'));
    expect(dc.nodes[0].decisionTable).toBeUndefined();
    expect(r.lossless).toBe(false);
    expect(r.unrepresented.map(shape)).toContainEqual({
      code: 'IM02', xsdElement: 'decisionTable', path: 'definitions.drgElement[0].decisionLogic',
    });
    expect(validateDecisionCoreSchema(dc).errors).toEqual([]);
  });

  test('a requirement with no required* child is reported rather than vanishing', async () => {
    const { dc, report: r } = await dmnToDecisionCore(doc(
      '<decision id="d1" name="D"><informationRequirement id="ir1"/></decision>'));
    expect(dc.requirements ?? []).toEqual([]);
    expect(r.lossless).toBe(false);
    expect(r.unrepresented.map(shape)).toContainEqual({
      code: 'IM03', xsdElement: 'informationRequirement',
      path: 'definitions.drgElement[0].informationRequirement[0]',
    });
    // It carried an id the file authored — the finding has to say which one.
    expect(r.unrepresented.find((f) => f.code === 'IM03').id).toBe('ir1');
  });
});

describe('the two deref rules', () => {
  test("a requirement's href is '#'-stripped and read in FLOW direction", async () => {
    const { dc } = await dmnToDecisionCore(doc(
      '<inputData id="in1" name="In"/>'
      + '<decision id="d1" name="D1"><informationRequirement id="ir1">'
      + '<requiredInput href="#in1"/></informationRequirement></decision>'));
    expect(dc.requirements).toEqual([
      { id: 'ir1', type: 'information', source: 'in1', target: 'd1' },
    ]);
  });

  test('usingTask keeps its href verbatim — the writer emits a bare id there on purpose', async () => {
    const { dc } = await dmnToDecisionCore(doc(
      '<decision id="d1" name="D1"><usingTask href="task_applyDiscount"/></decision>'));
    expect(dc.nodes[0].usingTask).toBe('task_applyDiscount');
  });

  test('a cross-document requirement href is reported as IM03 and never emitted', async () => {
    const { dc, report: r } = await dmnToDecisionCore(doc(
      '<decision id="d1" name="D1"><informationRequirement id="ir1">'
      + '<requiredDecision href="other.dmn#d9"/></informationRequirement></decision>'));
    expect(dc.requirements ?? []).toEqual([]);
    expect(r.unrepresented.map(shape)).toContainEqual({
      code: 'IM03', xsdElement: 'informationRequirement',
      path: 'definitions.drgElement[0].informationRequirement[0]',
    });
  });
});

describe('the three round-trip non-identities', () => {
  test('a requirement id the file carries is kept, generated-looking or not', async () => {
    const { dc } = await dmnToDecisionCore(doc(
      '<inputData id="in1" name="In"/>'
      + '<decision id="d1" name="D1"><informationRequirement id="req_in1_d1">'
      + '<requiredInput href="#in1"/></informationRequirement></decision>'));
    expect(dc.requirements[0].id).toBe('req_in1_d1');
  });

  test('a requirement with no id imports without one — canonicalize fills it on the expected side', async () => {
    const { dc } = await dmnToDecisionCore(doc(
      '<inputData id="in1" name="In"/>'
      + '<decision id="d1" name="D1"><informationRequirement>'
      + '<requiredInput href="#in1"/></informationRequirement></decision>'));
    expect(dc.requirements[0].id).toBeUndefined();
    expect(canonicalizeDecisionCore(dc).requirements[0].id).toBe('req_in1_d1');
  });

  test('a variable whose name equals the element name is the XSD default, and is suppressed', async () => {
    const { dc } = await dmnToDecisionCore(doc(
      '<inputData id="in1" name="Order value"><variable id="in1_var" name="Order value" typeRef="number"/></inputData>'));
    expect(dc.nodes[0].variable).toBeUndefined();
    expect(dc.nodes[0].typeRef).toBe('number');
  });

  test('a variable whose name differs from the element name is kept', async () => {
    const { dc } = await dmnToDecisionCore(doc(
      '<inputData id="in1" name="Order value"><variable id="in1_var" name="orderValue" typeRef="number"/></inputData>'));
    expect(dc.nodes[0].variable).toBe('orderValue');
  });

  test('usingTask is a string at one entry and an array above one', async () => {
    const one = await dmnToDecisionCore(doc('<decision id="d1" name="D"><usingTask href="t1"/></decision>'));
    expect(one.dc.nodes[0].usingTask).toBe('t1');
    const two = await dmnToDecisionCore(doc(
      '<decision id="d1" name="D"><usingTask href="t1"/><usingTask href="t2"/></decision>'));
    expect(two.dc.nodes[0].usingTask).toEqual(['t1', 't2']);
  });
});

describe('the one materialised XSD default', () => {
  test('a silent hitPolicy becomes UNIQUE and the materialisation is recorded', async () => {
    const { dc, report: r } = await dmnToDecisionCore(doc(
      '<decision id="d1" name="D"><decisionTable id="t1"><output id="o1"/></decisionTable></decision>'));
    expect(dc.nodes[0].decisionTable.hitPolicy).toBe('UNIQUE');
    expect(r.defaultsMaterialised).toEqual([
      { path: 'nodes[0].decisionTable', attr: 'hitPolicy', value: 'UNIQUE' },
    ]);
  });

  test('an explicitly written hitPolicy is not a materialisation', async () => {
    const { report: r } = await dmnToDecisionCore(doc(
      '<decision id="d1" name="D"><decisionTable id="t1" hitPolicy="UNIQUE"><output id="o1"/></decisionTable></decision>'));
    expect(r.defaultsMaterialised).toEqual([]);
  });

  test('applyDecisionCoreDefaults is idempotent and records nothing the second time', () => {
    const dc = { namespace: 'http://x/', nodes: [{ id: 'd', type: 'decision', name: 'D', decisionTable: { outputs: [{}] } }] };
    const first = applyDecisionCoreDefaults(dc);
    expect(first.defaultsMaterialised.length).toBe(1);
    expect(applyDecisionCoreDefaults(first.dc).defaultsMaterialised).toEqual([]);
  });
});

describe('a document that is not DMN at all', () => {
  test('a BPMN file returns a shaped failure rather than throwing', async () => {
    const { dc, report: r } = await dmnToDecisionCore(
      '<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"/>');
    expect(dc).toBeNull();
    expect(r.lossless).toBe(false);
    expect(r.unrepresented.map((f) => f.code)).toEqual(['IM08']);
    expect(r.parserWarnings[0]).toMatch(/dmn:Definitions/);
  });

  test('non-XML input returns a shaped failure too', async () => {
    const { dc, report: r } = await dmnToDecisionCore('not xml at all');
    expect(dc).toBeNull();
    expect(r.parserWarnings[0]).toMatch(/missing start tag/);
  });

  test('parseDmnXml itself still throws — the primitive stays honest', async () => {
    await expect(parseDmnXml('not xml at all')).rejects.toThrow();
  });
});

describe('the parse/convert split', () => {
  test('moddleToDecisionCore is synchronous and takes a parsed tree', async () => {
    const { definitions, warnings } = await parseDmnXml(doc('<decision id="d1" name="D1"/>'));
    expect(warnings).toEqual([]);
    const out = moddleToDecisionCore(definitions);
    expect(out.dc.nodes.map((n) => n.id)).toEqual(['d1']);
    expect(out.report.lossless).toBe(true);
  });
});

describe('the positive direction — the reference fixture', () => {
  test('discount-decision.expected.dmn imports to schema-valid Decision-Core', async () => {
    const xml = readFileSync(path.join(FIXTURES, 'discount-decision.expected.dmn'), 'utf8');
    const { dc, report: r } = await dmnToDecisionCore(xml);
    const result = validateDecisionCoreSchema(dc);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    // Exactly two loss classes, both of them the table's own documented ones and neither a defect:
    // IM06 for the DI (Decision-Core is coordinate-free by design) and IM05 for the ids of the
    // <variable> and <literalExpression> elements the writer GENERATES and regenerates on emit.
    expect([...new Set(r.unrepresented.map((f) => f.code))].sort()).toEqual(['IM05', 'IM06']);
    expect(r.unrepresented.filter((f) => f.code === 'IM05').map((f) => f.path)).toEqual([
      'definitions.drgElement[0].variable.id',
      'definitions.drgElement[1].variable.id',
      'definitions.drgElement[4].variable.id',
      'definitions.drgElement[5].variable.id',
      'definitions.drgElement[5].decisionLogic.id',
    ]);
    expect(dc.nodes.map((n) => n.id)).toEqual([
      'in_orderValue', 'in_customerSince', 'ks_discountPolicy', 'bkm_loyaltyBonus',
      'dec_discountLevel', 'dec_finalPercentage',
    ]);
    expect(dc.requirements.map((q) => q.id)).toEqual(['ir_1', 'ar_1', 'ir_2', 'ir_3', 'kr_1']);
  });

  test('every mapped slot the fixture instantiates survives the trip', async () => {
    const xml = readFileSync(path.join(FIXTURES, 'discount-decision.expected.dmn'), 'utf8');
    const { dc } = await dmnToDecisionCore(xml);
    const byId = Object.fromEntries(dc.nodes.map((n) => [n.id, n]));

    expect(dc.name).toBe('Discount decision');
    expect(dc.namespace).toBe('http://bpmn-generator.local/dmn/discount');
    expect(dc.documentation).toMatch(/^Reference fixture/);

    expect(byId.ks_discountPolicy.sourceType).toBe('Policy document');
    expect(byId.ks_discountPolicy.locationURI).toBe('http://bpmn-generator.local/policies/discount');

    expect(byId.bkm_loyaltyBonus.parameters).toEqual([{ name: 'since', typeRef: 'date' }]);
    expect(byId.bkm_loyaltyBonus.body).toMatch(/^if since </);
    expect(byId.bkm_loyaltyBonus.documentation).toBe('Extra percentage points granted for tenure.');

    const d = byId.dec_discountLevel;
    expect(d.question).toBe('Which discount level applies to this order?');
    expect(d.allowedAnswers).toBe('none, bronze, silver');
    expect(d.variable).toBe('discountLevel');
    expect(d.typeRef).toBe('string');
    expect(d.usingTask).toBe('task_applyDiscount');
    expect(d.decisionTable.inputs).toEqual([
      { id: 'in_1', label: 'Order value', expression: 'orderValue', typeRef: 'number' },
    ]);
    expect(d.decisionTable.outputs).toEqual([
      { id: 'out_1', name: 'level', typeRef: 'string', allowedValues: '"none","bronze","silver"' },
    ]);
    expect(d.decisionTable.annotations).toEqual([{ name: 'Note' }]);
    expect(d.decisionTable.rules[0]).toEqual({
      id: 'r1', when: ['< 100'], then: ['"none"'], annotations: ['Below threshold'],
    });
    expect(d.decisionTable.outputLabel).toBe('Discount level');
    expect(d.decisionTable.preferredOrientation).toBe('Rule-as-Row');

    expect(byId.dec_finalPercentage.expression)
      .toBe('base(discountLevel) + loyaltyBonus(customerSince)');
  });
});

describe('formatImportReport — the one rendering', () => {
  test('a lossless report says so in one line', async () => {
    const r = await report('<decision id="d1" name="D1"/>');
    const text = formatImportReport(r, { file: 'a.dmn' });
    expect(text).toMatch(/a\.dmn/);
    expect(text).toMatch(/lossless/i);
  });

  test('a missing report renders rather than throwing — the CLI must be able to print anything', () => {
    expect(formatImportReport(null)).toMatch(/no report/);
  });

  test('a lossy report names every code, its remedy and the paths', async () => {
    const r = await report('<decisionService id="ds1" name="S"/><itemDefinition id="it1" name="T"/>');
    const text = formatImportReport(r);
    expect(text).toMatch(/IM01/);
    expect(text).toMatch(/IM03/);
    expect(text).toMatch(/definitions\.drgElement\[0\]/);
    expect(text).toMatch(/definitions\.itemDefinition\[0\]/);
  });
});

describe('HANDLERS', () => {
  test('every handler is a function', () => {
    for (const [name, fn] of Object.entries(HANDLERS)) {
      expect(typeof fn).toBe('function');
      expect(name).toBe(name.trim());
    }
  });

  test('there is one handler per mapped row — the same equality F5 fences, asserted here too so '
    + 'this file fails on its own when the two drift', () => {
    const mapped = DMN_ELEMENT_COVERAGE.filter((r) => r.disposition === 'mapped');
    expect(Object.keys(HANDLERS).sort()).toEqual(mapped.map((r) => r.xsdElement).sort());
  });
});

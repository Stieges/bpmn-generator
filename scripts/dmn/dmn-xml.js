/**
 * DMN 1.3 XML + DMNDI generation via dmn-moddle, mirroring scripts/bpmn/bpmn-xml.js.
 *
 * Signature: generateDmnXml(dc, diagrams) -> Promise<string>
 *
 * Two facts this file depends on, both measured rather than assumed (Task 5, Steps 2-3):
 *   - $parent is not set on constructed elements — verified empirically (Task 5, Step 2) that
 *     moddle-xml's Writer does not need it, matching bpmn-xml.js's own precedent.
 *   - hitPolicy/preferredOrientation normalisation on write is dmn-moddle's own behaviour, not an
 *     XSD-derived rule (both attributes are equally optional-with-default in DMN13.xsd,
 *     dmn13-xsd-ground-truth.md §D8) — see tests/fixtures/dmn/README.md for what was observed.
 */

import { DmnModdle } from 'dmn-moddle';
import { rn } from '../shared/utils.js';
import { requirementKey } from './coordinates.js';

const moddle = new DmnModdle();

function create(type, attrs = {}) {
  return moddle.create(type, attrs);
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// The four DMN 1.3 types that do NOT extend tDMNElement and therefore must never carry an
// `id` attribute (DMN13.xsd, traced in full — dmn13-xsd-ground-truth.md §C). Emitting `id`
// on one of these reproduces the #36 mechanism: dmn-moddle does not reject an unknown
// attribute, it parks it in $attrs and writes it straight back out, and every later read of
// that file repeats the same warning. `dmn:Binding` is structurally unreachable from
// Decision-Core today — there is no `invocation` expression type in the schema — so it is
// listed here for completeness but never constructed; if invocation expressions are added
// later, the discipline already covers it.
const NO_ID_TYPES = new Set([
  'dmn:DMNElementReference', 'dmn:Binding', 'dmn:RuleAnnotationClause', 'dmn:RuleAnnotation',
]);

const MODDLE_TYPE = {
  decision: 'dmn:Decision',
  inputData: 'dmn:InputData',
  knowledgeSource: 'dmn:KnowledgeSource',
  businessKnowledgeModel: 'dmn:BusinessKnowledgeModel',
};

function buildDecisionTable(t) {
  const attrs = { id: t.id };
  if (t.hitPolicy) attrs.hitPolicy = t.hitPolicy;
  if (t.aggregation) attrs.aggregation = t.aggregation;
  if (t.preferredOrientation) attrs.preferredOrientation = t.preferredOrientation;
  if (t.outputLabel) attrs.outputLabel = t.outputLabel;
  const table = create('dmn:DecisionTable', attrs);

  for (const input of (t.inputs ?? [])) {
    // label lives on the InputClause itself (inherited from tDMNElement/@label); typeRef lives on
    // the inputExpression (inherited from tExpression/@typeRef, since tInputClause has no typeRef
    // of its own). Both are legal InputClause fields the schema and the fixture (in_1: "label":
    // "Order value", "typeRef": "number") carry — dropping either is the exact defect class this
    // plan exists to prevent (see CLAUDE.md "Adding a per-node field").
    const inputAttrs = { id: input.id, inputExpression: create('dmn:LiteralExpression', { text: input.expression, typeRef: input.typeRef }) };
    if (input.label) inputAttrs.label = input.label;
    if (input.allowedValues) inputAttrs.inputValues = create('dmn:UnaryTests', { text: input.allowedValues });
    table.get('input').push(create('dmn:InputClause', inputAttrs)); // nest
  }
  for (const output of t.outputs) {
    const outputAttrs = { id: output.id, name: output.name, typeRef: output.typeRef };
    if (output.allowedValues) outputAttrs.outputValues = create('dmn:UnaryTests', { text: output.allowedValues });
    if (output.defaultValue != null) outputAttrs.defaultOutputEntry = create('dmn:LiteralExpression', { text: output.defaultValue });
    table.get('output').push(create('dmn:OutputClause', outputAttrs)); // nest
  }
  for (const ann of (t.annotations ?? [])) {
    // NO id — tRuleAnnotationClause is one of the four id-less types.
    table.get('annotation').push(create('dmn:RuleAnnotationClause', { name: ann.name })); // nest
  }
  for (const rule of (t.rules ?? [])) {
    table.get('rule').push(create('dmn:DecisionRule', { // nest
      id: rule.id,
      inputEntry: (rule.when ?? []).map((w) => create('dmn:UnaryTests', { text: w })),
      outputEntry: rule.then.map((v) => create('dmn:LiteralExpression', { text: v })),
      // NO id on annotationEntry — tRuleAnnotation is one of the four id-less types.
      annotationEntry: (rule.annotations ?? []).map((a) => create('dmn:RuleAnnotation', { text: a })),
    }));
  }
  return table;
}

/**
 * tFunctionDefinition's moddle property names, VERIFIED against the real descriptor (Task 5, Step
 * 6a) rather than assumed — the research had no coverage for this type. The formal-parameter list
 * is `formalParameter` (as the design guessed), but the expression slot is `body` (type
 * dmn:Expression), NOT `expression` — the descriptor inspection caught this before it shipped.
 */
function buildFunctionDefinition(node) {
  const params = (node.parameters ?? []).map((p) => create('dmn:InformationItem', { name: p.name, typeRef: p.typeRef }));
  const attrs = { formalParameter: params };
  if (node.body != null) attrs.body = create('dmn:LiteralExpression', { text: node.body });
  return create('dmn:FunctionDefinition', attrs);
}

function buildDrgElement(node) {
  const attrs = { id: node.id, name: node.name };
  if (node.documentation) attrs.description = node.documentation;
  const el = create(MODDLE_TYPE[node.type], attrs);

  // `variable` (tInformationItem) exists only on tDecision, tInputData and tInvocable (the base of
  // tBusinessKnowledgeModel) — DMN13.xsd traced in full: tKnowledgeSource extends tDRGElement
  // directly and declares no `variable` child. Decision-Core allows `typeRef` on any node, so a
  // knowledgeSource carrying one would otherwise reach this branch and either get silently dropped
  // by dmn-moddle or produce an invalid element. Guard by type, not just by presence of the field.
  if (node.type !== 'knowledgeSource' && (node.variable || node.typeRef)) {
    el.variable = create('dmn:InformationItem', { // nest
      id: `${node.id}_var`, name: node.variable || node.name, typeRef: node.typeRef,
    });
  }

  if (node.type === 'decision') {
    if (node.question) el.question = node.question;
    if (node.allowedAnswers) el.allowedAnswers = node.allowedAnswers;
    if (node.decisionTable) {
      el.decisionLogic = buildDecisionTable(node.decisionTable); // nest
    } else if (node.expression != null) {
      el.decisionLogic = create('dmn:LiteralExpression', { id: `${node.id}_expr`, text: node.expression }); // nest
    }
    // Bare id, no leading '#' — unlike attachRequirements below, which points at a DRG element in
    // THIS document and uses an XPointer-style fragment (`#id`). usingTask/usingProcess point at a
    // BPMN task/process in a DIFFERENT document; DMN13.xsd attaches no fragment-resolution meaning
    // to that case (dmn13-xsd-ground-truth.md §F16: "no XSD-level tie to an actual BPMN schema...
    // resolution is entirely a tooling/prose convention"), so there is no document-relative anchor
    // for a '#' to be relative to. Both forms are legal xsd:anyURI; the distinction is deliberate.
    for (const taskId of asArray(node.usingTask)) {
      el.get('usingTask').push(create('dmn:DMNElementReference', { href: taskId })); // nest
    }
    for (const procId of asArray(node.usingProcess)) {
      el.get('usingProcess').push(create('dmn:DMNElementReference', { href: procId })); // nest
    }
  }

  if (node.type === 'knowledgeSource') {
    if (node.sourceType) el.type = node.sourceType;
    if (node.locationURI) el.locationURI = node.locationURI;
  }

  if (node.type === 'businessKnowledgeModel' && (node.parameters?.length || node.body != null)) {
    el.encapsulatedLogic = buildFunctionDefinition(node); // nest
  }

  return el;
}

/**
 * Requirements nest under their TARGET (the requiring element), each carrying a
 * dmn:DMNElementReference href-wrapper (a STRING href, NOT an object reference — the exact
 * opposite pattern from dmnElementRef below; getting this backwards drops XML silently,
 * dmn-external-ground-truth.md §A.4 gotcha 2) pointing at the SOURCE (the required element).
 * Returns a Map from requirement key -> the built requirement moddle element, for the DMNDI
 * writer to look up by edgeCoords key.
 *
 * The key comes from requirementKey() (Global Constraint 8) — the SAME helper Task 3's
 * buildDmnDiagrams uses to key edgeCoords. Do not inline a second copy of the formula here:
 * a mismatch does not throw, it silently drops the DMNEdge for every requirement lacking an
 * explicit id, because the lookup returns undefined and the caller skips it as "no waypoints".
 *
 * The key is also used as the element's `id` when the requirement has none. That is not
 * cosmetic: `dmnElementRef` is an object reference, which moddle serialises as the referenced
 * element's id. A requirement element without an id therefore cannot be referenced, and its
 * DMNEdge would be emitted with an unresolvable reference.
 */
function attachRequirements(dc, nodeMap) {
  const nodesById = new Map(dc.nodes.map((n) => [n.id, n]));
  const requirementMap = new Map();
  for (const req of (dc.requirements ?? [])) {
    const targetEl = nodeMap.get(req.target);
    const sourceNode = nodesById.get(req.source);
    if (!targetEl || !sourceNode) continue; // D01 guarantees this for rule-gated input; defend anyway
    const key = requirementKey(req);
    const ref = create('dmn:DMNElementReference', { href: `#${req.source}` });
    let reqEl;
    if (req.type === 'information') {
      reqEl = create('dmn:InformationRequirement', { id: key });
      if (sourceNode.type === 'decision') reqEl.requiredDecision = ref;
      else if (sourceNode.type === 'inputData') reqEl.requiredInput = ref;
      else {
        // DMN 1.3 §6.2.3 Table 2: an InformationRequirement's source must be a decision
        // (-> requiredDecision) or inputData (-> requiredInput). A knowledgeSource (or any
        // other node type) is not a legal source for this requirement kind — only an
        // AuthorityRequirement may point at a knowledgeSource. D03 rejects this pairing by
        // default; this throw is the last line of defense when that rule has been disabled.
        throw new Error(
          `Illegal information requirement: source "${req.source}" is a ${sourceNode.type}, ` +
          `but an InformationRequirement's source must be a decision or inputData ` +
          `(DMN 1.3 §6.2.3, Table 2).`);
      }
      targetEl.get('informationRequirement').push(reqEl); // nest
    } else if (req.type === 'knowledge') {
      reqEl = create('dmn:KnowledgeRequirement', { id: key, requiredKnowledge: ref });
      targetEl.get('knowledgeRequirement').push(reqEl); // nest
    } else if (req.type === 'authority') {
      reqEl = create('dmn:AuthorityRequirement', { id: key });
      if (sourceNode.type === 'decision') reqEl.requiredDecision = ref;
      else if (sourceNode.type === 'inputData') reqEl.requiredInput = ref;
      else reqEl.requiredAuthority = ref; // knowledgeSource
      targetEl.get('authorityRequirement').push(reqEl); // nest
    } else {
      continue;
    }
    requirementMap.set(key, reqEl);
  }
  return requirementMap;
}

function buildDmnDI(diagrams, nodeMap, requirementMap) {
  const dmnDiagrams = [];
  for (const diagram of diagrams) {
    const diagramElements = [];
    for (const [nodeId, c] of Object.entries(diagram.coordMap.coords)) {
      const nodeEl = nodeMap.get(nodeId);
      if (!nodeEl) continue;
      const bounds = create('dc:Bounds', { x: rn(c.x), y: rn(c.y), width: rn(c.w), height: rn(c.h) });
      diagramElements.push(create('dmndi:DMNShape', { id: `${nodeId}_di`, dmnElementRef: nodeEl, bounds })); // nest
    }
    for (const [reqKey, pts] of Object.entries(diagram.coordMap.edgeCoords)) {
      const reqEl = requirementMap.get(reqKey);
      if (!reqEl || pts.length < 2) continue; // better no DMNEdge than an invalid one
      const waypoint = pts.map((p) => create('dc:Point', { x: rn(p.x), y: rn(p.y) }));
      diagramElements.push(create('dmndi:DMNEdge', { id: `${reqKey}_di`, dmnElementRef: reqEl, waypoint })); // nest
    }
    dmnDiagrams.push(create('dmndi:DMNDiagram', { // nest
      id: diagram.id,
      name: diagram.name,
      // dmndi:DMNDiagram/size is typed `dmndi:Size` (DMNDI13.xsd), which extends dc:Dimension but
      // is its own element — `dc:Dimension` directly here serialises as an element the schema does
      // not expect at this position (verified empirically against dmn-moddle's own descriptor,
      // resources/dmn/json/dmndi13.json: DMNDiagram.size has type "Size", and Size's only
      // superClass is dc:Dimension — it carries the same width/height attributes but its own tag).
      size: create('dmndi:Size', { width: rn(diagram.size.w), height: rn(diagram.size.h) }),
      diagramElements,
    }));
  }
  return create('dmndi:DMNDI', { diagrams: dmnDiagrams });
}

export async function generateDmnXml(dc, diagrams) {
  if (!dc.namespace) {
    // DMN13.xsd tDefinitions/@namespace is use="required" — omitting it produces XML that
    // xmllint rejects ("The attribute 'namespace' is required but missing"), but neither
    // dmn-moddle's writer nor validateDmnXml's round trip notices: moddle happily serialises the
    // attribute as absent and re-parses its own output without complaint, so nothing downstream
    // of this function would catch it. references/decision-core-schema.json already requires
    // `namespace`, so the schema gate rejects this before generateDmnXml is ever reached in
    // production — but this function is exported and callable directly (Task 6, tests, future
    // callers), and a fallback value here would invent a namespace URI, which is worse than
    // refusing outright.
    throw new Error('generateDmnXml: dc.namespace is required (DMN13.xsd tDefinitions/@namespace, use="required")');
  }
  const definitions = create('dmn:Definitions', {
    id: dc.id || 'Definitions_1',
    name: dc.name || dc.id || 'Definitions_1',
    namespace: dc.namespace,
    ...(dc.expressionLanguage ? { expressionLanguage: dc.expressionLanguage } : {}),
    ...(dc.documentation ? { description: dc.documentation } : {}),
  });

  const nodeMap = new Map();
  for (const node of dc.nodes) {
    const el = buildDrgElement(node);
    nodeMap.set(node.id, el);
    definitions.get('drgElement').push(el); // nest
  }

  const requirementMap = attachRequirements(dc, nodeMap);
  definitions.set('dmnDI', buildDmnDI(diagrams, nodeMap, requirementMap)); // nest

  const { xml } = await moddle.toXML(definitions, { format: true, preamble: true });
  return xml;
}

/**
 * Round-trip validate DMN XML by parsing it back through dmn-moddle. Mirrors
 * scripts/bpmn/bpmn-xml.js's validateBpmnXml exactly, except the return shape has no `valid`
 * key — the interface contract (Task 6 depends on this) is `Promise<{ warnings: [...] }>`.
 */
export async function validateDmnXml(xml) {
  const { warnings } = await moddle.fromXML(xml);
  return { warnings: warnings.map((w) => w.message || String(w)) };
}

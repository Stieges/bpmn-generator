/**
 * DMN 1.3 coverage authority — what this project can represent in Decision-Core, and what it
 * cannot.
 *
 * WHY THIS FILE EXISTS
 *
 * `scripts/dmn/` was write-direction only, and a writer only ever emits what Decision-Core can
 * already say. An importer reads files we did NOT write, so the interesting question flips: what
 * does a foreign `.dmn` carry that we have no slot for? A round-trip fence cannot answer it —
 * `references/decision-core-schema.json` is `additionalProperties: false` throughout, so there is
 * no slot for unrepresentable content to spill into and be noticed in.
 *
 * And the loss is silent by construction. Probed against dmn-moddle, a document carrying
 * `itemDefinition + decisionService + textAnnotation` parses with ZERO warnings — every one of
 * those is fully present in the tree and trivially ignorable by a naive `drgElement` loop. moddle
 * warns about elements it does not KNOW, never about elements a consumer does not READ. Measured
 * on the registry: 38 concrete `dmn:` types exist and the writer covers 19 — exactly half of the
 * type space had no mapping and, worse, no policy.
 *
 * This table is that policy, and `coverage.test.js` keeps it from going stale by measuring it
 * against dmn-moddle's registry rather than against a restatement of the XSD. (Hand-writing the
 * list from DMN13.xsd already gets one wrong: the XSD element is `organizationUnit` while the
 * moddle type is `dmn:OrganisationalUnit`.)
 *
 * THIS TABLE IS THE IMPORTER'S ONLY EXCLUSION LIST. There will be no second one — a construct
 * skipped anywhere in `import.js` without a row here is a defect, and from Stage 3 on the fence
 * says so (`Object.keys(HANDLERS)` must equal the `mapped` set).
 *
 * Deliberately NOT a field-authority table. BPMN needs `OMG_NODE_FIELD_SCOPE` because a field
 * lives in four places there (writer + two importers + schema) and the two importers can drift
 * apart. DMN has one importer, so there is no dual-path drift to fence; the risk that is actually
 * DMN's is whole constructs going by unmentioned, and that is what is keyed here — by type.
 *
 * No import from `scripts/bpmn/` — `scripts/dmn/` is a sibling subsystem, not a consumer.
 */

/**
 * How an occurrence of unrepresentable content is surfaced to the caller. Documented vocabulary,
 * enforced by the fence: an `unrepresentable` row must name one of these, so "we drop it" can
 * never be written down without also saying how the caller finds out.
 *
 * - `element`   one report entry per occurrence, carrying the element's id and its path in the
 *               document. The default for anything a foreign file can contain many of.
 * - `attribute` one entry per occurrence of an attribute sitting on an otherwise-mapped element —
 *               the element still imports, one of its attributes does not.
 * - `document`  one entry for the whole document when the construct is present at all. For
 *               constructs where per-occurrence detail buys the caller nothing (a diagram's
 *               hundred shapes are one fact: "geometry was dropped").
 * - `subsumed`  recorded here for the record, but surfaced through another row's entry rather than
 *               its own. Never valid on a `dmn:` type row — only on a NON_TYPE_GAPS entry that
 *               lives inside a construct already reported as a whole.
 */
export const REPORT_KINDS = ['element', 'attribute', 'document', 'subsumed'];

/**
 * One row per concrete `dmn:` type in dmn-moddle's registry. Exactly one — the fence checks both
 * directions, so a missing row and a stale row each fail naming themselves.
 *
 * `status`:
 *   - `mapped`           Stage 3's importer turns it into Decision-Core. Carries `to`, naming the
 *                        target. May also carry `reason` where the mapping is partial — that is
 *                        not a loophole, it is the place a caveat is allowed to be written down
 *                        instead of being lost.
 *   - `unrepresentable`  Decision-Core has no slot. Carries `reason` and `report`.
 *   - `structural`       Not content at all — a reference mechanism, or a container whose meaning
 *                        is entirely absorbed by the thing it contains. Carries `reason`. Nothing
 *                        is lost, so there is nothing to report.
 */
export const DMN_COVERAGE = [

  // ── The document root ──────────────────────────────────────────────────────────────────────
  //
  // Judgment call (recorded, not assumed): `mapped`, not `structural`. Definitions is a container,
  // which argues for structural — but four of its attributes are Decision-Core content in their
  // own right (`@namespace` is even REQUIRED by the schema, and nothing else in the document can
  // supply it). A construct the importer must actively read to produce a valid result is mapped;
  // structural is reserved for what the importer reads THROUGH.
  { type: 'dmn:Definitions', status: 'mapped',
    to: 'the Decision-Core root: id, name, namespace, expressionLanguage, documentation',
    reason: 'Partial: @typeLanguage and @exporter/@exporterVersion have no Decision-Core slot. '
      + 'They are provenance about the producing tool, not about the decision model, and the '
      + 'generator re-stamps its own on emit — carrying a foreign exporter name through would '
      + 'make the re-emitted file claim an origin it does not have.' },

  // ── The four DRG element classes Decision-Core knows ───────────────────────────────────────
  { type: 'dmn:Decision', status: 'mapped',
    to: 'Node{type:"decision"} — id, name, documentation, question, allowedAnswers, variable, '
      + 'typeRef, usingTask, usingProcess, and decisionLogic as decisionTable or expression',
    reason: 'Partial: @decisionMaker/@decisionOwner (to an OrganisationalUnit), '
      + '@supportedObjective (to a PerformanceIndicator) and @impactedPerformanceIndicator point '
      + 'at business-context classes Decision-Core does not have, so those references are dropped '
      + 'with their targets — see the dmn:OrganisationalUnit and dmn:PerformanceIndicator rows.' },
  { type: 'dmn:InputData', status: 'mapped',
    to: 'Node{type:"inputData"} — id, name, documentation, variable, typeRef' },
  { type: 'dmn:KnowledgeSource', status: 'mapped',
    to: 'Node{type:"knowledgeSource"} — id, name, documentation, sourceType (from @type), '
      + 'locationURI',
    reason: 'Partial: @owner points at an OrganisationalUnit and is dropped with it.' },
  { type: 'dmn:BusinessKnowledgeModel', status: 'mapped',
    to: 'Node{type:"businessKnowledgeModel"} — id, name, documentation, variable, typeRef, and '
      + 'its encapsulatedLogic via dmn:FunctionDefinition' },

  // ── The three requirement classes ──────────────────────────────────────────────────────────
  //
  // DMN nests a requirement inside the element that REQUIRES it; Decision-Core stores source and
  // target in flow direction on a flat list, exactly as the BPMN side already flattens boundary
  // events. The importer therefore reads the nesting parent as `target` and the @href as `source`.
  { type: 'dmn:InformationRequirement', status: 'mapped',
    to: 'Requirement{type:"information"} — target is the nesting element, source is '
      + 'requiredDecision/requiredInput' },
  { type: 'dmn:KnowledgeRequirement', status: 'mapped',
    to: 'Requirement{type:"knowledge"} — target is the nesting element, source is '
      + 'requiredKnowledge' },
  { type: 'dmn:AuthorityRequirement', status: 'mapped',
    to: 'Requirement{type:"authority"} — target is the nesting element, source is '
      + 'requiredAuthority/requiredDecision/requiredInput' },

  // ── Decision table and its parts ───────────────────────────────────────────────────────────
  { type: 'dmn:DecisionTable', status: 'mapped',
    to: 'Node.decisionTable — id, hitPolicy, aggregation, preferredOrientation, outputLabel' },
  { type: 'dmn:InputClause', status: 'mapped',
    to: 'DecisionTable.inputs[] — id, label (@label), expression and typeRef (from its '
      + 'inputExpression), allowedValues (from inputValues)' },
  { type: 'dmn:OutputClause', status: 'mapped',
    to: 'DecisionTable.outputs[] — id, label/name, typeRef, allowedValues (from outputValues), '
      + 'defaultValue (from defaultOutputEntry)' },
  { type: 'dmn:DecisionRule', status: 'mapped',
    to: 'DecisionTable.rules[] — id, documentation, when[] (inputEntry), then[] (outputEntry), '
      + 'annotations[] (annotationEntry)' },
  { type: 'dmn:RuleAnnotationClause', status: 'mapped',
    to: 'DecisionTable.annotations[] — the annotation COLUMN headers; carries only @name, since '
      + 'tRuleAnnotationClause is one of the few DMN types that does not extend tDMNElement and '
      + 'therefore has no id' },
  { type: 'dmn:RuleAnnotation', status: 'mapped',
    to: 'DecisionRule.annotations[] — the per-rule annotation cell text' },

  // ── Expressions Decision-Core carries as text ──────────────────────────────────────────────
  //
  // Decision-Core stores every expression as a string and parses no FEEL. That is a deliberate
  // scope line, not an omission: the generator draws and checks decision structure, it does not
  // evaluate. It is also why the four BOXED expression types below are unrepresentable — they are
  // structure, and flattening them to text would be inventing a serialisation the file never had.
  { type: 'dmn:LiteralExpression', status: 'mapped',
    to: 'text into whichever string slot its position implies: Node.expression (a decision\'s '
      + 'decisionLogic), Node.body (a BKM\'s function body), InputClause.expression, '
      + 'OutputClause.defaultValue, or DecisionRule.then[]',
    reason: 'Partial: @expressionLanguage on an individual expression is dropped — Decision-Core '
      + 'carries one language for the whole document (root `expressionLanguage`), so a file that '
      + 'mixes languages per expression loses the per-expression override.' },
  { type: 'dmn:UnaryTests', status: 'mapped',
    to: 'text into DecisionRule.when[], InputClause.allowedValues or OutputClause.allowedValues',
    reason: 'Partial: as with LiteralExpression, a per-expression @expressionLanguage is dropped '
      + 'in favour of the document-wide one.' },
  { type: 'dmn:FunctionDefinition', status: 'mapped',
    to: 'a BKM\'s Node.parameters[] (from formalParameter) and Node.body (from its body, when '
      + 'that body is a LiteralExpression)',
    reason: 'Partial, and the boundary is worth stating: DMN allows a FunctionDefinition body to '
      + 'be ANY expression — a Context, an Invocation, a DecisionTable. Decision-Core\'s `body` is '
      + 'a string, so only a literal-expression body survives. A BKM whose logic is a boxed '
      + 'expression imports as a BKM with no body, and the body\'s own type reports as '
      + 'unrepresentable through its own row. @kind (FEEL/Java/PMML) is dropped with it.' },
  { type: 'dmn:InformationItem', status: 'mapped',
    to: 'Node.variable + Node.typeRef when it is an element\'s output variable; '
      + 'Node.parameters[]{name,typeRef} when it is a BKM formal parameter',
    reason: 'Partial: the InformationItem\'s own id is not read. The writer generates it as '
      + '`<node>_var` and regenerates the identical value on emit, so importing it would promote '
      + 'a generated id to an authored one for no gain. A foreign file\'s hand-written variable id '
      + 'is therefore replaced on re-emit — the variable\'s name and type survive, its identity '
      + 'does not.' },

  // ── Structural: read through, never read out ───────────────────────────────────────────────
  //
  // Judgment call (recorded): `structural`, not `mapped`, even though the requirements that use it
  // ARE mapped. DMNElementReference has exactly one property, @href, and it is a pointer. Its
  // content is always the identity of some OTHER element, and that identity is already the
  // `source` of the Requirement row, or an entry in Node.usingTask/usingProcess. Calling it
  // `mapped` would give the importer a second place to claim the same fact — and the point of a
  // single authority table is that every fact has exactly one row that owns it. Nothing is lost
  // here, which is why it carries no `report`.
  { type: 'dmn:DMNElementReference', status: 'structural',
    reason: 'The @href pointer mechanism, not content. It has no meaning of its own: what it '
      + 'names is recorded by whatever contains it — the Requirement\'s `source`, or an id in '
      + 'Node.usingTask/usingProcess. An href pointing INTO another document (`file.dmn#id`, only '
      + 'possible together with dmn:Import) is a different matter and is reported through the '
      + 'dmn:Import row, since without the import there is nothing for it to resolve against.' },

  // ── Boxed expressions: structure Decision-Core cannot hold ─────────────────────────────────
  { type: 'dmn:Context', status: 'unrepresentable', report: 'element',
    reason: 'A boxed context expression — a list of named sub-expressions evaluated together, one '
      + 'of DMN\'s two structured alternatives to a decision table. Decision-Core gives a decision '
      + 'exactly two logic slots, `decisionTable` (structured) and `expression` (one string), and '
      + 'a context is neither. Flattening it into the string slot would invent a textual form the '
      + 'file never contained and that nothing here can read back. The decision itself still '
      + 'imports; it arrives with no logic, which is why each occurrence is reported.' },
  { type: 'dmn:ContextEntry', status: 'unrepresentable', report: 'element',
    reason: 'One `variable: expression` pair inside a dmn:Context. It cannot be represented for '
      + 'the same reason its parent cannot, and it is listed separately rather than folded into '
      + 'the Context row because the parser produces it as a type of its own — a row per concrete '
      + 'type is what makes the fence a set equality against the registry.' },
  { type: 'dmn:Invocation', status: 'unrepresentable', report: 'element',
    reason: 'A boxed invocation — calling a BusinessKnowledgeModel with bound arguments. '
      + 'Decision-Core models the knowledge REQUIREMENT (decision needs BKM) but not the call: '
      + 'there is no slot for the argument bindings, so an imported invocation would silently '
      + 'become "this decision uses that BKM, somehow". The requirement edge still imports; the '
      + 'call does not.' },
  { type: 'dmn:Binding', status: 'unrepresentable', report: 'element',
    reason: 'One parameter-to-expression binding inside a dmn:Invocation, and unrepresentable for '
      + 'the same reason. Note it appears in dmn-xml.js\'s NO_ID_TYPES guard, which lists types '
      + 'that must not carry an id — that guard is a correctness fence over the type NAME, not '
      + 'evidence that the writer ever creates one. It does not: no Binding is written and none '
      + 'can be read.' },
  { type: 'dmn:List', status: 'unrepresentable', report: 'element',
    reason: 'A boxed list expression (an ordered collection of expressions as decision logic). '
      + 'Same wall as dmn:Context: Decision-Core has one structured logic slot and it is shaped '
      + 'like a decision table.' },
  { type: 'dmn:Relation', status: 'unrepresentable', report: 'element',
    reason: 'A boxed relation — rows and named columns, a table of VALUES rather than of rules. '
      + 'It looks close enough to a decision table to be tempting, and importing it as one would '
      + 'be wrong in a way nothing downstream could detect: a relation has no hit policy and no '
      + 'input clauses, so `analyzeDecisionTable` would report gaps and overlaps for a construct '
      + 'that has neither concept.' },

  // ── The type system ────────────────────────────────────────────────────────────────────────
  { type: 'dmn:ItemDefinition', status: 'unrepresentable', report: 'element',
    reason: 'The document\'s type definitions — a named type with components, an allowed-value '
      + 'range, or a collection flag. Decision-Core carries `typeRef` as a bare string wherever a '
      + 'type is referenced, so a reference to a custom type survives as its NAME while the '
      + 'definition behind it is lost. Re-emitting produces a file whose typeRefs resolve to '
      + 'nothing. This is the single most likely construct in a real externally authored model, '
      + 'which is why it reports per occurrence with its id rather than as one summary line.' },
  { type: 'dmn:FunctionItem', status: 'unrepresentable', report: 'element',
    reason: 'A function SIGNATURE inside an ItemDefinition (parameter types plus return type), '
      + 'used to type a variable that holds a function. It is lost with its enclosing '
      + 'ItemDefinition; Decision-Core has no type declarations at all, function-shaped or not.' },
  { type: 'dmn:ImportedValues', status: 'unrepresentable', report: 'element',
    reason: 'An input or output clause whose allowed values are not written in the file but '
      + 'fetched from an imported model. Decision-Core\'s `allowedValues` is a literal string, so '
      + 'there is nowhere to put "look them up over there". The clause still imports, with no '
      + 'allowed values — which reads as "any value permitted" and is the opposite of what the '
      + 'file says, so the occurrence must be reported rather than left to inference.' },

  // ── Cross-document reference ───────────────────────────────────────────────────────────────
  { type: 'dmn:Import', status: 'unrepresentable', report: 'element',
    reason: 'A reference to another DMN (or XSD, or PMML) model, whose elements the importing '
      + 'file may then name through prefixed hrefs. Decision-Core describes one self-contained '
      + 'model and has no multi-document concept — there is no slot for the import, and no '
      + 'resolution step that could inline what it points at. Every href that depends on it '
      + 'therefore dangles: this is the one unrepresentable construct that also breaks OTHER '
      + 'elements\' correctness, not just its own.' },

  // ── Grouping and business context ──────────────────────────────────────────────────────────
  { type: 'dmn:DecisionService', status: 'unrepresentable', report: 'element',
    reason: 'A named, callable grouping of decisions — four reference lists (output decisions, '
      + 'encapsulated decisions, input decisions, input data) plus its own DI divider line. '
      + 'Decision-Core\'s Node.type enum has four members and this is deliberately not one of '
      + 'them: the construct is a packaging boundary over decisions that already exist, so '
      + 'dropping it loses the boundary but no decision. It parses with zero moddle warnings and '
      + 'sits in the same `drgElement` list as a Decision, which makes it the textbook case for '
      + 'this whole table — a naive loop drops it in perfect silence.' },
  { type: 'dmn:ElementCollection', status: 'unrepresentable', report: 'element',
    reason: 'A named set of decisions, DMN\'s lightweight grouping construct (tElementCollection). '
      + 'Like DecisionService it groups elements that import fine on their own, so the loss is the '
      + 'grouping, not the content.' },
  { type: 'dmn:OrganisationalUnit', status: 'unrepresentable', report: 'element',
    reason: 'A business context element naming who makes and who owns decisions '
      + '(decisionMade/decisionOwned). Decision-Core models the decision graph, not the '
      + 'organisation around it. Note the spelling: moddle\'s type is British '
      + '(OrganisationalUnit) while the XSD element is `organizationUnit` — a list written from '
      + 'the XSD misses this row, which is why the fence\'s oracle is the registry.' },
  { type: 'dmn:PerformanceIndicator', status: 'unrepresentable', report: 'element',
    reason: 'A business context element naming a measure that decisions impact '
      + '(impactingDecision). Same boundary as OrganisationalUnit: it describes why the model '
      + 'matters to a business, and Decision-Core describes what the model computes.' },

  // ── Artifacts ──────────────────────────────────────────────────────────────────────────────
  { type: 'dmn:TextAnnotation', status: 'unrepresentable', report: 'element',
    reason: 'Free text attached to the diagram — the DRD\'s equivalent of a BPMN text annotation. '
      + 'Decision-Core has `documentation` on the root and on each node, but no free-floating '
      + 'note, and folding an annotation into the documentation of whatever it happens to point '
      + 'at would change an author\'s aside into a formal description of an element. It parses '
      + 'with zero warnings into `artifact`, a list nothing here reads.' },
  { type: 'dmn:Association', status: 'unrepresentable', report: 'element',
    reason: 'The connector tying a dmn:TextAnnotation to the element it comments on. It is lost '
      + 'with the annotation; an association whose annotation is gone would have nothing to say.' },
  { type: 'dmn:Group', status: 'unrepresentable', report: 'element',
    reason: 'A visual box drawn around elements on the DRD. Purely presentational — it carries no '
      + 'semantics and, unlike a BPMN Group, not even a membership list; which elements are inside '
      + 'is decided by geometry alone. Decision-Core is coordinate-free by design, so there is '
      + 'nothing left of a Group to keep.' },

  // ── Extension points ───────────────────────────────────────────────────────────────────────
  { type: 'dmn:ExtensionElements', status: 'unrepresentable', report: 'element',
    reason: 'The standard container for vendor content (Camunda, Signavio, …) on any DMN element. '
      + 'Decision-Core\'s schema is `additionalProperties: false` throughout, so there is by '
      + 'construction nowhere for foreign content to land — that is the property the schema is '
      + 'for, and it is also exactly why this content cannot be quietly carried through. Reported '
      + 'per occurrence so the caller can see WHICH element was stripped, since the element itself '
      + 'imports normally and looks intact.' },
  { type: 'dmn:ExtensionAttribute', status: 'unrepresentable', report: 'attribute',
    reason: 'A single named extension value, the attribute-shaped sibling of ExtensionElements. '
      + 'Reported as an attribute rather than an element: the element it sits on imports fine and '
      + 'only this value is dropped, so the report should say "this element lost this attribute" '
      + 'and not imply the element was skipped.' },
];

/**
 * The two known losses that are not `dmn:` types, and therefore cannot be rows above.
 *
 * Why a sibling export rather than extra rows: the fence's first assertion is a SET EQUALITY
 * against dmn-moddle's registry. A row the registry can never confirm would force that assertion
 * down to a subset test, and the set equality is the one thing the whole fence rests on — it is
 * what makes a dmn-moddle upgrade fail CI naming the new type. Keeping these two out of
 * DMN_COVERAGE costs nothing (the importer reads both exports) and keeps the equality exact. The
 * fence still checks them: same shape rules, plus an assertion that they are genuinely NOT
 * concrete `dmn:` types, so this list cannot become a bypass for a type that belongs above.
 */
export const NON_TYPE_GAPS = [
  { construct: 'dmndi:DMNDI', status: 'unrepresentable', report: 'document',
    reason: 'The whole diagram-interchange tree — DMNShape and DMNEdge bounds, waypoints, styles. '
      + 'Dropped entirely, and by design rather than by omission: Decision-Core is coordinate-free '
      + 'and `dmn/layout.js` re-lays-out the DRD on every emit, so there is no slot to import into '
      + 'and no step that would consume one. The consequence is worth stating plainly, because it '
      + 'is the loss a user will actually SEE: import-then-emit returns a correct model with a '
      + 'different-looking diagram. Reported once per document rather than per shape — a hundred '
      + 'shapes are one fact, and listing them would bury the rows that need acting on.' },
  { construct: 'dmndi:DMNShape@isCollapsed', status: 'unrepresentable', report: 'subsumed',
    reason: 'Whether a DecisionService is drawn collapsed. Recorded here because '
      + 'docs/superpowers/plans/2026-07-30-dmn-integration.md Stage 5 instructs the importer to '
      + 'read it from the DI — that instruction is VOID and this row is why: Decision-Core has no '
      + '`isCollapsed` property and its schema forbids extras, so there is no target for the read. '
      + 'It is also moot twice over, since the only thing it can sit on is a dmn:DecisionService, '
      + 'which is itself unrepresentable. Report kind `subsumed`: it lives inside the DMNDI tree, '
      + 'which already reports as a whole, so a separate line would say nothing new.' },
];

/** The row for a moddle type, or undefined when the type is not a concrete `dmn:` type. */
export function coverageFor(type) {
  return DMN_COVERAGE.find((row) => row.type === type);
}

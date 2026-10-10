/**
 * DMN 1.3 import scope — what a foreign `.dmn` file can contain, and what becomes of each part of
 * it here: represented in Decision-Core, merely reported, or never even seen by our parser.
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
 * warns about elements it does not KNOW, never about elements a consumer does not READ.
 *
 * THIS TABLE IS THE IMPORTER'S ONLY EXCLUSION LIST. There will be no second one — a construct
 * skipped anywhere in `import.js` without a row here is a defect, and from Stage 3 on the fence
 * says so (`Object.keys(HANDLERS)` must equal the `mapped` set).
 *
 * WHY THE KEY IS THE XSD ELEMENT NAME AND NOT THE MODDLE TYPE
 *
 * Because a table keyed by the parser's own vocabulary is consistent with itself no matter what it
 * claims about the world. dmn-moddle knows `dmn:OrganisationalUnit`, so a type-keyed table has a
 * row for it, so a registry-only fence is green — while a conformant file writes
 * `<organizationUnit>`, the AMERICAN spelling the XSD declares (`DMN13.xsd:132`), and dmn-moddle
 * cannot parse that at all:
 *
 *   <organizationUnit id="ou1" name="Finance"/>
 *   → warnings: ['unparsable content <organizationUnit> detected … unknown type
 *                <dmn:OrganizationUnit>']
 *   → businessContextElement: 0   — the element is GONE from the tree
 *
 * The old table called that construct "unrepresentable", which was factually wrong about the
 * mechanism: there is no path into our code for it to be unrepresentable ON. Hence the third
 * disposition, `parser-blind`, and hence the primary key being the name a real file actually
 * writes. `moddleType` survives as a column, and the divergence between the two is exactly what
 * fence F2 measures.
 *
 * Same class, second member — an id our parser rejects outright:
 *
 *   id="plain_ok"           → parsed
 *   id="my.decision"        → parsed   (legal DMN; OUR schema's id pattern used to reject it — now
 *                             accepted, see IM07 below: Stage 2 of the dmn-xml-importer plan
 *                             widened `decision-core-schema.json`'s id pattern from
 *                             `^[a-zA-Z_][a-zA-Z0-9_-]*$` to `^[a-zA-Z_][a-zA-Z0-9_.-]*$`)
 *   id="Entscheidung_Über"  → DROPPED, warnings: ['unparsable content <decision> detected …
 *                             illegal ID <Entscheidung_Über>']  → IM08
 *
 * That one is a property of an id VALUE rather than of an element class, so it has no row; it lives
 * in IMPORT_CODES, which is the importer's finding vocabulary and is deliberately wider than this
 * table (IM04 and IM07 are reachable at run time without any row naming them).
 *
 * IM07's remaining domain, and why it was not closed by widening further (Stage 2, recorded here
 * because a later reader who notices `xsd:ID`/NCName permits Unicode letters is the reader this
 * paragraph is for): `\p{L}` would compile under ajv 8's `u`-flagged `pattern`, so the schema
 * COULD accept `Entscheidung_Über`. Measured against dmn-moddle, though, doing so would not close
 * the gap — it would silently trade it for a worse one. dmn-moddle WRITES a non-ASCII id without
 * complaint and then cannot READ it back: `id="my.decision"` round-trips clean (1 drgElement, no
 * warnings), `id="Entscheidung_Über"` round-trips to 0 drgElements with `'unparsable content
 * <dmn:decision>'` and `'unresolved reference <Entscheidung_Über>'` among the warnings — the exact
 * IM08 mechanism, on OUR OWN emitted output. So a Unicode Decision-Core id would let the pipeline
 * generate a `.dmn` file the pipeline's own importer cannot read — the round-trip breakage this
 * whole plan exists to fence. That is a dmn-moddle library defect (its `Ids.assign` validation is
 * ASCII-only, narrower than the NCName it claims to check), not a design choice on our part, and
 * not one this project can widen its way past: it lives one layer below the schema. IM07 therefore
 * still fires, but its domain shrank to "legal DMN id, and parseable by dmn-moddle, that our schema
 * cannot hold" — after the ASCII-plus-`.` widening, no such id is known; every remaining case that
 * used to reach IM07 (a Unicode id) is intercepted one step earlier by dmn-moddle itself and reaches
 * IM08 instead.
 *
 * WRITING A ROW — the guide the fences point at
 *
 *   { xsdElement, xsdFile, moddleType, disposition, mapsTo?, unrepresented?, code?, reason?, blind? }
 *
 *   xsdElement    the name a conformant file writes. Primary key together with `xsdFile`.
 *   xsdFile       'DMN13' | 'DMNDI13' — which XSD declares the element.
 *   moddleType    the dmn-moddle type the parser resolves that name to, `null` when it resolves to
 *                 none. F2 checks this against dmn-moddle rather than trusting it.
 *   disposition   one of:
 *     `mapped`        the importer reads it into a Decision-Core slot. Carries `mapsTo`
 *                     (property → slot) and `unrepresented[]` for every descriptor property that
 *                     has no slot. Between them they must account for EVERY property of the
 *                     descriptor, inherited ones included — that is fence F1b.
 *   mapsTo        Its KEYS are load-bearing: each must be a real property of the row's descriptor
 *                 (F1b rejects an invented one), the set of them is what Stage 3's handler set is
 *                 derived from, and the fence follows them into the types behind them
 *                 (`DMN_NESTED_TYPE_COVERAGE`). Its VALUES are sentences for humans that BEGIN
 *                 with a machine-read Decision-Core slot: fence F1c resolves that leading slot —
 *                 `Type.property` (Type a `$defs` entry of references/decision-core-schema.json),
 *                 `Type{type:"x"}` (a Requirement kind) or a root-level `property` — and every
 *                 other `Type.property` token in the value, against the SCHEMA, not against this
 *                 file. The oracle is the schema, so a row cannot claim a slot that does not exist;
 *                 what F1c cannot see is whether the importer writes it (the schema-gate guard on
 *                 the roundtrip does that, wherever a fixture exercises the field). The prose
 *                 after the slot may be rewritten freely; the slot may not.
 *   multiTarget   Optional, on a row or nested-type entry: `{ <mapsTo key>: reason }` for a value
 *                 that genuinely has no single leading slot (the target depends on where the
 *                 element sits). It lifts only the leading-slot requirement — the embedded
 *                 `Type.property` tokens are still resolved, and there must be at least one.
 *     `reported`      dmn-moddle surfaces it, Decision-Core cannot hold it, the importer emits a
 *                     finding. Carries `code` + `reason`.
 *     `parser-blind`  dmn-moddle cannot surface it; the only evidence is `warnings[]`. Carries
 *                     `moddleType: null`, `code: 'IM08'`, a `reason` naming the mechanism, and
 *                     `blind` (see below).
 *   unrepresented Which code to use: a property gap on a mapped type is IM05 — except where the
 *                 property is the container of an element that has a row of its own, in which case
 *                 it takes THAT row's code, so a caller meets the same code from either direction.
 *   blind         `{ mechanism, moddleTypeIfReachable }`. `moddleType: null` on its own cannot
 *                 distinguish "dmn-moddle has no concept for this" from "dmn-moddle has the
 *                 concept under a name no conformant file writes". The second names the
 *                 unreachable type, and F2 asserts that type really exists — so the day a
 *                 dmn-moddle release fixes the spelling, the fence goes red instead of leaving a
 *                 row understating what we could by then read.
 *
 * Deliberately NOT a field-authority table in the BPMN sense. `OMG_NODE_FIELD_SCOPE` exists because
 * a BPMN field lives in four places (writer + two importers + schema) and the two importers can
 * drift apart. DMN has one importer, so there is no dual-path drift to fence; DMN's risk is whole
 * constructs going by unmentioned, and that is what is keyed here.
 *
 * Dependency-free on purpose — no `dmn-moddle` import, no I/O — mirroring `scripts/bpmn/types.js`.
 * All derivation lives in `import-coverage.test.js`. No import from `scripts/bpmn/`:
 * `scripts/dmn/` is a sibling subsystem, not a consumer.
 */

/**
 * How an element escapes the parser. Vocabulary rather than free text, because "we never see it" is
 * a claim about a MECHANISM and the two mechanisms have different futures: a spelling divergence is
 * fixed by an upstream release, an absent type by an upstream release too — but only the first
 * leaves a usable type sitting there under another name today.
 *
 * - `spelling`  dmn-moddle has the concept, under a name the XSD does not declare. Names the
 *               unreachable type in `blind.moddleTypeIfReachable`.
 * - `absent`    dmn-moddle has no type for the element at all. `moddleTypeIfReachable: null`.
 */
export const BLIND_MECHANISMS = ['spelling', 'absent'];

/**
 * WHOSE PROBLEM A FINDING IS — the axis `formatImportReport` groups by.
 *
 * Judgment call 3 of Stage 4, recorded: this lives here, as a column on `IMPORT_CODES`, rather than
 * as a set of code names inside the formatter. The formatter already reads `title` and `remedy` from
 * this register, so reading a third field is no new coupling — whereas a hand-written grouping in
 * the formatter would be a SECOND authority about codes, and this plan has now been bitten twice by
 * exactly that shape (the `exceptAt` contradiction, and the derived-map key that ignored
 * `containerType`). With the column here, a fence can assert that every code carries a kind, so a
 * new code cannot land ungrouped.
 *
 * The distinction is worth making at all because the two answers call for completely different
 * actions: "this tool cannot represent your construct" is ours to widen or to live with, "your file
 * is invalid" is fixed at the source and nowhere else. A report that blurs them teaches people to
 * ignore it.
 *
 * `parser` is a third kind rather than a fudge. IM08 covers two mechanisms that genuinely fall on
 * different sides — an element whose XSD spelling dmn-moddle does not recognise (`<organizationUnit>`
 * — ours) and an id or a document dmn-moddle refuses to read (the file's) — and nothing in the
 * finding distinguishes them except its message. Claiming one owner for the pair would be the blur
 * this column exists to remove, one level down.
 *
 * Ordered: the formatter renders the kinds in declaration order, source-first, because that is the
 * section a reader can act on today.
 */
export const IMPORT_CODE_KINDS = {
  source: {
    label: 'Only the source file can fix it',
    // The axis is WHO CAN FIX IT, not "is the file conformant" — and getting that wrong once
    // already produced the exact outcome this column exists to prevent. An earlier revision read
    // "The source file is invalid", which is true of three of IM09's four cases and false of the
    // fourth: DMN13.xsd:29 makes @id optional, so a DRG element without one is legal DMN 1.3. It is
    // still unusable and still fixable only at the source, which is what puts it here — so the
    // heading says that, and each finding's own message says whether DMN forbids the shape or
    // merely permits something nothing can act on.
    blurb: 'The file does not carry information this importer needs, and nothing on this side can '
      + 'infer it. Read each message for whether the file breaks a DMN 1.3 rule or exercises a '
      + 'freedom DMN allows and nothing downstream can use. Either way: fix it there, re-import.',
  },
  tool: {
    label: 'Decision-Core has no slot for it',
    blurb: 'The file is fine; this generator\'s model is narrower than DMN. The construct is '
      + 'dropped, and the element carrying it imports normally.',
  },
  parser: {
    label: 'The parser never surfaced it',
    blurb: 'dmn-moddle built no object for this content, so a warning is the only evidence it '
      + 'existed. The cause may be on either side — read the message.',
  },
};

/**
 * The importer's finding vocabulary. Wider than the row table by design: IM04, IM07 and IM09
 * describe things that happen to CONTENT inside otherwise ordinary elements, so no element row owns
 * them.
 *
 * Every entry carries `kind` — see `IMPORT_CODE_KINDS` for what that axis is and why it lives here.
 */
export const IMPORT_CODES = {
  IM01: {
    kind: 'tool',
    title: 'DRG element class with no Decision-Core equivalent',
    remedy: 'The element itself is dropped, but read the message before assuming a decision was '
      + 'lost: a <decisionService> is a packaging boundary over decisions that already exist as '
      + 'ordinary top-level <drgElement>s, so dropping it loses THE GROUPING ONLY — every decision '
      + 'inside it is still imported, still carries its requirements, and still appears in the DRD. '
      + 'If the grouping matters, keep the source file; nothing in Decision-Core can express it.',
  },
  IM02: {
    kind: 'tool',
    title: 'decision logic in a form Decision-Core cannot hold',
    remedy: 'Decision-Core gives a decision exactly two logic slots — `decisionTable` (structured) '
      + 'and `expression` (one string) — and the boxed expressions (context, invocation, relation, '
      + 'list) are neither. The decision itself imports and arrives with no logic. To keep the '
      + 'logic, re-express it as a decision table or as a single literal expression in the source '
      + 'file before importing.',
  },
  IM03: {
    kind: 'tool',
    title: 'document-level construct outside the decision graph',
    remedy: 'Imports, type definitions, element collections, business-context elements and DRD '
      + 'artifacts describe the document AROUND the decision graph, which is all Decision-Core '
      + 'models. They are dropped. Check the message for which one: a dropped <itemDefinition> '
      + 'leaves every `typeRef` naming it dangling on re-emit, which is a correctness consequence '
      + 'and not only a cosmetic one.',
  },
  IM04: {
    kind: 'tool',
    title: 'extension content',
    remedy: 'Vendor content (Camunda, Signavio, …) in <extensionElements> or an extension '
      + 'attribute. `decision-core-schema.json` is `additionalProperties: false` throughout, so '
      + 'there is by construction nowhere for foreign content to land — that is what the schema is '
      + 'for. The host element imports normally and looks intact, which is why the finding names '
      + 'the element the content was stripped from.',
  },
  IM05: {
    kind: 'tool',
    title: 'property with no Decision-Core slot, on a type we do import',
    remedy: 'The element imports; this one property does not. The finding names both, so the loss '
      + 'is checkable rather than inferable. Where the property points at a construct with a '
      + 'finding of its own, that finding carries the detail instead.',
  },
  IM06: {
    kind: 'tool',
    title: 'diagram interchange',
    remedy: 'The whole DMNDI tree — diagrams, shape bounds, edge waypoints, styles, labels, '
      + '`isCollapsed` — is dropped, by design rather than by omission: Decision-Core is '
      + 'coordinate-free and `dmn/layout.js` re-lays-out the DRD on every emit, so there is no slot '
      + 'to import into and no step that would consume one. Expect the visible consequence: '
      + 'import-then-emit returns a correct model with a differently arranged diagram.',
  },
  IM07: {
    kind: 'tool',
    title: 'id legal in DMN, not expressible in Decision-Core',
    remedy: 'Decision-Core ids match `^[a-zA-Z_][a-zA-Z0-9_.-]*$` (widened from '
      + '`^[a-zA-Z_][a-zA-Z0-9_-]*$` in dmn-xml-importer Stage 2, so `my.decision` — a legal DMN id '
      + '— now imports) while DMN inherits the far wider xsd:ID/NCName, which additionally permits '
      + 'Unicode letters. The pattern was deliberately NOT widened that far: dmn-moddle itself '
      + 'cannot round-trip a non-ASCII id (writes it without complaint, then fails to read it back '
      + '— see IM08 and the measurement in this file\'s doc comment, and in '
      + '`references/decision-core-schema.json`\'s `id` field description), so accepting one here '
      + 'would only move the loss one step later and make it self-inflicted. This is a dmn-moddle '
      + 'library defect, not a design choice — do not widen further without re-measuring dmn-moddle '
      + 'first. A document with a Unicode id cannot be imported without editing the id at the '
      + 'source; in practice dmn-moddle intercepts such ids before our schema even sees them, so '
      + 'the finding that actually fires is IM08.',
  },
  IM08: {
    kind: 'parser',
    title: 'the parser never surfaced it',
    remedy: 'dmn-moddle could not build an object for this content, so the only evidence it existed '
      + 'is a `warnings[]` entry — there is nothing in the parsed tree for the importer to read, '
      + 'skip or report on. Two known mechanisms: an element whose XSD spelling dmn-moddle does not '
      + 'recognise (`<organizationUnit>`), and an element whose id dmn-moddle rejects as an illegal '
      + 'xsd:ID — in practice, one carrying a non-ASCII (Unicode) character, which is legal NCName '
      + 'but which dmn-moddle\'s own id validation does not accept — which drops THE WHOLE ELEMENT. '
      + 'Do not silence the parser warnings; they are the only channel this class has.',
  },
  IM09: {
    kind: 'source',
    title: 'information the source file does not carry',
    // Deliberately makes NO universal claim about conformance, because one of the four cases is
    // conformant DMN and the register text is appended to every IM09 message. Which of the four a
    // reader has is stated per finding, at the site that knows.
    remedy: 'Not a gap in this tool\'s vocabulary: the construct is one DMN can express, and this '
      + 'file leaves out something without which nothing on this side can proceed. Four cases reach '
      + 'here, plus a fifth family: a value Decision-Core requires that the file merely omits (a name, '
      + 'the namespace, a clause\'s expression), reported where it is missing. Of the four, three break a DMN 1.3 rule — a requirement naming nothing it requires (DMN13.xsd:193 '
      + 'makes the choice mandatory), a requirement reference with no @href (:42, use="required"), '
      + 'and a decision table with no output clause (:304, output has no minOccurs, so it defaults '
      + 'to 1). The fourth does not: a DRG element with no id is legal DMN (:29, @id is '
      + 'use="optional"), and is unusable anyway — nothing can name it, so no @href, no <DMNShape '
      + 'dmnElementRef> and no <decisionService> can reach it, and Decision-Core requires one on '
      + 'every node. Each case drops the element it sits on. Nothing here can infer what was meant, '
      + 'so the fix is in the source file; re-export or edit it, and re-import. Note the contrast '
      + 'with IM07, which looks similar and is not: there the id is one DMN allows AND dmn-moddle '
      + 'reads, and Decision-Core is the narrower of the two — that is this tool\'s limit, not the '
      + 'file\'s.',
  },
};

/**
 * The three `tDMNElement` properties whose fate is the same on every type that inherits them,
 * hoisted out of the rows.
 *
 * Judgment call, recorded: repeating these on all twelve mapped rows is noise that buries the
 * per-type detail that actually differs, and hoisting them costs precision only if their fate ever
 * stops being uniform. So the fence checks exactly that: each hoisted property must be DECLARED on
 * `dmn:DMNElement` and INHERITED by every mapped type, or it goes back on the rows. A row may still
 * name one of these itself, and then the row wins — the hoist is a default, not a ceiling.
 *
 * `id` and `description` deliberately stay on the rows despite coming from the same base: their
 * fate genuinely varies (`description` becomes `Node.documentation` on a DRG element, has nowhere
 * to go on a requirement or a decision table; an expression's `id` is not read at all), and
 * hoisting a property whose answer differs per type would state something false.
 *
 * The live proof that "a row may name one itself, and then the row wins" is not hypothetical:
 * `dmn:InputClause` maps `label` (Decision-Core gives an input column a label slot) while its
 * sibling `dmn:OutputClause`, which has `name` instead, drops it with everything else here.
 */
export const DMN_ELEMENT_BASE = {
  label: {
    code: 'IM05',
    reason: 'An alternative display name for any DMN element. Decision-Core carries `name` only, '
      + 'and folding a label into it would replace the authored name with a presentation string on '
      + 're-emit.',
  },
  extensionElements: {
    code: 'IM04',
    reason: 'Vendor content on this element. There is no slot for it and, by '
      + '`additionalProperties: false`, cannot be one.',
  },
  extensionAttribute: {
    code: 'IM04',
    reason: 'A single named extension value, the attribute-shaped sibling of extensionElements. '
      + 'The element imports; only the value is dropped.',
  },
};

/**
 * One row per non-abstract global element declared in DMN13.xsd and DMNDI13.xsd — exactly one. The
 * fence checks both directions, so a missing row and a stale row each fail naming themselves.
 *
 * A note on what "global element" leaves out: types reached only through a local element
 * (`tInputClause` via <input>, `tUnaryTests` via <inputEntry>, `tDMNElementReference` via
 * <requiredDecision>, …) have no row of their own. They are named in their container's `mapsTo`
 * and are therefore accounted for, but their own properties are not individually fenced. See the
 * Stage 1 report for why that boundary was kept rather than widened here.
 */
export const DMN_ELEMENT_COVERAGE = [

  // ── The document root ────────────────────────────────────────────────────────────────────────
  //
  // Judgment call (recorded, not assumed): `mapped`, not merely a container to read through. Four
  // of its attributes are Decision-Core content in their own right, and `@namespace` is REQUIRED by
  // the schema with nothing else in the document able to supply it.
  {
    xsdElement: 'definitions', xsdFile: 'DMN13', moddleType: 'dmn:Definitions', disposition: 'mapped',
    mapsTo: {
      id: 'the Decision-Core root `id`',
      name: 'root `name`',
      namespace: 'root `namespace` — required by decision-core-schema.json, and only this element has it',
      expressionLanguage: 'root `expressionLanguage`',
      description: 'root `documentation`',
      drgElement: '`nodes[]`, plus `requirements[]` from the requirements nested inside them; each '
        + 'drgElement class has its own row',
    },
    unrepresented: [
      { property: 'import', code: 'IM03', reason: 'Reported through the <import> row.' },
      { property: 'itemDefinition', code: 'IM03', reason: 'Reported through the <itemDefinition> row.' },
      { property: 'elementCollection', code: 'IM03', reason: 'Reported through the <elementCollection> row.' },
      { property: 'artifact', code: 'IM03', reason: 'Reported through the <group>, <textAnnotation> and <association> rows.' },
      { property: 'businessContextElement', code: 'IM03',
        reason: 'Reported through the <performanceIndicator> row. Its other half, <organizationUnit>, '
          + 'never reaches this property at all — see that row.' },
      { property: 'typeLanguage', code: 'IM05',
        reason: 'The document-wide type language. Decision-Core carries `typeRef` as a bare string '
          + 'and no type language to interpret it in.' },
      { property: 'exporter', code: 'IM05',
        reason: 'Provenance about the producing tool, not about the decision model. The generator '
          + 're-stamps its own on emit, so carrying a foreign exporter name through would make the '
          + 're-emitted file claim an origin it does not have.' },
      { property: 'exporterVersion', code: 'IM05', reason: 'As `exporter`.' },
      { property: 'dmnDI', code: 'IM06', reason: 'Reported through the <DMNDI> row.' },
    ],
  },

  // ── The four DRG element classes Decision-Core knows ─────────────────────────────────────────
  {
    xsdElement: 'decision', xsdFile: 'DMN13', moddleType: 'dmn:Decision', disposition: 'mapped',
    mapsTo: {
      id: 'Node.id', name: 'Node.name', description: 'Node.documentation',
      question: 'Node.question', allowedAnswers: 'Node.allowedAnswers',
      variable: 'Node.variable and Node.typeRef — see the <informationItem> row',
      usingProcess: 'Node.usingProcess[]', usingTask: 'Node.usingTask[]',
      decisionLogic: 'Node.decisionTable when it is a <decisionTable>, Node.expression when it is a '
        + '<literalExpression>; any other expression form reports through its own row',
      informationRequirement: 'Requirement{type:"information"} — see the <informationRequirement> row',
      knowledgeRequirement: 'Requirement{type:"knowledge"}',
      authorityRequirement: 'Requirement{type:"authority"}',
    },
    unrepresented: [
      { property: 'supportedObjective', code: 'IM05',
        reason: 'Points at a <performanceIndicator>, which Decision-Core does not have; the '
          + 'reference is dropped with its target.' },
      { property: 'impactedPerformanceIndicator', code: 'IM05', reason: 'As `supportedObjective`.' },
      { property: 'decisionMaker', code: 'IM05',
        reason: 'Points at an <organizationUnit> — which, being parser-blind, is not even in the '
          + 'tree by the time the importer looks.' },
      { property: 'decisionOwner', code: 'IM05', reason: 'As `decisionMaker`.' },
    ],
  },
  {
    xsdElement: 'inputData', xsdFile: 'DMN13', moddleType: 'dmn:InputData', disposition: 'mapped',
    mapsTo: {
      id: 'Node.id', name: 'Node.name', description: 'Node.documentation',
      variable: 'Node.variable and Node.typeRef',
    },
  },
  {
    xsdElement: 'knowledgeSource', xsdFile: 'DMN13', moddleType: 'dmn:KnowledgeSource', disposition: 'mapped',
    mapsTo: {
      id: 'Node.id', name: 'Node.name', description: 'Node.documentation',
      type: 'Node.sourceType', locationURI: 'Node.locationURI',
      authorityRequirement: 'Requirement{type:"authority"}',
    },
    unrepresented: [
      { property: 'owner', code: 'IM05',
        reason: 'Points at an <organizationUnit>, which never reaches the tree — see that row.' },
    ],
  },
  {
    xsdElement: 'businessKnowledgeModel', xsdFile: 'DMN13', moddleType: 'dmn:BusinessKnowledgeModel',
    disposition: 'mapped',
    mapsTo: {
      id: 'Node.id', name: 'Node.name', description: 'Node.documentation',
      variable: 'Node.variable and Node.typeRef',
      encapsulatedLogic: 'Node.parameters[] and Node.body — see the <functionDefinition> row for '
        + 'which bodies survive',
      knowledgeRequirement: 'Requirement{type:"knowledge"}',
      authorityRequirement: 'Requirement{type:"authority"}',
    },
  },

  // ── The three requirement classes ────────────────────────────────────────────────────────────
  //
  // DMN nests a requirement inside the element that REQUIRES it; Decision-Core stores source and
  // target in flow direction on a flat list, exactly as the BPMN side already flattens boundary
  // events. The importer therefore reads the nesting parent as `target` and the @href as `source`.
  {
    xsdElement: 'informationRequirement', xsdFile: 'DMN13', moddleType: 'dmn:InformationRequirement',
    disposition: 'mapped',
    mapsTo: {
      id: 'Requirement.id',
      requiredDecision: 'Requirement.source (Requirement.target is the nesting element)',
      requiredInput: 'Requirement.source',
    },
    unrepresented: [
      { property: 'description', code: 'IM05',
        reason: 'A Decision-Core Requirement is {id, type, source, target} — an edge, with no '
          + 'documentation slot.' },
    ],
  },
  {
    xsdElement: 'knowledgeRequirement', xsdFile: 'DMN13', moddleType: 'dmn:KnowledgeRequirement',
    disposition: 'mapped',
    mapsTo: { id: 'Requirement.id', requiredKnowledge: 'Requirement.source' },
    unrepresented: [
      { property: 'description', code: 'IM05', reason: 'A Requirement has no documentation slot.' },
    ],
  },
  {
    xsdElement: 'authorityRequirement', xsdFile: 'DMN13', moddleType: 'dmn:AuthorityRequirement',
    disposition: 'mapped',
    mapsTo: {
      id: 'Requirement.id',
      requiredAuthority: 'Requirement.source', requiredDecision: 'Requirement.source',
      requiredInput: 'Requirement.source',
    },
    unrepresented: [
      { property: 'description', code: 'IM05', reason: 'A Requirement has no documentation slot.' },
    ],
  },

  // ── Decision logic Decision-Core can hold ────────────────────────────────────────────────────
  {
    xsdElement: 'decisionTable', xsdFile: 'DMN13', moddleType: 'dmn:DecisionTable', disposition: 'mapped',
    mapsTo: {
      id: 'DecisionTable.id',
      hitPolicy: 'DecisionTable.hitPolicy — note it arrives as "UNIQUE" even when the file is silent; '
        + 'see DMN_XSD_DEFAULTS',
      aggregation: 'DecisionTable.aggregation',
      preferredOrientation: 'DecisionTable.preferredOrientation',
      outputLabel: 'DecisionTable.outputLabel',
      input: 'DecisionTable.inputs[] — id, label, expression and typeRef from its inputExpression, '
        + 'allowedValues from its inputValues',
      output: 'DecisionTable.outputs[] — id, name, typeRef, allowedValues from outputValues, '
        + 'defaultValue from defaultOutputEntry',
      annotation: 'DecisionTable.annotations[] — the annotation COLUMN headers',
      rule: 'DecisionTable.rules[] — id, when[] from inputEntry, then[] from outputEntry, '
        + 'annotations[] from annotationEntry, documentation from its description',
    },
    unrepresented: [
      { property: 'description', code: 'IM05',
        reason: 'Decision-Core documents the decision, not its table; a DecisionTable is '
          + '{id, hitPolicy, …} with no documentation slot.' },
      { property: 'typeRef', code: 'IM05',
        reason: 'A decision table is an Expression and so may carry its own result type. '
          + 'Decision-Core types the decision (Node.typeRef) and the output clauses, not the table '
          + 'in between.' },
    ],
  },
  {
    xsdElement: 'literalExpression', xsdFile: 'DMN13', moddleType: 'dmn:LiteralExpression', disposition: 'mapped',
    mapsTo: {
      text: 'whichever string slot its position implies: Node.expression (a decision\'s logic), '
        + 'Node.body (a BKM\'s function body), InputClause.expression, OutputClause.defaultValue, '
        + 'or DecisionRule.then[]',
    },
    multiTarget: {
      text: 'The target depends on the position the literal expression occupies (a decision, a '
        + 'function body, an input expression, a default output, a rule cell): five slots, no one '
        + 'leading slot. Every one of them is still fenced as an embedded token.',
    },
    unrepresented: [
      { property: 'id', code: 'IM05',
        reason: 'Every one of the slots above is a bare string. The expression\'s identity has '
          + 'nowhere to go, and the writer generates a fresh id on emit.' },
      { property: 'description', code: 'IM05', reason: 'As `id` — the slot is a string.' },
      { property: 'typeRef', code: 'IM05',
        reason: 'As `id` — the slot is a string. True at four of the five positions a literal '
          + 'expression can occupy; see `exceptAt` for the fifth.',
        // The one place in this table where a property's fate is per-POSITION rather than per-TYPE,
        // and the reason the column exists at all: at `<inputExpression>` the typeRef IS read, into
        // `InputClause.typeRef`. Before this column the row said "dropped" flatly while
        // `dmn:InputClause.inputExpression`'s own mapsTo said "read" — two entries of one table
        // contradicting each other, joined only by a sentence, which is why no fence saw it (F1b
        // reads mapsTo's KEYS, never its prose VALUES, deliberately). F1b now checks all three
        // halves, the decisive one being reciprocity: the container named here must list
        // `containerProperty` among its own mapsTo keys.
        exceptAt: [{
          containerType: 'dmn:InputClause', containerProperty: 'inputExpression',
          readInto: 'InputClause.typeRef',
        }] },
      { property: 'expressionLanguage', code: 'IM05',
        reason: 'Decision-Core carries ONE language for the whole document (root '
          + '`expressionLanguage`), so a file that overrides the language per expression loses the '
          + 'override — and, unlike the other losses here, silently changes what the text means.' },
      { property: 'importedValues', code: 'IM05',
        reason: 'Allowed values fetched from an imported model instead of written in the file. '
          + '`allowedValues` is a literal string, so there is nowhere to put "look them up over '
          + 'there"; the clause imports with no allowed values, which reads as "any value '
          + 'permitted" and is the opposite of what the file says.' },
    ],
  },
  {
    xsdElement: 'functionDefinition', xsdFile: 'DMN13', moddleType: 'dmn:FunctionDefinition', disposition: 'mapped',
    mapsTo: {
      formalParameter: 'Node.parameters[]{name, typeRef}',
      body: 'Node.body, but only when the body is a <literalExpression> — DMN allows ANY expression '
        + 'there, and Decision-Core\'s `body` is a string. A BKM whose logic is a boxed expression '
        + 'imports as a BKM with no body, and the body reports through its own row',
    },
    unrepresented: [
      { property: 'id', code: 'IM05', reason: 'The function definition is flattened into its BKM\'s fields; its own identity has no slot.' },
      { property: 'description', code: 'IM05', reason: 'As `id`.' },
      { property: 'typeRef', code: 'IM05', reason: 'As `id`.' },
      { property: 'kind', code: 'IM05',
        reason: 'FEEL / Java / PMML. Decision-Core has one document-wide expression language and no '
          + 'per-function kind, so a Java-backed BKM imports looking like a FEEL one.' },
    ],
  },
  {
    xsdElement: 'informationItem', xsdFile: 'DMN13', moddleType: 'dmn:InformationItem', disposition: 'mapped',
    mapsTo: {
      name: 'Node.variable when it is an element\'s output variable; parameters[].name when it is a '
        + 'BKM formal parameter',
      typeRef: 'Node.typeRef, or parameters[].typeRef',
    },
    unrepresented: [
      { property: 'id', code: 'IM05',
        reason: 'The writer generates `<node>_var` and regenerates the identical value on emit, so '
          + 'importing the id would promote a generated value to an authored one. A foreign file\'s '
          + 'hand-written variable id is therefore replaced on re-emit: the variable\'s name and '
          + 'type survive, its identity does not.' },
      { property: 'description', code: 'IM05', reason: 'A variable is two fields on its owner; there is no place to document it.' },
    ],
  },

  // ── Boxed expressions: structure Decision-Core cannot hold ───────────────────────────────────
  //
  // Decision-Core stores every expression as a string and parses no FEEL. That is a deliberate
  // scope line, not an omission: the generator draws and checks decision structure, it does not
  // evaluate. It is also why the boxed forms below are reported rather than flattened — flattening
  // them to text would invent a serialisation the file never had and nothing here can read back.
  {
    xsdElement: 'context', xsdFile: 'DMN13', moddleType: 'dmn:Context', disposition: 'reported', code: 'IM02',
    reason: 'A boxed context — a list of named sub-expressions evaluated together, one of DMN\'s '
      + 'two structured alternatives to a decision table. The decision itself still imports; it '
      + 'arrives with no logic, which is why each occurrence is reported.',
  },
  {
    xsdElement: 'contextEntry', xsdFile: 'DMN13', moddleType: 'dmn:ContextEntry', disposition: 'reported', code: 'IM02',
    reason: 'One `variable: expression` pair inside a <context>. Unrepresentable for the same reason '
      + 'its parent is, and listed separately because the XSD declares it as a global element of '
      + 'its own — the row set is keyed by what a file may write, not by what nests in what.',
  },
  {
    xsdElement: 'invocation', xsdFile: 'DMN13', moddleType: 'dmn:Invocation', disposition: 'reported', code: 'IM02',
    reason: 'A boxed invocation — calling a business knowledge model with bound arguments. '
      + 'Decision-Core models the knowledge REQUIREMENT (decision needs BKM) but not the call: '
      + 'there is no slot for the argument bindings, so an imported invocation would silently '
      + 'become "this decision uses that BKM, somehow". The requirement edge still imports; the '
      + 'call does not.',
  },
  {
    xsdElement: 'list', xsdFile: 'DMN13', moddleType: 'dmn:List', disposition: 'reported', code: 'IM02',
    reason: 'A boxed list expression — an ordered collection of expressions as decision logic. Same '
      + 'wall as <context>: Decision-Core has one structured logic slot and it is shaped like a '
      + 'decision table.',
  },
  {
    xsdElement: 'relation', xsdFile: 'DMN13', moddleType: 'dmn:Relation', disposition: 'reported', code: 'IM02',
    reason: 'A boxed relation — rows and named columns, a table of VALUES rather than of rules. It '
      + 'looks close enough to a decision table to be tempting, and importing it as one would be '
      + 'wrong in a way nothing downstream could detect: a relation has no hit policy and no input '
      + 'clauses, so `scenarios/decision-table.js` would report gaps and overlaps for a construct '
      + 'that has neither concept.',
  },

  // ── Document-level constructs outside the decision graph ─────────────────────────────────────
  {
    xsdElement: 'import', xsdFile: 'DMN13', moddleType: 'dmn:Import', disposition: 'reported', code: 'IM03',
    reason: 'A reference to another DMN (or XSD, or PMML) model, whose elements this file may then '
      + 'name through prefixed hrefs. Decision-Core describes one self-contained model: there is no '
      + 'slot for the import and no resolution step that could inline what it points at. Every href '
      + 'depending on it therefore dangles — this is the one dropped construct that breaks OTHER '
      + 'elements\' correctness, not just its own.',
  },
  {
    xsdElement: 'itemDefinition', xsdFile: 'DMN13', moddleType: 'dmn:ItemDefinition', disposition: 'reported', code: 'IM03',
    reason: 'The document\'s type definitions — a named type with components, an allowed-value '
      + 'range, or a collection flag. Decision-Core carries `typeRef` as a bare string, so a '
      + 'reference to a custom type survives as its NAME while the definition behind it is lost, '
      + 'and re-emitting produces a file whose typeRefs resolve to nothing. The most likely '
      + 'construct in a real externally authored model, which is why it reports per occurrence with '
      + 'its id rather than as one summary line.',
  },
  {
    xsdElement: 'functionItem', xsdFile: 'DMN13', moddleType: 'dmn:FunctionItem', disposition: 'reported', code: 'IM03',
    reason: 'A function SIGNATURE inside an <itemDefinition> (parameter types plus return type), '
      + 'used to type a variable that holds a function. Lost with its enclosing type definition; '
      + 'Decision-Core has no type declarations at all, function-shaped or not.',
  },
  {
    xsdElement: 'elementCollection', xsdFile: 'DMN13', moddleType: 'dmn:ElementCollection', disposition: 'reported', code: 'IM03',
    reason: 'A named set of decisions, DMN\'s lightweight grouping construct. Like <decisionService> '
      + 'it groups elements that import fine on their own, so what is lost is the grouping, not the '
      + 'content.',
  },
  {
    xsdElement: 'performanceIndicator', xsdFile: 'DMN13', moddleType: 'dmn:PerformanceIndicator',
    disposition: 'reported', code: 'IM03',
    reason: 'A business context element naming a measure that decisions impact. Decision-Core '
      + 'describes what a model computes, not why it matters to a business. Its sibling '
      + '<organizationUnit> is the same boundary but a different mechanism — that one never reaches '
      + 'us at all.',
  },

  // ── Artifacts ────────────────────────────────────────────────────────────────────────────────
  {
    xsdElement: 'textAnnotation', xsdFile: 'DMN13', moddleType: 'dmn:TextAnnotation', disposition: 'reported', code: 'IM03',
    reason: 'Free text attached to the diagram — the DRD\'s equivalent of a BPMN text annotation. '
      + 'Decision-Core has `documentation` on the root and on each node but no free-floating note, '
      + 'and folding an annotation into the documentation of whatever it points at would turn an '
      + 'author\'s aside into a formal description of an element. It parses with zero warnings into '
      + '`artifact`, a list nothing here reads.',
  },
  {
    xsdElement: 'association', xsdFile: 'DMN13', moddleType: 'dmn:Association', disposition: 'reported', code: 'IM03',
    reason: 'The connector tying a <textAnnotation> to the element it comments on. Lost with the '
      + 'annotation; an association whose annotation is gone would have nothing to say.',
  },
  {
    xsdElement: 'group', xsdFile: 'DMN13', moddleType: 'dmn:Group', disposition: 'reported', code: 'IM03',
    reason: 'A visual box drawn around elements on the DRD. Purely presentational, and — unlike a '
      + 'BPMN Group — it carries not even a membership list: which elements are inside is decided by '
      + 'geometry alone. Decision-Core is coordinate-free by design, so there is nothing left of a '
      + 'group to keep.',
  },

  // ── Grouping ─────────────────────────────────────────────────────────────────────────────────
  {
    xsdElement: 'decisionService', xsdFile: 'DMN13', moddleType: 'dmn:DecisionService', disposition: 'reported', code: 'IM01',
    reason: 'A named, callable grouping of decisions — four reference lists (output, encapsulated '
      + 'and input decisions, input data) plus its own DI divider line. Decision-Core\'s Node.type '
      + 'enum has four members and this is deliberately not one of them. Dropping it loses THE '
      + 'GROUPING ONLY: every decision it names is an ordinary top-level <drgElement> in the same '
      + 'file and is still imported with its requirements intact. It parses with zero moddle '
      + 'warnings and sits in the same `drgElement` list as a decision, which makes it the textbook '
      + 'case for this whole table — a naive loop drops it in perfect silence.',
  },

  // ── The parser-blind class ───────────────────────────────────────────────────────────────────
  {
    xsdElement: 'organizationUnit', xsdFile: 'DMN13', moddleType: null, disposition: 'parser-blind',
    code: 'IM08', blind: { mechanism: 'spelling', moddleTypeIfReachable: 'dmn:OrganisationalUnit' },
    reason: 'A business context element naming who makes and who owns decisions. It would be out of '
      + 'scope anyway — Decision-Core models the decision graph, not the organisation around it — '
      + 'but the mechanism is what this row is for and it is not scope: dmn-moddle names the type '
      + 'with the BRITISH spelling `dmn:OrganisationalUnit`, and its tag alias therefore looks for '
      + '`<organisationalUnit>`, while DMN13.xsd:132 declares the AMERICAN `<organizationUnit>`. A '
      + 'conformant file\'s element is rejected as an unknown type, so it is absent from the parsed '
      + 'tree entirely and the only trace is `warnings[]`. Every `@decisionMaker`, `@decisionOwner` '
      + 'and `@owner` pointing at one dangles for the same reason.',
  },

  // ── Diagram interchange ──────────────────────────────────────────────────────────────────────
  //
  // Judgment call (recorded): these are ROWS, and the old table's separate `NON_TYPE_GAPS` export
  // is gone. It existed because the primary key used to be the moddle type and the fence's set
  // equality was against the moddle registry, which left `dmndi:` losses with nowhere to live. With
  // the XSD as the oracle they are simply global elements in DMNDI13.xsd and belong in the one
  // table — one authority, one shape, no sibling list to remember to read. `isCollapsed` needs no
  // entry of its own for the same reason: its owner <DMNShape> is reported whole, and the entry
  // would say nothing the row does not.
  {
    xsdElement: 'DMNDI', xsdFile: 'DMNDI13', moddleType: 'dmndi:DMNDI', disposition: 'reported', code: 'IM06',
    reason: 'The root of the diagram-interchange tree. Reported once for the document rather than '
      + 'once per shape: a hundred shapes are one fact ("geometry was dropped"), and listing them '
      + 'would bury the findings that need acting on.',
  },
  {
    xsdElement: 'DMNDiagram', xsdFile: 'DMNDI13', moddleType: 'dmndi:DMNDiagram', disposition: 'reported', code: 'IM06',
    reason: 'One diagram over the DRG. A file may carry several — different views of the same '
      + 'model — and Decision-Core has no concept of a view at all: `dmn/layout.js` derives exactly '
      + 'one DRD from the graph on every emit.',
  },
  {
    xsdElement: 'DMNDiagramElement', xsdFile: 'DMNDI13', moddleType: 'dmndi:DMNDiagramElement',
    disposition: 'reported', code: 'IM06',
    reason: 'The substitution-group head for <DMNShape> and <DMNEdge>. DMNDI13.xsd:16 declares it '
      + 'WITHOUT abstract="true" while its own documentation says it "should never be instantiated '
      + 'directly" — so it earns a row on the mechanical rule (a non-abstract global element gets a '
      + 'row) even though a conformant file will not contain one. dmn-moddle does mark its type '
      + 'abstract, which is the more honest of the two readings.',
  },
  {
    xsdElement: 'DMNShape', xsdFile: 'DMNDI13', moddleType: 'dmndi:DMNShape', disposition: 'reported', code: 'IM06',
    reason: 'A node\'s bounds on a diagram, plus `@isCollapsed` (whether a decision service is drawn '
      + 'collapsed) and the decision-service divider line. Worth naming `isCollapsed` explicitly: '
      + 'docs/superpowers/plans/2026-07-30-dmn-integration.md Stage 5 instructs the importer to read '
      + 'it, and that instruction is VOID — Decision-Core has no `isCollapsed` property and its '
      + 'schema forbids extras, so there is no target for the read. It is moot twice over, since the '
      + 'only thing it can sit on is a <decisionService>, which is itself dropped.',
  },
  {
    xsdElement: 'DMNEdge', xsdFile: 'DMNDI13', moddleType: 'dmndi:DMNEdge', disposition: 'reported', code: 'IM06',
    reason: 'A requirement connection\'s waypoints. The requirement itself imports; only its route '
      + 'is dropped, and the re-emitted file routes it afresh.',
  },
  {
    xsdElement: 'DMNStyle', xsdFile: 'DMNDI13', moddleType: 'dmndi:DMNStyle', disposition: 'reported', code: 'IM06',
    reason: 'Fill, stroke and font styling for diagram elements. Decision-Core carries no '
      + 'presentation at all; `dmn/constants.js` supplies ours from config.json on every emit.',
  },
  {
    xsdElement: 'DMNLabel', xsdFile: 'DMNDI13', moddleType: 'dmndi:DMNLabel', disposition: 'reported', code: 'IM06',
    reason: 'A label\'s own bounds and, optionally, its own text. The text is the trap: a <DMNLabel> '
      + 'may state something other than the element\'s `@name`, and there is no slot for a display '
      + 'text distinct from the name — so re-emitting shows the name where the file showed the '
      + 'label.',
  },
  {
    xsdElement: 'DMNDecisionServiceDividerLine', xsdFile: 'DMNDI13',
    moddleType: 'dmndi:DMNDecisionServiceDividerLine', disposition: 'reported', code: 'IM06',
    reason: 'The line splitting a decision service\'s shape into its output and encapsulated halves. '
      + 'Geometry of a construct that is itself dropped — see the <decisionService> row.',
  },
];

/**
 * The types a mapped row's properties lead to that have no global element of their own — the decision
 * table's clauses and rules, and the `<requiredDecision>`-style pointers.
 *
 * Why a separate export rather than more rows (judgment call, recorded): the row set is keyed by
 * what a conformant file may WRITE as an element, and F1's set equality against the XSDs is what
 * makes this table impossible to quietly outgrow. `dmn:InputClause` is not a global element; giving
 * it a row would mean either weakening that equality to a subset test or inventing an `xsdElement`
 * value no file contains. Keeping it here costs one extra export and keeps both authorities exact.
 *
 * Why keyed by moddle type rather than nested under the owning row: `dmn:DMNElementReference` is
 * reached from eight different properties across four rows, and `dmn:UnaryTests` from three. Copies
 * drift. `reachedFrom` gives back the navigation a nested shape would have provided — and it is
 * measured by the fence against the actual traversal, so it cannot describe an older graph.
 *
 * Entries are `{ moddleType, reachedFrom, mapsTo?, unrepresented? }` and obey the same accounting
 * rule as a mapped row: between `mapsTo`, `unrepresented` and `DMN_ELEMENT_BASE`, every descriptor
 * property must be named.
 */
export const DMN_NESTED_TYPE_COVERAGE = [
  {
    moddleType: 'dmn:DMNElementReference',
    reachedFrom: [
      '<authorityRequirement>.requiredAuthority', '<authorityRequirement>.requiredDecision',
      '<authorityRequirement>.requiredInput', '<decision>.usingProcess', '<decision>.usingTask',
      '<informationRequirement>.requiredDecision', '<informationRequirement>.requiredInput',
      '<knowledgeRequirement>.requiredKnowledge',
    ],
    mapsTo: {
      href: 'the id it points at — Requirement.source, or an entry in Node.usingTask[] / '
        + 'Node.usingProcess[]. The pointer itself has no identity to keep: what it names is '
        + 'recorded by whatever contains it, and giving the mechanism a second slot would give the '
        + 'importer two places to claim one fact. An href reaching INTO another document '
        + '(`file.dmn#id`) is a different matter and reports through the <import> row, since '
        + 'without the import there is nothing for it to resolve against',
    },
    multiTarget: {
      href: 'The slot depends on the container: a Requirement\'s source, or an entry in the '
        + 'usingTask/usingProcess lists of a Node. Each is still fenced as an embedded token.',
    },
  },
  {
    moddleType: 'dmn:InputClause',
    reachedFrom: ['<decisionTable>.input'],
    mapsTo: {
      id: 'InputClause.id',
      // The live exception to DMN_ELEMENT_BASE's hoist, and the reason the hoist is a default rather
      // than a ceiling: Decision-Core gives an input clause a `label` slot, so here `label` is read.
      // Its sibling OutputClause has `name` instead and drops its label with everything else.
      label: 'InputClause.label — the column header',
      inputExpression: 'InputClause.expression and InputClause.typeRef, from the literal '
        + 'expression\'s text and typeRef',
      inputValues: 'InputClause.allowedValues — see dmn:UnaryTests for what the cell text loses',
    },
    unrepresented: [
      { property: 'description', code: 'IM05',
        reason: 'A Decision-Core InputClause is {id, label, expression, typeRef, allowedValues}; '
          + 'documentation belongs to the decision, not to a column of its table.' },
    ],
  },
  {
    moddleType: 'dmn:OutputClause',
    reachedFrom: ['<decisionTable>.output'],
    mapsTo: {
      id: 'OutputClause.id',
      name: 'OutputClause.name — the column header, which on an output clause is @name and not @label',
      typeRef: 'OutputClause.typeRef',
      outputValues: 'OutputClause.allowedValues',
      defaultOutputEntry: 'OutputClause.defaultValue, from the literal expression\'s text',
    },
    unrepresented: [
      { property: 'description', code: 'IM05', reason: 'As on an input clause: no documentation slot.' },
    ],
  },
  {
    moddleType: 'dmn:RuleAnnotationClause',
    reachedFrom: ['<decisionTable>.annotation'],
    mapsTo: { name: 'DecisionTable.annotations[] — the annotation COLUMN header' },
    // No id, and deliberately so in the spec: tRuleAnnotationClause is one of the few DMN types that
    // does not extend tDMNElement, which is why this entry has no base properties to account for.
  },
  {
    moddleType: 'dmn:DecisionRule',
    reachedFrom: ['<decisionTable>.rule'],
    mapsTo: {
      id: 'DecisionRule.id',
      // THE LINE, stated rather than left to be inferred: a RULE is documented, its TABLE is not
      // (`dmn:DecisionTable`'s own `description` is an IM05 loss two rows up). The ground is that a
      // rule's rationale is business content unique to that row, while a table's description
      // restates the decision that owns it — Decision-Core already has `Node.documentation` for
      // that. Both halves of the mapping are real code: `references/decision-core-schema.json`
      // declares `$defs.DecisionRule.documentation` and `dmn-xml.js`'s `buildDecisionTable` emits it
      // back. Until Stage 5b none of that was true — the schema declared no such property and is
      // `additionalProperties: false`, so this row claimed a mapping that produced a Decision-Core
      // our OWN schema gate rejected. It stayed invisible because F1b reads `mapsTo`'s KEYS and
      // never its prose VALUES; the guard that would have caught it is the directory-driven
      // schema-gate fence in `import.test.js`, not anything in this table.
      description: 'DecisionRule.documentation — a rule is the one part of a table Decision-Core '
        + 'does let you document, unlike dmn:DecisionTable\'s own description (IM05)',
      inputEntry: 'DecisionRule.when[] — see dmn:UnaryTests',
      outputEntry: 'DecisionRule.then[] — see the <literalExpression> row',
      annotationEntry: 'DecisionRule.annotations[] — see dmn:RuleAnnotation',
    },
  },
  {
    moddleType: 'dmn:UnaryTests',
    reachedFrom: [
      'dmn:DecisionRule.inputEntry', 'dmn:InputClause.inputValues', 'dmn:OutputClause.outputValues',
    ],
    mapsTo: {
      text: 'the cell text, into DecisionRule.when[], InputClause.allowedValues or '
        + 'OutputClause.allowedValues',
    },
    multiTarget: {
      text: 'The slot depends on the cell\'s position: a rule\'s input entry, or the allowed values '
        + 'of an input or an output clause. Each is still fenced as an embedded token.',
    },
    unrepresented: [
      { property: 'id', code: 'IM05',
        reason: 'Every slot above is a bare string; a rule cell has no identity in Decision-Core and '
          + 'the writer emits no id for one.' },
      { property: 'description', code: 'IM05', reason: 'As `id` — the slot is a string.' },
      { property: 'typeRef', code: 'IM05', reason: 'As `id` — the slot is a string.' },
      { property: 'expressionLanguage', code: 'IM05',
        reason: 'The per-cell language override. This is the same loss as on <literalExpression> but '
          + 'multiplied by every cell of every table, and it is the one drop in this file that '
          + 'changes MEANING rather than only losing detail: the text survives and the language it '
          + 'must be read in does not. Decision-Core carries one language for the whole document.' },
    ],
  },
  {
    moddleType: 'dmn:RuleAnnotation',
    reachedFrom: ['dmn:DecisionRule.annotationEntry'],
    mapsTo: { text: 'DecisionRule.annotations[] — the per-rule annotation cell text' },
  },
];

/**
 * Every `default="…"` the four XSDs declare on an attribute, and what the importer does about it.
 *
 * Why this is a table and not a footnote: an XSD default means "absent has this meaning", so an
 * importer that ignores one is not being conservative, it is reading the file wrong. And the two
 * layers disagree about which defaults exist — dmn-moddle carries a descriptor default for exactly
 * two of the nine, which is why it drops `hitPolicy="UNIQUE"` on write while keeping
 * `preferredOrientation="Rule-as-Row"` (a difference `decision-core-schema.json` already had to
 * record for the golden files). The fence measures that 2-of-9 divergence instead of letting us
 * depend on it by accident.
 *
 *   moddleMaterialises  does dmn-moddle's descriptor carry the same default, so the parsed object
 *                       already has the value whether or not the file wrote it?
 *   slot                the Decision-Core field that could hold it, or null.
 *   materialize         should the importer write the default into that slot when the attribute is
 *                       absent? `false` with a non-null slot is a deliberate choice, not an
 *                       oversight: absent means the same thing at both ends, and writing it in
 *                       would turn the file's silence into an assertion.
 */
export const DMN_XSD_DEFAULTS = [
  {
    xsdFile: 'DMN13', ownerType: 'tDefinitions', attr: 'expressionLanguage',
    xsdDefault: 'https://www.omg.org/spec/DMN/20191111/FEEL/',
    moddleMaterialises: false, slot: 'the Decision-Core root `expressionLanguage`', materialize: false,
    reason: 'Absent means FEEL at both ends: `dmn-xml.js` emits the attribute only when the field is '
      + 'set, so a silent file re-emits silent and means the same thing.',
  },
  {
    xsdFile: 'DMN13', ownerType: 'tDefinitions', attr: 'typeLanguage',
    xsdDefault: 'https://www.omg.org/spec/DMN/20191111/FEEL/',
    moddleMaterialises: false, slot: null, materialize: false,
    reason: 'No slot — see the <definitions> row.',
  },
  {
    xsdFile: 'DMN13', ownerType: 'tItemDefinition', attr: 'isCollection', xsdDefault: 'false',
    moddleMaterialises: false, slot: null, materialize: false,
    reason: 'No slot: the whole <itemDefinition> is reported and dropped.',
  },
  {
    xsdFile: 'DMN13', ownerType: 'tDecisionTable', attr: 'hitPolicy', xsdDefault: 'UNIQUE',
    moddleMaterialises: true, slot: 'DecisionTable.hitPolicy', materialize: true,
    reason: 'dmn-moddle has already put "UNIQUE" on the object by the time the importer looks — but '
      + 'on the PROTOTYPE, so a silent file and an explicit UNIQUE remain DISTINGUISHABLE via '
      + '`Object.prototype.hasOwnProperty`, which is exactly how `import.js` tells them apart (see '
      + 'its `readOwn`). An earlier revision of this sentence said they were indistinguishable, '
      + 'which the shipped importer contradicts. The importer materialises the default from THIS '
      + 'table rather than from moddle\'s descriptor, and records each application in '
      + '`report.defaultsMaterialised`. Why materialise at all, given that both consumers already '
      + 'default it themselves (`scenarios/decision-table.js` uses `|| \'UNIQUE\'`, `dmn/rules.js` '
      + '`?? \'UNIQUE\'`): round-trip identity. The writer omits `hitPolicy="UNIQUE"` because moddle '
      + 'drops any attribute equal to its descriptor default, so without materialising, '
      + '{hitPolicy:"UNIQUE"} -> XML -> {} and the round-trip fence would need a tolerance for a '
      + 'field that is not actually lost.',
  },
  {
    xsdFile: 'DMN13', ownerType: 'tDecisionTable', attr: 'preferredOrientation', xsdDefault: 'Rule-as-Row',
    moddleMaterialises: false, slot: 'DecisionTable.preferredOrientation', materialize: false,
    reason: 'A slot exists, but the value is presentation and absent means Rule-as-Row at both ends. '
      + 'Writing it in would add an attribute to the re-emitted file that the source did not have.',
  },
  {
    xsdFile: 'DMN13', ownerType: 'tTextAnnotation', attr: 'textFormat', xsdDefault: 'text/plain',
    moddleMaterialises: true, slot: null, materialize: false,
    reason: 'The asymmetry worth knowing: dmn-moddle materialises a default on a type we do not '
      + 'import at all. The value is on the object and nothing reads it.',
  },
  {
    xsdFile: 'DMN13', ownerType: 'tAssociation', attr: 'associationDirection', xsdDefault: 'None',
    moddleMaterialises: false, slot: null, materialize: false,
    reason: 'No slot: <association> is reported and dropped.',
  },
  {
    xsdFile: 'DMN13', ownerType: 'tFunctionDefinition', attr: 'kind', xsdDefault: 'FEEL',
    moddleMaterialises: false, slot: null, materialize: false,
    reason: 'No slot — see the `kind` entry on the <functionDefinition> row. Note the consequence of '
      + 'the default rather than of the drop: a file that says nothing means FEEL, so only an '
      + 'explicitly Java- or PMML-backed function loses information here.',
  },
  {
    xsdFile: 'DMNDI13', ownerType: 'DMNShape', attr: 'isCollapsed', xsdDefault: 'false',
    moddleMaterialises: false, slot: null, materialize: false,
    reason: 'No slot, and no target for the Stage 5 instruction that says to read it — see the '
      + '<DMNShape> row.',
  },
];

/**
 * The row for an XSD element name, or undefined when no such global element is declared.
 *
 * `xsdFile` is optional but is half the primary key, and passing it is the correct habit: the names
 * alone are unique only because DMN13 is camelCase and DMNDI13 PascalCase, which neither spec
 * promises to keep. The fence asserts that uniqueness, so the one-argument form cannot silently
 * start returning the wrong row — but a caller that knows the file should say so.
 */
export function coverageForElement(xsdElement, xsdFile) {
  return DMN_ELEMENT_COVERAGE.find((row) => row.xsdElement === xsdElement
    && (xsdFile === undefined || row.xsdFile === xsdFile));
}

/**
 * The row for a dmn-moddle type, or undefined. The falsy guard is not defensive noise: a
 * parser-blind row carries `moddleType: null`, so without it a caller passing null — which is
 * exactly what a lookup on an unresolved element produces — would be handed the first blind row and
 * told the parser can see it.
 */
export function coverageForModdleType(moddleType) {
  if (!moddleType) return undefined;
  return DMN_ELEMENT_COVERAGE.find((row) => row.moddleType === moddleType);
}

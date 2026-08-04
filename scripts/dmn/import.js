/**
 * DMN 1.3 XML → Decision-Core JSON, plus a structured report of everything the file carried that
 * Decision-Core cannot hold.
 *
 * WHY THE REPORT IS HALF THE MODULE
 *
 * `scripts/dmn/` was write-direction only, and a writer emits only what Decision-Core can already
 * say. Reading a file we did not write flips the question: what does a foreign `.dmn` carry that we
 * have no slot for? Measured (see `import-scope.js`), a document carrying
 * `itemDefinition + decisionService + textAnnotation` parses with ZERO dmn-moddle warnings — moddle
 * warns about elements it does not KNOW, never about elements a consumer does not READ. So a naive
 * `drgElement` loop produces a Decision-Core that looks complete, feeds SC02–SC05 a model that is
 * not, and nothing anywhere says so. `report.unrepresented` is that channel, and
 * `report.lossless` is the one bit a caller has to branch on.
 *
 * `scripts/dmn/import-scope.js` IS THIS MODULE'S SPECIFICATION. Every `mapped` row is read here,
 * every `reported` row is detected here, and `parser-blind` rows can only ever be surfaced from
 * `warnings[]`. There is no second exclusion list: fence F5 in `import-coverage.test.js` asserts
 * `Object.keys(HANDLERS)` equals the set of `mapped` rows, so demoting a row without removing its
 * handler fails, and adding a handler without a row fails too.
 *
 * SHAPE
 *
 *   parseDmnXml(xml)                    async — the thin dmn-moddle wrapper; THROWS on a parse
 *                                       failure, because a primitive that swallows one is a
 *                                       primitive you cannot test the failure of
 *   moddleToDecisionCore(definitions)   PURE and SYNCHRONOUS — a hand-built moddle tree is a valid
 *                                       input, which is what lets the tests skip XML entirely
 *   dmnToDecisionCore(xml)              async — the public convenience path; returns a SHAPED
 *                                       failure rather than throwing (judgment call 3, argued at
 *                                       its own doc comment)
 *
 * The parse/convert split is `scripts/bpmn/moddle-import.js`'s and is copied deliberately. No
 * import from `scripts/bpmn/` — `scripts/dmn/` is a sibling subsystem, not a consumer.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 *
 * It reads no DMNDI and fabricates no diagram. Decision-Core is coordinate-free by design and
 * `dmn/layout.js` re-lays-out the DRD on every emit, so there is no slot to import geometry into
 * and no step that would consume one. Every diagram is an IM06 finding instead. (This is what
 * replaces the DMN-integration plan's Stage 5 instruction to read `@isCollapsed`, which has no
 * target — see the `<DMNShape>` row in `import-scope.js`.)
 *
 * @typedef {{ code: string, xsdElement: string|null, moddleType: string|null, path: string,
 *             id: string|null, name: string|null, reason: string }} Finding
 * @typedef {{ lossless: boolean, unrepresented: Finding[], parserWarnings: string[],
 *             defaultsMaterialised: { path: string, attr: string, value: string }[],
 *             counts: { unrepresented: number, byCode: Record<string, number>,
 *                       parserWarnings: number } }} ImportReport
 */

import { DmnModdle } from 'dmn-moddle';
import { readFileSync } from 'node:fs';

import {
  DMN_ELEMENT_COVERAGE, DMN_NESTED_TYPE_COVERAGE, DMN_ELEMENT_BASE, DMN_XSD_DEFAULTS, IMPORT_CODES,
  coverageForModdleType,
} from './import-scope.js';
import { requirementKey } from './coordinates.js';
import { decisionCoreSchemaPath } from '../shared/resource-paths.js';

const moddle = new DmnModdle();

/**
 * The id pattern, read out of `references/decision-core-schema.json` rather than restated. A second
 * copy is exactly the drift `import-scope.js`'s preamble is written against: the schema was widened
 * in Stage 2 (`.` accepted, for `my.decision`), and a hand-copied regex here would have silently
 * kept rejecting it while the schema said otherwise. Read at module load, like `schema-gate.js`
 * does, so `moddleToDecisionCore` itself stays pure and synchronous.
 */
const DC_ID_PATTERN = (() => {
  const schema = JSON.parse(readFileSync(decisionCoreSchemaPath(), 'utf8'));
  return new RegExp(schema.$defs.Node.properties.id.pattern);
})();

/** moddle type → the XSD element name a conformant file writes. The rows own both halves. */
const XSD_ELEMENT_OF_TYPE = new Map(
  DMN_ELEMENT_COVERAGE.filter((r) => r.moddleType).map((r) => [r.moddleType, r.xsdElement]),
);

/** moddle type → its Decision-Core `Node.type`, for the four DRG classes we hold. */
const NODE_TYPE_OF = {
  'dmn:Decision': 'decision',
  'dmn:InputData': 'inputData',
  'dmn:KnowledgeSource': 'knowledgeSource',
  'dmn:BusinessKnowledgeModel': 'businessKnowledgeModel',
};

/** Requirement container property → the Decision-Core `Requirement.type` it produces. */
const REQUIREMENT_KINDS = [
  ['informationRequirement', 'information'],
  ['knowledgeRequirement', 'knowledge'],
  ['authorityRequirement', 'authority'],
];

/**
 * The four `tDMNElementReference`-valued properties a requirement may carry its source in. DMN
 * picks the property by the SOURCE's class; Decision-Core picks `Requirement.type` by the
 * REQUIREMENT's class, so the property name carries nothing we keep — only its href does.
 */
const REQUIREMENT_SOURCE_PROPS = ['requiredDecision', 'requiredInput', 'requiredKnowledge', 'requiredAuthority'];

const isElement = (v) => v !== null && typeof v === 'object' && typeof v.$type === 'string';
const asArray = (v) => (v == null ? [] : (Array.isArray(v) ? v : [v]));

/** An own property, not an inherited one — see `readOwn` below for why the distinction is load-bearing. */
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Read a moddle attribute ONLY when the file actually wrote it.
 *
 * moddle materialises a descriptor default on the PROTOTYPE, so `table.hitPolicy` reads `'UNIQUE'`
 * for a file that never mentioned a hit policy, and `Object.keys(table)` does not list it at all.
 * Both halves of that matter here: never write this importer against `Object.keys` (it would drop
 * an explicitly authored `hitPolicy="UNIQUE"`), and never write it against plain property access
 * either (it cannot tell an authored value from a defaulted one). `hasOwnProperty` is the only read
 * that distinguishes them — measured, not assumed.
 */
const readOwn = (el, prop) => (hasOwn(el, prop) ? el[prop] : undefined);

// ── walkModdle — the generic recursive detector ──────────────────────────────────────────────────

/**
 * Depth-first walk over a parsed moddle tree, calling `visit(el, path)` for every element including
 * the root.
 *
 * WHY A SEPARATE RECURSION AT ALL, when the converter below is flat: DMN's DRG element list IS flat
 * (`tDefinitions/drgElement` is one unbounded sequence, there is no DRG nesting), and the only
 * recursion in the model is inside *expressions* — every one of which is `reported`. But `label`,
 * `description` and `extensionElements` are inherited from `tDMNElement` and can appear at ANY
 * depth, including inside something already reported. Folding that into the converter would mean
 * the converter growing a descent it otherwise has no use for, and would give IM04/IM05 two
 * possible sources. This walk is their SOLE source, so nothing is reported twice.
 *
 * `path` is POSITIONAL (`definitions.drgElement[2].decisionLogic.rule[0]`), never id-based: four
 * DMN types carry no `id` by construction and `DMNDiagram` has no required attributes at all, so an
 * id-keyed path cannot address them.
 *
 * Only OWN enumerable properties are followed, which is also what keeps the walk finite: moddle
 * resolves `<DMNShape dmnElementRef="d1">` to the Decision OBJECT rather than to a string, so a
 * prototype-or-reference-following walk would loop back into the DRG through the DI. (The same
 * asymmetry the converter has to know about — see `localHref`.)
 */
export function walkModdle(el, path, visit) {
  if (!isElement(el)) return;
  visit(el, path);
  for (const key of Object.keys(el)) {
    if (key.startsWith('$')) continue;                 // $type, $parent, $attrs — moddle internals
    const value = el[key];
    if (Array.isArray(value)) {
      value.forEach((item, i) => walkModdle(item, `${path}.${key}[${i}]`, visit));
    } else if (isElement(value)) {
      walkModdle(value, `${path}.${key}`, visit);
    }
  }
}

/**
 * A view of `import-scope.js` keyed by moddle type: which properties are unrepresented, and under
 * which code. Three sources, in increasing precedence:
 *
 *   1. `DMN_ELEMENT_BASE`      the `tDMNElement` properties whose fate is uniform (label, the two
 *                              extension points)
 *   2. `unrepresented[]`       the per-type list, on a row or on a nested-type entry
 *   3. `mapsTo`                a property we DO read wins over the hoist — the live case is
 *                              `dmn:InputClause.label`, which Decision-Core gives a slot while its
 *                              sibling `dmn:OutputClause` drops it with everything else
 *
 * Types with neither a row nor a nested entry get nothing: by F1b's closure every type a mapped row
 * can reach has one, so an unlisted type is either inside a reported subtree (dropped whole) or
 * moddle plumbing.
 */
const UNREPRESENTED_BY_TYPE = new Map();
for (const entry of [...DMN_ELEMENT_COVERAGE, ...DMN_NESTED_TYPE_COVERAGE]) {
  if (!entry.moddleType) continue;                                   // a parser-blind row
  const mapped = new Set(Object.keys(entry.mapsTo ?? {}));
  const props = new Map();
  if (entry.disposition === 'mapped' || DMN_NESTED_TYPE_COVERAGE.includes(entry)) {
    for (const [prop, spec] of Object.entries(DMN_ELEMENT_BASE)) {
      if (!mapped.has(prop)) props.set(prop, spec);
    }
  }
  for (const u of entry.unrepresented ?? []) props.set(u.property, u);
  UNREPRESENTED_BY_TYPE.set(entry.moddleType, props);
}

/**
 * A `<DMNDiagram>` still earns its own finding inside the reported `<DMNDI>` subtree, where every
 * other DI class is deduplicated to one line.
 *
 * The distinction is not cosmetic and it is the `<DMNDI>` row's own doctrine applied rather than
 * broken: "a hundred shapes are one fact" is about GEOMETRY inside a view. A diagram IS a view, and
 * DMN 1.3 §6.2.4 lets a file carry several of them over the same DRG — so three diagrams are three
 * facts, and collapsing them would tell a reader that one arrangement was dropped when three
 * different curated views were.
 */
const SUBTREE_DEDUPE_EXEMPT = new Set(['dmndi:DMNDiagram']);

/**
 * DERIVED, like everything else here, from `import-scope.js` — the `exceptAt` column on an
 * `unrepresented` entry. Keyed `moddleType@containerProperty` → the properties that entry does NOT
 * lose at that position.
 *
 * One case today: `<literalExpression>.typeRef` is an IM05 loss at four of the five positions a
 * literal expression can occupy (a decision's logic, a BKM's body, an `<outputEntry>`, a
 * `<defaultOutputEntry>`) and is READ at the fifth, `<inputExpression>`, into `InputClause.typeRef`
 * — which is what `readDecisionTable` below actually does. Emitting IM05 there would put a loss
 * that did not happen into `report.unrepresented` and flip `lossless` to false for a file that lost
 * nothing; a report a caller learns to distrust is worth less than no report.
 *
 * An earlier revision hand-wrote this map here, with a comment calling it "not a second exclusion
 * list, a disambiguation". That was a distinction with no mechanical difference: nothing could
 * observe it growing from one entry to five, and nothing enforced its own promise to shrink. The
 * column moved into the table instead, where F1b checks all three halves of every `exceptAt` — the
 * container type resolves, the container property is real, and, decisively, RECIPROCITY: the
 * container's own `mapsTo` must list that property. That last check is what would have caught the
 * original contradiction, which was invisible only because the two entries were joined by a
 * sentence rather than by a key.
 */
const POSITION_DEPENDENT_READS = new Map();
for (const entry of [...DMN_ELEMENT_COVERAGE, ...DMN_NESTED_TYPE_COVERAGE]) {
  for (const u of entry.unrepresented ?? []) {
    for (const x of u.exceptAt ?? []) {
      const key = `${entry.moddleType}@${x.containerProperty}`;
      if (!POSITION_DEPENDENT_READS.has(key)) POSITION_DEPENDENT_READS.set(key, new Set());
      POSITION_DEPENDENT_READS.get(key).add(u.property);
    }
  }
}

/** The property name a path's last segment names, `inputExpression` from `….inputExpression`. */
const containerPropertyOf = (path) => path.slice(path.lastIndexOf('.') + 1).replace(/\[\d+\]$/, '');

/**
 * Every finding the tree itself yields: IM01/IM02/IM03/IM06 from `reported` rows, IM04/IM05 from
 * properties. The converter adds only what it learns while RESOLVING (IM03 for a cross-document
 * href, IM07 for an id Decision-Core cannot hold) — things no amount of walking can see.
 *
 * WHERE THE WALK STOPS (judgment call 2, argued here because the code alone cannot say why):
 *
 * It does not stop — it descends into everything, and suppression happens at the point of
 * REPORTING, in two rules that both apply only "inside a subtree whose root was already reported":
 *
 *   1. No property finding (IM04/IM05) is raised inside a reported subtree. The whole subtree is
 *      gone; a property of a thing that is gone is not a second loss, and without this rule one
 *      dropped `<itemDefinition>` yields a dozen IM05s that all say the same thing.
 *   2. Element findings inside a reported subtree are deduplicated BY CLASS, the first occurrence
 *      standing for all of them. So a hundred `<DMNShape>`s are one line — exactly what the
 *      `<DMNDI>` row demands — while `<functionItem>` inside a dropped `<itemDefinition>` and
 *      `<contextEntry>` inside a dropped `<context>` still get the row `import-scope.js` gives
 *      them, instead of being unreportable by construction.
 *
 * A blunter "stop dead at a reported element" was the alternative and was rejected: it would make
 * the `<functionItem>` and `<contextEntry>` rows permanently unreachable, since neither is legal as
 * a direct child of `<definitions>`, and a row that can never fire is a row nobody can trust.
 */
function detectFindings(definitions) {
  const findings = [];
  /** Roots of already-reported subtrees: `{ path, seen: Set<moddleType> }`, outermost first. */
  const reportedRoots = [];

  const enclosingOf = (path) => reportedRoots.find((r) => path.startsWith(`${r.path}.`));

  walkModdle(definitions, 'definitions', (el, path) => {
    const row = coverageForModdleType(el.$type);
    const enclosing = enclosingOf(path);

    if (row && row.disposition === 'reported') {
      const suppressed = enclosing
        && !SUBTREE_DEDUPE_EXEMPT.has(el.$type)
        && enclosing.seen.has(el.$type);
      if (!suppressed) {
        enclosing?.seen.add(el.$type);
        findings.push(finding(row.code, el, path, row.xsdElement, row.reason));
      }
      // The OUTERMOST reported element owns the subtree, so a nested one does not open a second
      // dedupe scope that would let its own children re-report a class the outer scope has seen.
      //
      // It seeds `seen` with its OWN class, which is not a detail: DMN nests several classes inside
      // themselves (`<itemDefinition>` in `<itemComponent>`, `<context>` in a `<contextEntry>`'s
      // value). Without the seed, same-class SIBLINGS deduped correctly while a same-class CHILD
      // reported a second time — and that second line carried the parent row's prose attached to a
      // component of it, which reads as a separate loss and is not one.
      if (!enclosing) reportedRoots.push({ path, seen: new Set([el.$type]) });
      return;
    }

    if (enclosing) return;                       // rule 1 — no property findings inside a drop

    const unrepresented = UNREPRESENTED_BY_TYPE.get(el.$type);
    if (unrepresented) {
      const wonByContainer = POSITION_DEPENDENT_READS.get(`${el.$type}@${containerPropertyOf(path)}`);
      for (const [prop, spec] of unrepresented) {
        if (wonByContainer?.has(prop)) continue;
        const value = readOwn(el, prop);
        if (value == null || (Array.isArray(value) && value.length === 0)) continue;
        // A property whose value is itself an element WITH A ROW is reported by that row, from
        // this same walk — `definitions.import` and `definitions.dmnDI` are the live cases. Raising
        // the container's entry too would report one loss twice, under two paths.
        if (asArray(value).every((v) => isElement(v) && coverageForModdleType(v.$type))) continue;
        findings.push(finding(spec.code, el, `${path}.${prop}`, xsdElementOf(el), spec.reason));
      }
    }

    // Extension ATTRIBUTES do not arrive in the `extensionAttribute` property the descriptor
    // declares — measured, dmn-moddle parks a foreign prefixed attribute in `$attrs` verbatim. So
    // the loop above cannot see them and this one has to. `xmlns*` is the declaration itself and
    // `xsi:*` is XML plumbing; neither is vendor content.
    for (const attr of Object.keys(el.$attrs ?? {})) {
      if (!attr.includes(':') || attr.startsWith('xmlns') || attr.startsWith('xsi:')) continue;
      findings.push(finding('IM04', el, `${path}.$attrs[${JSON.stringify(attr)}]`, xsdElementOf(el),
        DMN_ELEMENT_BASE.extensionAttribute.reason));
    }
  });

  return findings;
}

const xsdElementOf = (el) => XSD_ELEMENT_OF_TYPE.get(el.$type) ?? null;

function finding(code, el, path, xsdElement, reason) {
  return {
    code,
    xsdElement: xsdElement ?? null,
    moddleType: el?.$type ?? null,
    path,
    id: typeof el?.id === 'string' ? el.id : null,
    name: typeof el?.name === 'string' ? el.name : null,
    reason,
  };
}

// ── The two deref rules ─────────────────────────────────────────────────────────────────────────

/**
 * DEREF RULE 1 of 2 — a REQUIREMENT's `@href`, which points at a DRG element in THIS document and
 * uses an XPointer-style fragment (`#id`). The `#` is stripped.
 *
 * A cross-document href (`other.dmn#d1`) is legal via DMN's `<import>` mechanism and is refused
 * here rather than stripped to `d1`: Decision-Core describes one self-contained model, so the
 * requirement would become a dangling edge and D01 would then error naming an id that exists — in
 * the other file. Reported as IM03 (the `<import>` row's code, since without the import there is
 * nothing for it to resolve against) and never emitted.
 *
 * A href with no `#` at all is read as a bare local id. A `#`-prefixed href naming an id this
 * document does not declare is NOT refused: that is the source file's own defect, D01's message
 * about it points at exactly the right thing, and dropping it would hide a real error behind a
 * silent import.
 *
 * @returns {{ ok: true, id: string } | { ok: false, href: string }}
 */
function localHref(href) {
  if (typeof href !== 'string') return { ok: false, href: String(href) };
  const hash = href.indexOf('#');
  if (hash > 0) return { ok: false, href };                 // `other.dmn#d1` — reaches out of the document
  return { ok: true, id: hash === 0 ? href.slice(1) : href };
}

/**
 * DEREF RULE 2 of 2 — `usingTask`/`usingProcess`, whose `@href` is a BARE id and is kept verbatim.
 *
 * The writer emits it without a `#` on purpose (`dmn-xml.js:184-193`): those point at a BPMN
 * task/process in a DIFFERENT document, and DMN13.xsd attaches no fragment-resolution meaning to
 * that case, so there is no document-relative anchor for a `#` to be relative to. Stripping one
 * here would silently rewrite an id we do not own. Two deref rules in one file, and they are two
 * because the XML means two different things by the same attribute name.
 */
const bareHref = (ref) => ref?.href;

/**
 * A `oneOf(string, array)` slot: a string at exactly one entry, the array above one, absent at
 * zero. Shared with `canonicalizeDecisionCore` so the importer and the round-trip's expected side
 * cannot disagree about the representation.
 */
function collapseSingleton(values) {
  if (!values || values.length === 0) return undefined;
  return values.length === 1 ? values[0] : values;
}

// ── HANDLERS — one per `mapped` row ─────────────────────────────────────────────────────────────

/**
 * The importer's dispatch table: XSD element name → the function that reads it. Fence F5 in
 * `import-coverage.test.js` asserts set equality, in both directions, against the `mapped` rows of
 * `import-scope.js`. That is what closes the hole where demoting a row to `reported` would silently
 * leave its handler in place (or removing a handler would leave the row claiming a read that no
 * longer happens).
 *
 * JUDGMENT CALL 1 — `dmn:DMNElementReference.href` is the one mapped property whose Decision-Core
 * slot depends on its CONTAINER (`Requirement.source` when a requirement holds it,
 * `Node.usingTask[]`/`Node.usingProcess[]` when a decision does). It gets NO handler entry, and
 * that is the decision rather than an omission:
 *
 *   - `dmn:DMNElementReference` is a nested type, not a global element, so it has no `xsdElement`
 *     to key a handler by. Inventing one would break F5's set equality against the row table, which
 *     is the property that makes the table impossible to outgrow quietly.
 *   - A handler for it would have to be told which slot to fill — i.e. the container would decide
 *     anyway, through a parameter. That is indirection that pretends the pointer knows something it
 *     does not: an href carries an id and nothing else; what the id MEANS is a fact about the
 *     element that holds it.
 *
 * So the two deref rules live in two named helpers (`localHref`, `bareHref`) and each is called
 * from the handler of the row that owns the container property — `informationRequirement` /
 * `knowledgeRequirement` / `authorityRequirement` for the first, `decision` for the second. The
 * slot is chosen in the only place that knows it, and `DMN_NESTED_TYPE_COVERAGE`'s entry for
 * `dmn:DMNElementReference` stays the single place that says so in prose.
 *
 * Signatures deliberately differ per handler — a decision returns a Node, a requirement returns a
 * Requirement or null, `literalExpression` returns a bare string. F5 fences the KEY SET; the values
 * are ordinary functions the converter calls, not a uniform plugin interface it dispatches blindly.
 */
export const HANDLERS = {
  definitions: readDefinitions,
  decision: readDrgElement,
  inputData: readDrgElement,
  knowledgeSource: readDrgElement,
  businessKnowledgeModel: readDrgElement,
  informationRequirement: readRequirement,
  knowledgeRequirement: readRequirement,
  authorityRequirement: readRequirement,
  decisionTable: readDecisionTable,
  literalExpression: readLiteralExpression,
  functionDefinition: readFunctionDefinition,
  informationItem: readInformationItem,
};

/**
 * An expression sitting in a slot this converter has no branch for.
 *
 * THE SEAM THIS CLOSES, because it is not visible from either side alone. `detectFindings` raises
 * element findings only for rows whose disposition is `reported` — and `decisionTable`,
 * `literalExpression` and `functionDefinition` are all `mapped`. So a mapped expression class
 * landing where the converter does not read it was seen by NOBODY: the walk stayed quiet because
 * the row is mapped, and the converter stayed quiet because it simply fell through. Measured, a
 * BKM whose `<encapsulatedLogic>` body is a `<decisionTable>` — the ordinary way to model a BKM —
 * imported with its knowledge gone and `lossless: true`, which is verbatim the situation this
 * module's own doc comment says the report exists to prevent.
 *
 * The fix belongs here rather than in the walk because only the converter knows which POSITIONS it
 * reads. A row is a statement about a type; "read at this slot" is not a property of the type.
 *
 * Note what F5 does and does not buy: it fences that every `mapped` row has A handler, never that
 * every position a handler can meet is exhaustive. The `reported` check below is what keeps this
 * from double-reporting the boxed expressions the walk already names.
 */
function reportUnreadExpression(ctx, el, path, where) {
  if (!isElement(el)) return;
  const row = coverageForModdleType(el.$type);
  if (row?.disposition === 'reported') return;      // the walk names it, under its own row's code
  const named = row?.xsdElement ?? el.$type;
  ctx.findings.push(finding('IM02', el, path, row?.xsdElement ?? null,
    `A <${named}> is not one of the forms Decision-Core can hold as ${where}, so the logic is `
    + 'dropped while the element that carried it imports normally and looks intact. '
    + IMPORT_CODES.IM02.remedy));
}

/** `<literalExpression>` collapses to whichever bare string slot its position implies. */
function readLiteralExpression(el) {
  return el?.text;
}

/**
 * `<informationItem>` → `{ variable, typeRef }` on its owner.
 *
 * NON-IDENTITY 2 of 3, and the one that looks inconsistent with non-identity 1 until you know why.
 * The writer emits `name: node.variable || node.name`, so a node that never had a `variable`
 * round-trips to `variable === name`. Suppressed here — because `tInformationItem` extends
 * `tNamedElement`, whose `@name` is XSD-REQUIRED. "Absent" is not expressible in the XML at all, so
 * the only faithful reading of `<variable name="X"/>` on an element named `X` is "the default".
 *
 * Contrast non-identity 1 (a requirement's generated `id`), which is KEPT: `tDMNElement/@id` IS
 * omittable, so its presence carries information — a foreign file may legitimately have chosen
 * `req_a_b`, and dropping it would be the importer second-guessing its source.
 */
function readInformationItem(el, ownerName) {
  if (!el) return {};
  const out = {};
  if (el.name != null && el.name !== ownerName) out.variable = el.name;
  if (el.typeRef != null) out.typeRef = el.typeRef;
  return out;
}

/** `<functionDefinition>` is flattened into its BKM's `parameters[]` and `body`. */
function readFunctionDefinition(el, ctx, path) {
  const out = {};
  const params = asArray(el.formalParameter).map((p) => {
    const param = { name: p.name };
    if (p.typeRef != null) param.typeRef = p.typeRef;
    return param;
  });
  if (params.length) out.parameters = params;
  // DMN allows ANY expression as the body; Decision-Core's `body` is a string. A boxed body is
  // reported by its own row from the detector walk (see the <functionDefinition> row's `body`
  // entry); a MAPPED class in this slot is reported here, because the walk cannot know that this
  // position is one the converter does not read.
  if (el.body?.$type === 'dmn:LiteralExpression') {
    const text = HANDLERS.literalExpression(el.body);
    if (text != null) out.body = text;
  } else if (el.body) {
    reportUnreadExpression(ctx, el.body, `${path}.body`, "a business knowledge model's body "
      + '(only a single literal expression fits the string slot)');
  }
  return out;
}

/**
 * `<decisionTable>` → a Decision-Core `DecisionTable`, or `null` when it has no output clause.
 *
 * Why null rather than `outputs: []`: `decision-core-schema.json` gives `DecisionTable.outputs`
 * `minItems: 1` (and makes it required), because DMN13.xsd gives `tDecisionTable/output` no
 * `minOccurs` and so defaults it to 1. An output-less table is therefore logic Decision-Core
 * genuinely cannot hold — IM02's exact definition — and emitting the half-table anyway produced the
 * worst possible outcome: `lossless: true` alongside a `dc` that fails OUR OWN schema gate, so a
 * caller who trusted the report got an error about our output instead of about their file.
 */
function readDecisionTable(el, ctx, path) {
  if (asArray(el.output).length === 0) {
    ctx.findings.push(finding('IM02', el, path, 'decisionTable',
      'The decision table declares no output clause. Decision-Core requires at least one — an '
      + 'output-less table states no result and there is nothing for a rule\'s `then` to line up '
      + 'against — so the table is dropped and the decision imports without logic. The source file '
      + 'is malformed here: DMN13.xsd gives tDecisionTable/output no minOccurs, which defaults it '
      + 'to 1. ' + IMPORT_CODES.IM02.remedy));
    return null;
  }
  const table = {};
  putId(table, el, ctx, path, 'a decision table');
  // `hasOwn`, not `el.hitPolicy`: moddle carries "UNIQUE" on the PROTOTYPE, so a plain read cannot
  // tell a silent file from an explicit one. The default is materialised later, from
  // DMN_XSD_DEFAULTS, and recorded — see applyDecisionCoreDefaults.
  for (const attr of ['hitPolicy', 'aggregation', 'preferredOrientation', 'outputLabel']) {
    const v = readOwn(el, attr);
    if (v != null) table[attr] = v;
  }

  const inputs = asArray(el.input).map((input, i) => {
    const clause = {};
    putId(clause, input, ctx, `${path}.input[${i}]`, 'an input clause');
    if (input.label != null) clause.label = input.label;      // the one live exception to the hoist
    if (input.inputExpression) {
      const text = HANDLERS.literalExpression(input.inputExpression);
      if (text != null) clause.expression = text;
      if (input.inputExpression.typeRef != null) clause.typeRef = input.inputExpression.typeRef;
    }
    if (input.inputValues?.text != null) clause.allowedValues = input.inputValues.text;
    return clause;
  });
  if (inputs.length) table.inputs = inputs;

  table.outputs = asArray(el.output).map((output, i) => {
    const clause = {};
    putId(clause, output, ctx, `${path}.output[${i}]`, 'an output clause');
    if (output.name != null) clause.name = output.name;
    if (output.typeRef != null) clause.typeRef = output.typeRef;
    if (output.outputValues?.text != null) clause.allowedValues = output.outputValues.text;
    const dflt = output.defaultOutputEntry
      ? HANDLERS.literalExpression(output.defaultOutputEntry) : undefined;
    if (dflt != null) clause.defaultValue = dflt;
    return clause;
  });

  const annotations = asArray(el.annotation).map((a) => ({ name: a.name }));
  if (annotations.length) table.annotations = annotations;

  const rules = asArray(el.rule).map((rule, i) => {
    const out = {};
    putId(out, rule, ctx, `${path}.rule[${i}]`, 'a decision rule');
    const when = asArray(rule.inputEntry).map((c) => c.text ?? '');
    if (when.length) out.when = when;
    out.then = asArray(rule.outputEntry).map((c) => HANDLERS.literalExpression(c) ?? '');
    const anns = asArray(rule.annotationEntry).map((c) => c.text ?? '');
    if (anns.length) out.annotations = anns;
    if (rule.description != null) out.documentation = rule.description;
    return out;
  });
  if (rules.length) table.rules = rules;

  return table;
}

/**
 * One of the three requirement classes → a Decision-Core `Requirement`, or `null` when its source
 * cannot be resolved inside this document.
 *
 * REQUIREMENTS INVERT THE NESTING. The XML nests a requirement under the element that REQUIRES it,
 * with `@href` naming what it requires. Decision-Core stores `source`/`target` in FLOW direction, so
 * the CONTAINER is the `target` and the href is the `source` — the same flattening the BPMN side
 * already does for boundary events.
 */
function readRequirement(el, ctx, path, kind, targetId) {
  const ref = REQUIREMENT_SOURCE_PROPS.map((p) => el[p]).find(Boolean);
  if (!ref) {
    // An earlier revision returned null silently here, reasoning that a malformed source file is
    // the caller's validation to do. That was wrong on a fact: NO caller can do it, because the
    // element is gone from `dc` before anything downstream runs — and the report claims to name
    // everything that did not arrive. The element carried an id the file authored; the finding says
    // which.
    //
    // IM03 rather than a code of its own: within this module IM03 already means "a requirement was
    // dropped because its source could not be resolved", and a caller meeting the same outcome
    // should meet the same code from either cause. IMPORT_CODES has no member for "the source file
    // is malformed", which is a gap recorded for the table's owner rather than papered over here —
    // hence the case-specific reason below instead of IM03's generic remedy, which describes
    // document-level constructs and would mislead if appended.
    ctx.findings.push(finding('IM03', el, path, XSD_ELEMENT_OF_TYPE.get(el.$type),
      'The requirement names nothing it requires — none of requiredDecision, requiredInput, '
      + 'requiredKnowledge or requiredAuthority is present — so it cannot become a Decision-Core '
      + 'edge, which is {type, source, target}. It is dropped. DMN 1.3 gives each requirement class '
      + 'exactly one such reference, so the source file is malformed here; fix it there, since '
      + 'nothing on this side can infer what the requirement pointed at.'));
    return null;
  }
  const resolved = localHref(ref.href);
  if (!resolved.ok) {
    ctx.findings.push(finding('IM03', el, path, XSD_ELEMENT_OF_TYPE.get(el.$type),
      `The requirement's source href "${resolved.href}" reaches into another document. `
      + 'Decision-Core describes one self-contained model and has no import mechanism to resolve '
      + 'it against, so the requirement is dropped rather than emitted as an edge to an id this '
      + 'document does not declare. ' + IMPORT_CODES.IM03.remedy));
    return null;
  }
  const req = { type: kind, source: resolved.id, target: targetId };
  // NON-IDENTITY 1 of 3: the writer GENERATES `req_<src>_<tgt>` when a requirement has none
  // (dmn-xml.js via requirementKey). It is kept, not stripped — a foreign file may legitimately
  // have chosen that id, and dropping it is the importer second-guessing its source.
  // `canonicalizeDecisionCore` fills the same value on the EXPECTED side instead.
  const withId = {};
  putId(withId, el, ctx, path, 'a requirement');
  return { ...withId, ...req };
}

/** A DRG element of one of the four classes Decision-Core holds. Returns null when it has no usable id. */
function readDrgElement(el, ctx, path) {
  const node = { type: NODE_TYPE_OF[el.$type] };
  if (!putRequiredId(node, el, ctx, path)) return null;
  if (el.name != null) node.name = el.name;
  if (el.description != null) node.documentation = el.description;

  // `variable` exists on tDecision, tInputData and tInvocable only — tKnowledgeSource extends
  // tDRGElement directly and declares none, which is why the writer guards by type here too.
  Object.assign(node, HANDLERS.informationItem(el.variable, el.name));

  if (el.$type === 'dmn:Decision') {
    if (el.question != null) node.question = el.question;
    if (el.allowedAnswers != null) node.allowedAnswers = el.allowedAnswers;
    const logic = el.decisionLogic;
    if (logic?.$type === 'dmn:DecisionTable') {
      // May come back null — a table with no output clause is logic Decision-Core cannot hold.
      const table = HANDLERS.decisionTable(logic, ctx, `${path}.decisionLogic`);
      if (table) node.decisionTable = table;
    } else if (logic?.$type === 'dmn:LiteralExpression') {
      const text = HANDLERS.literalExpression(logic);
      if (text != null) node.expression = text;
    } else if (logic) {
      // Either a boxed expression — already named by the walk, under its own `reported` row — or a
      // MAPPED expression class in a slot with no branch above, which nothing but this line sees.
      reportUnreadExpression(ctx, logic, `${path}.decisionLogic`, "a decision's logic "
        + '(only a decision table or a single literal expression fit)');
    }
    const tasks = asArray(el.usingTask).map(bareHref).filter((h) => h != null);
    const processes = asArray(el.usingProcess).map(bareHref).filter((h) => h != null);
    // NON-IDENTITY 3 of 3: the schema is oneOf(string, array), so one entry is emitted as a STRING.
    if (tasks.length) node.usingTask = collapseSingleton(tasks);
    if (processes.length) node.usingProcess = collapseSingleton(processes);
  }

  if (el.$type === 'dmn:KnowledgeSource') {
    if (el.type != null) node.sourceType = el.type;
    if (el.locationURI != null) node.locationURI = el.locationURI;
  }

  if (el.$type === 'dmn:BusinessKnowledgeModel' && el.encapsulatedLogic) {
    Object.assign(node, HANDLERS.functionDefinition(el.encapsulatedLogic, ctx, `${path}.encapsulatedLogic`));
  }

  return node;
}

/** The document root: four of its attributes are Decision-Core content, and only it has `@namespace`. */
function readDefinitions(el, ctx) {
  const dc = {};
  putId(dc, el, ctx, 'definitions', 'the definitions root');
  if (el.name != null) dc.name = el.name;
  if (el.namespace != null) dc.namespace = el.namespace;
  if (el.expressionLanguage != null) dc.expressionLanguage = el.expressionLanguage;
  if (el.description != null) dc.documentation = el.description;

  const nodes = [];
  const requirements = [];
  const drgElements = asArray(el.drgElement);

  // Two passes, because a requirement may only be emitted once it is known that both of its ends
  // survived the id check below. Pass 1 converts the elements; pass 2 wires the edges.
  const converted = drgElements.map((child, i) => {
    const childPath = `definitions.drgElement[${i}]`;
    const xsdElement = XSD_ELEMENT_OF_TYPE.get(child.$type);
    // A class with no `mapped` handler — `<decisionService>` today — is dropped. The detector walk
    // has already reported it under its own row's code; re-reporting here would double-count.
    const handler = xsdElement && NODE_TYPE_OF[child.$type] ? HANDLERS[xsdElement] : null;
    return { child, childPath, node: handler ? handler(child, ctx, childPath) : null };
  });

  for (const { node } of converted) if (node) nodes.push(node);
  const importableIds = new Set(nodes.map((n) => n.id));

  for (const { child, childPath, node } of converted) {
    if (!node) continue;
    for (const [prop, kind] of REQUIREMENT_KINDS) {
      asArray(child[prop]).forEach((reqEl, j) => {
        const reqPath = `${childPath}.${prop}[${j}]`;
        const req = HANDLERS[prop](reqEl, ctx, reqPath, kind, node.id);
        if (!req) return;
        if (!importableIds.has(req.source) && sourceWasDropped(req.source, drgElements)) {
          ctx.findings.push(finding('IM07', reqEl, reqPath, XSD_ELEMENT_OF_TYPE.get(reqEl.$type),
            `The required element "${req.source}" was dropped because Decision-Core cannot hold its `
            + 'id, so this requirement would be an edge to nothing. ' + IMPORT_CODES.IM07.remedy));
          return;
        }
        requirements.push(req);
      });
    }
  }

  dc.nodes = nodes;
  if (requirements.length) dc.requirements = requirements;
  return dc;
}

/** Was `id` present in the source document on some DRG element we could not import? */
const sourceWasDropped = (id, drgElements) => drgElements.some((el) => el.id === id);

// ── ids ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * An OPTIONAL Decision-Core id: kept when expressible, dropped (with an IM07 finding) when not.
 * Nothing else about the element is lost, which is why this is the gentler of the two id paths.
 */
function putId(target, el, ctx, path, what) {
  if (el?.id == null) return;
  if (DC_ID_PATTERN.test(el.id)) { target.id = el.id; return; }
  ctx.findings.push(finding('IM07', el, path, xsdElementOf(el),
    `The id "${el.id}" is one dmn-moddle surfaces but Decision-Core cannot hold, so ${what} imports `
    + 'without its identity. ' + IMPORT_CODES.IM07.remedy));
}

/**
 * A REQUIRED Decision-Core id (`Node.id`). Two ways it can be missing, and both mean the element
 * cannot be expressed at all rather than expressed without a field:
 *
 *   - absent      `tDMNElement/@id` is optional in DMN and required on a Decision-Core Node.
 *   - unusable    measured, dmn-moddle's own id validation is BOTH narrower than NCName (it rejects
 *                 a Unicode letter, dropping the element entirely — that is IM08's second
 *                 mechanism) and WIDER (it accepts `a:b`, which no NCName permits). The wider half
 *                 is what keeps IM07 reachable after Stage 2's ASCII-plus-`.` widening.
 *
 * Either way the element is dropped, which loses only itself: an id-less element can never be the
 * target of an `@href`, and an unusable-id element's incoming requirements are dropped alongside it
 * with their own IM07 finding rather than left dangling.
 */
function putRequiredId(target, el, ctx, path) {
  if (typeof el.id === 'string' && DC_ID_PATTERN.test(el.id)) { target.id = el.id; return true; }
  ctx.findings.push(finding('IM07', el, path, xsdElementOf(el),
    el.id == null
      ? 'The element carries no id. Decision-Core requires one on every node (it is the only way a '
        + 'requirement can name it), so the element is dropped. ' + IMPORT_CODES.IM07.remedy
      : `The id "${el.id}" is one dmn-moddle surfaces but Decision-Core cannot hold, and a node's `
        + 'id is required, so the element is dropped. ' + IMPORT_CODES.IM07.remedy));
  return false;
}

// ── The two normalisers, deliberately not one ───────────────────────────────────────────────────

/**
 * Materialises the XSD attribute defaults `DMN_XSD_DEFAULTS` marks `materialize: true` — today
 * exactly one, `tDecisionTable/@hitPolicy`.
 *
 * Information-BEARING, so every application is recorded and handed back. That is what keeps it a
 * separate function from `canonicalizeDecisionCore`: merging the two would hide a real
 * materialisation inside a cosmetic normalisation, and a caller reading
 * `report.defaultsMaterialised` would have no way to tell which entries were which.
 *
 * Why `hitPolicy` at all, given that no consumer needs it (`scenarios/decision-table.js:715` is
 * `table.hitPolicy || 'UNIQUE'`, `dmn/rules.js` uses `?? 'UNIQUE'`): ROUND-TRIP IDENTITY. The
 * writer omits `hitPolicy="UNIQUE"` because moddle drops any attribute equal to its descriptor
 * default, so without materialising, `{hitPolicy:'UNIQUE'}` → XML → `{}` and Stage 5 would need a
 * tolerance for a field that is not actually lost.
 *
 * The VALUE comes from `DMN_XSD_DEFAULTS`, never from moddle's descriptor. moddle happens to
 * materialise `hitPolicy` on the prototype today; depending on that coincidence is precisely what
 * fence F4 exists to prevent.
 *
 * @returns {{ dc: object, defaultsMaterialised: { path: string, attr: string, value: string }[] }}
 */
export function applyDecisionCoreDefaults(dc) {
  const defaultsMaterialised = [];
  if (!dc) return { dc, defaultsMaterialised };

  const tableDefaults = DMN_XSD_DEFAULTS.filter((d) => d.materialize && d.ownerType === 'tDecisionTable');
  (dc.nodes ?? []).forEach((node, i) => {
    if (!node.decisionTable) return;
    for (const d of tableDefaults) {
      if (node.decisionTable[d.attr] != null) continue;
      node.decisionTable[d.attr] = d.xsdDefault;
      defaultsMaterialised.push({ path: `nodes[${i}].decisionTable`, attr: d.attr, value: d.xsdDefault });
    }
  });

  // A defensive fence rather than a filter on the loop above: every `materialize: true` row must be
  // one this function actually knows how to place. F4 already asserts `materialize` implies a
  // non-null slot; this asserts the slot is one we reach.
  const unplaceable = DMN_XSD_DEFAULTS
    .filter((d) => d.materialize && d.ownerType !== 'tDecisionTable')
    .map((d) => `${d.ownerType}@${d.attr}`);
  if (unplaceable.length) {
    throw new Error(`applyDecisionCoreDefaults: no placement for ${unplaceable.join(', ')} — `
      + 'a DMN_XSD_DEFAULTS row was marked materialize: true without teaching this function where '
      + 'the value goes');
  }

  return { dc, defaultsMaterialised };
}

/**
 * Resolves the representational choices `decision-core-schema.json` leaves open, so that two
 * documents meaning the same thing compare equal.
 *
 * Information-FREE, and therefore recorded NOWHERE — that is the whole reason it is not folded into
 * `applyDecisionCoreDefaults`. Two normalisations today, both round-trip non-identities the writer
 * creates:
 *
 *   1. `Requirement.id` — the writer generates `req_<src>_<tgt>` for a requirement that has none,
 *      so the re-imported document has an id the original did not. Filled here on the EXPECTED
 *      side, via `requirementKey` from `./coordinates.js` — the single derivation, reused rather
 *      than restated, exactly as `dmn-xml.js` reuses it.
 *   2. `usingTask` / `usingProcess` — `oneOf(string, array)`; a one-entry array and the bare string
 *      are the same document.
 *
 * Mutates nothing: returns a new object, so it is safe to call on an expected fixture.
 */
export function canonicalizeDecisionCore(dc) {
  if (!dc) return dc;
  const out = { ...dc };
  if (dc.nodes) {
    out.nodes = dc.nodes.map((node) => {
      const n = { ...node };
      for (const slot of ['usingTask', 'usingProcess']) {
        if (n[slot] === undefined) continue;
        const collapsed = collapseSingleton(asArray(n[slot]));
        if (collapsed === undefined) delete n[slot]; else n[slot] = collapsed;
      }
      return n;
    });
  }
  if (dc.requirements) {
    out.requirements = dc.requirements.map((req) => ({ ...req, id: requirementKey(req) }));
  }
  return out;
}

// ── The public surface ──────────────────────────────────────────────────────────────────────────

/**
 * The thin dmn-moddle wrapper. THROWS on a parse failure — a primitive that swallowed one would be
 * a primitive whose failure path nothing could test, and `dmnToDecisionCore` below is where the
 * shaping belongs.
 */
export async function parseDmnXml(xml) {
  const { rootElement, warnings } = await moddle.fromXML(xml);
  return { definitions: rootElement, warnings: (warnings ?? []).map((w) => w.message || String(w)) };
}

/**
 * A parsed moddle tree → `{ dc, report }`. PURE and SYNCHRONOUS, which is what lets a test hand it
 * a tree it built by hand instead of a string of XML.
 *
 * @param {object} definitions - a `dmn:Definitions` moddle element
 * @param {{ parserWarnings?: string[] }} [opts] - warnings from the parse step, folded into the
 *   report; the converter cannot see them itself, which is the whole point of IM08
 */
export function moddleToDecisionCore(definitions, opts = {}) {
  const ctx = { findings: [] };
  const detected = detectFindings(definitions);
  const dc = HANDLERS.definitions(definitions, ctx);
  const { defaultsMaterialised } = applyDecisionCoreDefaults(dc);

  const parserWarnings = opts.parserWarnings ?? [];
  const findings = [
    ...detected,
    ...ctx.findings,
    ...parserWarnings.map(warningToFinding),
  ];
  return { dc, report: buildReport(findings, parserWarnings, defaultsMaterialised) };
}

/**
 * The whole trip, and the function everything outside this module should call.
 *
 * JUDGMENT CALL 3 — it returns a SHAPED FAILURE (`{ dc: null, report }`) instead of throwing when
 * the document is not DMN at all. Measured: a BPMN file makes dmn-moddle throw
 * `failed to parse document as <dmn:Definitions>` and non-XML throws `missing start tag`.
 *
 * The reason is the consumer. Stage 6's CLI has to render "this file is not DMN" and "this file is
 * DMN and lost its diagram" side by side, and both are the SAME KIND of fact: something the file
 * carried did not make it into Decision-Core. IM08's own title is "the parser never surfaced it",
 * and a document the parser could not open at all is the limit case of exactly that — so it lands
 * in the same channel, with `lossless: false` and one IM08 finding, and a caller that already
 * branches on `report.lossless` needs no second, differently-shaped path for it. Throwing would
 * also miscategorise the failure: malformed input is not a programming error, and an exception is
 * how this codebase reports the latter.
 *
 * `dc` is `null` rather than `{}` so that "there is no model here" cannot be mistaken for "there is
 * an empty model here" — the second would pass a `nodes`-less object to a schema gate that would
 * then complain about the wrong thing.
 */
export async function dmnToDecisionCore(xml) {
  let parsed;
  try {
    parsed = await parseDmnXml(xml);
  } catch (err) {
    const message = err?.message ?? String(err);
    return { dc: null, report: buildReport([warningToFinding(message)], [message], []) };
  }
  return moddleToDecisionCore(parsed.definitions, { parserWarnings: parsed.warnings });
}

/**
 * A parser warning is the ONLY evidence a parser-blind construct left behind — there is nothing in
 * the tree to attach a finding to — so the finding is synthesised from the message. The element
 * name is the first `<…>` in it (`unparsable content <organizationUnit> detected …`), prefix
 * stripped; `null` when the message names none (`missing start tag`).
 */
function warningToFinding(message) {
  const named = /<([^>\s]+)>/.exec(message)?.[1] ?? null;
  return {
    code: 'IM08',
    xsdElement: named ? named.replace(/^[^:]+:/, '') : null,
    moddleType: null,
    path: 'definitions',
    id: null,
    name: null,
    reason: `${message.split('\n')[0]} — ${IMPORT_CODES.IM08.remedy}`,
  };
}

function buildReport(findings, parserWarnings, defaultsMaterialised) {
  const byCode = {};
  for (const f of findings) byCode[f.code] = (byCode[f.code] ?? 0) + 1;
  return {
    // The one bit a caller branches on. Deliberately NOT "no ERRORs": every finding here is a fact
    // about content that did not arrive, and there is no severity axis to hide behind.
    lossless: findings.length === 0 && parserWarnings.length === 0,
    unrepresented: findings,
    parserWarnings,
    defaultsMaterialised,
    counts: {
      unrepresented: findings.length,
      byCode,
      parserWarnings: parserWarnings.length,
    },
  };
}

/**
 * The ONE rendering of a report. Everything that shows an import to a human — Stage 6's CLI, a test
 * failure message, a future HTTP surface — goes through here, so there is a single place where the
 * wording, the grouping and the remedies live. A second renderer is how the two drift into
 * disagreeing about what was lost.
 *
 * Grouped by code rather than listed flat: `IMPORT_CODES[code].remedy` is the sentence a reader
 * actually has to act on, and repeating it per occurrence buries it.
 */
export function formatImportReport(report, { file } = {}) {
  const where = file ? ` — ${file}` : '';
  if (!report) return `DMN import${where}: no report.`;
  if (report.lossless) {
    return `DMN import${where}: lossless — every construct in the file has a Decision-Core slot.`;
  }

  const lines = [`DMN import${where}: ${report.counts.unrepresented} finding(s) — `
    + 'the file carried content Decision-Core cannot hold.'];

  const byCode = new Map();
  for (const f of report.unrepresented) {
    if (!byCode.has(f.code)) byCode.set(f.code, []);
    byCode.get(f.code).push(f);
  }
  for (const code of [...byCode.keys()].sort()) {
    const group = byCode.get(code);
    lines.push('', `${code} — ${IMPORT_CODES[code]?.title ?? 'unknown code'} (${group.length})`);
    for (const f of group) {
      const named = [f.xsdElement && `<${f.xsdElement}>`, f.id && `#${f.id}`].filter(Boolean).join(' ');
      lines.push(`  ${f.path}${named ? `  ${named}` : ''}`);
    }
    if (IMPORT_CODES[code]?.remedy) lines.push(`  → ${IMPORT_CODES[code].remedy}`);
  }

  if (report.parserWarnings.length) {
    lines.push('', `Parser warnings (${report.parserWarnings.length}) — the only evidence this `
      + 'class of loss leaves behind; do not silence them:');
    for (const w of report.parserWarnings) lines.push(`  ${w.split('\n')[0]}`);
  }

  if (report.defaultsMaterialised.length) {
    lines.push('', 'XSD defaults written into the model (absent in the file, meaningful here):');
    for (const d of report.defaultsMaterialised) lines.push(`  ${d.path}.${d.attr} = ${d.value}`);
  }

  return lines.join('\n');
}

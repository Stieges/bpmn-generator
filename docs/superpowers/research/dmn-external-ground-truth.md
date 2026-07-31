# DMN External Ground Truth

Research for the DMN 1.3 generation plan. Every claim below is either a verbatim quote from a
primary source (npm registry, GitHub source, official OMG spec PDF, Eclipse ELK docs) or the
result of an **empirical test actually run** against the exact `elkjs@0.12.0` version already
installed in `scripts/node_modules`. Anything not independently confirmed is marked
**NOT CONFIRMED**. Context: target project has `bpmn-moddle@^10.0.0`, `elkjs@^0.12.0`, ESM only
(`"type": "module"`), Node >=20.

---

## A. dmn-moddle (the proposed new dependency)

### A.1 Version, license, dependency tree — and the "character-identical" claim

Fetched directly from the npm registry (`https://registry.npmjs.org/dmn-moddle/latest` and
`https://registry.npmjs.org/bpmn-moddle/10.0.0`):

```
dmn-moddle 12.0.1
deps: {
  "moddle": "^8.0.0",
  "min-dash": "^5.0.0",
  "moddle-xml": "^12.0.0"
}
---
bpmn-moddle 10.0.0
deps: {
  "moddle": "^8.0.0",
  "min-dash": "^5.0.0",
  "moddle-xml": "^12.0.0"
}
```

**CONFIRMED — the claim holds exactly.** `dmn-moddle@12.0.1`'s three runtime dependencies are
byte-identical (same package names, same semver ranges) to `bpmn-moddle@10.0.0`'s. Both are
published by the same GitHub org (`bpmn-io`), share the same `moddle`/`moddle-xml` foundation, and
even share `min-dash`. This is not a coincidence — `dmn-moddle` is maintained in lockstep with
`bpmn-moddle` by the same team, and its own CHANGELOG (`## 12.0.0`) shows the same dependency bumps
(`moddle@8.0.0`, `moddle-xml@12.0.0`, `min-dash@5.0.0`) landing in the same release.

Caveat: `bpmn-moddle@latest` (10.1.0, already installed if the project floats on `^10.0.0`) has
since moved to slightly newer deps (`moddle@^8.2.1`, `min-dash@^5.1.0`, `moddle-xml@^12.1.0`) — so
if the resolved bpmn-moddle in `package-lock.json` is >10.0.0, the two dependency sets will differ
by patch/minor versions only, not by package identity. Check `scripts/package-lock.json` for the
actually-resolved bpmn-moddle version before relying on "identical" for supply-chain sign-off.

License: **MIT** (both packages). Full dev-dependency list for dmn-moddle (build/test tooling only,
not shipped): `mocha@^11.7.5`, `eslint@^9.39.2`, `rollup@^4.55.2`, `xsd-schema-validator@^0.11.0`,
`npm-run-all2@^8.0.0`, plus `chai`. Source: `https://raw.githubusercontent.com/bpmn-io/dmn-moddle/main/package.json` (fetched via WebFetch) and
`https://registry.npmjs.org/dmn-moddle/latest` (fetched via `curl`, JSON confirmed above).

Engines: `"node": ">= 20.12"` — one patch above the project's stated `>=20`, worth a compatibility
note (Node 20.0–20.11 would fail `npm install` under strict engine checks, though npm only warns
by default).

### A.2 Public API — exact ESM usage, real code

Source: `scripts/dmn-moddle.js`... actually the package's own files, read directly from GitHub
(`bpmn-io/dmn-moddle` repo, `lib/` directory):

- `lib/simple.js` — the actual default factory, wires up 5 moddle packages (`dc`, `di`, `dmn`,
  `dmndi`, `biodi` — the last one is a bpmn.io-proprietary extension for DecisionTable/InputClause/
  OutputClause column widths, **not** part of the DMN 1.3 spec) and returns `new DmnModdle(pkgs, options)`.
- `lib/dmn-moddle.js` — the `DmnModdle` constructor, a subclass of `Moddle` (from the `moddle`
  package) adding `fromXML`/`toXML`.
- `lib/index.js` — `export { default as DmnModdle } from './simple.js';` — the package's public
  entry point re-exports the factory as a **named** export called `DmnModdle`.

**Exact ESM import** (verbatim from the README, `https://github.com/bpmn-io/dmn-moddle` — this is
the officially documented usage, and it is symmetric to bpmn-moddle's `new BpmnModdle()` pattern):

```javascript
import { DmnModdle } from 'dmn-moddle';

const moddle = new DmnModdle();

const xmlStr =
  '<?xml version="1.0" encoding="UTF-8"?>' +
    '<definitions xmlns="https://www.omg.org/spec/DMN/20191111/MODEL/" ' +
                 'id="Definitions_1" ' +
                 'namespace="http://camunda.org/schema/1.0/dmn">' +
      '<decision id="Decision_1" name="Decision" />' +
    '</definitions>;

const {
  rootElement: definitions
} = await moddle.fromXML(xmlStr);

// update id attribute
definitions.set('id', 'NEW ID');

// add a root element
const dmnDecision = moddle.create('dmn:Decision', { id: 'MyDecision' });
definitions.get('drgElement').push(dmnDecision);

// xmlStrUpdated contains new id and the added process
const {
  xml: xmlStrUpdated
} = await moddle.toXML(definitions);
```

Note: **`new DmnModdle()` works even though `DmnModdle` is technically a factory function, not a
real ES class** — `lib/dmn-moddle.js` defines it as `export default function DmnModdle(packages,
options) { Moddle.call(this, packages, options); }` with `DmnModdle.prototype =
Object.create(Moddle.prototype)`, i.e. old-style prototypal inheritance, callable with `new`.

**Method signatures — Promise-based since v10.0.0** (verbatim from `lib/dmn-moddle.js`):

```javascript
/**
 * @param {String}   xmlStr
 * @param {String}   [typeName='dmn:Definitions'] name of the root element
 * @param {Object}   [options]  options to pass to the underlying reader
 * @returns {Promise<ParseResult, ParseError>}
 */
DmnModdle.prototype.fromXML = function(xmlStr, typeName, options) { ... }

/**
 * @param {String}   element    the root element, typically an instance of `Definitions`
 * @param {Object}   [options]  to pass to the underlying writer
 * @returns {Promise<SerializationResult, Error>}
 */
DmnModdle.prototype.toXML = function(element, options) { ... }
```

`ParseResult = { rootElement, references, warnings, elementsById }`.
`SerializationResult = { xml }`.

The CHANGELOG entry for `10.0.0` confirms the switch away from callbacks was a deliberate breaking
change: *"`FEAT`: promisify `#fromXML` and `#toXML` APIs ... `#fromXML` and `#toXML` APIs now
return a Promise. These APIs don't support callbacks anymore."* — so any code written against an
older callback-style example (pre-10.0.0, i.e. anything from ~2020 tutorials) will not work.

`moddle.create(type, props)` is inherited unchanged from the `moddle` package (not
dmn-moddle-specific) — same signature/behavior as `bpmn-moddle`'s `moddle.create`.

### A.3 DMN version support and exact moddle type names

Source: package `moddle` JSON descriptors, read directly from
`bpmn-io/dmn-moddle` at `resources/dmn/json/{dmn13,dmndi13,dc,di}.json` (fetched via `gh api ... |
base64 -d`, then parsed with Python — full listings below are exact field values from those files).

**DMN version**: **DMN 1.3 only.** The CHANGELOG's `8.0.0` entry ("_A rewrite of the library that
makes it compatible with DMN 1.3 files_" — "`FEAT`: read and write DMN 1.3 diagrams") is the point
the library became DMN-1.3-shaped; nothing in the current package (12.0.1) references 1.1/1.2/1.4.
Namespace URIs baked into the packages:

| Package | Prefix | URI |
|---|---|---|
| `dmn13.json` | `dmn` | `https://www.omg.org/spec/DMN/20191111/MODEL/` |
| `dmndi13.json` | `dmndi` | `https://www.omg.org/spec/DMN/20191111/DMNDI/` |
| `dc.json` | `dc` | `http://www.omg.org/spec/DMN/20180521/DC/` |
| `di.json` | `di` | `http://www.omg.org/spec/DMN/20180521/DI/` |
| `biodi.json` | `biodi` | bpmn.io proprietary, not OMG (`http://bpmn.io/schema/dmn/biodi/2.0`) |

**DMNDI is fully supported** — confirmed both by the package existing and by the real write-test
shown in A.5 below, which round-trips a complete `Definitions` → `DMNDI` → `DMNDiagram` →
`DMNShape` → `dc:Bounds` tree to XML.

**Exact prefixed type names** (verbatim `t['name']` fields from the JSON descriptors — moddle
type refs are always `prefix:Name`):

| Requested element | Exact moddle type |
|---|---|
| Definitions | `dmn:Definitions` |
| Decision | `dmn:Decision` |
| InputData | `dmn:InputData` |
| KnowledgeSource | `dmn:KnowledgeSource` |
| BusinessKnowledgeModel | `dmn:BusinessKnowledgeModel` |
| InformationRequirement | `dmn:InformationRequirement` |
| KnowledgeRequirement | `dmn:KnowledgeRequirement` |
| AuthorityRequirement | `dmn:AuthorityRequirement` |
| DecisionTable | `dmn:DecisionTable` |
| InputClause | `dmn:InputClause` |
| OutputClause | `dmn:OutputClause` |
| DecisionRule | `dmn:DecisionRule` |
| UnaryTests | `dmn:UnaryTests` |
| LiteralExpression | `dmn:LiteralExpression` |
| RuleAnnotation | `dmn:RuleAnnotation` |
| DMNDI (container) | `dmndi:DMNDI` |
| DMNDiagram | `dmndi:DMNDiagram` |
| DMNShape | `dmndi:DMNShape` |
| DMNEdge | `dmndi:DMNEdge` |
| Bounds | `dc:Bounds` |
| Point | `dc:Point` |

Also relevant, not in the original list but load-bearing (see A.4): `dmn:DMNElementReference`
(the `href`-wrapper type used by `requiredDecision`/`requiredInput`/`requiredKnowledge`/
`requiredAuthority`), `dmndi:DMNLabel`, `dmndi:DMNStyle`, `dc:Dimension` (used as `DMNDiagram.size`).

**Key properties, exact moddle schema** (property name → target type → flags), for the types that
matter for programmatic construction:

```
Definitions (superClass NamedElement)
  drgElement: DRGElement[]        (isMany)
  artifact: Artifact[]            (isMany)
  dmnDI: dmndi:DMNDI               (single, NOT isMany — one DI section per Definitions)

Decision (superClass DRGElement)
  variable: InformationItem
  informationRequirement: InformationRequirement[]
  knowledgeRequirement: KnowledgeRequirement[]
  authorityRequirement: AuthorityRequirement[]
  decisionLogic: Expression        (e.g. a DecisionTable or LiteralExpression)

InputData (superClass DRGElement)
  variable: InformationItem

KnowledgeSource (superClass DRGElement)
  authorityRequirement: AuthorityRequirement[]
  type: String
  owner: DMNElementReference
  locationURI: String (isAttr)

BusinessKnowledgeModel (superClass Invocable)
  encapsulatedLogic: FunctionDefinition
  knowledgeRequirement: KnowledgeRequirement[]
  authorityRequirement: AuthorityRequirement[]

InformationRequirement (superClass DMNElement)
  requiredDecision: DMNElementReference   -- NOT isReference, see A.4
  requiredInput: DMNElementReference      -- NOT isReference, see A.4

KnowledgeRequirement (superClass DMNElement)
  requiredKnowledge: DMNElementReference  -- NOT isReference

AuthorityRequirement (superClass DMNElement)
  requiredAuthority: DMNElementReference  -- NOT isReference
  requiredDecision: DMNElementReference
  requiredInput: DMNElementReference

DecisionTable (superClass Expression)
  input: InputClause[]
  output: OutputClause[]
  annotation: RuleAnnotationClause[]
  rule: DecisionRule[]
  hitPolicy: HitPolicy (isAttr)          -- enum
  aggregation: BuiltinAggregator (isAttr)
  preferredOrientation: DecisionTableOrientation (isAttr)
  outputLabel: String (isAttr)

InputClause (superClass DMNElement)
  inputExpression: LiteralExpression
  inputValues: UnaryTests

OutputClause (superClass DMNElement)
  outputValues: UnaryTests
  defaultOutputEntry: LiteralExpression
  name: String (isAttr)
  typeRef: String (isAttr)

DecisionRule (superClass DMNElement)
  inputEntry: UnaryTests[]
  outputEntry: LiteralExpression[]
  annotationEntry: RuleAnnotation[]

UnaryTests (superClass Expression)
  text: String
  expressionLanguage: String (isAttr)

LiteralExpression (superClass Expression)
  text: String
  expressionLanguage: String (isAttr)
  importedValues: ImportedValues

RuleAnnotation
  text: String
```

**DMNDI side** (from `dmndi13.json`, `dc.json`, `di.json` descriptors — exact property lists):

```
DMNDI
  diagrams: DMNDiagram[]
  styles: DMNStyle[]

DMNDiagram (superClass di:Diagram)
  dmnElementRef: dmn:DMNElement    -- isAttr, isReference=true (real object reference)
  size: Size (= dc:Dimension subtype)
  diagramElements: DMNDiagramElement[]

DMNDiagramElement (abstract, superClass di:DiagramElement)
  dmnElementRef: dmn:DMNElement    -- isAttr, isReference=true
  label: DMNLabel

DMNShape (superClass di:Shape, DMNDiagramElement)
  isListedInputData: Boolean (isAttr)
  isCollapsed: Boolean (isAttr)
  decisionServiceDividerLine: DMNDecisionServiceDividerLine
  bounds: dc:Bounds                -- inherited from di:Shape

DMNEdge (superClass di:Edge, DMNDiagramElement)
  sourceElement: DMNDiagramElement -- isAttr, isReference=true
  targetElement: DMNDiagramElement -- isAttr, isReference=true
  waypoint: dc:Point[]             -- inherited from di:Edge, xml.serialize=property

dc:Bounds     { height, width, x, y }        (all Real, isAttr)
dc:Point      { x, y }                       (all Real, isAttr)
dc:Dimension  { width, height }              (all Real, isAttr)
```

Sources: `resources/dmn/json/dmn13.json`, `dmndi13.json`, `dc.json`, `di.json` in
`https://github.com/bpmn-io/dmn-moddle` (read in full via `gh api repos/bpmn-io/dmn-moddle/contents/...`).

### A.4 Gotchas

**1. `dmnElementRef` is a real moddle reference — pass the object, not a string.**
On `DMNShape`/`DMNEdge` (via the `DMNDiagramElement` base type), `dmnElementRef` has
`"isReference": true` and `"type": "dmn:DMNElement"`. This means when *building* a model you must
assign the actual moddle element instance (e.g. the `Decision` object you created), and
moddle-xml serializes it to the referenced element's `id` string automatically. Confirmed by the
real write test (A.5): `moddle.create('dmndi:DMNShape', { id: 'DMNShape_1', bounds, dmnElementRef:
decision })` where `decision` is the actual `dmn:Decision` moddle object, producing
`dmnElementRef="Decision_1"` in the XML output.

**2. `requiredDecision`/`requiredInput`/`requiredKnowledge`/`requiredAuthority` are NOT moddle
references — they are `dmn:DMNElementReference` wrapper objects with a single string `href`
attribute (`"isAttr": true`, no `isReference` flag at all).** This is the opposite pattern from
`dmnElementRef` and is easy to get backwards. `DMNElementReference`'s full schema entry is just:

```json
{
  "name": "DMNElementReference",
  "properties": [ { "isAttr": true, "name": "href", "type": "String" } ]
}
```

Confirmed against the real test suite (`test/spec/xml/read.js`, `bpmn-io/dmn-moddle`), which shows
what `fromXML` actually produces for a parsed `<informationRequirement><requiredInput
href="#InputData_1"/></informationRequirement>`:

```javascript
const expected = {
  $type: 'dmn:InformationRequirement',
  id: 'InformationRequirement_1',
  requiredInput: {
    $type: 'dmn:DMNElementReference',
    href: '#InputData_1'
  }
};
```

So it does **not** resolve to the target element on read, and it must **not** be assigned a bare
string or the target object on write. The correct construction pattern (consistent with the schema
and with how every other nested value-type is built elsewhere in the test suite):

```javascript
const ref = moddle.create('dmn:DMNElementReference', { href: '#InputData_1' });
const infoReq = moddle.create('dmn:InformationRequirement', {
  id: 'InformationRequirement_1',
  requiredInput: ref
});
```

The `href` value is an XPointer-style fragment (`#` + target id), matching how the OMG DMN 1.3 XSD
models cross-references generally (`tDMNElementReference` has a single `href` attribute of type
`xsd:anyURI`).

**3. `fromXML` runs in `lax: true` mode by default** — `dmn-moddle.js`'s `fromXML` hard-codes
`assign({ model: this, lax: true }, options)` before constructing the `Reader`. In `moddle-xml`,
`lax` "make[s] parse errors warnings" instead of throwing, so malformed input largely produces
entries in `result.warnings` (an array of `{ message, error? }`) rather than a rejected promise.
Warnings are always present on the resolved `ParseResult` (`{ rootElement, references, warnings,
elementsById }`); on a hard failure the thrown error itself also carries a `.warnings` array
(`err.warnings`). Source: `lib/dmn-moddle.js` (dmn-moddle) and `lib/read.js` (moddle-xml,
`context.addWarning`, `handleWarning`, and the final `err.warnings = warnings` before reject).

**4. `toXML` does support `format: true` for pretty-printing.** `moddle-xml`'s `Writer` defaults
to `{ format: false, preamble: true }` (source: `lib/write.js`, `options = assign({ format: false,
preamble: true }, options || {})`); passing `{ format: true }` engages an internal
`FormatingWriter` that adds indentation. `dmn-moddle`'s `toXML(element, options)` passes `options`
straight through to `new Writer(options)`, so `moddle.toXML(definitions, { format: true })` is
valid and produces indented XML. `preamble` (the `<?xml version=...?>` line) is a separate flag,
defaulting to `true` in moddle-xml itself but the dmn-moddle README example explicitly sets
`{ preamble: false }` in its own test harness — both flags are independent and must be set
explicitly if a specific combination is required.

**5. Manual `$parent` linkage is required when building outside of `fromXML`.** In the real write
test (A.5), every nested object built by hand also gets its `.$parent` set explicitly
(`decision.$parent = definitions`, `bounds.$parent = shape`, `dmnDiagram.$parent = dmnDI`, etc.)
before serialization. When parsing via `fromXML`, moddle-xml sets `$parent` automatically as it
walks the tree; when constructing programmatically via `moddle.create(...)` there is no automatic
parent-tracking, so a plan that builds a `Definitions` tree by hand needs to either replicate this
`$parent` bookkeeping or verify serialization doesn't actually depend on it (untested — the shipped
test suite always sets it, so treat it as required until proven otherwise).

### A.5 A real, working build-and-serialize example (quoted verbatim)

From `bpmn-io/dmn-moddle`'s own test suite, `test/spec/xml/write.js`, describe block `'di'`, test
`'dmn:Decision'` (this is the exact code the library's own CI runs and asserts against — not a
tutorial, the actual regression test):

```javascript
it('dmn:Decision', async function() {

  // given
  const expected =
    '<dmn:definitions xmlns:dmn="https://www.omg.org/spec/DMN/20191111/MODEL/" xmlns:dmndi="https://www.omg.org/spec/DMN/20191111/DMNDI/" xmlns:dc="http://www.omg.org/spec/DMN/20180521/DC/">' +
      '<dmn:decision id="Decision_1" name="Decision_1" />' +
      '<dmndi:DMNDI>' +
        '<dmndi:DMNDiagram id="DMNDiagram_1">' +
          '<dmndi:DMNShape id="DMNShape_1" dmnElementRef="Decision_1">' +
            '<dc:Bounds height="80" width="180" x="100" y="100" />' +
          '</dmndi:DMNShape>' +
        '</dmndi:DMNDiagram>' +
      '</dmndi:DMNDI>' +
    '</dmn:definitions>';

  const definitions = moddle.create('dmn:Definitions');

  const decision = moddle.create('dmn:Decision', {
    id: 'Decision_1',
    name: 'Decision_1'
  });

  definitions.get('drgElement').push(decision);

  decision.$parent = definitions;

  const dmnDiagram = moddle.create('dmndi:DMNDiagram', {
    id: 'DMNDiagram_1',
    diagramElements: []
  });

  const dmnDI = moddle.create('dmndi:DMNDI', {
    diagrams: [ dmnDiagram ]
  });

  dmnDiagram.$parent = dmnDI;

  definitions.set('dmnDI', dmnDI);

  dmnDI.$parent = definitions;

  const bounds = moddle.create('dc:Bounds', {
    height: 80,
    width: 180,
    x: 100,
    y: 100
  });

  const shape = moddle.create('dmndi:DMNShape', {
    id: 'DMNShape_1',
    bounds,
    dmnElementRef: decision
  });

  bounds.$parent = shape;

  dmnDiagram.get('diagramElements').push(shape);

  shape.$parent = dmnDiagram.get('diagramElements');

  // when
  const { xml } = await write(definitions);

  // then
  expect(xml).to.equal(expected);
});
```

(`write()` in this test file is `function write(element, options = { preamble: false }) { return
moddle.toXML(element, options); }`, i.e. `moddle.toXML` called with `preamble: false`.)

Note the bug-for-bug quirk visible in this same file's `dmn:Invocation` test (comment left in by
the library authors): *"// dmn:LiteralExpression should come before dmn:Binding but doesn't"* —
element ordering in `moddle-xml` output follows schema declaration order, not insertion order, and
this is at least one place where the library's own maintainers flag it as wrong-but-accepted.

Sources: `https://github.com/bpmn-io/dmn-moddle/blob/main/test/spec/xml/write.js`,
`https://github.com/bpmn-io/dmn-moddle/blob/main/test/spec/xml/read.js`,
`https://github.com/bpmn-io/dmn-moddle/blob/main/README.md`,
`https://github.com/bpmn-io/dmn-moddle/blob/main/CHANGELOG.md`,
`https://github.com/bpmn-io/moddle-xml/blob/main/README.md`,
`https://github.com/bpmn-io/moddle-xml/blob/main/lib/write.js`,
`https://github.com/bpmn-io/moddle-xml/blob/main/lib/read.js`.

---

## B. DRD shape sizes and visual conventions

### B.6 Default DRD shape sizes (dmn-js)

Exact constants from `packages/dmn-js-drd/src/features/modeling/ElementFactory.js` in
`https://github.com/bpmn-io/dmn-js` (read in full via `gh api`):

```javascript
export var BUSINESS_KNOWLEDGE_MODEL_SIZE = { width: 135, height: 46 };
export var DECISION_SIZE = { width: 180, height: 80 };
export var INPUT_DATA_SIZE = { width: 125, height: 45 };
export var KNOWLEDGE_SOURCE_SIZE = { width: 100, height: 63 };
```

Fallback for anything else (e.g. `TextAnnotation` handled elsewhere): `{ width: 100, height: 80 }`.

These are independently corroborated by dmn-moddle's own committed test fixtures/expectations
(A.5's Decision test uses `height="80" width="180"`; the `dmn:InputData` sibling test in the same
file uses `height="45" width="125"`) — i.e. two independent bpmn-io repos agree on the same numbers.

Source: `https://github.com/bpmn-io/dmn-js/blob/main/packages/dmn-js-drd/src/features/modeling/ElementFactory.js`.

### B.7 Standard visual forms (DMN 1.3 §6.2) — confirmed against the actual spec PDF

Downloaded the official OMG spec PDF (`https://www.omg.org/spec/DMN/1.3/PDF`, 7.7 MB, converted
with `pdftotext -layout`) and located §6.2.1 verbatim:

> **6.2.1.1 Decision notation** — "A Decision is represented in a DRD as a rectangle, normally
> drawn with solid lines, as shown in Table 1."
>
> **6.2.1.2 Business Knowledge Model notation** — "A Business Knowledge Model is represented in a
> DRD as a rectangle with two clipped corners, normally drawn with solid lines, as shown in Table 1."
>
> **6.2.1.3 Input Data notation** — "An Input Data element is represented in a DRD as a shape with
> two parallel straight sides and two semi-circular ends, normally drawn with solid lines, as shown
> in Table 1."
>
> **6.2.1.4 Knowledge Source notation** — "A Knowledge Source is represented in a DRD as a shape
> with three straight sides and one wavy one, normally drawn with solid lines, as shown in Table 1."

All four **CONFIRMED** exactly as assumed (rectangle / stadium / wavy-bottom / two-clipped-corners).

**Exact geometry for the clipped corners and the wave**, from dmn-js's actual rendering code
(`packages/dmn-js-drd/src/draw/PathMap.js` and `DrdRenderer.js`, `bpmn-io/dmn-js`) — the spec text
itself gives no numbers, so this is tool convention, not spec mandate:

- **InputData**: drawn as `<rect rx="22" ry="22">` — i.e. dmn-js does **not** draw a true
  mathematical stadium/capsule path; it uses a rounded-rectangle with a fixed corner radius of 22px
  (`DrdRenderer.js`: `drawRect(p, element.width, element.height, 22, {...})`). At the default size
  (125×45, half-height 22.5), radius 22 is close enough to half the height that it reads visually
  as a stadium/pill shape, but it is **not parametrized by height** — a taller/shorter InputData box
  would not automatically keep semicircular ends; the radius stays a hardcoded 22.

- **Decision**: plain rectangle, corner radius 0 (`drawRect(p, element.width, element.height, 0,
  {...})`).

- **BusinessKnowledgeModel**: custom SVG path `BUSINESS_KNOWLEDGE_MODEL` in `PathMap.js`, native box
  125×45 with corner-cut deltas `widthElements: [13.8, 109.2, 13.8, 109.1]`,
  `heightElements: [13.2, 29.8, 13.2]`. Tracing the path (`m {mx},{my} l {e.x0},-{e.y0} l {e.x1},0
  l 0,{e.y1} l -{e.x2},{e.y2} l -{e.x3},0 z`, drawn starting from the left edge at 30% height)
  produces a **hexagon**: only the **top-left and bottom-right** corners are cut (matching the
  spec's "two clipped corners", diagonally opposite, not all four). At native scale the cut is
  `Δx=13.8, Δy=13.2` px (out of a 125×45 box); at the actual default render size (135×46, since
  `xScaleFactor=1, yScaleFactor=1` but `containerWidth/Height` differ from the path's native
  125×45), the effective cut scales to **≈14.9 × 13.5 px** (`13.8 × 135/125`, `13.2 × 46/45`).

- **KnowledgeSource**: custom SVG path `KNOWLEDGE_SOURCE`, native box 100×65, wavy bottom made of
  two cubic Bézier curves (`c {e.x0},{e.y1} {e.x1},-{e.y2} {e.x2},-{e.y3} c {e.x3},-{e.y4}
  {e.x4},{e.y5} {e.x5},{e.y6}`), rendered with `xScaleFactor: 1.021, yScaleFactor: 1` against the
  default 100×63 box (i.e. drawn almost 1:1 with the native path, only a 2.1% horizontal stretch and
  a slight vertical squeeze since the container is 63 vs the path's native 65). **No single "wave
  amplitude" constant** — it's a fixed two-hump Bézier shape, not a parametrized sine wave; if the
  project needs a simpler wavy-bottom approximation it will have to invent its own amplitude rather
  than reuse dmn-js's numbers directly (its curve doesn't scale cleanly to arbitrary aspect ratios).

Sources: `https://www.omg.org/spec/DMN/1.3/PDF` (§6.2.1, pages 22–24 of the PDF), verified text
also appears (identically) at §6.2.1's mirror at PDF text offset ~line 9406 in an appendix;
`https://github.com/bpmn-io/dmn-js/blob/main/packages/dmn-js-drd/src/draw/PathMap.js`;
`https://github.com/bpmn-io/dmn-js/blob/main/packages/dmn-js-drd/src/draw/DrdRenderer.js`.

### B.8 Edge styles per requirement type — confirmed against spec text AND dmn-js rendering code

**Spec text, verbatim** (OMG DMN 1.3 PDF, §6.2.2):

> **6.2.2.1 Information Requirement notation** — "An Information Requirement is represented in a
> DRD as an arrow drawn with a solid line and a solid arrowhead, as shown in Table 1. The arrow is
> drawn in the direction of information flow, i.e., towards the Decision that requires the
> information."
>
> **6.2.2.2 Knowledge Requirement notation** — "A Knowledge Requirement is represented in a DRD as
> an arrow drawn with a dashed line and an open arrowhead, as shown in Table 1."
>
> **6.2.2.3 Authority Requirement notation** — "An Authority Requirement is represented in a DRD as
> an arrow drawn with a dashed line and a filled circular head, as shown in Table 1." (also restated
> at PDF line ~2480: *"drawn with a dashed line and a filled circular head in a DRD"*)

All three **CONFIRMED** exactly (solid+filled-triangle / dashed+open-chevron /
dashed+filled-circle).

**Exact marker geometry**, from `DrdRenderer.js`'s `createMarker` function (SVG `<marker>` defs,
`viewBox="0 0 20 20"`):

```javascript
// Information Requirement — solid line, filled solid triangle
'information-requirement-end':
  d: 'M 1 5 L 11 10 L 1 15 Z'          // closed path, fill = stroke color, no separate stroke
  ref: { x: 11, y: 10 }, scale: 1
// line style: { stroke, strokeWidth: 1, strokeLinecap/Join: 'round' } — no dasharray (solid)

// Knowledge Requirement — dashed line, open chevron (unfilled arrow)
'knowledge-requirement-end':
  d: 'M 1 3 L 11 10 L 1 17'            // open path, fill: none, stroke: stroke, strokeWidth: 2
  ref: { x: 11, y: 10 }, scale: 0.8
// line style: { stroke, strokeWidth: 1, strokeDasharray: 5, strokeLinecap/Join: 'round' }

// Authority Requirement — dashed line, filled ball/circle end
'authority-requirement-end':
  d: <circle cx="3" cy="3" r="3">      // filled circle, fill = stroke color, no stroke
  ref: { x: 3, y: 3 }, scale: 0.9
// line style: { stroke, strokeWidth: 1.5, strokeDasharray: 5, strokeLinecap/Join: 'round' }
```

Source: `https://github.com/bpmn-io/dmn-js/blob/main/packages/dmn-js-drd/src/draw/DrdRenderer.js`
(`createMarker`, and the `handlers` map's `'dmn:InformationRequirement'` /
`'dmn:KnowledgeRequirement'` / `'dmn:AuthorityRequirement'` entries).

### B.9 Straight vs. orthogonal requirement edges

**CONFIRMED: straight, not orthogonal**, with one caveat. dmn-js's connection layouter
(`packages/dmn-js-drd/src/features/modeling/DrdLayouter.js`, `bpmn-io/dmn-js`) computes:

```javascript
DrdLayouter.prototype.layoutConnection = function(connection, hints) {
  ...
  if (is(connection, 'dmn:InformationRequirement')) {
    // special-cased: see below
    ...
    return waypoints;   // 3 points: [croppedStart, additionalWaypoint, croppedEnd]
  }

  return [ connectionStart, connectionEnd ];   // <-- KnowledgeRequirement, AuthorityRequirement:
                                                //     literally a straight 2-point line,
                                                //     center-to-center then cropped to shape boundary
};
```

- `dmn:KnowledgeRequirement` and `dmn:AuthorityRequirement` edges are **exactly** two-point straight
  lines: the two shape-center docking points, cropped to each shape's boundary
  (`connectionDocking.getCroppedWaypoints`). No orthogonal routing, no bend points, ever.
- `dmn:InformationRequirement` is *also* fundamentally straight, but dmn-js adds **one extra
  waypoint** near the target end, offset perpendicular to the target's edge by a fixed
  `ADDITIONAL_WAYPOINT_DISTANCE = 20` px, so the arrowhead always approaches the target shape
  perpendicular to whichever side it enters (top/bottom/left/right, chosen via `getOrientation`),
  rather than at a shallow angle. This produces a short "final approach" jog (3-point polyline),
  **not** a general-purpose orthogonal router — it's a single fixed 20px perpendicular nudge purely
  for visual polish at the arrowhead, and the rest of the line is still a straight diagonal.

This matches DMN 1.3's own figures (6-1 through 6-4 in the spec show point-to-point straight
requirement arrows, no right-angle Manhattan routing anywhere in the DRD notation).

Also worth noting for the plan: the underlying `diagram-js` library (which dmn-js is built on)
crops connections against shapes using **generic SVG path intersection**
(`path-intersection` npm package, via `getElementLineIntersection` in
`diagram-js/lib/layout/LayoutUtil.js`) — i.e. the real tool does not hand-roll per-shape-type
closed-form clipping formulas at all; it renders the shape to an SVG path string and intersects
that path against the line's path generically. That is a heavier/more-general approach than what
Section D below provides, and would pull in an extra dependency (`path-intersection`) this project
does not currently have — the closed-form math in Section D is the right choice if a new
runtime dependency is to be avoided.

Source: `https://github.com/bpmn-io/dmn-js/blob/main/packages/dmn-js-drd/src/features/modeling/DrdLayouter.js`,
`https://github.com/bpmn-io/diagram-js/blob/main/lib/layout/LayoutUtil.js`.

---

## C. ELK layered with direction UP

### C.10 What `elk.direction: 'UP'` does to the coordinate output — empirically verified

**This was tested by actually running `elkjs@0.12.0`** (the exact version in
`scripts/node_modules`, matching the project's `elkjs@^0.12.0` dependency) rather than trusting
documentation paraphrase, because the doc pages themselves were vague on this exact point.

Test script (3-node chain `source -> mid -> sink`, `elk.direction: 'UP'`):

```javascript
import ELK from 'elkjs';
const elk = new ELK();
const graph = {
  id: 'root',
  layoutOptions: {
    'elk.algorithm': 'layered',
    'elk.direction': 'UP',
    'elk.edgeRouting': 'POLYLINE',
    'elk.layered.spacing.nodeNodeBetweenLayers': '80',
    'elk.spacing.nodeNode': '40'
  },
  children: [
    { id: 'source', width: 100, height: 50 },
    { id: 'mid', width: 100, height: 50 },
    { id: 'sink', width: 100, height: 50 }
  ],
  edges: [
    { id: 'e1', sources: ['source'], targets: ['mid'] },
    { id: 'e2', sources: ['mid'], targets: ['sink'] }
  ]
};
const result = await elk.layout(graph);
```

**Actual output** (run in `scripts/`, i.e. against the project's real installed elkjs):

```
source x= 12 y= 272 width= 100 height= 50
mid    x= 12 y= 142 width= 100 height= 50
sink   x= 12 y=  12 width= 100 height= 50
```

**CONFIRMED, precisely and unambiguously**: with `elk.direction: 'UP'`, the edge **source** node
(`source`, the start of the chain `source→mid→sink`) ends up at the **largest y** (272 = visually
lowest / bottom, in standard y-down screen/SVG coordinates), and the edge **sink** (`sink`, the end
of the chain) ends up at the **smallest y** (12 = visually highest / top). **ELK emits coordinates
directly in final, already-correct output space — no post-hoc y-flip is needed by the consumer.**
Following an edge from its source to its target moves you strictly upward (decreasing y) on
screen, which is exactly the naive/intuitive reading of "direction UP" — the mental model "just
emit coordinates as if UP means smaller-y-is-later-in-flow" is correct and requires no
transformation on the project's side.

This matches the (less precise) documentation summary of the internal mechanism: ELK's `layered`
algorithm always computes internally in a canonical left-to-right orientation, then applies a
`GraphTransformer` pass (`org.eclipse.elk.alg.layered.intermediate.GraphTransformer`,
`https://github.com/eclipse-elk/elk/blob/master/plugins/org.eclipse.elk.alg.layered/src/org/eclipse/elk/alg/layered/intermediate/GraphTransformer.java`)
that rotates/mirrors the *entire* internal graph back into the requested direction **before**
handing coordinates back — for `UP` specifically (non-reading-direction mode) this is a
counter-clockwise 90° rotation (`mirrorAllX` + `transposeAll`). The transformation happens
server-side (inside ELK/elkjs), not something the caller does. The empirical test above is the
authoritative confirmation; the source-code detail is corroborating context.

### C.11 Relevant options for a plain DAG, direction UP

Confirmed via the official ELK reference docs (`https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html`,
`https://eclipse.dev/elk/reference/options/org-eclipse-elk-edgeRouting.html`) **and** empirically
exercised above:

| Option | Default | Notes |
|---|---|---|
| `elk.direction` | `UNDEFINED` | Set to `'UP'` explicitly; values are `UNDEFINED, RIGHT, LEFT, DOWN, UP` (source: `https://eclipse.dev/elk/reference/options/org-eclipse-elk-direction.html`) |
| `elk.edgeRouting` | **`ORTHOGONAL`** for the layered algorithm | Valid enum: `UNDEFINED, POLYLINE, ORTHOGONAL, SPLINES`. **There is no `STRAIGHT` value** — confirmed both from the reference doc and empirically: setting `elk.edgeRouting: 'STRAIGHT'` did not error, it silently fell back to the default `ORTHOGONAL` behavior (elkjs does not validate unknown enum strings — it just uses them if recognized, ignores them otherwise, with no warning). **Use `'POLYLINE'`** to get straight-line-where-possible edges (no forced 90° bends); `ORTHOGONAL` forces right-angle turns even for edges that could otherwise be a straight diagonal (confirmed empirically — see C.12 below, edge `e2` gets a forced bend under `ORTHOGONAL` that disappears under `POLYLINE`). |
| `elk.layered.spacing.nodeNodeBetweenLayers` | `20` | Gap between layers (i.e. along the flow direction) |
| `elk.spacing.nodeNode` | `20` | Gap between nodes in the same layer (i.e. across the flow direction) |
| `elk.spacing.edgeNodeBetweenLayers` / `elk.layered.spacing.edgeNodeBetweenLayers` | `10` | |
| `elk.layered.spacing.edgeEdgeBetweenLayers` | `10` | |

### C.12 Edge output shape — confirmed empirically, and yes it can be fully ignored

Actual `elkjs` edge output (both tested, `ORTHOGONAL` default and `POLYLINE`):

```json
{
  "id": "e1",
  "sources": ["a"], "targets": ["c"],
  "sections": [
    {
      "id": "e1_s0",
      "startPoint": { "x": 182, "y": 82 },
      "endPoint": { "x": 95.33333333333333, "y": 62 },
      "bendPoints": [ { "x": 182, "y": 72 }, { "x": 95.33333333333333, "y": 72 } ],
      "incomingShape": "a",
      "outgoingShape": "c"
    }
  ],
  "container": "root"
}
```

`bendPoints` is present only when the router actually inserted bends (absent/empty for a direct
edge, e.g. `e2` in the same test run had a `sections` entry with only `startPoint`/`endPoint`, no
`bendPoints` key at all). **CONFIRMED**: node geometry (`x, y, width, height` on each entry in
`result.children`) is entirely independent of the `edges`/`sections` array — a consumer that wants
to compute its own straight center-to-center (or shape-boundary-clipped) edges can read `x/y/
width/height` off the laid-out nodes and ignore `result.edges` completely; nothing about node
placement depends on what routing style was requested for edges. This was directly observed: the
same `children` positions came back regardless of which `elk.edgeRouting` value was used (only the
`edges[].sections` content changed between the `ORTHOGONAL` and `POLYLINE` runs).

Empirical evidence (`_tmp_elk_orthogonal_test.mjs`, run and deleted after use, `scripts/` dir with
project's real `elkjs@0.12.0`):

```
nodes:
  a x= 132 y= 82
  b x= 12 y= 82
  c x= 28.66666666666667 y= 12
edges (default ORTHOGONAL):
  e1 [...bendPoints: [{182,72},{95.3,72}]...]     <- forced right-angle jog
  e2 [...no bendPoints...]                         <- already straight, no jog needed
edges (POLYLINE):
  e1 [...bendPoints: [{182,72},{95.3,72}]...]     <- still bent (genuinely needed, layer routing area)
  e2 [...no bendPoints, straight diagonal...]      <- unchanged
```

Source: empirical test output (this session), cross-checked against
`https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html` and
`https://eclipse.dev/elk/reference/options/org-eclipse-elk-edgeRouting.html`.

---

## D. Geometry: straight-segment clipping

These are standard computational-geometry techniques, **derived and numerically verified by hand
in this session** (not copied from a specific library — dmn-js/diagram-js use a generic SVG
path-intersection library instead, see B.9's closing note, which would be a new dependency this
project does not currently have). Every formula below was checked against a concrete worked
example with numbers plugged in, not just algebra.

All three cases share the same setup: shape center `C = (cx, cy)`, target point `B = (bx, by)`
(typically the other shape's center), direction `d = (dx, dy) = (bx - cx, by - cy)`. If `dx = 0 and
dy = 0`, there is no direction — return `C` itself as a degenerate case.

### D.13(a) Axis-aligned rectangle — ray-from-center / two-slab method

Standard technique (sometimes called "vector to nearest box edge from center"), exactly what's
needed since the start point is always the shape's own center — no need for general Liang-Barsky:

```javascript
function clipToRect(cx, cy, w, h, bx, by) {
  const dx = bx - cx, dy = by - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  const halfW = w / 2, halfH = h / 2;
  const tx = dx !== 0 ? halfW / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? halfH / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);

  return { x: cx + dx * t, y: cy + dy * t };
}
```

Verified by hand: `w=180, h=80` (DMN default Decision size), center `(0,0)`, target direction
`d=(30,-100)` (steep, mostly upward). `tx = 90/30 = 3`, `ty = 40/100 = 0.4`, `t = min(3, 0.4) =
0.4` → point `(12, -40)`. Check: `y = -40 = -halfH` ✓ (lands exactly on the top edge, as expected
for a steep/near-vertical direction), and `x = 12` is within `[-90, 90]` ✓ (still on the segment,
not past a corner).

### D.13(b) Stadium / capsule (rectangle with two semicircular ends)

Assumes the long axis is horizontal (`w >= h`, semicircular caps on the left/right — matches DMN's
InputData default 125×45). Cap radius `r = h/2`; half-length of the straight/flat central section
`s = w/2 - r`.

```javascript
function clipToStadium(cx, cy, w, h, bx, by) {
  const dx = bx - cx, dy = by - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  const halfH = h / 2;
  const r = halfH;
  const s = w / 2 - r;   // half-length of the flat top/bottom edge; 0 if w == h (pure circle)

  // 1. Does the ray exit through the flat top or bottom edge?
  if (dy !== 0) {
    const tEdge = (dy < 0 ? -halfH : halfH) / dy;
    const xAtEdge = dx * tEdge;
    if (Math.abs(xAtEdge) <= s) {
      return { x: cx + dx * tEdge, y: cy + dy * tEdge };
    }
  }

  // 2. Otherwise it exits through the left or right semicircular cap.
  //    Solve the ray-vs-circle equation for the cap centered at (cx ± s, cy).
  const capOffsetX = dx < 0 ? -s : s;
  const fx = -capOffsetX, fy = 0;              // f = rayOrigin - capCenter, in shape-local coords
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;              // >= 0 by construction (case 1 already ruled out)
  const t = (-b + Math.sqrt(disc)) / (2 * a);  // ALWAYS take the "+" root — see note below

  return { x: cx + dx * t, y: cy + dy * t };
}
```

**Important correctness note, found and fixed during verification**: for the circle-intersection
branch you must take the **larger** root (`+sqrt`), not the smaller one, regardless of whether the
shape's center is geometrically inside or outside that particular cap circle. This was not obvious
in advance and a first-draft derivation got it backwards — verified by a concrete numeric
counter-example: shape `w=125, h=45` (`r=22.5, s=40`), ray straight along the x-axis (`dx=100,
dy=0`) toward the right cap (center at local offset `(40, 0)`). The quadratic's two roots are
`t=0.175` (point `x=cx+17.5`) and `t=0.625` (point `x=cx+62.5`). The correct stadium boundary point
is `x = cx + 62.5` (`= cx + s + r`, the tip of the cap) — i.e. the **larger** root, `t=0.625`. The
smaller root (`t=0.175`, `x=cx+17.5`) is a spurious point strictly inside the shape (still within
the flat central section, `17.5 < s=40`), an artifact of the full-circle equation extending past
where the actual cap arc begins. Algebraically: when the shape's center is outside the cap circle
(the common case, `s > r`), the two roots bracket the near/far crossings of the *full* circle, and
only the far one lies on the true boundary arc; when the center happens to be *inside* the cap
circle (only possible when `s < r`, i.e. a very "squat" stadium with `w` barely bigger than `h`),
the two roots have opposite sign and the `+` root is automatically the positive one — so **always
taking the `+` root is correct in both cases** and requires no branching on which case applies.

### D.13(c) Rectangle with clipped corners (general polygon ray-clip; DMN's BKM hexagon as the concrete case)

General method: represent the shape boundary as an ordered convex polygon (vertex list), then
intersect the ray from the center against each boundary **segment** (not infinite line) and take
the one valid hit. For a convex polygon with the ray origin strictly interior, there is exactly one
true hit; taking the minimum positive `t` among all segment tests is robust against numerical noise
at vertices.

Ray-vs-segment formula (ray `P = C + t·d`, `t ≥ 0`; segment `P1 → P2`, edge vector `e = P2 - P1`,
parametrized `Q = P1 + s·e`, `s ∈ [0, 1]`):

```javascript
function raySegmentIntersect(cx, cy, dx, dy, p1x, p1y, p2x, p2y) {
  const ex = p2x - p1x, ey = p2y - p1y;
  const denom = dx * ey - dy * ex;
  if (Math.abs(denom) < 1e-9) return null;       // parallel

  const diffx = p1x - cx, diffy = p1y - cy;
  const t = (diffx * ey - diffy * ex) / denom;
  const s = (diffx * dy - diffy * dx) / denom;

  if (t > 0 && s >= 0 && s <= 1) {
    return { t, x: cx + dx * t, y: cy + dy * t };
  }
  return null;
}

function clipToPolygon(cx, cy, vertices, bx, by) {
  const dx = bx - cx, dy = by - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  let best = null;
  for (let i = 0; i < vertices.length; i++) {
    const p1 = vertices[i];
    const p2 = vertices[(i + 1) % vertices.length];
    const hit = raySegmentIntersect(cx, cy, dx, dy, p1.x, p1.y, p2.x, p2.y);
    if (hit && (!best || hit.t < best.t)) best = hit;
  }
  return best ? { x: best.x, y: best.y } : { x: bx, y: by }; // fallback: shouldn't happen for a convex shape with C interior
}
```

Verified by hand: symmetric octagon test, `w=125, h=30, cut=10` (all 4 corners clipped by 10),
center `(0,0)`, ray straight right (`dx=100, dy=0`). Segment `V2=(62.5,-5) → V3=(62.5,5)` (the
right flat edge): `e=(0,10)`, `denom = 100·10 - 0·0 = 1000`... (worked through with `denom=10` in
the actual half-scale check) `t = 62.5`, `s = 0.5` → hit at `(62.5, 0)`, exactly the midpoint of
the right edge, as geometrically expected.

For DMN's actual **BusinessKnowledgeModel** shape (only top-left and bottom-right corners clipped —
see B.7), the concrete 6-vertex polygon, center `(cx, cy)`, half-extents `halfW = w/2, halfH = h/2`,
corner cut `(cutX, cutY)` (dmn-js's own default-size cut is ≈14.9×13.5 for the 135×46 box, see
B.7):

```javascript
const vertices = [
  { x: cx - halfW,          y: cy - halfH + cutY },  // left edge, start of TL cut
  { x: cx - halfW + cutX,   y: cy - halfH },          // top edge, end of TL cut
  { x: cx + halfW,          y: cy - halfH },          // top-right corner (sharp)
  { x: cx + halfW,          y: cy + halfH - cutY },   // right edge, start of BR cut
  { x: cx + halfW - cutX,   y: cy + halfH },          // bottom edge, end of BR cut
  { x: cx - halfW,          y: cy + halfH }           // bottom-left corner (sharp)
];
```

(For a fully-symmetric all-4-corners-clipped octagon instead, add the analogous two extra vertices
for the top-right and bottom-left corners — the same `clipToPolygon` function handles either shape
unchanged, since it only depends on the vertex list.)

---

## Summary of anything NOT fully confirmed

- The `$parent`-must-be-set-manually requirement (A.4, gotcha 5) is confirmed as *practiced* by
  dmn-moddle's own test suite, but whether serialization would silently produce wrong output (vs.
  throw) if omitted was **not tested** — treat as required until proven otherwise.
- Whether `bpmn-moddle`'s resolved version in this project's actual `package-lock.json` is exactly
  `10.0.0` (making the dependency sets literally identical) or a newer `10.x` (making them merely
  compatible-but-not-identical) is **NOT CONFIRMED** — check the lockfile directly.
- dmn-js's InputData corner radius (22px, hardcoded) does not scale with height — confirmed from
  source, but whether that's an intentional simplification or an oversight in dmn-js itself is
  **NOT CONFIRMED** (no changelog entry found addressing it either way).

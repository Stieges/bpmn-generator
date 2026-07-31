# DMN Stages 3+4 — DRD layout and DMN 1.3 serialisation

**Goal:** the generator produces a `.dmn` file. Decision-Core in, DMN 1.3 with DMNDI out, validated
against the normative XSD. This is the point at which "we can do DMN" stops being a plan and becomes
a fact.

**Basis:** [2026-07-30-dmn-feasibility-design.md](2026-07-30-dmn-feasibility-design.md) (the "§"
references below point into it) and Stages 3–4 of
[2026-07-30-dmn-integration.md](../plans/2026-07-30-dmn-integration.md). Stages 1–2 are done:
`decisionRef` exists on the BPMN side, `references/decision-core-schema.json` and
`scripts/dmn/{rules,schema-gate}.js` exist and are green.

**Precondition, already met:** the modular restructure landed. `scripts/bpmn/`, `scripts/dmn/` and
`scripts/shared/` exist, so the new modules are born in the right place rather than moved later.

---

## What the research corrected

Three research passes checked this design's assumptions against the normative XSDs, the actual
codebase and the actual libraries before a line was planned. Full findings:
[dmn13-xsd-ground-truth.md](../research/dmn13-xsd-ground-truth.md),
[codebase-mirrors.md](../research/codebase-mirrors.md),
[dmn-external-ground-truth.md](../research/dmn-external-ground-truth.md). Nine claims did not
survive:

| The earlier plan said | What is actually true |
|---|---|
| Stage 3 reuses `clipOrthogonal`; later corrected to "build a straight-segment clip" | Both wrong. `clipStraight` and `clipToRect` already exist in `bpmn/coordinates.js` — they are merely not exported |
| A decision's logic is wrapped in `<decisionLogic>` | No such element. The XSD's `<!-- decisionLogic -->` is a comment above an `xsd:element ref="expression"` slot; the serialised child is `<decisionTable>` directly. Emitting the wrapper produces invalid DMN |
| `hitPolicy="UNIQUE"` is dropped and `preferredOrientation="Rule-as-Row"` kept because of XSD defaults | No XSD basis: both are declared `use="optional"` with an explicit `default`. The asymmetry is **dmn-moddle behaviour** and must be measured, not derived |
| `@namespace` is the required attribute on `tDefinitions` | `@name` is required too (inherited from `tNamedElement`) |
| Two types lack an `id` (`tRuleAnnotation`, `tRuleAnnotationClause`) | Four: those two plus `tDMNElementReference` and `tBinding` |
| `usingTask` is a single link | `0..unbounded`, only on `tDecision`, typed as an `href`-only `tDMNElementReference` |
| `tInputClause` mirrors `tOutputClause` | `tInputClause` has **no** `name` attribute; `tOutputClause` does |
| `elk.direction: 'UP'` may need a y-flip | It does not. Verified empirically against the installed `elkjs@0.12.0`: sources land at the largest y, sinks at the smallest |
| (unstated) straight edges via `edgeRouting: 'STRAIGHT'` | No such enum value. Valid: `UNDEFINED / POLYLINE / ORTHOGONAL / SPLINES`. An invalid value falls back to the default **silently** |

Two further facts the implementation depends on:

- **`dmnElementRef` is an object reference** (`isReference: true`) — pass the built moddle element,
  as `bpmn-xml.js` already does for `bpmnElement`. But `requiredInput` / `requiredDecision` /
  `requiredKnowledge` / `requiredAuthority` are **not**: they are `dmn:DMNElementReference` wrapper
  objects carrying a string `href: '#id'`. Getting this backwards drops XML silently.
- **DRD shape sizes** are not in the spec; they come from dmn-js, which is what has to open the file:
  Decision 180×80, InputData 125×45 (rounded rect, rx 22), KnowledgeSource 100×63,
  BusinessKnowledgeModel 135×46 (top-left and bottom-right corners clipped, ~15×13.5).

---

## Architecture

Six new modules in `scripts/dmn/`, one relocation into `scripts/shared/`:

```
scripts/shared/
  geometry.js      clipStraight, clipToRect — moved out of bpmn/coordinates.js

scripts/dmn/
  constants.js     the four DRD shape sizes, edge markers, spacing (from CFG.dmn)
  layout.js        Decision-Core → ELK → positioned graph
  coordinates.js   positioned graph → diagram LIST
  di-check.js      geometry pass → diagnostics (DD01–DD04)
  dmn-xml.js       generateDmnXml + validateDmnXml (dmn-moddle)
  pipeline.js      runDmnPipeline + CLI
```

**Why `shared/geometry.js` and not an import from `bpmn/`.** `dmn/` importing from `bpmn/` would
reintroduce exactly the asymmetry the restructure removed, and ArchiMate would inherit it. The
ArchiMate note in the DMN plan sets the criterion for `shared/`: code moves there once it is
*demonstrably* shared, not on suspicion. A second notation now needs this clip — that is the
demonstration.

**Where the boundary actually runs, and why it leaves pure code behind.** The clipping code in
`bpmn/coordinates.js` divides into maths and a dispatcher, not into straight and orthogonal:

```
knows no notation:  clipStraight, clipToRect,
                    clipCircleOrthogonal, clipDiamondOrthogonal, clipRectOrthogonal
notation-bound:     clipOrthogonal  — branches on isEvent(type) / isGateway(type) from bpmn/types.js
```

Only the first two move. The three orthogonal helpers are just as free of notation knowledge and
still stay in `bpmn/` — which looks inconsistent until the rule is named:

> **`shared/` takes what a second notation demonstrably imports — not everything that could be
> phrased format-independently.**

That is the rule Commit C of the restructure applied when it moved the thirteen layout constants
*out* of `shared/utils.js`; several of them are as format-independent as a diamond clip. And a
diamond is, in this repository, a BPMN gateway and nothing else: DMN has none, ArchiMate has none.
Under the broader rule `clipDiamondOrthogonal` would sit in `shared/` unused forever, and the next
notation would inherit a `shared/` that has started collecting again. Changing the rule mid-stream
costs more than a geometry split.

The split's one real price is legibility — clipping code in two files, on a line nobody can guess
from the filenames. Commit 1 pays it off in two comments: a header in `shared/geometry.js` stating
the rule above, and a pointer beside the remaining helpers in `bpmn/coordinates.js` saying why they
did not travel. Rejected alternative: putting the two functions in `shared/utils.js` and skipping the
new file — it saves a file and mixes geometry into the module that already collects whatever fits
nowhere else.

### Module contracts

**`shared/geometry.js`** — pure functions, no config, no notation knowledge. Two functions lifted
verbatim from `bpmn/coordinates.js` (lines 777–795), where they are currently private:

```js
clipStraight(a, b)              // a, b: {x, y, w, h} → [pointOnA, pointOnB]
clipToRect(from, towards, rect) // from, towards: {x, y}; rect: {w, h} → {x, y}
```

`bpmn/coordinates.js` imports them from here; its behaviour must not change, and the byte-identity
check proves it. `clipOrthogonal` and its three helpers stay behind, deliberately — see the boundary
rule above.

**Note the coordinate shape.** These take `{x, y, w, h}`, and so does every `coordMap` entry —
verified by running the pipeline, not by reading about it. `CLAUDE.md`'s Conventions section claims
"Coordinates always as `{ x, y, width, height }` objects", which is true of the emitted DI attributes
but **false of the internal contract**. An implementer who follows the documented convention writes
`width`/`height` and gets `NaN` with no error. Commit 1 corrects that sentence in `CLAUDE.md`.

**`dmn/constants.js`** — mirrors `bpmn/constants.js`: derives its values from `CFG.dmn`, exports no
literals of its own. Shape sizes are **fixed** (the dmn-js numbers above); there is no text-driven
sizing. A long decision name is the renderer's problem, which is how dmn-js treats it.

**`dmn/layout.js`** — `decisionCoreToElk(dc)` and `runDmnElkLayout(graph)` (async, `new ELK()` per
call, as `bpmn/layout.js` does). `elk.direction: 'UP'` so input data sits at the bottom and the
top-level decision at the top; `edgeRouting: 'POLYLINE'`. **ELK's edge routes are discarded** — edge
geometry is computed once, in `coordinates.js`, so the geometry contract holds.

**`dmn/coordinates.js`** — `buildDmnDiagrams(dc, laidOutGraph) → [{ id, name, size, coordMap }]`.
A **list**, with exactly one entry today: `DMNDiagram` is `maxOccurs="unbounded"` and §6.2.4 builds
partial views on it, so multiplicity belongs in the pipeline contract even though the schema has no
`views` directive yet. `size` is `{ w, h }` (the bounding box plus margin) and becomes
`dc:Dimension` on the way out. `coordMap` is `{ coords, edgeCoords }` — plain objects, not Maps,
matching `bpmn/coordinates.js`; `coords[id]` is `{x, y, w, h}` and `edgeCoords[id]` an array of
`{x, y}`. **No `edgeLabels`**: DMN requirements carry no name, so mirroring that member would create
an empty structure that later code would have to keep alive.

Requirement edges are straight two-point segments, clipped at both ends against the source and
target outline (§6.2.2 prescribes line style and arrowheads, not routing; the spec figures and every
tool draw straight). Rectangle and rounded-rect are handled by `shared/geometry.js`; the clipped
corner and the wavy bottom are approximated by their bounding rectangle, which is what dmn-js's own
hit-testing effectively does.

**`dmn/di-check.js`** — `checkDmnDiagramIntegrity(diagrams)`, same role and result shape as
`bpmn/di-check.js`, with its own code namespace so the two can appear side by side in one API
response: **DD01** overlapping shapes, **DD02** shape outside diagram bounds, **DD03** edge endpoint
not on its shape. All ERROR; `ok` means "no ERROR". The result lands in `result.diagnostics`, never
in `validation`.

Three codes, not four. A fourth — "two shapes at an identical position", mirroring BPMN's DI01 —
was drafted and dropped: DI01 exists because two participants at the same origin is a specific,
observed layout failure, and no such case has been observed for a DRD, where DD01 would catch it
anyway. A diagnostic code nobody can name a trigger for is ballast, and adding one later is cheap.

**`dmn/dmn-xml.js`** — `generateDmnXml(dc, diagrams)` (async) and `validateDmnXml(xml)`.
`tDefinitions` is an `xsd:sequence` ending in `dmndi:DMNDI`; `@name` and `@namespace` are both
required. Requirements nest under their **target**. The DMNDI writer loops over the diagram list.
Attribute discipline covers all four id-less types.

**`dmn/pipeline.js`** — `runDmnPipeline(dc, opts)` in the established gate order: schema gate →
rules → layout → coordinates → DI check → serialisation. Its result mirrors `runPipeline`'s minus
`advisories` and `metrics`, which the DMN rule engine does not produce. `--strict` stays what it is
on the BPMN side: **CLI logic, not a `runPipeline` option**, applied after the call across the three
channels `validation.warnings`, `diagnostics.issues`, `validation.xmlWarnings`.

---

## Commit cut

Six commits, each green on its own.

| # | Content | Hardest proof |
|---|---|---|
| 1 | `shared/geometry.js` + the two boundary comments; `bpmn/coordinates.js` imports from it; the `{x,y,w,h}` correction in `CLAUDE.md` | Byte-identical output for the six canonical fixtures — a pure move cannot move a pixel |
| 2 | `dmn/constants.js`, the `CFG.dmn` shape block, `dmn/layout.js` | Layer order: input data below, top-level decision above, on a **branching** graph |
| 3 | `dmn/coordinates.js`, `dmn/di-check.js` | Clip maths as unit tests with hand-computed expected values |
| 4 | `dmn-moddle@12.0.1` as a runtime dependency | dep-audit gate and `docs-gate` green; `THIRD-PARTY-NOTICES.md` updated |
| 5 | `dmn/dmn-xml.js` | XSD validation via `xmllint`; round trip through dmn-moddle compared by **field set**; two-diagram test |
| 6 | `dmn/pipeline.js` + CLI, golden file, documentation | A `.dmn` exists, `xmlWarnings` is empty, XSD-valid |

The dependency gets its own commit: a supply-chain change carries its own policy and its own gate,
and must not be buried in a 400-line serialiser diff.

---

## Verification and the autonomy boundary

This design exists to be executed by an agent working without the conversation that produced it.
That makes the boundary between what is *provable* and what needs a human explicit:

**Machine-provable, and therefore the plan's gates:**

1. `xmllint --noout --schema references/omg-spec/normative/dmn/DMN13.xsd <out>.dmn` — the normative
   conformance proof, needing no new dependency. Wired as a Jest test that **skips when `xmllint` is
   absent** rather than failing: the suite must not hang on a system tool that is not in
   `package.json`. Present locally (libxml 2.9.13) and on GitHub's ubuntu runners.
2. Round trip through dmn-moddle, compared by **field set** rather than field by field — moddle
   reports attributes it does not *know*, never fields that never arrived, which is why this class of
   defect was invisible twice (#36, #42).
3. `xmlWarnings` empty; attribute discipline checked against all four id-less types.
4. The two-diagram test: a `DMNDiagram*` loop that only ever runs with one entry is unverified
   generality.
5. Degenerate inputs: zero nodes, a single node, an isolated node.
6. `npm test` and `npm run docs-gate` green throughout; goldens as `.expected.dmn`, never blindly
   regenerated.

**Not machine-provable, and therefore handed back:** whether the file opens in dmn-js and Camunda
Modeler. The executing agent produces the file, states its path, and stops. It does not declare the
milestone reached on its own judgement.

**Measured, not assumed:** the `hitPolicy` / `preferredOrientation` normalisation. The plan pins
dmn-moddle's actual behaviour in a test written *after* observing it, and records the observation in
the fixture's README. The XSD gives no basis for predicting it.

---

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Where the straight clip lives | `shared/geometry.js`, two functions only | A second notation needs those two. The three orthogonal helpers stay in `bpmn/` although they are equally notation-free: `shared/` takes what a second notation demonstrably imports, which is the rule Commit C of the restructure applied |
| The bridge as a mechanism | **Not now** | `usingTask` is the second cross-model reference and the ArchiMate note calls for designing the mechanism before it exists — but doing it here would touch working BPMN code in both importers and the schema, and would blur this plan's goal. It gets its own small plan |
| `usingTask` / `usingProcess` shape | Accept string **or** array | Additive, breaks nothing, and covers the XSD's `0..unbounded` |
| DI code namespace | `DD01`–`DD04` | `DI01`–`DI06` are taken; a shared numbering would hide which notation a code belongs to |
| XSD validation | Test, skipping when absent | Strongest available proof without making the suite depend on a system tool |
| The Stage 3–7 plan document | Refreshed in commit 6 | It stays the map for Stages 5–7; leaving it with dead paths and three refuted claims would mislead whoever picks it up |
| `package.json` `exports` | **Untouched** | Public entry points are Stage 7. The package-integrity check is scoped to exports-reachable files, so `dmn/` correctly stays out of it for now |

---

## Out of scope

- Decision table rendering and DRD SVG (Stage 6, G6).
- The importer (Stage 5) — the round-trip check here parses through dmn-moddle directly, which is
  not the same thing as a Decision-Core importer.
- MCP tools, HTTP endpoints, `exports`, `SKILL.md` (Stage 7; GATE 2 still open).
- FEEL parsing (G5), completeness and overlap analysis (G7), DMN 1.4+ (G1), `camunda:` extensions.
- The cross-model reference mechanism — deliberately deferred, see Decisions.

## Risks

1. **A second copy of shared geometry.** The most expensive mistake available here, and the reason
   commit 1 exists at all and comes first.
2. **Silent library behaviour.** `edgeRouting: 'STRAIGHT'` falling back without error is the shape of
   this risk: a wrong value that looks accepted. Mitigation is that every library assumption in this
   design was verified by running the library, not by reading about it.
3. **The milestone being declared without being reached.** Mitigated by the autonomy boundary above:
   the XSD gate is the machine's verdict, dmn-js and Camunda Modeler are the human's.

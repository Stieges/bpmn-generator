# DMN support — feasibility analysis

**Date:** 2026-07-30 · **Status:** analysis only, no decision taken · **Question:** can this project
generate DMN the way it generates BPMN, and what would it cost?

**Short answer.** Technically yes, and the fit is better than expected — the diagram-interchange
model, the layout engine, the rule-engine shape and the moddle round-trip all transfer, and the two
parts that looked most expensive (decision-table geometry, FEEL parsing) turn out not to be required
at all. The cost is nonetheless a second pipeline: an estimated 1 800–2 600 lines of production code
plus tests, roughly a third of what exists today. This document lays out the evidence and the eight
decisions that have to be made before anyone writes a line of it. It does **not** recommend building
it yet — see §9.

Every claim below is marked **Verified** (traced to a normative schema, a registry response, or a
command run against this repository) or **Estimate** (reasoned, not measured). Nothing is asserted
from memory.

---

## 1. Where we stand today

**Verified.** `businessRuleTask` is a fully supported node type. It appears in
`references/input-schema.json:236`, `scripts/config.json:15` (100×80), `scripts/icons.js:191`
(table icon), `scripts/types.js:49`, both importers (`scripts/import.js:270`,
`scripts/moddle-import.js:192`), the rule engine (`scripts/rules.js:455`) and the optimization
layer (`scripts/optimize.js:24`).

**Verified.** Everything else is absent. A case-insensitive search across `*.js`, `*.json`, `*.md`
and `*.xsd` returns zero hits for `decisionRef`, zero for `dmn` as a standalone word in any source
or config file, no DMN namespace, no DMN dependency in `scripts/package.json`, and no entry in
`ROADMAP.md`.

The gap is precise: a Business Rule Task is a box with a table icon meaning *a rule set decides
here*. **Which** rule set is nowhere recorded — not in the Logic-Core, not in the emitted XML, not
on import. The decision logic itself has never had a home in this project.

---

## 2. Ground truth from the specifications

Retrieved live from omg.org and the npm registry on 2026-07-30. The schemas are now kept locally
under `references/omg-spec/normative/dmn/` (gitignored, same treatment as the BPMN schemas); the
download URLs are recorded in `references/omg-compliance.md`.

### 2.1 Version landscape — the same split as BPMN

**Verified.** The most recent *formal* DMN is **1.5** (August 2024). 1.6 and 1.7 exist as betas
(September 2024). The version the tooling world implements is **1.3** (`formal/21-01-01`,
February 2021): `dmn-moddle` describes itself verbatim as *"A moddle wrapper for DMN 1.3"*.

This is exactly the situation that led this project to target BPMN 2.0.2 rather than something
newer — the standard is ahead of its readers. See fork **G1**.

### 2.2 Dependency cost — one package, no new families

**Verified.** `dmn-moddle@12.0.1` (published 2026-01-20, MIT) declares exactly three dependencies:

| dmn-moddle@12.0.1 | bpmn-moddle@10.0.0 (already a dependency) |
|---|---|
| `min-dash ^5.0.0` | `min-dash ^5.0.0` |
| `moddle ^8.0.0` | `moddle ^8.0.0` |
| `moddle-xml ^12.0.0` | `moddle-xml ^12.0.0` |

Character-identical. All three are already installed under `scripts/node_modules/`. A fresh install
of `dmn-moddle` into an empty project pulls **5 packages total**, four of which this project already
carries.

This matters against the standing rule *"no new runtime dependencies without prior discussion"* and
against the supply-chain policy: the marginal exposure is one package from the same maintainer
organisation (bpmn-io) that already supplies `bpmn-moddle`, not a new subtree.

**Verified.** The import shape is symmetric too: `import { DmnModdle } from 'dmn-moddle'` mirrors the
existing `import { BpmnModdle } from 'bpmn-moddle'` in `scripts/moddle-import.js:9`. Both are
native ESM with a named export.

### 2.3 The geometry contract transfers unchanged

**Verified** (`DMNDI13.xsd`). DMNDI imports the same OMG building blocks BPMNDI does:

```
DMNShape extends di:Shape   →  dc:Bounds {x, y, width, height}
DMNEdge  extends di:Edge    →  di:waypoint*
DMNLabel extends di:Shape
```

The differences are names, not structure: `dmnElementRef` instead of `bpmnElement`, plus optional
`sourceElement`/`targetElement` on the edge. `DMNShape` additionally carries `isCollapsed` and
`isListedInputData`.

Consequence: the `coordMap` contract described in `CLAUDE.md` — *every drawable element has its
geometry in `coordMap`, renderers only translate* — applies verbatim. So does the anti-pattern it
guards against.

**Verified** (probe, §2.7): dmn-moddle resolves `dmnElementRef` to the referenced element object,
not to a string. A DI writer must therefore hand it built elements — the same shape as
`buildDI(lc, coordMap, processes, …)` in `scripts/bpmn-xml.js:516`, which receives built moddle
elements rather than raw Logic-Core objects.

### 2.4 The decision table has no interchange geometry at all

**Verified** (`DMNDI13.xsd`). `DMNShape`/`DMNEdge` reference DRG elements. DMNDI covers the
**Decision Requirements Diagram only**. The standard defines no interchange format for the layout
of a decision table — every tool renders it from the logical structure.

This removes the compliance obligation from what looked like the most expensive component. A table
renderer would be a product decision, not a conformance requirement. See fork **G6**.

### 2.5 FEEL does not have to be parsed

**Verified** (`DMN13.xsd`). Every expression carrier is plain text:

```
tUnaryTests        extends tExpression → <text> (xsd:string), optional @expressionLanguage
tLiteralExpression extends tExpression → <text> | <importedValues>, optional @expressionLanguage
```

Valid DMN is produced by passing strings through. FEEL parsing would be needed only to *validate*
expressions — a separable, deferrable capability. See fork **G5**.

### 2.6 The BPMN↔DMN bridge — half of it is normative

This corrects the widely repeated claim that the link is always vendor-specific.

**Verified** (`DMN13.xsd`, `tDecision`). A Decision carries, among others:

```xml
<xsd:element name="usingProcess" type="tDMNElementReference" minOccurs="0" maxOccurs="unbounded"/>
<xsd:element name="usingTask"    type="tDMNElementReference" minOccurs="0" maxOccurs="unbounded"/>
```

**DMN → BPMN is standardised.** `tDMNElementReference` is a required `href` (`xsd:anyURI`), and
`tImport` (`@namespace` required, `@importType` required, `@locationURI` optional) is the mechanism
for pointing across file boundaries — so a DMN file can legitimately name the BPMN task it serves.

**Verified.** Only the reverse direction — BPMN → DMN, `camunda:decisionRef` — is vendor-specific,
and adopting it would contradict the standing "no Camunda extensions" position in `CLAUDE.md`.

The clean link therefore points *from* the decision model *to* the task, not the other way round.
See fork **G4**.

### 2.7 Empirical probe — dmn-moddle round-trips a hand-written DMN

**Verified.** A minimal DMN 1.3 file (one `inputData`, one `knowledgeSource`, one `decision` with a
three-rule decision table, a `textAnnotation` + `association`, and a full DMNDI block) was written by
hand, read with `dmn-moddle@12.0.1`, inspected, and written back. Run in an isolated scratchpad
project; nothing was installed into `scripts/`.

Everything survived the read: `question`, `allowedAnswers`, `variable`/`typeRef`, all three
requirement kinds, `usingTask`, the table's `hitPolicy`/`preferredOrientation`/`outputLabel`, all
input/output clauses, all three rules with their input, output and annotation entries, both
artifacts, and the complete DMNDI geometry (bounds and waypoints).

Two behaviours are worth carrying forward:

**(a) The illegal-attribute mechanism reproduces here, exactly as in PR #36.** The probe file put
`id` on `<annotationEntry>`. Per the schema that is illegal — `tRuleAnnotation` is a bare
`complexType` with only a `<text>` child; unlike almost everything else in DMN it does **not** extend
`tDMNElement`, so it has no `id`. dmn-moddle emitted `unknown attribute <id>` three times, parked the
values in `$attrs`, **wrote them back out**, and re-reading its own output produced the same three
warnings again. This is byte-for-byte the mechanism behind the artifact-label defect fixed in #36:
an illegal attribute is not rejected, it is carried, and it keeps generating warnings in every
downstream consumer. Any DMN writer needs the same discipline `scripts/types.js`'s `isBpmnArtifact`
established — check the schema, not the intuition, before emitting an attribute.

**(b) Schema defaults are normalised asymmetrically on write.** The input carried
`hitPolicy="UNIQUE"` and `preferredOrientation="Rule-as-Row"`. Both are schema defaults. On write,
`hitPolicy` was **dropped** and `preferredOrientation` was **kept**. Semantically lossless — the XSD
default reinstates `UNIQUE` — but a byte-level golden-file comparison would see it. Any golden-file
discipline on the DMN side has to be built knowing this, or the first golden will be written against
output that does not match its own input.

### 2.8 Structural core to be modelled

**Verified** (`DMN13.xsd`).

The DRG is a DAG. Nodes substitute into `drgElement`: `decision`, `inputData`, `knowledgeSource`,
and `invocable` (`businessKnowledgeModel`, `decisionService`). Edges are three requirement kinds,
each a child of the *requiring* element:

| Requirement | Points at |
|---|---|
| `informationRequirement` | `requiredDecision` \| `requiredInput` |
| `knowledgeRequirement` | `requiredKnowledge` |
| `authorityRequirement` | `requiredDecision` \| `requiredInput` \| `requiredAuthority` |

The decision table is `input*, output⁺, annotation*, rule*` with `@hitPolicy` (7 values: UNIQUE,
FIRST, PRIORITY, ANY, COLLECT, RULE ORDER, OUTPUT ORDER), `@aggregation`, `@preferredOrientation`,
`@outputLabel`. A rule is `inputEntry*, outputEntry⁺, annotationEntry*`. Note `output` has no
`minOccurs`, so **at least one output clause is mandatory**.

**Verified.** `tDefinitions` is an `xsd:sequence` ending in `dmndi:DMNDI` (max 1), and requires
`@namespace`. That is the same positional-sequence discipline as `tProcess` (`laneSet*,
flowElement*, artifact*`), which this project has already been caught by once.

---

## 3. What transfers from the BPMN pipeline

Named concretely, because "we can reuse a lot" is not an estimate.

| Asset | File | Transfers because |
|---|---|---|
| ELK integration | `scripts/layout.js` | A DRG is a DAG; `elk.layered` applies directly. Only the direction differs (§4). |
| Geometry contract | `scripts/coordinates.js`, `CLAUDE.md` | DMNDI is DI/DC, same as BPMNDI (§2.3). The `coordMap` discipline and the "renderers never compute geometry" rule apply unchanged. |
| Rule-engine shape | `scripts/rules.js` | `{ id, layer, defaultSeverity, description, ref, check(proc) }` plus profile overrides in `rules/*.json` is format-agnostic. The rules differ; the frame does not. |
| Schema gate | `scripts/schema-gate.js` (32 lines) | ajv draft-2020-12 strict gate; a second schema plugs in with almost no new code. |
| Round-trip guard | the `subprocess-child-fidelity` field-set pattern | §2.7(a) proves the same silent-omission class exists in DMN. This is the guard that catches it. |
| Golden-file procedure | `tests/fixtures/*.expected.*` | Applies, with the §2.7(b) caveat about normalised defaults. |
| Docs gate | `.github/scripts/docs-gate.mjs` | Numeric-claim and package-integrity checks extend to new modules for free. |
| Config discipline | `scripts/config.json`, `scripts/utils.js` | Shapes/colors/spacing for DRG elements belong there, not in code. |
| Tool surface | `scripts/mcp-bpmn-server.js`, `scripts/http-server.js` | New tools/endpoints alongside the existing four MCP tools. |
| moddle idiom | `scripts/moddle-import.js` | Same library family, same API, same named-export import shape (§2.2). |

---

## 4. What does not transfer

- **Layout direction.** BPMN runs left-to-right. A DRD is conventionally drawn bottom-up: input data
  at the bottom, the top-level decision at the top. Same engine, different `elk.direction`, and the
  edge-clipping and label-placement code in `coordinates.js` is written around horizontal flow.
- **Container semantics.** There are no pools, no lanes, no boundary events, no message flows. A
  large share of `coordinates.js` (1 145 lines — lane bands, participant stacking, pool width
  balancing) has no counterpart. This is a *reduction*, and the single biggest reason the DMN layout
  module should be far smaller than the BPMN one.
- **Validation semantics.** A decision table is not "sound". Its questions are completeness (does
  every input combination hit a rule?), overlap (does `UNIQUE` actually hold?), masked rules, and
  hit-policy/aggregation compatibility. None of that resembles S01–S13 or the WF-Net layer. The
  DRG itself does need acyclicity and orphan checks, which are close to existing topology work.
- **Decision-table rendering.** No prior art in this codebase. `scripts/svg.js` draws shapes and
  paths; a table needs measured text in a grid with wrapping. Related to `wrapText` in `utils.js`,
  but not a reuse.
- **FEEL.** Not needed to generate (§2.5); a whole subsystem if ever validated.

---

## 5. Component breakdown and effort anchors

Anchors are **Verified** (`wc -l` on 2026-07-30). Estimates are **Estimates** — reasoned from the
anchor and from what §4 says is absent, not measured.

| Component | BPMN anchor | DMN estimate | Reasoning |
|---|---|---|---|
| Input schema | `references/input-schema.json` — 261 | 150–200 | Fewer element kinds than BPMN's type zoo, but decision tables add nesting. |
| Rule engine | `rules.js` — 874 for 33 rules (≈26 lines/rule) | 250–350 | An estimated 8–12 rules (§4). |
| Layout | `layout.js` 318 + `coordinates.js` 1 145 | 250–350 | No pools/lanes/boundary events — most of `coordinates.js` has no counterpart. |
| XML writer | `bpmn-xml.js` — 942 | 350–450 | No collaboration/participants/lanes; adds table serialisation + DMNDI. |
| Importer | `moddle-import.js` — 439 | 250–350 | Same library, smaller element set, but the same recursive-fidelity discipline. |
| SVG renderer | `svg.js` 564 + `icons.js` 217 | 250–350 | Four DRG shapes, three edge styles. Excludes table rendering. |
| Decision-table rendering | — | +200–300 | Optional; not a conformance requirement (§2.4). |
| Tests + fixtures + goldens | `pipeline.test.js` — 3 657 | 800–1 200 | Must include the field-set round-trip guard from day one. |

**Estimate.** Roughly **1 800–2 600 lines of production code** plus **800–1 200 of tests**, excluding
table rendering and FEEL — about a third of the existing pipeline (14 core modules, 6 311 lines).
That is a release-sized effort, not an afternoon, and it should be planned as several merges.

---

## 6. The forks

These must be answered before implementation. Each carries a recommendation; none is decided.

### G1 — DMN 1.3 or 1.5?
1.3 is what `dmn-moddle`, dmn-js and Camunda read. 1.5 is the current formal standard with
essentially no tooling. **Recommendation: 1.3**, for the same reason this project targets BPMN 2.0.2
— output nobody can open is not output. Record the choice explicitly, as `omg-compliance.md` does
for BPMN.

### G2 — Its own pipeline, or an extension of the existing one?
**Recommendation: its own.** A `Decision-Core` document beside the Logic-Core keeps each format
answering one question. Widening the Logic-Core to carry decision logic would put two unrelated
schemas behind one gate and make `runPipeline`'s contract ambiguous. The two connect through the
bridge (G4), not through a merged schema.

### G3 — `dmn-moddle`, or hand-written XML?
**Recommendation: `dmn-moddle`.** Symmetry with `bpmn-xml.js` (which builds moddle elements) and
`moddle-import.js`, a measured cost of one package with no new subtree (§2.2), and §2.7 shows it
round-trips a hand-written file correctly. This still requires a discussion per the dependency rule
— the point here is that the evidence for it is now concrete.

### G4 — Which bridge?
Options: normative `usingTask`/`usingProcess` with `tImport` (DMN→BPMN, §2.6) · vendor
`camunda:decisionRef` (BPMN→DMN, contradicts the no-Camunda-extensions position) · a neutral
`extensionElements` payload on the Business Rule Task · both directions.
**Recommendation: the normative direction first**, because it costs no policy exception. Revisit
BPMN→DMN only if a concrete consumer needs it — and then as `extensionElements`, not `camunda:`.

### G5 — FEEL: pass through or validate?
**Recommendation: pass through.** §2.5 shows it is sufficient for valid DMN. Validation is a
separate capability with its own risk; deferring it costs nothing now and keeps the door open.

### G6 — Render the table, and how?
No conformance obligation (§2.4). Options: SVG grid, HTML, or nothing.
**Recommendation: nothing in a first cut.** A DMN file that opens correctly in dmn-js already shows
the table. Adding a renderer means a second source of truth for something a consumer already draws
— the same duplication the geometry contract exists to prevent.

### G7 — Which validation classes?
Candidates: DRG acyclicity, orphaned input data, decisions with no logic, missing output clause,
`UNIQUE` violated by overlapping rules, incomplete coverage, hit-policy/aggregation mismatch,
masked rules.
**Open.** Completeness and overlap checking is real work (interval algebra over input domains) and
should probably be its own later stage rather than part of a first cut.

### G8 — Where does the LLM sit?
Does it extract Decision-Core from natural language the way it extracts Logic-Core? Does `SKILL.md`
grow a DMN half, and what does that do to skill size and to extraction quality for the BPMN half?
**Open, and the most under-examined of the eight.** This is the fork that decides whether DMN
support is a product capability or a library feature.

---

## 7. Risks

1. **Silent omission on the way down.** Proven present in DMN (§2.7a): moddle reports attributes it
   does not *know*, never fields that never *arrived*. This project has been caught by that class
   twice (#36, #42). The mitigation is known and must be built first, not last: a field-set
   round-trip guard over a fixture that carries every field class, at every nesting level.
2. **Golden files written against normalised output** (§2.7b). Establish the normalisation behaviour
   before the first golden is committed.
3. **Scope creep through the table.** G6 and G7 are each capable of exceeding the rest of the work.
   They must stay explicitly out of a first cut or the release will not land.
4. **Two formats, one skill.** G8. A `SKILL.md` that tries to teach both extractions may degrade the
   BPMN extraction that works today. This risk is not technical and is the hardest to measure.
5. **Standard drift.** Targeting 1.3 (G1) means knowingly trailing the formal standard by two
   versions. Acceptable — and identical to the existing BPMN position — but it should be a recorded
   decision, not an accident.

---

## 8. Ripple effects on what exists

**Verified** for each mechanism named:

- **Docs gate, script count.** `.github/scripts/docs-gate.mjs:206` matches `"<N> top-level scripts"`
  in `CLAUDE.md` against a non-recursive count of `scripts/*.js`. Currently 30. Every new top-level
  `dmn-*.js` moves it, and the gate fails until `CLAUDE.md` is updated. Working as designed.
- **Docs gate, numeric claims.** Rule and layer counts (33 rules, 5 layers) are derived from
  `rules.js` alone. A separate DMN rule module would not be counted, so any "N rules" claim covering
  both would silently drift — the gate would need extending.
- **Package integrity.** The gate checks every `join(__dirname, …)` in packed files against
  `npm pack` output, scoped to `scripts/package.json`'s `exports`. New modules must be added to
  `exports`/`files`, and any new resource file to `prepack-copy-references.mjs`.
- **Tool surface.** `scripts/mcp-bpmn-server.js` exposes four tools (`generate_bpmn`,
  `validate_bpmn`, `import_bpmn`, `orchestrate_bpmn`). `scripts/http-server.js` serves seven
  versioned endpoints (`/api/v1/` + `generate`, `validate`, `import`, `orchestrate`, `chat`,
  `config`, `telemetry`), plus `/health`, unversioned aliases and static routes — note that
  `CLAUDE.md`'s architecture table names only three of them, so it is a summary rather than an
  inventory. DMN equivalents mean new tools and endpoints, plus `references/api-schema.json`, which
  the docs gate validates a real response against.
- **Documentation.** `SKILL.md`, `README.md`, `CLAUDE.md` (architecture table, key files, Known
  Limitations), `references/omg-compliance.md` (a DMN mapping section alongside the BPMN one).

---

## 9. Recommendation

**Do not start building yet — but the ground is better than it looked, and the cheap half is worth
taking on its own.**

Three things changed during this analysis. The bridge is half-normative rather than
Camunda-only (§2.6). The decision table carries no interchange geometry, so the expensive-looking
renderer is optional (§2.4). And expressions are plain text, so FEEL is not on the critical path
(§2.5). Together these remove most of what would have made a DMN pipeline disproportionate.

What has *not* changed is the size: an estimated 1 800–2 600 lines of production code plus tests
(§5), and one genuinely open product question (G8) about whether the extraction skill can carry two
formats without degrading the one that works.

A sensible sequencing, if this is pursued:

1. **The bridge alone, first** (the "just the bridge" option from the original framing). Give
   `businessRuleTask` a decision reference in the Logic-Core, serialise it via `extensionElements`,
   read it back in both importers, extend the schema. Self-contained, useful immediately — a model
   that records *which* rule set decides is more use than one that does not — and it commits nobody
   to a DMN pipeline. This touches exactly the four places `CLAUDE.md`'s "Adding a per-node field"
   section names, with the field-set round-trip guard as the check.
2. **Decide G8 before anything else.** If the answer is "the LLM should not carry both", the whole
   generation pipeline is off the table and only an *import/validate* capability remains — a
   materially smaller and differently-shaped project.
3. **Only then** a first cut: Decision-Core schema, DRG layout, DMN 1.3 XML with DMNDI, importer,
   field-set round-trip guard. Explicitly without table rendering (G6), without FEEL validation
   (G5), and without completeness/overlap checking (G7).

The honest alternative is **not building it**: the project's stated purpose is BPMN, the roadmap's
actual v3.6 (npm publish, launch) is still undone, and DMN would compete with finishing that. This
document exists so that choice is made with the numbers in view rather than by default.

---

## Sources

Schemas retrieved 2026-07-30, kept locally under `references/omg-spec/normative/dmn/` (gitignored);
URLs recorded in `references/omg-compliance.md`.

- DMN 1.3 specification (`formal/21-01-01`, February 2021) — <https://www.omg.org/spec/DMN/1.3/About-DMN>
- `DMN13.xsd` (`dtc/19-12-01`) — <https://www.omg.org/spec/DMN/20191111/DMN13.xsd>
- `DMNDI13.xsd` (`dtc/19-10-06`) — <https://www.omg.org/spec/DMN/20191111/DMNDI13.xsd>
- DMN `DI.xsd` / `DC.xsd` (`dtc/18-05-06`, `dtc/18-05-07`) — <https://www.omg.org/spec/DMN/20180521/DI.xsd>, <https://www.omg.org/spec/DMN/20180521/DC.xsd>
- DMN version index (1.5 formal, 1.6/1.7 beta) — <https://www.omg.org/spec/DMN>
- `dmn-moddle@12.0.1` — <https://registry.npmjs.org/dmn-moddle>
- Camunda Business Rule Task / `camunda:decisionRef` — <https://docs.camunda.io/docs/components/modeler/bpmn/business-rule-tasks/>

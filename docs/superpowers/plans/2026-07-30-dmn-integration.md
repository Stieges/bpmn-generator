# DMN integration — implementation plan

> **Status (2026-07-31): Stages 0–4 done.** GATE 1 is answered (approved). The design for Stages
> 3–4 was re-verified against the normative XSD, the actual codebase and the actual libraries
> before being executed — see
> [2026-07-31-dmn-drd-and-serialisation-design.md](../specs/2026-07-31-dmn-drd-and-serialisation-design.md),
> whose "What the research corrected" table lists nine claims from earlier planning that did not
> survive checking, three of which are corrected inline below. A real `.dmn` file exists as of
> `scripts/dmn/pipeline.js`, XSD-validated. Stages 5–7 (importer, SVG, tool surface) remain; GATE 2
> is still deferred.

> **For agentic workers:** steps use checkbox (`- [ ]`) syntax for tracking. Work top to bottom;
> the two **GATES** are blocking and need a human answer, not a judgement call.

**Goal:** the generator produces valid DMN 1.3 the way it produces BPMN 2.0.2 — a decision model in,
a `.dmn` file that opens in dmn-js and Camunda Modeler out, with the same guarantees: schema-gated
input, a rule engine, deterministic layout, diagram interchange, and a round-trip that provably loses
nothing.

**Basis:** [2026-07-30-dmn-feasibility-design.md](../specs/2026-07-30-dmn-feasibility-design.md).
Every "§" reference below points into it. The forks G1–G8 are resolved here; two of them (G3, G8)
need a decision that is not mine to make.

**Tech stack:** unchanged — Node ≥20, ES Modules, Jest (`--experimental-vm-modules`), ELK. One new
runtime dependency proposed (`dmn-moddle`), see GATE 1.

**Branch:** all work stays on one branch until DMN actually works. One PR at the end, not per stage.

---

## Resolved forks

| Fork | Decision | Reason |
|---|---|---|
| **G1** version | **DMN 1.3** | What dmn-moddle, dmn-js and Camunda read. Same reasoning that put us on BPMN 2.0.2 (§2.1). Output nobody can open is not output. |
| **G2** shape | **Own pipeline, own format** — `Decision-Core` beside Logic-Core | Each format answers one question. A merged schema would make `runPipeline`'s contract ambiguous. They meet at the bridge (G4), not in the schema. |
| **G3** writer | **`dmn-moddle`** | Symmetric to `bpmn-xml.js`/`moddle-import.js`, one package, no new subtree (§2.2). **Needs approval — GATE 1.** |
| **G4** bridge | **Both directions, BPMN side first** | Stage 1 gives `businessRuleTask` a `decisionRef` via neutral `extensionElements`; Stage 4 emits the normative `usingTask` from the DMN side (§2.6). No Camunda namespace either way. |
| **G5** FEEL | **Pass through** | Sufficient for valid DMN (§2.5). Validation is a later, separable capability. |
| **G6** table rendering | **DRD only in v1**, table deferred | No conformance obligation (§2.4). Revisit after Stage 6. |
| **G7** rule classes | **Structural first**, completeness/overlap deferred | Acyclicity, orphans, missing logic, missing output clause are cheap and catch real errors. Interval algebra over input domains is its own project. |
| **G8** LLM | **Open — GATE 2** | The one genuinely undecided question. Blocks Stage 7 only; Stages 1–6 are library work and proceed regardless. |

### Module placement

New modules live in **`scripts/dmn/`**, not at the top level. Two reasons: it matches the existing
subsystem convention (`scripts/agents/`, `scripts/robustness/`), and the docs gate's
`"<N> top-level scripts"` claim counts `scripts/*.js` non-recursively — keeping DMN out of that
count leaves the number meaning "the BPMN core pipeline", which is what it is for.

### Decision-Core shape

Mirrors Logic-Core deliberately: a flat node list plus a flat edge list, even though the DMN XSD
nests requirements inside the requiring element. The writer nests on the way out, the importer
flattens on the way in — exactly as `bpmn-xml.js` already does for boundary events.

```jsonc
{
  "id": "Decisions_1",
  "name": "Discount decision",
  "namespace": "http://example.org/dmn/discount",   // required by tDefinitions
  "nodes": [
    { "id": "in_order", "type": "inputData", "name": "Order value", "typeRef": "number" },
    { "id": "ks_policy", "type": "knowledgeSource", "name": "Discount policy" },
    { "id": "d_level", "type": "decision", "name": "Discount level",
      "question": "Which discount level applies?",
      "usingTask": "task_checkDiscount",             // normative DMN -> BPMN link (§2.6)
      "decisionTable": {
        "hitPolicy": "UNIQUE",
        "inputs":  [{ "label": "Order value", "expression": "orderValue", "typeRef": "number" }],
        "outputs": [{ "name": "level", "typeRef": "string" }],
        "rules": [
          { "when": ["< 100"],      "then": ["\"none\""],   "annotation": "Below threshold" },
          { "when": ["[100..500)"], "then": ["\"bronze\""], "annotation": "Standard tier" }
        ]
      }
    }
  ],
  "requirements": [
    { "id": "ir_1", "type": "information", "source": "in_order",  "target": "d_level" },
    { "id": "ar_1", "type": "authority",   "source": "ks_policy", "target": "d_level" }
  ]
}
```

`source`/`target` read in **flow direction** (the required element is the source), so the DAG can go
straight to ELK without inversion — even though the XML nests the requirement under the target.

---

## GATES

> **✅ GATE 1 — new runtime dependency: APPROVED (2026-07-30).** `dmn-moddle@12.0.1` (MIT, bpmn-io)
> is taken as a runtime dependency. Its three dependencies are character-identical to
> `bpmn-moddle@10.0.0`'s and already installed, so the marginal cost is one package and no new
> subtree (§2.2). The dependency-audit gate and supply-chain policy still apply on the way in —
> `scripts/package.json` and `THIRD-PARTY-NOTICES.md` both need updating in Stage 4.
>
> Rejected alternative, recorded: hand-written XML via template strings, the way `bpmn-xml.js` began
> — an estimated +150–200 lines, and it gives up the free round-trip check that catches the §2.7(a)
> class.

> **⏸ GATE 2 — where the LLM sits (G8): DEFERRED (2026-07-30).** Deliberately unanswered until
> Stages 1–6 exist, because all three options need the same library work and the question is easier
> to answer against something real than against a plan.
> Options when it comes up: (a) `SKILL.md` gains a DMN half; (b) a separate skill sharing only
> `references/`; (c) no LLM extraction at all — DMN stays a library/CLI capability fed by
> hand-written or imported Decision-Core.
> **Blocks Stage 7 only.** Do not start Stage 7's skill work without answering it.

---

## Stage 0 — Preparation

- [ ] Rename the branch: `docs/dmn-feasibility` → `feat/dmn`. It carries code from Stage 1 on.
- [ ] Confirm the local specs are in place: `references/omg-spec/normative/dmn/` holds `DMN13.xsd`,
      `DMNDI13.xsd`, `DI.xsd`, `DC.xsd`, `DMN-1.3-spec.pdf`. Gitignored; URLs in
      `references/omg-compliance.md`.
- [ ] Answer GATE 1 and GATE 2.

---

## Stage 1 — The bridge, BPMN side (no DMN yet)

Self-contained and useful on its own: a model that records **which** rule set decides is worth more
than one that does not. Commits nobody to the rest of the plan.

- [ ] `references/input-schema.json` — optional `decisionRef` (string) on Node.
- [x] `scripts/bpmn/bpmn-xml.js` — `buildFlowNode` emits `extensionElements` carrying the reference for
      `businessRuleTask`. Neutral namespace, **not** `camunda:`. Follow the §2.7(a) discipline:
      check `Semantic.xsd` before emitting any attribute.
- [x] `scripts/bpmn/moddle-import.js` `nodeFromElement` **and** `scripts/bpmn/import.js` `nodeFromChild` —
      read it back. Both functions are recursive and shared between top level and subprocess
      children; put the field in the function, never in a caller.
- [x] `tests/fixtures/subprocess-child-fidelity.json` — add `decisionRef` to a child node. The
      field-set round-trip test then proves all four places learned about it.
- [x] Rule: a `decisionRef` on anything that is not a `businessRuleTask` is a warning.

**Verify:** `npm test`; round-trip preserves the field; `xmlWarnings` stays empty.

---

## Stage 2 — Decision-Core: schema and rules

- [ ] `references/decision-core-schema.json` — ajv draft-2020-12, strict, shape as above.
- [x] `scripts/dmn/schema-gate.js` — mirrors `scripts/bpmn/schema-gate.js`:
      it delegates path resolution to `resource-paths.js`. **Do not copy a path fallback into it** —
      add `decision-core-schema.json` to `resource-paths.js` (a third `sourcePath`/`packagedPath`
      pair plus a wrapper), to `prepack-copy-references.mjs`'s `FILES`, and it is removed again by
      the existing `postpack` step. Spell the filename out literally in each `join(__dirname, …)`,
      or the docs gate's package-integrity check resolves a directory and reports a false violation.
- [x] `scripts/dmn/rules.js` — same rule object shape as `scripts/bpmn/rules.js`
      (`{ id, layer, defaultSeverity, description, ref, check }`). First set, all structural:

      | ID | Severity | Checks |
      |---|---|---|
      | D01 | ERROR | Every requirement's `source`/`target` resolves to a declared node |
      | D02 | ERROR | The requirement graph is acyclic |
      | D03 | ERROR | `informationRequirement` targets a decision; `knowledgeRequirement` targets an invocable |
      | D04 | ERROR | Decision table has at least one output clause (XSD: `output` has no `minOccurs`) |
      | D05 | ERROR | Every rule's `when`/`then` arity matches the input/output clause count |
      | D06 | WARNING | Decision without decision logic |
      | D07 | WARNING | Input data reached by no requirement (orphan) |
      | D08 | WARNING | `aggregation` set with a hit policy other than `COLLECT` |

- [x] `rules/dmn-default-profile.json`. **Checked, 2026-07-30:** the profile machinery —
      `loadRuleProfile`, `isRuleEnabled`, `getEffectiveSeverity` — was already format-agnostic and
      was extracted out of `scripts/rules.js` into its own `scripts/rule-profile.js` in commit
      `2f255c6` (the Decision-Core schema and rule-engine commit), re-exported from `rules.js` so no
      importer changed. Commit `e611c67`, the later modular restructure, then did a separate
      0-line-diff rename that moved the already-extracted file to `scripts/shared/rule-profile.js`,
      where both engines import it today.
- [x] Fixtures under `tests/fixtures/dmn/`, one positive and one negative per rule.

**Verify:** `npm test -- --testPathPatterns=dmn`. **Docs-gate watch:** the existing "33 rules,
5 layers" claim is derived from `scripts/rules.js` alone — make sure no doc sentence starts implying
it covers both engines, or extend the gate.

---

## Stage 3 — DRD layout

- [x] `scripts/dmn/layout.js` — Decision-Core → ELK. A DRG is a plain DAG: no lanes, no pools, no
      boundary events, no message flows. `elk.direction: UP` (input data at the bottom, top-level
      decision at the top), which is the one real difference from `scripts/bpmn/layout.js`. Verified
      empirically against elkjs@0.12.0 that `UP` needs no post-hoc y-flip — ELK emits final
      coordinates directly (`dmn-external-ground-truth.md` §C.10).
- [ ] **The layout result is a diagram LIST, not a single coordMap** — `[{ id, name, size, coordMap }]`,
      with exactly one entry today. Grounds, checked 2026-07-30: DMNDI is `DMNDiagram*` (unbounded,
      DMNDI13.xsd), §6.2.4 builds partial views on exactly that ("DRDs can be interchanged" —
      plural), and a partial view in the XML is **pure DI**: a DMNDiagram holding shapes for a
      subset, nothing in the model part. So the multiplicity belongs to the pipeline contract, not
      to Decision-Core, which stays coordinate- and view-free like Logic-Core; a future `views`
      directive in the schema would be a generator input, additive, and can wait. The multiplicity
      is the target format's shape, not speculation — only our use of it is future. Consumers loop.
      When views arrive, each entry additionally needs its element selection: §6.2.4 SHOULD-notates
      hidden requirements with an ellipsis, and a renderer cannot mark hidden what it does not know
      about. Recorded so the entry shape does not fossilise; not built now.
- [x] `scripts/dmn/coordinates.js` — per-diagram `coordMap` in the same contract shape
      (`{ coords, edgeCoords, edgeLabels }`, no `laneCoords`/`poolCoords`).
      **Correction (2026-07-30):** this plan originally said to reuse `clipOrthogonal`. Checked
      against spec and code, that was wrong twice over: DRD requirement edges are drawn as STRAIGHT
      lines by convention — §6.2.2 mandates line style and arrowheads, not routing; the spec's own
      figures and the tools draw straight — while `clipOrthogonal` trims orthogonal polylines.
      **Further correction (2026-07-31):** the straight-segment clip already existed —
      `clipStraight`/`clipToRect` in `scripts/bpmn/coordinates.js` (lines 777-795), just not
      exported. They moved to `scripts/shared/geometry.js` so both `bpmn/` and `dmn/` import the
      same code rather than a second copy; the three orthogonal helpers (`clipCircleOrthogonal`,
      `clipDiamondOrthogonal`, `clipRectOrthogonal`) stayed in `bpmn/` — see
      [2026-07-31-dmn-drd-and-serialisation-design.md](../specs/2026-07-31-dmn-drd-and-serialisation-design.md)'s
      "Where the boundary actually runs" section for why. ELK contributes node positions only; edge
      routes are computed once, in `coordinates.js`, so the geometry contract holds. `rn()` from
      `shared/utils.js` is reused as-is.
- [x] `scripts/config.json` — a `dmn` block with the DRG shape sizes. No hard-coded constants.
- [x] `scripts/dmn/di-check.js` — geometry pass, same role as `scripts/bpmn/di-check.js`: overlapping shapes,
      shape outside the diagram bounds, edge endpoint not on its shape. Result into
      `result.diagnostics`, **not** into `validation`.

**Verify:** a green rule run says nothing about geometry — check `diagnostics`, per `CLAUDE.md`.

---

## Stage 4 — DMN XML + DMNDI  ← **this is where "we can do DMN" becomes true**

Blocked by GATE 1.

- [x] `scripts/dmn/dmn-xml.js` — `generateDmnXml(dc, diagrams)` building moddle elements, mirroring
      `bpmn/bpmn-xml.js`. `tDefinitions` order matters: it is an `xsd:sequence` ending in
      `dmndi:DMNDI` (max 1); `@namespace` AND `@name` (inherited from `tNamedElement`, easy to miss)
      are both required. **Correction (2026-07-31):** a decision's logic slot has no
      `<decisionLogic>` XML element — that string is only an XSD author's comment above an
      `xsd:element ref="expression"` slot. The serialised child is whichever concrete
      substitution-group member is used, `<decisionTable>` in every case this project produces
      today; emitting a literal `decisionLogic` wrapper is invalid DMN
      (`dmn13-xsd-ground-truth.md` §F16).
- [x] Requirements nest under their **target**; `usingTask`/`usingProcess` emitted where present,
      with `<import>` when the reference crosses into a BPMN file (§2.6).
- [x] DMNDI: `DMNShape`/`DMNEdge` carry `dmnElementRef`. dmn-moddle resolves that to the **element
      object**, not a string — hand it built elements, the way `buildDI` receives `processElements`
      (§2.3).
- [x] The DMNDI writer loops over Stage 3's diagram list and gets a test with a hand-built
      two-diagram input (the schema knows no views yet; the writer does not care). A list of one
      that never runs with two is unverified generality — the `DMNDiagram*` loop must not be dead
      code.
- [x] **Attribute discipline.** Covers all FOUR types that do not extend `tDMNElement` and therefore
      have no `id` — **correction (2026-07-31):** the earlier count of two
      (`tRuleAnnotation`, `tRuleAnnotationClause`) was incomplete; `tDMNElementReference` and
      `tBinding` also lack `id` (`dmn13-xsd-ground-truth.md` §C). `tBinding` is structurally
      unreachable from Decision-Core today (no `invocation` expression type), documented rather
      than exercised.
- [x] `validateDmnXml(xml)` — re-parse through dmn-moddle and surface warnings, mirroring
      `validateBpmnXml`. Wired into the CLI's own section and into `--strict`.
- [x] **Before the first golden file:** the `hitPolicy`/`preferredOrientation` normalisation was
      measured against the real library, not derived from the XSD. **Correction (2026-07-31):** the
      XSD gives no basis for treating the two attributes differently — both are `use="optional"`
      with an explicit `default`, on the same `xsd:extension` block
      (`dmn13-xsd-ground-truth.md` §D8). Whatever dmn-moddle actually does on write is recorded in
      `tests/fixtures/dmn/README.md`, and the golden file matches that observation.

**Verify:** generate the DRD from a fixture, open the `.dmn` in dmn-js **and** Camunda Modeler, and
confirm the decision table renders. That is the milestone — not a green test run.

---

## Stage 5 — Importer

- [ ] `scripts/dmn/import.js` — DMN XML → Decision-Core via dmn-moddle. Recursive where DMN nests.
- [ ] Read `isCollapsed` from the DI, never infer it from the presence of content — the mistake the
      BPMN importer made with `isExpanded` and that #42 had to unpick.
- [ ] **Field-set round-trip guard first, and red before the fix.** A fixture whose nodes carry every
      field class (`question`, `allowedAnswers`, `variable`/`typeRef`, all three requirement kinds,
      `usingTask`, full decision table with annotations, artifacts, DMNDI). Compare **field sets**,
      not individual fields: moddle reports attributes it does not *know*, never fields that never
      arrived — which is why this class was invisible twice (#36, #42).

---

## Stage 6 — SVG

- [ ] `scripts/dmn/svg.js` — four DRG shapes (decision rectangle, input data stadium, knowledge
      source wavy-bottom, business knowledge model clipped-corner) and three edge styles
      (information solid arrow, knowledge dashed open, authority dashed filled-circle).
- [ ] **Renderers translate, never compute** — every coordinate comes from `coordMap`. If something
      is missing, add it to `coordMap`.
- [ ] Guard test: the two renderers agree, mirroring `geometry contract — the two renderers agree`.
- [ ] Decision-table rendering stays out (G6). Note it in Known Limitations rather than half-building it.

---

## Stage 7 — Surface and documentation

Blocked by GATE 2 for the skill part only.

- [ ] CLI: `node dmn.js input.json output` or `pipeline.js --dmn`. Mirror the existing gate order —
      schema gate → rules → diagnostics → serialisation warnings → write, with `--strict` honoured
      at each.
- [ ] MCP: `generate_dmn`, `validate_dmn`, `import_dmn` alongside the four existing tools.
- [ ] HTTP: `/api/v1/dmn/generate` etc.; extend `references/api-schema.json` — the docs gate
      validates a real response against it.
- [ ] `scripts/package.json` — `exports` and `files` must cover `dmn/`, or the published package
      breaks on first import. The package-integrity check catches this; do not make it find it.
- [ ] Docs: `CLAUDE.md` (architecture, key files, Known Limitations, script count),
      `references/omg-compliance.md` (a DMN mapping section), `README.md`, `CHANGELOG.md`
      `[Unreleased]`, and `SKILL.md` per GATE 2.

---

## Verification (every stage)

```bash
cd scripts && npm test          # must stay green; 653 passing at the start of this plan
cd scripts && npm run docs-gate # 0 violations
```

Plus, per `CLAUDE.md`'s standing rules:

- A green validation says nothing about the layout — check `result.diagnostics`, not just
  `validation.errors`.
- No blind golden regeneration. Inspect the diff, decide intended vs. broken, regenerate in a
  separate commit.
- Guards are written **before** the fix and must be seen red. A guard that was never red is not
  verified — after each stage, revert one piece deliberately and confirm the guard fires.

---

## Risks

1. **Silent omission on the way down.** Proven present in DMN (§2.7a). Mitigation is Stage 5's
   field-set guard, and it must exist before the importer is trusted, not after.
2. **A second copy of shared geometry code.** The single most expensive mistake available here.
   **Corrected (2026-07-31):** Stage 3 does not reuse `clipOrthogonal` — that helper is
   orthogonal-routing- and BPMN-shape-specific (branches on `isEvent`/`isGateway`). It reuses
   `clipStraight`/`clipToRect`, relocated from `scripts/bpmn/coordinates.js` into
   `scripts/shared/geometry.js` for exactly this purpose, avoiding a second copy of the actual
   straight-line clip maths.
3. **Scope creep through table rendering (G6) and completeness checking (G7).** Either can exceed
   everything else. Both are explicitly out; keep them out.
4. **Doc claims drifting.** The docs gate covers rule counts, script counts, DI codes and the HTTP
   contract for the BPMN side only. New claims about DMN are unguarded prose until the gate is
   extended — worth doing in Stage 7 rather than accumulating unverified sentences.
5. **GATE 2 answered late.** If the answer turns out to be "no LLM extraction", Stage 7 shrinks and
   nothing else changes — which is why it is deliberately the last gate rather than the first.

---

## A third notation is coming (EAM / ArchiMate)

Recorded 2026-07-30, after the question "does it matter that an EAM component docks on later?".
It does, in three specific ways. **None of them changes Stages 3–7** — nothing built so far blocks
ArchiMate — but two get more expensive the longer they wait.

**The good news first.** The ArchiMate Model Exchange File Format is split into three schemas —
Model, View, Diagram. That is the same separation as BPMN (Semantic + BPMNDI) and DMN (Semantic +
DMNDI). A third pipeline is structurally the same animal as the first two, which is exactly what
G2 (own format, own pipeline) predicted.

**The one assumption EAM actually challenges: one model, one drawing.** `coordMap` silently assumes
a single diagram per model. True for BPMN. For DMN it is a simplification we chose (§6.2.4 defines
partial views; we emit one). ArchiMate makes it false: a model carries many views, each with its own
geometry, and a view is a *selection* over the model rather than the model itself. Whenever the
geometry contract is touched from here on, that is the assumption to keep in view — not to build
for now, but not to entrench further either.

### Decide now, act later

- [ ] **Make the bridge a mechanism, not a field.** `decisionRef` is currently one string on one
      element type. ArchiMate↔BPMN is a standard link (a Business Process element realized by a BPMN
      process) and EAM will want many of them — application supporting a task, capability realized
      by a process, business object behind a data object. Design the cross-model reference once,
      with target type and target namespace rather than a bare id, before the second one exists.
      Retrofitting means one four-place round (writer, both importers, schema) **per field** — the
      #42 shape again.
- [ ] **Directory symmetry — after Stage 4, not before.** Top level today is not "BPMN" but BPMN
      *plus* shared code *plus* tooling in one heap, with DMN in a subdirectory. The clean end state
      is `bpmn/ dmn/ archimate/ shared/` with the tooling beside it. That is a large mechanical diff
      touching every import, the docs gate's script count, `exports` and the Skill bundle. Do it
      once DMN produces a real file and it is visible what is genuinely shared — not before, on
      suspicion.

### Explicitly do NOT

- **Do not extract a generic diagram kernel now.** The expensive defects in this codebase came from
  *unintentional* duplication, not from abstracting too late. A kernel designed before the third
  notation exists is built on speculation. After Stage 6 it will be visible what actually repeated.

### Know before planning ArchiMate rules

ArchiMate has roughly 60 element types and a relationship-validity matrix — the same shape as D03,
at a completely different scale. Transcribing it by hand will not work. **First question, before any
rule design: does the Open Group publish that matrix machine-readably?** That is precisely the
question that saved D03 here: checking the source rather than reasoning from the schema alone turned
up a rule that would have rejected valid models.

Sources: <https://www.opengroup.org/open-group-archimate-model-exchange-file-format> ·
<https://www.opengroup.org/xsd/archimate/>

---

## Not in scope

- FEEL parsing or evaluation (G5). We generate and read expressions as text.
- Decision table rendering (G6).
- Completeness, overlap and masked-rule analysis (G7).
- DMN 1.4/1.5/1.6 (G1).
- `camunda:` extensions in either direction.
- Issues #37, #43, #31–#34 and the open Dependabot PRs stay untouched.

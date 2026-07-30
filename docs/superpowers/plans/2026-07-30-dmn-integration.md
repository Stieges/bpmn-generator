# DMN integration — implementation plan

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
- [ ] `scripts/bpmn-xml.js` — `buildFlowNode` emits `extensionElements` carrying the reference for
      `businessRuleTask`. Neutral namespace, **not** `camunda:`. Follow the §2.7(a) discipline:
      check `Semantic.xsd` before emitting any attribute.
- [ ] `scripts/moddle-import.js` `nodeFromElement` **and** `scripts/import.js` `nodeFromChild` —
      read it back. Both functions are recursive and shared between top level and subprocess
      children; put the field in the function, never in a caller.
- [ ] `tests/fixtures/subprocess-child-fidelity.json` — add `decisionRef` to a child node. The
      field-set round-trip test then proves all four places learned about it.
- [ ] Rule: a `decisionRef` on anything that is not a `businessRuleTask` is a warning.

**Verify:** `npm test`; round-trip preserves the field; `xmlWarnings` stays empty.

---

## Stage 2 — Decision-Core: schema and rules

- [ ] `references/decision-core-schema.json` — ajv draft-2020-12, strict, shape as above.
- [ ] `scripts/dmn/schema-gate.js` — mirrors `scripts/schema-gate.js`, which is now four lines:
      it delegates path resolution to `resource-paths.js`. **Do not copy a path fallback into it** —
      add `decision-core-schema.json` to `resource-paths.js` (a third `sourcePath`/`packagedPath`
      pair plus a wrapper), to `prepack-copy-references.mjs`'s `FILES`, and it is removed again by
      the existing `postpack` step. Spell the filename out literally in each `join(__dirname, …)`,
      or the docs gate's package-integrity check resolves a directory and reports a false violation.
- [ ] `scripts/dmn/rules.js` — same rule object shape as `scripts/rules.js`
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

- [ ] `rules/dmn-default-profile.json`. **Checked, 2026-07-30:** the profile machinery in
      `scripts/rules.js` — `loadRuleProfile`, `isRuleEnabled`, `getEffectiveSeverity` — is already
      format-agnostic; it only ever sees a rule object and a profile. Only `runRules` is
      BPMN-specific (fixed `RULES` list, `lc.pools ? lc.pools : [lc]`), so DMN needs its own runner
      and nothing else. Two of the three are not exported today: lift all three into
      `scripts/rule-profile.js` and have both engines import them, rather than duplicating them.
      That takes the top-level script count to 32 — update `CLAUDE.md` or the gate will.
- [ ] Fixtures under `tests/fixtures/dmn/`, one positive and one negative per rule.

**Verify:** `npm test -- --testPathPatterns=dmn`. **Docs-gate watch:** the existing "33 rules,
5 layers" claim is derived from `scripts/rules.js` alone — make sure no doc sentence starts implying
it covers both engines, or extend the gate.

---

## Stage 3 — DRD layout

- [ ] `scripts/dmn/layout.js` — Decision-Core → ELK. A DRG is a plain DAG: no lanes, no pools, no
      boundary events, no message flows. `elk.direction: UP` (input data at the bottom, top-level
      decision at the top), which is the one real difference from `scripts/layout.js`.
- [ ] `scripts/dmn/coordinates.js` — `buildCoordinateMap` producing the same contract shape
      (`{ coords, edgeCoords, edgeLabels }`, no `laneCoords`/`poolCoords`).
      **Reuse, do not copy:** `clipOrthogonal` from `scripts/coordinates.js`. If it needs
      generalising, generalise it in place rather than forking it — a second copy is the defect
      class this project has already paid for three times.
- [ ] `scripts/config.json` — a `dmn` block with the DRG shape sizes. No hard-coded constants.
- [ ] `scripts/dmn/di-check.js` — geometry pass, same role as `di-check.js`: overlapping shapes,
      shape outside the diagram bounds, edge endpoint not on its shape. Result into
      `result.diagnostics`, **not** into `validation`.

**Verify:** a green rule run says nothing about geometry — check `diagnostics`, per `CLAUDE.md`.

---

## Stage 4 — DMN XML + DMNDI  ← **this is where "we can do DMN" becomes true**

Blocked by GATE 1.

- [ ] `scripts/dmn/xml.js` — `generateDmnXml(dc, coordMap)` building moddle elements, mirroring
      `bpmn-xml.js`. `tDefinitions` order matters: it is an `xsd:sequence` ending in `dmndi:DMNDI`
      (max 1), and `@namespace` is required (§2.8).
- [ ] Requirements nest under their **target**; `usingTask`/`usingProcess` emitted where present,
      with `<import>` when the reference crosses into a BPMN file (§2.6).
- [ ] DMNDI: `DMNShape`/`DMNEdge` carry `dmnElementRef`. dmn-moddle resolves that to the **element
      object**, not a string — hand it built elements, the way `buildDI` receives `processElements`
      (§2.3).
- [ ] **Attribute discipline.** Add a `isDmnElementWithId`-style predicate covering the types that do
      **not** extend `tDMNElement` — `tRuleAnnotation` and `tRuleAnnotationClause` have no `id`.
      Emitting one produces a warning that survives the round trip and reappears in every consumer
      (§2.7a) — the #36 mechanism exactly.
- [ ] `validateDmnXml(xml)` — re-parse through dmn-moddle and surface warnings, mirroring
      `validateBpmnXml`. Wire into the CLI as its own section and into `--strict`.
- [ ] **Before the first golden file:** pin the normalisation behaviour from §2.7(b) in a test —
      `hitPolicy="UNIQUE"` is dropped on write, `preferredOrientation="Rule-as-Row"` is kept. Write
      the goldens against actual output, with that asymmetry documented in the fixture's README.

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
   Stage 3 reuses `clipOrthogonal` rather than forking it, on purpose.
3. **Scope creep through table rendering (G6) and completeness checking (G7).** Either can exceed
   everything else. Both are explicitly out; keep them out.
4. **Doc claims drifting.** The docs gate covers rule counts, script counts, DI codes and the HTTP
   contract for the BPMN side only. New claims about DMN are unguarded prose until the gate is
   extended — worth doing in Stage 7 rather than accumulating unverified sentences.
5. **GATE 2 answered late.** If the answer turns out to be "no LLM extraction", Stage 7 shrinks and
   nothing else changes — which is why it is deliberately the last gate rather than the first.

---

## Not in scope

- FEEL parsing or evaluation (G5). We generate and read expressions as text.
- Decision table rendering (G6).
- Completeness, overlap and masked-rule analysis (G7).
- DMN 1.4/1.5/1.6 (G1).
- `camunda:` extensions in either direction.
- Issues #37, #43, #31–#34 and the open Dependabot PRs stay untouched.

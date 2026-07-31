# CLAUDE.md — BPMN Generator

## Project Context

Enterprise BPMN 2.0 Generator: JSON Logic-Core → Validation → ElkJS Layout → BPMN 2.0 XML + SVG.
OMG BPMN 2.0.2 compliant (ISO/IEC 19510:2013). Compatible with bpmn.io / Camunda Modeler.

Used as a Claude Code Skill (SKILL.md) — the LLM extracts Logic-Core JSON from natural language, the pipeline handles layout and serialization. The LLM NEVER touches coordinates.

## Glossary

- **Logic-Core**: the JSON intermediate format between LLM and pipeline. Schema in `references/input-schema.json`, prose in `references/logic-core-schema.md`. Example: `tests/fixtures/simple-approval.json`.
- **BPMN 2.0.2**: OMG standard (ISO/IEC 19510:2013) for business process notation. We emit XML compatible with bpmn.io and Camunda Modeler.
- **BPMNDI**: BPMN Diagram Interchange — the `<bpmndi:*>` namespace that carries graphical layout (coordinates, waypoints) alongside the semantic XML.
- **Pool / Lane**: a Pool is a participant in a collaboration (its own process boundary); Lanes partition a Pool into roles/actors. Pools communicate via Message Flows.
- **WF-Net**: Workflow-Net — a restricted Petri-Net with one source and one sink. Used for soundness analysis (WF01–WF03 rules).
- **Soundness**: a process is sound if every case can reach the end state, no dead activities, no proper deadlocks. Petri-Net property.
- **Sugiyama**: layered graph drawing algorithm (Sugiyama et al., 1981). ElkJS implements a variant; we use it via the `org.eclipse.elk.layered` algorithm.
- **ElkJS Layered**: JavaScript port of the Eclipse Layout Kernel's layered algorithm. Our auto-layout engine — see `scripts/bpmn/layout.js`.
- **Bruce Silver Method & Style**: industry-recognized style conventions for BPMN diagrams. Most M-layer rules derive from this work — M11 is our own (the decisionRef bridge), not Silver.
- **MCP**: Model Context Protocol — the protocol Claude Code uses to talk to external tools. We expose the generator via `scripts/mcp-bpmn-server.js`.
- **MaD**: Model-and-Data sanity check used by the robustness subsystem to validate synthetic fixtures.
- **Golden file**: an `.expected.bpmn` (or `.expected.svg`) committed alongside a fixture; tests fail if output diverges.

## Architecture

7 top-level scripts (standalone tooling) + 23 bpmn-pipeline + 2 dmn (growing) + 3 shared + 7 agent +
9 robustness modules under `scripts/`. Verify current inventory with
`find scripts -name '*.js' -not -path '*/node_modules/*' -not -name '*.test.js' | wc -l`.

```
scripts/bpmn/ — Core Pipeline (run on every generate call)
  pipeline.js (Orchestrator, public API runPipeline)
    ├── validate.js          ← rules.js
    ├── rules.js             ← types.js, workflow-net.js, optimize.js
    ├── optimize.js          ← types.js, topology.js (opt-in Optimization Advisory layer O01–O04, invoked by rules.js)
    ├── workflow-net.js      ← types.js
    ├── topology.js          ← types.js
    ├── layout.js            ← types.js, ../shared/utils.js, constants.js, topology.js, elkjs
    ├── coordinates.js       ← types.js, ../shared/utils.js, constants.js, topology.js
    ├── di-check.js          (no deps — post-layout DI integrity pass, see below)
    ├── visual-refinement.js ← coordinates.js, constants.js (opt-in compaction passes)
    ├── edge-simplify.js     ← types.js (post-process ELK waypoints, reduce zigzag)
    ├── bpmn-xml.js          ← types.js, ../shared/utils.js, constants.js, topology.js, icons.js
    ├── svg.js               ← types.js, ../shared/utils.js, constants.js, icons.js
    ├── icons.js             ← ../shared/utils.js, constants.js
    ├── dot.js               ← types.js
    ├── schema-gate.js       ← ../shared/resource-paths.js (ajv draft-2020-12 strict gate)
    ├── types.js             (no deps)
    ├── constants.js         ← ../shared/utils.js (13 BPMN-only layout constants: SHAPE, SW, CLR,
    │                          lane/label/gap/padding sizes — derived from CFG, never touched by dmn/)
    ├── import.js             BPMN XML → Logic-Core (DOM parser)
    └── moddle-import.js      BPMN XML → Logic-Core (bpmn-moddle path)

scripts/bpmn/ — Redesign toolbox (opt-in; CLI-driven, not invoked by runPipeline)
  redesign-cli.js            ← redesign.js (CLI entry; preview is the default, --apply writes)
  redesign.js                ← redesign-core.js (5 deterministic transforms, each preview*/apply*)
  redesign-core.js           ← rules.js, topology.js (soundness gate, deterministic IDs, protection lists;
                                may NOT import agents/llm-provider.js, directly or transitively)

scripts/shared/ — format-independent core (used by both bpmn/ and dmn/)
  utils.js                   (reads ../config.json)
  rule-profile.js            (profile machinery: loadRuleProfile, isRuleEnabled, getEffectiveSeverity)
  resource-paths.js          (no deps — where references/ lives in each layout)

Standalone tooling (top-level scripts/)
  http-server.js             HTTP API (/api/v1/generate, /orchestrate, /chat)
  mcp-bpmn-server.js         MCP server entry point
  evaluate-slm.js            Pipeline evaluation runner
  prepare-training-data.js   Training-data prep script
  audit.js                   Append-only JSONL audit log
  delivery.js                Webhook delivery + dead-letter
  orchestrator.js            Multi-agent orchestration

DMN subsystem (scripts/dmn/) — opt-in, not reached by runPipeline
  schema-gate.js             ← ../shared/resource-paths.js (ajv gate for Decision-Core)
  rules.js                   ← ../shared/rule-profile.js, ../shared/utils.js (D01–D11 + B01–B06,
                               3 layers, 2 modes; own runner `runDmnRules`)
  (in progress — see docs/superpowers/plans/2026-07-30-dmn-integration.md.
   Stages 3–7 add layout, DMN 1.3 XML + DMNDI, importer, SVG and the tool surface.
   Nothing here produces a .dmn file yet.)

Agent subsystem (scripts/agents/)
  chat.js, compliance.js, layout.js, llm-provider.js, modeler.js, prompt-sections.js, reviewer.js

Robustness subsystem (scripts/robustness/)
  cli.js, curate-mad.js, failure-classifier.js, fixture-persister.js,
  graph-isomorphism.js, mad-validator.js, report-generator.js,
  stress-tester.js, synthetic-generator.js
  (+ seed-catalog.json, config.json, README.md)
```

**Guiding principle:** Each pipeline step is independently replaceable, configurable, and testable.

### The geometry contract

`coordMap` (`{ coords, laneCoords, poolCoords, edgeCoords, edgeLabels }`) is the contract between
layout and rendering. Two rules make it hold:

1. **Every drawable element has its geometry in `coordMap` — renderers only translate, never compute.**
   ELK is a *producer*, not the contract: its vocabulary is nodes and edges, BPMN's is larger.
   Boundary events, artifacts, message flows and associations are all outside it, so each needs its
   own placement step (`coordinates.js` §5.0-, §5.4, `routeMessageFlows`). Letting a renderer compute
   geometry means computing it *twice* — `svg.js` for humans, `bpmn-xml.js` for tools — and the two
   copies drift. That has happened three times; see **Do NOT**.
2. **Anything depending on final geometry runs last.** Message flow routes must lie in the gap
   between participants, so `routeMessageFlows()` runs in `pipeline.js` *after* visual refinement —
   the last pass that can still move a participant.

This is also why a `Lane`'s `flowNodeRef` in `bpmn-xml.js`'s `buildLane` excludes artifacts and
data references: `flowNodeRef` is typed `FlowNode` and neither qualifies (an Artifact never
inherits from `FlowNode`; a data reference is a `FlowElement` but still not a `FlowNode`). Which
lane an artifact sits in visually is answered once, in `coordMap` — putting a second, semantic
answer in `flowNodeRef` is exactly the kind of duplicate source rule 1 warns about, just for
membership instead of coordinates.

## Key Files

| File | Purpose |
|------|---------|
| `scripts/bpmn/pipeline.js` | Orchestrator + CLI + Public API (`runPipeline`) |
| `scripts/bpmn/rules.js` | Rule Engine: 34 rules, 5 layers (Soundness/Style/Pragmatics/Workflow-Net/Optimization; last two opt-in); M05/M06 severity=OFF. Verify count: `grep -c '^\s*id:' scripts/bpmn/rules.js` |
| `scripts/bpmn/optimize.js` | `runOptimizationAnalysis` — graph-heuristic redesign advisories (O01–O04) + Lean metrics; opt-in via `optimize`/`soll` mode |
| `scripts/bpmn/redesign.js` | Five deterministic redesign transforms (`parallelize`, `mergeTasks`, `relane`, `reorderKnockouts`, `isolateException`), each as a `preview*` (feasible? why/why not) + `apply*` pair; no LLM |
| `scripts/bpmn/redesign-core.js` | Shared redesign kernel: profile-independent soundness gate (`SOUNDNESS_GATE`/`checkGate`), deterministic collision-free IDs (`nextId`), protection-list matching by id/name (`isProtected`), cross-format lane resolution (re-exported `resolveLaneId` from `topology.js`) |
| `scripts/bpmn/redesign-cli.js` | CLI entry to the redesign toolbox (`node bpmn/redesign-cli.js <input.json> <transform> [options] [--apply]`); preview is the default, nothing is written without `--apply`, a refusal exits non-zero and writes nothing |
| `scripts/bpmn/validate.js` | Thin wrapper around `runRules()` |
| `scripts/bpmn/types.js` | `isEvent`, `isGateway`, `isArtifact` (layout sense — kept out of the ELK graph; wider than the BPMN class, includes data references), `isBpmnArtifact` (the actual OMG Artifact class — TextAnnotation, Group; use this one for anything that has to be right against the XSD), `bpmnXmlTag` |
| `scripts/shared/utils.js` | `loadConfig`, `CFG`, `esc`, `wrapText`, `EXTENSION_NS` (our own `extensionElements` namespace — always create those via `moddle.createAny(name, EXTENSION_NS, …)`; setting a prefixed attribute in `$attrs` without a matching `xmlns:` declaration makes moddle **drop the value silently**, logging to stderr while `warnings` stays empty). Carries only what both `bpmn/` and `dmn/` use — the 13 BPMN-only layout constants live in `scripts/bpmn/constants.js` |
| `scripts/bpmn/constants.js` | The 13 BPMN-only layout constants (`SHAPE`, `SW`, `CLR`, `LANE_HEADER_W`, `LANE_PADDING`, `LABEL_DISTANCE`, `TASK_RX`, `INNER_OUTER_GAP`, `EXTERNAL_LABEL_H`, `POOL_GAP`, `COLLAB_PADDING`, `MESSAGE_FLOW_FAN`, `ARTIFACT_GAP`), derived from `CFG` (`../shared/utils.js`) — never imported by `dmn/` |
| `scripts/bpmn/topology.js` | `inferGatewayDirections`, `sortNodesTopologically`, `orderLanesByFlow`, `normalizeLaneAssignments`, `resolveLaneId` (the single cross-format lane resolver — `node.lane` **or** `Lane.nodeIds`; lives here to stay clear of the `redesign-core → rules → optimize` import cycle) |
| `scripts/bpmn/layout.js` | `logicCoreToElk`, `runElkLayout` (ElkJS Sugiyama) |
| `scripts/bpmn/coordinates.js` | `buildCoordinateMap`, `clipOrthogonal`, pool width balancing; owns the **vertical** axis (§5.0a lane bands, §5.0b2 participant stacking) — ELK owns only x |
| `scripts/bpmn/di-check.js` | `checkDiagramIntegrity` — post-layout geometry pass. DI01 identical participant positions, DI02 overlapping participants, DI03 node outside its participant, DI04 overlapping lane bands, DI06 child outside its expanded subprocess (all ERROR); DI05 message flow crossing an uninvolved participant (WARNING). `ok` means "no ERROR". Result lands in `result.diagnostics`, **not** in `validation` |
| `scripts/bpmn/topology.js` | additionally `orderParticipantsByMessageFlow` — stacks participants so that communication partners are adjacent (exact search up to 8 participants, heuristic above). Toggle: `poolOrder: 'auto' \| 'declared'` |
| `scripts/bpmn/bpmn-xml.js` | `generateBpmnXml` — OMG-compliant BPMN 2.0 XML + DI |
| `scripts/bpmn/svg.js` | `generateSvg` — SVG rendering of all BPMN elements |
| `scripts/bpmn/icons.js` | Event markers, task icons, bottom markers (Loop, MI, Ad-Hoc) |
| `scripts/bpmn/dot.js` | `logicCoreToDot` / `dotToLogicCore` — Graphviz DOT support |
| `scripts/bpmn/workflow-net.js` | WF-Net soundness checks (used by WF01–WF03 rules) |
| `scripts/bpmn/visual-refinement.js` | Optional compaction/refinement passes P1–P7.1 (off by default) |
| `scripts/bpmn/edge-simplify.js` | Post-process ELK edge waypoints to reduce zigzag bends |
| `scripts/bpmn/schema-gate.js` | `validateLogicCoreSchema` — ajv draft-2020-12 strict gate for the HTTP API |
| `scripts/bpmn/moddle-import.js` | BPMN XML → Logic-Core via bpmn-moddle (parallel to import.js) |
| `scripts/http-server.js` | HTTP API server (`/api/v1/generate`, `/orchestrate`, `/chat`) |
| `scripts/mcp-bpmn-server.js` | MCP server entry point |
| `scripts/orchestrator.js` | Multi-agent orchestration (modeler → layout → reviewer → compliance) |
| `scripts/audit.js` | Append-only audit log (JSONL) |
| `scripts/delivery.js` | Webhook delivery + dead-letter queue |
| `scripts/evaluate-slm.js` | Evaluation runner against fixture sets |
| `scripts/prepare-training-data.js` | Training-data prep for SLM eval |
| `scripts/agents/` | 7 agent modules: chat, compliance, layout, llm-provider, modeler, prompt-sections, reviewer |
| `scripts/robustness/` | Synthetic-data + benchmarking subsystem (9 modules + config; see `scripts/robustness/README.md`) |
| `scripts/bpmn/import.js` | BPMN XML Parser → Logic-Core JSON |
| `scripts/config.json` | Externalized constants (shapes, colors, spacing) |
| `scripts/shared/rule-profile.js` | `loadRuleProfile`, `isRuleEnabled`, `getEffectiveSeverity` — what a profile *means*, shared by both rule engines. Nothing here knows about processes or decisions; only the runner is format-specific |
| `scripts/dmn/schema-gate.js` | `validateDecisionCoreSchema` — ajv gate for `references/decision-core-schema.json` |
| `scripts/dmn/rules.js` | `DMN_RULES`, `runDmnRules`, `dmnProfileForMode` — 17 rules, 3 layers, 2 modes. **Counted separately from the BPMN engine** — see the DMN section under Rule Engine |
| `references/decision-core-schema.json` | Formal JSON Schema for DMN Decision-Core input |
| `rules/dmn-default-profile.json` | Default DMN profile (semantic: soundness + semantics) |
| `rules/dmn-best-practice-profile.json` | Adds the opt-in `best_practice` layer |
| `rules/custom/` | Project-specific profiles, loaded by path only — see its README |
| `scripts/shared/resource-paths.js` | `inputSchemaPath`, `promptTemplatePath` — the single place that decides where `references/` lives. **The source outranks the in-package copy.** The reverse precedence was a silent trap: `npm pack` (including the `--dry-run` the docs gate runs) leaves a copy behind, and every later edit to `references/` then had no effect while `git status` said nothing, because it is gitignored. Filenames are spelled out literally in each `join(__dirname, …)` — the docs gate parses those calls for string literals, and a variable would make it check a directory |
| `scripts/prepack-copy-references.mjs` | `prepack` lifecycle script — copies `input-schema.json`/`prompt-template.md` from repo-root `references/` into `scripts/references/` (gitignored) so the npm package ships them. npm's `files` cannot reach outside the package root, hence a copy |
| `scripts/postpack-clean-references.mjs` | `postpack` lifecycle script — removes that copy again. npm runs it after both `npm pack` and `npm pack --dry-run`, so a build artifact no longer outlives the build |
| `scripts/build-skill.mjs` | `npm run build:skill` — bundles `SKILL.md` + `references/` + `scripts/` into `bpmn-generator-v3.skill` (gitignored, rebuilt on demand) |
| `references/input-schema.json` | Formal JSON Schema for Logic-Core input |
| `references/logic-core-schema.md` | Schema documentation (prose + examples) |
| `references/prompt-template.md` | LLM prompts + 5 enterprise few-shot patterns |
| `references/fachliches-regelwerk.md` | Rule documentation (per-rule sources, extension guide). Authoritative catalog — see this file, not duplicated counts. |
| `references/omg-compliance.md` | OMG BPMN 2.0.2 → code mapping |
| `rules/default-profile.json` | Default rule profile (all layers active) |
| `rules/strict-profile.json` | Strict profile (style warnings → errors) |

## Development

```bash
cd scripts/
npm install
npm test                                          # Jest, ES Modules; verify count with `npm test 2>&1 | tail -5`
npm run docs-gate                                 # the CI docs gate; add `-- --summary` to pass flags
node bpmn/pipeline.js ../tests/fixtures/simple-approval.json /tmp/test   # Smoke Test
```

Everything runs from `scripts/` — that is where the only `package.json` lives. The docs gate
itself sits at `.github/scripts/docs-gate.mjs` and works from any directory, but invoking it by
relative path only works from the repo root; `npm run docs-gate` avoids having to think about it.

After every change: `npm test` must pass.

### Adding a New Test

1. Place fixture in `tests/fixtures/` (JSON Logic-Core)
2. Add test in `pipeline.test.js` (Jest, `import { ... } from './pipeline.js'`)
3. For golden-file tests: place `.expected.bpmn` alongside the fixture

### Adding a New Rule

1. Insert rule object into `scripts/bpmn/rules.js` → `RULES` array
2. Fields: `id`, `layer`, `defaultSeverity`, `description`, `ref`, `check(proc)`
3. `check` returns `{ pass: true }` or `{ pass: false, message: '...' }`
4. Update documentation in `references/fachliches-regelwerk.md`
5. Add tests in `pipeline.test.js`

### Adding a New BPMN Element

1. `types.js` — extend `bpmnXmlTag` map, add type predicate if needed
2. `layout.js` — `buildElkNode` for layout dimensions
3. `bpmn-xml.js` — XML serialization
4. `svg.js` — SVG rendering
5. `icons.js` — if icon/marker needed
6. `import.js` **and** `moddle-import.js` — BPMN XML → Logic-Core parsing (both; `moddle-import.js`
   is the primary path, `import.js` the fallback — fixing only one leaves the round trip lossy)
7. `references/omg-compliance.md` — update OMG mapping
8. `references/input-schema.json` — extend schema

### Adding a per-node field

Not the same job as adding an element, and the place this project has got wrong twice.

A field lives in **four** places, and every one of them must learn about it: `bpmn-xml.js`
`buildFlowNode` (write), `moddle-import.js` `nodeFromElement` and `import.js` `nodeFromChild`
(read back), plus the schema. Each of those three functions is deliberately **recursive** and
shared between top-level nodes and subprocess children — put the field in a caller instead of in
the function and it silently applies to one nesting level only.

The failure mode is invisible: bpmn-moddle reports attributes it does not *know*, never fields
that never arrived, so an omission produces no warning and `validation.errors` stays empty. The
guard is the field-set round-trip test over `tests/fixtures/subprocess-child-fidelity.json` —
extend that fixture with the new field and it will tell you which of the four places you missed.

### Docs gate

CI check (`.github/scripts/docs-gate.mjs`, wired in `.github/workflows/docs-gate.yml`) that
checks documented claims against the running code instead of trusting the prose — added after
the CHANGELOG fell six releases behind and `/api/v1/orchestrate` silently dropped a documented
response field for three commits.

1. Four **proof** checks (exit 1 on violation): the HTTP response contract vs.
   `references/api-schema.json` (ajv, validated against a real response built from each
   endpoint), numeric claims ("N rules, 5 layers" in README.md/CLAUDE.md, "N top-level scripts"
   in CLAUDE.md, DI codes in `references/api-reference.md`) vs. the actual counts, doc paths —
   proof #3: every `scripts/`-, `references/`-, `rules/`-, `tests/`-, `docs/`-, `frontend/`- or
   `.github/`-shaped path string mentioned in prose (and every `node <file>.js` CLI example)
   across README.md, CLAUDE.md, ROADMAP.md, SKILL.md, EVALUATION.md,
   `docs/bpmn-generator-pipeline.md`, `references/api-reference.md` and
   `references/fachliches-regelwerk.md` must resolve to a real file or directory, or be covered
   by the allowlist in `checkDocPaths`' `DOC_PATH_ALLOWLIST` (transient/generated paths, each
   with a reason comment) — and package integrity — every `join(__dirname, ...)` a packed file
   reads at runtime, checked against `npm pack`'s output, scoped to files reachable from
   `scripts/package.json`'s `exports`.
2. One **nudge** check (PR-only, never fails the build): if a `feat`/`fix`/`perf` commit in the
   PR's range touches `scripts/**` and `CHANGELOG.md`'s `[Unreleased]` section is untouched or
   empty, prints a ready-to-paste draft built from the commit subjects.
3. Run locally: `cd scripts && npm run docs-gate` — same directory as `npm test`. Flags need the
   npm separator: `npm run docs-gate -- --summary --base <ref> --head <ref>` (`--base`/`--head`
   also run the nudge check). From the repo root, `node .github/scripts/docs-gate.mjs` works
   directly; the gate resolves its own paths, so only the path *to* it depends on where you
   stand. Exit codes: `0` clean, `1` a proof check found a violation, `2` tooling error (never
   passes silently).
4. Own tests: `scripts/docs-gate.test.js`, exercising the exported pure(-ish) functions directly
   — see the doc comment on `checkPackageIntegrity` for why that one reads real files instead of
   synthetic fixtures.

## Common Tasks

Workflows that come up repeatedly in this codebase. Each lists the file(s) to open first and the verification command.

### Debug a wrong layout

1. Reproduce: `cd scripts && node bpmn/pipeline.js ../tests/fixtures/<fixture>.json /tmp/dbg`
2. Inspect `/tmp/dbg.svg` (browser) and `/tmp/dbg.bpmn` (text editor).
3. Open in order: `layout.js` (Elk node/edge build), `coordinates.js` (post-processing), `topology.js` (node/lane ordering).
4. For pool/lane width issues, suspect `coordinates.js` first (pool width balancing + lane-compaction logic) and `visual-refinement.js` (compaction passes).
5. For edge routing issues, suspect `coordinates.js` (`clipOrthogonal`) and `bpmn-xml.js` (waypoint emission).

### React to a golden-file failure

1. **Never blind-regenerate.** First inspect the diff:
   - `diff -u tests/fixtures/<name>.expected.bpmn /tmp/output.bpmn`
2. Decide: is the change intended (then the golden is stale and must be regenerated) or unintended (then the code is broken)?
3. Only after the diff is reviewed: regenerate via the fixture's documented procedure (typically `node bpmn/pipeline.js <fixture> <out>` and then `cp <out>.bpmn <fixture>.expected.bpmn`).
4. Commit golden updates in their own commit, separate from code changes.

### Extend the rule engine

1. Insert the rule object into the `RULES` array in `scripts/bpmn/rules.js`.
2. Fields: `id`, `layer`, `defaultSeverity`, `description`, `ref`, `check(proc) → { pass: true } | { pass: false, message }`.
3. Document the rule in `references/fachliches-regelwerk.md` with source citation.
4. Add a positive and a negative fixture under `tests/fixtures/` and assertions in `pipeline.test.js`.
5. Verify: `npm test -- --testPathPatterns=pipeline`.

### Choose a test fixture

- Simple sequential approval flow → `tests/fixtures/simple-approval.json`
- Multi-pool collaboration with message flows → `tests/fixtures/multi-pool-collaboration.json`
- Realistic collaboration (6 participants, 5 expanded, 3 with lanes, boundary event, black box) → `tests/fixtures/realistic-collaboration.json` — the regression guard for the whole collaboration-layout class
- Every element class at once (artifacts, associations, boundary event, black box, message flow) → `tests/fixtures/all-element-classes.json` — the geometry-contract fixture: if a class loses its coordinates, this one fails
- Subprocess (expanded) → `tests/fixtures/expanded-subprocess.json`
- Sparse lanes (tests visual-refinement compaction) → `tests/fixtures/sparse-lanes.json`
- Full list: `ls tests/fixtures/`.

### Change a prompt template

1. Edit `references/prompt-template.md`. The LLM consumes this verbatim.
2. **Re-validate downstream**: any change must still produce valid Logic-Core per `references/input-schema.json`. Run a sample text through the orchestrator (`scripts/agents/modeler.js`) and check the schema-validation step passes.
3. Update the few-shot examples in the same file if the format changes — examples must be consistent with the new rules.

### Run a visual-refinement pass

1. Default: `visualRefinement: false`. Opt in per call: `runPipeline(lc, { visualRefinement: true })`.
2. Sub-flags live in `scripts/config.json` under `CFG.visualRefinement`: `dynamicLaneHeader`, `laneCompaction`, `edgeLabelCollisionRepair` (all on by default when `visualRefinement: true`). See `scripts/bpmn/visual-refinement.js` for the pass implementations.
3. Verify against goldens: `cd scripts && npm test -- --testPathPatterns=visual-refinement`.

### Change the participant order of a collaboration

1. Default is `poolOrder: 'auto'` — participants are stacked so that the ones exchanging messages sit
   next to each other, because a message flow spanning N positions crosses N-1 uninvolved pools and
   reads as a participation that does not exist. Expanded pools and black-box participants are
   ordered together (`orderParticipantsByMessageFlow` in `scripts/bpmn/topology.js`).
2. Keep the declared order instead: `runPipeline(lc, { poolOrder: 'declared' })`, project-wide via
   `config.json → layout.poolOrder`, or per call over MCP (`generate_bpmn`) and the HTTP API
   (`/api/v1/generate`). Switched off, nothing else changes — routing stays orthogonal, there are
   simply more crossings, and DI05 reports them.
3. Verify: `result.diagnostics.issues.filter(i => i.code === 'DI05')` — fewer is better.

### Run a robustness benchmark

1. Synthetic-data run: `cd scripts/robustness && node cli.js run --target=lc-json`.
2. Multi-target run: `node cli.js run --target=both` (LC-JSON + DOT paths through the LLM).
3. MaD subset validation: `node cli.js mad-check` — requires `tests/fixtures/mad-subset/` to exist
   first (one-time curation step, see `scripts/robustness/README.md`); `tests/fixtures/mad-subset-test/`
   alone is not enough.
4. Reports land in `tests/robustness-reports/` (gitignored — share by attaching).

## Rule Engine

5 layers with configurable severity:

| Layer | Default Severity | Rules | Focus |
|-------|-----------------|-------|-------|
| Soundness | ERROR | S01-S13 | Structural correctness (OMG compliance) |
| Style | WARNING | M01-M11 (M05/M06 severity=OFF) | Readability (Bruce Silver Method & Style) |
| Pragmatics | INFO | P01-P03 | Complexity metrics |
| Workflow-Net | ERROR/WARNING | WF01-WF03 | Petri-Net soundness (opt-in) |
| Optimization | ADVISORY | O01-O04 | Redesign advisories — `optimize`/`soll` mode only (opt-in); Reijers 2005 + BABOK Lean. Emits `validation.advisories` + `metrics.optimization` |

Profiles in `rules/*.json` override severities or disable layers. Mode: `document` (default, faithful IST) vs. `optimize`/`soll` (enables the Optimization layer). See `scripts/bpmn/optimize.js`.

### DMN rule engine — a separate count

`scripts/dmn/rules.js` holds 17 rules in 3 layers against Decision-Core, not Logic-Core:

| Layer | Default severity | Rules | Focus |
|-------|-----------------|-------|-------|
| soundness | ERROR | D01–D05, D09–D11 | Graph, table shape, DMN 1.3 conformance |
| semantics | WARNING | D06–D08 | Points at something demonstrably wrong |
| best_practice | WARNING | B01–B06 | Readability and method (opt-in) |

Two modes, mirroring `document`/`optimize`: **`semantic`** (default — does it hold together) and
**`best-practice`** (adds the third layer). `runDmnRules(dc, { mode, profile, config })`. A profile
is more specific than a mode, so an explicit `enabled` in a profile wins. Profiles:
`rules/dmn-default-profile.json`, `rules/dmn-best-practice-profile.json`, and project-specific ones
under `rules/custom/` — **loaded by path, never scanned**, so dropping a file in cannot change
behaviour silently. Thresholds in `config.json → dmn`.

The table above and every "N rules, 5 layers" claim in this file and README.md are about
`scripts/bpmn/rules.js` only. The docs gate routes a claim to the DMN engine when its own line says
"DMN", and to the BPMN engine otherwise — so an unqualified DMN sentence fails the gate, which is
the ambiguity worth failing on.

## Conventions

- ES Modules (`import`/`export`) — no CommonJS
- Node `>=20` (declared in `package.json` `engines`; CI tests 20 and 22)
- Runtime deps (6): `elkjs`, `bpmn-moddle`, `dmn-moddle`, `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats`. Dev deps: `jest`, `@jest/globals`, `bpmn-auto-layout`. No new deps without prior discussion.
- Config in `config.json`, not hardcoded
- Functions are pure (no global state except `CFG`)
- IDs in Logic-Core: `^[a-zA-Z_][a-zA-Z0-9_-]*$`
- XML escaping via `esc()` from `utils.js`
- Coordinates in the internal `coordMap` contract (`{ coords, laneCoords, poolCoords, edgeCoords, edgeLabels }`, and its DMN analogue) are always `{ x, y, w, h }` — **`w`/`h`, not `width`/`height`**. Only the emitted DI attributes (`dc:Bounds`) use `width`/`height`; `bpmn-xml.js` and `svg.js` translate on the way out.

### Security defaults (HTTP API + MCP)

- `BPMN_API_KEY` env var: required in production (`NODE_ENV=production`), optional in dev. Startup fails if production + missing key.
- `AUDIT_LOG_PATH` env var: where the audit JSONL is written. Default `<os.tmpdir>/bpmn-generator/audit/bpmn-generator.jsonl`.
- `DEAD_LETTER_PATH` env var: where failed webhook deliveries are written. Default `<os.tmpdir>/bpmn-generator/dead-letter/`.
- SSRF: callback URLs are validated against IPv4 private/link-local ranges (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x), IPv6 (::1, fc00::/7, fe80::/10), and the hostname is DNS-resolved with the resolved IP re-checked against the same denylist.
- Schema-strict gate: every Logic-Core input at the HTTP entry passes through `scripts/bpmn/schema-gate.js` (ajv draft-2020-12) before reaching the pipeline. LLM output is never trusted raw.
- Body size cap: 10 MB. Rate limit: 30 req/min per IP. Both in `scripts/http-server.js`.

See `SECURITY.md` for the threat model and deployment guidance.

## Do NOT

Anti-patterns that have caused real problems in this codebase. Each rule has a reason; understand it before deciding the rule does not apply.

- **No `require()` or CommonJS.** This is an ES-Modules project (`"type": "module"`). A single `require()` breaks everything downstream. If a CommonJS-only dep is unavoidable, use dynamic `import()` with explicit interop wrapping.
- **No new runtime dependencies without prior discussion.** Current deps: `elkjs`, `bpmn-moddle`, `dmn-moddle`, `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats` (`ajv` + `ajv-formats` added in v3.3 for the JSON Schema strict-gate; `dmn-moddle` added for DMN 1.3 XML serialisation — GATE 1 in `docs/superpowers/plans/2026-07-30-dmn-integration.md`, its three transitive dependencies identical to already-installed `bpmn-moddle`'s). Each was a deliberate choice. Adding another widens the threat surface and the supply-chain risk — propose it before installing.
- **Never compute geometry in a renderer.** If `svg.js` or `bpmn-xml.js` needs a coordinate that is not in `coordMap`, the fix is to add it to `coordMap` — not to compute it locally. Computing it locally means computing it twice, and the two copies drift silently because nobody compares the SVG against the DI. This produced three separate defects: the lane header strip, message flow routes (SVG drew a dog-leg while the DI carried a diagonal cutting through a pool), and association endpoints. The guard is the test `geometry contract — the two renderers agree`.
- **Do not use `elk.partitioning` for lanes.** In `elk.layered` a partition is a group of **layers** along the flow direction, not a horizontal band. Setting partition = lane index forces every node of the first lane before every node of the second, so a lane that acts mid-process gets pushed past the end event and its outgoing flow runs backwards. Lanes own the y axis (`coordinates.js` §5.0a), ELK owns x. This was live for a long time and produced semantically misleading diagrams that every rule called green.
- **A green validation says nothing about the layout.** The rule engine never sees a coordinate. Any change to `layout.js`, `coordinates.js` or `visual-refinement.js` must be checked against `result.diagnostics` (`di-check.js`), not just against `validation.errors`.
- **No blind golden-file regeneration.** When a `.expected.bpmn` or `.expected.svg` test fails, inspect the diff first. The test is the alarm — silencing it without understanding is how real regressions enter master.
- **No LLM output downstream without schema validation.** Any path that lets `references/input-schema.json` be bypassed is a bug. The pipeline assumes well-formed Logic-Core; an LLM that emits malformed JSON should be caught at the gate, not crash at `layout.js`.
- **No hard-coded constants where `config.json` applies.** Shapes, colors, spacing, font metrics all live in `scripts/config.json` and are loaded via `utils.js → CFG`. Hard-coding bypasses profile customization and tests.
- **No `git add .` or `git add -A`.** Always stage specific paths. The repo has `audit/`, `dead-letter/`, `tests/robustness-reports/` that produce artifacts which must not be committed.
- **No amending of published commits.** Once a commit is pushed (especially to `master`), amend rewrites history that others may have pulled. Make a new commit; the history stays honest.
- **No skipping pre-commit hooks (`--no-verify`).** Hooks exist for a reason. If a hook fails, fix the underlying issue. The exception is when the user explicitly asks for `--no-verify` for a specific commit.

## CLI

```bash
# Standard: JSON → BPMN + SVG
node bpmn/pipeline.js input.json output-basename

# Stdin:
cat input.json | node bpmn/pipeline.js - output

# With DOT export:
node bpmn/pipeline.js input.json output --dot

# DOT → Logic-Core JSON:
node bpmn/pipeline.js graph.dot output --import-dot

# BPMN → Logic-Core (Round-Trip):
node bpmn/import.js existing.bpmn extracted.json

# With documentation export:
node bpmn/pipeline.js input.json output --doc

# Abort (no files written) on any unresolved warning — rule engine, DI, or serialization:
node bpmn/pipeline.js input.json output --strict

# Enable the opt-in Optimization Advisory layer (soll/optimize mode):
node bpmn/pipeline.js input.json output --optimize

# Start MCP server:
node mcp-bpmn-server.js
```

## Known Limitations

- Rule placeholders: M05-M06 (Style) registered with severity=OFF (POS tagger problem; tracked in ROADMAP)
- No Camunda extensions (`camunda:` namespace)
- DOT import is a subset parser (only output from `logicCoreToDot` is guaranteed round-trip)
- Round-trip fidelity (BPMN→Logic-Core→BPMN) verified for ~25 OMG examples + unit tests; not exhaustive across all BPMN element types. Two classes were recently added to that coverage after both turned out to be lossy: text annotations and groups (the primary importer walked only `flowElements`, where bpmn-moddle never places an Artifact), and **subprocess children**, which reached the XML with only their id and name — documentation, loop/multi-instance, script, `calledElement`, `gatewayDirection` and the mandatory `attachedToRef` were all dropped, grandchildren entirely. Both directions were affected, so the round trip looked intact while both ends lost the same fields. The guard is now a field-set comparison over `tests/fixtures/subprocess-child-fidelity.json`, not a per-field assertion
- Boundary events are placed deterministically on the bottom edge of their host and their outgoing flow is re-routed there (`coordinates.js` §5.0-). ELK does not lay them out; a host carrying many of them will spread them evenly rather than optimally
- Artifacts (annotations, data objects, data stores) are placed below the element they are associated with, stacked. They are kept out of the ELK graph on purpose: an artifact without an association is disconnected and ELK hands it the first layer — measured, an unattached data store pushed the start event 184 px right
- Participant ordering is exact up to 8 participants and heuristic above. Some crossings are unavoidable: a communication cycle across three or more participants cannot be linearised, which is why DI05 is a WARNING
- The DI check (`di-check.js`) covers participants, lane bands, node containment and message flow crossings. It says nothing about sequence-flow crossings, label collisions or readability
- A single-process Logic-Core (no `pools`) may omit `id` — `input-schema.json`'s `SingleProcess`
  branch doesn't require it, unlike `Pool`. `bpmn-xml.js` has no fallback for that case, and the
  result is a `bpmnElement="undefined"` reference in the DI, plus (with lanes present) a phantom
  black-box pool on re-import and a `TypeError` in `dot.js` on the public `logicCoreToDot` path. No
  fixture or test exercises this branch end-to-end (tracked in #37; `--strict` now surfaces the
  `unresolved reference <undefined>` warning this produces, but nothing fixes it)
- No ESLint — CLAUDE.md's own "Do NOT" rules (no CommonJS, no hard-coded constants where
  `config.json` applies, etc.) are enforced by review convention, not tooling (#32)
- No test coverage collection or threshold gate — `npm test -- --coverage` works, nothing runs it
  in CI or reports the result (#33)

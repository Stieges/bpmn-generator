# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **`--refine` CLI flag.** 14 of the 28 golden fixtures (`*.refined.*`, visual refinement enabled)
  had no documented way to regenerate them — `pipeline.js` parsed `--dot`/`--doc`/`--drill-down`/
  `--strict`/`--optimize` but nothing for `visualRefinement`, and `CONTRIBUTING.md`'s regeneration
  loop covered only the other 14 (`.expected.*`). `node bpmn/pipeline.js input.json out --refine`
  closes that gap; omitting the flag leaves the pipeline's own default unaffected.
- **DI07 — a sequence-flow endpoint not on its own node's shape.** The exact class of defect
  `compactLanes` had (below) now has a permanent runtime guard in `scripts/bpmn/di-check.js`,
  checked on every pipeline run rather than only where a test happened to look. Message flows and
  associations are intentionally out of scope — DI05 and the geometry-contract tests already cover
  those.

### Fixed
- **`compactLanes` shifted every edge in the collaboration, not just its own — the largest defect
  this project's layout-quality analysis found.** It shrinks a lane and moves everything below it up
  by the freed space; that shift was scoped to the pool being compacted for nodes, but walked every
  edge in the whole collaboration for waypoints. Compacting one participant's lane therefore dragged
  every *other* participant's edges upward without moving their nodes. Measured with
  `visualRefinement: true` before the fix: 34 detached edge ends in `realistic-collaboration`, 16 in
  `multi-pool-collaboration`, 34 in `bpmn-generator-pipeline`, 0 in every single-pool fixture — the
  single-pool zero is the control that pins the cause to cross-pool scope. Edge and label ownership
  is now resolved per pool, and every participant positioned below the one being compacted shifts as
  a rigid body — box, lanes, every node (recursively, so a subprocess child no longer gets left
  behind by its own parent), and every owned edge's waypoints and label — mirroring
  `coordinates.js`'s `shiftParticipant`. `multi-pool-collaboration.refined.{bpmn,svg}` — the one
  golden pair this touches — was regenerated with a reviewed diff; every other golden is untouched.
- **A boundary event's flow could leave through its own host.** A boundary event straddles its host's
  outline, so half of it sits inside the host; the exit side was chosen purely from where the target
  lies, which for a target on the far side routed the flow through the host's body — it then reads as
  if the flow came out of the activity itself. The route is now rebuilt outward whenever the default
  would enter the host's *interior*, tested strictly so that a flow running along the outline stays
  untouched. That distinction is load-bearing: artifacts are stacked directly below their anchor, so
  forcing every boundary flow downward would have driven `all-element-classes`'s flow straight through
  the data object under the same host. Clearance is `layout.boundaryExitClearance` and must stay below
  `visual-refinement.js`'s lane-compaction padding, or compaction strands the corridor waypoint.
  Measured: `realistic-collaboration` drops from two sequence-flow crossings to none.
- **A boundary event inside a subprocess kept its host-anchored route.** The pass that discards ELK's
  boundary routes and rebuilds them from the event walked only top-level `proc.edges`, so a boundary
  event nested in an expanded subprocess was never corrected and its arrow visibly started at the host
  shape (`tests/fixtures/subprocess-child-fidelity.json`, edge `c_f10`). Both the discard and the
  re-route now use `flattenProcessEdges`. Same failure mode CLAUDE.md documents under "Adding a
  per-node field": a recursive structure handled at one level only.
- The three identical copies of the from-scratch orthogonal route construction (§5.0e, §5.2, §5.5 in
  `scripts/bpmn/coordinates.js`) are now one `orthogonalConnect` helper. §5.2's long-standing
  asymmetry — always exiting right and entering left — is preserved behind a flag rather than
  silently "fixed", since changing it would move edges in fixtures that have golden files.
- **A rebuilt edge route could cross where ELK's route did not.** `coordinates.js` discards a route
  whenever the lane-band shift moves its endpoints by different deltas (§5.0a) or its source is a
  boundary event (§5.0-), and rebuilds it as a fixed 4-point Z whose axis is picked from
  `|dy| > |dx|` alone — no obstacle test, no crossing test. A new `repairCrossings` pass in
  `scripts/bpmn/edge-simplify.js` looks for the crossings that produces and tries alternative
  orthogonal routes for the edges involved, keeping the clipped endpoints and the side of the shape
  they attach to. It is a no-op unless a crossing actually exists, so crossing-free diagrams —
  every golden fixture among them — are untouched. Opt out with `layout.crossingRepair: false`.
  Measured: the rework loop in `tests/fixtures/bpmn-generator-pipeline.json` goes from three
  crossings to two. The remaining two, and the two in `realistic-collaboration.json`, sit where
  every candidate corridor runs through a node; clearing those needs real pathfinding, which this
  pass deliberately is not.
- **The layout-quality metric counted correct behaviour as a defect.**
  `scripts/bench/layout-metrics.mjs` asked whether a link's endpoints share a center-y without
  asking whether they structurally could, so cross-lane links, row folds in a wrapped layout, and
  nodes ELK had placed on their branches' barycenter all registered as misalignment. It reported
  40% alignment on `sparse-lanes` where in truth every alignable link was already exact. Alignment
  is now decided by an explicit alignability rule that names why each excluded class is not a
  defect, and area gained an aspect-ratio column plus a note that it is not comparable between raw
  ELK and the pipeline. `docs/layout-quality-analysis.md` is corrected accordingly.

## [3.6.0] - 2026-08-01

### Added
- **Scenario enumeration — every path a token can take, listed instead of drawn.**
  A new opt-in subsystem, `scripts/scenarios/`, implementing
  `docs/superpowers/plans/2026-08-01-scenario-enumeration.md`. The rule engine only ever sees the
  generated Logic-Core, never the text it came from, so it cannot notice that an XOR should have
  been an AND. This lists the distinct executions so a reviewer can spot a missing or wrong
  scenario in a list, where it is findable, rather than in a diagram, where it is not.
  - **CLI + public API** — `scripts/scenarios/pipeline.js` (`runScenarioPipeline`):
    `node scenarios/pipeline.js input.json out [--decisions <files>] [--strict]`, writing
    `out.scenarios.json` and `out.scenarios.md`. Mirrors `scripts/dmn/pipeline.js`'s idiom.
    Every document, pooled or not, is routed through the collaboration pair — the composed net is
    a strict superset of the plain one, and it is the only path that yields `SC06` coverage.
  - **Six analytical modules.** `enumerate.js` walks one process's Petri net; `collaboration.js`
    composes the per-pool nets over message flows and drives the same traversal;
    `decision-table.js` computes hit-policy-aware branching plus gap/overlap analysis;
    `bridge.js` resolves a BPMN `decisionRef` to a DMN decision table; `format.js` produces the
    machine (JSON) and human (Markdown) views; `rules.js` is the one module allowed to judge.
  - **Reuses `bpmnToPN` rather than forking it.** `scripts/bpmn/workflow-net.js` gained only
    additive exports (`getEnabledTransitions`, `fireTransition`, `encodeMarking`, and
    `flatNodes`/`flatEdges` on the returned net); WF01–WF03 verdicts are byte-identical.
    `checkSoundness`'s own traversal is deliberately NOT reused — it deduplicates markings, which
    is right for "is the sink reachable?" and wrong for "which distinct paths reach it?".
    Termination instead rests on a per-backward-edge bound plus caps from `config.json`.
  - **Six rules, `SC01`–`SC06`, all WARNING-tier**, counted separately from both existing engines:
    SC01 a branch no enumerated scenario reaches, SC02/SC03 a `decisionRef` resolving to nothing
    or to more than one table, SC04/SC05 a decision table gap or an overlap illegal under
    `UNIQUE`, SC06 improper completion at a scenario's shared sink. SC01 declines to judge three
    situations outright rather than guess: cyclic gateways, truncated runs, and runs containing
    dead-end paths — in each, "absent from every completed scenario" stops meaning "never taken".
  - **Incompleteness is part of the output, not a footnote.** Both written files carry the
    enumeration's own bookkeeping (`deadEndPaths`, `truncated`, `cappedPaths`,
    `lengthTruncatedPaths`, `orGateways`, `skipped`, and the collaboration's message-flow
    fields), and the CLI prints two channels: `⚠ Enumeration completeness` for a run that did not
    finish the job (`--strict` blocks on it, so a totally failed run cannot pass), and
    `💡 Enumeration notes` for what the Petri-net translation structurally cannot see — an OR
    split fired as an AND, an unmodelled `eventBasedGateway`, a message flow with a black-box
    end. Without this an input whose every path deadlocks reported `✓ Scenarios enumerated: 0`
    at exit 0.
  - Deliberately out of scope: any business-sense judgment. Whether a process is *reasonable* is
    not a question this subsystem is allowed to answer.
- **DMN 1.3 XML + DMNDI generation — a real `.dmn` file now exists.**
  `scripts/dmn/dmn-xml.js` (`generateDmnXml`, `validateDmnXml`) and `scripts/dmn/pipeline.js`
  (`runDmnPipeline` + CLI), completing Stages 3–4 of
  `docs/superpowers/plans/2026-07-30-dmn-integration.md`.
  - New runtime dependency: `dmn-moddle@12.0.1`, symmetric to `bpmn-moddle` on the DMN side —
    GATE 1, its three transitive dependencies identical to the already-installed `bpmn-moddle`'s.
  - Requirements nest under their target element with the `href`-wrapper form
    (`dmn:DMNElementReference`, a string, not an object reference — the opposite pattern from
    `dmnElementRef`, which is). No literal `<decisionLogic>` element is emitted — DMN13.xsd has no
    such element, only a comment over an `expression` substitution-group slot; the serialised child
    is the concrete expression type directly (`decisionTable`, in every case this project produces
    today).
  - Attribute discipline against the four DMN 1.3 types that do not extend `tDMNElement` and
    therefore carry no `id` (`tRuleAnnotation`, `tRuleAnnotationClause`, `tDMNElementReference`,
    `tBinding` — the last structurally unreachable today, no `invocation` expression support yet).
  - `usingTask`/`usingProcess` now accept a string or an array in Decision-Core (additive schema
    change), covering DMN13.xsd's `0..unbounded` cardinality.
  - XSD-validated via `xmllint` against `references/omg-spec/normative/dmn/DMN13.xsd` (Jest test
    skips when the tool is absent), round-tripped through `dmn-moddle` and compared by field set —
    not field by field, the same defect class that was invisible twice on the BPMN side (#36, #42) —
    and exercised with two diagrams so the `DMNDiagram*` writer loop is not dead code.
  - The `hitPolicy`/`preferredOrientation` normalisation on write was measured against the real
    library rather than assumed from the XSD (which treats both attributes identically) — recorded
    in `tests/fixtures/dmn/README.md`.
  - Golden file: `tests/fixtures/dmn/discount-decision.expected.dmn`.
  - **Not yet done:** the importer (DMN → Decision-Core), SVG rendering, and the MCP/HTTP tool
    surface — Stages 5–7 of the integration plan, tracked there.
- **Decision-Core: a schema and a layered rule engine for DMN input.**
  `references/decision-core-schema.json` (ajv draft-2020-12, strict) plus `scripts/dmn/` with 17
  rules in 3 layers and 2 modes. Field set decided against the normative DMN13.xsd, which dictated
  two constraints that would not have been guessed: `name` is mandatory on every DRG element
  (`tNamedElement`) and `namespace` on the document (`tDefinitions`).
  - **`soundness` (ERROR)** — D01 dangling requirement references, D02 cycles, D03 impermissible or
    mislabelled requirement pairs, D04 decision table without an output clause, D05 rule rows that
    do not match the table width, D09 Collect operator over a compound output, D10 `PRIORITY`/
    `OUTPUT ORDER` without output values, D11 crosstab that is not `UNIQUE`.
  - **`semantics` (WARNING)** — D06 decision without logic, D07 orphaned input data, D08
    `aggregation` without `COLLECT`.
  - **`best_practice` (WARNING, opt-in)** — B01 avoid `FIRST` (the specification's own position),
    B02 table size, B03 decision without a stated question, B04 untyped input data, B05 knowledge
    source nobody can look up, B06 requirement chain depth. Thresholds in `config.json → dmn`.
  - Modes `semantic` (default) and `best-practice`, mirroring `document`/`optimize`. A model being
    documented as it is should not be nagged about how it ought to look. Profiles in
    `rules/dmn-*.json` and project-specific ones under `rules/custom/` — loaded by path, never
    scanned, so dropping a file in cannot change behaviour silently.
  - **D03 checks pairs, not endpoints.** DMN 1.3 §6.2.3: "the type of the requirement is uniquely
    determined by the types of the two elements connected". An endpoint check has holes in both
    directions — it accepts `decision → decision` labelled *authority*, and the first version of
    this rule wrongly rejected `knowledgeSource → businessKnowledgeModel`, which Table 2 permits.
  - Deliberately out of scope: `decisionService`, boxed-expression types beyond decision table and
    literal expression, `itemDefinition`, and completeness/overlap analysis.
  **This does not yet produce a `.dmn` file** — that is Stage 4 of
  `docs/superpowers/plans/2026-07-30-dmn-integration.md`. Counted separately from the BPMN engine;
  the docs gate routes a claim to the DMN engine only when its line says "DMN".
- **`scripts/shared/rule-profile.js`** — `loadRuleProfile`, `isRuleEnabled` and `getEffectiveSeverity` lifted
  out of `rules.js` and shared by both engines. Nothing about them was BPMN-specific, and a severity
  override applying to one engine but not the other would have been the same duplication defect this
  codebase has already paid for three times. Re-exported from `rules.js`, so no importer changes.
- **`decisionRef` on a Business Rule Task** — records *which* decision a task invokes. Until now the
  element said "a rule set decides here" and nothing said which one. Serialised into
  `<bpmn:extensionElements>` under the generator's own namespace (`EXTENSION_NS` in `utils.js`), read
  back by both importers, covered by the field-set round-trip guard. Deliberately **not**
  `camunda:decisionRef`: BPMN 2.0 defines no attribute for this link, and emitting a vendor one would
  make every file claim a binding it does not have. The reverse direction is standardised — DMN's
  `tDecision` carries `usingProcess`/`usingTask` — and is where the DMN side will attach.
- **Rule M11** (Style, WARNING): `decisionRef` on anything other than a `businessRuleTask` is inert.
  A warning rather than an error, because the file stays valid BPMN — `tExtensionElements` is
  `<xsd:any namespace="##other">`, so the child is legal anywhere. Rule count 33 → 34.
- **Docs gate proof #4 — `checkDocPaths`.** Every `scripts/`-, `references/`-, `rules/`-,
  `tests/`-, `docs/`-, `frontend/`- or `.github/`-shaped path string mentioned in prose (plus
  every `node <file>.js` CLI example) must resolve to a real file or directory, or be covered by
  a reasoned allowlist entry for transient/generated paths. Guards against exactly what a later
  restructure commit is about to do: move dozens of files and touch every doc reference to them.

### Fixed
- **An `exclusiveGateway` used as a join was analysed as an AND-join, deadlocking by
  construction.** `scripts/bpmn/workflow-net.js`'s implicit-merge rewrite (one Petri-net
  transition per incoming edge, so any single arrival fires it) only applied to non-gateway
  nodes — a task with two incoming flows got it, but an exclusiveGateway with two incoming flows
  and no more than one outgoing flow (an ordinary XOR-join, same shape, just gateway-typed) fell
  through to the default single-transition path instead, which requires a token from *every*
  incoming edge at once. An XOR split feeding such a join can structurally never deliver both, so
  WF01/WF03 reported a deadlock on two real fixtures — `dense-edge-labels.json`, `multi-pool-
  collaboration.json` — despite both being correctly-modelled, ordinary joins. Found while
  investigating a misattributed finding in the new scenario-enumeration subsystem (below); the
  fix lives in the shared translation both engines use, so both benefit.
- **A build artifact outranked the source of truth.** `npm pack` — including the `--dry-run` the
  docs gate runs for its package-integrity check — executes `prepack`, which copies
  `references/input-schema.json` and `prompt-template.md` into `scripts/references/` so the npm
  tarball can carry them (npm's `files` field cannot reach outside the package root). Nothing removed
  the copy afterwards, and both runtime readers preferred it over the repo-root source. So after
  running the docs gate once, every later edit to `references/` silently had no effect — and because
  the directory is gitignored, `git status` said nothing either. For `prompt-template.md` no test
  would ever have noticed. Neither CI (separate workflows, separate checkouts) nor the published
  package (prepack refreshes the copy immediately before packing) was affected — this was a
  developer-experience defect, and a quiet one.
  The precedence is now inverted: the source wins, the in-package copy is the fallback. Resolution
  moved into one place, `scripts/shared/resource-paths.js`, replacing two copies of the same logic that
  carried different `..` depths and had no test between them. A `postpack` step removes the artifact
  so it no longer outlives the build. Script count 30 → 31.
- **Subprocess children reached the XML with only their id and name.** The child branch of
  `buildProcess` was a hand-rolled subset of the top-level node loop, so `documentation`,
  standard-loop and multi-instance characteristics, `scriptFormat`, the script body,
  `calledElement` and `gatewayDirection` were all dropped — silently, because bpmn-moddle reports
  unknown attributes but never fields that never arrived. Per-node work now lives in one recursive
  `buildFlowNode` that both paths share.
- A boundary event on a subprocess child never received the mandatory `attachedToRef` (OMG
  `[1..1]`), producing invalid BPMN with `validation.errors: []`. The resolution pass now covers
  every nesting level.
- Nested subprocesses lost every grandchild — the child branch did not recurse. Layout already
  did, so the geometry was correct and only the semantics were missing.
- Both importers mirrored the same loss (children came back as `{id, type, name, marker}`), so the
  round trip appeared intact while both ends dropped the same fields.
- **Rule S13** collected activities recursively but checked only the top level. It now checks every
  level, and additionally verifies containment — a boundary event and its activity must share a
  container, so a top-level boundary event reaching into a subprocess is no longer accepted.

- **Text annotations and groups lost their label in the generated XML.** Per OMG Semantic.xsd an
  Artifact extends BaseElement, which declares only `id` — `name` is illegal on `TextAnnotation`
  and `Group`, and bpmn-moddle accepted it silently instead of rejecting it. Annotations rendered
  as empty boxes in every BPMN tool. The label is now emitted where each class keeps it: a
  `<bpmn:text>` child for annotations, a referenced `CategoryValue` for groups. Logic-Core is
  unchanged — `name` remains the single caption field on input.
- Artifacts were serialised into `<bpmn:flowElements>`; `tProcess` is an `xsd:sequence`
  (`laneSet*, flowElement*, artifact*`), so they now go to `<bpmn:artifacts>`. Association endpoint
  resolution widened to match, so associations onto an annotation are no longer dropped.
- `Lane/flowNodeRef` listed text annotations, groups and data references. It is typed `FlowNode`
  and none of those qualify.
- The bpmn-moddle importer walked only `flowElements`, where artifacts never appear — every
  annotation and group was dropped on import, leaving associations pointing at ids that no longer
  existed. Both importers now read the current form and fall back to the pre-fix `name`, so
  existing files still load.

### Changed
- **Modular layout: `scripts/bpmn/`, `scripts/dmn/`, `scripts/shared/`.** The BPMN pipeline
  (22 modules incl. both importers and the redesign toolbox) moved to `scripts/bpmn/`; the
  format-independent core (`utils`, `rule-profile`, `resource-paths`) to `scripts/shared/`;
  standalone tooling stays top-level. Preparation for a third notation — every notation gets
  the same internal shape. **The npm API is unchanged** (`exports` maps the public
  specifiers onto the new paths; no shims, no major bump). CLI invocations change:
  `node bpmn/pipeline.js …` from `scripts/`. Behaviour is provably identical — generated
  outputs are byte-identical against the pre-move baseline.
  `scripts/shared/utils.js` now carries only what both engines use; the 13 BPMN-only layout
  constants (`SHAPE`, `SW`, `CLR`, lane/label/gap/padding sizes) moved out to
  `scripts/bpmn/constants.js` — `dmn/` imports none of them. Same guarantee: byte-identical
  outputs against the pre-move baseline.
- A subprocess's content is now serialised whether or not it is expanded. `isExpanded` is a
  presentation property and stays confined to the DI (`BPMNShape`); gating the content on it made
  "collapsed but drillable" — legal BPMN — inexpressible and produced an empty box. Both importers
  read `isExpanded` from the DI instead of inferring it from the presence of content.
- The CLI now prints BPMN serialisation warnings (the bpmn-moddle round trip over the generated
  XML) as their own section, and `--strict` aborts on them — consistent with how it already treats
  rule warnings and diagram diagnostics. The field (`validation.xmlWarnings`) already existed and
  already fired; nothing read it, so invalid output reported success and exited 0. No behaviour
  change without the flag beyond the added output.

## [3.6.0] — 2026-07-29

> **Gap notice.** No entries were recorded here between `[3.3.0]` and `[3.6.0]`, although
> six releases and several feature merges shipped in that time: v3.4 (#15), v3.5 (#16),
> v3.5b (#17), v3.5c/v3.5d (#18), plus PRs #19, #21, #23, #24, #25 and #27. Those
> entries are not reconstructed retroactively — the pull requests are the record for
> that period. The docs gate added below exists to stop this recurring.

### Added
- **DI integrity check** (`scripts/di-check.js`) — a post-layout pass over the produced
  geometry, reported under `result.diagnostics` (separate from `validation`, which never
  sees a coordinate). Codes DI01 (identical participant positions), DI02 (overlapping
  participants), DI03 (node outside its participant), DI04 (overlapping lane bands),
  DI06 (child outside its expanded subprocess) — all ERROR; DI05 (message flow crossing
  an uninvolved participant) — WARNING, because a communication cycle across three or
  more participants cannot always be laid out without one.
- **`poolOrder` option** (`runPipeline`, `/api/v1/generate`, MCP `generate_bpmn`) —
  `"auto"` (default) stacks collaboration participants so the ones exchanging messages
  sit next to each other; `"declared"` keeps the input order.
- **Rule S13** — a boundary event must reference an existing activity (OMG §10.4.3).
- **Geometry for artifacts and associations** — text annotations, data objects/stores
  and their associations now get placed coordinates and reach the DI as shapes/edges,
  not just as XML semantics.
- **MCP `include` and `ruleProfile` parameters** on `generate_bpmn` — `include` selects
  which of `xml`/`svg`/`validation`/`diagnostics` to return (default: all four);
  `ruleProfile` loads a rule profile JSON, e.g. `rules/strict-profile.json`.
- **Message flow routing** — flows now get a real route in `coordMap` (through the gap
  between the two participants involved, fanning out when several flows share a
  corridor) instead of being improvised independently by each renderer.
- Fixtures `tests/fixtures/realistic-collaboration.json` (six participants, boundary
  event, black box, message flows) and `tests/fixtures/all-element-classes.json`.
- **Docs gate** (`.github/scripts/docs-gate.mjs`, CI) — validates the HTTP response
  contract (`references/api-schema.json`), rule/script counts, DI codes, and npm package
  integrity against the running code instead of trusting the prose; see `CLAUDE.md` →
  Docs gate.

### Fixed
- Participant id collision when a collaboration had more than one laned pool (all
  shared the ELK id `'pool'`).
- Participant stacking collapsing onto identical positions from four participants on.
- Boundary events aborting the pipeline (`JsonImportException`) instead of being laid
  out on their host's border.
- Lane ordering: `elk.partitioning` was misused for lane bands (it groups layers along
  the flow direction, not horizontal bands), which could push a mid-process lane's
  outgoing flow backwards.
- Lane compaction (`visual-refinement.js`) shrinking a band without moving its top edge,
  dropping the lowest nodes out of the pool.
- Expanded-subprocess children not moving with their parent when a lane band shifted
  (only reproducible with more than one lane, so the single-lane fixture missed it).
- Text annotations, data objects/stores and associations were semantically present in
  the XML but had no DI shape/route, making them invisible in every BPMN tool.
- Message flows: the SVG drew a dog-leg while the DI carried a diagonal, and the
  diagonal's horizontal leg could land inside the neighbouring pool.
- A boundary event with a dangling `attachedTo` produced a `boundaryEvent` without the
  mandatory `attachedToRef` and an edge with zero waypoints, while validation reported
  green — now caught by rule S13.
- `validate_bpmn` (MCP) silently dropped `infos` and `metrics` from the validation
  result; `generate_bpmn`/`validate_bpmn` (MCP) had no schema gate (only
  `orchestrate_bpmn` did); `generate_bpmn`'s `drillDown` ignored `mode`, so
  drill-down plus `optimize` returned no advisories.
- `/api/v1/orchestrate` dropped `diagnostics` from its response even though the
    orchestrator computed it and the MCP `orchestrate_bpmn` tool already returned it.
  - Published npm package threw on first import — `schema-gate.js` and
    `agents/prompt-sections.js` each read a file from `references/`, outside the package
    root, and `package.json`'s `files` cannot reach outside it. Fixed with a `prepack` copy
    step plus a dual-path runtime fallback.

  ### Changed
  - `diagnostics.ok` means "no ERROR-severity finding" — WARNING-severity findings (DI05)
    are reported but do not fail the gate.
  - The CLI now aborts and writes no files when an ERROR-severity geometry finding is
    present, alongside the existing validation-error abort.
  - Laned pools now get their frame drawn in the SVG at all (a missing `poolCoords`
    entry meant it was silently skipped before); the lane header band sits inside the
    lane, matching the emitted DI and bpmn.io.

  ## [3.3.0] — 2026-05-18

  ### Added
  - **SSRF complete coverage** — `callbackUrl` validation now blocks IPv4 link-local (169.254.x, including AWS metadata endpoint), IPv6 unique-local (fc00::/7), and IPv6 link-local (fe80::/10). Hostnames are DNS-resolved and the resolved IPs are re-checked against the same denylist, closing the `evil.com → 127.0.0.1` bypass.
  - **Production auth gate** — `BPMN_API_KEY` env var becomes mandatory when `NODE_ENV=production`. Server `startupCheck()` throws and refuses to bind. Dev mode (default) prints a prominent warning.
  - **JSON Schema strict-gate** — `scripts/schema-gate.js` validates every `body.logicCore` at the HTTP API entry (`/generate`, `/validate`, `/orchestrate` when logicCore is provided) using ajv draft-2020-12. LLM-generated Logic-Core from `orchestrator.js` is also gated before reaching the layout phase.
  - **`AUDIT_LOG_PATH` and `DEAD_LETTER_PATH` env vars** — runtime paths configurable for Docker / read-only filesystem deployments. Default: `os.tmpdir()/bpmn-generator/{audit,dead-letter}/`.
  - **`$schemaVersion` field** in `references/input-schema.json` — optional, `const: "1.0"`, backward-compatible (absent value still accepted).
- **`lane.nodeIds`** added to the schema — was supported by code (`topology.js`, `coordinates.js`, rule WF-L1) but missing from the JSON schema. Schema now declares it.
- **SECURITY.md** at repo root — threat model, deployment guidance, vulnerability reporting.
- **`ajv` + `ajv-formats`** as direct runtime dependencies (were already transitively present via bpmn-moddle — zero `node_modules` size delta).

### Changed
- **`server.listen()` is now guarded** by `isEntryPoint` so importing `http-server.js` no longer binds the port (fixes EADDRINUSE under Jest workers).
- CLAUDE.md: new "Security defaults" subsection; Do-NOT rule about new deps updated to list `ajv` + `ajv-formats`.

### Breaking
- **Default audit/dead-letter paths moved** from `<repo>/audit/` and `<repo>/dead-letter/` to `<os.tmpdir>/bpmn-generator/{audit,dead-letter}/`. Set `AUDIT_LOG_PATH` and `DEAD_LETTER_PATH` env vars to restore the old behavior or pin a deployment-specific location.
- **HTTP error response shape** for malformed input shifts from `500 internal_error` to `400 schema_error` with an `errors` array (ajv error objects). Clients relying on `500` for bad input will see `400`.
- **`NODE_ENV=production` without `BPMN_API_KEY`** now exits non-zero at startup. CI / deployment scripts that set NODE_ENV=production without providing a key will fail.

## [3.2.0] — 2026-05-18

### Changed
- **Documentation honesty pass** — eliminated drift between CLAUDE.md / README.md / ROADMAP.md and the code. Concrete fixes: rule count corrected to 27 (was claimed 26), CLAUDE.md module inventory expanded from 13 to the actual 37 .js files (23 root + 5 `agents/` + 9 `robustness/`), dependency convention now lists all 3 runtime deps (was claimed only `elkjs`), false "Timer events have empty `<timerEventDefinition/>`" Known Limitation removed (the feature is implemented).
- **CLAUDE.md restructured** with new Glossary (12 terms), Common Tasks (7 workflows), and Do-NOT (8 anti-patterns) sections.
- **`bpmn-generator-v3.skill` removed from git** — replaced by `npm run build:skill` (on-demand bundler at `scripts/build-skill.mjs`).
- README + ROADMAP point to `references/fachliches-regelwerk.md` as the authoritative rule catalog (single source of truth).

## [3.1.0] — 2026-03-23

### Added
- **bpmn-moddle integration** — CMOF-based XML serialization via `bpmn-moddle`, replacing the legacy string-builder. Full OMG BPMN 2.0.2 type system.
- **Round-trip XML validation** — `validateBpmnXml()` parses generated XML back through `moddle.fromXML()` to verify 0 warnings.
- **Cross-lane edge deconfliction** — Post-processing phase (§5.0f) nudges overlapping horizontal edge segments.
- **Golden-file regression tests** — Deterministic SVG/BPMN comparison against `.expected.*` files.
- **Pipeline self-diagram** — The generator produces its own BPMN diagram ([docs/bpmn-generator-pipeline.bpmn](docs/bpmn-generator-pipeline.bpmn)).
- **ELK layout optimization** — Happy-path edge priorities, `GREEDY_MODEL_ORDER` cycle breaking, high-degree node treatment, post-compaction, `favorStraightEdges`.

### Changed
- Port constraints reverted from `FIXED_SIDE` to `FREE` for better cross-lane routing.
- Pipeline self-diagram consolidated from 6 lanes to 4 lanes for cleaner layout.

### Fixed
- `triggeredByEvent` TypeError on SubProcess elements (eventDefinitions guard).
- Edge routing improvements for multi-pool diagrams.

## [3.0.0] — 2026-03-20

### Added
- **Multi-agent orchestration** — 4-agent pipeline: Modeler (LLM) → Reviewer → Layout → Compliance. Configurable iteration limits.
- **HTTP API** — 5 endpoints: generate, validate, import, orchestrate, health. Callback delivery with retry + dead letter queue.
- **MCP Server** — 4 tools: `generate_bpmn`, `validate_bpmn`, `import_bpmn`, `orchestrate_bpmn`.
- **Workflow-Net soundness checker** — Petri-Net verification (liveness, boundedness, deadlock-freedom). Rules WF01-WF03.
- **Training data pipeline** — `prepare-training-data.js` for BPMN-SLM fine-tuning. 1897 validated samples from 3734 BPMNs.
- **SLM evaluation** — `evaluate-slm.js` with pipeline-based metrics.

## [2.0.0] — 2026-03-15

### Added
- **Modular architecture** — 13 ES Modules with acyclic dependency graph. Each pipeline step independently replaceable.
- **Rule engine** — 25 rules across 4 layers (Soundness, Style, Pragmatics, Workflow-Net). Configurable JSON profiles.
- **BPMN-in-Color** — `bioc:stroke`/`bioc:fill` attributes on shapes. Per-node colors in XML + SVG.
- **Documentation view** — SVG tooltips + `--doc` Markdown companion.
- **Happy-path Y-leveling** — Post-layout alignment of happy-path nodes.
- **DOT format** — Graphviz export + import via `dot.js`.
- **Expanded sub-processes** — Container nodes with inline children, hierarchical ELK graph.
- **Transaction sub-process** — Double border, `<transaction>` tag (OMG §13.2.2).
- **Few-shot enterprise patterns** — 5 patterns: four-eyes, escalation, loops, compensation, event subprocess.
- **bpmn.io compatibility** — Verified with bpmn-js viewer.

## [1.0.0] — 2026-03-01

### Added
- Initial release: JSON Logic-Core → ElkJS Sugiyama layout → BPMN 2.0 XML + SVG.
- Multi-pool collaborations with message flows.
- All BPMN 2.0 task types, gateway types, event types.
- Boundary events (interrupting/non-interrupting).
- Lanes, collapsed pools, data objects, text annotations.
- Round-tripping via `import.js`.
- 30 tests (Jest, ES Modules).

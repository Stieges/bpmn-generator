# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **The extraction prompt contradicted the input schema.** The Master Extraction Prompt (the part
  the Modeler sends to the LLM) named a message flow with `label`, which the schema rejects (only
  `name`), and never mentioned `collapsedPools`, so an LLM following it returned an external
  partner as a pool with an empty `nodes` list. Every collaboration with an external partner failed
  the schema gate. The collaboration example is now a concrete, valid model with a
  `collapsedPools` entry, and the rules say when to use it. New fence
  `scripts/agents/prompt-examples.test.js`: every JSON example in the prompt passes the schema.
- **Refined and amended models skipped the schema gate.** The orchestrator validated only the first
  extraction; a Logic-Core from the reviewer loop or the layout loop went downstream unchecked. Every
  Modeler output now passes the gate. A rejected refinement or amendment is dropped, and the run
  goes on with the last valid model.
- **Orchestrator: one model from layout to result.** After the last layout pass the Modeler was
  still asked for an amendment, so the returned `logicCore` was not the model in `bpmnXml`, and
  compliance judged a model nobody had laid out. An amended model also skipped the reviewer, so an
  amendment could break soundness unnoticed. Now no amendment follows the last layout pass, and an
  amendment with reviewer errors is dropped, so the run keeps its model and layout. The layout
  review's answer is checked: `feedback` must be an array, items need a string `issue` and
  `suggestion`, and only `requiresLogicCoreChange === true` is structural (the string `"false"` was
  truthy). A failed review is noted in `history` (`reviewError`) and no longer swallowed, and no
  longer crashes the run on an object instead of an array.
- **One rule profile for every agent.** The reviewer and the layout pass used the default profile;
  only compliance applied the caller's `ruleProfile`. Under a stricter profile `validation` said
  fine while `compliance` said not compliant, and the refinement loop, which listens to the
  reviewer, never saw those errors. Reviewer, layout and compliance now resolve the same profile and
  `mode` (`resolveRuleProfile` in `bpmn/rules.js`, also used by `runPipeline`).
- **Schema errors of the wrong branch.** For a Logic-Core that fails the schema,
  `validateLogicCoreSchema` reported the errors of both root shapes, so a collaboration opened with
  SingleProcess's "must have required property 'nodes'". It now reports the errors of the shape the
  input was meant as (`pools` → collaboration). This also applies to `schema_error` responses over
  HTTP and MCP, whose format is unchanged. The orchestrator shows every real cause, one per line
  (`formatSchemaErrors`), not the first three as JSON.

### Added

- **Schema repair attempt in the orchestrator** (`maxSchemaRepairs`, default 1): a Modeler output
  the gate rejects goes back once through the refinement prompt with the gate's errors as issues.
  Every rejection is in `history` (`agent: "schema-gate"`).
- **`--timeout <seconds>`** on `node orchestrator.js` for the LLM request (default 120 s).
- **Retry against an unstable LLM endpoint.** `createLlmProvider` retries a transport error, a
  timeout or a 408/429/500/502/503/504 answer with exponential backoff and jitter, honouring
  `Retry-After` up to a cap (`config.json → llm.retry`: 3 retries, 2 s base, 30 s cap, Retry-After
  up to 60 s; per instance `retry`, `{ retries: 0 }` for one attempt). Other failures stay final at
  once. The error after the last attempt names the attempts (`LLM endpoint returned 503 (4
  attempts)`, `attempts` on `LlmProviderError`). It rides out a short outage or a burst of rate
  limiting, not an endpoint without capacity for minutes. CLI `--retries <n>`, with one stderr line
  per retry. Applies to the HTTP server and `evaluate-slm.js` too, so an LLM request there can now
  take up to `(retries + 1) × timeout` plus the waits.
- **Extra request fields for an endpoint** (`extraBody` on `createLlmProvider`, CLI
  `--extra-body '<json>'`, HTTP server `LLM_EXTRA_BODY` for its own endpoint only), e.g.
  `{"chat_template_kwargs":{"enable_thinking":false}}`. They cannot replace `model`, `messages`,
  `response_format` or `temperature`. An answer with only reasoning content and no content now says
  so instead of "empty response".

## [4.0.0-rc.1] - 2026-10-12

Release candidate for 4.0.0, published as a GitHub pre-release only (not on npm). The first
release since 3.6.0; every entry below is new since then.

### Migrating from 3.6.0

The details and every rollback switch are in the Breaking entries below; this is the checklist.

- **Default output changed.** Lane compaction, edge-label repair, the bend rule, node labels that
  avoid flows and the repair of flows through foreign shapes are on by default, and boundary events
  face their target. Every `.bpmn`/`.svg` produced with default options differs from 3.6.0. To
  switch the new passes off: CLI `--no-refine --no-bend-rule --no-label-avoidance
  --no-foreign-shape-repair`, the same keys over HTTP, MCP and `runPipeline`, or project-wide in a
  file named by `BPMN_CONFIG`. Edge-label placement and the boundary-event side have no switch.
- **`visualRefinement` keys.** `enabled` is ignored; `elkWrapping` and `elkWrappingNodeThreshold`
  moved to `layout.*`; `dynamicLaneHeader` (and its width keys) is removed; `--refine` no longer
  wraps (use `--wrap`); an unknown pass key in the object form is an error.
- **Colours.** `color.fill` / `color.stroke` accept only `#rgb` / `#rrggbb`.
- **CLI gates.** `--strict` also aborts on the new diagram warnings (DI08–DI11) and net-check
  warnings. Without it, duplicate node ids across sibling containers now abort (NC06; the file
  written before was invalid), and a `⚠ Petri-net diagnostics:` block can appear on stdout.
- **HTTP API and MCP.** `ruleProfile` is an inline object over HTTP and a profile name over MCP,
  never a path; HTTP profiles may only raise soundness rules; `correlationId` is
  `^[A-Za-z0-9_-]{1,64}$`; a client `llmConfig.baseUrl` needs `LLM_BASE_URL_ALLOWLIST`; provider
  failures are `502 llm_error`; dead-letter files are `<uuid>.json`; non-object JSON bodies are a
  `400`.
- **Rule profiles.** A profile file that is not JSON aborts; an unknown severity, or `ADVISORY`
  outside the optimization layer, refuses the profile.
- **Packaging.** The npm package no longer contains `robustness/` (run it from a checkout); the
  skill bundle is `bpmn-generator.skill` (was `bpmn-generator-v3.skill`).

### Breaking
- **`color.fill` / `color.stroke` accept only hex colours `#rgb` or `#rrggbb`.** Named and `rgb()`
  values are refused by the schema gate — convert them to hex. See `references/logic-core-schema.md`.
- **Bend rule and node labels that avoid flows are on by default.** `layout.bendRule` and
  `layout.nodeLabelsAvoidFlows` default to `true`: default output changes (fewer bends, flows enter
  activities and events in flow direction, event and gateway labels move off flows). Rollback, per
  call: CLI `--no-bend-rule` / `--no-label-avoidance`; HTTP `/api/v1/generate` and
  `/api/v1/orchestrate` and the MCP tools `generate_bpmn` / `orchestrate_bpmn` `"bendRule": false` /
  `"nodeLabelsAvoidFlows": false`; library `runPipeline(lc, { bendRule: false, nodeLabelsAvoidFlows:
  false })`. Project-wide: a file named by the `BPMN_CONFIG` environment variable,
  `{ "layout": { "bendRule": false, "nodeLabelsAvoidFlows": false } }` — merged over the shipped
  `config.json` (one level deep), so an npm install needs no edit inside `node_modules` — or the
  same two keys in `config.json` itself. With both off the output is byte-identical to before the
  bend rule for every committed fixture with two exceptions from #91 (below): `realistic-collaboration`,
  whose boundary event now sits on its host's top edge — permanent, no switch restores it — and any
  model `layout.foreignShapeRepair` re-routes (among the fixtures `example-rechnungspruefung`) unless
  that is switched off too. The hash fence now pins the output with all three off on current master.
  The SVG canvas change under Changed applies either way.
- **Sequence flows through a foreign shape are re-routed, and boundary events face their target
  (#91).** Default output changes for models where a flow ran through a task, event or gateway that
  is neither its source nor its target (DI11). Two changes:
  - A boundary event goes on its host's **top** edge when the target of its outgoing flow lies above
    the host — in a lane stacked above, or wholly above it in the same band — and stays on the bottom
    edge otherwise, and whenever the lane order cannot decide (a nested child lane, a node without a
    lane in a process that has lanes). Several events spread per side; on the top edge never in the
    middle, where a flow coming down into the host docks: over the half facing their targets (target
    straight above: the right half) when they fit side by side there, else over the whole edge with
    the middle slot left out, ordered by target x. Its label sits above it. Not switchable. Among the
    committed fixtures only `realistic-collaboration` changes: `inf8` leaves the timer upwards
    instead of running round `in_check` and through `in_gw`.
  - The stuck-end pass (`reclipStuckEnds`) also re-routes a sequence flow through a foreign shape —
    the routes `coordinates.js` §5.2 rebuilds for flows between lanes without an obstacle test, which
    no other pass was triggered by. A shape traversal may be traded for one crossing; a port where
    another flow of the same node enters or leaves in the other direction is given up for a free one.
    `layout.foreignShapeRepair` (default `true`). Rollback, per call: CLI
    `--no-foreign-shape-repair` (`--foreign-shape-repair` forces it on); HTTP `/api/v1/generate`,
    `/api/v1/orchestrate` and the MCP tools `generate_bpmn` / `orchestrate_bpmn`
    `"foreignShapeRepair": false` (schema `$defs/LayoutSwitchOption`); library
    `runPipeline(lc, { foreignShapeRepair: false })`; project-wide `{ "layout": { "foreignShapeRepair":
    false } }` in a file named by `BPMN_CONFIG`. The model #91 was found on is now the top-level
    fixture `tests/fixtures/example-rechnungspruefung.json` (from `negative/`): DI08 and four DI11 go,
    at the price of one crossing.
- **Default output is compacted.** Lane compaction (`visualRefinement.laneCompaction`) is now on by
  default, together with edge-label collision repair: diagrams with lanes or an expanded subprocess
  come out up to 29 % smaller in area (10–29 % on the seven golden fixtures; some diagrams are
  unchanged), and sequence flows between lanes are re-routed off the lane separators. Every
  `.bpmn`/`.svg` produced with default options changes. To get the pre-4.0 *lane geometry*: CLI
  `--no-refine`, library `runPipeline(lc, { visualRefinement: false })`, HTTP/MCP
  `"visualRefinement": false`, or project-wide `config.json -> visualRefinement.laneCompaction: false`
  and `edgeLabelCollisionRepair: false`. This does **not** restore the 3.6.0 output as a whole:
  edge-label placement changed in every mode (labels sit beside their flow, message flows carry a
  `BPMNLabel`, the SVG label backdrop is gone) and no switch brings that back. ELK wrapping stays
  opt-in.
- **`visualRefinement.enabled` is removed and silently ignored.** A project that set
  `config.json -> visualRefinement.enabled: true` now gets lane compaction and label repair (the
  defaults) but no wrapping. Migration: switch single passes with their own keys
  (`laneCompaction`, `edgeLabelCollisionRepair`), or use `--refine` / `--no-refine` for all of them.
- **`--refine` / `visualRefinement: true` no longer enable ELK wrapping.** Wrapping is its own
  switch: CLI `--wrap`, `runPipeline(lc, { elkWrapping: 'auto' })`, or `config.json ->
  layout.elkWrapping` (`"off"` default, `"auto"`, `"always"`).
- **`visualRefinement.elkWrapping` and `visualRefinement.elkWrappingNodeThreshold` moved to
  `layout.elkWrapping` and `layout.elkWrappingNodeThreshold`.** The old keys are silently ignored.
- **The `dynamicLaneHeader` refinement pass was removed** (with `laneHeaderMinWidth` and
  `laneHeaderMaxWidth`): bpmn.io and Camunda Modeler draw lane and participant headers at a fixed
  width, so a wider header showed as an empty strip. `--refine` / `visualRefinement: true` no longer
  change the header width; there is no replacement.
- **The object form of `visualRefinement` is validated.** An unknown pass key (`dynamicLaneHeader`
  included) or a non-boolean value is a `TypeError` in the library and a `schema_error` over HTTP
  and MCP. On 3.6.0 any truthy value switched every pass on. Accepted keys: `laneCompaction`,
  `edgeLabelCollisionRepair`.
- **`/api/v1/orchestrate` refuses a string `ruleProfile`** (it used to read it as a server-side path); send an inline object — see Security, "Rule profiles are treated as untrusted input".
- **MCP `ruleProfile` is a profile name, not a path** — see the same Security entry.
- **A profile file that is not valid JSON now aborts** instead of falling back to the defaults — see Changed, "Rule profiles are checked".
- **An unknown severity, or `ADVISORY` on a BPMN rule outside the optimization layer, refuses the profile** — see Changed, "Rule profiles are checked".
- **Inline profiles over HTTP may only raise soundness rules**, never disable the layer or lower a rule's default severity — see the same Security entry.
- **`correlationId` must be 1–64 characters from `[A-Za-z0-9_-]`** on every HTTP endpoint; anything else (other characters, other types, an empty string) is a `400` and is not echoed. A UUID passes. See Security, "HTTP API hardening".
- **A client `llmConfig.baseUrl` is refused by default** (`400`) on `/api/v1/orchestrate` and `/api/v1/chat`. Omit it to use the server-configured endpoint (`OPENAI_BASE_URL`, else the OpenAI default), or have the operator allowlist the origin in `LLM_BASE_URL_ALLOWLIST`. `llmConfig` now requires only `apiKey` and `model`.
- **LLM provider failures are `502 { correlationId, status: "llm_error" }`** instead of a `500` whose message carried the provider's response; the upstream detail is logged server-side only.
- **Callback URLs are refused for more address ranges** (CGNAT, `0.0.0.0/8`, benchmarking, multicast, reserved, IPv6 forms embedding an internal IPv4 address, `*.localhost`) and for URLs with credentials, and a callback that answers with a redirect is a failed delivery (it used to be followed).
- **Dead-letter files are named `<uuid>.json`** instead of `<correlationId>.json`; the correlation id is inside the file.
- **A JSON body that is not an object is a `400`**, and telemetry `details` larger than 8 KiB is a `400`.

### Added
- **DRD as SVG (DMN Stage 6).** `node dmn/pipeline.js input.json out` now writes `out.svg` next to
  `out.dmn`; `runDmnPipeline` returns it as `svg`. `scripts/dmn/svg.js` translates the same
  `coordMap` the DMNDI carries — no coordinate of its own, not even an offset — and draws the four
  DRG shapes and three requirement styles as dmn-js 17.12.3 draws them (path data in
  `scripts/dmn/pathmap.js`, attributed in `THIRD_PARTY_NOTICES.md`). `svg.test.js` fences DMNDI and
  SVG against the coordMap, the DMN twin of the BPMN renderer-agreement test.
- **Decision tables as Markdown, SVG and HTML.** `--doc` on the DMN CLI (`runDmnPipeline(dc, { doc:
  true })`) also writes `out.md` (per decision: question, inputs, outputs, the table),
  `out.tables.svg` and `out.tables.html` (`markdown`, `tablesSvg`, `tablesHtml`). One layout
  (`scripts/dmn/table.js`: hit-policy letter over the rule numbers, three-line heads "When/And/Then ·
  label · allowed values or type", annotation column only when used, column widths from text
  metrics), translated by `table-text.js`, `table-svg.js` and `table-html.js` (inline styles only,
  for a wiki page). Every word comes from `config.json → dmn.labels` — `en` by default, `de`
  available (`dmn.labels.locale`, or `locale` on the call).
- **A Business Rule Task's decision table in its BPMN documentation.** `runPipeline(lc, { decisions:
  [DecisionCore…] })`, CLI `node bpmn/pipeline.js lc.json out --decisions a.json,b.dmn` (`.dmn`
  imported, routed by content): every `businessRuleTask` with a `decisionRef` gets a plain-text
  section — title, hit policy, one sentence per rule — between `=== BEGIN generated: DMN decision …` / `=== END …` marker lines, after the author's own
  documentation. Every run replaces the section, so import → regenerate never duplicates it (both
  importers keep it as text). The rules are written as sentences ("Rule 1: WHEN Claim amount < 1000
  THEN level = "auto""), not as an aligned table, which falls apart in the proportional font of
  Camunda's properties panel. A decision decided by a literal expression shows its type and FEEL
  text — here and in the `--doc` Markdown, table SVG and HTML. Matching is `scenarios/bridge.js`'s,
  with a new `includeLiteralExpressions` option the scenario pipeline leaves off (SC02/SC03 keep
  their meaning); an unresolved reference reads "Calls decision: <ref> (table not supplied)". The
  SVG tooltip and the `--doc` Markdown show it.
  Without `decisions` the output is byte-identical (goldens and the output-hash fence unchanged).
  `bpmn/pipeline.js` now imports `cross/decision-doc.js` — the one import outside `bpmn/`, fenced so
  that no DMN or cross-notation rule module is in `runPipeline`'s import closure.
- **The skill confirms a decision table before generating it.** `SKILL.md` and `references/dmn.md`:
  show the table as Markdown in the chat, let the user confirm, then generate, then report the rule
  and scenario findings.
- **`role` and `system` on an activity.** Two optional Logic-Core node fields. `role` (any Activity:
  task, `subProcess`, `transaction`, `callActivity`) is written as BPMN standard — one
  `<bpmn:resource>` per distinct role name (id derived from the name, collision-safe), referenced
  by a `<bpmn:humanPerformer>` on a `userTask`/`manualTask` and a `<bpmn:performer>` elsewhere.
  `system` (any task type) is written as `<bg:system>` in `extensionElements`, beside `decisionRef`.
  Both importers read both back at every nesting level; of foreign role forms only a single
  performer/humanPerformer naming a named resource is read (a `resourceAssignmentExpression`,
  several performers, a `potentialOwner` or a nameless resource are not). On an element out of
  scope, S15 reports the field and the XML stays valid. The drawing does not change. Ontology
  version 1.2; both `$schemaVersion` defaults follow (1.0 and 1.1 documents stay valid).
- **Guide: showing roles and systems** — [`docs/roles-and-systems.md`](docs/roles-and-systems.md)
  shows responsibility lanes, system lanes, systems as collapsed pools and as expanded pools with
  the current means, one runnable Logic-Core example each (run by a test), plus the new fields.
- **Node labels that avoid flows (on by default).** An event's or a gateway's label no longer has to sit
  where a flow leaves or enters the node: when one of its sequence or message flows uses the node's
  bottom or runs through the label, the label moves to the first free spot among below, above, right-below and left-below —
  free of routes, shapes, other node and edge labels and lane separators, and inside its participant.
  With no free spot it stays below. Runs after message-flow routing, since a message flow's port is
  only known then; it moves label boxes in `coordMap.nodeLabels` only, which both renderers read
  unchanged. On by default; switch off with `runPipeline(lc, { nodeLabelsAvoidFlows: false })` or
  `config.json -> layout.nodeLabelsAvoidFlows: false`.
- **Bend rule (on by default): fewest bends, then enter in flow direction.** A new routing pass
  (`scripts/bpmn/bend-rule.js`) re-routes a sequence flow when a route with fewer bends exists, or one
  with as many bends that enters an activity or event from the left; endpoints stay put or move to a
  side midpoint — on a task, subprocess or call activity also to the point level with the other end
  (at least `portCornerMarginPx` from a corner), so a flow from a tall expanded subprocess runs
  straight into the task beside it — a boundary event's never moves. A route is only replaced by one
  that is no worse in crossings, lane-line hug, length of overlap with other flows (legs closer than
  `collinearPx` count as one line), crowding, external node labels, side
  conflicts, shared ports (two flows out of — or into — one gateway or event side, or one point of a
  task) and the later message-flow line, stays clear of shapes and inside its pool/lane stack, and
  is at most 10 % + 20 px longer. On by default; switch off with `runPipeline(lc, { bendRule: false })` or
  `config.json -> layout.bendRule: false`; limits in `layout.bendRuleLimits`. A re-routed flow's label is placed off every other route where a spot allows. Measured
  over the 19 top-level fixtures that predate the `example-*` ones, with it on: avoidable bends 29 → 0 (default) and
  49 → 0 (refinement + wrapping), entries against the flow 13 → 0 resp. 14 → 0, collinear overlap
  953 → 519 px resp. 1772 → 804 px; ends off their side's midpoint rise in three fixtures (projection
  ports), no other layout metric worse. The layout ratchet runs the rule in its `default`/`off`/`on`
  modes and gains `plain` and `plain-on` modes (both switches off, without and with refinement +
  wrapping) carrying the former rows; every mode has two flow-direction counts per fixture,
  `avoidableBends` and `againstFlowEntries`, measured by the same search, and an `overlapLen` column
  (px two flows run on top of each other).
- **Per-call layout switches on every surface.** CLI `--bend-rule` / `--no-bend-rule` and
  `--label-avoidance` / `--no-label-avoidance` (each pair mutually exclusive; the positive flag
  forces a pass on over a project config that turned it off). HTTP `/api/v1/generate`,
  `/api/v1/orchestrate` and the MCP tools `generate_bpmn`, `orchestrate_bpmn` take optional booleans
  `bendRule` and `nodeLabelsAvoidFlows` (schema `$defs/LayoutSwitchOption` in
  `references/api-schema.json`); anything but a boolean is a `schema_error`, on `/orchestrate` before
  any LLM work. `runPipeline` throws a `TypeError` for a non-boolean value instead of reading it as
  truthy. `/api/v1/validate` and `validate_bpmn` run no layout and take neither.
- **`BPMN_CONFIG` documented.** The environment variable names a JSON file merged over the shipped
  `config.json` (one level deep) — the project-wide way to change a default without editing the
  package.
- **Five realistic example fixtures.** `tests/fixtures/example-*.json` — Kreditantrag, Bestellung
  und Versand, Urlaubsantrag, Schadenmeldung, Onboarding — at the top level, so every directory-wide
  fence (net check, DI, renderer agreement, output hashes, layout ratchet) covers them.
- **DI11 — sequence flow through a foreign shape (WARNING).** `checkDiagramIntegrity` now reports a
  sequence flow (at any nesting depth) whose segment runs through the interior of a node that is
  neither its source nor its target (#91). Not counted: artifacts (data references, annotations,
  groups) and a box that contains an endpoint (the expanded subprocess a flow lives in). A boundary
  event attached to the flow's own source or target, or the host of a boundary-event source, is
  counted and the message says which case it is. Closed DI enum in `references/api-schema.json`
  and the table in `references/api-reference.md` extended. Behaviour: new entries in
  `diagnostics.issues`; `diagnostics.ok` is unchanged (WARNING), and the CLI prints them under
  "Diagram diagnostics" and aborts on them under `--strict` like DI08–DI10. With the shipped
  defaults no committed fixture reports one: the two layout defects it found are fixed under
  Breaking (boundary events facing their target, `layout.foreignShapeRepair`).
  `tests/fixtures/example-rechnungspruefung.json` with the repair off pins the detection.
- **`visualRefinement` on the HTTP API and MCP.** `POST /api/v1/generate`, `/api/v1/orchestrate` and the MCP tools `generate_bpmn`, `orchestrate_bpmn` take an optional `visualRefinement` (boolean or per-pass object, schema `$defs/VisualRefinementOption`); invalid values are a `schema_error`. Before, these entry points could not switch refinement at all.
- **Layout readability fence.** `scripts/bench/layout-metrics.mjs` now measures every top-level
  fixture (it had a fixed list of eight, which is how `boundary-event-shapes`' crossing went
  unseen) and four more things: sequence-flow ends lying on their own endpoint's outline (#52),
  empty strips in a lane stack, message/sequence flows through foreign shapes, and sequence flows
  running through their OWN source or target shape (exempt from every check until now). It is
  importable; `scripts/bench/layout-metrics.test.js` holds an exact per-fixture ratchet, so a
  layout change that makes any of them worse fails `npm test`. Its edge-through-node count no
  longer counts an expanded subprocess as foreign to its own children. It also measures flow
  quality (`scripts/bench/flow-metrics.mjs`): length of sequence-flow legs lying on a lane
  separator, most bends on one flow, parallel-segment crowding of sequence and message flows, and
  ends off their side's midpoint — all part of the ratchet, in three modes (default, refinement
  off, everything on).
- **Rules in the ontology.** `references/ontology.jsonld` now holds the rule catalog: every rule of
  the three rule sets — 40 BPMN rules, 5 layers; 19 DMN rules, 3 layers; 2 cross-notation rules, 1
  layer — as a `bg:Rule` with notation(s), kind (`specific`/`crossNotation`), layer (`bg:Layer`,
  named per notation), default severity (`bg:Severity`: ERROR, WARNING, INFO — linked to SHACL's
  `sh:Violation`/`sh:Warning`/`sh:Info` by `rdfs:seeAlso` only — ADVISORY, OFF) and run location
  (`runsIn`: `main` or `scenario`). Notations are an open class (`bg:Notation`: BPMN, DMN; ArchiMate
  announced). The loader checks references after the schema. The code keeps only the checks:
  `scripts/shared/rule-catalog.js` joins each rule module's register with the ontology at import and
  aborts that import on a rule only in code, only in the ontology, in the wrong module, or carrying
  its own `layer`/`defaultSeverity`.
- **DMN vocabulary in the ontology**: node kinds, requirement kinds, hit policies, aggregations,
  table orientations and expression kinds (`context`, `invocation`, `list`, `relation` announced),
  linked to the DMN 1.3 XSD namespace by `rdfs:seeAlso`; `references/decision-core-schema.json`'s
  enums are fenced equal to it.
- **Scenario rules in their rule sets**: SC01/SC06 in `scripts/bpmn/scenario-rules.js`, SC04/SC05 in
  `scripts/dmn/scenario-rules.js`, SC02/SC03 in the new `scripts/cross/rules.js`;
  `scripts/scenarios/pipeline.js` sorts their findings by rule id, so its output is byte-identical
  (goldens in `tests/fixtures/scenarios/golden/`).
- **Profile warnings**: an unknown rule id or layer, an override of a scenario rule, or a profile
  file that does not exist prints `⚠ rule profile …` from the runner; findings are unchanged.
- **Events and send/receive tasks name their top-level definition (#53).** New per-node fields
  `messageRef`, `signalRef`, `errorRef`, `escalationRef` (the OMG attribute names) select the
  definition an event definition references; `messageRef` also applies to `sendTask`/`receiveTask`
  and is written as the task's attribute. Resolution: the field, else the type's only definition,
  else **no reference** — it used to be the last definition of the type, so two message events could
  not point at two messages. Both importers read the reference back. New rules: `S16` (ERROR, a
  reference naming no/wrong-typed definition or sitting on a mismatching node) and `S17` (WARNING,
  several candidates and no reference chosen). Round trip is exact for an explicit reference only:
  an event authored without one, in a document with exactly one definition of its type, is written
  with that reference, so re-importing it yields a node that now has the field — the implicit form
  does not survive as implicit.
- **DMN XML importer — `scripts/dmn/import.js` (DMN 1.3 XML → Decision-Core).** `dmnToDecisionCore`
  returns `{ dc, report }`: the model plus a structured loss report (`IM01`–`IM09`, positional paths),
  with `report.lossless` as the one bit a caller branches on; a failure is a shaped result, never a
  throw. What is mapped, reported or invisible to the parser is one table,
  `scripts/dmn/import-scope.js`, fenced against `DMN13.xsd`/`DMNDI13.xsd`. The importer reads no
  DMNDI — Decision-Core is coordinate-free and layout is recomputed on every emit — so every diagram
  is an IM06 finding, and **a `.dmn` this generator wrote also imports as not lossless**
  (`--strict` rejects it); see Known limitations.
- **Import CLI: `node dmn/import.js <input.dmn | -> [output.json] [--strict]`.** Not-XML and
  not-DMN input exit with a message; `--strict` aborts on a lossy import and writes nothing; the
  output passes the Decision-Core schema gate.
- **`scenarios/pipeline.js --decisions` accepts DMN files**, routed by content (first non-whitespace
  character is `<`), not by extension. The import report prints to stderr and its findings count
  toward `--strict`. New dependency edge `scenarios/ → dmn/`.
- **DMN round-trip and permutation fences** (`scripts/dmn/roundtrip.test.js`,
  `scripts/dmn/requirement-order.test.js`) and `tests/fixtures/dmn/negative/`, the home for
  deliberately invalid DMN fixtures (excluded from the import schema-gate scan).
- **`references/ontology.jsonld` — the BPMN vocabulary as one JSON-LD file** (classes, node
  types, markers, definition kinds, element fields), loaded and validated at import by
  `scripts/shared/ontology.js`; exported as `bpmn-generator/ontology`; linked to the OMG metamodel
  and BBO via `rdfs:seeAlso` only; a field's allowed node types are `bg:allowedOn` (a declared
  annotation property, deliberately not `rdfs:domain`, whose several values are conjunctive).
  The file has a single default graph (the `owl:Ontology` header is a node inside `@graph`).
  Node cannot `import` a `.jsonld`; read it with
  `fileURLToPath(import.meta.resolve('bpmn-generator/ontology'))` + `readFileSync` + `JSON.parse`
  (see README). Fences: no vocabulary list outside the ontology
  (`ontology-audit.js`); schema enums equal it; a type added only to the ontology fails the tests
  at every place that does not know it.
- **`scripts/bpmn/orthogonal-router.js` — obstacle-aware crossing repair.** `repairCrossings`'s own
  candidate search tries only a fixed, small set of shapes around the direct source-target line;
  in a congested cluster every one of them can be blocked while a path around the cluster still
  exists. The router (an obstacle-aware Dijkstra over a sparse "trellis"/extended-lines grid, fixed
  endpoints, per-bend and soft-crossing cost penalties) is now tried as a fallback exactly when
  that happens, subject to the same strict-improvement guard as every other candidate. Both
  fixtures the layout-quality analysis found still crossing after the earlier repair pass —
  `bpmn-generator-pipeline` (`visualRefinement: false`) and `realistic-collaboration`
  (`visualRefinement: true`) — now measure 0 crossings, down from 2 each. Two layout items stay
  deliberately out of scope for this pass: closing lane gaps and pool gaps.
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
- **`scripts/dmn/roundtrip.test.js` + `tests/fixtures/dmn/roundtrip-all-fields.json` — the
  round-trip fence, and the three claims it had to correct (dmn-xml-importer plan, Stage 4b/5).**
  Stage 4's fences check what the importer does with a *foreign* file; this one checks the far side,
  that our own output is re-readable and the representable subset is exact. The fixture instantiates
  every property declared anywhere in `references/decision-core-schema.json` — six had no instance
  in `discount-decision.json` (`$schemaVersion`, `expressionLanguage`, `usingProcess`,
  `aggregation`, input `allowedValues`, output `defaultValue`) — and the completeness check
  **derives** the required set from the schema, walking `$ref`/`oneOf`/`items` and asserting as a
  premise that no other applicator keyword appears and that every object closes itself with
  `additionalProperties: false`. That is the property on which this plan declined a DMN
  field-authority table: a new schema property fails CI naming itself, demonstrated by adding
  `Node.dummyNewField` and by adding a fifth `Node.type` enum member. Three claims the stage brief
  made turned out to be false as written and are now pinned as findings rather than worked around:
  `report.lossless` is **structurally unreachable** for our own output (the writer always emits a
  `<dmndi:DMNDI>` tree → IM06, and it *generates* the `<variable>`/`<literalExpression>` ids the
  importer then reports → IM05 — both stated in `import-scope.js`, both regenerated identically on
  the next emit, so the claimable statement is "no finding outside those two classes" and that is
  asserted positively); `xml₁ === xml₂` did **not** hold as of this stage, because `buildDmnDiagrams`
  keyed `edgeCoords` in `dc.requirements` array order while the importer rebuilds that array grouped
  by target, so the `<dmndi:DMNEdge>` children permuted — the documents were byte-identical up to
  `<dmndi:DMNDI>` and the strongest available claim was the fixed point `xml₂ === xml₃`
  (**closed in Stage 5b**, see the two Fixed entries at the head of this section); and
  `$schemaVersion` does not survive at all. Nothing was added to `canonicalizeDecisionCore` and the
  fixture was not trimmed. Also surfaced and **not** fixed here: `readDecisionTable` reads a rule's
  `<description>` into `DecisionRule.documentation`, a property the schema does not declare, so a
  foreign file carrying one imports into a `dc` that fails our own schema gate — and
  `import-scope.js`'s `dmn:DecisionRule` row claims that mapping in prose, which F1b never reads
  (**also closed in Stage 5b**).
- **`scripts/dmn/import.js` — DMN 1.3 XML → Decision-Core, and a structured report of what could
  not come with it (dmn-xml-importer plan, Stage 3).** `parseDmnXml` (async, the thin dmn-moddle
  wrapper, throws), `moddleToDecisionCore` (pure and synchronous, so a hand-built moddle tree is a
  valid input), `dmnToDecisionCore` (the public path), plus `applyDecisionCoreDefaults`,
  `canonicalizeDecisionCore`, `formatImportReport` and the `HANDLERS` dispatch table.
  `scripts/dmn/import-scope.js` is its specification and its only exclusion list: fence **F5** in
  `import-coverage.test.js` now asserts `Object.keys(HANDLERS)` equals the set of `mapped` rows in
  both directions, so demoting a row without removing its handler fails naming the row. The report
  is the half that matters — measured, a document carrying `itemDefinition + decisionService +
  textAnnotation` parses with **zero** dmn-moddle warnings, so a naive `drgElement` loop produces a
  Decision-Core that looks complete, feeds SC02–SC05 a model that is not, and nothing says so.
  `report.lossless` is the one bit a caller branches on; findings carry a **positional** path
  (`definitions.drgElement[2].decisionLogic.rule[0]`), because four DMN types carry no `id` by
  construction. IM04/IM05 come from one generic recursive detector (`walkModdle`) and nowhere else,
  so nothing is reported twice. No geometry is read and none is fabricated: Decision-Core is
  coordinate-free and `dmn/layout.js` re-lays-out on every emit, so every diagram is an IM06
  finding — which is also what voids the DMN-integration plan's instruction to import
  `DMNShape/@isCollapsed`, an instruction with no target. Exactly one XSD default is materialised,
  `tDecisionTable/@hitPolicy`, read from `DMN_XSD_DEFAULTS` rather than from moddle's descriptor
  and recorded in `report.defaultsMaterialised`; the reason is round-trip identity, not consumer
  need (both consumers already default it). Two deref rules live in one file on purpose — a
  requirement's `@href` is `#`-stripped and refused when it reaches into another document (IM03),
  while `usingTask`/`usingProcess` keep theirs verbatim, because the writer emits a bare id there
  for a reason.
- **`references/decision-core-schema.json`'s id pattern widened to ASCII NCName
  (dmn-xml-importer plan, Stage 2).** All seven sites repeating the id pattern (root `id`, `Node`,
  `Requirement`, `DecisionTable`, `InputClause`, `OutputClause`, `DecisionRule`) moved from
  `^[a-zA-Z_][a-zA-Z0-9_-]*$` to `^[a-zA-Z_][a-zA-Z0-9_.-]*$` — accept-only, nothing previously
  valid becomes invalid. `xsd:ID` is an XML NCName and `my.decision` is a legal DMN id that the
  narrower pattern rejected outright, which made such a document unimportable without editing ids
  at the source; `scripts/scenarios/bridge.js` matches a BPMN `decisionRef` against the DMN
  decision's id, so rewriting ids on import was never an option. Deliberately **not** widened to
  full NCName's Unicode letters, even though ajv 8 compiles `pattern` with the `u` flag and `\p{L}`
  would work: measured against dmn-moddle, it writes a non-ASCII id (e.g. `Entscheidung_Über`)
  without complaint and then cannot read it back — 0 `drgElement`s, `'unparsable content
  <dmn:decision>'`, `'unresolved reference <Entscheidung_Über>'` — while `my.decision` round-trips
  clean. Accepting Unicode here would therefore let the pipeline emit a `.dmn` file its own
  importer cannot read, which is the exact round-trip breakage this plan exists to fence. The
  reason is recorded at the schema's `id` field, in `scripts/dmn/import-scope.js`'s IM07/IM08
  rows, and here, because the obvious later "NCName allows it, widen further" edit is exactly the
  change being declined — it is a dmn-moddle library defect, not a design choice.
- **`scripts/bpmn/field-fidelity.test.js` — the spanning fence, whose oracle is execution.** Every
  field `references/input-schema.json` declares is driven through the real `runPipeline` and read
  back through **both** importers (`bpmnToLogicCore` and `bpmnToLogicCoreLegacy`), for every class
  its row's `allowed` set names, at depth 0 **and** one level down inside a `subProcess` *and* a
  `transaction` — 1398 generated cases, ~15 s. Each case asserts the contract the row's `roundTrip`
  column states: `exact` deep-equals, `none` must not survive, and each of the 18 `lossy` rows has
  its own assertion, bound to that row's `reason` text by a verbatim quote so the two cannot drift.
  The `roundTrip` column **is** the exclusion list — there is no second one, and no local skip. This
  matters because the guards built before it all checked one of the project's restatements against
  another, which is how three fences were simultaneously green over a live `isCollection` defect.
  Four table rows were corrected by what it measured (see *Fixed*).
- **`OMG_NODE_FIELD_SCOPE` is now the project's single statement of per-field BPMN knowledge, and
  it covers every field.** The table in `scripts/bpmn/types.js` grew from 6 rows to 29 — one for
  every `$defs.Node` property except `id` and `type` — and gained a sibling
  `OMG_EDGE_FIELD_SCOPE` with a row for every `$defs.Edge` property except `id`. Each row now
  carries four more columns beside "which class may hold this": `shape` (how the field serialises —
  attribute, child element, event definition, extension element, DI, layout-only, or not at all),
  `writeSite` (which function writes it), `enforcedBy` (whether the write site actually consults
  the row's `allowed` set, and therefore whether rule S15 reports on it), and `roundTrip` (what
  survives Logic-Core → XML → Logic-Core, with a **mandatory reason** for anything short of
  `exact`). A new fence in `types.test.js` fails CI, naming the property, if a field is added to
  `references/input-schema.json` without a row — the four-places problem is now structurally
  unforgettable rather than a habit.
- **The metamodel fence covers every row with a metamodel counterpart, in both directions.** It
  used to check 6 hand-picked rows; it now checks every row whose attribute bpmn-moddle actually
  knows — including the structural ones (`marker` → `eventDefinitions`, `loopType`/`multiInstance`
  → `loopCharacteristics`, `has_join` → `gatewayDirection`) — against both `bpmn.json` and
  `bpmndi.json`, for `allowed` sets that are too wide *and* too narrow. Widening it is what found
  the `instantiate` defect below.

- **`net-check.js` — a Petri-net translation integrity guard, `NC01`–`NC06`.** Mirrors
  `di-check.js`'s shape for geometry: `checkNetIntegrity` judges the *translation* `bpmnToPN`
  produces (every node has a transition, every place is produced and consumed, every id is
  unique), never the model — a legitimately unsound process (a real deadlock, a real dead end)
  must still come out clean, `checkSoundness`/WF01–WF03's job. `NC02` (a transition that can
  never fire) is **ERROR**, its one legitimate cause — an untranslated boundary event — having
  been removed in the same release. That promotion is also what forced `NC02`/`NC02b` to be
  **scoped to the translation**, and the scoping is part of the contract, not an implementation
  detail: "this transition can never fire" is equally true of a model that routes nothing into the
  node (a `parallelGateway` nothing leads to, a subprocess with no incoming flow), which is a
  faithful translation of a defective model and therefore WF01's finding — plus S04 where the node
  has no edges at all and S07 for the missing-outgoing half — never this pass's. Both codes now
  fire only where the Logic-Core gives the node an input (resp. an
  output) that the net does not have. Measured over 4000 random rule-engine-clean processes, the
  unscoped codes produced 6601 `NC02` + 6612 `NC02b` ERRORs across 3380 of 3983 nets, while
  `NC01`, `NC03a`, `NC03b`, `NC04` and `NC06` never fired once — so the model-judging was entirely
  in those two, and wiring this pass into `runPipeline` (done — see the next entry) would have
  rejected models that generate today. Three input sources count, and the third is the one that
  makes the scoping safe: an incoming sequence flow, a start event's own scope source place, and
  **a boundary event's `attachedTo` host** — a boundary event has no incoming sequence flow by
  definition (OMG §10.4.4), so a naive "no flow ⇒ not a finding" rule would have exempted every
  one of them and blinded `NC02` to the exact defect its promotion was for. A regression test in
  `net-check.test.js` re-breaks the wiring and requires the ERROR. `NC04` (two distinct edges
  assigned the same place) is
  **ERROR**, its own one legitimate cause — the pair-keyed place-id scheme — having been removed
  in the same release too, though note what that leaves it checking: it reads `pn.placeOfEdge`
  rather than re-deriving the id (re-deriving would ERROR on every legal parallel pair), so it
  asserts `namePlaces`' invariant against `namePlaces`' output and cannot fire under the current
  naming rule — a regression fence, not a check of the net against the Logic-Core; `NC05`
  (multiple start events
  sharing one source place) is INFO — disclosure, not a defect. Fenced directory-wide over every
  Logic-Core fixture under `tests/fixtures/` by `net-check.test.js`, so a new fixture is covered
  the day it lands. Documented in `references/api-reference.md`; the check is now also pinned
  against `references/api-reference.md` by `.github/scripts/docs-gate.mjs`'s generalised
  `(module, prefix, doc)` diagnostic-code table, alongside `di-check.js`'s `DI` family.
- **`net-check.js` is now wired into `runPipeline`, as `result.netDiagnostics`.** The guard ran
  from tests and from a direct call only, so the defect class it exists to catch was invisible to
  every real generate. It now runs on every one: one `checkNetIntegrity(bpmnToPN(proc), proc)` per
  process — `bpmnToPN` flattens containers itself, so a nested subprocess needs no extra call —
  with findings prefixed `` `[pool] ` `` and carrying `process`, the form `runRules` and
  `checkWorkflowNetSoundness` already use. Without it a collaboration finding would be
  unattributable: NC messages name a node id and nothing else, and two participants may legally
  reuse one. `netDiagnostics` mirrors `diagnostics`' shape (`{ ok, issues }`, `ok` meaning no
  ERROR) and is `null` on the early-return path, for the same reason: no net was built, and "no
  artefact" is not "clean". It is a **separate key** rather than merged into `diagnostics`,
  because that one's `code` is a closed `DI01`–`DI06` enum in `references/api-schema.json` that
  the docs gate validates a real response against.
  - **It runs before layout, and that is a correctness constraint.** `logicCoreToElk` calls
    `preprocessLogicCore`, whose `sortNodesTopologically` rebuilds `proc.nodes` from an id-keyed
    map **in place**. Two nodes sharing an id therefore collapse into one before ELK sees them, so
    a check placed next to `checkDiagramIntegrity` would be handed a Logic-Core the defect had
    already been erased from — the same mistake this pass exists to prevent one level up. It is
    computed there and acted on nowhere: `runPipeline` produces the diagnostic and the caller
    decides, which is what lets the CLI gate on it and `agents/layout.js` pass it through.
  - **Cost**: `checkNetIntegrity` never calls `checkSoundness`, the expensive half, which stays
    opt-in. Measured across the whole fixture corpus: 0.611 ms against `runPipeline`'s 208.4 ms,
    0.29 %, largest single model 0.0823 ms. Deliberately **not** conditional on the opt-in
    `workflow_net` layer — gating it there would make the always-off default the always-unchecked
    default.
  - **CLI**: `node bpmn/pipeline.js` gates on it much as it gates on DI — an NC ERROR is fatal and
    writes no files, an NC WARNING is printed and fatal only under `--strict`. **INFO is printed
    and never fatal**, which is the one deliberate difference: the DI block has no INFO codes, so
    the question never arose there, and NC05's own message says multiple start events sharing one
    source place are standard WF-net/OMG normalisation and *not* a defect. A `--strict` run that
    refuses to write files while quoting that sentence tells the caller something false; multiple
    start events are OMG-legal (§10.4.2) and common, and no fixture in the corpus has two, so
    nothing would have caught it.
  - **Both CLI gates are on the ordinary generate path only.** `--drill-down` branches earlier,
    into `generateDiagramSet`, which checks `validation.errors` and writes its diagrams — so it
    bypasses the NC gate exactly as it already bypasses the DI one. Pre-existing behaviour, left
    unchanged, stated here because it means `--drill-down` will still write a file the ordinary
    path refuses.
  - **Two behaviour changes, both deliberate.** The blocking one: a Logic-Core with **duplicate
    node ids across sibling containers** used to generate with a serialisation warning and exit 0.
    The file it wrote carried the same `id=` twice, which `xsd:ID` forbids document-wide, so no
    tool loaded it correctly. `NC06` names it structurally and it is now blocking. The quiet one:
    every run may now print a `⚠ Petri-net diagnostics:` block it never printed before — NC05 on
    any model with more than one start event, for instance — which changes stdout for anyone
    parsing it. New fixture:
    `tests/fixtures/negative/duplicate-ids-across-containers.json` — under `negative/` because
    `net-check.test.js`'s fence scans the top level of `tests/fixtures/` and requires every
    fixture there to be a clean translation, which is not a contract a deliberately dirty fixture
    can be held to. Nothing else in the corpus moved: 0 NC ERRORs across all 24 fixture×pool
    units and 0 of 3983 rule-engine-clean random nets.
  - Not surfaced over HTTP or MCP. Both build their payloads key by key, so neither changed;
    doing so would pull in the schema enum, the docs-gate response contract and
    `mcp-bpmn-server.js`'s `include` set, and is a separate decision.
- **`S14` — a MessageFlow endpoint may not name a container.** `MessageFlow.sourceRef`
  and `targetRef` are typed `InteractionNode` (`BPMN20.cmof:851-852`). `Task` (`:1191`) and `Event`
  (`:287`) are InteractionNodes by an explicit second superclass and `Participant` (`:863`)
  likewise, but `Activity` is `superClass="FlowNode"` alone (`:1095`), so `SubProcess` (`:1147`),
  `CallActivity` (`:1188`), `AdHocSubProcess` (`:1222`) and `Transaction` (`:1233`) are not. The
  message names the remedy — a black-box participant, or a send/receive task or message event
  *inside* the container — and states that collapsing does not help, `isExpanded` being a
  `BPMNShape` attribute (`BPMNDI.xsd:55`) with no semantic counterpart. Severity is **WARNING**,
  consistent with the soundness layer's existing S04/S07/S08, so models that generate today keep
  generating; `rules/strict-profile.json` escalates it to ERROR.
  The rule asks `isContainerNode` (`scripts/bpmn/types.js`), i.e. **by class or by structure**, and
  both legs matter. The class leg is why it is not `n.nodes?.length` (a `callActivity` never
  carries children, a collapsed `subProcess` need not). The structural leg is why it is not
  `CONTAINER_TYPES.has(type)`, which is what it asked in its first cut: `references/input-schema.json`
  declares `nodes` on every `Node`, so a `userTask` with children is schema-valid input and
  `bpmnToPN`'s own `isContainer` — purely structural — gives it an entry/exit pair. On exactly that
  model, `composeCollaboration` (`scripts/scenarios/collaboration.js`) refused the endpoint and
  dropped the synchronisation while S14 emitted nothing, and `scripts/scenarios/format.js` then told
  the reader the endpoint "names a subProcess (S14)" about a node that is neither — the same
  two-layer disagreement the shared `CONTAINER_TYPES` closed in the other direction, reached through
  the leg that was not shared. Both layers now read one predicate, and neither the rule message nor
  the scenario note says "subProcess" any more: each names the node's actual type, and gives the
  CMOF argument only where the node really is in the `Activity` class.
- `references/prompt-template.md` now states the negative explicitly, upstream of every future
  generated model, and records that a node nested inside a subprocess *is* a valid endpoint.
- **`pn.approximations` — a disclosure channel for what the translation under-models rather than
  skips.** `pn.skipped` says "this node has no control-flow model at all"; the new list says "this
  node fires, but not in every way BPMN allows", which is a different thing to tell a reader.
  Today it carries `nonInterruptingBoundaryEvent` (a `cancelActivity: false` event is translated
  exactly like an interrupting one — the faithful encodings each invent something the model does
  not say: a forced AND adds a path, a silent skip transition adds a step to the trace, and
  under-modelling *and saying so* is the only option that invents nothing) and
  `boundaryEventOnContainer` (competing with the subprocess's entry means "ran partway, then was
  cancelled" is not enumerated; cancelling mid-flight needs a cancel region, which no fixed set of
  Petri-net arcs expresses). Passed through `stats` by `scripts/scenarios/enumerate.js` and
  `collaboration.js` and rendered as a note — never a warning, the enumeration did finish — by
  `describeEnumerationCompleteness` (`scripts/scenarios/format.js`), next to how `orGateways` is
  disclosed.

### Fixed
- **`GET /` on the HTTP server answers when no web frontend is installed.** The server read
  `index.html` from a frontend directory that neither the repository nor the npm package contains,
  and the failed read was never answered. It now returns `404` with a short JSON hint pointing to
  `/api/v1/` and `/health` (no stack trace, no server path); an installed frontend is still served.
- **A non-interrupting event-subprocess start event is non-interrupting in the BPMN XML (#83).**
  `isInterrupting: false` on a `startEvent` was drawn as a dashed ring in our SVG and written
  nowhere, so bpmn.io and Camunda showed an interrupting start event. `bpmn-xml.js` now writes
  `isInterrupting="false"` at every nesting depth (only `false`: `true` is the XSD default, like
  `cancelActivity`), both importers read it back, and the field-fidelity fence covers it (row
  `isInterrupting`, `roundTrip: 'lossy'` — a literal `true` comes back absent). Only on the start
  event of an event subprocess, the one place OMG gives the attribute meaning (§10.3.5); a `false`
  anywhere else is dropped, not drawn dashed, and reported by S15.
- **SVG and XML agree on conditional and default flows (#84, #85).** Which sequence flows carry a
  `conditionExpression` and which one is its source's `default` is now decided once, in
  `resolveFlowSemantics` (`scripts/bpmn/topology.js`); `bpmn-xml.js` writes from it and `svg.js`
  draws from it, by bpmn-js 18.6.2's rule: the conditional diamond only on a flow with a condition
  leaving an activity, the default slash on the flow a gateway or activity names as `default`.
  Before, the SVG drew a diamond for `isConditional` with no condition in the XML, and no slash for
  the default the serialiser infers on an unmarked diverging XOR/OR gateway. A flow marked
  `isConditional` with a `label` and no `condition` now gets the label as its conditionExpression
  body, so both renderers show it as conditional; `isConditional` with neither has nothing to write
  and draws nothing. A condition is written only where OMG admits one (§10.3.1): on a flow leaving
  an Activity or an exclusive, inclusive or complex gateway — a flow leaving a parallel or
  event-based gateway or an event gets none, whatever was authored. A flow marked `isDefault` gets
  none either: OMG ignores its condition (§10.5), so the default wins. The default the generator
  infers for an unmarked diverging XOR/OR gateway is chosen only among flows without an authored
  condition (the last such flow), and none is inferred when every flow has one — an inferred
  default never takes a condition away. S15 reports a condition either limit drops. The slash and the diamond have bpmn-js's geometry and size; the slash used to sit on the
  source point, inside the gateway outline.
- **Conditions and default flows inside a subprocess are written and read back.** A container's
  flows were written with id, name, source and target only, so `condition` and `isDefault` were
  lost at every depth below the process. They now come from the same decision as a process's flows
  (`resolveFlowSemantics`), both importers read them back at every depth, and the SVG draws their
  markers. Consequence: a diverging XOR/OR gateway inside a subprocess now gets the same inferred
  default and label-conditions as one at process level (`example-onboarding`,
  `subprocess-child-fidelity`).
- **SVG symbols that were wrong or missing (#85).** An event-based gateway draws two rings when it
  is exclusive and not instantiating, and an outlined plus in one ring when it is parallel (was: one
  ring and a pentagon for all three); an instantiating receive task draws the ring-and-envelope
  start symbol; a collapsed transaction draws the [+] marker. Each follows the matching handler of
  bpmn-js 18.6.2's `BpmnRenderer`.
- **Grandchildren of nested expanded subprocesses are drawn in the SVG.** The DI had their shapes;
  the SVG drew one nesting level only.
- **Artifacts stay inside their participant (#86).** A participant without lanes is grown around
  the artifacts `placeArtifacts` puts below their anchors (ELK never saw them), and an unassociated
  artifact goes below its own process — in the lane of its lowest node — instead of below the whole
  collaboration, i.e. under the last participant. Both raised DI03. New fixture
  `tests/fixtures/artifacts-laneless-pool.json`, fenced by the DI check.
- **Message-flow labels get collision repair (#88).** The edge-label repair ran before
  `routeMessageFlows`, so a message-flow label was never checked against anything placed after it:
  two flows fanned in one corridor put their labels on top of each other, or one label on the other
  flow's line (`realistic-collaboration` "Assessment request" / "Assessment report" in every mode,
  `bpmn-generator-pipeline` with `--refine --wrap`). A new pass, `repairMessageFlowLabels`
  (`scripts/bpmn/coordinates.js`), runs right after `routeMessageFlows` and before node-label
  avoidance: a message-flow label whose box reaches into a route (its own or any other), a shape, a
  node label, another edge label or a participant header (pool or lane header strip, a black-box
  participant whole), or crosses a lane separator or a participant's top or bottom outline — or comes
  closer than `layout.messageFlowLabelClearancePx` (4) px to any route, shape, header, separator or
  outline — moves to the nearest clear spot beside one of its own segments — `layout.edgeLabelGap` px off it, either
  side, slid along it in `layout.messageFlowLabelSlidePx` (10) px steps, at most
  `layout.messageFlowLabelMaxMovePx` (150) px from where it was. Where the gap between two
  participants is too narrow for any such spot, `growParticipantGapsForLabels` grows that gap (at
  most `layout.messageFlowLabelMaxGapGrowthPx`, 80 px, per gap), moves the participants below down
  rigidly and routes and repairs the message flows again; a growth is kept only where it clears the
  label. No clear spot even then: the label stays. Deterministic and idempotent (a fixpoint: the
  second run moves nothing); the box stays in `coordMap.edgeLabels`, so DI and SVG keep agreeing.
  Default output changes for four committed fixtures (`bpmn-generator-pipeline`,
  `example-kreditantrag`, `example-schadenmeldung`, `realistic-collaboration`), in some modes with a
  wider participant gap (35–80 px per gap); no message-flow label is left on anything in any fixture or mode,
  and the layout ratchet's `labelLabel` is now 0 for every fixture and mode. Where a gap grew, the
  message flows sharing a port column there run longer side by side (bench `overlapLen` up, no new
  pair). Switch: `layout.messageFlowLabelRepair` (default `true`), per call `runPipeline(lc, {
  messageFlowLabelRepair: false })`; with it off the output is byte-identical to before (the hash
  fence now names it among the switches it turns off).
- **The legacy importer decodes XML character data like the primary one.** `bpmnToLogicCoreLegacy`
  (`scripts/bpmn/import.js`) decoded only the five named entities in attributes and nothing in
  element text, so a name written as `&#38;` came back as `Check A &#38; B` and `x<1` in a
  condition, loop condition, script or documentation came back as `x&lt;1`. One single-pass
  `decodeXmlEntities` (five entities, decimal and hex references, an out-of-range reference left as
  written) now serves attributes and text, so `&amp;lt;` decodes to `&lt;`. The two field-fidelity
  rows that recorded the loss (`loopType`, `conditionExpression`) no longer state it.
- **Layout bench names what it compares.** The crossings line of `scripts/bench/layout-metrics.mjs`
  and `tests/bench/layout-metrics-baseline.md` still read "default − ELK raw"; it is the
  `unrefined` row (default layout passes, visual refinement off) minus the ELK raw row. Wording
  only, no number changes.
- **`tests/fixtures/messageflow-to-subprocess.json` passes the schema gate.** The fixture carried a
  stray top-level `name`, which the collaboration branch of `references/input-schema.json` does not
  allow, so the CLI refused it in every mode (the tests read it past the gate). The key is removed;
  output and every hash are unchanged.
- **Rule citations for M01, M05, M06 and M07 match what the rules check.** M01 now cites 7PMG G6
  ("use verb-object activity labels", Mendling et al. 2010) in `scripts/bpmn/rules.js` and in
  `references/fachliches-regelwerk.md` (was G5 in code, G7 in the docs); M07 cites G5 ("avoid OR
  routing elements") in the docs as it already did in code (was G4). The M05/M06 rows in the rule
  table described other rules than the placeholders registered in code; they now read "message flow
  labels: nouns only" (Silver Ch.5) and "event labels: participle/state or noun" (Silver Ch.3).
  Thanks to @kndrio.
- **Text annotations wrap instead of running out of their box.** A text annotation was a fixed
  100 × 30 box: our SVG drew a long text as one line across its neighbours and past the canvas edge,
  bpmn.io wrapped it at 100 px and let it hang down across the lane border. The box now fits the
  text: `artifactSize(node)` (`scripts/bpmn/coordinates.js`) lays it out the way bpmn-js lays out a
  TextAnnotation (Arial 12 px, line height 1.2, 7 px padding; `layout.textAnnotationText` in
  `config.json`), keeps 100 × 30 as the minimum, widens up to `maxWidth` (180 px) and wraps beyond.
  The text lines travel with the box in `coordMap.coords[id].lines`; the DI carries the box, `svg.js`
  draws the lines and never re-wraps. `layout.js` sizes an expanded subprocess's artifact band from
  the same function, so a long annotation inside one stays inside it (DI06). Artifacts stacked under
  one anchor now follow a running cursor instead of `slot × own height`, so they no longer overlap
  when their heights differ. **Output changes** for models with stacked artifacts of different
  heights (`all-element-classes`: the annotation moves 20 px down, clear of the data object's label
  it overlapped) and for annotations longer than about 85 px of text. Thanks to @kndrio.
- **`npm run build:skill` excludes `node_modules/`, `agents/` and `robustness/` on Windows too.**
  `scripts/build-skill.mjs` tested for `'/node_modules/'` etc. as substrings, which never matches a
  backslash-separated path: on Windows the bundle carried all of `node_modules` and the `zip`
  argument list overran the command-line limit. The filters now compare whole path segments, split
  on `/` and `\`, of the path relative to the walked directory; on POSIX the file list is
  unchanged. `zip` remains a prerequisite on every platform. Thanks to @sebastianbraun25.
- **Node labels have one geometry source (#82).** The external label of an event, a gateway or a
  data object/store was positioned twice — by `bpmn-xml.js` for the `BPMNLabel` bounds and by
  `svg.js` for the drawn text — against the geometry contract. Its box is now computed once, in
  `coordMap.nodeLabels` (`placeNodeLabels`, `scripts/bpmn/coordinates.js`), re-derived after lane
  compaction so it follows a moved node, and both renderers read it. The test `geometry contract —
  the two renderers agree on node labels` checks every top-level fixture.
  **Output changes:** the box is sized with bpmn-js's own text metrics (Arial 11 px, line height 1.2,
  wrapped at 90 px — the layout edge labels already use), so the `BPMNLabel` bounds in the DI are the
  box bpmn.io keeps on import, and the SVG wraps and places node labels exactly as bpmn.io does (a
  name the SVG used to break after 15 characters now stays on one line when bpmn.io keeps it there).
  Data objects and data stores now get a `BPMNLabel` too. New config key `layout.dataLabelDistance`
  (default 5): the gap between a data object/store and its label; events and gateways keep
  `layout.labelDistance`.
- **Compacted lanes keep their lane names whole in bpmn.io.** bpmn-js wraps a lane label against
  the lane height, so lane compaction (`laneCompaction`) could shrink a lane below its longest word
  and bpmn.io / Camunda Modeler then broke that word in the middle. `compactLanes` now takes a
  per-lane floor (`minLaneHeightFor`); the pipeline passes `laneLabelFloor(name)` — the longest
  word's estimated width at bpmn-js's 12 px lane font plus 2 × 8 px — capped at the lane's
  uncompacted height, so compaction still never makes a lane taller. A lane at its floor is never
  placed above the previous lane's bottom. Switch: `config.json → visualRefinement.laneLabelFloor`
  (default `true`).
- **Lane compaction no longer lays sequence flows on lane lines.** `compactLanes` clamped every
  waypoint inside the strip it cut away onto the shrunk band's bottom edge, so a cross-lane flow
  whose horizontal leg sat in the gap ended up on the lane separator (360–1080 px of such legs in
  6 of 20 measured models). The flows it bent are now re-routed on the compacted geometry by the
  same chain as before (simplify, legacy guard, crossing repair, stuck-end re-clip), and their inner
  horizontal legs keep `visualRefinement.laneLineClearance` (10 px) from lane separators. Message
  flows are still routed last. Compaction's area gains are unchanged.
- **Edge labels no longer lie across lane separators, in every mode** (the lane lines feed label
  placement also with refinement off). A label whose box would cross an inner lane
  line is placed on the other side of its segment (or the next leg), clear of the route, of node
  shapes and — for message flows — of every other label; the collision repair refuses a nudge that
  would cross a separator. The layout bench counts both defects (`labelLaneLine`, a label across a
  separator, and `labelFar`, a label more than `layout.edgeLabelGap` + 2 px from its own route) in
  the ratchet, at 0 for every fixture and mode. A container wrapping the label (expanded
  subprocess, group) is not counted as an obstacle. Where no candidate spot is clear, the label —
  and, when a move would add a crossing, the leg `keepOffLaneLines`/`rerouteAfterCompaction`
  leaves — stays on the separator; this is reported nowhere (see Known Limitations in CLAUDE.md).
- **ELK wrapping no longer crashes layout (#80).** MULTI_EDGE wrapping made elkjs throw
  (`Cannot read properties of null`) on models with more than 20 nodes and a back edge. When ELK
  fails with wrapping properties set, `runElkLayout` now retries once without them, re-throws the
  original error when there was nothing to remove, and the fallback is reported in
  `validation.infos` (and printed by the CLI), not only logged. The node threshold now counts only
  nodes that take part in the ELK graph — artifacts and boundary events no longer push a model over
  it. Retry approach first implemented in a fork by Sebastian Braun.
- **Edge labels now sit beside their flow, and the DI and the SVG agree.** `coordMap.edgeLabels` was
  computed on ELK's route and never refreshed after `simplifyAllEdges` (or after lane compaction),
  so the SVG drew labels on legs that no longer existed, while `bpmn-xml.js` computed its own
  `BPMNLabel` — centred on the line, crossing it by 3 px — and the label repair never reached
  bpmn.io. Every label is now one box in `coordMap.edgeLabels`, placed beside a segment (above a
  horizontal one, right of a vertical one, `layout.edgeLabelGap` px clear, never across its own
  route) and sized and wrapped the way bpmn-js lays out text (`layout.edgeLabelText`). Both
  renderers read that box: the DI writes it for sequence flows at every depth and, new, for message
  flows; the SVG draws the text where bpmn-js draws it, without the white backdrop that masked the
  line. The label repair keeps a label on its side of its line. The layout bench measures label ×
  own route, label × label and label × node, fenced by the ratchet. Goldens of `simple-approval`,
  `dense-edge-labels` and `multi-pool-collaboration` change in their labels only.
- **Sequence-flow ends no longer run along their own shape's outline (#52).** `simplifyAllEdges`
  replaced ELK's Z-shaped routes with an L whenever one cleared the nodes — including the L whose
  last leg lay on the target's border (and the mirror case at the source), so the line covered the
  outline and the arrowhead sat on it. 19 ends in 7 of 15 fixtures, 27 in 8 with `--refine`. It now
  takes only an L that crosses both outlines, otherwise the simplest two/three-bend route that does
  (including routes with a 15 px perpendicular stub at an end), otherwise ELK's route. A per-edge
  crossing guard after `repairCrossings` reverts a single edge to its old L when its new route
  leaves more crossings (config `layout.crossingGuard`; the guard runs only while `layout.crossingRepair` is
  enabled, so with that off the #52 routes go unguarded). ELK's settings are unchanged: its raw
  routes never end along an outline. New diagnostic **DI08**
  (WARNING) reports any remaining case; `references/api-schema.json`'s DI enum gains DI07 (already
  emitted, missing from the enum) and DI08.
- **No sequence flow runs through its own task any more.** A flow that, after the #52 routing and
  crossing repair, still ended along an outline or ran through its own source or target
  (realistic-collaboration `--refine`: `inf3` back through "Check completeness", `inf8` through
  "Send reminder") is re-routed; when no route keeping its endpoints works, an endpoint moves to the
  middle of another side of the same shape (config `layout.endpointReclip`). New diagnostic
  **DI09** (WARNING).
- **No empty strip between lanes with `--refine`.** `compactLanes` re-derived each band from its
  content, which left up to 40 px between a band and the one above (5 of 10 laned fixtures);
  bpmn.io draws that as an extra empty band. Each band below the first now grows up to the band
  above. No node, edge or participant moves.
- **Message flows no longer run through the shapes of participants they pass.** A flow whose
  straight leg crossed a task or event of another participant now detours through a clear column,
  with both horizontal legs in participant gaps; inside a rectangular endpoint the port moves along
  the edge when that clears the leg. DI05 is unchanged: avoiding a shape is not avoiding a
  participant's band.
- **Message flows step round the next lane's task.** When a shape of the flow's own participant
  blocks every column, the flow jogs inside that participant; new diagnostic **DI10** (WARNING)
  reports any message flow still running through a foreign shape.
- **DMN import: the `mapsTo` values are fenced against the Decision-Core schema (#61).** F1b fenced
  the keys only, so a row could claim a slot that `references/decision-core-schema.json` does not
  have. Fence F1c resolves each value's leading slot (`Type.property`, `Type{type:"x"}` or a root
  property) and every other `Type.property` token in it against the schema's `$defs`; the three
  genuinely multi-target values carry an explicit `multiTarget` opt-out with a reason (their
  embedded tokens are still resolved). Renaming a schema property now fails the fence naming the
  row. It proves the slot exists, not that the importer writes it. The `mapsTo` doc comment in
  `import-scope.js`, which said values are never parsed, is rewritten.
- **A single-process Logic-Core without an `id` no longer emits `undefined` (#37).** The schema's
  `SingleProcess` branch makes `id` optional; the process, `Participant_undefined`/`processRef`, the
  plane's `bpmnElement`, the lane DI, `dot.js` (a `TypeError` with lanes), the re-imported phantom
  black-box pool named "undefined" and the scenario pool label `pool_0` all followed from the one
  missing value. `assignProcessId` (`topology.js`) now gives it `Process_1` (`_2`… on a collision)
  by the pure `withProcessId` in `generateBpmnXml`, `logicCoreToDot` and `runScenarioPipeline`
  (`runPipeline` goes through `generateBpmnXml`), so the caller's object is never changed. The `proc.id || '1'` LaneSet fallback is gone. The schema still allows the
  omission, deliberately: rejecting it would break every existing single-process input.
  End-to-end tests cover it with and without lanes, both importers, DOT, and the scenario output.
  The CLI test for a non-fatal serialisation warning, which used this defect as its vehicle,
  now uses an association with an unresolvable target.
- **DOT import: parallel edges and a trailing `;` (#66).** `dotToLogicCore` minted `flow_<src>_<tgt>`
  for every edge, so parallel edges collided (and, since #64, the pipeline keeps an id it is given);
  it now leaves `id` unset and `normalizeEdgeIds` assigns unique ones. The edge and node statement
  patterns stop at whitespace, `;`, `,`, `[` and `]`, so `a -> b;` no longer yields target `b;`.
  Statements are split at newlines and `;` outside quotes and attribute lists, so the one-line forms
  (`digraph { a -> b; a -> c; }`) parse; a body with statements but no recognisable node or edge
  now throws instead of returning an empty graph.
- **The robustness CLI no longer silently ignores flags (#41).** `--strategy`/`--category` were
  accepted and dropped, so a run looked targeted and was not. The cells carry no `category`, and
  `sampleCells` has no strategy besides uniform, so there is nothing sound to wire through; each
  command now rejects a flag it does not read (exit 2, naming it). Targeted sampling stays
  programmatic (`sampleCells(cells, { filter })`); `docs/ROBUSTNESS-STACK.md` example corrected.
- **`/health` and the MCP `serverInfo` report the real version (#40).** Both hard-coded `2.0.0`;
  `scripts/shared/version.js` reads `scripts/package.json` once (it ships in the npm package and the
  skill bundle). `references/api-reference.md` no longer presents `2.0.0` as the response.
- **The "run as main" guard no longer fails on Windows (#51).** `mcp-bpmn-server.js` compared
  `import.meta.url` with `` `file://${process.argv[1]}` ``, false for `file:///C:/…` vs `C:\…`, so the
  server never connected and exited 0. `scripts/shared/entry-point.js` (`isMainModule`) compares
  file-system paths with the platform's own path rules; `http-server.js`, `orchestrator.js` and
  `robustness/cli.js`, which had the same pattern, use it too, as does every other CLI entry (the
  helper resolves symlinks, as `import.meta.url` is the real path). Unit-tested with Windows paths.
- **WF03's improper-completion issue carried WARNING** in `checkWorkflowNetSoundness`'s own output while
  the rule is ERROR; it now says ERROR. `runRules` already reported it as ERROR.
- **Edges without an `id` no longer fail the CLI with DI07 (#64).** The schema requires only
  `source` and `target`, but layout keyed such an edge `edge_<idx>`, the XML and SVG writers
  `flow_<source>_<target>`, and the DI check found no geometry under `undefined`; two parallel
  id-less edges also shared one id, which the CLI treats as fatal. `runPipeline` now gives every
  id-less sequence flow, at every depth, `flow_<source>_<target>` once, up front (`normalizeEdgeIds`
  in `topology.js`; on a collision with any id in the document `_2`, `_3`, … in document order;
  author ids are never touched; the caller's object is not mutated). The direct entries
  `logicCoreToElk`, `buildCoordinateMap`, `generateBpmnXml` and `generateSvg` complete id-less
  edges in place the same way (they fill missing ids on the caller's object — in place, idempotent,
  deterministic — whereas `runPipeline` works on a copy), and every downstream fallback is gone. Message flows and
  associations already require an `id`.
- **DMN importer: `lossless: true` no longer comes with a Decision-Core that fails its own schema.**
  A value the schema requires and the file omits (definitions `@namespace`, a DRG element, parameter
  or annotation `name`, an input clause's expression, a rule's output entry, or a model with no DRG
  element at all) is now an IM09 finding, so `--strict` catches it. The import CLI prints the report
  before the schema gate, and `scenarios/pipeline.js --decisions` gates imported DMN with the schema
  and names the file in the error. A BOM-prefixed JSON decisions file loads; malformed JSON names the file.
- **DMN XML no longer depends on the order of `dc.requirements`.** Layout, coordinates, serialisation
  and import each derived requirement order on their own; `scripts/dmn/requirement-order.js`
  (`requirementKey`, `orderedRequirements`) is now the single source, so permuting the array no
  longer changes the geometry or the emitted bytes.
- **Decision-Core ids accept the full ASCII NCName pattern**, so foreign DMN files whose ids the old
  pattern rejected import and re-validate.
- **An unknown or announced node type was silently serialised as `<bpmn:task>`.** It now fails
  with the type and node id. `transaction` had no shape size of its own (no visible change: the
  fallback gave the same 100x80); `artifactSize` no longer falls back to a non-existent key;
  SKILL.md, logic-core-schema.md and the skill template listed an incomplete set of types.
- **An artifact declared inside an expanded subprocess was placed outside it (#56).** Two gaps,
  both from artifacts being kept out of the ELK graph. An unassociated one was stacked below the
  whole collaboration, ignoring which container declared it — outside the subprocess *and* the
  participant (`DI03` + `DI06`). And ELK sized the subprocess without its artifacts, so even an
  associated one, hung below its anchor, overflowed whenever that anchor sat near the bottom. An
  expanded subprocess now reserves a band at its bottom for the artifacts it declares, sized for the
  worst case (all stacked under one anchor), and unassociated ones are placed into it — after every
  associated one, onto free slots only: an anchor near the bottom hangs its artifact into the same
  band, and placing blindly put two shapes on top of each other (measured for two of three anchor
  positions; DI checks containment, not artifact overlap, so nothing reported it).
  `tests/fixtures/subprocess-child-fidelity.json` had carried five such ERRORs since it gained its
  nested data objects; no test checked its diagram integrity until now. No golden file changed.
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
  ELK and the pipeline.
- **A rule's documentation had a read, a claim and no schema (dmn-xml-importer plan, Stage 5b).**
  `readDecisionTable` wrote `DecisionRule.documentation` into every imported Decision-Core,
  `references/decision-core-schema.json` declared no such property and closes itself with
  `additionalProperties: false`, and `buildDecisionTable` in `scripts/dmn/dmn-xml.js` had no branch
  to write it back. So a foreign file with `<rule><description>` imported into a Decision-Core our
  **own** schema gate rejects — `tests/fixtures/dmn/foreign-kitchen-sink.dmn`, one of our own Stage-4
  fixtures, among them — while the field was lost on the write side too, which made the round trip
  symmetric and the hole invisible from the round-trip fence. The content is now **carried**: a
  rule's rationale is business content, and an importer that discards it loses what foreign files are
  read for. `import-scope.js`'s `dmn:DecisionRule` row now states the line it draws against
  `dmn:DecisionTable`'s own `description` (still an IM05 loss) rather than leaving it to be inferred.
  The row claimed the mapping in **prose** all along; F1b reads `mapsTo`'s keys and never its values,
  which is exactly why no fence saw it. The guard that makes the class impossible is therefore on the
  **gate**, not on a field list: `scripts/dmn/import.test.js` now asserts, directory-driven over
  every `.dmn` in `tests/fixtures/dmn/` (our own `.expected.dmn` golden included), that each imports
  into a Decision-Core passing `validateDecisionCoreSchema`. Measured by biting it — with the schema
  property removed again the run fails naming `foreign-kitchen-sink.dmn` and printing the ajv error.
  Load-bearing for Stages 6 and 7, which both feed the imported Decision-Core through that same gate.
- **The `<dmndi:DMNEdge>` order followed the input array, not the model (dmn-xml-importer plan,
  Stage 5b).** `buildDmnDiagrams` keyed `edgeCoords` by walking `dc.requirements` flat and
  `buildDmnDI` emits one edge per key in key order, so the emitted DI depended on the order the
  requirements happened to arrive in; the importer rebuilds that array grouped by target, so a
  re-emit permuted the edge list — same edges, same waypoints, different order, and `xml₁ !== xml₂`
  (recorded as an unreachable claim in the Stage 4b/5 entry below). The DRG half already had the
  property by accident of nesting. `orderedRequirements` in `scripts/dmn/coordinates.js` now states
  the order explicitly — by target in `dc.nodes` order, then by DMN13.xsd's kind sequence, preserving
  array order inside a group — and **both** halves go through it, so their agreement stops being a
  property of moddle's collections. `roundtrip.test.js` asserts `xml₁ === xml₂` directly in place of
  the FINDING; `xml₂ === xml₃` is kept although it now follows, as a diagnostic split between a
  permutation that settles and an instability that compounds.
  `tests/fixtures/dmn/discount-decision.expected.dmn` moved, inspected: exactly one `<dmndi:DMNEdge>`
  block relocating with byte-identical waypoints, everything before the edge list identical, and the
  new order matching the order the requirement elements appear in the DRG half of the same document.
- **Three nesting losses the spanning fence found are closed.** All three sat at nesting depth ≥ 1
  and none was visible before the fence existed. (1) **`color` at depth ≥ 1**, on both importer
  paths: the write was already correct — the nested node's `<bpmndi:BPMNShape>` carried
  `bioc:stroke`/`bioc:fill` — but both DI reads resolved the shape's `bpmnElement` with a
  top-level-only `pool.nodes.find(...)`, so a coloured node inside a `subProcess`/`transaction` came
  back uncoloured. A shared `findNodeDeep` now walks the node tree, which is what the flat BPMNDI
  plane has always required. Row: `exact`. (2) **`isExpanded` on a nested container**, the same
  top-level-only walk seen from the write side: `buildDI` had one loop over the process's nodes and
  a *copy* of it one level down, and the copy had drifted — it wrote `isMarkerVisible`, the colours
  and the label bounds but not `isExpanded`, and it did not recurse, so a **grandchild got no
  `<bpmndi:BPMNShape>` at all**. One recursive `buildNodeShapeDI` replaces both, making depth 0 and
  depth N identical by construction. The row's *other* clause deliberately stays: `isExpanded` is
  still written only for a container that also carries children, because `svg.js` gates the expanded
  frame on the same condition and `layout.js` sizes a childless container as a task — writing the
  attribute alone would make the DI and the SVG disagree about one model, and closing it means all
  three places at once. (3) **A `textAnnotation`/`group` inside a container is read back by
  `moddle-import.js`**: its child walk read `flowElements`, and bpmn-moddle places an Artifact in
  `artifacts` — the same defect that was closed at top level and left open one level down
  (CLAUDE.md's round-trip limitation records the top-level half). Both levels now go through one
  `artifactFromElement`. `import.js`, the legacy DOM path, was already correct here and is
  unchanged. No golden file moved: no fixture has a nested container carrying `color`, and the only
  fixture that nests an `isExpanded` container and a grandchild
  (`tests/fixtures/subprocess-child-fidelity.json`) has no golden.
- **A nested `group` loses its `name` — recorded, and now fenced.** A Group carries no `name`
  attribute (BaseElement declares only `id`); its label travels as a `<bpmn:categoryValue>` the
  Group references, and `buildCategoryForGroup` runs only in `buildProcess`'s top-level loop, never
  in `buildFlowNode`'s recursion. Measured: a top-level group named `"Grp d0"` survives, the same
  group one level down comes back `name: ""`, on **both** importer paths, at depth 1 and depth 2.
  Pre-existing and older than the nested-artifact read above; it stayed invisible because the `name`
  row excludes groups and the fence's `nodes` sample carried only an annotation. The sample now
  carries a `group` child too, so the `nodes` row states this loss and a later fix turns the fence
  red.
- **Both importers now agree on a container that holds only artifacts.** `import.js`'s DOM parser
  has no `flowElements`-vs-`artifacts` split to go on, so it counted a `textAnnotation` child as a
  flow node and returned `edges: []`, where `moddle-import.js` returned no `edges` key at all. The
  legacy read now keys `edges` off the non-artifact children.
- **Four `roundTrip` claims corrected against what the pipeline actually does, all at nesting
  depth ≥ 1.** The spanning fence measured them; the rows now state the debt instead of asserting
  a fidelity that does not hold. `color` and `isExpanded` are written onto a nested node's
  `<bpmndi:BPMNShape>` or not written at all, and no importer reads a DI shape for a node below the
  top level, so a coloured node inside a `subProcess`/`transaction` comes back uncoloured on both
  paths. `lane` never reaches a `<bpmn:flowNodeRef>` for a nested node, because `buildLane` walks
  the process's own node list — and closing that is a modelling decision (a `LaneSet` belongs to a
  Process *or* a SubProcess), not a gap to fill, which the row now says. `nodes` round-trips a
  flow-node child exactly and loses a `textAnnotation`/`group` child on the primary path only:
  `moddle-import.js`'s child walk reads `flowElements`, and bpmn-moddle puts an Artifact in
  `artifacts` — the same defect that was closed at top level and left open one level down. **No
  behaviour changed here**: these are corrections to what the table claims, each with the mechanism
  written down, and each is one of the queued backlog stages' subjects.
- **`instantiate` on a `receiveTask` was unreachable from both ends at once.** OMG grants
  `instantiate` to `ReceiveTask` as well as `EventBasedGateway` (BPMN 2.0.2 §10.2.4 — an
  instantiating Receive Task is how a process starts on an incoming message without a message start
  event). The serialiser and *both* importers said `eventBasedGateway` alone, so a schema-valid
  `{ type: 'receiveTask', instantiate: true }` never reached the XML, and a
  `<bpmn:receiveTask instantiate="true">` written by any other tool was dropped on import. Because
  neither end could express it, no round-trip test could have caught it; the widened metamodel
  fence did. Write and both reads are widened; `references/input-schema.json`'s property
  description is corrected.
- **Three unguarded writes that bpmn-moddle was discarding in silence.** `loopType` on a
  `startEvent` and `multiInstance` on a `parallelGateway` produced no element, no
  `unknown attribute` warning and no rule finding — bpmn-moddle reports attributes it does not
  *know*, but a property it has no descriptor for it simply drops. Both are now scoped to
  `Activity` by the table and reported by S15. `decisionRef` was the mirror image: it was written
  into `extensionElements` on **any** class and read straight back, so the round trip looked
  perfect while the output claimed a decision binding on a class
  `references/input-schema.json` scopes the property away from ("For businessRuleTask"). It is now
  scoped to `businessRuleTask`.
- **`color` was lost on the primary importer path.** `moddle-import.js` read `bioc:stroke` /
  `bioc:fill` out of `$attrs`, the bag bpmn-moddle keeps for attributes it does **not** recognise —
  and it does recognise these, because it ships the bpmn.io colour package as a registered
  extension (`ColoredShape extends bpmndi:BPMNShape`). Measured: `$attrs` is `{}` and the values sit
  on the shape as plain `stroke` / `fill`, whether or not the file declares `xmlns:bioc`. So the
  read could never match and a coloured node came back with no `color` at all, while `import.js`'s
  own DOM parser (which sees raw attribute names) recovered it correctly. Now read from the parsed
  properties, with the `$attrs` path kept as a fallback for a file written against some other
  colour namespace.
- **`cancelActivity` could land on a task.** The guard was `isBoundaryEvent`, which also answers
  true for anything carrying `attachedTo`, so `{ type: 'userTask', attachedTo: 'x',
  cancelActivity: false }` emitted `<bpmn:task cancelActivity="false">` — an attribute OMG grants
  to `BoundaryEvent` alone. The class guard now comes from the table; the emission condition (only
  `false` is written, since `true` is the XSD default) stays at the write site.
- **A duplicate id in the emitted XML is now fatal on the ordinary generate path.** `xsd:ID` is
  document-wide unique, so a duplicate does not degrade the file — it makes it unloadable, and
  which of the two elements a reader binds a reference to is arbitrary. `NC06` already blocked
  duplicate **node** ids; duplicate **flow** ids were detected (bpmn-moddle's round trip reports
  `duplicate ID <…>` in `validation.xmlWarnings`) but fatal only under `--strict`, so half the
  decision was implemented. The gate now sits where the defect actually shows: that one class of
  serialisation warning aborts with exit 1 and writes nothing, `--strict` or not, in the same
  shape as the DI and NC gates. The rest of the `xmlWarnings` channel is unchanged and stays
  non-fatal outside `--strict` — pinned by a test that drives a plain `unknown attribute <…>`
  through the CLI and requires exit 0. `runPipeline` is untouched: it is a library function, it
  reports and does not refuse. Measured over the whole fixture corpus first — 18 fixtures, one
  hit, `tests/fixtures/negative/duplicate-ids-across-containers.json`, which lives under
  `negative/` precisely to be dirty and already aborted one gate earlier at `NC06`. No fixture
  changes behaviour. Note the fragility this buys, stated rather than hidden: the predicate
  matches moddle-xml's English prose (`error('duplicate ID <' + id + '>')`, moddle-xml 12.0.0),
  which a dependency reword would silently defeat — the guard is a CLI test that produces a real
  duplicate through the real dependency instead of asserting on the string.
- **A rule finding that contains `'; '` is no longer torn into two findings.** `classifyResult`
  split a rule's `message` on `'; '` because that was the separator rules used to join several
  findings into one string — an implicit, undeclared contract. A rule whose *single* message
  happened to contain the separator was therefore emitted as two findings, the second an
  unattributed fragment with no id in it, and that fragment reached `validation.errors`, the HTTP
  response and `--strict`, inflating the error count for one defect. `S10` hit it for real and was
  fixed by rewording, which fixed the instance and left the trap armed. A rule's `check` may now
  return `messages: string[]`, one entry per finding, and `classifyResult` no longer splits
  anything: `message` is taken verbatim as exactly one finding. **Every rule that built a list was
  converted** to `messages` — 20 of the 26 rules reporting a failing `message` at the time of this
  change; the rest keep `message` and are correct by construction. (Rules added later use
  `messages` too, so today's counts are higher — the invariant, not the tally, is the claim.)
  Converting exactly those let the split be
  *deleted* rather than worked around, so the trap is closed for every rule, existing and future,
  not only for the converted ones. Note that no lint over the rule sources could have closed it:
  messages are built at runtime from node and lane names, so a task named `"Prüfen; freigeben"`
  trips it from *data*. That is the case now pinned by test. `classifyResult` also keeps an
  explicit check that a failing rule actually carries a message — the deleted `.split` used to
  provide that by accident, and without it a typo'd result key would have pushed the literal
  string `"undefined"` into `validation.errors`.
- **`M10` reported every lane after the first as a contextless fragment.** Found while closing the
  `classifyResult` trap above, but it is a shipped bug in its own right rather than a latent one:
  `M10` built its offender list with `'; '` *inside* what it declared to be a single `message`, so
  `classifyResult` tore it apart. A pool and two over-long lanes produced one intelligible sentence
  plus two fragments with no verb and no threshold in them — `lane "…" (31 chars)` — in
  `validation.warnings`, the HTTP response and `--strict`. It now emits one complete sentence per
  offender: three findings, three readable sentences.
- **The serialiser no longer emits a per-node field on a class OMG does not define it on, and
  `S15` now reports when it drops one.** `references/input-schema.json` declares `isCompensation`,
  `implementation`, `isEventSubProcess`, `calledElement`, `scriptFormat` and `isCollection` as
  generic properties of `Node`, valid on any `NodeType` — JSON Schema cannot say "only when `type`
  is one of …" without a conditional block per field — while OMG scopes each far more narrowly.
  `buildFlowNode` wrote those guards out one per line, which is how **two** of the six came to be
  missing while the four beside them were correct: `isForCompensation` emitted
  `<bpmn:parallelGateway isForCompensation="true">` and `implementation` was emitted on every node
  type at all, both XSD-invalid and both reported straight back by bpmn-moddle as
  `unknown attribute <…>`. The scopes now live once, in `OMG_NODE_FIELD_SCOPE`
  (`scripts/bpmn/types.js`), read by the serialiser *and* by the new rule — a rule that disagreed
  with the serialiser about which fields are legal where would be worse than no rule.
  `implementation` is the reason the table is per-field rather than one `isActivity` test: BPMN20.cmof
  grants it per class to `userTask`/`serviceTask`/`sendTask`/`receiveTask`/`businessRuleTask` and
  never inherits it from `Activity`, so a `subProcess` is an Activity that may not carry it.
  **`S15`** (soundness, WARNING, recursive into subprocess children) reports the drop. It is needed
  precisely *because* the guards work: guarding made the output valid and removed bpmn-moddle's
  `unknown attribute` signal with it, so a `{ type: 'startEvent', isCompensation: true }` wired
  normally into a flow produced nothing at all — no error, no warning, exit 0 — and the author
  never learned the field had been ignored. `S04`/`S07` do not cover it: they fire only on
  *disconnected* nodes and speak about connectivity. WARNING and not ERROR because the emitted XML
  is valid — something the author wrote was ignored, which is worth saying and not worth refusing
  to build over — matching `S14`'s reasoning and the layer's existing WARNING rules. The rule count
  is now **36**. No golden moves; no fixture carries any of these fields out of scope.
- **`isCollection` now round-trips, on both importer paths and at every nesting depth.** Moving the
  write onto the `<bpmn:dataObject>` (below) moved it away from where both importers read it:
  `import.js` and `moddle-import.js` each took it off the *reference* element. The moddle path was
  already lossy for its own reasons, so after the move the field survived on **neither** path —
  precisely the four-places failure CLAUDE.md's "Adding a per-node field" section describes, where
  the write moves and the two reads do not. Both importers now resolve the companion object via
  `dataObjectRef`, falling back to the `<id>_do` naming convention for files written before that
  link was emitted. The serialiser emits `dataObjectRef` too — without it the split is unreadable
  by anyone else, since our naming convention means nothing to another tool.
  `tests/fixtures/subprocess-child-fidelity.json`, the fixture CLAUDE.md names as the guard for
  this class, gained a data reference at **both** nesting depths, and `isCollection` joined the
  field-set round-trip comparison; a second test drives both importers explicitly, since the
  field-set test uses only the primary one.
- **`isCollection` was written onto the wrong element, and a nested data object had no element to
  write to at all.** OMG puts `isCollection` on `DataObject`; bpmn-moddle's metamodel grants
  `DataObjectReference` only `dataObjectRef`. The serialiser wrote it on the reference, so every
  model carrying it emitted `<bpmn:dataObjectReference isCollection="true">` and got
  `unknown attribute <isCollection>` back on the round trip — a live instance of the defect class
  `S15` exists to prevent, sitting inside `S15`'s own table. The scope table now records *which
  element* each attribute is written to (`on`), and the attribute lands on the generated
  `<bpmn:dataObject>`. `allowed` still names `dataObjectReference`, and correctly: Logic-Core
  models the pair as one node, so the field is authored on the reference and only its emission
  target differs. Fixing it exposed a second gap — the `DataObject` was only ever created for
  *top-level* references, so a `dataObjectReference` inside a subprocess had a reference and no
  object, and moving the write without closing that hole would have silently dropped the field one
  nesting level down. Both build paths now create it. No golden moved: only
  `all-element-classes.json` carries a data reference, it is top-level, and it does not set
  `isCollection`.
- **A wrongly-*typed* value no longer reaches the XML either.** The table carries each field's
  expected type, rather than the serialiser inferring it from the value it was handed. Inferring it
  was a real defect: `typeof value === 'boolean' ? true : value` passed any truthy non-boolean
  straight through, so `{ type: 'task', isCompensation: 'yes' }` emitted
  `<bpmn:task isForCompensation="yes">` — not a boolean, invalid against the XSD, and *silent*,
  because bpmn-moddle reports attributes it does not know, never values of the wrong shape.
  `references/input-schema.json` does type these fields, so the HTTP path rejected such input at the
  schema gate; `runPipeline` and the CLI do not run that gate, and a public API must not depend on
  the caller having come through the HTTP server to be safe. The value is **dropped and reported by
  `S15`, never coerced** — `isCompensation: 'no'` is the case that decides it, since `!!'no'` is
  `true` and coercion would emit the exact opposite of what the author wrote with nothing saying
  so. `S15` reports wrong class or wrong type, never both for one field: they are different
  mistakes with different remedies.
- **`S04`/`S07` no longer warn about three shapes a sequence flow legitimately never touches.** An
  event subprocess (`isEventSubProcess`, OMG `triggeredByEvent`) is entered by its own start event;
  a compensation activity (`isCompensation`, OMG `isForCompensation`) is reached by a compensation
  association; a `group` is an artifact, connected by associations. Each tripped one or both
  warnings, because each rule approximated the exemption by hand and differently — S04 via
  `isArtifact` plus a startEvent/boundary test, S07 via three literal type names that forgot
  `group`. Two of the three are shapes `references/prompt-template.md` actively recommends to the
  model, so the pipeline was asking for them and then warning about them. Both rules now ask
  `isSequenceFlowExempt` (`scripts/bpmn/types.js`), which carries the exemptions with their
  reasons in one place. Nothing is newly rejected; this is signal quality. Both instance flags are
  guarded on the node's **class**, and the guard is what keeps the exemption honest:
  `references/input-schema.json` declares `isCompensation` and `isEventSubProcess` as generic
  `Node` properties valid on any `NodeType`, while OMG scopes them to `Activity` resp. `SubProcess`
  — unguarded, either would be a universal opt-out of both always-on rules, and a
  `{ type: 'parallelGateway', isCompensation: true }` with no edges at all would be reported by
  nothing.
- **`S04` now names a node with an outgoing flow and no incoming one.** Its "connected" set was
  *sources ∪ targets*, so a single outgoing flow was enough to pass — and S07 checks the opposite
  half, so a stranded `parallelGateway` (unreachable itself, every node behind it dead) validated
  clean under the default profile and was named only by the opt-in WF01. The set is now *targets
  only*, and **0 nodes are newly flagged** across the 21 fixture files. Note what is and is not a
  superset here, because two changes ship together and they point opposite ways: the *predicate*
  change (union → targets) is strictly a superset — every node it used to flag it still flags —
  while the *exemption* change in the entry above deliberately removes findings, so a fully
  isolated compensation activity was flagged before and is silent now. The combined behaviour is
  therefore not "everything previously reported is still reported": S04 flags a strictly larger
  set of unreachable nodes and a strictly smaller set of exempt ones, and the three silenced
  shapes are exactly the three named above.
  The message splits in two, because the mistakes differ — a node with no edge at all still
  "appears isolated", one with an outgoing flow "has no incoming flow", since calling the latter
  isolated is simply false. The rule stays **non-recursive** (`scope: 'process'`, dispatched per
  pool over top-level nodes); making it descend is a separate change with a separate blast radius.
  Its citation changed with it: `7PMG G2` is *"minimize the routing paths per element"*, a
  complexity guideline about how many arcs touch an element, which never supported this rule even
  in its narrow reading. What supports it is the connectedness a workflow net is defined by (van
  der Aalst 1997, *Verification of Workflow Nets*) — every node lies on a directed path from source
  to sink — of which S04 is the always-on local approximation and WF01 the exhaustive check. **No
  OMG clause is cited, deliberately.** Checked against the spec PDF in
  `references/omg-spec/normative/`: §7.3.1 is *"Basic BPMN Modeling Elements"*, a shape catalogue,
  and the Sequence Flow Connection Rules (§7.6.1, Table 7.3) govern which *pairs* may be connected
  while stating that "the quantity of connections into and out of an object … are not specified
  here". There is no clause that requires an incoming flow, so citing one would repeat the mistake
  being fixed.
- **`S13` now checks that a boundary event's host really is an Activity.**
  `BoundaryEvent.attachedToRef` is typed `Activity [1..1]` (OMG §10.4.3 Table 10.86); the rule's
  own `ref` said so and its messages said *Aktivität*, but the check only asked whether the id
  resolved in the same container, so a gateway, an event, another boundary event or a
  `textAnnotation` could be the host. The translation layer already refused those shapes —
  `wireBoundaryEvents` (`scripts/bpmn/workflow-net.js`) gives such an event no transition,
  discloses it on `pn.skipped` as `boundaryEventWithoutHost` and declares the orphaned place on
  `pn.unproducedPlaces` — so the shape was caught and disclosed by everything except the layer that
  talks to the author. It asks `isActivity`, not a task list: a subprocess, a transaction and a
  callActivity are all legal hosts. Measured: **0 of 6** boundary events in the fixtures newly fail.
- **`S10` now rejects an artifact as a message flow endpoint.** `MessageFlow.sourceRef`/`targetRef`
  are typed `InteractionNode`, which `BPMN20.cmof` grants per class — never by inheritance — to
  `Task`, `Event`, `Participant` and `ConversationNode` alone. `TextAnnotation` and `Group` are
  `superClass="Artifact"`, not even FlowNodes, and the data references are FlowElements; none is an
  InteractionNode. A `textAnnotation` endpoint nevertheless passed S09, S10, S12 **and** S14. The
  check applies only where the endpoint resolved to a *node*: a pool id names a Participant, which
  is an InteractionNode and lives in `lc.pools`, not in the NodeType enum. Gateways (S12, ERROR)
  and containers (S14, WARNING) keep their own rules rather than being reported twice at a second
  severity. The message deliberately contains no `"; "`: `classifyResult` splits a rule's `message`
  on that separator — it is what the rules use to join several findings into one string — so a
  semicolon inside a *single* finding silently becomes a second, id-less entry, doubling the
  reported error count for one bad endpoint and carrying that into `validation.errors`, the HTTP
  response and `--strict`. S12, S13 and S14 keep their prose free of it for the same reason.
- **`redesign.js`'s `isolateException` no longer refuses a boundary event on a subprocess.** It
  read a private `TASK_TYPES` list without the container classes and answered *"Boundary-Ereignisse
  hängen nur an Aufgaben"* to legal BPMN — an error boundary on a subprocess being the everyday
  case for the transform. Verified rather than assumed: `applyIsolateException` attaches the event,
  copies the host's lane and re-points the existing exception edge, and none of that — nor any of
  its three guards — reads the host's type, so the restriction had no reason of its own. It now
  asks `isActivity`. Both private `TASK_TYPES` copies (`optimize.js`, `redesign.js`) are gone; the
  call sites that genuinely mean *leaf work step* — `previewParallelize`, `previewMergeTasks`,
  and `optimize.js`'s O01/O02/O04 heuristics, which must not nominate a candidate the transform
  would refuse — now share the exported `TASK_TYPES` from `types.js` with that reason written down.
- **`S12` asks `isGateway` instead of `type.toLowerCase().includes('gateway')`.** Same
  substring-versus-explicit-set question `types.js` settled: the local form classifies by spelling
  and is fenced by nothing, while `GATEWAY_TYPES` is checked against `references/input-schema.json`'s
  NodeType enum in both directions. No verdict changes for any current type.
- **`S05`/`S06` no longer reject a re-converged XOR at ERROR severity.** Both rules asked *"do two
  branches of this split reach the AND-join?"* — a reachability question standing in for a token
  question, the same defect family as the rest of this release. Two branches that re-converge at a
  merge **before** the parallel block do both reach the join, but the choice is resolved by then: a
  single token enters the AND-fork and forks into exactly the tokens the join waits for. Since S05
  is ERROR, `runPipeline` returned `bpmnXml: null` and such a model produced no output at all;
  `tests/fixtures/subprocess-merge-fanout.json` was a live instance, provably sound
  (`checkSoundness` reports nothing, `checkNetIntegrity` returns `ok`) and rejected regardless. Both
  rules now work per **incoming flow** of the join — a parallel join fires only once every incoming
  flow carries a token — and report only when two incoming flows *disagree* about which branches can
  supply them, ignoring the flows no branch of the split can supply at all (those are fed by a
  concurrent thread of an enclosing AND block, which no choice at the split can starve). That is
  deliberately stronger than testing for a *disjoint pair* of incoming flows: with three branches
  A/B/C where A feeds only the first flow, C only the second and B both, no pair is disjoint and
  choosing A still deadlocks. A branch supplies an incoming flow either by reaching its source or by
  **being** that flow — the split's own edge may land on the join (`gx --no--> gj`, the everyday
  skip path), and crediting only reachability would discard exactly that flow and with it a real
  deadlock. Cross-checked against the second, independent implementation this release makes possible
  — `bpmnToPN` + `checkSoundness` — over every fixture and eight hand-built shapes; note that no
  fixture contains a split flowing straight into a parallel join, so that shape is covered by
  dedicated tests rather than by the fixture corpus.
  **What this release does not do is make S05/S06 complete, and the remaining gaps are disclosed
  rather than closed.** Both rules stay cheap syntactic heuristics: a flow counts as suppliable by
  a branch as soon as its source node is *reachable*, which over-approximates the supplying sets
  and therefore makes them agree more often than they should, and neither rule sees a branch that
  escapes an enclosing parallel block entirely. For **`S05`** the residual error is always a
  **missed** deadlock, never a fabricated one. That is *not* true of `S06`, which has a one-sided
  false positive of its own — see *Known limitations* below; the claim is scoped to `S05` here
  because it was stated absolutely and is not.
  `references/fachliches-regelwerk.md` names these two cases, and names
  them as *examples*: they are what has been identified, not a closed list. The exhaustive check is
  WF03 in the opt-in `workflow_net` layer — turn it on if a missed deadlock is not acceptable.
- **A Mixed gateway is now recognised as a split.** `S05`/`S06` skipped every gateway carrying
  `has_join`, which `references/input-schema.json` documents as a direction *hint*; a gateway with
  more than one outgoing flow diverges regardless (`gatewayDirection` = Mixed). A model whose XOR
  merged a rework loop and chose between two exclusive paths into an AND-join was therefore a
  deadlock that WF03 flagged and S05 did not.
- **Two parallel sequence flows between one node pair no longer collapse onto one Petri-net
  place.** `bpmnToPN` keyed a place on the node pair alone (`p_<src>_<tgt>`), so a `gw --yes--> t`
  / `gw --no--> t` pair — legal BPMN, and the everyday shape of two conditions with one
  consequence — produced a single place. Three consequences, all reproduced: the later flow's
  label silently overwrote the earlier one's (`places.set` is a plain overwrite); the split's two
  transitions produced onto the same token slot and the merge's two consumed from it, yielding
  four enumerated scenarios where the model has two, of which two were pure duplicates — and
  because `scripts/scenarios/format.js` recovers the branch *label* by index from the outgoing
  edges, a reader was told a decision the trace does not support; and two distinct **backward**
  edges between one pair shared one capped place, so the per-backward-edge cycle bound was applied
  to their sum (a model with two rework flows could rework once in total, at bound 1). The new
  `namePlaces` (`scripts/bpmn/workflow-net.js`) keeps `p_<src>_<tgt>` where the base id occurs
  once — so no existing model's place ids move — and suffixes `#<k>` in `flatEdges` order where
  it recurs. `#` is the file's reserved separator and no node id can contain one, so `#<k>` (a
  decimal) cannot be confused with a container's `p_<C>#source`/`p_<C>#sink`. Deliberately not
  `p_<edgeId>`: `references/input-schema.json` makes `Edge.id` neither required nor
  pattern-constrained, unlike `Node.id`.
  **A second, quieter collision of the same scheme closes with it:** the counter is keyed on the
  concatenation `<src>_<tgt>`, not on the (source, target) pair, and `Node.id` permits `_`, so
  `a → b_c` and `a_b → c` — different pairs entirely — both used to compute `p_a_b_c` and share
  a place. They now become `p_a_b_c#0` / `p_a_b_c#1`. The invariant `namePlaces` guarantees is
  therefore the stronger and simpler one, **distinct edges never share a place id**, rather than
  anything about pairs; a `#<k>` in an id does not prove the node pair repeats, only that the
  concatenation does.
- **The place-id formula now exists in exactly one place.** It had been re-derived in eight:
  three arc-building branches and `connectTransition` and `wireBoundaryEvents` in
  `workflow-net.js`, `backwardEdgePlaceId` in `scripts/scenarios/enumerate.js` (used from
  `collaboration.js` too), and NC04 and NC06 in `net-check.js` — which is why one defect had three
  symptoms. `bpmnToPN` now publishes `pn.placeOfEdge: Map<edgeObject, placeId>`, identity-keyed on
  the objects in `pn.flatEdges` and travelling with the net for the reason those arrays already
  do: identity guarantees agreement, where re-deriving a formula only guarantees it until someone
  edits one copy. `backwardEdgePlaceId` is gone. NC04 in particular *had* to stop re-deriving —
  against the new scheme the old formula would have called every legal parallel pair an ERROR.
- **Boundary events now have a Petri-net translation; before, they had none, silently.**
  `connectTransition` wired a `boundaryEvent` from its incoming sequence flows — of which a
  boundary event has none, its trigger being the host it attaches to — so its transition reached
  the net with no input arc at all and `getEnabledTransitions` (which requires
  `inputArcs.length > 0`) could never fire it, in any marking. Nothing reported it: the transition
  existed, the net looked populated, and the entire escalation path downstream of the event was
  simply absent from every enumerated scenario and every soundness verdict. Measured, this had
  been deleting `in_timer`/`in_remind`/`in_end_rem` from `realistic-collaboration.json`,
  `b`/`esc`/`e2` from `all-element-classes.json` and `c_bnd`/`c_end2` from
  `subprocess-child-fidelity.json` — each reported as a WF01 *dead transition*, i.e. as a finding
  about the model rather than about the translation. `wireBoundaryEvents`
  (`scripts/bpmn/workflow-net.js`) now makes a boundary event an XOR alternative to its host: it
  consumes exactly the places the host consumes, and produces on its own outgoing places. It reads
  the host's actual arcs rather than re-deriving which branch built them, so a host that is a
  container (one boundary transition per `t_C#enter#i`, never the exit — that marking is the
  subprocess having already finished) and a host built through the implicit-merge branch (one per
  `t_<h>_merge_<i>`) both fall out without a special case. A boundary event whose host cannot be
  found gets no transition at all and is disclosed on `pn.skipped`, rather than recreating the
  unfireable transition — and the place for its outgoing flow, minted before the skip was known,
  is declared on the new `pn.unproducedPlaces` so `net-check.js`'s NC03a exempts it. Without that
  the guard reported a *translation* defect (ERROR) for what is a malformed *model*, the category
  error its own header forbids; the list is applied to NC03a alone, never NC03b, so a genuinely
  unproduced place is still caught. A boundary event attached to another boundary event
  (`attachedToRef` is typed `Activity`, so this is illegal, and S13 does not reject it) is now
  refused outright rather than resolving or not by declaration order.
- **`bpmnToPN` no longer drops an expanded subprocess container while flattening, silently
  disconnecting the net.** `flattenNodes` replaced a container with its children — the container
  itself got no transition, and the outer edges naming it became places nothing produced and
  nothing consumed. Inner start/end events also drew from and produced into the global
  `p_source`/`p_sink`, so an inner start competed with the real start for the single initial
  token and an inner end marked the whole process complete. A container now gets its own
  `p_C#source`/`p_C#sink` pair, entered through `t_C#enter` and left through `t_C#exit`, via a
  scope-parameterised `buildScope`; recursion is type-agnostic (`n.nodes?.length`) rather than
  gated on `isExpanded`, a rendering attribute with no semantic counterpart. This is what had
  spent several releases reporting an expanded subprocess as a deadlocked main process (`WF03`)
  with a dead end event (`WF01`) — `checkSoundness` was correctly analyzing the wrong, broken
  net. The malformed-container fallback path had the same disconnection defect under a different
  name (children left in `flatNodes` with no transitions); both now share one
  `isRefinableContainer` predicate across `flattenNodes`, `flattenEdges` and `buildContainer`, so
  the flatten descends exactly where the translation does, and drops the subtree outright rather
  than half-translating it.
- **`S10` no longer reports a false `unknown source`/`unknown target` ERROR** for a message flow
  naming a node inside a subprocess. It collected node ids one level deep per pool, which rejected
  exactly the endpoint shape S14 recommends.
- **`S12` now sees a gateway inside a container that is not marked `isExpanded`.** Its recursive
  walk was gated on that flag — a rendering attribute — so a collapsed container hid its children
  from the rule for purely graphical reasons.
- **A message flow naming a subprocess no longer makes the composed Petri net invent a
  synchronisation.** Stage 1 put the container into `pn.flatNodes` with an entry/exit transition
  pair, so `scripts/scenarios/collaboration.js`'s `resolve()` began returning both: a container as
  a message source would have sent its message twice, and a container as a target would have hung
  consuming arcs on both ends of its subnet. `resolve()` now has an explicit `'container'` branch
  that wires nothing and reports the endpoint on `unresolvedEndpoints` with `reason: 'container'`.
- **`scripts/scenarios/format.js` no longer misattributes three notes.** An ungated message flow
  was reported as "(a black-box endpoint)" even when the real cause was an endpoint that could not
  be mapped — a defect presented to the reader as a deliberate modelling choice; the new
  `stats.messageFlows[].ungatedReason` (`'blackBox'` vs `'unmappedEndpoint'`) splits the note.
  Unresolved endpoints now carry their `reason` into the prose. And the skipped-nodes note is
  rendered per reason, so Stage 1's `subProcessWithoutStartOrEnd` is no longer explained by a
  sentence about `eventBasedGateway` race semantics.

### Changed
- **`SKILL.md` advises what to build.** New section "Advising the user: what to build, and how":
  pools, lanes, roles and IT systems by purpose of the diagram (business, integration, audit), and
  a "Which construct when" table (subprocess kinds, gateways and their pairing, exception handling,
  timers, message events vs. send/receive tasks, loops, task types, data and annotations, level of
  detail) naming the rule that warns on a wrong choice. The skill asks for the diagram's purpose
  when the text leaves it open. The title drops its old version ("BPMN Generator").
- **The npm package no longer ships `robustness/`.** The benchmark subsystem writes its fixtures
  and reports to `../../tests` and only works in a repository checkout; nothing else in the package
  imports it (checked against the import closure of every file `npm pack` includes). Run it from a
  checkout: `cd scripts/robustness && node cli.js run`.
- **The skill bundle is `bpmn-generator.skill` and holds exactly what `SKILL.md` runs.** `npm run
  build:skill` now writes `bpmn-generator.skill` (no version in the name; was
  `bpmn-generator-v3.skill`). Its `scripts/` part is the import closure of the CLIs `SKILL.md` tells
  the skill to run (`bpmn/pipeline.js`, `bpmn/import.js`, `bpmn/redesign-cli.js`) plus `config.json`
  and `package.json`. The old rule (every `.js` except `agents/` and `robustness/`) shipped
  `orchestrator.js`, `http-server.js` and `mcp-bpmn-server.js`, which all import `agents/` and so
  failed at import inside the bundle; they, and the DMN/scenario modules no skill instruction runs,
  are no longer bundled. A module the closure reaches but the bundle excludes aborts the build.
- **The SVG looks like bpmn.io.** Every symbol is drawn with bpmn-js 18.6.2's own glyph geometry
  (`scripts/bpmn/pathmap.js`, its `PathMap` templates) and the scale, position and stroke its
  `BpmnRenderer` handler uses: event icons (envelope, clock with hands and ticks, error zigzag,
  compensation, link, cancel, …), task icons (two cogs on white discs, the business-rule table),
  task markers in bpmn-js's order and offsets (compensation and loop sit where bpmn.io puts them),
  gateway symbols (filled X, plus and star), the data object's page and collection bars, the data
  store's stacked rims. Colours are bpmn-js's (`#22242a` strokes and text on white, no grey pool or
  lane header), stroke widths and dashes too: sequence flows 2, message flows 1.5 dashed `10, 11`,
  associations dotted (`0, 5`, round caps), transactions 1.5 with an inner border, event
  subprocesses dotted (`0, 5.5`, width 2.5), non-interrupting events dashed `6`, groups
  `10, 6, 0, 6`. Text is laid out as bpmn-js lays it out — task names centred with padding 7 and
  broken by Text.js's rule (no more hyphenated breaks), container titles centred at the top in
  regular weight, pool and lane names in regular weight, annotations left-top. Connections are
  drawn above shapes and with bpmn-js's rounded corners (radius 5, `symbols.connectionCornerRadius`);
  the rounding is drawing only — each connection path carries its exact waypoints in
  `data-waypoints`, which is what the geometry fence now compares with the DI. Colours, stroke widths, dash patterns and fonts live in
  `config.json` (`color`, `strokeWidth`, `symbols`). The BPMN XML is unchanged; every SVG golden
  and every SVG hash changes. `symbol-fidelity.test.js` now also asserts stroke widths per class,
  dash patterns, and the order and x offset of every task marker, from bpmn-js's tables.
- **Element colour values are validated and escaped.** `color.fill` and `color.stroke` (BPMN-in-Color)
  must be CSS hex colours (`#rgb` or `#rrggbb`) — `references/input-schema.json` enforces it at the
  schema gate — and the SVG renderer escapes every colour and dash value it writes into an attribute,
  so a value that reaches it without passing the gate (a direct library call, an imported file) still
  cannot leave its attribute. The BPMN XML was already safe: bpmn-moddle escapes attribute values.
  A Logic-Core with a named or `rgb()` colour is now refused by the gate.
- **Third-party notices.** `scripts/bpmn/pathmap.js` and parts of `icons.js` carry glyph data and
  renderer parameters from bpmn-js 18.6.2, `svg.js` and `coordinates.js` algorithms from diagram-js
  15.3.0 (both Camunda Services GmbH). Their license texts and the derived files are listed in
  `scripts/THIRD_PARTY_NOTICES.md`, which the npm package now ships.
- **Every node and connection in the SVG carries its id.** A node's markup (event, gateway,
  activity, data object/store, annotation, group) is one `<g data-element-id="…">` group, and the
  path of a sequence flow, message flow or association has a `data-element-id` attribute, as in
  bpmn-js, so a consumer can find an element without re-deriving its geometry. Pools, lanes, edge
  labels and the canvas carry none. Nothing is drawn differently; every SVG golden changes.
- **An unattached group has a bounded default size (#86):** `config.json → shape.group` is 200 × 120
  (was 300 × 300, which made a one-task participant several times taller than its content).
- **The SVG's symbols are fenced against bpmn-js.** `scripts/bpmn/symbol-fidelity.test.js` derives,
  for every element of every top-level fixture and of `tests/fixtures/symbols/symbol-catalog.json`
  (one example of every element class), the structure bpmn-js 18.6.2 draws from our XML — rings,
  dashes, icon, bottom markers, source-end marker — and compares it with our SVG. No browser.
- **The SVG canvas includes external node labels.** The canvas size now accounts for the label boxes
  of events, gateways, data objects and stores, with the layout switches on or off. Every committed
  fixture renders byte-identical with both switches off; a label reaching further than the canvas
  margin past the shapes now enlarges the canvas instead of being clipped.
- **Refinement passes have their own switches.** Each pass is switched by its own key
  (`laneCompaction`, `edgeLabelCollisionRepair`); `config.json → visualRefinement.enabled` is gone
  (see Breaking). `runPipeline`'s `visualRefinement` option takes `true`/`false` (every pass) or an
  object switching single passes; an unknown pass name throws. The CLI gains `--no-refine` (every
  pass off) next to `--refine` (every pass on); the two are mutually exclusive. Edge-label
  collision repair is now on by default — it only moves labels, never a route. The ELK wrapping
  fallback message bounds the error text it quotes from elkjs.
- **ELK wrapping is its own switch.** Row wrapping of long chains (> 20 nodes in the ELK graph) used
  to switch on with visual refinement. It now has `config.json → layout.elkWrapping`
  (`"off"` default, `"auto"`, `"always"`; threshold `layout.elkWrappingNodeThreshold`), the
  `runPipeline` option `elkWrapping` and the CLI flag `--wrap`. Measured on five models above the
  threshold, wrapping made every one worse in bends, detours and message-flow crowding, so
  `--refine`/`visualRefinement: true` no longer imply it. `visualRefinement.elkWrapping` and
  `visualRefinement.elkWrappingNodeThreshold` are gone from `config.json`.
- **DI05 is readable at high participant counts (#43).** Above `diagnostics.di05GroupThreshold`
  (default 5) the CLI prints DI05 grouped by source participant, one line each with a histogram of
  bands crossed and the worst flows named. Each DI05 message now says how many participants it
  crosses. The JSON result keeps one DI05 per flow.
- **`references/bpmn-ontology.jsonld` is now `references/ontology.jsonld`**, and its loader moved from
  `scripts/bpmn/ontology.js` to `scripts/shared/ontology.js` — the file now also describes DMN and
  the rule catalog, and `dmn/` must not import `bpmn/`. The export `bpmn-generator/ontology` keeps
  its name and resolves to the new file; a stale packaged copy under the old name is never read.
  The export's content gained the `@type`s `bg:Notation`, `bg:Severity`, `bg:Layer`, `bg:Rule`,
  `bg:DecisionNodeKind`, `bg:RequirementKind`, `bg:HitPolicy`, `bg:Aggregation`,
  `bg:TableOrientation` and `bg:ExpressionKind`: a consumer filtering `@type == "bg:NodeType"` gets
  the same 26 node types; one assuming a closed set of `@type`s must widen it. Ontology version 1.1;
  both `$schemaVersion` defaults in `references/input-schema.json` follow (1.0 documents stay valid).
- **Docs gate counts rules per rule set from the ontology**, never from rule-module source; a count
  claim must name its rule set at the number ("40 BPMN rules, 5 layers"), and "N rules across M
  layers" is now matched too. A missing or invalid ontology is a tooling error (exit 2).
- **Rule profiles are checked**: a profile file that is not valid JSON aborts, naming file, line and
  column (it used to fall back to the defaults silently); an unknown severity, or `ADVISORY` on a
  BPMN rule outside the optimization layer, refuses the profile. A missing profile file still runs
  the defaults, with a warning.
- **`scripts/scenarios/rules.js` is gone**; `runScenarioRules` now lives in
  `scripts/scenarios/pipeline.js` with the same contract.
- **Type sets derive from the ontology; `$schemaVersion` accepts any `1.x`.** Every type set, the
  field tables' allowed classes, `bpmnXmlTag` and the marker maps now come from the ontology;
  eight private copies (importers, `bpmn-xml.js`, `rules.js` M01/P02, `workflow-net.js`,
  `optimize.js`, `redesign.js`) are removed.
- **S15's coverage grew from 6 fields to 12.** It now also reports `cancelActivity`,
  `eventGatewayType`, `instantiate`, `script`, `loopType` and `multiInstance` on a class OMG does
  not define them on. The rule walks exactly the rows the serialiser guards from the same table —
  `enforcedBy: 'table'` — so the two still cannot disagree. Rule count is unchanged at 34.
- **M11's message now says the field is dropped, and M11 remains the only rule that reports
  `decisionRef`.** `decisionRef` is guarded by the same table, but its row is
  `enforcedBy: 'convention'`, not `'table'`: BPMN has no `decisionRef` attribute, so S15's sentence
  would be quoting an OMG class that does not exist, and M11 already owned the field in the style
  layer that owns this project's own conventions. One field on one node still produces one message.
  M11's comment used to say putting `decisionRef` elsewhere "round-trips fine"; that is no longer
  true and has been corrected.

### Known limitations
Things this release deliberately leaves open. They are listed here because the CHANGELOG is what a
release reader sees, and each of them is a gap someone could otherwise mistake for a guarantee.

- **elkjs mis-lays-out a `structuredClone`-built graph under Jest.** Under Jest's VM modules (how
  `npm test` runs), `structuredClone` creates its objects in Node's outer realm, and the bundled
  elkjs lays such a graph out differently, or — fully cloned — not at all (no coordinates). Plain
  `node` is unaffected (one realm), so this is not a production defect; it surfaced when a first
  draft of `cross/decision-doc.js` cloned with `structuredClone` and changed the BPMN layout in
  tests only. The pipeline clones Logic-Core with `JSON.parse(JSON.stringify(…))`. Minimal
  reproduction, skipped by design: `scripts/bpmn/elk-realm.test.js`.
- **SC02 reports a `decisionRef` to a decision decided by a literal expression** as resolving to no
  decision, because the scenario pipeline's bridge matches decision tables only. Kept as it is on
  purpose (SC02/SC03 and the table analysis are defined over tables); the documentation section of
  `--decisions` does show such a decision.
- **Multiple and parallel-multiple events are drawn but not serialised (#87).** The SVG shows the
  pentagon or plus; the XML carries no event definition, so bpmn.io shows a plain event. The
  symbol-fidelity fence pins the difference, so the fix will turn it red.
- **`isAdHoc` is drawn but not serialised (#99).** The SVG draws the tilde; the XML has a plain
  `subProcess` (the `isAdHoc` row in `types.js`, `adHocSubProcess` is `announced`). Pinned like #87.
- **Layout limits left open by the edge and message-flow work**, each tracked:
  - `boundary-event-shapes` still has one sequence-flow crossing between boundary-event shapes (#71).
  - A message-flow jog keeps clearance from shapes only; it ignores groups and labels (#72).
  - A sequence flow can still run through another edge's label (#73).
  - With `--refine`, lane content is not re-centred in its band after compaction (#74).
  - `compactLanes` neither compacts nor tiles nested `childLanes` (#75).
  - The orthogonal router can produce a U-turn where a detour is cheaper (#76).
  - Participant ordering is a heuristic above 8 participants (#77).
  - Layout time grows on large models: the crossing guard and the router add roughly 2x on a
    122-node process (#78).
- **SC01–SC06 are not profile-switchable yet**: the scenario pipeline takes no profile. A profile that
  turns off `workflow_net` (`rules/default-profile.json` does) or DMN `semantics` silences WF01–WF03
  resp. D06–D08, but not SC01/SC06 resp. SC04/SC05, which sit in those layers.
- **The DMN importer's `report.lossless` is never true for DMN this generator wrote.** It reads no
  DMNDI, so every diagram is an IM06 finding, and the writer's generated `<variable>` and
  `<literalExpression>` ids are IM05 findings. `--strict` on the import CLI and on
  `scenarios/pipeline.js --decisions` therefore rejects our own output. Nothing is lost that the
  next emit would not regenerate.
- **The BPMN importer side is untouched.** `references/input-schema.json` still has the narrow id
  pattern Decision-Core dropped, and `scripts/bpmn/import.js` swallows every moddle error with a
  bare `catch {}`; neither `/api/v1/import` nor the MCP `import_bpmn` tool has a test. Not
  addressed here.

- **`S05`/`S06`'s remaining missed-deadlock cases are disclosed, not closed** — see the S05/S06 entry
  under *Fixed* above. `references/fachliches-regelwerk.md` names two of them and names them as
  examples; the exhaustive check is WF03 in the opt-in `workflow_net` layer.
- **`S06` rejects a sound inclusive split whose branches converge on a parallel join — a false
  positive, at ERROR, so the model produces no output at all.** `start → gx(inclusive)`,
  `gx → t1`, `gx → gj(parallel)`, `t1 → gj`, `gj → end` is reported as a deadlock. It is not one:
  an OR-split may activate *both* of its branches, and when it does, both incoming flows of the
  join receive a token and the join fires. `S06` reasons per branch, and a single branch chosen
  alone would indeed starve the join — which is a correct statement about XOR semantics and the
  wrong one about OR. Because `S06` is ERROR, `runPipeline` returns `bpmnXml: null` and nothing is
  generated. This is **pre-existing, not a regression of this release** — reproduced identically
  against `master` (the message differs, the verdict and the `null` do not) — and it is the reason
  the absolute "never a fabricated one" claim above is now scoped to `S05`.
  **WF03 cannot arbitrate it.** The opt-in exhaustive check is the escape hatch offered for every
  other `S05`/`S06` gap, but not for this one. `bpmnToPN` gives an inclusive gateway a single
  transition that consumes and produces on *all* of its arcs — AND semantics — and records the
  gateway in `orGateways`, which surfaces as the `WF_OR` **INFO** finding *"OR-Gateway(s) … not
  formally verifiable in WF-Net analysis. Results may be incomplete."* So on this model
  `checkSoundness` reports no deadlock, but that silence is explicitly disclaimed: it is a verdict
  about an AND-substituted net, not about the model as written. Neither layer is analysing OR
  semantics, so neither can overrule the other. Giving OR its own semantics in the net (or teaching
  `S06` that an OR-split's branch sets are not mutually exclusive) is the real fix and was
  deliberately not attempted here. Workaround until then: model the intent with an explicit
  parallel split, or set `S06` to `OFF` via a rule profile.
- **`sortNodesTopologically` silently drops a node whose id duplicates an earlier one at process
  top level.** Its last two lines rebuild `proc.nodes` from an id-keyed map, in place, on the
  object `runPipeline` hands to every later stage — so the diagram omits an activity and nothing
  says so. `netDiagnostics` now reports it (`NC06`) and the CLI blocks on it, because the check
  runs before `logicCoreToElk`; but the mutation itself is still there, and any code reading `lc`
  after layout is reading a Logic-Core that differs from its input. Whoever repairs this: the test
  "a collaboration finding names the pool it came from" in `scripts/bpmn/pipeline.test.js` doubles
  as the fence on *where* net-check runs, and that second job depends on this bug. It keeps
  passing afterwards, in both placements, and silently stops discriminating between them.
- **`netDiagnostics` is reachable over neither HTTP nor MCP.** `runPipeline` produces it on every
  call and the CLI gates on it, but `/api/v1/generate`, `/orchestrate` and the `generate_bpmn` MCP
  tool all assemble their payloads key by key and do not carry it. Surfacing it means widening
  `references/api-schema.json`'s closed `DiagnosticIssue.code` enum, the docs gate's response
  contract and `mcp-bpmn-server.js`'s `include` set — a separate decision with its own blast
  radius, deliberately not taken here.
- **`S04` is not recursive, so an unreachable node *inside* a container is still reported by no
  always-on rule.** The rule is `scope: 'process'` and `runRules` dispatches it per pool over
  top-level nodes only, so the widening above does not reach a candidate one level down —
  `tests/fixtures/subprocess-collapsed-children.json` has exactly such a node. WF01
  (`workflow_net`, opt-in) is still the only layer that names it. Making S04 descend is a separate
  change with a separate blast radius and was deliberately not made here.
- **`isSequenceFlowExempt` carries the same narrowness `OMG_NODE_FIELD_SCOPE` was just fenced
  against, in a separate hard-coded guard.** The table's `allowed` sets now *are* checked in both
  directions against `bpmn-moddle`'s metamodel (`scripts/bpmn/types.test.js`, "no `allowed` set is
  too wide OR too narrow") — that gap is closed. But `isSequenceFlowExempt`'s own clause is
  literally `type === 'subProcess' && isEventSubProcess`, so an event **`transaction`** still trips
  S04 and S07: two always-on rules reporting a node that is legitimately entered by its own start
  event rather than by a sequence flow. Same root cause as the entry that closed, different guard,
  and the fence cannot see it because it only covers the table. The natural closure is deriving
  that clause from `OMG_NODE_FIELD_SCOPE` instead of restating it.
- **The `S15`/`buildFlowNode` round trip proves *acceptance*, not *meaning*.** The oracle added
  while fixing `isCollection` (see *Fixed* above) asks whether `bpmn-moddle` re-parses the emitted
  attribute without an `unknown attribute` warning — a real, external check, but one that can only
  say "this element is willing to carry this attribute", not "this is the element OMG means by
  it". A field placed on a class that is wrong per the CMOF but happens to be one `bpmn-moddle`'s
  metamodel also grants the attribute to would still pass every fence `OMG_NODE_FIELD_SCOPE`
  currently has.
- **`dataStoreReference` has no companion root element, and whether that is correct was never
  investigated in this release.** `isCollection`'s fix gave `dataObjectReference` a matching
  `<bpmn:dataObject>`, built and read back via `dataObjectRef`; `dataStoreReference` gets no
  equivalent `<bpmn:dataStore>` anywhere in `bpmn-xml.js`, and neither importer looks for one.
  `DataStore` is a `rootElement` rather than a `flowElement` in the CMOF, which is consistent with
  there being nothing to emit — but nobody has checked whether that appearance is the reason or a
  coincidence, and no field on `dataStoreReference` currently needs a companion object to round-trip.
- **`isAdHoc` is declared in `references/input-schema.json` but has no effect on the emitted XML.**
  `svg.js` reads `node.isAdHoc` to draw the ad-hoc tilde marker in the preview, but `bpmn-xml.js`
  never writes it to an attribute and neither `import.js` nor `moddle-import.js` reads one back —
  a `subProcess` with `isAdHoc: true` renders with the marker in the SVG and serialises as a plain
  `<bpmn:subProcess>`, indistinguishable from one without the flag, on both the write and the read
  side. `CONTAINER_TYPES`/`ACTIVITY_TYPES` separately carry `adHocSubProcess` as a type string that
  neither importer ever produces and the schema's `NodeType` enum does not expose (kept only
  because a hand-written test fixture depends on it — see the allowlist comment in
  `scripts/bpmn/types.test.js`), which is a second, adjacent way this release's ad-hoc support is
  thinner than either the schema or the type vocabulary implies on their own.

### Security
- **Rule profiles are treated as untrusted input on every channel.** Every profile — inline, by
  name or from a file — now passes a JSON Schema gate (`references/rule-profile-schema.json`)
  after a 64 KiB size bound, before any rule logic reads it; unknown top-level keys, including the
  loader's own internal markers, are refused. Over HTTP, `ruleProfile` is an inline object on all
  three endpoints (`/orchestrate` used to accept a string and read it as a server-side path), and
  it may only raise a soundness rule, never disable the layer or set a rule below its default
  severity. Over MCP — a trusted local channel that may still relax any rule — it is a profile
  name resolved inside the repository's `rules/` directory, located from the module rather than
  the working directory, which also fixes the documented `rules/strict-profile.json` silently
  running the defaults; an installed npm package has no `rules/` and refuses names. Profile size
  and nesting are bounded by a walk that stops at the limit. Profile files are read only when they
  are regular files of at most 256 KiB. Refusal messages no longer quote file content or name
  server paths to remote callers; client-supplied names in messages are escaped (control and
  Unicode format characters), warning lists are capped, and the audit line for a refused profile
  is bounded. A profile on `/orchestrate` (inline) and `orchestrate_bpmn` (by name) now actually
  applies in the compliance phase.
- **Five high/critical dependency advisories cleared; the audit gate is green again.** `proxy-addr`
  (critical), `@modelcontextprotocol/sdk` 1.29.0 → 1.32.1, `fast-uri` (reached through `ajv`, on the
  untrusted-input path), and the dev-only `brace-expansion` and `js-yaml` — all in-range lockfile
  updates, no range or dependency changes. The gate had failed on every pull request since these
  advisories were published. The last policy exception (`@hono/node-server`, Windows-only path
  traversal in an MCP transport this project never loads) is retired: its advisory no longer matches
  and its review trigger fired. `SECURITY.md` now lists no accepted risks; one moderate `js-yaml`
  advisory inside jest's coverage tooling stays a non-blocking warning.

- **HTTP API hardening.** One outbound-URL validator (`scripts/shared/outbound-url.js`) now
  guards every request to a client-supplied URL: http/https only, no credentials, `localhost`
  names refused, and every resolved address checked against the IPv4 and IPv6 special-purpose
  ranges, including IPv6 forms that embed an IPv4 address. Callback deliveries connect only to the
  addresses that passed the check and no longer follow redirects. A client `llmConfig.baseUrl` is
  accepted only for origins the operator lists in `LLM_BASE_URL_ALLOWLIST` and then passes the same
  validator and pinned transport; an LLM provider's response body is never returned to the client
  (generic `502 llm_error`, detail logged server-side, truncated and escaped); no LLM call,
  to the operator's endpoint either, follows a redirect. Dead-letter files
  are named by a server-generated UUID, created exclusively and kept inside the dead-letter
  directory; `correlationId` is accepted only as a short identifier. Client strings that reach the
  audit log or a response (`clientId`, telemetry fields, error messages) are length-bounded with
  control and format characters escaped, through one helper (`scripts/shared/safe-text.js`). Schema-gate
  errors in a response are capped at 20 (plus a count) with their strings bounded. A
  non-object JSON body is refused at once. The API key is compared in constant time; the rate
  limiter evicts expired buckets and can key on the client address recorded by trusted reverse
  proxies (`TRUST_PROXY_HOPS`). The MCP `orchestrate_bpmn` tool runs the Logic-Core schema gate
  like the other tools.

## [3.6.0] - 2026-08-01

### Added
- **Scenario enumeration — every path a token can take, listed instead of drawn.**
  A new opt-in subsystem, `scripts/scenarios/`. The rule engine only ever sees the
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
  (`runDmnPipeline` + CLI), completing Stages 3–4 of the DMN integration.
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
  **This does not yet produce a `.dmn` file** — that is Stage 4 of the DMN integration. Counted separately from the BPMN engine;
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

### Earlier 3.6.0 entries (recorded 2026-07-29)

> **Gap notice.** No entries were recorded here between `[3.3.0]` and `[3.6.0]`, although
> six releases and several feature merges shipped in that time: v3.4 (#15), v3.5 (#16),
> v3.5b (#17), v3.5c/v3.5d (#18), plus PRs #19, #21, #23, #24, #25 and #27. Those
> entries are not reconstructed retroactively — the pull requests are the record for
> that period. The docs gate added below exists to stop this recurring.

#### Added
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

#### Fixed
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

#### Changed
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

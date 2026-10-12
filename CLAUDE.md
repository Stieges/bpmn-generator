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

7 top-level scripts (standalone tooling) + 29 bpmn-pipeline + 20 dmn (growing) + 11 shared + 2 cross-notation + 7 agent +
9 robustness + 6 scenarios (growing) modules under `scripts/`. Verify current inventory with
`find scripts -name '*.js' -not -path '*/node_modules/*' -not -name '*.test.js' | wc -l`.

```
scripts/bpmn/ — Core Pipeline (run on every generate call)
  pipeline.js (Orchestrator, public API runPipeline; its one import outside bpmn/ is
  │                            ../cross/decision-doc.js, for the opt-in `decisions` option — text, no rule,
  │                            fenced in shared/rule-registers.test.js and shared/rule-catalog.test.js)
    ├── validate.js          ← rules.js
    ├── rules.js             ← types.js, workflow-net.js, optimize.js
    ├── scenario-rules.js    ← workflow-net.js, ../shared/rule-catalog.js (SC01, SC06 — the BPMN rules of the scenario pipeline; called only by scenarios/pipeline.js)
    ├── optimize.js          ← types.js, topology.js (opt-in Optimization Advisory layer O01–O04, invoked by rules.js)
    ├── workflow-net.js      ← types.js
    ├── topology.js          ← types.js
    ├── layout.js            ← types.js, ../shared/utils.js, ../shared/safe-text.js, constants.js, topology.js,
    │                          coordinates.js (artifactSize only), elkjs
    ├── coordinates.js       ← types.js, ../shared/utils.js, constants.js, topology.js
    ├── di-check.js          ← types.js (isArtifact only — post-layout DI integrity pass, see below)
    ├── visual-refinement.js ← ../shared/utils.js, coordinates.js (refinement passes: lane compaction, label repair)
    ├── edge-simplify.js     ← types.js, orthogonal-router.js, ../shared/utils.js (post-process ELK waypoints, reduce zigzag;
    │                          repairCrossings falls back to the router when its own fixed-shape
    │                          candidate search finds nothing admissible; reclipStuckEnds routes
    │                          through it between two end stubs)
    ├── orthogonal-router.js ← ../shared/utils.js (obstacle-aware Dijkstra pathfinder, called from
    │                          edge-simplify.js, by repairCrossings and reclipStuckEnds, and from
    │                          bend-rule.js as its fallback; duplicates its own segment/box clearance
    │                          test to avoid a circular import)
    ├── bend-rule.js         ← orthogonal-router.js, types.js, ../shared/utils.js (layout.bendRule, on by default:
    │                          fewest bends, then enter activities/events from the left; runs after
    │                          lane compaction, before edge-label repair and routeMessageFlows)
    ├── bpmn-xml.js          ← types.js, ../shared/utils.js, constants.js, topology.js, icons.js
    ├── svg.js               ← types.js, ../shared/utils.js, constants.js, icons.js, coordinates.js
    ├── icons.js             ← constants.js, pathmap.js (event/task icons, task markers, gateway
    │                          symbols, data shapes — element-relative, as bpmn-js 18.6.2 draws them)
    ├── pathmap.js           (no deps — bpmn-js 18.6.2 PathMap glyph templates + getScaledPath)
    ├── dot.js               ← types.js, topology.js
    ├── schema-gate.js       ← ../shared/resource-paths.js, ../shared/safe-text.js, visual-refinement.js (ajv draft-2020-12 strict gate;
    │                          visual-refinement.js supplies VISUAL_REFINEMENT_OPTION_SCHEMA, which pulls coordinates.js into the gate)
    ├── types.js             ← ../shared/ontology.js (every type set, marker map and field-table `allowed` derives from the ontology)
    ├── ontology-audit.js    (no deps — `findVocabularyLists`, `checkCompleteness`: the fence that finds private copies of the vocabulary)
    ├── constants.js         ← ../shared/utils.js (15 BPMN-only constants: SHAPE, SW, CLR, SYM, FIRST_BASELINE,
    │                          lane/label/gap/padding sizes — derived from CFG, never touched by dmn/)
    ├── import.js             BPMN XML → Logic-Core (DOM parser)
    └── moddle-import.js      BPMN XML → Logic-Core (bpmn-moddle path)

scripts/bpmn/ — Petri-net integrity guard (run on every generate call)
  net-check.js               (no deps — post-translation sanity pass on the net bpmnToPN
                               produces: does every node get a transition, every place get
                               produced and consumed, every id stay unique — never the model
                               itself, that stays checkSoundness/WF01–WF03's job — which is why
                               NC02/NC02b fire only when the Logic-Core has the flow and the net
                               lacks the arc, a boundary event's host counting as an input source
                               so the narrowing cannot blind them. NC01–NC06,
                               see below. Called per process from pipeline.js as
                               result.netDiagnostics, BEFORE logicCoreToElk — preprocessLogicCore
                               rebuilds proc.nodes from an id-keyed map in place, so a check
                               placed after layout gets a Logic-Core two nodes sharing an id have
                               already collapsed in. Fenced directory-wide over every Logic-Core
                               fixture at the TOP LEVEL of tests/fixtures/ by net-check.test.js,
                               so a new fixture is covered the day it lands; tests/fixtures/
                               negative/ is the home for fixtures that exist to be dirty)

scripts/bpmn/ — Redesign toolbox (opt-in; CLI-driven, not invoked by runPipeline)
  redesign-cli.js            ← redesign.js (CLI entry; preview is the default, --apply writes)
  redesign.js                ← redesign-core.js (5 deterministic transforms, each preview*/apply*)
  redesign-core.js           ← rules.js, topology.js (soundness gate, deterministic IDs, protection lists;
                                may NOT import agents/llm-provider.js, directly or transitively)

scripts/shared/ — format-independent core (used by both bpmn/ and dmn/)
  utils.js                   (reads ../config.json)
  rule-profile.js            (profile machinery: assertRuleProfile schema gate, loadRuleProfile, loadNamedRuleProfile,
                               isRuleEnabled, getEffectiveSeverity, auditProfile)
  rule-catalog.js            ← ontology.js (buildRuleCatalog: rule registers ⋈ ontology metadata, checked at import)
  resource-paths.js          (no deps — where references/ lives in each layout, and the repository's rules/
                               for named profiles: rulesDirPath, null outside a checkout)
  ontology.js                ← resource-paths.js, ajv (loads + validates references/ontology.jsonld at import; `VOCABULARY`)
  outbound-url.js            (no deps beyond node: — the one validator + pinned, redirect-free transport
                               for every outbound request to a client-supplied URL: callbacks, LLM base URLs)
  safe-text.js               (no deps — quoteForMessage / boundText: client text bounded and escaped on
                               its way into a message, a log line or a response)
  text-layout.js             (no deps — layoutText/lineWidth: Arial advance widths + diagram-js Text.js
                               line breaking, the one text measurement of both notations; bpmn/coordinates.js
                               edgeLabelLayout wraps it, the DMN renderers call it)
  geometry.js                (straight-segment clip maths: clipStraight, clipToRect — shared by
                               bpmn/coordinates.js and dmn/coordinates.js; the orthogonal clip
                               helpers stay in bpmn/ — see dmn-integration plan's Stage 3 note)
  entry-point.js             (no deps beyond node: — isMainModule, the CLI guard every entry script uses;
                               symlink- and Windows-safe, unlike comparing import.meta.url to argv[1])
  version.js                 (no deps beyond node: — PACKAGE_VERSION, read once from ../package.json;
                               'unknown' if unreadable)

Standalone tooling (top-level scripts/)
  http-server.js             HTTP API (/api/v1/generate, /orchestrate, /chat)
  mcp-bpmn-server.js         MCP server entry point
  evaluate-slm.js            Pipeline evaluation runner
  prepare-training-data.js   Training-data prep script
  audit.js                   Append-only JSONL audit log
  delivery.js                Webhook delivery + dead-letter
  orchestrator.js            Multi-agent orchestration

DMN subsystem (scripts/dmn/) — opt-in; runPipeline reaches only the table text (table.js,
table-text.js, constants.js, schema-gate.js via ../cross/decision-doc.js), never a rule module
  pipeline.js (Orchestrator + CLI, public API runDmnPipeline → { xml, svg, markdown?, tablesSvg?,
               tablesHtml?, diagrams, diagnostics, validation }; the three views with `doc: true`)
    ├── schema-gate.js       ← ../shared/resource-paths.js (ajv gate for Decision-Core)
    ├── rules.js             ← ../shared/rule-profile.js, ../shared/utils.js, ../shared/rule-catalog.js (D01–D11 + B01–B06,
    │                          3 layers, 2 modes; own runner `runDmnRules`)
    ├── scenario-rules.js    ← ../shared/rule-catalog.js (SC04, SC05, tableAnalysisKey — the DMN rules of the scenario pipeline)
    ├── requirement-order.js (no deps — `requirementKey` and `orderedRequirements`, the one place a
    │                          requirement's identity and emitted order are derived; shared by layout,
    │                          coordinates, dmn-xml and import so geometry and bytes depend on the
    │                          model, not on the `requirements` array order)
    ├── layout.js            ← constants.js, requirement-order.js, ../shared/utils.js, elkjs (decisionCoreToElk, runDmnElkLayout)
    ├── coordinates.js       ← constants.js, requirement-order.js, ../shared/geometry.js (buildDmnDiagrams, per-diagram coordMap)
    ├── di-check.js          (checkDmnDiagramIntegrity — DD01–DD03, mirrors bpmn/di-check.js)
    ├── dmn-xml.js           ← ../shared/utils.js, requirement-order.js, dmn-moddle
    │                          (generateDmnXml, validateDmnXml)
    ├── svg.js               ← constants.js, pathmap.js, requirement-order.js, ../shared/utils.js,
    │                          ../shared/text-layout.js (generateDmnSvg — the DRD as SVG, a pure
    │                          translation of the coordMap the DMNDI carries; dmn-js 17.12.3 shapes/markers)
    ├── pathmap.js           (no deps — dmn-js-drd 17.12.3 KNOWLEDGE_SOURCE / BUSINESS_KNOWLEDGE_MODEL
    │                          templates + getScaledPath)
    ├── table.js             ← constants.js, ../shared/text-layout.js (layoutDecisionTable(s) — the ONE
    │                          table layout: hit policy, three-line heads, rows, every box)
    ├── table-text.js        ← constants.js, table.js (formatTableMarkdown, formatTablePlainText — words only)
    ├── table-svg.js         ← constants.js, ../shared/utils.js (generateTablesSvg — translates table.js)
    ├── table-html.js        ← constants.js, ../shared/utils.js (generateTablesHtml — translates table.js)
    ├── doc.js               ← constants.js, table-text.js (generateDmnMarkdown — the --doc Markdown)
    └── constants.js         ← ../shared/utils.js (DRD shape sizes, spacing, edge markers, render and table
                               styles, hit-policy indicators, `dmnLabels(locale)` — every word of the
                               table views, from CFG.dmn.labels)
  load-decisions.js          ← schema-gate.js, import.js (loadDecisionFile — a --decisions file, JSON or
                               DMN routed by content; shared by the bpmn and scenarios CLIs)
  import-scope.js            (no deps — the coverage table: one row per non-abstract global element
                               in DMN13.xsd/DMNDI13.xsd, disposition `mapped`/`reported`/
                               `parser-blind`, plus DMN_NESTED_TYPE_COVERAGE, DMN_XSD_DEFAULTS and
                               IMPORT_CODES IM01–IM09. The importer's ONLY exclusion list)
  import.js                  ← import-scope.js, requirement-order.js, schema-gate.js,
                               ../shared/resource-paths.js, dmn-moddle
                               (DMN XML → Decision-Core + a structured loss report. `parseDmnXml`
                               async/throwing, `moddleToDecisionCore` pure+sync, `dmnToDecisionCore`
                               the public path returning `{dc, report}` — a shaped failure, never a
                               throw. `report.lossless` is the one bit a caller branches on; paths
                               are positional. Reads no DMNDI and fabricates none — Decision-Core is
                               coordinate-free and layout.js re-lays-out on every emit, so every
                               diagram is an IM06 finding — so even a file this generator wrote imports as
                               not lossless. Not reached by runDmnPipeline, but it has its own CLI:
                               `node dmn/import.js <input.dmn | -> [output.json] [--strict]`, and
                               load-decisions.js — the scenarios CLI and the BPMN CLI's
                               --decisions — imports through it)
  (produces a real .dmn file, XSD-validated, and the DRD as SVG — see
   docs/superpowers/plans/2026-07-30-dmn-integration.md for what is still open: the tool surface,
   Stage 7.)

Agent subsystem (scripts/agents/)
  chat.js, compliance.js, layout.js, llm-provider.js, modeler.js, prompt-sections.js, reviewer.js

Robustness subsystem (scripts/robustness/)
  cli.js, curate-mad.js, failure-classifier.js, fixture-persister.js,
  graph-isomorphism.js, mad-validator.js, report-generator.js,
  stress-tester.js, synthetic-generator.js
  (+ seed-catalog.json, config.json, README.md)

Scenario subsystem (scripts/scenarios/) — opt-in, not reached by runPipeline
  enumerate.js               ← ../bpmn/workflow-net.js, ../shared/utils.js
                               (enumerateScenarios — every distinct path a token can take
                               through ONE process, with a per-backward-edge cycle bound
                               and parallel interleavings collapsed to one canonical order
                               plus a count. Enumerates, never judges.)
  collaboration.js           ← ../bpmn/workflow-net.js, enumerate.js
                               (enumerateCollaboration — composes per-pool Petri nets over
                               message flows, drives the same traversal jointly.)
  decision-table.js          ← ../shared/utils.js
                               (analyzeDecisionTable — DMN hit-policy branching + gap/overlap
                               analysis over a Decision-Core table, symbolic, never a
                               reachability claim.)
  bridge.js                  (resolveBridge — resolves BPMN decisionRef against DMN decision
                               tables; pure static matching, no per-firing lookup.)
  format.js                  ← ../bpmn/workflow-net.js, ../bpmn/topology.js, enumerate.js,
                               ../shared/utils.js
                               (formatScenarioResult / formatCollaborationResult — the JSON
                               and Markdown views over enumerated scenarios: decision labels
                               recovered from t_<gw>_choice_<i> transition ids, sorted and
                               grouped around the model's happy path — marked via
                               isHappyPath, derived via BFS otherwise. Grouping key is BPMN
                               gateways only, not DMN — see the module doc for why.)
  pipeline.js                ← collaboration.js, decision-table.js, bridge.js, format.js,
                               ../bpmn/scenario-rules.js, ../dmn/scenario-rules.js,
                               ../cross/rules.js, ../dmn/load-decisions.js
                               (runScenarioPipeline — Orchestrator + CLI, mirrors
                               dmn/pipeline.js's idiom. Always routes through the
                               collaboration pair (enumerateCollaboration /
                               formatCollaborationResult), even for a pool-less lc — a plain
                               single-process Scenario carries no sinkTokens, which would
                               silently drop SC06 coverage; enumerate.js/its
                               enumerateScenarios/formatScenarioResult are therefore never
                               called from here. Calls the remaining modules above in order
                               and assembles their outputs. runScenarioRules calls the three
                               scenario rule modules and sorts their findings by rule id.
                               Integration only — no new computation or judgment.)

Cross-notation (scripts/cross/) — opt-in
  rules.js                   ← ../shared/rule-catalog.js (SC02, SC03 — a decisionRef that
                               resolves to no DMN decision / to more than one; layer
                               `consistency` of the cross-notation rule set; called only by
                               scenarios/pipeline.js)
  decision-doc.js            ← ../scenarios/bridge.js, ../dmn/table.js, ../dmn/table-text.js,
                               ../dmn/constants.js, ../dmn/schema-gate.js (applyDecisionDocumentation —
                               a businessRuleTask's decision table into its documentation, between
                               two marker lines, replaced on every run; matching is resolveBridge's.
                               Called only by bpmn/pipeline.js, for runPipeline's `decisions` option)
```

**Guiding principle:** Each pipeline step is independently replaceable, configurable, and testable.

### The geometry contract

`coordMap` (`{ coords, laneCoords, poolCoords, edgeCoords, edgeLabels, nodeLabels }`) is the contract between
layout and rendering. Two rules make it hold:

1. **Every drawable element has its geometry in `coordMap` — renderers only translate, never compute.**
   ELK is a *producer*, not the contract: its vocabulary is nodes and edges, BPMN's is larger.
   Boundary events, artifacts, message flows and associations are all outside it, so each needs its
   own placement step (`coordinates.js` §5.0-, §5.4, `routeMessageFlows`). Letting a renderer compute
   geometry means computing it *twice* — `svg.js` for humans, `bpmn-xml.js` for tools — and the two
   copies drift. That has happened three times; see **Do NOT**.
   Sequence-flow endpoints are clipped in `coordinates.js` §5.1; the only passes that may move one
   afterwards are `reclipStuckEnds` and, when `layout.bendRule` is on, the bend rule
   (`bend-rule.js`), and only to the midpoint of another side of the same node — or, for the bend
   rule on a rectangle, to a projection port: the point of a side level with the counterpart,
   `layout.bendRuleLimits.portCornerMarginPx` clear of the corners, which lies on the outline as
   exactly as a midpoint does.
   External node labels (events incl. boundary events, gateways, data objects and stores) are boxes
   in `coordMap.nodeLabels` (`placeNodeLabels`, `coordinates.js` §5.7), re-derived in `pipeline.js`
   after the last pass that moves a node; `bpmn-xml.js` writes the box as the `BPMNLabel` bounds and
   `svg.js` draws its `lines` into it. The SVG canvas is sized to include these boxes, with both layout
   switches on or off — so a label reaching past the shapes' margin enlarges the canvas in every mode.
   A text annotation's `coords` entry is the one entry that carries more than `{ x, y, w, h }`: its
   `lines`, because the box is sized from them. `artifactSize(node)` (`coordinates.js`) lays the
   text out the way bpmn-js lays out a TextAnnotation (`layout.textAnnotationText`) and is the one
   size source for both `layout.js` (`artifactReserveHeight`) and `placeArtifacts`; `bpmn-xml.js`
   writes the box, `svg.js` draws `lines` into it and never re-wraps.
2. **Anything depending on final geometry runs last.** Message flow routes must lie in the gap
   between participants, so `routeMessageFlows()` runs in `pipeline.js` *after* visual refinement —
   the last pass that can still move a participant. Two label passes run after it, in this order:
   1. `repairMessageFlowLabels` (`layout.messageFlowLabelRepair`, on by default, #88): a message-flow
      label that overlaps a route (its own or another flow's), a shape, a node label, another edge
      label or a participant header, or crosses a lane separator or a participant's top or bottom
      outline — or comes closer than `layout.messageFlowLabelClearancePx` to any of those lines or
      shapes — moves to the nearest clear spot beside one of its own segments (`layout.edgeLabelGap`
      px off it, the same `besideSegment` rule as every edge label, slid along it in
      `layout.messageFlowLabelSlidePx` steps, at most `layout.messageFlowLabelMaxMovePx` from where it
      was). Only message-flow labels move; sequence-flow and node labels are obstacles. The
      sequence-flow label repair (`repairEdgeLabels`) runs before `routeMessageFlows` and never sees
      message-flow labels. A label that still has no clear spot because the gap between two
      participants is too narrow gets that gap grown (`growParticipantGapsForLabels`, at most
      `layout.messageFlowLabelMaxGapGrowthPx` per gap): the participants below move down rigidly and
      `routeMessageFlows` and the repair run **again** inside it — this is the one pass after
      `routeMessageFlows` that moves a participant, so it re-routes message flows itself and they
      stay the last routing step. A growth is kept only where it clears the label. A rigid shift moves
      nothing inside a participant, so no earlier pass needs redoing.
   2. `placeNodeLabelsAvoidingFlows` (`layout.nodeLabelsAvoidFlows`, on by default): it moves an
      event's or a gateway's label off the bottom when one of its sequence or message flows docks at
      the bottom, or when an own flow runs through the default label box, and a message flow's port is
      only known once message flows are routed.
   Node-label avoidance changes label boxes only, never a route or a participant.
   Why this order: edge labels are settled before node labels choose among their candidates. Each
   pass treats the other's boxes as obstacles and never moves one, so neither can undo the other —
   the message-flow repair avoids every node label where it stands, and a node label moved
   afterwards only goes to a spot clear of every edge label, the repaired ones included. Nothing
   but the two renderers reads either kind of label afterwards.

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
| `scripts/bpmn/rules.js` | Rule engine of the BPMN rule set: 40 BPMN rules, 5 layers (Soundness/Style/Pragmatics/Workflow-Net/Optimization; last two opt-in) — 38 run here, SC01/SC06 in the scenario pipeline; M05/M06 severity=OFF. Counts per rule set: `VOCABULARY.ruleSets` (`scripts/shared/ontology.js`). Layer and default severity of every rule come from `references/ontology.jsonld` via `buildRuleCatalog`; the code keeps only the checks (`RULE_REGISTER`). |
| `scripts/bpmn/optimize.js` | `runOptimizationAnalysis` — graph-heuristic redesign advisories (O01–O04) + Lean metrics; opt-in via `optimize`/`soll` mode |
| `scripts/bpmn/redesign.js` | Five deterministic redesign transforms (`parallelize`, `mergeTasks`, `relane`, `reorderKnockouts`, `isolateException`), each as a `preview*` (feasible? why/why not) + `apply*` pair; no LLM |
| `scripts/bpmn/redesign-core.js` | Shared redesign kernel: profile-independent soundness gate (`SOUNDNESS_GATE`/`checkGate`), deterministic collision-free IDs (`nextId`), protection-list matching by id/name (`isProtected`), cross-format lane resolution (re-exported `resolveLaneId` from `topology.js`) |
| `scripts/bpmn/redesign-cli.js` | CLI entry to the redesign toolbox (`node bpmn/redesign-cli.js <input.json> <transform> [options] [--apply]`); preview is the default, nothing is written without `--apply`, a refusal exits non-zero and writes nothing |
| `scripts/bpmn/validate.js` | Thin wrapper around `runRules()` |
| `scripts/shared/ontology.js` | Loader for `references/ontology.jsonld` (read as plain JSON, ajv-validated at import — an invalid ontology fails the process, a missing file names both paths tried). `buildVocabulary`/`VOCABULARY`: class members, node types and their status (`supported`/`announced`), markers (incl. lossy ones, which need a reason), definition kinds, per-field domains. Exported as `bpmn-generator/ontology`. `ontology-audit.js` finds vocabulary lists outside it; `ontology.test.js` fences schema enums equal to it |
| `references/ontology.jsonld` | The vocabulary and rule catalog, one JSON-LD file: BPMN classes, 26 node types (announced ones such as `adHocSubProcess` included), 12 markers, 4 definition kinds, one `rdf:Property` per schema field with `allowedOn` (`bg:allowedOn`, not `rdfs:domain`) — BPMN fields only: the `rdf:Property` schema admits the Decision-Core element names (the `decision-core-schema.json` `$defs` names `Requirement`, `DecisionTable`, `InputClause`, `OutputClause`, `DecisionRule`, plus `DecisionCore` for the root; `Node` is shared with BPMN, a DMN property being told apart by its notation) but no per-field DMN `rdf:Property` entries exist yet; the DMN terms (node kinds, requirement kinds, hit policies, aggregations, orientations, expression kinds — `context`/`invocation`/`list`/`relation` announced); notations (BPMN, DMN; ArchiMate announced), severities, layers and every rule. Linked to the OMG metamodel (BPMN20.cmof), the DMN 1.3 XSD namespace, SHACL and BBO via `rdfs:seeAlso` only — no import, no reasoner. Labels are proper element names |
| `scripts/bpmn/types.js` | `isEvent`, `isGateway` (all type sets derive from `references/ontology.jsonld` via `scripts/shared/ontology.js` — no list of its own), `isArtifact` (layout sense — kept out of the ELK graph; wider than the BPMN class, includes data references), `isBpmnArtifact` (the actual OMG Artifact class — TextAnnotation, Group; use this one for anything that has to be right against the XSD), `bpmnXmlTag` (strict: an unknown or announced type throws), plus `OMG_NODE_FIELD_SCOPE`/`isFieldOutOfScope` — the single table of which node classes may carry which OMG-scoped per-node field (`isCompensation`, `implementation`, `isEventSubProcess`, `calledElement`, `scriptFormat`, `isCollection`). Read by **both** `bpmn-xml.js`'s `buildFlowNode` (drops an out-of-scope field, so the XML stays valid) and `rules.js`'s S15 (reports the drop, so it is not silent). Add a scoped field here, never inline in either consumer — the two disagreeing is the defect the table exists to prevent. Note `implementation`'s scope is narrower than `Activity` (five invoking Task types only), which is why the table is per-field rather than one `isActivity` test |
| `scripts/shared/utils.js` | `loadConfig`, `CFG`, `esc`, `wrapText`, `EXTENSION_NS` (our own `extensionElements` namespace — always create those via `moddle.createAny(name, EXTENSION_NS, …)`; setting a prefixed attribute in `$attrs` without a matching `xmlns:` declaration makes moddle **drop the value silently**, logging to stderr while `warnings` stays empty). Carries only what both `bpmn/` and `dmn/` use — the 15 BPMN-only constants live in `scripts/bpmn/constants.js` |
| `scripts/bpmn/constants.js` | The 15 BPMN-only constants (`SHAPE`, `SW`, `CLR`, `SYM` — the renderer's look from `config.json → symbols` —, `FIRST_BASELINE` (Text.js's ¾-line baseline), `LANE_HEADER_W`, `LANE_PADDING`, `LABEL_DISTANCE`, `TASK_RX`, `INNER_OUTER_GAP`, `EXTERNAL_LABEL_H`, `POOL_GAP`, `COLLAB_PADDING`, `MESSAGE_FLOW_FAN`, `ARTIFACT_GAP`), derived from `CFG` (`../shared/utils.js`) — never imported by `dmn/` |
| `scripts/bpmn/topology.js` | `assignProcessId`/`withProcessId` (the one place a single-process Logic-Core without `id` gets `Process_1`, `_2`… on collision; the public `generateBpmnXml`/`logicCoreToDot`/`runScenarioPipeline`), `inferGatewayDirections`, `sortNodesTopologically`, `orderLanesByFlow`, `normalizeLaneAssignments`, `identifyHappyPathNodes` (which nodes an `isHappyPath` edge chain touches — also read by `scripts/scenarios/format.js`), `normalizeEdgeIds`/`assignEdgeIds` (the one place an id-less sequence-flow edge gets its `flow_<source>_<target>` id, `_2`… on collision — nothing downstream invents one), `resolveLaneId` (the single cross-format lane resolver — `node.lane` **or** `Lane.nodeIds`; lives here to stay clear of the `redesign-core → rules → optimize` import cycle) |
| `scripts/bpmn/layout.js` | `logicCoreToElk`, `runElkLayout` (ElkJS Sugiyama) |
| `scripts/bpmn/coordinates.js` | `buildCoordinateMap`, `clipOrthogonal`, pool width balancing; owns the **vertical** axis (§5.0a lane bands, §5.0b2 participant stacking) — ELK owns only x. Node label boxes: `placeNodeLabels` (default, below the node) `placeNodeLabelsAvoidingFlows` (`layout.nodeLabelsAvoidFlows`, default `true`; per call `runPipeline(lc, { nodeLabelsAvoidFlows: false })`): an event's or gateway's label whose own sequence or message flow leaves or enters the node through the bottom, or runs through the label on its way, goes to the first free `nodeLabelCandidates` box — below, above, right-below, left-below; free = no route, shape, node or edge label, lane separator, and inside the participant — else stays below. Runs in `pipeline.js` after `routeMessageFlows` and `repairMessageFlowLabels`. `repairMessageFlowLabels` (`layout.messageFlowLabelRepair`, default `true`; per call `runPipeline(lc, { messageFlowLabelRepair: false })`): a message-flow label on a route, shape, node or edge label, participant header (`participantHeaders`), lane separator or participant outline (`participantOutlines`), or closer than `layout.messageFlowLabelClearancePx` to a line or shape, goes to the nearest clear spot beside one of its own segments within `layout.messageFlowLabelMaxMovePx`, else stays; repeated to a fixpoint (idempotent). `growParticipantGapsForLabels` (same switch, `layout.messageFlowLabelMaxGapGrowthPx`): grows a participant gap too narrow for a label, shifts the participants below rigidly, re-routes message flows and repairs again; kept only where it clears the label |
| `scripts/bpmn/di-check.js` | `checkDiagramIntegrity` — post-layout geometry pass. DI01 identical participant positions, DI02 overlapping participants, DI03 node outside its participant, DI04 overlapping lane bands, DI06 child outside its expanded subprocess, DI07 sequence-flow endpoint off its own shape (all ERROR); DI05 message flow crossing an uninvolved participant, DI08 a sequence-flow end segment lying on its own endpoint's outline, DI09 a sequence flow through its own source or target shape, DI10 a message flow through a foreign shape, DI11 a sequence flow through a shape that is neither its source nor its target (a boundary event of its own source or target included, said in the message; artifacts, groups and boxes holding an endpoint excluded) (all WARNING). `ok` means "no ERROR". Result lands in `result.diagnostics`, **not** in `validation` |
| `scripts/bpmn/topology.js` | additionally `orderParticipantsByMessageFlow` — stacks participants so that communication partners are adjacent (exact search up to 8 participants, heuristic above). Toggle: `poolOrder: 'auto' \| 'declared'` |
| `scripts/bpmn/bpmn-xml.js` | `generateBpmnXml` — OMG-compliant BPMN 2.0 XML + DI |
| `scripts/bpmn/svg.js` | `generateSvg` — SVG rendering of all BPMN elements |
| `scripts/bpmn/icons.js` | Event icons, task-type icons, task markers (in bpmn-js's order and offsets), gateway symbols, data-object/-store and annotation shapes — each mirroring a named bpmn-js 18.6.2 `BpmnRenderer` handler, element-relative (svg.js wraps them in one `translate`). Colours, stroke widths, dashes, fonts: `config.json` (`color`, `strokeWidth`, `symbols`) |
| `scripts/bpmn/pathmap.js` | bpmn-js 18.6.2's `PathMap` glyph templates and `getScaledPath`, verbatim data (bpmn.io license), so our icons have bpmn.io's geometry. Glyph data, not tuning knobs |
| `scripts/bpmn/dot.js` | `logicCoreToDot` / `dotToLogicCore` — Graphviz DOT support |
| `scripts/bpmn/workflow-net.js` | WF-Net soundness checks (used by WF01–WF03 rules). `bpmnToPN` also owns the translation itself: a container becomes its own subnet (`buildContainer`) and a boundary event becomes an XOR alternative to its host, consuming exactly the places the host consumes — one transition per host transition, so a container's multi-entry split and an implicit-merge host are both mirrored rather than AND-joined (`wireBoundaryEvents`). What the translation under-models rather than skips is listed on `pn.approximations` (today: a non-interrupting boundary event, and a boundary event on a container) |
| `scripts/bpmn/net-check.js` | `checkNetIntegrity` — post-translation sanity pass on the net `bpmnToPN` produces, the same role `di-check.js` plays for geometry: checks whether the *translation* is faithful (every node has a transition, every place is produced and consumed, every id is unique), never whether the *model* is sound — a legitimately unsound process must come out clean, `checkSoundness`/WF01–WF03's job. NC01 node with no transition, NC02 transition that can never fire, NC02b/NC03a/NC03b/NC06 the same class of drop applied to arcs/places/ids (all ERROR — NC02 became ERROR once boundary events got a translation, its one legitimate cause). NC02/NC02b are scoped to the translation by that same doctrine: they fire only when the Logic-Core gives the node an input (resp. output) the net does not have, so a node nothing routes to is WF01's finding and not theirs — plus S04's, but only where the node has no edges at all; a node with an outgoing flow but no incoming one (a stranded `parallelGateway`, say) passes S04 and S07 both and is caught only by the opt-in WF01 (see CHANGELOG's Known limitations) — and a boundary event's `attachedTo` host counts as an input source, without which the narrowing would blind NC02 to the very defect its promotion was for; NC04 (two distinct edges assigned the same place) is ERROR since every flow got a place of its own, but note it reads `pn.placeOfEdge` rather than re-deriving the id, so it asserts `namePlaces`' invariant against `namePlaces`' output — a regression fence that cannot fire under the current naming rule, not a check of the net against the Logic-Core; NC05 (multiple start events sharing one source place) is INFO — disclosure, not a defect. `ok` means "no ERROR". Wired into `runPipeline` as `result.netDiagnostics` (`{ ok, issues }`, `null` on the early-return path, one call per pool, findings prefixed `[pool] ` and carrying `process`) — **computed before `logicCoreToElk`**, because `preprocessLogicCore` rebuilds `proc.nodes` from an id-keyed map in place and would erase a duplicate-id defect before a later check could see it. A separate key from `diagnostics`, whose `code` is a closed DI enum in `references/api-schema.json`. The CLI gates on it as it gates on DI, with one difference: **INFO is printed and never fatal**, not even under `--strict` — NC05 says in its own message that it is not a defect. Both gates sit on the ordinary generate path; `--drill-down` bypasses NC exactly as it already bypasses DI. Not surfaced over HTTP or MCP. NC06 is scoped to duplicate **node** ids — two edges sharing an id are translated faithfully (places are keyed by node pair, `placeOfEdge` by edge identity), so that half belongs to the serialisation round-trip, where a `duplicate ID <…>` warning in `validation.xmlWarnings` is unconditionally fatal on the CLI (exit 1, no files written, `--strict` or not); the rest of that channel stays non-fatal outside `--strict`. Also fenced over every top-level fixture in `tests/fixtures/` by `net-check.test.js` |
| `scripts/bpmn/visual-refinement.js` | The refinement passes — `laneCompaction` (`compactLanes`) and `edgeLabelCollisionRepair` (`repairEdgeLabels`), both on by default; `resolveRefinement` turns the `visualRefinement` option into per-pass switches and rejects an unknown key or a non-boolean; `VISUAL_REFINEMENT_OPTION_SCHEMA` is the same contract for the HTTP/MCP gate (fenced against `references/api-schema.json`). ELK wrapping is not a pass here — it is `layout.elkWrapping` / `--wrap` |
| `scripts/bpmn/edge-simplify.js` | Post-process ELK edge waypoints to reduce zigzag bends; `repairCrossings` re-routes edges that cross another, falling back to `orthogonal-router.js` when its own fixed-shape candidate search finds nothing admissible; `guardAgainstLegacy` reverts single #52 re-routes that cost a crossing; `reclipStuckEnds` may move an endpoint to another side's midpoint when every fixed-endpoint route still ends along an outline or runs through the edge's own shape — the one exception to endpoint clipping in coordinates.js §5.1; `rerouteAfterCompaction` re-runs simplify → legacy guard → crossing repair for the flows lane compaction bent, then `keepOffLaneLines` keeps their inner legs `visualRefinement.laneLineClearance` px off lane separators. `guardAgainstLegacy` runs only while `layout.crossingRepair` is enabled. `layout.endStubPx` must stay above orthogonal-router's `PAD` (12), asserted at load by `assertStubClearsPad`; `layout.alongOutlineMinPx` is the one along-outline threshold (edge-simplify, DI08, bench) |
| `scripts/bpmn/orthogonal-router.js` | `routeAroundObstacles` — obstacle-aware orthogonal Dijkstra pathfinder ("trellis"/extended-lines grid + per-bend cost penalty + soft crossing penalty), three callers: in `edge-simplify.js` `repairCrossings` (fallback candidate source) and `reclipStuckEnds` (the route between the two 15 px end stubs, for each port pair it tries), and `bend-rule.js` (fallback when no 0/1/2-bend shape is admissible). The router never chooses an endpoint: it routes between the two points it is given, and its caller decides whether an endpoint moves |
| `scripts/bpmn/bend-rule.js` | `applyBendRule` — routing pass (`layout.bendRule`, default `true`; per call `runPipeline(lc, { bendRule: false })` switches it off): a sequence flow is re-routed when an admissible route has fewer bends, or as many bends and enters an activity/event from the left (leaves one to the right; gateways free). Endpoints stay put or move to a side midpoint, on a rectangle also to a projection port (level with the counterpart's centre or endpoint, `portCornerMarginPx` from the corners); a boundary event's never moves. Admissible = no end defect, clear of foreign shapes, inside its region, at most `lengthFactor`× + `lengthSlackPx` longer, and per edge not worse than the current route in crossings, lane-line hug, length of collinear overlap (legs closer than `collinearPx` count as one line), crowding, `coordMap.nodeLabels` hits, side conflicts, shared ports (two flows out of — or into — one gateway/event side, or one rectangle point; rechnungspruefung's „Betrag über 10.000 EUR?“) and the later message-flow line; no new top/bottom port at a message-flow node. A re-routed flow's label is refreshed with the other routes as obstacles (`placeEdgeLabel`'s `avoidRoutes`; the first candidate off every route, else off its own). Limits in `layout.bendRuleLimits`. Greedy in edge order, repeated to a fixpoint (idempotent). Runs in `pipeline.js` after lane compaction and its re-route, before edge-label repair and `routeMessageFlows`. `bendMetrics` is the same search as a measure (avoidable bends, entries against the flow), read by `scripts/bench/flow-metrics.mjs` |
| `scripts/bpmn/schema-gate.js` | `validateLogicCoreSchema` — ajv draft-2020-12 strict gate for the HTTP API and MCP; also `validateVisualRefinementOption` |
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
| `scripts/scenarios/enumerate.js` | `enumerateScenarios(proc)` — path enumeration over one process's Petri net. Reuses `bpmnToPN` and the firing primitives from `scripts/bpmn/workflow-net.js`, but runs its own traversal: `checkSoundness` deduplicates markings, which is right for "is the sink reachable?" and wrong for "which distinct paths reach it?". Cycles are bounded per backward edge (graph back edges via DFS colouring — **never** `loopType`/`loopMaximum`, which is one activity repeating, not a rework loop); parallel branches collapse to one canonical order carrying `interleavingCount`. Bounds in `config.json → scenarios` |
| `scripts/scenarios/format.js` | `formatScenarioResult` / `formatCollaborationResult` — the presentation layer over `enumerate.js`/`collaboration.js`'s output: a complete JSON view (every scenario tagged with its decision sequence, group key, happy-path distance) and a grouped, capped Markdown view. Decision labels are recovered from `t_<gw>_choice_<i>` transition ids against the process's own flattened edges (only XOR/inclusive-gateway SPLITs count, never a merge or pass-through). Happy path is `isHappyPath`-marked when declared, else a deterministic BFS fallback (`deriveHappyPathEdges`) excluding backward and boundary-event-adjacent edges — the output always says which. Grouping key is BPMN gateways only, not DMN choices (see the module doc). Cap in `config.json → scenarios.format.maxGroupsRendered` |
| `scripts/scenarios/decision-table.js` | `analyzeDecisionTable(table)` — DMN hit-policy-aware branching (UNIQUE exact, FIRST/PRIORITY overestimated-and-flagged, COLLECT/ANY/RULE ORDER/OUTPUT ORDER aggregated not branched) plus gap/overlap analysis over a Decision-Core table's `when`/`then` FEEL-subset text (numbers, dates, strings, intervals, enumerations, `-` wildcard). A column outside that grammar makes its whole rule "unanalyzable", never guessed at column-by-column. Cap in `config.json → scenarios.decisionTable.maxPartitionCells` |
| `scripts/scenarios/bridge.js` | `resolveBridge(lc, decisionCores)` — resolves every BPMN `decisionRef` occurrence (recursive walk into subprocess/transaction children) against every Decision-Core document's decision tables, by id. Three outcomes per occurrence: `resolved` (exactly one match), `unresolved` (none), `ambiguous` (more than one distinct Decision-Core document claims the same id). A static pre-pass, no per-firing lookup during enumeration |
| `scripts/bpmn/scenario-rules.js` | SC01 (a branch of an acyclic XOR split no scenario takes) and SC06 (improper completion at a scenario's shared sink) — the BPMN rule set's `scenario` partition; `findAcyclicDecisionGateways`; `runBpmnScenarioRules(context)`. Severity from the ontology (WARNING), not profile-switchable. Its header carries the full rationale for all six SC rules |
| `scripts/dmn/scenario-rules.js` | SC04 (decision-table gap) and SC05 (overlap under UNIQUE) — the DMN rule set's `scenario` partition; `tableAnalysisKey(link)` (the exact key `context.tableAnalyses` must be indexed by), `countSkippedTableAnalyses`, `runDmnScenarioRules(context)` |
| `scripts/cross/rules.js` | SC02/SC03 — the cross-notation rule set (layer `consistency`): a `decisionRef` that resolves to no / to several Decision-Core decisions; `runCrossRules(context)`. Names no notation itself |
| `scripts/scenarios/pipeline.js` | `runScenarioPipeline(lc, decisionCores, options)` — Orchestrator + CLI + Public API for the scenario-enumeration subsystem, mirroring `dmn/pipeline.js`'s idiom; always routes through `enumerateCollaboration`/`formatCollaborationResult`, even for a pool-less `lc` (the plain single-process `enumerateScenarios`/`formatScenarioResult` pair is never called, since it would silently drop SC06 coverage — see the module's own doc comment), resolves the bridge, analyzes every resolved table, formats, then judges — integration only, no new computation; `runScenarioRules(context)` calls the three scenario rule modules and sorts their findings by rule id (stable), `scenarioJsonText(result)` is the exact CLI JSON |
| `scripts/bpmn/import.js` | BPMN XML Parser → Logic-Core JSON |
| `scripts/config.json` | Externalized constants (shapes, colors, spacing) |
| `scripts/shared/rule-profile.js` | `assertRuleProfile`, `loadRuleProfile`, `loadNamedRuleProfile`, `isRuleEnabled`, `getEffectiveSeverity`, `auditProfile` — what a profile *means*, shared by both rule engines. Nothing here prints or knows about processes or decisions. **Every profile passes `assertRuleProfile` before any rule logic reads it** — a 64 KiB / 4-level bound (an early-exit walk, never a full stringify), then `references/rule-profile-schema.json` (ajv strict; top-level keys exactly those of the committed profiles, severities fenced equal to the ontology); both runners and both `profileForMode` variants call it. `loadRuleProfile` (CLI/library, a path) and `loadNamedRuleProfile` (MCP, a name inside `rules/`) open the file non-blocking and refuse anything that is not a regular file of at most 256 KiB; a missing path is an empty profile marked missing (the runner warns), a file that is not JSON throws `ProfileRejectedError` naming line and column, never content. Provenance travels out of band (`profileProvenance`), so a client cannot forge it with `$source`/`$missing` keys (the schema refuses those). `auditProfile` lists unknown rule ids, unknown layers and scenario-rule overrides (warnings), and unknown severities and an `ADVISORY` override outside the optimization layer (errors — `classifyResult` would drop the finding) — capped at 20 plus a count, every client token through `quoteForMessage`; the runner reports them. `assertLayerNotWeakened` is the HTTP API's refusal to let a client disable the soundness layer or set a soundness rule below its default severity (`profileContext().ruleDefaultSeverity`). The HTTP API maps `ProfileRejectedError` to `400 profile_error` |
| `scripts/shared/rule-catalog.js` | `buildRuleCatalog(register)` — joins a rule module's register (`{ module, partition, entries }`, checks only) with the ontology's rule metadata at import, and aborts that module's import on a rule only in code, only in the ontology, in the wrong module, or carrying its own `layer`/`defaultSeverity`; `registerFindings`, `rulesExpectedIn`, `partitionForModule` (path ⇒ rule set + run location). Imports only `ontology.js` |
| `scripts/dmn/schema-gate.js` | `validateDecisionCoreSchema` — ajv gate for `references/decision-core-schema.json` |
| `scripts/dmn/rules.js` | `DMN_RULES`, `runDmnRules`, `dmnProfileForMode` — 19 DMN rules, 3 layers, 2 modes (17 run here, SC04/SC05 in the scenario pipeline). **Counted separately from the BPMN rule set** — see the DMN section under Rule Engine. Layer and default severity come from `references/ontology.jsonld` via `buildRuleCatalog` (`RULE_REGISTER`), not from literals in code |
| `scripts/dmn/dmn-xml.js` | `generateDmnXml`, `validateDmnXml` — DMN 1.3 XML + DMNDI via dmn-moddle, mirroring `bpmn-xml.js` |
| `scripts/dmn/import.js` | `dmnToDecisionCore(xml)` → `{ dc, report }` — DMN 1.3 XML → Decision-Core plus a structured loss report (`IM01`–`IM09`, positional paths); `report.lossless` is the one bit a caller branches on, and a failure is a shaped result, never a throw. Reads no DMNDI: Decision-Core is coordinate-free and `layout.js` recomputes the layout on every emit, so every diagram is an IM06 finding. **Consequence worth knowing: a `.dmn` this generator wrote imports as not lossless** (it also generates the `<variable>`/`<literalExpression>` ids it then reports as IM05), so `--strict` on the import CLI or on `scenarios/pipeline.js --decisions` aborts on our own output. The claimable statement is "no finding outside IM05/IM06", asserted by `roundtrip.test.js`. The CLI is `node dmn/import.js <input.dmn \| -> [output.json] [--strict]`: not-XML and not-DMN input exit with a message, `--strict` aborts on a lossy import and writes nothing, and the output passes the Decision-Core schema gate |
| `scripts/dmn/import-scope.js` | The importer's coverage table — one row per non-abstract global element in `DMN13.xsd`/`DMNDI13.xsd` (`mapped`/`reported`/`parser-blind`), nested-type coverage, XSD defaults and the `IM01`–`IM09` codes. The only exclusion list; `import-coverage.test.js` fences it against the XSDs |
| `scripts/dmn/requirement-order.js` | `requirementKey`, `orderedRequirements` — the one place a requirement's identity and emitted order are derived, so DMN XML and DRD geometry depend on the model and not on the `dc.requirements` array order (a permutation fence in `requirement-order.test.js`). Dependency-free; used by `layout.js`, `coordinates.js`, `dmn-xml.js` and `import.js` |
| `scripts/dmn/pipeline.js` | `runDmnPipeline` — Orchestrator + CLI + Public API for the DMN side, gate order schema→rules→layout→coordinates→di-check→serialisation; then the views: `svg` (the DRD) always, `markdown`/`tablesSvg`/`tablesHtml` with `doc: true` (CLI `--doc`: `.md`, `.tables.svg`, `.tables.html`) |
| `scripts/dmn/svg.js` | `generateDmnSvg` — the DRD as SVG, translating the same `coordMap` the DMNDI carries (no offset: the canvas is anchored at the origin by `coordinates.js`); shapes and markers as dmn-js 17.12.3 draws them (`pathmap.js`). Fenced against the DMNDI by `svg.test.js`, the DMN twin of `geometry contract — the two renderers agree` |
| `scripts/dmn/table.js` | `layoutDecisionTable(s)` — the one decision-table layout (hit policy letter/name/meaning, three-line heads "When/And/Then · label · values or type", rows, every box from text metrics). `table-text.js` (Markdown; plain text for BPMN documentation with a sentence fallback above `dmn.table.plainTextMaxWidth`), `table-svg.js` and `table-html.js` only translate it. Words: `config.json → dmn.labels[locale]` (`en`, `de`), styles: `dmn.table` |
| `scripts/cross/decision-doc.js` | `applyDecisionDocumentation(lc, decisionCores)` — runPipeline's `decisions` option (CLI `--decisions`): every `businessRuleTask` with a `decisionRef` gets its decision table in `documentation`, between `=== BEGIN generated: DMN decision …` / `=== END …` marker lines, after the author's text; every run replaces the section (import → regenerate never duplicates it). Matching is `scenarios/bridge.js` `resolveBridge`; unresolved reads "Calls decision: <ref> (table not supplied)". Without `decisions` nothing changes (goldens and the output-hash fence rely on it) |
| `scripts/shared/text-layout.js` | `layoutText`, `lineWidth` — Arial advance widths and diagram-js `Text.js` line breaking, the one text measurement of both notations |
| `references/decision-core-schema.json` | Formal JSON Schema for DMN Decision-Core input |
| `rules/dmn-default-profile.json` | Default DMN profile (semantic: soundness + semantics) |
| `rules/dmn-best-practice-profile.json` | Adds the opt-in `best_practice` layer |
| `rules/custom/` | Project-specific profiles, loaded by path only — see its README |
| `scripts/shared/geometry.js` | `clipStraight`, `clipToRect` — straight-segment clip maths shared by `bpmn/coordinates.js` and `dmn/coordinates.js` (DMN's DRD draws requirement connections as unstyled straight lines, same as a BPMN Association). The orthogonal clip helpers stay in `scripts/bpmn/coordinates.js` |
| `scripts/shared/resource-paths.js` | `inputSchemaPath`, `promptTemplatePath` — the single place that decides where `references/` lives. **The source outranks the in-package copy.** The reverse precedence was a silent trap: `npm pack` (including the `--dry-run` the docs gate runs) leaves a copy behind, and every later edit to `references/` then had no effect while `git status` said nothing, because it is gitignored. Filenames are spelled out literally in each `join(__dirname, …)` — the docs gate parses those calls for string literals, and a variable would make it check a directory |
| `scripts/prepack-copy-references.mjs` | `prepack` lifecycle script — copies `input-schema.json`/`prompt-template.md` from repo-root `references/` into `scripts/references/` (gitignored) so the npm package ships them. npm's `files` cannot reach outside the package root, hence a copy |
| `scripts/postpack-clean-references.mjs` | `postpack` lifecycle script — removes that copy again. npm runs it after both `npm pack` and `npm pack --dry-run`, so a build artifact no longer outlives the build |
| `scripts/build-skill.mjs` | `npm run build:skill` — bundles `SKILL.md` + `references/` + the import closure of the CLIs `SKILL.md` and the bundled `references/*.md` name (`node <file>.js`; `NOT_SKILL_CLIS` — the HTTP and MCP servers — excepted) + `scripts/config.json`/`package.json` into `bpmn-generator.skill` (gitignored, rebuilt on demand); the build aborts when an entry point reaches an excluded module (`agents/`, `robustness/`, a test), and `build-skill.test.js` fences that the bundle is closed under its own imports |
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

1. Add a `bg:Rule` to `references/ontology.jsonld`: `name` (the id), `kind` (`specific`), `notation`
   (`["bg:notation-BPMN"]`), `layer` (a `bg:Layer` of that notation, e.g. `bg:layer-BPMN-style`),
   `defaultSeverity` (`bg:severity-ERROR` … `bg:severity-OFF`) and `runsIn` (`main`, or `scenario`
   for a rule of the scenario pipeline)
2. Add the check to the matching array in `scripts/bpmn/rules.js`: `id`, `description`, `ref`,
   `scope`, `check(proc, lc)` — **no** `layer`, **no** `defaultSeverity`; `buildRuleCatalog`
   (`scripts/shared/rule-catalog.js`) takes them from the ontology and refuses the import while the
   two sides disagree
3. `check` returns `{ pass: true }`, or `{ pass: false, message: '...' }` for exactly **one**
   finding, or `{ pass: false, messages: ['...', '...'] }` for **several**. `message` is taken
   verbatim as a single finding — never join several findings into one string, which is what
   `messages` is for (see `classifyResult`'s doc comment for the defect that produced this rule)
4. Update documentation in `references/fachliches-regelwerk.md`
5. Add tests in `pipeline.test.js`

### Adding a New BPMN Element

1. `references/ontology.jsonld` — add the node type (class, status, xmlTag, seeAlso). Then run `npm test`: `scripts/bpmn/ontology.test.js` names every remaining place (schema enum, shape size, icons, rendering, importers, prompt, docs). The list below is what it will name. `types.js` and both importers' type sets derive from the ontology; nothing there needs editing.
2. `layout.js` — `buildElkNode` for layout dimensions
3. `bpmn-xml.js` — XML serialization
4. `svg.js` — SVG rendering
5. `icons.js` — if icon/marker needed
6. `import.js` **and** `moddle-import.js` — BPMN XML → Logic-Core parsing (both; `moddle-import.js`
   is the primary path, `import.js` the fallback — fixing only one leaves the round trip lossy)
7. `references/omg-compliance.md` — update OMG mapping
8. `references/input-schema.json` — extend schema
9. Raise the minor `version` of the `owl:Ontology` node in `references/ontology.jsonld` and the
   `default` of both `$schemaVersion` blocks in `references/input-schema.json` (the version tests
   enforce that they agree)

### Adding a per-node field

Not the same job as adding an element, and the place this project has got wrong twice.

A field lives in **four** places, and every one of them must learn about it: `bpmn-xml.js`
`buildFlowNode` (write), `moddle-import.js` `nodeFromElement` and `import.js` `nodeFromChild`
(read back), plus the schema. Each of those three functions is deliberately **recursive** and
shared between top-level nodes and subprocess children — put the field in a caller instead of in
the function and it silently applies to one nesting level only.

The failure mode is invisible: bpmn-moddle reports attributes it does not *know*, never fields
that never arrived, so an omission produces no warning and `validation.errors` stays empty.

**So the procedure is: add the property to `references/input-schema.json` and an `rdf:Property`
with its `domain` (JSON key; `bg:allowedOn` in RDF) to `references/ontology.jsonld`, then add a row to
`OMG_NODE_FIELD_SCOPE` (or `OMG_EDGE_FIELD_SCOPE`) in `scripts/bpmn/types.js` (its `allowed` now
comes from that domain), then let `scripts/bpmn/field-fidelity.test.js` name every place you
missed.** A new field raises the minor `version` of the ontology and of both `$schemaVersion` defaults,
as a new element does. Adding the property to `references/input-schema.json` without a row fails CI naming the
property; with a row, the fence drives the field through the real pipeline and back through both
importers, for every class the row allows, at depth 0 and one level down — so a write that skipped
the child path, or a read that only one importer learned, fails with the field, the class, the
depth and the importer path in the message. The row's `roundTrip` column is the whole exclusion
list; there is no second one, so a field you cannot make round-trip is stated as `lossy`/`none`
with a reason rather than quietly skipped.

Second guard, complementary: the field-set round-trip test over
`tests/fixtures/subprocess-child-fidelity.json` (composition — several fields in one realistic
model, where the fence above is one field at a time). Extend that fixture too when the new field
can interact with a boundary event, a grandchild or a data reference.

### Docs gate

CI check (`.github/scripts/docs-gate.mjs`, wired in `.github/workflows/docs-gate.yml`) that
checks documented claims against the running code instead of trusting the prose — added after
the CHANGELOG fell six releases behind and `/api/v1/orchestrate` silently dropped a documented
response field for three commits.

1. Four **proof** checks (exit 1 on violation): the HTTP response contract vs.
   `references/api-schema.json` (ajv, validated against a real response built from each
   endpoint), numeric claims (rule counts per rule set — "N BPMN rules, M layers", "N DMN rules …", "N cross-notation rules …", counted from references/ontology.jsonld; a claim that does not name its rule set at the number fails — "N top-level scripts"
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
3. Only after the diff is reviewed: regenerate via the fixture's documented procedure (typically `node bpmn/pipeline.js <fixture> <out>` and then `cp <out>.bpmn <fixture>.expected.bpmn`). The `.refined.*` goldens (visual refinement) need the `--refine --wrap` flags: `node bpmn/pipeline.js <fixture> <out>.refined --refine --wrap`.
4. Commit golden updates in their own commit, separate from code changes.

### Extend the rule engine

1. Declare the rule in `references/ontology.jsonld` (`bg:Rule`: notation, kind, layer, default severity, run location).
2. Add its check to the matching `*_CHECKS` array of `scripts/bpmn/rules.js` (collected in `RULE_REGISTER`; `RULES` is the catalog built from it) (`id`, `description`, `ref`, `scope`, `check(proc) → { pass: true } | { pass: false, message }`) — never `layer` or `defaultSeverity`.
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
- Realistic German business processes (the bend rule's review examples: lanes, collapsed pools, timers, loops, expanded subprocesses) → `tests/fixtures/example-*.json` (kreditantrag, bestellung-versand, urlaubsantrag, schadenmeldung, onboarding)
- Full list: `ls tests/fixtures/`.

### Change a prompt template

1. Edit `references/prompt-template.md`. The LLM consumes this verbatim.
2. **Re-validate downstream**: any change must still produce valid Logic-Core per `references/input-schema.json`. Run a sample text through the orchestrator (`scripts/agents/modeler.js`) and check the schema-validation step passes.
3. Update the few-shot examples in the same file if the format changes — examples must be consistent with the new rules.

### Run a visual-refinement pass

1. Each pass has its own default in `scripts/config.json → visualRefinement`: `edgeLabelCollisionRepair` and `laneCompaction` on. Per call: `runPipeline(lc, { visualRefinement: true | false | { laneCompaction: true, … } })`; CLI `--refine` (all on) / `--no-refine` (all off). ELK wrapping is separate (`elkWrapping`, `--wrap`).
2. The passes are `laneCompaction`, `edgeLabelCollisionRepair`; `resolveRefinement` turns the option into per-pass switches. See `scripts/bpmn/visual-refinement.js` for the pass implementations.
3. Verify against goldens: `cd scripts && npm test -- --testPathPatterns=visual-refinement`.

### Switch the bend rule off (or tune it)

1. On by default (`config.json → layout.bendRule: true`). Per call `runPipeline(lc, { bendRule: false })`,
   CLI `--no-bend-rule` (`--bend-rule` forces it on), HTTP/MCP `"bendRule": false`; project-wide
   `layout.bendRule: false` in a file named by `BPMN_CONFIG`. Limits: `layout.bendRuleLimits` (see `scripts/bpmn/bend-rule.js`).
2. Verify: the layout ratchet (`cd scripts && npm test -- --testPathPatterns=layout-metrics`) — its
   `default`/`off`/`on` modes run the rule, `plain`/`plain-on` run with both switches off
   and `scripts/bpmn/bend-rule.test.js` (DI07–DI10 clean and idempotent over every fixture).

### Switch node labels that avoid flows off

1. On by default (`config.json → layout.nodeLabelsAvoidFlows: true`). Per call
   `runPipeline(lc, { nodeLabelsAvoidFlows: false })`, CLI `--no-label-avoidance` (`--label-avoidance`
   forces it on), HTTP/MCP `"nodeLabelsAvoidFlows": false`; project-wide `layout.nodeLabelsAvoidFlows: false`
   in a file named by `BPMN_CONFIG`.
   Independent of the bend rule; with both on, the labels follow the bend rule's routes.
2. Verify: `cd scripts && npm test -- --testPathPatterns=node-labels-avoid-flows` and the renderer-agreement
   test in `scripts/bpmn/pipeline.test.js` ("the two renderers agree on node labels", switch off and on).

### Switch the repair of flows through a foreign shape off

1. On by default (`config.json → layout.foreignShapeRepair: true`). Per call
   `runPipeline(lc, { foreignShapeRepair: false })`, CLI `--no-foreign-shape-repair`
   (`--foreign-shape-repair` forces it on), HTTP/MCP `"foreignShapeRepair": false`; project-wide
   `layout.foreignShapeRepair: false` in a file named by `BPMN_CONFIG`. It widens `reclipStuckEnds`
   (`scripts/bpmn/edge-simplify.js`, see its doc comment): a flow through a foreign shape (the DI11
   measure) is re-routed too, one crossing per shape traversed may be traded, a shared in/out port is
   given up. Off, the pass is the plain stuck-end pass.
2. Verify: `cd scripts && npm test -- --testPathPatterns=edge-simplify` and the `#91` block in
   `scripts/bpmn/pipeline.test.js` (`example-rechnungspruefung` clean of DI08/DI09/DI11 in every mode).

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

Rules, their layers, default severities and run locations live in `references/ontology.jsonld`
(`bg:Rule`, `bg:Layer`, `bg:Severity`, `bg:Notation`); the code holds only each rule's check. Three
rule sets — one per notation plus one across notations — and every count below is per rule set.

### BPMN rule set — 40 BPMN rules, 5 layers

| Layer | Default Severity | Rules | Focus |
|-------|-----------------|-------|-------|
| Soundness | ERROR | S01-S17 | Structural correctness (OMG compliance) |
| Style | WARNING | M01-M11 (M05/M06 severity=OFF) | Readability (Bruce Silver Method & Style) |
| Pragmatics | INFO | P01-P03 | Complexity metrics |
| Workflow-Net | ERROR/WARNING | WF01-WF03 (opt-in); SC01, SC06 (scenario pipeline) | Petri-Net soundness |
| Optimization | ADVISORY | O01-O04 | Redesign advisories — `optimize`/`soll` mode only (opt-in); Reijers 2005 + BABOK Lean. Emits `validation.advisories` + `metrics.optimization` |

Profiles in `rules/*.json` override severities or disable layers. Mode: `document` (default, faithful IST) vs. `optimize`/`soll` (enables the Optimization layer). See `scripts/bpmn/optimize.js`. A profile entry its rule set cannot honour — an unknown rule id or layer, an override of a scenario rule, a profile file that does not exist — is reported as a `⚠ rule profile …` warning on stderr by the runner; an unknown severity, or `ADVISORY` on a BPMN rule outside the optimization layer, refuses the profile; a profile file that is not JSON aborts, naming file, line and column.

### DMN rule set — 19 DMN rules, 3 layers

`scripts/dmn/rules.js` runs 17 of them against Decision-Core, not Logic-Core; SC04/SC05 run in the
scenario pipeline:

| Layer | Default severity | Rules | Focus |
|-------|-----------------|-------|-------|
| soundness | ERROR | D01–D05, D09–D11 | Graph, table shape, DMN 1.3 conformance |
| semantics | WARNING | D06–D08; SC04, SC05 (scenario pipeline) | Points at something demonstrably wrong |
| best_practice | WARNING | B01–B06 | Readability and method (opt-in) |

Two modes, mirroring `document`/`optimize`: **`semantic`** (default — does it hold together) and
**`best-practice`** (adds the third layer). `runDmnRules(dc, { mode, profile, config })`. A profile
is more specific than a mode, so an explicit `enabled` in a profile wins. Profiles:
`rules/dmn-default-profile.json`, `rules/dmn-best-practice-profile.json`, and project-specific ones
under `rules/custom/` — **loaded by path, never scanned**, so dropping a file in cannot change
behaviour silently. Thresholds in `config.json → dmn`.

### Cross-notation rule set — 2 cross-notation rules, 1 layer

| Layer | Default severity | Rules | Focus |
|-------|-----------------|-------|-------|
| consistency | WARNING | SC02, SC03 | A BPMN `decisionRef` that resolves to no DMN decision, or to more than one |

SC01–SC06 run only in the scenario pipeline (`scripts/scenarios/pipeline.js`), which takes no
profile — they are not profile-switchable yet (see Known Limitations).

Every rule-count claim in the docs names its rule set right at the number — "40 BPMN rules, 5
layers", "19 DMN rules, 3 layers", "2 cross-notation rules, 1 layer" (German: "40 BPMN-Regeln in 5
Schichten"). The docs gate counts each rule set from `references/ontology.jsonld` and fails a claim
that does not name its rule set there: a sentence a reader cannot attribute is the ambiguity worth
failing on.

## Conventions

- ES Modules (`import`/`export`) — no CommonJS
- Node `>=20` (declared in `package.json` `engines`; CI tests 20 and 22)
- Runtime deps (6): `elkjs`, `bpmn-moddle`, `dmn-moddle`, `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats`. Dev deps: `jest`, `@jest/globals`, `bpmn-auto-layout`. No new deps without prior discussion.
- Config in `config.json`, not hardcoded
- Functions are pure (no global state except `CFG`)
- IDs in Logic-Core: `^[a-zA-Z_][a-zA-Z0-9_-]*$`
- XML escaping via `esc()` from `utils.js`
- Coordinates in the internal `coordMap` contract (`{ coords, laneCoords, poolCoords, edgeCoords, edgeLabels, nodeLabels }`, and its DMN analogue) are always `{ x, y, w, h }` — **`w`/`h`, not `width`/`height`**. Only the emitted DI attributes (`dc:Bounds`) use `width`/`height`; `bpmn-xml.js` and `svg.js` translate on the way out.

### Security defaults (HTTP API + MCP)

- `BPMN_API_KEY` env var: required in production (`NODE_ENV=production`), optional in dev. Startup fails if production + missing key.
- `AUDIT_LOG_PATH` env var: where the audit JSONL is written. Default `<os.tmpdir>/bpmn-generator/audit/bpmn-generator.jsonl`.
- `DEAD_LETTER_PATH` env var: where failed webhook deliveries are written. Default `<os.tmpdir>/bpmn-generator/dead-letter/`. Files are named `<uuid>.json` by the server (created with `wx`, path asserted inside the directory) — never from `correlationId`, which the HTTP entry accepts only as `^[A-Za-z0-9_-]{1,64}$`.
- SSRF: every outbound request to a client-supplied URL goes through `scripts/shared/outbound-url.js` — http/https only, no credentials, `localhost` names refused, every resolved address checked against the IPv4/IPv6 special-purpose ranges (IPv6 forms embedding an IPv4 address checked as that address), the connection pinned to the checked addresses (`pinnedRequest`), redirects never followed. Never call `fetch` on a client-supplied URL directly.
- `LLM_BASE_URL_ALLOWLIST` env var: comma-separated origins a client may name as `llmConfig.baseUrl`; empty (default) = a client `baseUrl` is a `400`. Allowlisted URLs still pass the validator above. Without `baseUrl` the server's endpoint (`OPENAI_BASE_URL`) is used. Provider failures are `502 llm_error`; the upstream body is never returned to a client.
- Client strings into the audit log or a response go through `boundText` (`scripts/shared/safe-text.js`): 128 characters for identifiers, 500 for messages, control/format characters escaped. Telemetry `details` above 8 KiB is a `400`. A non-object JSON body is a `400`.
- Schema-strict gate: every Logic-Core input at the HTTP entry and on every MCP tool that takes one (`generate_bpmn`, `validate_bpmn`, `orchestrate_bpmn`) passes through `scripts/bpmn/schema-gate.js` (ajv draft-2020-12) before reaching the pipeline. LLM output is never trusted raw. The per-call layout options — `visualRefinement`, `bendRule`, `nodeLabelsAvoidFlows` — pass `validateLayoutOptions` (same module; schemas mirrored in `references/api-schema.json` `$defs`, fenced by tests) on `/api/v1/generate`, `/api/v1/orchestrate` (before any LLM or callback work), `generate_bpmn` and `orchestrate_bpmn`; an invalid value is a `400 schema_error` resp. `{ status: 'schema_error' }`. `/api/v1/validate` and `validate_bpmn` take none of them.
- Rule profiles: every profile (inline, by name, or from a file) passes `references/rule-profile-schema.json` (ajv strict) after a size/depth bound (64 KiB, 4 levels, a walk that stops at the limit). HTTP (untrusted) takes an inline object only (a string is a `400 profile_error`, no file is read) and refuses a profile that disables the soundness layer or sets a soundness rule below its ontology default severity — it may only raise one. MCP is a trusted local user like the CLI and may relax soundness, but its arguments come from an LLM, so it takes a profile *name* only, resolved inside the repository's `rules/` (`rulesDirPath` in `resource-paths.js`; none in an npm install, where names are refused). Profile files must be regular files of at most 256 KiB, opened non-blocking. Messages: client tokens through `quoteForMessage`, at most 20 warnings, no file content, no server path to a remote caller.
- Body size cap: 10 MB. Rate limit: 30 req/min per client, keyed on the socket address, or with `TRUST_PROXY_HOPS=<n>` on the address the outermost of `n` trusted proxies recorded in `X-Forwarded-For` (a shorter chain falls back to the socket address; set it only when the server is reachable exclusively through those proxies, since a direct client controls the header); expired buckets are evicted. The API key is compared in constant time. All in `scripts/http-server.js`.

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

# Abort (no files written) on any unresolved warning — rule engine, DI, NC, or serialization:
node bpmn/pipeline.js input.json output --strict

# Enable the opt-in Optimization Advisory layer (soll/optimize mode):
node bpmn/pipeline.js input.json output --optimize

# Switch every refinement pass on (label repair and lane compaction already are by default;
# --no-refine switches all off, the two flags are mutually exclusive):
node bpmn/pipeline.js input.json output --refine

# Wrap long chains into rows (ELK MULTI_EDGE, > 20 nodes; off by default, independent of --refine):
node bpmn/pipeline.js input.json output --wrap

# Bend rule / node labels that avoid flows / repair of flows through a foreign shape are on by
# default; switch any off for this call (--bend-rule / --label-avoidance / --foreign-shape-repair
# force it on over a project config; each pair is mutually exclusive):
node bpmn/pipeline.js input.json output --no-bend-rule --no-label-avoidance --no-foreign-shape-repair

# Project-wide config override (merged over scripts/config.json, one level deep):
BPMN_CONFIG=my-config.json node bpmn/pipeline.js input.json output

# Start MCP server:
node mcp-bpmn-server.js
```

DMN (mirrors the BPMN CLI's idiom):
```bash
# JSON → DMN 1.3 XML + DRD SVG
node dmn/pipeline.js input.json output-basename

# Stdin:
cat input.json | node dmn/pipeline.js - output

# Abort (no files written) on any unresolved warning:
node dmn/pipeline.js input.json output --strict

# Enable the opt-in best_practice rule layer:
node dmn/pipeline.js input.json output --best-practice

# Also write the decision tables: output.md, output.tables.svg, output.tables.html
node dmn/pipeline.js input.json output --doc

# A Business Rule Task's decision table into its BPMN documentation (JSON or .dmn, by content):
node bpmn/pipeline.js process.json output --decisions table.dmn,other.json

# DMN 1.3 XML -> Decision-Core JSON, with a loss report on stderr
node dmn/import.js input.dmn output.json

# Stdin; abort (nothing written) when the import is not lossless
cat input.dmn | node dmn/import.js - output.json --strict

# Scenarios accept DMN files directly (routed by content, not extension)
node scenarios/pipeline.js input.json --decisions table.dmn
```

## Known Limitations

- DMN views: the DRD SVG clips requirement edges at a shape's bounding box (as the DMNDI does), so
  an edge to a knowledge source or BKM ends at the box, not the wavy/clipped outline; decision tables
  are drawn rule-as-row only (`preferredOrientation` is carried in the XML, not honoured by the
  table views); the table SVG measures text with Arial widths — a browser without Arial may wrap a
  cell differently from the computed box. The BPMN documentation section is written only when
  `decisions` is given (CLI `--decisions`); a decision decided by a literal expression is reported
  as "table not supplied", because the bridge matches decisions with a table only
- Layout, tracked individually: `boundary-event-shapes` still has one sequence-flow crossing
  between boundary-event shapes (#71); a message-flow jog keeps clearance from shapes only, not
  from groups or labels (#72); a sequence flow can run through another edge's label (#73); with
  lane compaction (default) lane content is not re-centred in its band (#74); `compactLanes` neither compacts nor
  tiles nested `childLanes` (#75); the orthogonal router can produce a U-turn (#76); participant
  ordering is heuristic above 8 participants (#77); layout time roughly doubles on large models
  (122 nodes: ~2x) because of the crossing guard and the router (#78)
- A label or leg the fallback cannot move stays on a lane separator, and nothing reports it:
  `placeEdgeLabel` keeps its first pick when no other spot is clear of route, separators and shapes,
  and `keepOffLaneLines`/`rerouteAfterCompaction` refuse a move that would add a crossing; only the
  bench (`labelLaneLine`, `hug`) counts these. Two later passes can also put a leg back on a
  separator after `keepOffLaneLines` ran: the second `reclipStuckEnds` (it routes through
  `orthogonal-router.js`, which knows nothing of lane lines) and `repairCrossings` on edges that
  were not in `rerouteAfterCompaction`'s affected set. No fixture shows it today (`hug` is 0)
- `repairMessageFlowLabels` (#88) leaves a message-flow label where it is when no spot beside its
  own segments within `layout.messageFlowLabelMaxMovePx` is clear and growing the participant gap
  (up to `layout.messageFlowLabelMaxGapGrowthPx`) does not help — never worse than without it, and
  nothing reports such a label; only the bench counts them (`labelLabel`, `labelNode`,
  `labelOwnEdge`; no fixture has one). It moves message-flow labels only: a sequence-flow label a
  message flow runs through stays (the bend rule's label refresh does not see message flows either,
  see below). A grown gap lengthens the legs of message flows that share a port column, and with
  them the collinear overlap they already had (bench `overlapLen`). Edge labels still break a word
  longer than 90 px mid-word ("Unterlagenanford/erung"): bpmn-js wraps an external label at a fixed
  90 px and re-sizes its DI box to that on import, whatever width the DI gives, and `edgeLabelLayout`
  mirrors it — a wider DI box would change nothing in bpmn.io and only make our SVG disagree
- The bend rule's message-flow guard (`layout.bendRule`) models a message flow as its single
  centre line at a message-flow node, above or below it. `routeMessageFlows` runs later and fans several
  flows at one node out by `MESSAGE_FLOW_FAN` px either side of that line; the guard does not model the
  offsets, so a bend-rule route can still end up within the fan of a message flow
- The bend rule's label refresh places a re-routed flow's label off other sequence flows and
  associations only: message flows are routed after it, so the label can still land on one. Its
  guard does not count other flows' edge labels either, so a new route can run through a label that
  did not move (the class of #73). No check reports either
- "Output with `layout.bendRule`, `layout.nodeLabelsAvoidFlows`, `layout.foreignShapeRepair` and `layout.messageFlowLabelRepair` explicitly off does not change unnoticed" is fenced by
  SHA-256 hashes of BPMN XML and SVG per top-level fixture × four modes against current master's output
  (no longer the output from before the bend rule: #91 moved `realistic-collaboration`'s boundary event, which no switch restores)
  (`tests/bench/default-output-hashes.json`, written by `node bench/output-hashes.mjs`, compared by
  `scripts/bench/output-hashes.test.js`); regenerate it only for an intended change of the default output
- The DMN importer reads no DMNDI, so every diagram is reported as IM06 and **`report.lossless` is
  never true for a file this generator wrote** — the writer always emits a DMNDI tree (IM06) and
  generates `<variable>`/`<literalExpression>` ids (IM05). `--strict` on `dmn/import.js` and on
  `scenarios/pipeline.js --decisions` therefore rejects our own output; use it on foreign files and
  read the report otherwise. Layout is recomputed on the next emit, so nothing is lost that could
  not be regenerated. Two dmn-moddle-vs-XSD divergences (`organizationUnit` unparseable, non-ASCII
  NCName ids rejected) are pinned by tests so an upstream fix turns them red
- `references/input-schema.json` still has the narrow id pattern that Decision-Core dropped for
  ASCII NCName, so the BPMN importer has the same latent defect against foreign files. Neither
  `/api/v1/import` nor the MCP `import_bpmn` tool has a test, and `scripts/bpmn/import.js` swallows
  every moddle error with a bare `catch {}`
- Multiple and parallel-multiple events (`marker: multiple | parallelMultiple`) are drawn in the
  SVG but the XML carries no event definition, so bpmn.io shows a plain event (#87). Likewise
  `isAdHoc` (#99): the SVG draws the tilde, the XML has a plain `subProcess` (`adHocSubProcess` is
  `announced`). `scripts/bpmn/symbol-fidelity.test.js` pins both, so a fix turns it red
- Rule placeholders: M05-M06 (Style) registered with severity=OFF (POS tagger problem; tracked in ROADMAP)
- No Camunda extensions (`camunda:` namespace)
- DOT import is a subset parser (only output from `logicCoreToDot` is guaranteed round-trip)
- Round-trip fidelity (BPMN→Logic-Core→BPMN) verified for ~25 OMG examples + unit tests; not exhaustive across all BPMN element types. Two classes were recently added to that coverage after both turned out to be lossy: text annotations and groups (the primary importer walked only `flowElements`, where bpmn-moddle never places an Artifact), and **subprocess children**, which reached the XML with only their id and name — documentation, loop/multi-instance, script, `calledElement`, `gatewayDirection` and the mandatory `attachedToRef` were all dropped, grandchildren entirely. Both directions were affected, so the round trip looked intact while both ends lost the same fields. The guard is now a field-set comparison over `tests/fixtures/subprocess-child-fidelity.json`, not a per-field assertion. The annotation/group half of that was closed at top level only, and the identical `flowElements`-vs-`artifacts` gap survived one level down until `scripts/bpmn/field-fidelity.test.js` measured it; both levels now read from `artifacts` through the same function
- Boundary events are placed deterministically on their host's bottom edge — or its top edge when the target of their outgoing flow lies above the host (#91) — and their outgoing flow is re-routed from there (`coordinates.js` §5.0-). ELK does not lay them out; a host carrying many of them will spread them evenly per side rather than optimally (on the bottom edge without a minimum spacing, so three or more on a 100 px task overlap — the top edge keeps them apart), the side is decided by the event's first outgoing flow alone, and a target the lane order cannot place (nested child lane) keeps the event at the bottom
- `example-rechnungspruefung`'s "Ja" flow (`f412`) leaves "Betrag über 10.000 EUR?" at the bottom vertex and runs through the gateway's own label: `placeNodeLabelsAvoidingFlows` finds every candidate blocked (below and right-below by `f412` itself, above by `f409`/`f410`, left-below by `f410`) and keeps the default box. Its `f410` carries a 10 px jog from `repairCrossings` (6 bends) that no later pass straightens (#91)
- Artifacts (annotations, data objects, data stores) are placed below the element they are associated with, stacked. They are kept out of the ELK graph on purpose: an artifact without an association is disconnected and ELK hands it the first layer — measured, an unattached data store pushed the start event 184 px right. Because ELK therefore sizes an expanded subprocess without its artifacts, `layout.js` reserves a band at the subprocess's bottom for the artifacts it declares (`artifactReserveHeight`, sized for the worst case — every artifact stacked under one anchor), and `placeArtifacts` puts unassociated ones into that band — last, onto free slots, because an anchor near the bottom hangs its own artifact into the same band; without it they landed below the whole collaboration, outside both subprocess and participant (#56). Over-reserving costs whitespace, under-reserving a DI06
- Participant ordering is exact up to 8 participants and heuristic above. Some crossings are unavoidable: a communication cycle across three or more participants cannot be linearised, which is why DI05 is a WARNING
- The DI check (`di-check.js`) covers participants, lane bands, node containment, message flow crossings, and (DI07) that a sequence flow starts and ends on its own node, (DI08) that no sequence-flow end runs along its own endpoint's outline, (DI09) that no sequence flow runs through its own source or target, (DI10) that no message flow runs through a shape that is not one of its endpoints, and (DI11) that no sequence flow runs through a shape that is neither its source nor its target. It says nothing about sequence-flow *crossings*, label collisions or readability
- A single-process Logic-Core (no `pools`) may omit `id` (`input-schema.json`'s `SingleProcess`
  branch, unlike `Pool`). `assignProcessId` (`topology.js`) gives it `Process_1` (`_2`, … on a
  collision) once at `runPipeline` entry, on the pipeline's own copy; `generateBpmnXml`,
  `logicCoreToDot` and `runScenarioPipeline` apply the pure `withProcessId` to a direct call. The
  caller's object is never changed, so a document you serialise yourself still has no `id` (#37).
  `composeCollaboration` keeps its `pool_<n>` fallback for callers that hand `enumerateCollaboration`
  an id-less pool directly; the pipeline path never reaches it
- No ESLint — CLAUDE.md's own "Do NOT" rules (no CommonJS, no hard-coded constants where
  `config.json` applies, etc.) are enforced by review convention, not tooling (#32)
- No test coverage collection or threshold gate — `npm test -- --coverage` works, nothing runs it
  in CI or reports the result (#33)
- SC01–SC06 are not profile-switchable: the scenario pipeline takes no profile. A profile that turns
  off the BPMN `workflow_net` layer (`rules/default-profile.json` does) or the DMN `semantics` layer
  silences WF01–WF03 resp. D06–D08 in the main pipeline, but the scenario pipeline still reports
  SC01/SC06 resp. SC04/SC05, which sit in those layers

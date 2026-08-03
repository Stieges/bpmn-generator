# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
  escapes an enclosing parallel block entirely. The residual error is always a **missed** deadlock,
  never a fabricated one. `references/fachliches-regelwerk.md` names these two cases, and names
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

### Known limitations
Things this release deliberately leaves open. They are listed here because the CHANGELOG is what a
release reader sees, and each of them is a gap someone could otherwise mistake for a guarantee.

- **`S05`/`S06`'s remaining missed-deadlock cases are disclosed, not closed** — see the S05/S06 entry
  under *Fixed* above. `references/fachliches-regelwerk.md` names two of them and names them as
  examples; the exhaustive check is WF03 in the opt-in `workflow_net` layer.
- **Duplicate *edge* ids across sibling containers are still written, at exit 0.** `NC06` covers
  duplicate **node** ids, where the net genuinely loses one of the two (`transitions` is keyed
  `t_<node.id>`). Two edges sharing an id are translated *faithfully* — `namePlaces` keys places
  `p_<src>_<tgt>[#k]` and `pn.placeOfEdge` is keyed by edge object identity, so both get their own
  place and arcs — so `NC06` does not and must not fire on them; doing so would make a Petri-net
  guard assert something about XML serialisation, the category error the `NC02`/`NC02b` scoping
  was performed to remove. The emitted file is nonetheless invalid (`xsd:ID` is document-wide
  unique), and the layer that owns it already names it exactly: bpmn-moddle's round trip reports
  `duplicate ID <…>` in `validation.xmlWarnings`. **The remedy is therefore in that gate, not in
  `net-check.js`** — making a `duplicate ID` serialisation warning unconditionally fatal, rather
  than fatal only under `--strict`. That is a change to a different gate's contract with its own
  corpus measurement to run, and was deliberately not folded into this stage. Pinned by the test
  "duplicate FLOW ids are NOT an NC finding" in `scripts/bpmn/pipeline.test.js`, which asserts both
  halves: no NC finding, and the `xmlWarnings` entry that does exist.
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

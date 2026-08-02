# Layout Quality Analysis — the Petrov/Flowable arrangement algorithm vs. our ELK pipeline

Commissioned to answer one question: does the automatic-BPMN-arrangement algorithm described in
[Teodor Petrov's blog post](https://teodorpetrov.com/blog/algorithm_for_automatic_arrangement_of_bpmn_elements)
(a Flowable engineering write-up) help us produce a better diagram — and if so, which parts of it, in
what combination? A secondary ask covers other coordinate-computation approaches more generally.

Method, data, and conclusions below; recommendation in [§8](#8-recommendation).

## 0. Correction note

**The first version of this document reached the wrong conclusion, and the sections below have been
rewritten.** It reported that our lane-band shift tears straight chains apart by up to 839 px and
recommended adopting Petrov's Run-and-Anchor alignment and lane-constrained barycenter reordering to
fix it. Checking those numbers before implementing anything showed the finding was an artifact of the
measuring instrument: the alignment metric asked whether two nodes share a center-y without asking
whether they structurally could. Cross-lane links can never be straight — lanes are horizontal bands
by definition — and neither can row folds in a wrapped layout, nor a node ELK deliberately placed on
its branches' barycenter. All three were being counted as defects.

Measured correctly, **every structurally alignable link in all eight fixtures is already exactly
aligned, in both refinement modes.** There was nothing to fix. The metric has been repaired
(`alignabilityOf` in the harness now names why each excluded class is legitimate), and the two
recommendations that rested on it are withdrawn. One genuine finding survived the re-examination and
has been fixed — see §1.

The lesson is recorded rather than quietly patched: a metric that cannot distinguish a defect from
correct behaviour will manufacture work, and it did.

## 1. Executive summary

Edge crossings and chain alignment were both examined; only one of them was ever broken.

**Alignment: nothing was wrong.** All 59 structurally alignable chain links across the eight fixtures
share their center-y exactly, before and after our post-processing (§4). Petrov's Run-and-Anchor step
and his lane-constrained barycenter reordering therefore have nothing to improve here, and are not
adopted.

**Crossings: a real, narrow defect, now fixed.** ELK's raw output is crossing-free on every fixture,
but our own route rebuilding introduced crossings ELK had routed around — 2 in
`realistic-collaboration`, 3 in `bpmn-generator-pipeline`. `coordinates.js` discards a route whenever
the lane-band shift moves its endpoints by different deltas, then rebuilds it as a fixed 4-point Z
picked from `|dy| > |dx|` alone, with no obstacle or crossing test. This is Petrov's idea #6
(obstacle-aware routing), which the first version of this document had deferred for lack of evidence.
A bounded repair pass (`repairCrossings` in `scripts/bpmn/edge-simplify.js`) now clears one of them;
the remainder sit in congested regions where every candidate corridor runs through a node and would
need real pathfinding (§6, idea 6).

**Everything else measured as adequate.** ELK option tuning moves almost nothing end-to-end (§7 A);
`BRANDES_KOEPF` passes its gate but earns only an 8 % bend reduction for 28 golden-file
regenerations, so it is measured, documented and deliberately not adopted. Area growth and the
`wide-pipeline` wrapping figures, both flagged as problems in the first version, turned out to be
correct behaviour misread through unsuitable metrics (§3).

## 2. Method

- Metrics harness: [`scripts/bench/layout-metrics.mjs`](../scripts/bench/layout-metrics.mjs) (not wired
  into `npm test`, same idiom as the other `scripts/bench/*.mjs` comparison tools). Reads
  `coordMap.coords` / `coordMap.edgeCoords` straight from `runPipeline`'s return value — no XML parsing
  needed, `runPipeline` already exposes the internal geometry contract described in
  `CLAUDE.md`'s "geometry contract" section.
- Fixtures: `simple-approval`, `multi-pool-collaboration`, `realistic-collaboration`,
  `all-element-classes`, `expanded-subprocess`, `sparse-lanes`, `wide-pipeline` (27 nodes),
  `bpmn-generator-pipeline` (22 nodes, the two largest fixtures in `tests/fixtures/`).
- Metrics: crossings (pairwise segment intersections between non-adjacent sequence-flow edges),
  bends (direction changes per edge), diagonals (non-orthogonal segments — sanity check, should
  always be 0), area and aspect ratio, chain alignment, edge-through-node. Full definitions in the
  module doc comment.
- **What the metrics deliberately do not claim**, learned the hard way (§0):
  - *Chain alignment* counts only links whose endpoints could structurally share a center-y.
    Excluded, each because a vertical offset is correct for it: `cross-lane` (lanes are horizontal
    bands), `fold-back` (a loop, or a row fold in a wrapped layout), `branch` (target is a split or
    source is a join — ELK places it on its branches' barycenter, which is what makes those
    branches straight), `hosts-boundary` (the source carries a boundary event, whose outgoing flow
    `buildElkEdges` re-anchors onto the host, so ELK sees a split where Logic-Core shows none), and
    `boundary-src` (the source is a boundary event, pinned to its host's edge).
  - *Area* is not comparable between the ELK-raw row and the pipeline rows: raw ELK has not placed
    lane bands yet, so the difference measures the existence of swimlanes, not bloat. It is also
    not a quality score for a wrapped layout, which trades width for height on purpose — hence the
    separate aspect-ratio column.
  - *Crossings* covers sequence flows only, not message flows or associations.
  - *Edge-through-node* tests node boxes only — not edge-vs-edge, not lane or pool bands.
- Three variants measured per fixture: **ELK raw** (straight out of `runElkLayout`, before any of
  `coordinates.js`'s post-processing runs), **default** (`visualRefinement: false`, the pipeline's
  default), **visualRefinement: true**.
- Raw data: [`tests/bench/layout-metrics-baseline.md`](../tests/bench/layout-metrics-baseline.md).

## 3. Baseline results

Full table in `tests/bench/layout-metrics-baseline.md`. Headline numbers, `visualRefinement: false`,
after the crossing-repair fix described in §1:

| Fixture | Crossings (raw→default) | Chain alignment | Not alignable |
|---|---|---|---|
| simple-approval | 0→0 | 1/1 | 1 branch |
| multi-pool-collaboration | 0→0 | 5/5 | 2 branch |
| realistic-collaboration | 0→2 | 15/15 | 4 cross-lane, 1 hosts-boundary, 1 boundary-src |
| all-element-classes | 0→0 | 3/3 | 1 hosts-boundary, 1 boundary-src |
| expanded-subprocess | 0→0 | 6/6 | — |
| sparse-lanes | 0→0 | 1/1 | 2 cross-lane, 2 branch |
| wide-pipeline | 0→0 | 26/26 | — |
| bpmn-generator-pipeline | 0→2 | 5/5 | 2 cross-lane, 5 branch |

**Alignment is at 100 % everywhere** — 59 of 59 alignable links, in both refinement modes. The only
non-zero column is crossings, and only on the two most complex fixtures. That is the whole of what
the measurements support.

**On area.** The first version of this document read a 50–135 % area increase from raw ELK to the
final pipeline as bloat. It is not: raw ELK has not placed lane bands at the point that snapshot is
taken, so the growth is the padding and stacking that swimlanes *are*. Comparing a layout that has
lanes against one that does not yet have them measures the feature, not a regression. The area column
is retained for tracking pipeline-to-pipeline changes and carries an explicit warning against the
cross-row comparison.

**On the `wide-pipeline` "anomaly".** The first version flagged `visualRefinement: true` growing that
fixture's area 8.5× and adding 4 bends as a probable regression that "contradicts the feature's own
purpose". It does not. Wrapping (`elk.layered.wrapping.strategy: MULTI_EDGE`, above the 20-node
`elkWrappingNodeThreshold`) folds the 27 nodes into **5 rows** at center-y 120/301/482/663/844; the 4
"new" bends are exactly the 4 row transitions, and the 4 alignment losses are exactly the 4 links
spanning a fold. Width drops 4652→3932 and height rises 80→804, taking the aspect ratio from 58.15 to
4.89 — which is precisely what the existing test at `scripts/bpmn/pipeline.test.js` (`Pass 5 metric
assertions`, asserting `w/h <= 4.5` and `offRatio/onRatio > 2`) demands. Area was simply the wrong
instrument for a feature whose entire job is to trade width for height.

## 4. Alignment: measured, and not broken

This was the load-bearing claim of the first version, so it is worth stating precisely what replaced
it.

Filtering the 71 plain 1:1 chain links down to those that could structurally be straight leaves 59,
and **all 59 share their center-y to within 1 px** — in `visualRefinement: false` and `true` alike.
The 12 excluded links are excluded for reasons that are each verifiable rather than assumed:

- **Cross-lane (9 links).** All three "breaks" originally cited from `sparse-lanes` are of this kind:
  `join`@laneA → `b1`@laneB → `c1`@laneC → `d1`@laneD. A link between two lanes cannot be horizontal
  without defeating the lanes. The 839 px figure quoted in the first version was one of these, in
  `bpmn-generator-pipeline`.
- **Branch (10 links).** The target is a split, or the source a join. ELK positions such a node on
  the barycenter of its branches; aligning it to its single partner would straighten one edge by
  bending two.
- **Boundary-related (2 links).** Traced concretely in `all-element-classes`: task `t` shows
  out-degree 1 in Logic-Core, but it hosts boundary event `b`, and `buildElkEdges` re-anchors `b`'s
  outgoing flow onto `t`, so ELK sees a split. Its 13.5 px offset from gateway `g` is therefore
  ELK's barycenter placement, not our post-processing: measured on **raw ELK output**, `t`'s bbox
  center is y=131 and `g`'s is y=117.5 — the same 13.5 px, before `coordinates.js` runs at all. The
  final shape centers are identical to those raw values, i.e. our pipeline preserved ELK's decision
  exactly rather than corrupting it.

So `coordinates.js` §5.0a's per-lane shift, the mechanism the first version blamed, keeps every
alignment that can be kept. Neither Petrov's Run-and-Anchor step nor his lane-constrained barycenter
reordering has anything to correct here.

## 5. The Petrov/Flowable algorithm — summary

Full pipeline, ELK used only for step 2:

1. **Cycle removal** — DFS with 3-color marking; back-edges (pointing to a gray/active node) are
   reversed, re-inserted as return flows after layout. Rationale: DFS follows the happy path.
2. **Layering** — Network Simplex (via ELK): minimize Σ ω(u,v)·(rank(v)−rank(u)) subject to
   rank(v) ≥ rank(u) + δ(u,v). Produces global layer indices = the x-axis.
3. **Grid construction** — a discrete `[Layers × GlobalHeight]` grid. The y-axis is **lanes with fixed
   vertical slot bands**: each lane reserves `H_max` slots (its own max node count per layer), and
   `y_global = offset(lane) + y_local`. Long edges get subdivided into dummy nodes per intermediate
   layer, each dummy inheriting its source edge's lane.
4. **Lane-constrained barycenter crossing minimization** — the standard Sugiyama barycenter heuristic
   (`b_i(v) = mean of neighbor positions in the adjacent layer`), swept left-right-left, but **capped
   at lane boundaries** — a node never crosses from one lane's slot range into another's.
5. **Run-and-Anchor vertical alignment** — round barycenters to integer slots, group nodes competing
   for the same slot into a "run", pick the run member closest to its integer target as the "anchor",
   shift the whole run to the anchor. Net effect: a straight chain A→B→C gets identical integer
   barycenters and lands in exact horizontal alignment.
6. **Left-shift compressor** — iteratively move nodes to earlier layers (strict phase: no new
   crossings; relaxed phase after), governed by five validation rules (dummy immutability, same-layer
   dependency, target-slot occupancy, vertical-corridor clearance, crossing-order preservation).
7. **Coordinates** — grid slots → pixels.
8. **Orthogonal router** with obstacle/crossing avoidance (the article calls this the most
   compute-expensive step), then a labeler.

Complexity: O(E·N²·log N) worst case, empirically <20 ms per diagram given real BPMN's sparse edge
count and clear directional flow. Crossing minimization itself is NP-complete; the article is explicit
that this is heuristic, not optimal, throughout.

## 6. Idea-by-idea assessment

| # | Idea | Does ELK already give us this? | Does our post-processing break it? | Adoption form | Measured effect | Effort / risk |
|---|---|---|---|---|---|---|
| 1 | DFS cycle removal | Yes — `elk.layered.cycleBreaking.strategy: GREEDY_MODEL_ORDER` (`scripts/config.json`), functionally the same job (identify back-edges, order the DAG). | No — happens entirely inside ELK, before our code sees the graph. | — | n/a | **Not worth revisiting.** Already covered. |
| 2 | Network Simplex layering | Yes — `elk.layered.nodePlacement.strategy: NETWORK_SIMPLEX` is our exact default. | No. | — | n/a | **Not worth revisiting.** Already covered, and confirmed by the ELK-options experiment (§7) that `BRANDES_KOEPF` isn't clearly better on our fixture sizes. |
| 3 | Lane-constrained barycenter crossing minimization | No. ELK's `LAYER_SWEEP` is lane-blind by design (`layout.js` explains why `elk.partitioning` cannot be used for lanes). | **No.** This was the first version's claim and it does not survive measurement: raw ELK is crossing-free on all eight fixtures, and the crossings that do appear come from route *rebuilding*, not from node placement (idea 6). | Would be a lane-capped barycenter sweep before §5.0a derives bands. | **None measurable.** There are no placement-induced crossings on any fixture to remove. | **Not adopted.** No defect to fix. Revisit only if a future dense fixture shows placement-induced crossings — which would be visible as a non-zero crossing count in the ELK-raw row. |
| 4 | Run-and-Anchor vertical alignment | Partly — `favorStraightEdges: true`. | **No.** All 59 structurally alignable links are already exactly aligned, in both refinement modes (§4). The 839 px and 497 px "breaks" the first version cited are cross-lane links, which cannot be straight by definition. | Would generalize `coordinates.js` §5.0c beyond happy-path edges. | **None measurable.** Alignment is at 100 %; a pass can only preserve it, not improve it — and would risk the barycenter placements that keep branch edges straight. | **Not adopted.** Nothing to fix, and a real risk of making split/join placement worse. |
| 5 | Left-shift compressor | Partially — `elk.layered.compaction.postCompaction.strategy: EDGE_LENGTH` plus our opt-in `compactLanes`, which compacts lane *height*, not layer *width*. | Not broken; not attempted on the width axis. | Would target layer spacing. | Not measured. The area growth the first version pointed to turned out to be swimlane geometry, not bloat (§3), so the motivating evidence is gone. | **Defer.** No measured evidence it is a bottleneck. |
| 6 | **Orthogonal router with obstacle avoidance** | Yes for the *initial* route (`elk.edgeRouting: ORTHOGONAL`) — and ELK's is good: 0 crossings everywhere. No for anything downstream. | **Yes, and this is the one real defect found.** Every route `coordinates.js` deletes and rebuilds (§5.0a → §5.2, plus §5.0e/§5.5) picks its axis from `\|dy\| > \|dx\|` with no obstacle or crossing test, discarding exactly the obstacle-awareness ELK had. Result: +2 crossings in `realistic-collaboration`, +3 in `bpmn-generator-pipeline`. | **Done, partially:** `repairCrossings` in `scripts/bpmn/edge-simplify.js` re-routes edges that cross, keeping the clipped endpoints and the shape side they attach to; a no-op when no crossing exists, so no golden fixture is touched. | `bpmn-generator-pipeline` 3 → 2 crossings. The remaining two, and the two in `realistic-collaboration`, sit where every candidate corridor runs through a node. | **Shipped for the tractable cases.** Full obstacle-aware pathfinding (A\* over a visibility graph) remains open and is the only Petrov idea with evidence behind it — see §8. |

## 7. Alternative coordinate-computation methods

- **A — ELK option tuning.** Cheapest possible lever: change `scripts/config.json`'s `elk.layered`
  block, no code changes. Tested `BRANDES_KOEPF` node placement, `thoroughness: 50`,
  `considerModelOrder.strategy: NONE`, `favorStraightEdges: false`. `thoroughness`,
  `considerModelOrder` and `favorStraightEdges` were bit-for-bit identical to baseline on these
  fixture sizes — ELK's defaults are already doing their job.
  `BRANDES_KOEPF` was then measured **end-to-end through the full pipeline** (the first version only
  measured it on raw ELK output, which says nothing about what reaches the diagram). Totalled over
  all eight fixtures: **bends 38 → 35, crossings 4 → 4, alignment 59/59 → 59/59.** That passes the
  adoption gate — bends improve, nothing regresses — but the prize is an 8 % bend reduction, and the
  price is regenerating all 28 byte-exact golden files, 14 of which (`*.refined.*`) have no CLI path
  to regenerate them at all: `scripts/bpmn/pipeline.js` has no `--refine` flag, so
  `CONTRIBUTING.md`'s documented regeneration loop covers only half of them.
  **Verdict: measured, gate passed, deliberately not adopted.** Recorded here with the numbers so the
  decision can be revisited without re-measuring — most sensibly bundled with some other change that
  already requires a golden regeneration, or after a `--refine` flag closes the tooling gap.
- **B — Petrov's ideas as post-ELK passes.** See §6. Of the six, only idea 6 (obstacle-aware routing)
  had evidence behind it, and the tractable part of it has shipped.
- **C — ELK run per lane** (the `synergycodes/bpmn-editor` approach — Angular 19 + `ng-diagram`, ELK
  `layered` with `RIGHT` direction, one ELK invocation per swimlane, lanes stacked by hand afterward,
  auto-layout manually triggered rather than automatic). Simpler than our current two-stage approach
  (global ELK + lane-shift) in one sense — no shift-induced misalignment because ELK never had a
  cross-lane view to begin with — but trades that for being **structurally blind to cross-lane
  crossings and alignment**, which is the opposite failure mode: it can't optimize what it never sees.
  Not an improvement over our current architecture.
- **D — Full grid-based engine, Petrov-style** (ELK for ranking only; our own grid, lane-constrained
  barycenter, Run-and-Anchor, left-shift compressor, and orthogonal router). This is what the article
  itself built. Given the measured findings — placement and alignment are both sound, and the single
  defect was in route *rebuilding* — a second full engine would replace a great deal of working
  machinery to fix something a bounded repair pass already addresses. What remains open (§8) is one
  component of that engine, its router, not the engine.
- **E — `bpmn-auto-layout` (bpmn.io).** Already benchmarked and rejected — renders zero pool/lane
  shapes and drops message flows and later participants in a collaboration (`EVALUATION.md`,
  `scripts/bench/compare-bpmn-auto-layout.mjs`). Not revisited here; no new information changes that
  verdict.
- **`bpmn-elk-layout` (npm, v1.4.0, MIT)** — evaluated as a possible additional comparison point per
  the original ask. Its `package.json` (via the npm registry) declares dependencies on `elkjs@^0.9.3`
  (three minor versions behind our `^0.12.0`), `kiwi.js` (a Cassowary constraint-solver — plausibly
  used for something like Run-and-Anchor-style alignment, though this can't be confirmed) and
  `pathfinding` (likely A\*-based edge routing). Its declared `repository` field
  (`github.com/LcpMarvel/bpmn-elk-layout`) **returns HTTP 404** — the source is gone even though the
  package is still live on npm. **Verdict: do not build on or compare against this package** — no
  source to inspect, no way to verify its claims, and an unmaintained/orphaned dependency is exactly
  the supply-chain risk `CLAUDE.md`'s "no new dependencies" rule exists to avoid.

## 8. Recommendation

| Idea | Benefit measured? | Status |
|---|---|---|
| #6 Crossing repair for rebuilt routes | **Yes — the only defect found.** 5 crossings across two fixtures, none of them in ELK's own output | **Done.** `repairCrossings`; clears 1 of 5 |
| #6b Full obstacle-aware pathfinding | The 4 remaining crossings, in congested regions | **Open** — the only item with evidence behind it |
| A — `BRANDES_KOEPF` node placement | Bends 38 → 35 end-to-end; gate passed | **Measured, not adopted** — 8 % for 28 golden regenerations (§7 A) |
| #4 Run-and-Anchor alignment | **No** — alignment is already 100 % (§4) | Rejected; would risk branch placement |
| #3 Lane-constrained barycenter reorder | **No** — no placement-induced crossings exist | Rejected |
| #5 Left-shift width compaction | Not measured as broken; the area evidence dissolved (§3) | Defer |
| C ELK-per-lane | Trades one failure mode for another | Reject |
| D Full Petrov-style engine | Nothing left for it to fix | Reject |

**What was done, and what remains.**

Done in this pass: the metric was repaired so it can tell a defect from correct behaviour (§0), and
the one real defect — crossings introduced by our own route rebuilding — got a bounded repair pass
that clears the tractable case. Both are covered by tests; no golden file changed, because the pass
is a no-op on crossing-free diagrams.

Open, in the order the evidence supports:

1. **Obstacle-aware pathfinding for the four remaining crossings.** They sit where every candidate
   corridor from the repair pass runs through a node — in `realistic-collaboration`, the boundary
   event `in_timer` exits upward *through its own host* `in_check` and then along the column `inf2`
   descends in; in `bpmn-generator-pipeline`, two edges in a rework loop are boxed in by `t_refine`.
   A real router (A\* over a visibility graph, per Petrov's step 8) would resolve these. Worth doing
   only if these crossings are judged visually harmful — four crossings across two of eight
   fixtures, neither of which has a golden file.
2. **The boundary-event exit direction, separately and more cheaply.** That `in_timer` case is not
   really a routing problem: an edge leaving a boundary event should exit *away* from its host, and
   §5.2 picks the exit side purely from where the target sits, which for a boundary event straddling
   its host's bottom edge sends it back through the host. Fixing that is small, local, and would
   likely take `realistic-collaboration` to zero crossings on its own. It also explains that
   fixture's `edgeThroughNode: 1`.
3. **A `--refine` CLI flag,** so all 28 goldens have a documented regeneration path rather than 14.
   Not a layout improvement, but it is what currently makes any global layout change expensive —
   including `BRANDES_KOEPF` above.

The recommendations in the original version of this section are superseded in full.

## 9. Appendix — reproducing the numbers

- Full baseline table: [`tests/bench/layout-metrics-baseline.md`](../tests/bench/layout-metrics-baseline.md),
  regenerated with `cd scripts && node bench/layout-metrics.mjs`.
- **Alignment (§4).** The alignability rule lives in `alignabilityOf` in
  `scripts/bench/layout-metrics.mjs`; the baseline table prints both the quota and the excluded
  links by reason, so the 59/59 figure and its 12 exclusions are readable straight off it.
- **The 13.5 px boundary-event case (§4).** Reproduce by calling `logicCoreToElk` + `runElkLayout`
  on `tests/fixtures/all-element-classes.json` and comparing the raw bbox centers of `t` (131) and
  `g` (117.5) against the final `coordMap.coords` shape centers — they are the same numbers, which
  is what shows the offset is ELK's and not ours.
- **ELK-option variants (§7 A).** Mutate `CFG.elk.layered` (from `scripts/shared/utils.js`) before
  calling `runPipeline`, then re-measure. Measured end-to-end, not on raw ELK output — the
  distinction matters, and getting it wrong is what made the first version's reading of
  `BRANDES_KOEPF` unusable.
- **Crossings (§1, §6).** `countCrossings` in the `repairCrossings` suite in
  `scripts/bpmn/pipeline.test.js` restates the bench harness's definition, and the suite asserts the
  3 → 2 result on `bpmn-generator-pipeline` by toggling `CFG.layout.crossingRepair`.

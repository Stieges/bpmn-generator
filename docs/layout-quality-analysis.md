# Layout Quality Analysis — the Petrov/Flowable arrangement algorithm vs. our ELK pipeline

Commissioned to answer one question: does the automatic-BPMN-arrangement algorithm described in
[Teodor Petrov's blog post](https://teodorpetrov.com/blog/algorithm_for_automatic_arrangement_of_bpmn_elements)
(a Flowable engineering write-up) help us produce a better diagram — and if so, which parts of it, in
what combination? A secondary ask covers other coordinate-computation approaches more generally.

Method, data, and conclusions below; recommendation in [§8](#8-recommendation).

## 1. Executive summary

Edge crossings are **not** our bottleneck — both ELK's raw layering and our final output are
crossing-free or near-crossing-free on every fixture measured (§3–4). Tuning ELK's own layering
options moves almost nothing (§7). The actual quality loss happens entirely in
our own post-processing, in two concrete, measured ways: **straight chains that ELK aligned get pulled
apart by up to 839 px** once lanes are stacked independently (§4), and **diagram area inflates by
50–135%** from lane padding and pool/lane stacking that doesn't respond to content (§3, confirming the
existing admission in `CLAUDE.md`). Of Petrov's six pipeline stages, two map directly onto these gaps:
**lane-constrained barycenter reordering** and **Run-and-Anchor vertical alignment**. Adopting those two
as new post-ELK passes — not a full alternative engine — is the one adoption worth pursuing. See §8 for
the concrete combination and sequencing.

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
  always be 0), area (bbox px², and px² per node), chain alignment (a simplified proxy: of all
  plain in-degree-1/out-degree-1 links, what fraction keeps identical center-y), edge-through-node.
  Full definitions in the module doc comment.
- Three variants measured per fixture: **ELK raw** (straight out of `runElkLayout`, before any of
  `coordinates.js`'s post-processing runs), **default** (`visualRefinement: false`, the pipeline's
  default), **visualRefinement: true**.
- Raw data: [`tests/bench/layout-metrics-baseline.md`](../tests/bench/layout-metrics-baseline.md).

## 3. Baseline results

Full table in `tests/bench/layout-metrics-baseline.md`. Headline numbers:

| Fixture | Crossings (raw→default) | Area (raw→default) | Chain alignment (raw→default) |
|---|---|---|---|
| simple-approval | 0→0 | 154 440→154 440 | 50%→50% (unaffected — a single 2-node lane) |
| multi-pool-collaboration | 0→0 | 485 760→725 604 (+49%) | 100%→100% |
| realistic-collaboration | 0→2 | 1 265 656→1 965 588 (+55%) | 100%→71% |
| all-element-classes | 0→0 | 116 530→289 428 (+148%) | 100%→60% |
| expanded-subprocess | 0→0 | 134 960→134 960 (0%) | 100%→100% |
| sparse-lanes | 0→0 | 566 000→1 330 100 (+135%) | 100%→40% |
| wide-pipeline | 0→0 | 372 160→372 160 (0%) | 100%→100% |
| bpmn-generator-pipeline | 0→3 | 1 893 790→3 641 415 (+92%) | 83%→67% |

Two clear patterns: **crossings stay at or near zero** in every case (max delta +3), and **area and
chain alignment move a lot** whenever a fixture has more than one lane band that grows independently
(any single-lane or single-participant fixture — `simple-approval`, `expanded-subprocess`,
`wide-pipeline` — shows 0% change in both, which is the control case confirming the effect is lane-band
specific, not a general artifact of post-processing).

One anomaly outside this pattern, noted for the record but out of scope here: `visualRefinement: true`
on `wide-pipeline` grows area from 372 160 to 3 161 328 px² (8.5×) and adds 4 bends where there were
none — almost certainly the `elk.layered.wrapping.strategy: MULTI_EDGE` kicking in above the 20-node
`elkWrappingNodeThreshold` (`scripts/config.json`), which folds a wide pipeline into multiple rows but,
on this measurement, made the bounding box larger rather than smaller. That contradicts the feature's
own purpose and is worth its own investigation — separate from this analysis, since it's a
`visualRefinement` regression candidate, not a Petrov-idea question.

## 4. Where quality is lost: chain alignment, not crossings

This is the load-bearing measurement for the whole analysis. Petrov's article treats crossing
minimization as the central metric (§1 of the article: "min C(D)"), and our lane-blind ELK layering
followed by an independent per-lane y-shift (`coordinates.js` §5.0a) is exactly the kind of step that
*should*, per the article's own argument, reintroduce crossings a lane-aware algorithm would avoid. It
mostly doesn't — the delta is +0 to +3 across all eight fixtures.

What the lane-shift **does** break is straight-line alignment. Isolating every "plain link" (a
single-successor node feeding a single-predecessor node) whose center-y moved after the lane-shift:

```
sparse-lanes.json
  f3: join -> b1   deltaY = 497.5 px
  f4: b1 -> c1     deltaY = 225.0 px
  f5: c1 -> d1     deltaY = 225.0 px

bpmn-generator-pipeline.json
  fu2:  t_describe -> t_receive    deltaY = 37.0 px
  fo5:  t_validate -> gw_review    deltaY = 13.5 px
  fo16: t_svg -> t_compliance      deltaY = 225.0 px
  fo17: t_compliance -> t_assemble deltaY = 839.0 px
```

ELK's own layering had these nodes flush. `coordinates.js` §5.0a (`coordinates.js:161-209`) derives
each lane's band **independently** from its own content, then re-stacks bands top-down — a chain that
spans two lanes gets each half moved by that lane's own delta, with no attempt to keep the chain
straight afterward. An 839 px jump is not a subtle cosmetic issue; it turns what should read as a
straight arrow into a route that visibly detours across the diagram. This is precisely the failure mode
Petrov's **Run-and-Anchor** alignment step (§5) is designed to prevent, and precisely what our
`§5.0c` happy-path leveling *would* address if it weren't `CFG.layout.happyPathLeveling: false` by
default and limited to happy-path-flagged edges rather than every plain link.

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
| 3 | **Lane-constrained barycenter crossing minimization** | No. ELK's `LAYER_SWEEP` crossing minimization is lane-blind by design (`layout.js:107-120` explains why `elk.partitioning` can't be used for lanes) — it optimizes crossings in a graph that doesn't know lanes exist, and our lane-shift then moves nodes afterward with no re-check. | Yes — this is the mechanism, not a separate bug: §5.0a moves nodes into lane bands *after* ELK already decided on crossing-minimal positions, with no crossing-aware placement in the shifted result. | New post-ELK pass, between raw ELK output and §5.0a: run a lane-capped barycenter sweep on the ELK-produced order *before* deriving lane bands, so ordering-within-lane is chosen with lane membership already known, rather than fixed by ELK and then physically relocated. | Crossings are already near-zero (§3–4) — the measured payoff of proper lane-constrained minimization would be small on these fixtures. Larger, denser real-world diagrams are the case where this pays off; we don't have a fixture that size. | **Medium effort, low urgency.** Worth doing only paired with #4, and only if a future dense fixture shows crossings climbing. |
| 4 | **Run-and-Anchor vertical alignment** | No direct equivalent. `favorStraightEdges: true` is ELK's own attempt at this, but it operates *before* our lane-shift, so any alignment it achieves is exactly what §5.0a then destroys. Our own `§5.0c` happy-path leveling is a partial, narrower version (median-snap, happy-path edges only, off by default). | Yes, directly measured: §4's 37–839 px chain-alignment breaks are exactly this failure mode. | New post-lane-shift pass: for every plain link (or every edge, weighted by "is this a straight two-node hop"), snap chains to a shared y within each lane the way §5.0c does, but unconditionally (not gated behind `happyPathLeveling`, not restricted to happy-path edges) and only after all lane bands are final. | **This is the best-evidenced adoption in this analysis.** Directly explains the chain-alignment drop in §3 (100%→40–71% on multi-lane fixtures) and the concrete 497–839 px jumps in §4. | **Small-to-medium effort, well-scoped.** The groundwork already exists in `coordinates.js` §5.0c/§5.0d — this is closer to "generalize an existing pass" than "add new machinery." |
| 5 | Left-shift compressor | Partially — ELK's own `elk.layered.compaction.postCompaction.strategy: EDGE_LENGTH` plus our `compactLanes` (`visual-refinement.js`, opt-in) both compact, but neither is layer-aware left-shift with crossing-preservation guarantees; `compactLanes` compacts lane *height*, not layer *width*. | Not broken so much as **not attempted on the width axis** — CLAUDE.md's own admission (`visual-refinement.js:186-196`) is that lane-compaction saves a near-constant ~45 px/lane independent of content density. | Lower priority than #3/#4. If pursued, targets width (layer spacing), which is a different axis than what §3/§4 measured as broken. | Not measured in this analysis (area growth in §3 is dominated by lane-band stacking, not layer spacing — a different mechanism). | **Skip for now.** No measured evidence it's our bottleneck; revisit only after #3/#4 ship and area is re-measured. |
| 6 | Orthogonal router with obstacle avoidance | Yes for the *initial* route — `elk.edgeRouting: ORTHOGONAL`. No for anything downstream — `edge-simplify.js` only tries 2 candidate 1-bend L-shapes (never 2-bend staircases), collision-checks against nodes only (never edge-vs-edge), and multiple synthetic-route sites (§5.0e, §5.2, §5.5) rebuild routes with a fixed 4-point construction regardless of whether fewer bends would do. | Yes, by construction — every route that survives the lane-shift and gets rebuilt loses whatever obstacle-awareness ELK's router had. | A genuinely bigger lift: proper obstacle-aware orthogonal routing (Petrov's own "computational cost of orthogonal pathfinding" complaint) touching `edge-simplify.js` and all three synthetic-route sites in `coordinates.js`. | `edgeThroughNode` in our metrics stays low (0–3) across fixtures — not presently a visible problem on these fixture sizes, though the mechanism (fixed 4-point routes) is clearly a simplification that could bite on denser real-world graphs. | **Defer.** No measured evidence of current harm; the existing L-shape simplification is "good enough" on this fixture set. Revisit if a real customer diagram shows edges cutting through nodes. |

## 7. Alternative coordinate-computation methods

- **A — ELK option tuning.** Cheapest possible lever: change `scripts/config.json`'s `elk.layered`
  block, no code changes. Tested `BRANDES_KOEPF` node placement, `thoroughness: 50`,
  `considerModelOrder.strategy: NONE`, `favorStraightEdges: false` against raw ELK output on the four
  largest/densest fixtures. Result: **negligible effect.** `BRANDES_KOEPF` shaved a small number of
  bends (realistic-collaboration 6→4, bpmn-generator-pipeline 18→16) with no change to crossings or
  chain alignment; every other variant was bit-for-bit identical to baseline on these fixture sizes.
  ELK's default layering is already doing its job well — **the bottleneck is downstream of ELK, not
  inside it.** Verdict: not worth pursuing beyond possibly adopting `BRANDES_KOEPF` as a free minor bend
  reduction; no combination tested moved the metrics that actually matter (§4).
- **B — Petrov's ideas as post-ELK passes.** See §6 — the recommended path, ideas #3/#4 specifically.
- **C — ELK run per lane** (the `synergycodes/bpmn-editor` approach — Angular 19 + `ng-diagram`, ELK
  `layered` with `RIGHT` direction, one ELK invocation per swimlane, lanes stacked by hand afterward,
  auto-layout manually triggered rather than automatic). Simpler than our current two-stage approach
  (global ELK + lane-shift) in one sense — no shift-induced misalignment because ELK never had a
  cross-lane view to begin with — but trades that for being **structurally blind to cross-lane
  crossings and alignment**, which is the opposite failure mode: it can't optimize what it never sees.
  Not an improvement over our current architecture, let alone over adopting #3/#4.
- **D — Full grid-based engine, Petrov-style** (ELK for ranking only; our own grid, lane-constrained
  barycenter, Run-and-Anchor, left-shift compressor, and orthogonal router). This is what the article
  itself built. Given the measured findings — crossings aren't broken, only alignment and area are —
  building a second full engine to fix two specific, well-localized defects is disproportionate. The
  targeted-pass approach (B) gets the same measured benefit at a fraction of the implementation and
  maintenance cost, and keeps ELK's already-good layering and crossing minimization intact.
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

| Idea | Benefit measured? | Effort | Risk | Priority |
|---|---|---|---|---|
| #4 Run-and-Anchor-style alignment (generalize §5.0c) | **Yes — the strongest finding in this analysis** (§4) | S–M | Low — extends an existing, already-shipped mechanism | **1** |
| #3 Lane-constrained barycenter reorder | Not yet (crossings already near-zero on our fixtures) but theoretically sound and cheap to add alongside #4 | M | Low-Medium — touches ordering before §5.0a runs | **2, bundled with #1** |
| A — `BRANDES_KOEPF` node placement | Small (bend count only) | Trivial (config change) | Very low | **3, opportunistic** |
| #5 Left-shift width compaction | Not measured as broken | M | Medium | Defer |
| #6 Full obstacle-aware routing | Not measured as broken | L | Medium-High | Defer |
| D Full Petrov-style engine | Superseded by targeted passes | XL | High | Reject |
| C ELK-per-lane | Trades one failure mode for another | M | Medium | Reject |

**Concrete combination, in order:**

1. Generalize `§5.0c` happy-path leveling into an always-on chain-alignment pass that runs *after*
   §5.0a's lane-band stacking is final (not gated behind `CFG.layout.happyPathLeveling`, not restricted
   to happy-path-flagged edges) — this directly targets the 497–839 px breaks measured in §4.
   Abort criterion: re-run `layout-metrics.mjs`; if chain alignment on `sparse-lanes` and
   `bpmn-generator-pipeline` doesn't recover to at least 90%, the snapping logic needs rework before
   proceeding to step 2.
2. Add a lane-capped barycenter sweep before §5.0a derives lane bands, so within-lane node order is
   chosen with lane membership known rather than inherited from a lane-blind ELK ordering. Bundle with
   step 1 since both touch the same lane-shift boundary; verify crossings don't regress (they're
   already near-zero — any increase here is a bug, not a trade-off).
3. Adopt `BRANDES_KOEPF` node placement in `scripts/config.json` as a low-risk, low-effort follow-on —
   independent of steps 1–2, can ship any time.
4. Re-run the full `layout-metrics.mjs` baseline after 1–3 and update
   `tests/bench/layout-metrics-baseline.md`; if area is still inflating on multi-lane fixtures at that
   point (separately from the `wide-pipeline` wrapping anomaly noted in §3), that's the trigger to
   scope idea #5 (left-shift compaction) as a follow-up, not before.

Everything above is scoping for a **separate implementation task** — this analysis makes no code
changes to `layout.js`, `coordinates.js`, `edge-simplify.js`, or `visual-refinement.js`.

## 9. Appendix — raw experiment data

- Full baseline table: [`tests/bench/layout-metrics-baseline.md`](../tests/bench/layout-metrics-baseline.md).
- ELK-options experiment (BRANDES_KOEPF / thoroughness / considerModelOrder / favorStraightEdges) was
  run as a scratch script against `logicCoreToElk`/`runElkLayout` directly (not committed — reproduce
  by mutating `CFG.elk.layered` before calling `logicCoreToElk` on any fixture and re-measuring with
  the same metric functions as `scripts/bench/layout-metrics.mjs`). Summary in §7.
- Chain-misalignment pixel deltas (§4) were extracted by filtering `runPipeline`'s
  `coordMap.coords` for plain links (`outDegree(source) === 1 && inDegree(target) === 1`) and comparing
  center-y before/after the lane-shift; reproduce against `sparse-lanes.json` and
  `bpmn-generator-pipeline.json`.

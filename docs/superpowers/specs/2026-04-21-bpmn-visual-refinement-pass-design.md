# BPMN Visual Refinement Pass — Design

Date: 2026-04-21
Author: Daniel Stiegler + Claude
Status: Proposed

## 1 Problem

Empirical inspection of generator output (rendered `simple-approval.json` and `bpmn-generator-pipeline.json` self-diagram) surfaces four distinct visual-quality issues on non-trivial diagrams:

- **Lane header labels unreadable** — `LANE_HEADER_W = 40` is globally fixed. Long labels like "Prozessverantwortlicher" rotate 90° and exceed lane height, causing clipping and visual compression.
- **Edge labels collide** with lane-separator lines, other edges, and in some cases pool borders.
- **Wasted vertical space** — lanes have uniform height driven by the tallest lane's content; sparsely populated lanes are oversized. Canvas area utilization on the self-diagram is ≈55%.
- **Wide diagrams scale badly** — linear pipelines with 20+ nodes produce canvases with aspect ratio 5:1+.

Two items in the user's stored preferences explicitly flag `dynamic laneHeaderWidth` and `elk.layered.wrapping.strategy: MULTI_EDGE` as priority features.

## 2 Goal

Introduce a **Visual Refinement Pass** — a suite of post-layout coordinate transforms plus one pre-layout ELK hint — that improves visual density and label legibility without touching the ELK layout algorithm itself. The refinement is **opt-in** via config flag; existing behavior is preserved as default.

Out of scope for this spec: A2 (cross-lane backflow routing), A5 (synthetic edge crossing minimization). Those get separate specs.

## 3 Architecture

### 3.1 New module

`scripts/visual-refinement.js` — pure-functional module with four exports:

```
computeDynamicLaneHeaders(coordMap, process)  → coordMap'
compactLanes(coordMap)                        → coordMap'
repairEdgeLabels(coordMap)                    → coordMap'
estimateTextWidth(text, fontSize)             → pixels   (utility)
```

Dependencies: `types.js`, `utils.js` only. No elkjs import. No import from `layout.js` or `coordinates.js`. This preserves the acyclic module graph.

### 3.2 `LANE_HEADER_W` refactor — scalar → per-pool

Currently `LANE_HEADER_W` is a single imported constant in 5 files (`layout.js`, `coordinates.js`, `svg.js`, `bpmn-xml.js`, `utils.js` defines it). Making it dynamic requires a lookup rather than a static import.

**Strategy:** attach `laneHeaderWidth` to each pool entry in the coordinate map. All consumers read `coords.pools[pid].laneHeaderWidth ?? LANE_HEADER_W`. The global constant stays as fallback, so behavior with `visualRefinement.enabled = false` is byte-identical to current output.

Files that need the lookup update:
- `coordinates.js` — `buildCoordinateMap` initializes `pool.laneHeaderWidth = LANE_HEADER_W`.
- `layout.js` — `elk.padding` string construction (lines 85, 113) reads from the pool's hinted value if available, else LANE_HEADER_W.
- `svg.js` — pool/lane rect rendering (lines 30, 105–135, 226–235).
- `bpmn-xml.js` — DI generation (line 429).

### 3.3 Config (additions to `scripts/config.json`)

```json
"visualRefinement": {
  "enabled": false,
  "dynamicLaneHeader": true,
  "laneHeaderMinWidth": 30,
  "laneHeaderMaxWidth": 120,
  "laneCompaction": true,
  "minLaneHeight": 80,
  "edgeLabelCollisionRepair": true,
  "edgeLabelMaxShift": 25,
  "elkWrapping": "auto",
  "elkWrappingNodeThreshold": 20
}
```

Each sub-flag can be toggled independently for isolation in tests and incremental rollout. `enabled: false` gates the entire feature.

### 3.4 Pipeline integration (`scripts/pipeline.js`)

Two insertion points around the existing layout → coordinate-map → serialize flow:

```js
const refineOn = opts.visualRefinement ?? CFG.visualRefinement?.enabled ?? false;

// Eingriff 1 — vor ELK-Layout
const elkGraph = logicCoreToElk(process, { elkWrapping: refineOn });
const laid     = await runElkLayout(elkGraph);

let coordMap   = buildCoordinateMap(laid, process);

// Eingriff 2 — nach Coordinate-Map
if (refineOn) {
  if (CFG.visualRefinement.dynamicLaneHeader)        coordMap = computeDynamicLaneHeaders(coordMap, process);
  if (CFG.visualRefinement.laneCompaction)           coordMap = compactLanes(coordMap);
  if (CFG.visualRefinement.edgeLabelCollisionRepair) coordMap = repairEdgeLabels(coordMap);
}

const bpmnXml = generateBpmnXml(coordMap, process);
const svg     = generateSvg(coordMap, process);
```

Ordering matters:
1. Pass 1 changes pool X (adds width for wider header) — must run before Pass 2/3.
2. Pass 2 changes pool Y (shrinks lanes, shifts nodes) — must run before Pass 3.
3. Pass 3 reads finalized node and lane geometry.

## 4 Refinement Passes

### 4.1 Pass 1 — `computeDynamicLaneHeaders(coordMap, process)`

**Rationale:** Lane-header labels are rotated 90° and rendered along the lane's vertical axis. When label text, rotated, is longer than lane height, it overflows and gets clipped. The fix is to wrap the label into multiple lines so each line fits within the lane height — which requires widening the header strip to accommodate the additional lines stacked horizontally.

```
for each pool p in coordMap:
  let maxStripWidth = LANE_HEADER_MIN_WIDTH
  for each lane l in p.lanes:
    let available = l.h - 2 * padding
    let oneLineLen = estimateTextWidth(l.label, fontSize=11)
    if oneLineLen > available:
      l.renderedLines = wrapText(l.label, available)
    else:
      l.renderedLines = [l.label]
    let neededStripWidth = l.renderedLines.length * (fontSize + lineGap) + 2 * padding
    maxStripWidth = max(maxStripWidth, neededStripWidth)
  p.laneHeaderWidth = clamp(maxStripWidth, MIN, MAX)
  if maxStripWidth > MAX:
    truncate lanes whose wrapped text would overflow max; append "…"; store full label in l.titleTooltip
```

**Pool width adjustment:** After computing `p.laneHeaderWidth`, the delta against the default `LANE_HEADER_W` is added to the pool's outer width **on the left side** (pool.x shifts left by delta; pool.w grows by delta). Nodes inside the pool keep their ELK-computed X positions, so the lane content area is unchanged — only the header strip grows outward. The canvas-level aggregate `coordMap.canvas.w` and the minimum pool X must be recomputed after this pass (and again after Pass 2 for Y).

**Edge cases:**
- Empty lane (no label): strip width = MIN.
- Single-char label: strip width = MIN.
- Collapsed pool (no lanes): no header computation; pool header band renders as today.
- Multiple pools on same diagram: each pool independent, may have different `laneHeaderWidth`.

### 4.2 Pass 2 — `compactLanes(coordMap)` — highest risk

**Rationale:** ELK partitioning produces equal-height lane slots. Sparsely populated lanes waste vertical space. A post-layout shrink of each lane to its content's vertical bounding box yields significantly denser diagrams.

**Risk:** ELK's edge waypoints are computed against the original geometry. Moving lanes after layout requires coordinated waypoint adjustment. Three approaches considered; (ii) selected:

**(i) Pre-layout hints via ELK partition spacing** — rejected. ELK's partitioning API does not support per-partition heights (see elkjs#92). Attempting this via spacing overrides yielded unreliable results in prior experiments.

**(ii) Post-layout Y-shift + localized waypoint adjustment** — selected.
```
for each lane l in pool p, top to bottom:
  contentBbox = bounding box of all nodes whose lane == l.id
  newH = max(contentBbox.h + 2 * padding, MIN_LANE_HEIGHT)
  delta = l.h - newH
  if delta > 0:
    l.h = newH
    shiftDownwardLanesAndNodes(p, l.endY, by: -delta)
    for each edge e in coordMap.edges:
      for each waypoint w in e.waypoints:
        if w.y > l.endY: w.y -= delta
p.h = Σ l.h for l in p.lanes
```
Intra-lane edges and simple cross-lane edges adjust correctly because all affected coordinates shift in lockstep. Edges traversing multiple compacted lanes accumulate shifts proportionally — geometrically this preserves orthogonality but may degrade routing aesthetics slightly.

**Boundary edge case:** waypoints that originally sat in the region `[lane.newEndY, lane.oldEndY]` — i.e. the strip being "removed" — need explicit handling: either clamp to `lane.newEndY - 1` (keeps them inside the shrunk lane) or apply a graduated shift `(y - lane.newEndY) / (lane.oldEndY - lane.newEndY) × -delta`. Implementation picks one consistent strategy and documents it in code comments; the fixture tests will surface which looks cleaner.

**(iii) Re-route all edges with `clipOrthogonal` after compaction** — kept as fallback behind a secondary flag (not yet added to config). If (ii) shows routing artifacts in testing, the fallback is: discard ELK's edge paths post-compaction and re-run orthogonal routing from scratch.

**Abort criterion (see §7 Rollout, Phase P5):** if `sparse-lanes.json` fixture shows >5% increase in edge crossings with `laneCompaction: true` vs `false`, default-disable this pass and ship it opt-in only.

### 4.3 Pass 3 — `repairEdgeLabels(coordMap)`

**Rationale:** ELK places edge labels at an algorithmically valid point that is often visually poor — on top of another edge, over a lane-separator line, or over a node.

```
obstacles = [
  ...coordMap.edges.flatMap(e => e.labels.map(l => l.bbox)),
  ...coordMap.nodes.map(n => n.bbox),
  ...coordMap.pools.flatMap(p => p.lanes.map(l => l.headerRect)),
  ...coordMap.pools.map(p => p.borderLines)
]

for each edge-label L in coordMap:
  L.bbox = estimateTextBBox(L.text, fontSize=11)
  collisions = findAxisAlignedOverlap(L.bbox, obstacles.except(L))
  if collisions.length == 0: continue

  for distance in [15, 25, edgeLabelMaxShift]:
    for direction in ['up', 'down', 'perpendicular-left', 'perpendicular-right']:
      testBbox = L.bbox shifted by (direction, distance)
      if findAxisAlignedOverlap(testBbox, obstacles.except(L)).length == 0:
        L.position = testBbox.origin
        break outer
  else:
    log.warn(`Edge-Label "${L.text}" couldn't be repaired — ${collisions.length} collisions`)
    // leave at ELK-assigned position
```

Purely axis-aligned bounding-box tests; no polygon geometry. `edgeLabelMaxShift` caps nudge distance to prevent labels drifting far from their edge.

### 4.4 Pass 4 — `wrapText` extension in `utils.js`

**Rationale:** existing `wrapText(text, maxWidth)` breaks on word boundaries. German compound words (e.g. "Prozessverantwortlicher", 22 chars) are single words and never get wrapped — they overflow.

**Extension:**
```
function wrapText(text, maxWidth, fontSize=11):
  words = text.split(/\s+/)
  lines = []
  current = ""
  for word in words:
    if estimateTextWidth(word, fontSize) > maxWidth:
      // NEW: char-level break with soft hyphen
      chunks = splitWordAtWidth(word, maxWidth, fontSize)
      for chunk in chunks: lines.push(chunk + (isLast ? "" : "-"))
    else if estimateTextWidth(current + " " + word, fontSize) <= maxWidth:
      current += (current ? " " : "") + word
    else:
      lines.push(current)
      current = word
  if current: lines.push(current)
  return lines
```

`splitWordAtWidth` is conservative: it breaks at syllable-boundary-like points if detectable (vowel-consonant transitions), else at character boundaries every N chars where N × charWidth ≈ maxWidth.

Not attempting CamelCase-splitting — too many false positives with product/brand names.

### 4.5 Pass 5 — Conditional ELK wrapping in `layout.js`

**Rationale:** Linear pipelines with 20+ nodes produce extreme aspect ratios. ELK's `wrapping.strategy: MULTI_EDGE` folds long layer chains into multiple rows.

In `logicCoreToElk(process, opts)`:
```js
const nodeCount = flatNodes.length
const mode = CFG.visualRefinement?.elkWrapping ?? 'off'
const threshold = CFG.visualRefinement?.elkWrappingNodeThreshold ?? 20

if (opts.elkWrapping && (mode === 'always' || (mode === 'auto' && nodeCount > threshold))) {
  elkOptions['elk.layered.wrapping.strategy'] = 'MULTI_EDGE'
  elkOptions['elk.layered.wrapping.additionalEdgeSpacing'] = '40'
}
```

**Compatibility risk:** ELK's `wrapping.strategy` interacts with `partitioning` (used for lanes). The 25-node `wide-pipeline.json` fixture validates that lanes remain intact under wrapping. If the integration test shows broken lane partitioning, fall back to `LAST_LAYER_SOFT` (less aggressive wrapping).

## 5 Data Flow

```
Logic-Core JSON
  ↓
validate (rules.js)
  ↓
topology (infer gateway directions, topological sort, lane ordering)
  ↓
logicCoreToElk(process, { elkWrapping: refineOn }) ← Pass 5 hint applied here
  ↓
elk.layout()
  ↓
buildCoordinateMap(laid, process)
  ↓
if refineOn:
  computeDynamicLaneHeaders(coordMap, process)   ← Pass 1 (widens pool X)
  compactLanes(coordMap)                         ← Pass 2 (shrinks pool Y, shifts nodes)
  repairEdgeLabels(coordMap)                     ← Pass 3 (nudges labels)
  ↓
generateBpmnXml(coordMap, process)
generateSvg(coordMap, process)
```

Every pass is a pure function with signature `(coordMap, ...) → coordMap`, testable in isolation with a hand-built minimal coordMap.

## 6 Testing

### 6.1 Matrix strategy

Each existing fixture runs twice in CI:
- With `visualRefinement.enabled = false` → checked against `*.expected.{bpmn,svg}` (byte-identical to current).
- With `visualRefinement.enabled = true` → checked against new `*.refined.{bpmn,svg}`.

### 6.2 New fixtures

| Fixture | Purpose | Size |
|---|---|---|
| `long-lane-names.json` | Pass 1 — labels > 20 chars in 3 lanes | 8 nodes, 3 lanes |
| `sparse-lanes.json` | Pass 2 — 1 lane with 5 tasks, 3 lanes with 1 task each | 8 nodes, 4 lanes |
| `dense-edge-labels.json` | Pass 3 — fan-out XOR with 5 labeled branches | 12 nodes, 1 lane |
| `wide-pipeline.json` | Pass 5 — 25-activity linear flow | 25 nodes, 1 lane |

### 6.3 Metric assertions

Beyond golden-file equality, add numeric assertions that survive golden regenerations:

| Pass | Assertion | Applied to |
|---|---|---|
| 1 | For every lane: `lane.renderedLines.length × (fontSize + lineGap) ≤ pool.laneHeaderWidth` **and** `max(estimateTextWidth(line)) ≤ lane.h - 2*padding` | all refinement fixtures |
| 1 | `canvas.width(enabled=true) ≤ 1.5 × canvas.width(enabled=false)` (guard against runaway widening) | `long-lane-names.json` |
| 2 | `canvas.height(enabled=true) ≤ 0.75 × canvas.height(enabled=false)` | `sparse-lanes.json` |
| 3 | zero axis-aligned bbox overlaps between any two edge labels | `dense-edge-labels.json` |
| 5 | `canvas.aspectRatio ≤ 2.5` | `wide-pipeline.json` |

### 6.4 Unit tests

New file `scripts/visual-refinement.test.js` with isolated tests per function, using hand-constructed minimal coordMaps (no ELK round-trip). Coverage target: every pass, every conditional branch, every fallback path.

### 6.5 Test count target

Existing 136 tests remain green. New tests add ~18–22:
- 8–10 unit tests (visual-refinement.test.js)
- 4 matrix golden-pair tests (3 existing + 4 new fixtures, each with refinement on and off)
- 4 metric-assertion tests (one per pass, excluding Pass 4 which is a utility)
- 2–4 integration edge cases (collapsed pools, multi-pool collaboration, nested sub-processes)

## 7 Rollout

Five commits/phases, each independently deployable. After each phase: `npm test` green.

| Phase | Scope | Files touched | Risk |
|---|---|---|---|
| **P1** | Config scaffolding; empty `visual-refinement.js`; refactor `LANE_HEADER_W` → per-pool lookup | config.json, utils.js, coordinates.js, layout.js, svg.js, bpmn-xml.js, visual-refinement.js (new) | low |
| **P2** | Pass 1 (`computeDynamicLaneHeaders`) + Pass 4 (`wrapText` extension) + tests | visual-refinement.js, utils.js, pipeline.js, new fixture `long-lane-names.json`, visual-refinement.test.js | low |
| **P3** | Pass 3 (`repairEdgeLabels`) + tests | visual-refinement.js, pipeline.js, new fixture `dense-edge-labels.json` | low |
| **P4** | Pass 5 (conditional ELK wrapping) + tests | layout.js, pipeline.js, new fixture `wide-pipeline.json` | medium |
| **P5** | Pass 2 (`compactLanes`) + tests | visual-refinement.js, pipeline.js, new fixture `sparse-lanes.json` | medium–high |

**P5 abort criterion:** if edge-crossing count on `sparse-lanes.json` with compaction enabled exceeds 1.05 × the count without compaction, ship P5 with `laneCompaction: false` as default sub-flag. Keep (iii) re-route fallback ready as a follow-up if needed.

**Default-flip commit:** separate from any implementation commit. After ~2 weeks of opt-in real-world usage without regression reports, flip `visualRefinement.enabled` to `true` as a single dedicated commit (easy to revert if issues surface).

## 8 Non-Goals

- Vision-based layout feedback (M1 was dropped in favor of L3 orchestrator agents).
- Cross-lane backflow routing (A2) — separate spec.
- Synthetic-path edge crossing minimization (A5) — separate spec.
- Font-metric-accurate text measurement — char-count heuristic is sufficient; Canvas API is not available in Node runtime.
- BPMN-in-Color interactions — existing `bioc:` color attributes must continue to work, but no new color logic.

## 9 Open Questions

None blocking. Items to validate during implementation:

- Does ELK `MULTI_EDGE` wrapping preserve lane partitioning on `wide-pipeline.json`? If not, fall back to `LAST_LAYER_SOFT`.
- Is axis-aligned bbox sufficient for edge-label collision detection, or do labels on diagonal edges need rotation-aware detection? Likely sufficient given ELK routes orthogonally.
- Does the `wrapText` char-level fallback need language-aware syllable detection (e.g. for German Fugen-s), or is width-based chunking enough? Start with width-based; revisit if feedback demands it.

## 10 References

- User memory: `reference_elk_options.md` — ElkJS Layered Algorithm Options Reference.
- User memory: `feedback_elk_features.md` — dynamic laneHeaderWidth + wrapping for 20+ activities as priorities.
- `ROADMAP.md` §7 Known Limitations — cross-lane backflows, synthetic path crossings.
- `README.md` "Realistic Expectations" — 30+ activity diagrams acknowledged as suboptimal.
- Empirical inspection: `/tmp/bpmn-review-simple.svg.png`, `/tmp/bpmn-review-complex.svg.png` (2026-04-21).
- elkjs#92 — swimlane support limitation in partitioning.

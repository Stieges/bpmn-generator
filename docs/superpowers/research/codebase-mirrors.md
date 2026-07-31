# Codebase mirrors — BPMN internals a DMN pipeline/coordinates/layout/di-check must match

All paths below are post-restructure: `scripts/bpmn/*`, `scripts/shared/*`, `scripts/dmn/*`. Line
numbers are as of the current `feat/dmn` branch working tree; re-check before quoting in a PR review
months later.

---

## A. The BPMN orchestrator (`scripts/bpmn/pipeline.js`)

### A1. `runPipeline` — signature, stage order, return shape

```js
async function runPipeline(logicCore, opts = {}) {
```
Params: `logicCore` (Logic-Core JSON, deep-cloned internally via
`JSON.parse(JSON.stringify(logicCore))` so callers' objects are never mutated), `opts`:
- `opts.visualRefinement` (bool, overrides `CFG.visualRefinement?.enabled ?? false`)
- `opts.mode` (`'document'` default, or `'optimize'`/`'soll'` — enables the Optimization Advisory layer)
- `opts.ruleProfile` (string path or object; augmented by `mode` via `profileForMode`)
- `opts.poolOrder` (`'auto'` default or `'declared'`, overrides `CFG.layout?.poolOrder`)

Stage order inside `runPipeline` (`scripts/bpmn/pipeline.js:56-129`), each a **named call**:

1. `validateLogicCore(lc, profile)` (from `./validate.js`) — rule engine gate. **On `errors.length`,
   returns early**: `{ bpmnXml: null, svg: null, coordMap: null, diagnostics: null, validation: { errors, warnings, advisories, metrics } }`.
2. `inferGatewayDirections(proc.nodes || [], proc.edges || [])` — once per process/pool.
3. `logicCoreToElk(lc, { elkWrapping: refineOn, poolOrder })` — builds the ELK graph.
4. `runElkLayout(elkGraph)` — `await`ed, runs ELK.
5. `buildCoordinateMap(elkResult, lc)` — produces `coordMap`.
6. `simplifyAllEdges(coordMap.edgeCoords, coordMap.coords, allEdges, skipSimplify)` (from
   `edge-simplify.js`) — mutates/replaces `coordMap.edgeCoords`. `skipSimplify` is a `Set` of
   association ids (associations are pre-clipped in §5.4 and must not be re-simplified).
7. **Conditionally**, if `refineOn`: `computeDynamicLaneHeaders`, `compactLanes`,
   `repairEdgeLabels` (all from `visual-refinement.js`), each gated by its own
   `CFG.visualRefinement.*` sub-flag (default on when the parent flag is on).
8. `routeMessageFlows(coordMap, lc)` — **always last of the geometry passes**, because a message
   flow's horizontal leg has to sit in the final gap between participants (comment right above the
   call explains this is why it is NOT part of `buildCoordinateMap`).
9. `generateBpmnXml(lc, coordMap)` — `await`ed.
10. `generateSvg(lc, coordMap)` — **not** awaited, `generateSvg` is synchronous.
11. `validateBpmnXml(bpmnXml)` — `await`ed, the round-trip-through-moddle warning check.
12. `checkDiagramIntegrity(coordMap, lc)` — **not** awaited, synchronous, produces `diagnostics`.

Return shape (success path):
```js
{
  bpmnXml, svg, coordMap, diagnostics,
  validation: { errors: [], warnings, advisories, metrics, xmlWarnings: roundTrip.warnings },
}
```
`diagnostics` shape comes straight from `checkDiagramIntegrity` — see §D9. `validation.metrics` is
whatever `runRules` populated (see §F below on `rules.js`'s `runRules`) — `{}` unless the
Workflow-Net or Optimization opt-in layers ran, in which case `metrics.workflowNet` / `metrics.optimization`
appear. `validation.advisories` is `[]` unless `mode: 'optimize'`/`'soll'` is set.

**`--strict` is honoured only in the CLI (`main()`), not inside `runPipeline` itself** — `runPipeline`
has no `strict` option. Three separate abort points in `main()`, each **before any file is
written**:
- `strict && result.validation.warnings.length` → rule-engine warnings (soundness/style/etc.)
- `strict && diWarnings.length` → DI diagnostics with `severity !== 'ERROR'` (i.e. DI05)
- `strict && xmlWarnings.length` → moddle round-trip warnings

Each prints a message and calls `process.exit(1)`. A DI `ERROR` (not just `--strict`) always aborts
regardless of the flag — that check is unconditional (`if (diErrors.length) { ...; process.exit(1); }`).

### A2. CLI portion

Direct-run detection (`scripts/bpmn/pipeline.js:499-503`):
```js
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch(err => { console.error('Pipeline error:', err); process.exit(1); });
}
```
This is the exact idiom to mirror in `scripts/dmn/pipeline.js` — comparing `process.argv[1]` against
`fileURLToPath(import.meta.url)`, both resolved, so `import`ing the module for its exports never
triggers the CLI.

Arg/flag parsing (`main()`, lines 310-321) — no library, plain filtering:
```js
const args       = process.argv.slice(2);
const flags      = args.filter(a => a.startsWith('--'));
const positional = args.filter(a => !a.startsWith('--'));
const inputArg   = positional[0];
const outputBase = positional[1] || 'output';
const formatDot  = flags.includes('--format=dot') || flags.includes('--dot');
const importDot  = flags.includes('--import-dot');
const generateDoc = flags.includes('--doc');
const drillDown  = flags.includes('--drill-down');
const strict     = flags.includes('--strict');
const optimize   = flags.includes('--optimize') || flags.includes('--mode=soll') || flags.includes('--mode=optimize');
```
Usage error (`!inputArg`) prints to `console.error` and `process.exit(1)`.

Stdin (`-`) handling (lines 328-335):
```js
if (inputArg === '-') {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  rawInput = Buffer.concat(chunks).toString();
} else {
  rawInput = readFileSync(resolve(inputArg), 'utf8');
}
```

Schema gate runs **before** the pipeline, in the CLI, separately from any gate inside
`runPipeline` (`runPipeline` itself does NOT call the schema gate — only `validateLogicCore`, the
rule engine):
```js
const schemaCheck = validateLogicCoreSchema(parsedInput);
if (!schemaCheck.valid) {
  console.error('\n✗ Schema-Gate: Logic-Core input violates references/input-schema.json:');
  schemaCheck.errors.forEach(e => console.error(`  · ${e.path} ${e.message}`));
  process.exit(1);
}
```

Output writing: `writeFileSync(`${outputBase}.bpmn`, result.bpmnXml, 'utf8')` and the `.svg`
equivalent, plus optional `.md` (`--doc`) and `.dot` (`--dot`) exports. All via `writeFileSync` from
`node:fs`, `'utf8'` encoding, no async file I/O.

Exit codes: `0` implicit success (falls off the end of `main()`); `1` on: no `inputArg`, schema-gate
failure, `!result.bpmnXml` (pipeline blocked by rule-engine errors), `--strict` + any warning class,
DI `ERROR`s (unconditional), and the top-level `.catch` in `main().catch(...)`. There is no exit code
`2` in this file (unlike the docs-gate's own convention).

Warning/error printing convention — three **separate** channels, deliberately not merged (see the
comments at lines 421-424, 441-446):
1. Rule-engine warnings → `console.warn('\n⚠ Warnings:')` then `· ` bullets.
2. Optimization advisories (only if `optimize && result.validation.advisories?.length`) → `console.log('\n💡 Optimization opportunities ...')`.
3. DI diagnostics → split into `diErrors`/`diWarnings` by `severity === 'ERROR'`; warnings via
   `console.warn('\n⚠ Diagram diagnostics:')`, errors via `console.error('\n✗ Diagram integrity (DI) ...')`.
4. XML round-trip warnings → `console.warn('\n⚠ BPMN serialisation (round-trip through bpmn-moddle):')`.

### A3. `validateBpmnXml`

`scripts/bpmn/bpmn-xml.js:949-955`:
```js
async function validateBpmnXml(xml) {
  const { warnings } = await moddle.fromXML(xml);
  return {
    valid: warnings.length === 0,
    warnings: warnings.map(w => w.message || String(w)),
  };
}
```
It parses the **generated** XML string back through the same module-level `moddle` instance
(`const moddle = new BpmnModdle();` at the top of the file) using `moddle.fromXML`, and reports
whatever bpmn-moddle itself flagged as non-fatal warnings during parsing (e.g. "unknown attribute
<name>"). Called from `runPipeline` at `pipeline.js:120`: `const roundTrip = await validateBpmnXml(bpmnXml);`
— always run, unconditionally, right after `generateBpmnXml`/`generateSvg`, and its `warnings` land
in `validation.xmlWarnings`. `validateBpmnXml` is also exported from `pipeline.js` (re-export, not
re-implementation) for direct testing (see `pipeline.test.js:2006`, which feeds it a deliberately
bogus XML string and asserts `warnings.length > 0`).

---

## B. The geometry contract (`scripts/bpmn/coordinates.js`)

### B4. `buildCoordinateMap`

Signature: `function buildCoordinateMap(elkResult, lc)` (`coordinates.js:11`). Not async.
Returns:
```js
return { coords, laneCoords, poolCoords, edgeCoords, edgeLabels };
```
(`coordinates.js:666`). All five are **plain JS objects** (`{}` literals, `coordinates.js:12-15,
621`), never `Map`s — keyed by string id, so `coords['Task_1']`, not `coords.get('Task_1')`.

Exact per-key shape:
- `coords[nodeId] = { x, y, w, h }` — absolute (already offset-accumulated through the ELK
  hierarchy) top-left `x,y` and BPMN shape width/height. **Note the field names are `w`/`h`, not
  `width`/`height`** (ELK's own node objects use `width`/`height` — `coordinates.js` translates on
  the way in, e.g. line 62: `coords[node.id] = { x: ax, y: ay, w: node.width, h: node.height };`).
- `laneCoords[laneId] = { x, y, w, h }` — same shape, one entry per lane, computed from the
  bounding box of the lane's node group (§5.0) then adjusted for stacking (§5.0a) and width
  equalization.
- `poolCoords[poolId] = { x, y, w, h, laneHeaderWidth }` — one extra field vs. the other two maps:
  `laneHeaderWidth` (defaults to `LANE_HEADER_W` from `constants.js`, but can be overridden per-pool
  by visual-refinement's dynamic lane header pass — `bpmn-xml.js`'s `laneHeaderW()` helper reads it
  back with a `?? LANE_HEADER_W` fallback chain). For a single, lane-less process the key is the
  **literal string** `'_singlePool'` instead of the process id (`coordinates.js:45`).
- `edgeCoords[edgeId] = [{x,y}, {x,y}, ...]` — an **array of waypoint objects** (not `{x,y,w,h}`),
  at least 2 points, more for orthogonal bends. Keyed by the edge's own `id` (sequence flows), or by
  `messageFlowKey(mf)` = `mf.id || 'mf_' + mf.source + '_' + mf.target` for message flows, or by
  `assoc.id` for associations. See §B6.
- `edgeLabels[edgeOrFlowId] = { text, x, y }` — one label position per labeled sequence flow or
  named message flow. `x,y` is the label's anchor point (see below), not a bounding box.

### B5. `clipOrthogonal`

Signature (`coordinates.js:962`):
```js
function clipOrthogonal(shape, type, edgePt, nextPt, role)
```
- `shape` — `{x,y,w,h}` of the actual BPMN shape (from `coords[...]`).
- `type` — the BPMN element type string (`node.type`), used to pick which geometry formula applies.
- `edgePt` — the raw endpoint to clip (ELK's `pts[0]` or `pts[last]`).
- `nextPt` — the adjacent waypoint, used only to determine whether the final segment is horizontal
  or vertical (`dx = |nextPt.x-edgePt.x|`, `dy = |nextPt.y-edgePt.y|`, `isHorizontal = dx >= dy`) and,
  within that axis, which side of the shape to land on.
- `role` — `'source'` or `'target'` (accepted but **not actually branched on inside the function
  body** — the geometry is symmetric, so the parameter is present for readability/call-site symmetry
  only, not consumed).

Algorithm: dispatches by shape class —
```js
if (isEvent(type))   return clipCircleOrthogonal(cx, cy, r, nextPt, isHorizontal);
if (isGateway(type)) return clipDiamondOrthogonal(shape, nextPt, isHorizontal);
return clipRectOrthogonal(shape, nextPt, isHorizontal);   // activities / everything else
```
Each of the three helpers **preserves the orthogonal (90°) direction of the incoming segment** —
i.e. it does NOT clip to the nearest boundary point on a straight line to the center; it projects
along whichever axis (`x` fixed / `y` varies, or vice versa) the segment already travels, then
solves for where that axis-aligned ray crosses the shape's boundary (circle equation for events,
diamond `|x-cx|/hw + |y-cy|/hh=1` for gateways, plain rect edge + clamp for everything else).
Returns a single `{x, y}` point (the new endpoint), not an array.

**Reusable helper for a DMN straight-line clip**: `clipToRect(from, towards, rect)` at
`coordinates.js:784-795` — this is the "straight segment" clip the plan should reuse (not
`clipOrthogonal`, which is orthogonal-specific and BPMN-shape-specific via `isEvent`/`isGateway`).
```js
function clipToRect(from, towards, rect) {
  const dx = towards.x - from.x;
  const dy = towards.y - from.y;
  if (dx === 0 && dy === 0) return { x: from.x, y: from.y };
  const halfW = rect.w / 2;
  const halfH = rect.h / 2;
  const scale = Math.min(
    dx === 0 ? Infinity : halfW / Math.abs(dx),
    dy === 0 ? Infinity : halfH / Math.abs(dy),
  );
  return { x: from.x + dx * scale, y: from.y + dy * scale };
}
```
It projects a straight line from a shape's **center** toward another point and cuts it back to the
rectangle's border (works for any axis-aligned rectangle — DMN nodes have no circle/diamond
classes, so this is directly reusable with no BPMN-type branching needed). The paired function
`clipStraight(a, b)` (`coordinates.js:777-781`) shows the calling pattern for a two-ended straight
edge (DMN requirement connections are exactly this shape — a straight line, not orthogonal):
```js
function clipStraight(a, b) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  return [clipToRect(ac, bc, a), clipToRect(bc, ac, b)];
}
```
This is exactly what BPMN's own Association routing uses (§5.4, `coordinates.js:552-557`) — DMN
requirement connections (information/knowledge/authority) are the direct DMN analogue of a BPMN
Association, both being unstyled straight connectors between two shape borders, so this is very
likely the literal function to reuse (import `clipToRect`/`clipStraight` — currently NOT exported
from `coordinates.js`; only `buildCoordinateMap, enforceOrthogonal, findNodeInAllProcesses,
clipOrthogonal, routeMessageFlows` are exported at the bottom, line 1146 — so a DMN module cannot
`import { clipStraight } from '../bpmn/coordinates.js'` today without that export list being
extended, or the two functions being duplicated/moved to a shared location).

Also reusable/mirrorable: `enforceOrthogonal(pts)` is BPMN-orthogonal-specific and probably NOT
wanted for DMN (DMN requirement connections are conventionally drawn straight, not with 90° dog-legs)
— confirming the plan's assumption that DMN needs its own straight-clip path, not this one.

### B6. Edge waypoints end to end

`edgeCoords` is the single source of truth (object, `edgeId -> Array<{x,y}>`), built in three ways
depending on element class:
1. **Sequence flows** — from ELK's own routing (`collectEdge` in `buildCoordinateMap`, reading
   `edge.sections[].startPoint/bendPoints/endPoint`), then progressively corrected in §5.0e (detour
   replacement), §5.1 (`clipOrthogonal` endpoint projection), §5.2 (synthetic routing for edges ELK
   left unrouted), §5.3 (`enforceOrthogonal` dog-leg insertion), §5.5 (zigzag cleanup).
2. **Message flows** — computed entirely outside `buildCoordinateMap`, in `routeMessageFlows(coordMap, lc)`
   (mutates `coordMap.edgeCoords[messageFlowKey(mf)]` and `coordMap.edgeLabels[key]` in place), which
   `pipeline.js` calls **last**, after visual refinement.
3. **Associations** — §5.4 inside `buildCoordinateMap`, via `clipStraight` (see B5).

Consumers:
- `scripts/bpmn/bpmn-xml.js`: `buildWaypoints(pts, coords, sourceId, targetId)`
  (`bpmn-xml.js:746-758`) turns an `edgeCoords[...]` array into `dc:Point` moddle elements:
  ```js
  function buildWaypoints(pts, coords, sourceId, targetId) {
    if (pts.length >= 2) return pts.map(p => create('dc:Point', { x: rn(p.x), y: rn(p.y) }));
    // fallback: straight line between the two shape centers, only if pts is empty/short
    ...
  }
  ```
  Called once per sequence flow (`bpmn-xml.js:661`), once per subprocess-internal flow
  (`bpmn-xml.js:645`), and message flows / associations build their `dc:Point` list inline
  (`bpmn-xml.js:701`, `717`) rather than through `buildWaypoints` (they skip entirely — `if (pts.length < 2) continue;` — rather than falling back to a straight line, "better no DI edge than an invalid one").
  Each waypoint list becomes the `waypoint` array on a `bpmndi:BPMNEdge` moddle element.
- `scripts/bpmn/svg.js`: reads `edgeCoords[eid]` directly (no helper function) and builds an SVG
  path string: `` `M ${tx(pts[0].x)} ${ty(pts[0].y)} ` + pts.slice(1).map(p => `L ${tx(p.x)} ${ty(p.y)}`).join(' ') ``
  — done separately for sequence flows (`renderSequenceFlow`, `svg.js:275-301`), message flows
  (`svg.js:187-213`), and associations (`svg.js:215-225`) — three near-identical inline blocks, not
  a shared helper. `tx`/`ty` are the SVG viewport transform closures built earlier in `generateSvg`.

---

## C. Layout (`scripts/bpmn/layout.js`)

### C7. ELK bootstrap, options, signatures

Import (`layout.js:9`): `import ELK from 'elkjs/lib/elk.bundled.js';` — the **bundled** build (not
`elkjs/lib/elk-api.js` or the worker-based build), imported as a default export (a constructor).

Instantiation + run, inside `async function runElkLayout(elkGraph)` (`layout.js:313-317`):
```js
async function runElkLayout(elkGraph) {
  const elk = new ELK();
  const layouted = await elk.layout(elkGraph);
  return stackCollaborationVertically(layouted);
}
```
A **new `ELK()` instance is created per call** (not module-level/singleton). `elk.layout()` is
async/Promise-based. After the ELK call resolves, `stackCollaborationVertically(layouted)` is applied
as a deterministic post-process ONLY for the `id === 'collaboration'` graph (multi-pool case) — it
overrides ELK's rectpacking x/y for each pool child with a single vertical column (see comment
`layout.js:283-295`: ELK's rectpacking opens a second column at 4+ participants, which contradicts
`coordinates.js`'s "one x for all pools" assumption).

Options source: `scripts/config.json → elk.layered` and `elk.rectpacking` (verbatim keys are ELK's
own dotted option names, e.g. `'elk.algorithm'`, `'elk.layered.nodePlacement.strategy'`) — read via
`CFG.elk.layered` / `CFG.elk.rectpacking` (`CFG` from `../shared/utils.js`). Three read points:
- `elkDefaults()` (`layout.js:279-281`): `return { ...CFG.elk.layered };` — used for single-pool /
  lane-less-pool graphs.
- `buildLanedProcessElk` (`layout.js:132`): `...CFG.elk.layered` spread directly into the pool's
  `properties`, plus a computed `elk.padding` override, plus `wrappingOpts` spread last (wins on
  conflict).
- `buildMultiPoolElk` (`layout.js:205`): `...CFG.elk.rectpacking` for the outer `collaboration` node,
  plus `elk.spacing.nodeNode` and `elk.padding` overrides.

`logicCoreToElk(lc, opts = {})` (`layout.js:12-26`):
```js
function logicCoreToElk(lc, opts = {}) {
  preprocessLogicCore(lc, { poolOrder: opts.poolOrder });   // MUTATES lc (sorts nodes/lanes/pools)
  const wrappingOpts = resolveWrappingOpts(lc, opts);
  if (lc.pools && lc.pools.length > 0) return buildMultiPoolElk(lc, wrappingOpts);
  return buildSingleProcessElk(lc, wrappingOpts);
}
```
Not async. `opts.elkWrapping` (bool) and `opts.poolOrder` are the only two recognized keys.
**Side effect worth flagging for a DMN mirror**: `preprocessLogicCore` mutates its `lc` argument
in place (topological sort of nodes, lane ordering, `lc._participantOrder` assignment) — this is
why `pipeline.js` deep-clones `logicCore` before ever touching it.

`runElkLayout(elkGraph)` — shown above, `async`, no options parameter at all (the graph itself
already carries every ELK option via `properties`).

Shape ELK returns / downstream consumption: the raw ELK layout result is a nested tree
(`{ id, x, y, width, height, children: [...], edges: [...] }`, recursively), where each `edges[]`
entry carries `{ id, sections: [{ startPoint, bendPoints, endPoint }], ... }`. `coordinates.js`'s
`buildCoordinateMap(elkResult, lc)` is the only consumer, and it walks this tree recursively via its
internal `collectNodes`/`collectEdge` closures (see §B4) — nothing else in the codebase touches the
raw ELK tree.

### C8. `elk` block in `config.json`

Verbatim (`scripts/config.json`, `elk` key):
```json
"elk": {
  "layered": {
    "elk.algorithm": "layered",
    "elk.direction": "RIGHT",
    "elk.spacing.nodeNode": "60",
    "elk.spacing.edgeLabel": "5",
    "elk.layered.spacing.nodeNodeBetweenLayers": "80",
    "elk.layered.spacing.edgeEdgeBetweenLayers": "15",
    "elk.layered.spacing.edgeNodeBetweenLayers": "30",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    "elk.layered.crossingMinimization.greedySwitch.type": "TWO_SIDED",
    "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
    "elk.layered.nodePlacement.favorStraightEdges": "true",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    "elk.layered.thoroughness": "20",
    "elk.layered.compaction.postCompaction.strategy": "EDGE_LENGTH",
    "elk.layered.cycleBreaking.strategy": "GREEDY_MODEL_ORDER",
    "elk.layered.highDegreeNodes.treatment": "true",
    "elk.layered.highDegreeNodes.threshold": "6"
  },
  "rectpacking": {
    "elk.algorithm": "rectpacking",
    "elk.rectpacking.desiredAspectRatio": "0.1",
    "elk.contentAlignment": "V_TOP H_LEFT"
  }
}
```
All values are **strings** (ELK's own convention — even numeric options like spacing are
JSON-string-encoded, e.g. `"60"` not `60`), read via plain object spread (`CFG.elk.layered`) — no
parsing/casting layer in between. `CFG` itself comes from `loadConfig()` in `scripts/shared/utils.js`,
which is a plain `JSON.parse(readFileSync(...))` of `scripts/config.json` (see §F15) merged with an
optional custom override path from `process.env.BPMN_CONFIG`.

A DMN layout module has a real choice here: DMN DRDs are typically laid out top-to-bottom or as a
tree (Decision at top, Input Data/BKM/Knowledge Source below, following requirement direction),
which is a **different `elk.direction`** from BPMN's left-to-right process flow — this is very
likely NOT going to be a byte-identical copy of the `layered` block, just structurally the same
shape (a `properties` object of dotted ELK option strings).

---

## D. The DI check (`scripts/bpmn/di-check.js`)

### D9. `checkDiagramIntegrity`

Signature (`di-check.js:26`):
```js
function checkDiagramIntegrity(coordMap, lc, opts = {})
```
- `coordMap` — the `{ coords, laneCoords, poolCoords, edgeCoords, edgeLabels }` object from
  `buildCoordinateMap` (only `coords`, `poolCoords`, `laneCoords` are actually read; `edgeCoords` is
  read too, for DI05).
- `lc` — Logic-Core (used to enumerate participants/lanes/nodes/message flows to check).
- `opts.tolerance` — px slack, default `1` (module constant `DEFAULT_TOLERANCE = 1`).

Return shape:
```js
{ ok: !issues.some(i => i.severity === 'ERROR'), issues: [ { code, severity, message, elements }, ... ] }
```
`ok` means **"no ERROR-severity issue"** — WARNING-severity issues (currently only DI05) do not
affect `ok`. Each issue object: `code` (string like `'DI01'`), `severity` (`'ERROR'` or `'WARNING'`,
only two values used), `message` (human-readable string), `elements` (array of element/participant
ids involved, for tooling to highlight).

Six codes today: DI01 (identical participant position, ERROR), DI02 (participant overlap, ERROR),
DI03 (node outside its participant, ERROR), DI04 (overlapping lane bands, ERROR), DI06 (subprocess
child outside parent box, ERROR), DI05 (message flow crossing an uninvolved participant, WARNING —
the only non-ERROR code, deliberately, because a 3+-participant communication cycle cannot always be
linearised).

Attachment to the pipeline result: `pipeline.js:124` — `const diagnostics = checkDiagramIntegrity(coordMap, lc);`
— then returned verbatim as the top-level `diagnostics` key of `runPipeline`'s result, **NOT nested
inside `validation`** (CLAUDE.md and the code both stress this: "the rule engine never sees a
coordinate" — DI is a structurally separate channel from rule-engine `validation.errors/warnings`).
The CLI (`pipeline.js:425-439`) is the only consumer that acts on it, splitting `issues` by severity
and treating any `ERROR` as an unconditional abort (independent of `--strict`), while `WARNING`s
(DI05) only abort under `--strict`.

---

## E. The existing DMN subsystem

### E10. `scripts/dmn/schema-gate.js`

Exported function: `validateDecisionCoreSchema(input)` — same shape as BPMN's
`validateLogicCoreSchema`. Full file body (33 lines):
```js
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { decisionCoreSchemaPath } from '../shared/resource-paths.js';

const schema = JSON.parse(readFileSync(decisionCoreSchemaPath(), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

export function validateDecisionCoreSchema(input) {
  const valid = validate(input);
  return {
    valid,
    errors: valid ? [] : (validate.errors || []).map(e => ({
      path: e.instancePath || '(root)',
      message: e.message,
      params: e.params,
    })),
  };
}
```
Return shape: `{ valid: boolean, errors: Array<{ path, message, params }> }`. Schema is compiled
**once at module load** (top-level, not per-call) — same pattern as `bpmn/schema-gate.js`. Path
resolution is delegated entirely to `decisionCoreSchemaPath()` from `shared/resource-paths.js`
(source-checkout-wins-over-packaged-copy logic, mirrors `inputSchemaPath()`).

### E11. `scripts/dmn/rules.js`

Exports (`export` statements found): `DMN_RULES` (array, `rules.js:58`), `DMN_MODES` (array of mode
name strings, `= Object.keys(MODES)`, `rules.js:382`), `dmnProfileForMode(baseProfile, mode='semantic')`
(`rules.js:396`), `runDmnRules(dc, opts={})` (`rules.js:426`), and a re-export `loadRuleProfile`
(`rules.js:444`, pulled through from `shared/rule-profile.js`).

Rule-object shape (identical to BPMN's `rules.js` — same fields, format-independent runner
machinery lives in `shared/rule-profile.js`):
```js
{
  id: 'D01', layer: 'soundness', defaultSeverity: 'ERROR',
  description: 'Every requirement connects two declared nodes',
  ref: { omg: 'DMN 1.3 §6.3.2', xsd: 'tDMNElementReference/@href' },
  check: (dc, cfg) => ({ pass: true } | { pass: false, message: '...' }),
}
```
Note `check` takes **two** args for DMN rules — `(dc, cfg)` — where `cfg` is the `config.json → dmn`
block (only `B02`/`B06` actually use it, for `maxRulesPerTable`/`maxDrgDepth` thresholds); BPMN's
`check(proc, lc, profile)` takes three, with a different third argument. Not a literal match — a
DMN-shaped mirror, not a copy.

`runDmnRules(dc, opts = {})` (`rules.js:426-442`):
```js
export function runDmnRules(dc, opts = {}) {
  const { profile: rawProfile = null, mode = 'semantic', config = CFG.dmn } = opts;
  const profile = dmnProfileForMode(rawProfile, mode);
  const errors = [], warnings = [], infos = [];
  for (const rule of DMN_RULES) {
    if (!isRuleEnabled(rule, profile)) continue;
    const severity = getEffectiveSeverity(rule, profile);
    if (severity === 'OFF') continue;
    const result = rule.check(dc, config);
    if (result.pass) continue;
    const line = `[${rule.id}] ${result.message}`;
    if (severity === 'ERROR') errors.push(line);
    else if (severity === 'WARNING') warnings.push(line);
    else infos.push(line);
  }
  return { errors, warnings, infos, mode };
}
```
Return shape: `{ errors: string[], warnings: string[], infos: string[], mode: string }`.
**CONTRAST with BPMN's `runRules`**: no `advisories`, no `metrics` key at all — the DMN engine has
no Optimization-layer or Workflow-Net-layer analogue yet, so its return object is a strict subset of
BPMN's `{ errors, warnings, infos, advisories, metrics }`. A `dmn/pipeline.js` that assumes
`validation.metrics`/`validation.advisories` exist (by analogy with the BPMN orchestrator) will find
them **absent** unless it adds them itself.

Mode/profile resolution: two modes only, `'semantic'` (default) and `'best-practice'`, defined in a
`MODES` lookup object (`rules.js:374-380`):
```js
const MODES = {
  semantic:        { soundness: true, semantics: true, best_practice: false },
  'best-practice': { soundness: true, semantics: true, best_practice: true },
};
```
`dmnProfileForMode(baseProfile, mode)` clones the base profile, then fills in `p.layers[layer].enabled`
**only where the profile is silent** (`if (p.layers[layer]?.enabled === undefined)`) — an explicit
profile entry always wins over the mode, mirroring BPMN's `profileForMode` precedence rule.

### E12. `references/decision-core-schema.json` — full shape

Root object — `required: ["namespace", "nodes"]`, `additionalProperties: false`:
| Property | Required | Type | Notes |
|---|---|---|---|
| `$schemaVersion` | no | string `const "1.0"` | optional version marker |
| `id` | no | string, `^[a-zA-Z_][a-zA-Z0-9_-]*$` | Definitions id |
| `name` | no | string | Definitions name; fallback emitted if absent |
| `namespace` | **yes** | string | `tDefinitions/@namespace` |
| `expressionLanguage` | no | string | defaults to FEEL |
| `documentation` | no | string | → `tDMNElement/description` |
| `nodes` | **yes** | array of `Node`, `minItems: 1` | |
| `requirements` | no | array of `Requirement` | |

`Node` — `required: ["id", "type", "name"]`, `additionalProperties: false`:
| Property | Required | Type/enum | Applies to |
|---|---|---|---|
| `id` | yes | `^[a-zA-Z_][a-zA-Z0-9_-]*$` | all |
| `type` | yes | `enum: [decision, inputData, knowledgeSource, businessKnowledgeModel]` | all (decisionService intentionally out of scope) |
| `name` | yes | string | all |
| `documentation` | no | string | all |
| `variable` | no | string | all; defaults to element name |
| `typeRef` | no | string | all |
| `question` | no | string | decision only |
| `allowedAnswers` | no | string | decision only |
| `usingTask` | no | string | decision only — BPMN Business Rule Task id |
| `usingProcess` | no | string | decision only |
| `decisionTable` | no | `DecisionTable` | decision only; mutually exclusive with `expression` |
| `expression` | no | string | decision only |
| `sourceType` | no | string | knowledgeSource only |
| `locationURI` | no | string | knowledgeSource only |
| `parameters` | no | array of `{name (required), typeRef}`, `additionalProperties:false` | businessKnowledgeModel only |
| `body` | no | string | businessKnowledgeModel only |

(Note: the "applies to" column is documentation/convention only — the schema does NOT actually
enforce type-conditional property restriction; e.g. nothing stops a `decision`-typed node schema-wise
from also carrying `sourceType`. Same permissiveness pattern as the BPMN Logic-Core schema.)

`Requirement` — `required: ["type", "source", "target"]`, `additionalProperties: false`:
| Property | Required | Type |
|---|---|---|
| `id` | no | `^[a-zA-Z_][a-zA-Z0-9_-]*$` |
| `type` | yes | `enum: [information, knowledge, authority]` |
| `source` | yes | string (node id, flow direction: required element) |
| `target` | yes | string (node id, requiring element) |

`DecisionTable` — `required: ["outputs"]`, `additionalProperties: false`:
| Property | Required | Type |
|---|---|---|
| `id` | no | `^[a-zA-Z_][a-zA-Z0-9_-]*$` |
| `hitPolicy` | no | `enum: [UNIQUE, FIRST, PRIORITY, ANY, COLLECT, "RULE ORDER", "OUTPUT ORDER"]`, defaults UNIQUE |
| `aggregation` | no | `enum: [SUM, COUNT, MIN, MAX]` |
| `preferredOrientation` | no | `enum: ["Rule-as-Row", "Rule-as-Column", "CrossTable"]` |
| `outputLabel` | no | string |
| `inputs` | no | array of `InputClause` |
| `outputs` | **yes**, `minItems: 1` | array of `OutputClause` |
| `annotations` | no | array of `{name (required)}`, `additionalProperties:false` |
| `rules` | no | array of `DecisionRule` |

`InputClause` — `required: ["expression"]`, `additionalProperties: false`: `id`, `label`,
`expression` (required), `typeRef`, `allowedValues` — all optional except `expression`.

`OutputClause` — **no required fields at all**, `additionalProperties: false`: `id`, `name`
(required only *by convention* when >1 output clause — not schema-enforced), `typeRef`,
`allowedValues`, `defaultValue`.

`DecisionRule` — `required: ["then"]`, `additionalProperties: false`: `id` (optional), `when`
(array of strings, optional — one unary test per input clause), `then` (**required**, array of
strings, `minItems: 1` — one result expression per output clause), `annotations` (array of strings,
optional).

### E13. `tests/fixtures/dmn/discount-decision.json` — content

Full file dumped verbatim above in the Read output; summary: `Definitions_discount`, namespace
`http://bpmn-generator.local/dmn/discount`. 5 nodes exercising every type: 2 `inputData`
(`in_orderValue` number, `in_customerSince` date), 1 `knowledgeSource` (`ks_discountPolicy`, with
`sourceType`/`locationURI`), 1 `businessKnowledgeModel` (`bkm_loyaltyBonus`, with `parameters` and
`body`), 2 `decision`s — `dec_discountLevel` (has a full 3-rule `decisionTable`, hit policy UNIQUE,
1 input/1 output/1 annotation column, `usingTask: "task_applyDiscount"` linking back to a BPMN
Business Rule Task) and `dec_finalPercentage` (uses `expression` instead of `decisionTable`). 5
`requirements` covering all three types: 3 `information` (2 inputData→decision, 1 decision→decision),
1 `knowledge` (bkm→decision), 1 `authority` (knowledgeSource→decision). This is the fixture
`dmn/rules.test.js` loads as `good()` and asserts produces zero errors/warnings under the default
(`semantic`) mode.

### E14. `config.json`'s `dmn` block

Verbatim:
```json
"dmn": {
  "maxRulesPerTable": 20,
  "maxDrgDepth": 5
}
```
Read in `dmn/rules.js` via `const { ..., config = CFG.dmn } = opts;` (`rules.js:427`) — i.e.
`runDmnRules`'s default for its `config` option is `CFG.dmn`, and `CFG` is the same singleton
imported from `../shared/utils.js` that the BPMN engine uses (`import { CFG } from '../shared/utils.js';`,
`rules.js:20`) — **one shared config object for both engines**, not a separate DMN config loader.
Only `B02` (`maxRulesPerTable`) and `B06` (`maxDrgDepth`) actually read these two keys, both with a
literal fallback if `cfg` is undefined (`cfg?.maxRulesPerTable ?? 20`, `cfg?.maxDrgDepth ?? 5`) — so
the config block is not load-bearing today even though it exists (the fallback constants match it
exactly).

---

## F. Conventions

### F15. `scripts/shared/utils.js`

`loadConfig(customPath)` (`utils.js:12-25`): reads `scripts/config.json` via
`JSON.parse(readFileSync(resolve(__dirname, '..', 'config.json'), 'utf8'))` as the defaults; if
`customPath` given, shallow-merges (one level deep — nested objects get `{...defaults[key], ...custom[key]}`,
everything else overwritten) a second JSON file on top. `CFG` (`utils.js:27`) is the module-level
singleton: `export const CFG = loadConfig(process.env.BPMN_CONFIG);` — evaluated once at import
time, env-var-overridable.

- `esc(s)` (`utils.js:47-50`) — XML-escapes `&`, `<`, `>`, `"` (four entities only, no `'`→`&apos;`).
  `String(s || '')` coerces falsy input to empty string first.
- `rn(n)` (`utils.js:52-54`) — `Math.round(n * 10) / 10`, i.e. rounds to **1 decimal place**. Used
  everywhere a coordinate is written into XML/SVG (`create('dc:Bounds', { x: rn(px), ... })`).
- `wrapText(text, maxChars)` (`utils.js:56-104`) — greedy word-wrap into an array of lines, with a
  `breakLongWord` sub-routine that hyphen-splits any single word longer than `maxChars`. Clamps
  `maxChars < 2` up to `2` to avoid an infinite loop. Returns `['']` for falsy `text`.
- `wrapTextByPx(text, maxPxWidth, fontSize = 11)` (`utils.js:111-115`) — converts a pixel budget to
  a char-count budget via a fixed `CHAR_WIDTH_FACTOR = 0.6` heuristic, then delegates to `wrapText`.
- `EXTENSION_NS = 'http://bpmn-generator/schema/1.0'`, `EXTENSION_PREFIX = 'bg'` (`utils.js:44-45`)
  — the project's own `extensionElements` namespace, used for data BPMN 2.0 has no attribute for
  (currently only `decisionRef` on a Business Rule Task, `bpmn-xml.js:290-294`). **Must** be created
  via `moddle.createAny(name, EXTENSION_NS, attrs)`, never by hand-setting a prefixed key in
  `$attrs` — the latter silently drops the value if the matching `xmlns:` isn't separately declared
  (logs to stderr, `warnings` stays empty, no exception). This is a documented trap (CLAUDE.md
  repeats it) directly relevant to any DMN↔BPMN cross-reference field the new code adds.

Note: `types.js`, `SHAPE`/`SW`/`CLR`/etc. constants are **not** in `shared/utils.js` — they live in
`scripts/bpmn/constants.js` (`export const SHAPE = CFG.shape; ...`), explicitly BPMN-only per that
file's own doc comment ("DMN never touches these; that is why they live here and not in
shared/utils.js, which carries only what both engines use"). A DMN visual layer will need its own
`scripts/dmn/constants.js`-equivalent (or literal shape constants) rather than importing BPMN's.

### F16. `scripts/bpmn/bpmn-xml.js` — bpmn-moddle usage

Import: `import { BpmnModdle } from 'bpmn-moddle';` (`bpmn-xml.js:9`) — named import of the class.
Instance: `const moddle = new BpmnModdle();` (`bpmn-xml.js:16`) — **one module-level singleton**,
shared by every call to `generateBpmnXml`/`validateBpmnXml` in the process (not re-instantiated per
call, unlike ELK in `layout.js`).

Element creation — two paths:
- `moddle.create(type, attrs)` — wrapped in a local one-line helper `create(type, attrs = {}) { return moddle.create(type, attrs); }`
  (`bpmn-xml.js:31-33`), used for every standard BPMN/BPMNDI/DC type (`'bpmn:Task'`,
  `'bpmndi:BPMNShape'`, `'dc:Bounds'`, `'dc:Point'`, etc.).
- `moddle.createAny(qualifiedName, namespaceUri, attrs)` — used exactly once, for the
  `bg:decisionRef` extension element (`bpmn-xml.js:291-293`):
  ```js
  const ref = moddle.createAny(`${EXTENSION_PREFIX}:decisionRef`, EXTENSION_NS, { $body: String(node.decisionRef) });
  el.extensionElements = create('bpmn:ExtensionElements', { values: [ref] });
  ```
  `createAny` is the required path for any foreign-namespace child because it carries the namespace
  URI with it; a plain `create()` call cannot express a namespace outside the BPMN/BPMNDI/DC/DI set
  moddle already knows.

Serialization to string (`bpmn-xml.js:910`):
```js
const { xml } = await moddle.toXML(definitions, { format: true, preamble: true });
return xml;
```
`toXML` is async (Promise), returns `{ xml, ... }` — only `xml` is destructured/used. `format: true`
pretty-prints; `preamble: true` emits the `<?xml version="1.0" ...?>` line.

DI → semantic element reference — **confirmed from the code**: `bpmnElement` is set to the
**element object itself**, not a string id, whenever a lookup succeeds:
```js
const flowNodeEl = allFlowNodeMaps.get(node.id);
const shapeAttrs = {
  id: `${node.id}_di`,
  bpmnElement: flowNodeEl || node.id,   // object if found, string id as last-resort fallback
  ...
};
```
(`bpmn-xml.js:587-590`, and the identical pattern at lines 568, 622, 648, 667, 704, 716, 735 for
participants, subprocess children, subprocess-internal edges, top-level edges, message flows,
associations, and lanes respectively). `allFlowNodeMaps` is a `Map<id, moddleElement>` populated by
a `registerNode(node, el)` callback threaded through every node/edge-building function
(`buildFlowNode`, the sequence-flow builder, `registerLaneRefs` for lanes at `bpmn-xml.js:914-929`).
The `|| node.id` fallback is a defensive last resort (string id, which moddle would then be unable
to resolve as an object reference) — in practice `registerNode` is called for everything that gets a
DI shape, so the fallback branch is not expected to fire in normal operation. **This confirms**: a
DMN `dmn-xml.js` mirroring this pattern should likewise build a `Map<id, moddleElement>` while
constructing semantic elements and pass the *object* (not a string) as `bpmnElement`/whatever DMNDI's
equivalent attribute is (DMNDI's `dmndi:DMNShape` uses `dmnElementRef`, per DMN 1.3's DI schema —
not yet implemented in this repo, so this is forward-looking, not confirmed against existing DMN
code).

### F17. Golden-file test convention

Example: `scripts/bpmn/pipeline.test.js`, `describe('SVG Golden-File Regression', ...)`
(`pipeline.test.js:2023-2054` and following). Pattern per fixture name in
`const goldenFixtures = ['simple-approval', 'multi-pool-collaboration', 'expanded-subprocess'];`:
```js
test(`${name}: SVG matches golden file`, async () => {
  const lc = loadFixture(`${name}.json`);
  const result = await runPipeline(lc);
  expect(result.svg).toBeDefined();
  let expected;
  try {
    expected = readFileSync(resolve(fixturesDir, `${name}.expected.svg`), 'utf8');
  } catch {
    throw new Error(`Golden file missing: tests/fixtures/${name}.expected.svg — run golden file generation first`);
  }
  expect(result.svg).toBe(expected);   // byte-exact comparison, not a snapshot/fuzzy diff
});
```
Mirrored for `.expected.bpmn` (BPMN XML) immediately after, and again for
`.refined.svg`/`.refined.bpmn` under `runPipeline(lc, { visualRefinement: true })`. Comparison is
always `expect(result.X).toBe(expected)` — exact string equality, **not** Jest's `toMatchSnapshot()`
mechanism and not a diff/tolerance comparator. A missing golden file throws a descriptive `Error`
from inside the `catch` rather than letting `readFileSync`'s raw `ENOENT` surface. `loadFixture(name)`
(`pipeline.test.js:41-43`) is `JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'))`, and
`fixturesDir = resolve(__dirname, '../../tests/fixtures')` — i.e. `tests/fixtures/` at repo root, two
levels up from `scripts/bpmn/`. Per CLAUDE.md's "React to a golden-file failure" workflow, goldens
are regenerated deliberately (never blindly) via the pipeline CLI + `cp`, and reviewed as a diff
first. The DMN fixture directory already follows the same nesting one level deeper:
`tests/fixtures/dmn/discount-decision.json` (no `.expected.*` goldens exist for DMN yet — there is no
DMN XML/SVG generator to produce them).

### F18. Jest specifics

Run command (from `package.json → scripts.test`):
```
node --experimental-vm-modules node_modules/.bin/jest --no-cache
```
No `jest.config.js`, no `babel.config.js`/`.babelrc` anywhere in the repo (`find` confirmed empty) —
native ESM support is obtained purely through the `--experimental-vm-modules` Node flag passed
directly to the `jest` binary invocation; there is no separate Jest config file to update when
adding DMN tests. `package.json` has `"type": "module"` at the top level, so every `.js` file
(including `*.test.js`) is parsed as ESM by default; no `.mjs` extension needed.

Test location/naming: co-located `*.test.js` files sitting next to the module(s) they exercise, one
per subsystem directory — `scripts/bpmn/pipeline.test.js`, `scripts/bpmn/redesign.test.js`,
`scripts/bpmn/visual-refinement.test.js`, `scripts/dmn/rules.test.js`, `scripts/shared/resource-paths.test.js`,
plus top-level ones (`scripts/http-server.test.js`, `scripts/orchestrator.test.js`, etc.). No
`__tests__/` directory anywhere. Jest's default test-match glob picks these up automatically (no
custom `testMatch` — confirmed by the absence of a jest config). Imports use `@jest/globals`
explicitly (`import { describe, test, expect } from '@jest/globals';`) rather than relying on Jest's
injected globals — consistent across every test file checked. `npm test -- --testPathPatterns=<x>`
(per CLAUDE.md) filters by filename substring, standard Jest CLI behaviour, nothing project-specific.

---

## Summary of things a naive mirror would get wrong

- `runPipeline` has **no `strict` option** — `--strict` is CLI-only logic in `main()`, applied
  *after* `runPipeline` returns, against `validation.warnings`/`diagnostics.issues`/`validation.xmlWarnings`.
  A `dmn/pipeline.js` that tries to thread `strict` through `runPipeline`'s internals is diverging
  from the mirrored shape.
- `generateSvg` is **synchronous**; `generateBpmnXml`, `runElkLayout`, and `validateBpmnXml` are
  **async**. Mixed sync/async in one pipeline, not uniform.
- `coords`/`laneCoords`/`poolCoords`/`edgeCoords`/`edgeLabels` are **plain objects, not Maps** —
  `coords[id]`, never `coords.get(id)`.
- `edgeCoords` values are **arrays of `{x,y}` points**, not `{x,y,w,h}` — a different shape from the
  other four coordMap members.
- `clipOrthogonal`'s `role` parameter (`'source'|'target'`) is accepted but not branched on in the
  function body — cosmetic, not functional.
- The reusable straight-line clip helpers (`clipToRect`, `clipStraight`) exist and are the right fit
  for DMN's straight requirement connections, but **are not currently exported** from
  `coordinates.js` — only `buildCoordinateMap, enforceOrthogonal, findNodeInAllProcesses,
  clipOrthogonal, routeMessageFlows` are exported today, so reusing them means either extending that
  export list or duplicating ~15 lines.
- `runDmnRules`'s return shape `{ errors, warnings, infos, mode }` is a **strict subset** of BPMN's
  `runRules`'s `{ errors, warnings, infos, advisories, metrics }` — no `metrics`, no `advisories`
  key exist today. A DMN pipeline orchestrator assuming `validation.metrics` is present (by analogy)
  will find it undefined unless it adds the key itself.
- BPMN's rule `check(proc, lc, profile)` takes **three** args; DMN's rule `check(dc, cfg)` takes
  **two**, and the second argument means something different (a config sub-object, not a profile).
- `ELK` is **re-instantiated per call** (`new ELK()` inside `runElkLayout`), not a module singleton —
  opposite of `bpmn-moddle`'s pattern (`new BpmnModdle()` once at module load, reused for every call).
- Shape/color/spacing constants for BPMN live in `scripts/bpmn/constants.js` (derived from `CFG`),
  explicitly **not** in `scripts/shared/utils.js` — DMN will need its own constants module, it cannot
  import BPMN's.
- `dmn/schema-gate.js` and `dmn/rules.js` already exist and already mirror the BPMN shape closely
  (confirmed byte-for-byte structurally identical for the schema gate); the new work is
  `dmn/pipeline.js`, `dmn/layout.js`, `dmn/coordinates.js`, `dmn/di-check.js`, `dmn/dmn-xml.js`,
  `dmn/svg.js` — none of which exist yet in `scripts/dmn/` (only `rules.js`, `rules.test.js`,
  `schema-gate.js` are present).

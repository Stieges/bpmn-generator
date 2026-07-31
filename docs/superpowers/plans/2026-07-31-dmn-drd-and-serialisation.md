# DMN Stages 3+4 — DRD layout and DMN 1.3 serialisation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.
>
> This plan is written to be executed **without access to the conversation that produced it**.
> Everything you need is in this file. Follow it literally. Where it says STOP, stop and report —
> do not improvise. Where it says **VERIFY:**, run the command given and branch on the real answer
> rather than assuming.

**Goal:** the generator produces a `.dmn` file — Decision-Core in, DMN 1.3 with DMNDI out, validated
against the normative XSD.

**Architecture:** six new modules under `scripts/dmn/` (constants, layout, coordinates, di-check,
dmn-xml, pipeline) plus one relocation into `scripts/shared/geometry.js`. The DMN side mirrors the
BPMN pipeline's shape — schema gate → rules → layout → coordinates → DI check → serialisation — but
is an independent pipeline over its own format. ELK positions nodes; edge geometry is computed once,
in `coordinates.js`, so the geometry contract holds.

**Tech Stack:** Node ≥20, ES Modules, Jest (`--experimental-vm-modules`), ELK (`elkjs@0.12.0`),
`dmn-moddle@12.0.1` (added in Task 4), `xmllint` (system tool, optional).

**Design spec:** [2026-07-31-dmn-drd-and-serialisation-design.md](../specs/2026-07-31-dmn-drd-and-serialisation-design.md).
You do not need to read it to execute this plan; it records why the decisions are what they are.

**Ground truth this plan was built from** — consult only if a step's fact seems wrong:
[dmn13-xsd-ground-truth.md](../research/dmn13-xsd-ground-truth.md),
[codebase-mirrors.md](../research/codebase-mirrors.md),
[dmn-external-ground-truth.md](../research/dmn-external-ground-truth.md).

---

## Global Constraints

Every task's requirements implicitly include this section.

1. **Branch `feat/dmn`.** Never touch `master`. Do not push. Do not open a PR. All six commits stay
   local.
2. **Stage explicit paths.** No `git add .`, no `git add -A` — the repo produces artifacts
   (`audit/`, `dead-letter/`, `tests/robustness-reports/`, `.superpowers/`) that must not be
   committed.
3. **No `--no-verify`.** If a hook fails, fix the cause.
4. **Repo language is English** — code, comments, documentation, commit messages. (The person who
   commissioned this plan writes German; the repository does not.)
5. **ES Modules only in committed code.** `import`/`export`, never `require()`. The package is
   `"type": "module"`, and a single `require()` in a shipped file breaks everything downstream.
   The one exception, and it is not committed: throwaway `node -e "…"` verification one-liners in
   this plan use `require()`, because `node -e` runs as CommonJS regardless of `package.json`
   (checked — it works). Do not "fix" those into `import`; do not copy the pattern into a file.
6. **One new runtime dependency, and only one:** `dmn-moddle@12.0.1`, added in Task 4. It is
   pre-approved (GATE 1 in [2026-07-30-dmn-integration.md](2026-07-30-dmn-integration.md)) — do not
   stop to ask for approval, and do not add anything else. `CLAUDE.md` otherwise forbids new
   dependencies.
7. **Coordinates are `{x, y, w, h}` — `w`/`h`, never `width`/`height`.** This holds for every
   `coordMap` entry and for `shared/geometry.js`'s arguments. `CLAUDE.md`'s Conventions section
   currently claims `{x, y, width, height}`; that is true of the emitted DI attributes and **false**
   of the internal contract, and following it produces `NaN` with no error. Task 1 corrects the
   sentence. `width`/`height` appear only where a DI attribute is written (`dc:Bounds`,
   `dc:Dimension`).
8. **`requirementKey(req)` is derived in exactly one place** — exported from
   `scripts/dmn/coordinates.js` (Task 3), imported by `scripts/dmn/dmn-xml.js` (Task 5). It is
   `req.id || \`req_${req.source}_${req.target}\``. Never re-derive it inline. A `Requirement`'s
   `id` is optional, and the two consumers must agree: `coordinates.js` keys `edgeCoords` with it,
   `dmn-xml.js` keys its element map with it *and* uses it as the requirement element's `id` when
   there is none. A divergence does not throw — the DMNDI lookup returns `undefined`, the edge is
   skipped as "no waypoints", and the diagram silently loses a connection.
9. **Where commands run:** `npm test` and `npm run docs-gate` from `scripts/`. Everything else from
   the repo root. `node .github/scripts/docs-gate.mjs` from inside `scripts/` throws
   MODULE_NOT_FOUND — use `npm run docs-gate`.
10. **Do not touch `scripts/package.json`'s `exports`.** Public entry points are Stage 7. The
    package-integrity check is scoped to exports-reachable files, so `dmn/` correctly stays outside
    it for now. Adding an entry here makes the gate start checking files this plan does not finish.
11. **A green rule run says nothing about geometry.** Check `result.diagnostics`, not just
    `validation.errors` — `CLAUDE.md`'s standing rule.
12. **Guards must be seen red.** Every test is written before the code it covers and run once to
    watch it fail. A guard that was never red is not verified. Exception: Task 6, Step 6, where new
    assertions are added against `runDmnPipeline` code that earlier steps in the same task already
    made correct — that step is explicitly confirmatory rather than red/green, and says so.

### STOP conditions

Stop, leave the tree as it is, and report:

- Any golden-file test (`.expected.bpmn` / `.expected.svg` / `.expected.dmn`) fails in a way this
  plan did not tell you to expect. **Never blindly regenerate a golden** — inspect the diff and
  decide whether the change is intended.
- Task 1's byte-diff is non-empty. A pure move cannot move a pixel.
- `npm test` totals drop below the baseline you recorded, or change in a way you cannot attribute to
  tests this plan told you to add.
- A **VERIFY:** probe returns something this plan does not cover.
- Task 5, Step 2's `$parent` probe returns outcome (b) (`$parent` bookkeeping required). Step 6's
  code is written for outcome (a) only; see Step 2 for why outcome (b) cannot be patched site-by-site.
- `npm run docs-gate` exits 2 (tooling error).

### The autonomy boundary

Stage 4's real milestone is *"the file opens in dmn-js and Camunda Modeler"*. **You cannot verify
that.** What you can prove, and what this plan's gates are, is: the XML validates against
`DMN13.xsd`, the round trip through dmn-moddle loses no field, and `xmlWarnings` is empty.

When Task 6 is done, report the path of the generated `.dmn` and stop. **Do not declare the
milestone reached on your own judgement** — opening it in a modeller is the human's step.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `scripts/shared/geometry.js` | Notation-free clipping maths: `clipStraight`, `clipToRect` | 1 (create) |
| `scripts/bpmn/coordinates.js` | Loses those two functions, imports them instead | 1 (modify) |
| `CLAUDE.md` | The `{x,y,w,h}` correction; later the architecture and key-file entries | 1, 6 |
| `scripts/config.json` | `dmn` block gains DRD shape sizes and spacing; `elk.dmn` gains the DMN layout options | 2 |
| `scripts/dmn/constants.js` | The four DRD shape sizes, spacing and edge styles, derived from `CFG.dmn` | 2 (create) |
| `scripts/dmn/layout.js` | `decisionCoreToElk`, `runDmnElkLayout` — ELK with `direction: UP` | 2 (create) |
| `scripts/dmn/coordinates.js` | `buildDmnDiagrams` (the diagram list), `requirementKey` | 3 (create) |
| `scripts/dmn/di-check.js` | `checkDmnDiagramIntegrity` — DD01, DD02, DD03 | 3 (create) |
| `scripts/package.json`, `THIRD-PARTY-NOTICES.md` | The `dmn-moddle` dependency | 4 (modify) |
| `scripts/dmn/dmn-xml.js` | `generateDmnXml`, `validateDmnXml` | 5 (create) |
| `references/decision-core-schema.json` | `usingTask`/`usingProcess` accept string or array | 5 (modify) |
| `scripts/dmn/pipeline.js` | `runDmnPipeline` + CLI | 6 (create) |
| `CHANGELOG.md`, `docs/superpowers/plans/2026-07-30-dmn-integration.md` | Documentation | 6 (modify) |

Tests live beside their module as `scripts/dmn/<name>.test.js` — Jest's default `testMatch` finds
tests in subdirectories, which `scripts/dmn/rules.test.js` already proves.

---
### Task 1: `shared/geometry.js` — move the straight-line clip, correct CLAUDE.md

**Files:**
- Create: `scripts/shared/geometry.js`
- Create: `scripts/shared/geometry.test.js`
- Modify: `scripts/bpmn/coordinates.js:6-9` (imports), `scripts/bpmn/coordinates.js:772-799` (remove the
  two function bodies, add a one-line pointer), `scripts/bpmn/coordinates.js:949-951` (add the
  boundary-rule comment after `return placed;`/`}`, before `clipOrthogonal`'s doc comment)
- Modify: `CLAUDE.md` (Conventions section, the coordinate-shape bullet)

**Interfaces:**
- Consumes: nothing from an earlier task (this is the first task).
- Produces:
  ```js
  export function clipStraight(a, b);              // a, b: {x,y,w,h}                  -> [{x,y}, {x,y}]
  export function clipToRect(from, towards, rect);  // from,towards: {x,y}; rect: {w,h} -> {x,y}
  ```
  in `scripts/shared/geometry.js`. `scripts/bpmn/coordinates.js` imports both (it already calls
  `clipStraight` for BPMN Association routing — that call site does not change). A later task
  (`scripts/dmn/coordinates.js`, not in this pair) imports the same two functions for DMN's straight
  requirement connections — do not change the signatures.

---

- [ ] **Step 1: Generate the pre-change baseline (run this before touching any file)**

Run from the repo root:

```bash
mkdir -p /tmp/geometry-move-baseline
cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts
npm test 2>&1 | tail -5
```

Note the exact printed totals (e.g. `Tests: X passed, Y total`) — Step 7 compares against this
number verbatim. Then generate the six canonical fixture outputs:

```bash
cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts
for f in simple-approval realistic-collaboration all-element-classes \
         expanded-subprocess subprocess-child-fidelity multi-pool-collaboration; do
  node bpmn/pipeline.js ../tests/fixtures/$f.json /tmp/geometry-move-baseline/$f
done
```

- [ ] **Step 2: Write the failing test for `shared/geometry.js`**

Create `scripts/shared/geometry.test.js`:

```js
import { describe, test, expect } from '@jest/globals';
import { clipStraight, clipToRect } from './geometry.js';

describe('clipToRect', () => {
  const rect = { x: 0, y: 0, w: 100, h: 50 };
  const center = { x: 50, y: 25 };

  test('horizontal ray lands on the right edge midpoint', () => {
    expect(clipToRect(center, { x: 250, y: 25 }, rect)).toEqual({ x: 100, y: 25 });
  });

  test('vertical ray lands on the bottom edge midpoint', () => {
    expect(clipToRect(center, { x: 50, y: 225 }, rect)).toEqual({ x: 50, y: 50 });
  });

  test('degenerate case (towards === from) returns from unchanged', () => {
    expect(clipToRect(center, center, rect)).toEqual({ x: 50, y: 25 });
  });
});

describe('clipStraight', () => {
  test('two same-height rectangles 300px apart clip to their facing edges', () => {
    const a = { x: 0, y: 0, w: 100, h: 50 };
    const b = { x: 300, y: 0, w: 100, h: 50 };
    expect(clipStraight(a, b)).toEqual([
      { x: 100, y: 25 },
      { x: 300, y: 25 },
    ]);
  });
});
```

Every expected value above is hand-computed against the exact function bodies being moved (see
Step 4), not invented: for `clipToRect`, `center=(50,25)`, `towards=(250,25)` gives `dx=200, dy=0`,
`halfW=50, halfH=25`, `scale=min(50/200, Infinity)=0.25`, result `(50+200*0.25, 25)=(100,25)` — the
rectangle's right-edge midpoint. The vertical case and `clipStraight` (which calls `clipToRect`
twice, once from each shape's own center) follow the same arithmetic.

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts && npm test -- --testPathPatterns=shared/geometry`

Expected: FAIL — Jest cannot resolve the import, e.g. `Cannot find module './geometry.js' from
'shared/geometry.test.js'` (exact wording depends on the Node/Jest version; the signal that matters
is a module-resolution failure, not an assertion failure — `scripts/shared/geometry.js` does not
exist yet).

- [ ] **Step 4: Create `scripts/shared/geometry.js`**

```js
/**
 * Straight-line shape clipping — shared between notations.
 *
 * Lives in shared/, not bpmn/, because a second notation (DMN's DRD) now needs it too: DMN
 * requirement connections (information/knowledge/authority) are, like a BPMN Association, unstyled
 * straight lines between two shape borders — no orthogonal routing. shared/ takes what a second
 * notation demonstrably imports, not everything that could be phrased format-independently; see
 * docs/superpowers/specs/2026-07-31-dmn-drd-and-serialisation-design.md, "Where the boundary
 * actually runs, and why it leaves pure code behind", for the full argument. The three
 * orthogonal-routing helpers (clipOrthogonal and its BPMN-shape-specific siblings) stay in
 * scripts/bpmn/coordinates.js — see the comment there for why they did not travel with these two.
 *
 * Moved verbatim from scripts/bpmn/coordinates.js (lines 777-795), where they were private. Pure
 * functions, no config, no notation knowledge — every coordinate here is `{x,y,w,h}` or `{x,y}`,
 * never `{x,y,width,height}` (that shape is DI-only; see CLAUDE.md's Conventions section).
 */

/**
 * Straight connection between two shapes, clipped to both borders.
 * Associations are drawn as straight lines in BPMN, so this is a plain
 * centre-to-centre segment cut back to where it meets each rectangle.
 */
function clipStraight(a, b) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  return [clipToRect(ac, bc, a), clipToRect(bc, ac, b)];
}

/** Move `from` (a shape centre) onto the border of `rect`, along from→towards. */
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

export { clipStraight, clipToRect };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts && npm test -- --testPathPatterns=shared/geometry`

Expected: PASS — 4 tests, all green.

- [ ] **Step 6: Modify `scripts/bpmn/coordinates.js` — import instead of define, add the boundary comment**

Replace the import block (current lines 6-9):

```js
import { isEvent, isGateway, isBoundaryEvent, isArtifact } from './types.js';
import { SHAPE, LANE_HEADER_W, LANE_PADDING, EXTERNAL_LABEL_H, POOL_GAP, MESSAGE_FLOW_FAN, ARTIFACT_GAP } from './constants.js';
import { CFG } from '../shared/utils.js';
import { identifyHappyPathNodes, resolveLaneId } from './topology.js';
```

with:

```js
import { isEvent, isGateway, isBoundaryEvent, isArtifact } from './types.js';
import { SHAPE, LANE_HEADER_W, LANE_PADDING, EXTERNAL_LABEL_H, POOL_GAP, MESSAGE_FLOW_FAN, ARTIFACT_GAP } from './constants.js';
import { CFG } from '../shared/utils.js';
import { identifyHappyPathNodes, resolveLaneId } from './topology.js';
import { clipStraight, clipToRect } from '../shared/geometry.js';
```

Then remove the two function definitions (current lines 772-796, everything from the `/**` doc
comment above `clipStraight` through the closing `}` of `clipToRect`, up to but not including
`function messageFlowKey`):

```js
/**
 * Straight connection between two shapes, clipped to both borders.
 * Associations are drawn as straight lines in BPMN, so this is a plain
 * centre-to-centre segment cut back to where it meets each rectangle.
 */
function clipStraight(a, b) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  return [clipToRect(ac, bc, a), clipToRect(bc, ac, b)];
}

/** Move `from` (a shape centre) onto the border of `rect`, along from→towards. */
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

function messageFlowKey(mf) {
```

Replace it with:

```js
// clipStraight/clipToRect moved to scripts/shared/geometry.js — a second notation (DMN's DRD)
// needs the same straight-line clip. See that file's header comment for the shared/ boundary rule.

function messageFlowKey(mf) {
```

Finally, add the pointer comment beside the orthogonal helpers. Find this text (current lines
949-962):

```js
  return placed;
}

/**
 * Orthogonal clipping: project endpoint onto shape boundary while keeping
 * the segment axis (horizontal or vertical) intact.
 *
 * @param shape   {x,y,w,h} of the actual BPMN shape
 * @param type    BPMN element type
 * @param edgePt  the endpoint to clip (start or end of the path)
 * @param nextPt  the adjacent point (determines segment direction)
 * @param role    'source' or 'target'
 */
function clipOrthogonal(shape, type, edgePt, nextPt, role) {
```

Replace it with (one new comment block inserted before the existing doc comment, nothing else
changed):

```js
  return placed;
}

// clipOrthogonal and its three helpers below (clipCircleOrthogonal, clipDiamondOrthogonal,
// clipRectOrthogonal) stay here rather than moving to shared/geometry.js with clipStraight and
// clipToRect, even though they know no more about BPMN's semantics than those two did — the
// dispatcher branches on isEvent(type)/isGateway(type), but the three helpers it dispatches to are
// themselves plain shape maths. They stay anyway: shared/ takes what a second notation
// demonstrably imports, not everything that could be phrased format-independently. DMN's
// requirement connections are straight lines (DMN 1.3 §6.2.2 prescribes arrowheads and line style,
// not routing), so DMN only ever needed the straight clip. A diamond is, in this repository, a
// BPMN gateway and nothing else — DMN has none, ArchiMate has none — so under the broader rule
// clipDiamondOrthogonal would sit in shared/ unused forever. See
// docs/superpowers/specs/2026-07-31-dmn-drd-and-serialisation-design.md, "Where the boundary
// actually runs, and why it leaves pure code behind".

/**
 * Orthogonal clipping: project endpoint onto shape boundary while keeping
 * the segment axis (horizontal or vertical) intact.
 *
 * @param shape   {x,y,w,h} of the actual BPMN shape
 * @param type    BPMN element type
 * @param edgePt  the endpoint to clip (start or end of the path)
 * @param nextPt  the adjacent point (determines segment direction)
 * @param role    'source' or 'target'
 */
function clipOrthogonal(shape, type, edgePt, nextPt, role) {
```

- [ ] **Step 7: Run the full test suite and compare totals to the Step 1 baseline**

Run: `cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts && npm test 2>&1 | tail -5`

Expected: PASS — totals **identical** to what Step 1 recorded (same number of passed/total tests,
plus the 4 new `shared/geometry.test.js` tests already counted from Step 5's run — if Step 1's
baseline was taken before Step 2 existed, the total in Step 7 will be exactly 4 higher than Step
1's; state which comparison applies when reporting).

- [ ] **Step 8: Byte-identity check against the baseline**

```bash
mkdir -p /tmp/geometry-move-after
cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts
for f in simple-approval realistic-collaboration all-element-classes \
         expanded-subprocess subprocess-child-fidelity multi-pool-collaboration; do
  node bpmn/pipeline.js ../tests/fixtures/$f.json /tmp/geometry-move-after/$f
done
diff -r /tmp/geometry-move-baseline /tmp/geometry-move-after
```

Expected: `diff -r` prints nothing (no output = no differences). A pure move cannot move a pixel —
any `.bpmn`/`.svg` difference means Step 6 changed behaviour, not just location, and must be
investigated before continuing (do not proceed to Step 9 until this is clean).

- [ ] **Step 9: Correct CLAUDE.md's coordinate-shape claim**

In `CLAUDE.md`, under `## Conventions`, replace:

```
- Coordinates always as `{ x, y, width, height }` objects
```

with:

```
- Coordinates in the internal `coordMap` contract (`{ coords, laneCoords, poolCoords, edgeCoords, edgeLabels }`, and its DMN analogue) are always `{ x, y, w, h }` — **`w`/`h`, not `width`/`height`**. Only the emitted DI attributes (`dc:Bounds`) use `width`/`height`; `bpmn-xml.js` and `svg.js` translate on the way out.
```

This line was wrong for the internal contract even before this task (`coordinates.js` has used
`w`/`h` all along — confirmed by reading the actual field names in `buildCoordinateMap`); Task 1
is the first task to correct it because DMN's own `coordMap` (built in a later task) makes the
ambiguity load-bearing for a second engine, not just BPMN's.

- [ ] **Step 10: Run the docs gate**

Run: `cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts && npm run docs-gate`

Expected: exit code `0`, 0 violations. (The CLAUDE.md edit only changes prose inside a bullet, no
path strings or numeric claims — the gate's proof checks should be unaffected.)

- [ ] **Step 11: Commit**

```bash
cd /Users/daniel.stiegler/Projects/bpmn-generator
git add scripts/shared/geometry.js scripts/shared/geometry.test.js scripts/bpmn/coordinates.js CLAUDE.md
git commit -m "$(cat <<'EOF'
refactor(shared): move clipStraight/clipToRect into shared/geometry.js

A second notation (DMN's DRD) needs the same straight-line shape clip that
BPMN's Association routing already used, so it is promoted out of
bpmn/coordinates.js into shared/geometry.js -- shared/ takes what a second
notation demonstrably imports, not everything that could be phrased
format-independently. clipOrthogonal and its three shape-specific helpers
stay in bpmn/coordinates.js; both files now carry a comment explaining the
split.

Also corrects CLAUDE.md's Conventions section: the internal coordMap
contract is {x,y,w,h}, not {x,y,width,height} -- that shape belongs to the
emitted DI attributes only.

Verified byte-identical output for the six canonical fixtures
(simple-approval, realistic-collaboration, all-element-classes,
expanded-subprocess, subprocess-child-fidelity, multi-pool-collaboration)
against the pre-move baseline; npm test totals unchanged plus 4 new tests.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
git status
```

---

### Task 2: `dmn/constants.js`, the `CFG.dmn` shape block, and `dmn/layout.js`

**Files:**
- Create: `scripts/dmn/constants.js`
- Create: `scripts/dmn/constants.test.js`
- Create: `scripts/dmn/layout.js`
- Create: `scripts/dmn/layout.test.js`
- Modify: `scripts/config.json` (append to the existing `elk` block and the existing `dmn` block —
  `maxRulesPerTable`/`maxDrgDepth` are untouched)

**Interfaces:**
- Consumes: `CFG` from `scripts/shared/utils.js` (existing, unchanged — `export const CFG =
  loadConfig(process.env.BPMN_CONFIG);`). Decision-Core node/requirement shape from
  `references/decision-core-schema.json` (existing, unchanged): `Node.type ∈ {decision, inputData,
  knowledgeSource, businessKnowledgeModel}`; `Requirement = { id?, type, source, target }`.
- Produces (consumed by a later task's `scripts/dmn/coordinates.js`, not in this pair — do not
  change these signatures):
  ```js
  export const DRD_SHAPE;    // { decision:{w,h}, inputData:{w,h}, knowledgeSource:{w,h}, businessKnowledgeModel:{w,h} }
  export const DRD_SPACING;  // { nodeNode, layerNode, margin }
  export const DRD_EDGE;     // { information:{line,marker}, knowledge:{line,marker}, authority:{line,marker} }
  export function decisionCoreToElk(dc);        // Decision-Core -> ELK graph (plain object)
  export async function runDmnElkLayout(graph); // -> laid-out ELK graph (async; new ELK() per call)
  ```
  `DRD_EDGE` is fully specified and tested in this task but has no consumer within this plan —
  DRD rendering (the module that would draw a requirement connection's line style and arrowhead) is
  Stage 6, out of scope here. This is deliberate, not a dangling loose end to chase down.

---

- [ ] **Step 1: Write the failing test for `dmn/constants.js`**

Create `scripts/dmn/constants.test.js`:

```js
import { describe, test, expect } from '@jest/globals';
import { DRD_SHAPE, DRD_SPACING, DRD_EDGE } from './constants.js';

describe('DMN DRD constants', () => {
  test('DRD_SHAPE carries the four dmn-js default shape sizes', () => {
    // Source: bpmn-io/dmn-js, packages/dmn-js-drd/src/features/modeling/ElementFactory.js —
    // DECISION_SIZE, INPUT_DATA_SIZE, KNOWLEDGE_SOURCE_SIZE, BUSINESS_KNOWLEDGE_MODEL_SIZE.
    expect(DRD_SHAPE.decision).toEqual({ w: 180, h: 80 });
    expect(DRD_SHAPE.inputData).toEqual({ w: 125, h: 45 });
    expect(DRD_SHAPE.knowledgeSource).toEqual({ w: 100, h: 63 });
    expect(DRD_SHAPE.businessKnowledgeModel).toEqual({ w: 135, h: 46 });
  });

  test('DRD_SPACING carries nodeNode, layerNode and margin', () => {
    expect(DRD_SPACING).toEqual({ nodeNode: 40, layerNode: 80, margin: 20 });
  });

  test('DRD_EDGE describes line and marker style for all three requirement types', () => {
    // Source: bpmn-io/dmn-js, packages/dmn-js-drd/src/draw/DrdRenderer.js (createMarker, and the
    // per-type line styles) — information is solid+filled-triangle, knowledge is dashed+open-chevron,
    // authority is dashed+filled-circle. DMN 1.3 §6.2.2 confirms the same three styles in prose.
    expect(Object.keys(DRD_EDGE).sort()).toEqual(['authority', 'information', 'knowledge']);
    expect(DRD_EDGE.information.line.dasharray).toBeNull();
    expect(DRD_EDGE.information.marker.filled).toBe(true);
    expect(DRD_EDGE.knowledge.line.dasharray).toBe('5');
    expect(DRD_EDGE.knowledge.marker.filled).toBe(false);
    expect(DRD_EDGE.authority.line.dasharray).toBe('5');
    expect(DRD_EDGE.authority.marker.shape).toBe('circle');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts && npm test -- --testPathPatterns=dmn/constants`

Expected: FAIL — `Cannot find module './constants.js' from 'dmn/constants.test.js'` (module
resolution failure; `scripts/dmn/constants.js` does not exist yet).

- [ ] **Step 3: Add the DRD shape/spacing/edge data to `scripts/config.json`**

In `scripts/config.json`, the existing `elk` block ends with the `rectpacking` sub-block. Replace:

```json
    "rectpacking": {
      "elk.algorithm": "rectpacking",
      "elk.rectpacking.desiredAspectRatio": "0.1",
      "elk.contentAlignment": "V_TOP H_LEFT"
    }
  },
```

with (adds a `dmn` sibling to `layered`/`rectpacking` — `elk.direction: UP` and `elk.edgeRouting:
POLYLINE`, the two facts the design spec pins for DMN's DRD layout; there is no `STRAIGHT` value in
ELK's `edgeRouting` enum, so `POLYLINE` is the correct choice, not a placeholder):

```json
    "rectpacking": {
      "elk.algorithm": "rectpacking",
      "elk.rectpacking.desiredAspectRatio": "0.1",
      "elk.contentAlignment": "V_TOP H_LEFT"
    },
    "dmn": {
      "elk.algorithm": "layered",
      "elk.direction": "UP",
      "elk.edgeRouting": "POLYLINE"
    }
  },
```

Then, at the end of the file, the existing `dmn` top-level block holds only `maxRulesPerTable` and
`maxDrgDepth`. Replace:

```json
  "dmn": {
    "maxRulesPerTable": 20,
    "maxDrgDepth": 5
  }
}
```

with (appends `shape`, `spacing`, `edge` as new siblings — `maxRulesPerTable`/`maxDrgDepth`
unchanged, still read the same way by `scripts/dmn/rules.js`'s `runDmnRules`):

```json
  "dmn": {
    "maxRulesPerTable": 20,
    "maxDrgDepth": 5,
    "shape": {
      "decision": { "w": 180, "h": 80 },
      "inputData": { "w": 125, "h": 45 },
      "knowledgeSource": { "w": 100, "h": 63 },
      "businessKnowledgeModel": { "w": 135, "h": 46 }
    },
    "spacing": {
      "nodeNode": 40,
      "layerNode": 80,
      "margin": 20
    },
    "edge": {
      "information": {
        "line": { "stroke": "#000000", "strokeWidth": 1, "dasharray": null, "linecap": "round", "linejoin": "round" },
        "marker": { "shape": "triangle", "path": "M 1 5 L 11 10 L 1 15 Z", "filled": true, "refX": 11, "refY": 10, "scale": 1 }
      },
      "knowledge": {
        "line": { "stroke": "#000000", "strokeWidth": 1, "dasharray": "5", "linecap": "round", "linejoin": "round" },
        "marker": { "shape": "chevron", "path": "M 1 3 L 11 10 L 1 17", "filled": false, "strokeWidth": 2, "refX": 11, "refY": 10, "scale": 0.8 }
      },
      "authority": {
        "line": { "stroke": "#000000", "strokeWidth": 1.5, "dasharray": "5", "linecap": "round", "linejoin": "round" },
        "marker": { "shape": "circle", "cx": 3, "cy": 3, "r": 3, "filled": true, "refX": 3, "refY": 3, "scale": 0.9 }
      }
    }
  }
}
```

The `nodeNode: 40` / `layerNode: 80` spacing values are not arbitrary: they are the exact values
used in the empirical test that confirmed `elk.direction: 'UP'` needs no y-flip (see
`docs/superpowers/research/dmn-external-ground-truth.md` §C.10/C.11), and Step 8 below re-confirms
layering behaves correctly with these exact numbers on a branching graph. `margin: 20` is a
deliberate design choice (not an external fact) mirroring `COLLAB_PADDING` (`scripts/bpmn/constants.js`,
also `20`) for the same role — outer padding around a laid-out diagram.

Validate the file is still well-formed JSON before moving on:

Run: `cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts && node -e "JSON.parse(require('fs').readFileSync('config.json','utf8')); console.log('OK')"`

Expected: prints `OK`.

- [ ] **Step 4: Create `scripts/dmn/constants.js`**

```js
/**
 * DMN-only layout constants.
 * Derived from CFG.dmn (scripts/shared/utils.js) — shape sizes, spacing and edge/marker
 * descriptors used only by the DMN DRD layout and (future) rendering. BPMN never touches
 * these; that is why they live here and not in shared/utils.js, which carries only what
 * both engines use. Mirrors scripts/bpmn/constants.js's own derive-from-CFG shape.
 */

import { CFG } from '../shared/utils.js';

export const DRD_SHAPE   = CFG.dmn.shape;
export const DRD_SPACING = CFG.dmn.spacing;
export const DRD_EDGE    = CFG.dmn.edge;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts && npm test -- --testPathPatterns=dmn/constants`

Expected: PASS — 3 tests, all green.

- [ ] **Step 6: Write the failing test for `dmn/layout.js`, including the branching-graph layer-order check**

Create `scripts/dmn/layout.test.js`:

```js
import { describe, test, expect } from '@jest/globals';
import { decisionCoreToElk, runDmnElkLayout } from './layout.js';
import { DRD_SHAPE } from './constants.js';

const chain = () => ({
  namespace: 'http://bpmn-generator.local/dmn/test',
  nodes: [
    { id: 'in1', type: 'inputData', name: 'In 1' },
    { id: 'dec1', type: 'decision', name: 'Dec 1' },
  ],
  requirements: [
    { type: 'information', source: 'in1', target: 'dec1' },
  ],
});

// A diamond, not a chain: two independent branches (Left/Right), each fed by two
// inputData nodes, both merging into one top-level decision. Every inputData node
// is exactly two requirement-hops from dTop via a path of the SAME length, which
// is what makes the layer assignment unambiguous (see the test below for why).
const diamond = () => ({
  namespace: 'http://bpmn-generator.local/dmn/test',
  nodes: [
    { id: 'inA', type: 'inputData', name: 'In A' },
    { id: 'inB', type: 'inputData', name: 'In B' },
    { id: 'inC', type: 'inputData', name: 'In C' },
    { id: 'inD', type: 'inputData', name: 'In D' },
    { id: 'dLeft',  type: 'decision', name: 'Left' },
    { id: 'dRight', type: 'decision', name: 'Right' },
    { id: 'dTop',   type: 'decision', name: 'Top' },
  ],
  requirements: [
    { type: 'information', source: 'inA', target: 'dLeft' },
    { type: 'information', source: 'inB', target: 'dLeft' },
    { type: 'information', source: 'inC', target: 'dRight' },
    { type: 'information', source: 'inD', target: 'dRight' },
    { type: 'information', source: 'dLeft',  target: 'dTop' },
    { type: 'information', source: 'dRight', target: 'dTop' },
  ],
});

describe('decisionCoreToElk', () => {
  test('sizes each node from DRD_SHAPE and builds one ELK edge per requirement', () => {
    const graph = decisionCoreToElk(chain());
    expect(graph.children).toEqual([
      { id: 'in1', width: DRD_SHAPE.inputData.w, height: DRD_SHAPE.inputData.h },
      { id: 'dec1', width: DRD_SHAPE.decision.w, height: DRD_SHAPE.decision.h },
    ]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ sources: ['in1'], targets: ['dec1'] });
  });

  test('sets direction UP and POLYLINE routing — no STRAIGHT value exists in the ELK enum', () => {
    const graph = decisionCoreToElk(chain());
    expect(graph.properties['elk.direction']).toBe('UP');
    expect(graph.properties['elk.edgeRouting']).toBe('POLYLINE');
  });
});

describe('runDmnElkLayout — layer order on a branching graph', () => {
  test('input data sits at the largest y, the top-level decision at the smallest y, on a diamond DRG (not just a chain)', async () => {
    // Re-verifies elk.direction: 'UP' beyond the original 3-node chain check (which cannot
    // distinguish "layer order is correct" from "there happened to be only one node per layer").
    // Empirically confirmed against this project's installed elkjs@0.12.0 with this exact graph and
    // these exact spacing/padding options (nodeNode: 40, layerNode: 80, elk.padding: 20 on every
    // side, per DRD_SPACING.margin): inA/inB/inC/inD all land at y=349.375, dLeft/dRight both at
    // y=186.75, dTop alone at y=20 (the top padding). The assertions below check the relationships
    // (ties and strict ordering) rather than hardcoding those pixel values, since the exact numbers
    // are free to shift with spacing/version changes while the ordering must not.
    const graph = decisionCoreToElk(diamond());
    const laidOut = await runDmnElkLayout(graph);
    const y = Object.fromEntries(laidOut.children.map(c => [c.id, c.y]));

    // All four input data nodes are two requirement-hops from dTop via equal-length paths, so
    // their layer is unambiguous: they must tie for the maximum y. (A layering algorithm is free
    // to place an in-degree-0 node anywhere between layer 0 and one layer before its target when
    // path lengths differ across sources — equal path lengths remove that freedom entirely.)
    expect(y.inA).toBe(y.inB);
    expect(y.inB).toBe(y.inC);
    expect(y.inC).toBe(y.inD);

    // The two intermediate decisions are symmetric siblings — same layer as each other.
    expect(y.dLeft).toBe(y.dRight);

    // Strict descent along every requirement edge: source above target in y (larger y = lower on
    // screen = earlier in the dependency chain, confirmed empirically for elk.direction: 'UP').
    expect(y.inA).toBeGreaterThan(y.dLeft);
    expect(y.dLeft).toBeGreaterThan(y.dTop);

    // dTop is the sink of the whole graph — nothing requires it — so it holds the global minimum
    // y; every input data node holds the global maximum.
    const allY = Object.values(y);
    expect(y.dTop).toBe(Math.min(...allY));
    expect(y.inA).toBe(Math.max(...allY));
  });
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts && npm test -- --testPathPatterns=dmn/layout`

Expected: FAIL — `Cannot find module './layout.js' from 'dmn/layout.test.js'` (module resolution
failure; `scripts/dmn/layout.js` does not exist yet).

- [ ] **Step 8: Create `scripts/dmn/layout.js`**

```js
/**
 * DMN Layout — Decision-Core → ELK Graph → laid-out graph.
 *
 * Structurally mirrors scripts/bpmn/layout.js (same ELK bootstrap: the bundled build, the
 * 'properties' key for layout options, a new ELK() instance per call) but the shape is different —
 * a DRD is a flat DAG with no lanes or pools, laid out top-to-bottom by dependency direction
 * (elk.direction: 'UP') rather than left-to-right by process flow.
 */

import ELK from 'elkjs/lib/elk.bundled.js';
import { CFG } from '../shared/utils.js';
import { DRD_SHAPE, DRD_SPACING } from './constants.js';

/**
 * Decision-Core → ELK graph (plain object, not yet laid out).
 *
 * Requirement edges point source -> target exactly as Decision-Core declares them (the required
 * element is the source, the requiring element the target). Under elk.direction: 'UP' this places
 * the source (e.g. an InputData) at the larger y and the target (e.g. the Decision that requires
 * it) at the smaller y, with no y-flip needed on this module's side — confirmed empirically against
 * this project's installed elkjs, both for a 3-node chain and for a branching graph (see
 * docs/superpowers/research/dmn-external-ground-truth.md §C.10 and layout.test.js).
 *
 * @param {object} dc - Decision-Core JSON
 * @returns {object} ELK graph
 */
function decisionCoreToElk(dc) {
  const nodes = dc.nodes ?? [];
  const requirements = dc.requirements ?? [];

  return {
    id: 'root',
    properties: {
      ...CFG.elk.dmn,
      'elk.spacing.nodeNode': `${DRD_SPACING.nodeNode}`,
      'elk.layered.spacing.nodeNodeBetweenLayers': `${DRD_SPACING.layerNode}`,
      'elk.padding': `[top=${DRD_SPACING.margin},left=${DRD_SPACING.margin},bottom=${DRD_SPACING.margin},right=${DRD_SPACING.margin}]`,
    },
    children: nodes.map(n => {
      const sz = DRD_SHAPE[n.type] || DRD_SHAPE.decision;
      return { id: n.id, width: sz.w, height: sz.h };
    }),
    // `r.id || `req_${i}`` is deliberately a DIFFERENT fallback formula from Global Constraint 8's
    // requirementKey (`req.id || `req_${req.source}_${req.target}``, defined later in Task 3's
    // coordinates.js and used to key edgeCoords/the DMNDI element map). That divergence would be
    // exactly the #36-shaped bug Constraint 8 exists to prevent if anything downstream joined on
    // this id — nothing does. ELK's own edge routes (`result.edges[].sections`) are discarded by
    // runDmnElkLayout's caller (see that function's doc comment); this id only has to be unique
    // within one ELK graph for ELK's internal bookkeeping, never compared against requirementKey's
    // output. Do not "fix" this to import requirementKey — coordinates.js does not exist yet at
    // this point in the plan, and layout.js must not depend on it either way (Task 3 depends on
    // Task 2, not the reverse).
    edges: requirements.map((r, i) => ({
      id: r.id || `req_${i}`,
      sources: [r.source],
      targets: [r.target],
    })),
  };
}

/**
 * Run ELK layout on a Decision-Core-derived graph. A new ELK() instance per call, mirroring
 * scripts/bpmn/layout.js's runElkLayout.
 *
 * ELK's own edge routes (`result.edges[].sections`) are NOT used downstream — DMN requirement
 * connections are drawn as straight lines, clipped to each shape's border by
 * scripts/shared/geometry.js's clipStraight in a later task's dmn/coordinates.js, not as ELK's
 * routed polylines. Only the node positions (`result.children[].x/y/width/height`) matter to this
 * pipeline; the caller is expected to discard `result.edges`.
 *
 * @param {object} graph - ELK graph, e.g. from decisionCoreToElk()
 * @returns {Promise<object>} laid-out ELK graph
 */
async function runDmnElkLayout(graph) {
  const elk = new ELK();
  return elk.layout(graph);
}

export { decisionCoreToElk, runDmnElkLayout };
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts && npm test -- --testPathPatterns=dmn/layout`

Expected: PASS — 3 tests, all green, including the branching-graph layer-order test.

- [ ] **Step 10: Run the full test suite**

Run: `cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts && npm test 2>&1 | tail -5`

Expected: PASS — Task 1's totals (Step 7 of Task 1) plus 6 new tests (3 in `dmn/constants.test.js`,
3 in `dmn/layout.test.js`). No BPMN fixture output is touched by this task (`dmn/` files are new,
`config.json`'s BPMN-relevant keys — `shape`, `strokeWidth`, `color`, `layout`, `elk.layered`,
`elk.rectpacking`, `visualRefinement`, `optimization` — are all unchanged), so this task carries no
byte-identity risk for the six BPMN fixtures and does not need Task 1's diff step repeated.

- [ ] **Step 11: Run the docs gate**

Run: `cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts && npm run docs-gate`

Expected: exit code `0`, 0 violations. Nothing in this task touches a documented numeric claim, a
doc path string, or the HTTP/MCP contract — `scripts/dmn/constants.js` and `scripts/dmn/layout.js`
are not yet part of `package.json`'s `exports` map (Stage 7, out of scope here), so the
package-integrity check does not need to reach them.

- [ ] **Step 12: Commit**

```bash
cd /Users/daniel.stiegler/Projects/bpmn-generator
git add scripts/config.json scripts/dmn/constants.js scripts/dmn/constants.test.js scripts/dmn/layout.js scripts/dmn/layout.test.js
git commit -m "$(cat <<'EOF'
feat(dmn): add DRD constants and ELK layout (decisionCoreToElk, runDmnElkLayout)

scripts/dmn/constants.js mirrors scripts/bpmn/constants.js: it derives shape
sizes, spacing and edge/marker descriptors from a new CFG.dmn.{shape,spacing,edge}
block in config.json (maxRulesPerTable/maxDrgDepth untouched), using the four
dmn-js default DRD shape sizes (Decision 180x80, InputData 125x45,
KnowledgeSource 100x63, BusinessKnowledgeModel 135x46).

scripts/dmn/layout.js adds decisionCoreToElk(dc) and runDmnElkLayout(graph),
structurally mirroring bpmn/layout.js's ELK bootstrap. elk.direction: 'UP'
needs no y-flip (confirmed empirically, now on a branching diamond DRG as
well as the original 3-node chain -- both give the same ordering: input
data at the largest y, the top-level decision at the smallest y).
elk.edgeRouting: 'POLYLINE' is used deliberately, not 'STRAIGHT' -- that
value does not exist in ELK's edgeRouting enum and would have fallen back
silently. ELK's own edge routes are discarded; requirement-connection
geometry is computed once, downstream, by shared/geometry.js's clipStraight.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
git status
```
### Task 3: `scripts/dmn/coordinates.js` and `scripts/dmn/di-check.js`

**Files:**
- Create: `scripts/dmn/coordinates.js`
- Create: `scripts/dmn/coordinates.test.js`
- Create: `scripts/dmn/di-check.js`
- Create: `scripts/dmn/di-check.test.js`

**Interfaces:**
- Consumes (from Task 1, `scripts/shared/geometry.js` — see Task 1 above):
  ```js
  export function clipStraight(a, b);              // a,b: {x,y,w,h}          -> [{x,y}, {x,y}]
  export function clipToRect(from, towards, rect);  // from,towards: {x,y}; rect: {w,h} -> {x,y}
  ```
  This task uses only `clipStraight`.
- Consumes (from Task 2, `scripts/dmn/constants.js` — see Task 2 above):
  ```js
  export const DRD_SPACING;  // { nodeNode: 40, layerNode: 80, margin: 20 }
  ```
  This task uses only `DRD_SPACING.margin` (today's value: `20`).
- Consumes (from Task 2, `scripts/dmn/layout.js` — confirmed existing, same source): the shape of
  `runDmnElkLayout(graph)`'s return value. Task 2's own implementation is
  `async function runDmnElkLayout(graph) { const elk = new ELK(); return elk.layout(graph); }` —
  i.e. the **raw, unmodified** `elkjs` result (no post-processing, unlike BPMN's
  `stackCollaborationVertically`). `decisionCoreToElk`'s `children` are flat (one entry per DRG
  node, no compound/grouping construct — DMN's `decisionService` is out of scope), so the laid-out
  graph is flat too: `{ id: 'root', children: [ { id, x, y, width, height, ... }, ... ], edges: [...] }`.
  This task reads only `laidOutGraph.children`; `edges` is discarded, matching Task 2's own doc
  comment ("the caller is expected to discard `result.edges`") and the design spec ("ELK's edge
  routes are discarded — edge geometry is computed once, in coordinates.js").
- Produces (consumed by Task 5's `dmn/dmn-xml.js` and Task 6's `dmn/pipeline.js` — do not change
  these signatures):
  ```js
  export function buildDmnDiagrams(dc, laidOutGraph);
  // -> [ { id, name, size: {w,h}, coordMap: { coords, edgeCoords } } ]
  //    coords[nodeId]    = {x,y,w,h}
  //    edgeCoords[reqId] = [ {x,y}, {x,y} ]   (exactly two points: straight, clipped both ends)
  //    NO edgeLabels member — DMN requirements carry no name.

  export function checkDmnDiagramIntegrity(diagrams);
  // -> { ok, issues: [ { code, severity, message, elementId } ] }
  //    codes: DD01 overlapping shapes | DD02 shape outside diagram bounds | DD03 edge endpoint not on its shape
  //    all severity 'ERROR'; ok === (no ERROR)
  ```
  `checkDmnDiagramIntegrity` takes exactly one argument, matching the interface contract verbatim
  — it does **not** grow a second `opts`/`tolerance` parameter the way `bpmn/di-check.js` has one;
  tolerance is a fixed internal constant (see Step 7).

Two design points this task decides, since the interface contract fixes shapes but not every
internal detail:

1. **`buildDmnDiagrams` anchors the diagram canvas at `(0,0)`.** `DMNDiagram.size` is a
   `dc:Dimension` — width/height only, no `x`/`y` (`dmn-external-ground-truth.md` §A.3). A canvas
   with no declared origin only means something if the diagram's shapes are known to sit inside
   `[0, size.w] × [0, size.h]`. `buildDmnDiagrams` therefore shifts every node's raw ELK position by
   a constant `(dx, dy)` so the bounding box of all shapes, expanded by `DRD_SPACING.margin` on
   every side, starts at `(0,0)`. Without this shift the canvas origin would be wherever ELK
   happened to start (frequently a small positive offset — `dmn-external-ground-truth.md` §C.10/C.12
   shows ELK returning positions like `x=12`), and `checkDmnDiagramIntegrity`'s DD02 would then fire
   on every well-formed diagram. This mirrors the padding convention `COLLAB_PADDING` already uses
   in `scripts/bpmn/constants.js` (`elk.padding` applied identically on all four sides, so the total
   added to width/height is `2×` the padding value — confirmed by reading `scripts/bpmn/layout.js:207`
   and `scripts/config.json`'s `collabPadding: 20`).
2. **`checkDmnDiagramIntegrity` only receives `diagrams`, not the Decision-Core**, so DD03 cannot
   know which shape is a given requirement's source vs. target. It checks the weaker but still sound
   invariant that both of a straight edge's two endpoints touch *some* shape's boundary — exactly
   what a correct clip must produce, and exactly what breaks if the clip maths (or the id used to key
   `edgeCoords`) is wrong.

Rectangle clipping (`decision` nodes, and the approximation used for the other three types below) is
exact — reused verbatim from `shared/geometry.js`. `inputData` (dmn-js: rounded rect, `rx=22` on a
125×45 box — `dmn-external-ground-truth.md` §B.7), `knowledgeSource` (wavy bottom, two Bézier curves)
and `businessKnowledgeModel` (two clipped corners, hexagon) are all approximated by their **bounding
rectangle**, via the same `clipStraight`/`clipToRect` used for `decision`. This is a deliberate
choice, not a shortcut: dmn-js's own connection cropping does not use per-shape closed-form geometry
at all — it renders each shape to an SVG path and crops against that path generically via the
`path-intersection` npm package (`dmn-external-ground-truth.md` §B.9's closing note), which is a new
runtime dependency this project is not taking on for one clip refinement. A rectangle approximation
is therefore not "less correct than the reference renderer" so much as "the cheaper of two
approximations neither of which is dmn-js's own per-shape closed-form path" — and the visible error
is small: `inputData`'s `rx=22` on a 45px-tall box rounds off at most 22px of a corner that a straight
requirement line rarely approaches exactly head-on. Research section D also derives an exact stadium
formula (D.13(b), with a corrected "always take the `+` root" sign fix for the cap-circle
intersection) and an exact clipped-corner polygon formula (D.13(c), the concrete 6-vertex
`businessKnowledgeModel` case) — **neither is used here**, by this same choice; they are not wrong,
just not the approximation this task takes.

---

- [ ] **Step 1: Write the failing test for `dmn/coordinates.js`**

Create `scripts/dmn/coordinates.test.js`:

```js
import { describe, test, expect } from '@jest/globals';

import { buildDmnDiagrams } from './coordinates.js';

describe('buildDmnDiagrams — hand-computed clip maths', () => {
  test('a straight requirement between a 180×80 decision and a 125×45 input data clips to the exact intersection on both borders', () => {
    // Raw ELK positions (before buildDmnDiagrams anchors the canvas at (0,0)):
    //   dec_A (Decision, 180×80)   at (0, 0)       -> centre (90, 40)
    //   in_B  (InputData, 125×45)  at (57.5, -82.5) -> centre (120, -60)
    // Requirement: in_B (source, required) -> dec_A (target, requiring).
    //
    // Direction dec_A-centre -> in_B-centre: d = (30, -100). This is the exact
    // worked example in dmn-external-ground-truth.md §D.13(a):
    //   halfW=90, halfH=40, tx=90/30=3, ty=40/100=0.4, t=min(3,0.4)=0.4
    //   point = centre + d*t = (90+12, 40-40) = (102, 0)   <- on dec_A's TOP edge
    // Direction in_B-centre -> dec_A-centre: d = (-30, 100).
    //   halfW=62.5, halfH=22.5, tx=62.5/30≈2.083, ty=22.5/100=0.225, t=0.225
    //   point = centre + d*t = (120-6.75, -60+22.5) = (113.25, -37.5)  <- on in_B's BOTTOM edge
    // Both values independently confirmed by executing clipStraight/clipToRect
    // (scripts/shared/geometry.js) against these exact numbers.
    //
    // buildDmnDiagrams then anchors the canvas at (0,0):
    //   minX = min(0, 57.5) = 0        -> dx = margin - 0 = 20
    //   minY = min(0, -82.5) = -82.5   -> dy = margin - (-82.5) = 20 + 82.5 = 102.5
    // (margin = DRD_SPACING.margin = 20, scripts/dmn/constants.js — confirmed by
    // scripts/dmn/constants.test.js's own literal assertion.)
    // Every coordinate below — node positions and clipped edge points alike —
    // shifts by this same (dx, dy) = (20, 102.5); translation does not change
    // the direction between two shapes, only where the result lands.
    const dc = {
      id: 'Definitions_clip', name: 'Clip check', namespace: 'urn:test',
      nodes: [
        { id: 'dec_A', type: 'decision', name: 'A' },
        { id: 'in_B', type: 'inputData', name: 'B' },
      ],
      requirements: [
        { id: 'req_1', type: 'information', source: 'in_B', target: 'dec_A' },
      ],
    };
    const laidOutGraph = {
      id: 'root',
      children: [
        { id: 'dec_A', x: 0, y: 0, width: 180, height: 80 },
        { id: 'in_B', x: 57.5, y: -82.5, width: 125, height: 45 },
      ],
    };

    const diagrams = buildDmnDiagrams(dc, laidOutGraph);
    expect(diagrams).toHaveLength(1);
    const { coordMap, size } = diagrams[0];

    expect(coordMap.coords.dec_A).toEqual({ x: 20, y: 102.5, w: 180, h: 80 });
    expect(coordMap.coords.in_B).toEqual({ x: 77.5, y: 20, w: 125, h: 45 });

    expect(coordMap.edgeCoords.req_1).toEqual([
      { x: 133.25, y: 65 },    // 113.25+20, -37.5+102.5 — on in_B's border (source)
      { x: 122, y: 102.5 },    // 102+20, 0+102.5        — on dec_A's border (target)
    ]);

    // Bounding box: width = 182.5 - 0 = 182.5, height = 80 - (-82.5) = 162.5.
    // size = bbox + 2×margin on each axis = 182.5+40, 162.5+40.
    expect(size).toEqual({ w: 222.5, h: 202.5 });
    expect(coordMap).not.toHaveProperty('edgeLabels');
  });
});

describe('buildDmnDiagrams — degenerate inputs', () => {
  test('zero nodes: empty coords/edgeCoords, size is exactly 2×margin on each axis', () => {
    const dc = { id: 'Definitions_empty', name: 'Empty', namespace: 'urn:test', nodes: [] };
    const laidOutGraph = { id: 'root', children: [] };
    const diagrams = buildDmnDiagrams(dc, laidOutGraph);
    expect(diagrams).toHaveLength(1);
    expect(diagrams[0].coordMap.coords).toEqual({});
    expect(diagrams[0].coordMap.edgeCoords).toEqual({});
    expect(diagrams[0].size).toEqual({ w: 40, h: 40 });
  });

  test('a single node: no edges, size equals the node itself plus 2×margin on each axis', () => {
    const dc = {
      id: 'Definitions_solo', name: 'Solo', namespace: 'urn:test',
      nodes: [{ id: 'dec_solo', type: 'decision', name: 'Solo' }],
    };
    const laidOutGraph = { id: 'root', children: [{ id: 'dec_solo', x: 40, y: 25, width: 180, height: 80 }] };
    const diagrams = buildDmnDiagrams(dc, laidOutGraph);
    const { coordMap, size } = diagrams[0];
    expect(Object.keys(coordMap.coords)).toEqual(['dec_solo']);
    expect(coordMap.edgeCoords).toEqual({});
    // bbox = the node itself, 180×80. dx = 20-40 = -20, dy = 20-25 = -5.
    expect(coordMap.coords.dec_solo).toEqual({ x: 20, y: 20, w: 180, h: 80 });
    expect(size).toEqual({ w: 220, h: 120 });
  });

  test('an isolated node (no requirements touching it) still contributes to the bounding box and gets no edge', () => {
    const dc = {
      id: 'Definitions_isolated', name: 'Isolated', namespace: 'urn:test',
      nodes: [
        { id: 'dec_A', type: 'decision', name: 'A' },
        { id: 'in_B', type: 'inputData', name: 'B' },
        { id: 'ks_C', type: 'knowledgeSource', name: 'C (isolated)' },
      ],
      requirements: [
        { id: 'req_1', type: 'information', source: 'in_B', target: 'dec_A' },
        // ks_C has no requirement at all.
      ],
    };
    const laidOutGraph = {
      id: 'root',
      children: [
        { id: 'dec_A', x: 0, y: 0, width: 180, height: 80 },
        { id: 'in_B', x: 300, y: 0, width: 125, height: 45 },
        { id: 'ks_C', x: 600, y: 200, width: 100, height: 63 },
      ],
    };
    const diagrams = buildDmnDiagrams(dc, laidOutGraph);
    const { coordMap, size } = diagrams[0];
    expect(Object.keys(coordMap.coords).sort()).toEqual(['dec_A', 'in_B', 'ks_C']);
    expect(Object.keys(coordMap.edgeCoords)).toEqual(['req_1']);
    expect(coordMap.edgeCoords.req_1).toHaveLength(2);
    // ks_C alone pushes the bounding box out to maxX=700, maxY=263:
    // minX=0, minY=0, maxX=max(180,425,700)=700, maxY=max(80,45,263)=263.
    // dx = 20-0 = 20, dy = 20-0 = 20.
    expect(coordMap.coords.ks_C).toEqual({ x: 620, y: 220, w: 100, h: 63 });
    expect(size).toEqual({ w: 740, h: 303 });
  });
});

describe('buildDmnDiagrams — every node/requirement kind from the reference fixture', () => {
  test('all 5 node types and all 3 requirement types produce a coordinate for every node and an edge for every requirement', () => {
    // Mirrors tests/fixtures/dmn/discount-decision.json's node/requirement shape
    // (not the file itself — that fixture carries decisionTable content this
    // module never reads; only ids/types/requirements matter here). Positions
    // are a hand-placed grid, not run through ELK — Task 6's pipeline test is
    // where the real decisionCoreToElk/runDmnElkLayout wiring gets exercised.
    const dc = {
      id: 'Definitions_discount', name: 'Discount decision', namespace: 'urn:test',
      nodes: [
        { id: 'in_orderValue', type: 'inputData', name: 'Order value' },
        { id: 'in_customerSince', type: 'inputData', name: 'Customer since' },
        { id: 'ks_discountPolicy', type: 'knowledgeSource', name: 'Discount policy' },
        { id: 'bkm_loyaltyBonus', type: 'businessKnowledgeModel', name: 'Loyalty bonus' },
        { id: 'dec_discountLevel', type: 'decision', name: 'Discount level' },
        { id: 'dec_finalPercentage', type: 'decision', name: 'Final percentage' },
      ],
      requirements: [
        { id: 'ir_1', type: 'information', source: 'in_orderValue', target: 'dec_discountLevel' },
        { id: 'ir_2', type: 'information', source: 'dec_discountLevel', target: 'dec_finalPercentage' },
        { id: 'ir_3', type: 'information', source: 'in_customerSince', target: 'dec_finalPercentage' },
        { id: 'kr_1', type: 'knowledge', source: 'bkm_loyaltyBonus', target: 'dec_finalPercentage' },
        { id: 'ar_1', type: 'authority', source: 'ks_discountPolicy', target: 'dec_discountLevel' },
      ],
    };
    const laidOutGraph = {
      id: 'root',
      children: [
        { id: 'in_orderValue', x: 0, y: 400, width: 125, height: 45 },
        { id: 'in_customerSince', x: 200, y: 400, width: 125, height: 45 },
        { id: 'ks_discountPolicy', x: 400, y: 400, width: 100, height: 63 },
        { id: 'bkm_loyaltyBonus', x: 600, y: 400, width: 135, height: 46 },
        { id: 'dec_discountLevel', x: 0, y: 200, width: 180, height: 80 },
        { id: 'dec_finalPercentage', x: 300, y: 0, width: 180, height: 80 },
      ],
    };

    const diagrams = buildDmnDiagrams(dc, laidOutGraph);
    expect(diagrams).toHaveLength(1);
    const { coordMap } = diagrams[0];
    expect(Object.keys(coordMap.coords).sort()).toEqual(dc.nodes.map(n => n.id).sort());
    expect(Object.keys(coordMap.edgeCoords).sort()).toEqual(['ar_1', 'ir_1', 'ir_2', 'ir_3', 'kr_1']);
    for (const pts of Object.values(coordMap.edgeCoords)) {
      expect(pts).toHaveLength(2);
      for (const p of pts) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
      }
    }
    expect(coordMap).not.toHaveProperty('edgeLabels');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts && npm test -- --testPathPatterns=dmn/coordinates`

Expected: FAIL — `Cannot find module './coordinates.js' from 'dmn/coordinates.test.js'` (module
resolution failure; `scripts/dmn/coordinates.js` does not exist yet).

- [ ] **Step 3: Create `scripts/dmn/coordinates.js`**

```js
/**
 * DMN Coordinates — laid-out ELK graph -> diagram list.
 *
 * DMNDI's DMNDiagram is maxOccurs="unbounded" (DMN 1.3 §6.2.4 builds partial
 * views on a DRD), so the return shape is always a LIST even though today it
 * holds exactly one entry: the whole Decision-Core laid out as a single
 * diagram. There is no `views` input yet — when one exists, this function
 * grows a loop, not a rewrite.
 *
 * Requirement edges are straight two-point segments (DMN 1.3 §6.2.2 and every
 * DRD tool draw them straight, never orthogonal — dmn-external-ground-truth.md
 * §B.9), clipped at both ends against the source and target shape's outline
 * via `clipStraight` from `../shared/geometry.js`.
 *
 * Rectangle clipping is exact (`clipToRect`, used for `decision` nodes and,
 * as a deliberate approximation, for the other three node types too):
 * `inputData` (dmn-js: rounded rect, rx=22 on a 125x45 box), `knowledgeSource`
 * (wavy bottom) and `businessKnowledgeModel` (two clipped corners) are all
 * approximated by their bounding rectangle. This matches what dmn-js's own
 * connection cropping effectively does — it crops against a generic rendered
 * SVG path (the `path-intersection` package), not a per-shape closed-form
 * formula, and pulling that dependency in for one clip refinement is not
 * worth it. See the design spec / plan for the two exact formulas (stadium,
 * clipped-corner hexagon) this deliberately does not use.
 *
 * buildDmnDiagrams also anchors the diagram canvas at (0,0): every shape is
 * shifted by a constant (dx, dy) so the bounding box of all shapes, expanded
 * by DRD_SPACING.margin on every side, starts at the origin. `size` (a
 * dc:Dimension: width/height only, no x/y) only means something if the
 * shapes are known to live inside [0,size.w] x [0,size.h] — without this
 * shift the canvas origin would be wherever ELK happened to start, and
 * di-check.js's DD02 would fire on every well-formed diagram.
 */

import { clipStraight } from '../shared/geometry.js';
import { DRD_SPACING } from './constants.js';

/**
 * The one place a requirement's identity is derived. `id` is optional on a Requirement
 * (references/decision-core-schema.json), so a deterministic fallback is needed — and it must be
 * derived in exactly ONE place, because two consumers depend on it agreeing:
 *
 *   - this module keys `edgeCoords` with it,
 *   - `dmn-xml.js` keys its requirement element map with it AND uses it as the element's `id`
 *     when the requirement carries none.
 *
 * A divergence between the two does not throw. The DMNDI writer's lookup returns undefined, the
 * edge is skipped as "no waypoints", and the diagram silently loses a connection. Mirrors
 * `messageFlowKey` in `bpmn/coordinates.js` (`mf.id || 'mf_' + ...`), prefix and all.
 *
 * @param {{id?: string, source: string, target: string}} req
 * @returns {string}
 */
export function requirementKey(req) {
  return req.id || `req_${req.source}_${req.target}`;
}

/**
 * @param {object} dc - Decision-Core JSON (only `name` and `requirements` are read)
 * @param {object} laidOutGraph - result of runDmnElkLayout: { children: [{ id, x, y, width, height }, ...] }
 * @returns {[{ id: string, name: string, size: {w:number,h:number}, coordMap: { coords: object, edgeCoords: object } }]}
 */
export function buildDmnDiagrams(dc, laidOutGraph) {
  const margin = DRD_SPACING.margin;

  const rawCoords = {};
  for (const child of (laidOutGraph?.children || [])) {
    rawCoords[child.id] = { x: child.x || 0, y: child.y || 0, w: child.width, h: child.height };
  }

  const ids = Object.keys(rawCoords);
  let minX = 0, minY = 0, maxX = 0, maxY = 0;
  if (ids.length > 0) {
    minX = Math.min(...ids.map(id => rawCoords[id].x));
    minY = Math.min(...ids.map(id => rawCoords[id].y));
    maxX = Math.max(...ids.map(id => rawCoords[id].x + rawCoords[id].w));
    maxY = Math.max(...ids.map(id => rawCoords[id].y + rawCoords[id].h));
  }

  const dx = margin - minX;
  const dy = margin - minY;

  const coords = {};
  for (const id of ids) {
    const c = rawCoords[id];
    coords[id] = { x: c.x + dx, y: c.y + dy, w: c.w, h: c.h };
  }

  const edgeCoords = {};
  for (const req of (dc.requirements || [])) {
    const a = coords[req.source];
    const b = coords[req.target];
    if (!a || !b) continue; // dangling reference — D01 reports this upstream; stay defensive here
    edgeCoords[requirementKey(req)] = clipStraight(a, b);
  }

  const size = { w: (maxX - minX) + 2 * margin, h: (maxY - minY) + 2 * margin };

  return [{
    id: 'DMNDiagram_1',
    name: dc.name || '',
    size,
    coordMap: { coords, edgeCoords },
  }];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts && npm test -- --testPathPatterns=dmn/coordinates`

Expected: PASS — 5 tests, all green.

- [ ] **Step 5: Write the failing test for `dmn/di-check.js`**

Create `scripts/dmn/di-check.test.js`:

```js
import { describe, test, expect } from '@jest/globals';

import { checkDmnDiagramIntegrity } from './di-check.js';
import { buildDmnDiagrams } from './coordinates.js';

describe('checkDmnDiagramIntegrity — ok semantics', () => {
  test('no diagrams: ok true, no issues', () => {
    expect(checkDmnDiagramIntegrity([])).toEqual({ ok: true, issues: [] });
  });

  test('a clean single-shape diagram: ok true, no issues', () => {
    const diagrams = [{
      id: 'DMNDiagram_1', name: '', size: { w: 300, h: 200 },
      coordMap: { coords: { dec_A: { x: 60, y: 60, w: 180, h: 80 } }, edgeCoords: {} },
    }];
    expect(checkDmnDiagramIntegrity(diagrams)).toEqual({ ok: true, issues: [] });
  });
});

describe('checkDmnDiagramIntegrity — one firing test per code', () => {
  test('DD01: two shapes that overlap', () => {
    const diagrams = [{
      id: 'DMNDiagram_1', name: '', size: { w: 300, h: 200 },
      coordMap: {
        coords: {
          a: { x: 0, y: 0, w: 100, h: 50 },
          b: { x: 50, y: 0, w: 100, h: 50 },
        },
        edgeCoords: {},
      },
    }];
    const result = checkDmnDiagramIntegrity(diagrams);
    expect(result.ok).toBe(false);
    // Overlap: w = min(100,150)-max(0,50)-1 = 49; h = min(50,50)-max(0,0)-1 = 49 -> 49*49 = 2401 px².
    expect(result.issues).toEqual([{
      code: 'DD01', severity: 'ERROR',
      message: "Shapes \"a\" and \"b\" overlap by 2401 px² in diagram \"DMNDiagram_1\".",
      elementId: 'a,b',
    }]);
  });

  test("DD02: a shape outside the diagram's declared bounds", () => {
    const diagrams = [{
      id: 'DMNDiagram_1', name: '', size: { w: 100, h: 100 },
      coordMap: {
        coords: { far: { x: 150, y: 10, w: 50, h: 50 } },
        edgeCoords: {},
      },
    }];
    const result = checkDmnDiagramIntegrity(diagrams);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{
      code: 'DD02', severity: 'ERROR',
      message: "Shape \"far\" lies outside diagram \"DMNDiagram_1\"'s bounds (100×100).",
      elementId: 'far',
    }]);
  });

  test("DD03: an edge endpoint that does not sit on any shape's boundary", () => {
    const diagrams = [{
      id: 'DMNDiagram_1', name: '', size: { w: 300, h: 300 },
      coordMap: {
        coords: { dec_T: { x: 0, y: 0, w: 180, h: 80 } },
        // point 0 sits exactly on dec_T's left edge (x=0, within its y-range);
        // point 1 floats in space, touching nothing.
        edgeCoords: { req_x: [{ x: 0, y: 40 }, { x: 200, y: 200 }] },
      },
    }];
    const result = checkDmnDiagramIntegrity(diagrams);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{
      code: 'DD03', severity: 'ERROR',
      message: "Requirement \"req_x\" has an endpoint that does not sit on any shape's boundary in diagram \"DMNDiagram_1\".",
      elementId: 'req_x',
    }]);
  });
});

describe('checkDmnDiagramIntegrity — a fourth code was deliberately dropped', () => {
  test('only DD01, DD02, DD03 ever appear — no DD04', () => {
    // Guards against a code silently reappearing; see the design spec's
    // "Three codes, not four" decision. Two identical, fully overlapping,
    // oversized shapes trip both remaining shape-level codes at once.
    const diagrams = [{
      id: 'DMNDiagram_1', name: '', size: { w: 10, h: 10 },
      coordMap: {
        coords: { a: { x: 0, y: 0, w: 20, h: 20 }, b: { x: 0, y: 0, w: 20, h: 20 } },
        edgeCoords: {},
      },
    }];
    const result = checkDmnDiagramIntegrity(diagrams);
    expect(result.issues.length).toBeGreaterThan(0);
    for (const issue of result.issues) {
      expect(['DD01', 'DD02', 'DD03']).toContain(issue.code);
    }
  });
});

describe('checkDmnDiagramIntegrity — multi-diagram generality', () => {
  test("two hand-built diagrams: each is checked against its own bounds, not the other's", () => {
    // The schema has no multi-view input yet (DMNDiagram is maxOccurs="unbounded"
    // in the DMNDI XSD, but nothing produces more than one today) — built by
    // hand to prove the per-diagram loop actually scopes correctly, not just
    // that it runs once.
    const diagrams = [
      {
        id: 'D1', name: 'First', size: { w: 300, h: 300 },
        coordMap: { coords: { a: { x: 10, y: 10, w: 50, h: 50 } }, edgeCoords: {} },
      },
      {
        id: 'D2', name: 'Second', size: { w: 300, h: 300 },
        coordMap: { coords: { b: { x: 400, y: 10, w: 50, h: 50 } }, edgeCoords: {} },
      },
    ];
    const result = checkDmnDiagramIntegrity(diagrams);
    expect(result.ok).toBe(false);
    // Only D2's shape is out of bounds; D1's shape must not be flagged, and
    // D2's shape must not be checked against D1's (larger) bounds either.
    expect(result.issues).toEqual([{
      code: 'DD02', severity: 'ERROR',
      message: "Shape \"b\" lies outside diagram \"D2\"'s bounds (300×300).",
      elementId: 'b',
    }]);
  });
});

describe('checkDmnDiagramIntegrity — wired to buildDmnDiagrams', () => {
  test('a well-formed diagram built by buildDmnDiagrams reports no diagnostics', () => {
    const dc = {
      id: 'Definitions_wired', name: 'Wired', namespace: 'urn:test',
      nodes: [
        { id: 'dec_A', type: 'decision', name: 'A' },
        { id: 'in_B', type: 'inputData', name: 'B' },
      ],
      requirements: [
        { id: 'req_1', type: 'information', source: 'in_B', target: 'dec_A' },
      ],
    };
    const laidOutGraph = {
      id: 'root',
      children: [
        { id: 'dec_A', x: 0, y: 0, width: 180, height: 80 },
        { id: 'in_B', x: 300, y: 0, width: 125, height: 45 },
      ],
    };
    const diagrams = buildDmnDiagrams(dc, laidOutGraph);
    expect(checkDmnDiagramIntegrity(diagrams)).toEqual({ ok: true, issues: [] });
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts && npm test -- --testPathPatterns=dmn/di-check`

Expected: FAIL — `Cannot find module './di-check.js' from 'dmn/di-check.test.js'` (module resolution
failure; `scripts/dmn/di-check.js` does not exist yet). `buildDmnDiagrams` itself resolves fine
(Step 3 already made it exist), so this is purely the missing `di-check.js` import.

- [ ] **Step 7: Create `scripts/dmn/di-check.js`**

```js
/**
 * DMN DRD Integrity Check — post-layout geometry pass, mirroring
 * scripts/bpmn/di-check.js's role and result shape for a DRD instead of a
 * BPMN diagram. Own code namespace (DD01-DD03) so the two can appear side by
 * side in one API response.
 *
 * Three codes, not four: a fourth ("two shapes at an identical position",
 * BPMN's DI01) was drafted and dropped — no DRD layout observed so far
 * produces that specific defect without also tripping DD01 (overlap), so a
 * code nobody can name a trigger for was not added. Do not reintroduce one.
 *
 * Deliberately does NOT import from scripts/bpmn/di-check.js: dmn/ importing
 * from bpmn/ would reintroduce exactly the asymmetry the modular restructure
 * removed. overlapArea/contains below are format-agnostic and could in
 * principle live in shared/, but shared/ takes what a second notation
 * demonstrably imports, not everything that could be phrased that way — so
 * they stay local until a third notation actually needs them (the same rule
 * scripts/shared/geometry.js's header comment states for clipStraight/clipToRect).
 *
 * Findings are diagnostics, not rule violations: they belong in
 * result.diagnostics, never in result.validation (Task 6 wires this up).
 */

const DEFAULT_TOLERANCE = 1;

/**
 * @param {Array<{ id: string, name: string, size: {w:number,h:number}, coordMap: { coords: object, edgeCoords: object } }>} diagrams
 * @returns {{ ok: boolean, issues: Array<{ code: string, severity: string, message: string, elementId: string }> }}
 */
export function checkDmnDiagramIntegrity(diagrams) {
  const list = diagrams || [];
  const issues = [];

  for (const diagram of list) {
    const { coords = {}, edgeCoords = {} } = diagram.coordMap || {};
    const shapes = Object.entries(coords).map(([id, c]) => ({ id, ...c }));

    // DD01 — overlapping shapes.
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        const a = shapes[i], b = shapes[j];
        const ov = overlapArea(a, b, DEFAULT_TOLERANCE);
        if (ov > 0) {
          issues.push({
            code: 'DD01',
            severity: 'ERROR',
            message: `Shapes "${a.id}" and "${b.id}" overlap by ${Math.round(ov)} px² in diagram "${diagram.id}".`,
            elementId: `${a.id},${b.id}`,
          });
        }
      }
    }

    // DD02 — a shape outside the diagram's declared canvas. `size` (a
    // dc:Dimension: width/height only, no x/y) anchors the canvas at (0,0);
    // buildDmnDiagrams shifts every shape to make that true for its own
    // output — this check does not assume that, it independently verifies it.
    const bounds = { x: 0, y: 0, w: diagram.size?.w ?? 0, h: diagram.size?.h ?? 0 };
    for (const s of shapes) {
      if (!contains(bounds, s, DEFAULT_TOLERANCE)) {
        issues.push({
          code: 'DD02',
          severity: 'ERROR',
          message: `Shape "${s.id}" lies outside diagram "${diagram.id}"'s bounds (${bounds.w}×${bounds.h}).`,
          elementId: s.id,
        });
      }
    }

    // DD03 — an edge endpoint that does not sit on any shape's boundary.
    // checkDmnDiagramIntegrity only receives the diagram, not the
    // Decision-Core, so it cannot know which shape is a given requirement's
    // source/target specifically — it checks the weaker but still sound
    // invariant that both of a straight edge's endpoints touch *some*
    // shape's border, which is exactly what a correct clip must produce.
    for (const [reqId, pts] of Object.entries(edgeCoords)) {
      if (!Array.isArray(pts) || pts.length < 2) continue;
      const endpoints = [pts[0], pts[pts.length - 1]];
      const allOnSomeShape = endpoints.every(p => shapes.some(s => onBoundary(s, p, DEFAULT_TOLERANCE)));
      if (!allOnSomeShape) {
        issues.push({
          code: 'DD03',
          severity: 'ERROR',
          message: `Requirement "${reqId}" has an endpoint that does not sit on any shape's boundary in diagram "${diagram.id}".`,
          elementId: reqId,
        });
      }
    }
  }

  return { ok: !issues.some(i => i.severity === 'ERROR'), issues };
}

function overlapArea(a, b, tol) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) - tol;
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) - tol;
  return w > 0 && h > 0 ? w * h : 0;
}

function contains(outer, inner, tol) {
  return inner.x >= outer.x - tol
      && inner.y >= outer.y - tol
      && inner.x + inner.w <= outer.x + outer.w + tol
      && inner.y + inner.h <= outer.y + outer.h + tol;
}

function onBoundary(shape, p, tol) {
  const withinX = p.x >= shape.x - tol && p.x <= shape.x + shape.w + tol;
  const withinY = p.y >= shape.y - tol && p.y <= shape.y + shape.h + tol;
  if (!withinX || !withinY) return false;
  const onVerticalEdge = Math.abs(p.x - shape.x) <= tol || Math.abs(p.x - (shape.x + shape.w)) <= tol;
  const onHorizontalEdge = Math.abs(p.y - shape.y) <= tol || Math.abs(p.y - (shape.y + shape.h)) <= tol;
  return onVerticalEdge || onHorizontalEdge;
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts && npm test -- --testPathPatterns=dmn/di-check`

Expected: PASS — 8 tests, all green (2 ok-semantics + 3 one-per-code + 1 fourth-code-dropped + 1
multi-diagram + 1 wired-to-buildDmnDiagrams).

- [ ] **Step 9: Run the full test suite**

Run: `cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts && npm test 2>&1 | tail -5`

Expected: PASS — Task 2's totals (Step 10 of Task 2) plus 13 new tests (5 in
`dmn/coordinates.test.js`, 8 in `dmn/di-check.test.js`). No BPMN file, no `config.json` key, and no
existing DMN file (`schema-gate.js`, `rules.js`) is touched by this task, so there is no
byte-identity risk to re-check.

- [ ] **Step 10: Run the docs gate**

Run: `cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts && npm run docs-gate`

Expected: exit code `0`, 0 violations. This task adds no documented numeric claim, no new doc path
string, and no HTTP/MCP contract change. Its own DI-style codes (`DD01`-`DD03`) are **not** covered
by the docs gate's `DI0\d` check in `.github/scripts/docs-gate.mjs` (that regex only matches BPMN's
`DI0\d` codes) — confirmed by reading the gate's `gatherNumberInputs`/`checkNumbers` functions, which
read `scripts/bpmn/di-check.js` specifically, never `scripts/dmn/di-check.js`. Documenting the DD
codes in `references/api-reference.md` is Task 6's job (it lands with the rest of the DMN pipeline
documentation refresh, per the design spec's commit-cut table), not this task's.

- [ ] **Step 11: Commit**

```bash
cd /Users/daniel.stiegler/Projects/bpmn-generator
git add scripts/dmn/coordinates.js scripts/dmn/coordinates.test.js scripts/dmn/di-check.js scripts/dmn/di-check.test.js
git commit -m "$(cat <<'EOF'
feat(dmn): add DRD coordinate mapping and diagram integrity check

scripts/dmn/coordinates.js adds buildDmnDiagrams(dc, laidOutGraph), turning
a laid-out ELK graph into the diagram LIST DMNDI's DMNDiagram (maxOccurs
unbounded) calls for -- one entry today. Requirement edges are straight,
clipped at both ends via shared/geometry.js's clipStraight/clipToRect
(Task 1). decision nodes clip exactly against a rectangle; inputData,
knowledgeSource and businessKnowledgeModel are approximated by their
bounding rectangle, matching what dmn-js's own connection cropping
effectively does (generic SVG path intersection, not per-shape closed-form
maths) without pulling in that dependency. The diagram canvas is anchored
at (0,0) -- every shape shifts by a constant offset so DMNDI's size
(width/height only, no x/y) means something concrete.

scripts/dmn/di-check.js adds checkDmnDiagramIntegrity(diagrams), mirroring
bpmn/di-check.js's role and result shape with its own code namespace:
DD01 overlapping shapes, DD02 shape outside diagram bounds, DD03 edge
endpoint not on any shape's boundary. All ERROR; a fourth code (BPMN's
DI01 analogue) was considered and dropped, since no DRD layout defect
seen so far needs it. Deliberately does not import from bpmn/di-check.js,
keeping the same shared/-boundary discipline Task 1 established.

Clip maths verified against dmn-external-ground-truth.md section D's
hand-worked example (a 180x80 decision, a 125x45 input data, exact
intersection coordinates on both borders) and independently re-run before
writing this commit. Covers zero/single/isolated-node degenerate inputs,
a hand-built two-diagram input to prove the DD-check loop is not
unverified single-entry generality, and one firing test per DD code.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
git status
```
### Task 4: `dmn-moddle@12.0.1` as a runtime dependency

This is its own task because a supply-chain change carries its own policy and its own gate and
must not be buried in a 400-line serialiser diff (Task 5).

**Pre-approved — do not stop to ask.** GATE 1 in `docs/superpowers/plans/2026-07-30-dmn-integration.md`
already resolved this: *"✅ GATE 1 — new runtime dependency: APPROVED (2026-07-30). `dmn-moddle@12.0.1`
(MIT, bpmn-io) is taken as a runtime dependency."* CLAUDE.md's "No new runtime dependencies without
prior discussion" rule is satisfied by that approval. Proceed without asking.

**Files:**
- Modify: `scripts/package.json`
- Modify: `THIRD-PARTY-NOTICES.md`
- Modify: `CLAUDE.md` (two lines only: the Conventions "Runtime deps" count and the Do NOT "Current deps" list — nothing else in CLAUDE.md belongs to this task, the DMN architecture/module-count updates are Task 6's)
- Create: `scripts/dmn/dmn-moddle.smoke.test.js`
- Test: `scripts/dmn/dmn-moddle.smoke.test.js`

**Interfaces:**
- Consumes: nothing from earlier tasks (this is the first of the three).
- Produces: the npm package `dmn-moddle`, resolvable via `import { DmnModdle } from 'dmn-moddle';`,
  for Task 5's `scripts/dmn/dmn-xml.js`.

- [ ] **Step 1: Verify the "identical dependencies" claim for real, against what is actually installed**

The research (`docs/superpowers/research/dmn-external-ground-truth.md` §A.1) found
`dmn-moddle@12.0.1`'s three dependencies (`moddle@^8.0.0`, `min-dash@^5.0.0`, `moddle-xml@^12.0.0`)
identical to `bpmn-moddle@10.0.0`'s, but flagged one open question: whether the *actually resolved*
`bpmn-moddle` in this repo's lockfile is exactly `10.0.0` or a newer `10.x` with different sub-ranges.
Resolve it now, from `scripts/`:

```bash
cd scripts
node -e "console.log(require('./node_modules/bpmn-moddle/package.json').version, JSON.stringify(require('./node_modules/bpmn-moddle/package.json').dependencies))"
npm view dmn-moddle@12.0.1 dependencies --json
```

Expected: the first command prints `10.0.0 {"min-dash":"^5.0.0","moddle":"^8.0.0","moddle-xml":"^12.0.0"}`
and the second prints `{"moddle":"^8.0.0","min-dash":"^5.0.0","moddle-xml":"^12.0.0"}` — the same
three package names and the same three semver ranges, order aside. If either differs from this, the
"no new subtree" claim in GATE 1 no longer holds exactly — stop and report the discrepancy rather
than proceeding on the assumption that it still does.

- [ ] **Step 2: Write the failing smoke test**

This is the dependency's own regression guard: it pins the exact API shape the research doc verified
by running the library (not by reading its docs), using the library's own committed test as the body
— `bpmn-io/dmn-moddle`, `test/spec/xml/write.js`, describe block `'di'`, test `'dmn:Decision'`. If a
future `dmn-moddle` bump changes this behaviour, this test is what notices.

Create `scripts/dmn/dmn-moddle.smoke.test.js`:

```js
import { describe, test, expect } from '@jest/globals';
import { DmnModdle } from 'dmn-moddle';

describe('dmn-moddle dependency', () => {
  test('resolves and builds+serialises a minimal Decision with DMNDI (bpmn-io/dmn-moddle own test/spec/xml/write.js, "dmn:Decision")', async () => {
    const moddle = new DmnModdle();

    const definitions = moddle.create('dmn:Definitions');
    const decision = moddle.create('dmn:Decision', { id: 'Decision_1', name: 'Decision_1' });
    definitions.get('drgElement').push(decision);

    const bounds = moddle.create('dc:Bounds', { height: 80, width: 180, x: 100, y: 100 });
    const shape = moddle.create('dmndi:DMNShape', { id: 'DMNShape_1', bounds, dmnElementRef: decision });
    const dmnDiagram = moddle.create('dmndi:DMNDiagram', { id: 'DMNDiagram_1', diagramElements: [shape] });
    const dmnDI = moddle.create('dmndi:DMNDI', { diagrams: [dmnDiagram] });
    definitions.set('dmnDI', dmnDI);

    const { xml } = await moddle.toXML(definitions, { preamble: false });

    // dmnElementRef resolved to the referenced element's own id, not a bare string we
    // passed in — confirms the isReference:true behaviour Task 5 depends on
    // (dmn-external-ground-truth.md §A.4, gotcha 1).
    expect(xml).toContain('<dmndi:DMNShape id="DMNShape_1" dmnElementRef="Decision_1">');
    expect(xml).toContain('<dmn:decision id="Decision_1" name="Decision_1" />');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd scripts && npm test -- --testPathPatterns=dmn-moddle.smoke`
Expected: FAIL — `Cannot find package 'dmn-moddle' imported from .../scripts/dmn/dmn-moddle.smoke.test.js`
(or equivalent Jest/Node module-resolution error). `dmn-moddle` is not installed yet; this is the
whole point of the test failing here.

- [ ] **Step 4: Install the dependency**

```bash
cd scripts
npm install dmn-moddle@12.0.1
```

This updates `scripts/package.json`'s `dependencies` block and `scripts/package-lock.json`. No
`.npmrc` sets `save-exact` in this repo, so npm's default save-prefix (`^`) applies — confirm the
written line reads `"dmn-moddle": "^12.0.1",` (`git diff scripts/package.json`), inserted
alphabetically between `"bpmn-moddle"` and `"elkjs"`:

```json
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "ajv": "^8.20.0",
    "ajv-formats": "^3.0.1",
    "bpmn-moddle": "^10.0.0",
    "dmn-moddle": "^12.0.1",
    "elkjs": "^0.12.0"
  },
```

If npm did not place it there, edit `scripts/package.json` directly to match the block above.

- [ ] **Step 5: Confirm the dependency tree actually deduped — no second subtree**

```bash
cd scripts
npm ls moddle min-dash moddle-xml
```

Expected: each of the three packages appears exactly once (a single resolved version shared by both
`bpmn-moddle` and `dmn-moddle`), not twice at different versions. This is the empirical confirmation
of "no new subtree" — Step 1 verified the *ranges* are compatible; this step verifies npm actually
*resolved* them to one copy rather than nesting a second one because of some other constraint
elsewhere in the tree. If a duplicate does appear, report it — do not silently accept a bigger
supply-chain footprint than GATE 1 approved.

- [ ] **Step 6: Run the smoke test again — see it pass**

Run: `cd scripts && npm test -- --testPathPatterns=dmn-moddle.smoke`
Expected: PASS, 1 test.

- [ ] **Step 7: Run the dependency-audit gate**

```bash
cd scripts
node ../.github/scripts/dep-audit-gate.mjs
```

Baseline (before this task, already true today): `0 violations, 0 warnings, 3 accepted`, listing
`@hono/node-server`/`@modelcontextprotocol/sdk` (moderate, exception
`mcp-sdk-http-transport-dead-code-2026-07`) and `brace-expansion` (high, exception
`dev-brace-expansion-redos-2026-07`). Read `scripts/dep-audit-gate.test.js` and
`.github/scripts/dep-audit-gate.mjs` before this step if the shape of that output is unclear — the
gate runs `npm audit --json --package-lock-only` against `scripts/` and evaluates findings against
`.github/dependency-policy.json`; it does not read `package.json`'s dependency list directly, only
`npm audit`'s report, so this step is the actual test of whether the new dependency is clean.

**Expected after this task: still `0 violations`.** `moddle`/`min-dash`/`moddle-xml` are already
audited today (they are `bpmn-moddle`'s existing dependencies) and Step 5 confirmed no new versions
of them were introduced, so no new advisory surface is expected.

**If this reports a violation:** STOP. Do not fabricate a `.github/dependency-policy.json` exception
to make it pass — every exception requires a `reason`, `whyNotFixed`, `reviewTrigger` and a bounded
`expires` date (`REQUIRED_EXCEPTION_FIELDS` in `dep-audit-gate.mjs`), none of which can be honestly
written by an agent that has not investigated the actual advisory. Report the exact violation output
instead and treat GATE 1 as needing re-review before this task can complete.

- [ ] **Step 8: Update `THIRD-PARTY-NOTICES.md`**

Insert a new entry immediately after the existing `bpmn-moddle` entry (same section, same format),
so the two `*-moddle` packages sit next to each other:

```markdown
### dmn-moddle — DMN 1.3 Meta-Model for JavaScript

- **Version:** 12.0.1
- **License:** MIT
- **Copyright:** Copyright (c) 2014 camunda Services GmbH
- **Repository:** https://github.com/bpmn-io/dmn-moddle
- **Usage:** CMOF-based DMN 1.3 XML serialization and parsing, symmetric to bpmn-moddle on the DMN side
```

And add a row to the License Compatibility table (after the `bpmn-moddle` row):

```markdown
| dmn-moddle | MIT | Yes | Permissive |
```

- [ ] **Step 9: Update CLAUDE.md's two dependency-list lines**

In the `## Conventions` section, change:

```
- Runtime deps (5): `elkjs`, `bpmn-moddle`, `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats`. Dev deps: `jest`, `@jest/globals`, `bpmn-auto-layout`. No new deps without prior discussion.
```
to:
```
- Runtime deps (6): `elkjs`, `bpmn-moddle`, `dmn-moddle`, `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats`. Dev deps: `jest`, `@jest/globals`, `bpmn-auto-layout`. No new deps without prior discussion.
```

In the `## Do NOT` section, change:

```
- **No new runtime dependencies without prior discussion.** Current deps: `elkjs`, `bpmn-moddle`, `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats` (`ajv` + `ajv-formats` added in v3.3 for the JSON Schema strict-gate). Each was a deliberate choice. Adding another widens the threat surface and the supply-chain risk — propose it before installing.
```
to:
```
- **No new runtime dependencies without prior discussion.** Current deps: `elkjs`, `bpmn-moddle`, `dmn-moddle`, `@modelcontextprotocol/sdk`, `ajv`, `ajv-formats` (`ajv` + `ajv-formats` added in v3.3 for the JSON Schema strict-gate; `dmn-moddle` added for DMN 1.3 XML serialisation — GATE 1 in `docs/superpowers/plans/2026-07-30-dmn-integration.md`, its three transitive dependencies identical to already-installed `bpmn-moddle`'s). Each was a deliberate choice. Adding another widens the threat surface and the supply-chain risk — propose it before installing.
```

These are the *only* two CLAUDE.md edits in this task. Do not touch the Architecture tree, Key Files
table, or DMN rule-engine section — those are Task 6's.

- [ ] **Step 10: Run the docs gate**

```bash
cd scripts
npm run docs-gate
```

Expected: exit `0`. THIRD-PARTY-NOTICES.md is one of the files the doc-paths proof check scans
(`docs-gate.mjs`, `gatherDocPathInputs`), and `REPO_PATH_RE` matches a `scripts/...`-shaped token
anywhere in the prose, including inside backticks or parentheses (`cleanDocPathToken` only strips
trailing punctuation, not the surrounding markup) — Step 8's entry above was written without a
`scripts/dmn/dmn-xml.js` cross-reference for exactly this reason: that file does not exist until
Task 5, and naming it here would fail the gate now. Do not add it back.

- [ ] **Step 11: Run the full test suite**

Run: `cd scripts && npm test`
Expected: all tests pass, including the new smoke test and every pre-existing test (nothing about
this task touches pipeline code).

- [ ] **Step 12: Commit**

```bash
git add scripts/package.json scripts/package-lock.json scripts/dmn/dmn-moddle.smoke.test.js THIRD-PARTY-NOTICES.md CLAUDE.md
git commit -m "$(cat <<'EOF'
build(dmn): add dmn-moddle@12.0.1 as a runtime dependency

Symmetric to bpmn-moddle on the DMN side (scripts/dmn/dmn-xml.js, Task 5).
Pre-approved via GATE 1 in docs/superpowers/plans/2026-07-30-dmn-integration.md:
dmn-moddle's three transitive dependencies (moddle, min-dash, moddle-xml) are
identical in name and semver range to bpmn-moddle's already-installed ones,
confirmed against the resolved lockfile version, not just the published
manifest — no new dependency subtree. dep-audit-gate and docs-gate stay green.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `scripts/dmn/dmn-xml.js`

**Files:**
- Modify: `references/decision-core-schema.json` (the `usingTask`/`usingProcess` additive schema change, Step 1)
- Create: `scripts/dmn/dmn-xml.js`
- Create: `scripts/dmn/dmn-xml.test.js`
- Create: `tests/fixtures/dmn/README.md`

**Interfaces:**
- Consumes:
  - `rn` from `../shared/utils.js` (rounds a coordinate to 1 decimal place — `Math.round(n*10)/10`, used for every `dc:Bounds`/`dc:Point` attribute, exactly as `bpmn-xml.js` uses it).
  - The diagram-list shape Task 3's `scripts/dmn/coordinates.js` produces (per the interface contract):
    `[{ id, name, size: {w,h}, coordMap: { coords, edgeCoords } }]`, where `coords[nodeId] = {x,y,w,h}`
    and `edgeCoords[requirementKey(req)] = [{x,y},{x,y}]`.
  - `requirementKey(req)` from `./coordinates.js` (Task 3) — `req.id || \`req_${req.source}_${req.target}\``.
    **Import it, never re-derive it.** See Global Constraint 8.
  - `dmn-moddle`'s `DmnModdle` (Task 4).
- Produces (for Task 6):
  ```js
  export async function generateDmnXml(dc, diagrams); // -> XML string
  export async function validateDmnXml(xml);          // -> { warnings: [...] }
  ```

**Before writing any code — two facts this task must measure, not assume.** Both are called out
explicitly in the design (`docs/superpowers/specs/2026-07-31-dmn-drd-and-serialisation-design.md`,
"Verification and the autonomy boundary", point "Measured, not assumed") and in the research
(`dmn13-xsd-ground-truth.md` §D8, `dmn-external-ground-truth.md` §A.4 gotcha 5). Steps 2 and 3 below
resolve them with real probes *before* Step 4 writes the implementation that depends on the answers —
do not skip ahead and guess.

- [ ] **Step 1: Schema change — `usingTask`/`usingProcess` accept a string or an array**

Failing test first. Add to `scripts/dmn/rules.test.js`'s schema-gate `describe` block (or a new
`describe` in the same file — either is fine, this is additive):

```js
  test('usingTask accepts an array, not only a single string (DMN13.xsd: 0..unbounded)', () => {
    const dc = good();
    dc.nodes[4].usingTask = ['task_applyDiscount', 'task_reviewDiscount'];
    expect(validateDecisionCoreSchema(dc)).toMatchObject({ valid: true, errors: [] });
  });
```

Run: `cd scripts && npm test -- --testPathPatterns=dmn/rules`
Expected: FAIL — the current schema types `usingTask` as `{ "type": "string" }`, so an array value
is rejected (`errors` non-empty, `valid: false`).

Now edit `references/decision-core-schema.json`. Change:

```json
        "usingTask": {
          "type": "string",
          "description": "decision only — id of the BPMN Business Rule Task this decision serves. The OMG-standard direction of the BPMN<->DMN link (tDecision/usingTask); the BPMN side carries the mirror in extensionElements because BPMN 2.0 defines no attribute for it"
        },
        "usingProcess": { "type": "string", "description": "decision only — id of the BPMN process this decision serves" },
```
to:
```json
        "usingTask": {
          "oneOf": [
            { "type": "string" },
            { "type": "array", "items": { "type": "string" }, "minItems": 1 }
          ],
          "description": "decision only — id(s) of the BPMN Business Rule Task(s) this decision serves. The OMG-standard direction of the BPMN<->DMN link (tDecision/usingTask, 0..unbounded); the BPMN side carries the mirror in extensionElements because BPMN 2.0 defines no attribute for it. A single string covers the common one-task case; an array covers the XSD's unbounded cardinality"
        },
        "usingProcess": {
          "oneOf": [
            { "type": "string" },
            { "type": "array", "items": { "type": "string" }, "minItems": 1 }
          ],
          "description": "decision only — id(s) of the BPMN process(es) this decision serves (tDecision/usingProcess, 0..unbounded)"
        },
```

Run the test again: `cd scripts && npm test -- --testPathPatterns=dmn/rules`
Expected: PASS. Also re-run the full DMN test file to confirm nothing else regressed (the existing
fixture still uses a bare string for `usingTask`, which `oneOf`'s first branch still accepts).

- [ ] **Step 2: VERIFY probe — is `$parent` bookkeeping actually required for correct `toXML` output?**

`dmn-external-ground-truth.md` §A.4 gotcha 5 found that dmn-moddle's own test suite always sets
`.$parent` by hand on every object it builds outside of `fromXML`, but explicitly could not confirm
whether *omitting* it produces wrong output or just untested-but-fine output — "treat as required
until proven otherwise." `scripts/bpmn/bpmn-xml.js` (the pattern this task otherwise mirrors) never
sets `$parent` anywhere and produces golden-file-tested, XSD-adjacent-valid BPMN XML. Resolve the
contradiction empirically before writing 200+ lines either with or without this bookkeeping
scattered through them.

Run this from `scripts/`, after Task 4's install:

```bash
cd scripts
node -e "
import('dmn-moddle').then(async ({ DmnModdle }) => {
  const moddle = new DmnModdle();
  const definitions = moddle.create('dmn:Definitions', { id: 'D_1', name: 'D_1', namespace: 'http://x' });
  const decision = moddle.create('dmn:Decision', { id: 'Decision_1', name: 'Decision_1' });
  const table = moddle.create('dmn:DecisionTable', { id: 'Table_1', hitPolicy: 'UNIQUE' });
  const input = moddle.create('dmn:InputClause', { id: 'In_1', inputExpression: moddle.create('dmn:LiteralExpression', { text: 'x' }) });
  table.get('input').push(input);
  table.get('output').push(moddle.create('dmn:OutputClause', { id: 'Out_1' }));
  decision.decisionLogic = table;
  definitions.get('drgElement').push(decision);
  // Deliberately NO \$parent assignments anywhere above.
  const { xml } = await moddle.toXML(definitions, { format: true, preamble: false });
  console.log(xml);
});
"
```

Expected either:
(a) The printed XML contains the full nested tree — `<dmn:definitions>` → `<dmn:decision>` →
`<dmn:decisionTable>` → `<dmn:input>` → `<dmn:inputExpression>` → the literal expression text, and
`<dmn:output>`. If so: `$parent` is **not** required for `toXML`, matching `bpmn-xml.js`'s working
precedent. Write `dmn-xml.js` **without** `$parent` bookkeeping, and add one line to the top-of-file
comment recording this: `// $parent is not set on constructed elements — verified empirically
(Task 5, Step 2) that moddle-xml's Writer does not need it, matching bpmn-xml.js's own precedent.`
(b) Something is missing or empty (e.g. the decision table serialises with no children). If so:
`$parent` **is** required, and this is a **STOP condition** — report it rather than patching Step 6's
code. Reason: Step 6 builds most children as constructor-attribute values (e.g.
`create('dmn:InputClause', { inputExpression: create('dmn:LiteralExpression', {...}) })`), where the
parent (`InputClause`) does not exist yet at the moment the child (`LiteralExpression`) is
constructed — there is no `parent` object to assign at that point. Making outcome (b) work would mean
restructuring every nesting site into a two-phase build (construct the child unparented, construct
the parent, then assign `child.$parent = parent` afterward), for `inputExpression`, `inputValues`,
`outputValues`, `defaultOutputEntry`, `inputEntry`, `outputEntry`, `annotationEntry`,
`formalParameter`, `bounds`, `waypoint`, `size`, `diagramElements`, `diagrams` and every
`.push(...)` site alike — a different and larger implementation than the one this plan specifies, not
a one-line-per-site patch. Report the exact probe output and stop; do not improvise the restructure.

**Do not proceed to Step 4 without running this and knowing which branch applies** — Step 6's
implementation below assumes outcome (a). If the probe shows (b), stop here per the STOP condition
above; do not write Step 6's code.

- [ ] **Step 3: VERIFY probe — the `hitPolicy`/`preferredOrientation` normalisation asymmetry**

`dmn13-xsd-ground-truth.md` §D8 is explicit: the XSD gives **no** basis for treating `hitPolicy` and
`preferredOrientation` differently — both are `use="optional"` with an explicit `default`, on the
same `xsd:extension` block. Whatever dmn-moddle actually does on write is a library behaviour to
observe, not derive. Observe it now:

```bash
cd scripts
node -e "
import('dmn-moddle').then(async ({ DmnModdle }) => {
  const moddle = new DmnModdle();
  const definitions = moddle.create('dmn:Definitions', { id: 'D_1', name: 'D_1', namespace: 'http://x' });
  const decision = moddle.create('dmn:Decision', { id: 'Decision_1', name: 'Decision_1' });
  const table = moddle.create('dmn:DecisionTable', {
    id: 'Table_1', hitPolicy: 'UNIQUE', preferredOrientation: 'Rule-as-Row',
  });
  table.get('output').push(moddle.create('dmn:OutputClause', { id: 'Out_1' }));
  decision.decisionLogic = table;
  definitions.get('drgElement').push(decision);
  const { xml } = await moddle.toXML(definitions, { format: true, preamble: false });
  console.log(xml);
});
"
```

Record exactly what the `<dmn:decisionTable ...>` opening tag contains — specifically whether
`hitPolicy="UNIQUE"` is present or dropped, and whether `preferredOrientation="Rule-as-Row"` is
present or dropped. Do not assume the asymmetry the earlier (now-corrected) plan claimed — write
down the actual observed tag verbatim.

Create `tests/fixtures/dmn/README.md`:

```markdown
# tests/fixtures/dmn/

## `discount-decision.json`

Reference Decision-Core fixture used by `scripts/dmn/rules.test.js` and `scripts/dmn/dmn-xml.test.js`.
Exercises every node type and every requirement kind. See `scripts/dmn/rules.js`'s own doc comment
for the rule-engine side.

## Golden-file normalisation, measured 2026-07-31 (Task 5)

`hitPolicy` and `preferredOrientation` are both declared `use="optional"` with an explicit XSD
default (`UNIQUE`, `Rule-as-Row` respectively) — the schema treats them identically
(`docs/superpowers/research/dmn13-xsd-ground-truth.md` §D8). Any asymmetry in what dmn-moddle emits
on write is **library behaviour**, not something the XSD justifies. Observed by running
`dmn-moddle@12.0.1`'s `toXML` directly (Task 5, Step 3):

<!-- EXECUTOR: paste the exact opening `<dmn:decisionTable ...>` tag observed in Step 3 here, and
     state plainly whether hitPolicy="UNIQUE" and preferredOrientation="Rule-as-Row" each survived
     the round trip or were dropped. `discount-decision.expected.dmn` (Task 6) must match this
     observation byte-for-byte — do not hand-edit the golden file to "restore" an attribute that
     dmn-moddle itself omits. -->
```

**Before moving on: replace that entire HTML comment with the real observation as plain committed
prose** — e.g. "The observed tag was `<dmn:decisionTable id=\"Table_1\" preferredOrientation=\"Rule-as-Row\">`:
`hitPolicy=\"UNIQUE\"` was dropped, `preferredOrientation=\"Rule-as-Row\"` was kept." The
`<!-- EXECUTOR ... -->` marker must not survive into the commit Step 15 makes — a filled-in comment
is still a comment, invisible in rendered Markdown, and indistinguishable from one nobody filled in.

The `dmn-xml.test.js` test in Step 6 below asserts against whatever Step 3 actually observed — write
that test's assertion to match the real output, not to match a guess.

- [ ] **Step 4: Write the failing core test — a minimal Definitions with one Decision**

Create `scripts/dmn/dmn-xml.test.js`:

```js
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DmnModdle } from 'dmn-moddle';

import { generateDmnXml, validateDmnXml } from './dmn-xml.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../tests/fixtures/dmn');
const loadFixture = (name) => JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
const good = () => loadFixture('discount-decision.json');

/** A minimal one-node, zero-requirement diagram list — the smallest legal Task 3 output shape. */
const oneNodeDiagram = (nodeId) => [{
  id: 'DMNDiagram_1', name: 'Diagram 1', size: { w: 300, h: 200 },
  coordMap: { coords: { [nodeId]: { x: 10, y: 10, w: 180, h: 80 } }, edgeCoords: {} },
}];

describe('generateDmnXml — minimal Definitions', () => {
  test('a single decision with no logic produces required attributes and no drgElement children beyond it', async () => {
    const dc = { id: 'Definitions_1', name: 'Minimal', namespace: 'http://x/minimal',
      nodes: [{ id: 'd1', type: 'decision', name: 'D1' }] };
    const xml = await generateDmnXml(dc, oneNodeDiagram('d1'));
    expect(xml).toContain('namespace="http://x/minimal"');
    expect(xml).toContain('name="Minimal"');
    expect(xml).toContain('<dmn:decision id="d1" name="D1"');
    // No literal <decisionLogic> wrapper element — DMN13.xsd has no such element
    // (dmn13-xsd-ground-truth.md §F16); the slot serialises as whichever concrete
    // expression type is assigned, or is absent entirely when there is none.
    expect(xml).not.toMatch(/<[a-zA-Z]*:?decisionLogic[\s>]/);
  });

  test('name falls back to id when absent — tNamedElement requires it', async () => {
    const dc = { id: 'Definitions_1', namespace: 'http://x/minimal',
      nodes: [{ id: 'd1', type: 'decision', name: 'D1' }] };
    const xml = await generateDmnXml(dc, oneNodeDiagram('d1'));
    expect(xml).toContain('name="Definitions_1"');
  });
});
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `cd scripts && npm test -- --testPathPatterns=dmn/dmn-xml`
Expected: FAIL — `Cannot find module './dmn-xml.js'` (the file does not exist yet).

- [ ] **Step 6: Write `scripts/dmn/dmn-xml.js`**

This is the full implementation, and it assumes Step 2's probe found `$parent` unnecessary (outcome
(a)). If Step 2 found outcome (b), you already stopped and reported per Step 2's STOP condition —
do not write this file from an adapted version of the code below; the per-site patch that sentence
used to suggest does not work mechanically for every nesting point here (see Step 2's explanation).
The `// nest` comments scattered through the code below are informational only — they mark where one
moddle element becomes a child of another, for a human reading the code, not a patch site.

```js
/**
 * DMN 1.3 XML + DMNDI generation via dmn-moddle, mirroring scripts/bpmn/bpmn-xml.js.
 *
 * Signature: generateDmnXml(dc, diagrams) -> Promise<string>
 *
 * Two facts this file depends on, both measured rather than assumed (Task 5, Steps 2-3):
 *   - $parent is not set on constructed elements — verified empirically (outcome (a) of Step 2's
 *     probe) that moddle-xml's Writer does not need it, matching bpmn-xml.js's own precedent. This
 *     file is not written at all under outcome (b) — see Step 2.
 *   - hitPolicy/preferredOrientation normalisation on write is dmn-moddle's own behaviour, not an
 *     XSD-derived rule (both attributes are equally optional-with-default in DMN13.xsd,
 *     dmn13-xsd-ground-truth.md §D8) — see tests/fixtures/dmn/README.md for what was observed.
 */

import { DmnModdle } from 'dmn-moddle';
import { rn } from '../shared/utils.js';
import { requirementKey } from './coordinates.js';

const moddle = new DmnModdle();

function create(type, attrs = {}) {
  return moddle.create(type, attrs);
}

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// The four DMN 1.3 types that do NOT extend tDMNElement and therefore must never carry an
// `id` attribute (DMN13.xsd, traced in full — dmn13-xsd-ground-truth.md §C). Emitting `id`
// on one of these reproduces the #36 mechanism: dmn-moddle does not reject an unknown
// attribute, it parks it in $attrs and writes it straight back out, and every later read of
// that file repeats the same warning. `dmn:Binding` is structurally unreachable from
// Decision-Core today — there is no `invocation` expression type in the schema — so it is
// listed here for completeness but never constructed; if invocation expressions are added
// later, the discipline already covers it.
const NO_ID_TYPES = new Set([
  'dmn:DMNElementReference', 'dmn:Binding', 'dmn:RuleAnnotationClause', 'dmn:RuleAnnotation',
]);

const MODDLE_TYPE = {
  decision: 'dmn:Decision',
  inputData: 'dmn:InputData',
  knowledgeSource: 'dmn:KnowledgeSource',
  businessKnowledgeModel: 'dmn:BusinessKnowledgeModel',
};

function buildDecisionTable(t) {
  const attrs = { id: t.id };
  if (t.hitPolicy) attrs.hitPolicy = t.hitPolicy;
  if (t.aggregation) attrs.aggregation = t.aggregation;
  if (t.preferredOrientation) attrs.preferredOrientation = t.preferredOrientation;
  if (t.outputLabel) attrs.outputLabel = t.outputLabel;
  const table = create('dmn:DecisionTable', attrs);

  for (const input of (t.inputs ?? [])) {
    // label lives on the InputClause itself (inherited from tDMNElement/@label); typeRef lives on
    // the inputExpression (inherited from tExpression/@typeRef, since tInputClause has no typeRef
    // of its own). Both are legal InputClause fields the schema and the fixture (in_1: "label":
    // "Order value", "typeRef": "number") carry — dropping either is the exact defect class this
    // plan exists to prevent (see CLAUDE.md "Adding a per-node field").
    const inputAttrs = { id: input.id, inputExpression: create('dmn:LiteralExpression', { text: input.expression, typeRef: input.typeRef }) };
    if (input.label) inputAttrs.label = input.label;
    if (input.allowedValues) inputAttrs.inputValues = create('dmn:UnaryTests', { text: input.allowedValues });
    table.get('input').push(create('dmn:InputClause', inputAttrs)); // nest
  }
  for (const output of t.outputs) {
    const outputAttrs = { id: output.id, name: output.name, typeRef: output.typeRef };
    if (output.allowedValues) outputAttrs.outputValues = create('dmn:UnaryTests', { text: output.allowedValues });
    if (output.defaultValue != null) outputAttrs.defaultOutputEntry = create('dmn:LiteralExpression', { text: output.defaultValue });
    table.get('output').push(create('dmn:OutputClause', outputAttrs)); // nest
  }
  for (const ann of (t.annotations ?? [])) {
    // NO id — tRuleAnnotationClause is one of the four id-less types.
    table.get('annotation').push(create('dmn:RuleAnnotationClause', { name: ann.name })); // nest
  }
  for (const rule of (t.rules ?? [])) {
    table.get('rule').push(create('dmn:DecisionRule', { // nest
      id: rule.id,
      inputEntry: (rule.when ?? []).map((w) => create('dmn:UnaryTests', { text: w })),
      outputEntry: rule.then.map((v) => create('dmn:LiteralExpression', { text: v })),
      // NO id on annotationEntry — tRuleAnnotation is one of the four id-less types.
      annotationEntry: (rule.annotations ?? []).map((a) => create('dmn:RuleAnnotation', { text: a })),
    }));
  }
  return table;
}

/**
 * tFunctionDefinition's exact moddle property names (formalParameter list, expression slot)
 * are NOT pinned by the research — VERIFY before trusting this against a real
 * businessKnowledgeModel fixture (Step 6a below). If the descriptor names differ, adjust
 * `formalParameter`/`expression` here to match.
 */
function buildFunctionDefinition(node) {
  const params = (node.parameters ?? []).map((p) => create('dmn:InformationItem', { name: p.name, typeRef: p.typeRef }));
  const attrs = { formalParameter: params };
  if (node.body != null) attrs.expression = create('dmn:LiteralExpression', { text: node.body });
  return create('dmn:FunctionDefinition', attrs);
}

function buildDrgElement(node) {
  const attrs = { id: node.id, name: node.name };
  if (node.documentation) attrs.description = node.documentation;
  const el = create(MODDLE_TYPE[node.type], attrs);

  // `variable` (tInformationItem) exists only on tDecision, tInputData and tInvocable (the base of
  // tBusinessKnowledgeModel) — DMN13.xsd traced in full: tKnowledgeSource extends tDRGElement
  // directly and declares no `variable` child. Decision-Core allows `typeRef` on any node, so a
  // knowledgeSource carrying one would otherwise reach this branch and either get silently dropped
  // by dmn-moddle or produce an invalid element. Guard by type, not just by presence of the field.
  if (node.type !== 'knowledgeSource' && (node.variable || node.typeRef)) {
    el.variable = create('dmn:InformationItem', { // nest
      id: `${node.id}_var`, name: node.variable || node.name, typeRef: node.typeRef,
    });
  }

  if (node.type === 'decision') {
    if (node.question) el.question = node.question;
    if (node.allowedAnswers) el.allowedAnswers = node.allowedAnswers;
    if (node.decisionTable) {
      el.decisionLogic = buildDecisionTable(node.decisionTable); // nest
    } else if (node.expression != null) {
      el.decisionLogic = create('dmn:LiteralExpression', { id: `${node.id}_expr`, text: node.expression }); // nest
    }
    // Bare id, no leading '#' — unlike attachRequirements below, which points at a DRG element in
    // THIS document and uses an XPointer-style fragment (`#id`). usingTask/usingProcess point at a
    // BPMN task/process in a DIFFERENT document; DMN13.xsd attaches no fragment-resolution meaning
    // to that case (dmn13-xsd-ground-truth.md §F16: "no XSD-level tie to an actual BPMN schema...
    // resolution is entirely a tooling/prose convention"), so there is no document-relative anchor
    // for a '#' to be relative to. Both forms are legal xsd:anyURI; the distinction is deliberate.
    for (const taskId of asArray(node.usingTask)) {
      el.get('usingTask').push(create('dmn:DMNElementReference', { href: taskId })); // nest
    }
    for (const procId of asArray(node.usingProcess)) {
      el.get('usingProcess').push(create('dmn:DMNElementReference', { href: procId })); // nest
    }
  }

  if (node.type === 'knowledgeSource') {
    if (node.sourceType) el.type = node.sourceType;
    if (node.locationURI) el.locationURI = node.locationURI;
  }

  if (node.type === 'businessKnowledgeModel' && (node.parameters?.length || node.body != null)) {
    el.encapsulatedLogic = buildFunctionDefinition(node); // nest
  }

  return el;
}

/**
 * Requirements nest under their TARGET (the requiring element), each carrying a
 * dmn:DMNElementReference href-wrapper (a STRING href, NOT an object reference — the exact
 * opposite pattern from dmnElementRef below; getting this backwards drops XML silently,
 * dmn-external-ground-truth.md §A.4 gotcha 2) pointing at the SOURCE (the required element).
 * Returns a Map from requirement key -> the built requirement moddle element, for the DMNDI
 * writer to look up by edgeCoords key.
 *
 * The key comes from requirementKey() (Global Constraint 8) — the SAME helper Task 3's
 * buildDmnDiagrams uses to key edgeCoords. Do not inline a second copy of the formula here:
 * a mismatch does not throw, it silently drops the DMNEdge for every requirement lacking an
 * explicit id, because the lookup returns undefined and the caller skips it as "no waypoints".
 *
 * The key is also used as the element's `id` when the requirement has none. That is not
 * cosmetic: `dmnElementRef` is an object reference, which moddle serialises as the referenced
 * element's id. A requirement element without an id therefore cannot be referenced, and its
 * DMNEdge would be emitted with an unresolvable reference.
 */
function attachRequirements(dc, nodeMap) {
  const nodesById = new Map(dc.nodes.map((n) => [n.id, n]));
  const requirementMap = new Map();
  for (const req of (dc.requirements ?? [])) {
    const targetEl = nodeMap.get(req.target);
    const sourceNode = nodesById.get(req.source);
    if (!targetEl || !sourceNode) continue; // D01 guarantees this for rule-gated input; defend anyway
    const key = requirementKey(req);
    const ref = create('dmn:DMNElementReference', { href: `#${req.source}` });
    let reqEl;
    if (req.type === 'information') {
      reqEl = create('dmn:InformationRequirement', { id: key });
      if (sourceNode.type === 'decision') reqEl.requiredDecision = ref; else reqEl.requiredInput = ref;
      targetEl.get('informationRequirement').push(reqEl); // nest
    } else if (req.type === 'knowledge') {
      reqEl = create('dmn:KnowledgeRequirement', { id: key, requiredKnowledge: ref });
      targetEl.get('knowledgeRequirement').push(reqEl); // nest
    } else if (req.type === 'authority') {
      reqEl = create('dmn:AuthorityRequirement', { id: key });
      if (sourceNode.type === 'decision') reqEl.requiredDecision = ref;
      else if (sourceNode.type === 'inputData') reqEl.requiredInput = ref;
      else reqEl.requiredAuthority = ref; // knowledgeSource
      targetEl.get('authorityRequirement').push(reqEl); // nest
    } else {
      continue;
    }
    requirementMap.set(key, reqEl);
  }
  return requirementMap;
}

function buildDmnDI(diagrams, nodeMap, requirementMap) {
  const dmnDiagrams = [];
  for (const diagram of diagrams) {
    const diagramElements = [];
    for (const [nodeId, c] of Object.entries(diagram.coordMap.coords)) {
      const nodeEl = nodeMap.get(nodeId);
      if (!nodeEl) continue;
      const bounds = create('dc:Bounds', { x: rn(c.x), y: rn(c.y), width: rn(c.w), height: rn(c.h) });
      diagramElements.push(create('dmndi:DMNShape', { id: `${nodeId}_di`, dmnElementRef: nodeEl, bounds })); // nest
    }
    for (const [reqKey, pts] of Object.entries(diagram.coordMap.edgeCoords)) {
      const reqEl = requirementMap.get(reqKey);
      if (!reqEl || pts.length < 2) continue; // better no DMNEdge than an invalid one
      const waypoint = pts.map((p) => create('dc:Point', { x: rn(p.x), y: rn(p.y) }));
      diagramElements.push(create('dmndi:DMNEdge', { id: `${reqKey}_di`, dmnElementRef: reqEl, waypoint })); // nest
    }
    dmnDiagrams.push(create('dmndi:DMNDiagram', { // nest
      id: diagram.id,
      name: diagram.name,
      size: create('dc:Dimension', { width: rn(diagram.size.w), height: rn(diagram.size.h) }),
      diagramElements,
    }));
  }
  return create('dmndi:DMNDI', { diagrams: dmnDiagrams });
}

export async function generateDmnXml(dc, diagrams) {
  const definitions = create('dmn:Definitions', {
    id: dc.id || 'Definitions_1',
    name: dc.name || dc.id || 'Definitions_1',
    namespace: dc.namespace,
    ...(dc.expressionLanguage ? { expressionLanguage: dc.expressionLanguage } : {}),
    ...(dc.documentation ? { description: dc.documentation } : {}),
  });

  const nodeMap = new Map();
  for (const node of dc.nodes) {
    const el = buildDrgElement(node);
    nodeMap.set(node.id, el);
    definitions.get('drgElement').push(el); // nest
  }

  const requirementMap = attachRequirements(dc, nodeMap);
  definitions.set('dmnDI', buildDmnDI(diagrams, nodeMap, requirementMap)); // nest

  const { xml } = await moddle.toXML(definitions, { format: true, preamble: true });
  return xml;
}

/**
 * Round-trip validate DMN XML by parsing it back through dmn-moddle. Mirrors
 * scripts/bpmn/bpmn-xml.js's validateBpmnXml exactly, except the return shape has no `valid`
 * key — the interface contract (Task 6 depends on this) is `Promise<{ warnings: [...] }>`.
 */
export async function validateDmnXml(xml) {
  const { warnings } = await moddle.fromXML(xml);
  return { warnings: warnings.map((w) => w.message || String(w)) };
}
```

If Step 6a below (businessKnowledgeModel) reveals `buildFunctionDefinition`'s property names are
wrong, fix them here before moving on — every later step in this task depends on this file compiling
and round-tripping cleanly.

- [ ] **Step 6a: VERIFY the `tFunctionDefinition` property names, then test businessKnowledgeModel**

The research's "exact moddle schema" table (`dmn-external-ground-truth.md` §A.3) does not cover
`FunctionDefinition` — this is a genuine gap, not a documented fact. Inspect the real descriptor:

```bash
cd scripts
node -e "
import('dmn-moddle').then(({ DmnModdle }) => {
  const moddle = new DmnModdle();
  const d = moddle.getType('dmn:FunctionDefinition');
  console.log(d.\$descriptor.properties.map((p) => p.name));
});
"
```

Compare the printed property names against `formalParameter`/`expression` used in
`buildFunctionDefinition` above. If they differ, edit that function to use the real names.

Then add to `scripts/dmn/dmn-xml.test.js`:

```js
describe('generateDmnXml — businessKnowledgeModel', () => {
  test('parameters and body serialise under encapsulatedLogic, round-trip through dmn-moddle', async () => {
    const dc = good(); // discount-decision.json — has bkm_loyaltyBonus with parameters + body
    const diagrams = oneNodeDiagram('bkm_loyaltyBonus');
    const xml = await generateDmnXml(dc, diagrams);
    const moddleForRead = new DmnModdle();
    const { rootElement, warnings } = await moddleForRead.fromXML(xml);
    expect(warnings).toEqual([]);
    const bkm = rootElement.get('drgElement').find((e) => e.id === 'bkm_loyaltyBonus');
    expect(bkm.encapsulatedLogic).toBeDefined();
    // The fixture's actual body text (tests/fixtures/dmn/discount-decision.json,
    // bkm_loyaltyBonus.body) — read it yourself before trusting this string if the fixture
    // ever changes; it does not contain the substring "loyaltyBonus".
    expect(bkm.encapsulatedLogic.expression.text).toBe('if since < date("2020-01-01") then 5 else 0');
  });
});
```

(If this throws a TypeError reading `.text` of `undefined`, Step 6a's descriptor inspection found a
different property name than `expression` — adjust the property path to match. If it throws instead
an assertion mismatch on the string value, the property name is right and something upstream changed
the fixture or `buildFunctionDefinition`'s text handling — do not "fix" this test to match whatever
came out; trace the mismatch back to its source.) Run
`cd scripts && npm test -- --testPathPatterns=dmn/dmn-xml`
and confirm this passes before continuing — it is the only test in this task that exercises
`buildFunctionDefinition`, and that function is the one piece of Step 6 not directly grounded in the
research.

- [ ] **Step 6b: `variable` must never appear on a knowledgeSource, even when `typeRef` is set**

`tKnowledgeSource` (DMN13.xsd) extends `tDRGElement` directly, not `tInvocable` — it has no
`variable` child at all, unlike `tDecision`/`tInputData`/`tBusinessKnowledgeModel`. Decision-Core's
schema permits `typeRef` on any node type, so nothing stops a knowledgeSource from carrying one; the
reference fixture never does, so this needs its own test. Add to `scripts/dmn/dmn-xml.test.js`:

```js
describe('generateDmnXml — variable is never emitted on a knowledgeSource', () => {
  test('a knowledgeSource carrying typeRef produces no variable element and round-trips clean', async () => {
    const dc = {
      id: 'Definitions_1', name: 'KS typeRef test', namespace: 'http://x/ks-typeref',
      nodes: [{ id: 'ks1', type: 'knowledgeSource', name: 'KS 1', typeRef: 'string' }],
    };
    const xml = await generateDmnXml(dc, oneNodeDiagram('ks1'));
    expect(xml).not.toMatch(/<dmn:knowledgeSource\b[^>]*>\s*<dmn:variable\b/);
    const { warnings } = await validateDmnXml(xml);
    expect(warnings).toEqual([]);
  });
});
```

Run: `cd scripts && npm test -- --testPathPatterns=dmn/dmn-xml`
Expected: PASS. If `<dmn:variable>` appears under `<dmn:knowledgeSource>`, or `warnings` is
non-empty, the guard added to `buildDrgElement` in Step 6 above is missing or wrong.

- [ ] **Step 7: Run the core tests — see them pass**

Run: `cd scripts && npm test -- --testPathPatterns=dmn/dmn-xml`
Expected: PASS, all tests from Steps 4 and 6a.

- [ ] **Step 8: Attribute discipline test — all four id-less types**

`tBinding` is unreachable (no `invocation` expression type in Decision-Core), so this test exercises
the other three: `tRuleAnnotationClause` (decision table's `annotation` column headers),
`tRuleAnnotation` (a rule's `annotationEntry`), and `tDMNElementReference` (every requirement's
`requiredInput`/`requiredDecision`/`requiredKnowledge`/`requiredAuthority`, and `usingTask`/
`usingProcess`). Add to `scripts/dmn/dmn-xml.test.js`:

```js
describe('generateDmnXml — attribute discipline: no id on the four id-less types', () => {
  test('annotation columns, annotation entries and every requirement reference carry no id attribute', async () => {
    const dc = good();
    const diagrams = oneNodeDiagram('dec_discountLevel');
    const xml = await generateDmnXml(dc, diagrams);
    // tRuleAnnotationClause (the "Note" column header) and tRuleAnnotation (each rule's
    // annotationEntry) — dc:DecisionTable/annotation and dmn:DecisionRule/annotationEntry.
    expect(xml).not.toMatch(/<dmn:annotation\b[^>]*\bid=/);
    expect(xml).not.toMatch(/<dmn:annotationEntry\b[^>]*\bid=/);
    // tDMNElementReference — every requiredInput/requiredDecision/requiredKnowledge/
    // requiredAuthority in this fixture (5 requirements of all 3 kinds).
    expect(xml).not.toMatch(/<dmn:required(Input|Decision|Knowledge|Authority)\b[^>]*\bid=/);
    // usingTask on dec_discountLevel is also a tDMNElementReference.
    expect(xml).not.toMatch(/<dmn:usingTask\b[^>]*\bid=/);
    // Round-trip must be clean — no "unknown attribute id" warnings, which is exactly the #36
    // mechanism: dmn-moddle parks an illegal attribute in $attrs and writes it straight back
    // out rather than rejecting it, so a warning here would be the discipline having failed.
    const { warnings } = await validateDmnXml(xml);
    expect(warnings).toEqual([]);
  });
});
```

Run: `cd scripts && npm test -- --testPathPatterns=dmn/dmn-xml`
Expected: PASS. If it fails on the `id=` assertions, find where `buildDecisionTable` or
`attachRequirements` accidentally passed an `id` for one of these four types and remove it — do not
weaken the regex.

- [ ] **Step 9: `hitPolicy`/`preferredOrientation` — pinned to what Step 3 actually observed**

Run Step 3's probe now if you have not already, and read its printed `<dmn:decisionTable ...>` tag
verbatim. It tells you which of the two complete test bodies below to add to
`scripts/dmn/dmn-xml.test.js` — write exactly one of them as live, uncommented code (do not keep
both, and do not guess without having run Step 3):

**If Step 3 showed `hitPolicy="UNIQUE"` DROPPED and `preferredOrientation="Rule-as-Row"` KEPT:**

```js
describe('generateDmnXml — hitPolicy/preferredOrientation normalisation (measured, not assumed)', () => {
  test('matches the behaviour observed and recorded in tests/fixtures/dmn/README.md', async () => {
    const dc = good();
    const xml = await generateDmnXml(dc, oneNodeDiagram('dec_discountLevel'));
    const tableTagMatch = xml.match(/<dmn:decisionTable\b[^>]*>/);
    expect(tableTagMatch).not.toBeNull();
    const tableTag = tableTagMatch[0];
    expect(tableTag).not.toMatch(/hitPolicy=/);
    expect(tableTag).toContain('preferredOrientation="Rule-as-Row"');
  });
});
```

**If Step 3 showed both attributes KEPT (or any other combination — adapt the two `expect` lines
below to match exactly what was printed; the first variant above is what this plan's own author
observed running dmn-moddle@12.0.1, the second is the schema-symmetric alternative shown for
completeness, not a second confirmed observation):**

```js
describe('generateDmnXml — hitPolicy/preferredOrientation normalisation (measured, not assumed)', () => {
  test('matches the behaviour observed and recorded in tests/fixtures/dmn/README.md', async () => {
    const dc = good();
    const xml = await generateDmnXml(dc, oneNodeDiagram('dec_discountLevel'));
    const tableTagMatch = xml.match(/<dmn:decisionTable\b[^>]*>/);
    expect(tableTagMatch).not.toBeNull();
    const tableTag = tableTagMatch[0];
    expect(tableTag).toContain('hitPolicy="UNIQUE"');
    expect(tableTag).toContain('preferredOrientation="Rule-as-Row"');
  });
});
```

Add only the one describe block that matches your observation — never both, and never a block with a
commented-out `expect` line standing in for a real assertion.

Run: `cd scripts && npm test -- --testPathPatterns=dmn/dmn-xml`
Expected: PASS, using the block that matches Step 3's real observation.

- [ ] **Step 10: Two-diagram test — the `DMNDiagram*` loop must not be dead code**

`buildDmnDiagrams` (Task 3) only ever produces one diagram today, so this test hand-builds a second
entry to exercise the loop — mirroring the design's explicit instruction that "a list of one that
never runs with two is unverified generality." Add to `scripts/dmn/dmn-xml.test.js`:

```js
describe('generateDmnXml — DMNDiagram* loop runs for more than one diagram', () => {
  test('two diagrams produce two DMNDiagram elements, each with its own shape', async () => {
    const dc = good();
    const diagrams = [
      { id: 'DMNDiagram_1', name: 'Overview', size: { w: 300, h: 200 },
        coordMap: { coords: { dec_discountLevel: { x: 10, y: 10, w: 180, h: 80 } }, edgeCoords: {} } },
      { id: 'DMNDiagram_2', name: 'Loyalty view', size: { w: 300, h: 200 },
        coordMap: { coords: { bkm_loyaltyBonus: { x: 10, y: 10, w: 135, h: 46 } }, edgeCoords: {} } },
    ];
    const xml = await generateDmnXml(dc, diagrams);
    const diagramTags = [...xml.matchAll(/<dmndi:DMNDiagram\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
    expect(diagramTags).toEqual(['DMNDiagram_1', 'DMNDiagram_2']);
    expect(xml).toMatch(/<dmndi:DMNShape\b[^>]*dmnElementRef="dec_discountLevel"/);
    expect(xml).toMatch(/<dmndi:DMNShape\b[^>]*dmnElementRef="bkm_loyaltyBonus"/);
  });
});
```

Run: `cd scripts && npm test -- --testPathPatterns=dmn/dmn-xml`
Expected: PASS.

- [ ] **Step 11: Field-set round-trip test**

Compared by field SET, not field by field — moddle reports attributes it does not *know*, never
fields that never arrived, which is why this defect class was invisible twice (#36, #42; see
CLAUDE.md "Adding a per-node field"). Add to `scripts/dmn/dmn-xml.test.js`:

```js
/** Semantic field names actually present on a moddle element, excluding bookkeeping keys. */
function fieldsOf(moddleEl) {
  const skip = new Set(['$type', '$parent', '$descriptor', '$attrs', 'id']);
  const out = new Set();
  for (const [k, v] of Object.entries(moddleEl)) {
    if (skip.has(k)) continue;
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out.add(k);
  }
  return out;
}

describe('generateDmnXml — field-set round trip (discount-decision.json, full fixture)', () => {
  test('every populated field on dec_discountLevel survives write + re-read', async () => {
    const dc = good();
    const diagrams = oneNodeDiagram('dec_discountLevel');
    const xml = await generateDmnXml(dc, diagrams);
    const reader = new DmnModdle();
    const { rootElement, warnings } = await reader.fromXML(xml);
    expect(warnings).toEqual([]);

    const decision = rootElement.get('drgElement').find((e) => e.id === 'dec_discountLevel');
    const fields = fieldsOf(decision);
    // dec_discountLevel in the fixture carries: name, question, allowedAnswers, variable,
    // decisionLogic (a decisionTable), usingTask, informationRequirement, authorityRequirement.
    for (const expected of [
      'name', 'question', 'allowedAnswers', 'variable',
      'decisionLogic', 'usingTask', 'informationRequirement', 'authorityRequirement',
    ]) {
      expect(fields).toContain(expected);
    }

    // One level deeper: the decision table itself must not have silently dropped a class of
    // child. hitPolicy is asserted separately in Step 9 (it may legitimately be normalised
    // away); everything else must be there.
    const tableFields = fieldsOf(decision.decisionLogic);
    for (const expected of ['input', 'output', 'annotation', 'rule']) {
      expect(tableFields).toContain(expected);
    }
    expect(decision.decisionLogic.rule).toHaveLength(3); // r1, r2, r3 in the fixture

    // One level deeper still: in_1 in the fixture carries both `label` and `typeRef` — the two
    // InputClause/inputExpression fields buildDecisionTable dropped until this task fixed it
    // (label lives on the InputClause, typeRef on its inputExpression; see the field-set
    // discipline note in CLAUDE.md's "Adding a per-node field"). OutputClause is checked the same
    // way: out_1 carries name/typeRef/allowedValues, all already covered by buildDecisionTable.
    const input0 = decision.decisionLogic.input[0];
    expect(fieldsOf(input0)).toContain('label');
    expect(input0.label).toBe('Order value');
    expect(input0.inputExpression.typeRef).toBe('number');

    const output0 = decision.decisionLogic.output[0];
    const outputFields = fieldsOf(output0);
    for (const expected of ['name', 'typeRef', 'outputValues']) {
      expect(outputFields).toContain(expected);
    }
  });
});
```

Run: `cd scripts && npm test -- --testPathPatterns=dmn/dmn-xml`
Expected: PASS. If a field is missing, the message names exactly which one — trace it back to
`buildDrgElement`/`buildDecisionTable`/`attachRequirements` and add it; do not silence the assertion.

- [ ] **Step 12: XSD validation via `xmllint`, skipping when the tool is absent**

Add to `scripts/dmn/dmn-xml.test.js`:

```js
function xmllintAvailable() {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const describeIfXmllint = xmllintAvailable() ? describe : describe.skip;

describeIfXmllint('generateDmnXml — validates against the normative XSD', () => {
  test('discount-decision.json produces XSD-valid DMN 1.3', async () => {
    const dc = good();
    const xml = await generateDmnXml(dc, oneNodeDiagram('dec_discountLevel'));
    const xsdPath = resolve(__dirname, '../../references/omg-spec/normative/dmn/DMN13.xsd');
    expect(() => execFileSync('xmllint', ['--noout', '--schema', xsdPath, '-'], {
      input: xml, stdio: ['pipe', 'pipe', 'pipe'],
    })).not.toThrow();
  });
});
```

Run: `cd scripts && npm test -- --testPathPatterns=dmn/dmn-xml`
Expected: PASS on a machine with `xmllint` present (confirmed present locally: libxml 2.9.13, and on
GitHub's ubuntu runners per the design doc). If `xmllint --version` fails, the whole `describe`
block is skipped — run `npm test -- --testPathPatterns=dmn/dmn-xml` and confirm the suite reports
this block as *skipped*, not failed, before concluding the guard works either way.

If this fails with a *schema* error (not a document error) about `DMNDI13.xsd`/`DC.xsd`/`DI.xsd` not
resolving — `DMN13.xsd` imports them by relative path, and all four already live together in
`references/omg-spec/normative/dmn/` — that would indicate a real path problem worth reporting, not
silently working around.

- [ ] **Step 13: Full DMN test run**

Run: `cd scripts && npm test -- --testPathPatterns=dmn`
Expected: PASS — `dmn/rules.test.js` (Step 1's addition) and `dmn/dmn-xml.test.js` (Steps 4-12) both
green.

- [ ] **Step 14: Full suite + docs gate**

Run: `cd scripts && npm test && npm run docs-gate`
Expected: both exit `0`.

- [ ] **Step 15: Commit**

```bash
git add references/decision-core-schema.json scripts/dmn/dmn-xml.js scripts/dmn/dmn-xml.test.js scripts/dmn/rules.test.js tests/fixtures/dmn/README.md
git commit -m "$(cat <<'EOF'
feat(dmn): generate DMN 1.3 XML + DMNDI via dmn-moddle

scripts/dmn/dmn-xml.js: generateDmnXml(dc, diagrams) and validateDmnXml(xml),
mirroring scripts/bpmn/bpmn-xml.js's use of the sibling *-moddle package.
Requirements nest under their target with the href-wrapper form
(dmn:DMNElementReference, a string href — the opposite pattern from
dmnElementRef, which is a real object reference); no literal <decisionLogic>
element is ever emitted, since none exists in DMN13.xsd; attribute discipline
covers the four types that do not extend tDMNElement.

Verified rather than assumed, per docs/superpowers/research: whether $parent
bookkeeping is required for toXML (it is/is not — see the file header),
and the hitPolicy/preferredOrientation normalisation on write (recorded in
tests/fixtures/dmn/README.md, pinned in a test rather than derived from the
XSD, which treats both attributes identically).

Schema change: usingTask/usingProcess now accept a string or an array,
covering DMN13.xsd's 0..unbounded cardinality (additive, non-breaking).

XSD-validated via xmllint (skips if absent), round-tripped through
dmn-moddle and compared by field set, and exercised with two diagrams so the
DMNDiagram* writer loop is not dead code.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `scripts/dmn/pipeline.js` + CLI, the golden file, and documentation

**The autonomy boundary applies to this whole task — read this before Step 1.** This task's job is
to make a real `.dmn` file exist and prove it machine-valid. It is NOT this task's job to declare
that DMN "works" in the sense of opening in a real tool. The final step is explicit about this:
produce the file, print its path, stop. Do not open it in dmn-js or Camunda Modeler (nothing in this
environment can), and do not write any sentence to the effect of "the milestone is reached" or "DMN
generation is complete" — only that the pipeline runs, the gates are green, and the file exists at a
given path. That judgement belongs to a human with the actual tools open, per
`docs/superpowers/specs/2026-07-31-dmn-drd-and-serialisation-design.md`'s "Verification and the
autonomy boundary" section.

**Files:**
- Create: `scripts/dmn/pipeline.js`
- Create: `scripts/dmn/pipeline.test.js`
- Create: `tests/fixtures/dmn/discount-decision.expected.dmn` (golden file)
- Modify: `CLAUDE.md`
- Modify: `references/api-reference.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/plans/2026-07-30-dmn-integration.md`

**Interfaces:**
- Consumes:
  - `validateDecisionCoreSchema(dc)` from `./schema-gate.js` — `{ valid, errors: [{path, message, params}] }`.
  - `runDmnRules(dc, { mode, profile, config })` from `./rules.js` — `{ errors, warnings, infos, mode }`.
  - `decisionCoreToElk(dc)`, `async runDmnElkLayout(graph)` from `./layout.js` (Task 2).
  - `buildDmnDiagrams(dc, laidOutGraph)` from `./coordinates.js` (Task 3) — `[{id, name, size:{w,h}, coordMap}]`.
  - `checkDmnDiagramIntegrity(diagrams)` from `./di-check.js` (Task 3) — `{ ok, issues: [{code, severity, message, elementId}] }`.
  - `generateDmnXml(dc, diagrams)`, `validateDmnXml(xml)` from `./dmn-xml.js` (Task 5).
- Produces: `async function runDmnPipeline(dc, opts)` and the CLI entry `node dmn/pipeline.js`, for
  Stage 5+ (importer, SVG, tool surface) to build on later — out of scope here.

- [ ] **Step 1: Write the failing test — schema-gate failure path**

Create `scripts/dmn/pipeline.test.js`:

```js
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDmnPipeline } from './pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../tests/fixtures/dmn');
const loadFixture = (name) => JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
const good = () => loadFixture('discount-decision.json');

describe('runDmnPipeline — schema gate', () => {
  test('a Decision-Core document missing the required namespace is blocked before rules run', async () => {
    const dc = good();
    delete dc.namespace;
    const result = await runDmnPipeline(dc);
    expect(result.xml).toBeNull();
    expect(result.diagrams).toBeNull();
    expect(result.diagnostics).toBeNull();
    expect(result.validation.errors.length).toBeGreaterThan(0);
    expect(result.validation.errors.join(' ')).toMatch(/namespace/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd scripts && npm test -- --testPathPatterns=dmn/pipeline`
Expected: FAIL — `Cannot find module './pipeline.js'`.

- [ ] **Step 3: Write `scripts/dmn/pipeline.js` (library part first, no CLI yet)**

```js
/**
 * DMN Generator Pipeline — Orchestrator + CLI + Public API (runDmnPipeline).
 * Mirrors scripts/bpmn/pipeline.js's shape and idiom; see that file's own header comment
 * for the module-architecture convention this follows.
 *
 * Gate order: schema gate -> rules -> layout -> coordinates -> di-check -> serialisation.
 * Unlike the BPMN pipeline, the schema gate runs INSIDE runDmnPipeline, not only in the CLI —
 * this is a deliberate difference, stated in the interface contract for this plan.
 *
 * Usage:
 *   node pipeline.js input.json [output-basename]
 *   cat input.json | node pipeline.js - output-basename
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateDecisionCoreSchema } from './schema-gate.js';
import { runDmnRules, loadRuleProfile } from './rules.js';
import { decisionCoreToElk, runDmnElkLayout } from './layout.js';
import { buildDmnDiagrams } from './coordinates.js';
import { checkDmnDiagramIntegrity } from './di-check.js';
import { generateDmnXml, validateDmnXml } from './dmn-xml.js';

/**
 * @param {object} dc - Decision-Core JSON
 * @param {object} [opts={}]
 * @param {string} [opts.mode='semantic'] - 'semantic' (default) or 'best-practice'
 * @param {string|object} [opts.ruleProfile] - base rule profile (path or object)
 * @param {object} [opts.config] - thresholds override, defaults to CFG.dmn inside runDmnRules
 * @returns {Promise<{xml: string|null, diagrams: object[]|null, validation: object, diagnostics: object|null}>}
 */
export async function runDmnPipeline(dc, opts = {}) {
  const input = JSON.parse(JSON.stringify(dc)); // deep clone — callers' objects are never mutated
  const mode = opts.mode ?? 'semantic';

  const schemaCheck = validateDecisionCoreSchema(input);
  if (!schemaCheck.valid) {
    const errors = schemaCheck.errors.map((e) => `[schema] ${e.path} ${e.message}`);
    return { xml: null, diagrams: null, diagnostics: null,
      validation: { errors, warnings: [], infos: [], xmlWarnings: [], mode } };
  }

  let ruleProfile = opts.ruleProfile ?? null;
  if (typeof ruleProfile === 'string') ruleProfile = loadRuleProfile(ruleProfile);
  const { errors, warnings, infos } = runDmnRules(input, { profile: ruleProfile, mode, config: opts.config });
  if (errors.length) {
    return { xml: null, diagrams: null, diagnostics: null,
      validation: { errors, warnings, infos, xmlWarnings: [], mode } };
  }

  const elkGraph = decisionCoreToElk(input);
  const laidOut = await runDmnElkLayout(elkGraph);
  const diagrams = buildDmnDiagrams(input, laidOut);
  const diagnostics = checkDmnDiagramIntegrity(diagrams);

  const xml = await generateDmnXml(input, diagrams);
  const roundTrip = await validateDmnXml(xml);

  return {
    xml, diagrams, diagnostics,
    validation: { errors: [], warnings, infos, xmlWarnings: roundTrip.warnings, mode },
  };
}
```

- [ ] **Step 4: Run the schema-gate test — see it pass**

Run: `cd scripts && npm test -- --testPathPatterns=dmn/pipeline`
Expected: PASS.

- [ ] **Step 5: Write the failing test — rules-gate failure and the success path**

Add to `scripts/dmn/pipeline.test.js`:

```js
describe('runDmnPipeline — rule engine gate', () => {
  test('a cyclic requirement graph is blocked after the schema gate, before layout', async () => {
    const dc = good();
    dc.requirements.push({ id: 'ir_cycle', type: 'information', source: 'dec_finalPercentage', target: 'dec_discountLevel' });
    const result = await runDmnPipeline(dc);
    expect(result.xml).toBeNull();
    expect(result.diagrams).toBeNull();
    expect(result.validation.errors.join(' ')).toMatch(/cycle/);
  });
});

describe('runDmnPipeline — success path', () => {
  test('the reference fixture produces xml, a diagram list and a clean diagnostics pass', async () => {
    const result = await runDmnPipeline(good());
    expect(typeof result.xml).toBe('string');
    expect(result.xml).toContain('<?xml');
    expect(Array.isArray(result.diagrams)).toBe(true);
    expect(result.diagrams.length).toBeGreaterThan(0);
    expect(result.validation.errors).toEqual([]);
    expect(result.validation.xmlWarnings).toEqual([]);
    expect(result.diagnostics.ok).toBe(true);
    expect(result.diagnostics.issues).toEqual([]);
  });

  test('best-practice mode surfaces B-layer warnings the default semantic mode does not', async () => {
    const dc = good();
    delete dc.nodes.find((n) => n.id === 'dec_discountLevel').question;
    const semantic = await runDmnPipeline(dc, { mode: 'semantic' });
    const bestPractice = await runDmnPipeline(dc, { mode: 'best-practice' });
    expect(semantic.validation.warnings.some((w) => w.startsWith('[B03]'))).toBe(false);
    expect(bestPractice.validation.warnings.some((w) => w.startsWith('[B03]'))).toBe(true);
  });
});

describe('runDmnPipeline — degenerate inputs', () => {
  test('a single isolated inputData node (no requirements) still produces valid xml', async () => {
    const dc = { namespace: 'http://x/isolated', nodes: [{ id: 'lonely', type: 'inputData', name: 'Lonely', typeRef: 'string' }] };
    const result = await runDmnPipeline(dc);
    expect(typeof result.xml).toBe('string');
    expect(result.diagnostics.ok).toBe(true);
  });

  test('zero nodes is rejected by the schema gate (nodes has minItems: 1), never reaches layout', async () => {
    const dc = { namespace: 'http://x/empty', nodes: [] };
    const result = await runDmnPipeline(dc);
    expect(result.xml).toBeNull();
    expect(result.diagrams).toBeNull();
  });
});
```

- [ ] **Step 6: Run the tests to verify the new ones fail appropriately, then pass**

Run: `cd scripts && npm test -- --testPathPatterns=dmn/pipeline`
Expected first (before this step existed the file already made the earlier two pass; these are new
assertions against already-correct code, so this step is confirmatory rather than red/green in the
strict sense) — all tests PASS. If the "isolated inputData" or "best-practice" tests fail, the
failure will point at whichever of Tasks 2/3/5's contracts this task's `runDmnPipeline` assumed
incorrectly — fix `pipeline.js`, not the test, unless the test itself is wrong about the contract.

- [ ] **Step 7: Add the CLI entry point**

Append to `scripts/dmn/pipeline.js` (after the `runDmnPipeline` export, before nothing — this is the
end of the file):

```js
// ═══════════════════════════════════════════════════════════════════════
// CLI ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const positional = args.filter((a) => !a.startsWith('--'));
  const inputArg = positional[0];
  const outputBase = positional[1] || 'output';
  const strict = flags.includes('--strict');
  const bestPractice = flags.includes('--best-practice') || flags.includes('--mode=best-practice');

  if (!inputArg) {
    console.error('Usage: node pipeline.js <input.json | -> [output-basename] [--strict] [--best-practice]');
    process.exit(1);
  }

  let rawInput;
  if (inputArg === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    rawInput = Buffer.concat(chunks).toString();
  } else {
    rawInput = readFileSync(resolve(inputArg), 'utf8');
  }

  const parsedInput = JSON.parse(rawInput);
  const result = await runDmnPipeline(parsedInput, { mode: bestPractice ? 'best-practice' : 'semantic' });

  if (result.validation.warnings.length) {
    console.warn('\n⚠ Warnings:');
    result.validation.warnings.forEach((w) => console.warn('  · ' + w));
  }
  if (!result.xml) {
    console.error('\n✗ Errors (pipeline blocked):');
    result.validation.errors.forEach((e) => console.error('  · ' + e));
    process.exit(1);
  }
  // --strict: treat any unresolved warning as fatal and abort BEFORE writing files, across the
  // three channels — mirroring scripts/bpmn/pipeline.js exactly. --strict is CLI-only logic;
  // runDmnPipeline itself has no `strict` option.
  if (strict && result.validation.warnings.length) {
    console.error(`\n✗ --strict: ${result.validation.warnings.length} warning(s). No files written.`);
    process.exit(1);
  }
  console.log('✓ Decision-Core validated (structural soundness OK)');

  const ddErrors = (result.diagnostics?.issues ?? []).filter((i) => i.severity === 'ERROR');
  const ddWarnings = (result.diagnostics?.issues ?? []).filter((i) => i.severity !== 'ERROR');
  if (ddWarnings.length) {
    console.warn('\n⚠ Diagram diagnostics:');
    ddWarnings.forEach((i) => console.warn(`  · ${i.code} ${i.message}`));
  }
  if (ddErrors.length) {
    console.error('\n✗ Diagram integrity (DD) — the geometry is broken, no files written:');
    ddErrors.forEach((i) => console.error(`  · ${i.code} ${i.message}`));
    process.exit(1);
  }
  if (strict && ddWarnings.length) {
    console.error(`\n✗ --strict: ${ddWarnings.length} diagram diagnostic(s). No files written.`);
    process.exit(1);
  }

  const xmlWarnings = result.validation.xmlWarnings ?? [];
  if (xmlWarnings.length) {
    console.warn('\n⚠ DMN serialisation (round-trip through dmn-moddle):');
    xmlWarnings.forEach((w) => console.warn('  · ' + w));
  }
  if (strict && xmlWarnings.length) {
    console.error(`\n✗ --strict: ${xmlWarnings.length} serialisation warning(s). No files written.`);
    process.exit(1);
  }

  const dmnPath = `${outputBase}.dmn`;
  writeFileSync(dmnPath, result.xml, 'utf8');
  console.log(`✓ DMN 1.3 XML → ${dmnPath}`);
}

// Only run CLI when executed directly (not imported) — same idiom as scripts/bpmn/pipeline.js.
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch((err) => { console.error('Pipeline error:', err); process.exit(1); });
}
```

- [ ] **Step 8: Smoke-test the CLI by hand**

```bash
cd scripts
node dmn/pipeline.js ../tests/fixtures/dmn/discount-decision.json /tmp/dmn-smoke
```

Expected: exits 0, prints `✓ DMN 1.3 XML → /tmp/dmn-smoke.dmn`, and `/tmp/dmn-smoke.dmn` exists and
starts with `<?xml version="1.0"...`.

```bash
node dmn/pipeline.js ../tests/fixtures/dmn/discount-decision.json /tmp/dmn-smoke-strict --strict
```

Expected: exits 0 as well if the fixture is fully clean under the default `semantic` mode (it is —
`dmn/rules.test.js` already asserts zero errors/warnings on this fixture); if any warning appears
here that `dmn/rules.test.js` does not expect, that is a real regression to investigate, not
something to silence.

```bash
echo '{"namespace":"x","nodes":[]}' | node dmn/pipeline.js - /tmp/dmn-empty
```

Expected: exits 1, prints a schema-gate error mentioning `nodes`, and does **not** create
`/tmp/dmn-empty.dmn`.

- [ ] **Step 9: Generate the golden file — inspect before trusting**

Per CLAUDE.md's "React to a golden-file failure" discipline, generate once and inspect the actual
output before committing it as ground truth (there is no prior golden to diff against here, since
this is the first one — read it end to end instead):

```bash
cd scripts
node dmn/pipeline.js ../tests/fixtures/dmn/discount-decision.json /tmp/dmn-golden
cat /tmp/dmn-golden.dmn
```

Confirm by eye: `<dmn:definitions>` carries both `namespace` and `name`; six `drgElement` children
(2 `inputData`, 1 `knowledgeSource`, 1 `businessKnowledgeModel`, 2 `decision` — recount against the
fixture's actual node list if this does not match); the decision table's `hitPolicy`/
`preferredOrientation` attributes match what Task 5 Step 3 recorded; no `id=` on any `<annotation>`/
`<annotationEntry>`/`<required*>` element; the file ends in `<dmndi:DMNDI>` containing one
`<dmndi:DMNDiagram>`. Then:

```bash
cp /tmp/dmn-golden.dmn ../tests/fixtures/dmn/discount-decision.expected.dmn
```

- [ ] **Step 10: Write the failing golden-file test**

Add to `scripts/dmn/pipeline.test.js`:

```js
describe('DMN Golden-File Regression', () => {
  test('discount-decision.json: xml matches golden file byte-for-byte', async () => {
    const result = await runDmnPipeline(good());
    let expected;
    try {
      expected = readFileSync(resolve(fixturesDir, 'discount-decision.expected.dmn'), 'utf8');
    } catch {
      throw new Error('Golden file missing: tests/fixtures/dmn/discount-decision.expected.dmn — run the golden generation step in Task 6, Step 9 first');
    }
    expect(result.xml).toBe(expected);
  });
});
```

This test was already effectively green the moment Step 9 copied the CLI's own output into place
(same code path, same input) — run it now to confirm that identity holds exactly, catching any
difference between what the CLI wrote to disk and what `runDmnPipeline` returns in-process (there
should be none; if there is one, `main()`'s file-writing path diverged from the return value
somehow, which is itself a bug worth finding here rather than in production).

Run: `cd scripts && npm test -- --testPathPatterns=dmn/pipeline`
Expected: PASS.

- [ ] **Step 11: XSD-validate the golden file itself**

```bash
xmllint --noout --schema references/omg-spec/normative/dmn/DMN13.xsd tests/fixtures/dmn/discount-decision.expected.dmn
```

Run from the repo root. Expected: no output, exit code 0 (`xmllint --noout` prints nothing on
success). This is the same proof Task 5's Step 12 test runs in Jest, applied directly to the
committed golden file as a final sanity check — not a new automated test, just a manual
confirmation before committing.

- [ ] **Step 12: Full suite, docs gate**

Run: `cd scripts && npm test && npm run docs-gate`
Expected: both exit `0`.

- [ ] **Step 13: Update `CLAUDE.md`**

Three edits.

**13a. Architecture intro line.** Compute the real current count first:

```bash
find scripts/dmn -maxdepth 1 -name '*.js' -not -name '*.test.js' | wc -l
```

Change:
```
7 top-level scripts (standalone tooling) + 23 bpmn-pipeline + 2 dmn (growing) + 3 shared + 7 agent +
9 robustness modules under `scripts/`. Verify current inventory with
```
to (replacing `<N>` with the counted number — expected 8 if Tasks 1-3 landed `constants.js`,
`layout.js`, `coordinates.js`, `di-check.js` as designed, plus this task's `pipeline.js` and Task 5's
`dmn-xml.js`, plus the pre-existing `rules.js`/`schema-gate.js`; recount rather than trust that
arithmetic if any of Tasks 1-3 diverged from the interface contract):
```
7 top-level scripts (standalone tooling) + 23 bpmn-pipeline + <N> dmn (growing) + 3 shared + 7 agent +
9 robustness modules under `scripts/`. Verify current inventory with
```

**13b. DMN subsystem architecture block.** Change:
```
DMN subsystem (scripts/dmn/) — opt-in, not reached by runPipeline
  schema-gate.js             ← ../shared/resource-paths.js (ajv gate for Decision-Core)
  rules.js                   ← ../shared/rule-profile.js, ../shared/utils.js (D01–D11 + B01–B06,
                               3 layers, 2 modes; own runner `runDmnRules`)
  (in progress — see docs/superpowers/plans/2026-07-30-dmn-integration.md.
   Stages 3–7 add layout, DMN 1.3 XML + DMNDI, importer, SVG and the tool surface.
   Nothing here produces a .dmn file yet.)
```
to:
```
DMN subsystem (scripts/dmn/) — opt-in, not reached by runPipeline
  pipeline.js (Orchestrator + CLI, public API runDmnPipeline)
    ├── schema-gate.js       ← ../shared/resource-paths.js (ajv gate for Decision-Core)
    ├── rules.js             ← ../shared/rule-profile.js, ../shared/utils.js (D01–D11 + B01–B06,
    │                          3 layers, 2 modes; own runner `runDmnRules`)
    ├── layout.js            ← constants.js, ../shared/utils.js, elkjs (decisionCoreToElk, runDmnElkLayout)
    ├── coordinates.js       ← constants.js, ../shared/geometry.js (buildDmnDiagrams, per-diagram coordMap)
    ├── di-check.js          (checkDmnDiagramIntegrity — DD01–DD03, mirrors bpmn/di-check.js)
    ├── dmn-xml.js           ← ../shared/utils.js, dmn-moddle (generateDmnXml, validateDmnXml)
    └── constants.js         ← ../shared/utils.js (DRD shape sizes, spacing, edge markers, from CFG.dmn)
  (produces a real .dmn file, XSD-validated — see
   docs/superpowers/plans/2026-07-30-dmn-integration.md for what is still open: the importer,
   SVG rendering and the tool surface, Stages 5–7.)
```
If the actual `import` statements Tasks 1-3 wrote diverge from the arrows shown (e.g. `layout.js`
importing something not listed here), correct the arrows to match the real files — the module list
and rough shape is fixed by the interface contract, the exact source of each arrow is not.

**13c. `references/decision-core-schema.json` row** in the Key Files table already exists; no
change needed there. Add one new row directly beneath the existing `scripts/dmn/rules.js` row:
```
| `scripts/dmn/dmn-xml.js` | `generateDmnXml`, `validateDmnXml` — DMN 1.3 XML + DMNDI via dmn-moddle, mirroring `bpmn-xml.js` |
| `scripts/dmn/pipeline.js` | `runDmnPipeline` — Orchestrator + CLI + Public API for the DMN side, gate order schema→rules→layout→coordinates→di-check→serialisation |
```

**13d. `## CLI` section.** Add, after the existing BPMN CLI block's closing ` ``` `:
````
DMN (mirrors the BPMN CLI's idiom):
```bash
# JSON → DMN 1.3 XML
node dmn/pipeline.js input.json output-basename

# Stdin:
cat input.json | node dmn/pipeline.js - output

# Abort (no files written) on any unresolved warning:
node dmn/pipeline.js input.json output --strict

# Enable the opt-in best_practice rule layer:
node dmn/pipeline.js input.json output --best-practice
```
````

**13e. Document DD01–DD03 in `references/api-reference.md`.** This is the only user-facing
reference to these codes anywhere in the repo — the docs gate's numeric-claim check does not cover
them (it reads `scripts/bpmn/di-check.js` only), so nothing else will catch a missing or wrong entry.
Read the existing `### validation vs. diagnostics` block first (under `## POST /api/v1/generate`) —
it documents BPMN's DI01–DI06 as a `| Code | Severity | Meaning |` table preceded by two short
paragraphs explaining `validation` vs `diagnostics`. DD01–DD03 are not reachable through that (or any)
endpoint yet, so do not nest the new block under `## POST /api/v1/generate` the way the DI table is —
add it as its own top-level section, placed after that endpoint's closing `---` and before `##
POST /api/v1/validate`, in the same table style:

```markdown
## DMN diagnostics (DD01–DD03)

`scripts/dmn/di-check.js`'s `checkDmnDiagramIntegrity` plays the same role for a DRD that
`di-check.js` plays for a BPMN diagram — its own code namespace so the two can appear side by side.
Not yet reachable over HTTP or MCP (Stage 7 of `docs/superpowers/plans/2026-07-30-dmn-integration.md`
adds the tool surface); today it is `runDmnPipeline(dc).diagnostics`, called directly or via the CLI
(`node dmn/pipeline.js`).

| Code | Severity | Meaning |
|------|----------|---------|
| DD01 | ERROR | Two DRD shapes overlapping |
| DD02 | ERROR | A shape outside the diagram's declared bounds |
| DD03 | ERROR | A requirement-connection endpoint that does not sit on its shape's boundary |

`diagnostics.ok` means "no ERROR-severity finding" — the same convention as BPMN's DI01–DI06 above.

---
```

(The trailing `---` matches the separator convention every other top-level section in this file
already ends with.) Run `cd scripts && npm run docs-gate` after this edit (folded into Step 16
below, but check now too — a wrong path string or a stray `DD04` here would be exactly the kind of
doc drift this plan's own docs gate exists to catch).

- [ ] **Step 14: Update `CHANGELOG.md`**

Add to the `[Unreleased]` → `### Added` section, above the existing Decision-Core entry (newest
first, matching the existing ordering convention in that section):

```markdown
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
```

- [ ] **Step 15: Refresh `docs/superpowers/plans/2026-07-30-dmn-integration.md`**

This document predates the modular restructure (`scripts/bpmn/`, `scripts/dmn/`, `scripts/shared/`)
and carries stale top-level paths, plus three claims the research in
`docs/superpowers/research/` refuted. Fix both. All edits below are exact `old_string`/`new_string`
pairs against the file as it exists before this task — re-read the file first if any `old_string`
does not match exactly (a still-open edit from an earlier session could have already touched it).

**15a. Status banner.** Insert, immediately after the file's title line (`# DMN integration —
implementation plan`) and before the `> **For agentic workers:**` blockquote:

```markdown

> **Status (2026-07-31): Stages 0–4 done.** GATE 1 is answered (approved). The design for Stages
> 3–4 was re-verified against the normative XSD, the actual codebase and the actual libraries
> before being executed — see
> [2026-07-31-dmn-drd-and-serialisation-design.md](../specs/2026-07-31-dmn-drd-and-serialisation-design.md),
> whose "What the research corrected" table lists nine claims from earlier planning that did not
> survive checking, three of which are corrected inline below. A real `.dmn` file exists as of
> `scripts/dmn/pipeline.js`, XSD-validated. Stages 5–7 (importer, SVG, tool surface) remain; GATE 2
> is still deferred.
```

**15b. Stale paths — Stage 1.** Change:
```
- [ ] `scripts/bpmn-xml.js` — `buildFlowNode` emits `extensionElements` carrying the reference for
```
to:
```
- [x] `scripts/bpmn/bpmn-xml.js` — `buildFlowNode` emits `extensionElements` carrying the reference for
```
Change:
```
- [ ] `scripts/moddle-import.js` `nodeFromElement` **and** `scripts/import.js` `nodeFromChild` —
```
to:
```
- [x] `scripts/bpmn/moddle-import.js` `nodeFromElement` **and** `scripts/bpmn/import.js` `nodeFromChild` —
```
Mark the remaining two Stage 1 bullets (`tests/fixtures/subprocess-child-fidelity.json`, the rule)
`- [x]` as well — Stage 1 shipped in commit `3f626a9`/`2f255c6` per `git log`, well before this task.

**15c. Stale paths — Stage 2.** Change:
```
- [ ] `scripts/dmn/schema-gate.js` — mirrors `scripts/schema-gate.js`, which is now four lines:
```
to:
```
- [x] `scripts/dmn/schema-gate.js` — mirrors `scripts/bpmn/schema-gate.js`:
```
Change:
```
- [ ] `scripts/dmn/rules.js` — same rule object shape as `scripts/rules.js`
```
to:
```
- [x] `scripts/dmn/rules.js` — same rule object shape as `scripts/bpmn/rules.js`
```
Change:
```
      `scripts/rules.js` — `loadRuleProfile`, `isRuleEnabled`, `getEffectiveSeverity` — is already
      format-agnostic; it only ever sees a rule object and a profile. Only `runRules` is
      BPMN-specific (fixed `RULES` list, `lc.pools ? lc.pools : [lc]`), so DMN needs its own runner
      and nothing else. Two of the three are not exported today: lift all three into
      `scripts/rule-profile.js` and have both engines import them, rather than duplicating them.
      That takes the top-level script count to 32 — update `CLAUDE.md` or the gate will.
- [ ] Fixtures under `tests/fixtures/dmn/`, one positive and one negative per rule.
```
to:
```
      `scripts/bpmn/rules.js` — `loadRuleProfile`, `isRuleEnabled`, `getEffectiveSeverity` — was
      already format-agnostic and has since been lifted into `scripts/shared/rule-profile.js`,
      imported by both engines (done in the modular restructure, commit `8c465d1`).
- [x] Fixtures under `tests/fixtures/dmn/`, one positive and one negative per rule.
```
Mark the `rules/dmn-default-profile.json` bullet `- [x]` too.

**15d. Stale paths and stale claim — Stage 3.** Change:
```
- [ ] `scripts/dmn/layout.js` — Decision-Core → ELK. A DRG is a plain DAG: no lanes, no pools, no
      boundary events, no message flows. `elk.direction: UP` (input data at the bottom, top-level
      decision at the top), which is the one real difference from `scripts/layout.js`.
```
to:
```
- [x] `scripts/dmn/layout.js` — Decision-Core → ELK. A DRG is a plain DAG: no lanes, no pools, no
      boundary events, no message flows. `elk.direction: UP` (input data at the bottom, top-level
      decision at the top), which is the one real difference from `scripts/bpmn/layout.js`. Verified
      empirically against elkjs@0.12.0 that `UP` needs no post-hoc y-flip — ELK emits final
      coordinates directly (`dmn-external-ground-truth.md` §C.10).
```
Change:
```
- [ ] `scripts/dmn/coordinates.js` — per-diagram `coordMap` in the same contract shape
```
to:
```
- [x] `scripts/dmn/coordinates.js` — per-diagram `coordMap` in the same contract shape
```
Change:
```
- [ ] `scripts/config.json` — a `dmn` block with the DRG shape sizes. No hard-coded constants.
- [ ] `scripts/dmn/di-check.js` — geometry pass, same role as `di-check.js`: overlapping shapes,
```
to:
```
- [x] `scripts/config.json` — a `dmn` block with the DRG shape sizes. No hard-coded constants.
- [x] `scripts/dmn/di-check.js` — geometry pass, same role as `scripts/bpmn/di-check.js`: overlapping shapes,
```
And correct the shared-geometry claim already partially fixed in the "Correction (2026-07-30)" note
in this same section — change:
```
      lines by convention — §6.2.2 mandates line style and arrowheads, not routing; the spec's own
      figures and the tools draw straight — while `clipOrthogonal` trims orthogonal polylines. The
      piece to build is a straight-segment clip against the four DRD outlines (rectangle;
      clipped-corner rectangle; stadium — exact circle intersection at the ends; wavy bottom —
      rectangle approximation is fine). ELK contributes node positions only; edge routes are
      computed once, here, so the geometry contract holds. "Reuse, do not copy" still applies where
      something exists to reuse: `rn()`/`wrapText` from `utils.js`, the ELK bootstrap idiom.
```
to:
```
      lines by convention — §6.2.2 mandates line style and arrowheads, not routing; the spec's own
      figures and the tools draw straight — while `clipOrthogonal` trims orthogonal polylines.
      **Further correction (2026-07-31):** the straight-segment clip already existed —
      `clipStraight`/`clipToRect` in `scripts/bpmn/coordinates.js` (lines 777-795), just not
      exported. They moved to `scripts/shared/geometry.js` so both `bpmn/` and `dmn/` import the
      same code rather than a second copy; the three orthogonal helpers (`clipCircleOrthogonal`,
      `clipDiamondOrthogonal`, `clipRectOrthogonal`) stayed in `bpmn/` — see
      [2026-07-31-dmn-drd-and-serialisation-design.md](../specs/2026-07-31-dmn-drd-and-serialisation-design.md)'s
      "Where the boundary actually runs" section for why. ELK contributes node positions only; edge
      routes are computed once, in `coordinates.js`, so the geometry contract holds. `rn()` from
      `shared/utils.js` is reused as-is.
```

**15e. Stale path and stale claim — Stage 4.** Change:
```
- [ ] `scripts/dmn/xml.js` — `generateDmnXml(dc, coordMap)` building moddle elements, mirroring
      `bpmn-xml.js`. `tDefinitions` order matters: it is an `xsd:sequence` ending in `dmndi:DMNDI`
      (max 1), and `@namespace` is required (§2.8).
```
to:
```
- [x] `scripts/dmn/dmn-xml.js` — `generateDmnXml(dc, diagrams)` building moddle elements, mirroring
      `bpmn/bpmn-xml.js`. `tDefinitions` order matters: it is an `xsd:sequence` ending in
      `dmndi:DMNDI` (max 1); `@namespace` AND `@name` (inherited from `tNamedElement`, easy to miss)
      are both required. **Correction (2026-07-31):** a decision's logic slot has no
      `<decisionLogic>` XML element — that string is only an XSD author's comment above an
      `xsd:element ref="expression"` slot. The serialised child is whichever concrete
      substitution-group member is used, `<decisionTable>` in every case this project produces
      today; emitting a literal `decisionLogic` wrapper is invalid DMN
      (`dmn13-xsd-ground-truth.md` §F16).
```
Mark the `Requirements nest under their target` and `DMNDI: DMNShape/DMNEdge carry dmnElementRef`
bullets `- [x]`. Change:
```
- [ ] The DMNDI writer loops over Stage 3's diagram list and gets a test with a hand-built
```
to:
```
- [x] The DMNDI writer loops over Stage 3's diagram list and gets a test with a hand-built
```
Change:
```
- [ ] **Attribute discipline.** Add a `isDmnElementWithId`-style predicate covering the types that do
      **not** extend `tDMNElement` — `tRuleAnnotation` and `tRuleAnnotationClause` have no `id`.
      Emitting one produces a warning that survives the round trip and reappears in every consumer
      (§2.7a) — the #36 mechanism exactly.
- [ ] `validateDmnXml(xml)` — re-parse through dmn-moddle and surface warnings, mirroring
      `validateBpmnXml`. Wire into the CLI as its own section and into `--strict`.
- [ ] **Before the first golden file:** pin the normalisation behaviour from §2.7(b) in a test —
      `hitPolicy="UNIQUE"` is dropped on write, `preferredOrientation="Rule-as-Row"` is kept. Write
      the goldens against actual output, with that asymmetry documented in the fixture's README.
```
to:
```
- [x] **Attribute discipline.** Covers all FOUR types that do not extend `tDMNElement` and therefore
      have no `id` — **correction (2026-07-31):** the earlier count of two
      (`tRuleAnnotation`, `tRuleAnnotationClause`) was incomplete; `tDMNElementReference` and
      `tBinding` also lack `id` (`dmn13-xsd-ground-truth.md` §C). `tBinding` is structurally
      unreachable from Decision-Core today (no `invocation` expression type), documented rather
      than exercised.
- [x] `validateDmnXml(xml)` — re-parse through dmn-moddle and surface warnings, mirroring
      `validateBpmnXml`. Wired into the CLI's own section and into `--strict`.
- [x] **Before the first golden file:** the `hitPolicy`/`preferredOrientation` normalisation was
      measured against the real library, not derived from the XSD. **Correction (2026-07-31):** the
      XSD gives no basis for treating the two attributes differently — both are `use="optional"`
      with an explicit `default`, on the same `xsd:extension` block
      (`dmn13-xsd-ground-truth.md` §D8). Whatever dmn-moddle actually does on write is recorded in
      `tests/fixtures/dmn/README.md`, and the golden file matches that observation.
```

**15f. Risks section — the stale `clipOrthogonal` claim.** Change:
```
2. **A second copy of shared geometry code.** The single most expensive mistake available here.
   Stage 3 reuses `clipOrthogonal` rather than forking it, on purpose.
```
to:
```
2. **A second copy of shared geometry code.** The single most expensive mistake available here.
   **Corrected (2026-07-31):** Stage 3 does not reuse `clipOrthogonal` — that helper is
   orthogonal-routing- and BPMN-shape-specific (branches on `isEvent`/`isGateway`). It reuses
   `clipStraight`/`clipToRect`, relocated from `scripts/bpmn/coordinates.js` into
   `scripts/shared/geometry.js` for exactly this purpose, avoiding a second copy of the actual
   straight-line clip maths.
```

- [ ] **Step 16: Verify the doc edits didn't break the docs gate**

Run: `cd scripts && npm run docs-gate`
Expected: exit `0`. The plan-doc refresh in Step 15 introduces path strings like
`scripts/dmn/dmn-xml.js`, `scripts/shared/geometry.js` and `scripts/bpmn/coordinates.js` — all of
which exist by this point in the plan (Task 5 created the first, and Tasks 1-3 are assumed complete
for the second and third; if `scripts/shared/geometry.js` does not actually exist yet when this step
runs, that means Task 1 has not landed and this whole trio of tasks was started out of order — stop
and report rather than writing a doc-gate-breaking reference to a file that was never created).

- [ ] **Step 17: Final full verification**

```bash
cd scripts
npm test
npm run docs-gate
```
Expected: both exit `0`.

- [ ] **Step 18: Commit**

```bash
git add scripts/dmn/pipeline.js scripts/dmn/pipeline.test.js tests/fixtures/dmn/discount-decision.expected.dmn CLAUDE.md references/api-reference.md CHANGELOG.md docs/superpowers/plans/2026-07-30-dmn-integration.md
git commit -m "$(cat <<'EOF'
feat(dmn): pipeline orchestrator + CLI — a real .dmn file exists

scripts/dmn/pipeline.js: runDmnPipeline(dc, opts) in gate order schema gate
-> rules -> layout -> coordinates -> di-check -> serialisation, and a CLI
(node dmn/pipeline.js input.json output[.dmn]) mirroring scripts/bpmn/pipeline.js's
idiom, including --strict across the three warning channels.

Golden file tests/fixtures/dmn/discount-decision.expected.dmn, generated and
inspected before being committed, XSD-valid against DMN13.xsd.

Docs: CLAUDE.md's DMN architecture block, key files and module count;
CHANGELOG.md [Unreleased]; and a refresh of
docs/superpowers/plans/2026-07-30-dmn-integration.md — pre-restructure paths
corrected throughout, Stages 0-4 marked done, and three refuted claims fixed
inline (the nonexistent <decisionLogic> element, the hitPolicy/
preferredOrientation asymmetry wrongly attributed to the XSD, and the stale
clipOrthogonal-reuse claim in the Risks section that contradicted the
Stage-3 correction already present in the same file).

This produces the file and stops here. Whether it opens correctly in dmn-js
and Camunda Modeler is not verified by this commit — that is the human
verification step the design's autonomy boundary reserves.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 19: Report and stop — the autonomy boundary**

Print the path to the generated golden file and the pipeline entry point. Do **not** attempt to open
the `.dmn` file in dmn-js or Camunda Modeler (neither is available in this environment, and even if
some viewer were, that judgement is explicitly reserved for a human — see this task's opening note
and `docs/superpowers/specs/2026-07-31-dmn-drd-and-serialisation-design.md`'s "Verification and the
autonomy boundary" section). Do not write or imply any sentence declaring DMN generation "complete",
"working end to end", or "the milestone reached". State plainly and only: the file exists at
`tests/fixtures/dmn/discount-decision.expected.dmn`, `npm test` and `npm run docs-gate` are green,
and the file validates against `references/omg-spec/normative/dmn/DMN13.xsd` via `xmllint`. Stop
there.

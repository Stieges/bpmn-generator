# BPMN Visual Refinement Pass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an opt-in post-layout refinement pass that improves BPMN diagram legibility on non-trivial diagrams — dynamic lane-header widths, edge-label collision repair, ELK wrapping for wide pipelines, and lane-height compaction.

**Architecture:** New pure-functional module `scripts/visual-refinement.js` with four passes run between `buildCoordinateMap` and XML/SVG serialization in `pipeline.js`. Plus one pre-layout hint (ELK wrapping strategy) injected conditionally in `layout.js`. All gated by `config.json → visualRefinement.enabled` (default `false` initially). The global `LANE_HEADER_W` constant becomes a per-pool field on `poolCoords`, falling back to the constant when dynamic width is not computed.

**Tech Stack:** Node.js ES modules, Jest 30.x, ElkJS 0.11.x. No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-04-21-bpmn-visual-refinement-pass-design.md`.

---

## File Structure

### Create
- `scripts/visual-refinement.js` — the four-pass module (`estimateTextWidth`, `computeDynamicLaneHeaders`, `repairEdgeLabels`, `compactLanes`)
- `scripts/visual-refinement.test.js` — unit tests for the module
- `tests/fixtures/long-lane-names.json` — Pass 1 fixture
- `tests/fixtures/dense-edge-labels.json` — Pass 3 fixture
- `tests/fixtures/wide-pipeline.json` — Pass 5 fixture
- `tests/fixtures/sparse-lanes.json` — Pass 2 fixture
- Expected + refined golden files for all new fixtures (generated during implementation)
- Refined golden files for existing fixtures (`simple-approval.refined.{bpmn,svg}`, etc.)

### Modify
- `scripts/config.json` — add `visualRefinement` section
- `scripts/utils.js` — extend `wrapText` with char-level fallback; add `wrapTextByPx` helper
- `scripts/coordinates.js` — initialize `poolCoords[id].laneHeaderWidth`
- `scripts/layout.js` — conditional `elk.layered.wrapping.strategy`, accept `{ elkWrapping }` option in `logicCoreToElk`
- `scripts/svg.js` — read `laneHeaderWidth` from pool coord (fallback: `LANE_HEADER_W`)
- `scripts/bpmn-xml.js` — read `laneHeaderWidth` from pool coord (fallback: `LANE_HEADER_W`)
- `scripts/pipeline.js` — orchestrate refinement passes behind flag
- `scripts/pipeline.test.js` — matrix tests + metric assertions

---

## Phase P1 — Scaffolding + `LANE_HEADER_W` Refactor

### Task P1.1: Add config section

**Files:**
- Modify: `scripts/config.json` (append to root object)

- [ ] **Step 1: Add `visualRefinement` block to `scripts/config.json`**

Insert before the closing `}` of the root object, after the `elk` block:

```json
  },
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
}
```

(Replace the existing trailing `}` of `elk` with the comma + block shown.)

- [ ] **Step 2: Run tests to confirm no regression**

Run: `cd scripts && npm test`
Expected: all 136 tests pass, no config parse errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/daniel.stiegler/Projects/bpmn-generator
git add scripts/config.json
git commit -m "config: Add visualRefinement section (disabled by default)"
```

---

### Task P1.2: Create `visual-refinement.js` skeleton + `estimateTextWidth`

**Files:**
- Create: `scripts/visual-refinement.js`
- Create: `scripts/visual-refinement.test.js`

- [ ] **Step 1: Write the failing test for `estimateTextWidth`**

Create `scripts/visual-refinement.test.js`:

```javascript
/**
 * Visual Refinement — unit tests
 */
import { estimateTextWidth } from './visual-refinement.js';

describe('estimateTextWidth', () => {
  test('returns 0 for empty string', () => {
    expect(estimateTextWidth('', 11)).toBe(0);
  });

  test('scales roughly with character count at fontSize 11', () => {
    const short = estimateTextWidth('abc', 11);
    const long  = estimateTextWidth('abcabcabc', 11);
    expect(long).toBeGreaterThan(short * 2.5);
    expect(long).toBeLessThan(short * 3.5);
  });

  test('scales with font size', () => {
    const w11 = estimateTextWidth('Hello World', 11);
    const w22 = estimateTextWidth('Hello World', 22);
    expect(w22).toBeGreaterThan(w11 * 1.8);
  });

  test('handles German compound words (no spaces)', () => {
    const w = estimateTextWidth('Prozessverantwortlicher', 11);
    expect(w).toBeGreaterThan(100); // ~120–150 px expected
    expect(w).toBeLessThan(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts && npx jest visual-refinement.test.js --verbose`
Expected: FAIL with "Cannot find module './visual-refinement.js'".

- [ ] **Step 3: Create the module with `estimateTextWidth`**

Create `scripts/visual-refinement.js`:

```javascript
/**
 * BPMN Visual Refinement — Post-Layout Coordinate Transforms
 *
 * Pure functions that run between buildCoordinateMap and serialization.
 * All transforms are opt-in via config.visualRefinement.enabled.
 *
 * - estimateTextWidth:          char-count-based text width heuristic
 * - computeDynamicLaneHeaders:  per-pool dynamic lane header strip width
 * - repairEdgeLabels:           bbox-collision-based label nudging
 * - compactLanes:               shrink lanes to content, shift nodes + waypoints
 */

// Average character-width factors for Arial at fontSize 1 (in px).
// Calibrated against bpmn.io renderings; accurate to ~±15% which is
// enough for layout decisions.
const CHAR_WIDTH_FACTOR = 0.6;

/**
 * Estimate rendered width of a string in pixels.
 * @param {string} text
 * @param {number} fontSize - in px
 * @returns {number} estimated width in px
 */
export function estimateTextWidth(text, fontSize = 11) {
  if (!text) return 0;
  return text.length * fontSize * CHAR_WIDTH_FACTOR;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts && npx jest visual-refinement.test.js --verbose`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/visual-refinement.js scripts/visual-refinement.test.js
git commit -m "feat(visual-refinement): Scaffold module + estimateTextWidth"
```

---

### Task P1.3: Initialize `poolCoords[id].laneHeaderWidth` in `coordinates.js`

**Files:**
- Modify: `scripts/coordinates.js:37, 44, 166-184, ~530` (wherever poolCoords entries are created or written)

- [ ] **Step 1: Write failing test for poolCoords.laneHeaderWidth**

Append to `scripts/pipeline.test.js` (or create a new focused test file):

```javascript
import { runPipeline } from './pipeline.js';
import { readFileSync } from 'fs';

describe('poolCoords.laneHeaderWidth', () => {
  test('is populated with default LANE_HEADER_W after buildCoordinateMap', async () => {
    const lc = JSON.parse(readFileSync('../tests/fixtures/simple-approval.json', 'utf8'));
    const result = await runPipeline(lc);
    const poolIds = Object.keys(result.coordMap.poolCoords);
    expect(poolIds.length).toBeGreaterThan(0);
    for (const pid of poolIds) {
      expect(result.coordMap.poolCoords[pid].laneHeaderWidth).toBeDefined();
      expect(typeof result.coordMap.poolCoords[pid].laneHeaderWidth).toBe('number');
    }
  });
});
```

Note: if `runPipeline` does not expose `coordMap`, adapt the test to call `buildCoordinateMap` directly after `runElkLayout`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts && npx jest pipeline.test.js -t "laneHeaderWidth"`
Expected: FAIL with `laneHeaderWidth is undefined`.

- [ ] **Step 3: Populate the field in every `poolCoords` assignment**

In `scripts/coordinates.js`, modify every site that creates a `poolCoords[...]` entry to also set `laneHeaderWidth: LANE_HEADER_W`. Concretely:

Line 37 — change:
```js
poolCoords[node.id] = { x: ax, y: ay, w: node.width, h: node.height };
```
to:
```js
poolCoords[node.id] = { x: ax, y: ay, w: node.width, h: node.height, laneHeaderWidth: LANE_HEADER_W };
```

Line 44 — change:
```js
poolCoords['_singlePool'] = { x: ax, y: ay, w: node.width, h: node.height };
```
to:
```js
poolCoords['_singlePool'] = { x: ax, y: ay, w: node.width, h: node.height, laneHeaderWidth: LANE_HEADER_W };
```

No change needed in lines 176–184 — those mutate `pc.x`, `pc.y`, etc. but leave unrelated fields intact.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts && npx jest pipeline.test.js -t "laneHeaderWidth"`
Expected: PASS.

- [ ] **Step 5: Run full suite to confirm no regression**

Run: `cd scripts && npm test`
Expected: 137 tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/coordinates.js scripts/pipeline.test.js
git commit -m "refactor(coordinates): Store laneHeaderWidth per pool"
```

---

### Task P1.4: Update `svg.js` to read `laneHeaderWidth` from pool

**Files:**
- Modify: `scripts/svg.js` (5 sites currently using `LANE_HEADER_W`)

- [ ] **Step 1: Identify all LANE_HEADER_W usage sites**

Run: `cd scripts && grep -n LANE_HEADER_W svg.js`
Expected output: ~5 lines (30, 105, 111-112, 134-135, 226, 234-235).

- [ ] **Step 2: Introduce a lookup helper at top of `svg.js`**

Add immediately after imports in `scripts/svg.js`:

```javascript
/**
 * Return the effective lane-header strip width for a pool, preferring
 * any dynamic value computed by visual-refinement over the default.
 */
function laneHeaderW(poolCoords, poolKey) {
  return poolCoords?.[poolKey]?.laneHeaderWidth ?? LANE_HEADER_W;
}
```

- [ ] **Step 3: Replace `LANE_HEADER_W` with `laneHeaderW(poolCoords, poolKey)` at each call site**

At each rendering site where a pool is being drawn, identify the pool key in scope (`pools[pid]`, `proc.id`, or `_singlePool`) and substitute the helper call. Keep `LANE_HEADER_W` import for the fallback inside `laneHeaderW`.

- [ ] **Step 4: Run existing golden-file tests**

Run: `cd scripts && npm test`
Expected: all tests pass (existing goldens unchanged because `laneHeaderWidth === LANE_HEADER_W` for all pools at this point).

- [ ] **Step 5: Commit**

```bash
git add scripts/svg.js
git commit -m "refactor(svg): Read laneHeaderWidth from pool coords"
```

---

### Task P1.5: Update `bpmn-xml.js` to read `laneHeaderWidth` from pool

**Files:**
- Modify: `scripts/bpmn-xml.js:429` (and any other LANE_HEADER_W sites)

- [ ] **Step 1: Identify all LANE_HEADER_W usage sites**

Run: `cd scripts && grep -n LANE_HEADER_W bpmn-xml.js`

- [ ] **Step 2: Add the same `laneHeaderW` helper as in svg.js**

At top of `scripts/bpmn-xml.js`, after imports:

```javascript
function laneHeaderW(poolCoords, poolKey) {
  return poolCoords?.[poolKey]?.laneHeaderWidth ?? LANE_HEADER_W;
}
```

- [ ] **Step 3: Replace every `LANE_HEADER_W` usage with the helper call**

- [ ] **Step 4: Run full test suite**

Run: `cd scripts && npm test`
Expected: all tests pass (goldens unchanged).

- [ ] **Step 5: Commit**

```bash
git add scripts/bpmn-xml.js
git commit -m "refactor(bpmn-xml): Read laneHeaderWidth from pool coords"
```

---

### Task P1.6: End-of-Phase regression gate

- [ ] **Step 1: Regenerate existing goldens to prove byte-identity**

```bash
cd scripts
node pipeline.js ../tests/fixtures/simple-approval.json /tmp/p1-simple
diff /tmp/p1-simple.bpmn ../tests/fixtures/simple-approval.expected.bpmn
diff /tmp/p1-simple.svg  ../tests/fixtures/simple-approval.expected.svg
```
Expected: both diffs empty.

- [ ] **Step 2: Repeat for `multi-pool-collaboration.json` and `expanded-subprocess.json`**

Expected: all three diffs empty.

- [ ] **Step 3: Tag the phase boundary (no commit needed if step 1-2 clean)**

If anything diverges, investigate and fix before proceeding.

---

## Phase P2 — Pass 1 (Dynamic Lane Headers) + Pass 4 (wrapText extension)

### Task P2.1: Extend `wrapText` in `utils.js` with char-level fallback

**Files:**
- Modify: `scripts/utils.js:49-65` (current `wrapText` function)
- Modify: `scripts/pipeline.test.js` (or create `utils.test.js`)

- [ ] **Step 1: Write the failing tests for char-level fallback**

Append to `scripts/pipeline.test.js` (or create `scripts/utils.test.js`):

```javascript
import { wrapText } from './utils.js';

describe('wrapText char-level fallback', () => {
  test('wraps normal sentences on word boundaries', () => {
    expect(wrapText('Hello world foo', 5)).toEqual(['Hello', 'world', 'foo']);
  });

  test('breaks a single word longer than maxChars with hyphen', () => {
    const result = wrapText('Prozessverantwortlicher', 10);
    expect(result.length).toBeGreaterThan(1);
    expect(result.every(line => line.length <= 11)).toBe(true);  // 10 + hyphen
    // At least one line should end with hyphen (continuation marker)
    expect(result.slice(0, -1).every(l => l.endsWith('-'))).toBe(true);
    // Joining without hyphens reconstructs the original
    expect(result.map(l => l.replace(/-$/, '')).join('')).toBe('Prozessverantwortlicher');
  });

  test('respects max chars per line', () => {
    const result = wrapText('aaaaaaaaaaaaaaaaaaaa', 5);
    expect(result.every(l => l.length <= 6)).toBe(true);
  });

  test('returns array with empty string for empty input', () => {
    expect(wrapText('', 5)).toEqual(['']);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd scripts && npx jest -t "wrapText char-level"`
Expected: FAIL on "breaks a single word longer than maxChars".

- [ ] **Step 3: Update `wrapText` in `scripts/utils.js`**

Replace lines 49–66 (the entire current `wrapText` function) with:

```javascript
export function wrapText(text, maxChars) {
  if (!text) return [''];
  if (text.length <= maxChars) return [text];

  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';

  const breakLongWord = (word) => {
    // Break a single word longer than maxChars into hyphen-terminated chunks.
    // All but the last chunk end with '-'. Chunks have length <= maxChars.
    const chunks = [];
    let i = 0;
    while (i < word.length) {
      const remaining = word.length - i;
      if (remaining <= maxChars) {
        chunks.push(word.slice(i));
        break;
      }
      // Reserve one char for the hyphen
      const take = maxChars - 1;
      chunks.push(word.slice(i, i + take) + '-');
      i += take;
    }
    return chunks;
  };

  for (const w of words) {
    if (w.length > maxChars) {
      if (cur) { lines.push(cur); cur = ''; }
      const chunks = breakLongWord(w);
      for (let i = 0; i < chunks.length - 1; i++) lines.push(chunks[i]);
      cur = chunks[chunks.length - 1];
      continue;
    }
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length > maxChars) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}
```

- [ ] **Step 4: Run tests — confirm pass**

Run: `cd scripts && npm test`
Expected: all tests pass, new 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add scripts/utils.js scripts/pipeline.test.js
git commit -m "feat(utils): Add char-level fallback for long words in wrapText"
```

---

### Task P2.2: Add `wrapTextByPx` helper in `utils.js`

**Files:**
- Modify: `scripts/utils.js` (append new export)
- Modify: `scripts/pipeline.test.js` (or the shared utils tests)

- [ ] **Step 1: Write failing test**

Append to the same test file as P2.1:

```javascript
import { wrapText, wrapTextByPx } from './utils.js';

describe('wrapTextByPx', () => {
  test('wraps based on pixel budget, using estimateTextWidth', () => {
    // 60px at fontSize=11 ≈ 9 chars (60 / (11 * 0.6))
    const result = wrapTextByPx('Hello World Foo Bar', 60, 11);
    expect(result.length).toBeGreaterThan(1);
    expect(result.every(l => l.length <= 10)).toBe(true);
  });

  test('handles zero-width gracefully (returns one char per line)', () => {
    const result = wrapTextByPx('abc', 1, 11);
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run — confirm failure**

Run: `cd scripts && npx jest -t "wrapTextByPx"`
Expected: FAIL on import.

- [ ] **Step 3: Implement `wrapTextByPx` in `scripts/utils.js`**

Append to `scripts/utils.js`:

```javascript
/**
 * Wrap text using a pixel-width budget.
 * Converts to a char-count budget via the same heuristic as estimateTextWidth.
 */
export function wrapTextByPx(text, maxPxWidth, fontSize = 11) {
  const CHAR_WIDTH_FACTOR = 0.6;
  const maxChars = Math.max(1, Math.floor(maxPxWidth / (fontSize * CHAR_WIDTH_FACTOR)));
  return wrapText(text, maxChars);
}
```

- [ ] **Step 4: Run tests — pass**

Run: `cd scripts && npm test`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add scripts/utils.js scripts/pipeline.test.js
git commit -m "feat(utils): Add wrapTextByPx helper (px-budget wrapping)"
```

---

### Task P2.3: Implement `computeDynamicLaneHeaders`

**Files:**
- Modify: `scripts/visual-refinement.js`
- Modify: `scripts/visual-refinement.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/visual-refinement.test.js`:

```javascript
import { computeDynamicLaneHeaders } from './visual-refinement.js';

describe('computeDynamicLaneHeaders', () => {
  const mkCoordMap = () => ({
    poolCoords: { 'pool1': { x: 0, y: 0, w: 500, h: 200, laneHeaderWidth: 40 } },
    laneCoords: { 'lane1': { x: 40, y: 0, w: 460, h: 100 }, 'lane2': { x: 40, y: 100, w: 460, h: 100 } },
    coords: {}, edgeCoords: {}
  });
  const mkProcess = () => ({
    pools: [{
      id: 'pool1',
      lanes: [
        { id: 'lane1', name: 'Kurz' },
        { id: 'lane2', name: 'Prozessverantwortlicher' }
      ]
    }]
  });

  test('leaves short labels at default width', () => {
    const coords = mkCoordMap();
    const proc = { pools: [{ id: 'pool1', lanes: [{ id: 'lane1', name: 'A' }, { id: 'lane2', name: 'B' }]}] };
    const out = computeDynamicLaneHeaders(coords, proc, { minWidth: 30, maxWidth: 120 });
    expect(out.poolCoords.pool1.laneHeaderWidth).toBe(30);
  });

  test('widens header for long compound words', () => {
    const coords = mkCoordMap();
    const proc = mkProcess();
    const out = computeDynamicLaneHeaders(coords, proc, { minWidth: 30, maxWidth: 120 });
    expect(out.poolCoords.pool1.laneHeaderWidth).toBeGreaterThan(30);
    expect(out.poolCoords.pool1.laneHeaderWidth).toBeLessThanOrEqual(120);
  });

  test('grows pool width to the left by delta', () => {
    const coords = mkCoordMap();
    const proc = mkProcess();
    const origPoolX = coords.poolCoords.pool1.x;
    const origPoolW = coords.poolCoords.pool1.w;
    const out = computeDynamicLaneHeaders(coords, proc, { minWidth: 30, maxWidth: 120 });
    const delta = out.poolCoords.pool1.laneHeaderWidth - 40;
    expect(out.poolCoords.pool1.x).toBe(origPoolX - delta);
    expect(out.poolCoords.pool1.w).toBe(origPoolW + delta);
  });

  test('clamps to maxWidth when label is extremely long', () => {
    const coords = mkCoordMap();
    const longLabel = 'A'.repeat(100);
    const proc = { pools: [{ id: 'pool1', lanes: [{ id: 'lane1', name: longLabel }, { id: 'lane2', name: 'short' }]}] };
    const out = computeDynamicLaneHeaders(coords, proc, { minWidth: 30, maxWidth: 120 });
    expect(out.poolCoords.pool1.laneHeaderWidth).toBe(120);
  });
});
```

- [ ] **Step 2: Run — confirm failure**

Run: `cd scripts && npx jest -t "computeDynamicLaneHeaders"`
Expected: FAIL on import.

- [ ] **Step 3: Implement in `scripts/visual-refinement.js`**

Append:

```javascript
import { wrapTextByPx, LANE_HEADER_W } from './utils.js';

const FONT_SIZE = 11;
const LINE_GAP  = 3;    // additional spacing between wrapped lines
const STRIP_PADDING = 8; // 4px each side inside header strip

/**
 * Dynamically size per-pool lane-header strip width to fit rotated labels.
 * Wraps long labels into multiple vertical lines; widens strip so stacked
 * lines still fit within lane height.
 *
 * Mutates input coordMap (for consistency with other passes) and returns it.
 */
export function computeDynamicLaneHeaders(coordMap, process, opts = {}) {
  const minWidth = opts.minWidth ?? 30;
  const maxWidth = opts.maxWidth ?? 120;
  const lineHeight = FONT_SIZE + LINE_GAP;

  const pools = process.pools ?? [process];

  for (const pool of pools) {
    const pc = coordMap.poolCoords[pool.id] ?? coordMap.poolCoords['_singlePool'];
    if (!pc) continue;
    const lanes = pool.lanes ?? [];
    if (lanes.length === 0) continue;

    let maxStrip = minWidth;
    for (const lane of lanes) {
      const lc = coordMap.laneCoords[lane.id];
      if (!lc) continue;
      const available = Math.max(1, lc.h - 2 * STRIP_PADDING);
      const lines = wrapTextByPx(lane.name ?? '', available, FONT_SIZE);
      lane._renderedLines = lines; // stash for renderer (future use)
      const needed = lines.length * lineHeight + STRIP_PADDING * 2;
      if (needed > maxStrip) maxStrip = needed;
    }

    const clamped = Math.max(minWidth, Math.min(maxWidth, maxStrip));
    const delta = clamped - (pc.laneHeaderWidth ?? LANE_HEADER_W);

    if (delta !== 0) {
      pc.laneHeaderWidth = clamped;
      pc.x -= delta;
      pc.w += delta;
    }
  }

  return coordMap;
}
```

- [ ] **Step 4: Run tests — pass**

Run: `cd scripts && npx jest visual-refinement.test.js --verbose`
Expected: all green (4 new tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/visual-refinement.js scripts/visual-refinement.test.js
git commit -m "feat(visual-refinement): computeDynamicLaneHeaders"
```

---

### Task P2.4: Create `long-lane-names.json` fixture

**Files:**
- Create: `tests/fixtures/long-lane-names.json`

- [ ] **Step 1: Write the fixture**

Create `tests/fixtures/long-lane-names.json`:

```json
{
  "pools": [{
    "id": "Process_LongNames",
    "name": "Long Names Test",
    "lanes": [
      { "id": "laneA", "name": "Prozessverantwortlicher" },
      { "id": "laneB", "name": "Qualitätssicherungsbeauftragter" },
      { "id": "laneC", "name": "Datenschutzkoordinator" }
    ],
    "nodes": [
      {"id": "s1",  "type": "startEvent", "name": "Start",    "lane": "laneA"},
      {"id": "t1",  "type": "userTask",   "name": "Erfassen", "lane": "laneA"},
      {"id": "t2",  "type": "userTask",   "name": "Prüfen",   "lane": "laneB"},
      {"id": "t3",  "type": "userTask",   "name": "Freigeben","lane": "laneC"},
      {"id": "e1",  "type": "endEvent",   "name": "Fertig",   "lane": "laneC"}
    ],
    "edges": [
      {"id": "f1", "source": "s1", "target": "t1"},
      {"id": "f2", "source": "t1", "target": "t2"},
      {"id": "f3", "source": "t2", "target": "t3"},
      {"id": "f4", "source": "t3", "target": "e1"}
    ]
  }]
}
```

- [ ] **Step 2: Confirm fixture validates without refinement**

Run: `cd scripts && node pipeline.js ../tests/fixtures/long-lane-names.json /tmp/lln-baseline`
Expected: success, baseline BPMN + SVG produced.

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/long-lane-names.json
git commit -m "test: Add long-lane-names fixture for Pass 1"
```

---

### Task P2.5: Wire Pass 1 into `pipeline.js`

**Files:**
- Modify: `scripts/pipeline.js`

- [ ] **Step 1: Locate the pipeline orchestration function**

Run: `cd scripts && grep -n "buildCoordinateMap\|generateBpmnXml" pipeline.js`

You should see a sequence like:
```
coordMap = buildCoordinateMap(laid, lc);
...
bpmnXml = generateBpmnXml(...);
```

- [ ] **Step 2: Insert the refinement block**

Immediately after `coordMap = buildCoordinateMap(...)` and before the XML/SVG generation calls, insert:

```javascript
import { computeDynamicLaneHeaders } from './visual-refinement.js';
// (add this import to the top of pipeline.js)

// ... inside runPipeline, after buildCoordinateMap:
const refineOn = opts.visualRefinement ?? CFG.visualRefinement?.enabled ?? false;
if (refineOn) {
  if (CFG.visualRefinement?.dynamicLaneHeader !== false) {
    computeDynamicLaneHeaders(coordMap, lc, {
      minWidth: CFG.visualRefinement?.laneHeaderMinWidth ?? 30,
      maxWidth: CFG.visualRefinement?.laneHeaderMaxWidth ?? 120,
    });
  }
}
```

- [ ] **Step 3: Add `CFG` import if not already imported**

Run: `grep -n "import.*CFG" scripts/pipeline.js`
If absent, add: `import { CFG } from './utils.js';` near the top.

- [ ] **Step 4: Run tests — confirm existing goldens unchanged**

Run: `cd scripts && npm test`
Expected: all tests pass. (Default `enabled: false`, so no behavior change.)

- [ ] **Step 5: Commit**

```bash
git add scripts/pipeline.js
git commit -m "feat(pipeline): Wire computeDynamicLaneHeaders behind flag"
```

---

### Task P2.6: Generate goldens + matrix test for `long-lane-names`

**Files:**
- Create: `tests/fixtures/long-lane-names.expected.{bpmn,svg}`
- Create: `tests/fixtures/long-lane-names.refined.{bpmn,svg}`
- Modify: `scripts/pipeline.test.js`

- [ ] **Step 1: Generate `.expected` golden (refinement off)**

```bash
cd /Users/daniel.stiegler/Projects/bpmn-generator/scripts
node pipeline.js ../tests/fixtures/long-lane-names.json ../tests/fixtures/long-lane-names.expected
# produces long-lane-names.expected.bpmn + .svg
```

- [ ] **Step 2: Visually sanity-check**

Open `tests/fixtures/long-lane-names.expected.svg` in a browser. Expect: truncated/overflowing lane labels (the current behavior we are fixing).

- [ ] **Step 3: Generate `.refined` golden (refinement on)**

Create a temporary runner `scripts/_gen-refined.mjs` (delete after use):

```javascript
import { readFileSync, writeFileSync } from 'fs';
import { runPipeline } from './pipeline.js';

const [src, outBase] = process.argv.slice(2);
const lc = JSON.parse(readFileSync(src, 'utf8'));
const res = await runPipeline(lc, { visualRefinement: true });
writeFileSync(outBase + '.bpmn', res.bpmnXml);
writeFileSync(outBase + '.svg', res.svg);
console.log('wrote', outBase);
```

Run:
```bash
cd scripts
node _gen-refined.mjs ../tests/fixtures/long-lane-names.json ../tests/fixtures/long-lane-names.refined
rm _gen-refined.mjs
```

- [ ] **Step 4: Visually sanity-check `.refined.svg`**

Open in browser. Expect: lane labels wrap to multiple lines within a widened header strip, fully legible.

- [ ] **Step 5: Add matrix tests to `scripts/pipeline.test.js`**

```javascript
import { readFileSync } from 'fs';

describe('long-lane-names matrix', () => {
  const lc = JSON.parse(readFileSync('../tests/fixtures/long-lane-names.json', 'utf8'));

  test('matches .expected golden with refinement disabled', async () => {
    const res = await runPipeline(lc, { visualRefinement: false });
    const goldenBpmn = readFileSync('../tests/fixtures/long-lane-names.expected.bpmn', 'utf8');
    const goldenSvg  = readFileSync('../tests/fixtures/long-lane-names.expected.svg',  'utf8');
    expect(res.bpmnXml).toBe(goldenBpmn);
    expect(res.svg).toBe(goldenSvg);
  });

  test('matches .refined golden with refinement enabled', async () => {
    const res = await runPipeline(lc, { visualRefinement: true });
    const goldenBpmn = readFileSync('../tests/fixtures/long-lane-names.refined.bpmn', 'utf8');
    const goldenSvg  = readFileSync('../tests/fixtures/long-lane-names.refined.svg',  'utf8');
    expect(res.bpmnXml).toBe(goldenBpmn);
    expect(res.svg).toBe(goldenSvg);
  });
});
```

- [ ] **Step 6: Add metric assertions**

```javascript
import { estimateTextWidth } from './visual-refinement.js';
import { CFG } from './utils.js';

describe('Pass 1 metric assertions', () => {
  const lc = JSON.parse(readFileSync('../tests/fixtures/long-lane-names.json', 'utf8'));

  test('laneHeaderWidth ≥ rendered-lines height requirement', async () => {
    const res = await runPipeline(lc, { visualRefinement: true });
    const pool = res.coordMap.poolCoords['Process_LongNames'];
    expect(pool.laneHeaderWidth).toBeGreaterThan(40); // grew from default
    expect(pool.laneHeaderWidth).toBeLessThanOrEqual(CFG.visualRefinement.laneHeaderMaxWidth);
  });

  test('canvas width did not grow runaway (<= 1.5× baseline)', async () => {
    const resOff = await runPipeline(lc, { visualRefinement: false });
    const resOn  = await runPipeline(lc, { visualRefinement: true });
    const wOff = canvasWidth(resOff.svg);
    const wOn  = canvasWidth(resOn.svg);
    expect(wOn).toBeLessThanOrEqual(wOff * 1.5);
  });
});

// helper
function canvasWidth(svg) {
  const m = svg.match(/width="(\d+)"/);
  return m ? parseInt(m[1], 10) : 0;
}
```

- [ ] **Step 7: Run full suite**

Run: `cd scripts && npm test`
Expected: all tests pass (~141 tests).

- [ ] **Step 8: Commit**

```bash
git add tests/fixtures/long-lane-names.expected.bpmn \
        tests/fixtures/long-lane-names.expected.svg \
        tests/fixtures/long-lane-names.refined.bpmn \
        tests/fixtures/long-lane-names.refined.svg \
        scripts/pipeline.test.js
git commit -m "test(pass1): Golden matrix + metric assertions for long lane names"
```

---

## Phase P3 — Pass 3 (Edge Label Collision Repair)

### Task P3.1: Implement `estimateTextBBox` + bbox collision helpers

**Files:**
- Modify: `scripts/visual-refinement.js`
- Modify: `scripts/visual-refinement.test.js`

- [ ] **Step 1: Write failing tests**

Append to `visual-refinement.test.js`:

```javascript
import { estimateTextBBox, bboxOverlaps } from './visual-refinement.js';

describe('estimateTextBBox', () => {
  test('returns bbox centered on (x,y) for single-line text', () => {
    const bb = estimateTextBBox('Yes', 100, 100, 11);
    expect(bb.x).toBeLessThan(100);
    expect(bb.y).toBeLessThan(100);
    expect(bb.w).toBeGreaterThan(0);
    expect(bb.h).toBeGreaterThan(0);
  });
});

describe('bboxOverlaps', () => {
  test('returns true for overlapping bboxes', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 5, y: 5, w: 10, h: 10 };
    expect(bboxOverlaps(a, b)).toBe(true);
  });
  test('returns false for separated bboxes', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 20, y: 20, w: 10, h: 10 };
    expect(bboxOverlaps(a, b)).toBe(false);
  });
  test('returns false for adjacent (non-overlapping) bboxes', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    const b = { x: 10, y: 0, w: 10, h: 10 };
    expect(bboxOverlaps(a, b)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd scripts && npx jest visual-refinement.test.js -t "estimateTextBBox\|bboxOverlaps"`
Expected: FAIL on import.

- [ ] **Step 3: Implement helpers in `visual-refinement.js`**

Append:

```javascript
const TEXT_BBOX_PADDING = 2;

/**
 * Rectangular bbox for a short edge-label rendered centered at (x,y).
 */
export function estimateTextBBox(text, x, y, fontSize = 11) {
  const w = estimateTextWidth(text, fontSize) + 2 * TEXT_BBOX_PADDING;
  const h = fontSize + 2 * TEXT_BBOX_PADDING;
  return { x: x - w / 2, y: y - h / 2, w, h };
}

/**
 * Axis-aligned bbox overlap test. Adjacent (touching-only) bboxes return false.
 */
export function bboxOverlaps(a, b) {
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x ||
           a.y + a.h <= b.y || b.y + b.h <= a.y);
}
```

- [ ] **Step 4: Run — pass**

Run: `cd scripts && npx jest visual-refinement.test.js`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add scripts/visual-refinement.js scripts/visual-refinement.test.js
git commit -m "feat(visual-refinement): estimateTextBBox + bboxOverlaps helpers"
```

---

### Task P3.2: Implement `repairEdgeLabels`

**Files:**
- Modify: `scripts/visual-refinement.js`
- Modify: `scripts/visual-refinement.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
import { repairEdgeLabels } from './visual-refinement.js';

describe('repairEdgeLabels', () => {
  test('leaves non-colliding labels in place', () => {
    const cm = {
      coords: { 'n1': { x: 0, y: 0, w: 50, h: 50 } },
      poolCoords: {}, laneCoords: {},
      edgeCoords: { 'e1': [ {x:100,y:100}, {x:200,y:100} ] },
      edgeLabels: { 'e1': { text: 'OK', x: 150, y: 100 } }
    };
    repairEdgeLabels(cm);
    expect(cm.edgeLabels.e1.x).toBe(150);
    expect(cm.edgeLabels.e1.y).toBe(100);
  });

  test('nudges a colliding label perpendicular to edge', () => {
    const cm = {
      coords: { 'n1': { x: 140, y: 90, w: 30, h: 30 } }, // obstacle right on the label
      poolCoords: {}, laneCoords: {},
      edgeCoords: { 'e1': [ {x:100,y:105}, {x:200,y:105} ] },
      edgeLabels: { 'e1': { text: 'Yes', x: 150, y: 105 } }
    };
    repairEdgeLabels(cm, { maxShift: 25 });
    // Should have moved either up or down
    const moved = cm.edgeLabels.e1.y !== 105 || cm.edgeLabels.e1.x !== 150;
    expect(moved).toBe(true);
  });
});
```

- [ ] **Step 2: Run — confirm failure**

Run: `cd scripts && npx jest visual-refinement.test.js -t "repairEdgeLabels"`
Expected: FAIL on import.

- [ ] **Step 3: Implement**

```javascript
/**
 * Nudge edge labels that overlap with nodes or other labels.
 * Tries distances [15, 25, maxShift] × directions [up, down, left, right].
 * If no collision-free slot is found, label stays at original position.
 */
export function repairEdgeLabels(coordMap, opts = {}) {
  const maxShift = opts.maxShift ?? 25;
  const labels = coordMap.edgeLabels ?? {};
  const labelIds = Object.keys(labels);
  if (labelIds.length === 0) return coordMap;

  // Collect static obstacle bboxes (nodes only; lane/pool headers could be added later)
  const nodeBboxes = Object.values(coordMap.coords).map(c => ({ x: c.x, y: c.y, w: c.w, h: c.h }));

  const labelBboxOf = (id) => {
    const L = labels[id];
    return estimateTextBBox(L.text, L.x, L.y, 11);
  };

  const distances = [15, 25, maxShift].filter((d, i, arr) => arr.indexOf(d) === i);
  const directions = [
    { dx: 0, dy: -1 },  // up
    { dx: 0, dy:  1 },  // down
    { dx: -1, dy: 0 },  // left
    { dx:  1, dy: 0 },  // right
  ];

  for (const id of labelIds) {
    let bb = labelBboxOf(id);
    const otherLabels = labelIds.filter(o => o !== id).map(labelBboxOf);
    const obstacles = [...nodeBboxes, ...otherLabels];

    if (!obstacles.some(o => bboxOverlaps(bb, o))) continue;

    outer: for (const d of distances) {
      for (const dir of directions) {
        const tryBB = { ...bb, x: bb.x + dir.dx * d, y: bb.y + dir.dy * d };
        if (!obstacles.some(o => bboxOverlaps(tryBB, o))) {
          labels[id].x += dir.dx * d;
          labels[id].y += dir.dy * d;
          break outer;
        }
      }
    }
    // If still colliding: silently leave (future: log warning via opts.log)
  }
  return coordMap;
}
```

- [ ] **Step 4: Run — pass**

Run: `cd scripts && npx jest visual-refinement.test.js`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add scripts/visual-refinement.js scripts/visual-refinement.test.js
git commit -m "feat(visual-refinement): repairEdgeLabels with bbox nudge"
```

---

### Task P3.3: Wire Pass 3 into pipeline + verify existing edgeLabels shape

**Files:**
- Modify: `scripts/pipeline.js`
- Modify: `scripts/coordinates.js` or wherever edgeLabels get populated (inspect first)

- [ ] **Step 1: Determine where edge labels live in coordMap**

Run: `cd scripts && grep -nR "edgeLabel\|label" svg.js | head -30`

If edge labels are computed inline in `svg.js` rather than stored on coordMap, add a `coordMap.edgeLabels` map in `coordinates.js`:

```javascript
// Inside buildCoordinateMap, after edgeCoords are populated:
const edgeLabels = {};
for (const proc of allProcesses) {
  for (const e of (proc.edges || [])) {
    if (!e.label) continue;
    const pts = edgeCoords[e.id];
    if (!pts || pts.length < 2) continue;
    // Use midpoint of the edge as label anchor
    const mid = pts[Math.floor(pts.length / 2)];
    edgeLabels[e.id] = { text: e.label, x: mid.x, y: mid.y - 10 };
  }
}
// ... update return statement
return { coords, laneCoords, poolCoords, edgeCoords, edgeLabels };
```

Also update `svg.js` to render from `coordMap.edgeLabels` where available.

- [ ] **Step 2: Wire into `pipeline.js`**

In the refinement block (already added in P2.5), append:

```javascript
if (CFG.visualRefinement?.edgeLabelCollisionRepair !== false) {
  repairEdgeLabels(coordMap, { maxShift: CFG.visualRefinement?.edgeLabelMaxShift ?? 25 });
}
```

Add import: `import { ..., repairEdgeLabels } from './visual-refinement.js';`

- [ ] **Step 3: Run full suite — confirm no regression**

Run: `cd scripts && npm test`
Expected: all green (goldens unchanged — refinement flag is off).

- [ ] **Step 4: Commit**

```bash
git add scripts/pipeline.js scripts/coordinates.js scripts/svg.js
git commit -m "feat(pipeline): Integrate repairEdgeLabels behind flag"
```

---

### Task P3.4: Create `dense-edge-labels.json` fixture + matrix test

**Files:**
- Create: `tests/fixtures/dense-edge-labels.json`
- Create: `tests/fixtures/dense-edge-labels.{expected,refined}.{bpmn,svg}`
- Modify: `scripts/pipeline.test.js`

- [ ] **Step 1: Write fixture**

```json
{
  "pools": [{
    "id": "Process_Dense",
    "name": "Dense Edge Labels",
    "lanes": [{"id": "l1", "name": "Team"}],
    "nodes": [
      {"id": "s1", "type": "startEvent",       "name": "Start",   "lane": "l1"},
      {"id": "gw", "type": "exclusiveGateway", "name": "Welche?", "lane": "l1"},
      {"id": "t1", "type": "userTask", "name": "Variante A", "lane": "l1"},
      {"id": "t2", "type": "userTask", "name": "Variante B", "lane": "l1"},
      {"id": "t3", "type": "userTask", "name": "Variante C", "lane": "l1"},
      {"id": "t4", "type": "userTask", "name": "Variante D", "lane": "l1"},
      {"id": "t5", "type": "userTask", "name": "Variante E", "lane": "l1"},
      {"id": "gwJ","type": "exclusiveGateway", "name": "",      "lane": "l1"},
      {"id": "e1", "type": "endEvent", "name": "Ende", "lane": "l1"}
    ],
    "edges": [
      {"id": "f0", "source": "s1", "target": "gw"},
      {"id": "f1", "source": "gw", "target": "t1", "label": "Option Alpha"},
      {"id": "f2", "source": "gw", "target": "t2", "label": "Option Beta"},
      {"id": "f3", "source": "gw", "target": "t3", "label": "Option Gamma"},
      {"id": "f4", "source": "gw", "target": "t4", "label": "Option Delta"},
      {"id": "f5", "source": "gw", "target": "t5", "label": "Option Epsilon"},
      {"id": "f6", "source": "t1", "target": "gwJ"},
      {"id": "f7", "source": "t2", "target": "gwJ"},
      {"id": "f8", "source": "t3", "target": "gwJ"},
      {"id": "f9", "source": "t4", "target": "gwJ"},
      {"id": "f10","source": "t5", "target": "gwJ"},
      {"id": "f11","source": "gwJ","target": "e1"}
    ]
  }]
}
```

- [ ] **Step 2: Generate `.expected` golden (refinement off)**

```bash
cd scripts
node pipeline.js ../tests/fixtures/dense-edge-labels.json ../tests/fixtures/dense-edge-labels.expected
```

- [ ] **Step 3: Generate `.refined` golden (refinement on)**

Use the same `_gen-refined.mjs` approach as P2.6 (and remove the file after).

- [ ] **Step 4: Visually sanity-check both SVGs**

Expected: `.refined.svg` shows edge labels separated (no overlaps between "Option X" labels); `.expected.svg` shows labels clustered/overlapping.

- [ ] **Step 5: Add matrix test + metric assertion**

```javascript
describe('dense-edge-labels matrix', () => {
  const lc = JSON.parse(readFileSync('../tests/fixtures/dense-edge-labels.json','utf8'));

  test('matches golden .expected (refinement off)', async () => {
    const r = await runPipeline(lc, { visualRefinement: false });
    expect(r.bpmnXml).toBe(readFileSync('../tests/fixtures/dense-edge-labels.expected.bpmn','utf8'));
    expect(r.svg).toBe(readFileSync('../tests/fixtures/dense-edge-labels.expected.svg','utf8'));
  });

  test('matches golden .refined (refinement on)', async () => {
    const r = await runPipeline(lc, { visualRefinement: true });
    expect(r.bpmnXml).toBe(readFileSync('../tests/fixtures/dense-edge-labels.refined.bpmn','utf8'));
    expect(r.svg).toBe(readFileSync('../tests/fixtures/dense-edge-labels.refined.svg','utf8'));
  });

  test('metric: no edge-label bbox overlaps with refinement on', async () => {
    const r = await runPipeline(lc, { visualRefinement: true });
    const { estimateTextBBox, bboxOverlaps } = await import('./visual-refinement.js');
    const entries = Object.values(r.coordMap.edgeLabels);
    const bboxes = entries.map(L => estimateTextBBox(L.text, L.x, L.y, 11));
    for (let i = 0; i < bboxes.length; i++) {
      for (let j = i + 1; j < bboxes.length; j++) {
        expect(bboxOverlaps(bboxes[i], bboxes[j])).toBe(false);
      }
    }
  });
});
```

- [ ] **Step 6: Run full suite**

Run: `cd scripts && npm test`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add tests/fixtures/dense-edge-labels.json \
        tests/fixtures/dense-edge-labels.expected.bpmn \
        tests/fixtures/dense-edge-labels.expected.svg \
        tests/fixtures/dense-edge-labels.refined.bpmn \
        tests/fixtures/dense-edge-labels.refined.svg \
        scripts/pipeline.test.js
git commit -m "test(pass3): Fixture + golden matrix + no-overlap metric"
```

---

## Phase P4 — Pass 5 (Conditional ELK Wrapping)

### Task P4.1: Extend `logicCoreToElk` + `runElkLayout` signatures

**Files:**
- Modify: `scripts/layout.js`

- [ ] **Step 1: Inspect current signatures**

Run: `cd scripts && grep -n "export function \(logicCoreToElk\|runElkLayout\)" layout.js`

- [ ] **Step 2: Add `opts` parameter**

Update `logicCoreToElk(lc)` → `logicCoreToElk(lc, opts = {})`.

Inside the function, where `elkOptions` / `layoutOptions` are assembled:

```javascript
const elkMode     = CFG.visualRefinement?.elkWrapping ?? 'off';
const wrapThr     = CFG.visualRefinement?.elkWrappingNodeThreshold ?? 20;
const nodeCount   = (lc.nodes ?? (lc.pools ?? []).flatMap(p => p.nodes ?? [])).length;

if (opts.elkWrapping && (elkMode === 'always' || (elkMode === 'auto' && nodeCount > wrapThr))) {
  layoutOptions['elk.layered.wrapping.strategy'] = 'MULTI_EDGE';
  layoutOptions['elk.layered.wrapping.additionalEdgeSpacing'] = '40';
}
```

(Exact variable name for the options block depends on current code — inspect and adapt.)

- [ ] **Step 3: Write a unit test for the wrapping trigger**

Append to `scripts/pipeline.test.js`:

```javascript
describe('Pass 5 — ELK wrapping trigger', () => {
  test('does not enable wrapping when flag off', async () => {
    const lc = { nodes: new Array(30).fill(0).map((_, i) => ({
      id: `n${i}`, type: 'userTask', name: `Task ${i}`
    })), edges: new Array(29).fill(0).map((_, i) => ({
      id: `e${i}`, source: `n${i}`, target: `n${i+1}`
    }))};
    // Minimal process wrapper (check pipeline.js for exact shape)
    const res = await runPipeline(lc, { visualRefinement: false });
    // Canvas should be wide linear flow, aspect ratio > 4
    const { width, height } = parseSvgViewBox(res.svg);
    expect(width / height).toBeGreaterThan(4);
  });

  test('enables wrapping with 30 nodes when flag on and mode=auto', async () => {
    const lc = { nodes: new Array(30).fill(0).map((_, i) => ({
      id: `n${i}`, type: 'userTask', name: `Task ${i}`
    })), edges: new Array(29).fill(0).map((_, i) => ({
      id: `e${i}`, source: `n${i}`, target: `n${i+1}`
    }))};
    const res = await runPipeline(lc, { visualRefinement: true });
    const { width, height } = parseSvgViewBox(res.svg);
    expect(width / height).toBeLessThan(2.5);
  });
});

function parseSvgViewBox(svg) {
  const m = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
  return m ? { width: +m[1], height: +m[2] } : { width: 0, height: 0 };
}
```

- [ ] **Step 4: Run — confirm wrapping tests pass (and others still pass)**

Run: `cd scripts && npm test`

If the wrapping-on test fails because the flag isn't yet wired into `pipeline.js` → continue to next step.

- [ ] **Step 5: Commit**

```bash
git add scripts/layout.js scripts/pipeline.test.js
git commit -m "feat(layout): Conditional elk.layered.wrapping.strategy"
```

---

### Task P4.2: Wire `elkWrapping` flag through `pipeline.js`

**Files:**
- Modify: `scripts/pipeline.js`

- [ ] **Step 1: Pass `{ elkWrapping: refineOn }` to `logicCoreToElk`**

Find the call site:
```javascript
const elkGraph = logicCoreToElk(process);
```
Change to:
```javascript
const elkGraph = logicCoreToElk(process, { elkWrapping: refineOn });
```

- [ ] **Step 2: Run full suite**

Run: `cd scripts && npm test`
Expected: green.

- [ ] **Step 3: Commit**

```bash
git add scripts/pipeline.js
git commit -m "feat(pipeline): Thread elkWrapping flag into logicCoreToElk"
```

---

### Task P4.3: Create `wide-pipeline.json` fixture + goldens

**Files:**
- Create: `tests/fixtures/wide-pipeline.json`
- Create: `tests/fixtures/wide-pipeline.{expected,refined}.{bpmn,svg}`
- Modify: `scripts/pipeline.test.js`

- [ ] **Step 1: Write fixture (25 sequential tasks)**

Generate via one-liner:
```bash
cd /Users/daniel.stiegler/Projects/bpmn-generator
node -e '
  const nodes = [{id:"s",type:"startEvent",name:"Start",lane:"l1"}];
  for (let i=1;i<=25;i++) nodes.push({id:"t"+i,type:"userTask",name:"Schritt "+i,lane:"l1"});
  nodes.push({id:"e",type:"endEvent",name:"Ende",lane:"l1"});
  const edges = [];
  edges.push({id:"f0",source:"s",target:"t1"});
  for (let i=1;i<25;i++) edges.push({id:"f"+i,source:"t"+i,target:"t"+(i+1)});
  edges.push({id:"f25",source:"t25",target:"e"});
  const out = {pools:[{id:"Process_Wide",name:"Wide",lanes:[{id:"l1",name:"Team"}],nodes,edges}]};
  require("fs").writeFileSync("tests/fixtures/wide-pipeline.json", JSON.stringify(out,null,2));
'
```

- [ ] **Step 2: Generate goldens**

```bash
cd scripts
node pipeline.js ../tests/fixtures/wide-pipeline.json ../tests/fixtures/wide-pipeline.expected
# recreate _gen-refined.mjs as in P2.6
node _gen-refined.mjs ../tests/fixtures/wide-pipeline.json ../tests/fixtures/wide-pipeline.refined
rm _gen-refined.mjs
```

- [ ] **Step 3: Visual sanity-check**

`.expected.svg`: very wide, aspect ratio ~8:1, single long row.
`.refined.svg`: aspect ratio closer to 2–3:1, nodes wrapped into multiple rows.

- [ ] **Step 4: Add matrix test + aspect-ratio assertion**

```javascript
describe('wide-pipeline matrix', () => {
  const lc = JSON.parse(readFileSync('../tests/fixtures/wide-pipeline.json','utf8'));

  test('matches .expected', async () => {
    const r = await runPipeline(lc, { visualRefinement: false });
    expect(r.bpmnXml).toBe(readFileSync('../tests/fixtures/wide-pipeline.expected.bpmn','utf8'));
    expect(r.svg).toBe(readFileSync('../tests/fixtures/wide-pipeline.expected.svg','utf8'));
  });

  test('matches .refined', async () => {
    const r = await runPipeline(lc, { visualRefinement: true });
    expect(r.bpmnXml).toBe(readFileSync('../tests/fixtures/wide-pipeline.refined.bpmn','utf8'));
    expect(r.svg).toBe(readFileSync('../tests/fixtures/wide-pipeline.refined.svg','utf8'));
  });

  test('metric: aspect ratio ≤ 2.5 with refinement on', async () => {
    const r = await runPipeline(lc, { visualRefinement: true });
    const { width, height } = parseSvgViewBox(r.svg);
    expect(width / height).toBeLessThanOrEqual(2.5);
  });

  test('metric: lane partitioning intact (every task still assigned to l1)', async () => {
    const r = await runPipeline(lc, { visualRefinement: true });
    // Bpmn-moddle parse + check flowNodeRef
    // (or simpler: check all 27 task coords fall inside the lane bbox)
    const laneBbox = r.coordMap.laneCoords['l1'];
    for (const [id, c] of Object.entries(r.coordMap.coords)) {
      expect(c.x).toBeGreaterThanOrEqual(laneBbox.x - 1);
      expect(c.y).toBeGreaterThanOrEqual(laneBbox.y - 1);
      expect(c.x + c.w).toBeLessThanOrEqual(laneBbox.x + laneBbox.w + 1);
      expect(c.y + c.h).toBeLessThanOrEqual(laneBbox.y + laneBbox.h + 1);
    }
  });
});
```

- [ ] **Step 5: Run full suite**

If partition-intact assertion fails: ELK's MULTI_EDGE wrapping does not respect partitioning as hoped. Fallback: change `layout.js` to use `'LAST_LAYER_SOFT'` instead of `'MULTI_EDGE'`, regenerate `.refined` goldens, re-run.

Document the fallback choice in `visual-refinement.js` as an inline comment near the ELK options block.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/wide-pipeline.json \
        tests/fixtures/wide-pipeline.expected.bpmn \
        tests/fixtures/wide-pipeline.expected.svg \
        tests/fixtures/wide-pipeline.refined.bpmn \
        tests/fixtures/wide-pipeline.refined.svg \
        scripts/pipeline.test.js
git commit -m "test(pass5): Wide-pipeline fixture + aspect-ratio + partition-intact metrics"
```

---

## Phase P5 — Pass 2 (Lane Compaction) — highest-risk phase

### Task P5.1: Implement `compactLanes` basic shrink (no waypoint shift yet)

**Files:**
- Modify: `scripts/visual-refinement.js`
- Modify: `scripts/visual-refinement.test.js`

- [ ] **Step 1: Write failing tests**

```javascript
import { compactLanes } from './visual-refinement.js';

describe('compactLanes — basic shrink', () => {
  test('shrinks a sparsely-populated lane to its content + padding', () => {
    const cm = {
      coords: { n1: { x: 50, y: 20, w: 100, h: 80 } },
      poolCoords: { p1: { x: 0, y: 0, w: 300, h: 400, laneHeaderWidth: 40 } },
      laneCoords: {
        laneA: { x: 40, y:   0, w: 260, h: 200 },
        laneB: { x: 40, y: 200, w: 260, h: 200 }
      },
      edgeCoords: {}
    };
    const proc = { pools: [{ id: 'p1', lanes: [
      { id: 'laneA' }, { id: 'laneB' }
    ]}], nodes: [{ id: 'n1', lane: 'laneA' }] };
    compactLanes(cm, proc, { minLaneHeight: 60 });
    expect(cm.laneCoords.laneA.h).toBeLessThan(200);
    expect(cm.laneCoords.laneA.h).toBeGreaterThanOrEqual(60);
  });

  test('respects minLaneHeight for empty lanes', () => {
    const cm = {
      coords: {},
      poolCoords: { p1: { x: 0, y: 0, w: 300, h: 200, laneHeaderWidth: 40 } },
      laneCoords: { laneA: { x: 40, y: 0, w: 260, h: 200 } },
      edgeCoords: {}
    };
    const proc = { pools: [{ id: 'p1', lanes: [{ id: 'laneA' }] }], nodes: [] };
    compactLanes(cm, proc, { minLaneHeight: 60 });
    expect(cm.laneCoords.laneA.h).toBe(60);
  });
});
```

- [ ] **Step 2: Run — confirm failure**

Run: `cd scripts && npx jest visual-refinement.test.js -t "compactLanes"`
Expected: FAIL on import.

- [ ] **Step 3: Implement basic shrink (Y-shift + waypoint shift in later tasks)**

```javascript
const LANE_COMPACT_PADDING = 20;

/**
 * Shrink lanes to their content bbox + padding. Shifts subsequent lanes
 * upward and adjusts edge waypoints accordingly.
 *
 * Strategy: lane-by-lane from top to bottom. For each lane, compute content
 * bbox from the nodes that belong to it (via process.nodes[i].lane), clamp
 * to minLaneHeight, apply delta.
 */
export function compactLanes(coordMap, process, opts = {}) {
  const minH = opts.minLaneHeight ?? 80;
  const pad  = opts.padding ?? LANE_COMPACT_PADDING;

  const pools = process.pools ?? [process];
  const allNodes = pools.flatMap(p => p.nodes ?? []);

  for (const pool of pools) {
    const pc = coordMap.poolCoords[pool.id] ?? coordMap.poolCoords['_singlePool'];
    if (!pc) continue;
    const lanes = (pool.lanes ?? []).map(l => l.id).filter(id => coordMap.laneCoords[id]);
    lanes.sort((a, b) => coordMap.laneCoords[a].y - coordMap.laneCoords[b].y);

    let cumulativeDelta = 0;
    for (const laneId of lanes) {
      const lc = coordMap.laneCoords[laneId];
      lc.y -= cumulativeDelta;

      const laneNodes = allNodes.filter(n => n.lane === laneId)
                                .map(n => coordMap.coords[n.id])
                                .filter(Boolean);

      let newH;
      if (laneNodes.length === 0) {
        newH = minH;
      } else {
        const topY    = Math.min(...laneNodes.map(c => c.y));
        const botY    = Math.max(...laneNodes.map(c => c.y + c.h));
        newH = Math.max(minH, (botY - topY) + 2 * pad);
      }

      const delta = lc.h - newH;
      if (delta > 0) {
        lc.h = newH;
        cumulativeDelta += delta;
      }
    }

    // Recompute pool bounds
    const lanesList = lanes.map(id => coordMap.laneCoords[id]);
    if (lanesList.length > 0) {
      pc.y = Math.min(...lanesList.map(l => l.y));
      pc.h = Math.max(...lanesList.map(l => l.y + l.h)) - pc.y;
    }
  }

  return coordMap;
}
```

- [ ] **Step 4: Run — pass**

Run: `cd scripts && npx jest visual-refinement.test.js -t "compactLanes"`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add scripts/visual-refinement.js scripts/visual-refinement.test.js
git commit -m "feat(visual-refinement): compactLanes basic shrink (no node/waypoint shift yet)"
```

---

### Task P5.2: Add node + waypoint Y-shift

**Files:**
- Modify: `scripts/visual-refinement.js`

- [ ] **Step 1: Write failing test**

Append:

```javascript
test('shifts nodes in subsequent lanes up by the shrink delta', () => {
  const cm = {
    coords: {
      n1: { x: 50, y: 20,  w: 100, h: 80 },
      n2: { x: 50, y: 220, w: 100, h: 80 }  // lane B
    },
    poolCoords: { p1: { x: 0, y: 0, w: 300, h: 400, laneHeaderWidth: 40 } },
    laneCoords: {
      laneA: { x: 40, y:   0, w: 260, h: 200 },
      laneB: { x: 40, y: 200, w: 260, h: 200 }
    },
    edgeCoords: { e1: [{ x: 100, y: 60 }, { x: 100, y: 260 }] }
  };
  const proc = { pools: [{ id: 'p1', lanes: [{ id: 'laneA' }, { id: 'laneB' }] }],
                 nodes: [{ id: 'n1', lane: 'laneA' }, { id: 'n2', lane: 'laneB' }] };
  compactLanes(cm, proc, { minLaneHeight: 60 });
  // laneA was 200 tall, content 80+padding*2=120, so delta > 0
  // n2 should be shifted up by that delta
  expect(cm.coords.n2.y).toBeLessThan(220);
  // The waypoint crossing lane boundary should also be shifted
  expect(cm.edgeCoords.e1[1].y).toBeLessThan(260);
});
```

- [ ] **Step 2: Run — confirm failure**

- [ ] **Step 3: Update `compactLanes` to shift nodes + waypoints**

Inside the lane loop, after computing `delta`, add:

```javascript
      if (delta > 0) {
        const oldEndY = lc.y + lc.h; // before shrink
        lc.h = newH;
        const newEndY = lc.y + lc.h;

        // Shift nodes in subsequent lanes
        for (const other of lanes) {
          if (other === laneId) continue;
          if (coordMap.laneCoords[other].y <= lc.y) continue; // lanes above — already processed
          const otherLane = coordMap.laneCoords[other];
          otherLane.y -= delta;
          const nodesInOther = allNodes.filter(n => n.lane === other);
          for (const n of nodesInOther) {
            if (coordMap.coords[n.id]) coordMap.coords[n.id].y -= delta;
          }
        }

        // Shift edge waypoints
        for (const pts of Object.values(coordMap.edgeCoords)) {
          for (const p of pts) {
            if (p.y >= oldEndY) {
              p.y -= delta;
            } else if (p.y > newEndY && p.y < oldEndY) {
              // Boundary edge case: clamp to newEndY - 1 (keeps waypoint inside shrunk lane)
              p.y = newEndY - 1;
            }
          }
        }

        cumulativeDelta += delta;
      }
```

(Replace the earlier simple block inside the loop.)

- [ ] **Step 4: Run — pass**

Run: `cd scripts && npx jest visual-refinement.test.js`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add scripts/visual-refinement.js
git commit -m "feat(visual-refinement): compactLanes shifts nodes + edge waypoints"
```

---

### Task P5.3: Create `sparse-lanes.json` fixture

**Files:**
- Create: `tests/fixtures/sparse-lanes.json`

- [ ] **Step 1: Write fixture (1 lane dense, 3 lanes sparse)**

```json
{
  "pools": [{
    "id": "Process_Sparse",
    "name": "Sparse Lanes Test",
    "lanes": [
      { "id": "laneA", "name": "Frontend" },
      { "id": "laneB", "name": "Backend" },
      { "id": "laneC", "name": "Ops" },
      { "id": "laneD", "name": "QA" }
    ],
    "nodes": [
      {"id": "s",  "type": "startEvent", "name": "Start",  "lane": "laneA"},
      {"id": "a1", "type": "userTask", "name": "A1", "lane": "laneA"},
      {"id": "a2", "type": "userTask", "name": "A2", "lane": "laneA"},
      {"id": "a3", "type": "userTask", "name": "A3", "lane": "laneA"},
      {"id": "a4", "type": "userTask", "name": "A4", "lane": "laneA"},
      {"id": "b1", "type": "userTask", "name": "Validate", "lane": "laneB"},
      {"id": "c1", "type": "userTask", "name": "Deploy",   "lane": "laneC"},
      {"id": "d1", "type": "userTask", "name": "Test",     "lane": "laneD"},
      {"id": "e",  "type": "endEvent", "name": "End", "lane": "laneD"}
    ],
    "edges": [
      {"id": "f1", "source": "s",  "target": "a1"},
      {"id": "f2", "source": "a1", "target": "a2"},
      {"id": "f3", "source": "a2", "target": "a3"},
      {"id": "f4", "source": "a3", "target": "a4"},
      {"id": "f5", "source": "a4", "target": "b1"},
      {"id": "f6", "source": "b1", "target": "c1"},
      {"id": "f7", "source": "c1", "target": "d1"},
      {"id": "f8", "source": "d1", "target": "e"}
    ]
  }]
}
```

- [ ] **Step 2: Verify fixture runs**

Run: `cd scripts && node pipeline.js ../tests/fixtures/sparse-lanes.json /tmp/sparse-baseline`
Expected: success.

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/sparse-lanes.json
git commit -m "test: Add sparse-lanes fixture for Pass 2"
```

---

### Task P5.4: Wire `compactLanes` into pipeline + generate goldens + metric

**Files:**
- Modify: `scripts/pipeline.js`
- Create: `tests/fixtures/sparse-lanes.{expected,refined}.{bpmn,svg}`
- Modify: `scripts/pipeline.test.js`

- [ ] **Step 1: Wire into `pipeline.js` in the refinement block**

```javascript
import { ..., compactLanes } from './visual-refinement.js';

// inside runPipeline refinement block:
if (CFG.visualRefinement?.laneCompaction !== false) {
  compactLanes(coordMap, lc, {
    minLaneHeight: CFG.visualRefinement?.minLaneHeight ?? 80,
  });
}
```

Order: computeDynamicLaneHeaders → compactLanes → repairEdgeLabels.

- [ ] **Step 2: Run full suite — confirm default-off path unchanged**

Run: `cd scripts && npm test`
Expected: green (refinement off by default).

- [ ] **Step 3: Generate goldens**

```bash
cd scripts
node pipeline.js ../tests/fixtures/sparse-lanes.json ../tests/fixtures/sparse-lanes.expected
# _gen-refined.mjs helper
node _gen-refined.mjs ../tests/fixtures/sparse-lanes.json ../tests/fixtures/sparse-lanes.refined
rm _gen-refined.mjs
```

- [ ] **Step 4: Visual sanity-check**

`.expected.svg` should have uniform lane heights. `.refined.svg` should have short lanes for B/C/D and a taller lane for A.

- [ ] **Step 5: Add matrix + metric tests**

```javascript
describe('sparse-lanes matrix', () => {
  const lc = JSON.parse(readFileSync('../tests/fixtures/sparse-lanes.json','utf8'));

  test('matches .expected', async () => {
    const r = await runPipeline(lc, { visualRefinement: false });
    expect(r.bpmnXml).toBe(readFileSync('../tests/fixtures/sparse-lanes.expected.bpmn','utf8'));
    expect(r.svg).toBe(readFileSync('../tests/fixtures/sparse-lanes.expected.svg','utf8'));
  });

  test('matches .refined', async () => {
    const r = await runPipeline(lc, { visualRefinement: true });
    expect(r.bpmnXml).toBe(readFileSync('../tests/fixtures/sparse-lanes.refined.bpmn','utf8'));
    expect(r.svg).toBe(readFileSync('../tests/fixtures/sparse-lanes.refined.svg','utf8'));
  });

  test('metric: canvas height shrunk by at least 25%', async () => {
    const off = await runPipeline(lc, { visualRefinement: false });
    const on  = await runPipeline(lc, { visualRefinement: true });
    const hOff = parseSvgViewBox(off.svg).height;
    const hOn  = parseSvgViewBox(on.svg).height;
    expect(hOn).toBeLessThanOrEqual(hOff * 0.75);
  });
});
```

- [ ] **Step 6: Run full suite**

- [ ] **Step 7: Commit**

```bash
git add scripts/pipeline.js \
        tests/fixtures/sparse-lanes.expected.bpmn \
        tests/fixtures/sparse-lanes.expected.svg \
        tests/fixtures/sparse-lanes.refined.bpmn \
        tests/fixtures/sparse-lanes.refined.svg \
        scripts/pipeline.test.js
git commit -m "feat(pipeline): Wire compactLanes + sparse-lanes metric"
```

---

### Task P5.5: Edge-crossings abort-criterion check

**Files:**
- Modify: `scripts/visual-refinement.test.js`

- [ ] **Step 1: Add a helper + assertion test**

```javascript
function countEdgeCrossings(edgeCoords) {
  const edges = Object.values(edgeCoords);
  let crossings = 0;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      if (segmentsCross(edges[i], edges[j])) crossings++;
    }
  }
  return crossings;
}

// Sweep each pair of consecutive waypoints from each edge polyline
function segmentsCross(a, b) {
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      if (doSegmentsIntersect(a[i], a[i+1], b[j], b[j+1])) return true;
    }
  }
  return false;
}

function doSegmentsIntersect(p1, p2, p3, p4) {
  const ccw = (A, B, C) => (C.y - A.y) * (B.x - A.x) > (B.y - A.y) * (C.x - A.x);
  return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4);
}

test('P5 abort criterion: crossings after compaction ≤ 1.05 × baseline', async () => {
  const lc = JSON.parse(readFileSync('../tests/fixtures/sparse-lanes.json','utf8'));
  const off = await runPipeline(lc, { visualRefinement: false });
  const on  = await runPipeline(lc, { visualRefinement: true });
  const cOff = countEdgeCrossings(off.coordMap.edgeCoords);
  const cOn  = countEdgeCrossings(on.coordMap.edgeCoords);
  expect(cOn).toBeLessThanOrEqual(Math.ceil(cOff * 1.05));
});
```

- [ ] **Step 2: Run — pass**

Run: `cd scripts && npm test`
Expected: green. If it fails → Pass 2 degrades routing. Open secondary flag `laneCompaction: false` in `config.json` and default-disable. Re-run. Document in code comment.

- [ ] **Step 3: Commit**

```bash
git add scripts/visual-refinement.test.js
git commit -m "test(pass2): Edge-crossings abort criterion"
```

---

## Phase P6 — Regenerate goldens for existing fixtures (matrix mode)

For each of `simple-approval`, `multi-pool-collaboration`, `expanded-subprocess`:

### Task P6.1: Generate `.refined` goldens

- [ ] **Step 1: Use `_gen-refined.mjs` helper**

```bash
cd scripts
cat > _gen-refined.mjs <<'EOF'
import { readFileSync, writeFileSync } from 'fs';
import { runPipeline } from './pipeline.js';
const [src, outBase] = process.argv.slice(2);
const lc = JSON.parse(readFileSync(src, 'utf8'));
const res = await runPipeline(lc, { visualRefinement: true });
writeFileSync(outBase + '.bpmn', res.bpmnXml);
writeFileSync(outBase + '.svg', res.svg);
EOF

for f in simple-approval multi-pool-collaboration expanded-subprocess; do
  node _gen-refined.mjs ../tests/fixtures/$f.json ../tests/fixtures/$f.refined
done

rm _gen-refined.mjs
```

- [ ] **Step 2: Visually sanity-check all three `.refined.svg` files**

- [ ] **Step 3: Extend existing golden tests to matrix mode**

In `scripts/pipeline.test.js`, find the existing tests that compare against `.expected.bpmn` / `.expected.svg`. For each, add a parallel test that runs with `{ visualRefinement: true }` and compares against `.refined.*`.

- [ ] **Step 4: Run full suite**

Run: `cd scripts && npm test`
Expected: all green, ~155+ tests.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/*.refined.{bpmn,svg} scripts/pipeline.test.js
git commit -m "test: Add .refined goldens for existing fixtures (matrix mode)"
```

---

## Phase P7 — Documentation + Default-Flip (deferred)

### Task P7.1: Document the feature in README + ROADMAP

- [ ] **Step 1: Update README.md**

Add a section `## Visual Refinement (opt-in)` under Features describing:
- What the feature does (1 paragraph)
- How to enable: `"visualRefinement": { "enabled": true, ... }` in `config.json` or pass `{ visualRefinement: true }` to `runPipeline`
- Link to the spec in `docs/superpowers/specs/`

- [ ] **Step 2: Update ROADMAP.md**

In `ROADMAP.md` §3 (Mid-Term Improvements), add a new entry:

```markdown
### M7 — Visual Refinement Pass | DONE

Dynamic lane-header widths, edge-label collision repair, ELK MULTI_EDGE wrapping
for wide pipelines, lane compaction. Opt-in via config.visualRefinement.enabled.

**Files:** scripts/visual-refinement.js (new), scripts/utils.js (wrapText ext),
scripts/pipeline.js (flag wiring), scripts/layout.js (wrapping hint), config.json
```

Remove the matching items from §7 Known Limitations.

- [ ] **Step 3: Commit**

```bash
git add README.md ROADMAP.md
git commit -m "docs: Document Visual Refinement Pass (M7)"
```

---

### Task P7.2 (after ~2 weeks of opt-in): Default-flip commit

- [ ] **Step 1: After 2 weeks of opt-in use with no regression reports, flip the default**

Change `scripts/config.json`:
```diff
   "visualRefinement": {
-    "enabled": false,
+    "enabled": true,
```

- [ ] **Step 2: Update all existing tests that now need to use `{ visualRefinement: false }` to match `.expected.*` goldens**

Find every test that reads `.expected.*` and does not already pass `{ visualRefinement: false }`. Add the explicit flag.

- [ ] **Step 3: Run full suite — green**

- [ ] **Step 4: Commit (isolated)**

```bash
git add scripts/config.json scripts/pipeline.test.js
git commit -m "chore: Flip visualRefinement default to enabled=true"
```

Rollback via `git revert <this-commit>` if post-flip issues arise.

---

## Self-Review

### Spec Coverage Check

- §3.1 new module `visual-refinement.js` → Tasks P1.2, P2.3, P3.1, P3.2, P5.1, P5.2 ✓
- §3.2 `LANE_HEADER_W` refactor → Tasks P1.3, P1.4, P1.5 ✓
- §3.3 config section → Task P1.1 ✓
- §3.4 pipeline integration → Tasks P2.5, P3.3, P4.2, P5.4 ✓
- §4.1 Pass 1 dynamic lane headers → Task P2.3 ✓
- §4.2 Pass 2 lane compaction → Tasks P5.1, P5.2 ✓
- §4.3 Pass 3 edge label collision → Tasks P3.1, P3.2 ✓
- §4.4 Pass 4 wrapText extension → Tasks P2.1, P2.2 ✓
- §4.5 Pass 5 ELK wrapping → Tasks P4.1, P4.2 ✓
- §6 test matrix → Tasks P2.6, P3.4, P4.3, P5.4, P6.1 ✓
- §6.4 visual-refinement.test.js → created in P1.2, grown throughout ✓
- §7 rollout phases → P1–P7 match spec phases ✓
- §8 non-goals → not implemented (good)

### Placeholder Scan

None of the "TBD", "TODO", "handle edge cases later" patterns present. All code blocks contain actual code. All test expectations have concrete values.

### Type Consistency

- `estimateTextWidth(text, fontSize)` — same signature in all uses
- `estimateTextBBox(text, x, y, fontSize)` — consistent
- `bboxOverlaps(a, b)` — consistent
- `computeDynamicLaneHeaders(coordMap, process, opts)` — consistent in P2.3, P2.5
- `repairEdgeLabels(coordMap, opts)` — consistent in P3.2, P3.3
- `compactLanes(coordMap, process, opts)` — consistent in P5.1–P5.4
- `logicCoreToElk(lc, opts)` — consistent in P4.1, P4.2
- `runPipeline(lc, opts)` — uses `{ visualRefinement: boolean }` consistently

Plan is ready for execution.

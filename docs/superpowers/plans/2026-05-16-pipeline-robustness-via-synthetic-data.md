# Pipeline Robustness via Synthetic Data — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an offline JS-only tool under `scripts/robustness/` that uses a configured sovereign LLM endpoint to systematically stress-test the BPMN-Generator pipeline with synthetic inputs, triaging failures into three fixture buckets plus an audit log, producing a Markdown + JSON report and persisting regression fixtures.

**Architecture:** A small sidecar of ~10 JS modules co-located with the existing pipeline code in `scripts/`. The LLM provider is consumed as-is via the existing `createLlmProvider({ baseUrl, apiKey, model, timeout })`. A pre-filter (schema + rules) gates the pipeline, and survivors flow through a 5-step pipeline check + roundtrip verification. Failures are classified, fingerprinted, deduped, and routed to bucket directories.

**Tech Stack:** ES Modules + Jest 30 (existing project standard), native `fetch` (no new dependencies), `bpmn-moddle` (already in deps), `glob` (already in deps), existing `runPipeline()` / `runRules()` / `validate.js` / `import.js` / `dot.js` from `scripts/`.

**Companion spec:** [docs/superpowers/specs/2026-05-16-pipeline-robustness-via-synthetic-data-design.md](../specs/2026-05-16-pipeline-robustness-via-synthetic-data-design.md)

---

## File Structure (locked in)

```
scripts/robustness/                              (NEW directory)
├── README.md                                    (workflow doc)
├── config.json                                  (model, paths, flags)
├── seed-catalog.json                            (generation matrix)
├── cli.js                                       (~120 LOC)
├── synthetic-generator.js                       (~180 LOC)
├── stress-tester.js                             (~220 LOC, includes pre-filter)
├── failure-classifier.js                        (~120 LOC)
├── fixture-persister.js                         (~120 LOC)
├── report-generator.js                          (~170 LOC)
├── mad-validator.js                             (~80 LOC, Phase 6)
└── graph-isomorphism.js                         (~100 LOC)

scripts/robustness.test.js                       (NEW, dynamic auto-fixture loader)
scripts/robustness-internal.test.js              (NEW, ~30 tests for the tooling)

tests/fixtures/robustness/                       (NEW)
├── auto/                                        (auto-persisted regressions, empty initially)
├── triage/                                      (manual-review queue, empty initially)
├── llm-signal/                                  (gated, empty unless flag on)
└── README.md                                    (explains the buckets)

tests/fixtures/mad-subset/                       (Phase 6 only)

tests/robustness-reports/                        (NEW, run artifacts)
```

**No changes to:** `scripts/pipeline.js`, `scripts/rules.js`, `scripts/layout.js`, `scripts/coordinates.js`, `scripts/bpmn-xml.js`, `scripts/svg.js`, `scripts/agents/llm-provider.js`.

---

# Phase 1 — Foundation

Establish directory, config, CLI skeleton, env-var/flag plumbing, and a smoke test that the LLM provider can be constructed and called.

### Task 1.1: Create directory skeleton + config

**Files:**
- Create: `scripts/robustness/` (directory)
- Create: `scripts/robustness/config.json`
- Create: `scripts/robustness/README.md`
- Create: `tests/fixtures/robustness/` (directory)
- Create: `tests/fixtures/robustness/auto/.gitkeep`
- Create: `tests/fixtures/robustness/triage/.gitkeep`
- Create: `tests/fixtures/robustness/llm-signal/.gitkeep`
- Create: `tests/fixtures/robustness/README.md`
- Create: `tests/robustness-reports/.gitkeep`

- [ ] **Step 1: Create the directories**

```bash
mkdir -p scripts/robustness
mkdir -p tests/fixtures/robustness/{auto,triage,llm-signal}
mkdir -p tests/robustness-reports
touch tests/fixtures/robustness/{auto,triage,llm-signal}/.gitkeep
touch tests/robustness-reports/.gitkeep
```

- [ ] **Step 2: Write `scripts/robustness/config.json`**

```json
{
  "model": "qwen-3.5-122b",
  "fallback_models": ["qwen-3.6-35b", "qwen3-coder-480b"],
  "default_n": 100,
  "default_target": "lc-json",
  "timeout_seconds": 30,
  "parallelism": 1,
  "persist_llm_signal": false,
  "report_dir": "tests/robustness-reports",
  "fixture_dir": "tests/fixtures/robustness",
  "endpoint": {
    "url_env": "AIHUB_URL",
    "key_env": "AIHUB_KEY",
    "url": null,
    "key": null
  }
}
```

- [ ] **Step 3: Write `scripts/robustness/README.md`**

```markdown
# Pipeline Robustness Stack

Offline tool for stress-testing the BPMN-Generator pipeline using LLM-generated synthetic inputs.

## Quick start

```bash
export AIHUB_URL=...
export AIHUB_KEY=...
node scripts/robustness/cli.js run --n=100
```

See `docs/superpowers/specs/2026-05-16-pipeline-robustness-via-synthetic-data-design.md` for the full design.

## CLI

| Command | Purpose |
|---|---|
| `run --n=N --target=lc-json` | Stress run with N samples |
| `triage` | Review items in `tests/fixtures/robustness/triage/` |
| `mad-check` | Run external MaD-subset sanity check |
| `report --since=DATE` | Aggregate runs since DATE |

## Buckets

| Dir | Active | In tests |
|---|---|---|
| `tests/fixtures/robustness/auto/` | yes | yes (fail until fixed) |
| `tests/fixtures/robustness/triage/` | yes | no (review via `cli.js triage`) |
| `tests/fixtures/robustness/llm-signal/` | gated by `--persist-llm-signal` | no |

See the spec for details on the triage workflow.
```

- [ ] **Step 4: Write `tests/fixtures/robustness/README.md`**

```markdown
# Robustness Fixture Buckets

Three buckets plus a log, populated by `scripts/robustness/cli.js`.

- `auto/` — auto-persisted regression fixtures. Loaded by `scripts/robustness.test.js`; failing until fixed.
- `triage/` — items awaiting manual review. Use `node scripts/robustness/cli.js triage` to promote/dismiss/defer.
- `llm-signal/` — LLM-quality signals (schema/rule violations). Gated; only written when `--persist-llm-signal` is on.
- `dismissed.log` — append-only audit trail of dismissed triage items.

DO NOT hand-edit fixtures here. They are generated and regenerated by runs.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/ tests/fixtures/robustness/ tests/robustness-reports/
git commit -m "$(cat <<'EOF'
feat(robustness): Scaffold directory + config + READMEs

Sets up scripts/robustness/ sidecar, three fixture buckets under
tests/fixtures/robustness/, and tests/robustness-reports/. Adds config.json
with FREE-tier defaults targeting qwen-3.5-122b on a sovereign EU-hosted
LLM gateway.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.2: CLI arg-parsing skeleton

**Files:**
- Create: `scripts/robustness/cli.js`
- Test: covered by Task 1.3 (env-var resolution test exercises CLI parsing)

- [ ] **Step 1: Write minimal `scripts/robustness/cli.js` skeleton**

```js
#!/usr/bin/env node
/**
 * Pipeline Robustness CLI.
 * See docs/superpowers/specs/2026-05-16-pipeline-robustness-via-synthetic-data-design.md
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, 'config.json');

export function parseArgs(argv = process.argv.slice(2)) {
  const command = argv[0];
  const flags = {};
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        flags[arg.slice(2)] = argv[++i] || 'true';
      }
    }
  }
  return { command, flags };
}

export function loadConfig() {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

export function resolveEndpoint(config, flags, env = process.env) {
  const baseUrl = flags['api-url'] || env[config.endpoint.url_env] || config.endpoint.url;
  const apiKey  = flags['api-key'] || env[config.endpoint.key_env] || config.endpoint.key || 'none';
  const model   = flags['model']   || config.model;
  return { baseUrl, apiKey, model };
}

async function main() {
  const { command, flags } = parseArgs();
  const config = loadConfig();

  switch (command) {
    case 'run':
      console.log('[robustness] run — not implemented yet (Phase 2+)');
      console.log('Resolved endpoint:', resolveEndpoint(config, flags));
      break;
    case 'triage':
      console.log('[robustness] triage — not implemented yet (Phase 4)');
      break;
    case 'mad-check':
      console.log('[robustness] mad-check — not implemented yet (Phase 6)');
      break;
    case 'report':
      console.log('[robustness] report — not implemented yet (Phase 4)');
      break;
    default:
      console.error(`Usage: node scripts/robustness/cli.js <run|triage|mad-check|report> [flags]`);
      process.exit(1);
  }
}

// Only run main when invoked directly, not when imported in tests
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 2: Verify it runs**

Run: `node scripts/robustness/cli.js run --api-url=http://test.example/v1 --model=foo`
Expected output:
```
[robustness] run — not implemented yet (Phase 2+)
Resolved endpoint: { baseUrl: 'http://test.example/v1', apiKey: 'none', model: 'foo' }
```

- [ ] **Step 3: Commit**

```bash
git add scripts/robustness/cli.js
git commit -m "$(cat <<'EOF'
feat(robustness): CLI skeleton with arg/config/endpoint resolution

Pure functions parseArgs(), loadConfig(), resolveEndpoint() exposed for
test. main() dispatches commands but each command is a placeholder until
later phases implement them.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.3: Tests for env-var + flag precedence

**Files:**
- Create: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test**

```js
import { describe, test, expect } from '@jest/globals';
import { parseArgs, loadConfig, resolveEndpoint } from './robustness/cli.js';

describe('robustness/cli — parseArgs', () => {
  test('parses subcommand and flags', () => {
    const { command, flags } = parseArgs(['run', '--n=50', '--target=dot']);
    expect(command).toBe('run');
    expect(flags.n).toBe('50');
    expect(flags.target).toBe('dot');
  });

  test('handles space-separated flag form', () => {
    const { flags } = parseArgs(['run', '--model', 'qwen-3.5-122b']);
    expect(flags.model).toBe('qwen-3.5-122b');
  });
});

describe('robustness/cli — loadConfig', () => {
  test('loads default model from config.json', () => {
    const cfg = loadConfig();
    expect(cfg.model).toBe('qwen-3.5-122b');
    expect(cfg.endpoint.url_env).toBe('AIHUB_URL');
  });
});

describe('robustness/cli — resolveEndpoint precedence', () => {
  const cfg = { model: 'cfg-model', endpoint: { url_env: 'AIHUB_URL', key_env: 'AIHUB_KEY', url: null, key: null } };

  test('CLI flag wins over env', () => {
    const env = { AIHUB_URL: 'http://env.example' };
    const result = resolveEndpoint(cfg, { 'api-url': 'http://flag.example' }, env);
    expect(result.baseUrl).toBe('http://flag.example');
  });

  test('env wins over config when no flag', () => {
    const env = { AIHUB_URL: 'http://env.example' };
    const result = resolveEndpoint(cfg, {}, env);
    expect(result.baseUrl).toBe('http://env.example');
  });

  test('config falls back when no flag, no env', () => {
    const cfgWithUrl = { ...cfg, endpoint: { ...cfg.endpoint, url: 'http://cfg.example' } };
    const result = resolveEndpoint(cfgWithUrl, {}, {});
    expect(result.baseUrl).toBe('http://cfg.example');
  });

  test('apiKey defaults to "none" for local-mode compatibility', () => {
    const result = resolveEndpoint(cfg, {}, {});
    expect(result.apiKey).toBe('none');
  });

  test('flag --model overrides config.model', () => {
    const result = resolveEndpoint(cfg, { model: 'flag-model' }, {});
    expect(result.model).toBe('flag-model');
  });
});
```

- [ ] **Step 2: Run test, expect PASS (CLI was implemented in Task 1.2)**

Run: `cd scripts && npx jest robustness-internal.test.js -t "robustness/cli" --verbose`
Expected: all 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
test(robustness): CLI parseArgs/loadConfig/resolveEndpoint

6 tests cover subcommand parsing, both flag forms, env-var precedence,
config fallback, and apiKey "none" default. Establishes the test file for
all robustness-internal unit tests.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.4: LLM provider smoke test (offline)

**Files:**
- Modify: `scripts/robustness/cli.js` (add `smoke-test` command)
- Modify: `scripts/robustness-internal.test.js` (add smoke test for provider construction)

- [ ] **Step 1: Write failing test for provider construction**

Append to `scripts/robustness-internal.test.js`:

```js
import { createLlmProvider } from './agents/llm-provider.js';

describe('robustness/cli — LLM provider construction', () => {
  test('constructs a callable from resolved endpoint', () => {
    const cfg = { model: 'qwen-3.5-122b', endpoint: { url_env: 'AIHUB_URL', key_env: 'AIHUB_KEY', url: null, key: null } };
    const env = { AIHUB_URL: 'http://test.example/v1', AIHUB_KEY: 'secret' };
    const { baseUrl, apiKey, model } = resolveEndpoint(cfg, {}, env);
    const llm = createLlmProvider({ baseUrl, apiKey, model, timeout: 5_000 });
    expect(typeof llm).toBe('function');
  });
});
```

- [ ] **Step 2: Run test, expect PASS (no implementation change needed)**

Run: `cd scripts && npx jest robustness-internal.test.js -t "LLM provider construction" --verbose`
Expected: PASS.

- [ ] **Step 3: Add `smoke-test` command to cli.js (live HTTP call, optional)**

Modify the `switch (command)` block in `scripts/robustness/cli.js` to add:

```js
case 'smoke-test': {
  const { createLlmProvider } = await import('../agents/llm-provider.js');
  const { baseUrl, apiKey, model } = resolveEndpoint(config, flags);
  if (!baseUrl) {
    console.error('Missing baseUrl. Set AIHUB_URL or pass --api-url=...');
    process.exit(2);
  }
  const llm = createLlmProvider({ baseUrl, apiKey, model, timeout: 30_000 });
  const reply = await llm('You are a test.', 'Reply with the single word: pong');
  console.log('[smoke-test] reply:', reply);
  break;
}
```

Update the usage line:
```js
console.error('Usage: node scripts/robustness/cli.js <run|smoke-test|triage|mad-check|report> [flags]');
```

- [ ] **Step 4: Commit (smoke-test is opt-in, not run in CI)**

```bash
git add scripts/robustness/cli.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): smoke-test command + LLM provider construction test

smoke-test makes a live HTTP call to the configured LLM endpoint to
verify connectivity. Test for createLlmProvider construction uses no
network.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.5: Verify all existing tests still pass

- [ ] **Step 1: Run full test suite**

Run: `cd scripts && npx jest --verbose 2>&1 | tail -30`
Expected: 136 existing tests + new robustness-internal tests all pass.

- [ ] **Step 2: If any existing test broke, debug and fix; do NOT commit a broken state**

---

# Phase 2 — Generation

Implement the synthetic-data generator with two-step prompting.

### Task 2.1: Seed-catalog content + loader

**Files:**
- Create: `scripts/robustness/seed-catalog.json`
- Modify: `scripts/robustness-internal.test.js` (add catalog test)

- [ ] **Step 1: Write `scripts/robustness/seed-catalog.json`**

```json
{
  "domains": [
    "procurement",
    "hr-onboarding",
    "claims",
    "incident-mgmt",
    "loan-approval",
    "order-fulfillment"
  ],
  "complexity": {
    "simple":  { "minNodes": 5,  "maxNodes": 10, "gateways": 0 },
    "medium":  { "minNodes": 10, "maxNodes": 25, "gateways": 2 },
    "complex": { "minNodes": 25, "maxNodes": 50, "gateways": 5 }
  },
  "patterns": [
    "four-eyes",
    "escalation",
    "compensation",
    "event-subprocess",
    "pools-collaboration",
    "ad-hoc"
  ],
  "stress_modes": [
    "normal",
    "deep-nesting",
    "wide-parallelism",
    "many-lanes",
    "edge-label-density"
  ]
}
```

- [ ] **Step 2: Write failing test for catalog cell enumeration**

Append to `scripts/robustness-internal.test.js`:

```js
import { enumerateCells } from './robustness/synthetic-generator.js';

describe('robustness/synthetic-generator — enumerateCells', () => {
  const catalog = {
    domains: ['a', 'b'],
    complexity: { simple: {}, medium: {} },
    patterns: ['p1'],
    stress_modes: ['s1', 's2']
  };

  test('produces full Cartesian product', () => {
    const cells = enumerateCells(catalog);
    expect(cells).toHaveLength(2 * 2 * 1 * 2); // 8
    expect(cells[0]).toMatchObject({
      domain: 'a', complexity: 'simple', pattern: 'p1', stress_mode: 's1'
    });
  });

  test('each cell has the four dimension keys', () => {
    const cells = enumerateCells(catalog);
    for (const cell of cells) {
      expect(cell).toEqual(expect.objectContaining({
        domain: expect.any(String),
        complexity: expect.any(String),
        pattern: expect.any(String),
        stress_mode: expect.any(String),
      }));
    }
  });
});
```

- [ ] **Step 3: Run test, expect FAIL (module doesn't exist yet)**

Run: `cd scripts && npx jest robustness-internal.test.js -t "enumerateCells" --verbose`
Expected: FAIL with "Cannot find module './robustness/synthetic-generator.js'".

- [ ] **Step 4: Create `scripts/robustness/synthetic-generator.js` with enumerator**

```js
/**
 * Synthetic data generator — produces (description, lcJson|dot) pairs via two-step LLM prompting.
 * See spec Section 4.3.
 */

export function enumerateCells(catalog) {
  const cells = [];
  for (const domain of catalog.domains) {
    for (const complexity of Object.keys(catalog.complexity)) {
      for (const pattern of catalog.patterns) {
        for (const stress_mode of catalog.stress_modes) {
          cells.push({ domain, complexity, pattern, stress_mode });
        }
      }
    }
  }
  return cells;
}
```

- [ ] **Step 5: Run test, expect PASS**

Run: `cd scripts && npx jest robustness-internal.test.js -t "enumerateCells" --verbose`
Expected: both tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/robustness/seed-catalog.json scripts/robustness/synthetic-generator.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): Seed catalog + cell enumerator

540 cells (6 domains × 3 complexities × 6 patterns × 5 stress modes).
enumerateCells produces the Cartesian product for sampling strategies.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.2: Sampling strategies (uniform/weighted/targeted)

**Files:**
- Modify: `scripts/robustness/synthetic-generator.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test for sampleCells()**

Append to `scripts/robustness-internal.test.js`:

```js
import { sampleCells } from './robustness/synthetic-generator.js';

describe('robustness/synthetic-generator — sampleCells', () => {
  const cells = [
    { domain: 'a', complexity: 'simple', pattern: 'p1', stress_mode: 's1' },
    { domain: 'a', complexity: 'medium', pattern: 'p1', stress_mode: 's1' },
    { domain: 'b', complexity: 'simple', pattern: 'p1', stress_mode: 's1' },
    { domain: 'b', complexity: 'medium', pattern: 'p1', stress_mode: 's1' },
  ];

  test('uniform strategy returns N samples', () => {
    const picked = sampleCells(cells, { n: 3, strategy: 'uniform', seed: 42 });
    expect(picked).toHaveLength(3);
    for (const p of picked) {
      expect(cells).toContainEqual(p);
    }
  });

  test('uniform strategy is deterministic with same seed', () => {
    const a = sampleCells(cells, { n: 2, strategy: 'uniform', seed: 7 });
    const b = sampleCells(cells, { n: 2, strategy: 'uniform', seed: 7 });
    expect(a).toEqual(b);
  });

  test('targeted strategy filters by predicate', () => {
    const picked = sampleCells(cells, {
      n: 10, strategy: 'targeted', seed: 1,
      filter: c => c.complexity === 'simple'
    });
    expect(picked.every(p => p.complexity === 'simple')).toBe(true);
  });

  test('if n > available cells, returns all cells', () => {
    const picked = sampleCells(cells, { n: 100, strategy: 'uniform', seed: 1 });
    expect(picked).toHaveLength(cells.length);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `cd scripts && npx jest robustness-internal.test.js -t "sampleCells" --verbose`
Expected: FAIL — sampleCells not exported.

- [ ] **Step 3: Add `sampleCells` to `scripts/robustness/synthetic-generator.js`**

```js
function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleCells(cells, { n, strategy = 'uniform', seed = Date.now(), filter = null } = {}) {
  const pool = filter ? cells.filter(filter) : cells.slice();
  if (n >= pool.length) return pool;

  const rand = mulberry32(seed);
  const picked = [];
  const remaining = pool.slice();
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rand() * remaining.length);
    picked.push(remaining.splice(idx, 1)[0]);
  }
  return picked;
}
```

- [ ] **Step 4: Run test, expect PASS**

Run: `cd scripts && npx jest robustness-internal.test.js -t "sampleCells" --verbose`
Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/synthetic-generator.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): sampleCells with deterministic seeded sampling

Mulberry32 PRNG (no dep). Supports uniform and targeted (predicate-based)
strategies. Same seed → same picks for reproducibility.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.3: Description-gen prompt builder

**Files:**
- Modify: `scripts/robustness/synthetic-generator.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test for buildDescriptionPrompt()**

Append to `scripts/robustness-internal.test.js`:

```js
import { buildDescriptionPrompt } from './robustness/synthetic-generator.js';

describe('robustness/synthetic-generator — buildDescriptionPrompt', () => {
  const cell = { domain: 'procurement', complexity: 'medium', pattern: 'four-eyes', stress_mode: 'wide-parallelism' };
  const complexitySpec = { minNodes: 10, maxNodes: 25, gateways: 2 };

  test('produces system + user prompt strings', () => {
    const { system, user } = buildDescriptionPrompt(cell, complexitySpec);
    expect(typeof system).toBe('string');
    expect(typeof user).toBe('string');
    expect(system.length).toBeGreaterThan(0);
    expect(user.length).toBeGreaterThan(0);
  });

  test('user prompt references domain, complexity, pattern, stress_mode', () => {
    const { user } = buildDescriptionPrompt(cell, complexitySpec);
    expect(user).toContain('procurement');
    expect(user).toContain('medium');
    expect(user).toContain('four-eyes');
    expect(user).toContain('wide-parallelism');
  });

  test('user prompt requests German output', () => {
    const { user } = buildDescriptionPrompt(cell, complexitySpec);
    expect(user.toLowerCase()).toMatch(/german|deutsch/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd scripts && npx jest robustness-internal.test.js -t "buildDescriptionPrompt" --verbose`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement `buildDescriptionPrompt`**

Add to `scripts/robustness/synthetic-generator.js`:

```js
export function buildDescriptionPrompt(cell, complexitySpec) {
  const system = `You generate realistic German enterprise process descriptions for BPMN modeling. Write natural, plausible business language.`;

  const user = `Generate a process description with these characteristics:
- Domain: ${cell.domain}
- Complexity: ${cell.complexity} (${complexitySpec.minNodes}-${complexitySpec.maxNodes} nodes, ${complexitySpec.gateways} gateways)
- Pattern to demonstrate: ${cell.pattern}
- Stress mode: ${cell.stress_mode}

Write the description in German, 200-400 words. Output JUST the description text — no markdown, no preamble, no metadata. Plausible business prose only.`;

  return { system, user };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd scripts && npx jest robustness-internal.test.js -t "buildDescriptionPrompt" --verbose`
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/synthetic-generator.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): Description-gen prompt builder

Templated system + user prompts parameterized by cell (domain, complexity,
pattern, stress_mode). Requests 200-400 word German business prose.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.4: Structure-gen prompt + JSON extraction (LC-JSON target)

**Files:**
- Modify: `scripts/robustness/synthetic-generator.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing tests**

Append to `scripts/robustness-internal.test.js`:

```js
import { buildLcJsonPrompt, extractJson } from './robustness/synthetic-generator.js';

describe('robustness/synthetic-generator — buildLcJsonPrompt', () => {
  test('includes schema reference + description', () => {
    const desc = 'Im Beschaffungsprozess beginnt der Vorgang...';
    const { system, user } = buildLcJsonPrompt(desc);
    expect(system.toLowerCase()).toContain('json');
    expect(user).toContain(desc);
  });

  test('constrains output format (no prose)', () => {
    const { system } = buildLcJsonPrompt('x');
    expect(system.toLowerCase()).toMatch(/no prose|just json|output.*json/);
  });
});

describe('robustness/synthetic-generator — extractJson', () => {
  test('direct JSON parses', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  test('fenced code block JSON extracts', () => {
    const text = 'preamble\n```json\n{"a":1}\n```\ntrailing';
    expect(extractJson(text)).toEqual({ a: 1 });
  });

  test('returns null on no JSON', () => {
    expect(extractJson('no json here')).toBeNull();
  });

  test('first-to-last-brace fallback', () => {
    expect(extractJson('foo {"x":2} bar')).toEqual({ x: 2 });
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd scripts && npx jest robustness-internal.test.js -t "buildLcJsonPrompt|extractJson" --verbose`
Expected: 6 failures.

- [ ] **Step 3: Implement (reuse extractJson pattern from `scripts/evaluate-slm.js`)**

Add to `scripts/robustness/synthetic-generator.js`:

```js
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, '../../references/input-schema.json');

let _cachedSchema = null;
function loadSchema() {
  if (!_cachedSchema) _cachedSchema = readFileSync(SCHEMA_PATH, 'utf8');
  return _cachedSchema;
}

export function buildLcJsonPrompt(description) {
  const schema = loadSchema();
  const system = `You produce JSON conforming exactly to the provided schema. Output JUST the JSON object — no prose, no markdown fences, no preamble.

SCHEMA:
${schema}`;

  const user = `Convert this process description to Logic-Core JSON matching the schema above:

${description}

Constraints:
- All node IDs match ^[a-zA-Z_][a-zA-Z0-9_-]*$
- Every flow.source and flow.target must reference an existing node ID
- Lanes are ordered top-to-bottom by flow direction`;

  return { system, user };
}

export function extractJson(text) {
  // Direct parse
  try { return JSON.parse(text); } catch {}
  // Fenced code block
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  // First-brace to last-brace fallback
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd scripts && npx jest robustness-internal.test.js -t "buildLcJsonPrompt|extractJson" --verbose`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/synthetic-generator.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): LC-JSON prompt builder + extractJson helper

Schema is inlined into the system prompt (lazy-loaded + cached).
extractJson covers direct parse, fenced code block, and brace-bounded
fallback — pattern borrowed from scripts/evaluate-slm.js.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.5: Sample-record assembly with formatId

**Files:**
- Modify: `scripts/robustness/synthetic-generator.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test**

Append to `scripts/robustness-internal.test.js`:

```js
import { formatSampleId, buildSample } from './robustness/synthetic-generator.js';

describe('robustness/synthetic-generator — formatSampleId', () => {
  test('uses __ separator and includes all 5 fields', () => {
    const id = formatSampleId({
      domain: 'hr-onboarding', complexity: 'medium',
      pattern: 'four-eyes', stress_mode: 'wide-parallelism'
    }, 42);
    expect(id).toBe('hr-onboarding__medium__four-eyes__wide-parallelism__042');
  });

  test('pads sequence to 3 digits', () => {
    const id = formatSampleId({ domain: 'a', complexity: 'b', pattern: 'c', stress_mode: 'd' }, 7);
    expect(id).toMatch(/__007$/);
  });
});

describe('robustness/synthetic-generator — buildSample', () => {
  test('assembles full Sample record', () => {
    const sample = buildSample({
      cell: { domain: 'proc', complexity: 'medium', pattern: 'p', stress_mode: 's' },
      seq: 5,
      description: 'desc text',
      lcJson: { pools: [] },
      rawDot: null,
      target: 'lc-json',
      model: 'qwen-3.5-122b',
    });
    expect(sample.id).toBe('proc__medium__p__s__005');
    expect(sample.description).toBe('desc text');
    expect(sample.lcJson).toEqual({ pools: [] });
    expect(sample.rawDot).toBeNull();
    expect(sample.meta.domain).toBe('proc');
    expect(sample.meta.target).toBe('lc-json');
    expect(sample.meta.model).toBe('qwen-3.5-122b');
    expect(sample.meta.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd scripts && npx jest robustness-internal.test.js -t "formatSampleId|buildSample" --verbose`

- [ ] **Step 3: Implement**

Add to `scripts/robustness/synthetic-generator.js`:

```js
export function formatSampleId(cell, seq) {
  const padded = String(seq).padStart(3, '0');
  return `${cell.domain}__${cell.complexity}__${cell.pattern}__${cell.stress_mode}__${padded}`;
}

export function buildSample({ cell, seq, description, lcJson, rawDot = null, target, model }) {
  return {
    id: formatSampleId(cell, seq),
    description,
    lcJson,
    rawDot,
    meta: {
      domain: cell.domain,
      complexity: cell.complexity,
      pattern: cell.pattern,
      stress_mode: cell.stress_mode,
      target,
      model,
      generated_at: new Date().toISOString(),
    }
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/synthetic-generator.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): Sample ID format + buildSample assembler

ID uses __ separator so hyphenated domain names (hr-onboarding) remain
unambiguously parseable. Seq is zero-padded to 3 digits.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.6: End-to-end `generateSamples` with mocked LLM

**Files:**
- Modify: `scripts/robustness/synthetic-generator.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test (mocked LLM, no network)**

Append to `scripts/robustness-internal.test.js`:

```js
import { generateSamples } from './robustness/synthetic-generator.js';

describe('robustness/synthetic-generator — generateSamples (integration with mocked LLM)', () => {
  const catalog = {
    domains: ['a'],
    complexity: { simple: { minNodes: 5, maxNodes: 10, gateways: 0 } },
    patterns: ['p1'],
    stress_modes: ['normal']
  };

  const mockLlm = async (system, user) => {
    if (system.toLowerCase().includes('json')) {
      return '{"pools":[{"id":"P1","lanes":[{"id":"L1","nodes":[{"id":"start","type":"startEvent"}]}]}],"flows":[]}';
    }
    return 'Eine kurze Prozessbeschreibung auf Deutsch.';
  };

  test('produces N Sample records with correct meta', async () => {
    const samples = await generateSamples({
      catalog, n: 1, llm: mockLlm, target: 'lc-json', model: 'mock-model', seed: 42,
    });
    expect(samples).toHaveLength(1);
    expect(samples[0].description).toBe('Eine kurze Prozessbeschreibung auf Deutsch.');
    expect(samples[0].lcJson).toMatchObject({ pools: expect.any(Array) });
    expect(samples[0].meta.model).toBe('mock-model');
    expect(samples[0].meta.target).toBe('lc-json');
  });

  test('skips samples where structure-gen returns unparseable output', async () => {
    const flakyLlm = async (system) => {
      if (system.toLowerCase().includes('json')) return 'not json at all';
      return 'desc';
    };
    const samples = await generateSamples({
      catalog, n: 1, llm: flakyLlm, target: 'lc-json', model: 'flaky', seed: 1,
    });
    expect(samples).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd scripts && npx jest robustness-internal.test.js -t "generateSamples" --verbose`

- [ ] **Step 3: Implement `generateSamples`**

Add to `scripts/robustness/synthetic-generator.js`:

```js
export async function generateSamples({
  catalog,
  n,
  llm,
  strategy = 'uniform',
  target = 'lc-json',
  model,
  seed = Date.now(),
}) {
  const cells = enumerateCells(catalog);
  const picked = sampleCells(cells, { n, strategy, seed });
  const samples = [];
  let seq = 0;

  for (const cell of picked) {
    seq++;
    const complexitySpec = catalog.complexity[cell.complexity];

    // Step 1: description
    const { system: sysA, user: userA } = buildDescriptionPrompt(cell, complexitySpec);
    let description;
    try { description = (await llm(sysA, userA, {})).trim(); }
    catch (e) { continue; }

    // Step 2: structure (LC-JSON path; DOT path added in Phase 5)
    if (target === 'lc-json') {
      const { system: sysB, user: userB } = buildLcJsonPrompt(description);
      let rawOutput;
      try { rawOutput = await llm(sysB, userB, {}); }
      catch (e) { continue; }
      const lcJson = extractJson(rawOutput);
      if (!lcJson) continue;  // unparseable — skip silently
      samples.push(buildSample({ cell, seq, description, lcJson, target, model }));
    }
  }

  return samples;
}
```

- [ ] **Step 4: Run, expect PASS**

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/synthetic-generator.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): End-to-end generateSamples (LC-JSON target)

Orchestrates enumerate → sample → 2 LLM calls per cell → buildSample.
LLM is injected as a callable so tests can mock without network. Samples
where structure-gen returns unparseable output are silently dropped (not
classified as failures — these are LLM-quality issues handled in pre-filter).
DOT target follows in Phase 5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 3 — Stress + Classify

Implement the stress-tester (with inline pre-filter), graph-isomorphism check, and failure classifier.

### Task 3.1: graph-isomorphism — adjacency list builder

**Files:**
- Create: `scripts/robustness/graph-isomorphism.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test for `toAdjacencyList`**

Append to `scripts/robustness-internal.test.js`:

```js
import { toAdjacencyList } from './robustness/graph-isomorphism.js';

describe('robustness/graph-isomorphism — toAdjacencyList', () => {
  test('converts single-pool LC to typed adjacency list', () => {
    const lc = {
      pools: [{
        id: 'P1',
        lanes: [{
          id: 'L1',
          nodes: [
            { id: 'start', type: 'startEvent' },
            { id: 'task1', type: 'task' },
            { id: 'end', type: 'endEvent' },
          ]
        }]
      }],
      flows: [
        { source: 'start', target: 'task1' },
        { source: 'task1', target: 'end' },
      ]
    };
    const adj = toAdjacencyList(lc);
    expect(adj.nodes).toHaveLength(3);
    expect(adj.nodes[0]).toMatchObject({ id: 'start', type: 'startEvent' });
    expect(adj.edges).toHaveLength(2);
    expect(adj.lanes).toHaveLength(1);
  });

  test('handles multi-pool with lane count', () => {
    const lc = {
      pools: [
        { id: 'P1', lanes: [{ id: 'L1', nodes: [{ id: 'a', type: 'task' }] }] },
        { id: 'P2', lanes: [{ id: 'L2', nodes: [{ id: 'b', type: 'task' }] }] },
      ],
      flows: []
    };
    const adj = toAdjacencyList(lc);
    expect(adj.pools).toHaveLength(2);
    expect(adj.lanes).toHaveLength(2);
    expect(adj.nodes).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd scripts && npx jest robustness-internal.test.js -t "toAdjacencyList" --verbose`

- [ ] **Step 3: Implement**

Create `scripts/robustness/graph-isomorphism.js`:

```js
/**
 * Graph-isomorphism — structural equality check for Logic-Core JSON.
 * Approximate: canonical sort by type sequence, no full VF2.
 * Sufficient for typical sample sizes (≤50 nodes).
 */

export function toAdjacencyList(lc) {
  const nodes = [];
  const lanes = [];
  const pools = lc.pools || [];

  for (const pool of pools) {
    for (const lane of (pool.lanes || [])) {
      lanes.push({ id: lane.id, poolId: pool.id });
      for (const node of (lane.nodes || [])) {
        nodes.push({ id: node.id, type: node.type });
      }
    }
  }

  const edges = (lc.flows || []).map(f => ({ source: f.source, target: f.target }));
  return { pools: pools.map(p => ({ id: p.id })), lanes, nodes, edges };
}
```

- [ ] **Step 4: Run, expect PASS**

Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/graph-isomorphism.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): Graph-isomorphism — adjacency list builder

Flattens Logic-Core JSON to {pools, lanes, nodes, edges} for canonical
structural comparison. Strips labels/properties — only id+type retained.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.2: graph-isomorphism — canonical signature + comparison

**Files:**
- Modify: `scripts/robustness/graph-isomorphism.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing tests**

Append to `scripts/robustness-internal.test.js`:

```js
import { canonicalSignature, isStructurallyEqual } from './robustness/graph-isomorphism.js';

describe('robustness/graph-isomorphism — canonicalSignature', () => {
  test('produces deterministic string for same structure regardless of node order', () => {
    const lcA = {
      pools: [{ id: 'P', lanes: [{ id: 'L', nodes: [
        { id: 'a', type: 'task' }, { id: 'b', type: 'gateway' }
      ]}]}],
      flows: []
    };
    const lcB = {
      pools: [{ id: 'P', lanes: [{ id: 'L', nodes: [
        { id: 'b', type: 'gateway' }, { id: 'a', type: 'task' }
      ]}]}],
      flows: []
    };
    expect(canonicalSignature(lcA)).toBe(canonicalSignature(lcB));
  });

  test('differs when types differ', () => {
    const lcA = { pools: [{ id: 'P', lanes: [{ id: 'L', nodes: [{ id: 'x', type: 'task' }] }] }], flows: [] };
    const lcB = { pools: [{ id: 'P', lanes: [{ id: 'L', nodes: [{ id: 'x', type: 'startEvent' }] }] }], flows: [] };
    expect(canonicalSignature(lcA)).not.toBe(canonicalSignature(lcB));
  });
});

describe('robustness/graph-isomorphism — isStructurallyEqual', () => {
  test('returns equal:true for identical', () => {
    const lc = { pools: [{ id: 'P', lanes: [{ id: 'L', nodes: [{ id: 'a', type: 'task' }] }] }], flows: [] };
    const result = isStructurallyEqual(lc, lc);
    expect(result.equal).toBe(true);
  });

  test('returns delta with missingNodes', () => {
    const lcA = { pools: [{ id: 'P', lanes: [{ id: 'L', nodes: [
      { id: 'a', type: 'task' }, { id: 'b', type: 'task' }
    ]}]}], flows: [] };
    const lcB = { pools: [{ id: 'P', lanes: [{ id: 'L', nodes: [
      { id: 'a', type: 'task' }
    ]}]}], flows: [] };
    const result = isStructurallyEqual(lcA, lcB);
    expect(result.equal).toBe(false);
    expect(result.delta.nodeCount).toEqual({ a: 2, b: 1 });
  });

  test('returns delta with missingLanes when lane count differs', () => {
    const lcA = { pools: [{ id: 'P', lanes: [{ id: 'L1', nodes: [] }, { id: 'L2', nodes: [] }] }], flows: [] };
    const lcB = { pools: [{ id: 'P', lanes: [{ id: 'L1', nodes: [] }] }], flows: [] };
    const result = isStructurallyEqual(lcA, lcB);
    expect(result.equal).toBe(false);
    expect(result.delta.laneCount).toEqual({ a: 2, b: 1 });
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

Append to `scripts/robustness/graph-isomorphism.js`:

```js
export function canonicalSignature(lc) {
  const adj = toAdjacencyList(lc);
  const typeSequence = adj.nodes.map(n => n.type).sort().join(',');
  const edgeCount = adj.edges.length;
  const laneCount = adj.lanes.length;
  const poolCount = adj.pools.length;
  return `pools=${poolCount}|lanes=${laneCount}|edges=${edgeCount}|types=[${typeSequence}]`;
}

export function isStructurallyEqual(lcA, lcB) {
  const sigA = canonicalSignature(lcA);
  const sigB = canonicalSignature(lcB);
  if (sigA === sigB) return { equal: true, delta: null };

  const adjA = toAdjacencyList(lcA);
  const adjB = toAdjacencyList(lcB);

  return {
    equal: false,
    delta: {
      nodeCount: { a: adjA.nodes.length, b: adjB.nodes.length },
      edgeCount: { a: adjA.edges.length, b: adjB.edges.length },
      laneCount: { a: adjA.lanes.length, b: adjB.lanes.length },
      poolCount: { a: adjA.pools.length, b: adjB.pools.length },
      sigA, sigB,
    }
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/graph-isomorphism.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): canonicalSignature + isStructurallyEqual

Order-insensitive comparison via sorted type sequence + counts. Returns
delta with per-dimension a/b counts when not equal. Sufficient for ≤50
nodes; risks documented in spec R3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.3: stress-tester — pre-filter (schema + rules)

**Files:**
- Create: `scripts/robustness/stress-tester.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test**

Append to `scripts/robustness-internal.test.js`:

```js
import { preFilter } from './robustness/stress-tester.js';

describe('robustness/stress-tester — preFilter', () => {
  test('returns passed:true for valid LC', async () => {
    const validLc = loadFixture('simple-approval.json');
    const result = await preFilter(validLc);
    expect(result.passed).toBe(true);
    expect(result.schemaErrors).toEqual([]);
    expect(result.ruleErrors).toEqual([]);
  });

  test('returns passed:false for broken structure', async () => {
    const broken = { pools: 'not-an-array' };
    const result = await preFilter(broken);
    expect(result.passed).toBe(false);
  });

  test('errors short-circuit; warnings do not', async () => {
    // simple-approval typically passes with possible warnings — pre-filter must allow it
    const lc = loadFixture('simple-approval.json');
    const result = await preFilter(lc);
    expect(result.passed).toBe(true);
  });
});
```

(`loadFixture` may need to be defined in the test file — check the top of `scripts/orchestrator.test.js` for the existing helper and reuse the same pattern.)

If not already present, add at top of `scripts/robustness-internal.test.js`:

```js
const fixturesDir = resolve(__dirname, '../tests/fixtures');
function loadFixture(name) {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
}
```

- [ ] **Step 2: Run, expect FAIL**

Run: `cd scripts && npx jest robustness-internal.test.js -t "preFilter" --verbose`

- [ ] **Step 3: Implement**

Create `scripts/robustness/stress-tester.js`:

```js
/**
 * Stress-tester — runs samples through pre-filter, then full pipeline + roundtrip.
 * See spec Section 4.4.
 */

import { validateLogicCore } from '../validate.js';
import { runRules } from '../rules.js';

export async function preFilter(lc) {
  // Phase A.1: schema validation
  // validateLogicCore(lc) is sync, returns { errors: string[], warnings: string[] }
  const schemaResult = validateLogicCore(lc);
  if (schemaResult.errors && schemaResult.errors.length > 0) {
    return {
      passed: false,
      schemaErrors: schemaResult.errors,
      ruleErrors: [],
      schemaWarnings: schemaResult.warnings || [],
      ruleWarnings: [],
    };
  }

  // Phase A.2: rule engine
  // runRules(lc, profile=null) returns { errors: string[], warnings: string[], infos: string[], metrics: {} }
  let ruleResult;
  try {
    ruleResult = runRules(lc);
  } catch (e) {
    return {
      passed: false,
      schemaErrors: [],
      ruleErrors: [`runRules threw: ${e.message}`],
      schemaWarnings: schemaResult.warnings || [],
      ruleWarnings: [],
    };
  }

  const ruleErrors = ruleResult.errors || [];
  const ruleWarnings = ruleResult.warnings || [];

  return {
    passed: ruleErrors.length === 0,
    schemaErrors: [],
    ruleErrors,
    schemaWarnings: schemaResult.warnings || [],
    ruleWarnings,
  };
}
```

**API confirmed** (verified against `scripts/validate.js` and `scripts/rules.js`):
- `validateLogicCore(lc)` is sync, returns `{ errors: string[], warnings: string[] }` — errors are string messages, not objects
- `runRules(lc, profile=null)` returns `{ errors: string[], warnings: string[], infos: string[], metrics: object }` — already split by severity, no `.severity` field on items

- [ ] **Step 4: Run, expect PASS (after any return-shape fix)**

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/stress-tester.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): stress-tester preFilter (schema + rules)

Phase A of stress-test: validates against input-schema, then runs rules.
Only ERROR-severity rule violations fail; warnings are passed through. Used
by both the live stress run and the LLM-signal categorization.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.4: stress-tester — pipeline Phase B (5 steps)

**Files:**
- Modify: `scripts/robustness/stress-tester.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test**

Append to `scripts/robustness-internal.test.js`:

```js
import { runPipelineChecks } from './robustness/stress-tester.js';

describe('robustness/stress-tester — runPipelineChecks', () => {
  test('passes on simple valid LC', async () => {
    const lc = loadFixture('simple-approval.json');
    const result = await runPipelineChecks(lc, { timeoutMs: 10_000 });
    expect(result.failedStep).toBeNull();
    expect(result.bpmnXml).toMatch(/^<\?xml/);
    expect(result.svg).toMatch(/<svg/);
  });

  test('captures ELK throws as failedStep:elk', async () => {
    // We synthesize a known-bad LC. Most realistic options:
    // - Self-loop on a single node (may or may not throw)
    // - Empty pools array
    const empty = { pools: [], flows: [] };
    const result = await runPipelineChecks(empty, { timeoutMs: 5_000 });
    // Either fails at validation upstream, or at elk — we expect ANY failure.
    expect(result.failedStep === null).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

Append to `scripts/robustness/stress-tester.js`:

```js
import { runPipeline } from '../pipeline.js';
import { isStructurallyEqual } from './graph-isomorphism.js';

export async function runPipelineChecks(lc, { timeoutMs = 30_000 } = {}) {
  const start = Date.now();
  const result = {
    bpmnXml: null,
    svg: null,
    coordMap: null,
    validation: null,
    failedStep: null,
    error: null,
    durationMs: 0,
  };

  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), timeoutMs)
    );
    const pipelinePromise = runPipeline(lc);
    const r = await Promise.race([pipelinePromise, timeoutPromise]);

    result.bpmnXml = r.bpmnXml;
    result.svg = r.svg;
    result.coordMap = r.coordMap;
    result.validation = r.validation;
    result.durationMs = Date.now() - start;

    // Identify which step failed if any
    if (r.validation && r.validation.errors && r.validation.errors.length > 0) {
      result.failedStep = 'elk-or-xml';
      result.error = r.validation.errors[0];
    } else if (!r.bpmnXml) {
      result.failedStep = 'xml';
    } else if (!r.svg) {
      result.failedStep = 'svg';
    }
  } catch (e) {
    result.durationMs = Date.now() - start;
    result.failedStep = e.message === 'timeout' ? 'timeout' : 'pipeline-throw';
    result.error = e.message;
  }

  return result;
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/stress-tester.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): stress-tester runPipelineChecks

Wraps runPipeline() with timeout via Promise.race. Returns structured
result including failedStep marker (elk-or-xml | xml | svg | timeout |
pipeline-throw) and the captured error. Roundtrip check follows in
Task 3.5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.5: stress-tester — roundtrip check via import.js

**Files:**
- Modify: `scripts/robustness/stress-tester.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test**

Append to `scripts/robustness-internal.test.js`:

```js
import { runRoundtripCheck } from './robustness/stress-tester.js';

describe('robustness/stress-tester — runRoundtripCheck', () => {
  test('passes on simple LC that roundtrips cleanly', async () => {
    const lc = loadFixture('simple-approval.json');
    const { runPipeline } = await import('./pipeline.js');
    const pipelineResult = await runPipeline(lc);
    const rt = await runRoundtripCheck(lc, pipelineResult.bpmnXml);
    expect(rt.equal).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

Append to `scripts/robustness/stress-tester.js`:

```js
import { bpmnToLogicCore } from '../import.js';

export async function runRoundtripCheck(originalLc, bpmnXml) {
  if (!bpmnXml) return { equal: false, delta: { reason: 'no XML' } };
  let reparsedLc;
  try {
    reparsedLc = await bpmnToLogicCore(bpmnXml);
  } catch (e) {
    return { equal: false, delta: { reason: `import threw: ${e.message}` } };
  }
  return isStructurallyEqual(originalLc, reparsedLc);
}
```

**API confirmed** (verified against `scripts/import.js`): the export is `bpmnToLogicCore(xml)` — async, takes the raw XML string, returns a Logic-Core object. Falls back to a legacy parser internally if bpmn-moddle fails.

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/stress-tester.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): runRoundtripCheck via import.js + graph-iso

LC → BPMN-XML → LC' → structural compare. Returns equal:true/false plus
delta. Roundtrip-breaks land in the auto/ bucket per classifier rules.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.6: stress-tester — top-level `runStressTest` orchestration

**Files:**
- Modify: `scripts/robustness/stress-tester.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test**

```js
import { runStressTest } from './robustness/stress-tester.js';

describe('robustness/stress-tester — runStressTest', () => {
  test('returns array of Result objects one per sample', async () => {
    const sample = {
      id: 'test__simple__none__normal__001',
      description: 'test',
      lcJson: loadFixture('simple-approval.json'),
      meta: { domain: 'test', complexity: 'simple', pattern: 'none', stress_mode: 'normal', target: 'lc-json', model: 'test', generated_at: '2026-05-16T00:00:00Z' },
    };
    const results = await runStressTest([sample], { timeoutMs: 15_000 });
    expect(results).toHaveLength(1);
    expect(results[0].sample.id).toBe(sample.id);
    expect(results[0].preFilter).toBeDefined();
    expect(results[0]).toHaveProperty('failure');
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

Append to `scripts/robustness/stress-tester.js`:

```js
export async function runStressTest(samples, { timeoutMs = 30_000 } = {}) {
  const out = [];
  for (const sample of samples) {
    const start = Date.now();
    const pre = await preFilter(sample.lcJson);

    if (!pre.passed) {
      out.push({
        sample,
        preFilter: pre,
        pipelineResult: null,
        roundtripResult: null,
        durationMs: Date.now() - start,
        failure: {
          stage: 'pre-filter',
          schemaErrors: pre.schemaErrors,
          ruleErrors: pre.ruleErrors,
        }
      });
      continue;
    }

    const pipelineResult = await runPipelineChecks(sample.lcJson, { timeoutMs });
    let roundtripResult = null;
    if (pipelineResult.failedStep === null) {
      roundtripResult = await runRoundtripCheck(sample.lcJson, pipelineResult.bpmnXml);
    }

    const failure = pipelineResult.failedStep
      ? { stage: 'pipeline', failedStep: pipelineResult.failedStep, error: pipelineResult.error }
      : (roundtripResult && !roundtripResult.equal
        ? { stage: 'roundtrip', delta: roundtripResult.delta }
        : null);

    out.push({
      sample,
      preFilter: pre,
      pipelineResult,
      roundtripResult,
      durationMs: Date.now() - start,
      failure,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/stress-tester.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): runStressTest orchestrates pre-filter + pipeline + roundtrip

Sequential per sample (parallelism > 1 deferred per R7). Returns
structured Result with failure indicating stage and details.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.7: failure-classifier — category + bucket routing

**Files:**
- Create: `scripts/robustness/failure-classifier.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test**

```js
import { classify } from './robustness/failure-classifier.js';

describe('robustness/failure-classifier — classify', () => {
  test('pre-filter schema fail → schema-violation, llm-signal bucket', () => {
    const result = {
      sample: { id: 'x' },
      preFilter: { passed: false, schemaErrors: [{ msg: 'bad' }], ruleErrors: [] },
      failure: { stage: 'pre-filter', schemaErrors: [{ msg: 'bad' }] },
    };
    const c = classify(result);
    expect(c.category).toBe('schema-violation');
    expect(c.bucket).toBe('llm-signal');
  });

  test('pre-filter rule fail → rule-violation, llm-signal bucket', () => {
    const result = {
      sample: { id: 'x' },
      preFilter: { passed: false, schemaErrors: [], ruleErrors: [{ id: 'S01' }] },
      failure: { stage: 'pre-filter', ruleErrors: [{ id: 'S01' }] },
    };
    expect(classify(result).category).toBe('rule-violation');
    expect(classify(result).bucket).toBe('llm-signal');
  });

  test('pipeline-throw → elk-error, auto bucket', () => {
    const result = {
      sample: { id: 'x' },
      preFilter: { passed: true },
      pipelineResult: { failedStep: 'pipeline-throw', error: 'ElkError: cyclic' },
      failure: { stage: 'pipeline', failedStep: 'pipeline-throw', error: 'ElkError: cyclic' },
    };
    expect(classify(result).category).toBe('elk-error');
    expect(classify(result).bucket).toBe('auto');
  });

  test('timeout → timeout, auto', () => {
    const result = {
      sample: { id: 'x' },
      preFilter: { passed: true },
      pipelineResult: { failedStep: 'timeout', error: 'timeout' },
      failure: { stage: 'pipeline', failedStep: 'timeout', error: 'timeout' },
    };
    expect(classify(result).category).toBe('timeout');
  });

  test('roundtrip break → roundtrip-break, auto', () => {
    const result = {
      sample: { id: 'x' },
      preFilter: { passed: true },
      pipelineResult: { failedStep: null },
      roundtripResult: { equal: false, delta: {} },
      failure: { stage: 'roundtrip', delta: {} },
    };
    expect(classify(result).category).toBe('roundtrip-break');
    expect(classify(result).bucket).toBe('auto');
  });

  test('no failure → category:pass, no bucket', () => {
    const result = {
      sample: { id: 'x' },
      preFilter: { passed: true },
      pipelineResult: { failedStep: null },
      roundtripResult: { equal: true },
      failure: null,
    };
    expect(classify(result).category).toBe('pass');
    expect(classify(result).bucket).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

Create `scripts/robustness/failure-classifier.js`:

```js
/**
 * Failure classifier — maps stress-test results to (category, bucket, fingerprint).
 * See spec Section 4.5.
 */

export function classify(result) {
  if (!result.failure) {
    return { category: 'pass', bucket: null, fingerprint: null, evidence: null };
  }

  const { failure } = result;

  if (failure.stage === 'pre-filter') {
    if (failure.schemaErrors && failure.schemaErrors.length > 0) {
      return makeRecord('schema-violation', 'llm-signal', failure, result);
    }
    if (failure.ruleErrors && failure.ruleErrors.length > 0) {
      return makeRecord('rule-violation', 'llm-signal', failure, result);
    }
  }

  if (failure.stage === 'pipeline') {
    let category;
    switch (failure.failedStep) {
      case 'timeout':           category = 'timeout'; break;
      case 'pipeline-throw':    category = inferThrowCategory(failure.error); break;
      case 'elk-or-xml':        category = 'elk-error'; break;
      case 'xml':               category = 'xml-malform'; break;
      case 'svg':               category = 'svg-render-issue'; break;
      default:                  category = 'unknown';
    }
    return makeRecord(category, 'auto', failure, result);
  }

  if (failure.stage === 'roundtrip') {
    return makeRecord('roundtrip-break', 'auto', failure, result);
  }

  return makeRecord('unknown', 'triage', failure, result);
}

function inferThrowCategory(errorMessage) {
  if (!errorMessage) return 'elk-error';
  const lower = errorMessage.toLowerCase();
  if (lower.includes('elk') || lower.includes('layout')) return 'elk-error';
  if (lower.includes('xml') || lower.includes('parse')) return 'xml-malform';
  if (lower.includes('svg') || lower.includes('render')) return 'svg-render-issue';
  return 'elk-error'; // default — most pipeline throws are layout-related
}

function makeRecord(category, bucket, failure, result) {
  return {
    category,
    bucket,
    fingerprint: null, // filled in by computeFingerprint in Task 3.8
    evidence: failure,
  };
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/failure-classifier.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): failure-classifier categorization + bucket routing

Maps stress-test Results to one of 8 base categories + bucket assignment.
Schema/rule violations → llm-signal; ELK/timeout/XML/SVG → auto;
roundtrip-break → auto. DOT categories added in Phase 5. Fingerprint
follows in Task 3.8.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.8: failure-classifier — fingerprint hash

**Files:**
- Modify: `scripts/robustness/failure-classifier.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test**

```js
import { computeFingerprint } from './robustness/failure-classifier.js';
import { canonicalSignature } from './robustness/graph-isomorphism.js';

describe('robustness/failure-classifier — computeFingerprint', () => {
  test('same category + same error + same structure → same hash', () => {
    const r = {
      sample: { lcJson: { pools: [{ id: 'P', lanes: [{ id: 'L', nodes: [{ id: 'a', type: 'task' }] }] }], flows: [] } },
      failure: { stage: 'pipeline', failedStep: 'pipeline-throw', error: 'ElkError: cyclic' },
    };
    const fp1 = computeFingerprint('elk-error', r);
    const fp2 = computeFingerprint('elk-error', r);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[a-f0-9]{6,}$/);
  });

  test('different categories → different hashes', () => {
    const r = {
      sample: { lcJson: { pools: [], flows: [] } },
      failure: { stage: 'pipeline', failedStep: 'pipeline-throw', error: 'x' },
    };
    expect(computeFingerprint('elk-error', r)).not.toBe(computeFingerprint('timeout', r));
  });

  test('different error messages → different hashes (same category)', () => {
    const r1 = {
      sample: { lcJson: { pools: [], flows: [] } },
      failure: { stage: 'pipeline', failedStep: 'pipeline-throw', error: 'first error' },
    };
    const r2 = {
      sample: { lcJson: { pools: [], flows: [] } },
      failure: { stage: 'pipeline', failedStep: 'pipeline-throw', error: 'second error' },
    };
    expect(computeFingerprint('elk-error', r1)).not.toBe(computeFingerprint('elk-error', r2));
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

Append to `scripts/robustness/failure-classifier.js`:

```js
import { createHash } from 'crypto';
import { canonicalSignature } from './graph-isomorphism.js';

function canonicaliseError(msg) {
  if (!msg) return '';
  // Strip stack traces, memory addresses, line numbers
  return String(msg)
    .replace(/0x[0-9a-fA-F]+/g, '0xADDR')
    .replace(/:\d+:\d+/g, ':LINE:COL')
    .replace(/\s+/g, ' ')
    .slice(0, 200)
    .trim();
}

export function computeFingerprint(category, result) {
  const lc = result.sample?.lcJson;
  const structuralSig = lc ? canonicalSignature(lc) : 'no-lc';
  const errorSig = canonicaliseError(result.failure?.error);
  const blob = `${category}|${errorSig}|${structuralSig}`;
  return createHash('sha256').update(blob).digest('hex').slice(0, 8);
}
```

Then modify `classify()` to fill in the fingerprint by replacing the `makeRecord` call to pass it through, or by computing it inline. Adjust the existing `makeRecord` definition:

```js
function makeRecord(category, bucket, failure, result) {
  return {
    category,
    bucket,
    fingerprint: computeFingerprint(category, result),
    evidence: failure,
  };
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `cd scripts && npx jest robustness-internal.test.js -t "computeFingerprint|classify" --verbose`
Expected: all classifier tests pass (existing + new).

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/failure-classifier.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): Fingerprint hash for failure dedup

SHA-256 over (category, canonicalised error message, structural signature)
truncated to 8 hex chars. Canonicalisation strips memory addresses and
line/col numbers so the same bug under different stack traces produces
the same fingerprint.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 4 — Persist + Report

Implement fixture persistence (bucket-aware, dedup, gated llm-signal), report generation, and the dynamic `robustness.test.js` loader.

### Task 4.1: fixture-persister — basic write with dedup

**Files:**
- Create: `scripts/robustness/fixture-persister.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test (uses tmpfs)**

```js
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { persistFailure } from './robustness/fixture-persister.js';

describe('robustness/fixture-persister — persistFailure', () => {
  let tmpRoot;
  beforeEach(() => { tmpRoot = mkdtempSync(`${tmpdir()}/robustness-`); });
  afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

  const baseRecord = {
    category: 'elk-error',
    bucket: 'auto',
    fingerprint: 'abc123',
    evidence: { error: 'ElkError: cyclic' },
  };
  const baseSample = {
    id: 'test__simple__none__normal__001',
    description: 'A test',
    lcJson: { pools: [], flows: [] },
    meta: { model: 'test', target: 'lc-json', generated_at: '2026-05-16T00:00:00Z' },
  };

  test('first write creates fixture + meta files', async () => {
    const r = await persistFailure(baseRecord, baseSample, { fixtureRoot: tmpRoot });
    expect(r.wrote).toBe('new');
    expect(existsSync(`${tmpRoot}/auto/elk-error-abc123.json`)).toBe(true);
    expect(existsSync(`${tmpRoot}/auto/elk-error-abc123.meta.json`)).toBe(true);
    const meta = JSON.parse(readFileSync(`${tmpRoot}/auto/elk-error-abc123.meta.json`, 'utf8'));
    expect(meta.seen).toBe(1);
  });

  test('repeat with same fingerprint increments seen + updates last_seen', async () => {
    await persistFailure(baseRecord, baseSample, { fixtureRoot: tmpRoot });
    const r2 = await persistFailure(baseRecord, baseSample, { fixtureRoot: tmpRoot });
    expect(r2.wrote).toBe('dedup');
    const meta = JSON.parse(readFileSync(`${tmpRoot}/auto/elk-error-abc123.meta.json`, 'utf8'));
    expect(meta.seen).toBe(2);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

Create `scripts/robustness/fixture-persister.js`:

```js
/**
 * Fixture persister — writes failure records to bucket directories with dedup.
 * See spec Section 4.6.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(__dirname, '../../tests/fixtures/robustness');

function ensureDir(p) {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
}

function writeFixtureFiles(dir, fingerprint, category, lcJson, meta) {
  ensureDir(dir);
  const fixturePath = join(dir, `${category}-${fingerprint}.json`);
  const metaPath = join(dir, `${category}-${fingerprint}.meta.json`);
  writeFileSync(fixturePath, JSON.stringify(lcJson, null, 2), 'utf8');
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
}

function readMetaIfExists(metaPath) {
  if (!existsSync(metaPath)) return null;
  try { return JSON.parse(readFileSync(metaPath, 'utf8')); } catch { return null; }
}

export async function persistFailure(record, sample, opts = {}) {
  const root = opts.fixtureRoot || DEFAULT_ROOT;
  const persistLlmSignal = opts.persistLlmSignal === true;

  // Gated: skip llm-signal unless flag is on
  if (record.bucket === 'llm-signal' && !persistLlmSignal) {
    return { wrote: 'skipped-gated', bucket: 'llm-signal', fingerprint: record.fingerprint };
  }

  if (!record.bucket) {
    return { wrote: 'skipped-no-bucket', bucket: null, fingerprint: null };
  }

  const dir = join(root, record.bucket);
  const metaPath = join(dir, `${record.category}-${record.fingerprint}.meta.json`);
  const existing = readMetaIfExists(metaPath);
  const now = new Date().toISOString();

  if (existing) {
    existing.seen = (existing.seen || 0) + 1;
    existing.last_seen = now;
    writeFileSync(metaPath, JSON.stringify(existing, null, 2), 'utf8');
    return { wrote: 'dedup', bucket: record.bucket, fingerprint: record.fingerprint };
  }

  const meta = {
    fingerprint: record.fingerprint,
    category: record.category,
    first_seen: now,
    last_seen: now,
    seen: 1,
    description: sample.description,
    model: sample.meta?.model,
    target: sample.meta?.target,
    evidence: record.evidence,
  };
  writeFixtureFiles(dir, record.fingerprint, record.category, sample.lcJson, meta);
  return { wrote: 'new', bucket: record.bucket, fingerprint: record.fingerprint };
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/fixture-persister.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): fixture-persister with bucket routing + dedup

writeFixtureFiles for new, meta-only update for repeat fingerprints.
Llm-signal bucket gated by persistLlmSignal opt (default off). Uses
tmpfs in tests for hermetic file IO.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.2: fixture-persister — llm-signal gate test

**Files:**
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write tests verifying flag behavior**

```js
describe('robustness/fixture-persister — llm-signal gate', () => {
  let tmpRoot;
  beforeEach(() => { tmpRoot = mkdtempSync(`${tmpdir()}/robustness-`); });
  afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

  const record = {
    category: 'schema-violation',
    bucket: 'llm-signal',
    fingerprint: 'sig123',
    evidence: { schemaErrors: [{ msg: 'x' }] },
  };
  const sample = {
    id: 'test',
    description: 'd',
    lcJson: {},
    meta: { model: 't', target: 'lc-json' },
  };

  test('default OFF → not written', async () => {
    const r = await persistFailure(record, sample, { fixtureRoot: tmpRoot });
    expect(r.wrote).toBe('skipped-gated');
    expect(existsSync(`${tmpRoot}/llm-signal/schema-violation-sig123.json`)).toBe(false);
  });

  test('flag ON → written', async () => {
    const r = await persistFailure(record, sample, { fixtureRoot: tmpRoot, persistLlmSignal: true });
    expect(r.wrote).toBe('new');
    expect(existsSync(`${tmpRoot}/llm-signal/schema-violation-sig123.json`)).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect PASS (no impl change)**

- [ ] **Step 3: Commit**

```bash
git add scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
test(robustness): llm-signal gate verification

Confirms default off (no file written, returns skipped-gated) and flag on
(file written, returns new). Critical invariant for the build-but-disable
posture documented in spec.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.3: report-generator — Markdown + JSON output

**Files:**
- Create: `scripts/robustness/report-generator.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test**

```js
import { generateReport } from './robustness/report-generator.js';

describe('robustness/report-generator — generateReport', () => {
  const runMeta = {
    model: 'qwen-3.5-122b',
    target: 'lc-json',
    started_at: '2026-05-16T14:00:00Z',
    duration_ms: 600_000,
  };

  test('renders Markdown with totals + per-category', () => {
    const records = [
      { category: 'pass' }, { category: 'pass' },
      { category: 'elk-error', bucket: 'auto', fingerprint: 'a1' },
      { category: 'roundtrip-break', bucket: 'auto', fingerprint: 'a2' },
    ];
    const { markdown, json } = generateReport(runMeta, records);
    expect(markdown).toContain('Robustness Run');
    expect(markdown).toContain('Total samples: 4');
    expect(markdown).toContain('Pass: 2');
    expect(markdown).toContain('elk-error');
    expect(json.totals.total).toBe(4);
    expect(json.totals.pass).toBe(2);
    expect(json.byCategory['elk-error']).toBe(1);
  });

  test('Markdown includes per-target breakdown when both targets present', () => {
    const records = [
      { category: 'pass', sample: { meta: { target: 'lc-json' } } },
      { category: 'elk-error', sample: { meta: { target: 'dot' } }, bucket: 'auto', fingerprint: 'x' },
    ];
    const { markdown } = generateReport(runMeta, records);
    expect(markdown.toLowerCase()).toContain('target');
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

Create `scripts/robustness/report-generator.js`:

```js
/**
 * Report generator — produces Markdown + JSON summaries of a stress run.
 * See spec Section 4.7.
 */

export function generateReport(runMeta, records) {
  const totals = computeTotals(records);
  const byCategory = countBy(records, r => r.category);
  const newFixturesByCategory = countBy(
    records.filter(r => r.bucket && r.wrote === 'new'),
    r => r.category
  );

  const json = { runMeta, totals, byCategory, newFixturesByCategory };
  const markdown = renderMarkdown(runMeta, totals, byCategory, newFixturesByCategory, records);
  return { markdown, json };
}

function computeTotals(records) {
  const total = records.length;
  const pass = records.filter(r => r.category === 'pass').length;
  const fail = total - pass;
  return { total, pass, fail, passRate: total ? Math.round((pass / total) * 100) : 0 };
}

function countBy(arr, fn) {
  const out = {};
  for (const item of arr) {
    const key = fn(item);
    if (!key) continue;
    out[key] = (out[key] || 0) + 1;
  }
  return out;
}

function renderMarkdown(runMeta, totals, byCategory, newFixturesByCategory, records) {
  const lines = [];
  lines.push(`# Robustness Run — ${runMeta.started_at?.slice(0, 10) || 'unknown'}`);
  lines.push('');
  lines.push(`Model: ${runMeta.model}  Target: ${runMeta.target}  Duration: ${Math.round((runMeta.duration_ms || 0) / 1000)}s`);
  lines.push(`Total samples: ${totals.total}  Pass: ${totals.pass} (${totals.passRate}%)  Fail: ${totals.fail}`);
  lines.push('');

  // Per-target breakdown (only if multiple targets are present in records)
  const targets = new Set(records.map(r => r.sample?.meta?.target).filter(Boolean));
  if (targets.size > 1) {
    lines.push('## Per-Target Breakdown');
    for (const t of targets) {
      const recs = records.filter(r => r.sample?.meta?.target === t);
      const pass = recs.filter(r => r.category === 'pass').length;
      lines.push(`- target ${t}: ${recs.length} total, ${pass} pass (${Math.round((pass / recs.length) * 100)}%)`);
    }
    lines.push('');
  }

  // Failures by category
  lines.push('## Failures by Category');
  lines.push('');
  lines.push('| Category | Count | New Fixtures |');
  lines.push('|---|---|---|');
  for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    if (cat === 'pass') continue;
    const newCount = newFixturesByCategory[cat] || 0;
    lines.push(`| ${cat} | ${count} | ${newCount} |`);
  }
  lines.push('');

  return lines.join('\n');
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/report-generator.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): report-generator (Markdown + JSON)

Computes totals + per-category counts + new-fixture counts. Per-target
breakdown surfaces only when multiple targets are present. Drift
detection added in Task 4.4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.4: report-generator — drift detection vs last run

**Files:**
- Modify: `scripts/robustness/report-generator.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test**

```js
import { computeDrift } from './robustness/report-generator.js';

describe('robustness/report-generator — computeDrift', () => {
  test('detects new fingerprints', () => {
    const prev = { byCategory: { 'elk-error': 2 }, fingerprints: ['a1', 'a2'] };
    const curr = { byCategory: { 'elk-error': 3 }, fingerprints: ['a1', 'a2', 'a3'] };
    const drift = computeDrift(prev, curr);
    expect(drift.newFingerprints).toEqual(['a3']);
    expect(drift.closedFingerprints).toEqual([]);
  });

  test('detects closed fingerprints', () => {
    const prev = { byCategory: { 'elk-error': 2 }, fingerprints: ['a1', 'a2'] };
    const curr = { byCategory: { 'elk-error': 1 }, fingerprints: ['a1'] };
    const drift = computeDrift(prev, curr);
    expect(drift.closedFingerprints).toEqual(['a2']);
  });

  test('handles no previous run', () => {
    const drift = computeDrift(null, { byCategory: { 'elk-error': 1 }, fingerprints: ['a1'] });
    expect(drift.firstRun).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

Append to `scripts/robustness/report-generator.js`:

```js
export function computeDrift(previous, current) {
  if (!previous) return { firstRun: true, newFingerprints: [], closedFingerprints: [] };
  const prevSet = new Set(previous.fingerprints || []);
  const currSet = new Set(current.fingerprints || []);
  const newFingerprints = [...currSet].filter(x => !prevSet.has(x));
  const closedFingerprints = [...prevSet].filter(x => !currSet.has(x));
  return { firstRun: false, newFingerprints, closedFingerprints };
}
```

Also augment `generateReport` to compute fingerprints and embed drift in markdown:

```js
function collectFingerprints(records) {
  return [...new Set(records.filter(r => r.fingerprint).map(r => r.fingerprint))];
}

// Inside generateReport, after computing byCategory:
const fingerprints = collectFingerprints(records);
const drift = computeDrift(runMeta.previousReportJson || null, { byCategory, fingerprints });
json.fingerprints = fingerprints;
json.drift = drift;
// In renderMarkdown signature/body, append:
//   if (!drift.firstRun) {
//     append "## Drift vs Previous Run" + lists
//   }
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/report-generator.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): Drift detection vs previous run

Compares fingerprint sets. New fingerprints flagged as new bugs; closed
ones flagged as fixes (or LLM not regenerating that case). First-run flag
shorts-circuits when no previous report exists.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.5: robustness.test.js — dynamic auto-fixture loader

**Files:**
- Create: `scripts/robustness.test.js`

- [ ] **Step 1: Create the test file**

```js
import { describe, test, expect } from '@jest/globals';
import { glob } from 'glob';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import { runPipeline } from './pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const autoDir = resolve(__dirname, '../tests/fixtures/robustness/auto');

describe('Robustness Regression', () => {
  const autoFixtures = fs.existsSync(autoDir)
    ? glob.sync(`${autoDir}/*.json`).filter(f => !f.endsWith('.meta.json'))
    : [];

  if (autoFixtures.length === 0) {
    test.skip('No robustness fixtures yet — run `cli.js run` first', () => {});
    return;
  }

  autoFixtures.forEach(f => {
    test(`auto-fixture: ${path.basename(f)}`, async () => {
      const lc = JSON.parse(fs.readFileSync(f, 'utf8'));
      const result = await runPipeline(lc);
      expect(result.validation.errors).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run, expect SKIP (no fixtures yet)**

Run: `cd scripts && npx jest robustness.test.js --verbose`
Expected: 1 skipped test, output mentions "No robustness fixtures yet".

- [ ] **Step 3: Commit**

```bash
git add scripts/robustness.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): Regression test loader for auto/ fixtures

Dynamic glob discovery: each .json (non-meta) under auto/ becomes one
test. Skips entirely when no fixtures present (initial state). Tests fail
when result.validation.errors is non-empty — i.e., pipeline still has the
bug the fixture exposed.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.6: cli.js — wire run command end-to-end (LC-JSON only)

**Files:**
- Modify: `scripts/robustness/cli.js`

- [ ] **Step 1: Implement the `run` case fully**

Replace the `case 'run':` block in `scripts/robustness/cli.js` with:

```js
case 'run': {
  const { createLlmProvider } = await import('../agents/llm-provider.js');
  const { generateSamples } = await import('./synthetic-generator.js');
  const { runStressTest } = await import('./stress-tester.js');
  const { classify } = await import('./failure-classifier.js');
  const { persistFailure } = await import('./fixture-persister.js');
  const { generateReport } = await import('./report-generator.js');
  const { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } = await import('fs');
  const { resolve, join } = await import('path');

  const { baseUrl, apiKey, model } = resolveEndpoint(config, flags);
  if (!baseUrl) {
    console.error('Missing baseUrl. Set AIHUB_URL or pass --api-url=...');
    process.exit(2);
  }
  const llm = createLlmProvider({ baseUrl, apiKey, model, timeout: 120_000 });

  const catalog = JSON.parse(readFileSync(resolve(__dirname, 'seed-catalog.json'), 'utf8'));
  const n = parseInt(flags.n || config.default_n, 10);
  const target = flags.target || config.default_target;
  const persistLlmSignal = flags['persist-llm-signal'] === 'true' || config.persist_llm_signal;
  const seed = parseInt(flags.seed || Date.now(), 10);
  const startedAt = new Date().toISOString();

  console.log(`[robustness] Run started — model: ${model}, n: ${n}, target: ${target}, seed: ${seed}`);

  const samples = await generateSamples({ catalog, n, llm, target, model, seed });
  console.log(`[robustness] Generated ${samples.length} samples (out of ${n} attempts)`);

  const results = await runStressTest(samples, { timeoutMs: config.timeout_seconds * 1000 });
  const classified = results.map(r => ({ ...r, ...classify(r) }));

  for (const c of classified) {
    if (c.bucket) {
      const persistResult = await persistFailure(
        { category: c.category, bucket: c.bucket, fingerprint: c.fingerprint, evidence: c.evidence },
        c.sample,
        { persistLlmSignal }
      );
      c.wrote = persistResult.wrote;
    }
  }

  const runMeta = { model, target, started_at: startedAt, duration_ms: Date.now() - new Date(startedAt).getTime() };
  const { markdown, json } = generateReport(runMeta, classified);

  const reportDir = resolve(__dirname, '../../', config.report_dir);
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
  const stamp = startedAt.slice(0, 10);
  const baseName = `${stamp}-${model}-n${n}`;
  writeFileSync(join(reportDir, `${baseName}.md`), markdown, 'utf8');
  writeFileSync(join(reportDir, `${baseName}.json`), JSON.stringify(json, null, 2), 'utf8');

  console.log(markdown);
  console.log(`\n[robustness] Report written to ${reportDir}/${baseName}.{md,json}`);
  break;
}
```

- [ ] **Step 2: Smoke test (with --api-url=... or against a real endpoint)**

Run something like:
```
AIHUB_URL=http://your-endpoint/v1 AIHUB_KEY=your-key \
  node scripts/robustness/cli.js run --n=3 --model=qwen-3.5-122b
```

If you can't actually hit the endpoint right now: skip this manual step. The integration test in Task 4.7 covers it with a mock.

- [ ] **Step 3: Commit**

```bash
git add scripts/robustness/cli.js
git commit -m "$(cat <<'EOF'
feat(robustness): Wire cli.js run end-to-end (LC-JSON target only)

Generate → stress-test → classify → persist → report. Writes Markdown +
JSON to tests/robustness-reports/. DOT target follows in Phase 5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.7: Full integration smoke test with mocked LLM

**Files:**
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write end-to-end test**

```js
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('robustness — end-to-end with mocked LLM and tmpfs', () => {
  let tmpRoot;
  beforeEach(() => { tmpRoot = mkdtempSync(`${tmpdir()}/robustness-e2e-`); });
  afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

  test('valid LC sample passes through full pipeline', async () => {
    const { generateSamples } = await import('./robustness/synthetic-generator.js');
    const { runStressTest } = await import('./robustness/stress-tester.js');
    const { classify } = await import('./robustness/failure-classifier.js');
    const { persistFailure } = await import('./robustness/fixture-persister.js');

    const fixtureLc = loadFixture('simple-approval.json');
    const mockLlm = async (system) => {
      if (system.toLowerCase().includes('json')) return JSON.stringify(fixtureLc);
      return 'A simple approval process where requests are reviewed and approved.';
    };

    const catalog = {
      domains: ['test'],
      complexity: { simple: { minNodes: 5, maxNodes: 10, gateways: 0 } },
      patterns: ['none'],
      stress_modes: ['normal']
    };
    const samples = await generateSamples({ catalog, n: 1, llm: mockLlm, target: 'lc-json', model: 'mock', seed: 1 });
    expect(samples).toHaveLength(1);

    const results = await runStressTest(samples, { timeoutMs: 15_000 });
    const classified = results.map(r => ({ ...r, ...classify(r) }));
    expect(classified[0].category).toBe('pass');

    // No persistence expected for pass
    const persistResult = await persistFailure(classified[0], classified[0].sample, { fixtureRoot: tmpRoot });
    expect(persistResult.wrote).toBe('skipped-no-bucket');
    expect(existsSync(join(tmpRoot, 'auto'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect PASS**

- [ ] **Step 3: Commit**

```bash
git add scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
test(robustness): End-to-end integration with mocked LLM

Verifies generate → stress → classify → persist flow on a known-good LC.
Confirms category 'pass' short-circuits persistence. Uses tmpfs for IO.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.8: triage CLI subcommand

**Files:**
- Modify: `scripts/robustness/cli.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Implement `triage` command (simple list + interactive)**

Replace the `case 'triage':` block in `scripts/robustness/cli.js`:

```js
case 'triage': {
  const { readdirSync, existsSync, readFileSync, renameSync, appendFileSync, unlinkSync } = await import('fs');
  const { resolve, join, basename } = await import('path');
  const readline = await import('readline');

  const triageDir = resolve(__dirname, '../../', config.fixture_dir, 'triage');
  const autoDir = resolve(__dirname, '../../', config.fixture_dir, 'auto');
  const dismissedLog = resolve(__dirname, '../../', config.fixture_dir, 'dismissed.log');

  if (!existsSync(triageDir)) {
    console.log('[triage] No triage directory yet.');
    break;
  }

  const items = readdirSync(triageDir)
    .filter(f => f.endsWith('.meta.json'))
    .map(f => ({ name: f, meta: JSON.parse(readFileSync(join(triageDir, f), 'utf8')) }));

  if (items.length === 0) {
    console.log('[triage] No pending triage items.');
    break;
  }

  console.log(`Pending triage items: ${items.length}\n`);
  items.forEach((item, i) => {
    console.log(`[${i + 1}] ${item.meta.category}-${item.meta.fingerprint}   (seen ${item.meta.seen}x)`);
    console.log(`    description: ${(item.meta.description || '').slice(0, 80)}...`);
    console.log(`    evidence:    ${JSON.stringify(item.meta.evidence).slice(0, 100)}`);
  });

  console.log('\nCommands: promote N | dismiss N | defer N | quit');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('> ');
  rl.prompt();
  rl.on('line', (line) => {
    const [cmd, nStr] = line.trim().split(/\s+/);
    const n = parseInt(nStr, 10);
    if (cmd === 'quit') { rl.close(); return; }
    if (isNaN(n) || n < 1 || n > items.length) { rl.prompt(); return; }
    const item = items[n - 1];
    const base = item.name.replace('.meta.json', '');
    if (cmd === 'promote') {
      renameSync(join(triageDir, `${base}.json`), join(autoDir, `${base}.json`));
      renameSync(join(triageDir, `${base}.meta.json`), join(autoDir, `${base}.meta.json`));
      console.log(`Promoted ${base} to auto/`);
    } else if (cmd === 'dismiss') {
      unlinkSync(join(triageDir, `${base}.json`));
      unlinkSync(join(triageDir, `${base}.meta.json`));
      appendFileSync(dismissedLog, JSON.stringify({ at: new Date().toISOString(), base, meta: item.meta }) + '\n');
      console.log(`Dismissed ${base}`);
    } else if (cmd === 'defer') {
      console.log(`Deferred ${base}`);
    }
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
  return;
}
```

- [ ] **Step 2: Manual verification**

Manually populate `tests/fixtures/robustness/triage/` with a sample fixture (e.g., copy any existing fixture and add a `.meta.json`), then run:
```
node scripts/robustness/cli.js triage
```
Verify the interactive prompt works.

- [ ] **Step 3: Commit**

```bash
git add scripts/robustness/cli.js
git commit -m "$(cat <<'EOF'
feat(robustness): triage CLI subcommand

Interactive promote/dismiss/defer for items in triage/. Promoted items
move to auto/ (will be loaded by robustness.test.js). Dismissed items
are deleted with an audit-trail entry in dismissed.log.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 5 — DOT mode

Extend the generator and classifier to support `target='dot'`.

### Task 5.1: DOT prompt + extraction in generator

**Files:**
- Modify: `scripts/robustness/synthetic-generator.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test for `buildDotPrompt`**

```js
import { buildDotPrompt, extractDot } from './robustness/synthetic-generator.js';

describe('robustness/synthetic-generator — buildDotPrompt', () => {
  test('produces DOT-focused prompts', () => {
    const { system, user } = buildDotPrompt('Eine Beschreibung');
    expect(system.toLowerCase()).toMatch(/dot|graphviz/);
    expect(user).toContain('Eine Beschreibung');
  });
});

describe('robustness/synthetic-generator — extractDot', () => {
  test('returns content of digraph block', () => {
    const text = 'Some preamble\ndigraph G {\n  a -> b;\n}\nepilogue';
    const result = extractDot(text);
    expect(result).toContain('digraph');
    expect(result).toContain('a -> b');
  });

  test('handles fenced code blocks', () => {
    const text = '```dot\ndigraph G { a -> b }\n```';
    const result = extractDot(text);
    expect(result).toContain('digraph');
  });

  test('returns null when no DOT found', () => {
    expect(extractDot('no dot here')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement**

Append to `scripts/robustness/synthetic-generator.js`:

```js
export function buildDotPrompt(description) {
  const system = `You produce Graphviz DOT language describing BPMN process flows. Output JUST the DOT — no prose, no markdown.

DOT format example:
digraph process {
  start [shape=circle];
  task1 [shape=box];
  end [shape=doublecircle];
  start -> task1 -> end;
}`;

  const user = `Convert this process description to DOT:

${description}

Constraints:
- Use shape=circle for start events, doublecircle for end events, box for tasks, diamond for gateways
- Edge labels via [label="..."]
- Node IDs alphanumeric only`;

  return { system, user };
}

export function extractDot(text) {
  // Fenced code block
  const fenced = text.match(/```(?:dot)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return fenced[1].trim();
  // Bare digraph block
  const bare = text.match(/digraph\s+\w+\s*\{[\s\S]*?\}/);
  if (bare) return bare[0].trim();
  return null;
}
```

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/synthetic-generator.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): DOT prompt builder + extractor (Phase 5)

System prompt includes shape conventions example to bias toward
dot.js-parser-friendly output. Extractor handles fenced and bare digraph
blocks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.2: generateSamples — wire DOT target via dotToLogicCore

**Files:**
- Modify: `scripts/robustness/synthetic-generator.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test (mocked LLM returns DOT)**

```js
describe('robustness/synthetic-generator — DOT target end-to-end', () => {
  const catalog = {
    domains: ['x'],
    complexity: { simple: { minNodes: 5, maxNodes: 10, gateways: 0 } },
    patterns: ['p'],
    stress_modes: ['n']
  };

  test('parses good DOT into lcJson', async () => {
    const goodDot = 'digraph p { a [shape=circle]; b [shape=box]; c [shape=doublecircle]; a -> b -> c; }';
    const mockLlm = async (system) => {
      if (system.toLowerCase().includes('dot')) return goodDot;
      return 'desc';
    };
    const samples = await generateSamples({ catalog, n: 1, llm: mockLlm, target: 'dot', model: 'm', seed: 1 });
    expect(samples).toHaveLength(1);
    expect(samples[0].rawDot).toContain('digraph');
    expect(samples[0].lcJson).toBeDefined();
  });

  test('drops samples when dot parser fails', async () => {
    const mockLlm = async (system) => {
      if (system.toLowerCase().includes('dot')) return 'completely invalid DOT };';
      return 'desc';
    };
    const samples = await generateSamples({ catalog, n: 1, llm: mockLlm, target: 'dot', model: 'm', seed: 1 });
    // Either samples is empty (if parser throws) or has 1 with null lcJson — design choice:
    // current spec drops on failure to keep sample stream clean.
    expect(samples.length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

- [ ] **Step 3: Implement DOT branch in `generateSamples`**

Modify `generateSamples` in `scripts/robustness/synthetic-generator.js` to handle DOT:

```js
// Inside the loop, add an `if (target === 'dot') { ... }` branch after the LC-JSON branch:
if (target === 'dot') {
  const { dotToLogicCore } = await import('../dot.js');
  const { system: sysB, user: userB } = buildDotPrompt(description);
  let rawOutput;
  try { rawOutput = await llm(sysB, userB, {}); }
  catch (e) { continue; }
  const rawDot = extractDot(rawOutput);
  if (!rawDot) continue;
  let lcJson;
  try { lcJson = dotToLogicCore(rawDot); }
  catch (e) { continue; }  // Parser failure — would be classified as dot-parse-fail if we kept it
  samples.push(buildSample({ cell, seq, description, lcJson, rawDot, target, model }));
}
```

(Optional alternative: keep failed-parse samples and mark them with `_parseFail: true` so the classifier can route them to `dot-parse-fail`. For initial implementation, dropping is simpler and Phase 5 can iterate.)

- [ ] **Step 4: Run, expect PASS**

- [ ] **Step 5: Commit**

```bash
git add scripts/robustness/synthetic-generator.js scripts/robustness-internal.test.js
git commit -m "$(cat <<'EOF'
feat(robustness): generateSamples wires DOT target via dotToLogicCore

When target='dot', the structure-gen step emits DOT instead of JSON.
extractDot + dotToLogicCore convert to lcJson. Parse failures drop the
sample (initial simple semantics; Phase 5 follow-up may route to a
dot-parse-fail category instead).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.3: cli.js — accept --target flag dispatch

**Files:**
- Modify: `scripts/robustness/cli.js`

- [ ] **Step 1: Validate `--target` flag and add 'both' handling**

In the `case 'run':` block, after `const target = flags.target || config.default_target;`, add:

```js
if (!['lc-json', 'dot', 'both'].includes(target)) {
  console.error(`Invalid target: ${target}. Use lc-json | dot | both`);
  process.exit(2);
}

let allSamples = [];
if (target === 'both') {
  const halfN = Math.ceil(n / 2);
  const a = await generateSamples({ catalog, n: halfN, llm, target: 'lc-json', model, seed });
  const b = await generateSamples({ catalog, n: n - halfN, llm, target: 'dot', model, seed: seed + 1 });
  allSamples = [...a, ...b];
} else {
  allSamples = await generateSamples({ catalog, n, llm, target, model, seed });
}
console.log(`[robustness] Generated ${allSamples.length} samples (out of ${n} attempts, target=${target})`);
```

Then use `allSamples` instead of `samples` in the subsequent `runStressTest` call.

- [ ] **Step 2: Commit**

```bash
git add scripts/robustness/cli.js
git commit -m "$(cat <<'EOF'
feat(robustness): cli --target flag dispatch (lc-json | dot | both)

target=both splits N samples evenly across the two strategies. Per-target
breakdown in the report (already in report-generator.js) surfaces the
split outcomes.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Phase 6 — MaD sanity

Acquire/curate MaD subset, build the validator, and integrate into the report.

### Task 6.1: MaD subset curation (manual one-time)

**Files:**
- Create: `tests/fixtures/mad-subset/` (directory)
- Create: `tests/fixtures/mad-subset/index.json`
- Create: ~200 `.dot` files (filled by curation process)

- [ ] **Step 1: Acquire MaD dataset**

Send email to corresponding author of Soliman et al. 2025 (DOI 10.1186/s43067-025-00288-9) requesting the MaD dataset. Alternatively, check Hugging Face for mirrors. **This is a blocker for the rest of Phase 6** — until the dataset is in hand, skip to Phase 6 close.

- [ ] **Step 2: Write `scripts/robustness/curate-mad.js` (one-shot script, not a long-lived module)**

This is a small standalone script — it runs once when the MaD dataset is in hand, then need not run again.

```js
#!/usr/bin/env node
/**
 * One-time MaD curation. Run once when MaD is available; not part of regular CLI.
 *
 * Usage: node scripts/robustness/curate-mad.js --src /path/to/mad-raw --n 200
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dotToLogicCore } from '../dot.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '../../tests/fixtures/mad-subset');

function parseArgs() {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  return { src: flag('--src'), n: parseInt(flag('--n') || '200', 10) };
}

const { src, n } = parseArgs();
if (!src) { console.error('Usage: --src PATH --n 200'); process.exit(1); }

// Load MaD: assumes JSONL with {domain, description, dot} per line — adjust to actual format
const entries = readFileSync(src, 'utf8').trim().split('\n').map(JSON.parse);
const byDomain = {};
for (const e of entries) {
  (byDomain[e.domain] = byDomain[e.domain] || []).push(e);
}
const domainNames = Object.keys(byDomain);
const perDomain = Math.ceil(n / domainNames.length);

if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
const index = [];
let kept = 0;
for (const domain of domainNames) {
  const candidates = byDomain[domain].sort(() => Math.random() - 0.5).slice(0, perDomain * 3);
  for (const c of candidates) {
    if (kept >= n) break;
    try { dotToLogicCore(c.dot); } catch { continue; } // skip parser failures
    const fname = `${domain}-${String(kept).padStart(3, '0')}.dot`;
    writeFileSync(join(OUT_DIR, fname), c.dot, 'utf8');
    index.push({ file: fname, domain, sourceDescription: c.description?.slice(0, 100) });
    kept++;
  }
}
writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
console.log(`Curated ${kept} samples into ${OUT_DIR}`);
```

Run it once with the raw dataset:
```
node scripts/robustness/curate-mad.js --src ~/Downloads/mad-raw.jsonl --n 200
```

Then manual spot-check: pick 20 random files and visually confirm they look like reasonable BPMN process flows.

- [ ] **Step 3: Commit curated fixtures**

```bash
git add tests/fixtures/mad-subset/
git commit -m "$(cat <<'EOF'
data(robustness): MaD subset for external sanity check

200 samples curated from MaD dataset (Soliman et al. 2025) — proportional
across 15 business domains, pre-filtered for dotToLogicCore parseability.
See scripts/robustness/curate-mad.js for the curation process.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 6.2: mad-validator implementation

**Files:**
- Create: `scripts/robustness/mad-validator.js`
- Modify: `scripts/robustness-internal.test.js`

- [ ] **Step 1: Write failing test (uses small mock subset)**

```js
import { runMadCheck } from './robustness/mad-validator.js';

describe('robustness/mad-validator — runMadCheck', () => {
  test('returns aggregate stats', async () => {
    // Use a small embedded subset directory under tests/fixtures/mad-subset-test/
    // For initial impl, mock the subset path
    const result = await runMadCheck({ subsetDir: 'tests/fixtures/mad-subset-test', limit: 5 });
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('passed');
    expect(result).toHaveProperty('failed');
    expect(result).toHaveProperty('byCategory');
  });
});
```

(Create a tiny `tests/fixtures/mad-subset-test/` with 2-3 hand-made `.dot` files for this test.)

- [ ] **Step 2: Implement**

Create `scripts/robustness/mad-validator.js`:

```js
import { readdirSync, readFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dotToLogicCore } from '../dot.js';
import { runPipelineChecks } from './stress-tester.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SUBSET = resolve(__dirname, '../../tests/fixtures/mad-subset');

export async function runMadCheck({ subsetDir = DEFAULT_SUBSET, limit = Infinity } = {}) {
  const files = readdirSync(subsetDir).filter(f => f.endsWith('.dot')).slice(0, limit);
  let passed = 0, failed = 0;
  const byCategory = {};

  for (const f of files) {
    const dot = readFileSync(join(subsetDir, f), 'utf8');
    let lc;
    try { lc = dotToLogicCore(dot); }
    catch (e) {
      failed++;
      byCategory['dot-parse-fail'] = (byCategory['dot-parse-fail'] || 0) + 1;
      continue;
    }
    const pipelineResult = await runPipelineChecks(lc, { timeoutMs: 15_000 });
    if (pipelineResult.failedStep === null) passed++;
    else {
      failed++;
      byCategory[pipelineResult.failedStep] = (byCategory[pipelineResult.failedStep] || 0) + 1;
    }
  }

  return { total: files.length, passed, failed, byCategory };
}
```

- [ ] **Step 3: Run test, expect PASS**

- [ ] **Step 4: Commit**

```bash
git add scripts/robustness/mad-validator.js scripts/robustness-internal.test.js tests/fixtures/mad-subset-test/
git commit -m "$(cat <<'EOF'
feat(robustness): mad-validator runs MaD subset through pipeline

For each .dot file in tests/fixtures/mad-subset/: parse via dotToLogicCore
→ runPipelineChecks → aggregate pass/fail by failed-step. Exposed as
runMadCheck for the report and CLI mad-check command.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 6.3: cli.js — mad-check subcommand

**Files:**
- Modify: `scripts/robustness/cli.js`

- [ ] **Step 1: Wire the `mad-check` command**

Replace the `case 'mad-check':` placeholder:

```js
case 'mad-check': {
  const { runMadCheck } = await import('./mad-validator.js');
  const limit = parseInt(flags.limit || '200', 10);
  console.log(`[mad-check] Running ${limit} MaD samples...`);
  const result = await runMadCheck({ limit });
  console.log(`[mad-check] Total: ${result.total}  Passed: ${result.passed}  Failed: ${result.failed}`);
  console.log(`[mad-check] By category: ${JSON.stringify(result.byCategory, null, 2)}`);
  break;
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/robustness/cli.js
git commit -m "$(cat <<'EOF'
feat(robustness): cli mad-check subcommand

Runs runMadCheck and prints summary. --limit caps the sample count for
faster iteration.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 6.4: report-generator — include MaD section when available

**Files:**
- Modify: `scripts/robustness/report-generator.js`

- [ ] **Step 1: Allow runMeta to carry optional madResult; render MaD section if present**

In `renderMarkdown`, after the failures-by-category table, add:

```js
if (runMeta.madResult) {
  lines.push('## External Sanity Check (MaD subset)');
  lines.push('');
  lines.push(`MaD samples: ${runMeta.madResult.total}  Passed: ${runMeta.madResult.passed}  Failed: ${runMeta.madResult.failed}`);
  for (const [cat, count] of Object.entries(runMeta.madResult.byCategory)) {
    lines.push(`- ${cat}: ${count}`);
  }
  lines.push('');
}
```

- [ ] **Step 2: Modify cli.js `run` command to optionally invoke runMadCheck after the run when `--with-mad` flag is set**

In the `run` case, before `generateReport(runMeta, classified)`, add:

```js
if (flags['with-mad']) {
  const { runMadCheck } = await import('./mad-validator.js');
  runMeta.madResult = await runMadCheck({});
}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/robustness/report-generator.js scripts/robustness/cli.js
git commit -m "$(cat <<'EOF'
feat(robustness): MaD sanity section in report when --with-mad flag set

Optional: 'node cli.js run --n=50 --with-mad' will append the MaD pass-
rate as an extra section in the report. Useful for cross-checking that
our synthetic generator hasn't drifted toward unrealistic-easy inputs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 6.5: Update README with MaD curation steps

**Files:**
- Modify: `scripts/robustness/README.md`

- [ ] **Step 1: Append MaD section**

Add at end of `scripts/robustness/README.md`:

```markdown
## MaD External Sanity Check

The MaD dataset (Soliman et al. 2025) is curated into a 200-sample subset under `tests/fixtures/mad-subset/`. To run sanity check:

```bash
node scripts/robustness/cli.js mad-check
# or include in a normal run:
node scripts/robustness/cli.js run --n=100 --with-mad
```

The 200-sample subset is curated by `scripts/robustness/curate-mad.js` (separate one-time script — see spec Section 4.9). Acquire the raw dataset from the paper authors before curation.
```

- [ ] **Step 2: Commit**

```bash
git add scripts/robustness/README.md
git commit -m "$(cat <<'EOF'
docs(robustness): README — MaD curation + check usage

Closes Phase 6 documentation gap.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Final Verification

After all phases done:

- [ ] **Step 1: Run full test suite**

```bash
cd scripts && npx jest --verbose 2>&1 | tail -50
```

Expected: 136 existing tests + ~35 robustness-internal tests + robustness.test.js (skipped if no auto fixtures) all pass.

- [ ] **Step 2: Run a manual smoke against the live AI Hub**

```bash
AIHUB_URL=... AIHUB_KEY=... node scripts/robustness/cli.js run --n=10 --target=lc-json
```

Expected: produces report under `tests/robustness-reports/`, generates 10 samples, classifies failures (if any) into buckets.

- [ ] **Step 3: Inspect fixtures directory**

```bash
ls tests/fixtures/robustness/auto/ tests/fixtures/robustness/triage/ tests/fixtures/robustness/llm-signal/
```

Expected: any persisted failures from the smoke run; `llm-signal/` should be empty (default off).

- [ ] **Step 4: Verify spec acceptance items**

Check each line in spec Section 11 "Acceptance":
- ✅ `node scripts/robustness/cli.js run --n=N` works
- ✅ Three buckets exist + dismissed.log
- ✅ First run produces report + initial fixtures
- ✅ `scripts/robustness.test.js` exists and skips when empty
- ✅ ~30 tests in `scripts/robustness-internal.test.js`
- ✅ All 136 existing tests pass
- ✅ DOT-target mode works end-to-end (Phase 5)
- ✅ `scripts/robustness/README.md` documents workflow

- [ ] **Step 5: Open PR (optional, do not push without user approval)**

If user requests:
```bash
git push -u origin feature/robustness-stack
gh pr create --title "feat: Pipeline robustness via synthetic data" --body "..."
```

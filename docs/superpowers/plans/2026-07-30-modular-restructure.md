# Modular restructure — `bpmn/` + `dmn/` + `shared/`, with a docs gate that proves paths

> **For agentic workers:** this plan is written to be executed by a Sonnet-class session **without
> access to the conversation that produced it**. Everything you need is in this file. Follow it
> literally. Where it says STOP, stop and report — do not improvise. Use
> superpowers:executing-plans task-by-task; steps use checkbox (`- [ ]`) syntax.

**Goal:** three commits on branch `feat/dmn`, in this order:

- **Commit A** — the docs gate learns to prove that every path the documentation mentions exists.
  Guard first: this check is what verifies Commit B's documentation sweep.
- **Commit B** — the mechanical move: BPMN pipeline → `scripts/bpmn/`, shared core →
  `scripts/shared/`, tooling stays top-level. Provably behavior-identical.
- **Commit C** — split the BPMN layout constants out of `scripts/shared/utils.js` into
  `scripts/bpmn/constants.js`, so `shared/` carries only what both engines use.

**Non-goals:** no logic changes, no renamed exports, no formatting sweeps, no dependency changes,
no golden regeneration, no push, no PR. The npm public API must stay byte-for-byte identical in
behaviour (the `exports` map re-points; consumers of `bpmn-generator`, `bpmn-generator/import`,
`bpmn-generator/validate`, `bpmn-generator/orchestrator` notice nothing).

**Why (one paragraph of context):** a second notation (DMN, under `scripts/dmn/`) exists and a
third (ArchiMate) is planned. Today the top level of `scripts/` is BPMN + shared code + tooling in
one heap — BPMN would become the odd one out. What is shared is now *known*, not guessed:
`rule-profile.js`, `resource-paths.js`, and the core of `utils.js`. The restructure is done now,
before DMN Stages 3–7 create ~6 more files, so they are born in the right place. The docs-path
check comes first because a restructure mass-produces exactly the drift class the existing gate
cannot see: stale path strings in prose.

---

## Hard rules

1. Work on branch `feat/dmn`. **Never** touch `master`. Do not push. Do not open a PR.
2. **No `git add .` and no `git add -A`** — stage explicit paths. (`git mv` stages the rename
   itself; files you edit afterwards need `git add <path>` again.)
3. No `--no-verify`. No new dependencies. No edits to program logic — if a step seems to require
   one, STOP and report.
4. `npm test` and `npm run docs-gate` run from `scripts/`. Everything else from the repo root.
   (`node .github/scripts/docs-gate.mjs` from inside `scripts/` throws MODULE_NOT_FOUND — known
   trap, use `npm run docs-gate`.)
5. Repo language is **English** — code comments, doc edits, commit messages.
6. **STOP conditions** (stop, leave the tree as it is, report):
   - Any golden-file test (`.expected.bpmn` / `.expected.svg`) fails at any point. A pure move
     cannot legitimately move a golden. Do **not** regenerate.
   - Test totals differ from the Phase-0 baseline in any way you cannot attribute to a test you
     deliberately added in Commit A.
   - The byte-diff in Phase B7 is non-empty.
   - `npm run docs-gate` exits 2 (tooling error) after you applied every listed gate edit.
7. If reality disagrees with an inventory list in this plan (a file missing, an extra import),
   **update the mapping and continue** — the rewrite *rules* are authoritative, the enumerations
   are their verified snapshot as of 2026-07-30.

---

## File sets (used throughout; names without `.js`)

```
BPMN_SET (22):  pipeline validate rules optimize workflow-net topology layout coordinates
                di-check visual-refinement edge-simplify bpmn-xml svg icons dot schema-gate
                types import moddle-import redesign redesign-core redesign-cli
BPMN_TESTS (3): pipeline.test.js  visual-refinement.test.js  redesign.test.js
SHARED_SET (3): utils  rule-profile  resource-paths     (+ resource-paths.test.js)
STAYS top-level (7 runtime .js): audit delivery evaluate-slm http-server mcp-bpmn-server
                orchestrator prepare-training-data
STAYS also:     docs-gate.test.js dep-audit-gate.test.js http-server.test.js mcp-server.test.js
                orchestrator.test.js robustness.test.js robustness-internal.test.js
                build-skill.mjs prepack-copy-references.mjs postpack-clean-references.mjs
                config.json package.json agents/ robustness/ dmn/
```

---

## Commit A — the docs gate proves documented paths exist

Living documentation, in this repo's sense: a claim the gate can check is a claim that cannot
drift silently. The gate already proves numbers, DI codes, the HTTP contract and package
integrity. It does **not** check the dozens of `scripts/...` path strings in prose — and Commit B
is about to change nearly all of them.

- [ ] **A1.** In `.github/scripts/docs-gate.mjs`, add a fourth proof check `checkDocPaths(...)`,
      exported like the others (the test file imports named exports). Design:
      - **Files checked:** the existing `numberSources` set plus `references/api-reference.md` and
        `references/fachliches-regelwerk.md`.
      - **Extraction pattern 1 — explicit repo paths:** every match of
        `/(?:scripts|references|rules|tests|docs|frontend|\.github)\/[A-Za-z0-9_.\/-]+/g`.
        Before checking, strip trailing punctuation (`)`, `,`, `.`, `` ` ``, `:`), a `:<line>` or
        `:L<line>` suffix, and a `#fragment`. A token ending in `/` is a directory claim.
      - **Extraction pattern 2 — CLI examples:** every match of
        `/\bnode\s+((?:[\w.-]+\/)*[\w.-]+\.m?js)\b/g`. A CLI token passes if it exists relative to
        any of: `scripts/`, `scripts/robustness/`, repo root.
      - **Pass rule:** token exists on disk (file or directory), OR is matched by the allowlist.
      - **Allowlist** (documented-but-transient or generated; keep as a commented array):
        `scripts/references/` (prepack build artifact, removed by postpack),
        `references/omg-spec/` (gitignored, downloaded locally),
        `tests/robustness-reports/`, `docs/specs/`, `frontend/`, `audit/`, `dead-letter/`,
        `scripts/coverage/`, anything containing `*` or `<` (glob/placeholder, not a path).
      - **Finding text:** `"<file> mentions \"<token>\" — no such path in the repository"`.
- [ ] **A2. Calibrate to zero false positives on the CURRENT tree.** Run `npm run docs-gate`.
      Every finding is either (a) a genuinely stale documented path — fix the doc — or (b) a false
      positive — refine the pattern or extend the allowlist *with a reason comment*. Iterate until
      the gate is green. List every (a) you fixed in the commit message.
- [ ] **A3.** Tests in `scripts/docs-gate.test.js` (same style as the existing `checkNumbers`
      suite; pass texts and a probe function, not the real docs, where feasible): an existing path
      passes · a missing path is a finding · `:412`/`#L42` anchors are stripped · an allowlisted
      transient passes · `node pipeline.js` resolves against `scripts/` · a glob is ignored.
- [ ] **A4.** Document the new check: `CLAUDE.md` docs-gate section (one line: proof #4 — every
      documented repo path resolves), `CHANGELOG.md` `[Unreleased]` → **Added**.
- [ ] **A5.** Verify: `cd scripts && npm test` (all green, note the new totals as the baseline for
      Commit B) and `npm run docs-gate` (0 violations). Commit **A** — suggested subject:
      `feat(docs-gate): documented paths must exist — proof #4`. Stage explicit paths only.

---

## Commit B — the move

### B0. Baseline (before touching anything)

- [ ] `cd scripts && npm test 2>&1 | tail -3` — record the exact totals.
- [ ] Generate reference outputs (the strongest gate this commit has):
      ```bash
      mkdir -p /tmp/restructure-baseline
      cd scripts
      for f in simple-approval realistic-collaboration all-element-classes \
               expanded-subprocess subprocess-child-fidelity multi-pool-collaboration; do
        node pipeline.js ../tests/fixtures/$f.json /tmp/restructure-baseline/$f
      done
      ```
- [ ] `npm pack --dry-run --json > /tmp/restructure-baseline/pack.json` (file list for later
      comparison; `scripts/references/` copies appear — postpack removes them again).

### B1. Moves (pure `git mv`, no edits in this step)

- [ ] `mkdir scripts/bpmn scripts/shared`
- [ ] `cd scripts && git mv <each of BPMN_SET>.js bpmn/` (22 files)
- [ ] `git mv pipeline.test.js visual-refinement.test.js redesign.test.js bpmn/`
- [ ] `git mv utils.js rule-profile.js resource-paths.js resource-paths.test.js shared/`

### B2. Import rewrites — the complete rule table

Apply per group; then run the verification greps. Inventory verified 2026-07-30; rule 7 applies.

| In | Old specifier | New specifier |
|---|---|---|
| `bpmn/*.js` (incl. tests) | `'./utils.js'` / `'./rule-profile.js'` / `'./resource-paths.js'` | `'../shared/utils.js'` / `'../shared/rule-profile.js'` / `'../shared/resource-paths.js'` |
| `bpmn/*.js` intra-set (`'./types.js'` …) | — | **unchanged** (moved together) |
| `bpmn/pipeline.test.js` only | `'./http-server.js'` | `'../http-server.js'` |
| `bpmn/*.test.js` (all 3) | `resolve(__dirname, '../tests/fixtures'` … | `'../../tests/fixtures'` (grep `tests/fixtures` in each; also any `'../rules/'` profile path → `'../../rules/'`) |
| `dmn/*.js` | `'../utils.js'` / `'../rule-profile.js'` / `'../resource-paths.js'` | `'../shared/…'` (same three) |
| `agents/*.js` | `'../rules.js'`, `'../pipeline.js'`, `'../validate.js'` | `'../bpmn/…'` |
| `agents/prompt-sections.js` | `'../resource-paths.js'` | `'../shared/resource-paths.js'` |
| `robustness/*.js` | `'../dot.js'`, `'../validate.js'`, `'../rules.js'`, `'../pipeline.js'`, `'../import.js'` | `'../bpmn/…'` |
| top-level `*.js` (http-server, mcp-bpmn-server, orchestrator, evaluate-slm, prepare-training-data, robustness.test.js) | `'./pipeline.js'`, `'./rules.js'`, `'./import.js'`, `'./schema-gate.js'`, `'./validate.js'` | `'./bpmn/…'` |
| `shared/resource-paths.test.js` | dynamic `import('./schema-gate.js')` | `import('../bpmn/schema-gate.js')` |

- [ ] Verification grep — **must return nothing** (run from `scripts/`):
      ```bash
      grep -rnE "from '\.{1,2}/(pipeline|validate|rules|optimize|workflow-net|topology|layout|coordinates|di-check|visual-refinement|edge-simplify|bpmn-xml|svg|icons|dot|schema-gate|types|import|moddle-import|redesign|redesign-core|redesign-cli|utils|rule-profile|resource-paths)\.js'" \
        --include='*.js' . | grep -v node_modules | grep -vE "^\./(bpmn|shared)/" \
        | grep -vE "bpmn/(schema-gate|import)|shared/(utils|rule-profile|resource-paths)"
      ```
      (Intra-`bpmn/` and intra-`shared/` same-directory imports are the legitimate remainder; the
      command above excludes them. Anything it still prints is a missed rewrite.)

### B3. Path-sensitive internals — sed will not find these

- [ ] **`shared/utils.js`** — `loadConfig` reads `resolve(__dirname, 'config.json')`;
      `config.json` stays at `scripts/config.json`, so this becomes
      `resolve(__dirname, '..', 'config.json')`.
- [ ] **`shared/resource-paths.js`** — all four path constants move one level:
      `SOURCE_*  = join(__dirname, '..', '..', 'references', '<name>')`,
      `PACKAGED_* = join(__dirname, '..', 'references', '<name>')` (all three names). Keep every
      filename a **string literal inside the `join`** — the docs gate parses those literals; a
      variable would make it resolve a directory and report a false violation. Update the doc
      comment ("scripts/shared/ now; `..` twice reaches the repo root").
- [ ] **`shared/resource-paths.test.js`** — `PACKAGED_DIR` becomes
      `join(__dirname, '..', 'references')`, `REPO_REFERENCES` becomes
      `join(__dirname, '..', '..', 'references')`.
- [ ] **`scripts/docs-gate.test.js`** (stays top-level) — the two `checkPackageIntegrity` tests
      pin real paths: `'resource-paths.js'` → `'shared/resource-paths.js'` in the packedFiles
      arrays, and `join(__dirname, 'resource-paths.js')` →
      `join(__dirname, 'shared', 'resource-paths.js')` in the reachable sets.
- [ ] **`.github/scripts/docs-gate.mjs`** — `gatherNumberInputs` reads two moved files:
      `join(SCRIPTS_DIR, 'rules.js')` → `join(SCRIPTS_DIR, 'bpmn', 'rules.js')` and
      `join(SCRIPTS_DIR, 'di-check.js')` → `join(SCRIPTS_DIR, 'bpmn', 'di-check.js')`.
      The DMN path (`'dmn', 'rules.js'`) is already correct. The top-level script count command
      (`find scripts -maxdepth 1 …`) stays as is — the *claim* changes, not the counter.
- [ ] **`.github/workflows/ci.yml`** — smoke step (working-directory `scripts`):
      `node pipeline.js …` → `node bpmn/pipeline.js …`.
- [ ] **`scripts/package.json`** —
      ```jsonc
      "main": "./bpmn/pipeline.js",
      "exports": {
        ".":              "./bpmn/pipeline.js",
        "./import":       "./bpmn/import.js",
        "./validate":     "./bpmn/validate.js",
        "./orchestrator": "./orchestrator.js"
      },
      "files": [ "*.js", "bpmn/", "dmn/", "shared/", "config.json",
                 "agents/", "robustness/", "references/", "!**/*.test.js" ],
      "scripts": { "generate": "node bpmn/pipeline.js", …rest unchanged }
      ```
- [ ] **Explicitly NO change** (verified, and the executor must not "improve" them):
      `build-skill.mjs` (walks `scripts/` recursively; picks up `bpmn/`/`dmn/`/`shared/` by its
      existing rules), `prepack-copy-references.mjs` / `postpack-clean-references.mjs` (top-level,
      `__dirname` unchanged), `agents/prompt-sections.test.js`, `dep-audit-gate.test.js`,
      `robustness-internal.test.js` (imports only `./robustness/…` and `./agents/…`), jest config
      (default testMatch finds tests in subdirectories — `dmn/rules.test.js` already proves it).

### B4–B6. Documentation sweep

- [ ] `CLAUDE.md`: architecture header sentence → **"7 top-level scripts (standalone tooling) +
      22 bpmn-pipeline + 2 dmn (growing) + 3 shared + 7 agent + 9 robustness modules"** (the gate
      checks the `7`); move the existing per-file annotation lines under new `bpmn/` / `shared/`
      tree sections rather than rewriting them; Key-Files table, Development, CLI and
      Common-Tasks sections: `scripts/<X>.js` → `scripts/bpmn/<X>.js` for X ∈ BPMN_SET,
      `scripts/utils.js|rule-profile.js|resource-paths.js` → `scripts/shared/…`,
      `node pipeline.js` → `node bpmn/pipeline.js`, `node redesign-cli.js` →
      `node bpmn/redesign-cli.js`, `node import.js` → `node bpmn/import.js`.
- [ ] `README.md` and `SKILL.md`: same substitutions (≈23 hits across the three files —
      `grep -rn "node pipeline\.js\|node redesign-cli\.js\|node import\.js\|scripts/pipeline\.js" README.md SKILL.md CLAUDE.md`).
- [ ] `references/fachliches-regelwerk.md`: `scripts/rules.js` → `scripts/bpmn/rules.js` (the DMN
      references are already `scripts/dmn/…`).
- [ ] `CHANGELOG.md` `[Unreleased]` → **Changed** (draft):
      > **Modular layout: `scripts/bpmn/`, `scripts/dmn/`, `scripts/shared/`.** The BPMN pipeline
      > (22 modules incl. both importers and the redesign toolbox) moved to `scripts/bpmn/`; the
      > format-independent core (`utils`, `rule-profile`, `resource-paths`) to `scripts/shared/`;
      > standalone tooling stays top-level. Preparation for a third notation — every notation gets
      > the same internal shape. **The npm API is unchanged** (`exports` maps the public
      > specifiers onto the new paths; no shims, no major bump). CLI invocations change:
      > `node bpmn/pipeline.js …` from `scripts/`. Behaviour is provably identical — generated
      > outputs are byte-identical against the pre-move baseline.
- [ ] **Commit A's path check is now the completeness proof for this sweep** — any missed doc
      path fails the gate.

### B7. Verification battery (all must pass)

- [ ] `cd scripts && npm test` — totals **identical** to B0's baseline.
- [ ] `npm run docs-gate` — 0 violations (numbers, contract, package integrity, **doc paths**).
- [ ] Byte-identity:
      ```bash
      mkdir -p /tmp/restructure-after && cd scripts
      for f in simple-approval realistic-collaboration all-element-classes \
               expanded-subprocess subprocess-child-fidelity multi-pool-collaboration; do
        node bpmn/pipeline.js ../tests/fixtures/$f.json /tmp/restructure-after/$f
      done
      diff -r /tmp/restructure-baseline /tmp/restructure-after   # exactly one expected diff: pack.json lives only in baseline
      ```
      Any `.bpmn`/`.svg` difference → STOP.
- [ ] `npm pack --dry-run --json` — file list contains `bpmn/…`, `dmn/…`, `shared/…`, no
      `*.test.js`; `postpack` has removed `scripts/references/`.
- [ ] `node -e "import('bpmn-generator')"`-style check is not possible without publishing; instead:
      `cd scripts && node -e "import('./bpmn/pipeline.js').then(m=>console.log(typeof m.runPipeline))"`
      prints `function`, and `node bpmn/redesign-cli.js --help || true` runs without
      MODULE_NOT_FOUND.
- [ ] `git status` — only intended paths. Commit **B** — suggested subject:
      `refactor: modular layout — bpmn/, dmn/, shared/; npm API unchanged via exports map`.
      Body must state the byte-identity result and the baseline test totals.

---

## Commit C — `shared/utils.js` carries only what both engines use

- [ ] Create `scripts/bpmn/constants.js`: move these 13 exports out of `shared/utils.js`
      verbatim, importing `CFG` from `'../shared/utils.js'`:
      `SHAPE SW CLR LANE_HEADER_W LANE_PADDING LABEL_DISTANCE TASK_RX INNER_OUTER_GAP
      EXTERNAL_LABEL_H POOL_GAP COLLAB_PADDING MESSAGE_FLOW_FAN ARTIFACT_GAP`.
      Staying in `shared/utils.js`: `loadConfig CFG esc rn wrapText wrapTextByPx EXTENSION_NS
      EXTENSION_PREFIX`.
- [ ] Fix importers grep-driven:
      `grep -rln "SHAPE\|LANE_HEADER_W\|LANE_PADDING\|LABEL_DISTANCE\|TASK_RX\|INNER_OUTER_GAP\|EXTERNAL_LABEL_H\|POOL_GAP\|COLLAB_PADDING\|MESSAGE_FLOW_FAN\|ARTIFACT_GAP\|\\bSW\\b\|\\bCLR\\b" bpmn/ agents/`
      — for each hit that imports them from `'../shared/utils.js'`, split into two imports (the
      constants from `'./constants.js'`, the rest from `'../shared/utils.js'`). Expected files:
      `layout.js coordinates.js bpmn-xml.js svg.js icons.js visual-refinement.js`
      (+ possibly `edge-simplify.js`, `pipeline.js`). `dmn/` must import **none** of the 13 —
      verify with the same grep over `dmn/`.
- [ ] `CLAUDE.md`: script-count sentence 22 → 23 bpmn modules is **not** gate-checked (only the
      top-level `7` is) — still update the breakdown text and the Key-Files table
      (`scripts/shared/utils.js` row loses the constants, new `scripts/bpmn/constants.js` row).
- [ ] `CHANGELOG.md`: one line appended to the Changed entry.
- [ ] Full battery again: `npm test` (identical totals), `npm run docs-gate` (0), **byte-diff
      again** against `/tmp/restructure-baseline` (constants derivation must not change a single
      coordinate). Commit **C** — suggested subject:
      `refactor(shared): utils carries only what both engines use`.

---

## Final report (what the executor hands back)

Baseline vs. final test totals · docs-gate result per commit · byte-diff result (must be "no
differences") · list of stale doc paths Commit A's calibration found and fixed · anything rule 7
forced you to add to the mapping tables · confirmation that nothing was pushed.

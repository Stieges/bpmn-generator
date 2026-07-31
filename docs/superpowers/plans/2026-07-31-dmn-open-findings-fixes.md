# Fixing the open findings from the DMN Stages 3+4 build

## Context

Six tasks built a DMN 1.3 pipeline on branch `feat/dmn` (commits `9e6e3cd`..`a544fe1`). Every task
passed its review, and the repo now produces a `.dmn` file that validates against the normative
`DMN13.xsd`. Task 6's review, however, returned two Important findings, so that task is not
complete — and a verification pass over the ledger's deferred minors found three further real
correctness defects that had been recorded as style notes.

The goal here is to close all of it, so Task 6 can be marked complete and the final whole-branch
review can run against a clean tree.

Baseline: `cd scripts && npm test` → 1 skipped, 765 passed, 766 total. `npm run docs-gate` → 0
violations. Nothing pushed.

**Five premises were corrected while designing this** — each would have produced a red branch:

| Assumed | Actually |
|---|---|
| `loadRuleProfile` throws on a bad path | It swallows and returns `null` (`scripts/shared/rule-profile.js:28-35`). The test must document the swallow. |
| The `NaN` canvas hazard is silent | Only through the library path. Through the CLI, DD02 fires and `main()` exits 1. |
| `nextId` is reusable for id collisions | No — `collectIds` is Logic-Core-shaped, and `dmn/` must not import `bpmn/`. Copy the idiom, cite the source. |
| Sibling modules use inline `export function` | True only inside `scripts/shared/`. `scripts/dmn/layout.js:79` uses the same trailing form and stays as it is. |
| Adding `minLength` might break the existing missing-namespace test | It does not — that test deletes the key, which fails `required`, not `minLength`. |

## Approach

Nine commits. Three couplings are non-negotiable and drive the order:

- **C2 is indivisible.** Once C1 closes the empty-namespace hole, the *only* remaining reachable
  path into a `generateDmnXml` throw is the illegal-source case C2 itself adds. Splitting them
  ships the error handling untested.
- **C3 must not throw.** It runs at `pipeline.js:55`, one line outside the `try` C2 installs at
  `:58`. A throwing guard would reintroduce the rejected-promise defect C2 just closed. Use a
  finite-guard that degrades to `0`; the resulting degenerate geometry is DD01/DD02/DD03's job.
- **C4 before C6.** C4 builds the `spawnSync` harness and must leave the missing-file and
  bad-JSON paths alone — asserting today's stack trace there would turn red in C6.

### C1 — an empty namespace is rejected by the gate, not by the writer
`references/decision-core-schema.json` — add `"minLength": 1` to `namespace`. It is already in
`required`, so `""` currently passes the gate and throws later in `scripts/dmn/dmn-xml.js:233`.
Tests: +1 in `scripts/dmn/rules.test.js`, +1 in `scripts/dmn/pipeline.test.js`. **Δ +2.**

### C2 — name the information requirement's source type; a serialisation failure is an error, not a rejection
- `scripts/dmn/dmn-xml.js:180-183` — replace the binary if/else with three explicit arms mirroring
  the `authority` branch at `:188-192`: `decision → requiredDecision`, `inputData → requiredInput`,
  anything else → throw naming the illegal pair and citing DMN 1.3 §6.2.3 Table 2. Today a
  `knowledgeSource` source silently emits `requiredInput`, which the spec forbids.
- `scripts/dmn/pipeline.js:53-64` — wrap **only** `generateDmnXml` + `validateDmnXml`; on catch
  return `{ xml: null, diagrams, diagnostics, validation: { errors: ['[serialisation] …'], … } }`.
  **Keep `diagrams`/`diagnostics` real** rather than nulling them: in the two earlier early-returns
  `null` means "never computed", and here they were computed and are correct. Nulling would make
  `null` mean two things and discard a usable diagnostic.
- Reachable via `opts.ruleProfile` overriding D03 to `OFF` plus a `knowledgeSource --information→
  decision` requirement. Tests: +2 in `dmn-xml.test.js`, +1 in `pipeline.test.js` pinning the shape
  decision. **Δ +3.**

### C3 — a laid-out child without dimensions no longer poisons the canvas
`scripts/dmn/coordinates.js:67-68` — `laidOutGraph?.children ?? []`, and all four of
`x/y/width/height` through a finite-guard (`Number.isFinite(v) ? v : 0`). `??` alone is the weaker
fix: it does not catch `NaN`. Leave `requirementKey`'s `||` at `:55` alone — an empty-string `id`
*should* fall through to the derived key — and add a one-line comment saying so, or the next `??`
sweep will "fix" it. Tests: +2 in `coordinates.test.js`. **Δ +2.**

### C4 — CLI coverage, plus the ruleProfile option
`scripts/dmn/pipeline.test.js` has no CLI test at all: `main()`, all three `--strict` channels, flag
parsing, the `-` stdin path and the `writeFileSync` are untested. Copy the harness from
`scripts/bpmn/pipeline.test.js:2562-2582` verbatim in shape — `fs.mkdtempSync`, `spawnSync('node',
['pipeline.js', inPath, outBase], { cwd: __dirname })`, assertions on `status` / `stderr` /
`fs.existsSync(…dmn)`, no cleanup (the repo does not clean temp dirs).

Cover: no-arg usage exit; happy path; `-` stdin; schema-gate block; `--strict` with a B03 warning
(trigger as `pipeline.test.js:50-57` already does); both `--best-practice` spellings. Assert only
`--strict` channel 1 — channel 2 is unreachable and channel 3 has no known trigger; say so in a
comment. **Do not** touch missing-file or bad-JSON here.

For `opts.ruleProfile`: an object profile changes the outcome; a non-resolving string path falls
back to defaults — the test name must state that this documents a deliberate swallow, not a bug.
**Δ +8–10.**

### C5 — two blind spots
- `scripts/dmn/layout.test.js` — add `expect(graph.edges[0].id).toBe('req_0')` to the existing
  `chain()` test; the fallback at `layout.js:53-57` already runs there, it is just unasserted.
- `scripts/dmn/dmn-xml.test.js:217` — `hitPolicy` is unconditionally excluded from
  `assertFieldsSurvive`, so a non-default hit policy would survive serialisation *and* stop being
  checked. Add a describe that deep-clones the fixture in-test, sets `hitPolicy: 'FIRST'`, and runs
  `assertFieldsSurvive` **without** the exclusion. Use an in-test clone, not a second fixture file —
  a file would drag in a `tests/fixtures/dmn/README.md` update and risks being wired into the
  golden. `README.md` already predicts this behaviour; cite that line. **Δ +1.**

### C6 — the CLI reports an unreadable or unparseable input in one line
`scripts/dmn/pipeline.js:85-94` — one `try` around the read (both branches) and `JSON.parse`,
`catch (e) { console.error(\`✗ ${e.message}\`); process.exit(1); }`. Model:
`scripts/bpmn/redesign-cli.js:163-168`, but in **English** — that file is German, `dmn/pipeline.js`
is English with `✓`/`✗`/`⚠`.

Also here (to avoid a third commit touching this file): the comment at `pipeline.js:115-129`
recording that the diagram-diagnostics `--strict` channel is structurally live but currently
unreachable, because `di-check.js` classifies every finding `'ERROR'`; the mirror in
`scripts/bpmn/pipeline.js` *is* live because DI05 is WARNING. The channel stays.

Tests: +2, mirroring `scripts/bpmn/redesign.test.js:1864-1896`. The assertion that actually proves
"no stack trace" is the negative one: `stderr` must **not** match `/at .*pipeline\.js:/`. **Δ +2.**

### C7 — generated ids cannot collide with a document id
`scripts/dmn/dmn-xml.js:112-115` and `:124` — `${node.id}_var` / `_expr` collide if a document has
both `foo` and `foo_var`. Seed a collision set from the document's **whole** id space (node ids,
`decisionTable.id`, `input[].id`, `output[].id`, `rule[].id`, requirement keys — they all share one
`xsd:ID` space), then suffix `_2`, `_3`, … when taken. Cite `scripts/bpmn/redesign-core.js:104`
(`nextId`) as the idiom and state why it is not imported. No DMN rule checks duplicate ids today;
note that as separate work, do not add it here. Tests: +2. **Δ +2.**

**This is the only commit that can plausibly move the golden**, which is why it lands late — after
six green golden runs, any `.expected.dmn` diff is unambiguously attributable to it.

### C8 — wire NO_ID_TYPES in, drop an unused import, normalise exports
- `scripts/dmn/dmn-xml.js:37-39` — `NO_ID_TYPES` is declared with a full rationale and referenced
  nowhere. Extract `export function assertIdAllowed(type, attrs)` and call it from the private
  `create()`. Exporting the assertion (rather than `create` itself) makes the mechanism testable
  without opening the construction API. No existing call breaks — all three NO_ID_TYPE
  constructions pass no `id`. Tests: +2.
- `scripts/bpmn/coordinates.js:10` — drop `clipToRect` from the import; zero call sites in that
  file. It stays exported from `shared/geometry.js`, where `clipStraight` uses it internally.
- `scripts/shared/geometry.js` — inline `export function`, drop the trailing export statement.
  Scope the commit message to `shared/`; `dmn/layout.js` uses the same form deliberately. **Δ +2.**

### C9 — documentation
- `docs/superpowers/plans/2026-07-30-dmn-integration.md:166-169` — the `rule-profile.js` lift was
  `2f255c6` (extraction out of `rules.js`); `e611c67` was a 0-line rename into `shared/`. Name both.
- `CLAUDE.md` — add a Key-Files row for `scripts/shared/geometry.js` beside its three siblings. It
  is already in the architecture tree block. **Δ 0.**

## Files

| File | Commits |
|---|---|
| `scripts/dmn/pipeline.js` | C2, C6 |
| `scripts/dmn/dmn-xml.js` | C2, C7, C8 |
| `scripts/dmn/coordinates.js` | C3 |
| `references/decision-core-schema.json` | C1 |
| `scripts/dmn/pipeline.test.js` | C1, C2, C4 |
| `scripts/dmn/dmn-xml.test.js` | C2, C5, C7, C8 |
| `scripts/dmn/coordinates.test.js`, `layout.test.js`, `rules.test.js` | C3, C5, C1 |
| `scripts/bpmn/coordinates.js`, `scripts/shared/geometry.js` | C8 |
| `CLAUDE.md`, `docs/superpowers/plans/2026-07-30-dmn-integration.md` | C9 |

Reused rather than reinvented: the CLI harness at `scripts/bpmn/pipeline.test.js:2562-2582`; the
error-handling shape at `scripts/bpmn/redesign-cli.js:163-168`; the missing-file/bad-JSON test pair
at `scripts/bpmn/redesign.test.js:1864-1896`; `assertFieldsSurvive` in `scripts/dmn/dmn-xml.test.js`;
the `nextId` suffix idiom in `scripts/bpmn/redesign-core.js:104` (idiom only, not imported).

## Verification

Per commit, all four:

1. `cd scripts && npm test` → green, and the count matches the Δ above. **An unexplained count is
   as much a failure as a red test.**
2. `git diff --exit-code tests/fixtures/dmn/discount-decision.expected.dmn` → must exit 0. Any diff
   stops the commit. The golden is regenerated only after the diff is inspected line by line and the
   xmllint test re-run, and then in its own commit (`CLAUDE.md` golden-file procedure).
3. `cd scripts && npm run docs-gate` → 0 violations.
4. Explicit `git add` paths, no `--no-verify`, ES Modules, English.

End state: 1 skipped, ~788 passed, ~789 total; the golden byte-identical; `xmllint --noout --schema
references/omg-spec/normative/dmn/DMN13.xsd tests/fixtures/dmn/discount-decision.expected.dmn`
still reports `validates`.

**Which fixes could silently change generated output:** C7 (rewrites id generation — highest risk,
own commit, hard `git diff --exit-code` gate) and C2 (rewrites the requiredInput/requiredDecision
branch — but every `information` requirement in the fixture is `inputData→decision` or
`decision→decision`, both taking the same arm as before). C3 changes output only for inputs that
produce `NaN` today, i.e. already-broken ones. Everything else is schema, CLI, test, doc or
import-only and never reaches `moddle.toXML`.

After C9: mark Task 6 complete in the ledger and run the final whole-branch review.

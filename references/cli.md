# Setup and command-line reference

Load this when setting up the skill for the first time, or when you need a flag beyond the core
commands in `SKILL.md`. Every command below is meant to be **run**, from the `scripts/` directory.

## Contents

- [Setup](#setup)
- [BPMN pipeline](#bpmn-pipeline)
- [Format 2.0](#format-20)
- [BPMN import](#bpmn-import)
- [DMN, scenarios, redesign](#dmn-scenarios-redesign)
- [Exit codes and outputs](#exit-codes-and-outputs)

## Setup

Node.js 20 or newer. Once, in `scripts/`:

```bash
npm install --omit=dev    # runtime dependencies only: elkjs, bpmn-moddle, dmn-moddle, ajv, …
```

In a repository checkout, a plain `npm install` also installs the test tooling.

## BPMN pipeline

```bash
node bpmn/pipeline.js <input.json | -> [output-basename] [flags]
```

| Flag | Effect |
|------|--------|
| `--strict` | every warning is fatal: rule engine, diagram integrity (DI), Petri-net translation (NC), XML serialisation. Exit 1, no files written. **Use it before every delivery.** A DI05 that hint `H15` names (format 2.x: no order of the participants avoids the crossing) is printed but not counted. |
| `--optimize` | `optimize` mode: adds the opt-in optimisation advisories (O01–O04). Also `--mode=optimize` / `--mode=soll` |
| `--doc` | also writes `<output>.md`, a prose documentation of the process |
| `--decisions <a.json,b.dmn>` | Decision-Core JSON or `.dmn` files (routed by content); every `businessRuleTask` with a `decisionRef` gets its decision table in its documentation, as a marked section replaced on every run (`references/dmn.md`). Also `--decisions=<files>` |
| `--dot` | also writes `<output>.dot` (Graphviz) |
| `--import-dot` | the input is a `.dot` file written by `--dot`; converts it back to Logic-Core |
| `--drill-down` | writes the parent diagram plus one `<output>_<subprocessId>.bpmn/.svg` per subprocess (bypasses the DI/NC gates) |
| `--refine` / `--no-refine` | turns all visual-refinement passes on / off (lane compaction, dynamic lane header, label collision repair) |
| `--wrap` | wraps long chains (more than 20 nodes) into rows. With lanes it is accepted, but the rows shift like a staircase and the lane bands grow tall: one laned pool is one flat ELK graph and the bands are rebuilt from the nodes' y spans. Leave `--wrap` off for a model with lanes |
| `--bend-rule`, `--label-avoidance`, `--foreign-shape-repair` (and `--no-…`) | toggle individual layout repair passes; the defaults come from `config.json` |
| `--view=<name\|path>` or `--view <name\|path>` | the view for this call: a name is read from `views/`, any other value is a file. A flag given on the command line still wins over the view. See `README.md#views` |
| `--catalog <path>` or `--catalog=<path>` | the actor catalogue of a format 2.0 model, relative to the working directory. It wins over the model's own `"catalog"` field. Refused with a 1.x model. See [Format 2.0](#format-20) |

Examples:

```bash
node bpmn/pipeline.js my-process.json my-process --strict      # → my-process.bpmn + my-process.svg
echo '{ … }' | node bpmn/pipeline.js - out --strict            # Logic-Core from stdin
node bpmn/pipeline.js my-process.json my-process --optimize    # with advisories
node bpmn/pipeline.js my-process.json my-process --doc --dot   # extra outputs
```

### Format 2.0

A model with `"$schemaVersion": "2.0"` is read by the generate path only, so the commands above
apply with these limits: `--optimize`, `--mode=optimize`, `--mode=soll`, `--dot`, `--format=dot` and `--drill-down`
are refused for a 2.0 model; `--doc` works. The catalogue comes from `--catalog`, else from the
model's `"catalog"` field (relative to the model file; on standard input only `--catalog` works).
The lanes come from the view: `--view=rollen` gives lanes per performer, `--view=einheiten` lanes per
unit of the performer, `--view=organigramm` lanes per unit nested along the organigram (`partOf`), and
without a lanes view a 2.0 model gets role lanes. A lanes view on a 1.x model is an error. The model's
own `actors` beside a catalogue (`--catalog` or the `catalog` field) replace entries of it by id or
add new ids (hint H09 per replaced entry); a `scheme` there is C13. A unit cycle in `partOf` is C07.

```bash
node bpmn/pipeline.js my-process.json my-process --strict --view=rollen --catalog my-catalog.json
node bpmn/pipeline.js my-process.json my-process --strict --view=einheiten   # the model names its catalogue in "catalog"
node bpmn/pipeline.js my-process.json my-process --strict --view=organigramm # nested unit lanes
```

The orchestrator CLI (`orchestrator.js --input <model.json>`, run from a repository checkout; it is not
part of the skill bundle) reads a 2.0 model's catalogue the same way: `--catalog <path>` or
`--catalog=<path>` (relative to the working directory) wins over the model's `"catalog"` field
(relative to the model file); with a 1.x model or `--text` the flag is refused. See the README,
section Multi-Agent Orchestration.

The optional top-level `language` of a model (`"de"`, `"en"`, `"en-GB"`) selects the naming conventions of M01, M02, M05 and M06 and the event-marker inference; the CLI prints its hints (`ℹ [H10]` to `[H14]`) like `H01`, and they never fail `--strict`. Without `language` nothing changes. `BPMN_NAMING=<file>` extends the word lists of a shipped language (`references/naming-schema.json`, `$defs/Overlay`; read when a naming strategy is first used); a file that cannot be used makes the pipeline print `Pipeline error: NamingDataError: naming data "<path>" …` followed by a stack trace and exit 1. The shipped files `references/naming/<language>.json` carry the optional top-level `purpose` and `listNotes` (why each list exists; documentation only, the overlay has neither). Details: `references/modeling-guide.md`.

A 2.0 model's hints (H02–H06, H08, H09) are listed in `validation.hints` and never fail `--strict`. The messages of the 2.0-specific path (catalogue, format, lane formation) lead with their code, for example `✗ [C11] …` or `[F04] …` (exit 1, no stack trace). Rule messages (S, M, P, WF) keep their text unprefixed; their rule id is the `code` in `validation.findings`, a field of the library result that the CLI does not print. `--view=aligned-ports` docks message flows to or from a participant level with their other end. 1.x output is unchanged. The codes are in [`api-reference.md`](api-reference.md#message-codes). `node bpmn/import.js` prints `[N01] …` on stderr for a diagram generated from a 2.0 model. The
full rule for lanes and the entry points that accept 2.0 are in
[`logic-core-schema.md`](logic-core-schema.md#format-20-catalogue-and-lane-views).

The participant order of a collaboration is chosen automatically (partners that exchange messages
sit next to each other). To keep the declared order, set `layout.poolOrder` to `"declared"` in
`scripts/config.json`.

## BPMN import

```bash
node bpmn/import.js <input.bpmn | -> [output.json]
```

Details and caveats: `references/round-trip.md`.

## DMN, scenarios, redesign

```bash
node dmn/pipeline.js <input.json | -> [output-basename] [--strict] [--best-practice] [--doc]
node dmn/import.js <input.dmn | -> [output.json] [--strict]
node scenarios/pipeline.js <input.json | -> [output-basename] [--decisions <a.dmn,b.json>] [--strict]
node bpmn/redesign-cli.js <input.json> <transform> [options] [--apply] [-o out.json]
```

`dmn/pipeline.js` writes the `.dmn` file and the DRD as `.svg`; `--doc` adds `.md` (per decision:
question, inputs, outputs, the decision table), `.tables.svg` and `.tables.html` (every decision
table, drawn like dmn.io's table view; the HTML uses inline styles only, for a wiki page).

Details: `references/dmn.md` (the first three) and `references/redesign-toolbox.md` (the last).

## Exit codes and outputs

| Command | Writes | Exit ≠ 0 when |
|---------|--------|---------------|
| `bpmn/pipeline.js` | `.bpmn`, `.svg` (+ `.md`, `.dot` on request) | schema gate fails, an ERROR finding, or any warning under `--strict`; a `--decisions` file that cannot be read or fails the Decision-Core schema |
| `bpmn/import.js` | Logic-Core JSON | the input is not parseable BPMN |
| `dmn/pipeline.js` | `.dmn`, `.svg` (+ `.md`, `.tables.svg`, `.tables.html` with `--doc`) | schema gate fails, an ERROR finding, or any warning under `--strict` |
| `dmn/import.js` | Decision-Core JSON | not XML / not DMN, or a lossy import under `--strict` |
| `scenarios/pipeline.js` | `.scenarios.json`, `.scenarios.md` | invalid input; under `--strict` also any finding, an incomplete enumeration or a lossy DMN import |
| `bpmn/redesign-cli.js` | the transformed Logic-Core (only with `--apply`) | the transform refuses |

The HTTP API (`http-server.js`) and the MCP server (`mcp-bpmn-server.js`) are not part of the skill
bundle; they run from a repository checkout or the npm package — see `references/api-reference.md`.

# Setup and command-line reference

Load this when setting up the skill for the first time, or when you need a flag beyond the core
commands in `SKILL.md`. Every command below is meant to be **run**, from the `scripts/` directory.

## Contents

- [Setup](#setup)
- [BPMN pipeline](#bpmn-pipeline)
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
| `--strict` | every warning is fatal: rule engine, diagram integrity (DI), Petri-net translation (NC), XML serialisation. Exit 1, no files written. **Use it before every delivery.** |
| `--optimize` | `optimize` mode: adds the opt-in optimisation advisories (O01–O04). Also `--mode=optimize` / `--mode=soll` |
| `--doc` | also writes `<output>.md`, a prose documentation of the process |
| `--dot` | also writes `<output>.dot` (Graphviz) |
| `--import-dot` | the input is a `.dot` file written by `--dot`; converts it back to Logic-Core |
| `--drill-down` | writes the parent diagram plus one `<output>_<subprocessId>.bpmn/.svg` per subprocess (bypasses the DI/NC gates) |
| `--refine` / `--no-refine` | turns all visual-refinement passes on / off (lane compaction, dynamic lane header, label collision repair) |
| `--wrap` | wraps long chains (more than 20 nodes) into rows |
| `--bend-rule`, `--label-avoidance`, `--foreign-shape-repair` (and `--no-…`) | toggle individual layout repair passes; the defaults come from `config.json` |

Examples:

```bash
node bpmn/pipeline.js my-process.json my-process --strict      # → my-process.bpmn + my-process.svg
echo '{ … }' | node bpmn/pipeline.js - out --strict            # Logic-Core from stdin
node bpmn/pipeline.js my-process.json my-process --optimize    # with advisories
node bpmn/pipeline.js my-process.json my-process --doc --dot   # extra outputs
```

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
node dmn/pipeline.js <input.json | -> [output-basename] [--strict] [--best-practice]
node dmn/import.js <input.dmn | -> [output.json] [--strict]
node scenarios/pipeline.js <input.json | -> [output-basename] [--decisions <a.dmn,b.json>] [--strict]
node bpmn/redesign-cli.js <input.json> <transform> [options] [--apply] [-o out.json]
```

Details: `references/dmn.md` (the first three) and `references/redesign-toolbox.md` (the last).

## Exit codes and outputs

| Command | Writes | Exit ≠ 0 when |
|---------|--------|---------------|
| `bpmn/pipeline.js` | `.bpmn`, `.svg` (+ `.md`, `.dot` on request) | schema gate fails, an ERROR finding, or any warning under `--strict` |
| `bpmn/import.js` | Logic-Core JSON | the input is not parseable BPMN |
| `dmn/pipeline.js` | `.dmn` | schema gate fails, an ERROR finding, or any warning under `--strict` |
| `dmn/import.js` | Decision-Core JSON | not XML / not DMN, or a lossy import under `--strict` |
| `scenarios/pipeline.js` | `.scenarios.json`, `.scenarios.md` | invalid input; under `--strict` also any finding, an incomplete enumeration or a lossy DMN import |
| `bpmn/redesign-cli.js` | the transformed Logic-Core (only with `--apply`) | the transform refuses |

The HTTP API (`http-server.js`) and the MCP server (`mcp-bpmn-server.js`) are not part of the skill
bundle; they run from a repository checkout or the npm package — see `references/api-reference.md`.

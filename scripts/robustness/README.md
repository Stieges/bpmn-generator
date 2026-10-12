# Pipeline Robustness Stack

Offline tool for stress-testing the BPMN-Generator pipeline using LLM-generated synthetic inputs.

## Quick start

```bash
export AIHUB_URL=...
export AIHUB_KEY=...
node scripts/robustness/cli.js run --n=100
```

See `docs/ROBUSTNESS-STACK.md` for the full design.

## CLI

| Command | Purpose |
|---|---|
| `run --n=N --target=lc-json` | Stress run with N samples |
| `triage` | Review items in `tests/fixtures/robustness/triage/` |
| `mad-check` | Run external MaD-subset sanity check |
| `report --since=DATE` | Aggregate runs since DATE — **not implemented yet (Phase 4)**, the command exits with that message |

## Buckets

| Dir | Active | In tests |
|---|---|---|
| `tests/fixtures/robustness/auto/` | yes | yes (fail until fixed) |
| `tests/fixtures/robustness/triage/` | yes | no (review via `cli.js triage`) |
| `tests/fixtures/robustness/llm-signal/` | gated by `--persist-llm-signal` | no |

See the spec for details on the triage workflow.

## MaD External Sanity Check

The MaD dataset (Soliman et al. 2025) is curated into a 200-sample subset under `tests/fixtures/mad-subset/`. To run the sanity check:

```bash
node scripts/robustness/cli.js mad-check

# or include in a normal run:
node scripts/robustness/cli.js run --n=100 --with-mad
```

### One-time curation

The 200-sample subset is curated by `scripts/robustness/curate-mad.js` (separate one-shot script). Acquire the raw MaD dataset first:

1. Request from the paper authors (Soliman et al. 2025, DOI: 10.1186/s43067-025-00288-9), or check HuggingFace mirrors.
2. Run the curation: `node scripts/robustness/curate-mad.js --src ~/Downloads/mad-raw.jsonl --n 200`
3. Spot-check 20 random `.dot` files manually for "looks like reasonable BPMN process".
4. Commit `tests/fixtures/mad-subset/` to the repo.

After that, `node scripts/robustness/cli.js mad-check` runs the pipeline against each fixture and reports the pass rate — a sanity check that our synthetic generator hasn't drifted toward unrealistic-easy inputs.

## Extraction quality

The robustness runs above feed the pipeline synthetic models. This one measures the LLM path a user
takes: process text → `orchestrate()` (Modeler prompt, schema gate with repair, reviewer loop) →
Logic-Core, compared with a reference model of the same process.

```bash
cd scripts
node robustness/extraction-eval.js --api-url <url> --model <model> [--api-key <key>] \
  [--timeout 900] [--retries 3] [--extra-body '{"chat_template_kwargs":{"enable_thinking":false}}'] \
  --output /tmp/xeval
```

- Cases: `tests/fixtures/extraction-cases/*.json` — `{ "id", "text", "reference" }`, the reference a
  fixture file name in `tests/fixtures/` or `null` (then only the reference-free checks run).
- Comparison (`reference-compare.js`, `compareToReference`): participants (expanded vs. black box),
  lanes (missing, empty at the top level), activities matched by name (recall, precision, type and
  lane agreement, a step only inside a subprocess, a step written twice), gateways and boundary
  events counted. Thresholds in `config.json → extractionQuality`.
- Output: `<output>.md` (a row per case, then the findings) and `<output>.json` (everything,
  including every raw LLM answer).

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

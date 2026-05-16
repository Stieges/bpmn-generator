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

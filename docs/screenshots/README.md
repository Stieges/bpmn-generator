# Screenshot Gallery

SVG diagrams produced by the BPMN Generator from Logic-Core JSON fixtures in [`tests/fixtures/`](../../tests/fixtures/).
All files in this directory are regenerated from the fixtures by `node scripts/pipeline.js <fixture> <out>`, so they always reflect the current state of the layout engine.

| File | Source fixture | What it shows |
|---|---|---|
| [01-simple-approval.svg](01-simple-approval.svg) | `simple-approval.json` | Single-pool linear flow with one gateway and a happy-path/exception branch. The baseline rendering — start event, tasks, exclusive gateway, end event. |
| [02-multi-pool-collaboration.svg](02-multi-pool-collaboration.svg) | `multi-pool-collaboration.json` | Two pools (Customer + Service Department), three lanes (Customer / Manager / Agent), two message flows (Request + Response). The differentiation example — `bpmn-auto-layout` renders zero pool/lane shapes for this input ([benchmark](../../tests/bench/auto-layout-comparison.md)). |
| [03-multi-lane-pool.svg](03-multi-lane-pool.svg) | `sparse-lanes.json` | Single pool with four lanes (Frontend / Backend / Ops / QA). Demonstrates lane partitioning + cross-lane sequence flow routing. |
| [04-expanded-subprocess.svg](04-expanded-subprocess.svg) | `expanded-subprocess.json` | Process with an expanded SubProcess containing inner activities. The SubProcess shape is sized to encompass its children (ELK compound layout). |

## See also

- [`comparison-*.html`](../../tests/bench/) — side-by-side HTML pages comparing our output against `bpmn-auto-layout@1.3.0` for the same fixtures.
- [`EVALUATION.md`](../../EVALUATION.md) — reproducible metrics, competitor matrix, and the data behind these screenshots.
- [`stieges-bench-v1.md`](../../tests/bench/stieges-bench-v1.md) — pipeline benchmark (parse rate, soundness, edge crossings) across all 9 fixtures.

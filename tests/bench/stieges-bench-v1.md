# Stieges-Bench v1

Deterministic pipeline benchmark over every Logic-Core fixture in
`tests/fixtures/*.json`. No LLM, no network. Reproducible via
`node scripts/bench/run-stieges-bench-v1.mjs`.

- Generated: 2026-07-31T16:27:06.883Z
- Commit: 2cb6a9566e15d51ff8a5bd5bffcfe5ae94fd3258
- Fixtures: 12
- All parsed: YES

## Per-fixture results

| Fixture | Parses | Serialized | Schema | Nodes | Edges | Sound-Err | Sound-Warn | Crossings | BPMN (B) | SVG (B) | Time (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| all-element-classes | yes | yes | yes | 11 | 6 | 0 | 3 | 0 | 7578 | 11623 | 106.91 |
| bpmn-generator-pipeline | yes | yes | yes | 22 | 31 | 0 | 4 | 10 | 28811 | 55807 | 51.97 |
| deadlock-process | yes | no | yes | 7 | 7 | 1 | 3 | 0 | 0 | 0 | 0.16 |
| dense-edge-labels | yes | yes | yes | 9 | 12 | 0 | 6 | 0 | 9424 | 11006 | 20.57 |
| expanded-subprocess | yes | yes | yes | 4 | 3 | 0 | 1 | 0 | 5389 | 9283 | 12.75 |
| long-lane-names | yes | yes | yes | 5 | 4 | 0 | 4 | 0 | 4605 | 7184 | 8.82 |
| multi-pool-collaboration | yes | yes | yes | 12 | 13 | 0 | 0 | 0 | 11041 | 13780 | 17.9 |
| realistic-collaboration | yes | yes | yes | 29 | 31 | 0 | 6 | 6 | 25453 | 32974 | 28.72 |
| simple-approval | yes | yes | yes | 6 | 6 | 0 | 1 | 0 | 5704 | 9515 | 10.34 |
| sparse-lanes | yes | yes | yes | 11 | 13 | 0 | 4 | 1 | 9753 | 13522 | 13.08 |
| subprocess-child-fidelity | yes | yes | yes | 3 | 2 | 0 | 0 | 0 | 9812 | 15593 | 16.99 |
| wide-pipeline | yes | yes | yes | 27 | 26 | 0 | 25 | 0 | 16420 | 30523 | 17.55 |

## Totals

- Fixtures that parse (runPipeline didn't throw): **12 / 12**
- Fixtures that serialize (non-empty BPMN+SVG): **11 / 12**
- Schema-valid inputs: **12 / 12**
- Total nodes: **146**
- Total edges: **154**
- Total soundness errors: **1**
- Total soundness warnings: **57**
- Total edge crossings: **17**
- Cumulative wall-clock: **305.76 ms**
- Output bytes (BPMN + SVG): **344800**

## Notes

- **Parses**: `runPipeline` did not throw.
- **Serialized**: pipeline produced non-empty BPMN + SVG. When
  rule-engine ERROR findings exist, the pipeline aborts
  serialization on purpose (no diagram for an unsound model) but
  does not throw — so `parses=yes`, `serialized=no` is the
  expected outcome for fixtures like `deadlock-process`.
- "Sound-Err" counts rule-engine ERROR findings (Soundness layer).
- "Sound-Warn" counts WARNING-level findings (Style + Pragmatics).
- "Crossings" is a quadratic O(E^2) scan of edge polylines using a
  CCW-orientation segment-intersection test. Endpoint touches are not
  filtered, so a small non-zero count for connected edges is normal.
- Wall-clock is single-run (no warmup); for tight comparisons rerun.

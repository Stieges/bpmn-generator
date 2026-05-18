# Stieges-Bench v1

Deterministic pipeline benchmark over every Logic-Core fixture in
`tests/fixtures/*.json`. No LLM, no network. Reproducible via
`node scripts/bench/run-stieges-bench-v1.mjs`.

- Generated: 2026-05-18T13:22:51.757Z
- Commit: 332761314bb0a182e7d988cbfb0ffc9f778243e4
- Fixtures: 9
- All parsed: YES

## Per-fixture results

| Fixture | Parses | Serialized | Schema | Nodes | Edges | Sound-Err | Sound-Warn | Crossings | BPMN (B) | SVG (B) | Time (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bpmn-generator-pipeline | yes | yes | yes | 22 | 31 | 0 | 4 | 10 | 28994 | 54838 | 163.5 |
| deadlock-process | yes | no | yes | 7 | 7 | 1 | 1 | 0 | 0 | 0 | 0.25 |
| dense-edge-labels | yes | yes | yes | 9 | 12 | 0 | 1 | 1 | 9784 | 10661 | 23.15 |
| expanded-subprocess | yes | yes | yes | 4 | 3 | 0 | 1 | 0 | 5377 | 8901 | 13.91 |
| long-lane-names | yes | yes | yes | 5 | 4 | 0 | 4 | 0 | 4675 | 6825 | 10.32 |
| multi-pool-collaboration | yes | yes | yes | 11 | 12 | 0 | 0 | 1 | 10343 | 12526 | 17.34 |
| simple-approval | yes | yes | yes | 6 | 6 | 0 | 0 | 0 | 5747 | 8945 | 13.75 |
| sparse-lanes | yes | yes | yes | 11 | 13 | 0 | 0 | 7 | 10066 | 13165 | 14.7 |
| wide-pipeline | yes | yes | yes | 27 | 26 | 0 | 0 | 0 | 16414 | 30144 | 19.34 |

## Totals

- Fixtures that parse (runPipeline didn't throw): **9 / 9**
- Fixtures that serialize (non-empty BPMN+SVG): **8 / 9**
- Schema-valid inputs: **9 / 9**
- Total nodes: **102**
- Total edges: **114**
- Total soundness errors: **1**
- Total soundness warnings: **11**
- Total edge crossings: **19**
- Cumulative wall-clock: **276.26 ms**
- Output bytes (BPMN + SVG): **237405**

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

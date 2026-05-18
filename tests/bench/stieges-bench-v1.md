# Stieges-Bench v1

Deterministic pipeline benchmark over every Logic-Core fixture in
`tests/fixtures/*.json`. No LLM, no network. Reproducible via
`node scripts/bench/run-stieges-bench-v1.mjs`.

- Generated: 2026-05-18T14:02:34.240Z
- Commit: 5a0a628487d51b9321d39e75c4c0e7629ae7c7e6
- Fixtures: 9
- All parsed: YES

## Per-fixture results

| Fixture | Parses | Serialized | Schema | Nodes | Edges | Sound-Err | Sound-Warn | Crossings | BPMN (B) | SVG (B) | Time (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bpmn-generator-pipeline | yes | yes | yes | 22 | 31 | 0 | 4 | 9 | 28373 | 54961 | 148.76 |
| deadlock-process | yes | no | yes | 7 | 7 | 1 | 1 | 0 | 0 | 0 | 0.14 |
| dense-edge-labels | yes | yes | yes | 9 | 12 | 0 | 1 | 0 | 9424 | 10639 | 20.52 |
| expanded-subprocess | yes | yes | yes | 4 | 3 | 0 | 1 | 0 | 5389 | 8913 | 13.06 |
| long-lane-names | yes | yes | yes | 5 | 4 | 0 | 4 | 0 | 4690 | 6839 | 9.14 |
| multi-pool-collaboration | yes | yes | yes | 11 | 12 | 0 | 0 | 1 | 10220 | 12562 | 16.03 |
| simple-approval | yes | yes | yes | 6 | 6 | 0 | 0 | 0 | 5685 | 8959 | 10.19 |
| sparse-lanes | yes | yes | yes | 11 | 13 | 0 | 0 | 2 | 9868 | 13175 | 13.46 |
| wide-pipeline | yes | yes | yes | 27 | 26 | 0 | 0 | 0 | 16420 | 30148 | 20.32 |

## Totals

- Fixtures that parse (runPipeline didn't throw): **9 / 9**
- Fixtures that serialize (non-empty BPMN+SVG): **8 / 9**
- Schema-valid inputs: **9 / 9**
- Total nodes: **102**
- Total edges: **114**
- Total soundness errors: **1**
- Total soundness warnings: **11**
- Total edge crossings: **12**
- Cumulative wall-clock: **251.62 ms**
- Output bytes (BPMN + SVG): **236265**

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

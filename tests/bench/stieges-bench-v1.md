# Stieges-Bench v1

Deterministic pipeline benchmark over every Logic-Core fixture in
`tests/fixtures/*.json`. No LLM, no network. Reproducible via
`node scripts/bench/run-stieges-bench-v1.mjs`.

- Generated: 2026-05-18T13:35:20.103Z
- Commit: 718921540162c9fc843b365e3e9b5a50d7415f93
- Fixtures: 9
- All parsed: YES

## Per-fixture results

| Fixture | Parses | Serialized | Schema | Nodes | Edges | Sound-Err | Sound-Warn | Crossings | BPMN (B) | SVG (B) | Time (ms) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| bpmn-generator-pipeline | yes | yes | yes | 22 | 31 | 0 | 4 | 11 | 29093 | 55157 | 169.25 |
| deadlock-process | yes | no | yes | 7 | 7 | 1 | 1 | 0 | 0 | 0 | 0.13 |
| dense-edge-labels | yes | yes | yes | 9 | 12 | 0 | 1 | 0 | 9738 | 10709 | 22.99 |
| expanded-subprocess | yes | yes | yes | 4 | 3 | 0 | 1 | 0 | 5389 | 8913 | 13.9 |
| long-lane-names | yes | yes | yes | 5 | 4 | 0 | 4 | 0 | 4690 | 6839 | 9.42 |
| multi-pool-collaboration | yes | yes | yes | 11 | 12 | 0 | 0 | 1 | 10375 | 12598 | 17.85 |
| simple-approval | yes | yes | yes | 6 | 6 | 0 | 0 | 0 | 5763 | 8977 | 11.45 |
| sparse-lanes | yes | yes | yes | 11 | 13 | 0 | 0 | 7 | 10124 | 13251 | 13.74 |
| wide-pipeline | yes | yes | yes | 27 | 26 | 0 | 0 | 0 | 16420 | 30148 | 18.91 |

## Totals

- Fixtures that parse (runPipeline didn't throw): **9 / 9**
- Fixtures that serialize (non-empty BPMN+SVG): **8 / 9**
- Schema-valid inputs: **9 / 9**
- Total nodes: **102**
- Total edges: **114**
- Total soundness errors: **1**
- Total soundness warnings: **11**
- Total edge crossings: **19**
- Cumulative wall-clock: **277.64 ms**
- Output bytes (BPMN + SVG): **238184**

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

# BPMN Generator vs `bpmn-auto-layout` — Pools/Lanes Comparison

Generated: 2026-05-18T14:09:57.615Z
bpmn-auto-layout version: 1.3.0

## Method

For each fixture: generate BPMN with our pipeline, strip the `<bpmndi:BPMNDiagram>` section, feed the semantic-only XML to `bpmn-auto-layout.layoutProcess()`, and compare element counts. The hypothesis is that `bpmn-auto-layout` either errors out, silently drops semantic elements, or omits DI for pools/lanes/message-flows in multi-pool scenarios.

## Semantic Preservation

Counts of `<bpmn:*>` elements before/after. These should be identical — a layout engine is not supposed to delete semantic elements. Mismatches are marked with ⚠.

| Fixture | Participants (ours / theirs) | Lanes (ours / theirs) | MsgFlows (ours / theirs) | SeqFlows (ours / theirs) | Their error |
|---|---|---|---|---|---|
| simple-approval.json | 1 / 1 | 1 / 1 | 0 / 0 | 6 / 6 | — |
| multi-pool-collaboration.json | 2 / 2 | 3 / 3 | 2 / 2 | 11 / 11 | — |
| sparse-lanes.json | 1 / 1 | 4 / 4 | 0 / 0 | 13 / 13 | — |

## DI Output

Counts of `<bpmndi:*>` elements — what the layout engine actually drew. Missing pool/lane shapes or message-flow edges in "theirs" means the layout engine refused to draw them.

| Fixture | Pool shapes (ours / theirs) | Lane shapes (ours / theirs) | MsgFlow edges (ours / theirs) | SeqFlow edges (ours / theirs) | Total shapes (ours / theirs) | Total edges (ours / theirs) |
|---|---|---|---|---|---|---|
| simple-approval.json | 1 / 0 ⚠ | 1 / 0 ⚠ | 0 / 0 | 6 / 6 | 8 / 6 ⚠ | 6 / 6 |
| multi-pool-collaboration.json | 2 / 0 ⚠ | 3 / 0 ⚠ | 2 / 0 ⚠ | 11 / 3 ⚠ | 17 / 4 ⚠ | 13 / 3 ⚠ |
| sparse-lanes.json | 1 / 0 ⚠ | 4 / 0 ⚠ | 0 / 0 | 13 / 13 | 16 / 11 ⚠ | 13 / 13 |

## Interpretation

- **Semantic mismatch** (⚠ in first table): the layout engine dropped semantic elements — a serious data loss.
- **DI mismatch** (⚠ in second table): the layout engine refused to draw elements (typically pools beyond the first, or message flows). The BPMN file is still semantically valid but visually incomplete; rendering tools may show errors or invisible elements.
- **"Their error"**: outright rejection of the input.

Per the upstream README (`node_modules/bpmn-auto-layout/README.md`):

> * Given a collaboration only the first participant's process will be laid out
> * Sub-processes will be laid out as collapsed sub-processes
> * The following elements are not laid out:
>   * Groups
>   * Text annotations
>   * Associations
>   * Message flows

## Per-fixture artifacts

- `simple-approval.ours.bpmn` — our pipeline output
- `simple-approval.theirs.bpmn` — bpmn-auto-layout output
- `multi-pool-collaboration.ours.bpmn` — our pipeline output
- `multi-pool-collaboration.theirs.bpmn` — bpmn-auto-layout output
- `sparse-lanes.ours.bpmn` — our pipeline output
- `sparse-lanes.theirs.bpmn` — bpmn-auto-layout output

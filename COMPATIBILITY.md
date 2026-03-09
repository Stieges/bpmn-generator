# BPMN Compatibility Report

## Target: bpmn.io (bpmn-js)

The generated `.bpmn` files are designed to be compatible with [bpmn.io](https://bpmn.io/) / bpmn-js, the de-facto standard BPMN viewer/editor.

### Namespace Compliance

| Namespace | URI | Status |
|-----------|-----|--------|
| BPMN 2.0 Model | `http://www.omg.org/spec/BPMN/20100524/MODEL` | OK |
| BPMN DI | `http://www.omg.org/spec/BPMN/20100524/DI` | OK |
| DC | `http://www.omg.org/spec/DD/20100524/DC` | OK |
| DI | `http://www.omg.org/spec/DD/20100524/DI` | OK |
| XSI | `http://www.w3.org/2001/XMLSchema-instance` | OK |
| Target Namespace | `http://bpmn.io/schema/bpmn` | OK |

### Element Support

| Element | Generated | bpmn.io Compatible | Notes |
|---------|-----------|-------------------|-------|
| Task types (user, service, script, send, receive, manual, business rule) | Yes | Yes | |
| Call Activity | Yes | Yes | Bold border |
| Sub-Process (collapsed) | Yes | Yes | [+] marker |
| Sub-Process (expanded) | Yes | Yes | Inline children |
| Transaction | Yes | Yes | Double border (§13.2.2) |
| Event Sub-Process | Yes | Yes | Dashed border |
| Start/End Events | Yes | Yes | All marker types |
| Intermediate Events (catch/throw) | Yes | Yes | |
| Boundary Events (interrupting/non-interrupting) | Yes | Yes | |
| Gateways (XOR, AND, OR, Event-Based, Complex) | Yes | Yes | |
| Sequence Flows | Yes | Yes | With conditions, defaults |
| Message Flows | Yes | Yes | Cross-pool |
| Lanes/LaneSets | Yes | Yes | Single laneSet per process |
| Pools (expanded) | Yes | Yes | Horizontal |
| Pools (collapsed/black-box) | Yes | Yes | No processRef |
| Data Objects | Yes | Yes | With collection marker |
| Data Stores | Yes | Yes | |
| Text Annotations | Yes | Yes | |
| Groups | Yes | Yes | |
| Associations | Yes | Yes | Directed/undirected |

### DI (Diagram Interchange) Support

| Feature | Status | Notes |
|---------|--------|-------|
| BPMNShape with Bounds | OK | |
| isHorizontal on pools/lanes | OK | |
| isMarkerVisible on XOR gateways | OK | |
| isExpanded on sub-processes | OK | |
| BPMNEdge with waypoints | OK | Orthogonal routing |
| BPMNLabel Bounds | OK | Events, gateways, edge labels |

### Known Limitations

1. **No Camunda extensions** — No `camunda:` namespace attributes (formKey, assignee, etc.)
2. **No color extensions** — Uses default bpmn-js colors only
3. **Timer expressions** — Timer events have empty `<timerEventDefinition/>` (no duration/cycle)
4. **Conditional expressions** — Uses `tFormalExpression` with label text as expression body

### Verification

To verify compatibility, open generated `.bpmn` files at:
- https://demo.bpmn.io/ (online viewer)
- Camunda Modeler (desktop)

```bash
# Generate test output
node scripts/pipeline.js tests/fixtures/simple-approval.json /tmp/test
# Open /tmp/test.bpmn in bpmn.io
```

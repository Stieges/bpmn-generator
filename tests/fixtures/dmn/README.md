# tests/fixtures/dmn/

## `discount-decision.json`

Reference Decision-Core fixture used by `scripts/dmn/rules.test.js` and `scripts/dmn/dmn-xml.test.js`.
Exercises every node type and every requirement kind. See `scripts/dmn/rules.js`'s own doc comment
for the rule-engine side.

## Golden-file normalisation, measured 2026-07-31 (Task 5)

`hitPolicy` and `preferredOrientation` are both declared `use="optional"` with an explicit XSD
default (`UNIQUE`, `Rule-as-Row` respectively) — the schema treats them identically
(`docs/superpowers/research/dmn13-xsd-ground-truth.md` §D8). Any asymmetry in what dmn-moddle emits
on write is **library behaviour**, not something the XSD justifies. Observed by running
`dmn-moddle@12.0.1`'s `toXML` directly (Task 5, Step 3):

The observed tag was `<dmn:decisionTable id="Table_1" preferredOrientation="Rule-as-Row">`:
`hitPolicy="UNIQUE"` was dropped, `preferredOrientation="Rule-as-Row"` was kept.
`discount-decision.expected.dmn` (Task 6) must match this observation byte-for-byte — do not
hand-edit the golden file to "restore" an attribute that dmn-moddle itself omits.

**The mechanism** (found on review, confirmed against the real descriptor): moddle-xml's writer
omits any attribute value that equals its property's descriptor `default`. `hitPolicy`'s
descriptor carries `"default": "UNIQUE"`; `preferredOrientation`'s descriptor carries no `default`
key at all. Verified directly —
`moddle.getType('dmn:DecisionTable').$descriptor.properties` shows `hitPolicy: { default: "UNIQUE",
... }` and `preferredOrientation: { ... }` with no `default` field. So the asymmetry is not
per-attribute special-casing in dmn-moddle; it is the same one rule ("skip a value equal to the
default") applied to two attributes whose descriptors happen to differ on whether a default is
declared at all. Setting `hitPolicy: 'UNIQUE'` explicitly therefore always serialises as absent —
only a non-default hit policy (e.g. `'FIRST'`, `'PRIORITY'`) would survive the round trip.

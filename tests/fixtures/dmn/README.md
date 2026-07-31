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

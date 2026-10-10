# tests/fixtures/dmn/

## `discount-decision.json`

Reference Decision-Core fixture used by `scripts/dmn/rules.test.js` and `scripts/dmn/dmn-xml.test.js`.
Exercises every node type and every requirement kind. See `scripts/dmn/rules.js`'s own doc comment
for the rule-engine side.

## `roundtrip-all-fields.json`

The round-trip fixture (`scripts/dmn/roundtrip.test.js`, dmn-xml-importer plan Stage 5). Every
property declared anywhere in `references/decision-core-schema.json` is instantiated on at least one
instance, and the fence DERIVES that requirement from the schema rather than restating it — which is
what makes a new schema property fail CI naming itself, and is the argument on which this plan
declined a DMN field-authority table.

**A separate file from `discount-decision.json`, on purpose.** `discount-decision.expected.dmn` is a
byte-for-byte golden; extending the fixture it belongs to in order to reach field completeness would
move that golden for a reason that has nothing to do with what it guards. The two also have
different jobs: `discount-decision.json` is the *readable reference* model the rule-engine and
serialiser tests reason about, and a field-complete model is denser than a readable one — six of the
schema's properties (`$schemaVersion`, `expressionLanguage`, `usingProcess`, `aggregation`, input
`allowedValues`, output `defaultValue`) had no instance there, measured, before this file existed.

**Do not trim it to make an assertion pass.** A field that turns out not to survive the round trip is
a finding, and it stays in the fixture with the loss asserted as a loss —
`$schemaVersion` is exactly that case today (the writer has no branch for it and DMN 1.3 has no
attribute for it).

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

## `negative/` — fixtures that exist to be dirty

`import.test.js`'s directory-driven schema-gate guard scans this directory non-recursively and
asserts every `.dmn` imports into a Decision-Core the gate accepts. A fixture that must NOT satisfy
that claim goes in `tests/fixtures/dmn/negative/` (create it when the first one arrives); that
directory is the guard's whole opt-out.

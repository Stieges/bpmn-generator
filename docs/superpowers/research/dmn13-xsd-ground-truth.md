# DMN 1.3 XSD Ground Truth

Source files (all read in full):
`references/omg-spec/normative/dmn/DMN13.xsd`,
`DMNDI13.xsd`, `DI.xsd`, `DC.xsd`; prose cross-checked in `DMN-1.3-spec.pdf` via `pdftotext -layout`.

Every fact below is either a verbatim XSD fragment or a verbatim/paraphrased prose quote with a
line-number-traceable source. Nothing here is inferred beyond what the schema/prose states.

---

## A. `tDefinitions` structure

### A1. Child element sequence

`tDefinitions` extends `tNamedElement`, which extends `tDMNElement`, via `xsd:complexContent
xsd:extension`. Per XSD extension semantics, the effective sequence is the **base type's sequence
followed by the derived type's own sequence**. `tNamedElement` adds no elements (only the `name`
attribute), so the effective order is:

| # | Element | minOccurs | maxOccurs | Source type |
|---|---|---|---|---|
| 1 | `description` | 0 | 1 | inherited from `tDMNElement` |
| 2 | `extensionElements` | 0 | 1 | inherited from `tDMNElement` |
| 3 | `import` (ref) | 0 | unbounded | `tDefinitions` own sequence |
| 4 | `itemDefinition` | 0 | unbounded | |
| 5 | `drgElement` (ref, abstract) | 0 | unbounded | |
| 6 | `artifact` (ref, abstract) | 0 | unbounded | |
| 7 | `elementCollection` | 0 | unbounded | |
| 8 | `businessContextElement` (ref, abstract) | 0 | unbounded | |
| 9 | `dmndi:DMNDI` (ref) | 0 | **1** | |

Verbatim:
```xml
<xsd:complexType name="tDefinitions">
    <xsd:complexContent>
        <xsd:extension base="tNamedElement">
            <xsd:sequence>
                <xsd:element ref="import" minOccurs="0" maxOccurs="unbounded"/>
                <xsd:element name="itemDefinition" type="tItemDefinition" minOccurs="0" maxOccurs="unbounded"/>
                <xsd:element ref="drgElement" minOccurs="0" maxOccurs="unbounded"/>
                <xsd:element ref="artifact" minOccurs="0" maxOccurs="unbounded"/>
                <xsd:element name="elementCollection" type="tElementCollection" minOccurs="0" maxOccurs="unbounded"/>
                <xsd:element ref="businessContextElement" minOccurs="0" maxOccurs="unbounded"/>
                <xsd:element ref="dmndi:DMNDI" minOccurs="0" maxOccurs="1"/>
            </xsd:sequence>
            ...
```

**Plan claim "ends in `dmndi:DMNDI` (max 1)" — CONFIRMED, exactly as written.**

### A2. Attributes

```xml
<xsd:attribute name="expressionLanguage" type="xsd:anyURI" use="optional" default="https://www.omg.org/spec/DMN/20191111/FEEL/"/>
<xsd:attribute name="typeLanguage" type="xsd:anyURI" use="optional" default="https://www.omg.org/spec/DMN/20191111/FEEL/"/>
<xsd:attribute name="namespace" type="xsd:anyURI" use="required"/>
<xsd:attribute name="exporter" type="xsd:string" use="optional"/>
<xsd:attribute name="exporterVersion" type="xsd:string" use="optional"/>
```

Plus **inherited**:
- from `tNamedElement`: `name` — `use="required"`
- from `tDMNElement`: `id` (`xsd:ID`, optional), `label` (`xsd:string`, optional), plus `xsd:anyAttribute namespace="##other"`

**Required attributes on `tDefinitions`: `namespace` AND `name`** (the latter inherited, easy to
miss since it isn't declared directly on `tDefinitions`).

**Plan claim "`@namespace` is required" — CONFIRMED, but INCOMPLETE**: `@name` is equally
required (inherited from `tNamedElement`). If the plan's writer only checks/emits `namespace` and
treats `name` as optional on `<definitions>`, that is a gap.

Notable optional ones: `expressionLanguage` (default FEEL URI), `typeLanguage` (default FEEL URI),
`exporter`, `exporterVersion` — all confirmed optional, no surprises.

---

## B. Requirements nesting

### B3. Nesting confirmed

`informationRequirement`, `knowledgeRequirement`, `authorityRequirement` are each a **global
element** (substitutionGroup="DMNElement") but they only ever appear **embedded as child elements
of the requiring DRG element** — never as a standalone top-level element under `tDefinitions`.
Confirmed both in the XSD (child element declarations, not `<xsd:element ref="...">` at
`tDefinitions` level) and in prose (line 2406: *"An InformationRequirement element is a component
of a Decision element..."*, line 2447: *"A KnowledgeRequirement element is a component of a
Decision element or of a BusinessKnowledgeModel element..."*, line 2482: *"An
AuthorityRequirement element is a component of a Decision, BusinessKnowledgeModel or
KnowledgeSource element..."*).

Parent types and cardinalities, exact:

| Requirement element | Parent type | minOccurs | maxOccurs |
|---|---|---|---|
| `informationRequirement` | `tDecision` only | 0 | unbounded |
| `knowledgeRequirement` | `tDecision` | 0 | unbounded |
| `knowledgeRequirement` | `tBusinessKnowledgeModel` | 0 | unbounded |
| `authorityRequirement` | `tDecision` | 0 | unbounded |
| `authorityRequirement` | `tBusinessKnowledgeModel` | 0 | unbounded |
| `authorityRequirement` | `tKnowledgeSource` | 0 | unbounded |

Note asymmetry: `tKnowledgeSource` carries **only** `authorityRequirement` (no
`informationRequirement`, no `knowledgeRequirement`). `tDecisionService` carries **none** of the
three — it uses a structurally different mechanism (`outputDecision`, `encapsulatedDecision`,
`inputDecision`, `inputData`, all `tDMNElementReference`).

### B4. Child reference elements per requirement type, and legal targets

All reference children are typed `tDMNElementReference` — a minimal type with a single required
`href` (`xsd:anyURI`) attribute:
```xml
<xsd:complexType name="tDMNElementReference">
    <xsd:attribute name="href" type="xsd:anyURI" use="required"/>
</xsd:complexType>
```
The XSD itself does **not** restrict what an `href` may point to — target-type legality is a
**semantic/prose rule**, not a schema-enforced one (this matters: nothing will make ajv/xsd
validation catch a `requiredInput` pointing at a `Decision`; that's exactly D03's job).

```xml
<xsd:complexType name="tInformationRequirement">
    <xsd:complexContent><xsd:extension base="tDMNElement">
        <xsd:sequence>
            <xsd:choice minOccurs="1" maxOccurs="1">
                <xsd:element name="requiredDecision" type="tDMNElementReference"/>
                <xsd:element name="requiredInput" type="tDMNElementReference"/>
            </xsd:choice>
        </xsd:sequence>
    </xsd:extension></xsd:complexContent>
</xsd:complexType>
```
- `requiredDecision` → target must be a `Decision` (prose Table 20 + well-formedness rule: "It
  references a requiredDecision or a requiredInput element, but not both.")
- `requiredInput` → target must be an `InputData`
- Exactly one of the two, never both, never neither (enforced by the `xsd:choice` with
  minOccurs=1 maxOccurs=1).

```xml
<xsd:complexType name="tKnowledgeRequirement">
    <xsd:complexContent><xsd:extension base="tDMNElement">
        <xsd:sequence>
            <xsd:element name="requiredKnowledge" type="tDMNElementReference" minOccurs="1" maxOccurs="1"/>
        </xsd:sequence>
    </xsd:extension></xsd:complexContent>
</xsd:complexType>
```
- `requiredKnowledge` → target must be an **`Invocable`**, i.e. a `BusinessKnowledgeModel` or a
  `DecisionService` (prose line 2449-2450: *"...associates that requiring Decision or
  BusinessKnowledgeModel element with a requiredKnowledge element, which is an instance of
  Invocable."*). **Not** a plain `Decision`, **not** `InputData`, **not** `KnowledgeSource`. This
  is the exact rule D03 needs to enforce for `knowledgeRequirement`.
- Exactly one, mandatory (minOccurs=1, not a choice, single element).

```xml
<xsd:complexType name="tAuthorityRequirement">
    <xsd:complexContent><xsd:extension base="tDMNElement">
        <xsd:choice minOccurs="1" maxOccurs="1">
            <xsd:element name="requiredDecision" type="tDMNElementReference"/>
            <xsd:element name="requiredInput" type="tDMNElementReference"/>
            <xsd:element name="requiredAuthority" type="tDMNElementReference"/>
        </xsd:choice>
    </xsd:extension></xsd:complexContent>
</xsd:complexType>
```
- `requiredDecision` → target `Decision`
- `requiredInput` → target `InputData`
- `requiredAuthority` → target `KnowledgeSource`
- Exactly one of the three (choice, 1..1).

Full target-legality table for D03:

| Requirement | Child element | Legal target DRG element |
|---|---|---|
| informationRequirement | requiredDecision | Decision |
| informationRequirement | requiredInput | InputData |
| knowledgeRequirement | requiredKnowledge | BusinessKnowledgeModel **or** DecisionService (i.e. any `Invocable`) |
| authorityRequirement | requiredDecision | Decision |
| authorityRequirement | requiredInput | InputData |
| authorityRequirement | requiredAuthority | KnowledgeSource |

### B5. Do requirement elements have an `id`?

Yes. All three (`tInformationRequirement`, `tKnowledgeRequirement`, `tAuthorityRequirement`)
extend `tDMNElement` directly (`xsd:extension base="tDMNElement"`), so all three inherit the
optional `id` (`xsd:ID`), `description`, `label`, `extensionElements`. Confirmed by the
`<xsd:complexContent><xsd:extension base="tDMNElement">` on each (see B4 fragments above).

---

## C. Types WITHOUT an `id` (attribute discipline)

**Plan claim: `tRuleAnnotation` and `tRuleAnnotationClause` do NOT extend `tDMNElement` and
therefore have no `id` — CONFIRMED, but the list is INCOMPLETE.**

```xml
<xsd:complexType name="tRuleAnnotationClause">
    <xsd:attribute name="name" type="xsd:string"/>
</xsd:complexType>
<xsd:complexType name="tRuleAnnotation">
    <xsd:sequence>
        <xsd:element name="text" type="xsd:string" minOccurs="0"/>
    </xsd:sequence>
</xsd:complexType>
```
Neither has `xsd:complexContent`/`xsd:extension` at all — they are freestanding complex types, no
inheritance chain to `tDMNElement`. Confirmed: no `id`.

Having enumerated **every** `xsd:complexType` in `DMN13.xsd` (43 total) and traced each one's
inheritance chain, the **complete list of DMN 1.3 semantic-model complex types that do NOT extend
`tDMNElement` (directly or transitively) and therefore must never carry an `id`** is exactly
**four**:

| Type | Why it has no `id` | Where it appears in a decision tree |
|---|---|---|
| `tDMNElementReference` | freestanding type, only attribute is `href` (required, `xsd:anyURI`) | every `requiredDecision`/`requiredInput`/`requiredKnowledge`/`requiredAuthority`/`usingProcess`/`usingTask`/`outputDecision`/`encapsulatedDecision`/`inputDecision`/(DecisionService) `inputData`/`supportedObjective`/`impactedPerformanceIndicator`/`decisionMaker`/`decisionOwner`/`owner`(KnowledgeSource)/`impactingDecision`/`decisionMade`/`decisionOwned`/`drgElement`(inside `tElementCollection`) reference |
| `tBinding` | freestanding type, sequence `parameter` + `expression`, no `xsd:extension`, no `anyAttribute` | inside `tInvocation` (`binding` element, e.g. invoking a BKM) |
| `tRuleAnnotationClause` | freestanding type, only attribute `name` | `tDecisionTable`'s `annotation` child (column header) |
| `tRuleAnnotation` | freestanding type, sequence `text?` | `tDecisionRule`'s `annotationEntry` child (per-row annotation cell) |

Every other complex type in `DMN13.xsd` — including `tExpression` and everything derived from it
(`tLiteralExpression`, `tUnaryTests`, `tDecisionTable`, `tContext`, `tInvocation`,
`tFunctionDefinition`, `tRelation`, `tList`), `tInputClause`, `tOutputClause`, `tDecisionRule`,
`tItemDefinition`, `tInformationItem`, `tArtifact` and its children (`tGroup`, `tTextAnnotation`,
`tAssociation`), and all `tNamedElement`/`tDRGElement` descendants — extends `tDMNElement` and
therefore **may** carry an `id` (optional, never required by the XSD itself; `id` is `use="optional"`
everywhere on `tDMNElement`).

**Correction for the plan: add `tDMNElementReference` and `tBinding` to the "never emit an `id`
on this" list — the plan as quoted only names two of the four.**

---

## D. Decision table

### D7. `tDecisionTable` structure

Extends `tExpression` → `tDMNElement`, so full content model: `description?, extensionElements?,
input*, output+ (1..unbounded, unlabeled = default minOccurs 1), annotation*, rule*`.

```xml
<xsd:complexType name="tDecisionTable">
    <xsd:complexContent>
        <xsd:extension base="tExpression">
            <xsd:sequence>
                <xsd:element name="input" type="tInputClause" minOccurs="0" maxOccurs="unbounded"/>
                <xsd:element name="output" type="tOutputClause" maxOccurs="unbounded"/>
                <xsd:element name="annotation" type="tRuleAnnotationClause" minOccurs="0" maxOccurs="unbounded"/>
                <!-- NB: when the hit policy is FIRST or RULE ORDER, the ordering of the rules is significant and MUST be preserved -->
                <xsd:element name="rule" type="tDecisionRule" minOccurs="0" maxOccurs="unbounded"/>
            </xsd:sequence>
            <xsd:attribute name="hitPolicy" type="tHitPolicy" use="optional" default="UNIQUE"/>
            <xsd:attribute name="aggregation" type="tBuiltinAggregator" use="optional"/>
            <xsd:attribute name="preferredOrientation" type="tDecisionTableOrientation" use="optional" default="Rule-as-Row"/>
            <xsd:attribute name="outputLabel" type="xsd:string" use="optional"/>
        </xsd:extension>
    </xsd:complexContent>
</xsd:complexType>
```

| Element | minOccurs | maxOccurs |
|---|---|---|
| `input` | 0 | unbounded |
| `output` | **1** (unspecified = XSD default) | unbounded |
| `annotation` | 0 | unbounded |
| `rule` | 0 | unbounded |

Attributes and defaults:

| Attribute | use | default |
|---|---|---|
| `hitPolicy` (`tHitPolicy`) | optional | `UNIQUE` |
| `aggregation` (`tBuiltinAggregator`) | optional | *(none)* |
| `preferredOrientation` (`tDecisionTableOrientation`) | optional | `Rule-as-Row` |
| `outputLabel` (`xsd:string`) | optional | *(none)* |

### D8. Default values, and the hitPolicy/preferredOrientation asymmetry claim

`hitPolicy` default: **`UNIQUE`** — confirmed above, `use="optional" default="UNIQUE"`.
`preferredOrientation` default: **`Rule-as-Row`** — confirmed above, `use="optional"
default="Rule-as-Row"`.

**Plan claim to check: "`hitPolicy="UNIQUE"` is dropped on write because it's the default, and
`preferredOrientation="Rule-as-Row"` is kept — check whether the XSD defaults support that
asymmetry."**

**Finding: the XSD does NOT support the asymmetry.** Both attributes are declared identically —
`use="optional"` with an explicit `default` value — on the very same `xsd:extension` block. Nothing
in the XSD treats `preferredOrientation` differently from `hitPolicy`; from the schema's point of
view they are two ordinary optional attributes with defaults, full stop. If the plan's write logic
is "omit an attribute when it equals the XSD default," that rule applied consistently would drop
`preferredOrientation="Rule-as-Row"` exactly as it drops `hitPolicy="UNIQUE"`. **Whatever the
actual reason for keeping `preferredOrientation` (e.g. bpmn.io/Camunda tooling defaults it
differently, or the project wants it always-explicit for readability), it cannot be justified by
appeal to the XSD — the XSD gives no basis for the asymmetry.** This should be corrected or the
justification reworded in the plan (e.g. "we keep it explicit as a style choice" rather than "the
schema treats them differently").

### D9. `tDecisionRule`, `tUnaryTests`, `tLiteralExpression`

```xml
<xsd:complexType name="tDecisionRule">
    <xsd:complexContent>
        <xsd:extension base="tDMNElement">
            <xsd:sequence>
                <xsd:element name="inputEntry" type="tUnaryTests" minOccurs="0" maxOccurs="unbounded"/>
                <xsd:element name="outputEntry" type="tLiteralExpression" maxOccurs="unbounded"/>
                <xsd:element name="annotationEntry" type="tRuleAnnotation" minOccurs="0" maxOccurs="unbounded"/>
            </xsd:sequence>
        </xsd:extension>
    </xsd:complexContent>
</xsd:complexType>
```
`inputEntry`: 0..unbounded. `outputEntry`: **1**..unbounded (unspecified minOccurs = default 1,
mirroring the `output`-clause asymmetry above — at least one output cell per rule is mandatory).
`annotationEntry`: 0..unbounded.

```xml
<xsd:complexType name="tUnaryTests">
    <xsd:complexContent>
        <xsd:extension base="tExpression">
            <xsd:sequence>
                <xsd:element name="text" type="xsd:string"/>
            </xsd:sequence>
            <xsd:attribute name="expressionLanguage" type="xsd:anyURI" use="optional"/>
        </xsd:extension>
    </xsd:complexContent>
</xsd:complexType>
```
`text` is required (unspecified minOccurs/maxOccurs = exactly 1). Plus inherited `typeRef`
(optional, from `tExpression`) and `id`/`label` (from `tDMNElement`).

```xml
<xsd:complexType name="tLiteralExpression">
    <xsd:complexContent>
        <xsd:extension base="tExpression">
            <xsd:choice minOccurs="0" maxOccurs="1">
                <xsd:element name="text" type="xsd:string"/>
                <xsd:element name="importedValues" type="tImportedValues"/>
            </xsd:choice>
            <xsd:attribute name="expressionLanguage" type="xsd:anyURI" use="optional"/>
        </xsd:extension>
    </xsd:complexContent>
</xsd:complexType>
```
Unlike `tUnaryTests`, `tLiteralExpression`'s `text` is **optional** and mutually exclusive with
`importedValues` (choice, 0..1 — so a `tLiteralExpression` may legally have neither, i.e. an empty
cell).

### D10. `tOutputClause` and `tInputClause`

```xml
<xsd:complexType name="tInputClause">
    <xsd:complexContent>
        <xsd:extension base="tDMNElement">
            <xsd:sequence>
                <xsd:element name="inputExpression" type="tLiteralExpression"/>
                <xsd:element name="inputValues" type="tUnaryTests" minOccurs="0"/>
            </xsd:sequence>
        </xsd:extension>
    </xsd:complexContent>
</xsd:complexType>
```
`inputExpression`: required (default 1..1). `inputValues`: optional. **`tInputClause` extends
`tDMNElement` directly, NOT `tNamedElement` — it has NO `name` attribute at all.** (Easy to assume
symmetry with `tOutputClause`; there isn't one.)

```xml
<xsd:complexType name="tOutputClause">
    <xsd:complexContent>
        <xsd:extension base="tDMNElement">
            <xsd:sequence>
                <xsd:element name="outputValues" type="tUnaryTests" minOccurs="0"/>
                <xsd:element name="defaultOutputEntry" type="tLiteralExpression" minOccurs="0"/>
            </xsd:sequence>
            <xsd:attribute name="name" type="xsd:string" use="optional"/>
            <xsd:attribute name="typeRef" type="xsd:string"/>
        </xsd:extension>
    </xsd:complexContent>
</xsd:complexType>
```
`outputValues`, `defaultOutputEntry`: both optional. Attributes: `name` optional, `typeRef`
optional (unspecified `use` = default `"optional"`).

**Plan claim "`output` has no `minOccurs`, meaning at least one output is mandatory" —
CONFIRMED**, exactly as quoted in D7 above (`<xsd:element name="output" type="tOutputClause"
maxOccurs="unbounded"/>`, no `minOccurs` → XSD default of 1).

### D11. Enumerations

```xml
<xsd:simpleType name="tHitPolicy">
    <xsd:restriction base="xsd:string">
        <xsd:enumeration value="UNIQUE"/>
        <xsd:enumeration value="FIRST"/>
        <xsd:enumeration value="PRIORITY"/>
        <xsd:enumeration value="ANY"/>
        <xsd:enumeration value="COLLECT"/>
        <xsd:enumeration value="RULE ORDER"/>
        <xsd:enumeration value="OUTPUT ORDER"/>
    </xsd:restriction>
</xsd:simpleType>
```
7 values: `UNIQUE`, `FIRST`, `PRIORITY`, `ANY`, `COLLECT`, `RULE ORDER` (literal space, not
`RULE_ORDER`), `OUTPUT ORDER` (literal space). Note: the familiar `C+`/`C#`/`C<`/`C>` notation for
COLLECT-with-aggregator is a *notation* convention layered on top — the XSD value stays exactly
`COLLECT`, and the aggregator goes in the separate `aggregation` attribute.

```xml
<xsd:simpleType name="tBuiltinAggregator">
    <xsd:restriction base="xsd:string">
        <xsd:enumeration value="SUM"/>
        <xsd:enumeration value="COUNT"/>
        <xsd:enumeration value="MIN"/>
        <xsd:enumeration value="MAX"/>
    </xsd:restriction>
</xsd:simpleType>
```
4 values: `SUM`, `COUNT`, `MIN`, `MAX`.

(Bonus, not asked but adjacent: `tDecisionTableOrientation` = `Rule-as-Row`, `Rule-as-Column`,
`CrossTable`.)

---

## E. DMNDI

### E12. `DMNDI` and `DMNDiagram`

```xml
<xsd:complexType name="DMNDI">
    <xsd:sequence>
        <xsd:element ref="dmndi:DMNDiagram" minOccurs="0" maxOccurs="unbounded"/>
        <xsd:element ref="dmndi:DMNStyle" minOccurs="0" maxOccurs="unbounded"/>
    </xsd:sequence>
</xsd:complexType>
```
**Plan claim "`DMNDiagram` is unbounded (`maxOccurs="unbounded"`)" — CONFIRMED**, exactly as
written; `DMNStyle` (shared styles) is unbounded too and comes second.

### E13. `DMNShape` and `DMNEdge`

`DMNShape` extends `di:Shape` (→ `di:DiagramElement`):
```xml
<xsd:complexType name="DMNShape">
    <xsd:complexContent>
        <xsd:extension base="di:Shape">
            <xsd:sequence>
                <xsd:element ref="dmndi:DMNLabel" minOccurs="0" maxOccurs="1"/>
                <xsd:element ref="dmndi:DMNDecisionServiceDividerLine" minOccurs="0" maxOccurs="1"/>
            </xsd:sequence>
            <xsd:attribute name="dmnElementRef" type="xsd:QName" use="required"/>
            <xsd:attribute name="isListedInputData" type="xsd:boolean" use="optional"/>
            <xsd:attribute name="isCollapsed" type="xsd:boolean" use="optional" default="false"/>
        </xsd:extension>
    </xsd:complexContent>
</xsd:complexType>
```
Full content model (base-then-derived order): `extension?, Style?, Bounds?, DMNLabel?,
DMNDecisionServiceDividerLine?`. `dmnElementRef` type is **`xsd:QName`** (not `xsd:IDREF`) and is
**required**. `isCollapsed` defaults to `false`. `isListedInputData` optional, no default.

`DMNEdge` extends `di:Edge` (→ `di:DiagramElement`):
```xml
<xsd:complexType name="DMNEdge">
    <xsd:complexContent>
        <xsd:extension base="di:Edge">
            <xsd:sequence>
                <xsd:element ref="dmndi:DMNLabel" minOccurs="0" maxOccurs="1"/>
            </xsd:sequence>
            <xsd:attribute name="dmnElementRef" type="xsd:QName" use="required"/>
            <xsd:attribute name="sourceElement" type="xsd:QName" use="optional"/>
            <xsd:attribute name="targetElement" type="xsd:QName" use="optional"/>
        </xsd:extension>
    </xsd:complexContent>
</xsd:complexType>
```
Full content model: `extension?, Style?, waypoint*, DMNLabel?`. `dmnElementRef` required
(`xsd:QName`); `sourceElement`/`targetElement` optional (`xsd:QName`).

Inheritance chain (from DI.xsd/DC.xsd):
- `di:DiagramElement` (abstract): sequence `extension?` (any-content wrapper), `Style?` (ref
  `di:Style`); attributes `sharedStyle` (`xsd:IDREF`, optional), `id` (`xsd:ID`, optional),
  `anyAttribute`.
- `di:Shape` (abstract, extends `DiagramElement`): adds sequence `dc:Bounds?` (0..1).
- `di:Edge` (abstract, extends `DiagramElement`): adds sequence `waypoint` — type `dc:Point`,
  0..unbounded.

`Bounds` (`dc:Bounds`) — attribute-only, no children:
```xml
<xsd:complexType name="Bounds">
    <xsd:attribute name="x" type="xsd:double" use="required"/>
    <xsd:attribute name="y" type="xsd:double" use="required"/>
    <xsd:attribute name="width" type="xsd:double" use="required"/>
    <xsd:attribute name="height" type="xsd:double" use="required"/>
</xsd:complexType>
```

`waypoint` — type **`dc:Point`**, attribute-only, no children:
```xml
<xsd:complexType name="Point">
    <xsd:attribute name="x" type="xsd:double" use="required"/>
    <xsd:attribute name="y" type="xsd:double" use="required"/>
</xsd:complexType>
```
Confirmed: `Point` is x/y only (no width/height) — distinct from `Bounds` which is x/y/width/height.

`DMNLabel` extends `di:Shape`:
```xml
<xsd:complexType name="DMNLabel">
    <xsd:complexContent>
        <xsd:extension base="di:Shape">
            <xsd:sequence>
                <xsd:element name="Text" type="xsd:string" minOccurs="0" maxOccurs="1" />
            </xsd:sequence>
        </xsd:extension>
    </xsd:complexContent>
</xsd:complexType>
```
So `DMNLabel` = optional `Bounds` (inherited from Shape) + optional `Text` string child. No
attributes of its own beyond inherited `id`/`sharedStyle`.

`DMNDecisionServiceDividerLine` extends `di:Edge` — adds nothing of its own:
```xml
<xsd:complexType name="DMNDecisionServiceDividerLine">
    <xsd:complexContent>
        <xsd:extension base="di:Edge"/>
    </xsd:complexContent>
</xsd:complexType>
```
It is purely a plain `Edge` (i.e. `waypoint*`) used to draw the horizontal divider line inside a
Decision Service shape.

### E14. Required ordering / required attributes on `DMNDiagram` itself

`DMNDiagram` extends `di:Diagram` (abstract, extends `di:DiagramElement`):
```xml
<xsd:complexType name="Diagram" abstract="true">
    <xsd:complexContent>
        <xsd:extension base="di:DiagramElement">
            <xsd:attribute name="name" type="xsd:string">
            <xsd:attribute name="documentation" type="xsd:string">
            <xsd:attribute name="resolution" type="xsd:double">
        </xsd:extension>
    </xsd:complexContent>
</xsd:complexType>
```
```xml
<xsd:complexType name="DMNDiagram">
    <xsd:complexContent>
        <xsd:extension base="di:Diagram">
            <xsd:sequence>
                <xsd:element name="Size" type="dc:Dimension" minOccurs="0" maxOccurs="1"/>
                <xsd:element ref="dmndi:DMNDiagramElement" minOccurs="0" maxOccurs="unbounded"/>
            </xsd:sequence>
        </xsd:extension>
    </xsd:complexContent>
</xsd:complexType>
```
Full content model, in order: `extension?, Style?` (from `DiagramElement`), then `Size?,
DMNDiagramElement*` (from `DMNDiagram`; `di:Diagram` itself adds no elements). Order **is**
significant per `xsd:sequence` semantics even though every particle is optional/repeatable.

**Required attributes: NONE.** `name`, `documentation`, `resolution` (from `di:Diagram`) are all
declared with no `use` attribute → XSD default `use="optional"`. `id` (from `di:DiagramElement`,
`xsd:ID`) and `sharedStyle` (`xsd:IDREF`) are likewise optional. So `<dmndi:DMNDiagram/>` with zero
attributes and zero children is schema-valid. If the plan assumes `DMNDiagram` must carry an `id`,
that assumption is **not backed by the XSD** — worth flagging even though not explicitly asked
about as a "plan claim," since it's a natural mistake to make when several sibling model elements
do require `id`-like keys.

---

## F. The four DRD element types this project renders

### F15. Element type names and invocability

Confirmed exact names, all `substitutionGroup="drgElement"` (directly or via the abstract
`invocable` head element, itself `substitutionGroup="drgElement"`):

| DRD concept | Element name | Type name | Direct base |
|---|---|---|---|
| Decision | `decision` | `tDecision` | `tDRGElement` |
| Input Data | `inputData` | `tInputData` | `tDRGElement` |
| Knowledge Source | `knowledgeSource` | `tKnowledgeSource` | `tDRGElement` |
| Business Knowledge Model | `businessKnowledgeModel` | `tBusinessKnowledgeModel` | `tInvocable` |
| (also invocable) Decision Service | `decisionService` | `tDecisionService` | `tInvocable` |

**Invocable = `{tBusinessKnowledgeModel, tDecisionService}` — confirmed by
`substitutionGroup="invocable"` on both `businessKnowledgeModel` and `decisionService` elements**,
and by prose line 1954: *"Invocable is further specialized into BusinessKnowledgeModel and
DecisionService."* `tDecision`, `tInputData`, `tKnowledgeSource` are **not** invocable — a
`requiredKnowledge` reference to any of those three is illegal (see B4).

### F16. `tDecision`'s notable children, and the BPMN link elements

```xml
<xsd:complexType name="tDecision">
    <xsd:complexContent>
        <xsd:extension base="tDRGElement">
            <xsd:sequence>
                <xsd:element name="question" type="xsd:string" minOccurs="0" maxOccurs="1"/>
                <xsd:element name="allowedAnswers" type="xsd:string" minOccurs="0" maxOccurs="1"/>
                <xsd:element name="variable" type="tInformationItem" minOccurs="0"/>
                <xsd:element name="informationRequirement" type="tInformationRequirement" minOccurs="0" maxOccurs="unbounded"/>
                <xsd:element name="knowledgeRequirement" type="tKnowledgeRequirement" minOccurs="0" maxOccurs="unbounded"/>
                <xsd:element name="authorityRequirement" type="tAuthorityRequirement" minOccurs="0" maxOccurs="unbounded"/>
                <xsd:element name="supportedObjective" type="tDMNElementReference" minOccurs="0" maxOccurs="unbounded"/>
                <xsd:element name="impactedPerformanceIndicator" type="tDMNElementReference" minOccurs="0" maxOccurs="unbounded"/>
                <xsd:element name="decisionMaker" type="tDMNElementReference" minOccurs="0" maxOccurs="unbounded"/>
                <xsd:element name="decisionOwner" type="tDMNElementReference" minOccurs="0" maxOccurs="unbounded"/>
                <xsd:element name="usingProcess" type="tDMNElementReference" minOccurs="0" maxOccurs="unbounded"/>
                <xsd:element name="usingTask" type="tDMNElementReference" minOccurs="0" maxOccurs="unbounded"/>
                <!-- decisionLogic -->
                <xsd:element ref="expression" minOccurs="0" maxOccurs="1"/>
            </xsd:sequence>
        </xsd:extension>
    </xsd:complexContent>
</xsd:complexType>
```

**The BPMN link elements are `usingProcess` and `usingTask` — plan's naming CONFIRMED CORRECT** —
but with corrections on cardinality and type:

- Both are **children of `tDecision` only** (not `tBusinessKnowledgeModel`, not
  `tDecisionService`, not `tInputData`, not `tKnowledgeSource`).
- Cardinality is **`minOccurs="0" maxOccurs="unbounded"` each** — a Decision may reference **any
  number** of BPMN processes/tasks, not 0..1. (Prose line 2081-2083 confirms: *"an instance of
  Decision may reference any number of usingProcess... and any number of usingTask..."*.)
  Table 11 labels them `usingProcesses: BPMN::process [*]` / `usingTasks: BPMN::task [*]` — plural
  in the UML model, singular element names `usingProcess`/`usingTask` in the XSD (repeated per
  occurrence).
- Type is **`tDMNElementReference`** — a bare `href` (`xsd:anyURI`, required). The DMN XSD does
  **not** import a BPMN schema and does **not** type-check that the href resolves to an actual
  BPMN `<task>`/`<process>` element — that correspondence is purely a **prose convention** (line
  2081: *"...instances of Process as defined in OMG BPMN 2.0..."*). Any cross-file/cross-format
  resolution (e.g. resolving the href to an id in a sibling `.bpmn` file) is the *implementing
  tool's* responsibility, not something DMN 1.3's XSD enforces or even structurally supports
  beyond a URI string.

**Important correction — there is no `decisionLogic` element.** The XML comment `<!--
decisionLogic -->` immediately above `<xsd:element ref="expression".../>` is exactly that — an XSD
author's comment documenting the *semantic role* of that slot (Table 11: `decisionLogic:
Expression [0..1]`), not a wrapper element name. In an actual DMN 1.3 document there is no
`<decisionLogic>` tag; the child that appears is whichever **concrete substitution-group member of
the abstract `expression` head element** is used — most commonly `<decisionTable>`, but legally
also `<literalExpression>`, `<context>`, `<invocation>`, `<functionDefinition>`, `<relation>`, or
`<list>`. If the plan's writer or schema-gate logic expects to find/emit a literal `decisionLogic`
element under `<decision>`, that is **wrong** and will not validate — it must emit one of the
concrete expression elements directly. Cardinality of that slot: 0..1 (a Decision may have no
decision logic yet, e.g. a stub during modeling).

Other notable optional children, all `tDMNElementReference` and all 0..unbounded except where
noted: `question` (0..1, `xsd:string`), `allowedAnswers` (0..1, `xsd:string`), `variable` (0..1,
`tInformationItem`), `supportedObjective`, `impactedPerformanceIndicator`, `decisionMaker`,
`decisionOwner` (all 0..unbounded `tDMNElementReference`, business-context-only, not BPMN-related).

### Import mechanism (cross-file references)

```xml
<xsd:element name="import" type="tImport" substitutionGroup="namedElement"/>
<xsd:complexType name="tImport">
    <xsd:complexContent>
        <xsd:extension base="tNamedElement">
            <xsd:attribute name="namespace" type="xsd:anyURI" use="required"/>
            <xsd:attribute name="locationURI" type="xsd:anyURI" use="optional"/>
            <xsd:attribute name="importType" type="xsd:anyURI" use="required"/>
        </xsd:extension>
    </xsd:complexContent>
</xsd:complexType>
```
Element name: **`import`**, child of `tDefinitions` (first in its sequence, see A1), cardinality
0..unbounded. Required attributes: `name` (inherited from `tNamedElement`), `namespace`
(`xsd:anyURI`), `importType` (`xsd:anyURI` — a URI identifying the *format/style* of the imported
artifact, e.g. an XML-document import vs. a DMN-model import; prose line 1891: *"An instance of
Import has an importType, which is a String that specifies the type of import..."*). Optional:
`locationURI` (`xsd:anyURI`, where to physically find the imported document; prose line
1895-1896). `tImportedValues` (used by `tLiteralExpression`'s `importedValues` choice branch, D9)
itself extends `tImport`, adding a required `importedElement` (`xsd:string`) child and an optional
`expressionLanguage` attribute — i.e. it reuses the same import machinery to pull a single value
out of an external document rather than a whole model.

---

## Summary of corrections to the plan (all flagged inline above)

1. **A2** — `@namespace` required is correct, but `@name` on `<definitions>` (inherited from
   `tNamedElement`) is *equally* required and not mentioned by the plan.
2. **C6** — the "no `id`" list is incomplete: it's not just `tRuleAnnotation` and
   `tRuleAnnotationClause`; `tDMNElementReference` and `tBinding` also lack `id` and must be added
   to an emitter's never-put-an-id-here list (4 types total, not 2).
3. **D8 — the most consequential correction.** The plan's premise that the XSD justifies treating
   `hitPolicy="UNIQUE"` and `preferredOrientation="Rule-as-Row"` asymmetrically (drop one, keep
   the other) is **not supported by the schema**. Both attributes are declared identically:
   `use="optional"` with an explicit `default`. Any "drop if equals default" rule applies equally
   to both, or to neither. The decision to keep `preferredOrientation` needs a non-XSD
   justification (tooling convention, explicitness preference), not an XSD-based one.
4. **D10** — confirmed correct on `output`'s missing `minOccurs`; additionally note
   `tInputClause` has **no `name` attribute at all** (asymmetric with `tOutputClause`, which does)
   — a likely source of a symmetric-but-wrong implementation.
5. **F16 — second most consequential correction.** There is **no `decisionLogic` XML element**.
   The XSD's `<!-- decisionLogic -->` is a comment over an `xsd:element ref="expression"` slot; the
   actual serialized child is a concrete expression element (`decisionTable`, `literalExpression`,
   `context`, `invocation`, `functionDefinition`, `relation`, or `list`). Also, `usingProcess` /
   `usingTask` are `0..unbounded` (not `0..1`), live only on `tDecision`, and are typed as a bare
   `href`-only `tDMNElementReference` with no XSD-level tie to an actual BPMN schema — resolution
   is entirely a tooling/prose convention.
6. **E14 (new finding, not a quoted plan claim but worth flagging)** — `DMNDiagram` has **no
   required attributes at all**, not even `id`. Don't assume one is enforced by the schema.

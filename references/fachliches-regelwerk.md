# BPMN Fachliches Regelwerk

Konfigurierbare Validierungsregeln fuer BPMN-Prozesse. 5 Schichten, **32 registrierte Regeln**, davon 30 aktiv (M05/M06 stehen auf `severity: OFF`). Schicht 4 (Workflow-Net) und Schicht 5 (Optimization) sind opt-in.

## Architektur

```
rules.js           → Regel-Definitionen + Runner
validate.js         → Thin Wrapper (public API)
rules/*.json        → Profile (Severity-Overrides, Layer-Deaktivierung)
```

**Erweiterbar:** Neue Regeln = neues Objekt im `RULES`-Array in `rules.js`.
**Konfigurierbar:** Profile ueberschreiben Severities oder deaktivieren ganze Layer.

## Quellen

| Kuerzel | Quelle |
|---------|--------|
| OMG | OMG BPMN 2.0.2 (formal/2013-12-09, ISO/IEC 19510:2013) |
| 7PMG | Seven Process Modeling Guidelines (Mendling/Reijers/van der Aalst, 2010) |
| Silver | Bruce Silver: BPMN Method & Style, 2nd Ed. |
| MG.org | modeling-guidelines.org |
| BEF4LLM | BEF4LLM (Kourani et al., 2025) |

---

## Schicht 1: Soundness (ERROR)

Strukturelle Korrektheit. Blockiert die Pipeline bei Verletzung.

| ID | Regel | Referenz | Status |
|----|-------|----------|--------|
| S01 | Jeder Prozess hat mindestens ein Start-Event | OMG §10.4.2, 7PMG G3 | implementiert |
| S02 | Jeder Prozess hat mindestens ein End-Event | OMG §10.4.2, 7PMG G3 | implementiert |
| S03 | Kanten referenzieren nur existierende Nodes (source/target) | OMG §10.3.1 | implementiert |
| S04 | Keine isolierten Nodes (ohne ein-/ausgehende Kante) | 7PMG G2 | implementiert |
| S05 | Kein Deadlock: XOR-Split darf nicht direkt/indirekt in AND-Join muenden | OMG §10.5.1, Silver Ch.5 | implementiert |
| S06 | Kein Deadlock: Inclusive-Split darf nicht direkt/indirekt in AND-Join muenden | OMG §10.5.1 | implementiert |
| S07 | Jeder Pfad vom Start muss ein End-Event erreichen koennen | 7PMG G1 | implementiert |
| S08 | Boundary-Event-Pfade muessen in End-Event terminieren | OMG §10.4.4, BEF4LLM | implementiert |
| S09 | Message Flows nur zwischen verschiedenen Pools | OMG §9.4 | implementiert |
| S10 | Message Flows: Quell- und Ziel-Nodes muessen existieren | OMG §9.4 | implementiert |
| S11 | SubProcess-Kinder: Start-Event + End-Event vorhanden | OMG §10.2.1 | implementiert |
| S12 | Message Flow source/target darf kein Gateway sein | OMG §7.6.2 Table 7.4, CMOF: MessageFlow.sourceRef/targetRef typed as InteractionNode (Gateway extends FlowNode, not InteractionNode) | implementiert |
| S13 | Boundary Event muss an einer existierenden Aktivität hängen | OMG §10.4.3 Table 10.86, CMOF: BoundaryEvent.attachedToRef : Activity [1..1] | implementiert |

**Zu S13:** `attachedToRef` ist im OMG-Schema Pflicht (1..1). Ohne diese Prüfung lief ein
ins Leere zeigendes `attachedTo` bis in die Ausgabe durch und erzeugte ein `boundaryEvent`
ohne `attachedToRef`, ohne DI-Shape und mit einer ausgehenden Kante ohne Wegpunkte — also
BPMN, das kein Werkzeug lesen kann, bei grüner Validierung.

Die Regel prüft **jede Verschachtelungsebene** und zusätzlich das **Containment**: Boundary
Event und seine Aktivität müssen im selben Container liegen. Anfangs sammelte sie die
Aktivitäten rekursiv, prüfte aber nur die oberste Ebene — genau verkehrt. Das ließ zwei
Fehler durch: ein Boundary Event *innerhalb* eines Subprozesses ohne `attachedTo` (ungültiges
BPMN, grüne Validierung) und den Gegenfall, ein Boundary Event der obersten Ebene, das auf
einen Knoten *innerhalb* eines Subprozesses zeigt (auflösbar, aber laut BPMN unzulässig).

## Schicht 2: Style (WARNING)

Modellierungsrichtlinien. Warnt, blockiert nicht.

| ID | Regel | Referenz | Status |
|----|-------|----------|--------|
| M01 | Tasks benennen mit Objekt+Verb-Pattern (Verb im Infinitiv) | 7PMG G7, Silver Ch.3 | implementiert (Heuristik) |
| M02 | Divergierende XOR-Gateways: Label als Frage formulieren | Silver Ch.5, MG.org | implementiert |
| M03 | Convergierende Gateways: kein Label an ausgehenden Kanten | Silver Ch.5 | implementiert |
| M04 | Divergierende XOR-Gateways: Kanten muessen Labels haben | Silver Ch.5, OMG §10.5.1 | implementiert |
| M05 | Prozessnamen mit Verb+Substantiv-Pattern | 7PMG G7 | Platzhalter |
| M06 | Keine doppelten Knotennamen im selben Prozess | 7PMG G6 | Platzhalter |
| M07 | Vermeide OR-Gateways (inclusive) | Silver Ch.5, 7PMG G4 | implementiert |
| M08 | Jeder XOR-Split hat einen Default-Flow | Silver Ch.5 | implementiert |
| M09 | Lane-Node-Zuweisung: Format B (lane.nodeIds) ohne Format A (node.lane) | OMG §10.5 | implementiert |
| M10 | Lane- und Pool-Namen: max. 25 Zeichen | Silver §4.2 | implementiert |
| M11 | `decisionRef` only on a businessRuleTask | generator convention (no OMG attribute exists) | implementiert |

## Schicht 3: Pragmatik (INFO)

Komplexitaetsmetriken und Hinweise.

| ID | Regel | Referenz | Status |
|----|-------|----------|--------|
| P01 | Modellgroesse: max. 30 Aktivitaeten pro Prozess | 7PMG G1 (30/50 Threshold), BEF4LLM | implementiert |
| P02 | Gateway-Verschachtelungstiefe ≤ 3 | BEF4LLM | implementiert |
| P03 | Control-Flow Complexity Score (CFC) | Cardoso 2005 | implementiert |

## Schicht 4: Workflow-Net Soundness (opt-in, ERROR/WARNING)

Formale Petri-Netz-Pruefung. Nur aktiv, wenn das Profil `layers.workflow_net.enabled` setzt — der
Redesign-Werkzeugkasten aktiviert sie in seinem festen Gate immer (siehe `redesign-core.js`).

| ID | Regel | Referenz | Status |
|----|-------|----------|--------|
| WF01 | Liveness — jede Transition feuert mindestens einmal | van der Aalst, Soundness Def. 1 | implementiert |
| WF02 | 1-Boundedness — kein Place akkumuliert mehr als 1 Token | van der Aalst, Soundness Def. 2 | implementiert |
| WF03 | Proper Completion — keine Deadlocks, Sink erreichbar | van der Aalst, Soundness Def. 3 | implementiert |

## Schicht 5: Process Optimization Advisory (opt-in, ADVISORY)

Nur aktiv im **`optimize`/`soll`-Modus** (bzw. Profil-Flag `layers.optimization.enabled`). Erkennt
Redesign-*Chancen* aus dem Prozessgraphen und gibt sie als nicht-blockierende **Vorschläge** (`advisories`)
aus — **nie auto-appliziert**. Jeder Befund trägt ein Devil's-Quadrangle-Trade-off-Tag. Analyse in
`optimize.js`.

| ID | Regel | Referenz | Status |
|----|-------|----------|--------|
| O01 | Exception isolation — Ausnahmen vom Hauptfluss trennen | Reijers & Limam Mansar 2005 (exception) | Heuristik |
| O02 | Knock-out ordering — Prüfungen nach Aufwand/Wahrscheinlichkeit ordnen | Reijers & Limam Mansar 2005 (knock-out) | Heuristik |
| O03 | Handoffs / task composition — Rollen-Übergaben reduzieren | Reijers 2005 (task composition), BABOK v3 §10.34 (Lean) | Heuristik |
| O04 | Parallelism candidate — sequentielle Aufgaben ggf. parallelisieren | Reijers & Limam Mansar 2005 (parallelism) | Heuristik |

Zusätzlich `metrics.optimization` (Lean/BABOK §10.34): `handoffCount`, `waitStates`, `reworkLoops`,
`gatewayComplexity`.

**Bewusste Grenzen:** rein graph-heuristisch. Der Logic-Core trägt keine Laufzeit-/Mengendaten (Aufwand,
Wahrscheinlichkeiten, echte Datenabhängigkeit) — deshalb werden Kandidaten zur **Prüfung** vorgeschlagen,
nichts wird umsortiert oder automatisch geändert. Reijers warnt zudem: Heuristiken sind kontextabhängig und
widersprechen sich teils (z.B. *Control addition* ↔ *Task elimination*). Quellen sind ausschließlich die
**publizierten** Paper (Reijers/Limam Mansar 2005, *Omega* 33(4); BABOK v3 2015).

**Vom Vorschlag zum Eingriff:** jede Advisory benennt über `transform` einen passenden, deterministischen
Eingriff aus dem Redesign-Werkzeugkasten (`scripts/redesign.js`, CLI-Zugang `scripts/redesign-cli.js`,
gemeinsamer Kern `scripts/redesign-core.js`) — je mit `preview*`/`apply*`, geprüft gegen ein festes,
**profilunabhängiges** Soundness-Gate. O01→`isolateException`, O02→`reorderKnockouts`, O03→`relane`,
O04→`parallelize`; `mergeTasks` hat keinen eigenen Detektor und ist nur direkt aufrufbar. Der
Werkzeugkasten entscheidet **nie**, *ob* ein Eingriff gemacht wird, und rät nie eine fehlende
Pflichtangabe (Reihenfolge, Marker, Name, Kantenzuordnung) — er verweigert stattdessen mit Begründung.
Details: `SKILL.md` Abschnitt „Redesign Toolbox“, `references/api-reference.md` (Advisory-Objektform).

---

## Regel-Profile

Profile ueberschreiben Severities oder deaktivieren ganze Layer.

### Default-Profil (`rules/default-profile.json`)
Alle 3 Layer aktiv, keine Overrides.

### Strict-Profil (`rules/strict-profile.json`)
Fuer regulierte Branchen: Style-Warnungen werden zu Errors.

### Custom-Profil
```json
{
  "profile": "custom",
  "layers": {
    "soundness": { "enabled": true },
    "style": { "enabled": true },
    "pragmatics": { "enabled": false }
  },
  "overrides": {
    "M01": { "severity": "ERROR" },
    "S04": { "severity": "INFO" }
  }
}
```

---

## Regel-Objekt Schema

```javascript
{
  id: 'S01',                              // Eindeutige ID
  layer: 'soundness',                     // soundness | style | pragmatics
  defaultSeverity: 'ERROR',               // ERROR | WARNING | INFO
  scope: 'process',                       // process | global
  description: 'Jeder Prozess hat mindestens ein Start-Event',
  ref: { omg: '§10.4.2', pmg: 'G3' },    // Quellverweise
  check: (proc, lc, config) => {          // Prueffunktion
    const starts = (proc.nodes || []).filter(n => n.type === 'startEvent');
    return starts.length >= 1
      ? { pass: true }
      : { pass: false, message: `Process '${proc.id}' has no startEvent` };
  }
}
```

---

## Regel M01: Objekt+Verb-Heuristik

**Layer:** Style | **Default Severity:** WARNING | **Scope:** process

Aktivitaets-Labels sollen der Objekt+Verb-Konvention folgen (deutsche BA-Konvention: Verb am Ende im Infinitiv, z.B. "Antrag pruefen", "Zahlung anweisen"). Reine Substantive oder Substantivketten ohne Verb ("Pruefung", "Vorgang zur Klaerung") sind unklar und werden gewarnt.

**Heuristik (bewusst konservativ):** M01 ist **kein** POS-Tagger. Die Pruefung nutzt:
1. **< 2 Tokens** → Verstoss (Einzelwort wie "Pruefung").
2. **Deutsch (primaer):** valide, wenn das letzte Token wie ein Infinitiv aussieht (Endung `-en`/`-eln`/`-ern`/`-ieren`, Laenge ≥ 4). Klammer-/Bracket-Meta `(…)`/`[…]` und Slashes werden vorher normalisiert ("erfassen/aendern" → beide Verben).
3. **Englischer Escape-Hatch:** valide, wenn das erste Token in einer kleinen kuratierten Verbliste steht ("Review Application"), um False-Positives zu vermeiden.

**Bewusste Grenzen:** Die Heuristik kann deutsche Plural-Substantive auf `-en` nicht sicher von Verben unterscheiden und deckt nur einen kleinen englischen Verbwortschatz ab. Sie ist deshalb WARNING, nie blockierend. Die exakte Wortartanalyse ist als **M05/M06** vorgesehen (Status: Platzhalter/OFF — POS-Tagger-Problem, siehe ROADMAP). M01 faengt die haeufigen, offensichtlichen Verstoesse ab.

**Beispiele:**

| Bewertung | Name |
|-----------|------|
| gut | `Antrag pruefen` |
| gut | `Zahlung anweisen` |
| gut | `Partnerdaten erfassen/aendern (KVNeo)` |
| gut | `Review Application` (englischer Escape-Hatch) |
| schlecht | `Pruefung` (Einzelwort) |
| schlecht | `Vorgang zur Klaerung` (kein Verb) |

**Referenz:** 7PMG G7 (Mendling et al., 2010), Bruce Silver: BPMN Method & Style, Ch.3

---

## Regel M10: Lane/Pool Name Length

**Layer:** Style | **Default Severity:** WARNING | **Scope:** global

Lane- und Pool-Namen sollten maximal 25 Zeichen lang sein. Laengere Namen erzwingen mehrzeiliges Rendering in Swimlane-Headern, was die Lesbarkeit beeintraechtigt. Als Faustregel gilt: 25 Zeichen × ~6,6 px/Zeichen ≈ 165 px, was bei typischen Lane-Hoehen (100–200 px) komfortabel in einer rotierten Zeile Platz findet.

**Rationale:** Bruce Silver empfiehlt kurze, funktionale Rollennamen fuer Swimlanes (z.B. "Einkauf", "QA", "Compliance"). Beschreibende Saetze, Modul-Pfade oder Meta-Informationen in eckigen Klammern gehoeren nicht in einen Lane-Header.

**Beispiele:**

| Bewertung | Name | Laenge |
|-----------|------|--------|
| gut | `Einkauf` | 7 |
| gut | `QA Team` | 7 |
| gut | `Compliance` | 10 |
| gut | `Bestellverarbeitung` | 19 |
| schlecht | `Pipeline — Layout + Rendering (topology → ELK)` | 47 |
| schlecht | `Kreditorenbuchhaltung (intern)` | 30 |

**Referenz:** Bruce Silver: BPMN Method & Style, 2nd Ed., §4.2 (Naming & Labels)

---

## Rule M11: decisionRef Placement

**Layer:** Style | **Default Severity:** WARNING | **Scope:** process

> Written in English, unlike the older entries above. New content in this repository is English;
> the German entries are legacy and are not translated as a side effect of adding a rule.

`decisionRef` records which decision model a task invokes. It is meaningful on a `businessRuleTask`
and on nothing else. Anywhere else it is inert: no engine reads it, and the reader is misled into
thinking a decision is bound where none is.

**Why WARNING and not ERROR.** The file stays valid BPMN either way. `decisionRef` is serialised
into `<bpmn:extensionElements>` under the generator's own namespace, and `tExtensionElements` is
`<xsd:any namespace="##other">` — a foreign-namespace child is legal on any `BaseElement`
(OMG Semantic.xsd). So this is a modelling defect, not a structural one, and the severity says so.
The rule descends into subprocesses, because the field does.

**Why our own namespace and not `camunda:`.** BPMN 2.0 defines no attribute for this link. The
reverse direction *is* standardised — DMN's `tDecision` carries `usingProcess` and `usingTask`
(DMN13.xsd), pointing from the decision to the task — but there is no BPMN→DMN counterpart.
`camunda:decisionRef` is a vendor extension, and emitting it would make every file we write claim a
Camunda binding it does not have. See `EXTENSION_NS` in `scripts/utils.js`.

**Beispiele:**

| Bewertung | Element | Grund |
|-----------|---------|-------|
| gut | `businessRuleTask` mit `decisionRef: "RatingDecision"` | the element that invokes a decision |
| schlecht | `userTask` mit `decisionRef` | a person decides here, not a rule set |
| schlecht | `serviceTask` mit `decisionRef` | use `implementation` for the service binding |

**Referenz:** OMG BPMN 2.0.2 §10.2.5 (Business Rule Task); OMG DMN 1.3 `tDecision` for the
standardised reverse link.

---

## DMN Rules — a separate engine, three layers, two modes

> Written in English, like M11 above. These rules live in `scripts/dmn/rules.js` and run against
> **Decision-Core**, not Logic-Core. They are counted separately: every "N rules, 5 layers" claim in
> README.md and CLAUDE.md is about `scripts/rules.js` alone. The docs gate routes a claim to the DMN
> engine only when its line says "DMN".

A decision model is not "sound" in the workflow sense — it has no start, no end and no token, so
S01–S13 and the WF-Net layer have no counterpart. What a DRG can be wrong about is its graph, the
shape of its tables, and whether the two agree with the specification.

### Layers and modes

| Layer | Default severity | Rules | In which mode |
|-------|-----------------|-------|---------------|
| `soundness` | ERROR | D01–D05, D09–D11 | both |
| `semantics` | WARNING | D06–D08 | both |
| `best_practice` | WARNING | B01–B06 | `best-practice` only |

Two modes, mirroring `document`/`optimize` on the BPMN side:

- **`semantic`** (default) — does the model hold together? Everything reported here is either
  invalid against the specification or points at something demonstrably wrong.
- **`best-practice`** — additionally readability and method. Everything B-prefixed produces a file
  that is valid DMN and that every engine evaluates correctly; what it will not do is stay
  comprehensible.

The split is the point: a model being documented *as it is* should not be nagged about how it ought
to look. Recording an existing decision practice and improving it are different jobs.

```js
runDmnRules(dc);                                 // semantic
runDmnRules(dc, { mode: 'best-practice' });
runDmnRules(dc, { profile: loadRuleProfile('rules/custom/<profile>.json'), mode: 'best-practice' });
```

A profile is more specific than a mode, so an explicit `enabled` in a profile wins over what the
mode would set. Profiles: `rules/dmn-default-profile.json`, `rules/dmn-best-practice-profile.json`,
and your own under [`rules/custom/`](../rules/custom/README.md) — loaded by path, never scanned.

Thresholds live in `scripts/config.json` under `dmn` (`maxRulesPerTable`, `maxDrgDepth`), not in the
rule code.

### Soundness (ERROR)

| ID | Rule | Reference |
|----|------|-----------|
| D01 | Every requirement connects two declared nodes | `tDMNElementReference/@href` |
| D02 | The requirement graph is acyclic | DMN 1.3 §6.1.2 |
| D03 | Requirements connect element types DMN permits, with the type the pair implies | DMN 1.3 §6.2.3, Table 2 |
| D04 | A decision table has at least one output clause | `tDecisionTable/output` — no `minOccurs`, so it defaults to 1 |
| D05 | Every rule has one entry per input, output and annotation column | DMN 1.3 §8.2 |
| D09 | A Collect operator needs a single output | DMN 1.3 §8.2.11 |
| D10 | `PRIORITY` and `OUTPUT ORDER` need output values | DMN 1.3 §8.2.11 |
| D11 | A crosstab is always `UNIQUE` | DMN 1.3 §8.1 |

### Semantics (WARNING)

| ID | Rule | Reference |
|----|------|-----------|
| D06 | A decision should carry decision logic | DMN 1.3 §6.3.1 |
| D07 | Every input data element feeds something | — |
| D08 | `aggregation` only means something with hit policy `COLLECT` | DMN 1.3 §8.2.11 |

### Best practice (WARNING, opt-in)

| ID | Rule | Reference |
|----|------|-----------|
| B01 | Avoid the `FIRST` hit policy | DMN 1.3 §8.2.11 — the spec's own words, see below |
| B02 | A decision table should stay small enough to read | `config.json → dmn.maxRulesPerTable` (20) |
| B03 | A decision should state the question it answers | DMN 1.3 §6.3.6, Table 11 |
| B04 | Input data should declare its type | — |
| B05 | A knowledge source should say what it is and where it lives | DMN 1.3 §6.3.12, Table 19 |
| B06 | The requirement chain should not run too deep | `config.json → dmn.maxDrgDepth` (5) |

### Why these severities

**D03 checks pairs, not endpoints.** §6.2.3 states that "the type of the requirement is uniquely
determined by the types of the two elements connected", and Table 2 lists every permitted pair. That
sentence is why the rule is a lookup table rather than two lists of allowed sources and targets: an
endpoint check has holes in both directions. It accepts `decision → decision` labelled *authority*
(each end is individually legal for one) although Table 2 says that pair is unambiguously
*information*; and the first version of this rule rejected `knowledgeSource →
businessKnowledgeModel`, which Table 2 explicitly permits, because that target had been left off the
authority list. Both cases are now covered by tests.

**D05 is an error, not a warning,** because decision-table entries are *positional*. A row with one
input entry where the table has two columns does not leave a blank — it shifts every later entry, so
the table silently means something other than it reads.

**D09 is an error while the neighbouring D08 is a warning.** The specification says compound-output
tables support "Collect **without** operator, because the collect operator is undefined over multiple
outputs". Undefined, not merely unusual. An `aggregation` on a non-`COLLECT` table (D08) is by
contrast simply ignored — wrong, but harmless.

**D06 is only a warning.** A decision without logic is legal DMN and often deliberate: early in
modelling a DRD documents *which* decisions exist and what they depend on, before anyone has written
a single rule. Reporting that as an error would make the tool useless for exactly the phase it is
most helpful in.

**B01 is not our opinion.** DMN 1.3 §8.2.11 says of first-hit tables: *"first hit tables are not
considered good practice because they do not offer a clear overview of the decision logic"*. It sits
in the opt-in layer rather than in `semantics` because such a table is still valid and still
evaluates correctly.

### Not in this set

Completeness ("does every input combination hit a rule?") and overlap ("does `UNIQUE` actually
hold?" — the specification requires that unique tables contain no overlapping rules) are **not**
checked. Both need interval algebra over the input domains, and both are tracked as their own piece
of work in [the integration plan](../docs/superpowers/plans/2026-07-30-dmn-integration.md), fork G7.

Also absent, and deliberately: `decisionService` (a grouping construct with four reference lists and
its own DI divider line), the boxed-expression types beyond decision table and literal expression,
and `itemDefinition`.

---

## Erweiterung

1. Neues Regel-Objekt in `RULES`-Array in `rules.js` einfuegen
2. `check`-Funktion implementieren (Platzhalter: `() => ({ pass: true })`)
3. Tests schreiben
4. OMG-Compliance-Mapping in `references/omg-compliance.md` aktualisieren

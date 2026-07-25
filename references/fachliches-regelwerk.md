# BPMN Fachliches Regelwerk

Konfigurierbare Validierungsregeln fuer BPMN-Prozesse. 5 Schichten, 30 Regeln (M05/M06 deaktiviert; Schicht 4 Workflow-Net und Schicht 5 Optimization sind opt-in).

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
| M07 | Start-Events nur am Anfang (keine eingehenden Kanten) | OMG §10.4.2 | Platzhalter |
| M08 | End-Events nur am Ende (keine ausgehenden Kanten) | OMG §10.4.2 | Platzhalter |
| M10 | Lane- und Pool-Namen: max. 25 Zeichen | Silver §4.2 | implementiert |

## Schicht 3: Pragmatik (INFO)

Komplexitaetsmetriken und Hinweise.

| ID | Regel | Referenz | Status |
|----|-------|----------|--------|
| P01 | Modellgroesse: max. 30 Aktivitaeten pro Prozess | 7PMG G1 (30/50 Threshold), BEF4LLM | implementiert |
| P02 | Gateway-Fanout: max. 5 ausgehende Kanten pro Gateway | Silver Ch.5 | Platzhalter |
| P03 | Verschachtelungstiefe: max. 3 Ebenen | BEF4LLM | Platzhalter |

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

## Erweiterung

1. Neues Regel-Objekt in `RULES`-Array in `rules.js` einfuegen
2. `check`-Funktion implementieren (Platzhalter: `() => ({ pass: true })`)
3. Tests schreiben
4. OMG-Compliance-Mapping in `references/omg-compliance.md` aktualisieren

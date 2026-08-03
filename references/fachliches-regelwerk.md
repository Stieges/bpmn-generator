# BPMN Fachliches Regelwerk

Konfigurierbare Validierungsregeln fuer BPMN-Prozesse. 5 Schichten, **35 registrierte Regeln**, davon 33 aktiv (M05/M06 stehen auf `severity: OFF`). Schicht 4 (Workflow-Net) und Schicht 5 (Optimization) sind opt-in.

## Architektur

```
rules.js           → Regel-Definitionen + Runner
validate.js         → Thin Wrapper (public API)
rules/*.json        → Profile (Severity-Overrides, Layer-Deaktivierung)
```

**Erweiterbar:** Neue Regeln = neues Objekt im `RULES`-Array in `rules.js`.
**Konfigurierbar:** Profile ueberschreiben Severities oder deaktivieren ganze Layer.

**Sprache in diesem Dokument** — die Regel steht hier einmal vollständig, weil ihre kurze Fassung
(„neuer Inhalt ist Englisch") schon zweimal falsch verstanden worden ist:

- Ein **neuer Abschnitt** — eine Regel, eine Schicht, ein Kapitel, das es vorher nicht gab — wird
  **englisch** geschrieben. So entstanden M11, S14 und der DMN-Teil, jeder mit einer eigenen
  Notiz.
- Eine **Änderung an einem vorhandenen deutschen Abschnitt** bleibt **deutsch**, egal wie groß
  sie ist. Auch eine vollständige inhaltliche Neufassung ist eine Änderung, keine Neuanlage. Der
  Bestand wird **nicht** als Nebenwirkung einer Regeländerung übersetzt — das ist der ganze Sinn
  der Konvention, denn eine Übersetzung im selben Commit macht die eigentliche inhaltliche
  Änderung im Diff unsichtbar.
- Im Zweifel entscheidet die Sprache des Abschnitts, den man anfasst, nicht die des Commits.

Für Code gilt das nicht: `description`-Felder und Kommentare in `scripts/` sind für neuen Inhalt
englisch, unabhängig davon, in welcher Sprache dieses Dokument die Regel zusammenfasst (siehe die
Notiz über der Regel-Tabelle unten).

## Quellen

| Kuerzel | Quelle |
|---------|--------|
| OMG | OMG BPMN 2.0.2 (formal/2013-12-09, ISO/IEC 19510:2013) |
| 7PMG | Seven Process Modeling Guidelines (Mendling/Reijers/van der Aalst, 2010) |
| Silver | Bruce Silver: BPMN Method & Style, 2nd Ed. |
| MG.org | modeling-guidelines.org |
| BEF4LLM | BEF4LLM (Kourani et al., 2025) |

---

## Schicht 1: Soundness (ERROR, fuenf Regeln WARNING)

Strukturelle Korrektheit. Blockiert die Pipeline bei Verletzung — mit Ausnahme von S04, S07, S08,
S14 und S15, die per Default `WARNING` sind und daher melden, ohne die Generierung zu stoppen. Die
Severity steht pro Regel in `defaultSeverity` (`scripts/bpmn/rules.js`) und ist ueber Profile
ueberschreibbar; `rules/strict-profile.json` hebt S14 auf `ERROR`.

Die Spalte „Regel" ist eine **deutsche Zusammenfassung**, nicht der Wortlaut. Maßgeblich ist
immer das Feld `description` der jeweiligen Regel in `scripts/bpmn/rules.js` — dort steht bei
neueren Regeln englischer Text. Das ist Absicht: eine zweite, unabhängig gepflegte Formulierung
wäre genau das, was auseinanderlaufen kann, eine als solche gekennzeichnete Zusammenfassung nicht.
Wer eine Regel ändert, aktualisiert `description` und passt diese Zeile sinngemäß an.

| ID | Regel | Referenz | Status |
|----|-------|----------|--------|
| S01 | Jeder Prozess hat mindestens ein Start-Event | OMG §10.4.2, 7PMG G3 | implementiert |
| S02 | Jeder Prozess hat mindestens ein End-Event | OMG §10.4.2, 7PMG G3 | implementiert |
| S03 | Kanten referenzieren nur existierende Nodes (source/target) | OMG §10.3.1 | implementiert |
| S04 | Jeder Node wird von einer eingehenden Sequenzkante erreicht — keine isolierten und keine unerreichbaren Nodes (Severity WARNING) | van der Aalst (1997), WF-Netz-Zusammenhang (erschoepfend: WF01) — bewusst keine OMG-Stelle, siehe unten | implementiert |
| S05 | Kein Deadlock: XOR-Split darf keinen AND-Join auf exklusiven Pfaden speisen | OMG §10.5, Silver Ch.5, 7PMG G4, CMOF: ExclusiveGateway/ParallelGateway superClass="Gateway"; Gateway.gatewayDirection : GatewayDirection {Unspecified, Converging, Diverging, Mixed} | implementiert |
| S06 | Kein Deadlock: Inclusive-Split darf keinen AND-Join auf exklusiven Pfaden speisen | OMG §10.5, CMOF: InclusiveGateway superClass="Gateway" mit default : SequenceFlow | implementiert |
| S07 | Jeder Pfad vom Start muss ein End-Event erreichen koennen — Nodes ohne ausgehende Kante (Severity WARNING) | 7PMG G1 | implementiert |
| S08 | Boundary-Event-Pfade muessen in End-Event terminieren (Severity WARNING) | OMG §10.4.4, BEF4LLM | implementiert |
| S09 | Message Flows nur zwischen verschiedenen Pools | OMG §9.4 | implementiert |
| S10 | Message Flows: Endpunkte muessen existieren, und wo sie einen Knoten benennen, muss dieser ein InteractionNode sein | OMG §9.4, §7.6.2 Table 7.4, CMOF: MessageFlow.sourceRef/targetRef typed as InteractionNode; TextAnnotation/Group sind superClass="Artifact" (nicht einmal FlowNodes), DataObject-/DataStoreReference sind FlowElements | implementiert |
| S11 | SubProcess-Kinder: Start-Event + End-Event vorhanden | OMG §10.2.1 | implementiert |
| S12 | Message Flow source/target darf kein Gateway sein | OMG §7.6.2 Table 7.4, CMOF: MessageFlow.sourceRef/targetRef typed as InteractionNode (Gateway extends FlowNode, not InteractionNode) | implementiert |
| S13 | Boundary Event muss an einer existierenden Aktivität im selben Container hängen — und der Host muss wirklich eine Aktivität sein | OMG §10.4.3 Table 10.86, CMOF: BoundaryEvent.attachedToRef : Activity [1..1] | implementiert |
| S14 | Message Flow source/target darf kein Container sein — der Klasse nach (SubProcess/Transaction/AdHocSubProcess/CallActivity) oder der Struktur nach (eigenes `nodes`-Array) (Severity WARNING) | OMG §7.6.2 Table 7.4, CMOF: MessageFlow.sourceRef/targetRef typed as InteractionNode; Activity superClass="FlowNode" only (BPMN20.cmof:1095) | implementiert |
| S15 | Ein Knotenfeld muss auf einer Klasse sitzen, für die OMG das Attribut definiert — `isForCompensation` nur auf Activity, `implementation` nur auf den fünf aufrufenden Task-Typen, `triggeredByEvent` nur auf SubProcess und dessen Spezialisierung Transaction, `calledElement` nur auf CallActivity, `scriptFormat` nur auf ScriptTask, `isCollection` nur auf DataObjectReference (Severity WARNING) | OMG §10.2, §10.2.2/§10.2.3, §10.2.5, §10.2.6; CMOF: Activity.isForCompensation (BPMN20.cmof:1095), `implementation` per Klasse an UserTask (:1263)/ServiceTask (:1240)/SendTask (:1229)/ReceiveTask (:1214)/BusinessRuleTask (:1177) | implementiert |

**Zu S04:** Die Regel fragt nach **eingehenden** Kanten, nicht nach Kanten überhaupt — und das
ist eine Korrektur, keine Umformulierung.

Bis einschließlich v3.6 bildete S04 die Menge der „verbundenen" Knoten als *Quellen ∪ Ziele*.
Ein Knoten mit genau einer **ausgehenden** und keiner eingehenden Kante galt damit als verbunden
und bestand die Regel; S07 prüft die spiegelbildliche Hälfte (fehlende ausgehende Kante) und
schwieg ebenfalls. Ein gestrandetes `parallelGateway` — nichts führt hinein, alles dahinter ist
tot — validierte unter dem Default-Profil vollständig sauber. Benannt hat es nur WF01, und die
`workflow_net`-Schicht ist opt-in. Das war keine bewusste Engfassung, sondern ein blinder Fleck:
„isoliert" *beschreibt* den auffälligsten Fall, es ist nicht die Eigenschaft, um die es geht. Die
Eigenschaft ist Erreichbarkeit.

Die Menge ist jetzt *nur die Ziele*.

**Hier sind zwei Änderungen zusammen ausgeliefert worden, und sie zeigen nicht in dieselbe
Richtung — die eine deckt die andere nicht ab.** Wer eine neu aufgetauchte oder verschwundene
Warnung prüft, braucht sie getrennt:

1. Die Änderung am **Prädikat** (Vereinigung → Ziele) ist strikt eine Obermenge. Jeder Knoten,
   den das alte Prädikat meldete, wird weiterhin gemeldet, und zusätzlich Knoten mit ausgehender
   und ohne eingehende Kante. Über alle 21 Fixture-Dateien gemessen: **null zusätzliche Knoten**,
   weil kein Fixture diese Form auf oberster Ebene enthält.
2. Die Änderung an der **Ausnahmemenge** (handgeschriebene Liste → `isSequenceFlowExempt`)
   entfernt bewusst Befunde — das ist ihr Zweck. Eine vollständig isolierte
   Kompensations-Aktivität etwa meldete die alte S04 und die neue schweigt dazu, und zwar
   richtigerweise: erreicht wird sie durch eine Kompensations-Assoziation, nicht durch eine
   Sequenzkante. Die drei betroffenen Formen stehen in der Tabelle weiter unten; darüber hinaus
   wird nichts stillgelegt.

Also: Die Regel meldet jetzt eine strikt größere Menge *unerreichbarer* Knoten und eine strikt
kleinere Menge *ausgenommener*. Es stimmt **nicht**, dass alles bisher Gemeldete weiterhin gemeldet
wird.

Zwei Meldungstexte statt einem: Hat der Knoten gar keine Kante, heißt es weiterhin *appears
isolated*; hat er eine ausgehende, heißt es *has no incoming flow* — „isoliert" wäre über einen
verdrahteten Knoten schlicht falsch und würde den Leser an die falsche Stelle schicken.

**Zur Quellenangabe.** S04 zitierte bis hierher `7PMG G2`. Das trug die Regel nicht: 7PMG G2 ist
*„minimize the routing paths per element"* (Mendling/Reijers/van der Aalst 2010) — eine
Komplexitäts-Leitlinie über die *Anzahl* der Kanten an einem Element, die über ein Element ohne
Kanten nichts aussagt. Die Quelle stützte also nicht einmal die alte, enge Lesart. Was die Regel
trägt, ist die Zusammenhangs-Eigenschaft, über die ein Workflow-Netz definiert ist (van der Aalst
1997, *Verification of Workflow Nets*): Jeder Knoten liegt auf einem gerichteten Pfad von der
Quelle zur Senke, ein Knoten, den keine Sequenzkante erreicht, liegt auf keinem. Genau diese
Eigenschaft prüft WF01 erschöpfend; S04 ist ihre immer aktive, rein lokale Näherung (keine
eingehende Kante, statt: kein Pfad vom Start-Event).

**Es wird bewusst keine OMG-Stelle zitiert.** Geprüft gegen
`references/omg-spec/normative/BPMN-2.0.2-spec.pdf`: §7.3.1 ist *„Basic BPMN Modeling Elements"*,
ein Formen-Katalog. Die Sequence Flow Connection Rules sind **§7.6.1 / Table 7.3**, und diese
Stelle regelt, welche *Paare* verbunden werden dürfen, während sie im eigenen Wortlaut sagt: „the
quantity of connections into and out of an object is subject to various configuration dependencies
[and] are not specified here" — die Spezifikation verzichtet also ausdrücklich darauf, eine
eingehende Kante zu fordern. Es gibt keine Stelle, die man zitieren könnte, und genau das
trotzdem zu tun ist der Weg, auf dem S04 bereits zweimal zu einer falschen Referenz gekommen ist.

**Nicht rekursiv.** S04 hat `scope: 'process'`, `runRules` ruft sie pro Pool über die Knoten der
obersten Ebene auf. Ein Kandidat *innerhalb* eines Containers wird deshalb nie gesehen — `b_task1`
in `tests/fixtures/subprocess-collapsed-children.json` hat eine ausgehende und keine eingehende
Kante und ist ein lebendes Beispiel — was mit ein Grund für die gemessene Null ist. Sie absteigen
zu lassen ist eine eigene Änderung mit eigener Reichweite, hier bewusst nicht gemacht.

**Zu S04 und S07 gemeinsam — was eine Sequenzkante gar nicht erreichen kann.** Beide Regeln hatten
eine eigene, handgeschriebene Ausnahmeliste, und beide waren unvollständig, auf je andere Weise —
weshalb dieselben drei Modellformen mal die eine, mal beide Warnungen auslösten:

| Form | vorher S04 | vorher S07 | Grund für die Ausnahme |
|------|-----------|-----------|-------------------------|
| Ereignis-Subprozess (`isEventSubProcess`) | „appears isolated" | „no outgoing flow" | OMG `triggeredByEvent` — wird durch sein eigenes Start-Event betreten, keine Sequenzkante führt hinein oder heraus |
| Kompensations-Aktivität (`isCompensation`) | „appears isolated" | „no outgoing flow" | OMG `isForCompensation` — ausgelöst durch eine Kompensations-Assoziation, nicht durch eine Sequenzkante |
| `group` (Artefakt) | schon ausgenommen (`isArtifact`) | „no outgoing flow" | Artefakt — Assoziationen verbinden es, keine Sequenzkanten. §7.6.1s eigene Anmerkung zu Table 7.3 ist ausdrücklich: „Pool, Lane, Data Object, Group, and Text Annotation are not listed in the table", sie sind also gar keine Objekte mit Sequenzkanten. S07s Literalliste kannte nur die anderen drei Artefakt-Typen |

Beide Regeln rufen jetzt eine Funktion, `isSequenceFlowExempt` (`scripts/bpmn/types.js`), die die
Ausnahmen samt ihrer jeweiligen Begründung an einer Stelle führt (`startEvent`, Boundary Event,
Artefakt, `isCompensation`, `subProcess` mit `isEventSubProcess`). Diese Hälfte beanstandet nichts
neu, sie ist reine Signalqualität. Anlass ist, dass zwei der drei Formen in
`references/prompt-template.md` ausdrücklich empfohlen werden — die Pipeline forderte das Modell
also auf, sie zu erzeugen, und warnte anschließend davor.

**Beide Instanz-Flags sind auf die Klasse des Knotens eingeschränkt, und das ist tragend.**
`references/input-schema.json` deklariert `isCompensation` und `isEventSubProcess` als generische
Eigenschaften von `Node`, gültig auf jedem `NodeType`; OMG fasst sie deutlich enger
(`isForCompensation` ist ein Attribut von `Activity`, `triggeredByEvent` eines von `SubProcess`).
Ohne diese Einschränkung wäre jedes der beiden Flags ein universeller Ausstieg aus beiden immer
aktiven Regeln: `{ type: 'parallelGateway', isCompensation: true }` ganz ohne Kanten wäre in S04
*und* S07 stumm, ein wirklich isoliertes Gateway also von nichts mehr gemeldet. Die Ausnahme ist
deshalb so eng wie das OMG-Attribut, für das sie steht, und nicht so weit wie das Schema-Feld.

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

**Zur Host-Prüfung von S13.** S13 prüft jetzt zusätzlich die **Klasse** des Hosts.
`BoundaryEvent.attachedToRef` ist im CMOF auf `Activity [1..1]` typisiert, und die Regel fragt das
endlich auch (`isActivity`, `scripts/bpmn/types.js`), statt nur, ob die Id existiert und im selben
Container liegt. Vorher kam ein Boundary Event an einem Gateway, an einem Event, an einem Artefakt
oder an einem anderen Boundary Event durch. Aufgefangen wurde die Form nur in der Übersetzung —
`wireBoundaryEvents` (`scripts/bpmn/workflow-net.js`) gibt so einem Ereignis gar keine Transition
und legt es als `boundaryEventWithoutHost` auf `pn.skipped` offen — sie war also von allem erkannt
und offengelegt ausser von der Schicht, die mit dem Autor spricht, und die nannte ein solches
Modell sauber. Beide Schichten sagen jetzt dasselbe.

`isActivity` und ausdrücklich **keine** Aufgaben-Liste: `SubProcess`, `Transaction` und
`CallActivity` sind Activity-Unterklassen, ein Boundary Event hängt an ihnen genauso zulässig wie
an einer Aufgabe (Error-Boundary an einem Sub-Prozess ist der Regelfall). Über die Fixtures
gemessen: **0 von 6** Boundary Events fallen neu durch.

**On S05/S06:** both rules used to ask *"do two branches of this split reach the AND-join?"*.
That is a reachability question, not a token question, and it rejected sound models at ERROR
severity — meaning no output at all. Two branches that re-converge at a merge **before** the
parallel block do both reach the join, but by then the choice is resolved: a single token enters
the AND-fork and forks into exactly the tokens the join waits for. `tests/fixtures/subprocess-merge-fanout.json`
is such a model — provably sound (`checkSoundness` reports nothing) and rejected regardless.

Both rules now ask the token question, and they ask it **per incoming flow** of the join, because
a parallel join fires only once every incoming flow carries a token:

1. for each incoming flow, collect which branches of the split can supply it. A branch supplies a
   flow either by **reaching its source**, or by **being that flow** — the split's own edge may
   land straight on the join (`gx --no--> gj`, the everyday skip path around a parallel block);
2. ignore flows no branch can supply — those are fed from outside the split's subgraph (typically
   a concurrent thread of an enclosing AND block) and no choice at the split can starve them;
3. if all remaining flows agree on their supplying-branch set, every choice feeds either all of
   them or none — no starvation, no finding;
4. if two of them disagree, some branch supplies one but never the other, and the join waits for
   a token that run can no longer produce. That is the deadlock.

Step 4 is deliberately stronger than *"two incoming flows have disjoint supplying branches"*: with
three branches A/B/C where A feeds only the first flow, C only the second and B both, no **pair**
of flows is disjoint, yet choosing A still deadlocks. Both readings are pinned by tests in
`scripts/bpmn/pipeline.test.js`.

Step 1's second clause is not a detail. Every branch's reach set deliberately excludes the split
itself, so that a loop running back to the split cannot make one branch look as though it could
reach another. Crediting a branch only by reachability therefore leaves an incoming flow *whose
source is the split* matching no branch at all — step 2 would then discard it as "fed from outside
the split", drop the count of relevant flows below two, and accept the deadlock in silence. The
branch edge is matched by identity rather than by its endpoints, because a split may carry two
separate flows into the same join, and those are two different branches.

Two consequences worth knowing:

- A gateway counts as a split when it has more than one outgoing flow. `has_join` is only a
  direction *hint* in `references/input-schema.json`, and a **Mixed** gateway (`gatewayDirection`)
  merges and splits at once. The old code skipped every gateway carrying `has_join`, so a merge of
  a rework loop that also chose between two exclusive paths into an AND-join was never reported —
  WF03 flagged that model as a deadlock while S05 stayed silent.
- The rule stays a cheap syntactic heuristic and remains **incomplete**: a flow counts as
  suppliable by a branch as soon as its source node is reachable, which over-approximates the
  supplying sets and therefore makes them agree more often than they should. The residual error is
  a missed deadlock, never a fabricated one. It also does not see a branch that *escapes* an
  enclosing parallel block entirely (the sibling arm's token is then stranded). Both belong to the
  exhaustive check: WF03 in the opt-in `workflow_net` layer.

Not covered by S06, and not a deadlock: an inclusive split that activates several branches which
re-converge at an **exclusive** merge puts several tokens into the parallel block. That is a
boundedness / proper-completion defect — WF02 and WF03's business.

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

Zweite bewusste Grenze, weil sie sonst wie ein Fehler aussieht: **die O-Schicht nominiert nur
Blatt-Aufgaben, nie Container.** Eine Kette aus drei Sub-Prozessen löst kein O04 aus, ein
Sub-Prozess als Ausnahmezweig kein O01/O02 — `optimize.js` fragt `TASK_TYPES`
(`scripts/bpmn/types.js`), nicht `isActivity`. Der Grund liegt eine Schicht weiter: O04 nominiert
Kandidaten für genau den Eingriff `parallelize`, und `previewParallelize` **verweigert** eine Kette
mit einem Sub-Prozess (SKILL.md, „lineare, gleichbahnige Task-Kette"; ein Scope parallel zu
schalten ist keine Umsortierung von Schritten). Eine Advisory, die der deterministische
Werkzeugkasten garantiert ablehnt, ist schlechter als keine — deshalb stellen beide Schichten
dieselbe Frage. Wer diese Lücke schließen will, muss beim Eingriff anfangen, nicht beim Detektor.

**Vom Vorschlag zum Eingriff:** jede Advisory benennt über `transform` einen passenden, deterministischen
Eingriff aus dem Redesign-Werkzeugkasten (`scripts/bpmn/redesign.js`, CLI-Zugang `scripts/bpmn/redesign-cli.js`,
gemeinsamer Kern `scripts/bpmn/redesign-core.js`) — je mit `preview*`/`apply*`, geprüft gegen ein festes,
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
Camunda binding it does not have. See `EXTENSION_NS` in `scripts/shared/utils.js`.

**Beispiele:**

| Bewertung | Element | Grund |
|-----------|---------|-------|
| gut | `businessRuleTask` mit `decisionRef: "RatingDecision"` | the element that invokes a decision |
| schlecht | `userTask` mit `decisionRef` | a person decides here, not a rule set |
| schlecht | `serviceTask` mit `decisionRef` | use `implementation` for the service binding |

**Referenz:** OMG BPMN 2.0.2 §10.2.5 (Business Rule Task); OMG DMN 1.3 `tDecision` for the
standardised reverse link.

---

## Rule S14: MessageFlow endpoints are InteractionNodes, and a container is not one

**Layer:** Soundness | **Default Severity:** WARNING | **Scope:** global

> Written in English, like M11 above.

A message flow whose `source` or `target` names a container is not an under-modelled but legal
shape, it is a schema violation. The rule asks `isContainerNode` (`scripts/bpmn/types.js`), which
recognises a container **two** ways, and both legs are load-bearing:

1. **by class** — `subProcess`, `transaction`, `adHocSubProcess`, `callActivity`. This leg is why
   the rule is not `n.nodes?.length`: a `callActivity` never carries children and a collapsed
   `subProcess` need not, and legality must not depend on how much of the container the author
   wrote down.
2. **by structure** — any node, of any type, carrying its own `nodes` array.
   `references/input-schema.json` declares `nodes` on every `Node`, so a `userTask` with children
   is schema-valid input, and `bpmnToPN`'s own `isContainer` is purely structural: such a node is
   translated into an entry/exit transition pair like any other container. This leg is why the
   rule is not `CONTAINER_TYPES.has(type)`, which is what it asked in its first cut — the
   Petri-net composition (`scripts/scenarios/collaboration.js`) refused such an endpoint and
   dropped the synchronisation while this rule said nothing about the same model. One predicate,
   read by both layers, is what keeps them from disagreeing again.

The message names the actual node type and states the right reason for it: the CMOF argument below
for a container **class**, and "carries its own `nodes` — a container in everything but its
declared type" for the structural case, where the class argument would be about a class the node is
not in.

For the class leg, the CMOF says so without room for interpretation
(`references/omg-spec/normative/BPMN20.cmof`, line numbers verified against the file in this repo):

| Element | Declaration | Line | InteractionNode? |
|---------|-------------|------|------------------|
| `MessageFlow.sourceRef` / `targetRef` | `type="InteractionNode"` | 851–852 | — (this is the constraint) |
| `Task` | `superClass="Activity InteractionNode"` | 1191 | yes, by an explicit second superclass |
| `Event` | `superClass="FlowNode InteractionNode"` | 287 | yes, likewise |
| `Participant` | `superClass="InteractionNode BaseElement"` | 863 | yes |
| `Activity` | `superClass="FlowNode"` | 1095 | **no** |
| `SubProcess` | `superClass="Activity FlowElementsContainer"` | 1147 | no — inherits `Activity` |
| `CallActivity` | `superClass="Activity"` | 1188 | no |
| `AdHocSubProcess` | `superClass="SubProcess"` | 1222 | no |
| `Transaction` | `superClass="SubProcess"` | 1233 | no |

`Task` and `Event` are InteractionNodes because each names it as a *second* superclass. `Activity`
does not, so nothing that inherits from `Activity` alone is one — which is every container class.

**Collapsing the subprocess does not help.** `isExpanded` exists only as a `BPMNShape` attribute
(`BPMNDI.xsd:55`, `BPMNDI.cmof:34`) and has no semantic counterpart anywhere in `BPMN20.cmof`. It
says how the shape is drawn, not what the element is. Switching the container to a `callActivity`
does not help either — see the table.

**The remedy is always one level down**: point the flow at a black-box participant, at a
send/receive task inside the subprocess, or at a message start/end event inside it. S10 was fixed
in the same change to collect node ids recursively, so an endpoint naming a node inside a
subprocess no longer reports as a dangling reference — otherwise this rule's advice would have led
straight into a different false ERROR.

**Why WARNING and not ERROR.** The soundness layer already carries WARNING-severity rules (S04,
S07, S08), so this is consistent with the layer rather than an exception to it, and every model
that generates today keeps generating. `rules/strict-profile.json` carries the
`"S14": { "severity": "ERROR" }` override for anyone who wants the build to stop.

**Why it also matters to the Petri-net translation.** `scripts/scenarios/collaboration.js` composes
message flows into synchronisation places. A container owns an entry/exit transition PAIR
(`t_C#enter`/`t_C#exit`), so wiring both would make a container-as-source send its message twice,
and picking one would invent a reading the standard does not offer. `resolve()` therefore refuses a
container endpoint outright and records it on `unresolvedEndpoints` with `reason: 'container'`.

**Beispiele:**

| Bewertung | messageFlow | Grund |
|-----------|-------------|-------|
| gut | `target: "receive_order"` (a receiveTask inside the subprocess) | a `Task` is an InteractionNode |
| gut | `target: "Pool_Supplier"` (a black-box participant) | a `Participant` is an InteractionNode |
| schlecht | `target: "fulfil"` (a `subProcess`) | inherits `Activity`, which is `FlowNode` only |
| schlecht | `source: "check_credit"` (a `callActivity`) | same, and no `isExpanded` setting changes it |
| schlecht | `target: "handle"` (a `userTask` with a `nodes` array) | carries a scope, so it is translated into an entry/exit pair — the structural leg |

**Referenz:** OMG BPMN 2.0.2 §7.6.2 Table 7.4; `BPMN20.cmof` lines as tabulated above.

---

## Rule S15: a per-node field must sit on a class OMG defines it on

**Layer:** Soundness | **Default Severity:** WARNING | **Scope:** process (recursive)

> Written in English, like M11 and S14 above.

`references/input-schema.json` declares `isCompensation`, `implementation`, `isEventSubProcess`,
`calledElement`, `scriptFormat` and `isCollection` as generic properties of `Node`, valid on any
`NodeType`. JSON Schema's `properties` has no way to say "only when `type` is one of …" without a
conditional block per field, so all six are schema-valid anywhere. OMG scopes each one far more
narrowly, and an attribute outside a class's content model is not merely unusual — it is
XSD-invalid.

The narrowing therefore has to happen after the schema gate, and it has to happen in exactly one
place. It now does: `OMG_NODE_FIELD_SCOPE` in `scripts/bpmn/types.js` is read by both consumers.

| Field | OMG attribute | Type | May sit on |
|-------|---------------|------|------------|
| `isCompensation` | `isForCompensation` | boolean | any `Activity` (every Task type, `subProcess`, `transaction`, `adHocSubProcess`, `callActivity`) |
| `implementation` | `implementation` | string | `userTask`, `serviceTask`, `sendTask`, `receiveTask`, `businessRuleTask` — **not** every Activity |
| `isEventSubProcess` | `triggeredByEvent` | boolean | `subProcess`, `transaction` — Transaction specialises SubProcess and inherits the attribute (`adHocSubProcess` inherits it too, but is outside the `NodeType` enum and `bpmnXmlTag` cannot emit it, so it is deliberately not granted; see `types.js`) |
| `calledElement` | `calledElement` | string | `callActivity` |
| `scriptFormat` | `scriptFormat` | string | `scriptTask` |
| `isCollection` | `isCollection` | boolean | `dataObjectReference` — but the attribute is written onto the companion `<bpmn:dataObject>`, see below |

**One field is authored in one place and written in another.** Logic-Core models a data object and
the reference to it as a single node, while BPMN splits them into a `DataObject` (the thing) and a
`DataObjectReference` (a use of it) — and the properties split with them. `isCollection` belongs to
the `DataObject`; bpmn-moddle's metamodel grants `DataObjectReference` only `dataObjectRef`. So the
author writes `isCollection` on the `dataObjectReference` node, which is what S15's `allowed` set
records, and the serialiser writes it onto the generated `<bpmn:dataObject>`. The table's `on`
column carries that distinction.

Until this was corrected the attribute went onto the reference, producing
`<bpmn:dataObjectReference isCollection="true">` and an `unknown attribute <isCollection>` on every
round trip — a live instance, inside S15's own table, of the defect class S15 exists to prevent.

**The rule checks two things, and says only one of them at a time.** A field can be on the wrong
*class* or carry a value of the wrong *type*. These are different mistakes with different remedies
— "you meant a different node" versus "you meant a different value" — so the rule asks the class
question first and only asks about the type if the class is right. One field never produces two
overlapping sentences.

**Why a wrongly-typed value is dropped and reported rather than coerced.** `isCompensation: 'no'`
is the case that decides it: `!!'no'` is `true`, so coercing would emit
`isForCompensation="true"` for an author who wrote `"no"` — the exact opposite of the stated
intent, with nothing anywhere saying so. A serialiser guessing at intent is worse than one that
declines. And dropping *without* reporting would recreate, for the value, precisely the silence S15
exists to close for the class: `references/input-schema.json` does type these fields, so the HTTP
path rejects a wrong one at the schema gate, but `runPipeline` and the CLI do not run that gate —
and a public API must not depend on the caller having come through the HTTP server to be safe.

**Why the rule is not phrased as "an Activity attribute on a non-Activity".** `implementation`'s
scope is *narrower* than `Activity`: `BPMN20.cmof` grants it per class to the five invoking Task
types and never inherits it from `Activity`, so a plain `task`, a `scriptTask`, a `manualTask` and
every container are Activities that may not carry it. A single `isActivity` test would have cleared
`implementation` on a `subProcess` — one of the cases that actually emits invalid XML. Per-field
scopes are the point, not a complication of it.

**Why the rule exists, given that the serialiser already drops these fields.** Because the
serialiser drops them. Before the class guards, an out-of-scope field reached the XML and
bpmn-moddle's round trip reported it as `unknown attribute <…>` in `validation.xmlWarnings` —
indirect and ugly, but present. Guarding the serialiser made the output valid and took that signal
away with it. A `{ type: 'startEvent', isCompensation: true }` wired normally into a flow then
produced *nothing at all*: no error, no warning, no serialisation warning, exit 0, and the author
never learned that what they wrote had been ignored. That is exactly the silent-drop failure mode
CLAUDE.md's "Adding a per-node field" section warns about.

The serialiser is still right not to diagnose — its contract is to emit valid BPMN for the model it
was handed, the same separation that keeps `net-check.js` out of judging XML. That makes the
reporting the rule engine's job, and S15 is it. The two share one table precisely so they cannot
disagree; a rule that contradicted the serialiser about which fields are legal where would be worse
than no rule at all.

**Why it does not lean on S04/S07.** Those fire only where the node is *disconnected*, and they
talk about connectivity ("appears isolated"), which is a true sentence about a different problem. A
correctly wired node carrying an out-of-scope field is invisible to them.

**Recursive, because `buildFlowNode` is.** A subprocess child reaches the serialiser through the
same function and is dropped by the same guard at any nesting depth, so a rule that walked only the
top level would be silent about precisely the nesting level that gets forgotten.

**Why WARNING and not ERROR.** The emitted XML is valid — the field is dropped — so nothing
downstream breaks; what happened is that something the author wrote was ignored, which is worth
saying and not worth refusing to build over. It keeps every model that generates today generating,
the same reasoning S14 records, and the soundness layer already carries WARNING rules (S04, S07,
S08, S14). A profile override escalates it.

**Should the schema constrain this instead?** It *could*: JSON Schema can express it with an
`allOf` of `if`/`then` blocks, one per field. It should not be the only place, and was not chosen
as the first place, for three reasons. A schema violation is binary and blocking, so expressing it
there would reject models that generate today — the opposite of the WARNING decision above. The
schema gate runs at the HTTP entry (`scripts/bpmn/schema-gate.js`) and its ajv output names a
failed keyword and a JSON pointer, not a sentence an author can act on. And the schema is the
contract shown to the LLM, where six conditional blocks buy far less than one clear rule message.
Constraining it in the schema *as well*, once the WARNING has been in the field long enough to show
that nothing legitimate trips it, is a reasonable later step.

**Beispiele:**

| Bewertung | Node | Grund |
|-----------|------|-------|
| gut | `{ type: "serviceTask", isCompensation: true }` | a Task is an Activity |
| gut | `{ type: "subProcess", isCompensation: true }` | a container is an Activity too |
| gut | `{ type: "userTask", implementation: "##WebService" }` | one of the five invoking Task types |
| schlecht | `{ type: "parallelGateway", isCompensation: true }` | a Gateway is not an Activity |
| schlecht | `{ type: "startEvent", isCompensation: true }` | an Event is not an Activity |
| schlecht | `{ type: "subProcess", implementation: "##WebService" }` | an Activity, but not one of the five |
| schlecht | `{ type: "exclusiveGateway", implementation: "##WebService" }` | not a Task at all |
| schlecht | `{ type: "task", isCompensation: "yes" }` | right class, wrong type — a string, not a boolean |
| schlecht | `{ type: "task", isCompensation: "no" }` | same, and the case that rules out coercion: `!!"no"` is `true` |
| schlecht | `{ type: "userTask", implementation: 42 }` | right class, wrong type — a number, not a string |

**Referenz:** OMG BPMN 2.0.2 §10.2 (Activity), §10.2.2/§10.2.3 (Task attributes), §10.2.5
(SubProcess), §10.2.6 (CallActivity); `BPMN20.cmof` lines as tabulated in the rule's `ref`.

---

## DMN Rules — a separate engine, three layers, two modes

> Written in English, like M11 above. These rules live in `scripts/dmn/rules.js` and run against
> **Decision-Core**, not Logic-Core. They are counted separately: every "N rules, 5 layers" claim in
> README.md and CLAUDE.md is about `scripts/bpmn/rules.js` alone. The docs gate routes a claim to the DMN
> engine only when its line says "DMN".

A decision model is not "sound" in the workflow sense — it has no start, no end and no token, so
S01–S15 and the WF-Net layer have no counterpart. What a DRG can be wrong about is its graph, the
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
2. `check`-Funktion implementieren (Platzhalter: `() => ({ pass: true })`). Rueckgabe ist
   entweder `{ pass: true }` oder — bei einem Befund — `{ pass: false, message }` fuer **genau
   einen** Befund bzw. `{ pass: false, messages: [...] }` fuer **mehrere**. `message` wird
   woertlich als ein einziger Befund uebernommen, auch wenn `'; '` darin vorkommt.

   Mehrere Befunde gehoeren in `messages`, niemals in einen mit `'; '` zusammengefuegten String.
   Frueher war genau das der stillschweigende Vertrag: die Regeln fuegten mit `'; '` zusammen und
   `classifyResult` trennte an derselben Stelle wieder auf. Eine Regel, deren *einzelne* Meldung
   ein `'; '` enthielt, wurde dadurch als zwei Befunde ausgegeben — der zweite ein Fragment ohne
   Id und ohne Element, das bis in `validation.errors`, die HTTP-Antwort und `--strict`
   durchschlug und die Fehlerzahl fuer einen Defekt verdoppelte (S10 hat das real getroffen).
   `classifyResult` trennt seit dieser Aenderung nicht mehr auf. Ein Test ueber den Quelltext
   haette die Falle nie schliessen koennen: Meldungen entstehen zur Laufzeit aus Knoten- und
   Lane-Namen, eine Aufgabe namens „Pruefen; freigeben" loest sie also aus den *Daten* aus.
3. Tests schreiben
4. OMG-Compliance-Mapping in `references/omg-compliance.md` aktualisieren
5. Dieses Dokument nachziehen — Zeile in der Layer-Tabelle, bei Bedarf ein Langtext-Abschnitt.
   **Sprache:** ein *neuer* Abschnitt ist englisch, eine *Änderung* an einem vorhandenen
   deutschen Abschnitt bleibt deutsch (Volltext der Konvention oben unter „Architektur"). Auch
   eine vollständige Neufassung eines Bestandsabschnitts ist eine Änderung, keine Neuanlage.
   Die Tabellenzeile ist eine deutsche Zusammenfassung; maßgeblich ist `description` in
   `rules.js`.

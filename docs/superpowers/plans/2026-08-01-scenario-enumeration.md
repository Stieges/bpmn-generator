# Szenario-Aufzählung über BPMN und DMN

## Kontext

Die Evaluationslücke des Projekts ist nicht die Pipeline, sondern der Nachweis, dass ein erzeugtes
Modell zu dem passt, was beschrieben wurde. Der naheliegende Weg — ein Ground-Truth-Korpus mit
Precision/Recall — verlangt, dass jemand entscheidet, was in einem Text „notwendig" war. Das ist
eine fachliche Entscheidung, die dem Generator nicht zusteht; `README.md:67` schließt sie aus.

Dieser Entwurf geht anders vor: **Wir bewerten nicht, wir machen die Konsequenzen des Modells
sichtbar.** Aufgezählt wird, welche Wege ein Token nehmen kann — durch den Prozess und durch die
aufgerufenen Entscheidungstabellen. Ein fehlendes Szenario ist im Diagramm unsichtbar, in einer
Liste dagegen auffindbar. Das Urteil bleibt beim Prüfenden (Mensch oder LLM), wir liefern das
Material.

Die Regel-Engine kann das nicht leisten: `check(proc, lc, profile)` (`rules.js:827`) sieht nur das
erzeugte Logic-Core, nie den Ursprungstext. Ein XOR, das fälschlich als AND modelliert wurde, ist
strukturell einwandfrei und passiert alle 34 Regeln.

## Vorgehen und Reihenfolge

1. **Erst PR #45 mergen** (DMN 1.3 Pipeline, Branch `feat/dmn`, 39 Commits, reviewt). Dieses
   Vorhaben importiert aus `scripts/dmn/` und hängt daher an dessen Merge.
2. **Dann neuer Branch von `master`** — eigenes Thema, gehört nicht in den DMN-PR.
3. `caffeinate` zu Beginn aktivieren, am Ende wieder beenden.

(Schritte 1-2 sind erledigt: PR #45 gemerged als `116a0cd`, Branch `feat/scenario-enumeration`
von `master` eröffnet.)

## Der Befund, der die Struktur bestimmt

Ein Review dieses Entwurfs hat einen Blocker und mehrere schwere Lücken gefunden. Sie sind unten
eingearbeitet. Das Vorhaben zerfällt in Phasen, die einzeln ausführbar sind — als ein Plan gebaut,
würden die Phasen unabhängig voneinander Annahmen über die Datenform treffen und erst bei der
Integration kollidieren.

## Getroffene Entwurfsentscheidungen

Die fünf Fragen, die das Review offengelassen hatte, sind entschieden:

| # | Frage | Entscheidung |
|---|---|---|
| A1 | Parallele Verschränkungen | **Kanonisch** — eine Reihenfolge je Parallelblock, Anzahl als Zahl |
| A2 | Mehrere Pools | **Message Flows als Synchronisation modellieren** — echte poolübergreifende Szenarien |
| B1 | Hit-Policies | **Policy-genau abgestuft** — exakt bei UNIQUE, markierte Überschätzung bei FIRST/PRIORITY, aggregierter Ausgang bei COLLECT/ANY/RULE ORDER/OUTPUT ORDER |
| B2 | Analysierbare Grammatik | **Breit** — Zahlen, Datum und Zeichenketten |
| C | Brücke | **Vorlauf** — baut einmal eine statische `id → Tabelle`-Karte, kein Live-Aufruf |

A2 und B2 gehen bewusst über den kleinstmöglichen Umfang hinaus. Was das konkret bedeutet, steht in
den jeweiligen Abschnitten — beide bringen echte Zusatzarbeit mit, A2 sogar eine neue
Netz-Komposition.

## Phase A — Aufzähler (`scripts/scenarios/enumerate.js`)

Baut auf dem vorhandenen Petri-Netz auf: `bpmnToPN(proc)` ist exportiert (`workflow-net.js:493`)
und liefert `{places, transitions, arcs, initialMarking, sinkPlace, …}` inklusive AND-Semantik
(`workflow-net.js:130`). `getEnabledTransitions`, `fireTransition` und `encodeMarking` sind heute
privat (`workflow-net.js:248/260/273`) und müssen exportiert werden.

Der Unterschied zur bestehenden Traversierung: `checkSoundness` schiebt nur das neue Marking in die
Queue (`workflow-net.js:378`) und wirft den Weg weg. Der Aufzähler führt `{marking, trace}` mit und
legt `trace` ab, sobald die Senke erreicht ist. Die Marking-Deduplizierung (`visitedEncodings`,
`workflow-net.js:298/377`) entfällt — richtig für „ist erreichbar?", falsch für „welche Wege führen
dorthin?".

### Zyklen — die Korrektur des ursprünglichen Fehlers

Zwei Dinge, die ein erster Entwurf verwechselt hatte:

**`loopMaximum` ist NICHT die Schranke für Graphzyklen.** Es sitzt unter `Node.loopType`
(`input-schema.json:109-111`) und beschreibt BPMNs `standardLoopCharacteristics` — eine *einzelne
Aktivität*, die sich wiederholt. Eine Rückwärtskante über mehrere Knoten ist etwas anderes; das
`Edge`-Schema hat dafür **kein Feld** (`input-schema.json:182-196`). Empirisch bestätigt:
`simple-approval.json` (`f5: task3→task1`) und `bpmn-generator-pipeline.json` (`fu6`, `fo10`) haben
Zyklen ohne jedes `loopType`; das einzige Fixture mit `loopType` ist azyklisch.

**`sortNodesTopologically` erkennt keine Zyklen.** Es ist ein BFS, das bei besuchten Knoten
`continue`t (`topology.js:62`), nichts zurückgibt und nur `proc.nodes` umsortiert (`topology.js:81`).
Der brauchbare Vorläufer ist `countBackEdges` (`optimize.js:200-218`) — DFS mit On-Stack-Färbung,
liefert aber nur eine Zahl.

Konkret nötig, in dieser Reihenfolge:

1. Rückwärtskanten-**Menge** auf dem Logic-Core-Graphen bestimmen (Technik aus `optimize.js:201-218`
   bzw. D02 in `dmn/rules.js:86-112`, angepasst auf Kanten statt Zähler).
2. Jede solche Kante auf ihre Petri-Netz-Stelle abbilden: `p_${edge.source}_${edge.target}`
   (`workflow-net.js:66`). Zu prüfen ist, ob die Formel über die Umformungen von `bpmnToPN` stabil
   bleibt (XOR-Split → Transition je Zweig, `workflow-net.js:111-122`; impliziter Merge → Transition
   je eingehender Kante, `workflow-net.js:136-165`).
3. Beim Aufzählen einen Zähler je Rückwärtsstelle neben `{marking, trace}` führen und die Ausgabe
   von `getEnabledTransitions` (`workflow-net.js:260-268`) danach filtern.
4. **„Wegen Schranke gesperrt" von „echte Sackgasse" unterscheiden.** Eine gesperrte Transition
   erzeugt einen Zustand ohne Fortsetzung vor der Senke — strukturell identisch zum WF03-Deadlock
   (`workflow-net.js:355-369`). Ohne Unterscheidung meldet die urteilende Schicht (Phase E) jede
   gekappte Schleifenfortsetzung als „unerreichbaren Zweig".

Die Kapp-Regel gehört ausdrücklich in den Entwurf, weil die Prüfzahlen davon abhängen: **Ein Pfad,
der die Schranke überschreiten würde, wird vollständig verworfen** — nicht gekürzt, nicht gemeldet.
Und: Der Zähler ist **je Rückwärtskante**, nicht global; `bpmn-generator-pipeline.json` hat zwei.

### A1 — Verschränkungen: kanonisch

`checkSoundness` erkundet ausdrücklich „all interleavings" (`workflow-net.js:371-380`). Ohne
Marking-Dedup würde **jede Reihenfolge** parallel aktivierter Transitionen ein eigener Pfad —
multinomial viele, die alle dasselbe Szenario in anderer Schreibweise sind.

**Entschieden: eine kanonische Reihenfolge je Parallelblock**, die Zahl der möglichen
Verschränkungen wird als Zahl mitgeführt. Das verliert keine Deckung — sämtliche
Entscheidungskombinationen bleiben vollständig erhalten —, sondern nur Redundanz. Die Reihenfolge
muss deterministisch sein (etwa nach Transitions-Id), damit die Ausgabe reproduzierbar bleibt.

Umsetzung: Sind mehrere Transitionen gleichzeitig aktiviert und **nebenläufig** (keine teilt eine
Eingangsstelle mit einer anderen), wird nur eine feste Reihenfolge verfolgt statt aller. Bei
konkurrierenden Transitionen (gemeinsame Eingangsstelle = XOR-Wahl) wird weiterhin voll verzweigt —
das ist gerade die Entscheidungsinformation.

Kein Fixture hat ein `parallelGateway`; für den Prüfschritt muss eines gebaut werden.

Wichtig für die Erwartungshaltung: Verdichtung hilft **nicht** gegen viele unabhängige
XOR-Entscheidungen — dort ist die Gruppenzahl gleich der Szenarienzahl (10 binäre Gateways = 1024
Szenarien *und* 1024 Gruppen). Dagegen hilft nur die Obergrenze.

### A2 — Mehrere Pools: Message Flows als Synchronisation

`bpmnToPN` liest `messageFlows` nirgends, und `checkWorkflowNetSoundness` baut je Pool ein eigenes
Netz (`workflow-net.js:471-479`). Poolübergreifende Abhängigkeiten sind heute also unsichtbar — auch
poolübergreifende Verklemmungen, die eine reale Fehlerklasse sind.

**Entschieden: ein gemeinsames Netz über alle Pools.** Wichtig ist der nicht-invasive Weg:

- `bpmnToPN(pool)` bleibt **unverändert** und wird je Pool aufgerufen. Eine Erweiterung *in* dieser
  Funktion würde das Verhalten von WF01–WF03 für Kollaborationen ändern und bestehende Erwartungen
  kippen.
- Die Komposition passiert in `scripts/scenarios/`: je Message Flow **eine zusätzliche Stelle**
  zwischen der sendenden und der empfangenden Transition. Das ist die übliche Petri-Kodierung für
  asynchrone Nachrichten — der Sender feuert und läuft weiter, der Empfänger blockiert, bis ein
  Token liegt.

Zwei Punkte, die dabei zu klären sind und in der Umsetzung gemessen werden müssen:

- **Transitionen finden.** Die Kodierung muss die zu einem Knoten gehörende Transition im Teilnetz
  identifizieren. `bpmnToPN` erzeugt bei XOR-Splits je Zweig eine Transition
  (`workflow-net.js:111-122`) und bei implizitem Merge je eingehender Kante
  (`workflow-net.js:136-165`) — die Zuordnung Knoten → Transition ist also nicht immer 1:1.
- **Black-Box-Teilnehmer.** Ein eingeklappter Pool hat keinen inneren Prozess, also auf seiner Seite
  keine Transition. Vorschlag: als Umgebung behandeln, die jederzeit annimmt und liefert — sonst
  verklemmt jedes Modell mit Black Box künstlich. Ist beim Bau zu bestätigen.

**Grenzen** gehören nach `config.json` in einen `scenarios`-Block, nicht in den Code
(CLAUDE.md:418). Erreichte Grenzen werden **explizit als abgeschnitten markiert**.

## Phase B — Entscheidungstabellen (`scripts/scenarios/decision-table.js`)

Unabhängig von A, und das riskanteste Stück: Es gibt im Repo keinerlei FEEL-Verarbeitung, auf der
man aufbauen könnte. Der Kopfkommentar `dmn/rules.js:10-13` hat das schon vermerkt —
Vollständigkeits- und Überschneidungsanalyse *„need interval algebra over the input domains and are
their own piece of work"*. Dieses Vorhaben nimmt bewusst zurückgestellte Arbeit auf.

### B1 — Verzweigung: policy-genau abgestuft

Logic-Core liefert dem Business Rule Task nur `decisionRef` (`input-schema.json:138`), nie
Eingabewerte. Die Zweige sind daher **hypothetisch/symbolisch** („falls die Eingaben in diesen
Bereich fielen"), nicht gegen den vorgelagerten Prozess geprüft. Es gibt keine gemeinsame
Darstellung, die ein Gateway-Label mit einem DMN-Eingabeausdruck verbindet; unmögliche Kombinationen
(Zweig „Großauftrag" + Regel `< 100`) bleiben unerkannt. **Das muss am Ergebnis dranstehen.**

**Entschieden: die Verzweigungsregel richtet sich nach der Hit-Policy**
(`decision-core-schema.json:111` kennt sieben):

| Policy | Verzweigung | Genauigkeit |
|---|---|---|
| `UNIQUE` | ein Zweig je Regel | exakt — Überlappung ist hier verboten |
| `FIRST`, `PRIORITY` | ein Zweig je Regel, **als Überschätzung markiert** | Überlappung ist erlaubt; eine dominierte Zeile gewinnt für keine Eingabe je |
| `COLLECT`, `ANY`, `RULE ORDER`, `OUTPUT ORDER` | **kein** Zweig je Regel, sondern ein aggregierter Ausgang | mehrere Regeln treffen gleichzeitig zu (D08/D09); sie als sich ausschließend darzustellen wäre ein Kategorienfehler |

Für die dritte Gruppe entfällt die Verzweigung, die Lücken- und Überschneidungsbefunde bleiben.

### B2 — Grammatik: Zahlen, Datum und Zeichenketten

`when` ist laut `decision-core-schema.json:172` freier Text („Text, not parsed"), es gibt im Repo
keinerlei FEEL-Verarbeitung. Die Grammatik ist daher neu zu bauen. **Entschieden: breit** —
Zahlvergleiche, Intervalle, Datum und Zeichenketten.

Zu unterstützen:

- Vergleiche `<`, `<=`, `>`, `>=`, `=` mit Zahl, Datum (`date("2020-01-01")`) oder Zeichenkette
- Intervalle `[a..b]`, `[a..b)`, `(a..b]`, `(a..b)` über Zahlen und Datum
- Aufzählungen (`"Gold","Silber"`)
- `-` als Platzhalter „beliebig"

Festzulegende Mehrdeutigkeiten, sonst rät der Implementierende: Ist `-` allein der Platzhalter oder
ein negatives Vorzeichen (gleiches Zeichen, beides gültig)? Meint blankes `100` ein `= 100`?

**Eine nicht parsebare Spalte macht die ganze Regel nicht analysierbar** — nicht spaltenweise
prüfen. Spaltenweise wäre unsicher statt bloß konservativ: Es meldete Lücken, die eine verborgene
Bedingung in der ignorierten Spalte in Wahrheit ausschließt.

**Die entscheidende Asymmetrie bei Zeichenketten:** Überschneidungen sind immer prüfbar (zwei Regeln
treffen beide `"Gold"`). **Lücken sind es nur bei deklarierter Domäne** — über `allowedValues` an
der Ein-/Ausgabespalte (`decision-core-schema.json:147/158`) oder `allowedAnswers` an der
Entscheidung (`:50`). Ohne diese Angabe ist der Wertebereich unbegrenzt, und niemand kann wissen, ob
„Platin" fehlt. Fehlt sie, wird für diese Spalte **keine Lückenaussage** getroffen — die
Überschneidungsprüfung läuft weiter. Bei Zahlen und Datum sind Lücken dagegen auch ohne
`allowedValues` berechenbar (geordnete Domäne), `allowedValues` verengt dort nur die Ränder.

Alles außerhalb der Grammatik wird als **„nicht analysierbar" ausgewiesen**, nie geraten.

## Phase C — Brücke (`scripts/scenarios/bridge.js`)

Beide Richtungen existieren als Daten, nur der Auflöser fehlt:

- BPMN → DMN: `node.decisionRef` = Id der Entscheidung, serialisiert in `extensionElements`
  (`bpmn-xml.js:290-294`), von beiden Importern gelesen, im Feld-Fidelity-Test abgesichert.
- DMN → BPMN: `usingTask` am Decision-Knoten, OMG-Richtung `tDecision/usingTask`
  (`dmn-xml.js:188`).

Der Auflöser bekommt Logic-Core **und** eine Menge Decision-Cores; ein Logic-Core allein enthält die
Entscheidungen nicht. Ein `decisionRef` ohne auflösbare Entscheidung ist ein benannter Befund.

**Entschieden: die Brücke ist ein Vorlauf**, der einmal eine statische `id → Tabelle`-Karte baut,
kein Live-Aufruf beim Feuern. Damit bleibt `enumerate.js` frei von DMN-Wissen und einzeln testbar;
ein Live-Aufruf würde die drei Phasen aneinanderketten, ohne etwas zu gewinnen.

## Phase D — Darstellung (`scripts/scenarios/format.js`)

Zwei Verbraucher, zwei Sichten auf dieselben Daten:

- **Maschinell (JSON): vollständig.** Ein LLM prüft auch 4.000 Szenarien mühelos; dort ist
  Vollständigkeit der Zweck, nicht Ballast.
- **Menschlich (Markdown): verdichtet.** Gruppiert nach Entscheidungskombination, parallele
  Verschränkungen eingeklappt und nur gezählt.

Sortiert **um den Happy Path**: Hauptweg oben, Abweichungen nach Abstand. `isHappyPath` ist ein
deklariertes Kantenfeld (`input-schema.json:191`) und steuert schon ELK-Priorität (`layout.js:264`),
Sortierung (`topology.js:67`) und DOT-Einfärbung; `identifyHappyPathNodes` (`topology.js:241`)
existiert. Diagramm und Liste sind dann per Konstruktion einer Meinung.

Das Feld ist optional (`topology.js:243` gibt eine leere Menge zurück). Ohne Markierung als Ersatz
der kürzeste Pfad ohne Boundary-Event und ohne Rückwärtskante — **eine Kürzeste-Wege-Suche, die es
in `topology.js` heute nicht gibt** und die mitgebaut werden muss. Die Ausgabe weist aus, dass der
Hauptweg *abgeleitet* und nicht deklariert wurde.

Festzulegen: ob der Gruppierungsschlüssel DMN-Regelwahlen einschließt oder nur BPMN-Gateways; wie
ein Szenario zählt, das ein Happy-Path-Gateway gar nicht durchläuft; die Tie-Break-Regel bei
gleichem Abstand (nötig für die deterministische Reihenfolge, die Prüfschritt 8 unterstellt).

## Phase E — Urteilende Schicht

Eigene Datei, nach dem Vorbild `workflow-net.js` rechnet / WF01–WF03 urteilen. Meldet **nur**
objektiv Falsches: ein Zweig, den kein Szenario erreicht (nach Abzug der Schranken-Sperrungen,
siehe A.4); ein `decisionRef` ohne Entscheidung; eine Tabellenlücke; eine Überschneidung bei
`UNIQUE`. Alles Übrige bleibt Ausgabe ohne Urteil. Braucht ein eigenes Regel-Id-Präfix — `D` und
die BPMN-Präfixe sind vergeben.

## Phase F — Einstiegspunkt

Ohne diese Phase ist das Ergebnis eine Bibliothek, die niemand aufruft. Festzulegen: CLI-Flag,
HTTP-Route, MCP-Tool — mindestens eines davon, mit Auswirkung auf `references/api-schema.json` und
den Docs-Gate-Vertragstest.

## Dateien

| Datei | Phase | Rolle |
|---|---|---|
| `scripts/scenarios/enumerate.js` | A | Pfadaufzählung, Zyklusschranken |
| `scripts/scenarios/decision-table.js` | B | Tabellenausgänge, Lücken, Überschneidungen |
| `scripts/scenarios/bridge.js` | C | `decisionRef`/`usingTask` auflösen |
| `scripts/scenarios/format.js` | D | Gruppierung, Sortierung um den Happy Path |
| `scripts/scenarios/rules.js` | E | Urteilende Schicht |
| `scripts/bpmn/workflow-net.js` | A | **Änderung:** drei Feuerungs-Primitive exportieren |
| `scripts/config.json` | A | **Änderung:** `scenarios`-Block (Schranken) |

Wiederverwendet: `bpmnToPN` (`workflow-net.js:493`), die Rückwärtskanten-Technik aus
`optimize.js:200-218`, `identifyHappyPathNodes`/`resolveLaneId` (`topology.js`), `requirementKey`
(`dmn/coordinates.js:54`).

## Verifikation

1. **Von Hand nachgerechnet, mit ausgeschriebener Regel.** `simple-approval.json` (XOR `gw1`,
   Rückwärtskante `f5`): Schranke 0 → genau **1** Szenario (der „Nein"-Zweig endet in `task3`, dessen
   einziger Ausgang die gesperrte Kante ist). Schranke 1 → genau **2**. Gilt nur unter der Regel
   „überschreitende Pfade werden verworfen" — deshalb steht sie im Entwurf.
2. **Zähler je Kante, nicht global.** `bpmn-generator-pipeline.json` hat zwei Zyklen (`fu6`, `fo10`);
   die Zahl muss dem Produkt entsprechen, nicht einer gemeinsamen Schranke. Erwartung bei Schranke 1:
   Pool_User 2, Pool_Generator 8.
3. **Aktivitäts-Schleifenmarker ≠ Zyklus.** `subprocess-child-fidelity.json` (`c_loop`,
   `loopType: "standard"`, azyklisch) darf **keine** zusätzlichen Pfade erzeugen — Regressionstest
   gegen genau die Verwechslung, die dieser Entwurf zuerst enthielt.
4. **Gesperrt ≠ Sackgasse.** Ein gekappter Schleifenpfad darf in Phase E **nicht** als
   unerreichbarer Zweig gemeldet werden.
5. **Verschränkungen kanonisch.** Neues Fixture mit `parallelGateway` (es existiert keines): drei
   parallele Aufgaben ergeben **ein** Szenario mit der Angabe „6 mögliche Reihenfolgen", nicht sechs
   Szenarien. Die gewählte Reihenfolge muss über Läufe hinweg identisch sein.
6. **Poolübergreifende Synchronisation.** `realistic-collaboration.json` (5 Pools, 8 Message Flows):
   Ein Szenario muss die Reihenfolge über Poolgrenzen hinweg abbilden — eine empfangende Aufgabe
   darf nie vor der zugehörigen sendenden erscheinen. Gegenprobe: `bpmnToPN` bleibt unverändert,
   also müssen die WF01–WF03-Ergebnisse aller bestehenden Fixtures **exakt gleich bleiben**.
7. **Black-Box-Teilnehmer verklemmen nicht.** `realistic-collaboration.json` enthält einen
   eingeklappten Pool; Modelle mit Black Box müssen Szenarien liefern, nicht künstlich blockieren.
8. **Hit-Policies, alle drei Gruppen.** Je ein Fixture mit `UNIQUE` (vorhanden), `FIRST` (Zweige als
   Überschätzung markiert) und `COLLECT` (**kein** Zweig je Regel, aggregierter Ausgang).
9. **Tabellenanalyse über alle drei Typen.** Zahlen: `discount-decision.json`
   (`< 100`, `[100..500)`, `>= 500`) ist lückenlos, eine Variante ohne die mittlere Regel muss
   `[100..500)` melden. Datum: analoge Intervallprüfung. Zeichenketten: mit `allowedValues` wird
   eine fehlende Ausprägung als Lücke gemeldet, **ohne** `allowedValues` wird für diese Spalte
   keine Lückenaussage getroffen — die Überschneidungsprüfung läuft weiter.
10. **Nicht analysierbar bleibt nicht analysierbar.** Eine Regel mit einer freien FEEL-Spalte neben
    einfachen Spalten wird als Ganzes ausgeschlossen, nicht spaltenweise geprüft.
11. **Fremde Modelle.** `references/review-set/` enthält 14 Modelle der BPMN Model Interchange
    Working Group (`all_gateway_types`, `pools`, `pizza-collaboration`, …), über `import.js` nach
    Logic-Core gewandelt. Für jedes eine Antwort: Szenarien **oder** ein benannter Grund. Prüfbar ist
    „kein Absturz und ein Ergebnisobjekt je Modell" — mehr behauptet dieser Schritt nicht.
12. **Abbruch sichtbar.** Mit künstlich kleiner Schranke im Test; die echten Fixtures liegen mit
    ~6–10 Szenarien weit unter jeder sinnvollen Obergrenze.
13. **Sortierung, beide Fälle.** Mit und ohne `isHappyPath`-Markierung dieselbe Reihenfolge; im
    zweiten Fall der Hinweis, dass der Hauptweg abgeleitet ist.
14. `cd scripts && npm test` grün, `npm run docs-gate` 0 Verstöße.

## Bewusst nicht in diesem Vorhaben

- **Bewertung fachlicher Richtigkeit.** Wir zählen auf, wir urteilen nicht.
- **Ground-Truth-Korpus, Precision/Recall.** Bleibt offen (in `ROADMAP.md` vermerkt); dieser Entwurf
  ersetzt ihn nicht, macht ihn aber teilweise entbehrlich.
- **Layout-Feedback-Schleife.** Separates Thema.
- **Abgleich von Gateway-Bedingungen mit DMN-Eingaben.** Es gibt keine gemeinsame Darstellung;
  unmögliche Kombinationen bleiben unerkannt und werden als solche ausgewiesen.

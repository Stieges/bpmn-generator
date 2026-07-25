# Fallbeispiel: Anforderungs-Skill außerhalb seines Heimat-Kontexts

**Datum:** 2026-07-24
**Gegenstand:** Anwendung eines Anforderungsaufnahme-Skills (Orchestrator + Denkrahmen) auf ein
technisches Vorhaben in einem fremden Repository
**Ergebnis:** [2026-07-24_soll-redesign-agent.md](2026-07-24_soll-redesign-agent.md) — Reifegrad
`formalized`

> Der Skill stammt aus einem anderen Projekt (Versicherungs-/Fachdomäne, eigene Wissensdatenbank,
> Jira-Anbindung). Angewandt wurde er hier auf ein Software-Vorhaben in einem öffentlichen MIT-Repo.
> Dieses Dokument hält fest, **was unverändert trug**, **was adaptiert werden musste** und **was sich am
> Skill verbessern lässt**.

---

## 1 Was der Skill konkret gefunden hat

Der belastbarste Teil dieses Berichts: nicht die Theorie, sondern die Treffer. Alle vier hätte ein
normales Review nicht zutage gefördert, weil sie an Stellen lagen, die plausibel aussahen.

| # | Fund | Wodurch gefunden |
|---|---|---|
| 1 | **Eine Begründung war schlicht falsch.** Die Migrations-Empfehlung stützte sich auf „das Feld hat praktisch keine Nutzer" — tatsächlich existierten **sechs Konsumenten** (CLI-Ausgabe, fünf Tests, MCP-Antwort, HTTP-Doku). Die Umsetzung hätte CLI, MCP und Testsuite gleichzeitig gebrochen. | GATE 2a (Vollständigkeits-Kritiker) |
| 2 | **Eine Zusage war nicht entscheidbar.** „Fehler rollen zurück, Warnungen nicht" ist profilabhängig: die Deadlock-Prüfung ist im Standardprofil **aus**, im strengen Profil werden Stil-Regeln zu Fehlern. Damit war auch die Determinismus-Zusage verletzt. | GATE 2a |
| 3 | **Das freigegebene Erfolgskriterium hatte kein Kriterium.** „Verändert nur das Beabsichtigte" war zugesagt, aber durch kein einziges Szenario geprüft — genau dort entstehen stille Regressionen. | GATE 2a |
| 4 | **Zwei Bestandteile waren erfunden.** Durchlaufzeit-Berechnung und gewichtete Bewertung waren im Umfang, obwohl das Datenmodell keine Dauern trägt und Gewichte der Zielsetzung angehören — die der Scheibe ausdrücklich fehlt. | Necessity-Prüfung („nötig oder erfunden?") |

Dazu kam ein Fund aus der **Negations-Achse**, der die Schnittstelle verändert hat: Die Frage „was
passiert bei Teil-Erfüllung?" führte zur Entscheidung „der Aufrufer entscheidet" — und damit zur
Trennung jedes Eingriffs in `prüfen` und `anwenden`. Diese Vorschau-Fähigkeit war in einer früheren
Frage **explizit verworfen** worden und kam über die Methodik doch herein.

---

## 2 Was unverändert trug

Diese Elemente funktionierten ohne jede Anpassung — sie sind offenbar domänenunabhängig:

- **Split-Gate.** Das Vorhaben spannte mehrere Abstraktionsebenen. Der erzwungene Split in fünf Scheiben
  und die Wahl **einer** verhinderte den Sammel-Record, in dem alles halb spezifiziert ist.
- **Parken mit Trigger und Owner.** Nicht gewählte Scheiben verschwinden nicht und werden auch nicht
  stillschweigend mitgeplant — sie bekommen eine Aufgriffsbedingung. Auf die Frage „was passiert mit den
  Scheiben, die wir nicht wählen?" hatte die Methodik bereits eine Antwort.
- **Opt-Out-Zwang statt stillem Weglassen.** Jede Säule braucht Befund **oder** Begründung. Der einzige
  Opt-Out in diesem Record (Timeout) wurde vom Kritiker prompt als **zur Hälfte begründet** entlarvt —
  er deckte Warten ab, nicht Laufzeit.
- **Negations-Achse.** Siehe oben — sie hat die Schnittstelle verändert, nicht nur Testfälle ergänzt.
- **Statusspalte `Verifiziert | Hypothese | Nicht gefunden | Widerspruch`.** Sie machte den Abbruch der
  Recherche folgenlos für die Ehrlichkeit des Dokuments: unbelegte Behauptungen wurden herabgestuft
  statt versteckt.
- **Lern-Spur.** Der Zustand wird überschrieben, der Vorgang bleibt. Alle Korrekturen und Demotionen
  sind per `grep` auditierbar, statt aus dem Fließtext rekonstruiert werden zu müssen.
- **Zwei getrennte Gates.** GATE 1 (menschliche Freigabe der Begründung) und GATE 2 (adversariale
  Prüfung) haben unterschiedliche Dinge gefunden — sie sind nicht redundant.

---

## 3 Was adaptiert werden musste

| Element | Im Heimat-Kontext | Hier | Bewertung |
|---|---|---|---|
| **Recherche-Backend** | Eigene Wissensdatenbank über spezifische Werkzeuge, plus verpflichtende Rückmeldung an das System | Web- und Literatursuche | **Harte Kopplung** — der einzige Teil, der die Anwendung blockierte |
| **Compliance-Säule** | Versicherungsaufsicht, Datenschutz, Gesundheitsdaten | Datenabfluss (läuft es ohne Sprachmodell?), Lizenz, Herkunft der Verfahren | **Trug trotzdem** — die Säule war nicht leer, nur anders gefüllt |
| **Herkunftsschutz** | Interne Quellen sind normal | Öffentliches Repo — interne Projektnamen dürfen nicht hinein | **Neu** — im Skill nicht vorgesehen |
| **Übergabe** | An Story-/Feature-Erstellung | An einen Implementierungsplan | Trivial ersetzbar |
| **Record-Ort** | Arbeitsverzeichnis des Wissenssystems | `docs/anforderungen/` im Repo | Trivial |
| **GATE-2-Ausführung** | Subagenten | Subagenten (unverändert übernommen) | Kein Anpassungsbedarf |

**Nicht adaptiert, sondern weggelassen:** die Rückmeldung an das Lernsystem und die Pflicht-Kategorien
für Rechtsquellen. Beides existiert hier nicht.

---

## 4 Optimierungsvorschläge

### 4.1 Recherche als eigener Sub-Skill herauslösen (wichtigster Punkt)

**Befund:** Der Abschnitt „Recherche & Subagenten" ist der **einzige** Teil des Orchestrators, der die
Anwendung außerhalb des Heimat-Kontexts blockiert hat. Er verwebt drei Dinge, die getrennt gehören:

1. **Eskalationslogik** — Einzel-Nachschlag → breiter Fächer → Tiefenrecherche. *Allgemeingültig.*
2. **Findings-Contract** — jeder Befund trägt `claim`, `status`, `quelle`, `snippet`; ohne Quelle
   höchstens `Hypothese`. *Allgemeingültig und der eigentliche Wert.*
3. **Backend** — konkrete Werkzeugnamen, Rückmeldepflicht, Aufgabentyp-Konfiguration.
   *Projektspezifisch.*

**Vorschlag:** Punkte 1 und 2 werden ein Sub-Skill (analog zum Denkrahmen als „REQUIRED SUB-SKILL"), der
das Backend als **austauschbar** deklariert — Wissensdatenbank, Websuche, Literatursuche oder
Code-Inspektion, je nach Projekt. Der Orchestrator referenziert ihn dann nur noch, statt ihn zu
enthalten.

**Erwarteter Nutzen:** Der Skill wird ohne Anpassung in beliebigen Projekten anwendbar. Der
Findings-Contract — der die Belegtheit überhaupt erst prüfbar macht — wird wiederverwendbar, statt in
einem Orchestrator zu stecken.

### 4.2 Der Grounding-Kritiker braucht eine explizite Zirkularitätsregel

**Befund:** Die wirksamste Frage des Prüfers stand nicht im Skill, sondern musste ihm im Auftrag
mitgegeben werden: *Ist die Quelle von der richtigen **Art**?* Eine Aussage darüber, **was wir
entschieden haben**, darf sich auf die Sitzung stützen. Eine Aussage über **die Welt** („diese Regel ist
optimal") kann sich **nicht** auf unser eigenes Design-Dokument stützen — das ist zirkulär. Genau daran
hingen hier drei von vier Demotionen.

**Vorschlag:** Diese Unterscheidung als Prüfregel in den Skill aufnehmen: *Entscheidungs-Aussagen dürfen
sitzungsgegründet sein; Welt-Aussagen brauchen eine externe Quelle — das eigene Konzept zählt nie.*

### 4.3 Zeitliche Behauptungen sind Fakten, keine Einschätzungen

**Befund:** „Das Feld ist einen Tag alt" wurde ungeprüft aus dem Konzept übernommen. Tatsächlich waren es
Stunden — nachweisbar über den Merge-Zeitstempel.

**Vorschlag:** Der Grounding-Pass sollte quantitative Behauptungen (Alter, Anzahl, „keine Nutzer")
ausdrücklich als prüfpflichtig führen. Sie wirken wie Kontext, sind aber die Sorte Behauptung, auf die
Entscheidungen gestützt werden.

### 4.4 Die Prüf-Sicht braucht eine Ableitungspflicht

**Befund:** Der Kopf des Records widersprach seinem eigenen Körper (behauptete „0 Szenarien", während
sieben darin standen; „0 Hypothese", während drei deklariert waren). Der Skill verlangt Pflege bei jedem
Reifegrad-Übergang — das genügte nicht, weil innerhalb einer Phase viel entsteht.

**Vorschlag:** Die Prüf-Sicht **unmittelbar vor GATE 2** neu aus dem Körper ableiten, verpflichtend. Sie
ist die Sicht, auf die der Prüfer zuerst schaut; ist sie veraltet, prüft er das falsche Dokument.

### 4.5 Kleinere Beobachtungen

- **Der Denkrahmen als Pflicht-Sub-Skill funktioniert.** Die Trennung Methodik/Prozess hat sich bewährt —
  dasselbe Muster spricht für 4.1.
- **„Eine Frage zur Zeit" kollidiert mit Ungeduld.** Nach etwa zehn Fragen kam berechtigterweise
  „reicht es nicht langsam". Ein Hinweis, wann man Befunde **entwerfen und zur Korrektur vorlegen** darf,
  statt sie zu erfragen, würde die Methodik verträglicher machen — hier hat sich das Vorlegen von
  Entwürfen mit gezielter Rückfrage bei echten Weichen bewährt.
- **Abbruch ist vorgesehen und das ist gut.** Der Abbruch der Recherche hat den Record nicht entwertet,
  weil die Statusspalte den Preis sichtbar macht: aus `Verifiziert` wird `Hypothese`, geparkt mit
  Trigger. Diese Eigenschaft sollte im Skill ausdrücklich benannt werden — sie ist ein Verkaufsargument,
  kein Notbehelf.

---

## 5 Kosten und Nutzen, nüchtern

**Kosten:** rund zwei Dutzend Interaktionen, zwei Recherche-Agenten (abgebrochen), zwei Kritiker-Agenten,
ein Record von ~290 Zeilen.

**Nutzen:** vier Fehler gefunden, von denen mindestens einer (die falsche Migrations-Prämisse) in der
Umsetzung CLI, MCP-Schnittstelle und Testsuite gleichzeitig gebrochen hätte — mit einer Begründung im
Dokument, die den Umsetzenden in Sicherheit gewiegt hätte. Dazu eine Schnittstellenänderung
(`prüfen`/`anwenden`), die ohne die Negations-Achse nicht aufgefallen wäre.

**Einschätzung:** Für eine Konzeption dieser Größe hat sich der Aufwand gelohnt. Für ein kleines Ticket
wäre er unverhältnismäßig — der Skill sieht dafür ausdrücklich eine verschlankte Tiefe vor, was die
richtige Antwort ist.

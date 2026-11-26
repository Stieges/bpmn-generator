# Modelling guide: what to build, and how

Load this when the user's description leaves a modelling choice open — pools vs. lanes, how to show
an IT system, or which BPMN construct fits a situation. The short version lives in `SKILL.md`
("Advise the user"); this file is the full table.

## Contents

- [How to advise](#how-to-advise)
- [Pools, lanes, roles and systems](#pools-lanes-roles-and-systems)
- [Which construct when](#which-construct-when)
- [Naming conventions per language](#naming-conventions-per-language)

## How to advise

Do not just transcribe the text — advise. When the description leaves a modelling choice open,
propose the construct below that fits, say in one line why, and **ask what the diagram is for**
when that decides the choice: a **business** view (who does what, in what order), an
**IT/integration** view (which systems exchange what), or an **audit/compliance** view (who is
responsible, where the evidence is). Each line names the rule that warns when the choice is made
wrongly, where one exists (S = soundness, M = style, P = pragmatics, WF = workflow-net, opt-in;
SC = scenario pipeline, which checks a `decisionRef` against DMN files; see
`references/fachliches-regelwerk.md`).

## Pools, lanes, roles and systems

- **Pools are participants** — organisations or independent parties. Draw **one expanded pool** for
  the process in scope and a **collapsed pool** (`collapsedPools`) for each external party
  (customer, supplier, authority) whose inside is not in scope. Pools talk only through message
  flows, never sequence flows (S09).
- **Lanes are roles or departments** inside one pool: functional names, never people ("Claims
  handler", not "Ms Miller"), **at most 25 characters** (M10). Add lanes only when the text names
  distinct roles; assign nodes with `node.lane` (M09 warns on `lane.nodeIds` alone).
- **IT systems — pick the picture by purpose:**
  - *Business view:* the system is an attribute of the step, not a participant. Use a `serviceTask`
    for an automated step and a `userTask` for a person working in a system; put the system's name
    in the task name or its `documentation` where it matters.
  - *Automated steps at a glance (Signavio style):* a **system lane** per system holding its
    `serviceTask`s. This is a reading convention — a lane formally means responsibility — so say so
    when the diagram is shared.
  - *Interface view:* the system as a **collapsed pool**, connected by message flows from
    `sendTask`/`receiveTask` or message events (S10, S12, S14 police the endpoints).
  - *The system's own flow matters* (an integration you are specifying too): an **expanded pool**
    with its own process, connected by message flows only.
- If the text does not say which view is wanted, **ask** before choosing. Runnable examples of all
  four pictures live in a repository checkout under `docs/roles-and-systems.md` (not part of the
  skill bundle).
- The Logic-Core also has `role` and `system` fields on activities; **do not fill them during
  extraction yet** — they change nothing in the drawing until the planned role/system views exist.

## Which construct when

| Choice | Use … when … | Not when … | Warns |
|---|---|---|---|
| Single process vs. collaboration | one `process` (with lanes) when one organisation does the work; `pools` + `messageFlows` when two or more independent participants exchange messages | a "participant" is just another department — that is a lane | S09, M10 |
| Expanded subprocess | `subProcess` with `isExpanded: true` when the inner steps are part of the story and the level stays readable | the parent level would exceed 7–10 nodes — collapse it | S11, P01 |
| Collapsed subprocess | `subProcess` (collapsed) to hide a group of more than 3 logical steps behind one name | the steps are the point of the diagram | S11 |
| Call activity | `callActivity` + `calledElement` when the called process is reusable and maintained on its own | the steps belong only to this process — use a subprocess | S15 |
| Event subprocess | `subProcess` + `isEventSubProcess: true` when something can happen at any time inside a scope (error, cancellation, a status request); its start event interrupts the scope unless it carries `isInterrupting: false` | it is tied to one activity — use a boundary event | S11, S15 |
| Transaction | `transaction` when the steps commit or cancel as a unit | ordinary grouping — use a subprocess | — |
| Exclusive gateway (XOR) | exactly one path: name the split as a question, label every outgoing flow, mark one `isDefault` | several paths can be taken together | M02, M04, M08 |
| Inclusive gateway (OR) | one **or more** paths, decided by conditions | the paths exclude each other — XOR reads more clearly | M07 |
| Parallel gateway (AND) | all paths run, no condition; leave it unnamed | any branch is conditional | S05, S06 |
| Event-based gateway | the process waits and the **first event** to arrive decides (reply vs. timeout); follow it with catch events or receive tasks | the decision rests on data already known — use XOR | — |
| Split/join pairing | close every split with a join of the **same type** (`has_join: true`), unless the branches end in separate end events; no implicit merges, no XOR split into an AND join | — | S05, S06, WF02, WF03 |
| Boundary event, interrupting | the activity is **abandoned** when it fires (deadline missed, error); `cancelActivity` omitted or `true` | the activity should go on | S08, S13 |
| Boundary event, non-interrupting | something extra starts **while** the activity continues (reminder); `cancelActivity: false` | the activity must stop | S08, S13 |
| Gateway after a task | the task produces a **normal business outcome** (approved/rejected) | the outcome is an exception that cancels the work — use a boundary event | M02, M04 |
| Error end + error boundary | an error inside a subprocess ends it: `endEvent` with `marker: "error"` inside, an error `boundaryEvent` on the subprocess; reference one `definitions` entry via `errorRef` when there are several | a plain alternative outcome — use a gateway | S13, S16, S17 |
| Timer start event | the process starts on a schedule ("every Monday") | something else triggers it | — |
| Intermediate timer | the flow waits a fixed time ("wait 3 days") | the wait is a deadline on an activity — use a boundary timer | — |
| Boundary timer | a deadline on one activity (interrupting: escalate; non-interrupting: remind) | — | S08, S13 |
| Message events | waiting for or sending a message **is** the step (`intermediateCatchEvent`/`intermediateThrowEvent`, message start/end) | the sending or receiving is work in its own right | S10, S12, S14, S17 |
| Send/receive task | sending or receiving is work someone or something does — a step worth a name and a lane | it is a pure wait — use a message event | S10, S12 |
| Loop marker | one activity repeats until done (`loopType: "standard"`) | several steps repeat — that is a rework loop | S15 |
| Rework loop | a gateway sends the flow **back** to an earlier step ("Documents complete?" → No → request again) | only one task repeats — use the loop marker | M02, M04 |
| Multi-instance | the same activity runs once **per item** (`multiInstance: "parallel"` or `"sequential"`) | it repeats until a condition holds — use the loop marker | S15 |
| User / manual task | `userTask`: a person works with IT support; `manualTask`: a person works without IT | — | M01 |
| Service / script task | `serviceTask`: a system does it automatically; `scriptTask`: the engine runs a script | a person is involved | M01 |
| Business rule task | `businessRuleTask` for a decision by rules; `decisionRef` names the DMN decision (see `references/dmn.md`) | the decision is a human judgement — use a userTask and a gateway | M11; SC02, SC03 |
| Data object / data store | `dataObjectReference` for a document or data passed within one case; `dataStoreReference` for storage that outlives the case (database, archive); connect with `associations` | the data is a message between pools — use a message flow | S10 |
| Text annotation | an open question, a source, a deliberate deviation — anything the flow cannot express | the content is a step or a decision | — |
| Level of detail | 7–10 nodes per level; move groups into subprocesses; keep nesting shallow | — | P01, P02, P03 |
| Happy path first | model the main success path end to end (`isHappyPath: true`), then add exceptions | — | — |

If the user's purpose is unclear, ask rather than pick silently — the same text gives a different
diagram for a business reader than for an integration team.

## Naming conventions per language

Set the top-level `language` of the model (`"de"`, `"en"`, `"en-GB"`) to the language of its labels.
The naming rules then judge them by that language's convention; without the field M01 is the
older `Objekt+Verb` heuristic and M05 and M06 report nothing. A word list decides, not a grammar:
a correct label the lists do not know is flagged, and the remedy is `BPMN_NAMING` (see the README,
"Naming languages"), not a rewording. Under `en`, `Invoice customer` is flagged because `invoice` is
no verb in the list; `{ "languages": { "en": { "add": { "verbs": ["invoice"] } } } }` fixes it.
To see why a list exists and what it changes, read the `purpose` and `listNotes` at the top of
`references/naming/<language>.json`; they are documentation only, and the overlay has no such fields.

| Element | Rule | `de` (verb last) | `en` (verb first) |
|---|---|---|---|
| Task | M01 | object, then the infinitive: `Antrag prüfen`, `Paket an Paketdienst übergeben`, `Antrag prüfen und freigeben`. Not: `Prüfen`, `Antrag eingegangen`, `Klärung mit Lieferant`, `Rechnung zu zahlen` (a state, not an instruction) | imperative, then the object: `Review application`, `Hand off case`, `Re-check order`, `E-mail customer`. Not: `Check`, `Checking invoice`, `Invoice checked`, `Invoice is checked`, `The invoice`, `Path A`, `Follow-up` |
| Sub-process, call activity | M01 | a topic, not an instruction or a state: `Kommissionierung`, `Prüfung der Unterlagen`. Not: `Antrag geprüft`, `Prüfen` | a topic: `Claims handling`, `Credit check`, `Onboarding`. Not: `Order received`, `Validate` |
| Gateway | M02 | a question: `Vollständig?` | a question: `Complete?` |
| Event | M06 | a state or occurrence: `Antrag eingegangen`, `Plan aktiv`, `Start`. Not an instruction: `Antrag prüfen` | `Application received`, `7 days elapsed`, `Follow-up`. Not an instruction: `Send invoice` |
| Message flow | M05 | the content, not a state: `Bestellung`, `Rechnung zu zahlen`. Not: `Rechnung gesendet`, `Rechnung senden` | `Request for details`, `Pay slip`, `Deploy request`. Not: `Order received`, `Send invoice` |

Behaviours worth knowing:

- Under `de`, a capitalised single infinitive as a sub-process name is a nominalised verb and
  passes (`Verpacken`, `Versenden`, `Kommissionieren`, `Bezahlen`, `Prüfen`); a lower-case one
  (`prüfen`) reads as a task and is flagged, and so is a state form (`Antrag geprüft`).
- Under `en`, a one-word sub-process or call-activity name is flagged only when it is a listed
  verb that is no noun-verb homograph (`Validate`); `Review`, `Audit`, `Support`, `Order`,
  `Archive` are nouns and pass, and so does an unlisted word. A state form (`Order shipped`) is
  flagged. A placeholder in either language (`Step 3`, `Teil 2`: a word, then only numbers) is
  flagged; a plain noun (`Daten`, `Data`) is not. Under `de` a capitalised one-word participle
  (`Geprüft`) is not recognised (known limit).
- Under `en`, M01 flags a task name only on evidence of a wrong form: one word, nothing with a
  letter after the first word (`Step 3`), a label prefix (`SAP: Review invoice`), two words ending in
  a participle (`Invoice checked`), an auxiliary as second word (`Invoice is checked`), a first word
  that is an article, pronoun, preposition, a frequent noun or a placeholder noun (`The invoice`,
  `Customer data`, `Path A`), or a gerund (`Checking invoice`). A first word that is simply not in the
  verb list passes, even when the object could be a verb (`Queue request`), and the model gets one
  hint `H14` naming up to ten such words (a hyphenated word whole: `'Hot-desk'`); if they are verbs
  nothing is wrong, and adding them to `verbs` through `BPMN_NAMING` silences the hint. A shorter
  verb list gives more hints, never more findings. A hyphenated first word whose last part is a verb
  is a verb (`Quality-check part`). M01 misses wrong names whose first word is a verb too or unknown
  (`Credit check`, `Change request`, `Invoice check`: hint only).
- Under `en`, M05 does not flag a message flow that ends in a message noun (`Deploy request`, `Sell
  order`) for starting with a verb, unless the verb sends or decides on the message (`Send invoice`,
  `Approve order` are flagged).
- German compounds count for the event markers: `Fristablauf` suggests a timer and `Fehlermeldung`
  an error because the name starts with the keyword. Words that only begin like a keyword are
  listed in `compoundExceptions` and give no marker (`Zeitschrift gelesen`, `Zeitung`, `Zeitarbeit`,
  `Signalwirkung`). A word the list misses, and a keyword at the end of a word (`Arbeitszeit`), is
  fixed by setting `marker` on the event yourself: to the symbol you want, or to `"none"` for a
  plain event.
- The marker of an event without `marker` is inferred from its name only where BPMN allows it:
  `Deadline missed` is a timer on a boundary event and nothing on an end event; `Error raised` is
  an error on an end event and nothing on a start event. Error and escalation are never inferred on a
  start event (a start event inside an ordinary sub-process still gets an inferred marker). Every
  inferred marker is reported as hint `H10`; a name that gave a marker before the language was
  declared and now gives none or another one is `H11`. Either way, set `marker` to the symbol you
  want, or to `"none"` for a plain event (start, end and intermediate throw events only; a
  boundary or intermediate catch event needs a trigger, and S15 reports `"none"` there).
  `"none"` also stops the inference without a declared language.
- A valid tag without word lists (`fr`) skips M01, M05 and M06 (hint `H12`); labels that look like
  another supported language than the declared one give hint `H13` (and then no `H14`).

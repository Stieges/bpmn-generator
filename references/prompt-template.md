# Prompt Templates for BPMN Intent Extraction v2.0

These templates are used in the **Intent Extraction Phase** of the pipeline.
Claude uses these to convert unstructured process descriptions into a Logic-Core JSON.

---

## Master Extraction Prompt

Use this prompt when calling the LLM to extract a Logic-Core from user text.
Inject the user's process description at `{{USER_TEXT}}`.

```
You are an expert Business Process Analyst specializing in BPMN 2.0 modeling.
Extract a structured Logic-Core JSON from the process description below.

## Strict Rules

### Node IDs
- snake_case, max 30 chars, descriptive
- Prefixes: task_, gw_ (gateway), start, end_, evt_ (intermediate event), lane_, do_ (data object)

### Node Naming (BA-Quality Standard)
- Tasks: MUST follow "Verb + Substantiv" pattern (e.g. "Antrag prüfen", "Zahlung anweisen")
- XOR Gateways (exclusiveGateway): MUST be a question (e.g. "Antrag gültig?", "Betrag > 1000 EUR?")
- AND/OR Gateways: Empty name ("") or brief label — these are synchronization points, not decisions
- Events: Descriptive noun phrase (e.g. "Antrag eingegangen", "Frist abgelaufen")

### Node Types
- Human action → userTask
- System/automated → serviceTask
- Rule/DMN decision → businessRuleTask
- Script execution → scriptTask
- Send message outward → sendTask
- Receive external message → receiveTask
- Physical/offline work → manualTask
- Decision/branching → exclusiveGateway (XOR), parallelGateway (AND), inclusiveGateway (OR)
- Wait for first event → eventBasedGateway
- Start of process → startEvent
- End of process → endEvent
- Waiting for message/timer → intermediateCatchEvent (set marker: "message"/"timer")
- Sending signal/message → intermediateThrowEvent (set marker)
- Timer/error on task → boundaryEvent (set attachedTo + marker)
- Group of >3 sub-steps → subProcess

### Edges
- Mark the primary success flow ("happy path") edges with "isHappyPath": true
- XOR gateway outgoing edges MUST have labels ("Ja"/"Nein", "genehmigt"/"abgelehnt")
- Default flow (fallback path from gateway): set "isDefault": true
- Every gateway that splits flow MUST have a matching join gateway of the SAME type
  unless the branches lead to different endEvents
- Set "has_join": true on join gateways

### Lanes
- Only add lanes if distinct roles/departments are explicitly mentioned
- Use functional role names, NOT personal names ("Sachbearbeiter" not "Max Müller")

### Multi-Pool (Collaboration)
- If the process involves distinct organizations/participants communicating:
  - Use the "pools" array with separate process for each participant
  - Add "messageFlows" for cross-pool communication
  - Message flows connect sendTask/intermediateThrowEvent → receiveTaks/intermediateCatchEvent

### Boundary Events
- If a task has a deadline/timer → add boundaryEvent with "attachedTo": "<task_id>", "marker": "timer"
- For non-interrupting (task continues): set "cancelActivity": false
- For interrupting (task is cancelled): set "cancelActivity": true (or omit, it's the default)

### Loop / Multi-Instance
- If a task repeats → set "loopType": "standard"
- If multiple instances run in parallel → set "multiInstance": "parallel"
- If multiple instances run sequentially → set "multiInstance": "sequential"

### Structure
- Maximum 10 elements per level — use subProcess to collapse complexity
- Every process path must end at an endEvent
- No isolated nodes

## Output Format
Respond with ONLY valid JSON matching the Logic-Core schema. No explanation, no markdown, no comments.

## Process Description
{{USER_TEXT}}
```

---

## Refinement / Correction Prompt

Use when the Reviewer agent finds issues in the Logic-Core.

```
You are a BPMN expert correcting a Logic-Core JSON.

## Issues found by the Reviewer:
{{ISSUES}}

## Current Logic-Core:
{{CURRENT_JSON}}

Apply ONLY the minimal necessary changes to fix the listed issues.
Do NOT restructure or rename elements that are not involved in the issues.
Preserve all existing IDs.
Respond with ONLY the corrected JSON. No explanation.
```

---

## Amendment Prompt (editing existing diagrams)

```
You are a BPMN expert modifying a Logic-Core JSON.

## Current Logic-Core:
{{CURRENT_JSON}}

## Requested Change:
{{CHANGE_DESCRIPTION}}

Rules:
- Add new elements with unique IDs following existing naming conventions
- Connect new elements with appropriate edges
- Maintain ALL existing IDs and names exactly — do not rename or restructure unaffected elements
- If adding a gateway split, ensure a matching join exists
- Respond with ONLY the complete updated JSON. No explanation.
```

---

## Reviewer Agent Prompt

Use this for the Reviewer role in the 2-agent pipeline.

```
You are a strict BPMN 2.0 quality reviewer following OMG specification rules.
Analyze this Logic-Core JSON and check for:

1. **Deadlocks**: XOR-split path merging at AND-join (impossible to complete)
2. **Missing end events**: Any path that doesn't reach an endEvent
3. **Isolated nodes**: Nodes with no edges
4. **XOR Gateway naming**: All exclusiveGateway nodes must be questions (with "?")
5. **Task naming**: All tasks must follow Verb+Noun convention
6. **Path labels**: All XOR gateway outgoing edges must be labeled
7. **Join-split mismatch**: Every split gateway must have a matching join of same type
8. **Boundary events**: Must have attachedTo referencing an existing task
9. **Message flows**: Must cross pool boundaries (source and target in different pools)
10. **Lane assignment**: Nodes in a lane-based process should all have lane references

For each issue found, output:
- Severity: ERROR or WARNING
- Node/Edge ID affected
- Description of the problem
- Suggested fix

Logic-Core to review:
{{LOGIC_CORE_JSON}}

Respond in this JSON format:
{
  "issues": [
    {
      "severity": "ERROR",
      "elementId": "gw_example",
      "problem": "Description",
      "fix": "Suggested correction"
    }
  ],
  "isValid": true/false
}
```

---

## Method & Style Validation Rules (for Reviewer Agent)

Add these to the Reviewer prompt for full Method & Style compliance:

```
Additional checks (Bruce Silver Method & Style):

8. **Message Flow naming**: Labels must be nouns (the message name), NOT verbs or states.
   BAD: "Bestellung senden" (verb), "Bestellt" (state)
   GOOD: "Bestellung", "Auftragsbestätigung", "Lieferschein"
9. **Merge gateways**: MUST NOT have labels. Only split gateways get labels.
10. **AND/OR gateways**: Should NOT have question labels (only XOR gets questions).
11. **One expanded pool**: If modeling collaboration, recommend one expanded pool + collapsed pools for external participants.
12. **Default flow**: Every XOR gateway with >2 outgoing edges should have exactly one default flow (isDefault: true).
13. **Collapsed pool pattern**: External participants (customers, suppliers, authorities) should be collapsed pools unless their internal process is in scope.
```

---

## Few-Shot Examples for Complex Patterns

### Boundary Timer Event Example

User text: "Der Sachbearbeiter bearbeitet den Antrag. Wenn die Bearbeitung länger als 5 Tage dauert, wird eine Eskalation an den Teamleiter ausgelöst."

Expected Logic-Core fragment:
```json
{
  "nodes": [
    { "id": "task_bearbeiten", "type": "userTask", "name": "Antrag bearbeiten", "lane": "lane_sb" },
    { "id": "timer_frist", "type": "boundaryEvent", "name": "5 Tage Frist", "marker": "timer", "attachedTo": "task_bearbeiten", "cancelActivity": false },
    { "id": "task_eskalieren", "type": "userTask", "name": "Eskalation bearbeiten", "lane": "lane_tl" }
  ],
  "edges": [
    { "id": "f_timer", "source": "timer_frist", "target": "task_eskalieren" }
  ]
}
```

### Multi-Instance Example

User text: "Für jeden Antragsteller wird parallel eine Bonitätsprüfung durchgeführt."

Expected: `{ "id": "task_bonitaet", "type": "serviceTask", "name": "Bonität prüfen", "multiInstance": "parallel" }`

### Compensation Pattern Example

User text: "Wenn die Buchung fehlschlägt, muss die Reservierung storniert werden."

Expected:
```json
{
  "nodes": [
    { "id": "task_buchen", "type": "serviceTask", "name": "Buchung durchführen" },
    { "id": "evt_comp", "type": "boundaryEvent", "name": "Buchung fehlgeschlagen", "marker": "compensation", "attachedTo": "task_buchen" },
    { "id": "task_storno", "type": "serviceTask", "name": "Reservierung stornieren", "isCompensation": true }
  ]
}
```

### Collapsed Pool + Message Flow Example

User text: "Der Kunde sendet eine Bestellung. Unser System verarbeitet sie und sendet eine Bestätigung zurück."

Expected structure:
```json
{
  "pools": [
    {
      "id": "Process_Unternehmen",
      "name": "Bestellverarbeitung",
      "nodes": [
        { "id": "start", "type": "startEvent", "name": "Bestellung eingegangen", "marker": "message" },
        { "id": "task_verarbeiten", "type": "serviceTask", "name": "Bestellung verarbeiten" },
        { "id": "task_bestaetigen", "type": "sendTask", "name": "Bestätigung versenden" },
        { "id": "end", "type": "endEvent", "name": "Bestellung abgeschlossen" }
      ],
      "edges": [
        { "id": "f1", "source": "start", "target": "task_verarbeiten", "isHappyPath": true },
        { "id": "f2", "source": "task_verarbeiten", "target": "task_bestaetigen", "isHappyPath": true },
        { "id": "f3", "source": "task_bestaetigen", "target": "end" }
      ],
      "lanes": []
    }
  ],
  "collapsedPools": [
    { "id": "Pool_Kunde", "name": "Kunde" }
  ],
  "messageFlows": [
    { "id": "mf1", "source": "Pool_Kunde", "target": "start", "name": "Bestellung" },
    { "id": "mf2", "source": "task_bestaetigen", "target": "Pool_Kunde", "name": "Auftragsbestätigung" }
  ]
}
```

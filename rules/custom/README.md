# Custom rule profiles

Project-specific rule profiles live here. Nothing in this directory is read
automatically — a profile takes effect only when a caller passes its path. That
is deliberate: a directory that is scanned at startup means dropping a file in
changes behaviour silently, and a typo in a filename is never noticed by anyone.

Applies to both engines. The profile format is shared
(`scripts/rule-profile.js`), only the rule ids and layer names differ.

## Using one

```js
// BPMN
import { runPipeline } from '../scripts/pipeline.js';
await runPipeline(logicCore, { ruleProfile: 'rules/custom/acme.json' });

// DMN
import { loadRuleProfile, runDmnRules } from '../scripts/dmn/rules.js';
runDmnRules(decisionCore, {
  profile: loadRuleProfile('rules/custom/acme-dmn.json'),
  mode: 'best-practice',
});
```

`loadRuleProfile` returns `null` for a path it cannot read or parse, and a null
profile means "use the defaults" — a missing profile does not fail the run. That
is convenient and it is also a trap: check the return value if it matters that
your profile was actually applied.

## Format

```jsonc
{
  "profile": "acme-dmn",           // free-text, for your own orientation
  "version": "1.0",
  "description": "…",

  "layers": {                      // switch whole layers off
    "best_practice": { "enabled": true }
  },

  "overrides": {                   // or change one rule
    "B02": { "severity": "OFF" },      // OFF also disables the rule entirely
    "D07": { "severity": "ERROR" }     // ERROR | WARNING | INFO | OFF
  }
}
```

## How a profile and a mode interact

A mode (`semantic`, `best-practice`) sets layer enablement. **An explicit
statement in a profile wins**, because it is the more specific one: running in
mode `best-practice` with a profile that disables `best_practice` leaves that
layer disabled. Layers the profile says nothing about are set by the mode.

## What the layers are

| Engine | Layer | Default severity | Contains |
|---|---|---|---|
| BPMN | `soundness` | ERROR | S01–S13 |
| BPMN | `style` | WARNING | M01–M11 |
| BPMN | `pragmatics` | INFO | P01–P03 |
| BPMN | `workflow_net` | ERROR/WARNING | WF01–WF03 (opt-in) |
| BPMN | `optimization` | ADVISORY | O01–O04 (opt-in) |
| DMN | `soundness` | ERROR | D01–D05, D09–D11 |
| DMN | `semantics` | WARNING | D06–D08 |
| DMN | `best_practice` | WARNING | B01–B06 (opt-in) |

The authoritative per-rule catalog, with the source behind each rule, is
[`references/fachliches-regelwerk.md`](../../references/fachliches-regelwerk.md).

## A note on committing these

Files here are ordinary tracked files. If a profile encodes something about a
client engagement, it does not belong in this repository — keep it outside and
pass an absolute path.

# BPMN Generator

Enterprise BPMN 2.0 diagram generator — converts natural language process descriptions into OMG-compliant BPMN 2.0 XML files and SVG previews.

## Pipeline

```
User Text → [Phase 1] Intent Extraction (LLM → JSON Logic-Core)
          → [Phase 2] Validation (deadlock detection, structural soundness)
          → [Phase 3] Auto-Layout (ElkJS Sugiyama layered algorithm)
          → [Phase 4] Serialization → BPMN 2.0 XML + SVG
```

The LLM **never** handles coordinates. Layout is 100% algorithmic.

## Quick Start

```bash
cd scripts/
npm install          # installs elkjs (only dependency)

# Generate from JSON Logic-Core:
node pipeline.js my-process.json my-process

# From stdin:
echo '{ ... }' | node pipeline.js - output

# Import existing BPMN:
node import.js existing.bpmn extracted.json
```

**Output:** `output.bpmn` (BPMN 2.0 XML) + `output.svg` (vector preview)

## Usage as Claude Code Skill

### In a specific project

Copy `SKILL.md` to `.claude/skills/operative/bpmn-prozess-erstellen.md` and adjust the relative paths for `references/` and `scripts/` to match where you placed those directories.

### As a portable .skill file

The `bpmn-generator-v3.skill` ZIP archive can be shared with other projects. It contains everything needed:
- `SKILL.md` — Skill definition
- `references/` — Schema, prompt templates, inline template
- `scripts/` — pipeline.js, import.js, package.json

## Structure

```
bpmn-generator/
├── SKILL.md                          # Claude Code skill definition
├── ROADMAP.md                        # Development roadmap (K1-K8, M1-M6, L1-L6)
├── references/
│   ├── logic-core-schema.md          # JSON schema for Logic-Core intermediate format
│   ├── prompt-template.md            # LLM prompt templates (extraction, review, amendment)
│   └── inline-template.md            # HTML template for browser-side ElkJS rendering
├── scripts/
│   ├── pipeline.js                   # Main pipeline (ElkJS layout → BPMN XML + SVG)
│   ├── import.js                     # BPMN XML → Logic-Core JSON importer
│   └── package.json                  # Dependencies (elkjs)
└── bpmn-generator-v3.skill           # Portable ZIP archive
```

## Features

- **Multi-pool collaborations** with message flows
- **All BPMN 2.0 task types** (User, Service, Script, Send, Receive, Manual, Business Rule)
- **Boundary events** (timer, error, message, signal — interrupting/non-interrupting)
- **All gateway types** with correct `gatewayDirection` (Diverging/Converging/Mixed)
- **Loop/multi-instance markers** (standard loop, parallel MI, sequential MI)
- **Data objects**, data stores, text annotations, associations
- **Collapsed pools** (black-box participants)
- **Round-tripping** (BPMN XML → Logic-Core JSON → BPMN XML)
- **Inline mode** (browser-side ElkJS rendering without Node.js)
- **OMG BPMN 2.0.2 compliant** XML output

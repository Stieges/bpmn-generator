/**
 * Synthetic data generator — produces (description, lcJson|dot) pairs via two-step LLM prompting.
 * See spec Section 4.3.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, '../../references/input-schema.json');

let _cachedSchema = null;
function loadSchema() {
  if (!_cachedSchema) _cachedSchema = readFileSync(SCHEMA_PATH, 'utf8');
  return _cachedSchema;
}

export function buildLcJsonPrompt(description) {
  const schema = loadSchema();
  const system = `You produce JSON conforming exactly to the provided schema. Output JUST the JSON object — no prose, no markdown fences, no preamble.

SCHEMA:
${schema}`;

  const user = `Convert this process description to Logic-Core JSON matching the schema above:

${description}

Constraints:
- All node IDs match ^[a-zA-Z_][a-zA-Z0-9_-]*$
- Every flow.source and flow.target must reference an existing node ID
- Lanes are ordered top-to-bottom by flow direction`;

  return { system, user };
}

export function extractJson(text) {
  try { return JSON.parse(text); } catch {}
  const fenced = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }
  return null;
}

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleCells(cells, { n, strategy = 'uniform', seed = Date.now(), filter = null } = {}) {
  const pool = filter ? cells.filter(filter) : cells.slice();
  if (n >= pool.length) return pool;

  const rand = mulberry32(seed);
  const picked = [];
  const remaining = pool.slice();
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rand() * remaining.length);
    picked.push(remaining.splice(idx, 1)[0]);
  }
  return picked;
}

export function buildDescriptionPrompt(cell, complexitySpec) {
  const system = `You generate realistic German enterprise process descriptions for BPMN modeling. Write natural, plausible business language.`;

  const user = `Generate a process description with these characteristics:
- Domain: ${cell.domain}
- Complexity: ${cell.complexity} (${complexitySpec.minNodes}-${complexitySpec.maxNodes} nodes, ${complexitySpec.gateways} gateways)
- Pattern to demonstrate: ${cell.pattern}
- Stress mode: ${cell.stress_mode}

Write the description in German, 200-400 words. Output JUST the description text — no markdown, no preamble, no metadata. Plausible business prose only.`;

  return { system, user };
}

export function enumerateCells(catalog) {
  const cells = [];
  for (const domain of catalog.domains) {
    for (const complexity of Object.keys(catalog.complexity)) {
      for (const pattern of catalog.patterns) {
        for (const stress_mode of catalog.stress_modes) {
          cells.push({ domain, complexity, pattern, stress_mode });
        }
      }
    }
  }
  return cells;
}

export function formatSampleId(cell, seq) {
  const padded = String(seq).padStart(3, '0');
  return `${cell.domain}__${cell.complexity}__${cell.pattern}__${cell.stress_mode}__${padded}`;
}

export async function generateSamples({
  catalog,
  n,
  llm,
  strategy = 'uniform',
  target = 'lc-json',
  model,
  seed = Date.now(),
}) {
  const cells = enumerateCells(catalog);
  const picked = sampleCells(cells, { n, strategy, seed });
  const samples = [];
  let seq = 0;

  for (const cell of picked) {
    seq++;
    const complexitySpec = catalog.complexity[cell.complexity];

    // Step 1: description
    const { system: sysA, user: userA } = buildDescriptionPrompt(cell, complexitySpec);
    let description;
    try { description = (await llm(sysA, userA, {})).trim(); }
    catch (e) { continue; }

    // Step 2: structure (LC-JSON path; DOT path added in Phase 5)
    if (target === 'lc-json') {
      const { system: sysB, user: userB } = buildLcJsonPrompt(description);
      let rawOutput;
      try { rawOutput = await llm(sysB, userB, {}); }
      catch (e) { continue; }
      const lcJson = extractJson(rawOutput);
      if (!lcJson) continue;  // unparseable — skip silently
      samples.push(buildSample({ cell, seq, description, lcJson, target, model }));
    }
  }

  return samples;
}

export function buildDotPrompt(description) {
  const system = `You produce Graphviz DOT language describing BPMN process flows. Output JUST the DOT — no prose, no markdown.

DOT format example:
digraph process {
  start [shape=circle];
  task1 [shape=box];
  end [shape=doublecircle];
  start -> task1 -> end;
}`;

  const user = `Convert this process description to DOT:

${description}

Constraints:
- Use shape=circle for start events, doublecircle for end events, box for tasks, diamond for gateways
- Edge labels via [label="..."]
- Node IDs alphanumeric only`;

  return { system, user };
}

export function extractDot(text) {
  // Fenced code block
  const fenced = text.match(/```(?:dot)?\s*\n([\s\S]*?)\n```/);
  if (fenced) return fenced[1].trim();
  // Bare digraph block
  const bare = text.match(/digraph\s+\w+\s*\{[\s\S]*?\}/);
  if (bare) return bare[0].trim();
  return null;
}

export function buildSample({ cell, seq, description, lcJson, rawDot = null, target, model }) {
  return {
    id: formatSampleId(cell, seq),
    description,
    lcJson,
    rawDot,
    meta: {
      domain: cell.domain,
      complexity: cell.complexity,
      pattern: cell.pattern,
      stress_mode: cell.stress_mode,
      target,
      model,
      generated_at: new Date().toISOString(),
    }
  };
}

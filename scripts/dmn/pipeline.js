/**
 * DMN Generator Pipeline — Orchestrator + CLI + Public API (runDmnPipeline).
 * Mirrors scripts/bpmn/pipeline.js's shape and idiom; see that file's own header comment
 * for the module-architecture convention this follows.
 *
 * Gate order: schema gate -> rules -> layout -> coordinates -> di-check -> serialisation.
 * Unlike the BPMN pipeline, the schema gate runs INSIDE runDmnPipeline, not only in the CLI —
 * this is a deliberate difference, stated in the interface contract for this plan.
 *
 * Usage:
 *   node pipeline.js input.json [output-basename]
 *   cat input.json | node pipeline.js - output-basename
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateDecisionCoreSchema } from './schema-gate.js';
import { runDmnRules, loadRuleProfile } from './rules.js';
import { decisionCoreToElk, runDmnElkLayout } from './layout.js';
import { buildDmnDiagrams } from './coordinates.js';
import { checkDmnDiagramIntegrity } from './di-check.js';
import { generateDmnXml, validateDmnXml } from './dmn-xml.js';

/**
 * @param {object} dc - Decision-Core JSON
 * @param {object} [opts={}]
 * @param {string} [opts.mode='semantic'] - 'semantic' (default) or 'best-practice'
 * @param {string|object} [opts.ruleProfile] - base rule profile (path or object)
 * @param {object} [opts.config] - thresholds override, defaults to CFG.dmn inside runDmnRules
 * @returns {Promise<{xml: string|null, diagrams: object[]|null, validation: object, diagnostics: object|null}>}
 */
export async function runDmnPipeline(dc, opts = {}) {
  const input = JSON.parse(JSON.stringify(dc)); // deep clone — callers' objects are never mutated
  const mode = opts.mode ?? 'semantic';

  const schemaCheck = validateDecisionCoreSchema(input);
  if (!schemaCheck.valid) {
    const errors = schemaCheck.errors.map((e) => `[schema] ${e.path} ${e.message}`);
    return { xml: null, diagrams: null, diagnostics: null,
      validation: { errors, warnings: [], infos: [], xmlWarnings: [], mode } };
  }

  let ruleProfile = opts.ruleProfile ?? null;
  if (typeof ruleProfile === 'string') ruleProfile = loadRuleProfile(ruleProfile);
  const { errors, warnings, infos } = runDmnRules(input, { profile: ruleProfile, mode, config: opts.config });
  if (errors.length) {
    return { xml: null, diagrams: null, diagnostics: null,
      validation: { errors, warnings, infos, xmlWarnings: [], mode } };
  }

  const elkGraph = decisionCoreToElk(input);
  const laidOut = await runDmnElkLayout(elkGraph);
  const diagrams = buildDmnDiagrams(input, laidOut);
  const diagnostics = checkDmnDiagramIntegrity(diagrams);

  const xml = await generateDmnXml(input, diagrams);
  const roundTrip = await validateDmnXml(xml);

  return {
    xml, diagrams, diagnostics,
    validation: { errors: [], warnings, infos, xmlWarnings: roundTrip.warnings, mode },
  };
}

// ═══════════════════════════════════════════════════════════════════════
// CLI ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const positional = args.filter((a) => !a.startsWith('--'));
  const inputArg = positional[0];
  const outputBase = positional[1] || 'output';
  const strict = flags.includes('--strict');
  const bestPractice = flags.includes('--best-practice') || flags.includes('--mode=best-practice');

  if (!inputArg) {
    console.error('Usage: node pipeline.js <input.json | -> [output-basename] [--strict] [--best-practice]');
    process.exit(1);
  }

  let rawInput;
  if (inputArg === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    rawInput = Buffer.concat(chunks).toString();
  } else {
    rawInput = readFileSync(resolve(inputArg), 'utf8');
  }

  const parsedInput = JSON.parse(rawInput);
  const result = await runDmnPipeline(parsedInput, { mode: bestPractice ? 'best-practice' : 'semantic' });

  if (result.validation.warnings.length) {
    console.warn('\n⚠ Warnings:');
    result.validation.warnings.forEach((w) => console.warn('  · ' + w));
  }
  if (!result.xml) {
    console.error('\n✗ Errors (pipeline blocked):');
    result.validation.errors.forEach((e) => console.error('  · ' + e));
    process.exit(1);
  }
  // --strict: treat any unresolved warning as fatal and abort BEFORE writing files, across the
  // three channels — mirroring scripts/bpmn/pipeline.js exactly. --strict is CLI-only logic;
  // runDmnPipeline itself has no `strict` option.
  if (strict && result.validation.warnings.length) {
    console.error(`\n✗ --strict: ${result.validation.warnings.length} warning(s). No files written.`);
    process.exit(1);
  }
  console.log('✓ Decision-Core validated (structural soundness OK)');

  const ddErrors = (result.diagnostics?.issues ?? []).filter((i) => i.severity === 'ERROR');
  const ddWarnings = (result.diagnostics?.issues ?? []).filter((i) => i.severity !== 'ERROR');
  if (ddWarnings.length) {
    console.warn('\n⚠ Diagram diagnostics:');
    ddWarnings.forEach((i) => console.warn(`  · ${i.code} ${i.message}`));
  }
  if (ddErrors.length) {
    console.error('\n✗ Diagram integrity (DD) — the geometry is broken, no files written:');
    ddErrors.forEach((i) => console.error(`  · ${i.code} ${i.message}`));
    process.exit(1);
  }
  if (strict && ddWarnings.length) {
    console.error(`\n✗ --strict: ${ddWarnings.length} diagram diagnostic(s). No files written.`);
    process.exit(1);
  }

  const xmlWarnings = result.validation.xmlWarnings ?? [];
  if (xmlWarnings.length) {
    console.warn('\n⚠ DMN serialisation (round-trip through dmn-moddle):');
    xmlWarnings.forEach((w) => console.warn('  · ' + w));
  }
  if (strict && xmlWarnings.length) {
    console.error(`\n✗ --strict: ${xmlWarnings.length} serialisation warning(s). No files written.`);
    process.exit(1);
  }

  const dmnPath = `${outputBase}.dmn`;
  writeFileSync(dmnPath, result.xml, 'utf8');
  console.log(`✓ DMN 1.3 XML → ${dmnPath}`);
}

// Only run CLI when executed directly (not imported) — same idiom as scripts/bpmn/pipeline.js.
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch((err) => { console.error('Pipeline error:', err); process.exit(1); });
}

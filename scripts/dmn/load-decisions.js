/**
 * Loading a `--decisions` file — the one implementation shared by every CLI that takes decision
 * models next to a process (scripts/scenarios/pipeline.js, scripts/bpmn/pipeline.js).
 *
 * The format is decided by the CONTENT — first non-whitespace character `<` means XML (a `.dmn`
 * file, imported through dmn/import.js), anything else JSON (a Decision-Core) — never by the
 * extension, which lies in both directions. A DMN import prints its loss report (via `log`) and
 * hands its finding count back, so a `--strict` caller can fold it in. An imported DMN file must
 * pass the Decision-Core schema gate, or this throws; a JSON file is returned as parsed — the
 * caller's own gate judges it, exactly as for any other Decision-Core input.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { validateDecisionCoreSchema } from './schema-gate.js';
import { dmnToDecisionCore, formatImportReport, NOT_DMN_ROOT } from './import.js';

/**
 * @param {string} p - file path
 * @param {object} [opts]
 * @param {(line: string) => void} [opts.log=console.error] - where a DMN import report goes
 * @returns {Promise<{ dc: object, importFindings: number }>}
 */
export async function loadDecisionFile(p, { log = console.error } = {}) {
  const raw = readFileSync(resolve(p), 'utf8');
  // A UTF-8 BOM (U+FEFF) is what Windows editors prepend; JSON.parse rejects it.
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.trimStart().startsWith('<')) {
    let dc;
    try {
      dc = JSON.parse(text);
    } catch (e) {
      throw new Error(`${p} is not valid JSON (${e.message})`);
    }
    return { dc, importFindings: 0 };
  }

  const { dc, report } = await dmnToDecisionCore(text);
  if (!dc) {
    const first = report.parserWarnings[0] ?? '';
    throw new Error(NOT_DMN_ROOT.test(first)
      ? `${p} is not a DMN document (well-formed XML, but the root is not DMN 1.3 <definitions>)`
      : `${p} is not XML (${first.split('\n').pop().trim() || 'parse failed'})`);
  }
  log(formatImportReport(report, { file: p }));
  const gate = validateDecisionCoreSchema(dc);
  if (!gate.valid) {
    throw new Error(`${p}: the imported Decision-Core fails its schema (${gate.errors.map((e) => `${e.path} ${e.message}`).join('; ')})`);
  }
  return { dc, importFindings: report.lossless ? 0 : Math.max(1, report.counts.unrepresented) };
}

/** Split a `--decisions` value (comma-separated paths) into paths. */
export function decisionPaths(arg) {
  return String(arg ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

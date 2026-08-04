import { describe, test, expect } from '@jest/globals';
import { DmnModdle } from 'dmn-moddle';

import { DMN_COVERAGE, NON_TYPE_GAPS, REPORT_KINDS, coverageFor } from './coverage.js';

/**
 * The oracle is dmn-moddle's own registry, never a restatement of it.
 *
 * A list hand-written from DMN13.xsd would already be wrong: the XSD element is
 * `organizationUnit` while moddle's type is `dmn:OrganisationalUnit` (British spelling).
 * The parser is what the importer will actually face, so the parser's type map is what the
 * table is measured against — and a `dmn-moddle` upgrade that adds a type then fails CI
 * naming that type, rather than widening the silent gap the table exists to close.
 */
function concreteDmnTypes() {
  const md = new DmnModdle();
  return Object.keys(md.registry.typeMap)
    .filter((t) => t.startsWith('dmn:'))
    .filter((t) => !md.registry.typeMap[t].isAbstract);
}

describe('DMN coverage table — the fence', () => {
  test('1. every concrete dmn: type has exactly one row', () => {
    const rows = new Map();
    for (const row of DMN_COVERAGE) rows.set(row.type, (rows.get(row.type) ?? 0) + 1);

    // One flat list of human-readable problems rather than two empty-array assertions: the first
    // assertion to fail is the only one jest reports, and a table can be short a row AND carry a
    // duplicate at the same time. Each entry names the type and says what to do about it, so the
    // failure is actionable without opening this file.
    const problems = [
      ...concreteDmnTypes().filter((t) => !rows.has(t))
        .map((t) => `add a row to scripts/dmn/coverage.js for ${t}`),
      ...[...rows].filter(([, n]) => n > 1)
        .map(([t]) => `remove the duplicate row in scripts/dmn/coverage.js for ${t}`),
    ];
    expect(problems).toEqual([]);
  });

  test('2. every row names a type the registry still has as concrete', () => {
    const concrete = new Set(concreteDmnTypes());
    const stale = DMN_COVERAGE.map((r) => r.type).filter((t) => !concrete.has(t));
    expect(stale).toEqual([]);
  });

  test('3. every row carries what its status obliges it to carry', () => {
    const defects = [];
    for (const row of DMN_COVERAGE) {
      if (!['mapped', 'unrepresentable', 'structural'].includes(row.status)) {
        defects.push(`${row.type}: unknown status ${JSON.stringify(row.status)}`);
        continue;
      }
      if (row.status === 'mapped') {
        if (!row.to) defects.push(`${row.type}: status 'mapped' needs a 'to' naming the target`);
      } else if (!row.reason || row.reason.trim().length === 0) {
        defects.push(`${row.type}: status '${row.status}' needs a non-empty 'reason'`);
      }
      // `subsumed` is deliberately excluded here: it means "reported through another entry's
      // line", which only a NON_TYPE_GAPS entry nested inside an already-reported construct can
      // legitimately claim. Allowing it on a type row would make "we drop it, silently" spellable.
      const kinds = REPORT_KINDS.filter((k) => k !== 'subsumed');
      if (row.status === 'unrepresentable' && !kinds.includes(row.report)) {
        defects.push(`${row.type}: status 'unrepresentable' needs a 'report' from ${kinds.join('|')}`);
      }
    }
    expect(defects).toEqual([]);
  });

  // The two known losses that are not `dmn:` types. They deliberately live in a sibling
  // export rather than as extra rows: assertion 1 is a SET EQUALITY against the registry,
  // and a row the registry can never confirm would turn that equality into a subset test —
  // weakening the one assertion the whole fence rests on.
  test('the non-type gaps are recorded, and are genuinely not dmn: types', () => {
    const concrete = new Set(concreteDmnTypes());
    expect(NON_TYPE_GAPS.length).toBeGreaterThan(0);
    for (const gap of NON_TYPE_GAPS) {
      expect(concrete.has(gap.construct)).toBe(false);
      expect(gap.status).toBe('unrepresentable');
      expect(gap.reason.trim().length).toBeGreaterThan(0);
      expect(REPORT_KINDS).toContain(gap.report);
    }
  });

  test('coverageFor answers by type and is undefined for anything else', () => {
    expect(coverageFor('dmn:Decision').status).toBe('mapped');
    expect(coverageFor('dmn:Artifact')).toBeUndefined();
  });

  // Assertion 4 lands in Stage 3, once scripts/dmn/import.js exists:
  //   Object.keys(HANDLERS) must equal the set of `mapped` rows' types.
  // That is what stops the table and the importer from drifting apart. It is deliberately
  // NOT stubbed here — a skipped test reads as coverage that exists, and it does not.
});

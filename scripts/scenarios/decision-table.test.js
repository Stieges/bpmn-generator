/**
 * Phase B — decision-table analysis tests.
 *
 * Every expectation here is hand-derived from the table under test, not recorded from a
 * run: where one fails, the analysis is wrong, not the expectation. The tables are inline
 * except for the numeric ground truth, which is the real fixture
 * `tests/fixtures/dmn/discount-decision.json`.
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  analyzeDecisionTable, parseUnaryTest, parseValue, parseRules,
  predicatesIntersect, findOverlaps,
} from './decision-table.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The `UNIQUE`, single-numeric-column table of the reference fixture. */
function discountTable() {
  const dc = JSON.parse(readFileSync(
    resolve(__dirname, '../../tests/fixtures/dmn/discount-decision.json'), 'utf8'));
  return structuredClone(dc.nodes.find(n => n.id === 'dec_discountLevel').decisionTable);
}

const gapDescriptions = (result) => (result.gaps || []).map(g => g.describe);
const overlapPairs = (result) => result.overlaps.map(o => o.ruleIds.join('+'));

// ═══════════════════════════════════════════════════════════════════════
// The grammar, and the two ambiguities it had to resolve
// ═══════════════════════════════════════════════════════════════════════

describe('condition grammar', () => {
  test('a lone dash is the wildcard, a dash followed by digits is a negative number', () => {
    expect(parseUnaryTest('-')).toEqual({ kind: 'any' });
    expect(parseUnaryTest('  -  ')).toEqual({ kind: 'any' });
    expect(parseUnaryTest('')).toEqual({ kind: 'any' });

    const negative = parseUnaryTest('-5');
    expect(negative.kind).toBe('ranges');
    expect(negative.domain).toBe('number');
    expect(negative.ranges[0].lo.v).toBe(-5);
    expect(negative.ranges[0].hi.v).toBe(-5);

    expect(parseValue('-3.2').v).toBeCloseTo(-3.2);
    expect(parseUnaryTest('< -10').ranges[0].hi.v).toBe(-10);
    // The two readings never collide: the wildcard is exactly one character.
    expect(parseUnaryTest('-10')).not.toEqual({ kind: 'any' });
  });

  test('a bare literal is an implicit equality test, identical to the explicit form', () => {
    expect(parseUnaryTest('100')).toEqual(parseUnaryTest('= 100'));
    expect(parseUnaryTest('"Gold"')).toEqual(parseUnaryTest('= "Gold"'));
    expect(parseUnaryTest('100').ranges[0]).toMatchObject({
      lo: { v: 100, inclusive: true }, hi: { v: 100, inclusive: true },
    });
  });

  test('comparisons, intervals and enumerations parse; everything else declines', () => {
    expect(parseUnaryTest('< 100').ranges[0]).toMatchObject({ lo: null, hi: { v: 100, inclusive: false } });
    expect(parseUnaryTest('>= 500').ranges[0]).toMatchObject({ lo: { v: 500, inclusive: true }, hi: null });
    expect(parseUnaryTest('[100..500)').ranges[0]).toMatchObject({
      lo: { v: 100, inclusive: true }, hi: { v: 500, inclusive: false },
    });
    expect(parseUnaryTest('"Gold","Silver"')).toEqual({
      kind: 'enum', domain: 'string', values: ['Gold', 'Silver'],
    });

    // Outside the grammar — never approximated.
    for (const bad of ['someFunction(x)', '< 100 and > 10', 'not("Gold")', '[1..2],"Gold"', '< "Gold"', '[5..1]']) {
      expect(parseUnaryTest(bad)).toBeNull();
    }
  });

  test('predicate intersection is exact and conservative across domains', () => {
    expect(predicatesIntersect(parseUnaryTest('< 100'), parseUnaryTest('>= 100'))).toBe(false);
    expect(predicatesIntersect(parseUnaryTest('<= 100'), parseUnaryTest('>= 100'))).toBe(true);
    expect(predicatesIntersect(parseUnaryTest('-'), parseUnaryTest('"Gold"'))).toBe(true);
    expect(predicatesIntersect(parseUnaryTest('"Gold"'), parseUnaryTest('"Gold","Silver"'))).toBe(true);
    expect(predicatesIntersect(parseUnaryTest('"Gold"'), parseUnaryTest('< 100'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 1 — the numeric ground truth
// ═══════════════════════════════════════════════════════════════════════

describe('discount-decision.json — the numeric ground truth', () => {
  test('the three rules partition the number line: no gap, no overlap', () => {
    const result = analyzeDecisionTable(discountTable());
    expect(result.unanalyzableRules).toEqual([]);
    expect(result.gapAnalysis.attempted).toBe(true);
    expect(result.gaps).toEqual([]);
    expect(result.overlaps).toEqual([]);
    expect(result.gapAnalysis.cellCap).toBe(20_000);
  });

  test('deleting the middle rule reports exactly the gap [100..500)', () => {
    const table = discountTable();
    table.rules = table.rules.filter(r => r.id !== 'r2');
    const result = analyzeDecisionTable(table);
    expect(gapDescriptions(result)).toEqual(['[100..500)']);
    expect(result.gaps[0].columns[0]).toMatchObject({ inputIndex: 0, label: 'Order value' });
    expect(result.overlaps).toEqual([]);
  });

  test('widening the middle rule past 500 reports the overlap with the top tier', () => {
    const table = discountTable();
    table.rules[1].when = ['[100..600)'];
    const result = analyzeDecisionTable(table);
    expect(overlapPairs(result)).toEqual(['r2+r3']);
    expect(result.overlaps[0].columns[0].tests).toEqual(['[100..600)', '>= 500']);
    expect(result.gaps).toEqual([]); // widening covers everything, it only doubles up
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2 — several input columns
// ═══════════════════════════════════════════════════════════════════════

/** amount (number) × tier (string, closed domain). */
function twoColumnTable() {
  return {
    id: 'table_twoCol',
    hitPolicy: 'UNIQUE',
    inputs: [
      { id: 'in_amount', label: 'Amount', expression: 'amount', typeRef: 'number' },
      { id: 'in_tier', label: 'Tier', expression: 'tier', typeRef: 'string', allowedValues: '"Gold","Silver"' },
    ],
    outputs: [{ id: 'out_1', name: 'fee', typeRef: 'number' }],
    rules: [
      { id: 'r1', when: ['< 100', '-'], then: ['0'] },
      { id: 'r2', when: ['>= 100', '"Gold"'], then: ['5'] },
      { id: 'r3', when: ['>= 100', '"Silver"'], then: ['10'] },
    ],
  };
}

describe('multi-column tables', () => {
  test('the cross-product of two columns is fully covered and free of overlap', () => {
    const result = analyzeDecisionTable(twoColumnTable());
    expect(result.gaps).toEqual([]);
    expect(result.overlaps).toEqual([]);
    expect(result.gapAnalysis.columnsAnalyzed).toEqual([0, 1]);
    expect(result.gapAnalysis.cellCount).toBe(6); // 3 amount cells × 2 tier values
  });

  test('a gap in one column of the product is found and named per column', () => {
    const table = twoColumnTable();
    table.rules = table.rules.filter(r => r.id !== 'r3');
    const result = analyzeDecisionTable(table);
    expect(gapDescriptions(result)).toEqual(['[100..+∞) × "Silver"']);
    expect(result.gaps[0].columns).toEqual([
      { inputIndex: 0, label: 'Amount', describe: '[100..+∞)' },
      { inputIndex: 1, label: 'Tier', describe: '"Silver"' },
    ]);
  });

  test('an overlap is only reported when EVERY column intersects', () => {
    const table = twoColumnTable();
    table.rules.push({ id: 'r4', when: ['>= 200', '"Gold"'], then: ['7'] });   // overlaps r2
    table.rules.push({ id: 'r5', when: ['< 50', '"Gold"'], then: ['1'] });     // overlaps r1 only
    const result = analyzeDecisionTable(table);
    expect(overlapPairs(result).sort()).toEqual(['r1+r5', 'r2+r4']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3 — string columns, with and without a declared domain
// ═══════════════════════════════════════════════════════════════════════

function stringTable(withAllowedValues) {
  return {
    id: 'table_tier',
    hitPolicy: 'UNIQUE',
    inputs: [{
      id: 'in_tier', label: 'Tier', expression: 'tier', typeRef: 'string',
      ...(withAllowedValues ? { allowedValues: '"Gold","Silver","Bronze"' } : {}),
    }],
    outputs: [{ id: 'out_1', name: 'fee', typeRef: 'number' }],
    rules: [
      { id: 'r1', when: ['"Gold"'], then: ['5'] },
      { id: 'r2', when: ['"Silver"'], then: ['10'] },
    ],
  };
}

describe('string columns — the gap/overlap asymmetry', () => {
  test('with a declared domain, a missing enum value is a gap', () => {
    const result = analyzeDecisionTable(stringTable(true));
    expect(result.gapAnalysis.attempted).toBe(true);
    expect(gapDescriptions(result)).toEqual(['"Bronze"']);
  });

  test('without a declared domain, no gap claim is made — and the reason is stated', () => {
    const result = analyzeDecisionTable(stringTable(false));
    expect(result.gaps).toBeNull();
    expect(result.gapAnalysis.attempted).toBe(false);
    expect(result.gapAnalysis.reason.code).toBe('unbounded-domain');
    expect(result.gapAnalysis.reason.columns).toEqual([0]);
    expect(result.gapAnalysis.reason.message).toMatch(/without a declared domain/);
    expect(result.gapAnalysis.columnsSkipped).toHaveLength(1);
  });

  test('overlap detection on a string column works with no declared domain at all', () => {
    const table = stringTable(false);
    table.rules.push({ id: 'r3', when: ['"Gold","Bronze"'], then: ['3'] });
    const result = analyzeDecisionTable(table);
    expect(result.gaps).toBeNull();                 // still no gap claim
    expect(overlapPairs(result)).toEqual(['r1+r3']); // but overlap is unaffected
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4 — date columns are an ordered domain, not opaque strings
// ═══════════════════════════════════════════════════════════════════════

function dateTable() {
  return {
    id: 'table_tenure',
    hitPolicy: 'UNIQUE',
    inputs: [{ id: 'in_since', label: 'Customer since', expression: 'customerSince', typeRef: 'date' }],
    outputs: [{ id: 'out_1', name: 'bonus', typeRef: 'number' }],
    rules: [
      { id: 'd1', when: ['< date("2020-01-01")'], then: ['5'] },
      { id: 'd2', when: ['[date("2020-01-01")..date("2021-01-01"))'], then: ['3'] },
      { id: 'd3', when: ['>= date("2021-01-01")'], then: ['0'] },
    ],
  };
}

describe('date columns', () => {
  test('date intervals partition the timeline exactly as numbers partition the line', () => {
    const result = analyzeDecisionTable(dateTable());
    expect(result.gaps).toEqual([]);
    expect(result.overlaps).toEqual([]);
    const parsed = parseUnaryTest('[date("2020-01-01")..date("2021-01-01"))');
    expect(parsed.kind).toBe('ranges');
    expect(parsed.domain).toBe('date');       // ordered, not an enum of strings
    expect(parsed.ranges[0].lo.v).toBeLessThan(parsed.ranges[0].hi.v);
  });

  test('a missing period between two date rules is reported as a gap', () => {
    const table = dateTable();
    table.rules = table.rules.filter(r => r.id !== 'd2');
    const result = analyzeDecisionTable(table);
    expect(gapDescriptions(result)).toEqual(['[date("2020-01-01")..date("2021-01-01"))']);
  });

  test('two date rules covering the same day overlap', () => {
    const table = dateTable();
    table.rules[2].when = ['>= date("2020-06-01")'];
    const result = analyzeDecisionTable(table);
    expect(overlapPairs(result)).toEqual(['d2+d3']);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5-7 — hit-policy-aware branching
// ═══════════════════════════════════════════════════════════════════════

describe('branching — UNIQUE', () => {
  test('one exact branch per rule, carrying condition and outcome', () => {
    const result = analyzeDecisionTable(discountTable());
    const b = result.branching;
    expect(b.kind).toBe('per-rule');
    expect(b.exact).toBe(true);
    expect(b.mayOverestimate).toBe(false);
    expect(b.symbolic).toBe(true);
    expect(b.aggregated).toBeNull();
    expect(b.branches.map(x => x.ruleId)).toEqual(['r1', 'r2', 'r3']);
    expect(b.branches[1].condition).toEqual([{ inputIndex: 0, label: 'Order value', test: '[100..500)' }]);
    expect(b.branches[1].outcome).toEqual([{ outputIndex: 0, name: 'level', value: '"bronze"' }]);
    expect(b.branches.every(x => x.mayOverestimate === false)).toBe(true);
  });

  test('an overlapping UNIQUE table is reported, not re-interpreted or crashed on', () => {
    const table = discountTable();
    table.rules[0].when = ['< 200']; // illegal under UNIQUE, upstream validation may not have run
    const result = analyzeDecisionTable(table);
    expect(result.branching.kind).toBe('per-rule');
    expect(result.branching.exact).toBe(true);
    expect(overlapPairs(result)).toEqual(['r1+r2']);
  });
});

describe('branching — FIRST / PRIORITY', () => {
  const dominatedTable = (hitPolicy) => ({
    id: 'table_first',
    hitPolicy,
    inputs: [{ id: 'in_amount', label: 'Amount', expression: 'amount', typeRef: 'number' }],
    outputs: [{ id: 'out_1', name: 'fee', typeRef: 'number' }],
    rules: [
      { id: 'f1', when: ['< 100'], then: ['1'] },
      { id: 'f2', when: ['< 50'], then: ['2'] },   // fully dominated by f1 under FIRST
      { id: 'f3', when: ['>= 100'], then: ['3'] },
    ],
  });

  test('FIRST produces a branch per rule, every one marked as a possible overestimate', () => {
    const result = analyzeDecisionTable(dominatedTable('FIRST'));
    const b = result.branching;
    expect(b.kind).toBe('per-rule');
    expect(b.exact).toBe(false);
    expect(b.mayOverestimate).toBe(true);
    expect(b.branches).toHaveLength(3);            // domination is NOT detected here
    expect(b.branches.every(x => x.mayOverestimate === true)).toBe(true);
    expect(b.note).toMatch(/upper bound/);
    expect(overlapPairs(result)).toEqual(['f1+f2']); // the overlap is legal but still reported
  });

  test('PRIORITY behaves identically to FIRST for branching purposes', () => {
    const b = analyzeDecisionTable(dominatedTable('PRIORITY')).branching;
    expect(b.kind).toBe('per-rule');
    expect(b.hitPolicy).toBe('PRIORITY');
    expect(b.mayOverestimate).toBe(true);
    expect(b.aggregated).toBeNull();
  });
});

describe('branching — COLLECT and the other aggregating policies', () => {
  const collectTable = () => ({
    id: 'table_collect',
    hitPolicy: 'COLLECT',
    aggregation: 'SUM',
    inputs: [{ id: 'in_amount', label: 'Amount', expression: 'amount', typeRef: 'number' }],
    outputs: [{ id: 'out_1', name: 'points', typeRef: 'number' }],
    rules: [
      { id: 'c1', when: ['>= 100'], then: ['1'] },
      { id: 'c2', when: ['>= 500'], then: ['2'] },  // both match for amount >= 500
    ],
  });

  test('no per-rule branches — one aggregated-outcome descriptor instead', () => {
    const result = analyzeDecisionTable(collectTable());
    const b = result.branching;
    expect(b.kind).toBe('aggregated');
    expect(b.branches).toBeNull();
    expect(b.aggregated).toEqual({
      hitPolicy: 'COLLECT',
      aggregation: 'SUM',
      contributingRuleIds: ['c1', 'c2'],
      outputNames: ['points'],
      note: expect.stringMatching(/collected and reduced with SUM/),
    });
    // The simultaneous match is a fact about the table, still reported as an overlap.
    expect(overlapPairs(result)).toEqual(['c1+c2']);
  });

  test('the aggregated shape cannot be confused with the per-rule shape', () => {
    const aggregated = analyzeDecisionTable(collectTable()).branching;
    const perRule = analyzeDecisionTable(discountTable()).branching;
    expect(aggregated.kind).not.toBe(perRule.kind);
    expect(aggregated.branches).toBeNull();
    expect(perRule.aggregated).toBeNull();
    expect(Array.isArray(perRule.branches)).toBe(true);
    for (const policy of ['ANY', 'RULE ORDER', 'OUTPUT ORDER']) {
      const t = { ...collectTable(), hitPolicy: policy, aggregation: undefined };
      expect(analyzeDecisionTable(t).branching.kind).toBe('aggregated');
      expect(analyzeDecisionTable(t).branching.branches).toBeNull();
    }
  });

  test('gap and overlap findings survive an aggregating policy', () => {
    const table = collectTable();
    const result = analyzeDecisionTable(table);
    expect(gapDescriptions(result)).toEqual(['(-∞..100)']); // nothing covers small amounts
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8 — one bad column poisons its whole rule, never just that column
// ═══════════════════════════════════════════════════════════════════════

describe('mixed analyzable and unanalyzable columns', () => {
  const mixedTable = () => ({
    id: 'table_mixed',
    hitPolicy: 'UNIQUE',
    inputs: [
      { id: 'in_amount', label: 'Amount', expression: 'amount', typeRef: 'number' },
      { id: 'in_flag', label: 'Flag', expression: 'flag' },
    ],
    outputs: [{ id: 'out_1', name: 'fee', typeRef: 'number' }],
    rules: [
      { id: 'm1', when: ['< 100', '-'], then: ['0'] },
      { id: 'm2', when: ['< 100', 'riskScore(customer) > 3'], then: ['5'] },
      { id: 'm3', when: ['>= 100', '-'], then: ['9'] },
    ],
  });

  test('the whole rule is excluded from overlap analysis, not just the bad column', () => {
    const result = analyzeDecisionTable(mixedTable());
    expect(result.unanalyzableRules).toHaveLength(1);
    expect(result.unanalyzableRules[0]).toMatchObject({ ruleId: 'm2', ruleIndex: 1, columnIndex: 1 });
    expect(result.unanalyzableRules[0].reason).toMatch(/outside the supported grammar/);
    // m1 and m2 agree on column 0 and m1's column 1 is a wildcard — analyzing column by
    // column would have reported them as overlapping. They are not compared at all.
    expect(result.overlaps).toEqual([]);
    expect(result.stats).toMatchObject({ ruleCount: 3, analyzableRuleCount: 2 });
  });

  test('gap analysis declines entirely while any rule is unanalyzable, and says so', () => {
    const result = analyzeDecisionTable(mixedTable());
    expect(result.gaps).toBeNull();
    expect(result.gapAnalysis.attempted).toBe(false);
    expect(result.gapAnalysis.reason.code).toBe('unanalyzable-rule');
    expect(result.gapAnalysis.reason.ruleIds).toEqual(['m2']);
  });

  test('a rule whose arity does not match the input columns is unanalyzable, not padded', () => {
    const table = mixedTable();
    table.rules.push({ id: 'm4', when: ['< 10'], then: ['1'] });
    const { unanalyzable } = parseRules(table);
    expect(unanalyzable.map(u => u.ruleId)).toEqual(['m2', 'm4']);
    expect(unanalyzable[1].reason).toMatch(/1 unary test\(s\) but the table declares 2/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 9 — the explosion cap is honest
// ═══════════════════════════════════════════════════════════════════════

describe('the gap-analysis cell cap', () => {
  test('an exceeded cap yields "not attempted" with the real cell count, never a partial answer', () => {
    const result = analyzeDecisionTable(twoColumnTable(), { maxPartitionCells: 4 });
    expect(result.gaps).toBeNull();
    expect(result.gapAnalysis.attempted).toBe(false);
    expect(result.gapAnalysis.reason.code).toBe('cap-exceeded');
    expect(result.gapAnalysis.reason.cellCount).toBe(6);
    expect(result.gapAnalysis.reason.cap).toBe(4);
    expect(result.gapAnalysis.reason.message).toMatch(/not attempted/);
    // Overlap detection is unbounded by design and still ran.
    expect(result.overlaps).toEqual([]);
  });

  test('the same table under the default cap is fully analyzed', () => {
    const result = analyzeDecisionTable(twoColumnTable());
    expect(result.gapAnalysis.attempted).toBe(true);
    expect(result.gapAnalysis.cellCount).toBeLessThanOrEqual(result.gapAnalysis.cellCap);
  });

  test('the cap is configurable through the scenarios.decisionTable config block', () => {
    const config = { scenarios: { decisionTable: { maxPartitionCells: 2 } } };
    const result = analyzeDecisionTable(twoColumnTable(), { config });
    expect(result.gapAnalysis.cellCap).toBe(2);
    expect(result.gapAnalysis.reason.code).toBe('cap-exceeded');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Degenerate shapes a caller can legitimately hand in
// ═══════════════════════════════════════════════════════════════════════

describe('degenerate tables', () => {
  test('a table with no input columns: every rule always matches, so all pairs overlap', () => {
    const table = {
      id: 'table_noInput', hitPolicy: 'COLLECT', inputs: [],
      outputs: [{ id: 'o', name: 'v' }],
      rules: [{ id: 'n1', when: [], then: ['1'] }, { id: 'n2', when: [], then: ['2'] }],
    };
    const result = analyzeDecisionTable(table);
    expect(overlapPairs(result)).toEqual(['n1+n2']);
    expect(result.gaps).toEqual([]);
    expect(result.gapAnalysis.cellCount).toBe(1);
  });

  test('a table with no rules makes no gap claim and says why', () => {
    const table = { id: 't', inputs: [], outputs: [{ id: 'o' }], rules: [] };
    const result = analyzeDecisionTable(table);
    expect(result.gaps).toBeNull();
    expect(result.gapAnalysis.reason.code).toBe('no-rules');
    expect(result.branching.kind).toBe('per-rule');
    expect(result.branching.branches).toEqual([]);
  });

  test('an unknown hit policy asserts no branching shape', () => {
    const table = { ...discountTable(), hitPolicy: 'SOMETHING' };
    const b = analyzeDecisionTable(table).branching;
    expect(b.kind).toBe('unknown-policy');
    expect(b.branches).toBeNull();
    expect(b.aggregated).toBeNull();
  });

  test('a wildcard-only column needs no declared domain and leaves no gap', () => {
    const table = {
      id: 't', hitPolicy: 'UNIQUE',
      inputs: [{ id: 'i', label: 'Anything', expression: 'x' }],
      outputs: [{ id: 'o', name: 'v' }],
      rules: [{ id: 'w1', when: ['-'], then: ['1'] }],
    };
    const result = analyzeDecisionTable(table);
    expect(result.gaps).toEqual([]);
    expect(result.gapAnalysis.cellCount).toBe(1);
  });

  test('allowedValues on a numeric column narrows the domain instead of widening the gaps', () => {
    const table = {
      id: 't', hitPolicy: 'UNIQUE',
      inputs: [{ id: 'i', label: 'Score', expression: 'score', typeRef: 'number', allowedValues: '[0..100]' }],
      outputs: [{ id: 'o', name: 'v' }],
      rules: [
        { id: 'a1', when: ['[0..50)'], then: ['1'] },
        { id: 'a2', when: ['[50..100]'], then: ['2'] },
      ],
    };
    const result = analyzeDecisionTable(table);
    expect(result.gaps).toEqual([]);      // nothing below 0 or above 100 counts as missing
    expect(result.overlaps).toEqual([]);
  });

  test('findOverlaps is exported for callers that only need the pairwise check', () => {
    const table = twoColumnTable();
    const { analyzable } = parseRules(table);
    expect(findOverlaps(analyzable, table.inputs)).toEqual([]);
  });
});

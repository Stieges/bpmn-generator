/**
 * Decision tables: the one layout (table.js) and its four translations — Markdown and plain text
 * (table-text.js), SVG (table-svg.js), HTML (table-html.js) — plus the `--doc` Markdown (doc.js).
 *
 * The contract mirrors the DRD's: table.js decides every word and every box once; a renderer that
 * computes its own width or calls a column something else is the drift this file fences.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  layoutDecisionTable, layoutDecisionTables, describeHitPolicy, decisionsWithTables, isAnyEntry,
} from './table.js';
import { formatTableMarkdown, formatTablePlainText, escapeMarkdownCell } from './table-text.js';
import { generateTablesSvg } from './table-svg.js';
import { generateTablesHtml } from './table-html.js';
import { generateDmnMarkdown } from './doc.js';
import { dmnLabels, DMN_TABLE_STYLE } from './constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../../tests/fixtures/dmn');
const loadFixture = (name) => JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
const claim = () => loadFixture('claim-approval.json');
const claimDecision = () => claim().nodes.find((n) => n.id === 'dec_approvalLevel');

const decision = (table, extra = {}) => ({ id: 'd', type: 'decision', name: 'D', decisionTable: table, ...extra });
const simpleTable = (extra = {}) => ({
  inputs: [{ label: 'Score', expression: 'score', typeRef: 'number' }],
  outputs: [{ name: 'class', typeRef: 'string' }],
  rules: [{ when: ['< 50'], then: ['"low"'] }, { when: ['-'], then: ['"high"'] }],
  ...extra,
});

describe('table.js — the hit policy', () => {
  test.each([
    ['UNIQUE', undefined, 'U', false], ['FIRST', undefined, 'F', true], ['PRIORITY', undefined, 'P', false],
    ['ANY', undefined, 'A', false], ['COLLECT', undefined, 'C', false], ['RULE ORDER', undefined, 'R', true],
    ['OUTPUT ORDER', undefined, 'O', false], ['COLLECT', 'SUM', 'C+', false], ['COLLECT', 'COUNT', 'C#', false],
    ['COLLECT', 'MIN', 'C<', false], ['COLLECT', 'MAX', 'C>', false],
  ])('%s %s → %s (order matters: %s)', (hitPolicy, aggregation, code, orderMatters) => {
    const hp = describeHitPolicy({ hitPolicy, aggregation });
    expect(hp.code).toBe(code);
    expect(hp.orderMatters).toBe(orderMatters);
    expect(hp.meaning).toBe(aggregation ? dmnLabels().aggregations[aggregation] : dmnLabels().hitPolicies[hitPolicy].meaning);
  });

  test('an absent hit policy is UNIQUE (the DMN 1.3 default), an aggregation outside COLLECT is ignored', () => {
    expect(describeHitPolicy({}).code).toBe('U');
    expect(describeHitPolicy({ hitPolicy: 'FIRST', aggregation: 'SUM' }).code).toBe('F');
  });

  test('the line under the title spells the policy out, with "order matters" for F and R', () => {
    expect(layoutDecisionTable(decision(simpleTable())).hitPolicyText).toBe('Hit policy: UNIQUE (U) – exactly one rule can match');
    expect(layoutDecisionTable(decision(simpleTable({ hitPolicy: 'FIRST' }))).hitPolicyText).toMatch(/\(order matters\)$/);
    expect(layoutDecisionTable(decision(simpleTable({ hitPolicy: 'RULE ORDER' }))).hitPolicyText).toMatch(/\(order matters\)$/);
    expect(layoutDecisionTable(decision(simpleTable({ hitPolicy: 'PRIORITY' }))).hitPolicyText).not.toMatch(/order matters/);
  });
});

describe('table.js — columns as dmn-js 17.12.3 heads them', () => {
  test('"#" column under the hit-policy letter, "When"/"And" inputs, "Then"/"And" outputs, values else type', () => {
    const m = layoutDecisionTable(claimDecision());
    expect(m.columns.map((c) => [c.role, c.clause, c.label, c.detail])).toEqual([
      ['index', '', 'U', ''],
      ['input', 'When', 'Claim amount', 'number'],
      ['input', 'And', 'Customer segment', '"premium","standard"'],
      ['output', 'Then', 'level', '"auto","clerk","manager"'],
    ]);
    expect(m.rows.map((r) => r.cells[0].text)).toEqual(['1', '2', '3', '4']);
  });

  test('an input without a label is headed by its expression; "-" and "" read as "–" and are marked any', () => {
    const m = layoutDecisionTable(decision(simpleTable({ inputs: [{ expression: 'score' }], rules: [{ when: [''], then: ['1'] }, { when: ['-'], then: ['2'] }, { when: ['> 1'], then: ['3'] }] })));
    expect(m.columns[1].label).toBe('score');
    expect(m.rows.map((r) => [r.cells[1].text, r.cells[1].any])).toEqual([['–', true], ['–', true], ['> 1', false]]);
    expect(isAnyEntry(' - ')).toBe(true);
  });

  test('the annotation column exists only when a rule carries an annotation', () => {
    const without = layoutDecisionTable(decision(simpleTable({ annotations: [{ name: 'Note' }] })));
    expect(without.columns.some((c) => c.role === 'annotation')).toBe(false);
    const withNote = layoutDecisionTable(loadFixture('discount-decision.json').nodes.find((n) => n.id === 'dec_discountLevel'));
    const ann = withNote.columns.filter((c) => c.role === 'annotation');
    expect(ann.map((c) => c.label)).toEqual(['Annotation']);
    expect(withNote.rows.map((r) => r.cells.at(-1).text)).toEqual(['Below threshold', 'Standard tier', 'Top tier']);
  });

  test('locale "de" changes every word, and nothing else', () => {
    const en = layoutDecisionTable(claimDecision());
    const de = layoutDecisionTable(claimDecision(), { locale: 'de' });
    expect(de.columns.map((c) => c.clause)).toEqual(['', 'Wenn', 'Und', 'Dann']);
    expect(de.hitPolicyText).toBe('Trefferrichtlinie: UNIQUE (U) – genau eine Regel kann zutreffen');
    expect(de.rows.map((r) => r.cells.map((c) => c.text))).toEqual(en.rows.map((r) => r.cells.map((c) => c.text)));
  });

  test('an unknown locale throws instead of falling back', () => {
    expect(() => layoutDecisionTable(claimDecision(), { locale: 'xx' })).toThrow(/no locale "xx"/);
    expect(() => dmnLabels('locale')).toThrow();
  });

  test('en and de carry the same label keys (one table, two languages)', () => {
    const keys = (o) => Object.keys(o).sort();
    expect(keys(dmnLabels('de'))).toEqual(keys(dmnLabels('en')));
    expect(keys(dmnLabels('de').hitPolicies)).toEqual(keys(dmnLabels('en').hitPolicies));
    expect(keys(dmnLabels('de').aggregations)).toEqual(keys(dmnLabels('en').aggregations));
  });
});

describe('table.js — geometry, computed once', () => {
  const S = DMN_TABLE_STYLE;
  test('columns tile the table width; widths stay within [min, max]; the index column is fixed', () => {
    const m = layoutDecisionTable(claimDecision(), { x: 7, y: 11 });
    let x = 7;
    for (const c of m.columns) {
      expect(c.x).toBe(x);
      x += c.w;
      if (c.role === 'index') expect(c.w).toBe(S.indexWidth);
      else { expect(c.w).toBeGreaterThanOrEqual(S.minColumnWidth); expect(c.w).toBeLessThanOrEqual(S.maxColumnWidth); }
    }
    expect(m.geometry.w).toBe(x - 7);
    expect(m.geometry.ioDividerX).toBe(m.columns.find((c) => c.role === 'output').x);
  });

  test('title, head and rows stack without gaps, every cell inside its row and column', () => {
    const m = layoutDecisionTable(claimDecision(), { x: 0, y: 0 });
    const g = m.geometry;
    expect(g.title.y).toBe(0);
    expect(g.head.y).toBe(g.title.h);
    let y = g.head.y + g.head.h;
    for (const row of m.rows) {
      expect(row.y).toBe(y);
      row.cells.forEach((cell, i) => {
        expect(cell).toMatchObject({ x: m.columns[i].x, y: row.y, w: m.columns[i].w, h: row.h });
      });
      y += row.h;
    }
    expect(g.h).toBe(y);
  });

  test('a long cell wraps instead of widening the column past its maximum', () => {
    const long = 'a very long condition text '.repeat(10);
    const m = layoutDecisionTable(decision(simpleTable({ rules: [{ when: [long], then: ['1'] }] })));
    expect(m.columns[1].w).toBe(S.maxColumnWidth);
    expect(m.rows[0].cells[1].lines.length).toBeGreaterThan(1);
  });

  test('stacking: every table below the previous one, stackGap apart, inside the margin', () => {
    const dc = loadFixture('roundtrip-all-fields.json');
    const stack = layoutDecisionTables(dc);
    expect(stack.tables.map((t) => t.decisionId)).toEqual(decisionsWithTables(dc).map((n) => n.id));
    expect(stack.tables[0].geometry.y).toBe(S.margin);
    for (let i = 1; i < stack.tables.length; i++) {
      const prev = stack.tables[i - 1].geometry;
      expect(stack.tables[i].geometry.y).toBe(prev.y + prev.h + S.stackGap);
    }
    const last = stack.tables.at(-1).geometry;
    expect(stack.size.h).toBe(last.y + last.h + S.margin);
  });

  test('a decision without a table cannot be laid out as one', () => {
    expect(() => layoutDecisionTable({ id: 'x', type: 'decision', name: 'X', expression: '1' })).toThrow(/no decisionTable/);
  });
});

describe('table-text.js — Markdown', () => {
  test('the claim-approval table, exactly', () => {
    expect(formatTableMarkdown(layoutDecisionTable(claimDecision()))).toBe([
      '### Approval level',
      '',
      'Hit policy: **UNIQUE (U)** – exactly one rule can match',
      '',
      '| U | When: Claim amount *(number)* | And: Customer segment *("premium","standard")* | Then: level *("auto","clerk","manager")* |',
      '|--:|:--|:--|:--|',
      '| 1 | < 1000 | – | "auto" |',
      '| 2 | [1000..10000) | "premium" | "clerk" |',
      '| 3 | [1000..10000) | "standard" | "manager" |',
      '| 4 | >= 10000 | – | "manager" |',
    ].join('\n'));
  });

  test('an aggregated COLLECT shows its indicator in backticks with the aggregation meaning', () => {
    const md = formatTableMarkdown(layoutDecisionTable(decision(simpleTable({ hitPolicy: 'COLLECT', aggregation: 'SUM' }))), { headingLevel: 0 });
    expect(md.split('\n')[0]).toBe('Hit policy: **COLLECT (`C+`)** – every matching rule applies; the result is the sum of their outputs');
    expect(md).toContain('| C+ |');
  });

  test('pipes are escaped, line breaks become spaces, emphasis and tags are neutralised', () => {
    expect(escapeMarkdownCell('a | b\nc *d* _e_ `f` <b> < 5 \\')).toBe('a \\| b c \\*d\\* \\_e\\_ \\`f\\` \\<b> < 5 \\\\');
    const md = formatTableMarkdown(layoutDecisionTable(decision(simpleTable({ rules: [{ when: ['"a|b"'], then: ['"x\ny"'] }] }))));
    const row = md.split('\n').at(-1);
    expect(row).toBe('| 1 | "a\\|b" | "x y" |');
    expect(row.split(/(?<!\\)\|/).length).toBe(5); // 3 cells, 4 unescaped pipes
  });

  test('German labels', () => {
    const md = formatTableMarkdown(layoutDecisionTable(claimDecision(), { locale: 'de' }));
    expect(md).toContain('| U | Wenn: Claim amount *(number)* | Und: Customer segment');
    expect(md).toContain('Dann: level');
  });
});

describe('table-text.js — plain text for a BPMN documentation', () => {
  test('aligned table: group line WHEN … || THEN, "||" between inputs and outputs', () => {
    expect(formatTablePlainText(layoutDecisionTable(claimDecision()))).toEqual([
      '  | WHEN          |                      || THEN',
      'U | Claim amount  | Customer segment     || level',
      '  | number        | "premium","standard" || "auto","clerk","manager"',
      '--+---------------+----------------------++-------------------------',
      '1 | < 1000        | –                    || "auto"',
      '2 | [1000..10000) | "premium"            || "clerk"',
      '3 | [1000..10000) | "standard"           || "manager"',
      '4 | >= 10000      | –                    || "manager"',
    ]);
  });

  test('wider than plainTextMaxWidth → one sentence per rule, "any" inputs left out', () => {
    expect(formatTablePlainText(layoutDecisionTable(claimDecision()), { maxWidth: 40 })).toEqual([
      'Rule 1: WHEN Claim amount < 1000 THEN level = "auto"',
      'Rule 2: WHEN Claim amount in [1000..10000) AND Customer segment = "premium" THEN level = "clerk"',
      'Rule 3: WHEN Claim amount in [1000..10000) AND Customer segment = "standard" THEN level = "manager"',
      'Rule 4: WHEN Claim amount >= 10000 THEN level = "manager"',
    ]);
  });

  test('sentences carry annotations; a rule matching anything has no WHEN; German words', () => {
    const m = layoutDecisionTable(decision(simpleTable({ annotations: [{ name: 'n' }], rules: [{ when: ['-'], then: ['"x"'], annotations: ['why'] }] })), { locale: 'de' });
    expect(formatTablePlainText(m, { maxWidth: 1 })).toEqual(['Regel 1: DANN class = "x" (why)']);
  });

  test('no line of the aligned form ends in a separator', () => {
    const m = layoutDecisionTable(loadFixture('discount-decision.json').nodes.find((n) => n.id === 'dec_discountLevel'));
    for (const line of formatTablePlainText(m)) expect(line).not.toMatch(/[|\s]$/);
  });
});

describe('table-svg.js and table-html.js — translations of the one layout', () => {
  const stack = () => layoutDecisionTables(loadFixture('discount-decision.json'));

  test('SVG: every cell is drawn at its model box, and nothing else is', () => {
    const s = stack();
    const svg = generateTablesSvg(s);
    const drawn = [...svg.matchAll(/<rect class="dmn-(?:head|cell) ([a-z]+)" x="([-\d.]+)" y="([-\d.]+)" width="([-\d.]+)" height="([-\d.]+)"/g)]
      .map((m) => `${m[1]} ${m[2]},${m[3]} ${m[4]}x${m[5]}`);
    const want = s.tables.flatMap((t) => [
      ...t.columns.map((c) => `${c.role} ${c.head.x},${c.head.y} ${c.head.w}x${c.head.h}`),
      ...t.rows.flatMap((r) => r.cells.map((c) => `${c.role} ${c.x},${c.y} ${c.w}x${c.h}`)),
    ]);
    expect(drawn.sort()).toEqual(want.sort());
    expect(svg).toContain(`viewBox="0 0 ${s.size.w} ${s.size.h}"`);
  });

  test('SVG: double line between inputs and outputs and under the head; colours from config', () => {
    const s = stack();
    const svg = generateTablesSvg(s);
    const g = s.tables[0].geometry;
    const half = DMN_TABLE_STYLE.doubleLineGap / 2;
    expect(svg).toContain(`<line x1="${g.ioDividerX - half}" y1="${g.head.y}"`);
    expect(svg).toContain(`<line x1="${g.ioDividerX + half}" y1="${g.head.y}"`);
    expect(svg).toContain(`fill="${DMN_TABLE_STYLE.inputHeadFill}"`);
    expect(svg).toContain(`fill="${DMN_TABLE_STYLE.outputCellFill}"`);
    expect(svg).toContain(`fill="${DMN_TABLE_STYLE.indexFill}"`);
  });

  test('HTML: one <table> per decision, column widths from the model, three-line heads, escaped text', () => {
    const dc = loadFixture('discount-decision.json');
    dc.nodes.find((n) => n.id === 'dec_discountLevel').decisionTable.rules[0].then = ['"<b>&"'];
    const s = layoutDecisionTables(dc);
    const html = generateTablesHtml(s, { title: dc.name });
    expect(html.match(/<table /g)).toHaveLength(s.tables.length);
    const widths = [...html.matchAll(/<col style="width:(\d+)px;">/g)].map((m) => +m[1]);
    expect(widths).toEqual(s.tables.flatMap((t) => t.columns.map((c) => c.w)));
    expect(html).toContain('&quot;&lt;b&gt;&amp;&quot;');
    expect(html).not.toContain('<b>&');
    expect(html).toMatch(/<th [^>]*><div[^>]*>When<\/div><div[^>]*>Order value<\/div><div[^>]*>number<\/div><\/th>/);
    expect(html).toContain(`${DMN_TABLE_STYLE.doubleLineGap}px double`);
    expect(html).not.toMatch(/<style|<script|class="/);
  });

  test('SVG escapes every text', () => {
    const dc = loadFixture('discount-decision.json');
    dc.nodes.find((n) => n.id === 'dec_discountLevel').name = 'A <b> & "c"';
    const svg = generateTablesSvg(layoutDecisionTables(dc));
    expect(svg).toContain('A &lt;b&gt; &amp; &quot;c&quot;');
    expect(svg).not.toContain('<b>');
  });
});

describe('doc.js — the --doc Markdown', () => {
  test('per decision: heading, question, inputs/outputs, the table; a literal expression as code', () => {
    const dc = loadFixture('discount-decision.json');
    const md = generateDmnMarkdown(dc, layoutDecisionTables(dc));
    expect(md).toMatch(/^# Discount decision\n/);
    expect(md).toContain('## Decision: Discount level\n\n**Question:** Which discount level applies to this order?');
    expect(md).toContain('- **Inputs:** Order value = orderValue (number)');
    expect(md).toContain('- **Outputs:** level (string, "none","bronze","silver")');
    expect(md).toContain('| U | When: Order value *(number)* | Then: level *("none","bronze","silver")* | Annotation |');
    expect(md).toContain('## Decision: Final percentage');
    expect(md).toContain('**Expression:** `base(discountLevel) + loyaltyBonus(customerSince)`');
  });
});

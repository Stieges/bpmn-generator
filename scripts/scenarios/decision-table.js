/**
 * Phase B — analysis of ONE DMN decision table (Decision-Core JSON, never DMN XML).
 *
 * Two independent jobs, deliberately kept apart in the result:
 *
 *   1. **Branching.** What "the outcomes of this table" means depends entirely on the hit
 *      policy, and getting that wrong is a category error rather than an inaccuracy. See
 *      `analyzeBranching` for the three-way split (UNIQUE / FIRST+PRIORITY /
 *      COLLECT+ANY+RULE ORDER+OUTPUT ORDER).
 *   2. **Coverage.** Gaps (input combinations no rule covers) and overlaps (combinations
 *      several rules cover), computed over a purpose-built, deliberately small condition
 *      grammar (see `parseUnaryTest`).
 *
 * **Every branch this module produces is symbolic/hypothetical, never a statement about
 * reachability.** Logic-Core hands a Business Rule Task only a `decisionRef`
 * (`references/input-schema.json`, `Node.decisionRef`) — it never carries input values,
 * and this module has no visibility into what the surrounding BPMN process would actually
 * feed the table. "There is a branch for rule r2" therefore means "IF the inputs fell into
 * r2's region, this outcome would result", not "the process can reach this outcome". A
 * consumer that presents these as reachable outcomes is misreporting them; the flag
 * `branching.symbolic === true` is on every result so that cannot happen by accident.
 *
 * **The grammar is small on purpose and never guesses.** It covers exactly four forms
 * (comparison, interval, enumeration, wildcard) over exactly three domains (number, date,
 * string). Anything else — nested lists, function calls, `and`/`or` inside one unary test,
 * arithmetic, variable references — is reported as "not analyzable" and the rule carrying
 * it is dropped from BOTH gap and overlap analysis in its entirety, never column by
 * column. Column-wise analysis would be unsafe rather than merely incomplete: it would
 * report gaps that a hidden condition in the ignored column actually rules out, i.e. a
 * wrong answer delivered with full confidence. Declining to answer is the cheaper failure.
 *
 * Scope: one already-identified table, handed in by the caller. Resolving `decisionRef` /
 * `usingTask` against a Logic-Core process is Task 4's job and is not done here.
 */

import { CFG } from '../shared/utils.js';

const DEFAULTS = {
  // Cap on the number of cross-product cells the gap check will examine. A table with one
  // or two input columns never comes close (see `partitionCells`); only pathological
  // many-column tables do, and those get an honest "not attempted", never a partial answer.
  maxPartitionCells: 20_000,
};

/** Hit policies for which one branch per rule is the right model. */
const PER_RULE_POLICIES = new Set(['UNIQUE', 'FIRST', 'PRIORITY']);
/** Hit policies whose branches would overestimate: overlap is legal, domination undetected. */
const OVERESTIMATING_POLICIES = new Set(['FIRST', 'PRIORITY']);
/** Hit policies under which several rules fire for ONE input and their results combine. */
const AGGREGATING_POLICIES = new Set(['COLLECT', 'ANY', 'RULE ORDER', 'OUTPUT ORDER']);

// ═══════════════════════════════════════════════════════════════════════
// The condition grammar
// ═══════════════════════════════════════════════════════════════════════

/**
 * A parsed unary test. One of three shapes, discriminated by `kind`:
 *
 *   - `{kind: 'any'}` — matches every value of the column.
 *   - `{kind: 'ranges', domain: 'number'|'date', ranges: Range[]}` — a union of intervals
 *     over an ORDERED domain. A single comparison (`< 100`) is a one-element union with an
 *     open end; `= 100` is the degenerate interval `[100..100]`; `1,2,3` is three of them.
 *   - `{kind: 'enum', domain: 'string', values: string[]}` — an unordered set of literals.
 *
 * A `Range` is `{lo: Endpoint|null, hi: Endpoint|null}`, where `null` means unbounded on
 * that side and an `Endpoint` is `{v: number, raw: string, inclusive: boolean}`. Dates live
 * in the same shape: `v` is the epoch millisecond value, `raw` the source text, so a date
 * column is an ordered domain exactly like a numeric one rather than an opaque string set.
 *
 * @typedef {object} Predicate
 */

const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const DATE_RE = /^date\s*\(\s*(["'])([^"']*)\1\s*\)$/i;
const STRING_RE = /^(["'])([^"']*)\1$/;

/**
 * Parse a single literal into a typed value.
 *
 * @param {string} text
 * @returns {{domain: 'number'|'date'|'string', v?: number, s?: string, raw: string}|null}
 *   null when the literal is outside the grammar — never a guess.
 */
export function parseValue(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;

  const date = DATE_RE.exec(t);
  if (date) {
    // `date("2020-01-01")` — only the ISO calendar-date form. A parse failure here (e.g.
    // `date("yesterday")`) is a grammar failure, not a zero: Date.parse returns NaN and we
    // decline rather than order the column by NaN.
    const ms = Date.parse(`${date[2]}T00:00:00Z`);
    if (Number.isNaN(ms)) return null;
    return { domain: 'date', v: ms, raw: t };
  }

  if (NUMBER_RE.test(t)) return { domain: 'number', v: Number(t), raw: t };

  const str = STRING_RE.exec(t);
  if (str) return { domain: 'string', s: str[2], raw: t };

  return null;
}

/**
 * Split a comma-separated list at top level, respecting quotes and parentheses.
 *
 * `date("2020-01-01")` contains no comma, but a future endpoint form might; parenthesis
 * depth is tracked so the split never cuts a literal in half.
 *
 * @param {string} text
 * @returns {string[]|null} null when quoting or nesting is unbalanced.
 */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0, quote = null, buf = '';
  for (const ch of text) {
    if (quote) {
      buf += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
    if (ch === '(' || ch === '[') { depth++; buf += ch; continue; }
    if (ch === ')' || ch === ']') { depth--; buf += ch; continue; }
    if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  if (quote || depth !== 0) return null;
  parts.push(buf);
  return parts;
}

/** A degenerate interval `[v..v]` — the representation of an equality test. */
const pointRange = (val) => ({
  lo: { v: val.v, raw: val.raw, inclusive: true },
  hi: { v: val.v, raw: val.raw, inclusive: true },
});

/**
 * Parse one unary test (a `when` cell, or an `allowedValues` string) into a `Predicate`.
 *
 * Grammar, complete:
 *
 *   wildcard   := "-" | ""                          (the whole cell, after trimming)
 *   comparison := ("<" | "<=" | ">" | ">=" | "=") value
 *   interval   := ("[" | "(") value ".." value ("]" | ")")
 *   list       := item ("," item)*                  (all items the same domain)
 *   item       := value | interval
 *   value      := number | date("YYYY-MM-DD") | "string"
 *
 * **Ambiguity 1 — is a lone `-` the wildcard or a minus sign?** Resolved: the wildcard is
 * the string `-` and NOTHING else, after trimming. There is no real ambiguity once that is
 * required, because a negative number always has a digit or a decimal point immediately
 * after its sign (`-5`, `-3.2`, `-.5`); a sign with nothing following it is not a number in
 * any notation. So the check "trimmed cell is exactly one character, and it is `-`" cannot
 * misclassify a negative literal, and `-5` continues to parse as the number −5. An empty
 * cell is treated as the wildcard too: DMN renders "matches anything" as an empty cell just
 * as often as it renders it as a dash, and an empty cell cannot be any other test.
 *
 * **Ambiguity 2 — does a bare `100` mean `= 100`?** Resolved: yes. This is not a house
 * convention but FEEL's own semantics — DMN 1.3 §7.3.2 defines a unary test consisting of a
 * bare endpoint as an implicit equality against the input expression (`?  = 100`), which is
 * exactly why real decision tables write `100` and `"Gold"` rather than `= 100` and
 * `= "Gold"`. Following anything else here would misread the majority of real tables. A
 * bare literal therefore becomes the degenerate interval `[100..100]` (ordered domains) or a
 * one-element enumeration (strings), and `= 100` parses to the identical predicate.
 *
 * @param {string} text
 * @returns {Predicate|null} null when the text is outside the grammar. Callers MUST treat
 *   null as "this whole rule is not analyzable" — see the module header.
 */
export function parseUnaryTest(text) {
  const t = String(text ?? '').trim();
  if (t === '' || t === '-') return { kind: 'any' };

  const items = splitTopLevel(t);
  if (!items) return null;

  const ranges = [];
  const values = [];
  let domain = null;

  for (const rawItem of items) {
    const item = rawItem.trim();
    if (!item) return null;
    const parsed = parseItem(item);
    if (!parsed) return null;
    if (domain && parsed.domain !== domain) return null; // mixed-domain list: not analyzable
    domain = parsed.domain;
    if (parsed.kind === 'range') ranges.push(parsed.range);
    else values.push(parsed.value);
  }

  if (domain === 'string') return { kind: 'enum', domain: 'string', values };
  return { kind: 'ranges', domain, ranges };
}

const INTERVAL_RE = /^([[(])\s*(.+?)\s*\.\.\s*(.+?)\s*([\])])$/;
const COMPARISON_RE = /^(<=|>=|<|>|=)\s*(.+)$/;

/**
 * Parse one item of a (possibly single-element) comma list: a comparison, an interval, or a
 * bare literal.
 *
 * @param {string} item
 * @returns {{kind:'range', domain, range}|{kind:'value', domain, value:string}|null}
 */
function parseItem(item) {
  const interval = INTERVAL_RE.exec(item);
  if (interval) {
    const lo = parseValue(interval[2]);
    const hi = parseValue(interval[3]);
    if (!lo || !hi) return null;
    // Intervals exist only over ordered domains. `["a".."b"]` is legal FEEL but string
    // ordering is locale-dependent and no table in practice relies on it — decline.
    if (lo.domain === 'string' || hi.domain === 'string') return null;
    if (lo.domain !== hi.domain) return null;
    if (lo.v > hi.v) return null; // empty/reversed interval: almost certainly a typo, not ours to fix
    return {
      kind: 'range',
      domain: lo.domain,
      range: {
        lo: { v: lo.v, raw: lo.raw, inclusive: interval[1] === '[' },
        hi: { v: hi.v, raw: hi.raw, inclusive: interval[4] === ']' },
      },
    };
  }

  const cmp = COMPARISON_RE.exec(item);
  if (cmp) {
    const val = parseValue(cmp[2]);
    if (!val) return null;
    const op = cmp[1];
    if (val.domain === 'string') {
      // Only `=` is meaningful for an unordered domain; `< "Gold"` is declined rather than
      // silently ordered lexicographically.
      if (op !== '=') return null;
      return { kind: 'value', domain: 'string', value: val.s };
    }
    const point = { v: val.v, raw: val.raw };
    switch (op) {
      case '<': return { kind: 'range', domain: val.domain, range: { lo: null, hi: { ...point, inclusive: false } } };
      case '<=': return { kind: 'range', domain: val.domain, range: { lo: null, hi: { ...point, inclusive: true } } };
      case '>': return { kind: 'range', domain: val.domain, range: { lo: { ...point, inclusive: false }, hi: null } };
      case '>=': return { kind: 'range', domain: val.domain, range: { lo: { ...point, inclusive: true }, hi: null } };
      default: return { kind: 'range', domain: val.domain, range: pointRange(val) };
    }
  }

  // Bare literal — implicit equality, see ambiguity 2 in `parseUnaryTest`'s doc.
  const val = parseValue(item);
  if (!val) return null;
  if (val.domain === 'string') return { kind: 'value', domain: 'string', value: val.s };
  return { kind: 'range', domain: val.domain, range: pointRange(val) };
}

// ═══════════════════════════════════════════════════════════════════════
// Interval algebra
// ═══════════════════════════════════════════════════════════════════════

/** The greater of two lower endpoints (null = −∞). */
function maxLo(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.v > b.v) return a;
  if (b.v > a.v) return b;
  return a.inclusive ? b : a; // same value: the exclusive one is the stricter bound
}

/** The lesser of two upper endpoints (null = +∞). */
function minHi(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.v < b.v) return a;
  if (b.v < a.v) return b;
  return a.inclusive ? b : a;
}

/** Does `[lo..hi]` contain at least one value? */
function nonEmpty(lo, hi) {
  if (!lo || !hi) return true;
  if (lo.v < hi.v) return true;
  return lo.v === hi.v && lo.inclusive && hi.inclusive;
}

/** Do two ranges of the same domain share at least one value? */
function rangesIntersect(a, b) {
  return nonEmpty(maxLo(a.lo, b.lo), minHi(a.hi, b.hi));
}

/**
 * Do two predicates over the same column share at least one value?
 *
 * Mismatched domains (a numeric range against a string enumeration) report `false`. That is
 * the conservative direction for overlap detection: an overlap is only ever claimed when it
 * demonstrably exists, and a column mixing domains is reported separately as a gap-analysis
 * obstacle rather than silently intersected.
 *
 * @param {Predicate} a
 * @param {Predicate} b
 * @returns {boolean}
 */
export function predicatesIntersect(a, b) {
  if (a.kind === 'any' || b.kind === 'any') return true;
  if (a.kind !== b.kind || a.domain !== b.domain) return false;
  if (a.kind === 'enum') return a.values.some(v => b.values.includes(v));
  return a.ranges.some(ra => b.ranges.some(rb => rangesIntersect(ra, rb)));
}

/** Is the whole ordered cell inside the range? (`null` endpoints are ±∞.) */
function cellInRange(cell, r) {
  const loOk = !r.lo || (cell.lo && (cell.lo.v > r.lo.v
    || (cell.lo.v === r.lo.v && (r.lo.inclusive || !cell.lo.inclusive))));
  const hiOk = !r.hi || (cell.hi && (cell.hi.v < r.hi.v
    || (cell.hi.v === r.hi.v && (r.hi.inclusive || !cell.hi.inclusive))));
  return Boolean(loOk && hiOk);
}

/**
 * Does the predicate cover the whole partition cell?
 *
 * Cells are built from the union of ALL predicate boundaries in the column (see
 * `partitionCells`), so no predicate can cut a cell in two: for these cells "intersects"
 * and "contains" coincide. Containment is used anyway, because it is the property the
 * coverage claim actually needs.
 *
 * @param {Predicate} pred
 * @param {object} cell - `{type:'any'}`, `{type:'ordered', domain, lo, hi}` or
 *   `{type:'value', domain:'string', value}`
 * @returns {boolean}
 */
export function predicateCoversCell(pred, cell) {
  if (pred.kind === 'any') return true;
  if (cell.type === 'any') return false; // an unbounded cell is only covered by a wildcard
  if (cell.type === 'value') return pred.kind === 'enum' && pred.values.includes(cell.value);
  if (pred.kind !== 'ranges' || pred.domain !== cell.domain) return false;
  return pred.ranges.some(r => cellInRange(cell, r));
}

// ═══════════════════════════════════════════════════════════════════════
// Rule parsing
// ═══════════════════════════════════════════════════════════════════════

/**
 * Parse every `when` cell of every rule, at RULE granularity.
 *
 * The all-or-nothing boundary lives here and nowhere else: a rule appears in
 * `analyzable` only when every one of its clauses parsed, otherwise it appears in
 * `unanalyzable` with the offending column named. No caller ever sees a half-parsed rule.
 *
 * @param {object} table - a Decision-Core `decisionTable`
 * @returns {{analyzable: Array<object>, unanalyzable: Array<object>}}
 */
export function parseRules(table) {
  const inputs = table.inputs || [];
  const rules = table.rules || [];
  const analyzable = [];
  const unanalyzable = [];

  rules.forEach((rule, index) => {
    const ruleId = rule.id || `#${index}`;
    const when = rule.when || [];

    if (when.length !== inputs.length) {
      unanalyzable.push({
        ruleId, ruleIndex: index, columnIndex: null,
        reason: `rule has ${when.length} unary test(s) but the table declares ${inputs.length} input column(s)`,
      });
      return;
    }

    const predicates = [];
    let failed = null;
    for (let i = 0; i < when.length && !failed; i++) {
      const pred = parseUnaryTest(when[i]);
      if (!pred) failed = { columnIndex: i, text: when[i] };
      else predicates.push(pred);
    }

    if (failed) {
      unanalyzable.push({
        ruleId, ruleIndex: index, columnIndex: failed.columnIndex,
        reason: `unary test outside the supported grammar in input column ${failed.columnIndex}: ${JSON.stringify(failed.text)}`,
      });
      return;
    }

    analyzable.push({ ruleId, ruleIndex: index, rule, predicates });
  });

  return { analyzable, unanalyzable };
}

// ═══════════════════════════════════════════════════════════════════════
// Column partitions
// ═══════════════════════════════════════════════════════════════════════

const infDesc = (endpoint, side) => {
  if (!endpoint) return side === 'lo' ? '(-∞' : '+∞)';
  return side === 'lo'
    ? `${endpoint.inclusive ? '[' : '('}${endpoint.raw}`
    : `${endpoint.raw}${endpoint.inclusive ? ']' : ')'}`;
};

/** Human-readable form of one ordered cell or merged cell run, e.g. `[100..500)`. */
function describeOrdered(lo, hi) {
  return `${infDesc(lo, 'lo')}..${infDesc(hi, 'hi')}`;
}

/**
 * Build the partition of ONE input column into atomic cells.
 *
 * Ordered domains (number, date): every distinct endpoint appearing in any rule predicate
 * (and in `allowedValues`, when it declares a range) becomes a breakpoint; the cells are the
 * open intervals between consecutive breakpoints plus the degenerate `[b..b]` cell at each
 * breakpoint plus the two unbounded ends. That partition is fine enough that every predicate
 * of the column is a union of whole cells — which is what makes "cover every cell" equal to
 * "cover every value".
 *
 * Unordered domain (string): the cells ARE the declared allowed values. Without a declared
 * domain the column has no finite partition and this returns `{cells: null, reason}` — the
 * asymmetry the plan calls out: overlap stays computable, gaps do not, because nobody can
 * know whether `"Platinum"` is missing from a set nobody declared.
 *
 * @param {object} input - the `InputClause`
 * @param {Predicate[]} predicates - this column's predicate from every analyzable rule
 * @param {number} columnIndex
 * @returns {{cells: Array<object>|null, reason: string|null, domain: string}}
 */
export function partitionCells(input, predicates, columnIndex) {
  const allowed = input && input.allowedValues ? parseUnaryTest(input.allowedValues) : null;
  const contributing = predicates.filter(p => p.kind !== 'any');
  if (allowed && allowed.kind !== 'any') contributing.push(allowed);

  const domains = new Set(contributing.map(p => p.domain));
  if (domains.size > 1) {
    return {
      cells: null, domain: 'mixed',
      reason: `input column ${columnIndex} mixes value domains (${[...domains].sort().join(', ')}), so it has no single ordered or enumerated partition`,
    };
  }

  // No rule constrains this column at all (all wildcards, no declared domain): the whole
  // column is one cell, and any wildcard covers it. This is correct, not a fallback.
  if (domains.size === 0) return { cells: [{ type: 'any' }], reason: null, domain: 'any' };

  const domain = [...domains][0];

  if (domain === 'string') {
    if (!allowed || allowed.kind !== 'enum') {
      return {
        cells: null, domain,
        reason: `input column ${columnIndex} is a string column without a declared domain (no parseable allowedValues), so no gap statement can be made for it`,
      };
    }
    return {
      cells: allowed.values.map(value => ({ type: 'value', domain, value, describe: JSON.stringify(value) })),
      reason: null, domain,
    };
  }

  // Ordered domain: collect breakpoints from every range endpoint.
  const points = new Map(); // v → raw
  for (const pred of contributing) {
    for (const r of pred.ranges) {
      if (r.lo) points.set(r.lo.v, r.lo.raw);
      if (r.hi) points.set(r.hi.v, r.hi.raw);
    }
  }
  const sorted = [...points.keys()].sort((a, b) => a - b);

  const cells = [];
  const mk = (lo, hi) => cells.push({
    type: 'ordered', domain, lo, hi, describe: describeOrdered(lo, hi),
  });

  if (sorted.length === 0) { mk(null, null); }
  else {
    mk(null, { v: sorted[0], raw: points.get(sorted[0]), inclusive: false });
    for (let i = 0; i < sorted.length; i++) {
      const v = sorted[i], raw = points.get(v);
      mk({ v, raw, inclusive: true }, { v, raw, inclusive: true });
      if (i + 1 < sorted.length) {
        const n = sorted[i + 1];
        mk({ v, raw, inclusive: false }, { v: n, raw: points.get(n), inclusive: false });
      }
    }
    const last = sorted[sorted.length - 1];
    mk({ v: last, raw: points.get(last), inclusive: false }, null);
  }

  // A declared numeric/date domain narrows the edges: values outside it cannot occur, so a
  // cell no allowed range covers is not a gap, it is out of scope.
  if (allowed && allowed.kind === 'ranges') {
    return { cells: cells.filter(c => allowed.ranges.some(r => cellInRange(c, r))), reason: null, domain };
  }
  return { cells, reason: null, domain };
}

// ═══════════════════════════════════════════════════════════════════════
// Gaps and overlaps
// ═══════════════════════════════════════════════════════════════════════

/**
 * Merge adjacent uncovered cells back into readable regions.
 *
 * Purely presentational: the gap SET is exact either way, this only stops a single missing
 * band from being reported as five neighbouring slivers (`[100..100]`, `(100..500)`, …
 * instead of `[100..500)`). One merging sweep per dimension, greedy over runs of
 * consecutive cell indices with all other coordinates equal. Optimal rectangular
 * decomposition of a hole in n dimensions is a much harder problem and is not attempted;
 * with n = 1 (the common case) the sweep is exact.
 *
 * @param {Array<number[]>} gapTuples - each an index per column
 * @param {Array<Array<object>>} columnCells
 * @returns {Array<Array<{from: number, to: number}>>}
 */
function mergeGapRegions(gapTuples, columnCells) {
  let regions = gapTuples.map(t => t.map(i => ({ from: i, to: i })));
  for (let d = 0; d < columnCells.length; d++) {
    const groups = new Map();
    for (const region of regions) {
      const key = region.map((r, i) => (i === d ? '*' : `${r.from}-${r.to}`)).join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(region);
    }
    const merged = [];
    for (const group of groups.values()) {
      group.sort((a, b) => a[d].from - b[d].from);
      let current = null;
      for (const region of group) {
        if (current && region[d].from === current[d].to + 1) current[d] = { from: current[d].from, to: region[d].to };
        else { if (current) merged.push(current); current = region.map(r => ({ ...r })); }
      }
      if (current) merged.push(current);
    }
    regions = merged;
  }
  return regions;
}

/** Describe a merged run of cells in one column. */
function describeRegion(cells, run) {
  const first = cells[run.from], last = cells[run.to];
  if (first.type === 'any') return '-';
  if (first.type === 'value') {
    return cells.slice(run.from, run.to + 1).map(c => c.describe).join(',');
  }
  return describeOrdered(first.lo, last.hi);
}

/**
 * Exact pairwise overlap detection — O(rules² × columns), no combinatorial risk.
 *
 * @param {Array<object>} analyzable - as produced by `parseRules`
 * @param {Array<object>} inputs
 * @returns {Array<object>} one entry per overlapping rule pair
 */
export function findOverlaps(analyzable, inputs) {
  const overlaps = [];
  for (let i = 0; i < analyzable.length; i++) {
    for (let j = i + 1; j < analyzable.length; j++) {
      const a = analyzable[i], b = analyzable[j];
      // A table with zero input columns is covered by this loop trivially: with nothing to
      // disagree about, every pair of rules does overlap, which is the truth.
      const all = a.predicates.every((p, c) => predicatesIntersect(p, b.predicates[c]));
      if (!all) continue;
      overlaps.push({
        ruleIds: [a.ruleId, b.ruleId],
        ruleIndices: [a.ruleIndex, b.ruleIndex],
        columns: a.predicates.map((p, c) => ({
          inputIndex: c,
          label: (inputs[c] && (inputs[c].label || inputs[c].expression)) || null,
          tests: [a.rule.when[c], b.rule.when[c]],
        })),
      });
    }
  }
  return overlaps;
}

/**
 * Gap detection over the cross-product of the per-column partitions.
 *
 * Refuses rather than approximates in four situations, each reported with a reason code:
 *   - `unanalyzable-rule` — some rule of the table is outside the grammar; a gap claim would
 *     ignore whatever that rule covers and could therefore be plainly wrong.
 *   - `unbounded-domain` — a string column with no declared domain (or a column mixing
 *     domains). Overlap detection is unaffected and still runs.
 *   - `cap-exceeded` — the cross-product exceeds `maxPartitionCells`. The actual cell count
 *     is reported so the caller can raise the cap knowingly.
 *   - `no-rules` — nothing to analyze.
 *
 * @param {object} table
 * @param {Array<object>} analyzable
 * @param {Array<object>} unanalyzable
 * @param {number} cellCap
 * @returns {{gaps: Array<object>|null, reason: object|null, cellCount: number|null,
 *   columnsAnalyzed: number[], columnsSkipped: Array<{inputIndex, reason}>}}
 */
export function findGaps(table, analyzable, unanalyzable, cellCap) {
  const inputs = table.inputs || [];
  const base = { gaps: null, cellCount: null, columnsAnalyzed: [], columnsSkipped: [] };

  if (unanalyzable.length > 0) {
    return {
      ...base,
      reason: {
        code: 'unanalyzable-rule',
        message: `${unanalyzable.length} rule(s) are outside the supported grammar; a coverage claim that ignored them could report gaps those rules actually cover`,
        ruleIds: unanalyzable.map(u => u.ruleId),
      },
    };
  }
  if (analyzable.length === 0) {
    return { ...base, reason: { code: 'no-rules', message: 'the table has no rules to analyze' } };
  }

  const columnCells = [];
  const columnsSkipped = [];
  const columnsAnalyzed = [];
  for (let c = 0; c < inputs.length; c++) {
    const part = partitionCells(inputs[c], analyzable.map(r => r.predicates[c]), c);
    if (!part.cells) { columnsSkipped.push({ inputIndex: c, reason: part.reason }); continue; }
    columnCells.push({ inputIndex: c, cells: part.cells });
    columnsAnalyzed.push(c);
  }

  if (columnsSkipped.length > 0) {
    return {
      ...base, columnsAnalyzed, columnsSkipped,
      reason: {
        code: 'unbounded-domain',
        message: `no gap statement is possible while ${columnsSkipped.length} input column(s) have no computable domain: ${columnsSkipped.map(s => s.reason).join('; ')}`,
        columns: columnsSkipped.map(s => s.inputIndex),
      },
    };
  }

  const cellCount = columnCells.reduce((n, col) => n * col.cells.length, 1);
  if (cellCount > cellCap) {
    return {
      ...base, columnsAnalyzed, columnsSkipped,
      cellCount,
      reason: {
        code: 'cap-exceeded',
        message: `gap analysis not attempted: the input space partitions into ${cellCount} cells, above the cap of ${cellCap}`,
        cellCount, cap: cellCap,
      },
    };
  }

  // Walk the cross-product. A cell tuple is covered when SOME analyzable rule covers it in
  // EVERY column — cells are atomic, so no combination of two rules can cover a cell that
  // neither covers alone.
  const cellsPerColumn = columnCells.map(col => col.cells);
  const gapTuples = [];
  const indices = new Array(cellsPerColumn.length).fill(0);
  const total = cellCount;
  for (let n = 0; n < total; n++) {
    let rest = n;
    for (let d = cellsPerColumn.length - 1; d >= 0; d--) {
      indices[d] = rest % cellsPerColumn[d].length;
      rest = Math.floor(rest / cellsPerColumn[d].length);
    }
    const covered = analyzable.some(r =>
      cellsPerColumn.every((cells, d) =>
        predicateCoversCell(r.predicates[columnCells[d].inputIndex], cells[indices[d]])));
    if (!covered) gapTuples.push([...indices]);
  }

  const regions = mergeGapRegions(gapTuples, cellsPerColumn);
  const gaps = regions.map(region => ({
    columns: region.map((run, d) => ({
      inputIndex: columnCells[d].inputIndex,
      label: (inputs[columnCells[d].inputIndex]
        && (inputs[columnCells[d].inputIndex].label || inputs[columnCells[d].inputIndex].expression)) || null,
      describe: describeRegion(cellsPerColumn[d], run),
    })),
    describe: region.map((run, d) => describeRegion(cellsPerColumn[d], run)).join(' × '),
  }));

  return { gaps, reason: null, cellCount, columnsAnalyzed, columnsSkipped };
}

// ═══════════════════════════════════════════════════════════════════════
// Hit-policy-aware branching
// ═══════════════════════════════════════════════════════════════════════

/**
 * Turn a table into its branching description, per hit policy.
 *
 * Three shapes, and a consumer must switch on `kind` before reading anything else:
 *
 *   - `kind: 'per-rule'` (UNIQUE, FIRST, PRIORITY) — `branches` holds one entry per rule,
 *     `aggregated` is null. `exact` is true only for UNIQUE. For FIRST and PRIORITY every
 *     branch carries `mayOverestimate: true`: overlap is legal there, so a rule that is
 *     always beaten by an earlier / higher-priority one never actually wins, and detecting
 *     that domination is a substantially harder analysis this module does not perform. The
 *     branch list is therefore an upper bound on the reachable outcomes, flagged as such.
 *   - `kind: 'aggregated'` (COLLECT, ANY, RULE ORDER, OUTPUT ORDER) — `branches` is null and
 *     `aggregated` describes ONE combined outcome. Several rules match the same input
 *     simultaneously and their results are collected (optionally reduced by
 *     `aggregation`), so presenting them as mutually exclusive branches would not be an
 *     approximation but a different claim about the table's meaning.
 *   - `kind: 'unknown-policy'` — the `hitPolicy` string is not one of DMN's seven. Neither
 *     shape is asserted; nothing is guessed.
 *
 * @param {object} table
 * @returns {object} the `branching` member of the analysis result
 */
export function analyzeBranching(table) {
  const hitPolicy = table.hitPolicy || 'UNIQUE'; // schema default, decision-core-schema.json
  const aggregation = table.aggregation || null;
  const rules = table.rules || [];
  const outputs = table.outputs || [];

  const outcomeOf = (rule) => (rule.then || []).map((value, i) => ({
    outputIndex: i,
    name: (outputs[i] && (outputs[i].name || outputs[i].id)) || null,
    value,
  }));

  if (PER_RULE_POLICIES.has(hitPolicy)) {
    const mayOverestimate = OVERESTIMATING_POLICIES.has(hitPolicy);
    return {
      kind: 'per-rule',
      hitPolicy,
      aggregation,
      symbolic: true,
      exact: hitPolicy === 'UNIQUE',
      mayOverestimate,
      branches: rules.map((rule, index) => ({
        ruleId: rule.id || `#${index}`,
        ruleIndex: index,
        condition: (rule.when || []).map((text, c) => ({
          inputIndex: c,
          label: ((table.inputs || [])[c] && (table.inputs[c].label || table.inputs[c].expression)) || null,
          test: text,
        })),
        outcome: outcomeOf(rule),
        mayOverestimate,
      })),
      aggregated: null,
      note: hitPolicy === 'UNIQUE'
        ? 'UNIQUE forbids overlap, so one branch per rule is exact — but check `overlaps`: an overlapping UNIQUE table is invalid, not re-interpreted here.'
        : `${hitPolicy} permits overlapping rules; a dominated rule never wins for any input and this module does not detect domination, so the branch list is an upper bound.`,
    };
  }

  if (AGGREGATING_POLICIES.has(hitPolicy)) {
    return {
      kind: 'aggregated',
      hitPolicy,
      aggregation,
      symbolic: true,
      exact: false,
      mayOverestimate: false,
      branches: null,
      aggregated: {
        hitPolicy,
        aggregation,
        contributingRuleIds: rules.map((r, i) => r.id || `#${i}`),
        outputNames: outputs.map((o, i) => o.name || o.id || `#${i}`),
        note: hitPolicy === 'COLLECT'
          ? `several rules can match one input and their results are collected${aggregation ? ` and reduced with ${aggregation}` : ' as a list'}; there is one combined outcome, not one per rule.`
          : `under ${hitPolicy} several rules can match one input and the results are combined into a single outcome; per-rule branches would misstate the table's semantics.`,
      },
      note: 'No per-rule branches exist for this hit policy — read `aggregated`.',
    };
  }

  return {
    kind: 'unknown-policy',
    hitPolicy,
    aggregation,
    symbolic: true,
    exact: false,
    mayOverestimate: false,
    branches: null,
    aggregated: null,
    note: `hitPolicy ${JSON.stringify(hitPolicy)} is not one of DMN's seven; no branching shape is asserted.`,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════

/**
 * The result of analyzing one decision table. Stable contract — Tasks 4, 5 and 6 read it.
 *
 * @typedef {object} DecisionTableAnalysis
 * @property {string|null} tableId - `table.id`, passed through.
 * @property {string} hitPolicy - effective policy (`UNIQUE` when absent, per the schema).
 * @property {string|null} aggregation - only meaningful with COLLECT.
 * @property {object} branching - see `analyzeBranching`. ALWAYS switch on `branching.kind`
 *   (`per-rule` | `aggregated` | `unknown-policy`) before reading `branches`/`aggregated`;
 *   the unused one is `null`, so a consumer cannot silently treat an aggregated table as a
 *   set of exclusive branches. `branching.symbolic` is always true — see the module header.
 * @property {Array<object>} overlaps - one entry per overlapping rule PAIR, exact, and
 *   computed independently of gap analysis: `{ruleIds, ruleIndices, columns:[{inputIndex,
 *   label, tests}]}`. Empty array means "no overlap among the analyzable rules" — read
 *   `unanalyzableRules` to know whether that was all of them.
 * @property {Array<object>|null} gaps - `null` NEVER stands alone: whenever it is null,
 *   `gapAnalysis.reason` says why (`unanalyzable-rule`, `unbounded-domain`, `cap-exceeded`,
 *   `no-rules`). An empty ARRAY is the positive statement "no gaps": every cell of the
 *   input space is covered. Each gap is `{columns:[{inputIndex, label, describe}],
 *   describe}` where `describe` is a readable region like `[100..500)` or `[100..500) ×
 *   "Gold"`.
 * @property {object} gapAnalysis - `{attempted, reason, cellCount, cellCap, columnsAnalyzed,
 *   columnsSkipped}`. `columnsAnalyzed` is an array of input indices; `columnsSkipped` is
 *   `[{inputIndex, reason}]`.
 * @property {Array<object>} unanalyzableRules - `[{ruleId, ruleIndex, columnIndex, reason}]`.
 *   These rules took part in NEITHER gap nor overlap analysis — all or nothing per rule.
 * @property {object} stats - `{ruleCount, analyzableRuleCount, inputCount, outputCount}`.
 */

/**
 * Analyze ONE decision table.
 *
 * @param {object} table - a Decision-Core `decisionTable` object (the value of
 *   `node.decisionTable`), NOT a whole Decision-Core document and NOT DMN XML.
 * @param {object} [options]
 * @param {number} [options.maxPartitionCells] - cap on the cross-product cell count the gap
 *   check will examine. Default: `config.json → scenarios.decisionTable.maxPartitionCells`.
 * @param {object} [options.config] - config object to read that block from; defaults to the
 *   loaded `CFG`.
 * @returns {DecisionTableAnalysis}
 */
export function analyzeDecisionTable(table, options = {}) {
  if (!table || typeof table !== 'object') throw new TypeError('analyzeDecisionTable: a decision table object is required');

  const cfg = { ...DEFAULTS, ...((((options.config || CFG) || {}).scenarios || {}).decisionTable || {}) };
  const cellCap = options.maxPartitionCells ?? cfg.maxPartitionCells;

  const inputs = table.inputs || [];
  const outputs = table.outputs || [];
  const rules = table.rules || [];

  const { analyzable, unanalyzable } = parseRules(table);
  const overlaps = findOverlaps(analyzable, inputs);
  const gapResult = findGaps(table, analyzable, unanalyzable, cellCap);

  return {
    tableId: table.id || null,
    hitPolicy: table.hitPolicy || 'UNIQUE',
    aggregation: table.aggregation || null,
    branching: analyzeBranching(table),
    overlaps,
    gaps: gapResult.gaps,
    gapAnalysis: {
      attempted: gapResult.gaps !== null,
      reason: gapResult.reason,
      cellCount: gapResult.cellCount,
      cellCap,
      columnsAnalyzed: gapResult.columnsAnalyzed,
      columnsSkipped: gapResult.columnsSkipped,
    },
    unanalyzableRules: unanalyzable,
    stats: {
      ruleCount: rules.length,
      analyzableRuleCount: analyzable.length,
      inputCount: inputs.length,
      outputCount: outputs.length,
    },
  };
}

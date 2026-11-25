/**
 * Round-trip invariants of the `explicit-joins` view over every top-level fixture.
 *
 * Guarantees (a failure is a defect, never a reason to loosen the test): derivations are invisible
 * on the way back (transparency), every derivation is reported (hints match the XML markers), the
 * view adds no diagram error, and generating twice gives the same XML.
 *
 * Inventories (record what the code does today, compared against files in tests/bench/): the
 * diagram findings per fixture and view, and which fixtures are round-trip stable under each view
 * (generate(import(generate(m))) equals generate(m), the same view both times). Each stable set
 * may only grow.
 * Rewrite both files after an intended change: `UPDATE_VIEW_INVENTORIES=1 npm test --
 * --testPathPatterns=views-roundtrip` from scripts/.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './pipeline.js';
import { bpmnToLogicCore, bpmnToLogicCoreLegacy } from './import.js';
import { loadNamedView } from '../shared/view.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../../tests/fixtures');
const BENCH = resolve(__dirname, '../../tests/bench');
const STABLE_PATH = resolve(BENCH, 'roundtrip-stable-fixtures.json');
const FINDINGS_PATH = resolve(BENCH, 'view-di-findings.json');
const UPDATE = process.env.UPDATE_VIEW_INVENTORIES === '1';

const JOINS = loadNamedView('explicit-joins');
const DEFAULT = loadNamedView('default');
const READERS = [['bpmnToLogicCore', bpmnToLogicCore], ['bpmnToLogicCoreLegacy', async (xml) => bpmnToLogicCoreLegacy(xml)]];

/**
 * Derived join gateways per fixture under explicit-joins; a fixture not listed derives none. Pinned
 * so the transparency checks below cannot pass by deriving nothing.
 */
const DERIVED_PER_FIXTURE = {
  'boundary-event-shapes.json': 2,
  'bpmn-generator-pipeline.json': 3,
  'example-bestellung-versand.json': 1,
  'example-kreditantrag.json': 1,
  'example-rechnungspruefung.json': 2,
  'example-schadenmeldung.json': 1,
  'example-urlaubsantrag.json': 1,
  'nested-lanes-role-system.json': 1,
  'simple-approval.json': 1,
  'subprocess-merge-fanout.json': 1,
  'wrapping-back-edge.json': 1,
};

// Top-level Logic-Core models only: expected outputs and non-model JSON are skipped, directories
// (dmn/, negative/, ...) are not entered, as in output-hashes.mjs.
const modelNames = readdirSync(FIXTURES)
  .filter((n) => n.endsWith('.json') && !n.includes('.expected.') && !n.includes('.refined.'))
  .filter((n) => {
    const lc = JSON.parse(readFileSync(resolve(FIXTURES, n), 'utf8'));
    return Array.isArray(lc.pools) || Array.isArray(lc.nodes);
  })
  .sort();

const load = (n) => JSON.parse(readFileSync(resolve(FIXTURES, n), 'utf8'));
const markerCount = (xml) => (xml.match(/<bg:derived>joinGateway<\/bg:derived>/g) ?? []).length;
const flowMarkerCount = (xml) => (xml.match(/<bg:derived>joinGatewayFlow<\/bg:derived>/g) ?? []).length;
const codes = (r) => r.diagnostics.issues.map((i) => i.code).sort();
const errors = (r) => r.diagnostics.issues.filter((i) => i.severity === 'ERROR').map((i) => i.code).sort();

/** Sort every `nodes` and `edges` list by id, at any depth; everything else keeps its order. */
function normalise(value) {
  if (Array.isArray(value)) return value.map(normalise);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const n = normalise(v);
      out[k] = (k === 'nodes' || k === 'edges') && Array.isArray(n) && n.every((x) => x && x.id !== undefined)
        ? [...n].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        : n;
    }
    return out;
  }
  return value;
}

// Generated once per view at load time (describe.each needs the names while collecting). A model
// the pipeline blocks on purpose has no XML and is not part of the corpus; the blocked list is
// pinned so a fixture cannot drop out unnoticed.
const results = {}; // name -> { plain, joined, again }
const blocked = [];
for (const n of modelNames) {
  const plain = await runPipeline(load(n), { view: DEFAULT });
  if (!plain.bpmnXml) { blocked.push(n); continue; }
  const joined = await runPipeline(load(n), { view: JOINS });
  const again = await runPipeline(load(n), { view: JOINS });
  results[n] = { plain, joined, again };
}
const names = Object.keys(results);

describe('explicit-joins over every top-level fixture', () => {
  test('the scan found the Logic-Core fixtures', () => {
    expect(blocked).toEqual(['deadlock-process.json']); // blocked on purpose (WF deadlock)
    expect(names.length).toBe(27);
  });

  test('the view derives exactly the pinned gateways per fixture (the suite is not vacuous)', () => {
    const actual = Object.fromEntries(names.map((n) => [n, markerCount(results[n].joined.bpmnXml)]).filter(([, c]) => c > 0));
    expect(actual).toEqual(DERIVED_PER_FIXTURE);
    expect(Object.values(actual).reduce((s, c) => s + c, 0)).toBe(15);
  });

  describe.each(names)('%s', (n) => {
    test.each(READERS)('transparency (%s): importing the view output gives the default output\'s model', async (_r, read) => {
      const viaJoins = await read(results[n].joined.bpmnXml);
      const viaDefault = await read(results[n].plain.bpmnXml);
      expect(normalise(viaJoins)).toEqual(normalise(viaDefault));
    });

    test('hints match: one H01 per derived gateway and its onward flow in the XML', () => {
      const r = results[n].joined;
      const h01 = (r.validation.hints ?? []).filter((h) => h.code === 'H01');
      expect(h01.length).toBe(markerCount(r.bpmnXml));
      expect(h01.length).toBe(flowMarkerCount(r.bpmnXml));
      expect(h01.every((h) => h.elements.length === 3)).toBe(true);
    });

    test('no new diagram error under the view', () => {
      const plainErrors = errors(results[n].plain);
      for (const code of errors(results[n].joined)) expect(plainErrors).toContain(code);
    });

    test('idempotence: generating twice gives identical XML', () => {
      expect(results[n].again.bpmnXml).toBe(results[n].joined.bpmnXml);
    });
  });
});

describe('inventories', () => {
  test('diagram findings per fixture match tests/bench/view-di-findings.json', () => {
    const actual = {};
    for (const n of names) actual[n] = { default: codes(results[n].plain), 'explicit-joins': codes(results[n].joined) };
    if (UPDATE) {
      writeFileSync(FINDINGS_PATH, JSON.stringify({
        description: 'Sorted diagnostics.issues codes (all severities) per top-level fixture under the default view and under explicit-joins. '
          + 'An inventory of the picture quality, not a quality gate; compared by scripts/bpmn/views-roundtrip.test.js. '
          + 'Rewrite with UPDATE_VIEW_INVENTORIES=1 npm test -- --testPathPatterns=views-roundtrip (from scripts/).',
        fixtures: actual,
      }, null, 2) + '\n');
    }
    expect(actual).toEqual(JSON.parse(readFileSync(FINDINGS_PATH, 'utf8')).fixtures);
  });

  test('round-trip stable fixtures include every recorded one, per view', async () => {
    const stable = { default: [], 'explicit-joins': [] };
    for (const [viewName, view, key] of [['default', DEFAULT, 'plain'], ['explicit-joins', JOINS, 'joined']]) {
      for (const n of names) {
        const xml = results[n][key].bpmnXml;
        try {
          const back = await runPipeline(await bpmnToLogicCore(xml), { view });
          if (back.bpmnXml === xml) stable[viewName].push(n);
        } catch { /* a fixture whose import cannot be regenerated is not stable */ }
      }
    }
    if (UPDATE) {
      writeFileSync(STABLE_PATH, JSON.stringify({
        description: 'Top-level fixtures for which generate(import(generate(m))) equals generate(m) as XML, per view (the same view both times). '
          + 'The test requires each recorded set to be a subset of the current stable set (it may grow, not shrink); compared by '
          + 'scripts/bpmn/views-roundtrip.test.js. Rewrite with UPDATE_VIEW_INVENTORIES=1 npm test -- --testPathPatterns=views-roundtrip (from scripts/).',
        stable,
      }, null, 2) + '\n');
    }
    const recorded = JSON.parse(readFileSync(STABLE_PATH, 'utf8')).stable;
    expect(Object.keys(recorded).sort()).toEqual(['default', 'explicit-joins']);
    expect(recorded.default.length).toBeGreaterThan(0);
    for (const viewName of Object.keys(recorded)) expect(stable[viewName]).toEqual(expect.arrayContaining(recorded[viewName]));
  }, 360000);
});

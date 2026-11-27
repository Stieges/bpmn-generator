/**
 * Acceptance of `migrate` over every 1.x fixture (design 6: "je Fixture ergibt `migrate` → `rollen`
 * je Aktivität dieselbe Lane wie im Original; Abweichungen stehen im Bericht").
 *
 * Corpus: every top-level `tests/fixtures/*.json` model of format 1.x; a 2.0 or non-model file is
 * listed as excluded in the pinned table, never dropped silently. Per fixture the table
 * `tests/bench/migrate-fixtures.json` pins `{ status, statusWithDrop, activities, laneMatches, codes }`:
 * `status` without and `statusWithDrop` with `dropUnsupported`; the counts come from the run with
 * `dropUnsupported` (for a fixture translated without the flag both runs give the same report, which
 * is asserted). Re-measure with `UPDATE_MIGRATE_TABLE=1` and review the diff by eye.
 *
 * The lane checks (d), (e) and (g) do not use the report's own comparison: the original lane of a
 * node is read from the input (`node.lane` or a lane's `nodeIds`), the new one from the BPMN XML that
 * `runPipeline` writes under the view `rollen`, and the two are compared by lane name (a lane
 * becomes an actor of the same name). Fixtures refused without the flag (MG02) take part in (c)–(h)
 * with `dropUnsupported: true`.
 */
import { describe, test, expect, beforeAll } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bpmnXsdStatus, xsdDir } from '../../.github/scripts/fetch-bpmn-xsd.mjs';
import { migrateModel } from './migrate.js';
import { runPipeline } from './pipeline.js';
import { modelFormat, validateModelSchema } from './schema-gate.js';
import { resolveLaneId } from './topology.js';
import { resolveFields, formLanes } from './model-v2.js';
import { isActivity, isBoundaryEvent, FLOW_NODE_TYPES } from './types.js';
import { loadNamedView } from '../shared/view.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '../..');
const FIXTURES = join(ROOT, 'tests/fixtures');
const TABLE = join(ROOT, 'tests/bench/migrate-fixtures.json');
const UPDATE = process.env.UPDATE_MIGRATE_TABLE === '1';
// Floor of the corpus, so it cannot shrink silently. Raise it when fixtures are added; never lower it.
const MIN_CORPUS = 28;
// The pinned summary line (i); it must agree with the pinned table.
const SUMMARY = 'translated 19 of 28 (67.9 %), 28 of 28 with --drop-unsupported; MG03 3, MG04 16, MG05 0';

const copy = (v) => JSON.parse(JSON.stringify(v));
const processesOf = (model) => (Array.isArray(model.pools) ? model.pools : [model]);
const hasLanes = (proc) => Array.isArray(proc.lanes) && proc.lanes.length > 0;
const PLACEHOLDER_LANE = /\._(unassigned|unitUnknown)$/;
const stripProcessPrefix = (errors) => errors.map((e) => e.replace(/^\[[^\]]*\] /, ''));

/** Lane id → name of every lane of a process at any depth. */
function laneNames(proc) {
  const out = new Map();
  const walk = (lanes) => { for (const l of lanes || []) { out.set(l.id, l.name || l.id); walk(l.children); } };
  walk(proc.lanes);
  return out;
}

/** The compared top-level flow nodes of a laned process: no boundary event, no subprocess child. */
const flowNodesOf = (proc) => (proc.nodes || []).filter((n) => FLOW_NODE_TYPES.has(n.type) && !isBoundaryEvent(n));

/** Every `<bpmn:lane>` of the XML: node id → `{ laneId, name }`, and lane id → `{ name, nodes }`. */
function lanesOfXml(xml) {
  const nodeLane = new Map();
  const lanes = new Map();
  for (const m of xml.matchAll(/<bpmn:lane id="([^"]+)"(?: name="([^"]*)")?[^>]*>([\s\S]*?)<\/bpmn:lane>/g)) {
    const nodes = [...m[3].matchAll(/<bpmn:flowNodeRef>([^<]+)<\/bpmn:flowNodeRef>/g)].map((r) => r[1]);
    const name = (m[2] ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    lanes.set(m[1], { name, nodes });
    for (const n of nodes) nodeLane.set(n, { laneId: m[1], name });
  }
  return { nodeLane, lanes };
}

/** The same shape from the lanes `formLanes` forms (the model's own catalogue, view rollen). */
function lanesOfFormed(model, catalog) {
  const fields = resolveFields(copy(model), { catalog: copy(catalog) });
  expect(fields.errors).toEqual([]);
  const formed = formLanes(fields.lc, fields.resolved, { lanes: 'role' });
  expect(formed.errors).toEqual([]);
  const nodeLane = new Map();
  const lanes = new Map();
  for (const proc of processesOf(formed.lc)) {
    for (const l of proc.lanes || []) lanes.set(l.id, { name: l.name, nodes: [] });
    for (const n of proc.nodes || []) {
      if (!lanes.has(n.lane)) continue;
      lanes.get(n.lane).nodes.push(n.id);
      nodeLane.set(n.id, { laneId: n.lane, name: lanes.get(n.lane).name });
    }
  }
  return { nodeLane, lanes };
}

/**
 * The new lanes of a fixture under rollen: from the XML; a run blocked by a model error
 * (deadlock-process.json) writes none, so its lanes come from `formLanes`, the step that forms them.
 */
const newLanes = ({ drop, migrated }) => (typeof migrated.bpmnXml === 'string' ? lanesOfXml(migrated.bpmnXml) : lanesOfFormed(drop.model, drop.catalog));

/** Every top-level fixture: the 1.x models, and the files excluded with their reason. */
function corpus() {
  const models = [];
  const excluded = {};
  for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort()) {
    const value = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'));
    const isModel = value && typeof value === 'object' && !Array.isArray(value) && (Array.isArray(value.nodes) || Array.isArray(value.pools));
    if (!isModel) excluded[file] = 'not a model (neither nodes nor pools)';
    else if (modelFormat(value) !== '1') excluded[file] = `format ${value.$schemaVersion}, not 1.x`;
    else models.push({ file, input: value });
  }
  return { models, excluded };
}

const countCodes = (entries) => {
  const out = {};
  for (const e of entries) out[e.code] = (out[e.code] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
};

const { models, excluded } = corpus();
const rollen = loadNamedView('rollen');
const einheiten = loadNamedView('einheiten');
const xsd = bpmnXsdStatus();

/** Per fixture: the two migrate runs, the original 1.x run and the 2.0 run under `rollen`. */
const runs = new Map();

beforeAll(async () => {
  for (const { file, input } of models) {
    const plain = migrateModel(input);
    const drop = migrateModel(input, { dropUnsupported: true });
    const original = await runPipeline(copy(input));
    const migrated = drop.model ? await runPipeline(copy(drop.model), { catalog: copy(drop.catalog), view: rollen }) : null;
    runs.set(file, { input, plain, drop, original, migrated });
  }
}, 120000);

function measuredTable() {
  const fixtures = {};
  for (const [file, { plain, drop }] of runs) {
    fixtures[file] = {
      status: plain.report.status,
      statusWithDrop: drop.report.status,
      activities: drop.report.summary.activities,
      laneMatches: drop.report.summary.laneMatches,
      codes: countCodes(drop.report.entries),
    };
  }
  return { corpus: runs.size, excluded, fixtures };
}

describe('migrate over every 1.x fixture', () => {
  test('the corpus holds every top-level 1.x fixture (floor)', () => {
    expect(models.length).toBeGreaterThanOrEqual(MIN_CORPUS);
  });

  test('(a) the measured table equals the pinned file', () => {
    const measured = measuredTable();
    const text = `${JSON.stringify(measured, null, 2)}\n`;
    if (UPDATE) writeFileSync(TABLE, text);
    if (!existsSync(TABLE)) {
      throw new Error(`${TABLE} is missing; measure it with: cd scripts && UPDATE_MIGRATE_TABLE=1 npm test -- --testPathPatterns=migrate-fixtures (then review it by eye)`);
    }
    expect(JSON.parse(readFileSync(TABLE, 'utf8'))).toEqual(measured);
  });

  test('a fixture translated without the flag gives the same result with it', () => {
    for (const [, { plain, drop }] of runs) {
      if (plain.report.status === 'translated') expect(drop).toEqual(plain);
    }
  });

  test('(b) every refusal has only MG02 entries, and the flag translates it', () => {
    for (const [file, { plain, drop }] of runs) {
      if (plain.report.status !== 'refused') continue;
      const codes = [...new Set(plain.report.entries.map((e) => e.code))];
      expect({ file, codes }).toEqual({ file, codes: ['MG02'] });
      expect({ file, status: drop.report.status }).toEqual({ file, status: 'translated' });
      // the same MG02 entries, dropped
      expect(drop.report.entries.filter((e) => e.code === 'MG02').map((e) => e.elements)).toEqual(plain.report.entries.map((e) => e.elements));
    }
  });

  test('(c) each translated model passes the 2.0 gate', () => {
    for (const [file, { drop }] of runs) {
      const gate = validateModelSchema(drop.model, { accept: ['2'] });
      expect({ file, errors: gate.errors }).toEqual({ file, errors: [] });
    }
  });

  test('(d) every top-level activity of a laned process sits in the lane of its original lane, unless an MG03 names it', () => {
    for (const [file, run] of runs) {
      const { input, drop } = run;
      const { nodeLane } = newLanes(run);
      const mg03 = new Set(drop.report.entries.filter((e) => e.code === 'MG03').map((e) => e.elements[0]));
      for (const proc of processesOf(input)) {
        if (!hasLanes(proc)) continue;
        const names = laneNames(proc);
        for (const node of flowNodesOf(proc).filter((n) => isActivity(n.type))) {
          const laneId = resolveLaneId(proc, node);
          if (!names.has(laneId)) continue; // no original lane (MG05): nothing to compare
          const now = nodeLane.get(node.id)?.name ?? null;
          // an MG03 node is performed by its role, which names its new lane
          const want = mg03.has(node.id) ? node.role : names.get(laneId);
          expect({ file, node: node.id, lane: now }).toEqual({ file, node: node.id, lane: want });
          if (mg03.has(node.id)) expect(names.get(laneId)).not.toBe(node.role);
        }
      }
    }
  });

  test('(e) every event or gateway whose lane differs has exactly one MG04, and no MG04 names one that stays', () => {
    for (const [file, run] of runs) {
      const { input, drop } = run;
      const { nodeLane } = newLanes(run);
      const mg04 = drop.report.entries.filter((e) => e.code === 'MG04').map((e) => e.elements[0]);
      const differing = [];
      for (const proc of processesOf(input)) {
        if (!hasLanes(proc)) continue;
        const names = laneNames(proc);
        for (const node of flowNodesOf(proc).filter((n) => !isActivity(n.type))) {
          const laneId = resolveLaneId(proc, node);
          if (!names.has(laneId)) continue;
          if ((nodeLane.get(node.id)?.name ?? null) !== names.get(laneId)) differing.push(node.id);
        }
      }
      expect({ file, mg04: [...mg04].sort() }).toEqual({ file, mg04: [...differing].sort() });
    }
  });

  test('(d, e) compare as many nodes per fixture as the report does (laneMatches + MG03 + MG04)', () => {
    let total = 0;
    for (const [file, { input, drop }] of runs) {
      let compared = 0;
      for (const proc of processesOf(input)) {
        if (!hasLanes(proc)) continue;
        const names = laneNames(proc);
        compared += flowNodesOf(proc).filter((n) => names.has(resolveLaneId(proc, n))).length;
      }
      const { laneMatches, deviations } = drop.report.summary;
      expect({ file, compared }).toEqual({ file, compared: laneMatches + deviations.MG03 + deviations.MG04 });
      total += compared;
    }
    expect(total).toBeGreaterThan(0);
  });

  test('(f) under rollen the same errors as the 1.x original; XML without errors except the deadlock', () => {
    for (const [file, { original, migrated }] of runs) {
      expect({ file, errors: stripProcessPrefix(migrated.validation.errors) }).toEqual({ file, errors: stripProcessPrefix(original.validation.errors) });
      if (file === 'deadlock-process.json') {
        expect(migrated.validation.errors.join('\n')).toMatch(/Deadlock/);
        expect(migrated.bpmnXml).toBeNull();
      } else {
        expect({ file, errors: migrated.validation.errors }).toEqual({ file, errors: [] });
        expect(typeof migrated.bpmnXml).toBe('string');
      }
    }
  });

  (xsd.available ? test : test.skip)('(f) the XML under rollen validates against BPMN20.xsd', () => {
    const dir = mkdtempSync(join(tmpdir(), 'migrate-fixtures-'));
    try {
      const files = [];
      for (const [file, { migrated }] of runs) {
        if (migrated.bpmnXml === null) continue; // blocked by its model error, see (f)
        const path = join(dir, file.replace(/\.json$/, '.bpmn'));
        writeFileSync(path, migrated.bpmnXml);
        files.push(path);
      }
      execFileSync('xmllint', ['--noout', '--schema', join(xsdDir(), 'BPMN20.xsd'), ...files], { encoding: 'utf8', stdio: 'pipe' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(g) per laned process the new lane names are the original lanes that hold a node (or the performers); a placeholder only with MG04/MG05', () => {
    for (const [file, run] of runs) {
      const { input, drop } = run;
      const { lanes } = newLanes(run);
      const byCode = (code) => new Set(drop.report.entries.filter((e) => e.code === code).map((e) => e.elements[0]));
      const [mg03, mg04, mg05] = ['MG03', 'MG04', 'MG05'].map(byCode);
      for (const proc of processesOf(input)) {
        if (!hasLanes(proc)) continue;
        const names = laneNames(proc);
        const nodes = flowNodesOf(proc);
        const ids = new Set(nodes.map((n) => n.id));
        const own = [...lanes].filter(([, l]) => l.nodes.some((n) => ids.has(n)));
        const placeholders = own.filter(([id]) => PLACEHOLDER_LANE.test(id));
        const newNames = new Set(own.filter(([id]) => !PLACEHOLDER_LANE.test(id)).map(([, l]) => l.name));
        const withRoles = nodes.some((n) => mg03.has(n.id));
        const expected = new Set(withRoles
          ? nodes.filter((n) => isActivity(n.type)).map((n) => (n.role !== undefined ? n.role : names.get(resolveLaneId(proc, n)))).filter((n) => n !== undefined)
          : nodes.map((n) => names.get(resolveLaneId(proc, n))).filter((n) => n !== undefined));
        expect({ file, process: proc.id, lanes: [...newNames].sort() }).toEqual({ file, process: proc.id, lanes: [...expected].sort() });
        if (placeholders.length) {
          expect({ file, process: proc.id, mg04OrMg05: nodes.some((n) => mg04.has(n.id) || mg05.has(n.id)) }).toEqual({ file, process: proc.id, mg04OrMg05: true });
        }
      }
    }
  });

  test('(h) einheiten: without roles the sub-lane activities sit in their parent lane, with roles in their own lanes (decision 4)', async () => {
    const input = runs.get('nested-lanes-role-system.json').input;
    const noRoles = copy(input);
    for (const n of noRoles.nodes) delete n.role;
    const laneNameOf = async (model) => {
      const r = migrateModel(model, { dropUnsupported: true });
      expect(r.report.status).toBe('translated');
      const out = await runPipeline(copy(r.model), { catalog: copy(r.catalog), view: einheiten });
      expect(out.validation.errors).toEqual([]);
      const { nodeLane } = lanesOfXml(out.bpmnXml);
      return (id) => nodeLane.get(id);
    };
    const without = await laneNameOf(noRoles);
    for (const id of ['pruefen', 'freigeben']) expect(without(id)).toEqual({ laneId: 'L.Process_Antrag.lane_fach', name: 'Fachabteilung' });
    const withRoles = await laneNameOf(input);
    expect(withRoles('pruefen')).toEqual({ laneId: 'L.Process_Antrag.lane_pruefung', name: 'Prüfung' });
    expect(withRoles('freigeben')).toEqual({ laneId: 'L.Process_Antrag.lane_freigabe', name: 'Freigabe' });
  });

  test('(i) the summary', () => {
    const n = runs.size;
    const all = [...runs.values()];
    const a = all.filter((r) => r.plain.report.status === 'translated').length;
    const b = all.filter((r) => r.drop.report.status === 'translated').length;
    const sum = (code) => all.reduce((s, r) => s + r.drop.report.summary.deviations[code], 0);
    const line = `translated ${a} of ${n} (${(Math.round((1000 * a) / n) / 10).toFixed(1)} %), ${b} of ${n} with --drop-unsupported; MG03 ${sum('MG03')}, MG04 ${sum('MG04')}, MG05 ${sum('MG05')}`;
    console.log(line);
    expect(line).toBe(SUMMARY);
  });
});

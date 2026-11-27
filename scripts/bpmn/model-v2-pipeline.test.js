/**
 * runPipeline reads format 2.0 (design 5.3, 5.6, 6, 7.1, 7.3, 7.4): the view resolves first, then
 * `resolveFields` checks the model against its catalogue, the model is validated once (check M:
 * one verdict per model, whatever the view), `formLanes` forms the view's lanes and the view's
 * derivations run on the formed model. A 1.x model under a view with `lanes` is a view error.
 */
import { describe, test, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline, generateDiagramSet } from './pipeline.js';
import { validateModel, validateLogicCore } from './validate.js';
import { loadNamedView, ViewRejectedError } from '../shared/view.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const copy = (v) => JSON.parse(JSON.stringify(v));
const simpleApproval = () => JSON.parse(readFileSync(resolve(root, 'tests/fixtures/simple-approval.json'), 'utf8'));
const LANES_ON_1X = 'view "rollen" forms lanes from assignments; this model (format 1.x) carries its own lanes — translate it with node bpmn/migrate.js';

// The pair of design 5.6.
const CATALOG = {
  scheme: 'demi',
  actors: [
    { id: 'abt_schaden', name: 'Schadenabteilung', kind: 'unit' },
    { id: 'abt_finanzen', name: 'Finanzen', kind: 'unit' },
    { id: 'sb_schaden', name: 'Sachbearbeitung Schaden', kind: 'role', unit: 'abt_schaden' },
    { id: 'regress', name: 'Regressspezialist', kind: 'role', unit: 'abt_schaden' },
    { id: 'zahlung', name: 'Zahlungsverkehr', kind: 'role', unit: 'abt_finanzen' },
  ],
};
const MODEL = {
  $schemaVersion: '2.0', catalog: '../bpmn-catalog.json', id: 'Process_Schaden', name: 'Schaden regulieren',
  nodes: [
    { id: 'start', type: 'startEvent', name: 'Schaden gemeldet' },
    { id: 'gw', type: 'exclusiveGateway', name: 'Regress möglich?' },
    { id: 'pruefen', type: 'userTask', name: 'Schaden prüfen', assignments: [{ type: 'D', actor: 'sb_schaden' }] },
    { id: 'regr', type: 'userTask', name: 'Regress prüfen',
      assignments: [{ type: 'D', actor: 'regress' }, { type: 'I', actor: 'sb_schaden' }] },
    { id: 'zahlen', type: 'userTask', name: 'Zahlung anweisen', assignments: [{ type: 'D', actor: 'zahlung' }] },
    { id: 'end', type: 'endEvent', name: 'Schaden reguliert' },
  ],
  edges: [
    { source: 'start', target: 'pruefen' }, { source: 'pruefen', target: 'gw' },
    { source: 'gw', target: 'regr', label: 'ja' }, { source: 'gw', target: 'zahlen', label: 'nein' },
    { source: 'regr', target: 'zahlen' }, { source: 'zahlen', target: 'end' },
  ],
};
const L = (actor) => `L.Process_Schaden.${actor}`;

/** Lane id → its flowNodeRef ids, read from the XML. */
function laneMembers(xml) {
  const out = {};
  for (const m of xml.matchAll(/<bpmn:lane id="([^"]+)"[^>]*>([\s\S]*?)<\/bpmn:lane>/g)) {
    out[m[1]] = [...m[2].matchAll(/<bpmn:flowNodeRef>([^<]+)<\/bpmn:flowNodeRef>/g)].map((r) => r[1]).sort();
  }
  return out;
}
const verdict = ({ validation: { errors, warnings } }) => ({ errors, warnings });
const run = (opts = {}, model = MODEL) => runPipeline(copy(model), { catalog: copy(CATALOG), ...opts });

describe('runPipeline — format 2.0, the two views of design 5.6', () => {
  const ROLLEN = {
    [L('sb_schaden')]: ['gw', 'pruefen', 'start'],
    [L('regress')]: ['regr'],
    [L('zahlung')]: ['end', 'zahlen'],
  };
  const EINHEITEN = {
    [L('abt_schaden')]: ['gw', 'pruefen', 'regr', 'start'],
    [L('abt_finanzen')]: ['end', 'zahlen'],
  };

  test.each([['rollen', ROLLEN], ['einheiten', EINHEITEN]])('view %s forms the lanes of design 5.6', async (name, expected) => {
    const result = await run({ view: loadNamedView(name) });
    expect(result.validation.errors).toEqual([]);
    expect(Object.keys(result.coordMap.laneCoords).sort()).toEqual(Object.keys(expected).sort());
    expect(laneMembers(result.bpmnXml)).toEqual(expected);
    expect(result.bpmnXml).toContain(`bg:view="${name}"`);
    expect(result.validation.hints.filter((h) => h.code !== 'H18')).toEqual([]);
  });

  test('without a view a 2.0 model gets role lanes', async () => {
    const result = await run();
    expect(Object.keys(result.coordMap.laneCoords).sort()).toEqual(Object.keys(ROLLEN).sort());
    expect(laneMembers(result.bpmnXml)).toEqual(ROLLEN);
    expect(result.bpmnXml).toContain('bg:view="default"');
  });

  test('check M: one verdict per model, under both views and under none', async () => {
    const none = verdict(await run());
    expect(verdict(await run({ view: loadNamedView('rollen') }))).toEqual(none);
    expect(verdict(await run({ view: loadNamedView('einheiten') }))).toEqual(none);
  });

  test('explicit-joins puts the derived join into the lane of its target', async () => {
    const result = await run({ view: loadNamedView('explicit-joins') });
    expect(result.validation.hints).toEqual([expect.objectContaining({ code: 'H01', elements: ['gw_join_zahlen', 'zahlen', expect.any(String)] })]);
    expect(laneMembers(result.bpmnXml)[L('zahlung')]).toEqual(['end', 'gw_join_zahlen', 'zahlen']);
  });

  test('validation.hints: the lane hints first, then H01', async () => {
    const model = copy(MODEL);
    delete model.nodes.find((n) => n.id === 'regr').assignments;
    const result = await run({ view: loadNamedView('explicit-joins') }, model);
    expect(result.validation.errors).toEqual([]);
    expect(result.validation.hints.map((h) => h.code)).toEqual(['H02', 'H01']);
  });

  test('the caller\'s model and catalogue are not changed', async () => {
    const model = copy(MODEL);
    const catalog = copy(CATALOG);
    await runPipeline(model, { catalog, view: loadNamedView('einheiten') });
    expect(model).toEqual(MODEL);
    expect(catalog).toEqual(CATALOG);
  });
});

describe('runPipeline — format 2.0 early returns', () => {
  // A 2.x early return also carries `validation.findings`: one ERROR finding per error.
  const early = (errors, code) => ({
    bpmnXml: null, svg: null, coordMap: null, diagnostics: null, netDiagnostics: null,
    validation: {
      errors, warnings: [], advisories: [], metrics: {}, hints: [],
      findings: errors.map((message) => ({ code, severity: 'ERROR', message })),
    },
  });

  test.each(['optimize', 'soll'])('mode %s is refused', async (mode) => {
    expect(await run({ mode })).toEqual(early([`[F04] mode "${mode}" is not available for format 2.0 models yet`], 'F04'));
  });

  test('a C01 finding stops the run with no artefact and no hints', async () => {
    const model = copy(MODEL);
    model.nodes.find((n) => n.id === 'zahlen').assignments[0].actor = 'kasse';
    const result = await run({ view: loadNamedView('rollen') }, model);
    expect(result).toEqual(early([expect.stringMatching(/^\[C01\] node "zahlen": actor "kasse"/)], 'C01'));
  });

  test('a model naming its catalogue as a path without a catalogue object is an error', async () => {
    const result = await runPipeline(copy(MODEL));
    expect(result.bpmnXml).toBeNull();
    expect(result.validation.errors).toEqual([expect.stringMatching(/^\[C13\] the model names catalogue/)]);
  });
});

describe('runPipeline — the process file replaces catalogue entries', () => {
  const REGRESS = { id: 'regress', name: 'Regress (lokal)', kind: 'role', unit: 'abt_finanzen' };

  test('H09 comes first in validation.hints; regr moves into Finanzen in the unit view', async () => {
    const model = { ...copy(MODEL), actors: [REGRESS] };
    delete model.nodes.find((n) => n.id === 'pruefen').assignments;
    const result = await run({ view: loadNamedView('explicit-joins') }, model);
    expect(result.validation.errors).toEqual([]);
    expect(result.validation.hints.map((h) => h.code)).toEqual(['H09', 'H02', 'H01']);
    const unit = await run({ view: loadNamedView('einheiten') }, { ...copy(MODEL), actors: [REGRESS] });
    expect(laneMembers(unit.bpmnXml)[L('abt_finanzen')]).toEqual(['end', 'regr', 'zahlen']);
    expect(unit.validation.hints).toEqual([expect.objectContaining({ code: 'H09' })]);
  });

  test('the caller\'s model and catalogue are not changed', async () => {
    const model = { ...copy(MODEL), actors: [REGRESS] };
    const catalog = copy(CATALOG);
    await runPipeline(model, { catalog });
    expect(model).toEqual({ ...MODEL, actors: [REGRESS] });
    expect(catalog).toEqual(CATALOG);
  });

  test('the CLI with the catalog field and actors in one file works', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2-repl-'));
    try {
      writeFileSync(join(dir, 'bpmn-catalog.json'), JSON.stringify(CATALOG));
      writeFileSync(join(dir, 'm.json'), JSON.stringify({ ...copy(MODEL), catalog: 'bpmn-catalog.json', actors: [REGRESS] }));
      const out = execFileSync(process.execPath, [resolve(here, 'pipeline.js'), 'm.json', 'out', '--strict'], { cwd: dir, stdio: 'pipe' });
      expect(out.toString()).toContain('[H09] Catalogue entry "regress" is replaced by the process file.');
      expect(readFileSync(join(dir, 'out.bpmn'), 'utf8')).toContain('modelVersion="2.0"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runPipeline — the catalog option', () => {
  test('a string is refused: the library takes only a catalogue object', async () => {
    await expect(runPipeline(copy(MODEL), { catalog: '../bpmn-catalog.json' }))
      .rejects.toThrow(new TypeError('catalog must be a catalogue object; read a file with loadCatalog'));
  });

  test('a catalogue with a 1.x model is refused', async () => {
    await expect(runPipeline(simpleApproval(), { catalog: copy(CATALOG) }))
      .rejects.toThrow(new TypeError('catalog applies to format 2.0 models only'));
  });
});

describe('runPipeline — the catalog option, not an object', () => {
  test.each([[5], [[]]])('catalog %j throws the uncoded catalogue TypeError', async (catalog) => {
    const err = await runPipeline(copy(MODEL), { catalog }).catch((e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe('catalog must be a catalogue object; read a file with loadCatalog');
  });
});

describe('the CLI finds the catalogue of a model given by a relative path', () => {
  test('cwd elsewhere: the catalogue named by the model is found next to the model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2-rel-'));
    try {
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'bpmn-catalog.json'), JSON.stringify(CATALOG));
      writeFileSync(join(dir, 'sub', 'm.json'), JSON.stringify({ ...copy(MODEL), catalog: 'bpmn-catalog.json' }));
      // cwd is the parent: a cwd-relative lookup of bpmn-catalog.json would miss it, only the model's folder has it.
      const out = execFileSync(process.execPath, [resolve(here, 'pipeline.js'), 'sub/m.json', 'out', '--strict'], { cwd: dir, stdio: 'pipe' });
      expect(out.toString()).not.toContain('✗');
      expect(readFileSync(join(dir, 'out.bpmn'), 'utf8')).toContain('modelVersion="2.0"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a 1.x model under a view with lanes is a view error (design 6)', () => {
  test('runPipeline rejects with ViewRejectedError', async () => {
    const err = await runPipeline(simpleApproval(), { view: loadNamedView('rollen') }).catch((e) => e);
    expect(err).toBeInstanceOf(ViewRejectedError);
    expect(err.message).toBe(LANES_ON_1X);
  });

  test('the CLI exits 1 and prints the message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2-cli-'));
    try {
      let err;
      try {
        execFileSync(process.execPath, [resolve(here, 'pipeline.js'), resolve(root, 'tests/fixtures/simple-approval.json'), join(dir, 'out'), '--view=rollen'], { stdio: 'pipe' });
      } catch (e) { err = e; }
      expect(err?.status).toBe(1);
      expect(err.stderr.toString()).toContain(`✗ ${LANES_ON_1X}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('$schemaVersion: only "2.0" is format 2.0', () => {
  const versioned = (v) => ({ ...copy(MODEL), $schemaVersion: v });
  const refusal = (v) => `[F02] /$schemaVersion $schemaVersion "${v}" is not supported; only "2.0" and "2.1" are supported`;

  test('"2.0" is accepted by runPipeline and stamped 2.0', async () => {
    const result = await run({}, versioned('2.0'));
    expect(result.validation.errors).toEqual([]);
    expect(result.bpmnXml).toContain('modelVersion="2.0"');
  });

  test('"2.1" without systems generates; its XML differs from the "2.0" one only in bg:modelVersion', async () => {
    const two = await run({}, versioned('2.0'));
    const twoOne = await run({}, versioned('2.1'));
    expect(twoOne.validation.errors).toEqual([]);
    expect(twoOne.bpmnXml).toContain('modelVersion="2.1"');
    expect(twoOne.bpmnXml.replace('modelVersion="2.1"', 'modelVersion="2.0"')).toBe(two.bpmnXml);
    expect(twoOne.svg).toBe(two.svg);
  });

  test('generateDiagramSet refuses a "2.1" model with F04, not F02', async () => {
    const set = await generateDiagramSet(versioned('2.1'), { catalog: copy(CATALOG) });
    expect(set.parent.bpmnXml).toBeNull();
    expect(set.parent.validation.errors).toEqual(['[F04] drill-down is not available for format 2.0 models yet']);
  });

  test.each(['2.7', '2'])('runPipeline refuses "%s" with one error naming it', async (v) => {
    const result = await run({}, versioned(v));
    expect(result.bpmnXml).toBeNull();
    expect(result.validation.errors).toEqual([refusal(v)]);
  });

  test('the CLI exits 1 for "2.7" and for "2", names the value, and accepts "2.0"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'v2-ver-'));
    try {
      const catalogFile = join(dir, 'bpmn-catalog.json');
      writeFileSync(catalogFile, JSON.stringify(CATALOG));
      const generate = (v) => {
        const file = join(dir, `m-${v}.json`);
        writeFileSync(file, JSON.stringify(versioned(v)));
        try {
          execFileSync(process.execPath, [resolve(here, 'pipeline.js'), file, join(dir, `out-${v}`), '--strict', `--catalog=${catalogFile}`], { stdio: 'pipe' });
          return { status: 0, stderr: '' };
        } catch (e) { return { status: e.status, stderr: e.stderr.toString() }; }
      };
      expect(generate('2.0').status).toBe(0);
      for (const v of ['2.7', '2']) {
        const r = generate(v);
        expect(r.status).toBe(1);
        expect(r.stderr).toContain(`$schemaVersion "${v}" is not supported; only "2.0" and "2.1" are supported`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('response contract', () => {
  test('the hint code pattern in api-schema.json accepts H01–H19', () => {
    const api = JSON.parse(readFileSync(resolve(root, 'references/api-schema.json'), 'utf8'));
    const find = (v) => {
      if (v && typeof v === 'object') {
        if (v.hints?.items?.properties?.code?.pattern) return v.hints.items.properties.code.pattern;
        for (const x of Object.values(v)) { const r = find(x); if (r) return r; }
      }
      return undefined;
    };
    const re = new RegExp(find(api));
    for (const code of ['H01', 'H02', 'H06', 'H08', 'H09', 'H10', 'H11', 'H12', 'H13', 'H14']) expect(re.test(code)).toBe(true);
    for (const code of ['H00', 'H21', 'H1', 'H100']) expect(re.test(code)).toBe(false);
  });
});

describe('generateDiagramSet refuses format 2.0 (design 9: drill-down does not read 2.0 yet)', () => {
  const REFUSAL = '[F04] drill-down is not available for format 2.0 models yet';
  // A 2.0 model with an expanded subprocess whose child carries an assignment.
  const WITH_SUB = () => {
    const m = copy(MODEL);
    m.nodes.splice(2, 1, { id: 'pruefen', type: 'subProcess', name: 'Schaden prüfen', isExpanded: true,
      assignments: [{ type: 'D', actor: 'sb_schaden' }],
      nodes: [
        { id: 's_start', type: 'startEvent', name: 'Prüfung begonnen' },
        { id: 's_task', type: 'userTask', name: 'Unterlagen sichten', assignments: [{ type: 'D', actor: 'regress' }] },
        { id: 's_end', type: 'endEvent', name: 'Prüfung beendet' },
      ],
      edges: [{ source: 's_start', target: 's_task' }, { source: 's_task', target: 's_end' }] });
    return m;
  };

  test.each([['no view', {}], ['view rollen', { view: loadNamedView('rollen') }]])('%s: refused before any work, no diagram', async (_, opts) => {
    const model = WITH_SUB();
    const before = JSON.stringify(model);
    const set = await generateDiagramSet(model, { catalog: copy(CATALOG), ...opts });
    expect(set.parent.bpmnXml).toBeNull();
    expect(set.parent.svg).toBeNull();
    expect(set.parent.validation.errors).toEqual([REFUSAL]);
    expect(set.subProcesses).toEqual({});
    expect(set.navigation).toEqual({ subProcesses: [] });
    expect(JSON.stringify(model)).toBe(before);
  });
});

describe('validateModel — one judgement for both formats', () => {
  // An inclusive split and join: the workflow-net layer gives the WF_OR INFO finding.
  const OR_MODEL = () => {
    const m = copy(MODEL);
    m.nodes.splice(1, 1, { id: 'gw', type: 'inclusiveGateway', name: 'Welche Prüfungen?' },
      { id: 'gj', type: 'inclusiveGateway', name: '', has_join: true });
    m.edges = [
      { source: 'start', target: 'gw' }, { source: 'gw', target: 'pruefen' }, { source: 'gw', target: 'regr' },
      { source: 'pruefen', target: 'gj' }, { source: 'regr', target: 'gj' }, { source: 'gj', target: 'zahlen' },
      { source: 'zahlen', target: 'end' },
    ];
    return m;
  };
  const strict = resolve(root, 'rules/strict-profile.json');

  test('a 1.x model: exactly validateLogicCore, no findings key', () => {
    const result = validateModel(simpleApproval(), strict);
    expect(result).toEqual(validateLogicCore(simpleApproval(), strict));
    expect(result).not.toHaveProperty('findings');
  });

  test('a valid 2.0 model: the rule verdict on the resolved model, findings of all severities', () => {
    // The strict profile runs the workflow-net layer (and makes M07 an error).
    const result = validateModel(OR_MODEL(), strict, { catalog: copy(CATALOG) });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'WF_OR', severity: 'INFO' }));
    const bySeverity = (s) => result.findings.filter((f) => f.severity === s).map((f) => f.message);
    expect(bySeverity('ERROR')).toEqual(result.errors);
    expect(bySeverity('WARNING')).toEqual(result.warnings);
    expect(bySeverity('INFO')).toEqual(result.infos);
  });

  test('a 2.0 model with an unknown actor: the C01 errors, nothing else', () => {
    const model = copy(MODEL);
    model.nodes[2].assignments = [{ type: 'D', actor: 'niemand' }];
    const result = validateModel(model, null, { catalog: copy(CATALOG) });
    const message = '[C01] node "pruefen": actor "niemand" is not in the catalogue';
    expect(result).toEqual({
      errors: [message], warnings: [], infos: [], advisories: [], metrics: {},
      findings: [{ code: 'C01', severity: 'ERROR', message }],
    });
  });

  test('a 2.0 model naming its catalogue as a path, no catalogue object: C13', () => {
    const result = validateModel(copy(MODEL));
    expect(result.errors).toEqual([expect.stringMatching(/^\[C13\] the model names catalogue/)]);
    expect(result.findings).toEqual([{ code: 'C13', severity: 'ERROR', message: result.errors[0] }]);
  });

  test('no C10: validateModel forms no lanes (C10 depends on the view; generate reports it)', async () => {
    // An edge whose id is the lane id the role view would form for the performer of "zahlen".
    const model = copy(MODEL);
    model.edges[5].id = L('zahlung');
    const result = validateModel(model, null, { catalog: copy(CATALOG) });
    expect(result.errors.filter((e) => e.startsWith('[C10]'))).toEqual([]);
    expect(result.findings.some((f) => f.code === 'C10')).toBe(false);
    expect((await run({}, model)).validation.errors).toContainEqual(expect.stringMatching(/^\[C10\] /));
  });

  test('the caller\'s model and catalogue are not changed', () => {
    const model = copy(MODEL);
    const catalog = copy(CATALOG);
    validateModel(model, null, { catalog });
    expect(model).toEqual(MODEL);
    expect(catalog).toEqual(CATALOG);
  });

  test('the catalog option as runPipeline takes it: an object, for 2.0 models only', () => {
    expect(() => validateModel(copy(MODEL), null, { catalog: '../bpmn-catalog.json' }))
      .toThrow(new TypeError('catalog must be a catalogue object; read a file with loadCatalog'));
    expect(() => validateModel(simpleApproval(), null, { catalog: copy(CATALOG) }))
      .toThrow(new TypeError('catalog applies to format 2.0 models only'));
  });
});

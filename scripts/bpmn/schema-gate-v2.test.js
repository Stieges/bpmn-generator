/**
 * Format 2.0 at the schema gate (design 5.1, 5.4, 5.5): the v2 schema, `modelFormat`,
 * `validateModelSchema` with its `accept` list, and what every surface that has not opted in says
 * to a 2.0 model: one error, FORMAT_V2_NOT_ACCEPTED.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  modelFormat, validateModelSchema, validateLogicCoreSchema, FORMAT_V2_NOT_ACCEPTED, boundSchemaErrors, formatSchemaErrors,
} from './schema-gate.js';
import { inputSchemaPath, inputSchemaV2Path } from '../shared/resource-paths.js';
import { TOOLS, handleToolCall } from '../mcp-bpmn-server.js';
import { orchestrate } from '../orchestrator.js';
import { generateDiagramSet } from './pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../../tests/fixtures');
const v1 = JSON.parse(readFileSync(inputSchemaPath(), 'utf8'));
const v2 = JSON.parse(readFileSync(inputSchemaV2Path(), 'utf8'));

// Design 5.6, the 2.0 model, verbatim.
const m56 = () => ({ $schemaVersion: '2.0', catalog: '../bpmn-catalog.json', id: 'Process_Bestellung', name: 'Bestellung abwickeln',
  nodes: [
    { id: 'start', type: 'startEvent', name: 'Bestellung eingegangen' }, { id: 'gw', type: 'exclusiveGateway', name: 'Rückfrage nötig?' },
    { id: 'pruefen', type: 'userTask', name: 'Auftrag prüfen', assignments: [{ type: 'D', actor: 'sb_einkauf' }] },
    { id: 'rueck', type: 'userTask', name: 'Lieferant klären',
      assignments: [{ type: 'D', actor: 'leitung' }, { type: 'I', actor: 'sb_einkauf' }] },
    { id: 'zahlen', type: 'userTask', name: 'Zahlung anweisen', assignments: [{ type: 'D', actor: 'zahlung' }] },
    { id: 'end', type: 'endEvent', name: 'Auftrag erledigt' }],
  edges: [{ source: 'start', target: 'pruefen' }, { source: 'pruefen', target: 'gw' },
    { source: 'gw', target: 'rueck', label: 'ja' }, { source: 'gw', target: 'zahlen', label: 'nein' },
    { source: 'rueck', target: 'zahlen' }, { source: 'zahlen', target: 'end' }] });

const BOTH = { accept: ['1', '2'] };
const errorsOf = (m) => validateModelSchema(m, BOTH).errors;
const collab = () => ({ $schemaVersion: '2.0', pools: [
  { id: 'Pool_A', name: 'A', nodes: [{ id: 'a1', type: 'startEvent' }, { id: 'a2', type: 'endEvent' }], edges: [{ source: 'a1', target: 'a2' }] }] });

describe('v2 schema drift fence against the 1.x schema', () => {
  test.each(['Edge', 'MessageFlow', 'Association', 'CollapsedPool', 'EventMarker', 'TopLevelDefinition'])('%s equals 1.x', (name) => {
    expect(v2.$defs[name]).toEqual(v1.$defs[name]);
  });

  test('NodeType is 1.x without the two data node types', () => {
    expect(v2.$defs.NodeType.enum).toEqual(v1.$defs.NodeType.enum.filter((t) => !['dataObjectReference', 'dataStoreReference'].includes(t)));
  });

  test('Node.properties is 1.x minus lane, role plus assignments and dataAccess; system differs; the rest is equal', () => {
    const expected = Object.keys(v1.$defs.Node.properties).filter((k) => !['lane', 'role'].includes(k)).concat('assignments', 'dataAccess');
    expect(Object.keys(v2.$defs.Node.properties).sort()).toEqual(expected.sort());
    for (const k of expected.filter((x) => !['assignments', 'dataAccess', 'system'].includes(x))) expect(v2.$defs.Node.properties[k]).toEqual(v1.$defs.Node.properties[k]);
    expect(v2.$defs.Node.properties.system.$ref).toMatch(/#\/\$defs\/ActorId$/);
    expect(v2.$defs.Node.properties.dataAccess.items.properties.data.$ref).toMatch(/#\/\$defs\/ActorId$/);
  });

  test('no Lane definition and no lanes property anywhere', () => {
    expect(v2.$defs.Lane).toBeUndefined();
    expect(JSON.stringify(v2)).not.toMatch(/"lanes"|"lane"|"role"/);
  });
});

describe('modelFormat', () => {
  test.each([
    [{ $schemaVersion: '2.0' }, '2'], [{ $schemaVersion: '2.7' }, '2'], [{ $schemaVersion: '2' }, '2'],
    [{ $schemaVersion: '1.2' }, '1'], [{}, '1'], [{ $schemaVersion: 2 }, '1'], [{ $schemaVersion: 'x2.0' }, '1'],
    [null, '1'], [[], '1'], ['2.0', '1'],
  ])('%j is format %s', (input, expected) => {
    expect(modelFormat(input)).toBe(expected);
  });
});

describe('validateModelSchema', () => {
  test('the design 5.6 model passes when 2 is accepted', () => {
    expect(validateModelSchema(m56(), BOTH)).toEqual({ valid: true, format: '2', errors: [] });
  });

  test('a collaboration 2.0 model passes; a 1.x model passes with format 1', () => {
    expect(validateModelSchema(collab(), BOTH).valid).toBe(true);
    expect(validateModelSchema({ nodes: [{ id: 'a', type: 'task' }], edges: [] }, BOTH)).toMatchObject({ valid: true, format: '1' });
  });

  test('by default only 1 is accepted: one error for a 2.0 model', () => {
    const r = validateModelSchema(m56());
    expect(r).toEqual({ valid: false, format: '2', errors: [{ path: '/$schemaVersion', message: FORMAT_V2_NOT_ACCEPTED, params: { accepted: ['1'] }, code: 'F03' }] });
  });

  test('a 1.x model is rejected when only 2 is accepted', () => {
    const r = validateModelSchema({ nodes: [{ id: 'a', type: 'task' }], edges: [] }, { accept: ['2'] });
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].params).toEqual({ accepted: ['2'] });
    expect(r.errors[0]).not.toHaveProperty('code');
    expect(r.errors[0].message).toBe('this is not a format 2.0 model ($schemaVersion absent)');
  });

  test('2.x entries carry their code: F01 per schema error, F02 for a version, F03 for not accepted', () => {
    const bad = validateModelSchema({ $schemaVersion: '2.0', nodes: 5 }, { accept: ['2'] }).errors;
    expect(bad.length).toBeGreaterThan(0);
    expect(bad.every((e) => e.code === 'F01')).toBe(true);
    const seven = validateModelSchema({ ...m56(), $schemaVersion: '2.7' }, BOTH).errors;
    expect(seven).toHaveLength(1);
    expect(seven[0].code).toBe('F02');
    expect(validateModelSchema(m56()).errors[0].code).toBe('F03');
  });

  test('boundSchemaErrors keeps the code of 20 entries and the cap entry has none', () => {
    const errors = Array.from({ length: 25 }, (_, i) => ({ path: `/nodes/${i}`, message: 'bad', params: {}, code: 'F01' }));
    const out = boundSchemaErrors(errors);
    expect(out).toHaveLength(21);
    expect(out.slice(0, 20).every((e) => e.code === 'F01')).toBe(true);
    expect(out[20]).toEqual({ path: '(root)', message: '… and 5 more', params: { more: 5 } });
    expect(boundSchemaErrors([{ path: '/a', message: 'm', params: {} }])[0]).not.toHaveProperty('code');
    expect(formatSchemaErrors(out, 1)).toBe('[F01] /nodes/0: bad\n… and 20 more');
  });

  const withNode = (extra) => { const m = m56(); Object.assign(m.nodes[2], extra); return m; };
  test.each([
    ['lane', () => withNode({ lane: 'L1' }), '/nodes/2'],
    ['lanes', () => ({ ...m56(), lanes: [{ id: 'L1' }] }), '(root)'],
    ['role', () => withNode({ role: 'Sachbearbeitung' }), '/nodes/2'],
    ['dataStoreReference node', () => { const m = m56(); m.nodes.push({ id: 'ds', type: 'dataStoreReference' }); return m; }, '/nodes/6/type'],
    ['pool id "Pool 1"', () => { const m = collab(); m.pools[0].id = 'Pool 1'; return m; }, '/pools/0/id'],
    ['process id missing', () => { const m = m56(); delete m.id; return m; }, '(root)'],
    ['scheme without actors', () => ({ ...m56(), scheme: 'demi' }), '(root)'],
    ['assignments on a textAnnotation', () => { const m = m56(); m.nodes.push({ id: 'ta', type: 'textAnnotation', assignments: [] }); return m; }, '/nodes/6/assignments'],
    ['assignments on a group', () => { const m = m56(); m.nodes.push({ id: 'gr', type: 'group', assignments: [] }); return m; }, '/nodes/6/assignments'],
    ['lanes on a pool', () => { const m = collab(); m.pools[0].lanes = [{ id: 'L1' }]; return m; }, '/pools/0'],
    ['a pool without id', () => { const m = collab(); delete m.pools[0].id; return m; }, '/pools/0'],
    ['assignment without actor', () => withNode({ assignments: [{ type: 'D' }] }), '/nodes/2/assignments/0'],
    ['assignment type not a scheme key', () => withNode({ assignments: [{ type: '9', actor: 'a' }] }), '/nodes/2/assignments/0/type'],
    ['assignment actor not an actor id', () => withNode({ assignments: [{ type: 'D', actor: '1x' }] }), '/nodes/2/assignments/0/actor'],
    ['$schemaVersion 2.01 (leading zero)', () => ({ ...m56(), $schemaVersion: '2.01' }), '/$schemaVersion'],
  ])('%s is one error naming the path', (_, make, path) => {
    const errors = errorsOf(make());
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe(path);
  });

  describe('format 2.1 fields in a "2.0" model: one F06 per use', () => {
    const f06 = (path, field) => ({ path, message: `"${field}" needs format 2.1; set "$schemaVersion" to "2.1"`, params: { field, version: '2.1' }, code: 'F06' });

    test('system on a node: one F06 at its path, no F01', () => {
      expect(errorsOf(withNode({ system: 'crm' }))).toEqual([f06('/nodes/2/system', 'system')]);
      expect(validateModelSchema(withNode({ system: 'crm' }), { accept: ['2'] }).valid).toBe(false);
    });

    test('root systems, even empty: one F06 at /systems', () => {
      expect(errorsOf({ ...m56(), systems: [] })).toEqual([f06('/systems', 'systems')]);
    });

    test('a nested node of a pool: the path names every level', () => {
      const m = collab();
      m.pools[0].nodes.splice(1, 0, { id: 'sp', type: 'subProcess', isExpanded: true,
        nodes: [{ id: 's1', type: 'startEvent' }, { id: 's2', type: 'userTask', name: 'B', system: 'crm' }], edges: [] });
      expect(errorsOf(m)).toEqual([f06('/pools/0/nodes/1/nodes/1/system', 'system')]);
    });

    test('root first, then the nodes depth-first in document order', () => {
      const m = { ...m56(), systems: [{ id: 'crm', name: 'CRM' }] };
      m.nodes[2].system = 'crm';
      m.nodes[3].system = 'crm';
      expect(errorsOf(m).map((e) => e.path)).toEqual(['/systems', '/nodes/2/system', '/nodes/3/system']);
    });

    test('appended to the schema errors of an invalid model', () => {
      const m = withNode({ system: 'crm', lane: 'L1' });
      const errors = errorsOf(m);
      expect(errors.map((e) => e.code)).toEqual(['F01', 'F06']);
      expect(errors[1]).toEqual(f06('/nodes/2/system', 'system'));
    });

    test('as "2.1" the same models are valid', () => {
      const m = { ...m56(), $schemaVersion: '2.1' };
      expect(validateModelSchema(m, BOTH)).toEqual({ valid: true, format: '2', errors: [] });
      const s = { ...m56(), $schemaVersion: '2.1', systems: [{ id: 'sys_akte', name: 'Bestellakte' }] };
      s.nodes[2].system = 'sys_akte';
      expect(validateModelSchema(s, BOTH)).toEqual({ valid: true, format: '2', errors: [] });
      const c = { ...collab(), $schemaVersion: '2.1', systems: [] };
      c.pools[0].nodes.splice(1, 0, { id: 't', type: 'userTask', name: 'T', system: 'crm' });
      expect(validateModelSchema(c, BOTH).valid).toBe(true);
    });

    test('a system that is no actor id, or a system entry without name, is F01 under "2.1"', () => {
      const bad = { ...withNode({ system: '1x' }), $schemaVersion: '2.1' };
      expect(errorsOf(bad).map((e) => [e.code, e.path])).toEqual([['F01', '/nodes/2/system']]);
      const noName = { ...m56(), $schemaVersion: '2.1', systems: [{ id: 'crm' }] };
      expect(errorsOf(noName).map((e) => [e.code, e.path])).toEqual([['F01', '/systems/0']]);
    });

    test('dataAccess on a node: one F06 at its path, no F01; empty too', () => {
      expect(errorsOf(withNode({ dataAccess: [{ data: 'order', access: 'read' }] }))).toEqual([f06('/nodes/2/dataAccess', 'dataAccess')]);
      expect(errorsOf(withNode({ dataAccess: [] }))).toEqual([f06('/nodes/2/dataAccess', 'dataAccess')]);
    });

    test('root data, even empty: one F06 at /data', () => {
      expect(errorsOf({ ...m56(), data: [] })).toEqual([f06('/data', 'data')]);
    });

    test('root systems before root data, then nodes: system before dataAccess', () => {
      const m = { ...m56(), data: [], systems: [] };
      m.nodes[2].dataAccess = [];
      m.nodes[2].system = 'crm';
      expect(errorsOf(m).map((e) => e.path)).toEqual(['/systems', '/data', '/nodes/2/system', '/nodes/2/dataAccess']);
    });

    test('a collaboration: system and dataAccess on one nested node give two F06, system first', () => {
      const m = collab();
      m.pools[0].nodes.splice(1, 0, { id: 'sp', type: 'subProcess', isExpanded: true,
        nodes: [{ id: 's1', type: 'startEvent' }, { id: 's2', type: 'userTask', name: 'B', dataAccess: [{ data: 'd' }], system: 'crm' }], edges: [] });
      expect(errorsOf(m)).toEqual([f06('/pools/0/nodes/1/nodes/1/system', 'system'), f06('/pools/0/nodes/1/nodes/1/dataAccess', 'dataAccess')]);
    });

    test('as "2.1" data and dataAccess are valid, an empty dataAccess too; access "update" is F01', () => {
      const m = { ...m56(), $schemaVersion: '2.1', data: [{ id: 'order', name: 'Order', kind: 'object' }, { id: 'db', name: 'DB', kind: 'store' }] };
      m.nodes[2].dataAccess = [{ data: 'order', access: 'read' }, { data: 'db', access: 'write' }, { data: 'order' }];
      m.nodes[3].dataAccess = [];
      expect(validateModelSchema(m, BOTH)).toEqual({ valid: true, format: '2', errors: [] });
      m.nodes[2].dataAccess = [{ data: 'order', access: 'update' }];
      expect(errorsOf(m).map((e) => [e.code, e.path])).toEqual([['F01', '/nodes/2/dataAccess/0/access']]);
    });

    test('dataAccess holds at most 5000 entries, like the other lists', () => {
      const m = { ...m56(), $schemaVersion: '2.1' };
      m.nodes[2].dataAccess = Array.from({ length: 5001 }, () => ({ data: 'order' }));
      expect(errorsOf(m).map((e) => [e.code, e.path])).toEqual([['F01', '/nodes/2/dataAccess']]);
    });

    test('formatSchemaErrors writes the F06 line with a colon', () => {
      expect(formatSchemaErrors(errorsOf(withNode({ system: 'crm' }))))
        .toBe('[F06] /nodes/2/system: "system" needs format 2.1; set "$schemaVersion" to "2.1"');
    });
  });

  test('a false schema reads "is not allowed here" and its `if` error is dropped', () => {
    const m = m56();
    m.nodes.push({ id: 'ta', type: 'textAnnotation', assignments: [] });
    const [e] = errorsOf(m);
    expect(e).toMatchObject({ path: '/nodes/6/assignments', message: 'is not allowed here', code: 'F01' });
  });

  test('catalog beside actors is valid; scheme still needs actors', () => {
    expect(validateModelSchema({ ...m56(), actors: [{ id: 'a', name: 'A' }] }, BOTH).valid).toBe(true);
    expect(errorsOf({ ...m56(), scheme: 'demi' })[0].path).toBe('(root)');
  });

  test('scheme with actors, an inline scheme and no catalog is valid', () => {
    const m = m56();
    delete m.catalog;
    m.actors = [{ id: 'sb', name: 'Sachbearbeitung', kind: 'role' }];
    m.scheme = 'demi';
    expect(validateModelSchema(m, BOTH).valid).toBe(true);
  });
});

describe('validateLogicCoreSchema stays the 1.x gate', () => {
  test('a 2.0 model gets exactly the one not-accepted error', () => {
    expect(validateLogicCoreSchema(m56())).toEqual({
      valid: false,
      errors: [{ path: '/$schemaVersion', message: FORMAT_V2_NOT_ACCEPTED, params: { accepted: ['1'] }, code: 'F03' }],
    });
  });

  test('every 1.x fixture: same verdict as the 1.x schema alone, and valid ones have no errors', () => {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(v1);
    let checked = 0;
    for (const f of readdirSync(FIXTURES).filter((n) => n.endsWith('.json') && !n.includes('.expected.') && !n.includes('.refined.'))) {
      const input = JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'));
      if (modelFormat(input) === '2') continue;
      const result = validateLogicCoreSchema(input);
      expect([f, result.valid]).toEqual([f, validate(input)]);
      if (result.valid) expect(result).toEqual({ valid: true, errors: [] });
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe('surfaces that have not opted in reject a 2.0 model with the one error', () => {
  const entry = { path: '/$schemaVersion', message: FORMAT_V2_NOT_ACCEPTED, params: { accepted: ['1'] }, code: 'F03' };

  // MCP opted in (embedded catalogue object): the model's own catalogue path is never read, one C13 entry.
  test.each(['generate_bpmn', 'validate_bpmn', 'orchestrate_bpmn'])('MCP %s reads 2.0: a catalogue path without an object is C13', async (name) => {
    expect(TOOLS.some((t) => t.name === name)).toBe(true);
    const r = JSON.parse((await handleToolCall({ params: { name, arguments: { logicCore: m56() } } })).content[0].text);
    expect(r.status).toBe('schema_error');
    expect(r.errors).toEqual([expect.objectContaining({ path: '/catalog', code: 'C13' })]);
  });

  test.each(['2', '2.7'])('MCP validate_bpmn names the unsupported version %s, not the fixed text', async (version) => {
    const r = JSON.parse((await handleToolCall({ params: { name: 'validate_bpmn', arguments: { logicCore: { ...m56(), $schemaVersion: version } } } })).content[0].text);
    expect(r.status).toBe('schema_error');
    expect(r.errors).toEqual([{ path: '/$schemaVersion', message: `$schemaVersion "${version}" is not supported; only "2.0" and "2.1" are supported`, params: { supported: ['2.0', '2.1'] }, code: 'F02' }]);
  });

  test('MCP generate_bpmn with drillDown: the same C13 gate answers first', async () => {
    const r = JSON.parse((await handleToolCall({ params: { name: 'generate_bpmn', arguments: { logicCore: m56(), drillDown: true } } })).content[0].text);
    expect(r.status).toBe('schema_error');
    expect(r.errors).toEqual([expect.objectContaining({ path: '/catalog', code: 'C13' })]);
  });

  test.each(['2', '2.7'])('generateDiagramSet names the unsupported version %s as the F02 error of a blocked parent', async (version) => {
    const set = await generateDiagramSet({ ...m56(), $schemaVersion: version });
    const message = `[F02] $schemaVersion "${version}" is not supported; only "2.0" and "2.1" are supported`;
    expect(set.parent.bpmnXml).toBeNull();
    expect(set.parent.validation.errors).toEqual([message]);
    expect(set.parent.validation.findings).toEqual([{ code: 'F02', severity: 'ERROR', message }]);
    expect(set.subProcesses).toEqual({});
  });

  test('the message names the entry points that read 2.0', () => {
    expect(FORMAT_V2_NOT_ACCEPTED).toBe('format 2.0 is not accepted here yet — generate, validate and orchestrate read it on the CLI, in the library, over MCP and over HTTP');
  });

  test('orchestrate() reads it: a catalogue path without an object is the C13 verdict, not the refusal', async () => {
    const result = await orchestrate(m56());
    expect(result.compliance.isCompliant).toBe(false);
    expect(result.compliance.errors).toEqual([expect.stringMatching(/^\[C13\] the model names catalogue/)]);
    expect(result.bpmnXml).toBeNull();
  });

  describe('CLIs', () => {
    let dir;
    beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'v2-gate-')); writeFileSync(join(dir, 'm56.json'), JSON.stringify(m56())); });
    afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
    const run = (script, ...args) => spawnSync('node', [resolve(__dirname, '..', script), ...args], { encoding: 'utf8' });

    test('redesign-cli exits 1 and says so in German', () => {
      const r = run('bpmn/redesign-cli.js', join(dir, 'm56.json'), 'parallelize');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('✗ [F03] Format 2.0 wird hier noch nicht angenommen.');
    });

    test.each(['redesign-cli', 'scenarios'])('%s names an unsupported version with F02', (which) => {
      writeFileSync(join(dir, 'm27.json'), JSON.stringify({ ...m56(), $schemaVersion: '2.7' }));
      const r = which === 'redesign-cli' ? run('bpmn/redesign-cli.js', join(dir, 'm27.json'), 'parallelize') : run('scenarios/pipeline.js', join(dir, 'm27.json'));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('✗ [F02] $schemaVersion "2.7" is not supported; only "2.0" and "2.1" are supported');
    });

    test.each(['redesign-cli', 'scenarios'])('%s refuses a "2.1" model with F03, not F02', (which) => {
      writeFileSync(join(dir, 'm21.json'), JSON.stringify({ ...m56(), $schemaVersion: '2.1' }));
      const r = which === 'redesign-cli' ? run('bpmn/redesign-cli.js', join(dir, 'm21.json'), 'parallelize') : run('scenarios/pipeline.js', join(dir, 'm21.json'));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(which === 'redesign-cli' ? '✗ [F03] Format 2.0 wird hier noch nicht angenommen.' : `✗ [F03] ${FORMAT_V2_NOT_ACCEPTED}`);
      expect(r.stderr).not.toContain('[F02]');
    });

    test('scenarios/pipeline.js exits 1 with a message naming 2.0', () => {
      const r = run('scenarios/pipeline.js', join(dir, 'm56.json'));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('2.0');
      expect(r.stderr).toContain(`✗ [F03] ${FORMAT_V2_NOT_ACCEPTED}`);
    });
  });
});

describe('language: the natural language of the labels (2.0)', () => {
  const ACC = { accept: ['2'] };
  const shapes = { 'single process': m56, collaboration: collab };

  describe.each(Object.entries(shapes))('%s', (_n, make) => {
    test.each(['de', 'en-GB', 'fr', 'zh-Hant-TW'])('%s is valid', (language) => {
      expect(validateModelSchema({ ...make(), language }, ACC)).toEqual({ valid: true, errors: [], format: '2' });
    });
    test.each(['German', 'DE', 'd', '', 5, null])('%j is rejected with one error at /language', (language) => {
      const { valid, errors } = validateModelSchema({ ...make(), language }, ACC);
      expect(valid).toBe(false);
      expect(errors.map((e) => e.path)).toEqual(['/language']);
    });
  });

  test('language on a pool, a node or a lane is an additional property', () => {
    const onPool = collab(); onPool.pools[0].language = 'de';
    const onNode = m56(); onNode.nodes[0].language = 'de';
    const onLane = m56(); onLane.lanes = [{ id: 'l', name: 'L', language: 'de' }];
    for (const m of [onPool, onNode, onLane]) {
      const { valid, errors } = validateModelSchema(m, ACC);
      expect(valid).toBe(false);
      expect(errors.map((e) => e.message).join('\n')).toContain('must NOT have additional properties');
    }
  });
});

/**
 * Format 2.0 at the schema gate (design 5.1, 5.4, 5.5): the v2 schema, `modelFormat`,
 * `validateModelSchema` with its `accept` list, and what every surface that has not opted in says
 * to a 2.0 model: one error, FORMAT_V2_NOT_ACCEPTED.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  modelFormat, validateModelSchema, validateLogicCoreSchema, FORMAT_V2_NOT_ACCEPTED,
} from './schema-gate.js';
import { inputSchemaPath, inputSchemaV2Path } from '../shared/resource-paths.js';
import { TOOLS, handleToolCall } from '../mcp-bpmn-server.js';
import { orchestrate } from '../orchestrator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../../tests/fixtures');
const v1 = JSON.parse(readFileSync(inputSchemaPath(), 'utf8'));
const v2 = JSON.parse(readFileSync(inputSchemaV2Path(), 'utf8'));

// Design 5.6, the 2.0 model, verbatim.
const m56 = () => ({ $schemaVersion: '2.0', catalog: '../bpmn-catalog.json', id: 'Process_Schaden', name: 'Schaden regulieren',
  nodes: [
    { id: 'start', type: 'startEvent', name: 'Schaden gemeldet' }, { id: 'gw', type: 'exclusiveGateway', name: 'Regress möglich?' },
    { id: 'pruefen', type: 'userTask', name: 'Schaden prüfen', assignments: [{ type: 'D', actor: 'sb_schaden' }] },
    { id: 'regr', type: 'userTask', name: 'Regress prüfen',
      assignments: [{ type: 'D', actor: 'regress' }, { type: 'I', actor: 'sb_schaden' }] },
    { id: 'zahlen', type: 'userTask', name: 'Zahlung anweisen', assignments: [{ type: 'D', actor: 'zahlung' }] },
    { id: 'end', type: 'endEvent', name: 'Schaden reguliert' }],
  edges: [{ source: 'start', target: 'pruefen' }, { source: 'pruefen', target: 'gw' },
    { source: 'gw', target: 'regr', label: 'ja' }, { source: 'gw', target: 'zahlen', label: 'nein' },
    { source: 'regr', target: 'zahlen' }, { source: 'zahlen', target: 'end' }] });

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

  test('Node.properties is 1.x minus lane, role, system plus assignments; the rest is equal', () => {
    const expected = Object.keys(v1.$defs.Node.properties).filter((k) => !['lane', 'role', 'system'].includes(k)).concat('assignments');
    expect(Object.keys(v2.$defs.Node.properties).sort()).toEqual(expected.sort());
    for (const k of expected.filter((x) => x !== 'assignments')) expect(v2.$defs.Node.properties[k]).toEqual(v1.$defs.Node.properties[k]);
  });

  test('no Lane definition and no lanes property anywhere', () => {
    expect(v2.$defs.Lane).toBeUndefined();
    expect(JSON.stringify(v2)).not.toMatch(/"lanes"|"lane"|"role"|"system"/);
  });
});

describe('modelFormat', () => {
  test.each([
    [{ $schemaVersion: '2.0' }, '2'], [{ $schemaVersion: '2.7' }, '2'],
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
    expect(r).toEqual({ valid: false, format: '2', errors: [{ path: '/$schemaVersion', message: FORMAT_V2_NOT_ACCEPTED, params: { accepted: ['1'] } }] });
  });

  test('a 1.x model is rejected when only 2 is accepted', () => {
    const r = validateModelSchema({ nodes: [{ id: 'a', type: 'task' }], edges: [] }, { accept: ['2'] });
    expect(r.valid).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].params).toEqual({ accepted: ['2'] });
  });

  const withNode = (extra) => { const m = m56(); Object.assign(m.nodes[2], extra); return m; };
  test.each([
    ['lane', () => withNode({ lane: 'L1' }), '/nodes/2'],
    ['lanes', () => ({ ...m56(), lanes: [{ id: 'L1' }] }), '(root)'],
    ['role', () => withNode({ role: 'Sachbearbeitung' }), '/nodes/2'],
    ['system', () => withNode({ system: 'SAP' }), '/nodes/2'],
    ['dataStoreReference node', () => { const m = m56(); m.nodes.push({ id: 'ds', type: 'dataStoreReference' }); return m; }, '/nodes/6/type'],
    ['pool id "Pool 1"', () => { const m = collab(); m.pools[0].id = 'Pool 1'; return m; }, '/pools/0/id'],
    ['process id missing', () => { const m = m56(); delete m.id; return m; }, '(root)'],
    ['catalog plus actors', () => ({ ...m56(), actors: [{ id: 'a', name: 'A' }] }), '(root)'],
    ['scheme without actors', () => ({ ...m56(), scheme: 'demi' }), '(root)'],
    ['assignments on a textAnnotation', () => { const m = m56(); m.nodes.push({ id: 'ta', type: 'textAnnotation', assignments: [] }); return m; }, '/nodes/6'],
    ['assignment without actor', () => withNode({ assignments: [{ type: 'D' }] }), '/nodes/2/assignments/0'],
    ['assignment type not a scheme key', () => withNode({ assignments: [{ type: '9', actor: 'a' }] }), '/nodes/2/assignments/0/type'],
    ['assignment actor not an actor id', () => withNode({ assignments: [{ type: 'D', actor: '1x' }] }), '/nodes/2/assignments/0/actor'],
    ['$schemaVersion 2.01 (leading zero)', () => ({ ...m56(), $schemaVersion: '2.01' }), '/$schemaVersion'],
  ])('%s is one error naming the path', (_, make, path) => {
    const errors = errorsOf(make());
    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe(path);
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
      errors: [{ path: '/$schemaVersion', message: FORMAT_V2_NOT_ACCEPTED, params: { accepted: ['1'] } }],
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
  const entry = { path: '/$schemaVersion', message: FORMAT_V2_NOT_ACCEPTED, params: { accepted: ['1'] } };

  test.each(['generate_bpmn', 'validate_bpmn', 'orchestrate_bpmn'])('MCP %s', async (name) => {
    expect(TOOLS.some((t) => t.name === name)).toBe(true);
    const r = JSON.parse((await handleToolCall({ params: { name, arguments: { logicCore: m56() } } })).content[0].text);
    expect(r.status).toBe('schema_error');
    expect(r.errors).toEqual([entry]);
  });

  test('orchestrate() rejects with the message', async () => {
    await expect(orchestrate(m56())).rejects.toThrow(FORMAT_V2_NOT_ACCEPTED);
  });

  describe('CLIs', () => {
    let dir;
    beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'v2-gate-')); writeFileSync(join(dir, 'm56.json'), JSON.stringify(m56())); });
    afterAll(() => {});
    const run = (script, ...args) => spawnSync('node', [resolve(__dirname, '..', script), ...args], { encoding: 'utf8' });

    test('redesign-cli exits 1 and says so in German', () => {
      const r = run('bpmn/redesign-cli.js', join(dir, 'm56.json'), 'parallelize');
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('✗ Format 2.0 wird hier noch nicht angenommen.');
    });

    test('scenarios/pipeline.js exits 1 with a message naming 2.0', () => {
      const r = run('scenarios/pipeline.js', join(dir, 'm56.json'));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('2.0');
    });
  });
});

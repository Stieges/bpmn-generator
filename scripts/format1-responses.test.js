/**
 * Characterisation of the format 1.x responses.
 *
 * A request whose model is 1.x (or has no `$schemaVersion`) gets byte-identical responses on every
 * surface: library result, CLI stderr, MCP, HTTP, thrown messages. This file pins them with exact
 * values (full JSON, exact strings), written against the code before message codes existed. Later
 * changes keep it green unchanged.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { runPipeline } from './bpmn/pipeline.js';
import { server } from './http-server.js';
import { TOOLS, handleToolCall } from './mcp-bpmn-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, '../tests/fixtures/simple-approval.json');
const simpleApproval = () => JSON.parse(readFileSync(FIXTURE, 'utf8'));

const WARNING = 'Task "Revise document" folgt nicht der Objekt+Verb-Konvention (z.B. "Antrag prüfen"). Heuristik — exakte Wortartprüfung: M05/M06.';
const PREFIXED_WARNING = `[Main Pool] ${WARNING}`;

// The exact serialisations (key order included) of the `validation` objects.
const FULL_VALIDATION = `{"errors":[],"warnings":${JSON.stringify([PREFIXED_WARNING])},"infos":[],"advisories":[],"metrics":{},"xmlWarnings":[],"hints":[]}`;
const SHORT_VALIDATION = `{"errors":[],"warnings":${JSON.stringify([PREFIXED_WARNING])},"infos":[],"advisories":[],"metrics":{}}`;

const VIEW_ERROR = 'view "rollen" forms lanes from assignments; this model (format 1.x) carries its own lanes — translate it with node bpmn/migrate.js';

describe('format 1.x characterisation: library and CLI', () => {
  test('runPipeline: the exact validation object', async () => {
    const result = await runPipeline(simpleApproval());
    expect(JSON.stringify(result.validation)).toBe(FULL_VALIDATION);
  });

  test('runPipeline with a catalog option throws the exact TypeError', async () => {
    const err = await runPipeline(simpleApproval(), { catalog: {} }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(err.message).toBe('catalog applies to format 2.0 models only');
    expect(err.messageCode).toBeUndefined();
    expect(err.code).toBeUndefined();
  });

  test('CLI --catalog=x with a 1.x model: the exact stderr and exit 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'f1resp-'));
    try {
      const res = spawnSync(process.execPath, [resolve(__dirname, 'bpmn/pipeline.js'), FIXTURE, join(dir, 'out.bpmn'), '--catalog=x'], { encoding: 'utf8' });
      expect(res.status).toBe(1);
      expect(res.stderr).toBe('✗ --catalog applies to format 2.0 models only\n');
      expect(res.stdout).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('format 1.x characterisation: HTTP', () => {
  let base;
  beforeAll(async () => {
    await new Promise((r) => server.listen(0, r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  const post = async (path, body) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();
    const { correlationId, ...rest } = json;
    expect(typeof correlationId).toBe('string');
    return { status: res.status, keys: Object.keys(json), body: rest };
  };

  test('/generate: the exact validation JSON', async () => {
    const { status, body } = await post('/api/v1/generate', { logicCore: simpleApproval() });
    expect(status).toBe(200);
    expect(JSON.stringify(body.validation)).toBe(FULL_VALIDATION);
  });

  test('/validate: the exact validation JSON and keys', async () => {
    const { status, keys, body } = await post('/api/v1/validate', { logicCore: simpleApproval() });
    expect(status).toBe(200);
    expect(keys).toEqual(['correlationId', 'status', 'validation']);
    expect(JSON.stringify(body.validation)).toBe(SHORT_VALIDATION);
  });

  test('/orchestrate: the exact validation JSON', async () => {
    const { status, body } = await post('/api/v1/orchestrate', { logicCore: simpleApproval() });
    expect(status).toBe(200);
    expect(JSON.stringify(body.validation)).toBe(FULL_VALIDATION);
  });

  test('schema_error of an unknown node field: the exact body', async () => {
    const bad = simpleApproval();
    bad.pools[0].nodes[0].bogus = 1;
    const { status, body } = await post('/api/v1/generate', { logicCore: bad });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toBe(JSON.stringify({
      status: 'schema_error',
      errors: [{ path: '/pools/0/nodes/0', message: 'must NOT have additional properties', params: { additionalProperty: 'bogus' } }],
    }));
  });

  test('view_error of an inline lanes view on a 1.x model: the exact body', async () => {
    const { status, body } = await post('/api/v1/generate', { logicCore: simpleApproval(), view: { view: 'rollen', version: '1.0', lanes: 'role' } });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).toBe(JSON.stringify({ status: 'view_error', error: VIEW_ERROR }));
  });
});

describe('format 1.x characterisation: MCP', () => {
  const call = (name, args) => handleToolCall({ params: { name, arguments: args } });

  test('the three tools are listed', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(expect.arrayContaining(['generate_bpmn', 'validate_bpmn', 'orchestrate_bpmn']));
  });

  test('generate_bpmn: one block, the exact keys and validation', async () => {
    const r = await call('generate_bpmn', { logicCore: simpleApproval() });
    expect(r.content).toHaveLength(1);
    const j = JSON.parse(r.content[0].text);
    expect(Object.keys(j)).toEqual(['bpmnXml', 'svg', 'validation', 'diagnostics']);
    expect(JSON.stringify(j.validation)).toBe(FULL_VALIDATION);
  });

  test('validate_bpmn: the exact keys and values', async () => {
    const r = await call('validate_bpmn', { logicCore: simpleApproval() });
    expect(r.content).toHaveLength(1);
    const j = JSON.parse(r.content[0].text);
    expect(JSON.stringify(j)).toBe(SHORT_VALIDATION);
  });

  test('orchestrate_bpmn: the exact keys and validation', async () => {
    const r = await call('orchestrate_bpmn', { logicCore: simpleApproval() });
    expect(r.content).toHaveLength(1);
    const j = JSON.parse(r.content[0].text);
    expect(Object.keys(j)).toEqual(['bpmnXml', 'svg', 'validation', 'diagnostics', 'compliance', 'history', 'iterations']);
    expect(JSON.stringify(j.validation)).toBe(FULL_VALIDATION);
  });

  test('schema_error text of an unknown node field', async () => {
    const bad = simpleApproval();
    bad.pools[0].nodes[0].bogus = 1;
    const r = await call('generate_bpmn', { logicCore: bad });
    expect(r.isError).toBeUndefined();
    expect(r.content).toHaveLength(1);
    expect(r.content[0].text).toBe(JSON.stringify({
      status: 'schema_error',
      errors: [{ path: '/pools/0/nodes/0', message: 'must NOT have additional properties', params: { additionalProperty: 'bogus' } }],
    }, null, 2));
  });

  test('a lanes view on a 1.x model: the exact error message', async () => {
    const err = await call('generate_bpmn', { logicCore: simpleApproval(), view: 'rollen' }).then(() => null, (e) => e);
    expect(err?.name).toBe('ViewRejectedError');
    expect(err.message).toBe(VIEW_ERROR);
    expect(err.messageCode).toBeUndefined();
    expect(err.code).toBe('VIEW_REJECTED');
  });
});

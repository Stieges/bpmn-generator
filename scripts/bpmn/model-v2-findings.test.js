/**
 * `validation.findings` (format 2.x runs only): each message of a 2.x run as `{ code, severity,
 * message }`, `message` the very string in the list it mirrors. The rule engine gives its findings
 * on request only (`withFindings`), so a run without the option — every 1.x run — keeps its shape.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { runPipeline, generateDiagramSet } from './pipeline.js';
import { validateLogicCore } from './validate.js';
import { runRules } from './rules.js';
import { loadNamedView } from '../shared/view.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const readJson = (p) => JSON.parse(readFileSync(resolve(root, p), 'utf8'));
const copy = (v) => JSON.parse(JSON.stringify(v));
// The example of design 5.6, as committed fixture.
const SCHADEN = readJson('tests/fixtures-v2/schaden.json');
const CATALOG = readJson('tests/fixtures-v2/schaden-catalog.json');
const run = (model, opts = {}) => runPipeline(copy(model), { catalog: copy(CATALOG), ...opts });
const VIEWS = ['rollen', 'einheiten'];

describe('validation.findings on format 2.x runs', () => {
  test('an unknown actor: one C01 ERROR finding mirroring the error', async () => {
    const model = copy(SCHADEN);
    model.nodes[2].assignments[0].actor = 'unbekannt';
    const { validation } = await run(model);
    expect(validation.errors).toHaveLength(1);
    expect(validation.findings).toEqual([{ code: 'C01', severity: 'ERROR', message: validation.errors[0] }]);
  });

  test('the 5.6 model without its end event: S02 ERROR, then the rule warnings', async () => {
    const model = copy(SCHADEN);
    model.nodes = model.nodes.filter((n) => n.id !== 'end');
    model.edges = model.edges.filter((e) => e.target !== 'end');
    const { validation } = await run(model);
    expect(validation.errors).toContain('Missing endEvent.');
    expect(validation.findings).toContainEqual({ code: 'S02', severity: 'ERROR', message: 'Missing endEvent.' });
    expect(validation.findings).toEqual([
      ...validation.errors.map((message) => expect.objectContaining({ severity: 'ERROR', message })),
      ...validation.warnings.map((message) => expect.objectContaining({ severity: 'WARNING', message })),
    ]);
  });

  test.each(VIEWS)('schaden.json under view %s: findings mirror errors and warnings', async (name) => {
    const { validation } = await run(SCHADEN, { view: loadNamedView(name) });
    expect(validation.findings.filter((f) => f.severity === 'WARNING').map((f) => f.message)).toEqual(validation.warnings);
    for (const f of validation.findings) {
      expect([...validation.errors, ...validation.warnings]).toContain(f.message);
    }
  });

  test('a decisions option that fails the Decision-Core schema: every finding F05, message unchanged', async () => {
    const { validation } = await run(SCHADEN, { decisions: [{}] });
    expect(validation.errors.length).toBeGreaterThan(0);
    expect(validation.findings.map((f) => f.message)).toEqual(validation.errors);
    for (const f of validation.findings) expect(f).toEqual({ code: 'F05', severity: 'ERROR', message: f.message });
  });

  test('a C10 lane id collision: the C10 findings, then the kept rule warnings', async () => {
    const model = copy(SCHADEN);
    model.nodes.find((n) => n.id === 'gw').name = 'Regress';
    model.edges[5].id = 'L.Process_Schaden.zahlung';
    const { validation } = await run(model);
    expect(validation.warnings.length).toBeGreaterThan(0);
    expect(validation.findings).toEqual([
      ...validation.errors.map((message) => ({ code: 'C10', severity: 'ERROR', message })),
      ...validation.warnings.map((message) => ({ code: 'M02', severity: 'WARNING', message })),
    ]);
  });

  test('strict profile: errors of every layer come before any warning, each in emission order', async () => {
    // The catalogue walks S, M, P, WF, so under the strict profile an S warning (S07) is emitted
    // before an M or WF error; the findings still list all errors first.
    const model = copy(SCHADEN);
    model.nodes.find((n) => n.id === 'gw').name = 'Regress';
    model.nodes = model.nodes.filter((n) => n.id !== 'end');
    model.edges = model.edges.filter((e) => e.target !== 'end');
    const { validation } = await run(model, { ruleProfile: resolve(root, 'rules/strict-profile.json') });
    expect(validation.warnings.length).toBeGreaterThan(0);
    expect(new Set(validation.findings.map((f) => f.code.slice(0, 1)))).toEqual(new Set(['S', 'M', 'W']));
    expect(validation.findings.map((f) => f.message)).toEqual([...validation.errors, ...validation.warnings]);
  });

  test('generateDiagramSet with a 2.x model: the F04 refusal of its parent carries its finding', async () => {
    const { parent } = await generateDiagramSet(copy(SCHADEN), { catalog: copy(CATALOG) });
    expect(parent.validation.findings).toEqual([{ code: 'F04', severity: 'ERROR', message: parent.validation.errors[0] }]);
  });

  test('a mode not available for 2.0: one F04 finding', async () => {
    const { validation } = await run(SCHADEN, { mode: 'optimize' });
    expect(validation.findings).toEqual([{ code: 'F04', severity: 'ERROR', message: validation.errors[0] }]);
  });

  test('a 1.x run carries no findings key', async () => {
    const { validation } = await runPipeline(readJson('tests/fixtures/simple-approval.json'));
    expect(validation).not.toHaveProperty('findings');
  });

  test('a GenerateResponse built from a 2.x run validates against the published contract', async () => {
    const gen = await run(SCHADEN, { view: loadNamedView('rollen') });
    const hasErrors = gen.validation.errors.length > 0;
    const diBroken = gen.diagnostics ? !gen.diagnostics.ok : false;
    const response = {
      correlationId: 'docs-gate',
      status: hasErrors ? 'validation_error' : (diBroken ? 'diagram_error' : 'success'),
      bpmnXml: gen.bpmnXml,
      svg: gen.svg,
      validation: gen.validation,
      diagnostics: gen.diagnostics,
      callbackStatus: 'not_requested',
    };
    expect(gen.validation).toHaveProperty('findings');
    const schema = readJson('references/api-schema.json');
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    ajv.addSchema(schema, schema.$id);
    const validate = ajv.getSchema(`${schema.$id}#/$defs/GenerateResponse`);
    expect(validate(response) ? [] : validate.errors).toEqual([]);
  });
});

describe('the rule engine gives findings on request only', () => {
  const orGatewayModel = {
    id: 'P', name: 'Kanäle',
    nodes: [
      { id: 's', type: 'startEvent', name: 'Start' },
      { id: 'go', type: 'inclusiveGateway', name: 'Welche Kanäle?' },
      { id: 'a', type: 'task', name: 'Mail senden' },
      { id: 'b', type: 'task', name: 'Brief senden' },
      { id: 'gj', type: 'inclusiveGateway', name: '', has_join: true },
      { id: 'e', type: 'endEvent', name: 'Ende' },
    ],
    edges: [
      { id: 'f1', source: 's', target: 'go' }, { id: 'f2', source: 'go', target: 'a' }, { id: 'f3', source: 'go', target: 'b' },
      { id: 'f4', source: 'a', target: 'gj' }, { id: 'f5', source: 'b', target: 'gj' }, { id: 'f6', source: 'gj', target: 'e' },
    ],
  };

  test('validateLogicCore with withFindings: the WF_OR INFO finding of the workflow-net layer', () => {
    const result = validateLogicCore(orGatewayModel, resolve(root, 'rules/strict-profile.json'), { withFindings: true });
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'WF_OR', severity: 'INFO' }));
    const bySeverity = (s) => result.findings.filter((f) => f.severity === s).map((f) => f.message);
    expect(bySeverity('ERROR')).toEqual(result.errors);
    expect(bySeverity('WARNING')).toEqual(result.warnings);
    expect(bySeverity('INFO')).toEqual(result.infos);
  });

  test('validateLogicCore without the option: no findings key', () => {
    expect(validateLogicCore(orGatewayModel, resolve(root, 'rules/strict-profile.json'))).not.toHaveProperty('findings');
  });

  const fixtures = readdirSync(resolve(root, 'tests/fixtures')).filter((f) => f.endsWith('.json'));
  test.each(fixtures)('runRules without the option: no findings key (%s)', (file) => {
    const result = runRules(readJson(`tests/fixtures/${file}`));
    expect(Object.keys(result)).toEqual(['errors', 'warnings', 'infos', 'advisories', 'metrics']);
  });
});

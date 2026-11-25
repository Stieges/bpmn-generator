/**
 * runPipeline with a view (shared/view.js): the view resolves first, the author's model is
 * validated, then the view's derivations run and every later step sees the derived model.
 * Each derived element is reported as a hint (`validation.hints`, code H01 for a join gateway).
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './pipeline.js';
import { ViewRejectedError, resolveViewOptions } from '../shared/view.js';
import { loadNamedRuleProfile } from '../shared/rule-profile.js';
import { rulesDirPath } from '../shared/resource-paths.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = (file) => readFileSync(resolve(root, 'tests/fixtures', file), 'utf8');
const simpleApproval = () => JSON.parse(fixture('simple-approval.json'));
const viewPath = (name) => resolve(root, 'views', `${name}-view.json`);
const findings = ({ validation: { errors, warnings, advisories, metrics } }) => ({ errors, warnings, advisories, metrics });

describe('runPipeline — view', () => {
  test('explicit-joins derives gw_join_task1 and reports it as one H01 hint', async () => {
    const result = await runPipeline(simpleApproval(), { view: viewPath('explicit-joins') });
    expect(result.bpmnXml).toContain('id="gw_join_task1"');
    expect(result.svg).toContain('gw_join_task1');
    expect(result.validation.hints).toEqual([
      { code: 'H01', message: expect.stringContaining('gw_join_task1'), elements: ['gw_join_task1', 'task1', 'flow_gw_join_task1_task1'] },
    ]);
  });

  test.each([
    ['no view', {}],
    ['the default view', { view: viewPath('default') }],
    ['view: null (not given, as over MCP and HTTP)', { view: null }],
  ])('%s: XML and SVG equal the committed golden files, no hints', async (_, opts) => {
    const result = await runPipeline(simpleApproval(), opts);
    expect(result.bpmnXml).toBe(fixture('simple-approval.expected.bpmn'));
    expect(result.svg).toBe(fixture('simple-approval.expected.svg'));
    expect(result.validation.hints).toEqual([]);
  });

  test('the caller\'s model and view are not changed', async () => {
    const lc = simpleApproval();
    const view = { view: 'joins', version: '1.0', derivations: { joinGateways: true } };
    const before = JSON.stringify({ lc, view });
    await runPipeline(lc, { view });
    expect(JSON.stringify({ lc, view })).toBe(before);
  });

  test('a view\'s ruleProfile applies; an explicit ruleProfile option wins over it', async () => {
    const view = { view: 't', version: '1.0', ruleProfile: 'strict' };
    const strict = await runPipeline(simpleApproval(), { ruleProfile: loadNamedRuleProfile('strict', rulesDirPath()) });
    expect(strict.validation.errors.length).toBeGreaterThan(0); // strict and default really differ here
    expect(findings(await runPipeline(simpleApproval(), { view }))).toEqual(findings(strict));

    const explicit = await runPipeline(simpleApproval(), { ruleProfile: {} });
    expect(explicit.validation.errors).toEqual([]);
    expect(findings(await runPipeline(simpleApproval(), { view, ruleProfile: {} }))).toEqual(findings(explicit));
  });

  test('a view\'s layout switch gives the same XML as the option', async () => {
    const byView = await runPipeline(simpleApproval(), { view: { view: 't', version: '1.0', layout: { bendRule: false } } });
    const byOption = await runPipeline(simpleApproval(), { bendRule: false });
    expect(byView.bpmnXml).toBe(byOption.bpmnXml);
    expect(byView.bpmnXml).not.toBe(fixture('simple-approval.expected.bpmn'));
  });

  test('an invalid view rejects with ViewRejectedError', async () => {
    await expect(runPipeline(simpleApproval(), { view: { view: 't', version: '1.0', extra: 1 } }))
      .rejects.toBeInstanceOf(ViewRejectedError);
    await expect(runPipeline(simpleApproval(), { view: viewPath('no-such') }))
      .rejects.toBeInstanceOf(ViewRejectedError);
  });

  test('rules judge the author\'s model: findings are identical with and without the derivation', async () => {
    const plain = await runPipeline(simpleApproval());
    const joined = await runPipeline(simpleApproval(), { view: viewPath('explicit-joins') });
    expect(findings(joined)).toEqual(findings(plain));
  });

  test('a validation error returns early with an empty hints array', async () => {
    const lc = simpleApproval();
    lc.pools[0].edges.push({ id: 'bad', source: 'task1', target: 'nowhere' });
    const result = await runPipeline(lc, { view: viewPath('explicit-joins') });
    expect(result.bpmnXml).toBeNull();
    expect(result.validation.errors.length).toBeGreaterThan(0);
    expect(result.validation.hints).toEqual([]);
  });
});

describe('resolveViewOptions', () => {
  test('explicit option, then the view, then nothing', () => {
    const view = { view: 't', version: '1.0', layout: { bendRule: false, poolOrder: 'declared' }, derivations: { joinGateways: true } };
    const resolved = resolveViewOptions(view, { bendRule: true, mode: 'optimize' });
    expect(resolved).toMatchObject({ bendRule: true, poolOrder: 'declared', mode: 'optimize', derivations: { joinGateways: true } });
    expect(resolved.nodeLabelsAvoidFlows).toBeUndefined();
    expect('nodeLabelsAvoidFlows' in resolved).toBe(false);
    expect(resolved.ruleProfile).toBeUndefined();
  });

  test('a view\'s ruleProfile name resolves to the profile; no view changes nothing', () => {
    const resolved = resolveViewOptions({ view: 't', version: '1.0', ruleProfile: 'strict' }, {});
    expect(resolved.ruleProfile).toEqual(loadNamedRuleProfile('strict', rulesDirPath()));
    expect(resolveViewOptions(null, { bendRule: false })).toEqual({ bendRule: false, derivations: undefined });
  });
});

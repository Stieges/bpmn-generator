/**
 * The decision table in a Business Rule Task's documentation (cross/decision-doc.js), and its
 * plumbing through runPipeline and the BPMN CLI.
 *
 * What is fenced: the section is generated only when decisions are supplied; the author's text
 * stays before it; a second run REPLACES the section (import → regenerate never duplicates it, on
 * both importers); matching is scripts/scenarios/bridge.js's (unresolved / ambiguous read as such);
 * nested and pooled tasks are reached; and the section is text — the geometry is the same with and
 * without it.
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  applyDecisionDocumentation, stripDecisionSection, decisionSectionBody, DECISION_DOC_BEGIN, DECISION_DOC_END,
} from './decision-doc.js';
import { runPipeline } from '../bpmn/pipeline.js';
import { bpmnToLogicCoreLegacy } from '../bpmn/import.js';
import { moddleParse, moddleToLogicCore } from '../bpmn/moddle-import.js';
import { runDmnPipeline } from '../dmn/pipeline.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(__dirname, '../../tests/fixtures');
const load = (rel) => JSON.parse(readFileSync(resolve(fixtures, rel), 'utf8'));
const claimDc = () => load('dmn/claim-approval.json');

/** The worked example of references/dmn.md: a process whose businessRuleTask calls dec_approvalLevel. */
const claimProcess = () => ({
  id: 'Process_claimApproval',
  name: 'Claim approval',
  nodes: [
    { id: 'start', type: 'startEvent', name: 'Claim received' },
    { id: 'task_evaluateApproval', type: 'businessRuleTask', name: 'Evaluate approval level', decisionRef: 'dec_approvalLevel' },
    { id: 'gw_level', type: 'exclusiveGateway', name: 'Approval level?' },
    { id: 'task_pay', type: 'serviceTask', name: 'Release payment' },
    { id: 'task_review', type: 'userTask', name: 'Review claim', documentation: 'Four eyes.' },
    { id: 'gw_join', type: 'exclusiveGateway', name: '', has_join: true },
    { id: 'end', type: 'endEvent', name: 'Claim settled' },
  ],
  edges: [
    { id: 'f1', source: 'start', target: 'task_evaluateApproval' },
    { id: 'f2', source: 'task_evaluateApproval', target: 'gw_level' },
    { id: 'f3', source: 'gw_level', target: 'task_pay', label: 'auto', isDefault: true },
    { id: 'f4', source: 'gw_level', target: 'task_review', label: 'clerk or manager' },
    { id: 'f5', source: 'task_review', target: 'gw_join' },
    { id: 'f6', source: 'task_pay', target: 'gw_join' },
    { id: 'f7', source: 'gw_join', target: 'end' },
  ],
});
const task = (lc, id = 'task_evaluateApproval') => lc.nodes.find((n) => n.id === id);
const count = (text, needle) => String(text).split(needle).length - 1;

describe('applyDecisionDocumentation', () => {
  test('a resolved task gets a marked section: title line, hit policy, aligned table', () => {
    const lc = claimProcess();
    const out = applyDecisionDocumentation(lc, [claimDc()]);
    expect(task(out).documentation).toBe([
      DECISION_DOC_BEGIN,
      'Decision: Approval level (dec_approvalLevel) — generated from Definitions_claimApproval',
      'Hit policy: UNIQUE (U) – exactly one rule can match',
      '  | WHEN          |                      || THEN',
      'U | Claim amount  | Customer segment     || level',
      '  | number        | "premium","standard" || "auto","clerk","manager"',
      '--+---------------+----------------------++-------------------------',
      '1 | < 1000        | –                    || "auto"',
      '2 | [1000..10000) | "premium"            || "clerk"',
      '3 | [1000..10000) | "standard"           || "manager"',
      '4 | >= 10000      | –                    || "manager"',
      DECISION_DOC_END,
    ].join('\n'));
    expect(task(out, 'task_review').documentation).toBe('Four eyes.');
    expect(task(lc).documentation).toBeUndefined(); // the input is never changed
  });

  test('the author\'s documentation stays, before the section; a second run replaces the section', () => {
    const lc = claimProcess();
    task(lc).documentation = 'Owned by the claims team.\nSee policy 7.';
    const once = applyDecisionDocumentation(lc, [claimDc()]);
    expect(task(once).documentation.startsWith('Owned by the claims team.\nSee policy 7.\n\n' + DECISION_DOC_BEGIN)).toBe(true);
    const twice = applyDecisionDocumentation(once, [claimDc()]);
    expect(task(twice).documentation).toBe(task(once).documentation);
    const changed = claimDc();
    changed.nodes[2].decisionTable.hitPolicy = 'FIRST';
    const replaced = applyDecisionDocumentation(once, [changed]);
    expect(count(task(replaced).documentation, 'BEGIN generated')).toBe(1);
    expect(task(replaced).documentation).toContain('Hit policy: FIRST (F)');
    expect(task(replaced).documentation).not.toContain('UNIQUE');
  });

  test('without the decision model: "Calls decision: <ref> (table not supplied)"', () => {
    const out = applyDecisionDocumentation(claimProcess(), []);
    expect(task(out).documentation).toBe(`${DECISION_DOC_BEGIN}\nCalls decision: dec_approvalLevel (table not supplied)\n${DECISION_DOC_END}`);
  });

  test('a decision two models define is reported as ambiguous, naming both', () => {
    const a = claimDc();
    const b = claimDc();
    b.id = 'Definitions_other';
    const out = applyDecisionDocumentation(claimProcess(), [a, b]);
    expect(task(out).documentation).toContain('Calls decision: dec_approvalLevel (ambiguous, defined in Definitions_claimApproval, Definitions_other)');
  });

  test('German labels', () => {
    const out = applyDecisionDocumentation(claimProcess(), [claimDc()], { locale: 'de' });
    expect(task(out).documentation).toContain('Entscheidung: Approval level (dec_approvalLevel) — erzeugt aus Definitions_claimApproval');
    expect(task(out).documentation).toContain('  | WENN ');
    expect(applyDecisionDocumentation(claimProcess(), [], { locale: 'de' }).nodes[1].documentation)
      .toContain('Ruft Entscheidung auf: dec_approvalLevel (Tabelle nicht mitgeliefert)');
  });

  test('a task inside a subprocess is reached (the bridge\'s recursive walk)', () => {
    const lc = load('subprocess-child-fidelity.json');
    const dc = { id: 'Defs_rating', namespace: 'http://x', nodes: [{ id: 'RatingDecision', type: 'decision', name: 'Rating', decisionTable: { outputs: [{ name: 'r' }], rules: [{ then: ['1'] }] } }] };
    const out = applyDecisionDocumentation(lc, [dc]);
    const find = (nodes) => nodes.flatMap((n) => [n, ...find(n.nodes ?? [])]);
    const all = find((out.pools ?? [out]).flatMap((p) => p.nodes));
    expect(all.find((n) => n.id === 'c_rule').documentation).toContain('Decision: Rating (RatingDecision)');
  });

  test('pools: a task is matched within its own pool', () => {
    const lc = { pools: [{ ...claimProcess(), id: 'P1' }, { ...claimProcess(), id: 'P2', nodes: claimProcess().nodes.map((n) => (n.id === 'task_evaluateApproval' ? { ...n, decisionRef: 'dec_missing' } : n)) }] };
    const out = applyDecisionDocumentation(lc, [claimDc()]);
    expect(task(out.pools[0]).documentation).toContain('Decision: Approval level');
    expect(task(out.pools[1]).documentation).toContain('Calls decision: dec_missing (table not supplied)');
  });

  test('a decisionRef on something other than a businessRuleTask gets nothing (it is inert there, M11)', () => {
    const lc = claimProcess();
    task(lc, 'task_pay').decisionRef = 'dec_approvalLevel';
    expect(task(applyDecisionDocumentation(lc, [claimDc()]), 'task_pay').documentation).toBeUndefined();
  });

  test('a stale section on a task that no longer calls a decision is removed, the author text kept', () => {
    const lc = claimProcess();
    task(lc, 'task_review').documentation = `Four eyes.\n\n${DECISION_DOC_BEGIN}\nold\n${DECISION_DOC_END}`;
    task(lc, 'task_pay').documentation = `${DECISION_DOC_BEGIN}\nold\n${DECISION_DOC_END}`;
    const out = applyDecisionDocumentation(lc, [claimDc()]);
    expect(task(out, 'task_review').documentation).toBe('Four eyes.');
    expect(task(out, 'task_pay').documentation).toBeUndefined();
  });
});

describe('stripDecisionSection / decisionSectionBody', () => {
  test('text after a section survives; a BEGIN without END drops the rest', () => {
    expect(stripDecisionSection(`a\n\n${DECISION_DOC_BEGIN}\nx\n${DECISION_DOC_END}\n\nb`)).toBe('a\n\nb');
    expect(stripDecisionSection(`a\n${DECISION_DOC_BEGIN}\nx`)).toBe('a');
    expect(stripDecisionSection('plain')).toBe('plain');
    expect(stripDecisionSection(undefined)).toBe('');
  });

  test('the body is what lies between the markers', () => {
    expect(decisionSectionBody(`a\n\n${DECISION_DOC_BEGIN}\nx\ny\n${DECISION_DOC_END}`)).toBe('x\ny');
    expect(decisionSectionBody('plain')).toBeNull();
  });
});

describe('runPipeline({ decisions })', () => {
  test('text, not geometry: the coordMap is identical with and without decisions', async () => {
    const without = await runPipeline(claimProcess());
    const withDecisions = await runPipeline(claimProcess(), { decisions: [claimDc()] });
    expect(withDecisions.coordMap).toEqual(without.coordMap);
    expect(withDecisions.bpmnXml).not.toBe(without.bpmnXml);
    // Remove the documentation element and the two files are the same bytes.
    const noDoc = (xml) => xml.replace(/\s*<bpmn:documentation>[\s\S]*?<\/bpmn:documentation>/g, '');
    expect(noDoc(withDecisions.bpmnXml)).toBe(noDoc(without.bpmnXml));
    expect(withDecisions.validation.errors).toEqual([]);
  });

  test('without the option nothing changes, not even for a model that has a decisionRef', async () => {
    const a = await runPipeline(claimProcess());
    expect(a.bpmnXml).not.toContain('BEGIN generated');
  });

  test('the SVG tooltip of the task carries the section, escaped', async () => {
    const r = await runPipeline(claimProcess(), { decisions: [claimDc()] });
    expect(r.svg).toContain('<title>=== BEGIN generated: DMN decision');
    expect(r.svg).toContain('1 | &lt; 1000');
  });

  test('a Decision-Core that fails its schema blocks the run with a [decisions #i] error', async () => {
    const bad = claimDc();
    delete bad.namespace;
    const r = await runPipeline(claimProcess(), { decisions: [claimDc(), bad] });
    expect(r.bpmnXml).toBeNull();
    expect(r.validation.errors.join('\n')).toMatch(/^\[decisions #1\] .*namespace/m);
    await expect(runPipeline(claimProcess(), { decisions: claimDc() })).rejects.toThrow(/array/);
  });

  test('round trip: both importers keep the section as text, and regenerating replaces it', async () => {
    const first = await runPipeline(claimProcess(), { decisions: [claimDc()] });
    const firstDoc = (lc) => task(lc.pools ? lc.pools[0] : lc).documentation;
    const viaLegacy = bpmnToLogicCoreLegacy(first.bpmnXml);
    const viaModdle = moddleToLogicCore((await moddleParse(first.bpmnXml)).rootElement);
    for (const back of [viaLegacy, viaModdle]) {
      const generated = applyDecisionDocumentation(claimProcess(), [claimDc()]);
      expect(firstDoc(back)).toBe(task(generated).documentation);
      const again = await runPipeline(back, { decisions: [claimDc()] });
      expect(count(again.bpmnXml, 'BEGIN generated')).toBe(1);
      expect(again.bpmnXml.match(/<bpmn:documentation>[\s\S]*?<\/bpmn:documentation>/g))
        .toEqual(first.bpmnXml.match(/<bpmn:documentation>[\s\S]*?<\/bpmn:documentation>/g));
      // Without decisions the imported section is just documentation text, kept as it is.
      const kept = await runPipeline(back);
      expect(count(kept.bpmnXml, 'BEGIN generated')).toBe(1);
    }
  });
});

describe('BPMN CLI --decisions', () => {
  const bpmnDir = resolve(__dirname, '../bpmn');
  const runCli = (args) => spawnSync('node', ['pipeline.js', ...args], { cwd: bpmnDir, encoding: 'utf8' });

  test('accepts Decision-Core JSON and .dmn (by content), writes the section, and --doc shows it as a block', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bpmn-decisions-'));
    const lcPath = join(dir, 'process.json');
    writeFileSync(lcPath, JSON.stringify(claimProcess()), 'utf8');
    const jsonPath = join(dir, 'approval.json');
    writeFileSync(jsonPath, JSON.stringify(claimDc()), 'utf8');
    const dmnPath = join(dir, 'approval.decision'); // no .dmn extension: routed by content
    writeFileSync(dmnPath, (await runDmnPipeline(claimDc())).xml, 'utf8');

    for (const [name, decisions] of [['json', jsonPath], ['dmn', dmnPath]]) {
      const out = join(dir, name);
      const res = runCli([lcPath, out, '--doc', '--decisions', decisions]);
      expect(res.status).toBe(0);
      const xml = readFileSync(`${out}.bpmn`, 'utf8');
      expect(count(xml, 'BEGIN generated')).toBe(1);
      expect(xml).toContain('Decision: Approval level (dec_approvalLevel)');
      const md = readFileSync(`${out}.md`, 'utf8');
      expect(md).toContain('### Evaluate approval level\n\n```text\nDecision: Approval level');
      expect(md).not.toContain('=== BEGIN');
    }
    // --decisions=<files> works too; the value is never read as the output path.
    const res = runCli([lcPath, join(dir, 'eq'), `--decisions=${jsonPath}`]);
    expect(res.status).toBe(0);
    expect(existsSync(join(dir, 'eq.bpmn'))).toBe(true);
  });

  test('a missing value or an unreadable file exits non-zero and writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bpmn-decisions-'));
    const lcPath = join(dir, 'process.json');
    writeFileSync(lcPath, JSON.stringify(claimProcess()), 'utf8');
    expect(runCli([lcPath, join(dir, 'a'), '--decisions']).status).not.toBe(0);
    const res = runCli([lcPath, join(dir, 'b'), '--decisions', join(dir, 'nope.json')]);
    expect(res.status).not.toBe(0);
    expect(existsSync(join(dir, 'b.bpmn'))).toBe(false);
  });
});

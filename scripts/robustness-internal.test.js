import { describe, test, expect } from '@jest/globals';
import { parseArgs, loadConfig, resolveEndpoint } from './robustness/cli.js';
import { createLlmProvider } from './agents/llm-provider.js';
import { readFileSync as _readFile } from 'fs';
import { resolve as _resolve, dirname as _dirname } from 'path';
import { fileURLToPath as _fileURLToPath } from 'url';

const __testDirname = _dirname(_fileURLToPath(import.meta.url));
const _fixturesDir = _resolve(__testDirname, '../tests/fixtures');
function loadFixture(name) {
  return JSON.parse(_readFile(_resolve(_fixturesDir, name), 'utf8'));
}

describe('robustness/cli — parseArgs', () => {
  test('parses subcommand and flags', () => {
    const { command, flags } = parseArgs(['run', '--n=50', '--target=dot']);
    expect(command).toBe('run');
    expect(flags.n).toBe('50');
    expect(flags.target).toBe('dot');
  });

  test('handles space-separated flag form', () => {
    const { flags } = parseArgs(['run', '--model', 'qwen-3.5-122b']);
    expect(flags.model).toBe('qwen-3.5-122b');
  });
});

describe('robustness/cli — loadConfig', () => {
  test('loads default model from config.json', () => {
    const cfg = loadConfig();
    expect(cfg.model).toBe('qwen-3.5-122b');
    expect(cfg.endpoint.url_env).toBe('AIHUB_URL');
  });
});

describe('robustness/cli — resolveEndpoint precedence', () => {
  const cfg = { model: 'cfg-model', endpoint: { url_env: 'AIHUB_URL', key_env: 'AIHUB_KEY', url: null, key: null } };

  test('CLI flag wins over env', () => {
    const env = { AIHUB_URL: 'http://env.example' };
    const result = resolveEndpoint(cfg, { 'api-url': 'http://flag.example' }, env);
    expect(result.baseUrl).toBe('http://flag.example');
  });

  test('env wins over config when no flag', () => {
    const env = { AIHUB_URL: 'http://env.example' };
    const result = resolveEndpoint(cfg, {}, env);
    expect(result.baseUrl).toBe('http://env.example');
  });

  test('config falls back when no flag, no env', () => {
    const cfgWithUrl = { ...cfg, endpoint: { ...cfg.endpoint, url: 'http://cfg.example' } };
    const result = resolveEndpoint(cfgWithUrl, {}, {});
    expect(result.baseUrl).toBe('http://cfg.example');
  });

  test('apiKey defaults to "none" for local-mode compatibility', () => {
    const result = resolveEndpoint(cfg, {}, {});
    expect(result.apiKey).toBe('none');
  });

  test('flag --model overrides config.model', () => {
    const result = resolveEndpoint(cfg, { model: 'flag-model' }, {});
    expect(result.model).toBe('flag-model');
  });
});

describe('robustness/cli — LLM provider construction', () => {
  test('constructs a callable from resolved endpoint', () => {
    const cfg = { model: 'qwen-3.5-122b', endpoint: { url_env: 'AIHUB_URL', key_env: 'AIHUB_KEY', url: null, key: null } };
    const env = { AIHUB_URL: 'http://test.example/v1', AIHUB_KEY: 'secret' };
    const { baseUrl, apiKey, model } = resolveEndpoint(cfg, {}, env);
    const llm = createLlmProvider({ baseUrl, apiKey, model, timeout: 5_000 });
    expect(typeof llm).toBe('function');
  });
});

import { enumerateCells, sampleCells } from './robustness/synthetic-generator.js';

describe('robustness/synthetic-generator — enumerateCells', () => {
  const catalog = {
    domains: ['a', 'b'],
    complexity: { simple: {}, medium: {} },
    patterns: ['p1'],
    stress_modes: ['s1', 's2']
  };

  test('produces full Cartesian product', () => {
    const cells = enumerateCells(catalog);
    expect(cells).toHaveLength(2 * 2 * 1 * 2); // 8
    expect(cells[0]).toMatchObject({
      domain: 'a', complexity: 'simple', pattern: 'p1', stress_mode: 's1'
    });
  });

  test('each cell has the four dimension keys', () => {
    const cells = enumerateCells(catalog);
    for (const cell of cells) {
      expect(cell).toEqual(expect.objectContaining({
        domain: expect.any(String),
        complexity: expect.any(String),
        pattern: expect.any(String),
        stress_mode: expect.any(String),
      }));
    }
  });
});

describe('robustness/synthetic-generator — sampleCells', () => {
  const cells = [
    { domain: 'a', complexity: 'simple', pattern: 'p1', stress_mode: 's1' },
    { domain: 'a', complexity: 'medium', pattern: 'p1', stress_mode: 's1' },
    { domain: 'b', complexity: 'simple', pattern: 'p1', stress_mode: 's1' },
    { domain: 'b', complexity: 'medium', pattern: 'p1', stress_mode: 's1' },
  ];

  test('uniform strategy returns N samples', () => {
    const picked = sampleCells(cells, { n: 3, strategy: 'uniform', seed: 42 });
    expect(picked).toHaveLength(3);
    for (const p of picked) {
      expect(cells).toContainEqual(p);
    }
  });

  test('uniform strategy is deterministic with same seed', () => {
    const a = sampleCells(cells, { n: 2, strategy: 'uniform', seed: 7 });
    const b = sampleCells(cells, { n: 2, strategy: 'uniform', seed: 7 });
    expect(a).toEqual(b);
  });

  test('targeted strategy filters by predicate', () => {
    const picked = sampleCells(cells, {
      n: 10, strategy: 'targeted', seed: 1,
      filter: c => c.complexity === 'simple'
    });
    expect(picked.every(p => p.complexity === 'simple')).toBe(true);
  });

  test('if n > available cells, returns all cells', () => {
    const picked = sampleCells(cells, { n: 100, strategy: 'uniform', seed: 1 });
    expect(picked).toHaveLength(cells.length);
  });
});

import { buildDescriptionPrompt, buildLcJsonPrompt, extractJson } from './robustness/synthetic-generator.js';

describe('robustness/synthetic-generator — buildDescriptionPrompt', () => {
  const cell = { domain: 'procurement', complexity: 'medium', pattern: 'four-eyes', stress_mode: 'wide-parallelism' };
  const complexitySpec = { minNodes: 10, maxNodes: 25, gateways: 2 };

  test('produces system + user prompt strings', () => {
    const { system, user } = buildDescriptionPrompt(cell, complexitySpec);
    expect(typeof system).toBe('string');
    expect(typeof user).toBe('string');
    expect(system.length).toBeGreaterThan(0);
    expect(user.length).toBeGreaterThan(0);
  });

  test('user prompt references domain, complexity, pattern, stress_mode', () => {
    const { user } = buildDescriptionPrompt(cell, complexitySpec);
    expect(user).toContain('procurement');
    expect(user).toContain('medium');
    expect(user).toContain('four-eyes');
    expect(user).toContain('wide-parallelism');
  });

  test('user prompt requests German output', () => {
    const { user } = buildDescriptionPrompt(cell, complexitySpec);
    expect(user.toLowerCase()).toMatch(/german|deutsch/);
  });
});

describe('robustness/synthetic-generator — buildLcJsonPrompt', () => {
  test('includes schema reference + description', () => {
    const desc = 'Im Beschaffungsprozess beginnt der Vorgang...';
    const { system, user } = buildLcJsonPrompt(desc);
    expect(system.toLowerCase()).toContain('json');
    expect(user).toContain(desc);
  });

  test('constrains output format (no prose)', () => {
    const { system } = buildLcJsonPrompt('x');
    expect(system.toLowerCase()).toMatch(/no prose|just json|output.*json/);
  });
});

describe('robustness/synthetic-generator — extractJson', () => {
  test('direct JSON parses', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  test('fenced code block JSON extracts', () => {
    const text = 'preamble\n```json\n{"a":1}\n```\ntrailing';
    expect(extractJson(text)).toEqual({ a: 1 });
  });

  test('returns null on no JSON', () => {
    expect(extractJson('no json here')).toBeNull();
  });

  test('first-to-last-brace fallback', () => {
    expect(extractJson('foo {"x":2} bar')).toEqual({ x: 2 });
  });
});

import { generateSamples, formatSampleId, buildSample } from './robustness/synthetic-generator.js';

describe('robustness/synthetic-generator — formatSampleId', () => {
  test('uses __ separator and includes all 5 fields', () => {
    const id = formatSampleId({
      domain: 'hr-onboarding', complexity: 'medium',
      pattern: 'four-eyes', stress_mode: 'wide-parallelism'
    }, 42);
    expect(id).toBe('hr-onboarding__medium__four-eyes__wide-parallelism__042');
  });

  test('pads sequence to 3 digits', () => {
    const id = formatSampleId({ domain: 'a', complexity: 'b', pattern: 'c', stress_mode: 'd' }, 7);
    expect(id).toMatch(/__007$/);
  });
});

describe('robustness/synthetic-generator — buildSample', () => {
  test('assembles full Sample record', () => {
    const sample = buildSample({
      cell: { domain: 'proc', complexity: 'medium', pattern: 'p', stress_mode: 's' },
      seq: 5,
      description: 'desc text',
      lcJson: { pools: [] },
      rawDot: null,
      target: 'lc-json',
      model: 'qwen-3.5-122b',
    });
    expect(sample.id).toBe('proc__medium__p__s__005');
    expect(sample.description).toBe('desc text');
    expect(sample.lcJson).toEqual({ pools: [] });
    expect(sample.rawDot).toBeNull();
    expect(sample.meta.domain).toBe('proc');
    expect(sample.meta.target).toBe('lc-json');
    expect(sample.meta.model).toBe('qwen-3.5-122b');
    expect(sample.meta.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('robustness/synthetic-generator — generateSamples (integration with mocked LLM)', () => {
  const catalog = {
    domains: ['a'],
    complexity: { simple: { minNodes: 5, maxNodes: 10, gateways: 0 } },
    patterns: ['p1'],
    stress_modes: ['normal']
  };

  const mockLlm = async (system, user) => {
    if (system.toLowerCase().includes('json')) {
      return '{"pools":[{"id":"P1","lanes":[{"id":"L1","nodes":[{"id":"start","type":"startEvent"}]}]}],"flows":[]}';
    }
    return 'Eine kurze Prozessbeschreibung auf Deutsch.';
  };

  test('produces N Sample records with correct meta', async () => {
    const samples = await generateSamples({
      catalog, n: 1, llm: mockLlm, target: 'lc-json', model: 'mock-model', seed: 42,
    });
    expect(samples).toHaveLength(1);
    expect(samples[0].description).toBe('Eine kurze Prozessbeschreibung auf Deutsch.');
    expect(samples[0].lcJson).toMatchObject({ pools: expect.any(Array) });
    expect(samples[0].meta.model).toBe('mock-model');
    expect(samples[0].meta.target).toBe('lc-json');
  });

  test('skips samples where structure-gen returns unparseable output', async () => {
    const flakyLlm = async (system) => {
      if (system.toLowerCase().includes('json')) return 'not json at all';
      return 'desc';
    };
    const samples = await generateSamples({
      catalog, n: 1, llm: flakyLlm, target: 'lc-json', model: 'flaky', seed: 1,
    });
    expect(samples).toHaveLength(0);
  });
});

import { toAdjacencyList, canonicalSignature, isStructurallyEqual } from './robustness/graph-isomorphism.js';

describe('robustness/graph-isomorphism — toAdjacencyList', () => {
  test('converts single-pool LC to typed adjacency list', () => {
    const lc = {
      pools: [{
        id: 'P1',
        lanes: [{
          id: 'L1',
          nodes: [
            { id: 'start', type: 'startEvent' },
            { id: 'task1', type: 'task' },
            { id: 'end', type: 'endEvent' },
          ]
        }]
      }],
      flows: [
        { source: 'start', target: 'task1' },
        { source: 'task1', target: 'end' },
      ]
    };
    const adj = toAdjacencyList(lc);
    expect(adj.nodes).toHaveLength(3);
    expect(adj.nodes[0]).toMatchObject({ id: 'start', type: 'startEvent' });
    expect(adj.edges).toHaveLength(2);
    expect(adj.lanes).toHaveLength(1);
  });

  test('handles multi-pool with lane count', () => {
    const lc = {
      pools: [
        { id: 'P1', lanes: [{ id: 'L1', nodes: [{ id: 'a', type: 'task' }] }] },
        { id: 'P2', lanes: [{ id: 'L2', nodes: [{ id: 'b', type: 'task' }] }] },
      ],
      flows: []
    };
    const adj = toAdjacencyList(lc);
    expect(adj.pools).toHaveLength(2);
    expect(adj.lanes).toHaveLength(2);
    expect(adj.nodes).toHaveLength(2);
  });
});

describe('robustness/graph-isomorphism — canonicalSignature', () => {
  test('produces deterministic string for same structure regardless of node order', () => {
    const lcA = {
      pools: [{ id: 'P', lanes: [{ id: 'L', nodes: [
        { id: 'a', type: 'task' }, { id: 'b', type: 'gateway' }
      ]}]}],
      flows: []
    };
    const lcB = {
      pools: [{ id: 'P', lanes: [{ id: 'L', nodes: [
        { id: 'b', type: 'gateway' }, { id: 'a', type: 'task' }
      ]}]}],
      flows: []
    };
    expect(canonicalSignature(lcA)).toBe(canonicalSignature(lcB));
  });

  test('differs when types differ', () => {
    const lcA = { pools: [{ id: 'P', lanes: [{ id: 'L', nodes: [{ id: 'x', type: 'task' }] }] }], flows: [] };
    const lcB = { pools: [{ id: 'P', lanes: [{ id: 'L', nodes: [{ id: 'x', type: 'startEvent' }] }] }], flows: [] };
    expect(canonicalSignature(lcA)).not.toBe(canonicalSignature(lcB));
  });
});

describe('robustness/graph-isomorphism — isStructurallyEqual', () => {
  test('returns equal:true for identical', () => {
    const lc = { pools: [{ id: 'P', lanes: [{ id: 'L', nodes: [{ id: 'a', type: 'task' }] }] }], flows: [] };
    const result = isStructurallyEqual(lc, lc);
    expect(result.equal).toBe(true);
  });

  test('returns delta with mismatched node counts', () => {
    const lcA = { pools: [{ id: 'P', lanes: [{ id: 'L', nodes: [
      { id: 'a', type: 'task' }, { id: 'b', type: 'task' }
    ]}]}], flows: [] };
    const lcB = { pools: [{ id: 'P', lanes: [{ id: 'L', nodes: [
      { id: 'a', type: 'task' }
    ]}]}], flows: [] };
    const result = isStructurallyEqual(lcA, lcB);
    expect(result.equal).toBe(false);
    expect(result.delta.nodeCount).toEqual({ a: 2, b: 1 });
  });

  test('returns delta when lane count differs', () => {
    const lcA = { pools: [{ id: 'P', lanes: [{ id: 'L1', nodes: [] }, { id: 'L2', nodes: [] }] }], flows: [] };
    const lcB = { pools: [{ id: 'P', lanes: [{ id: 'L1', nodes: [] }] }], flows: [] };
    const result = isStructurallyEqual(lcA, lcB);
    expect(result.equal).toBe(false);
    expect(result.delta.laneCount).toEqual({ a: 2, b: 1 });
  });
});

describe('robustness/graph-isomorphism — toAdjacencyList format tolerance', () => {
  test('handles legacy flat format', () => {
    const legacy = {
      id: 'proc',
      nodes: [{ id: 'a', type: 'task' }, { id: 'b', type: 'task' }],
      edges: [{ source: 'a', target: 'b' }],
      lanes: [{ id: 'L1' }]
    };
    const adj = toAdjacencyList(legacy);
    expect(adj.nodes).toHaveLength(2);
    expect(adj.edges).toHaveLength(1);
    expect(adj.lanes).toHaveLength(1);
    expect(adj.pools).toHaveLength(1);
  });

  test('handles legacy flat format without lanes (synthetic lane)', () => {
    const legacy = { nodes: [{ id: 'a', type: 'task' }], edges: [] };
    const adj = toAdjacencyList(legacy);
    expect(adj.nodes).toHaveLength(1);
    expect(adj.lanes).toHaveLength(1);  // synthetic default lane
  });
});

import { preFilter, runPipelineChecks, runRoundtripCheck, runStressTest } from './robustness/stress-tester.js';

describe('robustness/stress-tester — runPipelineChecks', () => {
  test('passes on simple valid LC', async () => {
    const lc = loadFixture('simple-approval.json');
    const result = await runPipelineChecks(lc, { timeoutMs: 15_000 });
    expect(result.failedStep).toBeNull();
    expect(result.bpmnXml).toMatch(/^<\?xml/);
    expect(result.svg).toMatch(/<svg/);
  }, 20_000);

  test('captures pipeline failure on broken input', async () => {
    const broken = { pools: 'not-an-array', flows: [] };
    const result = await runPipelineChecks(broken, { timeoutMs: 5_000 });
    expect(result.failedStep === null).toBe(false);
  }, 10_000);
});

describe('robustness/stress-tester — runRoundtripCheck', () => {
  test('passes on simple LC that roundtrips cleanly', async () => {
    const lc = loadFixture('simple-approval.json');
    const { runPipeline } = await import('./pipeline.js');
    const pipelineResult = await runPipeline(lc);
    const rt = await runRoundtripCheck(lc, pipelineResult.bpmnXml);
    expect(rt.equal).toBe(true);
  }, 15_000);

  test('returns reason when no XML provided', async () => {
    const rt = await runRoundtripCheck({ pools: [] }, null);
    expect(rt.equal).toBe(false);
    expect(rt.delta.reason).toContain('no XML');
  });
});

describe('robustness/stress-tester — preFilter', () => {
  test('returns passed:true for valid LC', async () => {
    const validLc = loadFixture('simple-approval.json');
    const result = await preFilter(validLc);
    expect(result.passed).toBe(true);
    expect(result.schemaErrors).toEqual([]);
    expect(result.ruleErrors).toEqual([]);
  });

  test('returns passed:false for broken structure', async () => {
    const broken = { pools: 'not-an-array' };
    const result = await preFilter(broken);
    expect(result.passed).toBe(false);
  });

  test('warnings do not fail the filter', async () => {
    const lc = loadFixture('simple-approval.json');
    const result = await preFilter(lc);
    expect(result.passed).toBe(true);
  });
});

describe('robustness/stress-tester — runStressTest', () => {
  test('returns array of Result objects one per sample', async () => {
    const sample = {
      id: 'test__simple__none__normal__001',
      description: 'test',
      lcJson: loadFixture('simple-approval.json'),
      meta: { domain: 'test', complexity: 'simple', pattern: 'none', stress_mode: 'normal', target: 'lc-json', model: 'test', generated_at: '2026-05-16T00:00:00Z' },
    };
    const results = await runStressTest([sample], { timeoutMs: 15_000 });
    expect(results).toHaveLength(1);
    expect(results[0].sample.id).toBe(sample.id);
    expect(results[0].preFilter).toBeDefined();
    expect(results[0]).toHaveProperty('failure');
  }, 20_000);
});

import { classify, computeFingerprint } from './robustness/failure-classifier.js';

describe('robustness/failure-classifier — computeFingerprint', () => {
  test('same category + same error + same structure → same hash', () => {
    const r = {
      sample: { lcJson: { pools: [{ id: 'P', lanes: [], nodes: [{ id: 'a', type: 'task' }] }], flows: [] } },
      failure: { stage: 'pipeline', failedStep: 'pipeline-throw', error: 'ElkError: cyclic' },
    };
    const fp1 = computeFingerprint('elk-error', r);
    const fp2 = computeFingerprint('elk-error', r);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[a-f0-9]{6,}$/);
  });

  test('different categories → different hashes', () => {
    const r = {
      sample: { lcJson: { pools: [], flows: [] } },
      failure: { stage: 'pipeline', failedStep: 'pipeline-throw', error: 'x' },
    };
    expect(computeFingerprint('elk-error', r)).not.toBe(computeFingerprint('timeout', r));
  });

  test('different error messages → different hashes (same category)', () => {
    const r1 = {
      sample: { lcJson: { pools: [], flows: [] } },
      failure: { stage: 'pipeline', failedStep: 'pipeline-throw', error: 'first error' },
    };
    const r2 = {
      sample: { lcJson: { pools: [], flows: [] } },
      failure: { stage: 'pipeline', failedStep: 'pipeline-throw', error: 'second error' },
    };
    expect(computeFingerprint('elk-error', r1)).not.toBe(computeFingerprint('elk-error', r2));
  });
});

describe('robustness/failure-classifier — classify', () => {
  test('pre-filter schema fail → schema-violation, llm-signal bucket', () => {
    const result = {
      sample: { id: 'x', lcJson: { pools: [] } },
      preFilter: { passed: false, schemaErrors: [{ msg: 'bad' }], ruleErrors: [] },
      failure: { stage: 'pre-filter', schemaErrors: [{ msg: 'bad' }] },
    };
    const c = classify(result);
    expect(c.category).toBe('schema-violation');
    expect(c.bucket).toBe('llm-signal');
  });

  test('pre-filter rule fail → rule-violation, llm-signal bucket', () => {
    const result = {
      sample: { id: 'x', lcJson: { pools: [] } },
      preFilter: { passed: false, schemaErrors: [], ruleErrors: [{ id: 'S01' }] },
      failure: { stage: 'pre-filter', ruleErrors: [{ id: 'S01' }] },
    };
    expect(classify(result).category).toBe('rule-violation');
    expect(classify(result).bucket).toBe('llm-signal');
  });

  test('pipeline-throw → elk-error, auto bucket', () => {
    const result = {
      sample: { id: 'x', lcJson: { pools: [] } },
      preFilter: { passed: true },
      pipelineResult: { failedStep: 'pipeline-throw', error: 'ElkError: cyclic' },
      failure: { stage: 'pipeline', failedStep: 'pipeline-throw', error: 'ElkError: cyclic' },
    };
    expect(classify(result).category).toBe('elk-error');
    expect(classify(result).bucket).toBe('auto');
  });

  test('timeout → timeout, auto', () => {
    const result = {
      sample: { id: 'x', lcJson: { pools: [] } },
      preFilter: { passed: true },
      pipelineResult: { failedStep: 'timeout', error: 'timeout' },
      failure: { stage: 'pipeline', failedStep: 'timeout', error: 'timeout' },
    };
    expect(classify(result).category).toBe('timeout');
  });

  test('roundtrip break → roundtrip-break, auto', () => {
    const result = {
      sample: { id: 'x', lcJson: { pools: [] } },
      preFilter: { passed: true },
      pipelineResult: { failedStep: null },
      roundtripResult: { equal: false, delta: {} },
      failure: { stage: 'roundtrip', delta: {} },
    };
    expect(classify(result).category).toBe('roundtrip-break');
    expect(classify(result).bucket).toBe('auto');
  });

  test('no failure → category:pass, no bucket', () => {
    const result = {
      sample: { id: 'x', lcJson: { pools: [] } },
      preFilter: { passed: true },
      pipelineResult: { failedStep: null },
      roundtripResult: { equal: true },
      failure: null,
    };
    expect(classify(result).category).toBe('pass');
    expect(classify(result).bucket).toBeNull();
  });
});

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { persistFailure } from './robustness/fixture-persister.js';
import { join as _join_4_1 } from 'path';

describe('robustness/fixture-persister — persistFailure', () => {
  let tmpRoot;
  beforeEach(() => { tmpRoot = mkdtempSync(`${tmpdir()}/robustness-`); });
  afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

  const baseRecord = {
    category: 'elk-error',
    bucket: 'auto',
    fingerprint: 'abc123',
    evidence: { error: 'ElkError: cyclic' },
  };
  const baseSample = {
    id: 'test__simple__none__normal__001',
    description: 'A test',
    lcJson: { pools: [], flows: [] },
    meta: { model: 'test', target: 'lc-json', generated_at: '2026-05-16T00:00:00Z' },
  };

  test('first write creates fixture + meta files', async () => {
    const r = await persistFailure(baseRecord, baseSample, { fixtureRoot: tmpRoot });
    expect(r.wrote).toBe('new');
    expect(existsSync(_join_4_1(tmpRoot, 'auto/elk-error-abc123.json'))).toBe(true);
    expect(existsSync(_join_4_1(tmpRoot, 'auto/elk-error-abc123.meta.json'))).toBe(true);
    const meta = JSON.parse(readFileSync(_join_4_1(tmpRoot, 'auto/elk-error-abc123.meta.json'), 'utf8'));
    expect(meta.seen).toBe(1);
  });

  test('repeat with same fingerprint increments seen + updates last_seen', async () => {
    await persistFailure(baseRecord, baseSample, { fixtureRoot: tmpRoot });
    const r2 = await persistFailure(baseRecord, baseSample, { fixtureRoot: tmpRoot });
    expect(r2.wrote).toBe('dedup');
    const meta = JSON.parse(readFileSync(_join_4_1(tmpRoot, 'auto/elk-error-abc123.meta.json'), 'utf8'));
    expect(meta.seen).toBe(2);
  });
});

describe('robustness/fixture-persister — llm-signal gate', () => {
  let tmpRoot;
  beforeEach(() => { tmpRoot = mkdtempSync(`${tmpdir()}/robustness-signal-`); });
  afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

  const record = {
    category: 'schema-violation',
    bucket: 'llm-signal',
    fingerprint: 'sig123',
    evidence: { schemaErrors: [{ msg: 'x' }] },
  };
  const sample = {
    id: 'test',
    description: 'd',
    lcJson: {},
    meta: { model: 't', target: 'lc-json' },
  };

  test('default OFF → not written', async () => {
    const r = await persistFailure(record, sample, { fixtureRoot: tmpRoot });
    expect(r.wrote).toBe('skipped-gated');
    const llmSignalFile = `${tmpRoot}/llm-signal/schema-violation-sig123.json`;
    expect(existsSync(llmSignalFile)).toBe(false);
  });

  test('flag ON → written', async () => {
    const r = await persistFailure(record, sample, { fixtureRoot: tmpRoot, persistLlmSignal: true });
    expect(r.wrote).toBe('new');
    const llmSignalFile = `${tmpRoot}/llm-signal/schema-violation-sig123.json`;
    expect(existsSync(llmSignalFile)).toBe(true);
  });
});

import { generateReport, computeDrift } from './robustness/report-generator.js';

describe('robustness/report-generator — generateReport', () => {
  const runMeta = {
    model: 'qwen-3.5-122b',
    target: 'lc-json',
    started_at: '2026-05-16T14:00:00Z',
    duration_ms: 600_000,
  };

  test('renders Markdown with totals + per-category', () => {
    const records = [
      { category: 'pass' }, { category: 'pass' },
      { category: 'elk-error', bucket: 'auto', fingerprint: 'a1' },
      { category: 'roundtrip-break', bucket: 'auto', fingerprint: 'a2' },
    ];
    const { markdown, json } = generateReport(runMeta, records);
    expect(markdown).toContain('Robustness Run');
    expect(markdown).toContain('Total samples: 4');
    expect(markdown).toContain('Pass: 2');
    expect(markdown).toContain('elk-error');
    expect(json.totals.total).toBe(4);
    expect(json.totals.pass).toBe(2);
    expect(json.byCategory['elk-error']).toBe(1);
  });

  test('Markdown includes per-target breakdown when both targets present', () => {
    const records = [
      { category: 'pass', sample: { meta: { target: 'lc-json' } } },
      { category: 'elk-error', sample: { meta: { target: 'dot' } }, bucket: 'auto', fingerprint: 'x' },
    ];
    const { markdown } = generateReport(runMeta, records);
    expect(markdown.toLowerCase()).toContain('target');
  });
});

describe('robustness/report-generator — computeDrift', () => {
  test('detects new fingerprints', () => {
    const prev = { byCategory: { 'elk-error': 2 }, fingerprints: ['a1', 'a2'] };
    const curr = { byCategory: { 'elk-error': 3 }, fingerprints: ['a1', 'a2', 'a3'] };
    const drift = computeDrift(prev, curr);
    expect(drift.newFingerprints).toEqual(['a3']);
    expect(drift.closedFingerprints).toEqual([]);
  });

  test('detects closed fingerprints', () => {
    const prev = { byCategory: { 'elk-error': 2 }, fingerprints: ['a1', 'a2'] };
    const curr = { byCategory: { 'elk-error': 1 }, fingerprints: ['a1'] };
    const drift = computeDrift(prev, curr);
    expect(drift.closedFingerprints).toEqual(['a2']);
  });

  test('handles no previous run', () => {
    const drift = computeDrift(null, { byCategory: { 'elk-error': 1 }, fingerprints: ['a1'] });
    expect(drift.firstRun).toBe(true);
  });
});

describe('robustness — end-to-end with mocked LLM and tmpfs', () => {
  let tmpRoot;
  beforeEach(() => { tmpRoot = mkdtempSync(`${tmpdir()}/robustness-e2e-`); });
  afterEach(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

  test('valid LC sample passes through full pipeline', async () => {
    const { generateSamples } = await import('./robustness/synthetic-generator.js');
    const { runStressTest } = await import('./robustness/stress-tester.js');
    const { classify } = await import('./robustness/failure-classifier.js');
    const { persistFailure } = await import('./robustness/fixture-persister.js');

    const fixtureLc = loadFixture('simple-approval.json');
    const mockLlm = async (system) => {
      if (system.toLowerCase().includes('json')) return JSON.stringify(fixtureLc);
      return 'A simple approval process where requests are reviewed and approved.';
    };

    const catalog = {
      domains: ['test'],
      complexity: { simple: { minNodes: 5, maxNodes: 10, gateways: 0 } },
      patterns: ['none'],
      stress_modes: ['normal']
    };
    const samples = await generateSamples({ catalog, n: 1, llm: mockLlm, target: 'lc-json', model: 'mock', seed: 1 });
    expect(samples).toHaveLength(1);

    const results = await runStressTest(samples, { timeoutMs: 15_000 });
    const classified = results.map(r => ({ ...r, ...classify(r) }));
    expect(classified[0].category).toBe('pass');

    // No persistence expected for pass
    const persistResult = await persistFailure(classified[0], classified[0].sample, { fixtureRoot: tmpRoot });
    expect(persistResult.wrote).toBe('skipped-no-bucket');
  }, 20_000);
});

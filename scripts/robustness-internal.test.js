import { describe, test, expect } from '@jest/globals';
import { parseArgs, loadConfig, resolveEndpoint } from './robustness/cli.js';
import { createLlmProvider } from './agents/llm-provider.js';

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

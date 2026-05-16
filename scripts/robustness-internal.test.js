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

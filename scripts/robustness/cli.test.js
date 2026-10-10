import { describe, test, expect } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, unknownFlags } from './cli.js';

const CLI = fileURLToPath(new URL('./cli.js', import.meta.url));

describe('robustness CLI rejects flags it does not read (#41)', () => {
  test('--strategy and --category are unknown for run', () => {
    const { command, flags } = parseArgs(['run', '--n=5', '--strategy=uniform', '--category', 'elk-error']);
    expect(unknownFlags(command, flags)).toEqual(['strategy', 'category']);
  });

  test('every flag cli.js reads is accepted', () => {
    const { command, flags } = parseArgs(['run', '--n=5', '--target=dot', '--seed=1', '--model=m',
      '--api-url=u', '--api-key=k', '--persist-llm-signal=true', '--with-mad']);
    expect(unknownFlags(command, flags)).toEqual([]);
  });

  test('a flag valid for one command is unknown for another', () => {
    expect(unknownFlags('mad-check', { limit: '5' })).toEqual([]);
    expect(unknownFlags('mad-check', { n: '5' })).toEqual(['n']);
  });

  test('the process exits 2 with a message naming the flag, before any network call', () => {
    const r = spawnSync(process.execPath, [CLI, 'run', '--strategy=uniform'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--strategy/);
    expect(r.stderr).toMatch(/not supported/i);
  });

  test('a bare boolean flag does not swallow a following flag', () => {
    const { command, flags } = parseArgs(['run', '--with-mad', '--strategy=x']);
    expect(flags['with-mad']).toBe('true');
    expect(unknownFlags(command, flags)).toEqual(['strategy']);
    const r = spawnSync(process.execPath, [CLI, 'run', '--with-mad', '--strategy=x'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/--strategy/);
  });

  test('a flag still takes a following plain value', () => {
    expect(parseArgs(['run', '--n', '5']).flags.n).toBe('5');
  });
});

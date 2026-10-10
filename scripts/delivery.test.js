/**
 * Webhook delivery — the dead-letter file a failed delivery leaves behind.
 *
 * The correlation id is client-controlled, so it must never become part of a file name: the
 * dead-letter file is named by the server, created exclusively, and always lands inside the
 * dead-letter directory. Every delivery here targets a closed port on 127.0.0.1 (or is refused
 * before connecting), so no request leaves the machine.
 */

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

let root;
let deadLetterDir;
let deliver;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'dead-letter-test-'));
  deadLetterDir = join(root, 'dl');
  process.env.DEAD_LETTER_PATH = deadLetterDir;
  ({ deliver } = await import('./delivery.js'));
});

afterAll(() => {
  delete process.env.DEAD_LETTER_PATH;
  rmSync(root, { recursive: true, force: true });
});

const UNREACHABLE = 'http://127.0.0.1:1/hook';

describe('dead-letter files', () => {
  test('a failed delivery is written inside the dead-letter directory under a server-chosen name', async () => {
    const result = await deliver(UNREACHABLE, { correlationId: 'abc-123', bpmnXml: '<x/>' }, 1);
    expect(result.status).toBe('dead_letter');
    expect(dirname(result.path)).toBe(resolve(deadLetterDir));
    expect(result.path).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/);
    expect(result.path).not.toContain('abc-123');
    // The correlation id is kept inside the file, not in its name.
    expect(JSON.parse(readFileSync(result.path, 'utf8')).correlationId).toBe('abc-123');
  });

  test.each([
    ['a relative path that climbs out of the directory', '../outside/escaped'],
    ['an absolute path', join(tmpdir(), 'dead-letter-absolute-escape')],
    ['a path with nested separators', `sub${sep}..${sep}..${sep}escaped-too`],
  ])('%s as correlation id never leaves the directory', async (_label, correlationId) => {
    const result = await deliver(UNREACHABLE, { correlationId, svg: '<svg/>' }, 1);
    expect(result.status).toBe('dead_letter');
    expect(result.path.startsWith(resolve(deadLetterDir) + sep)).toBe(true);
    expect(existsSync(join(root, 'outside'))).toBe(false);
    expect(existsSync(`${join(tmpdir(), 'dead-letter-absolute-escape')}.json`)).toBe(false);
    expect(readdirSync(root)).toEqual(['dl']);
  });

  test('two failures with the same correlation id leave two files, never overwrite one', async () => {
    const a = await deliver(UNREACHABLE, { correlationId: 'same-id', n: 1 }, 1);
    const b = await deliver(UNREACHABLE, { correlationId: 'same-id', n: 2 }, 1);
    expect(a.path).not.toBe(b.path);
    expect(JSON.parse(readFileSync(a.path, 'utf8')).n).toBe(1);
    expect(JSON.parse(readFileSync(b.path, 'utf8')).n).toBe(2);
  });
});

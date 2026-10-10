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
import { createServer } from 'node:http';

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

describe('delivery connects only where it was allowed to', () => {
  let hits;
  let servers;
  const listen = (handler) => new Promise((done) => {
    const s = createServer(handler);
    s.listen(0, '127.0.0.1', () => done(s));
  });

  beforeAll(async () => {
    hits = { target: [], redirector: [] };
    const target = await listen((req, res) => { hits.target.push(req.url); req.resume(); res.end('ok'); });
    const redirector = await listen((req, res) => {
      hits.redirector.push({ url: req.url, host: req.headers.host });
      req.resume();
      res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/followed` });
      res.end();
    });
    servers = { target, redirector };
  });

  afterAll(async () => {
    await Promise.all(Object.values(servers).map((s) => new Promise((done) => s.close(done))));
  });

  test('an internal address written as an IPv4-mapped IPv6 literal is refused before connecting', async () => {
    const before = hits.target.length;
    const result = await deliver(`http://[::ffff:127.0.0.1]:${servers.target.address().port}/mapped`, { correlationId: 'mapped' }, 1);
    expect(result.status).toBe('dead_letter');
    expect(hits.target.length).toBe(before);
  });

  test('a redirect is not followed, and the request goes to the address that was checked', async () => {
    const resolved = [];
    // The first lookup answers with the (test-allowed) loopback address; any later lookup would
    // answer with a different address — a delivery that re-resolved would never reach the server.
    const resolve = async (host) => {
      resolved.push(host);
      return resolved.length === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.1', family: 4 }];
    };
    const allowLoopbackOnly = (address) => address !== '127.0.0.1';
    const port = servers.redirector.address().port;
    const result = await deliver(`http://callback.test:${port}/hook`, { correlationId: 'redirect' }, 1,
      { resolve, isBlocked: allowLoopbackOnly });
    expect(result.status).toBe('dead_letter');
    expect(resolved).toEqual(['callback.test']);
    expect(hits.redirector).toEqual([{ url: '/hook', host: `callback.test:${port}` }]);
    expect(hits.target).not.toContain('/followed');
  });
});

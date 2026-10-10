import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PACKAGE_VERSION } from './version.js';
import { server as mcpServer } from '../mcp-bpmn-server.js';
import { server as httpServer } from '../http-server.js';

const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

describe('one version, read from package.json (#40)', () => {
  test('PACKAGE_VERSION is the package.json version', () => {
    expect(PACKAGE_VERSION).toBe(pkgVersion);
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  test('/health reports it', async () => {
    await new Promise((r) => httpServer.listen(0, r));
    try {
      const res = await fetch(`http://127.0.0.1:${httpServer.address().port}/health`);
      expect((await res.json()).version).toBe(pkgVersion);
    } finally {
      await new Promise((r) => httpServer.close(r));
    }
  });

  test('MCP serverInfo reports it', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await mcpServer.connect(a);
    await client.connect(b);
    expect(client.getServerVersion()).toMatchObject({ name: 'bpmn-generator', version: pkgVersion });
    await client.close();
  });
});

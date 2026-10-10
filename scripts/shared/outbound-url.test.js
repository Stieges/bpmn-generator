/**
 * The outbound-URL validator: every special-purpose address form is refused, a public address
 * passes. DNS is always stubbed — no test here performs a real lookup or connection.
 */

import { describe, test, expect } from '@jest/globals';
import { isBlockedAddress, ipv6Bytes, checkUrlShape, resolveOutboundUrl, pinnedRequest, OutboundRefusedError } from './outbound-url.js';

const stub = (map) => async (host) => {
  if (!(host in map)) throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
  return map[host];
};

describe('isBlockedAddress', () => {
  test.each([
    '0.0.0.0', '0.1.2.3', '10.0.0.1', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.1.2.3',
    '169.254.169.254', '172.16.0.1', '172.31.255.254', '192.0.0.1', '192.168.1.1', '198.18.0.1',
    '198.19.255.255', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
  ])('IPv4 %s is blocked', (a) => expect(isBlockedAddress(a)).toBe(true));

  test.each([
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%en0', 'ff02::1', 'fec0::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
    '::127.0.0.1', '::7f00:1', '::ffff:0:127.0.0.1',
    '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '64:ff9b:1::1',
    '2002:7f00:1::1', '2002:a9fe:a9fe::',
    '2001:0:4136:e378:8000:63bf:80ff:fffe', // Teredo, client 127.0.0.1
  ])('IPv6 %s is blocked', (a) => expect(isBlockedAddress(a)).toBe(true));

  test.each(['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:93.184.216.34', '64:ff9b::808:808'])(
    'public %s passes', (a) => expect(isBlockedAddress(a)).toBe(false));

  test('anything that is not an IP address is blocked', () => {
    expect(isBlockedAddress('example.com')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
  });

  test('ipv6Bytes expands compressed and dotted forms', () => {
    expect(Array.from(ipv6Bytes('::ffff:127.0.0.1')).slice(10)).toEqual([0xff, 0xff, 127, 0, 0, 1]);
    expect(Array.from(ipv6Bytes('fe80::'))[0]).toBe(0xfe);
    expect(ipv6Bytes('1.2.3.4')).toBeNull();
  });
});

describe('checkUrlShape', () => {
  test.each([
    'http://127.0.0.1/', 'http://[::ffff:127.0.0.1]:8080/', 'http://[::ffff:7f00:1]/', 'http://0.0.0.0/',
    'http://[::]/', 'http://2130706433/', 'http://0x7f000001/', 'http://017700000001/', 'http://127.1/',
    'http://localhost/', 'http://LOCALHOST./', 'http://api.localhost/', 'http://[64:ff9b::a9fe:a9fe]/',
    'http://100.64.1.1/', 'http://198.18.0.1/', 'http://224.0.0.1/',
  ])('%s targets an internal network', (u) => expect(checkUrlShape(u, 'callbackUrl').error).toMatch(/internal/));

  test('only http and https', () => {
    expect(checkUrlShape('ftp://example.com/', 'callbackUrl').error).toMatch(/http or https/);
    expect(checkUrlShape('file:///etc/passwd', 'callbackUrl').error).toMatch(/http or https/);
  });

  test('no credentials in the URL', () => {
    expect(checkUrlShape('https://user:pw@example.com/', 'callbackUrl').error).toMatch(/credentials/);
    expect(checkUrlShape('https://user@example.com/', 'callbackUrl').error).toMatch(/credentials/);
  });

  test('a non-URL throws', () => expect(() => checkUrlShape('not a url')).toThrow());
});

describe('resolveOutboundUrl', () => {
  test('a name is refused when ANY resolved address is internal', async () => {
    const resolve = stub({ 'mixed.test': [{ address: '93.184.216.34', family: 4 }, { address: '::ffff:10.0.0.1', family: 6 }] });
    const r = await resolveOutboundUrl('https://mixed.test/', { label: 'callbackUrl', resolve });
    expect(r).toEqual({ ok: false, error: 'callbackUrl resolves to internal network' });
  });

  test('a name resolving only to public addresses passes and carries those addresses', async () => {
    const resolve = stub({ 'hooks.test': [{ address: '93.184.216.34', family: 4 }] });
    const r = await resolveOutboundUrl('https://hooks.test/x', { resolve });
    expect(r.ok).toBe(true);
    expect(r.addresses).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });

  test('a failed lookup is a refusal, not a pass', async () => {
    const r = await resolveOutboundUrl('https://nowhere.test/', { label: 'callbackUrl', resolve: stub({}) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/DNS lookup failed/);
  });

  test('a public IP literal passes without a lookup', async () => {
    const r = await resolveOutboundUrl('http://93.184.216.34/', { resolve: () => { throw new Error('no lookup expected'); } });
    expect(r.ok).toBe(true);
  });
});

describe('pinnedRequest', () => {
  test('a refused target throws OutboundRefusedError without connecting', async () => {
    await expect(pinnedRequest('http://[::]:1/')).rejects.toBeInstanceOf(OutboundRefusedError);
    await expect(pinnedRequest('http://internal.test/', { resolve: stub({ 'internal.test': [{ address: '10.1.2.3', family: 4 }] }) }))
      .rejects.toThrow(/internal network/);
  });
});

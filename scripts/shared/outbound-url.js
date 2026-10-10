/**
 * Outbound requests to client-supplied URLs — the one validator and the one transport.
 *
 * Every outbound request whose target a client chose (a webhook `callbackUrl`, an allowlisted
 * `llmConfig.baseUrl`) goes through here, so that "may the server talk to this address?" is
 * answered once:
 *
 *  - only `http:`/`https:`, no credentials in the URL;
 *  - the host is parsed by WHATWG `URL` (which already normalises decimal, octal and hex IPv4
 *    spellings) and `node:net`; `localhost` and `*.localhost` are refused without a lookup;
 *  - a host name is resolved and EVERY resolved address must pass `isBlockedAddress`, which
 *    covers the IPv4 special-purpose ranges and the IPv6 forms that embed an IPv4 address
 *    (mapped, compatible, translated, NAT64, 6to4, Teredo) by checking the embedded address;
 *  - `pinnedRequest` connects to exactly the addresses that were checked (a custom `lookup` that
 *    hands the socket those addresses), so the name cannot be re-resolved to something else
 *    between check and use; the original host still goes out as `Host` header and TLS SNI;
 *  - redirects are never followed — a 3xx is just an unsuccessful response.
 *
 * Dependency-free: node:net, node:dns, node:http(s).
 */

import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';

const BLOCKED_V4 = new net.BlockList();
for (const [prefix, bits] of [
  ['0.0.0.0', 8],        // "this network", incl. 0.0.0.0
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // carrier-grade NAT
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, cloud metadata
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // documentation
  ['192.88.99.0', 24],   // 6to4 relay anycast
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // documentation
  ['203.0.113.0', 24],   // documentation
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved, incl. broadcast 255.255.255.255
]) BLOCKED_V4.addSubnet(prefix, bits, 'ipv4');

const BLOCKED_V6 = new net.BlockList();
for (const [prefix, bits] of [
  ['::', 128],           // unspecified
  ['::1', 128],          // loopback
  ['100::', 64],         // discard-only
  ['64:ff9b:1::', 48],   // local-use NAT64
  ['2001:db8::', 32],    // documentation
  ['fc00::', 7],         // unique-local
  ['fe80::', 10],        // link-local
  ['fec0::', 10],        // site-local (deprecated)
  ['ff00::', 8],         // multicast
]) BLOCKED_V6.addSubnet(prefix, bits, 'ipv6');

/** 16 bytes of an IPv6 address (zone id dropped, embedded dotted quad honoured), or null. */
export function ipv6Bytes(input) {
  let s = String(input).split('%')[0].toLowerCase();
  if (!net.isIPv6(s)) return null;
  const lastColon = s.lastIndexOf(':');
  const last = s.slice(lastColon + 1);
  if (last.includes('.')) {
    const q = last.split('.').map(Number);
    s = `${s.slice(0, lastColon + 1)}${((q[0] << 8) | q[1]).toString(16)}:${((q[2] << 8) | q[3]).toString(16)}`;
  }
  let groups;
  if (s.includes('::')) {
    const [head, tail] = s.split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    groups = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  } else {
    groups = s.split(':');
  }
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    const v = parseInt(g, 16);
    bytes[i * 2] = v >> 8;
    bytes[i * 2 + 1] = v & 0xff;
  });
  return bytes;
}

const v4At = (b, i, mask = 0) => [b[i], b[i + 1], b[i + 2], b[i + 3]].map((x) => x ^ mask).join('.');
const allZero = (b, from, to) => b.slice(from, to).every((x) => x === 0);

/** The IPv4 addresses an IPv6 address carries inside it, in every form a stack may route on. */
function embeddedV4(b) {
  const out = [];
  if (allZero(b, 0, 10) && b[10] === 0xff && b[11] === 0xff) out.push(v4At(b, 12));          // ::ffff:a.b.c.d mapped
  if (allZero(b, 0, 12)) out.push(v4At(b, 12));                                              // ::a.b.c.d compatible
  if (allZero(b, 0, 8) && b[8] === 0xff && b[9] === 0xff && allZero(b, 10, 12)) out.push(v4At(b, 12)); // ::ffff:0:a.b.c.d translated
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(b, 4, 12)) out.push(v4At(b, 12)); // 64:ff9b::/96 NAT64
  if (b[0] === 0x20 && b[1] === 0x02) out.push(v4At(b, 2));                                  // 2002::/16 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) {                    // 2001::/32 Teredo
    out.push(v4At(b, 4));          // server
    out.push(v4At(b, 12, 0xff));   // client (obfuscated)
  }
  return out;
}

/**
 * True when the server must not connect to `address`. Fails closed: anything that is not an IP
 * address is blocked.
 */
export function isBlockedAddress(address) {
  const a = String(address).replace(/^\[|\]$/g, '');
  if (net.isIPv4(a)) return BLOCKED_V4.check(a, 'ipv4');
  const bytes = ipv6Bytes(a);
  if (!bytes) return true;
  if (embeddedV4(bytes).some((v4) => BLOCKED_V4.check(v4, 'ipv4'))) return true;
  return BLOCKED_V6.check(a.split('%')[0], 'ipv6');
}

const isLocalhostName = (host) => {
  const h = host.toLowerCase().replace(/\.$/, '');
  return h === 'localhost' || h.endsWith('.localhost');
};

/**
 * The checks that need no DNS: scheme, credentials, IP literal, `localhost` names. Returns
 * `{ url, host }` or `{ error }`; throws (TypeError from `URL`) on a string that is not a URL.
 */
export function checkUrlShape(raw, label = 'url') {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: `${label} must use http or https` };
  if (url.username || url.password) return { error: `${label} must not contain credentials` };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isLocalhostName(host)) return { error: `${label} must not target internal networks` };
  if (net.isIP(host) && isBlockedAddress(host)) return { error: `${label} must not target internal networks` };
  return { url, host };
}

let resolver = (host) => dnsLookup(host, { all: true, verbatim: true });
/** Test hook: replace DNS resolution (no real lookups in tests). `null` restores the default. */
export function _setResolver(fn) {
  resolver = fn || ((host) => dnsLookup(host, { all: true, verbatim: true }));
}

/**
 * Full check: shape, then every resolved address. Returns `{ ok: true, url, addresses }` — the
 * addresses `pinnedRequest` will connect to — or `{ ok: false, error }`. Throws on a non-URL.
 */
export async function resolveOutboundUrl(raw, { label = 'url', resolve = resolver, isBlocked = isBlockedAddress } = {}) {
  const shape = checkUrlShape(raw, label);
  if (shape.error) return { ok: false, error: shape.error };
  const { url, host } = shape;
  const family = net.isIP(host);
  if (family) {
    if (isBlocked(host)) return { ok: false, error: `${label} must not target internal networks` };
    return { ok: true, url, addresses: [{ address: host, family }] };
  }
  let addresses;
  try {
    addresses = await resolve(host);
  } catch (err) {
    return { ok: false, error: `${label} DNS lookup failed: ${err.code || 'error'}` };
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return { ok: false, error: `${label} DNS lookup failed: no address` };
  if (addresses.some(({ address }) => isBlocked(address))) {
    return { ok: false, error: `${label} resolves to internal network` };
  }
  return { ok: true, url, addresses: addresses.map(({ address, family: f }) => ({ address, family: f || net.isIP(address) })) };
}

/** Thrown by `pinnedRequest` when the target is refused before any connection is made. */
export class OutboundRefusedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OutboundRefusedError';
  }
}

const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * A minimal fetch-shaped request to a client-supplied URL: re-validates the URL, connects only to
 * the addresses it validated, never follows a redirect, caps the response body. Resolves to
 * `{ ok, status, text(), json() }`; rejects with `OutboundRefusedError` when the target is
 * refused, or with the network error.
 */
export async function pinnedRequest(raw, {
  method = 'POST', headers = {}, body = '', timeoutMs = 10_000,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, label = 'url',
  resolve = resolver, isBlocked = isBlockedAddress,
} = {}) {
  const check = await resolveOutboundUrl(raw, { label, resolve, isBlocked });
  if (!check.ok) throw new OutboundRefusedError(check.error);
  const { url, addresses } = check;
  const lookup = (_hostname, opts, cb) => {
    const callback = typeof opts === 'function' ? opts : cb;
    if (opts && typeof opts === 'object' && opts.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  };
  const transport = url.protocol === 'https:' ? https : http;
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  return new Promise((resolvePromise, reject) => {
    const req = transport.request(url, {
      method,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(payload) },
      lookup,
      signal: AbortSignal.timeout(timeoutMs),
    }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxResponseBytes) res.destroy(new Error('response body too large'));
        else chunks.push(c);
      });
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const status = res.statusCode;
        resolvePromise({
          ok: status >= 200 && status < 300,
          status,
          text: async () => text,
          json: async () => JSON.parse(text),
        });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

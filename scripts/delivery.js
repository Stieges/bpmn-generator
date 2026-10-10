import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { auditLog } from './audit.js';
import { pinnedRequest, OutboundRefusedError } from './shared/outbound-url.js';

function resolveDeadLetterDir() {
  if (process.env.DEAD_LETTER_PATH) return resolve(process.env.DEAD_LETTER_PATH);
  return join(tmpdir(), 'bpmn-generator', 'dead-letter');
}

const deadLetterDir = resolveDeadLetterDir();
mkdirSync(deadLetterDir, { recursive: true });

export function getDeadLetterDir() {
  return deadLetterDir;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Writes an undeliverable payload to the dead-letter directory. The file name is a fresh
 * server-generated UUID — nothing from the payload (the correlation id is client-controlled)
 * ever becomes part of a path; the correlation id travels inside the file. The file is created
 * exclusively (`wx`), so an existing file is never overwritten, and the final path is checked to
 * lie inside the directory before anything is written.
 */
function writeDeadLetter(payload) {
  const dlPath = resolve(deadLetterDir, `${randomUUID()}.json`);
  if (!dlPath.startsWith(deadLetterDir + sep)) {
    throw new Error('dead-letter path escapes the dead-letter directory');
  }
  writeFileSync(dlPath, JSON.stringify(payload, null, 2), { flag: 'wx' });
  return dlPath;
}

/**
 * POSTs `payload` to a client-supplied callback URL, with retries. The request goes through
 * `pinnedRequest`: the URL is re-validated, the connection goes only to the addresses that passed
 * the check, and a redirect counts as a failed attempt. A target refused by the check is not
 * retried. `requestOptions` is passed through to `pinnedRequest` (tests inject a resolver).
 */
export async function deliver(callbackUrl, payload, retries = 3, requestOptions = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await pinnedRequest(callbackUrl, {
        ...requestOptions,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 10_000,
        maxResponseBytes: 64 * 1024,
        label: 'callbackUrl',
      });
      if (res.ok) {
        auditLog({ event: 'delivery_sent', correlationId: payload.correlationId });
        return { status: 'sent' };
      }
    } catch (err) {
      if (err instanceof OutboundRefusedError) break;
    }
    if (i < retries - 1) await sleep(1000 * 4 ** i);
  }
  const dlPath = writeDeadLetter(payload);
  auditLog({ event: 'dead_letter', correlationId: payload.correlationId, path: dlPath });
  return { status: 'dead_letter', path: dlPath };
}

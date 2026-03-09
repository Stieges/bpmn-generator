import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditLog } from './audit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const deadLetterDir = join(__dirname, '..', 'dead-letter');

mkdirSync(deadLetterDir, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function deliver(callbackUrl, payload, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        auditLog({ event: 'delivery_sent', correlationId: payload.correlationId });
        return { status: 'sent' };
      }
    } catch { /* retry */ }
    if (i < retries - 1) await sleep(1000 * 4 ** i);
  }
  const dlPath = join(deadLetterDir, `${payload.correlationId}.json`);
  writeFileSync(dlPath, JSON.stringify(payload, null, 2));
  auditLog({ event: 'dead_letter', correlationId: payload.correlationId, path: dlPath });
  return { status: 'dead_letter', path: dlPath };
}

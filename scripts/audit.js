import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const auditDir = join(__dirname, '..', 'audit');
const auditPath = join(auditDir, 'bpmn-generator.jsonl');

mkdirSync(auditDir, { recursive: true });

export function auditLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFileSync(auditPath, line + '\n');
}

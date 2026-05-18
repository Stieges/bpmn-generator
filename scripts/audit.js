import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

function resolveAuditPath() {
  if (process.env.AUDIT_LOG_PATH) return process.env.AUDIT_LOG_PATH;
  return join(tmpdir(), 'bpmn-generator', 'audit', 'bpmn-generator.jsonl');
}

const auditPath = resolveAuditPath();
mkdirSync(dirname(auditPath), { recursive: true });

export function auditLog(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFileSync(auditPath, line + '\n');
}

export function getAuditPath() {
  return auditPath;
}

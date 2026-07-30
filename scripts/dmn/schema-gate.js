/**
 * Strict schema gate for Decision-Core input, mirroring scripts/schema-gate.js.
 *
 * Same guarantee as the BPMN side: nothing reaches the pipeline that the formal
 * schema has not accepted. Hand-written and LLM-produced input is never trusted
 * raw — a malformed document should be rejected here, not crash three modules
 * further down.
 *
 * Path resolution is deliberately NOT repeated here; resource-paths.js owns it.
 */

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { decisionCoreSchemaPath } from '../shared/resource-paths.js';

const schema = JSON.parse(readFileSync(decisionCoreSchemaPath(), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

export function validateDecisionCoreSchema(input) {
  const valid = validate(input);
  return {
    valid,
    errors: valid ? [] : (validate.errors || []).map(e => ({
      path: e.instancePath || '(root)',
      message: e.message,
      params: e.params,
    })),
  };
}

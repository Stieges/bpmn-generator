import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { inputSchemaPath } from '../shared/resource-paths.js';

// Which of the two layouts applies — and why the source wins over the in-package
// copy — is decided in one place; see resource-paths.js.
const schema = JSON.parse(readFileSync(inputSchemaPath(), 'utf8'));

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

export function validateLogicCoreSchema(input) {
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

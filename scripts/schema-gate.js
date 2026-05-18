import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', 'references', 'input-schema.json');
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

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

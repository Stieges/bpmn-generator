import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { inputSchemaPath } from '../shared/resource-paths.js';
import { boundText } from '../shared/safe-text.js';
import { VISUAL_REFINEMENT_OPTION_SCHEMA } from './visual-refinement.js';

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

const validateRefinementOption = ajv.compile(VISUAL_REFINEMENT_OPTION_SCHEMA);

/** The `visualRefinement` request option, checked against the one schema every surface shares. */
export function validateVisualRefinementOption(value) {
  if (value === undefined) return { valid: true, errors: [] };
  const valid = validateRefinementOption(value);
  return {
    valid,
    errors: valid ? [] : (validateRefinementOption.errors || []).map(e => ({
      path: `visualRefinement${e.instancePath}`, message: e.message, params: e.params,
    })),
  };
}

const RESPONSE_ERRORS_MAX = 20;
const RESPONSE_TEXT_MAX = 200;

function boundParams(value, depth = 0) {
  if (typeof value === 'string') return boundText(value, RESPONSE_TEXT_MAX);
  if (value === null || typeof value !== 'object' || depth >= 3) return typeof value === 'object' && value !== null ? '…' : value;
  if (Array.isArray(value)) return value.slice(0, RESPONSE_ERRORS_MAX).map((v) => boundParams(v, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [boundText(k, RESPONSE_TEXT_MAX), boundParams(v, depth + 1)]));
}

/**
 * Schema errors as they go back to a remote caller: at most 20, then one entry counting the rest,
 * every path, message and parameter string cut and escaped — a client's own keys and ids appear in
 * them, and `allErrors` would otherwise echo one entry per bad element.
 */
export function boundSchemaErrors(errors) {
  const shown = errors.slice(0, RESPONSE_ERRORS_MAX).map((e) => ({
    path: boundText(e.path, RESPONSE_TEXT_MAX),
    message: boundText(e.message, RESPONSE_TEXT_MAX),
    params: boundParams(e.params),
  }));
  const more = errors.length - shown.length;
  if (more > 0) shown.push({ path: '(root)', message: `… and ${more} more`, params: { more } });
  return shown;
}

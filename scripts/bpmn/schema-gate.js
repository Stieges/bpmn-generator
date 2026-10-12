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

// The root is a oneOf of SingleProcess and Collaboration, and ajv reports the errors of both: a
// collaboration with one bad message flow opens with SingleProcess's "must have required property
// 'nodes'", and the real cause comes later. A Logic-Core with `pools` is meant as a Collaboration,
// any other object as a SingleProcess — its errors are that branch's alone.
const validateBranch = {
  Collaboration: ajv.getSchema(`${schema.$id}#/$defs/Collaboration`),
  SingleProcess: ajv.getSchema(`${schema.$id}#/$defs/SingleProcess`),
};

const asGateErrors = (errors) => (errors || []).map(e => ({
  path: e.instancePath || '(root)',
  message: e.message,
  params: e.params,
}));

export function validateLogicCoreSchema(input) {
  if (validate(input)) return { valid: true, errors: [] };
  const all = validate.errors;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const branch = validateBranch[Array.isArray(input.pools) || 'pools' in input ? 'Collaboration' : 'SingleProcess'];
    // A branch the input passes cannot explain the failure (it would then match both): keep all.
    if (branch && !branch(input)) return { valid: false, errors: asGateErrors(branch.errors) };
  }
  return { valid: false, errors: asGateErrors(all) };
}

/**
 * Gate errors as text for a person or an LLM: one line per error, `path: message`, plus the
 * offending property, missing property or limit where ajv names one; beyond `max`, one line
 * counting the rest.
 */
export function formatSchemaErrors(errors, max = 10) {
  const detail = (p = {}) => p.additionalProperty ?? p.missingProperty ?? p.allowedValues?.join(', ') ?? null;
  const lines = errors.slice(0, max).map((e) => {
    const d = detail(e.params);
    return `${e.path}: ${e.message}${d !== null && !String(e.message).includes(`'${d}'`) ? ` (${d})` : ''}`;
  });
  if (errors.length > max) lines.push(`… and ${errors.length - max} more`);
  return lines.join('\n');
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

/**
 * The per-call layout switches every geometry surface takes (runPipeline, CLI, HTTP /generate and
 * /orchestrate, MCP generate_bpmn and orchestrate_bpmn): the bend rule, node labels that avoid
 * flows, and the repair of sequence flows through a foreign shape. Omitted,
 * `config.json -> layout.<switch>` decides.
 */
export const LAYOUT_SWITCHES = Object.freeze(['bendRule', 'nodeLabelsAvoidFlows', 'foreignShapeRepair']);

/** JSON Schema of one layout switch; mirrored as `$defs/LayoutSwitchOption` in references/api-schema.json. */
export const LAYOUT_SWITCH_OPTION_SCHEMA = Object.freeze({ type: 'boolean' });

const validateLayoutSwitch = ajv.compile(LAYOUT_SWITCH_OPTION_SCHEMA);

/**
 * Every per-call layout option of a request (`visualRefinement` plus the layout switches), checked
 * against the schemas every surface shares. `source` is the request body or the tool arguments; a
 * key that is absent is not checked.
 */
export function validateLayoutOptions(source = {}) {
  const errors = [...validateVisualRefinementOption(source.visualRefinement).errors];
  for (const key of LAYOUT_SWITCHES) {
    if (source[key] === undefined || validateLayoutSwitch(source[key])) continue;
    errors.push(...(validateLayoutSwitch.errors || []).map(e => ({
      path: `${key}${e.instancePath}`, message: e.message, params: e.params,
    })));
  }
  return { valid: errors.length === 0, errors };
}

/** The per-call layout options of a request, to hand to runPipeline once `validateLayoutOptions` passed. */
export function layoutOptionsOf(source = {}) {
  const opts = { visualRefinement: source.visualRefinement };
  for (const key of LAYOUT_SWITCHES) opts[key] = source[key];
  return opts;
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

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { inputSchemaPath, inputSchemaV2Path, catalogSchemaPath } from '../shared/resource-paths.js';
import { boundText } from '../shared/safe-text.js';
import { ViewRejectedError } from '../shared/view.js';
import { quoteForMessage } from '../shared/rule-profile.js';
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
const branchValidators = (id) => ({
  Collaboration: ajv.getSchema(`${id}#/$defs/Collaboration`),
  SingleProcess: ajv.getSchema(`${id}#/$defs/SingleProcess`),
});
const validateBranch = branchValidators(schema.$id);

// Format 2.0 (design 5.1): its own schema, which refers to the actor catalogue schema.
const schemaV2 = JSON.parse(readFileSync(inputSchemaV2Path(), 'utf8'));
ajv.addSchema(JSON.parse(readFileSync(catalogSchemaPath(), 'utf8')));
const validateV2 = ajv.compile(schemaV2);
const validateBranchV2 = branchValidators(schemaV2.$id);

// For a 2.x model (`code` given), an `if` error only says that a `then` or `else` failed — that one
// is the entry — and a `false` property schema reads "is not allowed here". 1.x entries stay as ajv words them.
const asGateErrors = (errors, code) => (errors || []).filter(e => !(code && e.keyword === 'if')).map(e => ({
  path: e.instancePath || '(root)',
  message: code && e.keyword === 'false schema' ? 'is not allowed here' : e.message,
  params: e.params,
  ...(code ? { code } : {}),
}));

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The format of a model: '2' iff a plain object whose `$schemaVersion` is the string "2" or starts
 * `2.`, else '1'. Only the exact string "2.0" passes the 2.0 gate; any other value of the 2 line
 * ("2", "2.1", "2.7") is classified 2 so it gets the one clear version message, not a 1.x error.
 */
export function modelFormat(input) {
  return isPlainObject(input) && typeof input.$schemaVersion === 'string' && /^2(\.|$)/.test(input.$schemaVersion) ? '2' : '1';
}

export const FORMAT_V2_VERSION = '2.0';

/**
 * Design 6: a view with `lanes` forms the lanes of a format 2.0 model from its assignments; a 1.x
 * model carries its own lanes, so that pair is a view error. One check for every surface that
 * resolves a view (runPipeline, MCP tools, HTTP endpoints, orchestrate), so the message lives here.
 * `view` is a loaded view object, or null/undefined for none. Throws ViewRejectedError.
 */
export function assertViewFitsModel(model, view) {
  if (view?.lanes !== undefined && modelFormat(model) === '1') {
    throw new ViewRejectedError(`view ${quoteForMessage(view.view)} forms lanes from assignments; this model (format 1.x) carries its own lanes`);
  }
}

export const FORMAT_V2_NOT_ACCEPTED = 'format 2.0 is not accepted here yet — generate, validate and orchestrate read it on the CLI, in the library, over MCP and over HTTP';

/** Why a model that is not format 2.0 is refused where only 2.0 is read; no code (1.x responses stay as they were). */
function notFormatV2Message(input) {
  const v = isPlainObject(input) && input.$schemaVersion !== undefined ? quoteForMessage(input.$schemaVersion) : 'absent';
  return `this is not a format 2.0 model ($schemaVersion ${v})`;
}

/** The error of a model on the 2 line whose `$schemaVersion` is not exactly "2.0", else null. */
function unsupportedVersionError(input) {
  if (modelFormat(input) !== '2' || input.$schemaVersion === FORMAT_V2_VERSION) return null;
  return {
    path: '/$schemaVersion',
    message: `$schemaVersion ${quoteForMessage(input.$schemaVersion)} is not supported; only "${FORMAT_V2_VERSION}" is supported`,
    params: { allowedValue: FORMAT_V2_VERSION },
    code: 'F02',
  };
}

/** Why an entry point that does not read 2.x refuses this 2.x model: the version message, or the fixed text for "2.0". */
export function formatV2RefusalMessage(input) {
  return unsupportedVersionError(input)?.message ?? FORMAT_V2_NOT_ACCEPTED;
}

/**
 * The schema gate for both formats. `accept` lists the formats the caller reads; a model of
 * another format gets exactly one error. Errors are those of the root shape the input was meant
 * to have (Collaboration iff `pools`).
 */
export function validateModelSchema(input, { accept = ['1'] } = {}) {
  const format = modelFormat(input);
  // An unsupported 2.x value ("2", "2.7") names its value everywhere, whichever formats the caller reads.
  const unsupported = unsupportedVersionError(input);
  if (unsupported) return { valid: false, format, errors: [unsupported] };
  if (!accept.includes(format)) {
    // A 2.x model gets F03; a 1.x model refused under accept ['2'] is the "not a format 2.0 model" case, uncoded.
    const entry = format === '2'
      ? { path: '/$schemaVersion', message: FORMAT_V2_NOT_ACCEPTED, params: { accepted: accept }, code: 'F03' }
      : { path: '/$schemaVersion', message: notFormatV2Message(input), params: { accepted: accept } };
    return { valid: false, format, errors: [entry] };
  }
  const code = format === '2' ? 'F01' : undefined;
  const [check, branches] = format === '2' ? [validateV2, validateBranchV2] : [validate, validateBranch];
  if (check(input)) return { valid: true, format, errors: [] };
  const all = check.errors;
  if (isPlainObject(input)) {
    const branch = branches[Array.isArray(input.pools) || 'pools' in input ? 'Collaboration' : 'SingleProcess'];
    // A branch the input passes cannot explain the failure (it would then match both): keep all.
    if (branch && !branch(input)) return { valid: false, format, errors: asGateErrors(branch.errors, code) };
  }
  return { valid: false, format, errors: asGateErrors(all, code) };
}

/** The 1.x gate every caller that has not opted into format 2.0 uses. */
export function validateLogicCoreSchema(input) {
  const { valid, errors } = validateModelSchema(input, { accept: ['1'] });
  return { valid, errors };
}

/**
 * Gate errors as text for a person or an LLM: one line per error, `path: message`, plus the
 * offending property, missing property or limit where ajv names one; beyond `max`, one line
 * counting the rest.
 */
export function formatSchemaErrors(errors, max = 10) {
  const detail = (p = {}) => p.additionalProperty ?? p.missingProperty ?? p.allowedValues?.join(', ') ?? null;
  // Paths and property names come from the rejected document (an LLM's, a client's): bounded.
  const lines = errors.slice(0, max).map((e) => {
    const d = detail(e.params);
    const extra = d !== null && !String(e.message).includes(`'${d}'`) ? ` (${boundText(String(d), RESPONSE_TEXT_MAX)})` : '';
    return `${e.code ? `[${e.code}] ` : ''}${boundText(String(e.path), RESPONSE_TEXT_MAX)}: ${e.message}${extra}`;
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
    ...(e.code ? { code: e.code } : {}),
  }));
  const more = errors.length - shown.length;
  if (more > 0) shown.push({ path: '(root)', message: `… and ${more} more`, params: { more } });
  return shown;
}

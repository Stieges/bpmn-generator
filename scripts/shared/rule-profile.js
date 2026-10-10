/**
 * Rule profiles — loading them, and deciding what a profile means for one rule.
 *
 * Shared by the BPMN rule engine (`rules.js`) and the DMN one (`dmn/rules.js`).
 * Nothing here knows what a process or a decision is: a profile is applied to a
 * rule object and that is the whole contract. Only the *runner* — which rule list
 * to walk, and what to hand each `check` — is format-specific, and that stays in
 * each engine.
 *
 * Lifted out rather than copied. The same three functions written twice is how
 * this codebase acquired its most expensive defects (geometry computed in two
 * renderers, per-node fields enriched on two paths, reference paths resolved in
 * two modules), and a severity override silently applying to one engine but not
 * the other would be exactly that shape again.
 *
 * Profile format:
 *   { layers:    { <layer>: { enabled: false } },
 *     overrides: { <ruleId>: { severity: <a severity of references/ontology.jsonld> } } }
 *
 * This module never prints. What a profile says that its rule set cannot honour is computed by
 * `auditProfile` and REPORTED by the runner that owns the rule set.
 *
 * A profile is client input on two channels (the HTTP API sends an inline object, the MCP server a
 * profile name), so everything here treats it as untrusted:
 *  - every profile object passes `assertRuleProfile` — a size bound, then the JSON Schema
 *    references/rule-profile-schema.json — before any rule logic reads it;
 *  - a file is opened non-blocking and checked with fstat before a byte is read: only a regular
 *    file of at most 256 KiB is read, so a FIFO or a device can neither block nor exhaust memory;
 *  - a profile name resolves inside one directory only (`loadNamedRuleProfile`);
 *  - every client-derived token in a message goes through `quoteForMessage`, every list of
 *    messages is capped, and no message quotes file content.
 * Where a profile came from travels out of band (`profileProvenance`), never as a key of the
 * profile itself, so a client cannot forge it.
 */

import { openSync, fstatSync, readSync, closeSync, realpathSync, readFileSync, constants as FS } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { ruleProfileSchemaPath } from './resource-paths.js';

/** Hard limits on profile input. */
export const PROFILE_LIMITS = Object.freeze({
  inlineBytes: 64 * 1024, // JSON.stringify length of a profile object, checked before the schema
  fileBytes: 256 * 1024,  // size of a profile file, checked before it is read
  messages: 20,           // warnings / refusal reasons listed before "… and N more"
  schemaErrors: 5,        // schema problems listed in one refusal
  token: 80,              // characters of one client-derived token in a message
});

/**
 * A profile that is refused: a file that cannot be read or parsed, a profile that fails the schema,
 * or a severity that would drop findings. A caller that takes a profile from a client (the HTTP API)
 * maps this to a client error instead of an internal one.
 */
export class ProfileRejectedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProfileRejectedError';
    this.code = 'PROFILE_REJECTED';
  }
}

/**
 * The one way a client-derived token (a rule id, a layer, a profile name, a path) enters a message:
 * truncated to `max` characters, JSON-quoted (which escapes newlines and every other C0 control character), and with
 * C1 controls and Unicode line separators removed — so it cannot start a new log line or drive a
 * terminal.
 */
export function quoteForMessage(value, max = PROFILE_LIMITS.token) {
  const text = String(value);
  const cut = text.length > max ? `${text.slice(0, max)}…` : text;
  return JSON.stringify(cut).replace(/[\u0080-\u009f\u2028\u2029]/g, '');
}

/** At most `PROFILE_LIMITS.messages` entries, then one line counting the rest. */
function capMessages(list) {
  if (list.length <= PROFILE_LIMITS.messages) return list;
  return [...list.slice(0, PROFILE_LIMITS.messages), `… and ${list.length - PROFILE_LIMITS.messages} more`];
}

// ─── Provenance, out of band ───

const PROVENANCE = Symbol('rule profile provenance');

/** `{ label, missing }` for a profile read by one of the loaders below; null for an inline object. */
export function profileProvenance(profile) {
  return (profile && typeof profile === 'object' && profile[PROVENANCE]) || null;
}

/** Copy the provenance onto a derived profile (profileForMode clones through JSON, which drops it). */
export function carryProvenance(from, to) {
  const p = profileProvenance(from);
  if (p && to && typeof to === 'object') Object.defineProperty(to, PROVENANCE, { value: p, enumerable: false });
  return to;
}

function withProvenance(profile, label, missing = false) {
  Object.defineProperty(profile, PROVENANCE, { value: { label, missing }, enumerable: false });
  return profile;
}

/** How a message names a profile. Only a schema-checked `profile` field is used, and quoted. */
function profileLabel(profile) {
  const p = profileProvenance(profile);
  if (p) return p.label;
  return typeof profile?.profile === 'string' ? quoteForMessage(profile.profile) : '(inline profile)';
}

// ─── The schema gate ───

const profileSchema = JSON.parse(readFileSync(ruleProfileSchemaPath(), 'utf8'));
const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(profileSchema);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describeSchemaError(e) {
  const where = quoteForMessage(e.instancePath || '/');
  if (e.keyword === 'enum') return `${where} must be one of ${e.params.allowedValues.join(', ')}`;
  if (e.keyword === 'additionalProperties') return `${where} has an unknown key ${quoteForMessage(e.params.additionalProperty)}`;
  if (e.keyword === 'propertyNames') return `${where} has a key that is not a valid name`;
  return `${where} ${e.message}`;
}

/**
 * Refuse anything that is not a profile: not a plain object, larger than `PROFILE_LIMITS.inlineBytes`
 * once serialised (checked before the schema runs, so a huge object costs one stringify), or not
 * matching references/rule-profile-schema.json. `null`/`undefined` mean "no profile" and pass.
 */
export function assertRuleProfile(profile, label) {
  if (profile === null || profile === undefined) return;
  if (!isPlainObject(profile)) {
    const kind = Array.isArray(profile) ? 'an array' : typeof profile === 'object' ? 'a non-plain object' : `a ${typeof profile}`;
    throw new ProfileRejectedError(`a rule profile must be a JSON object, not ${kind}`);
  }
  let size;
  try {
    size = JSON.stringify(profile).length;
  } catch {
    throw new ProfileRejectedError('a rule profile must be plain JSON');
  }
  const name = label ?? profileLabel(profile); // quoteForMessage bounds an unchecked `profile` field
  if (size > PROFILE_LIMITS.inlineBytes) {
    throw new ProfileRejectedError(`rule profile ${name} is larger than ${PROFILE_LIMITS.inlineBytes / 1024} KiB`);
  }
  if (!validateSchema(profile)) {
    const errors = validateSchema.errors ?? [];
    const listed = errors.slice(0, PROFILE_LIMITS.schemaErrors).map(describeSchemaError);
    if (errors.length > listed.length) listed.push(`… and ${errors.length - listed.length} more`);
    throw new ProfileRejectedError(`rule profile ${name} does not match the profile schema: ${listed.join('; ')}`);
  }
}

/**
 * Refuse a profile that switches `layer` off, or sets one of its rules to a severity that stops it
 * from being reported as an error or a warning (OFF, INFO, ADVISORY). For profiles from a remote
 * client, so that it can never make a soundness finding vanish from the response.
 * `context` is profileContext() from rule-catalog.js (its `ruleLayer`).
 */
export function assertLayerNotWeakened(profile, layer, context) {
  if (!profile) return;
  const reasons = [];
  if (profile.layers?.[layer]?.enabled === false) reasons.push(`it disables the ${layer} layer`);
  for (const [id, override] of Object.entries(profile.overrides ?? {})) {
    if (context.ruleLayer.get(id) === layer && ['OFF', 'INFO', 'ADVISORY'].includes(override?.severity)) {
      reasons.push(`it sets ${layer} rule ${quoteForMessage(id)} to ${override.severity}`);
    }
  }
  if (reasons.length) {
    throw new ProfileRejectedError(`rule profile ${profileLabel(profile)} is not accepted from a client: ${capMessages(reasons).join('; ')}`);
  }
}

// ─── Reading a file safely ───

const O_NONBLOCK = FS.O_NONBLOCK ?? 0;

/**
 * Read a profile file: open non-blocking (a FIFO without a writer would otherwise block the
 * thread), fstat the open descriptor (so what is checked is what is read), refuse anything that is
 * not a regular file or is larger than `PROFILE_LIMITS.fileBytes`, then read at most that many bytes.
 * `label` is how messages name the file; nothing of the file's content ever enters a message.
 */
function readProfileText(path, label) {
  let fd;
  try {
    fd = openSync(path, FS.O_RDONLY | O_NONBLOCK);
  } catch (err) {
    throw new ProfileRejectedError(`rule profile ${label} cannot be read (${err.code ?? 'error'})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new ProfileRejectedError(`rule profile ${label} is not a regular file`);
    if (st.size > PROFILE_LIMITS.fileBytes) {
      throw new ProfileRejectedError(`rule profile ${label} is larger than ${PROFILE_LIMITS.fileBytes / 1024} KiB`);
    }
    const buf = Buffer.alloc(PROFILE_LIMITS.fileBytes + 1);
    let n = 0;
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
      if (n > PROFILE_LIMITS.fileBytes) {
        throw new ProfileRejectedError(`rule profile ${label} is larger than ${PROFILE_LIMITS.fileBytes / 1024} KiB`);
      }
    }
    return buf.toString('utf8', 0, n);
  } catch (err) {
    if (err instanceof ProfileRejectedError) throw err;
    throw new ProfileRejectedError(`rule profile ${label} cannot be read (${err.code ?? 'error'})`);
  } finally {
    closeSync(fd);
  }
}

/** Parse, gate and label a profile's text. A leading UTF-8 BOM (Windows editors) is stripped. */
function parseProfile(text, label) {
  const json = text.replace(/^﻿/, '');
  let profile;
  try {
    profile = JSON.parse(json);
  } catch (err) {
    // The parser's own message quotes the start of the input; only the position is passed on.
    throw new ProfileRejectedError(`rule profile ${label} is not valid JSON at ${jsonErrorLocation(json, err)}`);
  }
  assertRuleProfile(profile, label);
  return withProvenance(profile, label);
}

/** "line L, column C" of a JSON.parse failure; the end of the text when the parser names no position. */
function jsonErrorLocation(text, err) {
  const m = /position (\d+)/.exec(err.message);
  const pos = m ? Number(m[1]) : text.length;
  const before = text.slice(0, pos);
  return `line ${before.split('\n').length}, column ${pos - before.lastIndexOf('\n')}`;
}

/**
 * Read a profile from a file path — for local, trusted callers (the CLI and the library API); the
 * path is resolved against the working directory and named in messages.
 *  - The file does not exist: an empty profile marked missing, which behaves exactly like no
 *    profile (every rule at its ontology default) but lets the runner warn that it was not found.
 *  - It is not a small regular file, cannot be read, is not JSON or fails the schema: throws.
 */
export function loadRuleProfile(profilePath) {
  const path = resolve(profilePath);
  const label = quoteForMessage(path, 4096); // a local caller's own path, shown whole
  let real;
  try {
    real = realpathSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return withProvenance({}, label, true);
    throw new ProfileRejectedError(`rule profile ${label} cannot be read (${err.code ?? 'error'})`);
  }
  return parseProfile(readProfileText(real, label), label);
}

const PROFILE_NAME = /^(custom\/)?[a-z0-9][a-z0-9-]{0,63}(\.json)?$/;

/**
 * Read a profile by NAME from `rulesDir` — for remote callers (the MCP server). Accepted:
 * `strict`, `strict-profile`, `strict-profile.json`, `rules/strict-profile.json` (the documented
 * form; the leading `rules/` names the directory this already is), and `custom/<name>`.
 * Anything else — an absolute path, `..`, another directory — is refused before the file system is
 * touched, and a symlink whose target leaves `rulesDir` is refused. Messages name the name only.
 */
export function loadNamedRuleProfile(name, rulesDir) {
  const shown = quoteForMessage(name);
  const bare = typeof name === 'string' ? name.replace(/^rules\//, '') : '';
  if (!PROFILE_NAME.test(bare)) {
    throw new ProfileRejectedError(`rule profile name ${shown} is not valid — use a name such as "strict" or "custom/my-team"`);
  }
  const base = bare.replace(/\.json$/, '');
  const candidates = [`${base}.json`, ...(base.endsWith('-profile') ? [] : [`${base}-profile.json`])];
  let root;
  try {
    root = realpathSync(rulesDir);
  } catch {
    throw new ProfileRejectedError(`unknown rule profile ${shown}`);
  }
  const label = `profile ${shown}`;
  for (const file of candidates) {
    let real;
    try {
      real = realpathSync(join(root, file));
    } catch {
      continue;
    }
    if (!real.startsWith(root + sep)) {
      throw new ProfileRejectedError(`rule profile ${shown} points outside the rules directory`);
    }
    return parseProfile(readProfileText(real, label), label);
  }
  throw new ProfileRejectedError(`unknown rule profile ${shown}`);
}

/**
 * What a profile names that its rule set cannot honour. Pure; the runner prints `warnings` and
 * throws on `errors`. Both lists are capped at `PROFILE_LIMITS.messages` plus a count of the rest,
 * and every name in them is quoted with `quoteForMessage`.
 *
 * @param {object|null} profile
 * @param {{ ruleSet: string, ruleIds: Set<string>, layers: Set<string>, severities: Set<string>,
 *           scenarioRuleIds: Set<string>, ruleLayer: Map<string, string>,
 *           severityOnlyFor?: Record<string, Set<string>> }} context - see profileContext() in
 *   rule-catalog.js; `severityOnlyFor` maps a severity to the only layers that can report it.
 * @returns {{ warnings: string[], errors: string[] }}
 */
export function auditProfile(profile, context) {
  const warnings = [];
  const errors = [];
  if (!profile) return { warnings, errors };
  const name = profileLabel(profile);
  if (profileProvenance(profile)?.missing) {
    warnings.push(`rule profile ${name} not found — every ${context.ruleSet} rule runs at its default severity`);
  }
  for (const layer of Object.keys(profile.layers ?? {})) {
    if (!context.layers.has(layer)) {
      warnings.push(`rule profile ${name} names layer ${quoteForMessage(layer)}, which the ${context.ruleSet} rule set does not have — ignored`);
    }
  }
  for (const [id, override] of Object.entries(profile.overrides ?? {})) {
    const severity = override?.severity;
    const rule = quoteForMessage(id);
    if (severity !== undefined && !context.severities.has(severity)) {
      errors.push(`rule profile ${name}: unknown severity ${quoteForMessage(severity)} (${rule})`);
    } else if (context.scenarioRuleIds.has(id)) {
      warnings.push(`rule profile ${name} overrides ${id}, which runs in the scenario pipeline and is not profile-switchable in this release — ignored`);
    } else if (!context.ruleIds.has(id)) {
      warnings.push(`rule profile ${name} names rule ${rule}, which the ${context.ruleSet} rule set does not have — ignored`);
    } else {
      const only = context.severityOnlyFor?.[severity];
      if (only && !only.has(context.ruleLayer.get(id))) {
        errors.push(`rule profile ${name}: ${id} is a ${context.ruleLayer.get(id)} rule, and severity ${severity} is reported for the ${[...only].join('/')} layer only — its findings would be dropped`);
      }
    }
  }
  return { warnings: capMessages(warnings), errors: capMessages(errors) };
}

/** Is this rule switched on under this profile? */
export function isRuleEnabled(rule, profile) {
  if (!profile) return true;
  const layerConfig = profile.layers?.[rule.layer];
  if (layerConfig && layerConfig.enabled === false) return false;
  const override = profile.overrides?.[rule.id];
  if (override?.severity === 'OFF') return false;
  return true;
}

/** Severity to report this rule at, honouring any override. */
export function getEffectiveSeverity(rule, profile) {
  const override = profile?.overrides?.[rule.id];
  return override?.severity || rule.defaultSeverity;
}

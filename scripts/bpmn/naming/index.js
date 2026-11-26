/**
 * The natural language of a model's labels: the optional top-level `language` of both input
 * formats, a language tag with a lowercase primary subtag ("de", "en-GB").
 *
 * A value that is not a valid tag counts as absent everywhere: nothing is written and nothing is
 * selected by it, so such a model gives the same results as one without the field.
 */

/** The `language` pattern of `references/input-schema.json` and `references/input-schema-v2.json`. */
export const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The whole valid tag of `lc.language` (`"en-GB"`), else `null`. Never throws. */
export function languageTag(lc) {
  let tag;
  try {
    if (!isPlainObject(lc)) return null;
    tag = lc.language;
  } catch {
    return null; // a throwing getter or proxy trap
  }
  return typeof tag === 'string' && LANGUAGE_TAG.test(tag) ? tag : null;
}

/** The primary subtag of the model's language (`"en-GB"` → `"en"`), else `null`. Never throws. */
export function modelLanguage(lc) {
  const tag = languageTag(lc);
  return tag === null ? null : tag.split('-')[0];
}

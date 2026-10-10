/**
 * Client-derived text on its way into a message, a log line or a response.
 *
 * Two forms, one character class:
 *  - `quoteForMessage` — truncated and JSON-quoted (newlines and every other C0 control character
 *    escaped), with C1 controls, Unicode line separators and format characters (bidi overrides
 *    and isolates, zero-width characters, BOM) removed: for a token quoted inside a sentence.
 *  - `boundText` — truncated, unquoted, with every control, line-separator and format character
 *    replaced by its `\uXXXX` escape: for a field value (an audit-log field, an echoed error).
 *
 * Either way the text can neither start a new log line, drive a terminal, nor reorder what a
 * reader sees, and its length is bounded by `max` (plus one ellipsis character).
 */

const FORMAT_AND_C1 = /[\u0080-\u009f\u2028\u2029\p{Cf}]/gu;
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu;

function cut(value, max) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function quoteForMessage(value, max) {
  return JSON.stringify(cut(value, max)).replace(FORMAT_AND_C1, '');
}

export function boundText(value, max) {
  return cut(value, max).replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

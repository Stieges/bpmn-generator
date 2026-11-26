/**
 * Label tokens for the naming rules: folding of a word and the split of a label into words and
 * tokens. Pure functions, no imports.
 */

/** Lower case, `ß` → `ss`, `ä/ö/ü` → `ae/oe/ue`, everything but `a–z` and `0–9` removed. */
export function foldWord(word) {
  return String(word).toLowerCase()
    .replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * `text` without every `open … close` span. The closer is the first one after the opener; an
 * opener with no closer after it is dropped alone. Linear: the position of the last closer is
 * known once, so an unclosed opener never rescans.
 */
function removeSpans(text, open, close) {
  const last = text.lastIndexOf(close);
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== open) { out += ch; i++; continue; }
    const end = i < last ? text.indexOf(close, i + 1) : -1;
    if (end === -1) { out += ' '; i++; } else { out += ' '; i = end + 1; }
  }
  return out;
}

/**
 * The words of a label. `(…)` and `[…]` are removed, `/` and newlines count as spaces.
 * `wordCount` counts whitespace-separated words with a non-empty fold, before the hyphen split
 * (`Follow-up` is one word); `tokens` are the parts after splitting on hyphens whose fold is not
 * empty, `raw` keeping the case.
 */
export function labelTokens(name) {
  return split(name, false);
}

/** `labelTokens` with `word` on every token: the 0-based index of the whitespace word it is a part of. */
export function labelTokenWords(name) {
  return split(name, true);
}

function split(name, withWord) {
  if (typeof name !== 'string') return { wordCount: 0, tokens: [] };
  const text = removeSpans(removeSpans(name, '(', ')'), '[', ']').replace(/[/\r\n]/g, ' ');
  let wordCount = 0;
  const tokens = [];
  for (const word of text.split(/\s+/)) {
    if (foldWord(word) === '') continue;
    wordCount++;
    for (const raw of word.split('-')) {
      const folded = foldWord(raw);
      if (folded !== '') tokens.push(withWord ? { raw, folded, word: wordCount - 1 } : { raw, folded });
    }
  }
  return { wordCount, tokens };
}

/**
 * Audit helpers for the ontology fences (scripts/bpmn/ontology.test.js). Pure: no I/O.
 */

// Blank out comments, keeping line breaks so line numbers stay true.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

const ARRAY_OF_STRINGS = /\[\s*((?:'[^'\n]*'|"[^"\n]*")(?:\s*,\s*(?:'[^'\n]*'|"[^"\n]*"))*)\s*,?\s*\]/g;

export function findVocabularyLists(source, names, minCount = 3) {
  const src = stripComments(source);
  const out = [];
  for (const m of src.matchAll(ARRAY_OF_STRINGS)) {
    const items = [...m[1].matchAll(/'([^']*)'|"([^"]*)"/g)].map(x => x[1] ?? x[2]);
    const hits = items.filter(i => names.has(i));
    if (hits.length >= minCount) {
      out.push({ line: src.slice(0, m.index).split('\n').length, names: hits });
    }
  }
  return out;
}

/*
 * layoutText and semanticShorten port diagram-js 15.3.0 `lib/util/Text.js` (`layoutNext`,
 * `semanticShorten`). Copyright (c) 2014-present Camunda Services GmbH, MIT license — see
 * THIRD_PARTY_NOTICES.md.
 */

/**
 * Text layout without a DOM — the one place both notations measure and break text.
 *
 * bpmn.io (bpmn-js, dmn-js) lays text out with diagram-js's `Text.js`, measuring each candidate line
 * in the DOM. We cannot measure, so `lineWidth` sums Arial advance widths instead, and `layoutText`
 * breaks lines by Text.js's own rule. Moved here from `bpmn/coordinates.js` (which keeps its
 * `edgeLabelLayout` as a thin wrapper) so `dmn/` can lay out text the same way without depending on
 * `bpmn/`. Format-independent: no CFG, no notation.
 */

/**
 * Advance widths of Arial (Helvetica-, Liberation Sans- and Arimo-compatible), 1/1000 em, for
 * printable ASCII 32–126 in code-point order. Identical to what Chrome measures. No kerning, so
 * the estimate is never narrower than what a browser draws.
 */
const ARIAL_ASCII_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const ARIAL_EXTRA_WIDTHS = { '→': 1000, '…': 1000, '–': 556, '—': 1000, 'ß': 611 };

function arialCharWidth(ch) {
  const c = ch.codePointAt(0);
  if (c >= 32 && c <= 126) return ARIAL_ASCII_WIDTHS[c - 32];
  if (ARIAL_EXTRA_WIDTHS[ch] !== undefined) return ARIAL_EXTRA_WIDTHS[ch];
  // Accented Latin letters: the base letter's advance (ä = a, Ö = O, …).
  const b = ch.normalize('NFD').codePointAt(0);
  if (b >= 32 && b <= 126) return ARIAL_ASCII_WIDTHS[b - 32];
  return 1000;
}

/** Rendered width of one line, px. Leading/trailing blanks collapse in SVG and do not count. */
export function lineWidth(text, fontSize) {
  let w = 0;
  for (const ch of String(text).trim()) w += arialCharWidth(ch);
  return (w * fontSize) / 1000;
}

/** bpmn-js Text.js `semanticShorten`: cut a line at a blank, hyphen or soft hyphen. */
function semanticShorten(line, maxLength) {
  const parts = line.split(/(\s|-|­)/g);
  const kept = [];
  let length = 0;
  if (parts.length > 1) {
    let part;
    while ((part = parts.shift())) {
      if (part.length + length < maxLength) {
        kept.push(part);
        length += part.length;
      } else {
        if (part === '-' || part === '­') kept.pop();
        break;
      }
    }
  }
  if (kept[kept.length - 1] === '­') kept[kept.length - 1] = '-';
  return kept.join('');
}

/**
 * Text.js `layoutNext` over the whole text: its lines, broken exactly as diagram-js breaks them
 * (Arial widths instead of a DOM measurement), and the box they need, `w` × `h` px.
 *
 * `cuts` lists every word the breaking had to cut inside — a run of characters with no blank,
 * hyphen or soft hyphen in it that is wider than the line (the hard cut, last line of Text.js
 * `layoutNext`'s fallback) — each once, in text order, as typed (a word cut over several lines is
 * one entry). Nothing else about the layout depends on it.
 *
 * @param {string} text
 * @param {{ fontSize: number, lineHeight: number, wrapWidth: number }} style
 * @returns {{ lines: string[], w: number, h: number, cuts: string[] }}
 */
export function layoutText(text, { fontSize, lineHeight, wrapWidth }) {
  const pending = String(text ?? '').split(/\u00AD?\r?\n/);
  const lines = [];
  const cuts = [];
  let w = 0;
  // The entry of `cuts` whose word goes on in the line `pending` holds next (a cut inside a word).
  let open = null;
  while (pending.length) {
    const original = pending.shift();
    const lead = original.trimStart().split(/[\s\-\u00AD]/)[0];
    const cont = open;
    open = null;
    let cutHere = null;
    let fit = original;
    for (;;) {
      const fw = fit ? lineWidth(fit, fontSize) : 0;
      if (fit === ' ' || fit === '' || fw < Math.round(wrapWidth) || fit.length < 2) {
        if (fit.length < original.length) pending.unshift(original.slice(fit.length).trim());
        lines.push(fit.trim());
        w = Math.max(w, fw);
        if (cutHere && fit.length < original.length) open = cutHere;
        break;
      }
      const length = Math.max(fit.length * (wrapWidth / fw), 1);
      const shortened = semanticShorten(fit, length);
      if (shortened) { fit = shortened; continue; }
      const cutAt = Math.max(Math.round(length - 1), 1);
      const lead0 = fit.length - fit.trimStart().length;
      if (!cutHere && cutAt > lead0 && cutAt < lead0 + fit.trimStart().split(/[\s\-\u00AD]/)[0].length) {
        cutHere = cont ?? { word: lead };
        if (!cont) cuts.push(cutHere);
      }
      fit = fit.slice(0, cutAt);
    }
  }
  return { lines, w, h: Math.ceil(lines.length * fontSize * lineHeight), cuts: [...new Set(cuts.map(c => c.word))] };
}

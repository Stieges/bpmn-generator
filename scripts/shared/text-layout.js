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
 * @param {string} text
 * @param {{ fontSize: number, lineHeight: number, wrapWidth: number }} style
 * @returns {{ lines: string[], w: number, h: number }}
 */
export function layoutText(text, { fontSize, lineHeight, wrapWidth }) {
  const pending = String(text ?? '').split(/­?\r?\n/);
  const lines = [];
  let w = 0;
  while (pending.length) {
    const original = pending.shift();
    let fit = original;
    for (;;) {
      const fw = fit ? lineWidth(fit, fontSize) : 0;
      if (fit === ' ' || fit === '' || fw < Math.round(wrapWidth) || fit.length < 2) {
        if (fit.length < original.length) pending.unshift(original.slice(fit.length).trim());
        lines.push(fit.trim());
        w = Math.max(w, fw);
        break;
      }
      const length = Math.max(fit.length * (wrapWidth / fw), 1);
      fit = semanticShorten(fit, length) || fit.slice(0, Math.max(Math.round(length - 1), 1));
    }
  }
  return { lines, w, h: Math.ceil(lines.length * fontSize * lineHeight) };
}

/**
 * BPMN Generator Utilities & Configuration
 * Loads config.json, exports visual constants + helper functions.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function loadConfig(customPath) {
  const defaults = JSON.parse(readFileSync(resolve(__dirname, 'config.json'), 'utf8'));
  if (!customPath) return defaults;
  const custom = JSON.parse(readFileSync(resolve(customPath), 'utf8'));
  const merged = { ...defaults };
  for (const key of Object.keys(custom)) {
    if (typeof custom[key] === 'object' && !Array.isArray(custom[key]) && typeof defaults[key] === 'object') {
      merged[key] = { ...defaults[key], ...custom[key] };
    } else {
      merged[key] = custom[key];
    }
  }
  return merged;
}

export const CFG = loadConfig(process.env.BPMN_CONFIG);

export const SHAPE          = CFG.shape;
export const SW             = CFG.strokeWidth;
export const CLR            = CFG.color;
export const LANE_HEADER_W  = CFG.layout.laneHeaderWidth;
export const LANE_PADDING   = CFG.layout.lanePadding;
export const LABEL_DISTANCE = CFG.layout.labelDistance;
export const TASK_RX        = CFG.layout.taskBorderRadius;
export const INNER_OUTER_GAP = CFG.layout.innerOuterGap;
export const EXTERNAL_LABEL_H = CFG.layout.externalLabelHeight;
export const POOL_GAP       = CFG.layout.poolGap;

export function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function rn(n) {
  return Math.round(n * 10) / 10;
}

export function wrapText(text, maxChars) {
  if (!text) return [''];
  // Sanity clamp: maxChars < 2 would infinite-loop in breakLongWord
  // (we need at least 1 char + 1 hyphen per chunk).
  if (maxChars < 2) maxChars = 2;
  if (text.length <= maxChars) return [text];

  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';

  const breakLongWord = (word) => {
    // Break a single word longer than maxChars into hyphen-terminated chunks.
    // All but the last chunk end with '-'. Chunks have length <= maxChars.
    const chunks = [];
    let i = 0;
    while (i < word.length) {
      const remaining = word.length - i;
      if (remaining <= maxChars) {
        chunks.push(word.slice(i));
        break;
      }
      // Reserve one char for the hyphen
      const take = maxChars - 1;
      chunks.push(word.slice(i, i + take) + '-');
      i += take;
    }
    return chunks;
  };

  for (const w of words) {
    if (w.length > maxChars) {
      if (cur) { lines.push(cur); cur = ''; }
      const chunks = breakLongWord(w);
      for (let i = 0; i < chunks.length - 1; i++) lines.push(chunks[i]);
      cur = chunks[chunks.length - 1];
      continue;
    }
    const candidate = cur ? `${cur} ${w}` : w;
    if (candidate.length > maxChars) {
      if (cur) lines.push(cur);
      cur = w;
    } else {
      cur = candidate;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

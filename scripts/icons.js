/**
 * BPMN Icons — Event Markers, Task Type Icons, Bottom Markers
 * SVG path data based on bpmn-js PathMap glyphs.
 */

import { CLR, rn } from './utils.js';

function renderLoopMarker(ox, oy) {
  return `<path d="M 4,8 A 5,5 0 1,0 11,5 L 13,2 L 11,5 L 8,5" fill="none" stroke="${CLR.stroke}" stroke-width="1.5" stroke-linecap="round"/>`;
}

function renderMIParallelMarker(ox, oy) {
  return `<line x1="3" y1="1" x2="3" y2="13" stroke="${CLR.stroke}" stroke-width="2"/>`
       + `<line x1="7" y1="1" x2="7" y2="13" stroke="${CLR.stroke}" stroke-width="2"/>`
       + `<line x1="11" y1="1" x2="11" y2="13" stroke="${CLR.stroke}" stroke-width="2"/>`;
}

function renderMISequentialMarker(ox, oy) {
  return `<line x1="1" y1="3" x2="13" y2="3" stroke="${CLR.stroke}" stroke-width="2"/>`
       + `<line x1="1" y1="7" x2="13" y2="7" stroke="${CLR.stroke}" stroke-width="2"/>`
       + `<line x1="1" y1="11" x2="13" y2="11" stroke="${CLR.stroke}" stroke-width="2"/>`;
}

function renderSubProcessMarker(ox, oy) {
  return `<rect x="1" y="1" width="12" height="12" fill="${CLR.fill}" stroke="${CLR.stroke}" stroke-width="1"/>`
       + `<line x1="7" y1="3" x2="7" y2="11" stroke="${CLR.stroke}" stroke-width="1.5"/>`
       + `<line x1="3" y1="7" x2="11" y2="7" stroke="${CLR.stroke}" stroke-width="1.5"/>`;
}

function renderAdHocMarker(ox, oy) {
  return `<path d="M 2,7 C 4,3 6,3 8,7 C 10,11 12,11 14,7" fill="none" stroke="${CLR.stroke}" stroke-width="1.5"/>`;
}

function renderCompensationMarker(ox, oy) {
  return `<polygon points="1,7 7,2 7,12" fill="none" stroke="${CLR.stroke}" stroke-width="1.5"/>`
       + `<polygon points="7,7 13,2 13,12" fill="none" stroke="${CLR.stroke}" stroke-width="1.5"/>`;
}

// ─────────────────────────────────────────────────────────────────────
function renderEventMarker(marker, cx, cy, r, filled) {
  const f  = filled ? CLR.stroke : CLR.fill;
  const fi = filled ? CLR.fill   : CLR.stroke; // inverted stroke for filled envelopes
  const s  = CLR.stroke;
  const sw = 1.5;
  const sc = r / 18;

  switch (marker) {
    case 'message': {
      const mw = rn(14*sc), mh = rn(10*sc);
      const mx = cx - mw/2, my = cy - mh/2;
      return `<rect x="${mx}" y="${my}" width="${mw}" height="${mh}" fill="${f}" stroke="${filled ? fi : s}" stroke-width="${sw}"/>`
           + `<path d="M ${mx},${my} L ${cx},${rn(my+mh*0.6)} L ${rn(mx+mw)},${my}" fill="none" stroke="${filled ? fi : s}" stroke-width="${sw}"/>`;
    }
    case 'timer': {
      const tr = rn(r * 0.55);
      let timerSvg = `<circle cx="${cx}" cy="${cy}" r="${tr}" fill="${CLR.fill}" stroke="${s}" stroke-width="${sw}"/>`;
      // 12 tick marks
      for (let i = 0; i < 12; i++) {
        const a = (i * 30) * Math.PI / 180;
        const ix = cx + Math.cos(a) * (tr - 2);
        const iy = cy + Math.sin(a) * (tr - 2);
        const ox = cx + Math.cos(a) * tr;
        const oy = cy + Math.sin(a) * tr;
        timerSvg += `<line x1="${rn(ix)}" y1="${rn(iy)}" x2="${rn(ox)}" y2="${rn(oy)}" stroke="${s}" stroke-width="0.5"/>`;
      }
      // Clock hands
      timerSvg += `<line x1="${cx}" y1="${rn(cy-tr+3)}" x2="${cx}" y2="${cy}" stroke="${s}" stroke-width="1.5" stroke-linecap="round"/>`;
      timerSvg += `<line x1="${cx}" y1="${cy}" x2="${rn(cx+tr*0.4)}" y2="${rn(cy-tr*0.3)}" stroke="${s}" stroke-width="1.5" stroke-linecap="round"/>`;
      return timerSvg;
    }
    case 'signal': {
      const sh = r * 0.65, sw2 = sh * 1.1;
      const pts = `${cx},${rn(cy-sh*0.6)} ${rn(cx+sw2/2)},${rn(cy+sh*0.4)} ${rn(cx-sw2/2)},${rn(cy+sh*0.4)}`;
      return `<polygon points="${pts}" fill="${f}" stroke="${s}" stroke-width="${sw}"/>`;
    }
    case 'error': {
      const eh = r * 0.65;
      return `<path d="M ${rn(cx-eh*0.3)},${rn(cy+eh*0.5)} L ${rn(cx-eh*0.1)},${rn(cy-eh*0.25)} L ${rn(cx+eh*0.2)},${rn(cy)} L ${rn(cx+eh*0.3)},${rn(cy-eh*0.5)} L ${rn(cx+eh*0.1)},${rn(cy+eh*0.2)} L ${rn(cx-eh*0.2)},${rn(cy)} Z" fill="${f}" stroke="${s}" stroke-width="${sw}"/>`;
    }
    case 'escalation': {
      const eh = r * 0.6;
      return `<path d="M ${cx},${rn(cy-eh)} L ${rn(cx+eh*0.5)},${rn(cy+eh*0.5)} L ${cx},${rn(cy)} L ${rn(cx-eh*0.5)},${rn(cy+eh*0.5)} Z" fill="${f}" stroke="${s}" stroke-width="${sw}"/>`;
    }
    case 'compensation': {
      const cw = r * 0.35, ch = r * 0.5;
      return `<polygon points="${rn(cx-cw*2)},${cy} ${rn(cx-cw)},${rn(cy-ch)} ${rn(cx-cw)},${rn(cy+ch)}" fill="${f}" stroke="${s}" stroke-width="${sw}"/>`
           + `<polygon points="${rn(cx-cw)},${cy} ${cx},${rn(cy-ch)} ${cx},${rn(cy+ch)}" fill="${f}" stroke="${s}" stroke-width="${sw}"/>`;
    }
    case 'conditional': {
      const cw = rn(10*sc), ch = rn(12*sc);
      const mx = cx - cw/2, my = cy - ch/2;
      let svg = `<rect x="${mx}" y="${my}" width="${cw}" height="${ch}" fill="${CLR.fill}" stroke="${s}" stroke-width="1"/>`;
      for (let i = 0; i < 4; i++) {
        svg += `<line x1="${mx+2}" y1="${rn(my+2+i*3)}" x2="${rn(mx+cw-2)}" y2="${rn(my+2+i*3)}" stroke="${s}" stroke-width="0.8"/>`;
      }
      return svg;
    }
    case 'link': {
      const lh = r*0.45, lw = r*0.65;
      return `<path d="M ${rn(cx-lw)},${rn(cy-lh*0.5)} L ${cx},${rn(cy-lh*0.5)} L ${cx},${rn(cy-lh)} L ${rn(cx+lw)},${cy} L ${cx},${rn(cy+lh)} L ${cx},${rn(cy+lh*0.5)} L ${rn(cx-lw)},${rn(cy+lh*0.5)} Z" fill="${f}" stroke="${s}" stroke-width="${sw}"/>`;
    }
    case 'cancel': {
      const cd = r * 0.45;
      return `<line x1="${rn(cx-cd)}" y1="${rn(cy-cd)}" x2="${rn(cx+cd)}" y2="${rn(cy+cd)}" stroke="${s}" stroke-width="3" stroke-linecap="round"/>`
           + `<line x1="${rn(cx+cd)}" y1="${rn(cy-cd)}" x2="${rn(cx-cd)}" y2="${rn(cy+cd)}" stroke="${s}" stroke-width="3" stroke-linecap="round"/>`;
    }
    case 'multiple': {
      return renderPentagon(cx, cy, r * 0.55, s);
    }
    case 'parallelMultiple': {
      const pd = r * 0.5;
      return `<line x1="${cx}" y1="${rn(cy-pd)}" x2="${cx}" y2="${rn(cy+pd)}" stroke="${s}" stroke-width="2.5" stroke-linecap="round"/>`
           + `<line x1="${rn(cx-pd)}" y1="${cy}" x2="${rn(cx+pd)}" y2="${cy}" stroke="${s}" stroke-width="2.5" stroke-linecap="round"/>`;
    }
    default: return '';
  }
}

function inferEventMarker(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes('nachricht') || n.includes('message') || n.includes('mail') || n.includes('e-mail')) return 'message';
  if (n.includes('timer') || n.includes('zeit') || n.includes('frist') || n.includes('warte') || n.includes('deadline')) return 'timer';
  if (n.includes('fehler') || n.includes('error') || n.includes('exception') || n.includes('störung')) return 'error';
  if (n.includes('signal')) return 'signal';
  if (n.includes('eskalation') || n.includes('escalation')) return 'escalation';
  if (n.includes('kompensation') || n.includes('compensation')) return 'compensation';
  if (n.includes('bedingung') || n.includes('conditional') || n.includes('condition')) return 'conditional';
  if (n.includes('abbruch') || n.includes('cancel') || n.includes('abgebrochen') || n.includes('stornierung')) return 'cancel';
  if (n.includes('terminat') || n.includes('beendet') || n.includes('sofortiger abbruch')) return 'terminate';
  return null;
}

// ─────────────────────────────────────────────────────────────────────
function renderTaskIcon(type, ox, oy) {
  const s = CLR.stroke, f = CLR.fill;
  switch (type) {
    case 'userTask': {
      // bpmn-js: TASK_TYPE_USER_1 (body), _2 (face), _3 (hair) at abspos(15,12)
      const ux = ox + 15, uy = oy + 12;
      const body = `m ${ux},${uy} c 0.909,-0.845 1.594,-2.049 1.594,-3.385 0,-2.554 -1.805,-4.622 -4.357,-4.622 -2.552,0 -4.288,2.068 -4.288,4.622 0,1.348 0.974,2.562 1.896,3.405 -0.529,0.187 -5.669,2.097 -5.794,4.756 v 6.718 h 17 v -6.718 c 0,-2.298 -5.528,-4.595 -6.051,-4.776 z m -8,6 l 0,5.5 m 11,0 l 0,-5`;
      const face = `m ${ux + 2.162},${uy + 1.009} c 0,2.447 -2.158,4.431 -4.821,4.431 -2.665,0 -4.822,-1.981 -4.822,-4.431`;
      const hair = `m ${ux - 6.9},${uy - 3.80} c 0,0 2.251,-2.358 4.274,-1.177 2.024,1.181 4.221,1.537 4.124,0.965 -0.098,-0.57 -0.117,-3.791 -4.191,-4.136 -3.575,0.001 -4.208,3.367 -4.207,4.348 z`;
      return `<g><path d="${body}" fill="${f}" stroke="${s}" stroke-width="0.5"/>`
        + `<path d="${face}" fill="none" stroke="${s}" stroke-width="0.5"/>`
        + `<path d="${hair}" fill="${s}" stroke="${s}" stroke-width="0.5"/></g>`;
    }
    case 'serviceTask': {
      // bpmn-js: TASK_TYPE_SERVICE rendered twice at (6,6)+(11,10) with abspos(12,18)
      const cogPath = (tx, ty) => {
        const cx = tx + 12, cy = ty + 18;
        return `m ${cx},${cy} v -1.713 c 0.352,-0.071 0.704,-0.178 1.048,-0.321 0.344,-0.145 0.666,-0.321 0.966,-0.521 l 1.194,1.18 1.567,-1.577 -1.195,-1.18 c 0.403,-0.614 0.683,-1.299 0.825,-2.018 l 1.622,-0.01 v -2.22 l -1.637,0.01 c -0.073,-0.352 -0.178,-0.7 -0.324,-1.044 -0.145,-0.344 -0.321,-0.664 -0.523,-0.962 l 1.131,-1.136 -1.583,-1.563 -1.13,1.136 c -0.614,-0.401 -1.303,-0.681 -2.023,-0.822 l 0.009,-1.619 h -2.241 l 0.004,1.631 c -0.354,0.074 -0.705,0.18 -1.05,0.324 -0.344,0.144 -0.665,0.321 -0.964,0.52 l -1.17,-1.158 -1.567,1.579 1.168,1.157 c -0.403,0.613 -0.683,1.298 -0.825,2.017 l -1.659,0.003 v 2.222 l 1.672,-0.006 c 0.073,0.351 0.18,0.702 0.324,1.045 0.145,0.344 0.321,0.664 0.523,0.961 l -1.199,1.197 1.584,1.56 1.196,-1.193 c 0.614,0.403 1.303,0.682 2.023,0.823 l 0.001,1.699 h 2.227 z m 0.221,-3.996 c -1.789,0.75 -3.858,-0.093 -4.61,-1.874 -0.752,-1.783 0.091,-3.846 1.88,-4.596 1.788,-0.749 3.857,0.093 4.609,1.874 0.752,1.782 -0.091,3.846 -1.879,4.596 z`;
      };
      const fillPath = (tx, ty) => {
        const cx = tx + 12 + 0.221, cy = ty + 18 - 3.996;
        return `m ${cx},${cy} c -1.789,0.75 -3.858,-0.093 -4.61,-1.874 -0.752,-1.783 0.091,-3.846 1.88,-4.596 1.788,-0.749 3.857,0.093 4.609,1.874 0.752,1.782 -0.091,3.846 -1.879,4.596 z`;
      };
      return `<g>`
        + `<path d="${cogPath(ox + 6, oy + 6)}" fill="${f}" stroke="${s}" stroke-width="0.5"/>`
        + `<path d="${fillPath(ox + 6, oy + 6)}" fill="none" stroke="${s}" stroke-width="0.5"/>`
        + `<path d="${cogPath(ox + 11, oy + 10)}" fill="${f}" stroke="${s}" stroke-width="0.5"/>`
        + `<path d="${fillPath(ox + 11, oy + 10)}" fill="${s}" stroke="${s}" stroke-width="0.5"/>`
        + `</g>`;
    }
    case 'scriptTask': {
      // bpmn-js: TASK_TYPE_SCRIPT at abspos(15,20)
      const sx = ox + 15, sy = oy + 20;
      const d = `m ${sx},${sy} c 9.967,-6.273 -8.001,-7.919 2.969,-14.938 l -8.803,0 c -10.97,7.019 6.998,8.665 -2.969,14.938 z m -7,-12 l 5,0 m -4.5,3 l 4.5,0 m -3,3 l 5,0 m -4,3 l 5,0`;
      return `<path d="${d}" fill="${f}" stroke="${s}" stroke-width="0.5"/>`;
    }
    case 'sendTask': {
      // bpmn-js: TASK_TYPE_SEND at position(0.285,0.357) on 21×14 container
      const sx = ox + 6, sy = oy + 5;
      return `<g>`
        + `<path d="m ${sx},${sy} l 0,14 l 21,0 l 0,-14 z l 10.5,6 l 10.5,-6" fill="${s}" stroke="${f}" stroke-width="0.5"/>`
        + `</g>`;
    }
    case 'receiveTask': {
      // Inverse of send: unfilled envelope
      const sx = ox + 6, sy = oy + 5;
      return `<g>`
        + `<path d="m ${sx},${sy} l 0,14 l 21,0 l 0,-14 z l 10.5,6 l 10.5,-6" fill="${f}" stroke="${s}" stroke-width="1"/>`
        + `</g>`;
    }
    case 'manualTask': {
      // bpmn-js: TASK_TYPE_MANUAL at abspos(17,15)
      const mx = ox + 17, my = oy + 15;
      const d = `m ${mx},${my} c 0.234,-0.01 5.604,0.008 8.029,0.004 0.808,0 1.271,-0.172 1.417,-0.752 0.227,-0.898 -0.334,-1.314 -1.338,-1.316 -2.467,-0.01 -7.886,-0.004 -8.108,-0.004 -0.014,-0.079 0.016,-0.533 0,-0.61 0.195,-0.042 8.507,0.006 9.616,0.002 0.877,-0.007 1.35,-0.438 1.353,-1.208 0.003,-0.768 -0.479,-1.09 -1.35,-1.091 -2.968,-0.002 -9.619,-0.013 -9.619,-0.013 v -0.591 c 0,0 5.052,-0.016 7.225,-0.016 0.888,-0.002 1.354,-0.416 1.351,-1.193 -0.006,-0.761 -0.492,-1.196 -1.361,-1.196 -3.473,-0.005 -10.86,-0.003 -11.083,-0.003 -0.022,-0.047 -0.045,-0.094 -0.069,-0.139 0.394,-0.319 2.041,-1.626 2.415,-2.017 0.469,-0.487 0.519,-1.165 0.162,-1.604 -0.414,-0.511 -0.973,-0.5 -1.48,-0.236 -1.461,0.764 -6.6,3.643 -7.733,4.271 -0.9,0.499 -1.516,1.253 -1.882,2.19 -0.37,0.95 -0.17,2.01 -0.166,2.979 0.004,0.718 -0.273,1.345 -0.055,2.063 0.629,2.087 2.425,3.312 4.859,3.318 4.618,0.014 9.238,-0.139 13.857,-0.158 0.755,-0.004 1.171,-0.301 1.182,-1.033 0.012,-0.754 -0.423,-0.969 -1.183,-0.973 -1.778,-0.01 -5.824,-0.004 -6.04,-0.004 0.001,-0.084 0.003,-0.586 0.001,-0.67 z`;
      return `<path d="${d}" fill="${f}" stroke="${s}" stroke-width="0.5"/>`;
    }
    case 'businessRuleTask': {
      // bpmn-js: TASK_TYPE_BUSINESS_RULE_HEADER + _MAIN at abspos(8,8)
      const bx = ox + 8, by = oy + 8;
      const header = `m ${bx},${by} 0,4 20,0 0,-4 z`;
      const main = `m ${bx},${by + 4} 0,12 20,0 0,-12 z m 0,8 l 20,0 m -13,-4 l 0,8`;
      return `<g>`
        + `<path d="${header}" fill="${s}" stroke="${s}" stroke-width="0.5"/>`
        + `<path d="${main}" fill="${f}" stroke="${s}" stroke-width="0.5"/>`
        + `</g>`;
    }
    default: return null;
  }
}

function renderPentagon(cx, cy, r, stroke) {
  const pts = Array.from({length: 5}, (_, i) => {
    const a = (i * 72 - 90) * Math.PI / 180;
    return `${rn(cx + r * Math.cos(a))},${rn(cy + r * Math.sin(a))}`;
  }).join(' ');
  return `<polygon points="${pts}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`;
}

export {
  renderEventMarker, inferEventMarker, renderTaskIcon, renderPentagon,
  renderLoopMarker, renderMIParallelMarker, renderMISequentialMarker,
  renderSubProcessMarker, renderAdHocMarker, renderCompensationMarker,
};

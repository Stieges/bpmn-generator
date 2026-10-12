/*
 * Contains data derived from dmn-js-drd 17.12.3 (lib/draw/PathMap.js, lib/draw/DrdRenderer.js).
 * Copyright (c) 2014-present Camunda Services GmbH. Used under the bpmn.io license (MIT-based);
 * the full text is in THIRD_PARTY_NOTICES.md.
 */

/**
 * DRD shape paths — the path templates of dmn-js-drd 17.12.3 (`lib/draw/PathMap.js`) for the two
 * DRG elements that are not a plain rectangle, the scale and start position `DrdRenderer.js` passes
 * for each (`DRD_GLYPH`), and `getScaledPath`, so dmn/svg.js draws a knowledge source and a business
 * knowledge model with the geometry dmn.io draws them from the same DMNShape bounds.
 *
 * Data, not tuning: colours, stroke widths and fonts are project choices and live in
 * `config.json → dmn.render`. Every path is relative to the element's top-left corner, as in
 * dmn-js; svg.js draws it inside a `translate(x, y)` group.
 */

const DRD_PATH_MAP = {
  KNOWLEDGE_SOURCE: {
    d: 'm {mx},{my} l 0,{e.y0} c {e.x0},{e.y1} {e.x1},-{e.y2} {e.x2},-{e.y3} '
      + 'c {e.x3},-{e.y4} {e.x4},{e.y5} {e.x5},{e.y6} l 0,-{e.y7}z',
    width: 100, height: 65,
    widthElements: [29.8, 48.4, 67.2, 12.2, 19.8, 30.8],
    heightElements: [55.3, 19.7, 4.2, 6.7, 2.3, 1.6, 6.2, 54.6],
  },
  BUSINESS_KNOWLEDGE_MODEL: {
    d: 'm {mx},{my} l {e.x0},-{e.y0} l {e.x1},0 l 0,{e.y1} l -{e.x2},{e.y2} l -{e.x3},0z',
    width: 125, height: 45,
    widthElements: [13.8, 109.2, 13.8, 109.1],
    heightElements: [13.2, 29.8, 13.2],
  },
};

/** The `getScaledPath` parameters DrdRenderer.js's handler passes for each shape. */
export const DRD_GLYPH = {
  knowledgeSource: { path: 'KNOWLEDGE_SOURCE', xScaleFactor: 1.021, yScaleFactor: 1, position: { mx: 0.0, my: 0.075 } },
  businessKnowledgeModel: { path: 'BUSINESS_KNOWLEDGE_MODEL', xScaleFactor: 1, yScaleFactor: 1, position: { mx: 0.0, my: 0.3 } },
};

/** dmn-js's corner radius of an input data shape (`drawRect(…, 22, …)`), and of a decision (0). */
export const DRD_CORNER_RADIUS = { inputData: 22, decision: 0 };

const num = (v) => String(Math.round(v * 1000) / 1000);

/**
 * dmn-js `PathMap#getScaledPath`: fill a template's `{mx}`, `{my}` and `{e.xN}`/`{e.yN}` slots for
 * a container `containerWidth` × `containerHeight`.
 */
export function drdScaledPath(id, { xScaleFactor = 1, yScaleFactor = 1, containerWidth, containerHeight, position }) {
  const raw = DRD_PATH_MAP[id];
  if (!raw) throw new Error(`dmn pathmap: no path "${id}"`);
  const mx = containerWidth * position.mx;
  const my = containerHeight * position.my;
  const hr = (containerHeight / raw.height) * yScaleFactor;
  const wr = (containerWidth / raw.width) * xScaleFactor;
  const e = {};
  raw.heightElements.forEach((v, i) => { e[`y${i}`] = v * hr; });
  raw.widthElements.forEach((v, i) => { e[`x${i}`] = v * wr; });
  return raw.d
    .replace(/\{mx\}/g, num(mx)).replace(/\{my\}/g, num(my))
    .replace(/\{e\.([xy]\d+)\}/g, (_, k) => num(e[k]));
}

export { DRD_PATH_MAP };

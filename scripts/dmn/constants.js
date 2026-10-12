/**
 * DMN-only layout constants.
 * Derived from CFG.dmn (scripts/shared/utils.js) — shape sizes, spacing and edge/marker
 * descriptors used only by the DMN DRD layout and (future) rendering. BPMN never touches
 * these; that is why they live here and not in shared/utils.js, which carries only what
 * both engines use. Mirrors scripts/bpmn/constants.js's own derive-from-CFG shape.
 */

import { CFG } from '../shared/utils.js';

export const DRD_SHAPE   = CFG.dmn.shape;
export const DRD_SPACING = CFG.dmn.spacing;
export const DRD_EDGE    = CFG.dmn.edge;
export const DRD_RENDER  = CFG.dmn.render;
export const DMN_TABLE_STYLE = CFG.dmn.table;

/**
 * The DMN 1.3 single-letter hit policy indicators (OMG DMN 1.3 §8.2.11) and the COLLECT
 * aggregation indicators (`C+` sum, `C#` count, `C<` min, `C>` max). Notation fixed by the
 * standard, so not configurable — the words around them are, in `config.json → dmn.labels`.
 */
export const HIT_POLICY_CODE = Object.freeze({
  UNIQUE: 'U', FIRST: 'F', PRIORITY: 'P', ANY: 'A', COLLECT: 'C', 'RULE ORDER': 'R', 'OUTPUT ORDER': 'O',
});
export const AGGREGATION_CODE = Object.freeze({ SUM: '+', COUNT: '#', MIN: '<', MAX: '>' });
/** Hit policies whose result depends on the rules' order in the table. */
export const ORDER_SENSITIVE_HIT_POLICIES = Object.freeze(new Set(['FIRST', 'RULE ORDER']));

/**
 * Every user-visible word of the DMN text renderers (Markdown, plain text, table SVG), in one table:
 * `config.json → dmn.labels[locale]`. `locale` defaults to `dmn.labels.locale` ("en"); an unknown
 * locale throws rather than silently falling back to another language.
 */
export function dmnLabels(locale = CFG.dmn.labels.locale) {
  const table = locale !== 'locale' ? CFG.dmn.labels[locale] : undefined;
  if (!table || typeof table !== 'object') throw new Error(`config.json dmn.labels has no locale "${locale}"`);
  return table;
}

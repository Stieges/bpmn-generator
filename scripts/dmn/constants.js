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

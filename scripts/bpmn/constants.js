/**
 * BPMN-only layout constants.
 * Derived from CFG (scripts/shared/utils.js) — shapes, colors, spacing used only by
 * the BPMN engine. DMN never touches these; that is why they live here and not in
 * shared/utils.js, which carries only what both engines use.
 */

import { CFG } from '../shared/utils.js';

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
export const COLLAB_PADDING = CFG.layout.collabPadding;
export const MESSAGE_FLOW_FAN = CFG.layout.messageFlowFan;
export const ARTIFACT_GAP = CFG.layout.artifactGap;

/**
 * Shape size of an artifact. Artifacts are kept out of the ELK graph, so two places have to size
 * them: layout.js (the band an expanded subprocess keeps free for them) and coordinates.js (where
 * they are placed). One function, so the reserved band and the placed shapes cannot disagree.
 */
export function artifactSize(type) {
  return SHAPE[type] || SHAPE._textAnnotation || { w: 100, h: 80 };
}

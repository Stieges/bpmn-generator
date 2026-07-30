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

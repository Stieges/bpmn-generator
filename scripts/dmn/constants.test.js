import { describe, test, expect } from '@jest/globals';
import { DRD_SHAPE, DRD_SPACING, DRD_EDGE } from './constants.js';

describe('DMN DRD constants', () => {
  test('DRD_SHAPE carries the four dmn-js default shape sizes', () => {
    // Source: bpmn-io/dmn-js, packages/dmn-js-drd/src/features/modeling/ElementFactory.js —
    // DECISION_SIZE, INPUT_DATA_SIZE, KNOWLEDGE_SOURCE_SIZE, BUSINESS_KNOWLEDGE_MODEL_SIZE.
    expect(DRD_SHAPE.decision).toEqual({ w: 180, h: 80 });
    expect(DRD_SHAPE.inputData).toEqual({ w: 125, h: 45 });
    expect(DRD_SHAPE.knowledgeSource).toEqual({ w: 100, h: 63 });
    expect(DRD_SHAPE.businessKnowledgeModel).toEqual({ w: 135, h: 46 });
  });

  test('DRD_SPACING carries nodeNode, layerNode and margin', () => {
    expect(DRD_SPACING).toEqual({ nodeNode: 40, layerNode: 80, margin: 20 });
  });

  test('DRD_EDGE describes line and marker style for all three requirement types', () => {
    // Source: bpmn-io/dmn-js, packages/dmn-js-drd/src/draw/DrdRenderer.js (createMarker, and the
    // per-type line styles) — information is solid+filled-triangle, knowledge is dashed+open-chevron,
    // authority is dashed+filled-circle. DMN 1.3 §6.2.2 confirms the same three styles in prose.
    expect(Object.keys(DRD_EDGE).sort()).toEqual(['authority', 'information', 'knowledge']);
    expect(DRD_EDGE.information.line.dasharray).toBeNull();
    expect(DRD_EDGE.information.marker.filled).toBe(true);
    expect(DRD_EDGE.knowledge.line.dasharray).toBe('5');
    expect(DRD_EDGE.knowledge.marker.filled).toBe(false);
    expect(DRD_EDGE.authority.line.dasharray).toBe('5');
    expect(DRD_EDGE.authority.marker.shape).toBe('circle');
  });
});

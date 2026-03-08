/**
 * BPMN Generator Pipeline — Unit Tests
 * K0c: Tests for critical functions + golden-file regression tests
 */

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  runPipeline,
  validateLogicCore,
  inferGatewayDirections,
  sortNodesTopologically,
  enforceOrthogonal,
  clipOrthogonal,
  generateBpmnXml,
  generateSvg,
  loadConfig,
} from './pipeline.js';

import { bpmnToLogicCore } from './import.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, '../tests/fixtures');

function loadFixture(name) {
  return JSON.parse(readFileSync(resolve(fixturesDir, name), 'utf8'));
}

// ═══════════════════════════════════════════════════════════════
// §1  loadConfig
// ═══════════════════════════════════════════════════════════════

describe('loadConfig', () => {
  test('loads default config from config.json', () => {
    const cfg = loadConfig();
    expect(cfg.shape).toBeDefined();
    expect(cfg.shape.startEvent).toEqual({ w: 36, h: 36 });
    expect(cfg.shape.task).toEqual({ w: 100, h: 80 });
    expect(cfg.strokeWidth).toBeDefined();
    expect(cfg.color).toBeDefined();
    expect(cfg.layout).toBeDefined();
    expect(cfg.elk).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// §2  validateLogicCore
// ═══════════════════════════════════════════════════════════════

describe('validateLogicCore', () => {
  test('valid single-pool process passes', () => {
    const lc = loadFixture('simple-approval.json');
    const { errors, warnings } = validateLogicCore(lc);
    expect(errors).toHaveLength(0);
  });

  test('valid multi-pool collaboration passes', () => {
    const lc = loadFixture('multi-pool-collaboration.json');
    const { errors, warnings } = validateLogicCore(lc);
    expect(errors).toHaveLength(0);
  });

  test('rejects process without startEvent', () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Test',
        nodes: [
          { id: 'task1', type: 'userTask', name: 'Do something' },
          { id: 'end1', type: 'endEvent', name: 'End' },
        ],
        edges: [{ id: 'f1', source: 'task1', target: 'end1' }],
        lanes: [],
      }],
    };
    const { errors } = validateLogicCore(lc);
    expect(errors.some(e => /startEvent/i.test(e))).toBe(true);
  });

  test('rejects process without endEvent', () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Test',
        nodes: [
          { id: 'start1', type: 'startEvent', name: 'Start' },
          { id: 'task1', type: 'userTask', name: 'Do something' },
        ],
        edges: [{ id: 'f1', source: 'start1', target: 'task1' }],
        lanes: [],
      }],
    };
    const { errors } = validateLogicCore(lc);
    expect(errors.some(e => /endEvent/i.test(e))).toBe(true);
  });

  test('rejects edge with unknown source', () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Test',
        nodes: [
          { id: 'start1', type: 'startEvent', name: 'Start' },
          { id: 'end1', type: 'endEvent', name: 'End' },
        ],
        edges: [{ id: 'f1', source: 'nonexistent', target: 'end1' }],
        lanes: [],
      }],
    };
    const { errors } = validateLogicCore(lc);
    expect(errors.some(e => /unknown source/i.test(e))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// §3  inferGatewayDirections
// ═══════════════════════════════════════════════════════════════

describe('inferGatewayDirections', () => {
  test('sets Diverging for gateway with 1 incoming, 2 outgoing', () => {
    const nodes = [
      { id: 'gw1', type: 'exclusiveGateway', name: 'Check?' },
    ];
    const edges = [
      { id: 'f1', source: 'task1', target: 'gw1' },
      { id: 'f2', source: 'gw1', target: 'taskA' },
      { id: 'f3', source: 'gw1', target: 'taskB' },
    ];
    inferGatewayDirections(nodes, edges);
    expect(nodes[0]._direction).toBe('Diverging');
  });

  test('sets Converging for gateway with 2 incoming, 1 outgoing', () => {
    const nodes = [
      { id: 'gw1', type: 'parallelGateway', name: '', has_join: true },
    ];
    const edges = [
      { id: 'f1', source: 'taskA', target: 'gw1' },
      { id: 'f2', source: 'taskB', target: 'gw1' },
      { id: 'f3', source: 'gw1', target: 'task2' },
    ];
    inferGatewayDirections(nodes, edges);
    expect(nodes[0]._direction).toBe('Converging');
  });

  test('sets Mixed for gateway with 2+ incoming and 2+ outgoing', () => {
    const nodes = [
      { id: 'gw1', type: 'exclusiveGateway', name: '' },
    ];
    const edges = [
      { id: 'f1', source: 'taskA', target: 'gw1' },
      { id: 'f2', source: 'taskB', target: 'gw1' },
      { id: 'f3', source: 'gw1', target: 'taskC' },
      { id: 'f4', source: 'gw1', target: 'taskD' },
    ];
    inferGatewayDirections(nodes, edges);
    expect(nodes[0]._direction).toBe('Mixed');
  });
});

// ═══════════════════════════════════════════════════════════════
// §4  sortNodesTopologically
// ═══════════════════════════════════════════════════════════════

describe('sortNodesTopologically', () => {
  test('sorts nodes in flow order', () => {
    const proc = {
      nodes: [
        { id: 'end1', type: 'endEvent', name: 'End' },
        { id: 'task1', type: 'userTask', name: 'Task' },
        { id: 'start1', type: 'startEvent', name: 'Start' },
      ],
      edges: [
        { id: 'f1', source: 'start1', target: 'task1' },
        { id: 'f2', source: 'task1', target: 'end1' },
      ],
    };
    sortNodesTopologically(proc);
    expect(proc.nodes[0].id).toBe('start1');
    expect(proc.nodes[1].id).toBe('task1');
    expect(proc.nodes[2].id).toBe('end1');
  });
});

// ═══════════════════════════════════════════════════════════════
// §5  enforceOrthogonal
// ═══════════════════════════════════════════════════════════════

describe('enforceOrthogonal', () => {
  test('returns unchanged for already-orthogonal path', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }];
    const result = enforceOrthogonal(pts);
    expect(result).toHaveLength(3);
    // All segments should be axis-aligned
    for (let i = 1; i < result.length; i++) {
      const dx = Math.abs(result[i].x - result[i - 1].x);
      const dy = Math.abs(result[i].y - result[i - 1].y);
      expect(dx < 1 || dy < 1).toBe(true);
    }
  });

  test('inserts bend point for diagonal segment', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 80 }];
    const result = enforceOrthogonal(pts);
    expect(result.length).toBeGreaterThan(2);
    // All segments should now be orthogonal
    for (let i = 1; i < result.length; i++) {
      const dx = Math.abs(result[i].x - result[i - 1].x);
      const dy = Math.abs(result[i].y - result[i - 1].y);
      expect(dx < 1 || dy < 1).toBe(true);
    }
  });

  test('handles single point', () => {
    const pts = [{ x: 50, y: 50 }];
    expect(enforceOrthogonal(pts)).toHaveLength(1);
  });

  test('handles empty array', () => {
    expect(enforceOrthogonal([])).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// §6  clipOrthogonal
// ═══════════════════════════════════════════════════════════════

describe('clipOrthogonal', () => {
  test('clips to circle boundary for event', () => {
    const shape = { x: 0, y: 0, w: 36, h: 36 };
    const edgePt = { x: 18, y: 18 };
    const nextPt = { x: 100, y: 18 };
    const clipped = clipOrthogonal(shape, 'startEvent', edgePt, nextPt, 'source');
    // Should be on right edge of circle (x ≈ 36, y = 18)
    expect(clipped.x).toBeCloseTo(36, 0);
    expect(clipped.y).toBeCloseTo(18, 0);
  });

  test('clips to diamond boundary for gateway', () => {
    const shape = { x: 0, y: 0, w: 50, h: 50 };
    const edgePt = { x: 25, y: 25 };
    const nextPt = { x: 100, y: 25 };
    const clipped = clipOrthogonal(shape, 'exclusiveGateway', edgePt, nextPt, 'source');
    // Should be on right tip of diamond (x = 50, y = 25)
    expect(clipped.x).toBeCloseTo(50, 0);
    expect(clipped.y).toBeCloseTo(25, 0);
  });

  test('clips to rectangle boundary for task', () => {
    const shape = { x: 0, y: 0, w: 100, h: 80 };
    const edgePt = { x: 50, y: 40 };
    const nextPt = { x: 200, y: 40 };
    const clipped = clipOrthogonal(shape, 'userTask', edgePt, nextPt, 'source');
    // Should be on right edge (x = 100)
    expect(clipped.x).toBeCloseTo(100, 0);
    expect(clipped.y).toBeCloseTo(40, 0);
  });
});

// ═══════════════════════════════════════════════════════════════
// §7  Full Pipeline — Golden File Tests
// ═══════════════════════════════════════════════════════════════

describe('runPipeline', () => {
  test('generates valid BPMN XML for simple approval process', async () => {
    const lc = loadFixture('simple-approval.json');
    const result = await runPipeline(lc);

    expect(result.validation.errors).toHaveLength(0);
    expect(result.bpmnXml).toBeTruthy();
    expect(result.svg).toBeTruthy();

    // Check BPMN XML structure
    expect(result.bpmnXml).toContain('<definitions');
    expect(result.bpmnXml).toContain('xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"');
    expect(result.bpmnXml).toContain('xmlns:bpmndi=');
    expect(result.bpmnXml).toContain('<process');
    expect(result.bpmnXml).toContain('<laneSet');
    expect(result.bpmnXml).toContain('<userTask');
    expect(result.bpmnXml).toContain('<serviceTask');
    expect(result.bpmnXml).toContain('<exclusiveGateway');
    expect(result.bpmnXml).toContain('gatewayDirection=');
    expect(result.bpmnXml).toContain('<bpmndi:BPMNDiagram');
    expect(result.bpmnXml).toContain('<bpmndi:BPMNShape');
    expect(result.bpmnXml).toContain('<bpmndi:BPMNEdge');
    expect(result.bpmnXml).toContain('<dc:Bounds');
    expect(result.bpmnXml).toContain('<di:waypoint');
  });

  test('generates valid BPMN XML for multi-pool collaboration', async () => {
    const lc = loadFixture('multi-pool-collaboration.json');
    const result = await runPipeline(lc);

    expect(result.validation.errors).toHaveLength(0);
    expect(result.bpmnXml).toBeTruthy();

    // Collaboration-specific checks
    expect(result.bpmnXml).toContain('<collaboration');
    expect(result.bpmnXml).toContain('<participant');
    expect(result.bpmnXml).toContain('<messageFlow');
    // Should have 2 processes
    const processMatches = result.bpmnXml.match(/<process /g);
    expect(processMatches.length).toBe(2);
  });

  test('returns errors for invalid input', async () => {
    const lc = { pools: [{ id: 'P1', name: 'Empty', nodes: [], edges: [], lanes: [] }] };
    const result = await runPipeline(lc);
    expect(result.validation.errors.length).toBeGreaterThan(0);
    expect(result.bpmnXml).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// §8  Round-Trip — JSON → BPMN → JSON
// ═══════════════════════════════════════════════════════════════

describe('Round-trip (JSON → BPMN → JSON)', () => {
  test('simple approval: reimport preserves node count', async () => {
    const original = loadFixture('simple-approval.json');
    const result = await runPipeline(original);
    expect(result.bpmnXml).toBeTruthy();

    const reimported = bpmnToLogicCore(result.bpmnXml);
    const origNodes = original.pools[0].nodes;
    const reimNodes = reimported.nodes || (reimported.pools && reimported.pools[0].nodes) || [];

    expect(reimNodes.length).toBe(origNodes.length);
  });

  test('multi-pool: reimport preserves pool count', async () => {
    const original = loadFixture('multi-pool-collaboration.json');
    const result = await runPipeline(original);
    expect(result.bpmnXml).toBeTruthy();

    const reimported = bpmnToLogicCore(result.bpmnXml);
    expect(reimported.pools.length).toBe(original.pools.length);
  });
});

// ═══════════════════════════════════════════════════════════════
// §9  SVG Output Checks
// ═══════════════════════════════════════════════════════════════

describe('SVG output', () => {
  test('contains valid SVG structure', async () => {
    const lc = loadFixture('simple-approval.json');
    const result = await runPipeline(lc);

    expect(result.svg).toContain('<svg');
    expect(result.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(result.svg).toContain('</svg>');
    // Should contain shapes for all nodes
    expect(result.svg).toContain('<rect');    // tasks
    expect(result.svg).toContain('<circle');  // events
    expect(result.svg).toContain('<polygon'); // gateways
  });
});

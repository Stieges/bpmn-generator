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
  validateBpmnXml,
  generateSvg,
  loadConfig,
  generateDiagramSet,
  collapseSubProcesses,
  extractSubProcessAsLogicCore,
} from './pipeline.js';
import { normalizeLaneAssignments } from './topology.js';

import { bpmnToLogicCore, bpmnToLogicCoreLegacy } from './import.js';
import { moddleParse, moddleToLogicCore } from './moddle-import.js';
import { checkWorkflowNetSoundness, bpmnToPN } from './workflow-net.js';
import { runRules, RULES, loadRuleProfile } from './rules.js';
import { logicCoreToDot, dotToLogicCore } from './dot.js';
import { parseBody, validateCallbackUrl } from './http-server.js';

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

    // Check BPMN XML structure (supports both default and prefixed namespaces)
    expect(result.bpmnXml).toMatch(/definitions/);
    expect(result.bpmnXml).toContain('http://www.omg.org/spec/BPMN/20100524/MODEL');
    expect(result.bpmnXml).toContain('xmlns:bpmndi=');
    expect(result.bpmnXml).toMatch(/<(bpmn:)?process/);
    expect(result.bpmnXml).toMatch(/<(bpmn:)?laneSet/);
    expect(result.bpmnXml).toMatch(/<(bpmn:)?userTask/);
    expect(result.bpmnXml).toMatch(/<(bpmn:)?serviceTask/);
    expect(result.bpmnXml).toMatch(/<(bpmn:)?exclusiveGateway/);
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
    expect(result.bpmnXml).toMatch(/<(bpmn:)?collaboration/);
    expect(result.bpmnXml).toMatch(/<(bpmn:)?participant/);
    expect(result.bpmnXml).toMatch(/<(bpmn:)?messageFlow/);
    // Should have 2 processes
    const processMatches = result.bpmnXml.match(/<(bpmn:)?process /g);
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

    const reimported = await bpmnToLogicCore(result.bpmnXml);
    const origNodes = original.pools[0].nodes;
    const reimNodes = reimported.nodes || (reimported.pools && reimported.pools[0].nodes) || [];

    expect(reimNodes.length).toBe(origNodes.length);
  });

  test('multi-pool: reimport preserves pool count', async () => {
    const original = loadFixture('multi-pool-collaboration.json');
    const result = await runPipeline(original);
    expect(result.bpmnXml).toBeTruthy();

    const reimported = await bpmnToLogicCore(result.bpmnXml);
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

// ═══════════════════════════════════════════════════════════════
// §10  Extended Validation (K4)
// ═══════════════════════════════════════════════════════════════

describe('Extended Validation (K4)', () => {
  test('detects inclusive-GW → AND-join deadlock', () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Test',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start' },
          { id: 'igw', type: 'inclusiveGateway', name: 'Split?' },
          { id: 'a', type: 'userTask', name: 'A' },
          { id: 'b', type: 'userTask', name: 'B' },
          { id: 'pgw', type: 'parallelGateway', name: 'Join', has_join: true },
          { id: 'e', type: 'endEvent', name: 'End' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 'igw' },
          { id: 'f2', source: 'igw', target: 'a', label: 'Ja' },
          { id: 'f3', source: 'igw', target: 'b', label: 'Nein' },
          { id: 'f4', source: 'a', target: 'pgw' },
          { id: 'f5', source: 'b', target: 'pgw' },
          { id: 'f6', source: 'pgw', target: 'e' },
        ],
        lanes: [],
      }],
    };
    const { errors } = validateLogicCore(lc);
    expect(errors.some(e => /Inclusive-split.*AND-join/i.test(e))).toBe(true);
  });

  test('warns boundary event path without endEvent', () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Test',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start' },
          { id: 't', type: 'userTask', name: 'Task' },
          { id: 'be', type: 'boundaryEvent', name: 'Timer', attachedTo: 't', marker: 'timer' },
          { id: 'dead', type: 'userTask', name: 'Dangling' },
          { id: 'e', type: 'endEvent', name: 'End' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 't' },
          { id: 'f2', source: 't', target: 'e' },
          { id: 'f3', source: 'be', target: 'dead' },
          // dead has no outgoing → path does not reach endEvent
        ],
        lanes: [],
      }],
    };
    const { warnings } = validateLogicCore(lc);
    expect(warnings.some(w => /boundary.*endEvent/i.test(w))).toBe(true);
  });

  test('warns converging gateway with labeled outgoing edge', () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Test',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start' },
          { id: 'a', type: 'userTask', name: 'A' },
          { id: 'b', type: 'userTask', name: 'B' },
          { id: 'gw', type: 'exclusiveGateway', name: 'Merge', has_join: true },
          { id: 't', type: 'userTask', name: 'Task' },
          { id: 'e', type: 'endEvent', name: 'End' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 'a' },
          { id: 'f2', source: 'a', target: 'gw' },
          { id: 'f3', source: 'b', target: 'gw' },
          { id: 'f4', source: 'gw', target: 't', label: 'Falsches Label' },
          { id: 'f5', source: 't', target: 'e' },
        ],
        lanes: [],
      }],
    };
    const { warnings } = validateLogicCore(lc);
    expect(warnings.some(w => /Converging.*labeled/i.test(w))).toBe(true);
  });

  test('detects message flow within same pool', () => {
    const lc = {
      pools: [
        {
          id: 'P1', name: 'Pool 1',
          nodes: [
            { id: 's1', type: 'startEvent', name: 'Start' },
            { id: 't1', type: 'userTask', name: 'Task' },
            { id: 'e1', type: 'endEvent', name: 'End' },
          ],
          edges: [
            { id: 'f1', source: 's1', target: 't1' },
            { id: 'f2', source: 't1', target: 'e1' },
          ],
          lanes: [],
        },
      ],
      messageFlows: [
        { id: 'mf1', source: 's1', target: 't1' },
      ],
    };
    const { errors } = validateLogicCore(lc);
    expect(errors.some(e => /within pool/i.test(e))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// §11  Expanded Sub-Processes (K3)
// ═══════════════════════════════════════════════════════════════

describe('Expanded Sub-Processes', () => {
  test('generates valid BPMN XML with nested flow elements', async () => {
    const lc = loadFixture('expanded-subprocess.json');
    const result = await runPipeline(lc);

    expect(result.validation.errors).toHaveLength(0);
    expect(result.bpmnXml).toBeTruthy();

    // SubProcess element contains child flow elements
    expect(result.bpmnXml).toMatch(/<(bpmn:)?subProcess/);
    expect(result.bpmnXml).toContain('sub1_start');
    expect(result.bpmnXml).toContain('sub1_task1');
    expect(result.bpmnXml).toContain('sub1_end');
    // Child sequence flows inside subprocess
    expect(result.bpmnXml).toContain('sub1_f1');
    expect(result.bpmnXml).toContain('sub1_f2');
    expect(result.bpmnXml).toContain('sub1_f3');
    // BPMNDI: isExpanded attribute
    expect(result.bpmnXml).toContain('isExpanded="true"');
    // BPMNDI: child shapes exist
    expect(result.bpmnXml).toContain('sub1_start_di');
    expect(result.bpmnXml).toContain('sub1_task1_di');
    expect(result.bpmnXml).toContain('sub1_end_di');
    // BPMNDI: child edge waypoints
    expect(result.bpmnXml).toContain('sub1_f1_di');
  });

  test('validates subprocess children (missing endEvent)', async () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Test',
        nodes: [
          { id: 'start1', type: 'startEvent', name: 'Start' },
          {
            id: 'sub1', type: 'subProcess', name: 'Sub', isExpanded: true,
            nodes: [
              { id: 'sub_s', type: 'startEvent', name: 'SubStart' },
              { id: 'sub_t', type: 'userTask', name: 'SubTask' },
            ],
            edges: [{ id: 'sf1', source: 'sub_s', target: 'sub_t' }],
          },
          { id: 'end1', type: 'endEvent', name: 'End' },
        ],
        edges: [
          { id: 'f1', source: 'start1', target: 'sub1' },
          { id: 'f2', source: 'sub1', target: 'end1' },
        ],
        lanes: [],
      }],
    };
    const result = await runPipeline(lc);
    expect(result.validation.errors.some(e => /SubProcess.*endEvent/i.test(e))).toBe(true);
  });

  test('round-trip preserves subprocess structure', async () => {
    const original = loadFixture('expanded-subprocess.json');
    const result = await runPipeline(original);
    expect(result.bpmnXml).toBeTruthy();

    const reimported = await bpmnToLogicCore(result.bpmnXml);
    // May return { pools: [...] } or flat { nodes, edges } depending on collaboration
    const nodes = reimported.pools ? reimported.pools[0].nodes : reimported.nodes;
    // Find the expanded subprocess node
    const sub = nodes.find(n => n.type === 'subProcess' && n.isExpanded);
    expect(sub).toBeDefined();
    expect(sub.nodes.length).toBe(4); // start, task1, task2, end
    expect(sub.edges.length).toBe(3);
  });
});

// ═══════════════════════════════════════════════════════════════
// §9  Drill-Down (M4)
// ═══════════════════════════════════════════════════════════════

describe('collapseSubProcesses', () => {
  test('collapses expanded subprocesses', () => {
    const lc = loadFixture('expanded-subprocess.json');
    const collapsed = collapseSubProcesses(lc);
    const sub = collapsed.pools[0].nodes.find(n => n.id === 'sub1');
    expect(sub.isExpanded).toBe(false);
    expect(sub.nodes).toBeUndefined();
    expect(sub.edges).toBeUndefined();
  });

  test('preserves non-subprocess nodes unchanged', () => {
    const lc = loadFixture('expanded-subprocess.json');
    const collapsed = collapseSubProcesses(lc);
    const task = collapsed.pools[0].nodes.find(n => n.id === 'task1');
    expect(task.name).toBe('Vorprüfung');
  });

  test('does not mutate original', () => {
    const lc = loadFixture('expanded-subprocess.json');
    collapseSubProcesses(lc);
    const sub = lc.pools[0].nodes.find(n => n.id === 'sub1');
    expect(sub.isExpanded).toBe(true);
    expect(sub.nodes.length).toBe(4);
  });
});

describe('extractSubProcessAsLogicCore', () => {
  test('extracts subprocess as standalone Logic-Core', () => {
    const lc = loadFixture('expanded-subprocess.json');
    const subLc = extractSubProcessAsLogicCore(lc, 'sub1');
    expect(subLc).toBeDefined();
    expect(subLc.pools).toHaveLength(1);
    expect(subLc.pools[0].nodes).toHaveLength(4);
    expect(subLc.pools[0].edges).toHaveLength(3);
    expect(subLc.pools[0].name).toBe('Detailprüfung');
  });

  test('returns null for non-existent subprocess', () => {
    const lc = loadFixture('expanded-subprocess.json');
    expect(extractSubProcessAsLogicCore(lc, 'nonexistent')).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §9b  normalizeLaneAssignments (Format B → Format A)
// ═══════════════════════════════════════════════════════════════════════

describe('normalizeLaneAssignments', () => {
  test('sets node.lane from lane.nodeIds (Format B → A)', () => {
    const proc = {
      lanes: [{ id: 'L1', name: 'Lane 1', nodeIds: ['n1', 'n2'] }],
      nodes: [{ id: 'n1', type: 'task' }, { id: 'n2', type: 'task' }],
    };
    normalizeLaneAssignments(proc);
    expect(proc.nodes[0].lane).toBe('L1');
    expect(proc.nodes[1].lane).toBe('L1');
  });

  test('does not overwrite existing node.lane (Format A has priority)', () => {
    const proc = {
      lanes: [
        { id: 'L1', name: 'Lane 1', nodeIds: ['n1'] },
        { id: 'L2', name: 'Lane 2', nodeIds: [] },
      ],
      nodes: [{ id: 'n1', type: 'task', lane: 'L2' }],
    };
    normalizeLaneAssignments(proc);
    expect(proc.nodes[0].lane).toBe('L2');
  });

  test('leaves nodes without lane assignment unchanged', () => {
    const proc = {
      lanes: [{ id: 'L1', name: 'Lane 1', nodeIds: ['n1'] }],
      nodes: [{ id: 'n1', type: 'task' }, { id: 'n2', type: 'task' }],
    };
    normalizeLaneAssignments(proc);
    expect(proc.nodes[0].lane).toBe('L1');
    expect(proc.nodes[1].lane).toBeUndefined();
  });

  test('handles lanes without nodeIds gracefully', () => {
    const proc = {
      lanes: [{ id: 'L1', name: 'Lane 1' }],
      nodes: [{ id: 'n1', type: 'task' }],
    };
    normalizeLaneAssignments(proc);
    expect(proc.nodes[0].lane).toBeUndefined();
  });

  test('no-op when no lanes', () => {
    const proc = { nodes: [{ id: 'n1', type: 'task' }] };
    normalizeLaneAssignments(proc);
    expect(proc.nodes[0].lane).toBeUndefined();
  });
});

describe('extractSubProcessAsLogicCore — Format A', () => {
  test('sets node.lane on extracted subprocess nodes', () => {
    const lc = loadFixture('expanded-subprocess.json');
    const subLc = extractSubProcessAsLogicCore(lc, 'sub1');
    const lane = subLc.pools[0].lanes[0];
    for (const node of subLc.pools[0].nodes) {
      expect(node.lane).toBe(lane.id);
    }
  });
});

describe('generateDiagramSet', () => {
  test('generates parent + subprocess diagrams', async () => {
    const lc = loadFixture('expanded-subprocess.json');
    const set = await generateDiagramSet(lc);

    // Parent diagram exists
    expect(set.parent.bpmnXml).toBeDefined();
    expect(set.parent.svg).toContain('<svg');

    // SubProcess diagram exists
    expect(set.subProcesses).toHaveProperty('sub1');
    expect(set.subProcesses.sub1.bpmnXml).toBeDefined();
    expect(set.subProcesses.sub1.svg).toContain('<svg');

    // Navigation
    expect(set.navigation.subProcesses).toHaveLength(1);
    expect(set.navigation.subProcesses[0].id).toBe('sub1');
    expect(set.navigation.subProcesses[0].name).toBe('Detailprüfung');
    expect(set.navigation.subProcesses[0].nodeCount).toBe(4);
  });

  test('no subprocesses → empty subProcesses map', async () => {
    const lc = loadFixture('simple-approval.json');
    const set = await generateDiagramSet(lc);

    expect(set.parent.bpmnXml).toBeDefined();
    expect(Object.keys(set.subProcesses)).toHaveLength(0);
    expect(set.navigation.subProcesses).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// §10  Workflow-Net Soundness (L2)
// ═══════════════════════════════════════════════════════════════════════

describe('Workflow-Net Soundness', () => {
  test('sound process → no WF errors', () => {
    const lc = loadFixture('simple-approval.json');
    const result = checkWorkflowNetSoundness(lc);
    const wfErrors = result.issues.filter(i => i.severity === 'ERROR');
    expect(wfErrors).toHaveLength(0);
    expect(result.stats).toBeDefined();
  });

  test('deadlock process → WF03 error', () => {
    const lc = loadFixture('deadlock-process.json');
    const result = checkWorkflowNetSoundness(lc);
    const deadlocks = result.issues.filter(i => i.rule === 'WF03' && i.severity === 'ERROR');
    expect(deadlocks.length).toBeGreaterThan(0);
    expect(deadlocks[0].message).toContain('Deadlock');
  });

  test('multi-pool process → per-pool analysis', () => {
    const lc = loadFixture('multi-pool-collaboration.json');
    const result = checkWorkflowNetSoundness(lc);
    // Should have stats for each pool
    const poolCount = lc.pools.length;
    expect(Object.keys(result.stats)).toHaveLength(poolCount);
  });

  test('bpmnToPN creates places for edges', () => {
    const proc = {
      nodes: [
        { id: 's', type: 'startEvent' },
        { id: 't', type: 'task', name: 'Do' },
        { id: 'e', type: 'endEvent' },
      ],
      edges: [
        { id: 'f1', source: 's', target: 't' },
        { id: 'f2', source: 't', target: 'e' },
      ],
    };
    const pn = bpmnToPN(proc);
    // 2 edge places + source + sink = 4
    expect(pn.places.size).toBe(4);
    expect(pn.transitions.size).toBe(3);
    expect(pn.initialMarking.get('p_source')).toBe(1);
  });

  test('XOR split creates choice transitions', () => {
    const proc = {
      nodes: [
        { id: 's', type: 'startEvent' },
        { id: 'xor', type: 'exclusiveGateway', name: 'Pick?' },
        { id: 'a', type: 'task', name: 'A' },
        { id: 'b', type: 'task', name: 'B' },
        { id: 'e', type: 'endEvent' },
      ],
      edges: [
        { id: 'f1', source: 's', target: 'xor' },
        { id: 'f2', source: 'xor', target: 'a', label: 'A' },
        { id: 'f3', source: 'xor', target: 'b', label: 'B' },
        { id: 'f4', source: 'a', target: 'e' },
        { id: 'f5', source: 'b', target: 'e' },
      ],
    };
    const pn = bpmnToPN(proc);
    // XOR with 2 outgoing → 2 choice transitions
    const choiceTs = [...pn.transitions.keys()].filter(k => k.includes('choice'));
    expect(choiceTs).toHaveLength(2);
  });

  test('runRules with strict profile includes WF checks', () => {
    const lc = loadFixture('simple-approval.json');
    const profile = loadRuleProfile(resolve(fixturesDir, '../../rules/strict-profile.json'));
    const result = runRules(lc, profile);
    // Sound process should have workflowNet stats in metrics
    expect(result.metrics.workflowNet).toBeDefined();
  });

  test('runRules without workflow_net layer skips WF checks', () => {
    const lc = loadFixture('simple-approval.json');
    const result = runRules(lc); // default profile (no WF layer)
    expect(result.metrics.workflowNet).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// §12  OMG BPMN 2.0.2 Compliance — Semantic & Structural Gaps
// ═══════════════════════════════════════════════════════════════

describe('OMG Compliance — Execution Attributes', () => {
  test('timer expression round-trip (duration)', async () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Timer Test',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start', marker: 'timer', timerExpression: { type: 'duration', value: 'PT5D' } },
          { id: 't', type: 'userTask', name: 'Do Work' },
          { id: 'e', type: 'endEvent', name: 'End' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 't' },
          { id: 'f2', source: 't', target: 'e' },
        ],
        lanes: [],
      }],
    };
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toMatch(/<(bpmn:)?timeDuration/);
    expect(result.bpmnXml).toContain('PT5D');

    const reimported = await bpmnToLogicCore(result.bpmnXml);
    const nodes = reimported.pools ? reimported.pools[0].nodes : reimported.nodes;
    const timer = nodes.find(n => n.marker === 'timer');
    expect(timer.timerExpression).toEqual({ type: 'duration', value: 'PT5D' });
  });

  test('script task round-trip', async () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Script Test',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start' },
          { id: 'sc', type: 'scriptTask', name: 'Run Script', scriptFormat: 'groovy', script: 'println "hello"' },
          { id: 'e', type: 'endEvent', name: 'End' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 'sc' },
          { id: 'f2', source: 'sc', target: 'e' },
        ],
        lanes: [],
      }],
    };
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toContain('scriptFormat="groovy"');
    expect(result.bpmnXml).toMatch(/<(bpmn:)?script>/);
    expect(result.bpmnXml).toMatch(/println.*hello/);

    const reimported = await bpmnToLogicCore(result.bpmnXml);
    const nodes = reimported.pools ? reimported.pools[0].nodes : reimported.nodes;
    const sc = nodes.find(n => n.type === 'scriptTask');
    expect(sc.scriptFormat).toBe('groovy');
    expect(sc.script).toContain('println');
  });

  test('callActivity calledElement round-trip', async () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'CallActivity Test',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start' },
          { id: 'ca', type: 'callActivity', name: 'Call Sub', calledElement: 'SubProcess_123' },
          { id: 'e', type: 'endEvent', name: 'End' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 'ca' },
          { id: 'f2', source: 'ca', target: 'e' },
        ],
        lanes: [],
      }],
    };
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toContain('calledElement="SubProcess_123"');

    const reimported = await bpmnToLogicCore(result.bpmnXml);
    const nodes = reimported.pools ? reimported.pools[0].nodes : reimported.nodes;
    const ca = nodes.find(n => n.type === 'callActivity');
    expect(ca.calledElement).toBe('SubProcess_123');
  });

  test('conditional event condition round-trip', async () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Conditional Test',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start', marker: 'conditional', conditionExpression: '${amount > 1000}' },
          { id: 't', type: 'userTask', name: 'Handle' },
          { id: 'e', type: 'endEvent', name: 'End' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 't' },
          { id: 'f2', source: 't', target: 'e' },
        ],
        lanes: [],
      }],
    };
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toContain('conditionalEventDefinition');
    expect(result.bpmnXml).toMatch(/<(bpmn:)?condition/);

    const reimported = await bpmnToLogicCore(result.bpmnXml);
    const nodes = reimported.pools ? reimported.pools[0].nodes : reimported.nodes;
    const cond = nodes.find(n => n.marker === 'conditional');
    expect(cond.conditionExpression).toContain('amount');
  });

  test('link event name round-trip', async () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Link Test',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start' },
          { id: 'lt', type: 'intermediateThrowEvent', name: 'Go To B', marker: 'link', linkName: 'LinkToB' },
          { id: 'lc', type: 'intermediateCatchEvent', name: 'From A', marker: 'link', linkName: 'LinkToB' },
          { id: 'e', type: 'endEvent', name: 'End' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 'lt' },
          { id: 'f2', source: 'lc', target: 'e' },
        ],
        lanes: [],
      }],
    };
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toContain('linkEventDefinition');
    expect(result.bpmnXml).toContain('name="LinkToB"');

    const reimported = await bpmnToLogicCore(result.bpmnXml);
    const nodes = reimported.pools ? reimported.pools[0].nodes : reimported.nodes;
    const link = nodes.find(n => n.linkName === 'LinkToB');
    expect(link).toBeDefined();
  });

  test('multi-instance with loopCardinality round-trip', async () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'MI Test',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start' },
          { id: 't', type: 'userTask', name: 'Review', multiInstance: { type: 'parallel', loopCardinality: '5', completionCondition: '${nrOfCompleted >= 3}' } },
          { id: 'e', type: 'endEvent', name: 'End' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 't' },
          { id: 'f2', source: 't', target: 'e' },
        ],
        lanes: [],
      }],
    };
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toContain('multiInstanceLoopCharacteristics');
    expect(result.bpmnXml).toMatch(/<(bpmn:)?loopCardinality/);
    expect(result.bpmnXml).toMatch(/<(bpmn:)?completionCondition/);

    const reimported = await bpmnToLogicCore(result.bpmnXml);
    const nodes = reimported.pools ? reimported.pools[0].nodes : reimported.nodes;
    const mi = nodes.find(n => n.multiInstance);
    expect(mi.multiInstance.type).toBe('parallel');
    expect(mi.multiInstance.loopCardinality).toBe('5');
    expect(mi.multiInstance.completionCondition).toContain('nrOfCompleted');
  });

  test('simple multiInstance string still works (backward compat)', async () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'MI Simple',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start' },
          { id: 't', type: 'userTask', name: 'Review', multiInstance: 'sequential' },
          { id: 'e', type: 'endEvent', name: 'End' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 't' },
          { id: 'f2', source: 't', target: 'e' },
        ],
        lanes: [],
      }],
    };
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toContain('multiInstanceLoopCharacteristics');
    expect(result.bpmnXml).toContain('isSequential="true"');
  });

  test('loop with loopCondition round-trip', async () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Loop Test',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start' },
          { id: 't', type: 'userTask', name: 'Retry', loopType: { loopCondition: '${retry < 3}', testBefore: true, loopMaximum: 10 } },
          { id: 'e', type: 'endEvent', name: 'End' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 't' },
          { id: 'f2', source: 't', target: 'e' },
        ],
        lanes: [],
      }],
    };
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toContain('standardLoopCharacteristics');
    expect(result.bpmnXml).toContain('testBefore="true"');
    expect(result.bpmnXml).toContain('loopMaximum="10"');
    expect(result.bpmnXml).toMatch(/<(bpmn:)?loopCondition/);

    const reimported = await bpmnToLogicCore(result.bpmnXml);
    const nodes = reimported.pools ? reimported.pools[0].nodes : reimported.nodes;
    const loop = nodes.find(n => n.loopType);
    // Note: < gets XML-escaped to &lt; during round-trip
    expect(loop.loopType.testBefore).toBe(true);
    expect(loop.loopType.loopMaximum).toBe(10);
    expect(loop.loopType.loopCondition).toContain('retry');
    expect(loop.loopType.loopCondition).toContain('3');
  });

  test('top-level definitions round-trip', async () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Defs Test',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start' },
          { id: 't', type: 'userTask', name: 'Process' },
          { id: 'ee', type: 'endEvent', name: 'Error End', marker: 'error' },
          { id: 'e', type: 'endEvent', name: 'End' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 't' },
          { id: 'f2', source: 't', target: 'ee' },
          { id: 'f3', source: 't', target: 'e' },
        ],
        lanes: [],
      }],
      definitions: [
        { type: 'error', id: 'Err_1', name: 'Payment Failed', errorCode: 'ERR_PAY_001' },
        { type: 'message', id: 'Msg_1', name: 'Order Request' },
      ],
    };
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toContain('errorCode="ERR_PAY_001"');
    expect(result.bpmnXml).toMatch(/<(bpmn:)?message id="Msg_1"/);

    const reimported = await bpmnToLogicCore(result.bpmnXml);
    expect(reimported.definitions).toBeDefined();
    const errDef = reimported.definitions.find(d => d.type === 'error');
    expect(errDef.errorCode).toBe('ERR_PAY_001');
    const msgDef = reimported.definitions.find(d => d.type === 'message');
    expect(msgDef.name).toBe('Order Request');
  });

  test('isForCompensation emitted on task', async () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Compensation Test',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start' },
          { id: 't', type: 'serviceTask', name: 'Compensate', isCompensation: true },
          { id: 'e', type: 'endEvent', name: 'End' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 't' },
          { id: 'f2', source: 't', target: 'e' },
        ],
        lanes: [],
      }],
    };
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toContain('isForCompensation="true"');
  });

  test('implementation attribute on serviceTask', async () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Impl Test',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start' },
          { id: 't', type: 'serviceTask', name: 'Call WS', implementation: 'WebService' },
          { id: 'e', type: 'endEvent', name: 'End' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 't' },
          { id: 'f2', source: 't', target: 'e' },
        ],
        lanes: [],
      }],
    };
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toContain('implementation="WebService"');

    const reimported = await bpmnToLogicCore(result.bpmnXml);
    const nodes = reimported.pools ? reimported.pools[0].nodes : reimported.nodes;
    const svc = nodes.find(n => n.type === 'serviceTask');
    expect(svc.implementation).toBe('WebService');
  });

  test('eventBasedGateway attributes round-trip', async () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'EBG Test',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start' },
          { id: 'ebg', type: 'eventBasedGateway', name: 'Wait', eventGatewayType: 'Parallel', instantiate: true },
          { id: 'tc', type: 'intermediateCatchEvent', name: 'Timer', marker: 'timer' },
          { id: 'mc', type: 'intermediateCatchEvent', name: 'Message', marker: 'message' },
          { id: 'e1', type: 'endEvent', name: 'End1' },
          { id: 'e2', type: 'endEvent', name: 'End2' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 'ebg' },
          { id: 'f2', source: 'ebg', target: 'tc' },
          { id: 'f3', source: 'ebg', target: 'mc' },
          { id: 'f4', source: 'tc', target: 'e1' },
          { id: 'f5', source: 'mc', target: 'e2' },
        ],
        lanes: [],
      }],
    };
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toContain('eventGatewayType="Parallel"');
    expect(result.bpmnXml).toContain('instantiate="true"');

    const reimported = await bpmnToLogicCore(result.bpmnXml);
    const nodes = reimported.pools ? reimported.pools[0].nodes : reimported.nodes;
    const ebg = nodes.find(n => n.type === 'eventBasedGateway');
    expect(ebg.eventGatewayType).toBe('Parallel');
    expect(ebg.instantiate).toBe(true);
  });

  test('nested lanes round-trip', async () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Nested Lane Test',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start', lane: 'L1_1' },
          { id: 't', type: 'userTask', name: 'Task', lane: 'L1_2' },
          { id: 'e', type: 'endEvent', name: 'End', lane: 'L1_2' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 't' },
          { id: 'f2', source: 't', target: 'e' },
        ],
        lanes: [
          {
            id: 'L1', name: 'Parent Lane',
            children: [
              { id: 'L1_1', name: 'Child Lane A' },
              { id: 'L1_2', name: 'Child Lane B' },
            ],
          },
        ],
      }],
    };
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toContain('childLaneSet');
    expect(result.bpmnXml).toContain('Child Lane A');
    expect(result.bpmnXml).toContain('Child Lane B');

    const reimported = await bpmnToLogicCore(result.bpmnXml);
    const lanes = reimported.pools ? reimported.pools[0].lanes : reimported.lanes;
    const parent = lanes.find(l => l.id === 'L1');
    expect(parent).toBeDefined();
    expect(parent.children).toHaveLength(2);
    expect(parent.children[0].name).toBe('Child Lane A');
  });

  test('triggeredByEvent on event subProcess', async () => {
    const lc = {
      pools: [{
        id: 'P1', name: 'Event SubProcess Test',
        nodes: [
          { id: 's', type: 'startEvent', name: 'Start' },
          { id: 'esp', type: 'subProcess', name: 'Error Handler', isExpanded: true, isEventSubProcess: true,
            nodes: [
              { id: 'es', type: 'startEvent', name: 'Error Start', marker: 'error' },
              { id: 'et', type: 'userTask', name: 'Handle Error' },
              { id: 'ee', type: 'endEvent', name: 'Done' },
            ],
            edges: [
              { id: 'ef1', source: 'es', target: 'et' },
              { id: 'ef2', source: 'et', target: 'ee' },
            ],
          },
          { id: 't', type: 'userTask', name: 'Main Task' },
          { id: 'e', type: 'endEvent', name: 'End' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 't' },
          { id: 'f2', source: 't', target: 'e' },
        ],
        lanes: [],
      }],
    };
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toContain('triggeredByEvent="true"');
  });
});

// ═══════════════════════════════════════════════════════════════
// §13  bpmn-moddle Integration Tests
// ═══════════════════════════════════════════════════════════════

describe('bpmn-moddle Import', () => {
  test('moddle import matches legacy import for simple approval', async () => {
    const lc = loadFixture('simple-approval.json');
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toBeTruthy();

    const moddleResult = await bpmnToLogicCore(result.bpmnXml);
    const legacyResult = bpmnToLogicCoreLegacy(result.bpmnXml);

    const moddleNodes = moddleResult.pools ? moddleResult.pools[0].nodes : moddleResult.nodes;
    const legacyNodes = legacyResult.pools ? legacyResult.pools[0].nodes : legacyResult.nodes;
    expect(moddleNodes.length).toBe(legacyNodes.length);

    // Same node IDs
    const moddleIds = moddleNodes.map(n => n.id).sort();
    const legacyIds = legacyNodes.map(n => n.id).sort();
    expect(moddleIds).toEqual(legacyIds);
  });

  test('moddle import matches legacy import for multi-pool', async () => {
    const lc = loadFixture('multi-pool-collaboration.json');
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toBeTruthy();

    const moddleResult = await bpmnToLogicCore(result.bpmnXml);
    const legacyResult = bpmnToLogicCoreLegacy(result.bpmnXml);

    expect(moddleResult.pools.length).toBe(legacyResult.pools.length);
    expect(moddleResult.messageFlows.length).toBe(legacyResult.messageFlows.length);
  });

  test('moddle preserves unknown extension attributes', async () => {
    // Minimal BPMN with a camunda:assignee attribute
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
  xmlns:camunda="http://camunda.org/schema/1.0/bpmn"
  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <process id="Process_1" isExecutable="false">
    <startEvent id="s" name="Start" />
    <userTask id="t" name="Review" camunda:assignee="\${currentUser}" />
    <endEvent id="e" name="End" />
    <sequenceFlow id="f1" sourceRef="s" targetRef="t" />
    <sequenceFlow id="f2" sourceRef="t" targetRef="e" />
  </process>
  <bpmndi:BPMNDiagram id="D1">
    <bpmndi:BPMNPlane id="P1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="s_di" bpmnElement="s"><dc:Bounds x="0" y="0" width="36" height="36" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="t_di" bpmnElement="t"><dc:Bounds x="100" y="0" width="100" height="80" /></bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="e_di" bpmnElement="e"><dc:Bounds x="250" y="0" width="36" height="36" /></bpmndi:BPMNShape>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</definitions>`;

    const result = await bpmnToLogicCore(xml);
    const nodes = result.pools ? result.pools[0].nodes : result.nodes;
    const task = nodes.find(n => n.id === 't');
    expect(task.extensions).toBeDefined();
    expect(task.extensions.$attrs['camunda:assignee']).toContain('currentUser');
  });

  test('all OMG example files parse with bpmn-moddle', async () => {
    const { readdirSync, readFileSync, statSync, existsSync } = await import('fs');
    const { join } = await import('path');

    const examplesDir = resolve(__dirname, '../references/omg-spec/informative/examples-bpmn');
    if (!existsSync(examplesDir)) {
      // OMG spec files are kept locally but not tracked in git (copyright).
      // Skip this test in CI or when files are not present.
      return;
    }

    function findBpmn(dir) {
      const r = [];
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) r.push(...findBpmn(p));
        else if (f.endsWith('.bpmn')) r.push(p);
      }
      return r;
    }

    const files = findBpmn(examplesDir);
    expect(files.length).toBeGreaterThanOrEqual(25);

    let ok = 0, fail = 0;
    for (const f of files) {
      try {
        const xml = readFileSync(f, 'utf8');
        const { rootElement } = await moddleParse(xml);
        moddleToLogicCore(rootElement);
        ok++;
      } catch {
        fail++;
      }
    }
    expect(ok).toBe(files.length);
    expect(fail).toBe(0);
  });

  test('OMG nested lanes example imports correctly', async () => {
    const { readFileSync, existsSync } = await import('fs');
    const nestedLanesFile = resolve(__dirname, '../references/omg-spec/informative/examples-bpmn/2010-06-03/Diagram Interchange/Examples - DI - Lanes and Nested Lanes.bpmn');
    if (!existsSync(nestedLanesFile)) return; // OMG spec files not in git (copyright)
    const xml = readFileSync(nestedLanesFile, 'utf8');

    const result = await bpmnToLogicCore(xml);
    const lanes = result.pools ? result.pools[0].lanes : result.lanes;

    // Should have at least one lane with children (nested)
    const hasNested = lanes.some(l => l.children?.length > 0);
    expect(hasNested).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// §14  Rule Engine — Dedicated unit tests per rule
// ═══════════════════════════════════════════════════════════════

describe('Rule Engine — individual rules', () => {
  // Helper: minimal process
  const proc = (nodes, edges = []) => ({ id: 'P1', name: 'Test', nodes, edges, lanes: [] });
  const wfProfile = { layers: { workflow_net: { enabled: true } }, overrides: {} };

  test('S01: missing startEvent → ERROR', () => {
    const lc = proc([{ id: 'e1', type: 'endEvent', name: 'End' }]);
    const result = runRules(lc);
    expect(result.errors.some(e => e.includes('startEvent'))).toBe(true);
  });

  test('S02: missing endEvent → ERROR', () => {
    const lc = proc([{ id: 's1', type: 'startEvent', name: 'Start' }]);
    const result = runRules(lc);
    expect(result.errors.some(e => e.includes('endEvent'))).toBe(true);
  });

  test('S03: edge with unknown source → ERROR', () => {
    const lc = proc(
      [{ id: 's1', type: 'startEvent' }, { id: 'e1', type: 'endEvent' }],
      [{ id: 'f1', source: 'GHOST', target: 'e1' }],
    );
    const result = runRules(lc);
    expect(result.errors.some(e => e.includes('unknown source'))).toBe(true);
  });

  test('S04: isolated node → WARNING', () => {
    const lc = proc([
      { id: 's1', type: 'startEvent' },
      { id: 't1', type: 'task', name: 'Lonely Task' },
      { id: 'e1', type: 'endEvent' },
    ], [{ id: 'f1', source: 's1', target: 'e1' }]);
    const result = runRules(lc);
    expect(result.warnings.some(w => w.includes('isolated'))).toBe(true);
  });

  test('S05: XOR-split → AND-join deadlock → ERROR', () => {
    const lc = proc([
      { id: 's', type: 'startEvent' },
      { id: 'xor', type: 'exclusiveGateway', name: 'XOR' },
      { id: 't1', type: 'task', name: 'Branch A' },
      { id: 't2', type: 'task', name: 'Branch B' },
      { id: 'and', type: 'parallelGateway', name: 'AND Join' },
      { id: 'e', type: 'endEvent' },
    ], [
      { id: 'f1', source: 's', target: 'xor' },
      { id: 'f2', source: 'xor', target: 't1', label: 'Yes' },
      { id: 'f3', source: 'xor', target: 't2', label: 'No' },
      { id: 'f4', source: 't1', target: 'and' },
      { id: 'f5', source: 't2', target: 'and' },
      { id: 'f6', source: 'and', target: 'e' },
    ]);
    const result = runRules(lc);
    expect(result.errors.some(e => e.includes('Deadlock') && e.includes('XOR'))).toBe(true);
  });

  test('S06: inclusive-split → AND-join → ERROR', () => {
    const lc = proc([
      { id: 's', type: 'startEvent' },
      { id: 'or', type: 'inclusiveGateway', name: 'OR' },
      { id: 't1', type: 'task', name: 'A' },
      { id: 't2', type: 'task', name: 'B' },
      { id: 'and', type: 'parallelGateway', name: 'AND' },
      { id: 'e', type: 'endEvent' },
    ], [
      { id: 'f1', source: 's', target: 'or' },
      { id: 'f2', source: 'or', target: 't1' },
      { id: 'f3', source: 'or', target: 't2' },
      { id: 'f4', source: 't1', target: 'and' },
      { id: 'f5', source: 't2', target: 'and' },
      { id: 'f6', source: 'and', target: 'e' },
    ]);
    const result = runRules(lc);
    expect(result.errors.some(e => e.includes('Deadlock') && e.includes('Inclusive'))).toBe(true);
  });

  test('S07: node without outgoing flow → WARNING', () => {
    const lc = proc([
      { id: 's', type: 'startEvent' },
      { id: 't1', type: 'task', name: 'Dead End' },
      { id: 'e', type: 'endEvent' },
    ], [
      { id: 'f1', source: 's', target: 't1' },
      // t1 has no outgoing edge
      { id: 'f2', source: 's', target: 'e' },
    ]);
    const result = runRules(lc);
    expect(result.warnings.some(w => w.includes('no outgoing'))).toBe(true);
  });

  test('S08: boundary event path without endEvent → WARNING', () => {
    const lc = proc([
      { id: 's', type: 'startEvent' },
      { id: 't1', type: 'task', name: 'Do Work' },
      { id: 'b1', type: 'boundaryEvent', name: 'Timer', attachedToRef: 't1' },
      { id: 't2', type: 'task', name: 'Handle Timeout' },
      { id: 'e', type: 'endEvent' },
    ], [
      { id: 'f1', source: 's', target: 't1' },
      { id: 'f2', source: 't1', target: 'e' },
      { id: 'f3', source: 'b1', target: 't2' },
      // t2 has no path to endEvent
    ]);
    const result = runRules(lc);
    expect(result.warnings.some(w => w.includes('boundary') || w.includes('Boundary'))).toBe(true);
  });

  test('S09: messageFlow within same pool → ERROR', () => {
    const lc = {
      pools: [{
        id: 'pool1', name: 'Pool 1',
        nodes: [
          { id: 's', type: 'startEvent' },
          { id: 't1', type: 'task', name: 'A' },
          { id: 'e', type: 'endEvent' },
        ],
        edges: [
          { id: 'f1', source: 's', target: 't1' },
          { id: 'f2', source: 't1', target: 'e' },
        ],
        lanes: [],
      }],
      messageFlows: [{ id: 'mf1', source: 's', target: 't1' }],
      collapsedPools: [],
    };
    const result = runRules(lc);
    expect(result.errors.some(e => e.includes('within pool'))).toBe(true);
  });

  test('S10: messageFlow with unknown reference → ERROR', () => {
    const lc = {
      pools: [{
        id: 'pool1', name: 'Pool 1',
        nodes: [{ id: 's', type: 'startEvent' }, { id: 'e', type: 'endEvent' }],
        edges: [{ id: 'f1', source: 's', target: 'e' }],
        lanes: [],
      }],
      messageFlows: [{ id: 'mf1', source: 's', target: 'NONEXISTENT' }],
      collapsedPools: [],
    };
    const result = runRules(lc);
    expect(result.errors.some(e => e.includes('unknown'))).toBe(true);
  });

  test('S11: expanded subProcess without start/end → ERROR', () => {
    const lc = proc([
      { id: 's', type: 'startEvent' },
      {
        id: 'sub1', type: 'subProcess', name: 'Sub', isExpanded: true,
        nodes: [{ id: 'inner_t', type: 'task', name: 'Inner' }],
        edges: [],
      },
      { id: 'e', type: 'endEvent' },
    ], [
      { id: 'f1', source: 's', target: 'sub1' },
      { id: 'f2', source: 'sub1', target: 'e' },
    ]);
    const result = runRules(lc);
    expect(result.errors.some(e => e.includes('SubProcess') && e.includes('startEvent'))).toBe(true);
    expect(result.errors.some(e => e.includes('SubProcess') && e.includes('endEvent'))).toBe(true);
  });

  test('M01: single-word task name → WARNING', () => {
    const lc = proc([
      { id: 's', type: 'startEvent' },
      { id: 't1', type: 'task', name: 'Submit' },
      { id: 'e', type: 'endEvent' },
    ], [
      { id: 'f1', source: 's', target: 't1' },
      { id: 'f2', source: 't1', target: 'e' },
    ]);
    const result = runRules(lc);
    expect(result.warnings.some(w => w.includes('Submit'))).toBe(true);
  });

  test('M02: XOR gateway without question mark → WARNING', () => {
    const lc = proc([
      { id: 's', type: 'startEvent' },
      { id: 'xor', type: 'exclusiveGateway', name: 'Check result' },
      { id: 't1', type: 'task', name: 'Path A' },
      { id: 't2', type: 'task', name: 'Path B' },
      { id: 'e', type: 'endEvent' },
    ], [
      { id: 'f1', source: 's', target: 'xor' },
      { id: 'f2', source: 'xor', target: 't1', label: 'Yes' },
      { id: 'f3', source: 'xor', target: 't2', label: 'No' },
      { id: 'f4', source: 't1', target: 'e' },
      { id: 'f5', source: 't2', target: 'e' },
    ]);
    const result = runRules(lc);
    expect(result.warnings.some(w => w.includes('question'))).toBe(true);
  });

  test('M03: converging gateway with labeled outgoing edge → WARNING', () => {
    const lc = proc([
      { id: 's', type: 'startEvent' },
      { id: 't1', type: 'task', name: 'Do A' },
      { id: 't2', type: 'task', name: 'Do B' },
      { id: 'merge', type: 'exclusiveGateway', name: 'Merge', has_join: true },
      { id: 'e', type: 'endEvent' },
    ], [
      { id: 'f1', source: 's', target: 't1' },
      { id: 'f2', source: 's', target: 't2' },
      { id: 'f3', source: 't1', target: 'merge' },
      { id: 'f4', source: 't2', target: 'merge' },
      { id: 'f5', source: 'merge', target: 'e', label: 'Should not have label' },
    ]);
    const result = runRules(lc);
    expect(result.warnings.some(w => w.includes('Converging'))).toBe(true);
  });

  test('M04: XOR outgoing edge without label → WARNING', () => {
    const lc = proc([
      { id: 's', type: 'startEvent' },
      { id: 'xor', type: 'exclusiveGateway', name: 'Check?' },
      { id: 't1', type: 'task', name: 'Path A' },
      { id: 't2', type: 'task', name: 'Path B' },
      { id: 'e', type: 'endEvent' },
    ], [
      { id: 'f1', source: 's', target: 'xor' },
      { id: 'f2', source: 'xor', target: 't1' },  // no label
      { id: 'f3', source: 'xor', target: 't2' },  // no label
      { id: 'f4', source: 't1', target: 'e' },
      { id: 'f5', source: 't2', target: 'e' },
    ]);
    const result = runRules(lc);
    expect(result.warnings.some(w => w.includes('missing label'))).toBe(true);
  });

  test('M05/M06: placeholder rules are OFF by default', () => {
    const m05 = RULES.find(r => r.id === 'M05');
    const m06 = RULES.find(r => r.id === 'M06');
    expect(m05.defaultSeverity).toBe('OFF');
    expect(m06.defaultSeverity).toBe('OFF');
  });

  test('M07: inclusive gateway present → WARNING', () => {
    const lc = proc([
      { id: 's', type: 'startEvent' },
      { id: 'or', type: 'inclusiveGateway', name: 'OR' },
      { id: 't1', type: 'task', name: 'Do Something' },
      { id: 'e', type: 'endEvent' },
    ], [
      { id: 'f1', source: 's', target: 'or' },
      { id: 'f2', source: 'or', target: 't1' },
      { id: 'f3', source: 't1', target: 'e' },
    ]);
    const result = runRules(lc);
    expect(result.warnings.some(w => w.includes('OR') || w.includes('inclusive'))).toBe(true);
  });

  test('M08: XOR with 3+ outgoing, no default → WARNING', () => {
    const lc = proc([
      { id: 's', type: 'startEvent' },
      { id: 'xor', type: 'exclusiveGateway', name: 'Multi?' },
      { id: 't1', type: 'task', name: 'Path A' },
      { id: 't2', type: 'task', name: 'Path B' },
      { id: 't3', type: 'task', name: 'Path C' },
      { id: 'e', type: 'endEvent' },
    ], [
      { id: 'f1', source: 's', target: 'xor' },
      { id: 'f2', source: 'xor', target: 't1', label: 'A' },
      { id: 'f3', source: 'xor', target: 't2', label: 'B' },
      { id: 'f4', source: 'xor', target: 't3', label: 'C' },
      { id: 'f5', source: 't1', target: 'e' },
      { id: 'f6', source: 't2', target: 'e' },
      { id: 'f7', source: 't3', target: 'e' },
    ]);
    const result = runRules(lc);
    expect(result.warnings.some(w => w.includes('default'))).toBe(true);
  });

  test('P01: process with >50 nodes → INFO', () => {
    const nodes = [{ id: 's', type: 'startEvent' }];
    for (let i = 0; i < 55; i++) nodes.push({ id: `t${i}`, type: 'task', name: `Task ${i}` });
    nodes.push({ id: 'e', type: 'endEvent' });
    const edges = [{ id: 'f0', source: 's', target: 't0' }];
    for (let i = 0; i < 54; i++) edges.push({ id: `f${i+1}`, source: `t${i}`, target: `t${i+1}` });
    edges.push({ id: 'fend', source: 't54', target: 'e' });
    const result = runRules(proc(nodes, edges));
    expect(result.infos.some(i => i.includes('elements'))).toBe(true);
  });

  test('P02: gateway nesting depth >3 → INFO', () => {
    // Chain of 4 nested XOR gateways
    const lc = proc([
      { id: 's', type: 'startEvent' },
      { id: 'g1', type: 'exclusiveGateway', name: 'Q1?' },
      { id: 'g2', type: 'exclusiveGateway', name: 'Q2?' },
      { id: 'g3', type: 'exclusiveGateway', name: 'Q3?' },
      { id: 'g4', type: 'exclusiveGateway', name: 'Q4?' },
      { id: 't1', type: 'task', name: 'Deep Task' },
      { id: 'e', type: 'endEvent' },
    ], [
      { id: 'f1', source: 's', target: 'g1' },
      { id: 'f2', source: 'g1', target: 'g2', label: 'Y' },
      { id: 'f3', source: 'g1', target: 'e', label: 'N' },
      { id: 'f4', source: 'g2', target: 'g3', label: 'Y' },
      { id: 'f5', source: 'g2', target: 'e', label: 'N' },
      { id: 'f6', source: 'g3', target: 'g4', label: 'Y' },
      { id: 'f7', source: 'g3', target: 'e', label: 'N' },
      { id: 'f8', source: 'g4', target: 't1', label: 'Y' },
      { id: 'f9', source: 'g4', target: 'e', label: 'N' },
      { id: 'f10', source: 't1', target: 'e' },
    ]);
    const result = runRules(lc);
    expect(result.infos.some(i => i.includes('nesting depth'))).toBe(true);
  });

  test('P03: CFC score > 30 → INFO', () => {
    // Many XOR gateways with 3+ outgoing each
    const nodes = [{ id: 's', type: 'startEvent' }];
    const edges = [];
    let edgeId = 0;
    let prev = 's';
    for (let g = 0; g < 12; g++) {
      const gwId = `gw${g}`;
      nodes.push({ id: gwId, type: 'exclusiveGateway', name: `Q${g}?` });
      edges.push({ id: `e${edgeId++}`, source: prev, target: gwId });
      const t1 = `t${g}a`, t2 = `t${g}b`, t3 = `t${g}c`;
      nodes.push({ id: t1, type: 'task', name: `${g}A` });
      nodes.push({ id: t2, type: 'task', name: `${g}B` });
      nodes.push({ id: t3, type: 'task', name: `${g}C` });
      edges.push({ id: `e${edgeId++}`, source: gwId, target: t1, label: 'A' });
      edges.push({ id: `e${edgeId++}`, source: gwId, target: t2, label: 'B' });
      edges.push({ id: `e${edgeId++}`, source: gwId, target: t3, label: 'C' });
      const merge = `m${g}`;
      nodes.push({ id: merge, type: 'exclusiveGateway', name: 'Merge', has_join: true });
      edges.push({ id: `e${edgeId++}`, source: t1, target: merge });
      edges.push({ id: `e${edgeId++}`, source: t2, target: merge });
      edges.push({ id: `e${edgeId++}`, source: t3, target: merge });
      prev = merge;
    }
    nodes.push({ id: 'e', type: 'endEvent' });
    edges.push({ id: `e${edgeId++}`, source: prev, target: 'e' });
    const result = runRules(proc(nodes, edges));
    expect(result.infos.some(i => i.includes('CFC') || i.includes('Complexity'))).toBe(true);
  });

  test('WF03: deadlock detected via workflow-net → ERROR', () => {
    // XOR-split → AND-join = deadlock
    const lc = proc([
      { id: 's', type: 'startEvent' },
      { id: 'xor', type: 'exclusiveGateway', name: 'XOR' },
      { id: 't1', type: 'task', name: 'A' },
      { id: 't2', type: 'task', name: 'B' },
      { id: 'and', type: 'parallelGateway', name: 'AND' },
      { id: 'e', type: 'endEvent' },
    ], [
      { id: 'f1', source: 's', target: 'xor' },
      { id: 'f2', source: 'xor', target: 't1', label: 'Y' },
      { id: 'f3', source: 'xor', target: 't2', label: 'N' },
      { id: 'f4', source: 't1', target: 'and' },
      { id: 'f5', source: 't2', target: 'and' },
      { id: 'f6', source: 'and', target: 'e' },
    ]);
    const result = runRules(lc, wfProfile);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('valid process passes all rules', () => {
    const lc = loadFixture('simple-approval.json');
    const result = runRules(lc);
    expect(result.errors).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// §15  HTTP Server — parseBody + URL validation
// ═══════════════════════════════════════════════════════════════

describe('HTTP Server utilities', () => {
  test('parseBody with valid JSON → object', async () => {
    const { Readable } = await import('stream');
    const data = JSON.stringify({ logicCore: { id: 'P1' } });
    const req = new Readable({ read() { this.push(data); this.push(null); } });
    const result = await parseBody(req);
    expect(result.logicCore.id).toBe('P1');
  });

  test('parseBody with invalid JSON → rejects', async () => {
    const { Readable } = await import('stream');
    const req = new Readable({ read() { this.push('not json'); this.push(null); } });
    await expect(parseBody(req)).rejects.toThrow('Invalid JSON');
  });

  test('parseBody with oversized body → rejects', async () => {
    const { Readable } = await import('stream');
    const chunk = Buffer.alloc(1024 * 1024); // 1 MB
    let sent = 0;
    const req = new Readable({
      read() {
        if (sent < 11) { this.push(chunk); sent++; }
        else this.push(null);
      },
      destroy() { /* allow destroy */ }
    });
    await expect(parseBody(req)).rejects.toThrow('exceeds');
  });

  test('validateCallbackUrl rejects internal IP', () => {
    expect(validateCallbackUrl('http://127.0.0.1:8080/hook')).toMatch(/internal/);
    expect(validateCallbackUrl('http://192.168.1.1/hook')).toMatch(/internal/);
    expect(validateCallbackUrl('http://10.0.0.5/hook')).toMatch(/internal/);
    expect(validateCallbackUrl('http://localhost:3000')).toMatch(/internal/);
  });

  test('validateCallbackUrl rejects non-http protocols', () => {
    expect(validateCallbackUrl('ftp://example.com/hook')).toMatch(/http/);
  });

  test('validateCallbackUrl accepts valid external URL', () => {
    expect(validateCallbackUrl('https://webhook.example.com/bpmn')).toBeNull();
  });

  test('validateCallbackUrl throws on invalid URL', () => {
    expect(() => validateCallbackUrl('not-a-url')).toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// §16  DOT Format — Round-trip + multi-pool export
// ═══════════════════════════════════════════════════════════════

describe('DOT format', () => {
  test('logicCoreToDot produces valid DOT string', () => {
    const lc = loadFixture('simple-approval.json');
    const dot = logicCoreToDot(lc);
    expect(dot).toContain('digraph');
    expect(dot).toContain('start1');
    expect(dot).toContain('task1');
    expect(dot).toContain('->');
  });

  test('round-trip preserves node and edge count', () => {
    const lc = {
      id: 'P1', name: 'Test',
      nodes: [
        { id: 'start', type: 'startEvent', name: 'Start' },
        { id: 'do_work', type: 'task', name: 'Do Work' },
        { id: 'end', type: 'endEvent', name: 'End' },
      ],
      edges: [
        { id: 'f1', source: 'start', target: 'do_work' },
        { id: 'f2', source: 'do_work', target: 'end' },
      ],
      lanes: [],
    };
    const dot = logicCoreToDot(lc);
    const rt = dotToLogicCore(dot);
    expect(rt.nodes.length).toBe(lc.nodes.length);
    expect(rt.edges.length).toBe(lc.edges.length);
  });

  test('multi-pool export contains subgraph clusters', () => {
    const lc = {
      pools: [
        { id: 'pool1', name: 'Pool A', nodes: [{ id: 's1', type: 'startEvent', name: 'S' }], edges: [], lanes: [] },
        { id: 'pool2', name: 'Pool B', nodes: [{ id: 's2', type: 'startEvent', name: 'S' }], edges: [], lanes: [] },
      ],
      messageFlows: [],
      collapsedPools: [],
    };
    const dot = logicCoreToDot(lc);
    expect(dot).toContain('subgraph cluster_');
    expect(dot).toContain('Pool A');
    expect(dot).toContain('Pool B');
  });
});

// ═══════════════════════════════════════════════════════════════
// Round-Trip XML Validation
// ═══════════════════════════════════════════════════════════════

describe('Round-Trip XML Validation', () => {
  test('validateBpmnXml is exported and callable', () => {
    expect(typeof validateBpmnXml).toBe('function');
  });

  test('simple-approval: 0 round-trip warnings', async () => {
    const lc = loadFixture('simple-approval.json');
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toBeDefined();
    expect(result.validation.xmlWarnings).toEqual([]);
  });

  test('multi-pool-collaboration: 0 round-trip warnings', async () => {
    const lc = loadFixture('multi-pool-collaboration.json');
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toBeDefined();
    expect(result.validation.xmlWarnings).toEqual([]);
  });

  test('expanded-subprocess: 0 round-trip warnings', async () => {
    const lc = loadFixture('expanded-subprocess.json');
    const result = await runPipeline(lc);
    expect(result.bpmnXml).toBeDefined();
    expect(result.validation.xmlWarnings).toEqual([]);
  });

  test('validateBpmnXml detects invalid XML', async () => {
    const result = await validateBpmnXml('<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"><bpmn:process id="p1"><bpmn:bogusElement id="x"/></bpmn:process></bpmn:definitions>');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test('runPipeline result includes xmlWarnings field', async () => {
    const lc = loadFixture('simple-approval.json');
    const result = await runPipeline(lc);
    expect(result.validation).toHaveProperty('xmlWarnings');
    expect(Array.isArray(result.validation.xmlWarnings)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// SVG Golden-File Regression Tests
// ═══════════════════════════════════════════════════════════════

describe('SVG Golden-File Regression', () => {
  const goldenFixtures = ['simple-approval', 'multi-pool-collaboration', 'expanded-subprocess'];

  for (const name of goldenFixtures) {
    test(`${name}: SVG matches golden file`, async () => {
      const lc = loadFixture(`${name}.json`);
      const result = await runPipeline(lc);
      expect(result.svg).toBeDefined();

      let expected;
      try {
        expected = readFileSync(resolve(fixturesDir, `${name}.expected.svg`), 'utf8');
      } catch {
        throw new Error(`Golden file missing: tests/fixtures/${name}.expected.svg — run golden file generation first`);
      }
      expect(result.svg).toBe(expected);
    });

    test(`${name}: BPMN XML matches golden file`, async () => {
      const lc = loadFixture(`${name}.json`);
      const result = await runPipeline(lc);
      expect(result.bpmnXml).toBeDefined();

      let expected;
      try {
        expected = readFileSync(resolve(fixturesDir, `${name}.expected.bpmn`), 'utf8');
      } catch {
        throw new Error(`Golden file missing: tests/fixtures/${name}.expected.bpmn — run golden file generation first`);
      }
      expect(result.bpmnXml).toBe(expected);
    });
  }
});

describe('poolCoords.laneHeaderWidth', () => {
  test('is populated with default LANE_HEADER_W after buildCoordinateMap', async () => {
    const lc = JSON.parse(readFileSync('../tests/fixtures/simple-approval.json', 'utf8'));
    const result = await runPipeline(lc);
    const poolIds = Object.keys(result.coordMap.poolCoords);
    expect(poolIds.length).toBeGreaterThan(0);
    for (const pid of poolIds) {
      expect(result.coordMap.poolCoords[pid].laneHeaderWidth).toBeDefined();
      expect(typeof result.coordMap.poolCoords[pid].laneHeaderWidth).toBe('number');
    }
  });
});

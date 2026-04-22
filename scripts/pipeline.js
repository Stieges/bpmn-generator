/**
 * BPMN Generator Pipeline v2.0 — Enterprise Edition
 * OMG BPMN 2.0.2 compliant (formal/2013-12-09, ISO/IEC 19510:2013)
 *
 * Orchestrator: imports all modules and exposes the public API + CLI.
 *
 * Module architecture:
 *   types.js       → Type predicates, BPMN XML tag mapping
 *   utils.js       → Config, visual constants, helpers
 *   rules.js       → Rule engine (38 rules, 3 layers)
 *   validate.js    → Validation wrapper
 *   topology.js    → Gateway directions, topological sort, lane ordering
 *   layout.js      → ELK graph construction + layout execution
 *   coordinates.js → Coordinate maps, edge clipping
 *   bpmn-xml.js    → BPMN 2.0 XML generation
 *   icons.js       → Event markers, task icons
 *   svg.js         → SVG rendering
 *
 * Usage:
 *   node pipeline.js input.json [output-basename]
 *   cat input.json | node pipeline.js - output-basename
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

// Module imports
import { loadConfig, CFG } from './utils.js';
import { validateLogicCore } from './validate.js';
import { inferGatewayDirections, sortNodesTopologically, orderLanesByFlow, preprocessLogicCore, identifyHappyPathNodes } from './topology.js';
import { logicCoreToElk, runElkLayout } from './layout.js';
import { buildCoordinateMap, enforceOrthogonal, clipOrthogonal } from './coordinates.js';
import { generateBpmnXml, validateBpmnXml } from './bpmn-xml.js';
import { generateSvg } from './svg.js';
import { logicCoreToDot, dotToLogicCore } from './dot.js';
import { computeDynamicLaneHeaders, repairEdgeLabels } from './visual-refinement.js';

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — programmatic usage via import
// ═══════════════════════════════════════════════════════════════════════

/**
 * Run the full BPMN pipeline programmatically.
 * @param {object} logicCore - Logic-Core JSON object
 * @param {object} [opts={}] - Pipeline options
 * @param {boolean} [opts.visualRefinement] - Enable visual refinement passes (overrides CFG.visualRefinement.enabled)
 * @returns {Promise<{bpmnXml: string, svg: string, coordMap: object, validation: {errors: string[], warnings: string[]}}>}
 */
async function runPipeline(logicCore, opts = {}) {
  const lc = JSON.parse(JSON.stringify(logicCore)); // deep clone to avoid mutation
  const { errors, warnings } = validateLogicCore(lc);
  if (errors.length) {
    return { bpmnXml: null, svg: null, coordMap: null, validation: { errors, warnings } };
  }

  const allProcesses = lc.pools ? lc.pools : [lc];
  for (const proc of allProcesses) {
    inferGatewayDirections(proc.nodes || [], proc.edges || []);
  }

  const elkGraph  = logicCoreToElk(lc);
  const elkResult = await runElkLayout(elkGraph);
  const coordMap  = buildCoordinateMap(elkResult, lc);

  // Visual Refinement (opt-in, post-layout coordinate transforms)
  const refineOn = opts.visualRefinement ?? CFG.visualRefinement?.enabled ?? false;
  if (refineOn) {
    if (CFG.visualRefinement?.dynamicLaneHeader !== false) {
      computeDynamicLaneHeaders(coordMap, lc, {
        minWidth: CFG.visualRefinement?.laneHeaderMinWidth ?? 30,
        maxWidth: CFG.visualRefinement?.laneHeaderMaxWidth ?? 120,
      });
    }
    if (CFG.visualRefinement?.edgeLabelCollisionRepair !== false) {
      repairEdgeLabels(coordMap, {
        maxShift: CFG.visualRefinement?.edgeLabelMaxShift ?? 25,
      });
    }
  }

  const bpmnXml   = await generateBpmnXml(lc, coordMap);
  const svg       = generateSvg(lc, coordMap);

  // Round-trip XML validation: parse back through moddle to catch structural issues
  const roundTrip = await validateBpmnXml(bpmnXml);

  return { bpmnXml, svg, coordMap, validation: { errors: [], warnings, xmlWarnings: roundTrip.warnings } };
}

/**
 * Generate a Markdown documentation companion for a Logic-Core process.
 */
function generateProcessDoc(lc) {
  const lines = [];
  const processes = lc.pools ? lc.pools : [lc];
  lines.push(`# ${lc.pools ? 'Collaboration' : (lc.name || 'Process')}`);
  if (lc.pools) lines.push(`\n${processes.length} Pools, ${(lc.messageFlows || []).length} Message Flows\n`);
  for (const proc of processes) {
    if (lc.pools) lines.push(`\n## ${proc.name || proc.id}\n`);
    if (proc.documentation) lines.push(`${proc.documentation}\n`);
    const documented = (proc.nodes || []).filter(n => n.documentation || n.name);
    if (documented.length > 0) {
      lines.push('| Element | Typ | Dokumentation |');
      lines.push('|---------|-----|---------------|');
      for (const n of documented) {
        lines.push(`| ${n.name || n.id} | ${n.type} | ${(n.documentation || '\u2014').replace(/\n/g, ' ')} |`);
      }
    }
  }
  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════
// DRILL-DOWN — hierarchical SubProcess diagrams
// ═══════════════════════════════════════════════════════════════════════

/**
 * Find all expanded subprocesses (recursive, handles nesting).
 */
function findExpandedSubProcesses(nodes, parentPath = []) {
  const result = [];
  for (const node of nodes) {
    if (node.type === 'subProcess' && node.isExpanded && node.nodes?.length) {
      const path = [...parentPath, { id: node.id, name: node.name || node.id }];
      result.push({ node, path });
      // Recurse into nested subprocesses
      result.push(...findExpandedSubProcesses(node.nodes, path));
    }
  }
  return result;
}

/**
 * Deep-clone LogicCore with all expanded subprocesses collapsed.
 * Collapsed = remove inner nodes/edges, set isExpanded: false.
 */
function collapseSubProcesses(logicCore) {
  const lc = JSON.parse(JSON.stringify(logicCore));
  const processes = lc.pools ? lc.pools : [lc];
  for (const proc of processes) {
    proc.nodes = (proc.nodes || []).map(n => {
      if (n.type === 'subProcess' && n.isExpanded) {
        const { nodes: _n, edges: _e, ...rest } = n;
        return { ...rest, isExpanded: false };
      }
      return n;
    });
  }
  return lc;
}

/**
 * Extract a subprocess's internal flow as a standalone Logic-Core.
 */
function extractSubProcessAsLogicCore(logicCore, subProcessId) {
  const processes = logicCore.pools ? logicCore.pools : [logicCore];
  for (const proc of processes) {
    for (const node of (proc.nodes || [])) {
      if (node.id === subProcessId && node.isExpanded && node.nodes?.length) {
        const laneId = `Lane_${subProcessId}`;
        // Set Format A (node.lane) in addition to Format B (lane.nodeIds)
        for (const n of node.nodes) {
          if (!n.lane) n.lane = laneId;
        }
        return {
          pools: [{
            id: `Pool_${subProcessId}`,
            name: node.name || subProcessId,
            lanes: [{ id: laneId, name: node.name || subProcessId, nodeIds: node.nodes.map(n => n.id) }],
            nodes: node.nodes,
            edges: node.edges || [],
          }],
        };
      }
      // Recurse for nested subprocesses
      if (node.type === 'subProcess' && node.isExpanded && node.nodes?.length) {
        const nested = extractSubProcessAsLogicCore(
          { pools: [{ ...proc, nodes: node.nodes, edges: node.edges || [] }] },
          subProcessId,
        );
        if (nested) return nested;
      }
    }
  }
  return null;
}

/**
 * Build navigation metadata for all subprocesses.
 */
function buildNavigation(logicCore) {
  const processes = logicCore.pools ? logicCore.pools : [logicCore];
  const allSubs = [];
  for (const proc of processes) {
    allSubs.push(...findExpandedSubProcesses(proc.nodes || []));
  }
  return {
    subProcesses: allSubs.map(s => ({
      id: s.node.id,
      name: s.node.name || s.node.id,
      breadcrumb: s.path.map(p => p.name),
      nodeCount: s.node.nodes.length,
      edgeCount: (s.node.edges || []).length,
    })),
  };
}

/**
 * Generate a diagram set: parent diagram (subprocesses collapsed) + per-subprocess diagrams.
 * @returns {Promise<{parent: object, subProcesses: object, navigation: object}>}
 */
async function generateDiagramSet(logicCore) {
  // 1. Parent diagram with subprocesses collapsed
  const parentLc = collapseSubProcesses(logicCore);
  const parent = await runPipeline(parentLc);

  // 2. Per-subprocess diagrams
  const processes = logicCore.pools ? logicCore.pools : [logicCore];
  const allSubs = [];
  for (const proc of processes) {
    allSubs.push(...findExpandedSubProcesses(proc.nodes || []));
  }

  const subProcesses = {};
  for (const { node } of allSubs) {
    const subLc = extractSubProcessAsLogicCore(logicCore, node.id);
    if (subLc) {
      subProcesses[node.id] = await runPipeline(subLc);
    }
  }

  // 3. Navigation
  const navigation = buildNavigation(logicCore);

  return { parent, subProcesses, navigation };
}

export {
  runPipeline,
  validateLogicCore,
  inferGatewayDirections,
  sortNodesTopologically,
  orderLanesByFlow,
  preprocessLogicCore,
  logicCoreToElk,
  runElkLayout,
  buildCoordinateMap,
  generateBpmnXml,
  validateBpmnXml,
  generateSvg,
  enforceOrthogonal,
  clipOrthogonal,
  loadConfig,
  CFG,
  logicCoreToDot,
  dotToLogicCore,
  generateProcessDoc,
  identifyHappyPathNodes,
  generateDiagramSet,
  collapseSubProcesses,
  extractSubProcessAsLogicCore,
};

// ═══════════════════════════════════════════════════════════════════════
// CLI ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  const args       = process.argv.slice(2);
  const flags      = args.filter(a => a.startsWith('--'));
  const positional = args.filter(a => !a.startsWith('--'));
  const inputArg   = positional[0];
  const outputBase = positional[1] || 'output';
  const formatDot  = flags.includes('--format=dot') || flags.includes('--dot');
  const importDot  = flags.includes('--import-dot');
  const generateDoc = flags.includes('--doc');
  const drillDown  = flags.includes('--drill-down');
  if (!inputArg) {
    console.error('Usage: node pipeline.js <input.json | -> [output-basename] [--dot] [--import-dot] [--doc]');
    process.exit(1);
  }

  // Read input
  let rawInput;
  if (inputArg === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    rawInput = Buffer.concat(chunks).toString();
  } else {
    rawInput = readFileSync(resolve(inputArg), 'utf8');
  }

  // DOT import mode: convert DOT → Logic-Core JSON and write out
  if (importDot) {
    const lc = dotToLogicCore(rawInput);
    const jsonPath = `${outputBase}.json`;
    writeFileSync(jsonPath, JSON.stringify(lc, null, 2), 'utf8');
    console.log(`✓ DOT → Logic-Core JSON → ${jsonPath}`);
    return;
  }

  const parsedInput = JSON.parse(rawInput);

  // Drill-down mode: generate parent + per-subprocess diagrams
  if (drillDown) {
    const diagramSet = await generateDiagramSet(parsedInput);
    if (!diagramSet.parent.bpmnXml) {
      console.error('\n✗ Errors (pipeline blocked):');
      diagramSet.parent.validation.errors.forEach(e => console.error('  · ' + e));
      process.exit(1);
    }
    writeFileSync(`${outputBase}.bpmn`, diagramSet.parent.bpmnXml, 'utf8');
    writeFileSync(`${outputBase}.svg`, diagramSet.parent.svg, 'utf8');
    console.log(`✓ Parent diagram → ${outputBase}.bpmn, ${outputBase}.svg`);

    for (const [subId, subResult] of Object.entries(diagramSet.subProcesses)) {
      if (subResult.bpmnXml) {
        writeFileSync(`${outputBase}_${subId}.bpmn`, subResult.bpmnXml, 'utf8');
        writeFileSync(`${outputBase}_${subId}.svg`, subResult.svg, 'utf8');
        console.log(`✓ SubProcess ${subId} → ${outputBase}_${subId}.svg`);
      }
    }

    const nav = diagramSet.navigation;
    if (nav.subProcesses.length) {
      const indexHtml = [
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>BPMN Drill-Down</title></head><body>',
        '<h1>Process Overview</h1>',
        `<p><a href="${outputBase}.svg">Parent Diagram</a></p>`,
        '<h2>SubProcesses</h2><ul>',
        ...nav.subProcesses.map(s =>
          `<li><a href="${outputBase}_${s.id}.svg">${s.name}</a> (${s.nodeCount} nodes) — ${s.breadcrumb.join(' → ')}</li>`
        ),
        '</ul></body></html>',
      ].join('\n');
      writeFileSync(`${outputBase}_index.html`, indexHtml, 'utf8');
      console.log(`✓ Navigation → ${outputBase}_index.html`);
    }
    console.log(`\n📊 Drill-Down: 1 parent + ${Object.keys(diagramSet.subProcesses).length} subprocess diagram(s)`);
    return;
  }

  const result = await runPipeline(parsedInput);

  if (result.validation.warnings.length) {
    console.warn('\n⚠ Warnings:');
    result.validation.warnings.forEach(w => console.warn('  · ' + w));
  }
  if (!result.bpmnXml) {
    console.error('\n✗ Errors (pipeline blocked):');
    result.validation.errors.forEach(e => console.error('  · ' + e));
    process.exit(1);
  }
  console.log(`✓ Logic-Core validated (structural soundness OK)`);

  const xmlPath = `${outputBase}.bpmn`;
  writeFileSync(xmlPath, result.bpmnXml, 'utf8');
  console.log(`✓ BPMN 2.0 XML → ${xmlPath}`);

  const svgPath = `${outputBase}.svg`;
  writeFileSync(svgPath, result.svg, 'utf8');
  console.log(`✓ SVG preview → ${svgPath}`);

  // Documentation export (optional)
  if (generateDoc) {
    const docPath = `${outputBase}.md`;
    writeFileSync(docPath, generateProcessDoc(parsedInput), 'utf8');
    console.log(`✓ Process doc → ${docPath}`);
  }

  // DOT export (optional)
  if (formatDot) {
    const dotPath = `${outputBase}.dot`;
    writeFileSync(dotPath, logicCoreToDot(parsedInput), 'utf8');
    console.log(`✓ DOT graph → ${dotPath}`);
  }

  // Summary
  const lc = parsedInput;
  const allProcesses = lc.pools ? lc.pools : [lc];
  const totalNodes = allProcesses.reduce((s, p) => s + (p.nodes || []).length, 0);
  const totalEdges = allProcesses.reduce((s, p) => s + (p.edges || []).length, 0);
  const totalLanes = allProcesses.reduce((s, p) => s + (p.lanes || []).length, 0);
  const totalMsgFlows = (lc.messageFlows || []).length;
  const totalCollapsed = (lc.collapsedPools || []).length;
  const totalAssociations = (lc.associations || []).length;
  console.log(`\n📊 Summary:`);
  console.log(`  Processes:     ${allProcesses.length}`);
  if (totalCollapsed) console.log(`  Black-Box:     ${totalCollapsed}`);
  console.log(`  Nodes:         ${totalNodes}`);
  console.log(`  Edges:         ${totalEdges}`);
  console.log(`  Lanes:         ${totalLanes}`);
  if (totalMsgFlows)    console.log(`  MsgFlows:      ${totalMsgFlows}`);
  if (totalAssociations) console.log(`  Associations:  ${totalAssociations}`);
  console.log(`  Files:         ${xmlPath}, ${svgPath}`);
}

// Only run CLI when executed directly (not imported)
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch(err => { console.error('Pipeline error:', err); process.exit(1); });
}

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
import { loadConfig, CFG } from '../shared/utils.js';
import { validateLogicCore } from './validate.js';
import { validateLogicCoreSchema, LAYOUT_SWITCHES } from './schema-gate.js';
import { resolveRuleProfile } from './rules.js';
import { inferGatewayDirections, sortNodesTopologically, orderLanesByFlow, preprocessLogicCore, identifyHappyPathNodes, normalizeEdgeIds } from './topology.js';
import { logicCoreToElk, runElkLayout } from './layout.js';
import { buildCoordinateMap, placeNodeLabels, placeNodeLabelsAvoidingFlows, enforceOrthogonal, clipOrthogonal, routeMessageFlows, repairMessageFlowLabels, growParticipantGapsForLabels, computeSequenceFlowLabel, flattenProcessEdges, flattenProcessNodes } from './coordinates.js';
import { checkDiagramIntegrity, formatDiWarnings } from './di-check.js';
import { checkNetIntegrity } from './net-check.js';
import { bpmnToPN } from './workflow-net.js';
import { simplifyAllEdges, repairCrossings, guardAgainstLegacy, reclipStuckEnds, reclipOptionsFor, rerouteAfterCompaction } from './edge-simplify.js';
import { applyBendRule } from './bend-rule.js';
import { generateBpmnXml, validateBpmnXml } from './bpmn-xml.js';
import { generateSvg } from './svg.js';
import { logicCoreToDot, dotToLogicCore } from './dot.js';
import { compactLanes, repairEdgeLabels, resolveRefinement, innerLaneLines, laneLabelFloor } from './visual-refinement.js';
import { isMainModule } from '../shared/entry-point.js';
// The one import from outside bpmn/ (fenced in shared/rule-registers.test.js): text for the
// documentation of a Business Rule Task, never a rule — no DMN or cross-notation rule catalog is
// reachable from here.
import { applyDecisionDocumentation, decisionCoreErrors, stripDecisionSection, decisionSectionBody } from '../cross/decision-doc.js';

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — programmatic usage via import
// ═══════════════════════════════════════════════════════════════════════

/**
 * Petri-net translation integrity over a whole Logic-Core — one net per process.
 *
 * `checkNetIntegrity` (net-check.js) is per-process, and `bpmnToPN` flattens containers itself,
 * so a nested subprocess needs no extra call: N pools, N calls, exactly the shape
 * `checkWorkflowNetSoundness` (workflow-net.js) already has.
 *
 * The `[pool] ` prefix is not cosmetic. NC messages name a node id and nothing else, and two
 * participants may legally reuse one id, so an unprefixed collaboration finding would be
 * unattributable — the reader cannot tell which pool's translation broke. `runRules` and
 * `checkWorkflowNetSoundness` both solve this the same way; this is that form, not a third one.
 * `process` carries the same attribution machine-readably, for a caller that would otherwise
 * have to parse the prefix back out of the message.
 *
 * Deliberately NOT conditional on the opt-in `workflow_net` rule layer. When that layer is on,
 * `checkWorkflowNetSoundness` builds its own net per pool and this one is redundant — measured at
 * 0.028–0.037 ms per model, which is not worth a branch. Gating on it would make the always-off
 * default the always-unchecked default, i.e. exactly the state this wiring exists to end.
 *
 * @param {object} lc - Logic-Core (already validated; pools or a single process)
 * @returns {{ ok: boolean, issues: Array<{code, severity, message, elements, process}> }}
 */
function checkNetTranslation(lc) {
  const processes = lc.pools ? lc.pools : [lc];
  const issues = [];
  for (const proc of processes) {
    const prefix = lc.pools ? `[${proc.name || proc.id}] ` : '';
    for (const issue of checkNetIntegrity(bpmnToPN(proc), proc).issues) {
      issues.push({ ...issue, message: prefix + issue.message, process: proc.id });
    }
  }
  return { ok: !issues.some(i => i.severity === 'ERROR'), issues };
}

/**
 * Re-derive the label of every edge whose route `beforeRoutes` → `coordMap.edgeCoords` replaced.
 * Route passes return the same array for an edge they left alone, so reference inequality is the
 * "moved" test. Labels are placed on a route's first horizontal leg (coordinates.js §5.6); a pass
 * that changes the route without this leaves the label on a leg that no longer exists.
 * A pass that moves route points in place passes `{}` as `beforeRoutes`: every label is refreshed.
 * `laneLines` (innerLaneLines of the current geometry) keeps a refreshed label off lane separators.
 * `avoidOtherRoutes` keeps it off every other route too, where a candidate allows (placeEdgeLabel's
 * `avoidRoutes`) — the bend rule's refresh only, so every other pass places labels as before.
 */
function refreshMovedLabels(coordMap, edges, beforeRoutes, laneLines = [], { avoidOtherRoutes = false } = {}) {
  for (const e of edges) {
    if (beforeRoutes[e.id] === coordMap.edgeCoords[e.id]) continue;
    const avoidRoutes = avoidOtherRoutes
      ? Object.entries(coordMap.edgeCoords).filter(([id]) => id !== e.id).map(([, pts]) => pts)
      : [];
    const label = computeSequenceFlowLabel(e, coordMap.edgeCoords[e.id], coordMap.coords, { laneLines, avoidRoutes });
    if (label) coordMap.edgeLabels[e.id] = label;
  }
}

/**
 * Run the full BPMN pipeline programmatically.
 * @param {object} logicCore - Logic-Core JSON object
 * @param {object} [opts={}] - Pipeline options
 * @param {boolean|object} [opts.visualRefinement] - true/false switch every refinement pass; an object { laneCompaction?, edgeLabelCollisionRepair? } switches single passes; omitted -> config.json -> visualRefinement.<pass>
 * @param {boolean} [opts.bendRule] - the bend rule pass (bend-rule.js); default config.json -> layout.bendRule (true)
 * @param {boolean} [opts.alignParticipantPorts] - a message flow to or from a participant (black-box or expanded pool as endpoint) docks level with its other end, not at the middle of the band (routeMessageFlows); default config.json -> layout.alignParticipantPorts (false)
 * @param {boolean} [opts.messageFlowLabelRepair] - message-flow labels off routes, shapes, labels, headers and lane separators (repairMessageFlowLabels); default config.json -> layout.messageFlowLabelRepair (true)
 * @param {boolean} [opts.nodeLabelsAvoidFlows] - event and gateway labels off their flows (placeNodeLabelsAvoidingFlows); default config.json -> layout.nodeLabelsAvoidFlows (true)
 * @param {boolean} [opts.foreignShapeRepair] - the stuck-end pass also re-routes a sequence flow through a foreign shape (reclipStuckEnds' foreignShapes, #91); default config.json -> layout.foreignShapeRepair (true)
 * @param {boolean|'off'|'auto'|'always'} [opts.elkWrapping] - ELK row wrapping for long chains (default config.json -> layout.elkWrapping, 'off'); independent of visualRefinement. If ELK fails with wrapping on, the layout is retried without it and `validation.infos` says so
 * @param {string} [opts.mode='document'] - 'document' (IST, faithful) or 'optimize'/'soll' (enables the Optimization Advisory layer)
 * @param {string|object} [opts.ruleProfile] - Base rule profile (path or object); mode augments it
 * @param {object[]} [opts.decisions] - Decision-Core documents. When given (even empty), every
 *   businessRuleTask with a decisionRef gets its decision table in its documentation, as a marked
 *   section that replaces any earlier one (cross/decision-doc.js). Each document passes the
 *   Decision-Core schema gate first; a failure blocks like a validation error
 * @param {string} [opts.locale] - label locale of that section, default config.json -> dmn.labels.locale
 * @returns {Promise<{
 *   bpmnXml: string|null,
 *   svg: string|null,
 *   coordMap: object|null,
 *   diagnostics: {ok: boolean, issues: object[]}|null,
 *     post-layout geometry findings (di-check.js, DI01-DI10); `null` when validation blocked and
 *     no layout ran — "no artefact", which is not the same claim as "clean"
 *   netDiagnostics: {ok: boolean, issues: object[]}|null,
 *     Petri-net translation findings (net-check.js, NC01-NC06), one call per pool, messages
 *     prefixed `[pool] ` and carrying `process`; `null` on the same early-return path. A separate
 *     key from `diagnostics` because that one's `code` is a closed DI enum in
 *     references/api-schema.json
 *   validation: {errors: string[], warnings: string[], advisories: object[], metrics: object,
 *                xmlWarnings?: string[]}
 * }>}
 */
async function runPipeline(logicCore, opts = {}) {
  // Deep clone (no mutation of the caller's object) that also gives every id-less edge its id,
  // once, before validation, the net check and layout: nothing downstream invents one (#64).
  let lc = normalizeEdgeIds(logicCore);

  // Decision tables into Business Rule Task documentation — only when the caller supplies the
  // decision models (cross/decision-doc.js). Text, never geometry; without `decisions` nothing
  // here runs and the output is byte-identical to a call without the option.
  if (opts.decisions !== undefined) {
    if (!Array.isArray(opts.decisions)) throw new TypeError('decisions must be an array of Decision-Core documents');
    const decisionErrors = decisionCoreErrors(opts.decisions);
    if (decisionErrors.length) {
      return { bpmnXml: null, svg: null, coordMap: null, diagnostics: null, netDiagnostics: null,
        validation: { errors: decisionErrors, warnings: [], advisories: [], metrics: {} } };
    }
    lc = applyDecisionDocumentation(lc, opts.decisions, { locale: opts.locale });
  }

  const profile = resolveRuleProfile(opts.ruleProfile ?? null, opts.mode);
  const { errors, warnings, advisories = [], metrics } = validateLogicCore(lc, profile);
  if (errors.length) {
    return { bpmnXml: null, svg: null, coordMap: null, diagnostics: null, netDiagnostics: null, validation: { errors, warnings, advisories, metrics } };
  }

  const allProcesses = lc.pools ? lc.pools : [lc];
  for (const proc of allProcesses) {
    inferGatewayDirections(proc.nodes || [], proc.edges || []);
  }

  // Net integrity: the same statement one layer over from the DI check below. A green validation
  // says nothing about the Petri net the analysis layers reason on — `checkSoundness` never sees
  // the Logic-Core its net came from, so a translation defect yields a well-formed verdict about
  // the wrong graph.
  //
  // Computed HERE, before `logicCoreToElk`, and that is a correctness constraint rather than a
  // preference: `logicCoreToElk` calls `preprocessLogicCore`, whose `sortNodesTopologically`
  // rebuilds `proc.nodes` from an id-keyed map — in place, on this very object. Two nodes sharing
  // an id therefore collapse into one before layout, and a check running after it would be
  // handed a Logic-Core the defect has already been erased from. Which is exactly the mistake
  // this pass exists to prevent, one level up: judging a graph that is not the model's.
  // `bpmnToPN` does not read the gateway direction the loop above writes, so the position within
  // this block is free; the position relative to `logicCoreToElk` is not.
  //
  // Computed, never acted on. `runPipeline` produces a diagnostic and the caller decides what it
  // means — which is what lets `main()` gate on it, the HTTP layer turn it into a status and
  // `agents/layout.js` pass it through without retrying. Returning early here instead would make
  // one key a gate in the library and a report over HTTP. Kept as its own key rather than merged
  // into `diagnostics` because that one's `code` is a closed DI01…DI11 enum in
  // references/api-schema.json, which the docs gate validates a real response against.
  const netDiagnostics = checkNetTranslation(lc);

  // which refinement passes run — see resolveRefinement
  const refine = resolveRefinement(opts.visualRefinement);
  // The layout switches: omitted means config.json -> layout.<switch>; anything but a boolean throws,
  // so `"false"` cannot switch a pass on by being truthy (the surfaces gate it as a schema_error).
  for (const key of LAYOUT_SWITCHES) {
    if (opts[key] !== undefined && typeof opts[key] !== 'boolean') {
      throw new TypeError(`${key} must be a boolean (got ${JSON.stringify(opts[key])})`);
    }
  }

  // poolOrder: 'auto' (default) orders participants so that the ones exchanging
  // messages sit next to each other; 'declared' keeps the input order.
  const poolOrder = opts.poolOrder ?? CFG.layout?.poolOrder ?? 'auto';
  const elkGraph  = logicCoreToElk(lc, { elkWrapping: opts.elkWrapping, poolOrder });
  const elkResult = await runElkLayout(elkGraph);
  const layoutInfos = elkResult.layoutInfos ?? [];
  const coordMap  = buildCoordinateMap(elkResult, lc);

  // Edge simplification: collapse ELK's layer-column jogs into clean L-shapes
  // where node-bbox collision allows it — never an L that would lie on an
  // endpoint's outline (#52). Reduces cross-lane zigzag.
  // flattenProcessEdges, not proc.edges: a subprocess child's edges must reach
  // simplifyAllEdges/repairCrossings too, or a nested crossing is invisible to
  // both passes (see the coordinates.js §5.0- comment for the same pattern).
  const allEdges = allProcesses.flatMap(p => flattenProcessEdges(p));
  // Associations are already clipped to both shapes (coordinates.js §5.4) and
  // must not be simplified — clearance here is checked against nodes only.
  const skipSimplify = new Set((lc.associations || []).map(a => a.id));
  const elkRoutes = coordMap.edgeCoords;
  coordMap.edgeCoords = simplifyAllEdges(elkRoutes, coordMap.coords, allEdges, skipSimplify);
  // Lane separators a refreshed label must not lie across; re-derived once compaction moves them.
  let laneLines = innerLaneLines(coordMap, lc);
  refreshMovedLabels(coordMap, allEdges, elkRoutes, laneLines);

  // Crossing repair: the routes coordinates.js deletes and rebuilds (§5.0a,
  // §5.2, §5.0e, §5.5) pick their axis by |dy| > |dx| alone, so they can cross
  // an edge that ELK had routed around. Runs after simplifyAllEdges because
  // that pass rewrites routes too. A no-op unless a crossing actually exists.
  // Sequence flows through a foreign shape (#91): the stuck-end pass re-routes them too — see
  // reclipStuckEnds' `foreignShapes`. On by default (config.json -> layout.foreignShapeRepair); per
  // call `foreignShapeRepair`, CLI --no-foreign-shape-repair / --foreign-shape-repair.
  const foreignShapes = opts.foreignShapeRepair ?? (CFG.layout?.foreignShapeRepair === true);
  const repairOpts = {
    maxPasses: CFG.layout?.crossingRepairMaxPasses ?? 2,
    orthogonalRouter: CFG.layout?.orthogonalRouterEnabled !== false,
    orthogonalRouterMaxGridPoints: CFG.layout?.orthogonalRouterMaxGridPoints,
  };
  if (CFG.layout?.crossingRepair !== false) {
    // #52 guard: a new route must not cost a crossing the pre-#52 routes did not have — see
    // guardAgainstLegacy. Reverts single edges only; a no-op unless the count went up.
    if (CFG.layout?.crossingGuard !== false) {
      const legacyRoutes = simplifyAllEdges(elkRoutes, coordMap.coords, allEdges, skipSimplify, { legacy: true });
      const preGuard = coordMap.edgeCoords;
      coordMap.edgeCoords = guardAgainstLegacy(preGuard, legacyRoutes, coordMap.coords,
        allEdges, skipSimplify, repairOpts).routes;
      // A reverted edge has its legacy route now; its label must follow it.
      refreshMovedLabels(coordMap, allEdges, preGuard, laneLines);
    }
    const beforeRepair = coordMap.edgeCoords;
    coordMap.edgeCoords = repairCrossings(beforeRepair, coordMap.coords, allEdges, skipSimplify, repairOpts);
    // Labels were placed on the pre-repair geometry (coordinates.js §5.6).
    // Refresh only the ones whose route actually moved — repairCrossings keeps
    // the original array reference for everything it left alone.
    if (coordMap.edgeCoords !== beforeRepair) {
      refreshMovedLabels(coordMap, allEdges, beforeRepair, laneLines);
    }
  }

  // Stuck ends: an edge that still ends along an outline or runs through its
  // own source/target after simplification and repair may move an endpoint to another side's
  // midpoint — see reclipStuckEnds. A boundary event's endpoint never moves: its place on the host
  // is placeBoundaryEvents' contract.
  if (CFG.layout?.endpointReclip !== false) {
    const reclipOpts = { ...reclipOptionsFor(allProcesses.flatMap(p => flattenProcessNodes(p.nodes || []))), foreignShapes };
    const beforeReclip = coordMap.edgeCoords;
    coordMap.edgeCoords = reclipStuckEnds(beforeReclip, coordMap.coords, allEdges, skipSimplify, reclipOpts);
    refreshMovedLabels(coordMap, allEdges, beforeReclip, laneLines);
  }

  // Visual Refinement (post-layout coordinate transforms)
  if (refine.laneCompaction) {
    const preCompaction = structuredClone(coordMap.edgeCoords);
    // bpmn-js wraps a lane label against the lane height, so a lane compacted below its
    // longest word shows that word broken mid-word in bpmn.io and Camunda Modeler.
    const laneNameOf = new Map(allProcesses.flatMap(p => p.lanes || []).map(l => [l.id, l.name]));
    compactLanes(coordMap, lc, {
      minLaneHeight: CFG.visualRefinement?.minLaneHeight ?? 80,
      minLaneHeightFor: CFG.visualRefinement?.laneLabelFloor === false ? undefined : (id) => laneLabelFloor(laneNameOf.get(id)),
    });
    laneLines = innerLaneLines(coordMap, lc);
    // compactLanes moves route points in place and shifts each label on its own, so a route whose
    // points land in different lanes ends up with its label off its leg — or across it. The
    // routes are the same arrays, so the reference test cannot see them: refresh every label.
    refreshMovedLabels(coordMap, allEdges, {}, laneLines);
    // compactLanes moves waypoints but never re-routes: re-run the routing chain for the flows it
    // bent and keep their legs off the lane separators (rerouteAfterCompaction), then the stuck-end
    // pass again — both on the compacted geometry. Message flows are routed later, as always.
    const beforeReroute = coordMap.edgeCoords;
    coordMap.edgeCoords = rerouteAfterCompaction(beforeReroute, preCompaction, coordMap.coords, allEdges, skipSimplify, {
      laneLines,
      laneLineClearance: CFG.visualRefinement?.laneLineClearance ?? 10,
      guard: CFG.layout?.crossingRepair !== false && CFG.layout?.crossingGuard !== false,
      repair: CFG.layout?.crossingRepair !== false,
      repairOpts,
    });
    if (CFG.layout?.endpointReclip !== false) {
      const reclipOpts = { ...reclipOptionsFor(allProcesses.flatMap(p => flattenProcessNodes(p.nodes || []))), foreignShapes };
      coordMap.edgeCoords = reclipStuckEnds(coordMap.edgeCoords, coordMap.coords, allEdges, skipSimplify, reclipOpts);
    }
    refreshMovedLabels(coordMap, allEdges, beforeReroute, laneLines);
  }

  // Node labels follow their node: buildCoordinateMap placed them, lane compaction may have moved
  // nodes since. Re-derived here, after the last pass that moves a node and before anything
  // reads them (the bend rule; routeMessageFlows moves no node), rather than shifted pass by pass —
  // placeNodeLabels is a pure function of the final node boxes, so re-deriving cannot drift from them.
  coordMap.nodeLabels = placeNodeLabels(coordMap.coords, lc);

  // Bend rule (bend-rule.js): fewest bends, then enter activities and events from the left. After
  // every pass that moves a shape or a route, so it judges the final geometry and nothing re-routes
  // its choice; before edge-label repair and routeMessageFlows. On by default (config.json ->
  // layout.bendRule); per call `bendRule`, CLI --no-bend-rule / --bend-rule.
  if (opts.bendRule ?? (CFG.layout?.bendRule === true)) {
    const beforeBend = coordMap.edgeCoords;
    coordMap.edgeCoords = applyBendRule(coordMap, lc, { edges: allEdges, skipIds: skipSimplify });
    refreshMovedLabels(coordMap, allEdges, beforeBend, laneLines, { avoidOtherRoutes: true });
  }
  if (refine.edgeLabelCollisionRepair) {
    repairEdgeLabels(coordMap, {
      maxShift: CFG.visualRefinement?.edgeLabelMaxShift ?? 25,
      laneLines,
    });
  }

  // Message flows LAST: their horizontal leg has to sit in the gap between two
  // participants, so every pass that can still move a participant must be done.
  // layout.alignParticipantPorts (off by default): a flow to or from a participant docks level with
  // its other end instead of at the middle of the participant's band.
  const routeOpts = { alignParticipantPorts: opts.alignParticipantPorts ?? (CFG.layout?.alignParticipantPorts === true) };
  routeMessageFlows(coordMap, lc, routeOpts);

  // Message-flow label repair (repairMessageFlowLabels, #88): routeMessageFlows placed each label
  // without the ones after it, and the edge-label repair above ran before any message flow existed.
  // A label that overlaps a route, a shape, a node or edge label, a participant header or crosses a
  // lane separator moves beside one of its own segments. Labels only — every route is final here.
  // BEFORE node-label avoidance, so edge labels are settled when node labels choose: that pass treats
  // every edge label as an obstacle and never moves one, and this one treats every node label as one
  // and never moves one — neither can undo the other, and a node label moved afterwards lands only
  // on a spot clear of the repaired boxes. On by default (config.json ->
  // layout.messageFlowLabelRepair); per call `messageFlowLabelRepair`.
  if (opts.messageFlowLabelRepair ?? (CFG.layout?.messageFlowLabelRepair === true)) {
    coordMap.edgeLabels = repairMessageFlowLabels(coordMap, lc);
    // A label no spot beside its flow can take, because the gap between two participants is too
    // narrow: grow that gap (participants below move down rigidly), route message flows again and
    // repair again — inside growParticipantGapsForLabels, so message flows still follow the last
    // pass that moves a participant. Kept only where it clears the label.
    growParticipantGapsForLabels(coordMap, lc, routeOpts);
  }

  // Node labels away from flows (placeNodeLabelsAvoidingFlows): an event's or a gateway's label
  // leaves the bottom when a flow leaves or enters the node there. After routeMessageFlows on
  // purpose — a message flow's port is only known now — and that keeps "message flows last": a
  // label box is not route geometry, and from here on only the two renderers read node labels.
  // On by default (config.json -> layout.nodeLabelsAvoidFlows); per call `nodeLabelsAvoidFlows`,
  // CLI --no-label-avoidance / --label-avoidance.
  if (opts.nodeLabelsAvoidFlows ?? (CFG.layout?.nodeLabelsAvoidFlows === true)) {
    coordMap.nodeLabels = placeNodeLabelsAvoidingFlows(coordMap, lc);
  }

  const bpmnXml   = await generateBpmnXml(lc, coordMap);
  const svg       = generateSvg(lc, coordMap);

  // Round-trip XML validation: parse back through moddle to catch structural issues
  const roundTrip = await validateBpmnXml(bpmnXml);

  // DI integrity: the rule engine never sees a coordinate, so a layout defect
  // passes validation green. This pass inspects the produced geometry.
  const diagnostics = checkDiagramIntegrity(coordMap, lc, { alongOutlineMinPx: CFG.layout?.alongOutlineMinPx });

  return {
    bpmnXml, svg, coordMap, diagnostics, netDiagnostics,
    validation: { errors: [], warnings, infos: layoutInfos, advisories, metrics, xmlWarnings: roundTrip.warnings },
  };
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
        // A generated decision section (cross/decision-doc.js) is an aligned text table: squeezed
        // into one table cell it would be unreadable, so the cell keeps the author's text and the
        // section follows the table as a preformatted block.
        const section = decisionSectionBody(n.documentation);
        const cell = section === null ? (n.documentation || '\u2014') : stripDecisionSection(n.documentation);
        lines.push(`| ${n.name || n.id} | ${n.type} | ${cell.replace(/\n/g, ' ')} |`);
      }
      for (const n of documented) {
        const section = decisionSectionBody(n.documentation);
        if (section) lines.push('', `### ${n.name || n.id}`, '', '```text', section, '```');
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
async function generateDiagramSet(logicCore, opts = {}) {
  // 1. Parent diagram with subprocesses collapsed
  const parentLc = collapseSubProcesses(logicCore);
  const parent = await runPipeline(parentLc, opts);

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
      subProcesses[node.id] = await runPipeline(subLc, opts);
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
  const rawArgs    = process.argv.slice(2);
  // `--decisions <files>` (or `--decisions=<files>`) is the one flag that takes a value; pull it
  // out first so its value is not read as the input or output path.
  let decisionsArg = null;
  const args = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === '--decisions') {
      if (i + 1 >= rawArgs.length) {
        console.error('✗ --decisions requires a value (comma-separated Decision-Core JSON or .dmn files)');
        process.exit(1);
      }
      decisionsArg = rawArgs[++i];
    } else if (a.startsWith('--decisions=')) {
      decisionsArg = a.slice('--decisions='.length);
    } else {
      args.push(a);
    }
  }
  const flags      = args.filter(a => a.startsWith('--'));
  const positional = args.filter(a => !a.startsWith('--'));
  const inputArg   = positional[0];
  const outputBase = positional[1] || 'output';
  const formatDot  = flags.includes('--format=dot') || flags.includes('--dot');
  const importDot  = flags.includes('--import-dot');
  const generateDoc = flags.includes('--doc');
  const drillDown  = flags.includes('--drill-down');
  const strict     = flags.includes('--strict');
  const optimize   = flags.includes('--optimize') || flags.includes('--mode=soll') || flags.includes('--mode=optimize');
  const refine     = flags.includes('--refine');
  const noRefine   = flags.includes('--no-refine');
  const wrap       = flags.includes('--wrap');
  if (!inputArg) {
    console.error('Usage: node pipeline.js <input.json | -> [output-basename] [--dot] [--import-dot] [--doc] [--strict] [--optimize] [--refine] [--no-refine] [--wrap] [--bend-rule] [--no-bend-rule] [--label-avoidance] [--no-label-avoidance] [--foreign-shape-repair] [--no-foreign-shape-repair] [--decisions <files>]');
    process.exit(1);
  }
  if (refine && noRefine) {
    console.error('--refine and --no-refine are mutually exclusive.');
    process.exit(1);
  }
  // The layout switches, each forced on or off for this call; with neither flag config.json
  // (or a BPMN_CONFIG override) decides.
  const switchOpts = {};
  for (const [key, on, off] of [['bendRule', '--bend-rule', '--no-bend-rule'], ['nodeLabelsAvoidFlows', '--label-avoidance', '--no-label-avoidance'], ['foreignShapeRepair', '--foreign-shape-repair', '--no-foreign-shape-repair']]) {
    if (flags.includes(on) && flags.includes(off)) {
      console.error(`${on} and ${off} are mutually exclusive.`);
      process.exit(1);
    }
    if (flags.includes(on)) switchOpts[key] = true;
    else if (flags.includes(off)) switchOpts[key] = false;
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

  // Schema-Gate (ajv, draft-2020-12): LLM/handwritten Logic-Core is never trusted
  // raw — enforce the formal input-schema before the pipeline, same guarantee the
  // HTTP entry already has. See references/input-schema.json + scripts/bpmn/schema-gate.js.
  const schemaCheck = validateLogicCoreSchema(parsedInput);
  if (!schemaCheck.valid) {
    console.error('\n✗ Schema-Gate: Logic-Core input violates references/input-schema.json:');
    schemaCheck.errors.forEach(e => console.error(`  · ${e.path} ${e.message}`));
    process.exit(1);
  }

  // --decisions: Decision-Core JSON or .dmn files (routed by content, dmn/load-decisions.js), whose
  // tables go into the documentation of the Business Rule Tasks that call them.
  let decisions;
  if (decisionsArg !== null) {
    // Loaded on demand: it pulls in the DMN importer (dmn-moddle), which no other BPMN run needs.
    const { loadDecisionFile, decisionPaths } = await import('../dmn/load-decisions.js');
    decisions = [];
    for (const p of decisionPaths(decisionsArg)) {
      try {
        decisions.push((await loadDecisionFile(p)).dc);
      } catch (e) {
        console.error(`✗ ${e.message}`);
        process.exit(1);
      }
    }
  }

  // --refine switches every refinement pass on, --no-refine every pass off; with neither flag
  // opts.visualRefinement stays undefined and the per-pass defaults in
  // config.json -> visualRefinement decide. --wrap likewise only ever asks for wrapping; the
  // config default (layout.elkWrapping) decides otherwise.
  const refineOpts = {
    ...(refine ? { visualRefinement: true } : noRefine ? { visualRefinement: false } : {}),
    ...(wrap ? { elkWrapping: 'auto' } : {}),
    ...switchOpts,
    ...(decisions ? { decisions } : {}),
  };

  // Drill-down mode: generate parent + per-subprocess diagrams
  if (drillDown) {
    const diagramSet = await generateDiagramSet(parsedInput, refineOpts);
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

  const result = await runPipeline(parsedInput, { mode: optimize ? 'optimize' : 'document', ...refineOpts });

  if (result.validation.warnings.length) {
    console.warn('\n⚠ Warnings:');
    result.validation.warnings.forEach(w => console.warn('  · ' + w));
  }
  if (result.validation.infos?.length) {
    result.validation.infos.forEach(i => console.log('ℹ ' + i));
  }
  if (optimize && result.validation.advisories?.length) {
    console.log('\n💡 Optimization opportunities (Soll-Redesign — Vorschläge, kein Auto-Fix):');
    result.validation.advisories.forEach(a => console.log('  · ' + (a.pool ? `[${a.pool}] ` : '') + a.message));
  }
  if (!result.bpmnXml) {
    console.error('\n✗ Errors (pipeline blocked):');
    result.validation.errors.forEach(e => console.error('  · ' + e));
    process.exit(1);
  }
  // --strict: treat warnings as fatal and abort BEFORE writing files, so a run
  // with unresolved warnings never produces a "green" artifact. Without the flag
  // the historical behaviour (warn + exit 0) is preserved.
  if (strict && result.validation.warnings.length) {
    console.error(`\n✗ --strict: ${result.validation.warnings.length} warning(s) — resolve them before delivery. No files written.`);
    process.exit(1);
  }
  console.log(`✓ Logic-Core validated (structural soundness OK)`);

  // Geometry diagnostics. A green validation says nothing about the layout —
  // the rule engine never sees a coordinate. Printing this next to the
  // validation line is the whole point of the check: it existed but nobody
  // surfaced it, so a broken diagram still reported success and exited 0.
  const diErrors = (result.diagnostics?.issues ?? []).filter(i => i.severity === 'ERROR');
  const diWarnings = (result.diagnostics?.issues ?? []).filter(i => i.severity !== 'ERROR');
  if (diWarnings.length) {
    console.warn('\n⚠ Diagram diagnostics:');
    // #43: above the threshold DI05 prints grouped by source participant; the JSON result keeps
    // one issue per flow.
    formatDiWarnings(result.diagnostics.issues, parsedInput,
      { groupThreshold: CFG.diagnostics?.di05GroupThreshold ?? 5 })
      .forEach(line => console.warn(`  · ${line}`));
  }
  if (diErrors.length) {
    console.error('\n✗ Diagram integrity (DI) — the geometry is broken, no files written:');
    diErrors.forEach(i => console.error(`  · ${i.code} ${i.message}`));
    process.exit(1);
  }
  if (strict && diWarnings.length) {
    console.error(`\n✗ --strict: ${diWarnings.length} diagram diagnostic(s). No files written.`);
    process.exit(1);
  }

  // Petri-net translation diagnostics, gated exactly like the DI block above and for the same
  // reason: an unfaithful net makes every soundness verdict a statement about a different
  // process, and a green one is worse than none. The one model class this newly blocks is
  // duplicate ids across sibling containers — see tests/fixtures/negative/. That used to leave
  // here with a serialisation warning and exit 0, and the file it wrote carried the same `id=`
  // twice, which xsd:ID forbids document-wide; no tool loads it correctly.
  //
  // One deliberate difference from the DI block: `--strict` gates on WARNING only, not on
  // "anything that is not an ERROR". DI has no INFO codes, so the distinction never arose there;
  // NC does, and NC05 is the case — its own message says multiple start events sharing one source
  // place are "standard WF-net/OMG normalisation, not a defect". A gate that refuses to write
  // files while quoting a message that says nothing is wrong is telling the user something false,
  // and multiple start events are OMG-legal (§10.4.2) and common. INFO is disclosure: printed,
  // never fatal.
  const netIssues = result.netDiagnostics?.issues ?? [];
  const netErrors = netIssues.filter(i => i.severity === 'ERROR');
  const netWarnings = netIssues.filter(i => i.severity === 'WARNING');
  const netInfos = netIssues.filter(i => i.severity !== 'ERROR' && i.severity !== 'WARNING');
  if (netWarnings.length || netInfos.length) {
    console.warn('\n⚠ Petri-net diagnostics:');
    [...netWarnings, ...netInfos].forEach(i => console.warn(`  · ${i.code} ${i.message}`));
  }
  if (netErrors.length) {
    console.error('\n✗ Net integrity (NC) — the Petri-net translation is not faithful to the model, no files written:');
    netErrors.forEach(i => console.error(`  · ${i.code} ${i.message}`));
    process.exit(1);
  }
  if (strict && netWarnings.length) {
    console.error(`\n✗ --strict: ${netWarnings.length} Petri-net diagnostic(s). No files written.`);
    process.exit(1);
  }

  // Serialisation diagnostics, from re-parsing our own XML through bpmn-moddle.
  // Kept apart from the rule-engine warnings above on purpose: those are about
  // the process, these are about whether the file we just wrote is actually
  // valid BPMN. This channel already existed and already fired — nothing read
  // it, so invalid output ("unknown attribute <name>" on every text annotation)
  // shipped for months while the CLI reported success and exited 0.
  const xmlWarnings = result.validation.xmlWarnings ?? [];
  if (xmlWarnings.length) {
    console.warn('\n⚠ BPMN serialisation (round-trip through bpmn-moddle):');
    xmlWarnings.forEach(w => console.warn('  · ' + w));
  }
  // One class within that channel is unconditionally fatal, not merely `--strict` fatal.
  // `xsd:ID` is document-wide unique by definition, so a duplicate id does not degrade the file,
  // it makes it unloadable — no tool can resolve a reference to the id, and which of the two
  // elements a reader binds is arbitrary. Writing such a file and exiting 0 is the CLI claiming
  // a success it did not have, which is the same defect NC and DI are gated on.
  //
  // NC06 covers only half of the class and deliberately so: it catches duplicate NODE ids,
  // because there the Petri net is genuinely wrong too (transitions are keyed `t_<node.id>`, so
  // one node overwrites the other). Two edges sharing an id translate FAITHFULLY — `placeOfEdge`
  // is keyed by edge object identity — so NC06 does not fire and must not, its message would be
  // false about them. A Petri-net guard has no business judging XML serialisation. This gate is
  // that other half, placed in the layer that actually owns it.
  //
  // The predicate matches prose emitted by a dependency, which is a real fragility and is called
  // out rather than hidden: the string is moddle-xml's, thrown at `addElement` as
  // `error('duplicate ID <' + id + '>')` (moddle-xml 12.0.0, dist/index.esm.js) and surfaced by
  // bpmn-moddle as an import warning. It reaches us either verbatim or nested inside an
  // `unparsable content <…> detected … nested error: duplicate ID <x>` wrapper, so the match has
  // to be on a substring rather than on a prefix. A moddle-xml release that rewords it would
  // make this gate silently stop firing; the guard against that is the test below, which drives
  // a genuinely duplicated id through the real dependency rather than asserting on a fixed
  // string. Not in config.json on purpose — this is a fact about an installed dependency, not a
  // tunable of ours, and it belongs next to the comment that explains it.
  const DUPLICATE_ID_WARNING = /duplicate ID </;
  const duplicateIdWarnings = xmlWarnings.filter(w => DUPLICATE_ID_WARNING.test(w));
  if (duplicateIdWarnings.length) {
    console.error('\n✗ Duplicate id in the emitted XML — xsd:ID is document-wide unique, so the file would not load. No files written:');
    duplicateIdWarnings.forEach(w => console.error('  · ' + w));
    process.exit(1);
  }

  if (strict && xmlWarnings.length) {
    console.error(`\n✗ --strict: ${xmlWarnings.length} serialisation warning(s). No files written.`);
    process.exit(1);
  }

  const xmlPath = `${outputBase}.bpmn`;
  writeFileSync(xmlPath, result.bpmnXml, 'utf8');
  console.log(`✓ BPMN 2.0 XML → ${xmlPath}`);

  const svgPath = `${outputBase}.svg`;
  writeFileSync(svgPath, result.svg, 'utf8');
  console.log(`✓ SVG preview → ${svgPath}`);

  // Documentation export (optional)
  if (generateDoc) {
    const docPath = `${outputBase}.md`;
    // The documentation the pipeline wrote, decision sections included (cross/decision-doc.js is
    // pure, so this is the same text runPipeline put into the XML and the SVG tooltips).
    const docInput = decisions ? applyDecisionDocumentation(parsedInput, decisions) : parsedInput;
    writeFileSync(docPath, generateProcessDoc(docInput), 'utf8');
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
const isDirectRun = isMainModule(import.meta.url, process.argv[1]);
if (isDirectRun) {
  main().catch(err => { console.error('Pipeline error:', err); process.exit(1); });
}

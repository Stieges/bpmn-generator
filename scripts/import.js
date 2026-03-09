/**
 * BPMN Import Module — Round-Tripping
 * Converts BPMN 2.0 XML → Logic-Core JSON for editing and re-generation.
 *
 * Usage:
 *   node import.js input.bpmn [output.json]
 *   cat input.bpmn | node import.js - output.json
 *
 * Supports: processes, collaborations, lanes, message flows,
 *           collapsed pools, gateways, all task/event types,
 *           boundary events, loop/MI markers, data objects, associations.
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { moddleParse, moddleToLogicCore } from './moddle-import.js';

// ═══════════════════════════════════════════════════════════════
// Simple XML parser (no dependencies, handles BPMN subset)
// ═══════════════════════════════════════════════════════════════

function parseXml(xml) {
  // Strip XML declaration and comments
  xml = xml.replace(/<\?xml[^?]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  return parseElement(xml, 0).element;
}

function parseElement(xml, pos) {
  // Skip whitespace
  while (pos < xml.length && /\s/.test(xml[pos])) pos++;
  if (xml[pos] !== '<') return { element: null, pos };

  // Parse tag name
  const tagStart = pos;
  pos++; // skip <
  let tagName = '';
  while (pos < xml.length && !/[\s/>]/.test(xml[pos])) { tagName += xml[pos]; pos++; }

  // Parse attributes
  const attrs = {};
  while (pos < xml.length && xml[pos] !== '>' && !(xml[pos] === '/' && xml[pos+1] === '>')) {
    while (pos < xml.length && /\s/.test(xml[pos])) pos++;
    if (xml[pos] === '>' || (xml[pos] === '/' && xml[pos+1] === '>')) break;
    let attrName = '';
    while (pos < xml.length && xml[pos] !== '=' && !/[\s/>]/.test(xml[pos])) { attrName += xml[pos]; pos++; }
    if (xml[pos] === '=') {
      pos++; // skip =
      const quote = xml[pos]; pos++; // skip quote
      let attrVal = '';
      while (pos < xml.length && xml[pos] !== quote) { attrVal += xml[pos]; pos++; }
      pos++; // skip closing quote
      attrs[attrName] = unescXml(attrVal);
    }
  }

  // Self-closing?
  if (xml[pos] === '/' && xml[pos+1] === '>') {
    return { element: { tag: tagName, attrs, children: [], text: '' }, pos: pos + 2 };
  }
  pos++; // skip >

  // Parse children and text content
  const children = [];
  let text = '';
  while (pos < xml.length) {
    // Check for closing tag
    if (xml[pos] === '<' && xml[pos+1] === '/') {
      // Skip closing tag
      while (pos < xml.length && xml[pos] !== '>') pos++;
      pos++; // skip >
      break;
    }
    if (xml[pos] === '<') {
      const child = parseElement(xml, pos);
      if (child.element) children.push(child.element);
      pos = child.pos;
    } else {
      text += xml[pos];
      pos++;
    }
  }

  return { element: { tag: tagName, attrs, children, text: text.trim() }, pos };
}

function unescXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// ═══════════════════════════════════════════════════════════════
// BPMN XML → Logic-Core Converter
// ═══════════════════════════════════════════════════════════════

/**
 * Import BPMN XML → Logic-Core JSON (async, uses bpmn-moddle).
 * Falls back to legacy parser on moddle failure.
 */
async function bpmnToLogicCore(xml) {
  try {
    const { rootElement } = await moddleParse(xml);
    return moddleToLogicCore(rootElement);
  } catch {
    return bpmnToLogicCoreLegacy(xml);
  }
}

/** Legacy sync parser (custom XML parser, kept for fallback/comparison). */
function bpmnToLogicCoreLegacy(xml) {
  const root = parseXml(xml);
  if (!root) throw new Error('Failed to parse BPMN XML');

  const defs = root; // <definitions>

  // Find collaboration
  const collab = findChild(defs, 'collaboration');
  const processes = findChildren(defs, 'process');
  const participants = collab ? findChildren(collab, 'participant') : [];
  const xmlMessageFlows = collab ? findChildren(collab, 'messageFlow') : [];

  // Build participant → process mapping
  const partMap = {};
  for (const p of participants) {
    partMap[p.attrs.id] = {
      processRef: p.attrs.processRef || null,
      name: p.attrs.name || '',
      id: p.attrs.id,
    };
  }

  // Identify collapsed pools (participants without processRef or without matching process)
  const processIds = new Set(processes.map(p => p.attrs.id));
  const expandedParts = participants.filter(p => p.attrs.processRef && processIds.has(p.attrs.processRef));
  const collapsedParts = participants.filter(p => !p.attrs.processRef || !processIds.has(p.attrs.processRef));

  const isMultiPool = expandedParts.length > 1 || collapsedParts.length > 0;

  // Convert each process
  const pools = [];
  for (const proc of processes) {
    const pool = convertProcess(proc, partMap);
    pools.push(pool);
  }

  // Build collapsed pools
  const collapsedPools = collapsedParts.map(p => ({
    id: p.attrs.processRef || p.attrs.id.replace('Participant_', ''),
    name: p.attrs.name || '',
  }));

  // Build message flows
  const messageFlows = xmlMessageFlows.map(mf => ({
    id: mf.attrs.id,
    name: mf.attrs.name || '',
    source: resolveParticipantRef(mf.attrs.sourceRef, partMap),
    target: resolveParticipantRef(mf.attrs.targetRef, partMap),
  }));

  // Extract top-level definitions (error, message, signal, escalation) — OMG spec §8.4
  const topLevelDefs = [];
  const defTags = { 'error': 'error', 'message': 'message', 'signal': 'signal', 'escalation': 'escalation' };
  for (const child of defs.children) {
    const tag = stripNs(child.tag);
    if (defTags[tag]) {
      const def = { type: tag, id: child.attrs.id, name: child.attrs.name || '' };
      if (tag === 'error' && child.attrs.errorCode) def.errorCode = child.attrs.errorCode;
      if (tag === 'escalation' && child.attrs.escalationCode) def.escalationCode = child.attrs.escalationCode;
      topLevelDefs.push(def);
    }
  }

  // Build associations (from all processes)
  const associations = [];
  for (const proc of processes) {
    for (const assoc of findChildren(proc, 'association')) {
      associations.push({
        id: assoc.attrs.id,
        source: assoc.attrs.sourceRef,
        target: assoc.attrs.targetRef,
        directed: assoc.attrs.associationDirection === 'One',
      });
    }
  }

  // Parse bioc: color attributes from DI shapes
  const diagram = findChild(defs, 'BPMNDiagram');
  const plane = diagram ? findChild(diagram, 'BPMNPlane') : null;
  if (plane) {
    for (const shape of findChildren(plane, 'BPMNShape')) {
      const bpmnElement = shape.attrs.bpmnElement;
      const biocStroke = shape.attrs['bioc:stroke'];
      const biocFill = shape.attrs['bioc:fill'];
      if (bpmnElement && (biocStroke || biocFill)) {
        for (const pool of pools) {
          const node = (pool.nodes || []).find(n => n.id === bpmnElement);
          if (node) {
            node.color = {};
            if (biocStroke) node.color.stroke = biocStroke;
            if (biocFill) node.color.fill = biocFill;
            break;
          }
        }
      }
    }
  }

  // Output
  if (isMultiPool || pools.length > 1) {
    const result = { pools, collapsedPools, messageFlows };
    if (associations.length > 0) result.associations = associations;
    if (topLevelDefs.length > 0) result.definitions = topLevelDefs;
    return result;
  } else if (pools.length === 1) {
    const result = pools[0];
    if (associations.length > 0) result.associations = associations;
    if (topLevelDefs.length > 0) result.definitions = topLevelDefs;
    return result;
  }

  return { id: 'Process_1', name: 'Empty', nodes: [], edges: [], lanes: [] };
}

function convertProcess(proc, partMap) {
  const processId = proc.attrs.id;
  const processName = proc.attrs.name || findPartNameForProcess(processId, partMap) || processId;

  // Documentation
  const docEl = findChild(proc, 'documentation');
  const documentation = docEl?.text || undefined;

  // Lanes
  const laneSet = findChild(proc, 'laneSet');
  const lanes = [];
  const nodeLaneMap = {};

  if (laneSet) {
    parseLanes(laneSet, lanes, nodeLaneMap);
  }

  // Flow nodes
  const nodes = [];
  const flowNodeTags = new Set([
    'startEvent', 'endEvent', 'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent',
    'task', 'userTask', 'serviceTask', 'scriptTask', 'sendTask', 'receiveTask',
    'manualTask', 'businessRuleTask', 'callActivity', 'subProcess', 'transaction',
    'exclusiveGateway', 'parallelGateway', 'inclusiveGateway', 'eventBasedGateway', 'complexGateway',
    'dataObjectReference', 'dataStoreReference', 'textAnnotation', 'group',
  ]);

  for (const child of proc.children) {
    const tag = stripNs(child.tag);
    if (!flowNodeTags.has(tag)) continue;

    const node = {
      id: child.attrs.id,
      type: tag,
      name: child.attrs.name || '',
    };

    // Lane assignment
    if (nodeLaneMap[node.id]) node.lane = nodeLaneMap[node.id];

    // Documentation
    const nodeDoc = findChild(child, 'documentation');
    if (nodeDoc?.text) node.documentation = nodeDoc.text;

    // Gateway direction → has_join
    if (child.attrs.gatewayDirection === 'Converging') node.has_join = true;

    // Boundary event
    if (child.attrs.attachedToRef) {
      node.attachedTo = child.attrs.attachedToRef;
      if (child.attrs.cancelActivity === 'false') node.cancelActivity = false;
    }

    // Event marker + event-definition details
    const markerInfo = detectEventMarkerFull(child);
    if (markerInfo.marker) node.marker = markerInfo.marker;
    if (markerInfo.linkName) node.linkName = markerInfo.linkName;
    if (markerInfo.conditionExpression) node.conditionExpression = markerInfo.conditionExpression;
    if (markerInfo.timerExpression) node.timerExpression = markerInfo.timerExpression;

    // isForCompensation (OMG spec §10.2.1)
    if (child.attrs.isForCompensation === 'true') node.isCompensation = true;

    // isCollection on dataObjectReference (OMG spec §10.3.1)
    if (child.attrs.isCollection === 'true') node.isCollection = true;

    // CallActivity: calledElement (OMG spec §10.2.3)
    if (tag === 'callActivity' && child.attrs.calledElement) node.calledElement = child.attrs.calledElement;

    // ScriptTask: scriptFormat + script body (OMG spec §10.2.5)
    if (tag === 'scriptTask') {
      if (child.attrs.scriptFormat) node.scriptFormat = child.attrs.scriptFormat;
      const scriptEl = findChild(child, 'script');
      if (scriptEl?.text) node.script = scriptEl.text;
    }

    // ServiceTask/SendTask/ReceiveTask: implementation, messageRef (OMG spec §10.2.5)
    if (child.attrs.implementation && child.attrs.implementation !== '##WebService' && child.attrs.implementation !== '##unspecified') {
      node.implementation = child.attrs.implementation;
    }

    // EventBasedGateway: eventGatewayType, instantiate (OMG spec §10.5.6)
    if (tag === 'eventBasedGateway') {
      if (child.attrs.eventGatewayType && child.attrs.eventGatewayType !== 'Exclusive') node.eventGatewayType = child.attrs.eventGatewayType;
      if (child.attrs.instantiate === 'true') node.instantiate = true;
    }

    // Event SubProcess: triggeredByEvent (OMG spec §10.2.4)
    if (tag === 'subProcess' && child.attrs.triggeredByEvent === 'true') node.isEventSubProcess = true;

    // Loop / Multi-instance with details
    const slc = findChild(child, 'standardLoopCharacteristics');
    if (slc) {
      const loopCond = findChild(slc, 'loopCondition');
      if (loopCond?.text || slc.attrs.testBefore || slc.attrs.loopMaximum) {
        node.loopType = {};
        if (loopCond?.text) node.loopType.loopCondition = loopCond.text;
        if (slc.attrs.testBefore === 'true') node.loopType.testBefore = true;
        if (slc.attrs.loopMaximum) node.loopType.loopMaximum = parseInt(slc.attrs.loopMaximum, 10);
      } else {
        node.loopType = 'standard';
      }
    }
    const mi = findChild(child, 'multiInstanceLoopCharacteristics');
    if (mi) {
      const miType = mi.attrs.isSequential === 'true' ? 'sequential' : 'parallel';
      const loopCard = findChild(mi, 'loopCardinality');
      const completionCond = findChild(mi, 'completionCondition');
      if (loopCard?.text || completionCond?.text) {
        node.multiInstance = { type: miType };
        if (loopCard?.text) node.multiInstance.loopCardinality = loopCard.text;
        if (completionCond?.text) node.multiInstance.completionCondition = completionCond.text;
      } else {
        node.multiInstance = miType;
      }
    }

    // Expanded SubProcess: parse child flow elements + sequence flows
    if ((tag === 'subProcess' || tag === 'transaction') && child.children && child.children.length > 0) {
      const subFlowNodes = child.children.filter(c => flowNodeTags.has(stripNs(c.tag)));
      const subSeqFlows = findChildren(child, 'sequenceFlow');
      if (subFlowNodes.length > 0) {
        node.isExpanded = true;
        node.nodes = subFlowNodes.map(c => {
          const sn = { id: c.attrs.id, type: stripNs(c.tag), name: c.attrs.name || '' };
          const sm = detectEventMarker(c);
          if (sm) sn.marker = sm;
          return sn;
        });
        node.edges = subSeqFlows.map(sf => {
          const se = { id: sf.attrs.id, source: sf.attrs.sourceRef, target: sf.attrs.targetRef };
          if (sf.attrs.name) se.label = sf.attrs.name;
          return se;
        });
      }
    }

    nodes.push(node);
  }

  // Sequence flows
  const edges = [];
  for (const sf of findChildren(proc, 'sequenceFlow')) {
    const edge = {
      id: sf.attrs.id,
      source: sf.attrs.sourceRef,
      target: sf.attrs.targetRef,
    };
    if (sf.attrs.name) edge.label = sf.attrs.name;

    // Condition expression
    const condExpr = findChild(sf, 'conditionExpression');
    if (condExpr?.text) edge.condition = condExpr.text;

    // Default flow detection
    // Check if any gateway has this flow as default
    for (const n of proc.children) {
      if (n.attrs.default === sf.attrs.id) {
        edge.isDefault = true;
        break;
      }
    }

    edges.push(edge);
  }

  const result = { id: processId, name: processName, nodes, edges, lanes };
  if (documentation) result.documentation = documentation;
  return result;
}

function parseLanes(laneSet, lanes, nodeLaneMap) {
  for (const lane of findChildren(laneSet, 'lane')) {
    const laneObj = { id: lane.attrs.id, name: lane.attrs.name || lane.attrs.id };
    // Nested lanes via childLaneSet (OMG spec §10.5)
    const childLaneSet = findChild(lane, 'childLaneSet');
    if (childLaneSet) {
      laneObj.children = [];
      parseLanes(childLaneSet, laneObj.children, nodeLaneMap);
    }
    lanes.push(laneObj);
    for (const ref of findChildren(lane, 'flowNodeRef')) {
      nodeLaneMap[ref.text] = lane.attrs.id;
    }
  }
}

function detectEventMarkerFull(element) {
  const markerMap = {
    'messageEventDefinition': 'message',
    'timerEventDefinition': 'timer',
    'errorEventDefinition': 'error',
    'signalEventDefinition': 'signal',
    'escalationEventDefinition': 'escalation',
    'compensateEventDefinition': 'compensation',
    'conditionalEventDefinition': 'conditional',
    'linkEventDefinition': 'link',
    'cancelEventDefinition': 'cancel',
    'terminateEventDefinition': 'terminate',
  };

  const result = { marker: null };

  for (const child of element.children) {
    const tag = stripNs(child.tag);
    if (!markerMap[tag]) continue;
    result.marker = markerMap[tag];

    // Link event: extract name
    if (tag === 'linkEventDefinition' && child.attrs.name) {
      result.linkName = child.attrs.name;
    }

    // Conditional event: extract condition expression
    if (tag === 'conditionalEventDefinition') {
      const condEl = findChild(child, 'condition');
      if (condEl?.text) result.conditionExpression = condEl.text;
    }

    // Timer event: extract time expression
    if (tag === 'timerEventDefinition') {
      const timeDate = findChild(child, 'timeDate');
      const timeDuration = findChild(child, 'timeDuration');
      const timeCycle = findChild(child, 'timeCycle');
      if (timeDate?.text) result.timerExpression = { type: 'date', value: timeDate.text };
      else if (timeDuration?.text) result.timerExpression = { type: 'duration', value: timeDuration.text };
      else if (timeCycle?.text) result.timerExpression = { type: 'cycle', value: timeCycle.text };
    }

    break;
  }
  return result;
}

function detectEventMarker(element) {
  return detectEventMarkerFull(element).marker;
}

function resolveParticipantRef(ref, partMap) {
  if (partMap[ref]) {
    return partMap[ref].processRef || ref.replace('Participant_', '');
  }
  return ref;
}

function findPartNameForProcess(processId, partMap) {
  for (const p of Object.values(partMap)) {
    if (p.processRef === processId) return p.name;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// XML Helpers
// ═══════════════════════════════════════════════════════════════

function stripNs(tag) {
  const i = tag.lastIndexOf(':');
  return i >= 0 ? tag.slice(i + 1) : tag;
}

function findChild(element, localName) {
  if (!element?.children) return null;
  return element.children.find(c => stripNs(c.tag) === localName) || null;
}

function findChildren(element, localName) {
  if (!element?.children) return [];
  return element.children.filter(c => stripNs(c.tag) === localName);
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════

async function main() {
  const args       = process.argv.slice(2);
  const inputArg   = args[0];
  const outputPath = args[1] || null;

  if (!inputArg) {
    console.error('Usage: node import.js <input.bpmn | -> [output.json]');
    process.exit(1);
  }

  let xmlInput;
  if (inputArg === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    xmlInput = Buffer.concat(chunks).toString();
  } else {
    xmlInput = readFileSync(resolve(inputArg), 'utf8');
  }

  console.log('✓ BPMN XML loaded');

  const logicCore = await bpmnToLogicCore(xmlInput);
  console.log('✓ Logic-Core extracted');

  const json = JSON.stringify(logicCore, null, 2);

  if (outputPath) {
    writeFileSync(outputPath, json, 'utf8');
    console.log(`✓ Logic-Core JSON → ${outputPath}`);
  } else {
    console.log(json);
  }

  // Summary
  const procs = logicCore.pools || [logicCore];
  const totalNodes = procs.reduce((s, p) => s + (p.nodes || []).length, 0);
  const totalEdges = procs.reduce((s, p) => s + (p.edges || []).length, 0);
  console.log(`\n📊 Import summary:`);
  console.log(`  Processes:  ${procs.length}`);
  if (logicCore.collapsedPools?.length) console.log(`  Black-Box:  ${logicCore.collapsedPools.length}`);
  console.log(`  Nodes:      ${totalNodes}`);
  console.log(`  Edges:      ${totalEdges}`);
}

export { bpmnToLogicCore, bpmnToLogicCoreLegacy, parseXml };

// Only run CLI when executed directly (not imported)
const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (isDirectRun) {
  main().catch(err => { console.error('Import error:', err); process.exit(1); });
}

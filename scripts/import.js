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

function bpmnToLogicCore(xml) {
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

  // Output
  if (isMultiPool || pools.length > 1) {
    const result = { pools, collapsedPools, messageFlows };
    if (associations.length > 0) result.associations = associations;
    return result;
  } else if (pools.length === 1) {
    const result = pools[0];
    if (associations.length > 0) result.associations = associations;
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
    for (const lane of findChildren(laneSet, 'lane')) {
      lanes.push({ id: lane.attrs.id, name: lane.attrs.name || lane.attrs.id });
      for (const ref of findChildren(lane, 'flowNodeRef')) {
        nodeLaneMap[ref.text] = lane.attrs.id;
      }
    }
  }

  // Flow nodes
  const nodes = [];
  const flowNodeTags = new Set([
    'startEvent', 'endEvent', 'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent',
    'task', 'userTask', 'serviceTask', 'scriptTask', 'sendTask', 'receiveTask',
    'manualTask', 'businessRuleTask', 'callActivity', 'subProcess',
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

    // Event marker
    const marker = detectEventMarker(child);
    if (marker) node.marker = marker;

    // Loop / Multi-instance
    if (findChild(child, 'standardLoopCharacteristics')) node.loopType = 'standard';
    const mi = findChild(child, 'multiInstanceLoopCharacteristics');
    if (mi) node.multiInstance = mi.attrs.isSequential === 'true' ? 'sequential' : 'parallel';

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

function detectEventMarker(element) {
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

  for (const child of element.children) {
    const tag = stripNs(child.tag);
    if (markerMap[tag]) return markerMap[tag];
  }
  return null;
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

  const logicCore = bpmnToLogicCore(xmlInput);
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

export { bpmnToLogicCore, parseXml };

// Only run CLI when executed directly (not imported)
const __filename = fileURLToPath(import.meta.url);
const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);
if (isDirectRun) {
  main().catch(err => { console.error('Import error:', err); process.exit(1); });
}

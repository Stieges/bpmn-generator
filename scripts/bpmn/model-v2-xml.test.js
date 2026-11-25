/**
 * XML places of a 2.0 model (design 11 a): every assignment as `<bg:assignment>` in the node's
 * extensionElements, a formed lane's `<bg:derived>` marker in the lane's extensionElements, and
 * the origin as attributes on `bpmn:definitions`. Fed a hand-built 1.x-shaped model carrying the
 * private fields of the intermediate form (design 7.5), through `runPipeline` without a view.
 */
import { describe, test, expect } from '@jest/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bpmnXsdStatus, xsdDir } from '../../.github/scripts/fetch-bpmn-xsd.mjs';
import { runPipeline } from './pipeline.js';
import { bpmnToLogicCore, bpmnToLogicCoreLegacy } from './import.js';

const PINNED = 'sha256:1839c85404873913d420764884aa77ed37f54a3341df18b7e641c0f85f70c9a4';
const ASSIGNMENT = '<bg:assignment type="D" actor="sb_schaden" />';
const LANE_MARKER = '<bg:derived by="role" actor="sb_schaden">lane</bg:derived>';
const LANE = 'L.P._sb';
const MODEL_INFO = { version: '2.0', view: 'rollen', catalogFingerprint: PINNED };
const D = [{ type: 'D', actor: 'sb_schaden' }];

const copy = (v) => JSON.parse(JSON.stringify(v));
const count = (xml, re) => (xml.match(re) || []).length;

/** The intermediate form: lanes formed by role, every node with one D assignment. */
function formed() {
  return {
    id: 'P', name: 'Schaden regulieren',
    _modelInfo: { ...MODEL_INFO },
    lanes: [{ id: LANE, name: 'Sachbearbeitung Schaden', _derived: 'lane', _laneBy: 'role', _laneActor: 'sb_schaden' }],
    nodes: [
      { id: 's', type: 'startEvent', name: 'Schaden gemeldet', lane: LANE, _assignments: D },
      { id: 't', type: 'userTask', name: 'Schaden prüfen', lane: LANE, _assignments: D },
      { id: 'b', type: 'boundaryEvent', marker: 'timer', attachedTo: 't', cancelActivity: false,
        name: '3 Tage vergangen', lane: LANE, _assignments: D },
      { id: 'eb', type: 'endEvent', name: 'Erinnert', lane: LANE },
      { id: 'gw', type: 'exclusiveGateway', name: 'Schaden gedeckt?', lane: LANE, _assignments: D },
      {
        id: 'sp', type: 'subProcess', name: 'Zahlung abwickeln', isExpanded: true, lane: LANE,
        nodes: [
          { id: 'c_s', type: 'startEvent', name: 'Zahlung beginnt' },
          { id: 'c_t', type: 'userTask', name: 'Zahlung freigeben', _assignments: D },
          { id: 'c_e', type: 'endEvent', name: 'Zahlung freigegeben' },
        ],
        edges: [
          { id: 'c_f1', source: 'c_s', target: 'c_t' },
          { id: 'c_f2', source: 'c_t', target: 'c_e' },
        ],
      },
      { id: 'e1', type: 'endEvent', name: 'Schaden reguliert', lane: LANE },
      { id: 'e2', type: 'endEvent', name: 'Schaden abgelehnt', lane: LANE },
    ],
    edges: [
      { id: 'f1', source: 's', target: 't' },
      { id: 'f2', source: 't', target: 'gw' },
      { id: 'f3', source: 'gw', target: 'sp', label: 'ja' },
      { id: 'f4', source: 'gw', target: 'e2', label: 'nein' },
      { id: 'f5', source: 'sp', target: 'e1' },
      { id: 'f6', source: 'b', target: 'eb' },
    ],
  };
}

/** The same model without any private field of the intermediate form. */
function stripPrivate(value) {
  return JSON.parse(JSON.stringify(value, (k, v) => (k.startsWith('_') ? undefined : v)));
}

/** The element `<bpmn:<tag> id="<id>" …>…</bpmn:<tag>>` of `xml`. */
function element(xml, tag, id) {
  const m = xml.match(new RegExp(`<bpmn:${tag} id="${id}"[\\s\\S]*?</bpmn:${tag}>`));
  if (!m) throw new Error(`no <bpmn:${tag} id="${id}"> in the XML`);
  return m[0];
}
const extensionOf = (el) => el.match(/<bpmn:extensionElements>[\s\S]*?<\/bpmn:extensionElements>/)?.[0] ?? '';
const definitionsTag = (xml) => xml.match(/<bpmn:definitions\b[^>]*>/)[0];

async function generate(model) {
  const r = await runPipeline(copy(model));
  expect(r.validation.errors).toEqual([]);
  return r;
}

describe('2.0 XML places (design 11 a)', () => {
  test('every assignment sits in the node\'s extensionElements, subprocess children included', async () => {
    const { bpmnXml, validation } = await generate(formed());
    expect(validation.xmlWarnings).toEqual([]);
    for (const [tag, id] of [['userTask', 't'], ['startEvent', 's'], ['exclusiveGateway', 'gw'],
      ['boundaryEvent', 'b'], ['userTask', 'c_t']]) {
      expect(extensionOf(element(bpmnXml, tag, id))).toContain(ASSIGNMENT);
    }
    expect(count(bpmnXml, /<bg:assignment\b/g)).toBe(5);
  });

  test('a formed lane carries its marker as first child, before flowNodeRef', async () => {
    const { bpmnXml } = await generate(formed());
    const lane = element(bpmnXml, 'lane', LANE.replace(/\./g, '\\.'));
    const body = lane.replace(/^<bpmn:lane[^>]*>\s*/, '');
    expect(body).toMatch(/^<bpmn:extensionElements>\s*<bg:derived by="role" actor="sb_schaden">lane<\/bg:derived>\s*<\/bpmn:extensionElements>\s*<bpmn:flowNodeRef>/);
    expect(lane.indexOf(LANE_MARKER)).toBeLessThan(lane.indexOf('<bpmn:flowNodeRef>'));
  });

  test('definitions carry the origin, exporter, no exporterVersion, one xmlns:bg', async () => {
    const { bpmnXml } = await generate(formed());
    const defs = definitionsTag(bpmnXml);
    expect(defs).toContain(`bg:modelVersion="2.0"`);
    expect(defs).toContain(`bg:view="rollen"`);
    expect(defs).toContain(`bg:catalog="${PINNED}"`);
    expect(defs).toContain('exporter="bpmn-generator"');
    expect(bpmnXml).not.toContain('exporterVersion');
    expect(count(bpmnXml, /xmlns:bg=/g)).toBe(1);
    expect(defs).toContain('xmlns:bg="http://bpmn-generator/schema/1.0"');
  });

  test('xmlns:bg is declared once with no assignment and no lane', async () => {
    const bare = {
      id: 'P', name: 'Schaden melden', _modelInfo: { ...MODEL_INFO, view: 'default' },
      nodes: [
        { id: 's', type: 'startEvent', name: 'Schaden eingetreten' },
        { id: 't', type: 'userTask', name: 'Schaden melden' },
        { id: 'e', type: 'endEvent', name: 'Schaden gemeldet' },
      ],
      edges: [{ id: 'f1', source: 's', target: 't' }, { id: 'f2', source: 't', target: 'e' }],
    };
    const { bpmnXml, validation } = await generate(bare);
    expect(validation.xmlWarnings).toEqual([]);
    expect(count(bpmnXml, /xmlns:bg=/g)).toBe(1);
    expect(count(bpmnXml, /<bg:/g)).toBe(0);
    expect(definitionsTag(bpmnXml)).toContain('bg:view="default"');
  });

  test('no performer, resource or system in 2.0 output', async () => {
    const { bpmnXml } = await generate(formed());
    expect(bpmnXml).not.toMatch(/<bpmn:(performer|humanPerformer|resource)\b/);
    expect(bpmnXml).not.toContain('<bg:system');
  });

  test('without the private fields nothing of it is written', async () => {
    const { bpmnXml } = await generate(stripPrivate(formed()));
    expect(bpmnXml).not.toMatch(/bg:assignment|bg:derived|bg:modelVersion|exporter=/);
  });

  test.each([
    ['bpmnToLogicCore', (xml) => bpmnToLogicCore(xml)],
    ['bpmnToLogicCoreLegacy', async (xml) => bpmnToLogicCoreLegacy(xml)],
  ])('%s reads the same model as without the private fields', async (_name, read) => {
    const withFields = (await generate(formed())).bpmnXml;
    const without = (await generate(stripPrivate(formed()))).bpmnXml;
    expect(await read(withFields)).toEqual(await read(without));
  });
});

const xsd = bpmnXsdStatus();
(xsd.available ? test : test.skip)('2.0 output validates against BPMN20.xsd', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'model-v2-xml-'));
  try {
    const files = [];
    for (const [name, model] of [['formed', formed()], ['bare', { ...stripPrivate(formed()), _modelInfo: MODEL_INFO }]]) {
      const file = join(dir, `${name}.bpmn`);
      writeFileSync(file, (await generate(model)).bpmnXml);
      files.push(file);
    }
    // Throws with xmllint's message when a file fails to validate.
    execFileSync('xmllint', ['--noout', '--schema', join(xsdDir(), 'BPMN20.xsd'), ...files], { encoding: 'utf8', stdio: 'pipe' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

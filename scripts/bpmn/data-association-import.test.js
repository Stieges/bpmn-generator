/**
 * Native data associations on import, and the association between two nested elements on write.
 *
 * A `bpmn:dataInputAssociation` / `bpmn:dataOutputAssociation` (an editor's link between a task
 * or an event and a data object or data store) is read by both importers as a directed 1.x
 * association: input from the data reference to the owning node, output from the owning node to
 * the data reference. The writer, in turn, keeps an association whose two ends both sit inside a
 * subprocess (it used to drop it and leave a BPMNEdge pointing at nothing).
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from './pipeline.js';
import { bpmnToLogicCore, bpmnToLogicCoreLegacy } from './import.js';
import { validateLogicCoreSchema } from './schema-gate.js';

const here = dirname(fileURLToPath(import.meta.url));
const REVIEW_SET = resolve(here, '../../references/review-set/artifacts_and_data_reference.bpmn');

const definitions = (body) => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
${body}
</bpmn:definitions>`;

/** Both readers' results, after checking they agree. */
const readBoth = async (xml) => {
  const moddle = await bpmnToLogicCore(xml);
  const legacy = bpmnToLogicCoreLegacy(xml);
  expect(moddle).toEqual(legacy);
  return moddle;
};

describe('importers read native data associations as directed associations', () => {
  test('review-set file: both readers add the three linked data associations', async () => {
    const xml = readFileSync(REVIEW_SET, 'utf8');
    const lc = await readBoth(xml);
    expect(lc.associations.map(a => a.id).slice(0, 4)).toEqual([
      'Association_16ysqsl', 'Association_1k4w4ly', 'Association_0yloi1l', 'Association_1xsjlah',
    ]);
    expect(lc.associations.slice(4)).toEqual([
      { id: 'DataInputAssociation_0q9hrq8', source: 'DataStoreReference_0mdthby', target: 'Activity_1pc1cln', directed: true },
      { id: 'DataOutputAssociation_04pjgr8', source: 'Activity_1pc1cln', target: 'DataObjectReference_1549xs9', directed: true },
      { id: 'DataInputAssociation_190gulw', source: 'DataObjectReference_1549xs9', target: 'Activity_04jlk0c', directed: true },
    ]);
    // The output association without an id (no DI possible) is not read.
    expect(lc.associations).toHaveLength(7);
    expect(lc.associations.every(a => typeof a.id === 'string' && a.id !== '')).toBe(true);
    expect(validateLogicCoreSchema(lc)).toEqual({ valid: true, errors: [] });
  });

  test("a nested activity's data associations are read", async () => {
    const xml = definitions(`  <bpmn:process id="Process_order" isExecutable="false">
    <bpmn:startEvent id="s" name="Bestellung eingegangen" />
    <bpmn:subProcess id="sp" name="Bestellung bearbeiten">
      <bpmn:startEvent id="sp_s" />
      <bpmn:task id="sp_t" name="Bestellung prüfen">
        <bpmn:property id="sp_t_prop" name="__targetRef_placeholder" />
        <bpmn:dataInputAssociation id="read_order">
          <bpmn:sourceRef>order</bpmn:sourceRef>
          <bpmn:targetRef>sp_t_prop</bpmn:targetRef>
        </bpmn:dataInputAssociation>
        <bpmn:dataOutputAssociation id="write_stock">
          <bpmn:targetRef>stock</bpmn:targetRef>
        </bpmn:dataOutputAssociation>
      </bpmn:task>
      <bpmn:endEvent id="sp_e" />
      <bpmn:dataObjectReference id="order" name="Bestellung" dataObjectRef="order_do" />
      <bpmn:dataObject id="order_do" />
      <bpmn:sequenceFlow id="sf1" sourceRef="sp_s" targetRef="sp_t" />
      <bpmn:sequenceFlow id="sf2" sourceRef="sp_t" targetRef="sp_e" />
    </bpmn:subProcess>
    <bpmn:endEvent id="e" name="Bestellung bearbeitet" />
    <bpmn:dataStoreReference id="stock" name="Lagerbestand" />
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="sp" />
    <bpmn:sequenceFlow id="f2" sourceRef="sp" targetRef="e" />
  </bpmn:process>`);
    const lc = await readBoth(xml);
    expect(lc.associations).toEqual([
      { id: 'read_order', source: 'order', target: 'sp_t', directed: true },
      { id: 'write_stock', source: 'sp_t', target: 'stock', directed: true },
    ]);
    expect(validateLogicCoreSchema(lc)).toEqual({ valid: true, errors: [] });
  });

  test('a sourceRef naming a property is skipped', async () => {
    const xml = definitions(`  <bpmn:process id="Process_order" isExecutable="false">
    <bpmn:task id="t" name="Bestellung prüfen">
      <bpmn:property id="t_prop" name="__targetRef_placeholder" />
      <bpmn:property id="t_other" name="other" />
      <bpmn:dataInputAssociation id="from_property">
        <bpmn:sourceRef>t_other</bpmn:sourceRef>
        <bpmn:targetRef>t_prop</bpmn:targetRef>
      </bpmn:dataInputAssociation>
      <bpmn:dataOutputAssociation id="to_property">
        <bpmn:targetRef>t_other</bpmn:targetRef>
      </bpmn:dataOutputAssociation>
    </bpmn:task>
    <bpmn:dataObjectReference id="order" name="Bestellung" dataObjectRef="order_do" />
    <bpmn:dataObject id="order_do" />
  </bpmn:process>`);
    const lc = await readBoth(xml);
    expect(lc.associations).toBeUndefined();
  });

  const twoSources = (extraNode = '') => definitions(`  <bpmn:process id="Process_order" isExecutable="false">
    <bpmn:task id="t" name="Bestellung prüfen">
      <bpmn:property id="t_prop" name="__targetRef_placeholder" />
      <bpmn:dataInputAssociation id="read">
        <bpmn:sourceRef>order</bpmn:sourceRef>
        <bpmn:sourceRef>stock</bpmn:sourceRef>
        <bpmn:targetRef>t_prop</bpmn:targetRef>
      </bpmn:dataInputAssociation>
    </bpmn:task>
    ${extraNode}
    <bpmn:dataObjectReference id="order" name="Bestellung" dataObjectRef="order_do" />
    <bpmn:dataObject id="order_do" />
    <bpmn:dataStoreReference id="stock" name="Lagerbestand" />
  </bpmn:process>`);

  test('two sourceRefs give <id> and <id>_2', async () => {
    const lc = await readBoth(twoSources());
    expect(lc.associations).toEqual([
      { id: 'read', source: 'order', target: 't', directed: true },
      { id: 'read_2', source: 'stock', target: 't', directed: true },
    ]);
  });

  test('a minted id avoids an id the document already uses', async () => {
    const lc = await readBoth(twoSources('<bpmn:task id="read_2" name="Lieferung planen" />'));
    expect(lc.associations).toEqual([
      { id: 'read', source: 'order', target: 't', directed: true },
      { id: 'read_3', source: 'stock', target: 't', directed: true },
    ]);
    expect(validateLogicCoreSchema(lc)).toEqual({ valid: true, errors: [] });
  });

  test('both readers ignore a data association the schema does not allow on its element', async () => {
    // An input on a gateway or a start event and an output on an end event are not read; the id
    // of the gateway's element does not count as used, so the minted suffix is `_2` in both readers.
    const xml = definitions(`  <bpmn:process id="Process_order" isExecutable="false">
    <bpmn:startEvent id="s" name="Bestellung eingegangen">
      <bpmn:dataInputAssociation id="start_reads">
        <bpmn:sourceRef>order</bpmn:sourceRef>
      </bpmn:dataInputAssociation>
    </bpmn:startEvent>
    <bpmn:task id="t" name="Bestellung prüfen">
      <bpmn:property id="t_prop" name="__targetRef_placeholder" />
      <bpmn:dataInputAssociation id="read">
        <bpmn:sourceRef>order</bpmn:sourceRef>
        <bpmn:sourceRef>stock</bpmn:sourceRef>
        <bpmn:targetRef>t_prop</bpmn:targetRef>
      </bpmn:dataInputAssociation>
    </bpmn:task>
    <bpmn:exclusiveGateway id="g" name="Bestellung vollständig?">
      <bpmn:dataInputAssociation id="read_2">
        <bpmn:sourceRef>order</bpmn:sourceRef>
      </bpmn:dataInputAssociation>
    </bpmn:exclusiveGateway>
    <bpmn:endEvent id="e" name="Bestellung abgeschlossen">
      <bpmn:dataInputAssociation id="end_reads">
        <bpmn:sourceRef>stock</bpmn:sourceRef>
      </bpmn:dataInputAssociation>
      <bpmn:dataOutputAssociation id="end_writes">
        <bpmn:targetRef>order</bpmn:targetRef>
      </bpmn:dataOutputAssociation>
    </bpmn:endEvent>
    <bpmn:dataObjectReference id="order" name="Bestellung" dataObjectRef="order_do" />
    <bpmn:dataObject id="order_do" />
    <bpmn:dataStoreReference id="stock" name="Lagerbestand" />
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="t" />
    <bpmn:sequenceFlow id="f2" sourceRef="t" targetRef="g" />
    <bpmn:sequenceFlow id="f3" sourceRef="g" targetRef="e" />
  </bpmn:process>`);
    const lc = await readBoth(xml);
    expect(lc.associations).toEqual([
      { id: 'read', source: 'order', target: 't', directed: true },
      { id: 'read_2', source: 'stock', target: 't', directed: true },
      { id: 'end_reads', source: 'stock', target: 'e', directed: true },
    ]);
  });

  test('throw and catch events', async () => {
    const xml = definitions(`  <bpmn:process id="Process_order" isExecutable="false">
    <bpmn:startEvent id="s" name="Bestellung eingegangen" />
    <bpmn:intermediateThrowEvent id="notify" name="Bestellung gemeldet">
      <bpmn:dataInputAssociation id="notify_reads">
        <bpmn:sourceRef>order</bpmn:sourceRef>
      </bpmn:dataInputAssociation>
    </bpmn:intermediateThrowEvent>
    <bpmn:intermediateCatchEvent id="confirm" name="Bestätigung erhalten">
      <bpmn:dataOutputAssociation id="confirm_writes">
        <bpmn:targetRef>order</bpmn:targetRef>
      </bpmn:dataOutputAssociation>
      <bpmn:messageEventDefinition id="confirm_def" />
    </bpmn:intermediateCatchEvent>
    <bpmn:endEvent id="e" name="Bestellung abgeschlossen" />
    <bpmn:dataObjectReference id="order" name="Bestellung" dataObjectRef="order_do" />
    <bpmn:dataObject id="order_do" />
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="notify" />
    <bpmn:sequenceFlow id="f2" sourceRef="notify" targetRef="confirm" />
    <bpmn:sequenceFlow id="f3" sourceRef="confirm" targetRef="e" />
  </bpmn:process>`);
    const lc = await readBoth(xml);
    expect(lc.associations).toEqual([
      { id: 'notify_reads', source: 'order', target: 'notify', directed: true },
      { id: 'confirm_writes', source: 'confirm', target: 'order', directed: true },
    ]);
  });

  test('regenerating the import writes plain directed associations', async () => {
    const lc = await bpmnToLogicCore(readFileSync(REVIEW_SET, 'utf8'));
    const r = await runPipeline(lc);
    const xml = r.bpmnXml;
    for (const id of ['DataInputAssociation_0q9hrq8', 'DataOutputAssociation_04pjgr8', 'DataInputAssociation_190gulw']) {
      const el = xml.match(new RegExp(`<bpmn:association [^>]*id="${id}"[^>]*>`))?.[0];
      expect({ id, el: el ?? null }).toEqual({ id, el: expect.stringContaining('associationDirection="One"') });
      expect(xml).toContain(`bpmnElement="${id}"`);
    }
    expect(xml).not.toMatch(/dataInputAssociation|dataOutputAssociation/);
    expect(r.validation.xmlWarnings).toEqual([]);
  });
});

describe('the writer keeps an association whose two ends are nested', () => {
  const nestedModel = () => ({
    id: 'Process_order', name: 'Bestellung',
    nodes: [
      { id: 's', type: 'startEvent', name: 'Bestellung eingegangen' },
      {
        id: 'sp', type: 'subProcess', name: 'Bestellung bearbeiten', isExpanded: true,
        nodes: [
          { id: 'ss', type: 'startEvent', name: 'Beginn' },
          { id: 'st', type: 'task', name: 'Bestellung prüfen' },
          { id: 'se', type: 'endEvent', name: 'Geprüft' },
          { id: 'sn', type: 'textAnnotation', name: 'Vier-Augen-Prinzip' },
        ],
        edges: [{ id: 'sf1', source: 'ss', target: 'st' }, { id: 'sf2', source: 'st', target: 'se' }],
      },
      { id: 'e', type: 'endEvent', name: 'Bestellung bearbeitet' },
    ],
    edges: [{ id: 'f1', source: 's', target: 'sp' }, { id: 'f2', source: 'sp', target: 'e' }],
    associations: [{ id: 'a1', source: 'sn', target: 'st' }],
  });

  test('an association between two nested nodes is written', async () => {
    const r = await runPipeline(nestedModel());
    expect(r.validation.xmlWarnings).toEqual([]);
    expect(r.bpmnXml.match(/<bpmn:association /g)).toHaveLength(1);
    expect(r.bpmnXml).toMatch(/<bpmn:association [^>]*id="a1"[^>]*sourceRef="sn"[^>]*targetRef="st"/);
    expect(r.bpmnXml).toContain('<bpmndi:BPMNEdge id="a1_di" bpmnElement="a1">');
    expect(r.bpmnXml).not.toContain('bpmnElement="undefined"');
    const back = await readBoth(r.bpmnXml);
    expect(back.associations).toEqual([{ id: 'a1', source: 'sn', target: 'st', directed: false }]);
  });

  test('a cross-pool association with a top-level end keeps its pool', async () => {
    const lc = {
      pools: [
        {
          id: 'P1', name: 'Vertrieb',
          nodes: [
            { id: 's1', type: 'startEvent', name: 'Bestellung eingegangen' },
            {
              id: 'sp1', type: 'subProcess', name: 'Bestellung bearbeiten', isExpanded: true,
              nodes: [
                { id: 'ss1', type: 'startEvent', name: 'Beginn' },
                { id: 'st1', type: 'task', name: 'Bestellung prüfen' },
                { id: 'se1', type: 'endEvent', name: 'Geprüft' },
              ],
              edges: [{ id: 'sf1', source: 'ss1', target: 'st1' }, { id: 'sf2', source: 'st1', target: 'se1' }],
            },
            { id: 'e1', type: 'endEvent', name: 'Bestellung bearbeitet' },
          ],
          edges: [{ id: 'f1', source: 's1', target: 'sp1' }, { id: 'f2', source: 'sp1', target: 'e1' }],
        },
        {
          id: 'P2', name: 'Lager',
          nodes: [
            { id: 's2', type: 'startEvent', name: 'Auftrag eingegangen' },
            { id: 't2', type: 'task', name: 'Ware kommissionieren' },
            { id: 'e2', type: 'endEvent', name: 'Ware bereit' },
            { id: 'n2', type: 'textAnnotation', name: 'Nach Lagerplatz sortiert' },
          ],
          edges: [{ id: 'g1', source: 's2', target: 't2' }, { id: 'g2', source: 't2', target: 'e2' }],
        },
      ],
      associations: [{ id: 'cross', source: 'n2', target: 'st1' }],
    };
    const r = await runPipeline(lc);
    const processes = [...r.bpmnXml.matchAll(/<bpmn:process id="([^"]+)"[\s\S]*?<\/bpmn:process>/g)];
    const owner = processes.filter(m => m[0].includes('<bpmn:association id="cross"')).map(m => m[1]);
    expect(owner).toEqual(['P2']);
  });
});

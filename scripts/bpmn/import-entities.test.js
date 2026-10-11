/**
 * Both importers decode XML character data the same way. The legacy (DOM) parser used to decode
 * only the five named entities, so a name written as `&#38;` came back as `Check A &#38; B`,
 * and element text (documentation, scripts, conditions) was not decoded at all.
 */
import { describe, test, expect } from '@jest/globals';
import { runPipeline } from './pipeline.js';
import { bpmnToLogicCore, bpmnToLogicCoreLegacy } from './import.js';

const NAMES = [
  'Check A & B',
  'x < y > z',
  'say "hi" and \'bye\'',
  'Prüfung für Größe – 日本語 😀',
  '&lt; literal entity text',
];

const lcWith = (name, documentation) => ({
  id: 'p', name: 'P',
  nodes: [
    { id: 's', type: 'startEvent', name: 'Start' },
    { id: 't', type: 'task', name, documentation },
    { id: 'e', type: 'endEvent', name: 'End' },
  ],
  edges: [{ source: 's', target: 't' }, { source: 't', target: 'e' }],
});

const importers = async (xml) => [
  ['moddle', await bpmnToLogicCore(xml)],
  ['legacy', bpmnToLogicCoreLegacy(xml)],
];

describe('XML character data round-trips through both importers', () => {
  test.each(NAMES)('pipeline output, name and documentation: %s', async (text) => {
    const r = await runPipeline(lcWith(text, text));
    for (const [, lc] of await importers(r.bpmnXml)) {
      const t = lc.nodes.find((n) => n.id === 't');
      expect(t.name).toBe(text);
      expect(t.documentation).toBe(text);
    }
  });

  const xmlWith = (name, doc) => `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d" targetNamespace="http://x">
  <bpmn:process id="p" name="P" isExecutable="false">
    <bpmn:startEvent id="s" name="Start"/>
    <bpmn:task id="t" name="${name}"><bpmn:documentation>${doc}</bpmn:documentation></bpmn:task>
    <bpmn:endEvent id="e" name="End"/>
    <bpmn:sequenceFlow id="f1" sourceRef="s" targetRef="t"/>
    <bpmn:sequenceFlow id="f2" sourceRef="t" targetRef="e"/>
  </bpmn:process>
</bpmn:definitions>`;

  test.each([
    ['Check A &#38; B', 'Check A & B'],
    ['Check A &#x26; B', 'Check A & B'],
    ['Check A &#X26; B', 'Check A & B'],
    ['&amp;lt; stays', '&lt; stays'],
    ['&#60;tag&#62;', '<tag>'],
    ['&quot;q&quot; &apos;a&apos;', '"q" \'a\''],
  ])('hand-written XML: %s', async (raw, expected) => {
    const xml = xmlWith(raw, raw);
    const imported = await importers(xml);
    for (const [who, lc] of imported) {
      const t = lc.nodes.find((n) => n.id === 't');
      expect([who, t.name]).toEqual([who, expected]);
      expect([who, t.documentation]).toEqual([who, expected]);
    }
  });

  // bpmn-moddle's sax layer truncates astral references and turns invalid ones into U+FFFD, so
  // these two are pinned for the legacy parser alone: it decodes an astral reference and leaves
  // an out-of-range one as written instead of throwing from String.fromCodePoint.
  test('legacy parser: astral reference decoded, invalid reference left as written', () => {
    const lc = bpmnToLogicCoreLegacy(xmlWith('&#x1F600; &#1114112; &#xD800;', 'x'));
    expect(lc.nodes.find((n) => n.id === 't').name).toBe('\u{1F600} &#1114112; &#xD800;');
  });
});

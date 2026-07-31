import { describe, test, expect } from '@jest/globals';
import { DmnModdle } from 'dmn-moddle';

describe('dmn-moddle dependency', () => {
  test('resolves and builds+serialises a minimal Decision with DMNDI (bpmn-io/dmn-moddle own test/spec/xml/write.js, "dmn:Decision")', async () => {
    const moddle = new DmnModdle();

    const definitions = moddle.create('dmn:Definitions');
    const decision = moddle.create('dmn:Decision', { id: 'Decision_1', name: 'Decision_1' });
    definitions.get('drgElement').push(decision);

    const bounds = moddle.create('dc:Bounds', { height: 80, width: 180, x: 100, y: 100 });
    const shape = moddle.create('dmndi:DMNShape', { id: 'DMNShape_1', bounds, dmnElementRef: decision });
    const dmnDiagram = moddle.create('dmndi:DMNDiagram', { id: 'DMNDiagram_1', diagramElements: [shape] });
    const dmnDI = moddle.create('dmndi:DMNDI', { diagrams: [dmnDiagram] });
    definitions.set('dmnDI', dmnDI);

    const { xml } = await moddle.toXML(definitions, { preamble: false });

    // dmnElementRef resolved to the referenced element's own id, not a bare string we
    // passed in — confirms the isReference:true behaviour Task 5 depends on
    // (dmn-external-ground-truth.md §A.4, gotcha 1).
    expect(xml).toContain('<dmndi:DMNShape id="DMNShape_1" dmnElementRef="Decision_1">');
    expect(xml).toContain('<dmn:decision id="Decision_1" name="Decision_1" />');
  });
});

import { describe, test, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLexicon } from './lexicon.js';
import { verbFirst } from './verb-first.js';
import { verbLast } from './verb-last.js';
// TASK_TYPES / CONTAINER_TYPES / EVENT_TYPES: the ontology-derived sets of scripts/bpmn/types.js.
import { TASK_TYPES, CONTAINER_TYPES, EVENT_TYPES } from '../types.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tests', 'fixtures');
const languages = JSON.parse(readFileSync(join(root, 'rules-characterization', 'fixture-languages.json'), 'utf8'));
const s = verbFirst(loadLexicon('en'));

function processesOf(model) {
  return Array.isArray(model.pools) ? model.pools : [model];
}

function collect(model) {
  const out = { task: [], container: [], event: [], message: [] };
  const walk = (nodes) => {
    for (const n of nodes ?? []) {
      const name = n.name;
      if (typeof name === 'string' && name !== '') {
        if (CONTAINER_TYPES.has(n.type)) out.container.push(name);
        else if (TASK_TYPES.has(n.type)) out.task.push(name);
        else if (EVENT_TYPES.has(n.type)) out.event.push(name);
      }
      walk(n.nodes);
    }
  };
  for (const p of processesOf(model)) walk(p.nodes);
  for (const m of model.messageFlows ?? []) if (typeof m.name === 'string' && m.name !== '') out.message.push(m.name);
  return out;
}

const english = Object.entries(languages).filter(([, l]) => l === 'en').map(([f]) => f);
const judge = { task: s.taskName, container: s.containerName, event: s.eventName, message: s.messageName };

describe('fixture language map', () => {
  test('covers exactly the top-level fixtures, 13 German and 15 English', async () => {
    const { readdirSync } = await import('node:fs');
    const top = readdirSync(root).filter((f) => f.endsWith('.json') && !f.endsWith('.expected.json')).sort();
    expect(Object.keys(languages).sort()).toEqual(top);
    expect(Object.values(languages).filter((l) => l === 'de')).toHaveLength(13);
    expect(english).toHaveLength(15);
  });
});

describe('English fixture labels', () => {
  const flagged = { task: {}, container: {}, event: {}, message: {} };
  for (const file of english) {
    const labels = collect(JSON.parse(readFileSync(join(root, file), 'utf8')));
    for (const kind of Object.keys(labels)) {
      for (const name of labels[kind]) {
        if (judge[kind](name) !== null) (flagged[kind][file.replace('.json', '')] ??= []).push(name);
      }
    }
  }
  test('the flagged labels are exactly the expected ones', () => {
    const steps = Array.from({ length: 20 }, (_, i) => `Step ${i + 1}`);
    expect(flagged).toEqual({
      task: {
        'all-element-classes': ['Check', 'Escalate'],
        'deadlock-process': ['Path A', 'Path B', 'Continue'],
        'wrapping-back-edge': steps,
      },
      container: {
        'subprocess-collapsed-children': ['Validate'],
      },
      event: {},
      message: { 'loop-with-join': ['Order received'], 'realistic-collaboration': ['Case closed'] },
    });
  });
});

describe('German fixture labels', () => {
  const g = verbLast(loadLexicon('de'));
  const judgeDe = { task: g.taskName, container: g.containerName, event: g.eventName, message: g.messageName };
  const german = Object.entries(languages).filter(([, l]) => l === 'de').map(([f]) => f);
  const flagged = { task: {}, container: {}, event: {}, message: {} };
  for (const file of german) {
    const labels = collect(JSON.parse(readFileSync(join(root, file), 'utf8')));
    for (const kind of Object.keys(labels)) {
      for (const name of labels[kind]) {
        if (judgeDe[kind](name) !== null) (flagged[kind][file.replace('.json', '')] ??= []).push(name);
      }
    }
  }
  test('the flagged labels are exactly the expected ones', () => {
    const steps = Array.from({ length: 25 }, (_, i) => `Schritt ${i + 1}`);
    expect(flagged).toEqual({
      task: {
        'dense-edge-labels': ['A', 'B', 'C', 'D', 'E'].map((x) => `Variante ${x}`),
        'example-rechnungspruefung': ['Klärung mit Lieferant'],
        'example-schadenmeldung': ['Rückfrage an Versicherungsnehmer'],
        'example-urlaubsantrag': ['Erinnerung an Vorgesetzten'],
        'expanded-subprocess': ['Vorprüfung'],
        'long-lane-names': ['Erfassen', 'Prüfen', 'Freigeben'],
        'wide-pipeline': steps,
      },
      container: {},
      event: {},
      message: {},
    });
  });
});

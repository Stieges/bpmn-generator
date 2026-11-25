/**
 * bpmnlint over the generator's output: every top-level fixture, default options, linted with
 * `bpmnlint:recommended` + `plugin:@miragon/rules/recommended-for-modeling` (flow-target-alignment
 * off). Prints `{ "<fixture>": ["<category> <rule> <element id>", …] }` (sorted; `null` for a
 * fixture the rule engine blocks on purpose) to stdout.
 *
 *   node bench/bpmnlint-fixtures.mjs                # every top-level fixture
 *   node bench/bpmnlint-fixtures.mjs a.json b.json  # these fixtures only
 *   node bench/bpmnlint-fixtures.mjs --reuse-check  # does a reused Linter leak rule state?
 *
 * A plain Node process on purpose: bpmnlint is CommonJS and require()s min-dash, which is ESM-only.
 * Node (20.19+, 22.12+) loads that; Jest's module runtime does not, so bpmnlint.test.js runs this
 * script as a child process.
 *
 * A fresh Linter per document: bpmnlint caches rule instances across lint() calls, and stateful
 * rules (no-duplicate-sequence-flows keeps a map in its factory closure) then report every flow of
 * a second document as a duplicate (--reuse-check shows it).
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BpmnModdle } from 'bpmn-moddle';
import { runPipeline } from '../bpmn/pipeline.js';
import { isMainModule } from '../shared/entry-point.js';

const require = createRequire(import.meta.url);
const { Linter } = require('bpmnlint');
const NodeResolver = require('bpmnlint/lib/resolver/node-resolver');

const CONFIG = {
  extends: ['bpmnlint:recommended', 'plugin:@miragon/rules/recommended-for-modeling'],
  rules: { '@miragon/rules/flow-target-alignment': 'off' },
};

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');

const newLinter = (config = CONFIG) => new Linter({ config, resolver: new NodeResolver({ require }) });

async function rootOf(xml) {
  const { rootElement, warnings } = await new BpmnModdle().fromXML(xml);
  if (warnings.length) throw new Error(`bpmn-moddle import warnings: ${warnings.map((w) => w.message).join('; ')}`);
  return rootElement;
}

const flatten = (reports) => Object.entries(reports)
  .flatMap(([rule, list]) => list.map((rep) => `${rep.category} ${rule} ${rep.id}`))
  .sort();

export async function lintFixture(name) {
  const r = await runPipeline(JSON.parse(readFileSync(join(fixturesDir, name), 'utf8')));
  if (!r.bpmnXml) return null;
  return flatten(await newLinter().lint(await rootOf(r.bpmnXml)));
}

export async function reuseCheck() {
  const r = await runPipeline(JSON.parse(readFileSync(join(fixturesDir, 'simple-approval.json'), 'utf8')));
  const linter = newLinter({ rules: { 'no-duplicate-sequence-flows': 'error' } });
  const once = flatten(await linter.lint(await rootOf(r.bpmnXml)));
  const twice = flatten(await linter.lint(await rootOf(r.bpmnXml)));
  return { once, twice };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2);
  if (args[0] === '--reuse-check') {
    console.log(JSON.stringify(await reuseCheck()));
  } else {
    const names = args.length ? args : readdirSync(fixturesDir).filter((f) => f.endsWith('.json')).sort();
    const out = {};
    for (const name of names) out[name] = await lintFixture(name);
    console.log(JSON.stringify(out));
  }
}

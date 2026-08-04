import { beforeAll, describe, test, expect } from '@jest/globals';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';

import {
  DMN_ELEMENT_COVERAGE, DMN_NESTED_TYPE_COVERAGE, DMN_XSD_DEFAULTS, DMN_ELEMENT_BASE,
  IMPORT_CODES, IMPORT_CODE_KINDS, BLIND_MECHANISMS, coverageForElement, coverageForModdleType,
} from './import-scope.js';
import { HANDLERS, dmnToDecisionCore, moddleToDecisionCore } from './import.js';

/**
 * TWO ORACLES, NEITHER RESTATED HERE.
 *
 * Oracle A is the normative XSD (`references/omg-spec/normative/dmn/`) — it says what a conformant
 * file may CONTAIN. Oracle B is dmn-moddle's own descriptors (`dmn-moddle/resources/dmn/json/`) —
 * they say what our parser can SURFACE. Both are read at test time; the table under test is never
 * allowed to be its own evidence.
 *
 * One oracle was not enough, and the reason is measurable rather than theoretical. A registry-only
 * fence asks dmn-moddle "does every type you know have a row?". It knows `dmn:OrganisationalUnit`,
 * so a row exists, so the fence is green — while a conformant file writes `<organizationUnit>`, the
 * AMERICAN spelling the XSD declares (DMN13.xsd:132), which dmn-moddle cannot parse at all:
 *
 *   <organizationUnit id="ou1" name="Finance"/>
 *   → warnings: ['unparsable content <organizationUnit> detected … unknown type
 *                <dmn:OrganizationUnit>']
 *   → businessContextElement: 0   — the element is GONE from the tree
 *
 * An internally consistent table is consistent with itself regardless of what it claims about the
 * world. Only the divergence BETWEEN the two oracles exposes that class of gap, which is what F2
 * measures.
 */

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const XSD_DIR = path.join(HERE, '..', '..', 'references', 'omg-spec', 'normative', 'dmn');

// ── Oracle A ────────────────────────────────────────────────────────────────────────────────────

/**
 * A depth-tracking tag scan rather than a `^\t<xsd:element` line match: "global" means "a direct
 * child of xsd:schema", and indentation is a formatting accident that a re-download could change
 * without changing a single declaration. The scan is deliberately small — these four files are
 * frozen normative artefacts with no CDATA, no comments carrying `<`, and no namespace surprises,
 * so a full XML parser would buy nothing and would mean a new dependency.
 */
function scanXsd(xsdFile) {
  const text = readFileSync(path.join(XSD_DIR, `${xsdFile}.xsd`), 'utf8');
  const tag = /<(\/?)(?:xsd:)?([A-Za-z][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  const globalElements = [];
  const defaults = [];
  const complexTypes = [];
  const open = [];
  let m;
  while ((m = tag.exec(text))) {
    const [, closing, tagName, attrs, selfClosing] = m;
    if (closing) { open.pop(); continue; }
    const name = attrs.match(/\bname="([^"]*)"/)?.[1] ?? null;
    if (tagName === 'element' && open.length === 1) {
      globalElements.push({
        xsdFile, name,
        abstract: /\babstract="true"/.test(attrs),
        // The element's declared TYPE, kept because "the element is not abstract" and "the element
        // can appear in a document" are different questions — see `UNINSTANTIABLE` below.
        type: attrs.match(/\btype="([^"]*)"/)?.[1] ?? null,
      });
    }
    if (tagName === 'complexType' && name) {
      complexTypes.push({ xsdFile, name, abstract: /\babstract="true"/.test(attrs) });
    }
    const dflt = attrs.match(/\bdefault="([^"]*)"/)?.[1];
    if (tagName === 'attribute' && dflt !== undefined) {
      // The owning complexType is the nearest enclosing `<xsd:complexType name="…">`.
      const owner = [...open].reverse().find((o) => o.tagName === 'complexType')?.name ?? null;
      defaults.push({ xsdFile, ownerType: owner, attr: name, xsdDefault: dflt });
    }
    if (!selfClosing) open.push({ tagName, name });
  }
  return { globalElements, defaults, complexTypes };
}

/**
 * Two of the four, and the reason is containment — NOT unreachability. Getting this justification
 * right matters more than it looks: an earlier draft of this comment claimed no conformant `.dmn`
 * can contain a DC or DI global element at all, and that was simply untrue about the world, which is
 * the exact failure mode this file's preamble warns about.
 *
 * Measured against both XSDs: of the five global elements DC and DI declare, exactly two are
 * reachable in a conformant document, and by `ref=` to the GLOBAL element rather than by a local
 * declaration — `<xsd:element ref="dc:Bounds"/>` inside `di:Shape` (DI.xsd:74) and
 * `<xsd:element ref="di:Style"/>` inside `di:DiagramElement` (DI.xsd:33), both of which
 * `dmndi:DMNShape` and `dmndi:DMNEdge` extend. A real `.dmn` therefore does contain
 * `<dc:Bounds x=… y=…/>` in its DI, and `<dmndi:DMNStyle>` substitutes for the `di:Style` ref. The
 * other three (`Color`, `Point`, `Dimension`) appear only as the TYPE of a local element
 * (`<waypoint>`, `<Size>`, `<FillColor>`), never as elements in their own right.
 *
 * They need no rows anyway, for the reason that actually applies: their only containers —
 * `<DMNShape>`, `<DMNEdge>`, `<DMNDiagram>` — are `reported` (IM06), so their content is dropped
 * with them. Same rule that keeps `dmn:Binding` out: a construct behind a reported one is covered by
 * that one. `<DMNStyle>` already has a row of its own.
 *
 * The defaults scan below reads all four regardless, because a default is a fact about an attribute
 * wherever its owner is used.
 */
const XSD_FILES_WITH_ELEMENTS = ['DMN13', 'DMNDI13'];
// F4 reads all four: DC.xsd and DI.xsd declare no defaults today, and the fence should say so by
// looking rather than by our leaving them out.
const XSD_FILES_WITH_DEFAULTS = ['DMN13', 'DMNDI13', 'DC', 'DI'];

const XSD_ELEMENTS = XSD_FILES_WITH_ELEMENTS
  .flatMap((f) => scanXsd(f).globalElements)
  .filter((e) => !e.abstract);   // an abstract head is a substitution-group anchor, never in a file

const XSD_DEFAULTS = XSD_FILES_WITH_DEFAULTS.flatMap((f) => scanXsd(f).defaults);

/**
 * Which complexTypes the four XSDs declare `abstract="true"`, keyed `file:LocalName`, plus the
 * prefix→file map needed to resolve a `type="di:DiagramElement"` reference to one of them. Read from
 * all four, since an element declared in DMNDI13 may be typed by DI.
 */
const XSD_ABSTRACT_TYPES = new Set(
  XSD_FILES_WITH_DEFAULTS.flatMap((f) => scanXsd(f).complexTypes)
    .filter((t) => t.abstract).map((t) => `${t.xsdFile}:${t.name}`),
);
const XSD_FILE_OF_PREFIX = { dmn: 'DMN13', dmndi: 'DMNDI13', dc: 'DC', di: 'DI' };

/**
 * A global element no XSD-valid document can contain — because its declared TYPE is abstract, even
 * though the element declaration itself is not.
 *
 * Exactly one such element exists and it is the reason this function does: DMNDI13.xsd:16 declares
 * `<DMNDiagramElement>` without `abstract="true"` (which is why F1's mechanical rule gives it a row)
 * and types it `di:DiagramElement`, which DI.xsd:23 declares `abstract="true"`. F3 has to leave it
 * out of the set the fixture is measured against, and derives that exclusion here rather than
 * carrying a name — the day a spec revision makes the type concrete, or a second element acquires
 * the same shape, the derivation follows and the hand list would not.
 */
function typeIsAbstract(element) {
  if (!element?.type) return false;
  const [maybePrefix, local] = element.type.includes(':') ? element.type.split(':') : [null, element.type];
  const file = maybePrefix ? XSD_FILE_OF_PREFIX[maybePrefix] : element.xsdFile;
  return XSD_ABSTRACT_TYPES.has(`${file}:${local}`);
}

// ── Oracle B ────────────────────────────────────────────────────────────────────────────────────

const PACKAGES = ['dmn13', 'dmndi13', 'dc', 'di']
  .map((f) => require(`dmn-moddle/resources/dmn/json/${f}.json`));

/** Every descriptor, keyed `prefix:Name` — the identity our rows use. */
const DESCRIPTORS = new Map(
  PACKAGES.flatMap((pkg) => pkg.types.map((t) => [`${pkg.prefix}:${t.name}`, { ...t, prefix: pkg.prefix }])),
);

/**
 * XSD element name → moddle type, by moddle's OWN naming rule rather than by a table of ours:
 * a package declaring `xml.tagAlias === 'lowerCase'` (dmn13 does, dmndi13 does not) is read with the
 * type name's first letter lowered. That is exactly the rule the parser applies, which is why a
 * spelling the rule cannot reach is genuinely unreachable and not merely unlisted.
 */
const TAG_TO_TYPE = new Map();
for (const pkg of PACKAGES) {
  const lower = pkg.xml?.tagAlias === 'lowerCase';
  for (const t of pkg.types) {
    const tag = lower ? t.name[0].toLowerCase() + t.name.slice(1) : t.name;
    TAG_TO_TYPE.set(`${pkg.prefix}|${tag}`, `${pkg.prefix}:${t.name}`);
  }
}
const PREFIX_OF_XSD_FILE = { DMN13: 'dmn', DMNDI13: 'dmndi' };
const resolveTag = (row) => TAG_TO_TYPE.get(`${PREFIX_OF_XSD_FILE[row.xsdFile]}|${row.xsdElement}`);

/** A moddle `superClass` / property `type` may be written unprefixed, meaning "same package". */
const qualify = (name, prefix) => (name.includes(':') ? name : `${prefix}:${name}`);

/** Descriptor property objects, including everything inherited through `superClass`. */
function propertyDescriptorsOf(typeName, seen = new Set()) {
  if (seen.has(typeName)) return [];
  seen.add(typeName);
  const d = DESCRIPTORS.get(typeName);
  if (!d) return [];
  const prefix = typeName.split(':')[0];
  const inherited = (d.superClass ?? []).flatMap((s) => propertyDescriptorsOf(qualify(s, prefix), seen));
  return [...inherited, ...(d.properties ?? [])];
}

const propertiesOf = (typeName) => propertyDescriptorsOf(typeName).map((p) => p.name);

/** The type itself plus everything it inherits from, transitively. */
function ancestryOf(typeName, seen = new Set()) {
  if (seen.has(typeName) || !DESCRIPTORS.has(typeName)) return [...seen];
  seen.add(typeName);
  const prefix = typeName.split(':')[0];
  for (const s of DESCRIPTORS.get(typeName).superClass ?? []) ancestryOf(qualify(s, prefix), seen);
  return [...seen];
}

/**
 * `DMN_ELEMENT_BASE` is a statement about what `tDMNElement` contributes, so only a type that
 * actually inherits it may draw on that statement. Three of the nested types
 * (`dmn:DMNElementReference`, `dmn:RuleAnnotation`, `dmn:RuleAnnotationClause`) do not extend
 * `tDMNElement` at all — DMN gives them no id, no label, no extension points — and handing them the
 * hoist's free pass would excuse a property the hoist says nothing about. Vacuous today, since none
 * of the three declares one of those names; it stops being vacuous the moment a dmn-moddle release
 * gives one of them its own `label`.
 */
const inheritsBase = (typeName) => ancestryOf(typeName).includes('dmn:DMNElement');
const baseCoverageFor = (typeName) => (inheritsBase(typeName) ? Object.keys(DMN_ELEMENT_BASE) : []);

/**
 * The types a mapped row's own properties lead to, that have no row of their own — `dmn:InputClause`
 * behind `<decisionTable>.input`, `dmn:UnaryTests` two steps behind it, and so on. Without this,
 * F1b fences the twelve top-level types and stops: `UnaryTests.expressionLanguage` would be dropped
 * on every rule cell of every imported table with no fence noticing, while the identical drop on
 * `LiteralExpression` is listed with a reason.
 *
 * The link between a property and the type behind it comes from Oracle B's own `type` field, NOT
 * from reading our prose. `mapsTo`'s KEYS are property names and are machine-read; its VALUES are
 * sentences for humans, and deriving a type by regexing them would restate the oracle inside the
 * fence — the exact failure this stage exists to prevent.
 *
 * Traversal follows `mapsTo` keys only, never `unrepresented` ones: a property already declared
 * dropped takes its subtree with it, so `LiteralExpression.importedValues` does not drag
 * `dmn:ImportedValues` in to be documented for a path the importer never walks. Rows and abstract
 * heads terminate the walk — a row is fenced by F1b already, and an abstract head's properties are
 * checked on each concrete type that inherits them.
 */
function nestedClosure() {
  const rowTypes = new Set(DMN_ELEMENT_COVERAGE.map((r) => r.moddleType).filter(Boolean));
  const reached = new Map();          // moddle type → Set of the paths that reach it
  const queue = [];

  const follow = (label, typeName, mapsTo) => {
    const byName = new Map(propertyDescriptorsOf(typeName).map((p) => [p.name, p]));
    for (const key of Object.keys(mapsTo ?? {})) {
      const target = byName.get(key)?.type;
      if (!target) continue;                                   // a string/boolean-valued property
      const qualified = qualify(target, typeName.split(':')[0]);
      const d = DESCRIPTORS.get(qualified);
      if (!d || d.isAbstract || rowTypes.has(qualified)) continue;
      queue.push([qualified, `${label}.${key}`]);
    }
  };

  for (const row of DMN_ELEMENT_COVERAGE.filter((r) => r.disposition === 'mapped')) {
    follow(`<${row.xsdElement}>`, row.moddleType, row.mapsTo);
  }
  while (queue.length) {
    const [typeName, from] = queue.shift();
    if (!reached.has(typeName)) reached.set(typeName, new Set());
    if (reached.get(typeName).has(from)) continue;
    reached.get(typeName).add(from);
    // An unlisted type contributes no further reach — which is correct rather than a shortcut: the
    // fence below names it as missing, and only once it has a mapsTo is there anything to follow.
    follow(typeName, typeName, DMN_NESTED_TYPE_COVERAGE.find((e) => e.moddleType === typeName)?.mapsTo);
  }
  return reached;
}

const HOWTO = 'see the row-writing guide at the top of scripts/dmn/import-scope.js';

// ── F1 — element completeness (Oracle A) ────────────────────────────────────────────────────────

describe('F1 — every non-abstract global element in the XSDs has exactly one row', () => {
  test('no element is unlisted, no row is stale, no element is listed twice', () => {
    const rows = new Map();
    for (const row of DMN_ELEMENT_COVERAGE) {
      const key = `${row.xsdFile}:${row.xsdElement}`;
      rows.set(key, (rows.get(key) ?? 0) + 1);
    }
    const declared = new Set(XSD_ELEMENTS.map((e) => `${e.xsdFile}:${e.name}`));

    // One flat list of instructions rather than three assertions: jest reports only the first
    // failure, and a table can be short a row AND carry a stale one at the same time. Each line
    // names the element and the action, so the failure is actionable without opening this file.
    const problems = [
      ...[...declared].filter((k) => !rows.has(k))
        .map((k) => `add a row to scripts/dmn/import-scope.js for <${k.split(':')[1]}> (${k.split(':')[0]}.xsd) — ${HOWTO}`),
      ...[...rows.keys()].filter((k) => !declared.has(k))
        .map((k) => `remove the stale row for <${k.split(':')[1]}>: ${k.split(':')[0]}.xsd declares no such global element`),
      ...[...rows].filter(([, n]) => n > 1)
        .map(([k]) => `remove the duplicate row for <${k.split(':')[1]}> (${k.split(':')[0]}.xsd)`),
    ];
    expect(problems).toEqual([]);
  });

  test('the scan found the XSDs at all — a silent empty oracle would pass every check above', () => {
    expect(XSD_ELEMENTS.length).toBeGreaterThan(20);
    expect(XSD_ELEMENTS.some((e) => e.name === 'decision')).toBe(true);
    expect(XSD_ELEMENTS.some((e) => e.name === 'DMNShape')).toBe(true);
    // The abstract heads really are dropped, so the filter is doing work rather than matching
    // nothing: `drgElement` is declared abstract="true" and must never earn a row.
    expect(XSD_ELEMENTS.some((e) => e.name === 'drgElement')).toBe(false);
  });

  test('every row carries what its disposition obliges it to carry', () => {
    const defects = [];
    for (const row of DMN_ELEMENT_COVERAGE) {
      const at = `<${row.xsdElement}>`;
      if (!['mapped', 'reported', 'parser-blind'].includes(row.disposition)) {
        defects.push(`${at}: unknown disposition ${JSON.stringify(row.disposition)}`);
        continue;
      }
      if (row.disposition === 'mapped') {
        if (!row.mapsTo || Object.keys(row.mapsTo).length === 0) {
          defects.push(`${at}: 'mapped' needs a non-empty mapsTo naming the Decision-Core slots`);
        }
      } else {
        if (!row.code) defects.push(`${at}: '${row.disposition}' needs a code`);
        if (!row.reason?.trim()) defects.push(`${at}: '${row.disposition}' needs a non-empty reason`);
      }
      for (const code of [row.code, ...(row.unrepresented ?? []).map((u) => u.code)].filter(Boolean)) {
        if (!IMPORT_CODES[code]) defects.push(`${at}: unknown code ${code} — add it to IMPORT_CODES`);
      }
      for (const u of row.unrepresented ?? []) {
        if (!u.reason?.trim()) defects.push(`${at}.${u.property}: an unrepresented property needs a reason`);
      }
    }
    expect(defects).toEqual([]);
  });

  test('every code has a title and a remedy a stranger can act on', () => {
    const bad = Object.entries(IMPORT_CODES)
      .filter(([, c]) => !c.title?.trim() || !c.remedy?.trim())
      .map(([id]) => `${id} needs a non-empty title and remedy`);
    expect(bad).toEqual([]);
    expect(Object.keys(IMPORT_CODES))
      .toEqual(['IM01', 'IM02', 'IM03', 'IM04', 'IM05', 'IM06', 'IM07', 'IM08', 'IM09']);
  });

  /**
   * The grouping axis lives on the table (judgment call 3 of Stage 4), so the fence that keeps a new
   * code from landing ungrouped lives here rather than in the formatter. Without it a code added
   * without a `kind` would render in the "unknown code" section — visible, but only to whoever
   * happened to read a report.
   */
  test('every code declares a kind the kind register knows, and every kind is used', () => {
    const kinds = Object.keys(IMPORT_CODE_KINDS);
    const defects = [
      ...Object.entries(IMPORT_CODES)
        .filter(([, c]) => !kinds.includes(c.kind))
        .map(([id, c]) => `${id} declares kind ${JSON.stringify(c.kind)} — must be one of ${kinds.join('|')}`),
      ...Object.entries(IMPORT_CODE_KINDS)
        .filter(([, k]) => !k.label?.trim() || !k.blurb?.trim())
        .map(([id]) => `IMPORT_CODE_KINDS.${id} needs a non-empty label and blurb`),
      // A kind nothing uses is a heading a reader will never see — either a code belongs on it or it
      // belongs deleted.
      ...kinds.filter((k) => !Object.values(IMPORT_CODES).some((c) => c.kind === k))
        .map((k) => `no code carries kind ${k} — remove the kind or move a code onto it`),
    ];
    expect(defects).toEqual([]);
  });
});

// ── F1b — property completeness (Oracle B) ──────────────────────────────────────────────────────

describe('F1b — every property of every mapped type is accounted for', () => {
  const mapped = DMN_ELEMENT_COVERAGE.filter((r) => r.disposition === 'mapped');

  test('there are mapped rows to check', () => {
    expect(mapped.length).toBeGreaterThan(5);
  });

  test.each(mapped.map((r) => [r.xsdElement, r]))(
    '<%s>: every descriptor property is either mapped or named unrepresented', (_name, row) => {
      const props = propertiesOf(row.moddleType);
      expect(props.length).toBeGreaterThan(0);   // a typo'd moddleType would silently check nothing
      const named = new Set([
        ...Object.keys(row.mapsTo ?? {}),
        ...(row.unrepresented ?? []).map((u) => u.property),
        ...baseCoverageFor(row.moddleType),
      ]);
      const unaccounted = props.filter((p) => !named.has(p))
        .map((p) => `<${row.xsdElement}>.${p} has no slot in mapsTo and no unrepresented entry — ${HOWTO}`);
      expect(unaccounted).toEqual([]);
    });

  test.each(mapped.map((r) => [r.xsdElement, r]))(
    '<%s>: nothing is claimed that the descriptor does not have', (_name, row) => {
      const props = new Set(propertiesOf(row.moddleType));
      const phantom = [
        ...Object.keys(row.mapsTo ?? {}),
        ...(row.unrepresented ?? []).map((u) => u.property),
      ].filter((p) => !props.has(p))
        .map((p) => `<${row.xsdElement}> claims property ${p}, which dmn:${row.moddleType} does not declare`);
      expect(phantom).toEqual([]);
    });

  /**
   * The hoist is only legitimate while it is genuinely uniform. Two conditions, both checked:
   * the property must be DECLARED on the shared base (not on some individual type that happened to
   * be convenient), and every type DRAWING on the hoist must actually inherit it. Either failing
   * means the property belongs on the rows, not in the base.
   *
   * The consumers are the mapped rows plus the nested entries that extend `tDMNElement` — and it is
   * `baseCoverageFor` that decides who those are, so the same predicate gates the free pass and this
   * assertion. A nested type outside `tDMNElement` (`dmn:DMNElementReference`, `dmn:RuleAnnotation`,
   * `dmn:RuleAnnotationClause`) neither draws on the hoist nor is measured against it.
   */
  test('the hoisted base properties are genuinely inherited by everything that draws on them', () => {
    const base = new Set(propertiesOf('dmn:DMNElement'));
    const consumers = [
      ...mapped.map((r) => [`<${r.xsdElement}>`, r.moddleType]),
      ...DMN_NESTED_TYPE_COVERAGE.map((e) => [e.moddleType, e.moddleType]),
    ].filter(([, t]) => baseCoverageFor(t).length > 0);
    const defects = [];
    for (const p of Object.keys(DMN_ELEMENT_BASE)) {
      if (!base.has(p)) defects.push(`${p} is not declared on dmn:DMNElement — it belongs on its rows`);
      for (const [label, type] of consumers) {
        if (!propertiesOf(type).includes(p)) {
          defects.push(`${label} does not inherit ${p} — the hoist is no longer uniform`);
        }
      }
    }
    expect(defects).toEqual([]);
    expect(consumers.length).toBeGreaterThan(mapped.length);   // the nested half really is included
  });

  // ── the nested half: types a mapped row leads to that have no row of their own ───────────────

  const REACHED = nestedClosure();
  const nestedEntry = (t) => DMN_NESTED_TYPE_COVERAGE.find((e) => e.moddleType === t);

  test('every nested type a mapped row leads to has exactly one entry, and none is stale', () => {
    const listed = new Map();
    for (const e of DMN_NESTED_TYPE_COVERAGE) listed.set(e.moddleType, (listed.get(e.moddleType) ?? 0) + 1);
    const problems = [
      ...[...REACHED.keys()].filter((t) => !listed.has(t)).map((t) => `add a DMN_NESTED_TYPE_COVERAGE `
        + `entry for ${t}, reached from ${[...REACHED.get(t)].sort().join(', ')} — ${HOWTO}`),
      ...[...listed.keys()].filter((t) => !REACHED.has(t)).map((t) => `remove the stale `
        + `DMN_NESTED_TYPE_COVERAGE entry for ${t}: no mapped row's mapsTo leads to it`),
      ...[...listed].filter(([, n]) => n > 1).map(([t]) => `remove the duplicate entry for ${t}`),
    ];
    expect(problems).toEqual([]);
    expect(REACHED.size).toBeGreaterThan(0);
  });

  /**
   * The invariant the whole two-oracle design rests on: one row per global element, and F1's set
   * equality against the XSDs. Nested coverage lives in its own export precisely so it cannot dilute
   * that — an entry duplicating a row would put the same construct in two authorities.
   */
  test('a nested entry never shadows a row', () => {
    const rowTypes = new Set(DMN_ELEMENT_COVERAGE.map((r) => r.moddleType).filter(Boolean));
    const shadowing = DMN_NESTED_TYPE_COVERAGE.filter((e) => rowTypes.has(e.moddleType))
      .map((e) => `${e.moddleType} has a row of its own — it must not also be a nested entry`);
    expect(shadowing).toEqual([]);
  });

  test.each(DMN_NESTED_TYPE_COVERAGE.map((e) => [e.moddleType, e]))(
    '%s: every property is either mapped or named unrepresented, and nothing is invented', (_t, entry) => {
      const props = propertiesOf(entry.moddleType);
      expect(props.length).toBeGreaterThan(0);
      const claimed = [
        ...Object.keys(entry.mapsTo ?? {}),
        ...(entry.unrepresented ?? []).map((u) => u.property),
      ];
      const named = new Set([...claimed, ...baseCoverageFor(entry.moddleType)]);
      expect([
        ...props.filter((p) => !named.has(p))
          .map((p) => `${entry.moddleType}.${p} has no slot in mapsTo and no unrepresented entry — ${HOWTO}`),
        ...claimed.filter((p) => !props.includes(p))
          .map((p) => `${entry.moddleType} claims property ${p}, which dmn-moddle does not declare`),
      ]).toEqual([]);
    });

  /**
   * `reachedFrom` is navigation, not decoration: `dmn:UnaryTests` is where a reader goes looking for
   * the per-cell `expressionLanguage` loss, and the entry has to say that it is arrived at through
   * `<decisionTable>`. Measured against the closure rather than trusted, so it cannot rot into a
   * description of an older graph.
   */
  test.each(DMN_NESTED_TYPE_COVERAGE.map((e) => [e.moddleType, e]))(
    '%s: reachedFrom is what the traversal actually finds', (_t, entry) => {
      expect([...(entry.reachedFrom ?? [])].sort()).toEqual([...(REACHED.get(entry.moddleType) ?? [])].sort());
    });

  /**
   * F1b's answer to the one thing its key-level checks could not see: a property whose fate depends
   * on the POSITION its element occupies, not on its type.
   *
   * The live case, and the defect that produced this check: `<literalExpression>.typeRef` is listed
   * unrepresented ("As `id` — the slot is a string"), which holds at four of the five positions a
   * literal expression can occupy — and is FALSE at `<inputExpression>`, where `dmn:InputClause`'s
   * own `mapsTo` says the typeRef becomes `InputClause.typeRef`, and where the importer really does
   * read it. Two entries of one table contradicting each other, joined only by a sentence — which is
   * why nothing caught it: F1b reads `mapsTo`'s KEYS and never its prose VALUES, deliberately, since
   * a fence that parsed our own sentences would be restating them as evidence.
   *
   * `exceptAt` is the row shape that lets a table entry state it, and all three of its halves are
   * checkable with machinery already here. The decisive one is RECIPROCITY: the container's entry
   * must list the container property among its `mapsTo` keys. That is a key-level check, it stays
   * clear of prose, and it is exactly what would have caught the original contradiction.
   */
  describe('exceptAt — a property read at one position and dropped at the others', () => {
    const allEntries = [
      ...DMN_ELEMENT_COVERAGE.filter((r) => r.disposition === 'mapped')
        .map((r) => ({ label: `<${r.xsdElement}>`, moddleType: r.moddleType, entry: r })),
      ...DMN_NESTED_TYPE_COVERAGE.map((e) => ({ label: e.moddleType, moddleType: e.moddleType, entry: e })),
    ];
    const exceptions = allEntries.flatMap(({ label, entry }) =>
      (entry.unrepresented ?? []).flatMap((u) =>
        (u.exceptAt ?? []).map((x) => ({ label, property: u.property, x }))));

    test('the known position-dependent read is stated in the table, not in import.js', () => {
      // The whole point of the column: `import.js` derives its behaviour from here, so this entry
      // existing is what makes the exception observable, fenceable and reviewable.
      expect(exceptions.map(({ label, property, x }) =>
        `${label}.${property}@${x.containerType}.${x.containerProperty}`))
        .toContain('<literalExpression>.typeRef@dmn:InputClause.inputExpression');
    });

    test('every exceptAt names a container this table knows', () => {
      const known = new Map([
        ...DMN_ELEMENT_COVERAGE.filter((r) => r.moddleType).map((r) => [r.moddleType, r]),
        ...DMN_NESTED_TYPE_COVERAGE.map((e) => [e.moddleType, e]),
      ]);
      const defects = exceptions
        .filter(({ x }) => !known.has(x.containerType))
        .map(({ label, property, x }) => `${label}.${property}: exceptAt names container type `
          + `${x.containerType}, which has neither a row nor a nested entry`);
      expect(defects).toEqual([]);
    });

    test('every exceptAt names a real descriptor property of that container', () => {
      const defects = exceptions
        .filter(({ x }) => !propertiesOf(x.containerType).includes(x.containerProperty))
        .map(({ label, property, x }) => `${label}.${property}: exceptAt names `
          + `${x.containerType}.${x.containerProperty}, which dmn-moddle does not declare`);
      expect(defects).toEqual([]);
    });

    /**
     * The half that would have caught the original defect. An exception claims "my container reads
     * me here" — so the container's entry has to actually say it reads that property. If it does
     * not, the two entries still disagree and the exception is the wrong half of the disagreement.
     */
    test('reciprocity — the container maps the property the exception hides behind', () => {
      const known = new Map([
        ...DMN_ELEMENT_COVERAGE.filter((r) => r.moddleType).map((r) => [r.moddleType, r]),
        ...DMN_NESTED_TYPE_COVERAGE.map((e) => [e.moddleType, e]),
      ]);
      const defects = exceptions
        .filter(({ x }) => !Object.keys(known.get(x.containerType)?.mapsTo ?? {}).includes(x.containerProperty))
        .map(({ label, property, x }) => `${label}.${property}: exceptAt claims `
          + `${x.containerType} reads it through .${x.containerProperty}, but that entry's mapsTo `
          + `does not list ${x.containerProperty} — the two entries still disagree`);
      expect(defects).toEqual([]);
    });

    test('every exceptAt says where the value lands, so the claim is checkable by a reader', () => {
      const defects = exceptions.filter(({ x }) => !x.readInto?.trim())
        .map(({ label, property }) => `${label}.${property}: an exceptAt needs a readInto naming the `
          + 'Decision-Core slot the value reaches');
      expect(defects).toEqual([]);
    });
  });

  test('every nested entry carries known codes and non-empty reasons', () => {
    const bad = DMN_NESTED_TYPE_COVERAGE.flatMap((e) => (e.unrepresented ?? [])
      .filter((u) => !IMPORT_CODES[u.code] || !u.reason?.trim())
      .map((u) => `${e.moddleType}.${u.property} needs a known code and a non-empty reason`));
    expect(bad).toEqual([]);
  });

  test('every hoisted base property carries a known code and a reason', () => {
    const bad = Object.entries(DMN_ELEMENT_BASE)
      .filter(([, v]) => !IMPORT_CODES[v.code] || !v.reason?.trim())
      .map(([p]) => `DMN_ELEMENT_BASE.${p} needs a known code and a non-empty reason`);
    expect(bad).toEqual([]);
  });
});

// ── F2 — the divergence between the oracles ─────────────────────────────────────────────────────

describe('F2 — a row resolves against dmn-moddle exactly when it claims the parser can see it', () => {
  test('mapped and reported rows resolve, and to the type the row names', () => {
    const defects = [];
    for (const row of DMN_ELEMENT_COVERAGE.filter((r) => r.disposition !== 'parser-blind')) {
      const resolved = resolveTag(row);
      if (!resolved) {
        defects.push(`<${row.xsdElement}> is '${row.disposition}', but dmn-moddle cannot parse that `
          + `element name at all — the disposition must become 'parser-blind' (IM08)`);
      } else if (resolved !== row.moddleType) {
        defects.push(`<${row.xsdElement}> names moddleType ${row.moddleType}, but dmn-moddle resolves `
          + `that element to ${resolved}`);
      }
    }
    expect(defects).toEqual([]);
  });

  /**
   * The anti-staleness half, and the reason there are two oracles at all. The day a dmn-moddle
   * release renames `OrganisationalUnit` to the XSD's `OrganizationUnit`, `resolveTag` starts
   * succeeding and this goes red — forcing the disposition to change from `parser-blind` to a real
   * one, instead of leaving a row that quietly understates what we could now read.
   */
  test('parser-blind rows do NOT resolve, and say by which mechanism', () => {
    const blind = DMN_ELEMENT_COVERAGE.filter((r) => r.disposition === 'parser-blind');
    const defects = [];
    for (const row of blind) {
      const resolved = resolveTag(row);
      if (resolved) {
        defects.push(`<${row.xsdElement}> is 'parser-blind', but dmn-moddle now resolves it to `
          + `${resolved} — the parser gained sight of it; change the disposition and give it a mapsTo `
          + `or a code`);
      }
      if (row.moddleType !== null) defects.push(`<${row.xsdElement}>: a parser-blind row carries moddleType: null`);
      if (row.code !== 'IM08') defects.push(`<${row.xsdElement}>: a parser-blind row carries code IM08`);
      if (!BLIND_MECHANISMS.includes(row.blind?.mechanism)) {
        defects.push(`<${row.xsdElement}>: blind.mechanism must be one of ${BLIND_MECHANISMS.join('|')}`);
      }
      // Judgment call 3 made checkable: `moddleType: null` alone cannot distinguish "moddle has no
      // concept for this" from "moddle has the concept under a name the XSD never uses". The second
      // must name the unreachable type, and that type must really exist — otherwise the row is
      // asserting a spelling divergence that is not there.
      if (row.blind?.moddleTypeIfReachable !== null
          && !DESCRIPTORS.has(row.blind?.moddleTypeIfReachable)) {
        defects.push(`<${row.xsdElement}>: blind.moddleTypeIfReachable names `
          + `${row.blind?.moddleTypeIfReachable}, which is not a dmn-moddle type — use null if moddle `
          + `has no concept for this element at all`);
      }
    }
    expect(defects).toEqual([]);
    expect(blind.length).toBeGreaterThan(0);   // the class is real; an empty set would pass vacuously
  });
});

// ── F3 — the behavioural fence, over a file we did not write ────────────────────────────────────

/**
 * F1, F1b, F2, F4 and F5 are all STATIC: they compare the table against its oracles, or against the
 * importer's dispatch table. Not one of them checks that the importer, run on an actual file, DOES
 * what the table says. F3 is that check, and `tests/fixtures/dmn/foreign-kitchen-sink.dmn` is the
 * file — hand-written rather than produced by `generateDmnXml`, because our writer emits only what
 * Decision-Core can already hold, so a generated fixture could not contain a single construct this
 * table exists to describe and the fence would only ever prove we can read ourselves.
 *
 * SET EQUALITY, IN BOTH DIRECTIONS, rather than per-row presence. Per-row presence cannot see the
 * importer reporting something the table does not list — and one-directional checks passing over a
 * live defect is this project's own history, twice over in this plan alone.
 *
 * JUDGMENT CALL 2 (Stage 4), recorded: the equality is over `{code × xsdElement}`, not over anything
 * finer. Finer — the path, or the count per row — catches more and buys it by coupling the fence to
 * facts that may legitimately change: a path moves when the fixture is reordered, a count moves when
 * an instance is added to exercise something else, and neither movement means the importer's
 * behaviour changed. `{code × xsdElement}` is exactly what a `reported` row STATES ("this element
 * class produces this code"), so the fence measures the claim and nothing around it. What finer
 * would have caught and this does not — a row firing at the wrong path, or once where it should fire
 * per occurrence — is covered where it belongs: `import.test.js` pins paths for the cases whose
 * paths are the point, and the suppression rules get their own assertions below.
 */
describe('F3 — the importer, run on a foreign file, reports exactly the `reported` rows', () => {
  const FIXTURE = path.join(HERE, '..', '..', 'tests', 'fixtures', 'dmn', 'foreign-kitchen-sink.dmn');
  const REPORTED = DMN_ELEMENT_COVERAGE.filter((r) => r.disposition === 'reported');
  const UNINSTANTIABLE = REPORTED.filter((row) =>
    typeIsAbstract(XSD_ELEMENTS.find((e) => e.xsdFile === row.xsdFile && e.name === row.xsdElement)));
  const pair = (code, xsdElement) => `${code} × <${xsdElement}>`;

  let result;
  beforeAll(async () => {
    result = await dmnToDecisionCore(readFileSync(FIXTURE, 'utf8'));
  });

  test('the fixture parsed at all — an unreadable one would make every check below vacuous', () => {
    expect(result.dc).not.toBeNull();
    expect(result.dc.nodes.length).toBeGreaterThan(5);
    expect(result.report.lossless).toBe(false);
  });

  /**
   * The exclusion, asserted rather than applied silently. It is derived (see `typeIsAbstract`), but a
   * derivation that quietly grew to cover half the table would hollow the fence out without failing
   * it — so the SET is pinned too. One member, and the fixture's own header comment says why.
   */
  test('exactly one reported row is structurally impossible to put in a conformant file', () => {
    expect(UNINSTANTIABLE.map((r) => r.xsdElement)).toEqual(['DMNDiagramElement']);
  });

  test('set equality — every reported row fires, and nothing fires that no row claims', () => {
    const expected = new Set(REPORTED.filter((r) => !UNINSTANTIABLE.includes(r))
      .map((r) => pair(r.code, r.xsdElement)));
    const actual = new Set(result.report.unrepresented
      .filter((f) => coverageForElement(f.xsdElement)?.disposition === 'reported')
      .map((f) => pair(f.code, f.xsdElement)));

    const problems = [
      ...[...expected].filter((p) => !actual.has(p)).map((p) => `${p}: the row claims this and the `
        + `importer did not produce it — either the fixture lacks an instance, or the importer does `
        + `not report the construct the row says it reports`),
      ...[...actual].filter((p) => !expected.has(p)).map((p) => `${p}: the importer produced this `
        + `and no reported row claims it — the row's code and the finding's code disagree`),
    ];
    expect(problems).toEqual([]);
    expect(expected.size).toBeGreaterThan(15);   // an empty expectation would pass vacuously
  });

  /**
   * The half set equality above cannot reach, because it filters to the reported universe first: a
   * finding under a code or an element name that appears nowhere in the table at all. Cheap, and it
   * is the check that keeps the filter from hiding something.
   */
  test('every finding names a code and an element the table knows', () => {
    const strays = result.report.unrepresented.flatMap((f) => [
      ...(IMPORT_CODES[f.code] ? [] : [`${f.path}: code ${f.code} is not in IMPORT_CODES`]),
      // A parser-blind finding is synthesised from a warning message, so its xsdElement is whatever
      // the message named — including, legitimately, an attribute rather than an element.
      ...(f.xsdElement === null || f.code === 'IM08' || coverageForElement(f.xsdElement) ? []
        : [`${f.path}: <${f.xsdElement}> has no row`]),
    ]);
    expect(strays).toEqual([]);
  });

  /**
   * The suppression rules exercised rather than asserted — which is why the fixture carries two
   * nesting cases (`<itemDefinition>` in `<itemComponent>`, `<context>` inside a `<contextEntry>`'s
   * value). Rule 2 dedupes BY CLASS inside a reported subtree, and a same-class CHILD is the case
   * that once escaped it.
   */
  test('a reported class inside a subtree of its own class reports exactly once per outer subtree', () => {
    const paths = (el) => result.report.unrepresented.filter((f) => f.xsdElement === el).map((f) => f.path);
    expect(paths('itemDefinition')).toEqual([
      'definitions.itemDefinition[0]', 'definitions.itemDefinition[1]',
    ]);
    expect(paths('context')).toEqual(['definitions.drgElement[4].decisionLogic']);
    expect(paths('contextEntry')).toEqual(['definitions.drgElement[4].decisionLogic.contextEntry[0]']);
    // …while a <DMNDiagram> is exempt, because a view is a fact and a shape is not.
    expect(paths('DMNDiagram')).toHaveLength(2);
  });

  test('no property finding is raised inside a subtree already reported whole', () => {
    const inside = result.report.unrepresented
      .filter((f) => ['IM04', 'IM05'].includes(f.code))
      .filter((f) => result.report.unrepresented.some((g) => g !== f
        && coverageForElement(g.xsdElement)?.disposition === 'reported'
        && f.path.startsWith(`${g.path}.`)))
      .map((f) => `${f.code} at ${f.path} sits inside the reported subtree that already declared it gone`);
    expect(inside).toEqual([]);
  });

  /**
   * The parser-blind class end to end. `<organizationUnit>` is XSD-legal and dmn-moddle spells the
   * type `OrganisationalUnit`, so the element never reaches the tree — a `warnings[]` entry is the
   * only evidence it was ever in the file, which is the entire reason the `parser-blind` disposition
   * exists.
   */
  test('the parser-blind element leaves nothing but a warning, and that warning becomes IM08', () => {
    expect(result.report.parserWarnings.some((w) => w.includes('organizationUnit'))).toBe(true);
    expect(result.report.unrepresented.some((f) => f.code === 'IM08' && f.xsdElement === 'organizationUnit'))
      .toBe(true);
    expect(JSON.stringify(result.dc)).not.toMatch(/ou_claims|Claims department/);
  });
});

/**
 * F3's own premise — "this is what a conformant foreign file looks like" — is unverified without
 * this. A malformed fixture would quietly narrow what F3 covers while still passing every assertion
 * above, since the importer would simply see less.
 *
 * Two independent dependencies, guarded separately, mirroring `dmn-xml.test.js:465-482`: the xmllint
 * binary and the schema file. A worktree can have one without the other in either direction.
 */
function xmllintAvailable() {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const DMN13_XSD = path.join(XSD_DIR, 'DMN13.xsd');
const describeIfXmllint = (xmllintAvailable() && existsSync(DMN13_XSD)) ? describe : describe.skip;

describeIfXmllint('F3 — the fixture really is a conformant DMN 1.3 document', () => {
  test('foreign-kitchen-sink.dmn validates against the normative XSD', () => {
    const fixture = path.join(HERE, '..', '..', 'tests', 'fixtures', 'dmn', 'foreign-kitchen-sink.dmn');
    expect(() => execFileSync('xmllint', ['--noout', '--schema', DMN13_XSD, fixture],
      { stdio: ['pipe', 'pipe', 'pipe'] })).not.toThrow();
  });
});

// ── F6 — exhaustiveness: every polymorphic slot × every class that can land in it ────────────────

/**
 * THE FENCE THAT WOULD HAVE CAUGHT C1.
 *
 * Stage 3's review found a Critical no fence could see: a `mapped` expression class landing in a
 * position the converter had no branch for was dropped while the report said `lossless: true`. A
 * business knowledge model written as a decision table — the ordinary way to model one — imported
 * with no logic at all. F5 fences that every `mapped` row has A handler; it can say nothing about
 * whether every POSITION that handler can meet is covered, because a row is a statement about a
 * TYPE and "read at this slot" is not a property of a type.
 *
 * So this fence enumerates the positions, and it does so from the descriptors and the table — never
 * from a hand-written position list, which would be the same document C1 slipped past. That
 * generation is the point rather than a nicety: `Invocation.calledFunction`, `Binding.bindingFormula`,
 * `ContextEntry.value` and `List.elements` are covered here TODAY only because the walk drops their
 * whole subtree, and the day any of those rows is promoted to `mapped` they become converter-
 * reachable — a generated case set follows that promotion, a written one does not.
 *
 * DERIVATION, in three steps, each with its own reason:
 *
 *   1. CONTAINMENT ROUTES.  Breadth-first from `dmn:Definitions` over non-reference properties,
 *      refusing to traverse a property the table declares unrepresented — the same rule
 *      `nestedClosure()` already uses ("a property already declared dropped takes its subtree with
 *      it"). That is what keeps `dmn:ExtensionElements` out without a hand exclusion: it is reachable
 *      only through `extensionElements`, which `DMN_ELEMENT_BASE` declares an IM04 loss.
 *      ALL routes of minimal length are kept, not one. `dmn:FunctionDefinition` sits one step from
 *      the root twice over — as a decision's logic, where the converter does NOT read it, and as a
 *      BKM's `encapsulatedLogic`, where it does — and keeping only the first would have made
 *      `FunctionDefinition.body` pass for the wrong reason, since everything under a dropped subtree
 *      is trivially "reported". C1 lived on the second route.
 *
 *   2. SLOTS.  A property of a reachable type whose declared type is ABSTRACT and at least one
 *      `mapped` class descends from it. Abstractness is the mechanism: a monomorphic slot's class is
 *      fixed, so "the converter has no branch for this class here" cannot arise.
 *
 *   3. CASES.  Slot × route × every `mapped` class that can land there. For each, a tree is built
 *      with the instance and an identical one without it, and the two are compared.
 *
 * READ-OR-REPORTED is the assertion, and both arms are generic:
 *   read      the resulting `dc` differs from the instance-less baseline — the importer did
 *             something with it.
 *   reported  some finding's path is the slot's path, or a prefix of it — the slot, or a subtree
 *             containing it, was declared gone.
 * Neither is the C1 shape exactly: content arrived, nothing read it, nothing said so.
 *
 * WHAT THE REVIEW COUNTED, AND WHERE I DIFFER (asked for explicitly, so stated explicitly). The
 * review enumerated six polymorphic slots, all `dmn:Expression`-typed: four under `reported` rows,
 * two converter-reachable and both handled. That is right, and this derivation finds all six. It
 * also finds a SEVENTH the review did not name — `dmn:Definitions.drgElement`, typed by the abstract
 * `dmn:DRGElement` — and I kept it rather than narrowing the rule to `dmn:Expression`, because it is
 * the same defect class and not a near miss: a `mapped` DRG row whose class `NODE_TYPE_OF` has no
 * entry for falls through `readDefinitions`' `handler ? … : null` and is dropped in exactly C1's
 * silence. Narrowing to `dmn:Expression` would have meant naming a type by hand to exclude a live
 * hole, which is the shape of the thing being fenced against.
 */
describe('F6 — every mapped class, in every polymorphic slot it can occupy, is read or reported', () => {
  const MAPPED_ROWS = DMN_ELEMENT_COVERAGE.filter((r) => r.disposition === 'mapped');
  const tableEntryFor = (type) =>
    [...DMN_ELEMENT_COVERAGE, ...DMN_NESTED_TYPE_COVERAGE].find((e) => e.moddleType === type);

  /** Does the table declare this property of this type dropped, so its subtree goes with it? */
  function isDroppedProperty(typeName, property) {
    const entry = tableEntryFor(typeName);
    if ((entry?.unrepresented ?? []).some((u) => u.property === property)) return true;
    // The hoisted base losses apply to every type that does not itself map the property.
    return Object.keys(DMN_ELEMENT_BASE).includes(property)
      && !Object.keys(entry?.mapsTo ?? {}).includes(property);
  }

  const concreteSubtypesOf = (type) => [...DESCRIPTORS.keys()]
    .filter((k) => !DESCRIPTORS.get(k).isAbstract && ancestryOf(k).includes(type));

  /** Every property a walk could descend through, with the concrete types it can hold. */
  function descendableProperties(typeName) {
    const prefix = typeName.split(':')[0];
    return propertyDescriptorsOf(typeName)
      .filter((p) => !p.isReference && !isDroppedProperty(typeName, p.name))
      .map((p) => {
        const target = qualify(p.type, prefix);
        const d = DESCRIPTORS.get(target);
        if (!d) return null;
        return { property: p.name, isMany: !!p.isMany, target, concrete: d.isAbstract ? concreteSubtypesOf(target) : [target] };
      })
      .filter(Boolean);
  }

  /** moddle type → every MINIMAL-length containment route from `dmn:Definitions` to it. */
  const ROUTES = (() => {
    const routes = new Map([['dmn:Definitions', [[]]]]);
    let frontier = ['dmn:Definitions'];
    while (frontier.length) {
      const discovered = new Map();
      for (const from of frontier) {
        for (const p of descendableProperties(from)) {
          for (const to of p.concrete) {
            if (routes.has(to)) continue;                       // already reached, at a shorter length
            if (!discovered.has(to)) discovered.set(to, []);
            for (const r of routes.get(from)) {
              discovered.get(to).push([...r, { ownerType: from, property: p.property, isMany: p.isMany }]);
            }
          }
        }
      }
      for (const [type, rs] of discovered) routes.set(type, rs);
      frontier = [...discovered.keys()];
    }
    return routes;
  })();

  const SLOTS = [...ROUTES.keys()].flatMap((owner) => descendableProperties(owner)
    .filter((p) => DESCRIPTORS.get(p.target)?.isAbstract)
    .map((p) => ({
      owner, property: p.property, isMany: p.isMany, slotType: p.target,
      holds: MAPPED_ROWS.filter((r) => ancestryOf(r.moddleType).includes(p.target)),
    }))
    .filter((s) => s.holds.length > 0));

  /**
   * The one hand-written part, and it cannot be otherwise: "a minimal instance that is observably
   * read" is a semantic fact, not a descriptor one — nothing in dmn-moddle says a
   * `<literalExpression>` is empty without its `text`, or that a `<decisionTable>` needs an output
   * clause to be a table rather than an IM09. An empty instance would make the read arm fail and the
   * fence report a defect that is not there.
   *
   * Fenced instead of trusted: the test below asserts that every mapped class the derivation puts in
   * a case has an entry here, so promoting a row to `mapped` fails loudly rather than generating a
   * hollow instance that quietly passes.
   */
  let serial = 0;
  const gen = () => `gen_${serial++}`;
  const MINIMAL_INSTANCES = {
    'dmn:LiteralExpression': () => ({ $type: 'dmn:LiteralExpression', text: '42' }),
    'dmn:DecisionTable': () => ({
      $type: 'dmn:DecisionTable', id: gen(),
      output: [{ $type: 'dmn:OutputClause', id: gen(), name: 'out' }],
    }),
    'dmn:FunctionDefinition': () => ({
      $type: 'dmn:FunctionDefinition', body: { $type: 'dmn:LiteralExpression', text: '42' },
    }),
    'dmn:Decision': () => ({ $type: 'dmn:Decision', id: gen(), name: 'X' }),
    'dmn:InputData': () => ({ $type: 'dmn:InputData', id: gen(), name: 'X' }),
    'dmn:KnowledgeSource': () => ({ $type: 'dmn:KnowledgeSource', id: gen(), name: 'X' }),
    'dmn:BusinessKnowledgeModel': () => ({ $type: 'dmn:BusinessKnowledgeModel', id: gen(), name: 'X' }),
  };

  /**
   * A tree reaching `slot` along `route`, with the instance in the slot or without it.
   *
   * The wrapper ids are POSITIONAL (`w_0`, `w_owner`) rather than drawn from the same counter as the
   * instance: a shared counter made the with- and without-instance trees differ in their wrappers'
   * ids, so `dc` differed for every case and the read arm was satisfied by an artefact of the
   * generator. Measured — it turned five honest `reported` verdicts into false `read` ones.
   */
  function buildCase(route, slot, mappedType) {
    const wrapper = (type, id) => {
      const props = new Set(propertiesOf(type));
      const el = { $type: type };
      if (props.has('id')) el.id = id;
      if (props.has('name')) el.name = 'X';
      if (type === 'dmn:Definitions') el.namespace = 'http://bpmn-generator.local/t';
      return el;
    };
    let node = wrapper(slot.owner, 'w_owner');
    if (mappedType) {
      const made = MINIMAL_INSTANCES[mappedType]();
      node[slot.property] = slot.isMany ? [made] : made;
    }
    for (let i = route.length - 1; i >= 0; i -= 1) {
      const parent = wrapper(route[i].ownerType, `w_${i}`);
      parent[route[i].property] = route[i].isMany ? [node] : node;
      node = parent;
    }
    const slotPath = route.reduce((p, s) => `${p}.${s.property}${s.isMany ? '[0]' : ''}`, 'definitions')
      + `.${slot.property}${slot.isMany ? '[0]' : ''}`;
    return { tree: node, slotPath };
  }

  const CASES = SLOTS.flatMap((slot) => (ROUTES.get(slot.owner) ?? []).flatMap((route) =>
    slot.holds.map((row) => ({ slot, route, row }))));

  /**
   * The count the review's own enumeration is a check on. Pinned as the full list rather than a
   * number, so a slot appearing or vanishing says WHICH — a bare count would let one slot replace
   * another silently.
   */
  test('the derivation finds the six dmn:Expression slots, plus the drgElement list', () => {
    expect(SLOTS.map((s) => `${s.owner}.${s.property} :: ${s.slotType}`).sort()).toEqual([
      'dmn:Binding.bindingFormula :: dmn:Expression',
      'dmn:ContextEntry.value :: dmn:Expression',
      'dmn:Decision.decisionLogic :: dmn:Expression',
      'dmn:Definitions.drgElement :: dmn:DRGElement',
      'dmn:FunctionDefinition.body :: dmn:Expression',
      'dmn:Invocation.calledFunction :: dmn:Expression',
      'dmn:List.elements :: dmn:Expression',
    ]);
    // Four of the six sit under `reported` rows, which is why they pass on the reported arm today.
    expect(SLOTS.filter((s) => coverageForModdleType(s.owner)?.disposition === 'reported')
      .map((s) => s.owner).sort())
      .toEqual(['dmn:ContextEntry', 'dmn:Invocation', 'dmn:List']);
    // `dmn:Binding` is the fourth, and has no row at all — it is reached only through <invocation>.
    expect(coverageForModdleType('dmn:Binding')).toBeUndefined();
  });

  test('dmn:FunctionDefinition is reached by both of its minimal routes, not just the first', () => {
    expect((ROUTES.get('dmn:FunctionDefinition') ?? []).map((r) => r.map((s) => s.property).join('.')).sort())
      .toEqual(['drgElement.decisionLogic', 'drgElement.encapsulatedLogic']);
  });

  test('every mapped class in a case has a minimal instance — a hollow one would pass falsely', () => {
    const missing = [...new Set(CASES.map((c) => c.row.moddleType))]
      .filter((t) => !MINIMAL_INSTANCES[t])
      .map((t) => `${t} became reachable in a polymorphic slot — add a MINIMAL_INSTANCES entry for `
        + `it, or this fence generates an empty element and passes without testing anything`);
    expect(missing).toEqual([]);
    expect(CASES.length).toBeGreaterThan(20);   // an empty case set would pass vacuously
  });

  /**
   * THE VACUOUS-PASS GUARD, and it is here because the vacuous pass actually happened. A first
   * revision of `buildCase` built its wrappers from `propertiesOf(type).map((p) => p.name)` —
   * `propertiesOf` already returns names, so the map produced `undefined`s, no wrapper ever got an
   * `id`, every generated decision was dropped as invalid source (IM09), and every case therefore
   * counted as "reported" because a finding sat above its slot. The fence was green and testing
   * nothing; only the red-first run exposed it.
   *
   * So: the SCAFFOLDING must import cleanly. A baseline tree — no instance in the slot at all — may
   * legitimately report what the table says is unrepresentable, but it must never report that the
   * source is broken or that an id could not be held, because the generator wrote those ids.
   */
  test('the generated scaffolding is well formed — a broken wrapper would make every case pass', () => {
    const broken = [];
    for (const { slot, route } of CASES) {
      const { report } = moddleToDecisionCore(buildCase(route, slot, null).tree);
      for (const f of report.unrepresented.filter((x) => ['IM07', 'IM09'].includes(x.code))) {
        broken.push(`${slot.owner}.${slot.property}: the generated tree itself reports ${f.code} at `
          + `${f.path} — the scaffolding is malformed, so every case under it passes for free`);
      }
    }
    expect([...new Set(broken)]).toEqual([]);
  });

  test('no case is silent — every mapped class in every slot is either read or reported', () => {
    const silent = [];
    for (const { slot, route, row } of CASES) {
      const withIt = buildCase(route, slot, row.moddleType);
      const without = buildCase(route, slot, null);
      const read = JSON.stringify(moddleToDecisionCore(withIt.tree).dc)
        !== JSON.stringify(moddleToDecisionCore(without.tree).dc);
      const { report } = moddleToDecisionCore(withIt.tree);
      const reported = report.unrepresented
        .some((f) => withIt.slotPath === f.path || withIt.slotPath.startsWith(`${f.path}.`));
      if (!read && !reported) {
        silent.push(`<${row.xsdElement}> at ${slot.owner}.${slot.property} (${withIt.slotPath}) is `
          + `neither read into Decision-Core nor named in the report — it is dropped in silence, `
          + `which is the C1 shape: either give the converter a branch for it, or make it report`);
      }
    }
    expect(silent).toEqual([]);
  });
});

// ── F4 — the XSD-declared attribute defaults ────────────────────────────────────────────────────

describe('F4 — the XSD defaults, and the two that dmn-moddle materialises', () => {
  const key = (d) => `${d.xsdFile}:${d.ownerType}@${d.attr}`;

  test('DMN_XSD_DEFAULTS covers exactly the declared defaults, with the declared values', () => {
    const declared = new Map(XSD_DEFAULTS.map((d) => [key(d), d.xsdDefault]));
    const listed = new Map(DMN_XSD_DEFAULTS.map((d) => [key(d), d.xsdDefault]));
    const problems = [
      ...[...declared].filter(([k]) => !listed.has(k))
        .map(([k, v]) => `add a DMN_XSD_DEFAULTS row for ${k} (XSD default ${JSON.stringify(v)})`),
      ...[...listed].filter(([k]) => !declared.has(k))
        .map(([k]) => `remove the stale DMN_XSD_DEFAULTS row for ${k}: no XSD declares that default`),
      ...[...listed].filter(([k, v]) => declared.has(k) && declared.get(k) !== v)
        .map(([k, v]) => `${k}: row says ${JSON.stringify(v)}, the XSD says ${JSON.stringify(declared.get(k))}`),
    ];
    expect(problems).toEqual([]);
    expect(declared.size).toBeGreaterThan(0);
  });

  /**
   * The 2-of-9 divergence as a tested fact rather than a coincidence we depend on. dmn-moddle
   * carries a descriptor `default` for `hitPolicy` and `textFormat` only — which is why moddle DROPS
   * `hitPolicy="UNIQUE"` on write while keeping `preferredOrientation="Rule-as-Row"`, a difference
   * `references/decision-core-schema.json` already had to record for the golden files. Every other
   * XSD default is ours to apply or ignore deliberately.
   */
  test('exactly hitPolicy and textFormat carry a moddle descriptor default', () => {
    const moddleOwner = (d) => (d.xsdFile === 'DMN13' ? `dmn:${d.ownerType.replace(/^t/, '')}` : `dmndi:${d.ownerType}`);
    const mismatches = [];
    for (const d of DMN_XSD_DEFAULTS) {
      const descriptor = DESCRIPTORS.get(moddleOwner(d));
      // Without this, a naming rule that stops holding (`tFoo` → `dmn:Foo`) makes the lookup return
      // undefined, `actually` false, and every row saying `false` pass FOR THE WRONG REASON — the
      // fence would go quiet exactly when the two layers had drifted.
      if (!descriptor) {
        mismatches.push(`${key(d)}: no dmn-moddle descriptor for ${moddleOwner(d)} — the owner-type `
          + `naming rule no longer holds, so this row cannot be checked at all`);
        continue;
      }
      const prop = descriptor.properties?.find((p) => p.name === d.attr);
      const actually = prop?.default !== undefined;
      if (actually !== d.moddleMaterialises) {
        mismatches.push(`${key(d)}: row says moddleMaterialises ${d.moddleMaterialises}, dmn-moddle `
          + `${actually ? 'does' : 'does not'} carry a descriptor default`);
      }
      if (actually && prop.default !== d.xsdDefault) {
        mismatches.push(`${key(d)}: dmn-moddle's descriptor default ${JSON.stringify(prop.default)} `
          + `disagrees with the XSD's ${JSON.stringify(d.xsdDefault)}`);
      }
    }
    expect(mismatches).toEqual([]);
    expect(DMN_XSD_DEFAULTS.filter((d) => d.moddleMaterialises).map((d) => d.attr).sort())
      .toEqual(['hitPolicy', 'textFormat']);
  });

  test('a default we materialise must have somewhere to go', () => {
    const bad = DMN_XSD_DEFAULTS.filter((d) => d.materialize && d.slot === null)
      .map((d) => `${key(d)}: materialize: true with slot: null — there is no Decision-Core field to write it into`);
    expect(bad).toEqual([]);
  });
});

// ── The lookups ─────────────────────────────────────────────────────────────────────────────────

describe('the lookups', () => {
  test('coverageForElement answers by XSD element name, and by file when asked', () => {
    expect(coverageForElement('decision').disposition).toBe('mapped');
    expect(coverageForElement('decisionService').disposition).toBe('reported');
    expect(coverageForElement('tDecision')).toBeUndefined();
    expect(coverageForElement('DMNShape', 'DMNDI13').code).toBe('IM06');
    expect(coverageForElement('DMNShape', 'DMN13')).toBeUndefined();
  });

  /**
   * The primary key is (xsdElement, xsdFile), so the one-argument form is only safe while the names
   * alone happen to be unique — true today because DMN13 is camelCase and DMNDI13 PascalCase, but
   * nothing in either spec promises it stays that way. Asserted rather than assumed: the day a DMNDI
   * revision adds an `<association>`, this goes red before a caller can be handed the DMN13 row for
   * a DI element and told it is an IM03.
   */
  test('no two rows share an xsdElement, which is what makes the one-argument lookup safe', () => {
    const seen = new Map();
    for (const row of DMN_ELEMENT_COVERAGE) seen.set(row.xsdElement, (seen.get(row.xsdElement) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1).map(([e]) => `<${e}> is declared in two XSDs — `
      + `every coverageForElement caller must now pass xsdFile`)).toEqual([]);
  });

  test('coverageForModdleType answers by moddle type, and never matches a parser-blind row', () => {
    expect(coverageForModdleType('dmn:Decision').xsdElement).toBe('decision');
    expect(coverageForModdleType('dmn:OrganisationalUnit')).toBeUndefined();
    // The guard that makes that last line more than a fact about today: a parser-blind row's
    // moddleType is null, and a caller passing null must not be handed the first such row.
    expect(coverageForModdleType(null)).toBeUndefined();
    expect(coverageForModdleType(undefined)).toBeUndefined();
  });
});

// ── F5 — the table and the importer cannot drift apart ──────────────────────────────────────────

describe('F5 — Object.keys(HANDLERS) is exactly the set of `mapped` rows', () => {
  /**
   * The fence the other four could not provide. F1 keeps the row set honest against the XSDs and
   * F1b keeps each mapped row's properties accounted for — but neither can tell whether the
   * IMPORTER still reads the row it says it reads. Demoting a row from `mapped` to `reported`
   * without deleting its handler leaves the property fencing F1b did for it silently gone, since
   * F1b only walks `mapped` rows; adding a handler with no row lets a construct be imported that
   * the table never mentions. Set equality in BOTH directions closes both.
   *
   * `dmn:DMNElementReference` deliberately has no key: it is a nested type, not a global element,
   * so it has no `xsdElement` to key one by, and its `href`'s Decision-Core slot depends on its
   * container. See the HANDLERS doc comment in import.js for that argument in full.
   */
  test('no mapped row is unhandled, and no handler is stray', () => {
    const mapped = DMN_ELEMENT_COVERAGE.filter((r) => r.disposition === 'mapped').map((r) => r.xsdElement);
    const handled = Object.keys(HANDLERS);
    const problems = [
      ...mapped.filter((e) => !handled.includes(e))
        .map((e) => `<${e}> is 'mapped' but scripts/dmn/import.js has no HANDLERS entry for it — `
          + `either add the handler or change the row's disposition`),
      ...handled.filter((e) => !mapped.includes(e))
        .map((e) => `HANDLERS has an entry for <${e}>, which is not a 'mapped' row in `
          + `scripts/dmn/import-scope.js — ${HOWTO}`),
    ];
    expect(problems).toEqual([]);
    expect(mapped.length).toBeGreaterThan(5);   // an empty mapped set would pass vacuously
  });

  test('every handler is callable', () => {
    expect(Object.values(HANDLERS).every((h) => typeof h === 'function')).toBe(true);
  });
});

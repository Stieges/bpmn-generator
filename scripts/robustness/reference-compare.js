/**
 * Reference comparison — how close an extracted Logic-Core is to a reference model of the same
 * process.
 *
 * The schema gate, the rule engine and compliance judge whether a model holds together. None of
 * them can say whether it is the process that was described: a run that hid a role's work in a
 * collapsed subprocess and repeated a step passed all three. This module compares against a
 * reference instead, deterministically, by names and structure:
 *
 *  - participants: expanded pools and black boxes (`collapsedPools`) matched by name; a missing
 *    one, and one expanded where the reference has a black box (or the reverse);
 *  - lanes: matched by name; a missing one, and a lane with no element at the top level
 *    (`emptyLeafLanes`, the definition rule M12 uses);
 *  - activities: every reference activity matched one-to-one to the most similar candidate
 *    activity (`nameSimilarity` ≥ `nameMatch`) — recall, precision, type and lane agreement; a
 *    match found only inside a subprocess where the reference has it at the top level; a second
 *    candidate activity for an already matched reference activity, or two directly connected
 *    activities with near-equal names (`duplicateMatch`): a duplicate step;
 *  - control flow: gateways by type and boundary events by marker, counted.
 *
 * Without a reference (`null`) only the checks that need none run: empty lanes, duplicate steps,
 * and — when the case names them (`opts.expect.lanes`) — the lanes the text calls for.
 * A candidate with no lane at all where lanes are expected is `no-lanes`, the first finding.
 * `opts.notInText` lists reference activities the case's text does not describe: they count
 * neither for recall nor, when a candidate has them anyway, against precision.
 * Thresholds: robustness/config.json → extractionQuality.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isActivity, isGateway } from '../bpmn/types.js';
import { resolveLaneId, emptyLeafLanes } from '../bpmn/topology.js';

const CONFIG = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'config.json'), 'utf8'));
const DEFAULTS = { nameMatch: 0.6, duplicateMatch: 0.75, ...(CONFIG.extractionQuality ?? {}) };

const STOPWORDS = new Set(['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer',
  'und', 'oder', 'an', 'am', 'im', 'in', 'zu', 'zum', 'zur', 'vom', 'von', 'mit', 'fuer', 'auf', 'bei',
  'the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'on', 'in', 'with', 'by']);

/** Lowercase words, umlauts spelled out, stopwords dropped, a crude suffix stem on longer words. */
function tokens(name) {
  return String(name ?? '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .split(/[^a-z0-9]+/).filter((t) => t && !STOPWORDS.has(t))
    .map((t) => (t.length > 5 ? t.replace(/(en|ern|er|es|e|s|n|t)$/, '') : t));
}

const tokenMatch = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a)));

/**
 * Similarity of two names in [0, 1]: the share of words that find a partner in the other name
 * (equal, or one containing the other — "Urlaubsantrag" holds "Antrag"), over the longer name.
 */
function wordHits(a, b) {
  const A = tokens(a), B = tokens(b);
  const used = new Set();
  let hits = 0;
  for (const t of A) {
    const j = B.findIndex((u, k) => !used.has(k) && tokenMatch(t, u));
    if (j >= 0) { used.add(j); hits++; }
  }
  return { hits, a: A.length, b: B.length };
}

export function nameSimilarity(a, b) {
  const h = wordHits(a, b);
  return h.a && h.b ? h.hits / Math.max(h.a, h.b) : 0;
}

/**
 * The stricter measure for "the same step written twice": the share of the SHORTER name found in
 * the other ("Urlaubsantrag erneut stellen" holds all of "Urlaubsantrag stellen"). Compared with
 * `duplicateMatch`, so one shared word out of two ("Antrag abstimmen" / "Urlaubsantrag stellen")
 * is not a duplicate.
 */
function duplicateSimilarity(a, b) {
  const h = wordHits(a, b);
  return h.a && h.b ? h.hits / Math.min(h.a, h.b) : 0;
}

const processesOf = (lc) => (lc?.pools ? lc.pools : lc ? [lc] : []);

/** Every activity of a model with its process, lane and depth (0 = top level of its process). */
function activitiesOf(lc) {
  const out = [];
  for (const proc of processesOf(lc)) {
    const laneName = new Map();
    const walkLanes = (ls) => { for (const l of ls || []) { laneName.set(l.id, l.name ?? l.id); walkLanes(l.children); } };
    walkLanes(proc.lanes);
    const walk = (container, depth) => {
      for (const n of container.nodes || []) {
        if (isActivity(n.type)) {
          out.push({ id: n.id, name: n.name ?? '', type: n.type, depth, process: proc.id ?? null,
            lane: depth === 0 ? laneName.get(resolveLaneId(proc, n)) ?? null : null });
        }
        if (n.nodes) walk(n, depth + 1);
      }
    };
    walk(proc, 0);
  }
  return out;
}

function participantsOf(lc) {
  if (!lc) return [];
  const expanded = lc.pools ? lc.pools.map((p) => ({ name: p.name ?? p.id, kind: 'expanded' })) : [{ name: lc.name ?? lc.id ?? '', kind: 'expanded' }];
  return [...expanded, ...(lc.collapsedPools || []).map((p) => ({ name: p.name ?? p.id, kind: 'black box' }))];
}

function lanesOf(lc) {
  const out = [];
  for (const proc of processesOf(lc)) {
    const walk = (ls) => { for (const l of ls || []) { if (l.children?.length) walk(l.children); else out.push(l.name ?? l.id); } };
    walk(proc.lanes);
  }
  return out;
}

function countBy(lc, pick) {
  const out = {};
  for (const proc of processesOf(lc)) {
    for (const n of proc.nodes || []) {
      const key = pick(n);
      if (key) out[key] = (out[key] ?? 0) + 1;
    }
  }
  return out;
}

/** One-to-one greedy matching of names, best pair first. Returns Map(refIndex → candIndex). */
function matchByName(refNames, candNames, threshold) {
  const pairs = [];
  refNames.forEach((r, i) => candNames.forEach((c, j) => {
    const s = nameSimilarity(r, c);
    if (s >= threshold) pairs.push({ i, j, s });
  }));
  pairs.sort((a, b) => b.s - a.s || a.i - b.i || a.j - b.j);
  const ref = new Map(), cand = new Set();
  for (const p of pairs) {
    if (ref.has(p.i) || cand.has(p.j)) continue;
    ref.set(p.i, p.j);
    cand.add(p.j);
  }
  return ref;
}

/** Two activities joined by a sequence flow whose names are near-equal: one step written twice. */
function adjacentDuplicates(lc, threshold) {
  const out = [];
  for (const proc of processesOf(lc)) {
    const walk = (container) => {
      const byId = new Map((container.nodes || []).map((n) => [n.id, n]));
      for (const e of container.edges || []) {
        const a = byId.get(e.source), b = byId.get(e.target);
        if (a && b && isActivity(a.type) && isActivity(b.type) && duplicateSimilarity(a.name, b.name) >= threshold) out.push([a, b]);
      }
      for (const n of container.nodes || []) if (n.nodes) walk(n);
    };
    walk(proc);
  }
  return out;
}

/**
 * @param {object} candidate - the extracted Logic-Core
 * @param {object|null} reference - the reference Logic-Core, or null
 * @param {{ nameMatch?: number, duplicateMatch?: number, expect?: { lanes?: string[] }, notInText?: string[] }} [opts]
 *   thresholds over the config; the lanes a case expects without a reference model; reference
 *   activities its text does not describe
 * @returns {{ metrics: object, findings: { kind: string, message: string }[] }}
 */
export function compareToReference(candidate, reference, opts = {}) {
  const { nameMatch, duplicateMatch } = { ...DEFAULTS, ...opts };
  const findings = [];
  const add = (kind, message) => findings.push({ kind, message });
  const candL = lanesOf(candidate);
  // Lanes the reference has (or, without one, the case expects): matched by name. A candidate
  // without any lane gets `no-lanes` first — the one finding that says what went wrong.
  const checkLanes = (wanted) => {
    const match = matchByName(wanted, candL, nameMatch);
    if (wanted.length && !candL.length) {
      findings.unshift({ kind: 'no-lanes', message: `No lane at all; ${wanted.length} expected (${wanted.join(', ')})` });
    }
    wanted.forEach((l, i) => { if (!match.has(i)) add('missing-lane', `Lane "${l}" is missing`); });
    return match;
  };

  // Reference-free: empty lanes, adjacent duplicates.
  for (const proc of processesOf(candidate)) {
    for (const l of emptyLeafLanes(proc)) add('empty-lane', `Lane "${l.name ?? l.id}" has no element at the top level`);
  }
  const dupIds = new Set();
  for (const [a, b] of adjacentDuplicates(candidate, duplicateMatch)) {
    dupIds.add(a.id);
    dupIds.add(b.id);
    add('duplicate-step', `"${a.name}" and "${b.name}" follow each other and name the same step`);
  }

  const allCand = activitiesOf(candidate);
  const metrics = {
    activities: { candidate: allCand.length, reference: null, matched: null, recall: null, precision: null, typeAgreement: null, laneAgreement: null, excluded: 0 },
  };
  if (!reference) {
    const wanted = opts.expect?.lanes ?? [];
    if (wanted.length) metrics.lanes = { reference: wanted.length, candidate: candL.length, matched: checkLanes(wanted).size };
    return { metrics, findings };
  }

  // Participants
  const refP = participantsOf(reference), candP = participantsOf(candidate);
  const pMatch = matchByName(refP.map((p) => p.name), candP.map((p) => p.name), nameMatch);
  refP.forEach((p, i) => {
    if (!pMatch.has(i)) add('missing-participant', `Participant "${p.name}" (${p.kind}) is missing`);
    else if (candP[pMatch.get(i)].kind !== p.kind) {
      add('participant-kind', `Participant "${p.name}" is ${candP[pMatch.get(i)].kind}, the reference has it as ${p.kind}`);
    }
  });
  metrics.participants = { reference: refP.length, candidate: candP.length, matched: pMatch.size };

  // Lanes
  const refL = lanesOf(reference);
  const lMatch = checkLanes(refL);
  const laneMap = new Map([...lMatch].map(([i, j]) => [refL[i], candL[j]]));
  metrics.lanes = { reference: refL.length, candidate: candL.length, matched: lMatch.size };

  // Activities — without the ones the text does not describe, and without candidate activities
  // that are one of those (a model may know more than the text; that is not an invented step).
  const notInText = opts.notInText ?? [];
  const described = (a) => !notInText.some((n) => nameSimilarity(n, a.name) >= nameMatch);
  const allRef = activitiesOf(reference);
  const ref = allRef.filter(described);
  const cand = allCand.filter(described);
  metrics.activities.excluded = allRef.length - ref.length;
  const aMatch = matchByName(ref.map((a) => a.name), cand.map((a) => a.name), nameMatch);
  let sameType = 0, sameLane = 0, laned = 0;
  ref.forEach((r, i) => {
    if (!aMatch.has(i)) { add('missing-activity', `Activity "${r.name}" (${r.type}) is missing`); return; }
    const c = cand[aMatch.get(i)];
    if (c.type === r.type) sameType++;
    if (r.lane) { laned++; if (c.lane && laneMap.get(r.lane) === c.lane) sameLane++; }
    if (r.depth === 0 && c.depth > 0) add('nested-activity', `Activity "${r.name}" sits inside a subprocess; the reference has it at the top level`);
  });
  const matchedCand = new Set(aMatch.values());
  cand.forEach((c, j) => {
    if (matchedCand.has(j) || dupIds.has(c.id)) return;
    let twin = -1, best = 0;
    ref.forEach((r, i) => { const d = duplicateSimilarity(r.name, c.name); if (d > best) { best = d; twin = i; } });
    if (twin >= 0 && best >= duplicateMatch && aMatch.has(twin)) {
      add('duplicate-step', `"${c.name}" repeats the step "${ref[twin].name}", already matched by "${cand[aMatch.get(twin)].name}"`);
    }
  });
  const m = aMatch.size;
  metrics.activities = {
    candidate: cand.length, reference: ref.length, matched: m, excluded: allRef.length - ref.length,
    recall: ref.length ? m / ref.length : 1,
    precision: cand.length ? m / cand.length : 1,
    typeAgreement: m ? sameType / m : null,
    laneAgreement: laned ? sameLane / laned : null,
  };

  // Control flow
  const gw = (lc) => countBy(lc, (n) => (isGateway(n.type) ? n.type : null));
  const be = (lc) => countBy(lc, (n) => (n.type === 'boundaryEvent' ? n.marker ?? 'none' : null));
  metrics.gateways = { reference: gw(reference), candidate: gw(candidate) };
  metrics.boundaryEvents = { reference: be(reference), candidate: be(candidate) };
  for (const [key, kind, label] of [['gateways', 'gateway-count', 'gateways'], ['boundaryEvents', 'boundary-count', 'boundary events']]) {
    const { reference: r, candidate: c } = metrics[key];
    for (const t of new Set([...Object.keys(r), ...Object.keys(c)])) {
      if ((r[t] ?? 0) !== (c[t] ?? 0)) add(kind, `${label} ${t}: ${c[t] ?? 0} at the top level, the reference has ${r[t] ?? 0}`);
    }
  }

  return { metrics, findings };
}

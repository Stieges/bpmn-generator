#!/usr/bin/env node
/**
 * fetch-bpmn-xsd — download the five normative OMG BPMN 2.0 schema files that the XSD
 * conformance test (scripts/bpmn/xsd-conformance.test.js) validates against.
 *
 * The files are third-party documents and are not committed (references/omg-spec/ is
 * git-ignored). Each body is checked against a pinned SHA-256 before it is written; a file
 * already present with the right hash is left alone.
 *
 * Usage: node .github/scripts/fetch-bpmn-xsd.mjs
 * Exit codes: 0 all five files present and verified; 1 HTTP error or hash mismatch.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainModule } from '../../scripts/shared/entry-point.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const XSD_BASE = 'https://www.omg.org/spec/BPMN/20100501/';

/** File name -> SHA-256 (hex) of the OMG file. */
export const XSD_FILES = {
  'BPMN20.xsd': 'a07c159cb0594573dd7c97b1370dd116112378f377e43c89a8bf512ac5030705',
  'Semantic.xsd': 'c4318842f7d2bbc262d7954c9452c501db16f0868eac0b8732ec5d7fb384d9a7',
  'BPMNDI.xsd': 'f0dff1cd559d1514d8ebfc8c646f58402bcaced27ec22e2aa6456c2dcc80b038',
  'DC.xsd': 'a2f90e5ad9bb48c6915e4e034b4e27ac838264a1d4f27bfc70dbdfc69351312d',
  'DI.xsd': '8220b179c175572df74e08a51bffabe957867962035cee7b5fee0b6acb4c4498',
};

/** Absolute path of references/omg-spec/normative/. */
export function xsdDir() {
  return resolve(HERE, '../../references/omg-spec/normative');
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Download what is missing or wrong into `dir`; returns the names written. Throws on HTTP error or hash mismatch. */
export async function fetchBpmnXsd({ dir = xsdDir() } = {}) {
  mkdirSync(dir, { recursive: true });
  const written = [];
  for (const [name, hash] of Object.entries(XSD_FILES)) {
    const target = join(dir, name);
    if (existsSync(target) && sha256(readFileSync(target)) === hash) continue;
    const res = await fetch(XSD_BASE + name);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status} from ${XSD_BASE}${name}`);
    const body = Buffer.from(await res.arrayBuffer());
    const got = sha256(body);
    if (got !== hash) throw new Error(`${name}: SHA-256 mismatch (expected ${hash}, got ${got})`);
    writeFileSync(target, body);
    written.push(name);
  }
  return written;
}

/**
 * Can the conformance test run? xmllint present and all five files carry the pinned hashes.
 * `mismatch` is true when a file exists with the wrong hash (a broken download, never a skip);
 * missing files or a missing xmllint only make it unavailable.
 */
export function bpmnXsdStatus({ dir = xsdDir() } = {}) {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'pipe' });
  } catch {
    return { available: false, mismatch: false, reason: 'xmllint not found' };
  }
  const problems = [];
  let mismatch = false;
  for (const [name, hash] of Object.entries(XSD_FILES)) {
    const file = join(dir, name);
    if (!existsSync(file)) problems.push(`${name} missing`);
    else if (sha256(readFileSync(file)) !== hash) {
      problems.push(`${name} has the wrong SHA-256`);
      mismatch = true;
    }
  }
  return problems.length
    ? { available: false, mismatch, reason: problems.join('; ') }
    : { available: true, mismatch: false, reason: null };
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    const written = await fetchBpmnXsd();
    console.log(written.length ? `fetched: ${written.join(', ')}` : 'all BPMN XSD files already present');
  } catch (e) {
    console.error(`fetch-bpmn-xsd: ${e.message}`);
    process.exit(1);
  }
}

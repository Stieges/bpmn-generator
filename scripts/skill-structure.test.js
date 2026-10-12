/**
 * SKILL.md follows Anthropic's skill-authoring guidance (progressive disclosure): a short body, a
 * frontmatter the skill loader accepts, and reference files linked one level deep from SKILL.md,
 * each findable from the index and navigable on its own. These are the mechanical parts of that
 * guidance; the prose is reviewed, not tested.
 *
 * Limits: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
 * (body under 500 lines, `name` at most 64 characters of lowercase letters, digits and hyphens,
 * `description` at most 1024 characters, a table of contents in reference files over 100 lines).
 */
import { describe, test, expect } from '@jest/globals';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8');

const fm = skill.match(/^---\n([\s\S]*?)\n---\n/);
const frontmatter = fm ? fm[1] : '';
const body = fm ? skill.slice(fm[0].length) : skill;

/** The YAML subset SKILL.md uses: `key: value` and `key: >` folded blocks. */
function parseFrontmatter(text) {
  const out = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([a-z-]+):\s*(.*)$/);
    if (!m) continue;
    if (m[2] === '>' || m[2] === '|') {
      const block = [];
      while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) block.push(lines[++i].trim());
      out[m[1]] = block.join(' ');
    } else {
      out[m[1]] = m[2].trim();
    }
  }
  return out;
}
const meta = parseFrontmatter(frontmatter);

// Every `references/<file>` SKILL.md names, in backticks or as a link target.
const linked = [...new Set([...skill.matchAll(/references\/[\w.-]+\.(?:md|jsonld|json)\b/g)].map((m) => m[0]))];
const referenceFiles = readdirSync(path.join(ROOT, 'references'))
  .filter((f) => statSync(path.join(ROOT, 'references', f)).isFile())
  .map((f) => `references/${f}`);

const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replace(/ /g, '-');
function headings(text) {
  const out = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) { fenced = !fenced; continue; }
    if (!fenced && /^#{2,3} /.test(line)) out.push(slug(line.replace(/^#+ /, '')));
  }
  return out;
}

describe('SKILL.md — frontmatter', () => {
  test('has a frontmatter block', () => {
    expect(fm).not.toBeNull();
  });

  test('name: at most 64 characters, lowercase letters, digits and hyphens', () => {
    expect(meta.name).toMatch(/^[a-z0-9-]{1,64}$/);
  });

  test('description: present, at most 1024 characters, says what and when', () => {
    expect(typeof meta.description).toBe('string');
    expect(meta.description.length).toBeGreaterThan(0);
    expect(meta.description.length).toBeLessThanOrEqual(1024);
    expect(meta.description).toMatch(/\bUse when\b/);
    for (const term of ['BPMN', 'DMN']) expect(meta.description).toContain(term);
  });
});

describe('SKILL.md — body and progressive disclosure', () => {
  test('the body stays under 500 lines', () => {
    expect(body.split('\n').length).toBeLessThan(500);
  });

  test('the pre-delivery gate stays in the body (SKILL.md is not re-read)', () => {
    expect(body).toMatch(/## Pre-delivery gate/);
    expect(body).toMatch(/node bpmn\/pipeline\.js <input>\.json <output> --strict/);
  });

  test('every reference file SKILL.md names exists', () => {
    expect(linked.length).toBeGreaterThan(0);
    const missing = linked.filter((rel) => !existsSync(path.join(ROOT, rel)));
    expect(missing).toEqual([]);
  });

  test('every reference file is indexed in SKILL.md', () => {
    expect(referenceFiles.filter((rel) => !linked.includes(rel))).toEqual([]);
  });

  test('every Markdown reference file over 100 lines opens with a table of contents that resolves', () => {
    const problems = [];
    for (const rel of linked.filter((r) => r.endsWith('.md'))) {
      const text = readFileSync(path.join(ROOT, rel), 'utf8');
      if (text.split('\n').length <= 100) continue;
      const toc = text.match(/^## Contents\n\n((?:- \[.*\]\(#.*\)\n)+)/m);
      if (!toc) { problems.push(`${rel}: no "## Contents" list`); continue; }
      const anchors = new Set(headings(text));
      for (const [, anchor] of toc[1].matchAll(/\]\(#([^)]+)\)/g)) {
        if (!anchors.has(anchor)) problems.push(`${rel}: #${anchor} matches no heading`);
      }
    }
    expect(problems).toEqual([]);
  });
});

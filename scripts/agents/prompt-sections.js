/**
 * Prompt Section Loader — extracts named fenced-code sections from
 * references/prompt-template.md, shared by the modeler and chat agents.
 */

import { readFileSync } from 'node:fs';
import { promptTemplatePath } from '../resource-paths.js';

// Which of the two layouts applies — and why the source wins over the in-package
// copy — is decided in one place; see resource-paths.js. This module used to
// carry its own copy of that logic with a different `..` depth, which meant the
// same defect had to be fixed twice and no test covered either.

let _raw = null;
function loadRaw() {
  if (_raw === null) _raw = readFileSync(promptTemplatePath(), 'utf8');
  return _raw;
}

const _cache = new Map();

// Extracts the outer fenced block after a `## <header>` line. The block may
// contain nested ```json examples, so the close is anchored on the section
// separator (---) rather than the first closing fence.
export function extractPromptSection(header) {
  if (_cache.has(header)) return _cache.get(header);
  const re = new RegExp(`## ${header}[\\s\\S]*?\`\`\`\\n([\\s\\S]*?)\\n\`\`\`\\n+---`, 'i');
  const m = loadRaw().match(re);
  const section = m ? m[1].trim() : '';
  _cache.set(header, section);
  return section;
}

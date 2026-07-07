/**
 * Prompt Section Loader — extracts named fenced-code sections from
 * references/prompt-template.md, shared by the modeler and chat agents.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const promptPath = join(__dirname, '..', '..', 'references', 'prompt-template.md');

let _raw = null;
function loadRaw() {
  if (_raw === null) _raw = readFileSync(promptPath, 'utf8');
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

/**
 * L1 — Training Data Preparation for BPMN-SLM Fine-Tuning
 *
 * Converts BPMN XML files → Logic-Core JSON via import.js round-trip,
 * runs quality filters (validation + compliance), and outputs JSONL
 * for instruction-tuning.
 *
 * Usage:
 *   node prepare-training-data.js --research /path/to/bpmn-for-research-master \
 *     [--iwf-bpmn /path/to/bpmn/] [--output training/] [--stats-only]
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { bpmnToLogicCore } from './import.js';
import { validateLogicCore } from './validate.js';
import { runRules } from './rules.js';

// ── Config ─────────────────────────────────────────────────────────────

const EXERCISES = {
  en: {
    '01': { dir: 'English/01-Dispatch-of-goods', name: 'Dispatch of goods' },
    '02': { dir: 'English/02-Recourse', name: 'Recourse' },
    '03': { dir: 'English/03-Credit-scoring', name: 'Credit scoring' },
    '04': { dir: 'English/04-Self-service-restaurant', name: 'Self-service restaurant' },
  },
  de: {
    '01': { dir: 'German/01-Vorbereitung-des-Warenversands', name: 'Vorbereitung des Warenversands' },
    '02': { dir: 'German/02-Regressnahme', name: 'Regressnahme' },
    '03': { dir: 'German/03-Schufascoring', name: 'Schufascoring' },
    '04': { dir: 'German/04-Selbstbedienungsrestaurant', name: 'Selbstbedienungsrestaurant' },
  },
};

// Exercise descriptions (extracted from the markdown/PDF content)
const DESCRIPTIONS = {
  en: {
    '01': `A small company that produces hardware has a process for dispatching goods. After the goods are received by the Logistics department, a clerk checks whether a standard or special shipment is required. For standard shipments, the clerk fills in a post label and packages the goods. In the case of a special shipment, three offers from carriers are obtained and the best offer is selected. Then insurance is taken out and the goods are packaged. After the goods are packaged (whether standard or special), a logistics manager verifies the package contents, and the shipment is dispatched and the customer is notified.`,
    '02': `An insurance company handles recourse claims. A clerk receives a recourse case and checks the legal situation. Based on the assessment, they either send a recourse claim to the liable party or close the case. If a claim is sent, the clerk waits for a response. If the liable party accepts, the payment is processed. If they reject, the clerk evaluates whether to escalate or close the case.`,
    '03': `A credit scoring process involves three participants: the Customer, the Bank, and the Credit Agency. The customer requests a loan from the bank. The bank sends a scoring request to the credit agency. The credit agency performs a credit check and returns the result. Based on the score, the bank either approves or rejects the loan application and notifies the customer.`,
    '04': `A self-service restaurant process involves three pools: the Guest, the Employee, and the Chef. The guest enters the restaurant and places an order. The employee records the order and sends it to the kitchen. The chef prepares the meal. When the meal is ready, a buzzer notifies the guest. If the guest does not pick up within 5 minutes, the buzzer is triggered again. The guest picks up the meal and pays.`,
  },
  de: {
    '01': `Ein kleines Unternehmen, das Hardware herstellt, hat einen Prozess für den Warenversand. Nachdem die Ware von der Logistikabteilung eingegangen ist, prüft ein Sachbearbeiter, ob ein Standard- oder Sonderversand erforderlich ist. Beim Standardversand füllt der Sachbearbeiter ein Postlabel aus und verpackt die Ware. Bei einem Sonderversand werden drei Angebote von Spediteuren eingeholt und das beste Angebot ausgewählt. Dann wird eine Versicherung abgeschlossen und die Ware verpackt. Nach dem Verpacken prüft ein Logistikleiter den Paketinhalt, der Versand wird durchgeführt und der Kunde benachrichtigt.`,
    '02': `Eine Versicherung bearbeitet Regressfälle. Ein Sachbearbeiter erhält einen Regressfall und prüft die Rechtslage. Basierend auf der Einschätzung sendet er entweder eine Regressforderung an den Haftpflichtigen oder schließt den Fall. Bei einer gesendeten Forderung wartet der Sachbearbeiter auf eine Antwort. Bei Akzeptanz wird die Zahlung verarbeitet. Bei Ablehnung wird entschieden, ob eskaliert oder der Fall geschlossen wird.`,
    '03': `Ein Schufa-Scoring-Prozess umfasst drei Teilnehmer: den Kunden, die Bank und die Schufa. Der Kunde beantragt einen Kredit bei der Bank. Die Bank sendet eine Scoring-Anfrage an die Schufa. Die Schufa führt eine Bonitätsprüfung durch und liefert das Ergebnis. Basierend auf dem Score genehmigt oder lehnt die Bank den Kreditantrag ab und benachrichtigt den Kunden.`,
    '04': `Ein Selbstbedienungsrestaurant-Prozess umfasst drei Pools: den Gast, den Mitarbeiter und den Koch. Der Gast betritt das Restaurant und gibt eine Bestellung auf. Der Mitarbeiter nimmt die Bestellung auf und leitet sie an die Küche weiter. Der Koch bereitet das Essen zu. Wenn das Essen fertig ist, wird der Gast per Buzzer benachrichtigt. Holt der Gast das Essen nicht innerhalb von 5 Minuten ab, wird der Buzzer erneut ausgelöst. Der Gast holt das Essen ab und bezahlt.`,
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────

function findBpmnFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...findBpmnFiles(full));
    } else if (extname(entry).toLowerCase() === '.bpmn') {
      results.push(full);
    }
  }
  return results;
}

async function convertAndScore(bpmnPath) {
  try {
    const xml = readFileSync(bpmnPath, 'utf8');
    const logicCore = await bpmnToLogicCore(xml);
    const { errors: valErrors, warnings: valWarnings } = validateLogicCore(logicCore);
    const ruleResult = runRules(logicCore);

    return {
      path: bpmnPath,
      logicCore,
      validation: { errors: valErrors.length, warnings: valWarnings.length },
      compliance: { errors: ruleResult.errors.length, warnings: ruleResult.warnings.length },
      nodeCount: countNodes(logicCore),
      isValid: valErrors.length === 0,
      isCompliant: ruleResult.errors.length === 0,
      parseError: null,
    };
  } catch (err) {
    return {
      path: bpmnPath,
      logicCore: null,
      parseError: err.message,
      isValid: false,
      isCompliant: false,
    };
  }
}

function countNodes(lc) {
  const processes = lc.pools ? lc.pools : [lc];
  return processes.reduce((sum, p) => sum + (p.nodes || []).length, 0);
}

function toTrainingSample(description, logicCore, lang, exerciseId) {
  const instruction = lang === 'de'
    ? 'Konvertiere diese Prozessbeschreibung in Logic-Core JSON nach dem BPMN 2.0 Schema.'
    : 'Convert this process description to Logic-Core JSON following the BPMN 2.0 schema.';

  return {
    instruction,
    input: description,
    output: JSON.stringify(logicCore),
    metadata: { lang, exerciseId },
  };
}

// ── Main ────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  return {
    researchDir: flag('--research'),
    iwfBpmnDir: flag('--iwf-bpmn'),
    outputDir: flag('--output') || 'training',
    statsOnly: args.includes('--stats-only'),
  };
}

const config = parseArgs();

if (!config.researchDir && !config.iwfBpmnDir) {
  console.error('Usage: node prepare-training-data.js --research <path> [--iwf-bpmn <path>] [--output <dir>]');
  process.exit(1);
}

mkdirSync(config.outputDir, { recursive: true });

const stats = {
  total: 0, parsed: 0, parseFailed: 0,
  valid: 0, compliant: 0,
  byExercise: {},
  byLang: { en: 0, de: 0, iwf: 0 },
};

const allSamples = [];

// ── Process Research Dataset ────────────────────────────────────────────

if (config.researchDir) {
  const baseDir = join(config.researchDir, 'BPMN for Research');

  for (const lang of ['en', 'de']) {
    const exercises = EXERCISES[lang];
    for (const [exId, exInfo] of Object.entries(exercises)) {
      // English: 02-Results / 03-Solution; German: 02-Ergebnisse (no model solutions)
      const solutionDir = join(baseDir, exInfo.dir, lang === 'en' ? '02-Results' : '02-Ergebnisse');
      const modelDir = join(baseDir, exInfo.dir, '03-Solution');
      const key = `${lang}_${exId}`;
      stats.byExercise[key] = { total: 0, parsed: 0, valid: 0, compliant: 0 };

      // Collect all BPMN files (student + model solutions)
      const bpmnFiles = [...findBpmnFiles(solutionDir), ...findBpmnFiles(modelDir)];

      for (const bpmnPath of bpmnFiles) {
        stats.total++;
        stats.byExercise[key].total++;

        const result = await convertAndScore(bpmnPath);

        if (result.parseError) {
          stats.parseFailed++;
          continue;
        }

        stats.parsed++;
        stats.byExercise[key].parsed++;
        stats.byLang[lang]++;

        if (result.isValid) {
          stats.valid++;
          stats.byExercise[key].valid++;
        }
        if (result.isCompliant) {
          stats.compliant++;
          stats.byExercise[key].compliant++;
        }

        // Only create training samples from valid + compliant models
        if (result.isValid && result.isCompliant) {
          const description = DESCRIPTIONS[lang]?.[exId];
          if (description) {
            allSamples.push(toTrainingSample(description, result.logicCore, lang, exId));
          }
        }
      }
    }
  }
}

// ── Process IWF BPMNs ───────────────────────────────────────────────────

if (config.iwfBpmnDir) {
  const bpmnFiles = findBpmnFiles(config.iwfBpmnDir);

  for (const bpmnPath of bpmnFiles) {
    if (bpmnPath.endsWith('.meta.json')) continue;

    stats.total++;
    const result = await convertAndScore(bpmnPath);

    if (result.parseError) {
      stats.parseFailed++;
      continue;
    }

    stats.parsed++;
    stats.byLang.iwf++;

    if (result.isValid) stats.valid++;
    if (result.isCompliant) stats.compliant++;

    // IWF: use page title from meta.json as pseudo-description
    if (result.isValid && result.isCompliant) {
      const metaPath = bpmnPath.replace(/\.bpmn$/, '.meta.json');
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8'));
          const description = `Erstelle einen BPMN-Prozess für: ${meta.source_page_title || meta.attachment_title || basename(bpmnPath, '.bpmn')}`;
          allSamples.push(toTrainingSample(description, result.logicCore, 'de', 'iwf'));
        } catch { /* skip */ }
      }
    }
  }
}

// ── Output ──────────────────────────────────────────────────────────────

// Shuffle and split
const shuffled = allSamples.sort(() => Math.random() - 0.5);
const trainEnd = Math.floor(shuffled.length * 0.8);
const valEnd = Math.floor(shuffled.length * 0.9);

const train = shuffled.slice(0, trainEnd);
const val = shuffled.slice(trainEnd, valEnd);
const test = shuffled.slice(valEnd);

if (!config.statsOnly) {
  const toJsonl = (arr) => arr.map(s => JSON.stringify(s)).join('\n') + '\n';

  writeFileSync(join(config.outputDir, 'train.jsonl'), toJsonl(train), 'utf8');
  writeFileSync(join(config.outputDir, 'val.jsonl'), toJsonl(val), 'utf8');
  writeFileSync(join(config.outputDir, 'test.jsonl'), toJsonl(test), 'utf8');
}

// Stats
const statsOutput = {
  ...stats,
  samples: {
    total: allSamples.length,
    train: train.length,
    val: val.length,
    test: test.length,
  },
  qualityRates: {
    parseRate: stats.total > 0 ? `${((stats.parsed / stats.total) * 100).toFixed(1)}%` : 'N/A',
    validRate: stats.parsed > 0 ? `${((stats.valid / stats.parsed) * 100).toFixed(1)}%` : 'N/A',
    compliantRate: stats.parsed > 0 ? `${((stats.compliant / stats.parsed) * 100).toFixed(1)}%` : 'N/A',
  },
};

writeFileSync(join(config.outputDir, 'stats.json'), JSON.stringify(statsOutput, null, 2), 'utf8');

console.log(`\n✓ Training Data Preparation Complete\n`);
console.log(`  Total BPMN files:    ${stats.total}`);
console.log(`  Parsed successfully: ${stats.parsed} (${statsOutput.qualityRates.parseRate})`);
console.log(`  Parse failures:      ${stats.parseFailed}`);
console.log(`  Valid (0 errors):    ${stats.valid} (${statsOutput.qualityRates.validRate})`);
console.log(`  Compliant:           ${stats.compliant} (${statsOutput.qualityRates.compliantRate})`);
console.log(`\n  Training samples:    ${allSamples.length}`);
console.log(`    Train:  ${train.length}`);
console.log(`    Val:    ${val.length}`);
console.log(`    Test:   ${test.length}`);

if (Object.keys(stats.byExercise).length > 0) {
  console.log(`\n  Per Exercise:`);
  for (const [key, ex] of Object.entries(stats.byExercise)) {
    console.log(`    ${key}: ${ex.total} total, ${ex.parsed} parsed, ${ex.valid} valid, ${ex.compliant} compliant`);
  }
}

console.log(`\n  Output: ${config.outputDir}/`);
if (!config.statsOnly) {
  console.log(`    train.jsonl, val.jsonl, test.jsonl, stats.json`);
} else {
  console.log(`    stats.json (--stats-only mode)`);
}

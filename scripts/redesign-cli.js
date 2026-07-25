/**
 * CLI-Zugang zum Redesign-Werkzeugkasten (scripts/redesign.js).
 *
 * Macht den Werkzeugkasten von der Kommandozeile aus benutzbar, bevor es
 * irgendeinen programmatischen Aufrufer (Agent, interaktive Schleife) gibt.
 * Die CLI selbst trifft keine fachliche Entscheidung — sie reicht Parameter
 * 1:1 an preview()/apply() aus redesign.js durch und meldet deren Ergebnis.
 *
 * Verhaltensvertrag:
 *   - Vorschau ist der STANDARD. Ohne --apply wird nichts geschrieben.
 *   - Eine Verweigerung endet mit Rückgabewert ≠ 0 UND schreibt die
 *     Zieldatei nicht.
 *   - Bei Erfolg wird das Ergebnis geschrieben und der Änderungsdatensatz
 *     gemeldet (change.note + etwaige neue Warnungen).
 *   - Fehlt ein Pflichtparameter eines Transforms, wird dieser Parameter
 *     bewusst NICHT auf einen Default gesetzt (kein stilles Erraten) —
 *     die CLI überlässt die Verweigerung dem Transform selbst, damit dessen
 *     eigene, spezifische Begründung erscheint statt eines CLI-Ersatztexts.
 *
 * Usage:
 *   node redesign-cli.js <input.json> <transform> [Optionen] [--apply] [-o out.json]
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  previewParallelize, applyParallelize,
  previewMergeTasks, applyMergeTasks,
  previewRelane, applyRelane,
  previewReorderKnockouts, applyReorderKnockouts,
  previewIsolateException, applyIsolateException,
} from './redesign.js';

const TRANSFORMS = {
  parallelize:      [previewParallelize, applyParallelize],
  mergeTasks:       [previewMergeTasks, applyMergeTasks],
  relane:           [previewRelane, applyRelane],
  reorderKnockouts: [previewReorderKnockouts, applyReorderKnockouts],
  isolateException: [previewIsolateException, applyIsolateException],
};

/** Signalisiert einen CLI-seitigen Bedienungsfehler (nicht: eine Verweigerung durch den Transform). */
class UsageError extends Error {}

/**
 * Liest den Wert eines Flags. Ein Folge-Token, das selbst wie ein Flag
 * aussieht (führendes "--"), darf NIE als Wert durchgereicht werden — sonst
 * "verschluckt" ein fehlender Wert das naechste Flag: `--name --apply`
 * wuerde sonst den String "--apply" als Namen liefern, mergeTasks haette
 * einen (unsinnigen) Namen und wuerde NICHT verweigern, und die CLI meldete
 * Erfolg + schriebe eine Datei mit dem Knoten-Namen "--apply" — ein
 * stilles Erraten, exakt das, was dieses Werkzeug laut Vertrag ausschliesst.
 * Kein "--"-Präfix kommt in diesem Programm als legitimer Wert vor (Kennungen,
 * Bahn-Namen, Policy-JSON, Reihenfolgen) — daher ist "führendes --" ein
 * sicheres, false-positive-freies Erkennungsmerkmal für ein Flag-Token.
 * Ein tatsächlich wertloser Flag wie --apply wird nie ueber flag() gelesen
 * (er wird per argv.includes('--apply') geprüft) und bleibt daher unberührt.
 */
function flag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (value !== undefined && value.startsWith('--')) return undefined;
  return value;
}

function splitList(value) {
  return value === undefined ? undefined : value.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * true/false → echter Boolean. Alles andere (auch nicht gesetzt) bleibt
 * unveraendert bzw. undefined durchgereicht: previewIsolateException prueft
 * selbst `typeof cancelActivity !== 'boolean'` und verweigert mit seiner
 * eigenen, spezifischen Meldung — die CLI rät nicht, was der Aufrufer meinte.
 */
function parseBoolFlag(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value; // undefined bleibt undefined; jeder andere String bleibt String (kein Boolean)
}

function parsePolicy(raw) {
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new UsageError(`--policy ist kein gültiges JSON: ${e.message}`);
  }
}

/**
 * Baut die params für den gewählten Transform. Pflichtparameter werden NIE
 * defaulted — fehlt ein Flag, bleibt das entsprechende Feld undefined
 * (bzw. bei --nodes: die leere Liste, die preview*() selbst schon als
 * "zu wenige Schritte" verweigert). Jede Verweigerung wegen eines fehlenden
 * Pflichtparameters kommt so aus dem Transform selbst, nicht aus der CLI.
 */
function buildParams(transform, args) {
  const nodeIds = splitList(flag(args, '--nodes'));
  const policy = parsePolicy(flag(args, '--policy'));

  switch (transform) {
    case 'parallelize':
      return { nodeIds, policy };

    case 'mergeTasks':
      return { nodeIds, name: flag(args, '--name'), policy };

    case 'relane': {
      const node = flag(args, '--node');
      return { nodeId: node !== undefined ? node : (nodeIds ? nodeIds[0] : undefined),
               lane: flag(args, '--lane'), policy };
    }

    case 'reorderKnockouts':
      return { gatewayIds: nodeIds, order: splitList(flag(args, '--order')), policy };

    case 'isolateException':
      return {
        endId: flag(args, '--end'),
        attachTo: flag(args, '--attach-to'),
        marker: flag(args, '--marker'),
        cancelActivity: parseBoolFlag(flag(args, '--cancel-activity')),
        edgeIds: splitList(flag(args, '--edges')),
        policy,
      };

    default:
      // Unerreichbar: main() prüft TRANSFORMS[transform] bereits vor buildParams().
      throw new UsageError(`Unbekannter Eingriff: ${transform}`);
  }
}

function usage() {
  return [
    `Usage: node redesign-cli.js <input.json> <${Object.keys(TRANSFORMS).join('|')}> [Optionen] [--apply] [-o out.json]`,
    '',
    'Optionen:',
    '  --nodes a,b,c          Knoten-/Gateway-Kennungen (parallelize, mergeTasks, reorderKnockouts)',
    '  --node a               Einzelne Knoten-Kennung (relane; Alternative zu --nodes)',
    '  --name "..."           Name des gebündelten Schritts — Pflicht bei mergeTasks',
    '  --lane X               Zielbahn — Pflicht bei relane',
    '  --order g2,g1          Neue Reihenfolge — Pflicht bei reorderKnockouts, wird nie berechnet',
    '  --end xend             Ausnahme-Ende — Pflicht bei isolateException',
    '  --attach-to task       Host-Aufgabe — Pflicht bei isolateException',
    '  --marker timer         Boundary-Marker — Pflicht bei isolateException',
    '  --cancel-activity true|false   Pflicht bei isolateException, kein Default',
    '  --edges j2,j5          Eingehende Kanten des Ausnahme-Endes — nur bei Mehrdeutigkeit nötig',
    '  --policy \'{"protectNodes":[...],"protectLanes":[...]}\'',
    '  --apply                Ergebnis anwenden und schreiben (ohne: nur Vorschau, Standard)',
    '  -o out.json             Zielpfad (Default: <input ohne .json>.soll.json)',
  ].join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const [inputArg, transform] = argv;
  if (!inputArg || !transform || !TRANSFORMS[transform]) {
    console.error(usage());
    process.exit(1);
  }

  let lc;
  try {
    lc = JSON.parse(readFileSync(resolve(inputArg), 'utf8'));
  } catch (e) {
    console.error(`✗ Eingabe konnte nicht gelesen werden: ${e.message}`);
    process.exit(1);
  }

  let params;
  try {
    params = buildParams(transform, argv);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }

  const [preview, apply] = TRANSFORMS[transform];
  const pv = preview(lc, params);
  if (pv.feasible === 'none') {
    console.error(`✗ Nicht machbar: ${pv.reason}`);
    process.exit(1);
  }
  console.log(`✓ Machbar (${pv.feasible}): ${pv.scope.join(', ')}`);

  if (!argv.includes('--apply')) {
    console.log('Vorschau — nichts geschrieben. Mit --apply anwenden.');
    return;
  }

  // apply() wertet params intern erneut per preview() aus und wirft bei
  // Verweigerung eine Error mit derselben reason — derselbe Vertrag
  // (Rückgabewert ≠ 0, nichts geschrieben) gilt daher auch hier, falls
  // apply()s eigenes Rollback-Gate (Soundness nach der Änderung) anschlägt,
  // obwohl die Vorprüfung oben 'full'/'partial' meldete.
  let res;
  try {
    res = apply(lc, params);
  } catch (e) {
    console.error(`✗ Verweigert: ${e.message}`);
    process.exit(1);
  }

  const outPath = flag(argv, '-o') || `${inputArg.replace(/\.json$/, '')}.soll.json`;
  writeFileSync(outPath, JSON.stringify(res.lc, null, 2), 'utf8');
  console.log(`✓ ${res.change.note}`);
  console.log(`✓ Ergebnis → ${outPath}`);
  if (res.warnings.length) {
    console.warn('⚠ Neue Warnungen:');
    res.warnings.forEach(w => console.warn('  · ' + w));
  }
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main();
}

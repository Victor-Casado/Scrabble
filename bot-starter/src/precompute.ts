import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CONFIG } from "./config.js";
import {
  bestWordForLegalRack,
  buildExactBestByRack,
  encodeGainVector,
  enumerateLegalRacksOfSize,
  normalizeDictionary,
  resolvePrecomputeSettings,
  serializePrecomputedRack,
  tableSample,
  tileGainForLegalRack,
  type PrecomputeOptions,
  type PrecomputedWord,
  type PrecomputeSettings,
} from "./precompute_tables.js";

function dictionaryPath(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    ...CONFIG.dictionary.wordlistPathSegments,
  );
}

function precomputedRoot(): string {
  return path.join(process.cwd(), ...CONFIG.precompute.outputDirSegments);
}

function outputPath(...segments: string[]): string {
  return path.join(precomputedRoot(), ...segments);
}

function sizeFileName(size: number): string {
  return `${CONFIG.precompute.sizeFilePrefix}${size}${CONFIG.precompute.jsonFileExtension}`;
}

function splitOutputPath(dirName: string, size: number): string {
  return outputPath(dirName, sizeFileName(size));
}

function readDictionary(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    throw new Error(`[precompute] dictionary not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf8").split(/\r?\n/u);
}

function writePrettyJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(value, null, CONFIG.precompute.jsonIndent)}\n`,
  );
}

function writeJsonObjectFromEntries<T>(
  filePath: string,
  entries: Iterable<[string, T]>,
  serializeValue: (value: T) => string,
): number {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const handle = fs.openSync(filePath, "w");
  let count = CONFIG.count.none;
  let first = true;
  try {
    fs.writeSync(handle, "{");
    for (const [key, value] of entries) {
      if (!first) fs.writeSync(handle, ",");
      first = false;
      fs.writeSync(handle, JSON.stringify(key));
      fs.writeSync(handle, ":");
      fs.writeSync(handle, serializeValue(value));
      count += CONFIG.count.increment;
    }
    fs.writeSync(handle, "}\n");
  } finally {
    fs.closeSync(handle);
  }
  return count;
}

function compactBestWord(value: PrecomputedWord): string {
  return JSON.stringify([value.word, value.score]);
}

function emptyBestEntries(): Iterable<[string, PrecomputedWord]> {
  return [];
}

function logProgress(
  options: PrecomputeOptions,
  label: string,
  processed: number,
): void {
  if (!options.verbose) return;
  if (processed % CONFIG.precompute.progressInterval !== CONFIG.count.none) return;
  options.logger(`[precompute] ${label}: ${processed}`);
}

function buildBestWordsForSize(
  size: number,
  exactBest: Map<string, PrecomputedWord>,
  previousBest: Map<string, PrecomputedWord>,
  settings: PrecomputeSettings,
  options: PrecomputeOptions,
): Map<string, PrecomputedWord> {
  const currentBest = new Map<string, PrecomputedWord>();
  let processed = CONFIG.count.none;
  for (const counts of enumerateLegalRacksOfSize(settings, size)) {
    processed += CONFIG.count.increment;
    const best = bestWordForLegalRack(counts, exactBest, previousBest);
    if (best) currentBest.set(serializePrecomputedRack(counts), best);
    logProgress(options, `best words size ${size}`, processed);
  }
  options.logger(
    `[precompute] best words size ${size}: ${processed} legal racks, ${currentBest.size} scoring racks`,
  );
  return currentBest;
}

function writeBestWordsForSize(
  size: number,
  best: Map<string, PrecomputedWord>,
  options: PrecomputeOptions,
): void {
  const file = splitOutputPath(CONFIG.precompute.bestWordDirName, size);
  const count = writeJsonObjectFromEntries(file, best, compactBestWord);
  options.logger(`[precompute] wrote ${file} (${count} entries)`);
}

function writeTileGainsForSize(
  size: number,
  currentBest: Map<string, PrecomputedWord>,
  nextBest: Map<string, PrecomputedWord>,
  settings: PrecomputeSettings,
  options: PrecomputeOptions,
  priorTotals: Record<string, number>,
): number {
  const file = splitOutputPath(CONFIG.precompute.tileGainDirName, size);
  let processed = CONFIG.count.none;
  const entries = (function* (): Generator<[string, string]> {
    for (const counts of enumerateLegalRacksOfSize(settings, size)) {
      processed += CONFIG.count.increment;
      const key = serializePrecomputedRack(counts);
      const gains = tileGainForLegalRack(counts, currentBest, nextBest, settings);
      if (size === settings.letterPriorRackSize) {
        for (const letter of settings.letters) priorTotals[letter] += gains[letter];
      }
      logProgress(options, `tile gains size ${size}`, processed);
      yield [key, encodeGainVector(gains, settings.letters)];
    }
  })();
  const count = writeJsonObjectFromEntries(file, entries, JSON.stringify);
  options.logger(`[precompute] wrote ${file} (${count} entries)`);
  return processed;
}

function roundedPrior(total: number, count: number): number {
  if (count <= CONFIG.count.none) return CONFIG.count.none;
  return (
    Math.round((total / count) * CONFIG.precompute.priorPrecisionFactor) /
    CONFIG.precompute.priorPrecisionFactor
  );
}

function writeLetterPrior(
  priorTotals: Record<string, number>,
  priorRackCount: number,
  settings: PrecomputeSettings,
  options: PrecomputeOptions,
): void {
  const letterPrior = Object.fromEntries(
    settings.letters.map((letter) => [
      letter,
      roundedPrior(priorTotals[letter], priorRackCount),
    ]),
  );
  const rankedPrior = Object.entries(letterPrior)
    .sort(([, left], [, right]) => right - left)
    .map(([letter, value]) => `${letter}:${value}`)
    .join(", ");
  const file = outputPath(CONFIG.precompute.letterPriorFileName);
  writePrettyJson(file, letterPrior);
  options.logger(`[precompute] letter prior rack count: ${priorRackCount}`);
  options.logger(`[precompute] letter prior ranked: ${rankedPrior}`);
  options.logger(`[precompute] letter prior sample: ${tableSample(letterPrior)}`);
  options.logger(`[precompute] wrote ${file}`);
}

export function runPrecompute(argv: readonly string[] = process.argv): void {
  const verbose = !argv.includes(CONFIG.precompute.quietFlag);
  const log = (line: string) => {
    if (verbose) console.log(line);
  };

  const source = dictionaryPath();
  const options: PrecomputeOptions = { verbose, logger: log };
  const settings = resolvePrecomputeSettings(options);
  log(`[precompute] dictionary path: ${source}`);
  log(`[precompute] output dir: ${precomputedRoot()}`);
  log(`[precompute] max rack letters: ${settings.maxRackLetters}`);
  log(`[precompute] tile gain encoded base: ${CONFIG.precompute.gainEncodingBase}`);
  log(`[precompute] tile gain encoded width: ${CONFIG.precompute.gainEncodingWidth}`);

  const dictionary = readDictionary(source);
  log(`[precompute] raw dictionary rows: ${dictionary.length}`);

  const words = normalizeDictionary(dictionary, settings);
  log(
    `[precompute] normalized dictionary: ${dictionary.length} raw -> ${words.length} usable <= rack ${settings.maxRackLetters}`,
  );
  const exactBest = buildExactBestByRack(words, options, settings);
  log(`[precompute] exact rack keys: ${exactBest.size}`);

  writeJsonObjectFromEntries(
    splitOutputPath(CONFIG.precompute.bestWordDirName, CONFIG.count.none),
    emptyBestEntries(),
    compactBestWord,
  );

  let previousBest = new Map<string, PrecomputedWord>();
  const priorTotals = Object.fromEntries(
    settings.letters.map((letter) => [letter, CONFIG.count.none]),
  ) as Record<string, number>;
  let priorRackCount: number = CONFIG.count.none;

  for (
    let size = CONFIG.count.increment;
    size <= settings.maxRackLetters;
    size += CONFIG.count.increment
  ) {
    const currentBest = buildBestWordsForSize(
      size,
      exactBest,
      previousBest,
      settings,
      options,
    );
    writeBestWordsForSize(size, currentBest, options);
    const tileGainSize = size - CONFIG.count.increment;
    const writtenTileGainCount = writeTileGainsForSize(
      tileGainSize,
      previousBest,
      currentBest,
      settings,
      options,
      priorTotals,
    );
    if (tileGainSize === settings.letterPriorRackSize) {
      priorRackCount = writtenTileGainCount;
    }
    previousBest = currentBest;
  }

  log(
    `[precompute] skipped terminal tile_gain size ${settings.maxRackLetters}; live strategy should fall back for racks at or above cap`,
  );
  writeLetterPrior(priorTotals, priorRackCount, settings, options);
  log("[precompute] complete");
}

const invokedPath = process.argv[CONFIG.count.increment]
  ? pathToFileURL(process.argv[CONFIG.count.increment]).href
  : "";

if (import.meta.url === invokedPath) {
  runPrecompute();
}

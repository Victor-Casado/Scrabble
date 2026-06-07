import { CONFIG } from "./config.js";
import { scoreWord } from "./word_scoring.js";

export interface PrecomputedWord {
  word: string;
  score: number;
}

export type LetterPriorTable = Record<string, number>;
export type BestWordTable = Record<string, PrecomputedWord>;
export type TileGainTable = Record<string, Record<string, number>>;

export interface PrecomputeTables {
  letterPrior: LetterPriorTable;
  bestWord: BestWordTable;
  tileGain: TileGainTable;
}

export interface PrecomputeOptions {
  verbose: boolean;
  logger: (line: string) => void;
  maxRackLetters?: number;
  bagLimits?: Record<string, number>;
  letters?: readonly string[];
}

interface WordEntry extends PrecomputedWord {
  counts: Map<string, number>;
  key: string;
}

type MutableTotals = Record<string, number>;

export interface PrecomputeSettings {
  maxRackLetters: number;
  letterPriorRackSize: number;
  bagLimits: Record<string, number>;
  letters: readonly string[];
}

export function countsForWord(word: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const letter of word.toUpperCase()) {
    counts.set(letter, (counts.get(letter) ?? CONFIG.count.none) + CONFIG.count.increment);
  }
  return counts;
}

export function serializePrecomputedRack(counts: Map<string, number>): string {
  return [...counts.entries()]
    .filter(([, count]) => count > CONFIG.count.none)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([letter, count]) => `${letter}${count}`)
    .join("");
}

function totalLetters(counts: Map<string, number>): number {
  return [...counts.values()].reduce(
    (sum, count) => sum + count,
    CONFIG.count.none,
  );
}

export function resolvePrecomputeSettings(options: PrecomputeOptions): PrecomputeSettings {
  const maxRackLetters = options.maxRackLetters ?? CONFIG.precompute.maxRackLetters;
  return {
    maxRackLetters,
    letterPriorRackSize: Math.min(
      CONFIG.precompute.letterPriorRackSize,
      Math.max(CONFIG.count.none, maxRackLetters - CONFIG.count.increment),
    ),
    bagLimits: options.bagLimits ?? CONFIG.neat.game.startingBag,
    letters: options.letters ?? CONFIG.precompute.letters,
  };
}

function cloneWithTile(counts: Map<string, number>, letter: string): Map<string, number> {
  const next = new Map(counts);
  next.set(letter, (next.get(letter) ?? CONFIG.count.none) + CONFIG.count.increment);
  return next;
}

function withoutOneTile(counts: Map<string, number>, letter: string): Map<string, number> {
  const next = new Map(counts);
  const left = (next.get(letter) ?? CONFIG.count.none) - CONFIG.count.increment;
  if (left <= CONFIG.count.none) next.delete(letter);
  else next.set(letter, left);
  return next;
}

function betterWord(left: PrecomputedWord, right: PrecomputedWord | undefined): boolean {
  if (!right) return true;
  if (left.score !== right.score) return left.score > right.score;
  if (left.word.length !== right.word.length) return left.word.length > right.word.length;
  return left.word.localeCompare(right.word) < CONFIG.count.none;
}

function roundPrior(value: number): number {
  return (
    Math.round(value * CONFIG.precompute.priorPrecisionFactor) /
    CONFIG.precompute.priorPrecisionFactor
  );
}

export function normalizeDictionary(
  dictionary: readonly string[],
  settings: PrecomputeSettings,
): string[] {
  return [
    ...new Set(
      dictionary
        .map((word) => word.trim().toUpperCase())
        .filter((word) => word.length >= CONFIG.dictionary.minWordLength)
        .filter((word) => word.length <= settings.maxRackLetters)
        .filter((word) => countsFitBag(countsForWord(word), settings)),
    ),
  ];
}

function countsFitBag(
  counts: Map<string, number>,
  settings: PrecomputeSettings,
): boolean {
  for (const [letter, count] of counts) {
    if (count > (settings.bagLimits[letter] ?? CONFIG.count.none)) return false;
  }
  return true;
}

export function* enumerateLegalRacksOfSize(
  settings: PrecomputeSettings,
  targetSize: number,
): Generator<Map<string, number>> {
  const current = new Map<string, number>();

  function* walk(index: number, currentTotal: number): Generator<Map<string, number>> {
    if (currentTotal > targetSize) return;
    if (index === settings.letters.length) {
      if (currentTotal === targetSize) yield new Map(current);
      return;
    }

    const letter = settings.letters[index];
    const count = settings.bagLimits[letter] ?? CONFIG.count.none;
    for (
      let amount = CONFIG.count.none;
      amount <= Math.min(count, targetSize - currentTotal);
      amount += CONFIG.count.increment
    ) {
      if (amount <= CONFIG.count.none) current.delete(letter);
      else current.set(letter, amount);
      yield* walk(index + CONFIG.count.increment, currentTotal + amount);
    }
    current.delete(letter);
  }

  yield* walk(CONFIG.count.none, CONFIG.count.none);
}

function logProgress(
  options: PrecomputeOptions,
  label: string,
  processed: number,
  total: number,
): void {
  if (!options.verbose) return;
  if (processed % CONFIG.precompute.progressInterval !== CONFIG.count.none) return;
  options.logger(`[precompute] ${label}: ${processed}/${total}`);
}

export function tableSample<T>(table: Record<string, T>): string {
  return Object.entries(table)
    .slice(CONFIG.count.none, CONFIG.precompute.sampleOutputCount)
    .map(([key, value]) => `${key || "<empty>"}=${JSON.stringify(value)}`)
    .join(", ");
}

function canAddTile(
  counts: Map<string, number>,
  letter: string,
  settings: PrecomputeSettings,
): boolean {
  if (totalLetters(counts) >= settings.maxRackLetters) return false;
  return (counts.get(letter) ?? CONFIG.count.none) < (settings.bagLimits[letter] ?? CONFIG.count.none);
}

function buildLetterPrior(
  tileGain: TileGainTable,
  settings: PrecomputeSettings,
  options: PrecomputeOptions,
): LetterPriorTable {
  let selectedRackCount = CONFIG.count.none;
  let totals = Object.fromEntries(
    settings.letters.map((letter) => [letter, CONFIG.count.none]),
  ) as MutableTotals;

  for (const counts of enumerateLegalRacksOfSize(settings, settings.letterPriorRackSize)) {
    const key = serializePrecomputedRack(counts);
    const gains = tileGain[key];
    if (!gains) continue;
    selectedRackCount += CONFIG.count.increment;
    for (const letter of settings.letters) totals[letter] += gains[letter];
  }

  if (selectedRackCount === CONFIG.count.none) {
    totals = Object.fromEntries(
      settings.letters.map((letter) => [letter, CONFIG.count.none]),
    ) as MutableTotals;
    for (
      let size = CONFIG.count.none;
      size <= settings.maxRackLetters;
      size += CONFIG.count.increment
    ) {
      for (const counts of enumerateLegalRacksOfSize(settings, size)) {
        const key = serializePrecomputedRack(counts);
        const gains = tileGain[key];
        if (!gains) continue;
        selectedRackCount += CONFIG.count.increment;
        for (const letter of settings.letters) totals[letter] += gains[letter];
      }
    }
    if (options.verbose) {
      options.logger(
        `[precompute] no racks at prior size ${settings.letterPriorRackSize}; using all ${selectedRackCount} racks`,
      );
    }
  }

  if (options.verbose) {
    options.logger(
      `[precompute] letter prior rack size ${settings.letterPriorRackSize}: ${selectedRackCount} racks`,
    );
  }

  return Object.fromEntries(
    settings.letters.map((letter) => [
      letter,
      selectedRackCount === CONFIG.count.none
        ? CONFIG.count.none
        : roundPrior(totals[letter] / selectedRackCount),
    ]),
  );
}

export function buildExactBestByRack(
  words: readonly string[],
  options: PrecomputeOptions,
  settings: PrecomputeSettings,
): Map<string, PrecomputedWord> {
  const exactBest = new Map<string, PrecomputedWord>();
  for (const [index, word] of words.entries()) {
    const counts = countsForWord(word);
    const key = serializePrecomputedRack(counts);
    const entry = { word, score: scoreWord(word) };
    const current = exactBest.get(key);
    if (betterWord(entry, current)) exactBest.set(key, entry);
    logProgress(
      options,
      "indexed exact word racks",
      index + CONFIG.count.increment,
      words.length,
    );
  }
  return exactBest;
}

export function bestWordForLegalRack(
  counts: Map<string, number>,
  exactBest: Map<string, PrecomputedWord>,
  previousBest: Map<string, PrecomputedWord>,
): PrecomputedWord | undefined {
  const key = serializePrecomputedRack(counts);
  let best = exactBest.get(key);
  for (const [letter] of counts) {
    const previous = previousBest.get(serializePrecomputedRack(withoutOneTile(counts, letter)));
    if (previous && betterWord(previous, best)) best = previous;
  }
  return best;
}

export function encodeGainVector(
  gains: Record<string, number>,
  letters: readonly string[],
): string {
  return letters
    .map((letter) =>
      gains[letter]
        .toString(CONFIG.precompute.gainEncodingBase)
        .padStart(CONFIG.precompute.gainEncodingWidth, "0"),
    )
    .join("");
}

export function tileGainForLegalRack(
  counts: Map<string, number>,
  currentBest: Map<string, PrecomputedWord>,
  nextBest: Map<string, PrecomputedWord>,
  settings: PrecomputeSettings,
): Record<string, number> {
  const key = serializePrecomputedRack(counts);
  const gains: Record<string, number> = {};
  const currentScore = currentBest.get(key)?.score ?? CONFIG.count.none;
  for (const letter of settings.letters) {
    if (!canAddTile(counts, letter, settings)) {
      gains[letter] = CONFIG.count.none;
      continue;
    }
    const withTile = cloneWithTile(counts, letter);
    const withKey = serializePrecomputedRack(withTile);
    const nextScore = nextBest.get(withKey)?.score ?? CONFIG.count.none;
    gains[letter] = Math.max(CONFIG.count.none, nextScore - currentScore);
  }
  return gains;
}

export function buildPrecomputeTables(
  dictionary: readonly string[],
  options: PrecomputeOptions,
): PrecomputeTables {
  const settings = resolvePrecomputeSettings(options);
  const words = normalizeDictionary(dictionary, settings);
  if (options.verbose) {
    options.logger(
      `[precompute] normalized dictionary: ${dictionary.length} raw -> ${words.length} usable <= rack ${settings.maxRackLetters}`,
    );
  }

  const exactBest = buildExactBestByRack(words, options, settings);
  if (options.verbose) {
    options.logger(`[precompute] exact rack keys: ${exactBest.size}`);
  }

  const bestBySize = new Map<number, Map<string, PrecomputedWord>>();
  const bestWord: BestWordTable = {};
  let previousBest = new Map<string, PrecomputedWord>();
  bestBySize.set(CONFIG.count.none, previousBest);

  for (
    let size = CONFIG.count.increment;
    size <= settings.maxRackLetters;
    size += CONFIG.count.increment
  ) {
    const currentBest = new Map<string, PrecomputedWord>();
    let processed = CONFIG.count.none;
    for (const counts of enumerateLegalRacksOfSize(settings, size)) {
      processed += CONFIG.count.increment;
      const key = serializePrecomputedRack(counts);
      const best = bestWordForLegalRack(counts, exactBest, previousBest);
      if (best) {
        currentBest.set(key, { word: best.word, score: best.score });
        bestWord[key] = { word: best.word, score: best.score };
      }
      logProgress(options, `resolved legal best words size ${size}`, processed, processed);
    }
    bestBySize.set(size, currentBest);
    previousBest = currentBest;
    if (options.verbose) {
      options.logger(
        `[precompute] legal best words size ${size}: ${currentBest.size} scoring racks`,
      );
    }
  }

  if (options.verbose) {
    options.logger(`[precompute] best-word entries: ${Object.keys(bestWord).length}`);
    options.logger(`[precompute] best-word sample: ${tableSample(bestWord)}`);
  }

  const tileGain: TileGainTable = {};
  for (
    let size = CONFIG.count.none;
    size <= settings.maxRackLetters;
    size += CONFIG.count.increment
  ) {
    const currentBest = bestBySize.get(size) ?? new Map<string, PrecomputedWord>();
    const nextBest = bestBySize.get(size + CONFIG.count.increment) ?? new Map<string, PrecomputedWord>();
    let processed = CONFIG.count.none;
    for (const counts of enumerateLegalRacksOfSize(settings, size)) {
      processed += CONFIG.count.increment;
      const key = serializePrecomputedRack(counts);
      tileGain[key] = tileGainForLegalRack(counts, currentBest, nextBest, settings);
      logProgress(options, `resolved legal tile gains size ${size}`, processed, processed);
    }
  }

  if (options.verbose) {
    options.logger(`[precompute] tile-gain entries: ${Object.keys(tileGain).length}`);
    options.logger(`[precompute] tile-gain sample: ${tableSample(tileGain)}`);
  }

  const letterPrior = buildLetterPrior(tileGain, settings, options);
  if (options.verbose) {
    const rankedPrior = Object.entries(letterPrior)
      .sort(([, left], [, right]) => right - left)
      .map(([letter, value]) => `${letter}:${value}`)
      .join(", ");
    options.logger(`[precompute] letter prior ranked: ${rankedPrior}`);
  }

  return { letterPrior, bestWord, tileGain };
}

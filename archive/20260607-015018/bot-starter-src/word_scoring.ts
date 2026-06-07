import { CONFIG } from "./config.js";

const bestScoreCacheByDictionary = new WeakMap<readonly string[], Map<string, number>>();

export function scoreWord(word: string): number {
  const base = [...word.toUpperCase()].reduce<number>(
    (sum, letter) =>
      sum + (CONFIG.bidding.letterValues[letter] ?? CONFIG.bidding.fallbackLetterValue),
    CONFIG.count.none,
  );
  const len = word.length;
  if (len <= CONFIG.scoring.threeLetterMaxLength) return base;
  if (len === CONFIG.scoring.fourLetterLength) {
    return Math.floor(
      (base * CONFIG.scoring.fourLetterNumerator) /
        CONFIG.scoring.fourLetterDenominator,
    );
  }
  if (len === CONFIG.scoring.fiveLetterLength) {
    return base * CONFIG.scoring.fiveLetterMultiplier;
  }
  if (len === CONFIG.scoring.sixLetterLength) {
    return Math.floor(
      (base * CONFIG.scoring.sixLetterNumerator) /
        CONFIG.scoring.sixLetterDenominator,
    );
  }
  return base * CONFIG.scoring.sevenPlusMultiplier;
}

export function canFormWord(word: string, rackCounts: Map<string, number>): boolean {
  const seen = new Map<string, number>();
  for (const letter of word) {
    const next = (seen.get(letter) ?? CONFIG.count.none) + CONFIG.count.increment;
    if (next > (rackCounts.get(letter) ?? CONFIG.count.none)) return false;
    seen.set(letter, next);
  }
  return true;
}

export function rackKey(rackCounts: Map<string, number>): string {
  return [...rackCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([letter, count]) => `${letter}${count}`)
    .join("");
}

export function bestRackWordScore(
  rackCounts: Map<string, number>,
  dictionary: readonly string[],
): number {
  let cache = bestScoreCacheByDictionary.get(dictionary);
  if (!cache) {
    cache = new Map<string, number>();
    bestScoreCacheByDictionary.set(dictionary, cache);
  }

  const key = rackKey(rackCounts);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let best: number = CONFIG.count.none;
  for (const word of dictionary) {
    const score = scoreWord(word);
    if (score <= best) continue;
    if (canFormWord(word, rackCounts)) best = score;
  }

  cache.set(key, best);
  return best;
}

export function rackScoreGainForTile(
  rackCounts: Map<string, number>,
  tile: string,
  dictionary: readonly string[],
): number {
  const currentScore = bestRackWordScore(rackCounts, dictionary);
  const withTile = new Map(rackCounts);
  withTile.set(tile, (withTile.get(tile) ?? CONFIG.count.none) + CONFIG.count.increment);
  return Math.max(
    CONFIG.live.noRackGain,
    bestRackWordScore(withTile, dictionary) - currentScore,
  );
}

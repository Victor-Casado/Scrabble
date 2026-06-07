import { CONFIG } from "../src/config.js";
import type { OpponentModel } from "./opponentModel.js";
import { probabilityOpponentNeeds } from "./rackInference.js";

const VOWELS = new Set(["A", "E", "I", "O", "U"]);
const COMMON_FINISHERS = new Set(["S", "E", "R", "D", "N", "T"]);
const SCARCE_LEVERAGE: Record<string, number> = {
  J: 3,
  Q: 2,
  X: 4,
  Z: 4,
  S: 5,
};

function rackArrayToCounts(rack: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const letter of rack) {
    const normalized = letter.toUpperCase();
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }
  return counts;
}

function countsToArray(rack: Map<string, number>): string[] {
  const letters: string[] = [];
  for (const [letter, count] of rack.entries()) {
    for (let index = 0; index < count; index += 1) letters.push(letter);
  }
  return letters;
}

export function rackCountsToArray(rack: Map<string, number>): string[] {
  return countsToArray(rack);
}

export function scoreLetterForRack(rack: string[], letter: string): number {
  const normalized = letter.toUpperCase();
  const counts = rackArrayToCounts(rack);
  const rackSize = rack.length;
  let vowels = 0;
  for (const held of rack) {
    if (VOWELS.has(held.toUpperCase())) vowels += 1;
  }
  const vowelRatio = rackSize === 0 ? 0 : vowels / rackSize;

  let score =
    CONFIG.bidding.letterValues[normalized] ?? CONFIG.bidding.fallbackLetterValue;

  if (VOWELS.has(normalized) && vowelRatio < 0.35) score += 5;
  if (!VOWELS.has(normalized) && vowelRatio > 0.65) score += 4;
  if (normalized === "S") score += 7;
  if (COMMON_FINISHERS.has(normalized)) score += 2;
  if (normalized === "U" && (counts.get("Q") ?? 0) > 0) score += 8;
  if (normalized === "Q" && (counts.get("U") ?? 0) === 0) score -= 6;

  const duplicateCount = counts.get(normalized) ?? 0;
  if (duplicateCount >= 2 && normalized !== "E" && normalized !== "S") {
    score -= duplicateCount * 2;
  }

  return Math.max(0, Math.round(score));
}

export function computeDenialValue(
  letter: string,
  opponents: readonly OpponentModel[],
): number {
  const normalized = letter.toUpperCase();
  let value = SCARCE_LEVERAGE[normalized] ?? 1;

  for (const opponent of opponents) {
    const need = probabilityOpponentNeeds(opponent.inferredRack, normalized);
    const strength =
      opponent.classification === "aggressive" || opponent.classification === "hoarder"
        ? 1.25
        : opponent.classification === "frugal"
          ? 0.75
          : 1;
    const bidPressure = Math.min(2, opponent.averageBidEstimate / 10);
    value += need * strength * (2 + bidPressure * 3);
  }

  return Math.max(0, Math.round(value));
}

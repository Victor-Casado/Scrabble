import type { OpponentModel } from "./opponentModel.js";

const VOWELS = new Set(["A", "E", "I", "O", "U"]);

export function predictOpponentBid(model: OpponentModel, letter: string): number {
  const normalized = letter.toUpperCase();
  let estimate = model.averageBidEstimate > 0 ? model.averageBidEstimate : 4;

  if (VOWELS.has(normalized)) {
    estimate += model.vowelAggression * 4;
  } else {
    estimate += model.consonantAggression * 2;
  }

  if (normalized === "S") estimate += 6 * Math.max(0.5, model.sPreference);

  switch (model.classification) {
    case "aggressive":
      estimate *= 1.25;
      break;
    case "frugal":
      estimate *= 0.65;
      break;
    case "hoarder":
      estimate *= normalized === "S" || VOWELS.has(normalized) ? 1.15 : 0.95;
      break;
    case "short-word-spammer":
      estimate *= normalized === "S" ? 1.2 : 0.9;
      break;
    case "unknown":
      break;
  }

  return Math.max(0, Math.round(estimate));
}

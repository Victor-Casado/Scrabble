import type { OpponentModel } from "./opponentModel.js";

export type Classification =
  | "unknown"
  | "aggressive"
  | "frugal"
  | "hoarder"
  | "short-word-spammer";

export function classifyOpponent(model: OpponentModel): Classification {
  if (model.auctionsSeen < 3) return "unknown";

  if (
    model.playFrequency >= 0.45 &&
    model.averageWordLength > 0 &&
    model.averageWordLength <= 3.5
  ) {
    return "short-word-spammer";
  }

  if (model.hoardingScore >= 6 && model.playFrequency <= 0.2) {
    return "hoarder";
  }

  if (model.averageBidEstimate >= 14 || model.auctionsWon / model.auctionsSeen >= 0.55) {
    return "aggressive";
  }

  if (model.averageBidEstimate > 0 && model.averageBidEstimate <= 4) {
    return "frugal";
  }

  return "unknown";
}

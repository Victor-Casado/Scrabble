import type { OpponentModel } from "./opponentModel.js";
import type { TournamentPhase } from "./phase.js";

function compact(value: unknown): string {
  return String(value).replace(/\s+/g, "_");
}

export function logPhase(phase: TournamentPhase): void {
  console.log(`[PHASE] ${phase}`);
}

export function logModel(model: OpponentModel): void {
  console.log(`[MODEL] ${compact(model.id)}=${model.classification}`);
}

export function logPrediction(id: string, bid: number): void {
  console.log(`[PREDICTION] ${compact(id)} bid~${bid}`);
}

export function logBid(parts: {
  self: number;
  denial: number;
  price: number;
  final: number;
  base: number;
  phase: TournamentPhase;
}): void {
  console.log(
    `[BID] self=${parts.self} denial=${parts.denial} price=${parts.price} base=${parts.base} phase=${parts.phase} final=${parts.final}`,
  );
}

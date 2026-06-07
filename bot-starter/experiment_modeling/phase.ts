export type TournamentPhase = "learn" | "exploit" | "duel";

export function selectTournamentPhase(playersRemaining: number): TournamentPhase {
  if (playersRemaining <= 2) return "duel";
  if (playersRemaining <= 4) return "exploit";
  return "learn";
}

export function denialMultiplierForPhase(phase: TournamentPhase): number {
  switch (phase) {
    case "learn":
      return 0.2;
    case "exploit":
      return 0.65;
    case "duel":
      return 0.95;
  }
}

export function maxSpendFractionForPhase(phase: TournamentPhase): number {
  switch (phase) {
    case "learn":
      return 0.25;
    case "exploit":
      return 0.4;
    case "duel":
      return 0.7;
  }
}

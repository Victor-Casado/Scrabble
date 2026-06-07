export const MIN_RESIDUAL_TRAINING_DECISIONS = 40;

export function shouldTrainResiduals(decisionCount: number): boolean {
  return decisionCount >= MIN_RESIDUAL_TRAINING_DECISIONS;
}

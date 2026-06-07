import type { TournamentPhase } from "./phase.js";

export type ResidualAction = -4 | -2 | 0 | 2 | 5 | 8;
export type RackBucket =
  | "vowel-starved"
  | "consonant-starved"
  | "balanced"
  | "s-hungry"
  | "q-needs-u"
  | "large-rack";
export type BalanceBucket = "broke" | "thin" | "healthy" | "rich";
export type OpponentPressureBucket = "unknown" | "low" | "medium" | "high";
export type LetterGroup =
  | "s"
  | "vowel"
  | "common-consonant"
  | "premium"
  | "q"
  | "other";

export interface ResidualBucket {
  phase: TournamentPhase;
  letter: string;
  rackBucket: RackBucket;
  balanceBucket: BalanceBucket;
  opponentPressureBucket: OpponentPressureBucket;
  auctionType: "FirstPrice" | "Vickrey";
}

export interface ResidualDecision {
  key: string;
  residual: ResidualAction;
}

export interface ActionStats {
  count: number;
  value: number;
}

export interface SerializedResidualLearner {
  version: 1;
  matrix: Record<string, Partial<Record<string, ActionStats>>>;
  updates: number;
  warmupUpdates: number;
  explorationRate: number;
}

const ACTIONS: readonly ResidualAction[] = [-4, -2, 0, 2, 5, 8];
const ZERO_BASELINE_SAMPLES = 3;
const EXPLORATION = 0.65;
const MIN_BASELINE_CHOICES = 3;
const DEFAULT_WARMUP_UPDATES = 3;
const DEFAULT_EXPLORATION_RATE = 0.12;
const PROVEN_COUNT = 2;
const PROVEN_MARGIN = 0.05;

export interface ResidualLearnerOptions {
  warmupUpdates?: number;
  explorationRate?: number;
}

function actionKey(action: ResidualAction): string {
  return String(action);
}

function clampReward(reward: number): number {
  return Math.max(-1, Math.min(1, reward));
}

export class ResidualLearner {
  private readonly matrix = new Map<string, Map<ResidualAction, ActionStats>>();
  private updates = 0;
  private readonly warmupUpdates: number;
  private readonly explorationRate: number;

  constructor(options: ResidualLearnerOptions = {}) {
    this.warmupUpdates = Math.max(
      0,
      Math.floor(options.warmupUpdates ?? DEFAULT_WARMUP_UPDATES),
    );
    this.explorationRate = Math.max(
      0,
      Math.min(1, options.explorationRate ?? DEFAULT_EXPLORATION_RATE),
    );
  }

  keyFor(bucket: ResidualBucket): string {
    return [
      bucket.phase,
      letterGroupFor(bucket.letter),
      bucket.rackBucket,
      bucket.balanceBucket,
      bucket.opponentPressureBucket,
      bucket.auctionType,
    ].join("|");
  }

  choose(bucket: ResidualBucket): ResidualDecision {
    const key = this.keyFor(bucket);
    const actionStats = this.ensureBucket(key);
    if (this.updates < this.warmupUpdates) return { key, residual: 0 };
    const total = [...actionStats.values()].reduce((sum, stats) => sum + stats.count, 0);

    if (total < ZERO_BASELINE_SAMPLES + MIN_BASELINE_CHOICES) {
      return { key, residual: 0 };
    }

    const zero = actionStats.get(0) ?? { count: 0, value: 0 };
    const zeroAverage = zero.count === 0 ? 0 : zero.value / zero.count;
    let bestAction: ResidualAction = 0;
    let bestScore = zeroAverage;
    for (const action of ACTIONS) {
      if (action === 0) continue;
      const stats = actionStats.get(action) ?? { count: 0, value: 0 };
      if (stats.count < PROVEN_COUNT) continue;
      const average = stats.value / stats.count;
      const score = average + EXPLORATION * Math.sqrt(Math.log(total + 1) / stats.count);
      if (score > bestScore) {
        bestScore = score;
        bestAction = action;
      }
    }

    if (bestAction !== 0 && bestScore >= zeroAverage + PROVEN_MARGIN) {
      return { key, residual: bestAction };
    }

    const exploratory = this.explorationActionFor(bucket.phase, key, actionStats);
    if (exploratory !== 0) return { key, residual: exploratory };

    return { key, residual: bestAction };
  }

  update(decisions: readonly ResidualDecision[], reward: number): void {
    this.updates += 1;
    const normalizedReward = clampReward(reward);
    for (const decision of decisions) {
      const actionStats = this.ensureBucket(decision.key);
      const stats = actionStats.get(decision.residual) ?? { count: 0, value: 0 };
      actionStats.set(decision.residual, {
        count: stats.count + 1,
        value: stats.value + normalizedReward,
      });
    }
  }

  statsFor(key: string, residual: ResidualAction): ActionStats {
    return this.ensureBucket(key).get(residual) ?? { count: 0, value: 0 };
  }

  toJSON(): SerializedResidualLearner {
    const matrix: SerializedResidualLearner["matrix"] = {};
    for (const [key, actionStats] of this.matrix.entries()) {
      matrix[key] = {};
      for (const [action, stats] of actionStats.entries()) {
        matrix[key][actionKey(action)] = { ...stats };
      }
    }
    return {
      version: 1,
      matrix,
      updates: this.updates,
      warmupUpdates: this.warmupUpdates,
      explorationRate: this.explorationRate,
    };
  }

  load(serialized: SerializedResidualLearner): void {
    this.matrix.clear();
    this.updates = Math.max(0, Math.floor(Number(serialized.updates ?? 0)));
    for (const [key, actions] of Object.entries(serialized.matrix)) {
      const actionStats = this.ensureBucket(key);
      for (const [rawAction, stats] of Object.entries(actions)) {
        const action = Number(rawAction) as ResidualAction;
        if (!ACTIONS.includes(action)) continue;
        actionStats.set(action, {
          count: Math.max(0, Number(stats?.count ?? 0)),
          value: Number(stats?.value ?? 0),
        });
      }
    }
  }

  private ensureBucket(key: string): Map<ResidualAction, ActionStats> {
    let actionStats = this.matrix.get(key);
    if (!actionStats) {
      actionStats = new Map<ResidualAction, ActionStats>([
        [0, { count: ZERO_BASELINE_SAMPLES, value: 0 }],
      ]);
      this.matrix.set(key, actionStats);
    }
    return actionStats;
  }

  private explorationActionFor(
    phase: TournamentPhase,
    key: string,
    actionStats: Map<ResidualAction, ActionStats>,
  ): ResidualAction {
    const phaseRate =
      phase === "learn"
        ? this.explorationRate * 0.25
        : phase === "exploit"
          ? this.explorationRate
          : this.explorationRate;
    if (phaseRate <= 0) return 0;
    if (hashFraction(`${key}|${this.updates}`) >= phaseRate) return 0;
    const explorationOrder: readonly ResidualAction[] =
      phase === "duel" ? [2, 5, -2, 8, -4] : [2, 5, 8];
    let bestAction: ResidualAction = 0;
    let bestCount = Number.POSITIVE_INFINITY;
    for (const action of explorationOrder) {
      const count = actionStats.get(action)?.count ?? 0;
      if (count < bestCount) {
        bestCount = count;
        bestAction = action;
      }
    }
    return bestAction;
  }
}

export function createResidualLearner(
  options: ResidualLearnerOptions = {},
): ResidualLearner {
  return new ResidualLearner(options);
}

export function serializeResidualLearner(
  learner: ResidualLearner,
): SerializedResidualLearner {
  return learner.toJSON();
}

export function deserializeResidualLearner(
  serialized: SerializedResidualLearner,
): ResidualLearner {
  const learner = createResidualLearner({
    warmupUpdates: serialized.warmupUpdates ?? DEFAULT_WARMUP_UPDATES,
    explorationRate: serialized.explorationRate ?? DEFAULT_EXPLORATION_RATE,
  });
  learner.load(serialized);
  return learner;
}

function hashFraction(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

export function letterGroupFor(letter: string): LetterGroup {
  const normalized = letter.toUpperCase();
  if (normalized === "S") return "s";
  if (["A", "E", "I", "O", "U"].includes(normalized)) return "vowel";
  if (normalized === "Q") return "q";
  if (["J", "X", "Z"].includes(normalized)) return "premium";
  if (["R", "T", "N", "L", "D", "H"].includes(normalized)) {
    return "common-consonant";
  }
  return "other";
}

export function rackBucketFor(rack: Map<string, number>, letter: string): RackBucket {
  const normalized = letter.toUpperCase();
  const size = [...rack.values()].reduce((sum, count) => sum + count, 0);
  const vowels = ["A", "E", "I", "O", "U"].reduce(
    (sum, vowel) => sum + (rack.get(vowel) ?? 0),
    0,
  );
  if (normalized === "U" && (rack.get("Q") ?? 0) > 0) return "q-needs-u";
  if (normalized === "S" && size >= 5) return "s-hungry";
  if (size >= 7) return "large-rack";
  if (size > 0 && vowels / size < 0.3) return "vowel-starved";
  if (size > 0 && vowels / size > 0.65) return "consonant-starved";
  return "balanced";
}

export function balanceBucketFor(balance: number): BalanceBucket {
  if (balance <= 12) return "broke";
  if (balance <= 35) return "thin";
  if (balance <= 90) return "healthy";
  return "rich";
}

export function opponentPressureBucketFor(expectedPrice: number): OpponentPressureBucket {
  if (expectedPrice <= 0) return "unknown";
  if (expectedPrice <= 4) return "low";
  if (expectedPrice <= 10) return "medium";
  return "high";
}

import { CONFIG } from "./config.js";
import { letterPriorForTile, tileGainForRackTile } from "./live_tables.js";

export type LivePhase =
  | typeof CONFIG.live.phaseNames.beginning
  | typeof CONFIG.live.phaseNames.middle
  | typeof CONFIG.live.phaseNames.end;

export interface PhaseBidContext {
  letter: string;
  myBalance: number;
  myRack: Map<string, number>;
  round: number;
  dictionary: readonly string[];
  useNoBidFloor?: boolean;
  auctionType?: "FirstPrice" | "Vickrey";
}

export interface PhaseBidExplanation {
  letter: string;
  phase: LivePhase;
  balance: number;
  rackSize: number;
  usualLetterValue: number;
  evDiff: number;
  rackFitValue: number;
  expectedBalance: number;
  balanceDelta: number;
  pressureMultiplier: number;
  baselineBid: number;
  value: number;
  cap: number;
  minBid: number;
  bidMultiplier: number;
  reserveBalance: number;
  maxBidBalanceFraction: number;
  bid: number;
  reason: string;
}

type PhaseConfig = (typeof CONFIG.live.phases)[LivePhase];

export function selectLivePhase(round: number): LivePhase {
  if (round <= CONFIG.live.phases.beginning.maxRound) {
    return CONFIG.live.phaseNames.beginning;
  }
  if (round <= CONFIG.live.phases.middle.maxRound) {
    return CONFIG.live.phaseNames.middle;
  }
  return CONFIG.live.phaseNames.end;
}

function phaseConfig(phase: LivePhase): PhaseConfig {
  return CONFIG.live.phases[phase];
}

function spendCap(balance: number, config: PhaseConfig): number {
  const reserveLimited = Math.max(CONFIG.count.none, balance - config.reserveBalance);
  const fractionLimited = Math.floor(balance * config.maxBidBalanceFraction);
  return Math.max(CONFIG.count.none, Math.min(balance, reserveLimited, fractionLimited));
}

function noBidFloorBid(ctx: PhaseBidContext, config: PhaseConfig): number {
  if (!ctx.useNoBidFloor) return CONFIG.bidding.noBidAmount;
  if (ctx.myBalance < config.minBid) return CONFIG.bidding.noBidAmount;
  if (CONFIG.bidding.noBidFloorExcludedLetters.includes(ctx.letter)) {
    return CONFIG.bidding.noBidAmount;
  }
  return Math.min(ctx.myBalance, config.minBid);
}

function rackSize(rack: Map<string, number>): number {
  return [...rack.values()].reduce(
    (total, count) => total + count,
    CONFIG.count.none,
  );
}

function tileFaceValue(letter: string): number {
  return CONFIG.bidding.letterValues[letter] ?? CONFIG.bidding.fallbackLetterValue;
}

function adjustedRackGain(ctx: PhaseBidContext): number {
  let gain = tileGainForRackTile(ctx.myRack, ctx.letter);
  const hasQ = (ctx.myRack.get("Q") ?? CONFIG.count.none) > CONFIG.count.none;
  const hasU = (ctx.myRack.get("U") ?? CONFIG.count.none) > CONFIG.count.none;

  if (ctx.letter === "Q" && !hasU) {
    return gain >= CONFIG.live.valuation.qWithoutUGainThreshold
      ? gain
      : CONFIG.live.noRackGain;
  }
  if (ctx.letter === "U" && hasQ) {
    gain += CONFIG.live.valuation.qUSynergyValue;
  }
  if (
    ctx.letter === "S" &&
    rackSize(ctx.myRack) >= CONFIG.live.valuation.sLongRackMinLength
  ) {
    gain *= CONFIG.live.valuation.sLongRackSynergyMultiplier;
  }
  return gain;
}

function shouldAvoidBareQ(ctx: PhaseBidContext): boolean {
  if (ctx.letter !== "Q") return false;
  const hasU = (ctx.myRack.get("U") ?? CONFIG.count.none) > CONFIG.count.none;
  if (hasU) return false;
  return tileGainForRackTile(ctx.myRack, ctx.letter) < CONFIG.live.valuation.qWithoutUGainThreshold;
}

function usualTileValue(letter: string): number {
  return (
    letterPriorForTile(letter) +
    tileFaceValue(letter) * CONFIG.live.valuation.faceValueWeight
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function expectedBalanceForRound(round: number): number {
  const config = CONFIG.live.bankrollPressure;
  const roundSpan = Math.max(
    CONFIG.count.increment,
    config.endRound - config.startRound,
  );
  const elapsedRounds = clamp(
    round - config.startRound,
    CONFIG.count.none,
    roundSpan,
  );
  const progress = elapsedRounds / roundSpan;
  return Math.round(
    config.startBalance +
      (config.endBalance - config.startBalance) * progress,
  );
}

function bankrollPressureMultiplier(
  balanceDelta: number,
  auctionType: PhaseBidContext["auctionType"],
): number {
  const config = CONFIG.live.bankrollPressure;
  if (auctionType !== "Vickrey") return config.neutralMultiplier;

  const normalizedDelta = clamp(
    balanceDelta / config.fullPressureBalanceDelta,
    -CONFIG.count.increment,
    CONFIG.count.increment,
  );
  if (normalizedDelta >= CONFIG.count.none) {
    return (
      config.neutralMultiplier +
      normalizedDelta * (config.maxMultiplier - config.neutralMultiplier)
    );
  }
  return (
    config.neutralMultiplier +
    normalizedDelta * (config.neutralMultiplier - config.minMultiplier)
  );
}

function vickreyBaselineBid(
  ctx: PhaseBidContext,
  cap: number,
  bareQAvoided: boolean,
  pressureMultiplier: number,
): number {
  if (ctx.auctionType !== "Vickrey") return CONFIG.bidding.noBidAmount;
  if (!ctx.useNoBidFloor) return CONFIG.bidding.noBidAmount;
  if (bareQAvoided) return CONFIG.bidding.noBidAmount;
  if (CONFIG.bidding.noBidFloorExcludedLetters.includes(ctx.letter)) {
    return CONFIG.bidding.noBidAmount;
  }
  if (cap <= CONFIG.bidding.noBidAmount) return CONFIG.bidding.noBidAmount;
  const pressuredBaseline = Math.max(
    CONFIG.count.increment,
    Math.round(CONFIG.live.valuation.vickreyBaselineBid * pressureMultiplier),
  );
  return Math.min(cap, pressuredBaseline);
}

export function decidePhaseBid(ctx: PhaseBidContext): number {
  return explainPhaseBid(ctx).bid;
}

export function explainPhaseBid(ctx: PhaseBidContext): PhaseBidExplanation {
  const phase = selectLivePhase(ctx.round);
  const config = phaseConfig(phase);
  const evDiff = tileGainForRackTile(ctx.myRack, ctx.letter);
  const rackFitValue = adjustedRackGain(ctx);
  const usualLetterValue = usualTileValue(ctx.letter);
  const expectedBalance = expectedBalanceForRound(ctx.round);
  const balanceDelta = ctx.myBalance - expectedBalance;
  const pressureMultiplier = bankrollPressureMultiplier(
    balanceDelta,
    ctx.auctionType,
  );
  let value =
    usualLetterValue * config.usualLetterWeight + rackFitValue * config.rackFitWeight;
  if (ctx.auctionType === "FirstPrice") {
    value *= CONFIG.live.valuation.firstPriceShade;
  }
  const cap = spendCap(ctx.myBalance, config);
  let bid: number = CONFIG.bidding.noBidAmount;
  let reason = "skip";
  const bareQAvoided = shouldAvoidBareQ(ctx);
  const baselineBid = vickreyBaselineBid(
    ctx,
    cap,
    bareQAvoided,
    pressureMultiplier,
  );

  if (bareQAvoided) {
    reason = "skip-bare-q";
  } else if (value <= CONFIG.bidding.noBidAmount) {
    bid = noBidFloorBid(ctx, config);
    reason =
      bid > CONFIG.bidding.noBidAmount ? "floor-no-value" : "skip-no-value";
  } else if (cap <= CONFIG.bidding.noBidAmount) {
    bid = noBidFloorBid(ctx, config);
    reason = bid > CONFIG.bidding.noBidAmount ? "floor-no-cap" : "skip-no-cap";
  } else {
    const rawBid = Math.round(
      value * config.bidMultiplier * pressureMultiplier,
    );
    if (rawBid <= CONFIG.bidding.noBidAmount) {
      bid = noBidFloorBid(ctx, config);
      reason = bid > CONFIG.bidding.noBidAmount ? "floor-rounded" : "skip-rounded";
    } else {
      bid = Math.min(cap, Math.max(config.minBid, rawBid));
      reason = "bid";
    }
  }
  if (baselineBid > bid) {
    bid = baselineBid;
    reason = "baseline-floor";
  }
  if (
    reason !== "skip-bare-q" &&
    ctx.auctionType === "Vickrey" &&
    evDiff > CONFIG.bidding.noBidAmount &&
    cap > CONFIG.bidding.noBidAmount
  ) {
    const evFloorBid = Math.min(cap, evDiff);
    if (evFloorBid > bid) {
      bid = evFloorBid;
      reason = "ev-floor";
    }
  }

  return {
    letter: ctx.letter,
    phase,
    balance: ctx.myBalance,
    rackSize: rackSize(ctx.myRack),
    usualLetterValue,
    evDiff,
    rackFitValue,
    expectedBalance,
    balanceDelta,
    pressureMultiplier,
    baselineBid,
    value,
    cap,
    minBid: config.minBid,
    bidMultiplier: config.bidMultiplier,
    reserveBalance: config.reserveBalance,
    maxBidBalanceFraction: config.maxBidBalanceFraction,
    bid,
    reason,
  };
}

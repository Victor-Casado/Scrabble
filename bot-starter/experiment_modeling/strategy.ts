import type { BidContext } from "../src/strategy.js";
import { explainPhaseBid } from "../src/phase_strategy.js";
import { predictOpponentBid } from "./bidPrediction.js";
import { computeDenialValue, rackCountsToArray, scoreLetterForRack } from "./letterValue.js";
import type { OpponentModel } from "./opponentModel.js";
import {
  denialMultiplierForPhase,
  maxSpendFractionForPhase,
  selectTournamentPhase,
  type TournamentPhase,
} from "./phase.js";
import {
  balanceBucketFor,
  opponentPressureBucketFor,
  rackBucketFor,
  type ResidualDecision,
  type ResidualLearner,
} from "./residualLearner.js";
import { logBid, logModel, logPhase, logPrediction } from "./telemetry.js";

export interface ModelingBidContext extends BidContext {
  playersRemaining: number;
  opponents: readonly OpponentModel[];
  telemetry?: boolean;
  learner?: ResidualLearner;
}

export interface ModelingBidExplanation {
  phase: TournamentPhase;
  selfValue: number;
  denialValue: number;
  phaseAdjustedDenialValue: number;
  expectedPrice: number;
  lisanBid: number;
  residual: number;
  learnerKey: string | null;
  cap: number;
  bid: number;
  decision: ResidualDecision | null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function reserveBalanceFor(ctx: ModelingBidContext, phase: TournamentPhase): number {
  if (phase === "duel") return ctx.myBalance <= 8 ? 0 : 2;
  if (phase === "exploit") return 5;
  return 10;
}

function expectedPriceFor(ctx: ModelingBidContext): number {
  let top = 0;
  for (const opponent of ctx.opponents) {
    const predicted = predictOpponentBid(opponent, ctx.letter);
    top = Math.max(top, predicted);
    if (ctx.telemetry) logPrediction(opponent.id, predicted);
  }
  return top;
}

function exploitAdjustment(
  ctx: ModelingBidContext,
  phase: TournamentPhase,
  rawBid: number,
  expectedPrice: number,
): number {
  if (phase === "learn") return Math.min(rawBid, Math.ceil(ctx.myBalance * 0.18));
  if (phase === "duel") return rawBid;

  const strongest = [...ctx.opponents].sort(
    (left, right) => right.averageBidEstimate - left.averageBidEstimate,
  )[0];
  if (!strongest) return rawBid;

  if (strongest.classification === "aggressive" && expectedPrice > rawBid) {
    return Math.floor(rawBid * 0.8);
  }
  if (strongest.classification === "frugal" && rawBid > expectedPrice) {
    return Math.max(rawBid, expectedPrice + 1);
  }
  if (strongest.classification === "hoarder") {
    return rawBid + 2;
  }
  return rawBid;
}

export function explainModelingBid(ctx: ModelingBidContext): ModelingBidExplanation {
  const phase = selectTournamentPhase(ctx.playersRemaining);
  const lisan = explainPhaseBid(ctx);
  const rackLetters = rackCountsToArray(ctx.myRack);
  const rackValue = scoreLetterForRack(rackLetters, ctx.letter);
  const selfValue = Math.max(lisan.bid, rackValue);
  const denialValue = computeDenialValue(ctx.letter, ctx.opponents);
  const phaseAdjustedDenialValue = denialValue * denialMultiplierForPhase(phase);
  const expectedPrice = expectedPriceFor(ctx);
  const decision =
    ctx.learner?.choose({
      phase,
      letter: ctx.letter,
      rackBucket: rackBucketFor(ctx.myRack, ctx.letter),
      balanceBucket: balanceBucketFor(ctx.myBalance),
      opponentPressureBucket: opponentPressureBucketFor(expectedPrice),
      auctionType: ctx.auctionType ?? "Vickrey",
    }) ?? null;
  const residual = decision?.residual ?? 0;
  let rawBid = lisan.bid + residual;
  if (residual === 0 && ctx.learner === undefined) {
    rawBid = Math.round(selfValue + phaseAdjustedDenialValue - expectedPrice);
    rawBid = exploitAdjustment(ctx, phase, rawBid, expectedPrice);
  }

  if (
    ctx.learner === undefined &&
    rawBid <= 1 &&
    selfValue + phaseAdjustedDenialValue < expectedPrice + 3
  ) {
    rawBid = 0;
  }

  const reserve = reserveBalanceFor(ctx, phase);
  const cap =
    ctx.learner === undefined
      ? Math.max(
          0,
          Math.min(
            ctx.myBalance - reserve,
            Math.floor(ctx.myBalance * maxSpendFractionForPhase(phase)),
          ),
        )
      : ctx.myBalance;
  const bid = clamp(rawBid, 0, cap);
  return {
    phase,
    selfValue,
    denialValue,
    phaseAdjustedDenialValue,
    expectedPrice,
    lisanBid: lisan.bid,
    residual,
    learnerKey: decision?.key ?? null,
    cap,
    bid,
    decision,
  };
}

export function decideBid(ctx: ModelingBidContext): number {
  if (ctx.telemetry) {
    const phase = selectTournamentPhase(ctx.playersRemaining);
    logPhase(phase);
    for (const opponent of ctx.opponents) logModel(opponent);
  }
  const explanation = explainModelingBid(ctx);
  if (ctx.telemetry) {
    logBid({
      self: explanation.selfValue,
      denial: Math.round(explanation.phaseAdjustedDenialValue),
      price: explanation.expectedPrice,
      final: explanation.bid,
      base: explanation.lisanBid,
      phase: explanation.phase,
    });
  }
  return explanation.bid;
}

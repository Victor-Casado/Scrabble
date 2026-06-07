import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG } from "./config.js";
import { explainPhaseBid, type PhaseBidContext } from "./phase_strategy.js";
import { scoreWord } from "./word_scoring.js";

interface ProfessorEntry {
  bid: number;
  live_bid: number;
  best_ev: number;
  live_ev: number;
  improvement: number;
  variance: number;
  visits: number;
}

type ProfessorTable = Record<string, ProfessorEntry>;

interface ProfessorGate {
  minImprovement: number;
  maxVariance: number;
  maxBidDelta: number;
}

export interface ProfessorBidContext extends PhaseBidContext {
  playerCount?: number;
}

export interface ProfessorBidExplanation {
  bid: number;
  baselineBid: number;
  key: string;
  table: "one-v-one" | "six";
  reason: string;
  entry?: ProfessorEntry;
}

function precomputedProfessorRoot(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    CONFIG.precompute.outputDirSegments[CONFIG.count.increment],
    CONFIG.professor.tableDirName,
  );
}

function readTable(fileName: string): ProfessorTable {
  const filePath = path.join(precomputedProfessorRoot(), fileName);
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as ProfessorTable;
}

const oneVOneTable = readTable(CONFIG.professor.oneVOneTableFile);
const sixTable = readTable(CONFIG.professor.sixTableFile);

function bucket(value: number, cuts: readonly number[]): number {
  for (
    let index = Number(CONFIG.count.none);
    index < cuts.length;
    index += CONFIG.count.increment
  ) {
    if (value <= cuts[index]) return index;
  }
  return cuts.length;
}

function rackSize(rack: Map<string, number>): number {
  return [...rack.values()].reduce(
    (total, count) => total + count,
    Number(CONFIG.count.none),
  );
}

function playable(word: string, rack: Map<string, number>): boolean {
  const needed = new Map<string, number>();
  for (const letter of word) {
    needed.set(letter, (needed.get(letter) ?? CONFIG.count.none) + CONFIG.count.increment);
  }
  for (const [letter, count] of needed) {
    if ((rack.get(letter) ?? CONFIG.count.none) < count) return false;
  }
  return true;
}

function bestPlayableReward(ctx: ProfessorBidContext): number {
  let best = Number(CONFIG.count.none);
  for (const word of ctx.dictionary) {
    const reward = scoreWord(word);
    if (reward < best) continue;
    if (playable(word, ctx.myRack)) best = reward;
  }
  return best;
}

function liveCommonKey(ctx: ProfessorBidContext): string {
  const size = rackSize(ctx.myRack);
  const vowels = "AEIOU"
    .split("")
    .reduce(
      (total, letter) => total + (ctx.myRack.get(letter) ?? CONFIG.count.none),
      Number(CONFIG.count.none),
    );
  const phase =
    ctx.round <= CONFIG.live.phases.beginning.maxRound
      ? "p0"
      : ctx.round <= CONFIG.live.phases.middle.maxRound
        ? "p1"
        : "p2";
  return [
    ctx.letter,
    phase,
    `rs${bucket(size, CONFIG.professor.liveCommonRackCuts)}`,
    `vw${bucket(vowels, CONFIG.professor.liveCommonVowelCuts)}`,
    `br${bucket(bestPlayableReward(ctx), CONFIG.professor.liveCommonBestRewardCuts)}`,
    `b${bucket(ctx.myBalance, CONFIG.professor.balanceCuts)}`,
  ].join("|");
}

function tableFor(ctx: ProfessorBidContext): {
  name: "one-v-one" | "six";
  table: ProfessorTable;
  gate: ProfessorGate;
} {
  if (
    (ctx.playerCount ?? CONFIG.professor.defaultPlayerCount) >=
    CONFIG.professor.multiplayerMinPlayers
  ) {
    return {
      name: "six",
      table: sixTable,
      gate: {
        minImprovement: CONFIG.professor.sixMinImprovement,
        maxVariance: CONFIG.professor.sixMaxVariance,
        maxBidDelta: CONFIG.professor.sixMaxBidDelta,
      },
    };
  }
  return {
    name: "one-v-one",
    table: oneVOneTable,
    gate: {
      minImprovement: CONFIG.professor.oneVOneMinImprovement,
      maxVariance: CONFIG.professor.oneVOneMaxVariance,
      maxBidDelta: CONFIG.professor.oneVOneMaxBidDelta,
    },
  };
}

function safeOverrideBid(
  baseline: number,
  entry: ProfessorEntry,
  balance: number,
  auctionsLeft: number | undefined,
  gate: ProfessorGate,
): number | null {
  if (entry.visits < CONFIG.professor.minVisits) return null;
  if (entry.improvement < gate.minImprovement) return null;
  if (entry.variance > gate.maxVariance) return null;

  const proposed = Math.max(CONFIG.count.none, Math.min(balance, Math.round(entry.bid)));
  const delta = Math.max(
    -gate.maxBidDelta,
    Math.min(gate.maxBidDelta, proposed - baseline),
  );
  const bid = Math.max(CONFIG.count.none, Math.min(balance, baseline + delta));

  if ((auctionsLeft ?? CONFIG.live.phases.end.maxRound) > CONFIG.scoring.fiveLetterMultiplier) {
    const cap =
      balance <=
      CONFIG.live.wordPolicy.emergencyBalance + CONFIG.live.valuation.vickreyBaselineBid
        ? Math.max(CONFIG.count.increment, Math.floor(balance * CONFIG.professor.lowBalanceFraction))
        : Math.max(
            baseline,
            Math.floor(balance * CONFIG.professor.maxOverrideBalanceFraction),
          );
    if (bid > cap) return null;
  }
  return bid;
}

export function explainProfessorBid(ctx: ProfessorBidContext): ProfessorBidExplanation {
  const baselineBid = explainPhaseBid(ctx).bid;
  const selected = tableFor(ctx);
  const key = liveCommonKey(ctx);
  const entry = selected.table[key];
  if (entry === undefined) {
    return {
      bid: baselineBid,
      baselineBid,
      key,
      table: selected.name,
      reason: "table-miss",
    };
  }

  const bid = safeOverrideBid(
    baselineBid,
    entry,
    ctx.myBalance,
    ctx.bagTotal,
    selected.gate,
  );
  if (bid === null) {
    return {
      bid: baselineBid,
      baselineBid,
      key,
      table: selected.name,
      reason: "override-rejected",
      entry,
    };
  }
  return {
    bid,
    baselineBid,
    key,
    table: selected.name,
    reason: "override",
    entry,
  };
}

export function decideProfessorBid(ctx: ProfessorBidContext): number {
  return explainProfessorBid(ctx).bid;
}

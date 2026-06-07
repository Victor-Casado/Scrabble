import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG } from "../src/config.js";
import { explainPhaseBid } from "../src/phase_strategy.js";
import { chooseWord } from "../src/strategy.js";
import { scoreWord } from "../src/word_scoring.js";
import { OpponentModelStore } from "./opponentModel.js";
import { createResidualLearner, type ResidualDecision, type ResidualLearner } from "./residualLearner.js";
import { explainModelingBid } from "./strategy.js";

type AuctionType = "Vickrey" | "FirstPrice";
type CandidateKind = "lisan" | "thinker";
type OpponentKind = "lisan" | "aggressive" | "frugal" | "saver";

interface PlayerState {
  id: string;
  kind: CandidateKind | OpponentKind;
  balance: number;
  score: number;
  rack: string[];
}

type Rng = () => number;

const bestWordCache = new Map<string, string | null>();

function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + CONFIG.neat.random.mulberryIncrement) | 0;
    let t = Math.imul(
      state ^ (state >>> CONFIG.neat.random.firstShift),
      CONFIG.neat.random.firstMultiplierBase | state,
    );
    t =
      (t +
        Math.imul(
          t ^ (t >>> CONFIG.neat.random.secondShift),
          CONFIG.neat.random.secondMultiplierBase | t,
        )) ^
      t;
    return ((t ^ (t >>> CONFIG.neat.random.finalShift)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: Rng): void {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rng() * (index + 1));
    [items[index], items[swap]] = [items[swap], items[index]];
  }
}

function generateBag(rng: Rng): string[] {
  const bag: string[] = [];
  for (const [letter, count] of Object.entries(CONFIG.neat.game.startingBag)) {
    for (let index = 0; index < count; index += 1) bag.push(letter);
  }
  shuffle(bag, rng);
  return bag;
}

function dictionaryPath(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    ...CONFIG.dictionary.wordlistPathSegments,
  );
}

function loadDictionary(maxWords: number): string[] {
  return fs
    .readFileSync(dictionaryPath(), "utf8")
    .split("\n")
    .map((line) => line.trim().toUpperCase())
    .filter((word) => word.length >= CONFIG.dictionary.minWordLength)
    .sort((left, right) => scoreWord(right) - scoreWord(left) || right.length - left.length)
    .slice(0, maxWords);
}

function rackMap(rack: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const letter of rack) counts.set(letter, (counts.get(letter) ?? 0) + 1);
  return counts;
}

function rackKey(rack: readonly string[]): string {
  return [...rack].sort().join("");
}

function removeWordFromRack(rack: string[], word: string): void {
  for (const letter of word) {
    const index = rack.indexOf(letter);
    if (index >= 0) rack.splice(index, 1);
  }
}

function playBestWord(player: PlayerState, dictionary: readonly string[]): string | null {
  const key = rackKey(player.rack);
  let word = bestWordCache.get(key);
  if (word === undefined) {
    word = chooseWord({ myRack: rackMap(player.rack), dictionary: [...dictionary] });
    bestWordCache.set(key, word);
  }
  if (!word) return null;
  removeWordFromRack(player.rack, word);
  const reward = scoreWord(word);
  player.score += reward;
  player.balance += reward;
  return word;
}

function dumpRack(player: PlayerState, dictionary: readonly string[]): void {
  while (playBestWord(player, dictionary) !== null) {
    // Dump all playable words at the final window.
  }
}

function maybeCashIn(player: PlayerState, dictionary: readonly string[]): string | null {
  if (player.balance > CONFIG.live.wordPolicy.emergencyBalance) return null;
  return playBestWord(player, dictionary);
}

function lisanBid(
  player: PlayerState,
  letter: string,
  round: number,
  bagTotal: number,
  dictionary: readonly string[],
  auctionType: AuctionType,
): number {
  return explainPhaseBid({
    letter,
    myBalance: player.balance,
    myRack: rackMap(player.rack),
    round,
    bagTotal,
    dictionary,
    useNoBidFloor: true,
    auctionType,
  }).bid;
}

function bidFor(
  player: PlayerState,
  letter: string,
  round: number,
  bagTotal: number,
  dictionary: readonly string[],
  auctionType: AuctionType,
  playersRemaining: number,
  models: OpponentModelStore,
  learner: ResidualLearner,
): { amount: number; decision: ResidualDecision | null } {
  const base = lisanBid(player, letter, round, bagTotal, dictionary, auctionType);
  if (player.kind === "thinker") {
    const explanation = explainModelingBid({
      letter,
      myBalance: player.balance,
      myRack: rackMap(player.rack),
      round,
      bagTotal,
      dictionary,
      useNoBidFloor: true,
      auctionType,
      playersRemaining,
      opponents: models.allExcept(player.id),
      learner,
    });
    return { amount: Math.min(player.balance, explanation.bid), decision: explanation.decision };
  }
  if (player.kind === "aggressive") {
    return { amount: Math.min(player.balance, Math.ceil(base * 1.25) + 1), decision: null };
  }
  if (player.kind === "frugal") {
    return { amount: Math.min(player.balance, Math.floor(base * 0.65)), decision: null };
  }
  if (player.kind === "saver") {
    return {
      amount: Math.min(player.balance, Math.floor(base * 0.85), Math.max(0, player.balance - 20)),
      decision: null,
    };
  }
  return { amount: Math.min(player.balance, base), decision: null };
}

function resolveAuction(
  bids: { id: string; amount: number; sequence: number }[],
  auctionType: AuctionType,
): { winner: string | null; paid: number } {
  const sorted = bids
    .filter((bid) => bid.amount > 0)
    .sort((left, right) => right.amount - left.amount || left.sequence - right.sequence);
  const top = sorted[0];
  if (!top) return { winner: null, paid: 0 };
  if (auctionType === "FirstPrice") return { winner: top.id, paid: top.amount };
  const second = sorted[1];
  return {
    winner: top.id,
    paid: second ? second.amount : Math.min(CONFIG.neat.game.auctionReserve, top.amount),
  };
}

function rosterFor(candidate: CandidateKind, players: number): PlayerState[] {
  const kinds: OpponentKind[] = ["lisan", "aggressive", "frugal", "saver", "lisan"];
  return [
    { id: "candidate", kind: candidate, balance: 100, score: 0, rack: [] },
    ...Array.from({ length: players - 1 }, (_, index) => ({
      id: `opp${index + 1}`,
      kind: kinds[index % kinds.length],
      balance: 100,
      score: 0,
      rack: [] as string[],
    })),
  ];
}

function runGame(
  candidate: CandidateKind,
  players: number,
  bag: string[],
  dictionary: readonly string[],
  learner: ResidualLearner,
  auctionType: AuctionType,
): { candidateScore: number; rank: number; nonZeroResiduals: number } {
  const roster = rosterFor(candidate, players);
  const models = new OpponentModelStore();
  let bagIndex = 0;
  for (const player of roster) {
    for (let index = 0; index < CONFIG.neat.game.startingRackSize; index += 1) {
      player.rack.push(bag[bagIndex++].toUpperCase());
    }
  }

  const decisions: ResidualDecision[] = [];
  let nonZeroResiduals = 0;
  let sequence = 0;
  let round = 0;
  while (bagIndex < bag.length) {
    round += 1;
    const letter = bag[bagIndex++].toUpperCase();
    const bagTotal = bag.length - bagIndex;
    const finalAuction = bagTotal === 0;
    if (finalAuction) for (const player of roster) dumpRack(player, dictionary);

    const bids = roster.map((player, offset) => {
      const bid = bidFor(
        player,
        letter,
        round,
        bagTotal,
        dictionary,
        auctionType,
        players,
        models,
        learner,
      );
      if (bid.decision) {
        decisions.push(bid.decision);
        if (bid.decision.residual !== 0) nonZeroResiduals += 1;
      }
      return {
        id: player.id,
        amount: bid.amount,
        sequence: sequence + ((round + offset) % roster.length),
      };
    });
    sequence += roster.length;
    const outcome = resolveAuction(bids, auctionType);
    models.observeAuction(
      roster.map((player) => player.id),
      outcome.winner,
      letter,
      outcome.paid,
    );
    if (outcome.winner) {
      const winner = roster.find((player) => player.id === outcome.winner);
      if (winner) {
        winner.balance -= outcome.paid;
        winner.rack.push(letter);
      }
    }
    if (!finalAuction) {
      for (const player of roster) {
        const word = maybeCashIn(player, dictionary);
        if (word) models.observeWord(player.id, word, scoreWord(word));
      }
    }
  }

  for (const player of roster) dumpRack(player, dictionary);
  const ranked = [...roster].sort((left, right) => right.score - left.score);
  const candidateState = roster[0];
  const rank = ranked.findIndex((player) => player.id === "candidate") + 1;
  const bestOpponent = ranked.find((player) => player.id !== "candidate");
  const scoreDelta = candidateState.score - (bestOpponent?.score ?? 0);
  const reward = (rank === 1 ? 0.5 : -0.5) + scoreDelta / 250;
  if (candidate === "thinker") learner.update(decisions, reward);
  return { candidateScore: candidateState.score, rank, nonZeroResiduals };
}

function parseArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function main(): void {
  const games = parseArg("--games", 8);
  const seed = parseArg("--seed", 20260607);
  const selectedPlayers = parseArg("--players", 0);
  const maxWords = parseArg("--max-words", 20000);
  const dictionary = loadDictionary(maxWords);
  const auctionType: AuctionType = process.argv.includes("--first-price")
    ? "FirstPrice"
    : "Vickrey";

  const playerCounts = selectedPlayers > 0 ? [selectedPlayers] : [2, 4, 6];
  for (const players of playerCounts) {
    const learner = createResidualLearner();
    let thinkerScore = 0;
    let lisanScore = 0;
    let thinkerRank = 0;
    let lisanRank = 0;
    let nonZeroResiduals = 0;
    for (let game = 1; game <= games; game += 1) {
      const bag = generateBag(seededRng(seed + players * 1000 + game));
      const lisan = runGame("lisan", players, [...bag], dictionary, createResidualLearner(), auctionType);
      const thinker = runGame("thinker", players, [...bag], dictionary, learner, auctionType);
      lisanScore += lisan.candidateScore;
      thinkerScore += thinker.candidateScore;
      lisanRank += lisan.rank;
      thinkerRank += thinker.rank;
      nonZeroResiduals += thinker.nonZeroResiduals;
    }
    console.log(
      [
        "arena",
        `players=${players}`,
        `games=${games}`,
        `thinkerAvgScore=${(thinkerScore / games).toFixed(1)}`,
        `lisanAvgScore=${(lisanScore / games).toFixed(1)}`,
        `thinkerAvgRank=${(thinkerRank / games).toFixed(2)}`,
        `lisanAvgRank=${(lisanRank / games).toFixed(2)}`,
        `nonZeroResiduals=${nonZeroResiduals}`,
      ].join(" "),
    );
  }
}

main();

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
type PlayerId = "lisan" | "the-thinker";

interface PlayerState {
  id: PlayerId;
  balance: number;
  score: number;
  rack: string[];
}

interface SeriesResult {
  games: number;
  thinkerWins: number;
  lisanWins: number;
  ties: number;
  thinkerTotalScore: number;
  lisanTotalScore: number;
}

interface Rng {
  (): number;
}

const PLAYER_IDS: PlayerId[] = ["lisan", "the-thinker"];
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

function loadDictionary(): string[] {
  return fs
    .readFileSync(dictionaryPath(), "utf8")
    .split("\n")
    .map((line) => line.trim().toUpperCase())
    .filter((word) => word.length >= CONFIG.dictionary.minWordLength)
    .sort((left, right) => scoreWord(right) - scoreWord(left) || right.length - left.length);
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
    // Keep dumping playable words.
  }
}

function maybeCashIn(player: PlayerState, dictionary: readonly string[]): string | null {
  if (player.balance > CONFIG.live.wordPolicy.emergencyBalance) return null;
  const beforeScore = player.score;
  const word = playBestWord(player, dictionary);
  if (!word) return null;
  const reward = player.score - beforeScore;
  return reward >= CONFIG.live.wordPolicy.emergencyMinScore ? word : null;
}

function resolveAuction(
  bids: { id: PlayerId; amount: number; sequence: number }[],
  auctionType: AuctionType,
): { winner: PlayerId | null; paid: number; topBid: number } {
  const sorted = bids
    .filter((bid) => bid.amount > 0)
    .sort((left, right) => right.amount - left.amount || left.sequence - right.sequence);
  const top = sorted[0];
  if (!top) return { winner: null, paid: 0, topBid: 0 };
  if (auctionType === "FirstPrice") {
    return { winner: top.id, paid: top.amount, topBid: top.amount };
  }
  const second = sorted[1];
  return {
    winner: top.id,
    paid: second ? second.amount : Math.min(CONFIG.neat.game.auctionReserve, top.amount),
    topBid: top.amount,
  };
}

function decideLisanBid(
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

function runGame(
  gameNumber: number,
  bag: string[],
  dictionary: readonly string[],
  models: OpponentModelStore,
  learner: ResidualLearner,
  auctionType: AuctionType,
): { thinkerScore: number; lisanScore: number; winner: PlayerId | "tie" } {
  const players = new Map<PlayerId, PlayerState>(
    PLAYER_IDS.map((id) => [
      id,
      {
        id,
        balance: CONFIG.neat.game.startingBalance,
        score: 0,
        rack: [],
      },
    ]),
  );

  let bagIndex = 0;
  for (const id of PLAYER_IDS) {
    const player = players.get(id);
    if (!player) throw new Error(`missing player ${id}`);
    for (let index = 0; index < CONFIG.neat.game.startingRackSize; index += 1) {
      player.rack.push(bag[bagIndex].toUpperCase());
      bagIndex += 1;
    }
  }

  let sequence = 0;
  let round = 0;
  const decisions: ResidualDecision[] = [];
  let nonZeroResiduals = 0;
  while (bagIndex < bag.length) {
    round += 1;
    const letter = bag[bagIndex].toUpperCase();
    bagIndex += 1;
    const bagTotal = bag.length - bagIndex;
    const isFinalAuction = bagTotal === 0;

    if (isFinalAuction) {
      for (const player of players.values()) dumpRack(player, dictionary);
    }

    const lisan = players.get("lisan");
    const thinker = players.get("the-thinker");
    if (!lisan || !thinker) throw new Error("missing player state");

    const lisanBid = Math.min(
      lisan.balance,
      decideLisanBid(lisan, letter, round, bagTotal, dictionary, auctionType),
    );
    const thinkerExplanation = explainModelingBid({
      letter,
      myBalance: thinker.balance,
      myRack: rackMap(thinker.rack),
      round,
      bagTotal,
      dictionary,
      useNoBidFloor: true,
      auctionType,
      playersRemaining: 2,
      opponents: [models.get("lisan")],
      learner,
      telemetry: false,
    });
    const thinkerBid = Math.min(thinker.balance, thinkerExplanation.bid);
    if (thinkerExplanation.decision !== null) {
      decisions.push(thinkerExplanation.decision);
      if (thinkerExplanation.decision.residual !== 0) nonZeroResiduals += 1;
    }

    const thinkerFirst = round % 2 === 0;
    const bids = thinkerFirst
      ? [
          { id: "the-thinker" as PlayerId, amount: thinkerBid, sequence: sequence++ },
          { id: "lisan" as PlayerId, amount: lisanBid, sequence: sequence++ },
        ]
      : [
          { id: "lisan" as PlayerId, amount: lisanBid, sequence: sequence++ },
          { id: "the-thinker" as PlayerId, amount: thinkerBid, sequence: sequence++ },
        ];
    const outcome = resolveAuction(bids, auctionType);
    models.observeAuction(["lisan"], outcome.winner === "lisan" ? "lisan" : null, letter, outcome.paid);

    if (outcome.winner !== null) {
      const winner = players.get(outcome.winner);
      if (!winner) throw new Error(`missing winner ${outcome.winner}`);
      winner.balance -= outcome.paid;
      winner.rack.push(letter);
    }

    if (!isFinalAuction) {
      for (const player of players.values()) {
        const word = maybeCashIn(player, dictionary);
        if (word && player.id === "lisan") {
          models.observeWord("lisan", word, scoreWord(word));
        }
      }
    }
  }

  for (const player of players.values()) dumpRack(player, dictionary);

  const thinker = players.get("the-thinker");
  const lisan = players.get("lisan");
  if (!thinker || !lisan) throw new Error("missing final player state");
  const winner =
    thinker.score > lisan.score
      ? "the-thinker"
      : lisan.score > thinker.score
        ? "lisan"
        : "tie";
  const scoreDelta = thinker.score - lisan.score;
  const reward =
    (scoreDelta > 0 ? 0.5 : scoreDelta < 0 ? -0.5 : 0) + scoreDelta / 200;
  learner.update(decisions, reward);
  console.log(
    [
      `game=${gameNumber}`,
      `winner=${winner}`,
      `thinkerScore=${thinker.score}`,
      `lisanScore=${lisan.score}`,
      `thinkerBalance=${thinker.balance}`,
      `lisanBalance=${lisan.balance}`,
      `lisanModel=${models.get("lisan").classification}`,
      `lisanAvgBid=${models.get("lisan").averageBidEstimate.toFixed(2)}`,
      `lisanAuctions=${models.get("lisan").auctionsSeen}`,
      `learnerDecisions=${decisions.length}`,
      `nonZeroResiduals=${nonZeroResiduals}`,
    ].join(" "),
  );
  return { thinkerScore: thinker.score, lisanScore: lisan.score, winner };
}

function parseArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function main(): void {
  const games = parseArg("--games", 20);
  const seed = parseArg("--seed", 20260607);
  const auctionType = (process.argv.includes("--first-price")
    ? "FirstPrice"
    : "Vickrey") satisfies AuctionType;
  const dictionary = loadDictionary();
  const models = new OpponentModelStore();
  const learner = createResidualLearner();
  const result: SeriesResult = {
    games,
    thinkerWins: 0,
    lisanWins: 0,
    ties: 0,
    thinkerTotalScore: 0,
    lisanTotalScore: 0,
  };

  for (let game = 1; game <= games; game += 1) {
    const rng = seededRng(seed + game);
    const gameResult = runGame(
      game,
      generateBag(rng),
      dictionary,
      models,
      learner,
      auctionType,
    );
    result.thinkerTotalScore += gameResult.thinkerScore;
    result.lisanTotalScore += gameResult.lisanScore;
    if (gameResult.winner === "the-thinker") result.thinkerWins += 1;
    else if (gameResult.winner === "lisan") result.lisanWins += 1;
    else result.ties += 1;
  }

  const lisanModel = models.get("lisan");
  console.log(
    [
      "summary",
      `games=${result.games}`,
      `thinkerWins=${result.thinkerWins}`,
      `lisanWins=${result.lisanWins}`,
      `ties=${result.ties}`,
      `thinkerAvgScore=${(result.thinkerTotalScore / result.games).toFixed(1)}`,
      `lisanAvgScore=${(result.lisanTotalScore / result.games).toFixed(1)}`,
      `learnedClassification=${lisanModel.classification}`,
      `learnedAvgBid=${lisanModel.averageBidEstimate.toFixed(2)}`,
      `observedAuctions=${lisanModel.auctionsSeen}`,
    ].join(" "),
  );
}

main();

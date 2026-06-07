import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import { CONFIG } from "./config.js";
import {
  chooseWord as chooseRepoWord,
  decideBid as decideRepoBid,
} from "./strategy.js";
import {
  serializePrecomputedRack,
  type PrecomputedWord,
} from "./precompute_tables.js";

export type AuctionType = "Vickrey" | "FirstPrice";
export type Rng = () => number;

export interface Bid {
  playerId: number;
  amount: number;
  sequence: number;
}

export interface AuctionOutcome {
  winnerId: number | null;
  topBid: number;
  paid: number;
}

export interface SimPlayerState {
  id: number;
  balance: number;
  score: number;
  rack: string[];
}

export interface TunableConfig {
  bidMultiplier: number;
  firstPriceShade: number;
  maxBidBalanceFraction: number;
  reserveBalance: number;
  cashInMinScore: number;
  finalDump: boolean;
  minBid: number;
  endgameMultiplier: number;
  finalAuctionMultiplier: number;
  qPenalty: number;
  synergyMultiplier: number;
}

export interface ConfigPlayer {
  kind: "config";
  name?: string;
  config: TunableConfig;
}

export interface LivePlayer {
  kind: "live";
  name: string;
}

export type SimPlayer = ConfigPlayer | LivePlayer;

export interface SimulationInput {
  bag: string[];
  players: SimPlayer[];
  auctionType: AuctionType;
  rng?: Rng;
}

export interface SimulationResult {
  players: SimPlayerState[];
  ourScore: number;
  ourRank: number;
  finalAuctionWinnerId: number | null;
  finalAuctionLetter: string | null;
}

interface WordEntry {
  word: string;
  score: number;
}

interface EvaluationOptions {
  auctionType: AuctionType;
  playerCount: number;
  opponentProfile: string;
}

interface EvaluationJob {
  id: string;
  config: TunableConfig;
  bags: string[][];
  options: EvaluationOptions;
  opponentPool: SimPlayer[];
}

interface EvaluationResult {
  id: string;
  config: TunableConfig;
  avgScore: number;
  avgRank: number;
  winRate: number;
  fitness: number;
}

export interface CliOptions {
  mode: string;
  matches: number;
  generations: number;
  population: number;
  workers: number;
  seed: number;
  outFile: string;
  generationDir: string;
  playerCount: number;
  auctionType: string;
  opponentProfile: string;
  compareA?: string;
  compareB?: string;
}

type Logger = (line: string) => void;
type CompactPrecomputedWord = [string, number];

const wordCache = new Map<string, WordEntry | null>();
let wordEntries: WordEntry[] | null = null;
let dictionaryWords: string[] | null = null;
const precomputedBestWordBySize = new Map<number, Record<string, PrecomputedWord> | null>();

export function createSeededRng(seed: number): Rng {
  let state = seed >>> CONFIG.count.none;
  return () => {
    state = (state + CONFIG.neat.random.mulberryIncrement) | CONFIG.count.none;
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
    return (
      ((t ^ (t >>> CONFIG.neat.random.finalShift)) >>> CONFIG.count.none) /
      CONFIG.neat.random.uint32Divisor
    );
  };
}

export function auctionableTileCount(playerCount: number): number {
  return Math.max(
    CONFIG.count.none,
    CONFIG.neat.game.totalTiles - playerCount * CONFIG.neat.game.startingRackSize,
  );
}

export function scoreWordForTest(word: string): number {
  return scoreWord(word);
}

export function playWordForTest(player: SimPlayerState, word: string): number {
  return playWord(player, word);
}

export function resolveAuctionForTest(
  bids: Bid[],
  auctionType: AuctionType,
): AuctionOutcome {
  return resolveAuction(bids, auctionType);
}

export function runSimulationMatch({
  bag,
  players,
  auctionType,
}: SimulationInput): SimulationResult {
  const states = players.map((_player, index) => ({
    id: index,
    balance: CONFIG.neat.game.startingBalance,
    score: CONFIG.count.none,
    rack: [] as string[],
  }));

  let bagIndex = CONFIG.count.none;
  for (const state of states) {
    for (let i = CONFIG.count.none; i < CONFIG.neat.game.startingRackSize; i += CONFIG.count.increment) {
      state.rack.push(bag[bagIndex].toUpperCase());
      bagIndex += CONFIG.count.increment;
    }
  }

  let bidSequence = CONFIG.count.none;
  let round = CONFIG.count.none;
  let finalAuctionWinnerId: number | null = null;
  let finalAuctionLetter: string | null = null;

  while (bagIndex < bag.length) {
    round += CONFIG.count.increment;
    const letter = bag[bagIndex].toUpperCase();
    bagIndex += CONFIG.count.increment;
    const tilesLeftAfterOpen = bag.length - bagIndex;
    const isFinalAuction = tilesLeftAfterOpen <= CONFIG.count.none;

    if (isFinalAuction) {
      for (const [index, player] of players.entries()) {
        dumpRackForPlayer(states[index], player);
      }
    }

    const bids: Bid[] = [];
    for (const [index, player] of players.entries()) {
      const amount = decidePlayerBid(states[index], player, letter, {
        auctionType,
        tilesLeftAfterOpen,
        auctionableTiles: auctionableTileCount(states.length),
        isFinalAuction,
        round,
      });
      if (amount > CONFIG.bidding.noBidAmount) {
        bids.push({
          playerId: index,
          amount: Math.min(amount, states[index].balance),
          sequence: bidSequence,
        });
        bidSequence += CONFIG.count.increment;
      }
    }

    const outcome = resolveAuction(bids, auctionType);
    if (isFinalAuction) {
      finalAuctionWinnerId = outcome.winnerId;
      finalAuctionLetter = letter;
    }
    if (outcome.winnerId !== null) {
      const winner = states[outcome.winnerId];
      if (winner.balance >= outcome.paid) {
        winner.balance -= outcome.paid;
        winner.rack.push(letter);
      }
    }

    if (!isFinalAuction) {
      for (const [index, player] of players.entries()) {
        maybeCashInForPlayer(states[index], player);
      }
    }
  }

  const ranked = [...states].sort((a, b) => b.score - a.score || a.id - b.id);
  const ourRank =
    ranked.findIndex((state) => state.id === CONFIG.count.none) + CONFIG.count.increment;

  return {
    players: states,
    ourScore: states[CONFIG.count.none].score,
    ourRank,
    finalAuctionWinnerId,
    finalAuctionLetter,
  };
}

function dictionaryPath(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    ...CONFIG.dictionary.wordlistPathSegments,
  );
}

function precomputedPath(...segments: string[]): string {
  return path.join(process.cwd(), ...CONFIG.precompute.outputDirSegments, ...segments);
}

function precomputedSizeFileName(size: number): string {
  return `${CONFIG.precompute.sizeFilePrefix}${size}${CONFIG.precompute.jsonFileExtension}`;
}

function decodePrecomputedWord(value: PrecomputedWord | CompactPrecomputedWord): PrecomputedWord {
  if (!Array.isArray(value)) return value;
  return {
    word: value[CONFIG.count.none],
    score: value[CONFIG.count.increment],
  };
}

function loadPrecomputedBestWord(size: number): Record<string, PrecomputedWord> | null {
  if (size > CONFIG.precompute.maxRackLetters) return null;
  if (precomputedBestWordBySize.has(size)) {
    return precomputedBestWordBySize.get(size) ?? null;
  }
  const file = precomputedPath(
    CONFIG.precompute.bestWordDirName,
    precomputedSizeFileName(size),
  );
  const table = fs.existsSync(file) &&
    fs.statSync(file).size <= CONFIG.precompute.maxBestWordTableBytes
    ? Object.fromEntries(
        Object.entries(
          JSON.parse(fs.readFileSync(file, "utf8")) as Record<
            string,
            PrecomputedWord | CompactPrecomputedWord
          >,
        ).map(([key, value]) => [key, decodePrecomputedWord(value)]),
      )
    : null;
  precomputedBestWordBySize.set(size, table);
  return table;
}

function loadWordEntries(): WordEntry[] {
  if (wordEntries) return wordEntries;
  const file = dictionaryPath();
  if (!fs.existsSync(file)) {
    throw new Error(`Dictionary not found at ${file}`);
  }
  wordEntries = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((word) => word.trim().toUpperCase())
    .filter((word) => word.length >= CONFIG.dictionary.minWordLength)
    .map((word) => ({ word, score: scoreWord(word) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.word.length - a.word.length ||
        a.word.localeCompare(b.word),
    );
  return wordEntries;
}

function loadDictionaryWords(): string[] {
  if (dictionaryWords) return dictionaryWords;
  dictionaryWords = loadWordEntries()
    .map((entry) => entry.word)
    .sort(
      (a, b) =>
        b.length - a.length ||
        a.localeCompare(b),
    );
  return dictionaryWords;
}

function scoreWord(word: string): number {
  const base = [...word.toUpperCase()].reduce<number>(
    (sum, letter) => sum + (CONFIG.bidding.letterValues[letter] ?? CONFIG.bidding.fallbackLetterValue),
    CONFIG.count.none,
  );
  const len = word.length;
  if (len <= CONFIG.neat.scoring.threeLetterMaxLength) return base;
  if (len === CONFIG.neat.scoring.fourLetterLength) {
    return Math.floor(
      (base * CONFIG.neat.scoring.fourLetterNumerator) /
        CONFIG.neat.scoring.fourLetterDenominator,
    );
  }
  if (len === CONFIG.neat.scoring.fiveLetterLength) {
    return base * CONFIG.neat.scoring.fiveLetterMultiplier;
  }
  if (len === CONFIG.neat.scoring.sixLetterLength) {
    return Math.floor(
      (base * CONFIG.neat.scoring.sixLetterNumerator) /
        CONFIG.neat.scoring.sixLetterDenominator,
    );
  }
  return base * CONFIG.neat.scoring.sevenPlusMultiplier;
}

function rackKey(rack: string[]): string {
  return [...rack].sort().join("");
}

function countsFor(letters: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const letter of letters) {
    counts.set(letter, (counts.get(letter) ?? CONFIG.count.none) + CONFIG.count.increment);
  }
  return counts;
}

function rackMap(rack: string[]): Map<string, number> {
  return countsFor(rack);
}

function canForm(word: string, rackCounts: Map<string, number>): boolean {
  const used = new Map<string, number>();
  for (const letter of word) {
    const next = (used.get(letter) ?? CONFIG.count.none) + CONFIG.count.increment;
    if (next > (rackCounts.get(letter) ?? CONFIG.count.none)) return false;
    used.set(letter, next);
  }
  return true;
}

function bestSingleWord(rack: string[]): WordEntry | null {
  if (rack.length <= CONFIG.collection.emptyLength) return null;
  const key = rackKey(rack);
  if (wordCache.has(key)) return wordCache.get(key) ?? null;
  const precomputed = loadPrecomputedBestWord(rack.length);
  if (precomputed) {
    const entry = precomputed[serializePrecomputedRack(countsFor(rack))];
    if (entry) {
      wordCache.set(key, entry);
      return entry;
    }
  }
  const counts = countsFor(rack);
  const best = loadWordEntries().find((entry) => canForm(entry.word, counts)) ?? null;
  wordCache.set(key, best);
  return best;
}

function bestSingleScore(rack: string[]): number {
  return bestSingleWord(rack)?.score ?? CONFIG.count.none;
}

function removeWordFromRack(rack: string[], word: string): void {
  for (const letter of word) {
    const index = rack.indexOf(letter);
    if (index < CONFIG.count.none) {
      throw new Error(`Cannot remove ${word}; missing ${letter}`);
    }
    rack.splice(index, CONFIG.count.increment);
  }
}

function playWord(player: SimPlayerState, word: string): number {
  removeWordFromRack(player.rack, word);
  const reward = scoreWord(word);
  player.score += reward;
  player.balance += reward;
  return reward;
}

function dumpRack(player: SimPlayerState): void {
  while (player.rack.length > CONFIG.collection.emptyLength) {
    const word = bestSingleWord(player.rack);
    if (!word) return;
    playWord(player, word.word);
  }
}

function dumpRackWithRepoStrategy(player: SimPlayerState): void {
  while (player.rack.length > CONFIG.collection.emptyLength) {
    const word = chooseRepoWord({
      myRack: rackMap(player.rack),
      dictionary: loadDictionaryWords(),
    });
    if (!word) return;
    playWord(player, word);
  }
}

function dumpRackForPlayer(state: SimPlayerState, player: SimPlayer): void {
  if (player.kind === "live") {
    dumpRackWithRepoStrategy(state);
    return;
  }
  if (player.config.finalDump) dumpRack(state);
}

function maybeCashIn(player: SimPlayerState, config: TunableConfig): void {
  if (player.balance >= config.reserveBalance + config.minBid) return;
  const word = bestSingleWord(player.rack);
  if (!word || word.score < config.cashInMinScore) return;
  playWord(player, word.word);
}

function maybeCashInForPlayer(state: SimPlayerState, player: SimPlayer): void {
  if (player.kind !== "config") return;
  maybeCashIn(state, player.config);
}

function resolveAuction(bids: Bid[], auctionType: AuctionType): AuctionOutcome {
  const sorted = bids
    .filter((bid) => bid.amount > CONFIG.bidding.noBidAmount)
    .sort((a, b) => b.amount - a.amount || a.sequence - b.sequence);
  const first = sorted[CONFIG.count.none];
  if (!first) {
    return {
      winnerId: null,
      topBid: CONFIG.count.none,
      paid: CONFIG.count.none,
    };
  }
  if (auctionType === "FirstPrice") {
    return {
      winnerId: first.playerId,
      topBid: first.amount,
      paid: first.amount,
    };
  }
  const second = sorted[CONFIG.count.increment];
  return {
    winnerId: first.playerId,
    topBid: first.amount,
    paid: second
      ? second.amount
      : Math.min(CONFIG.neat.game.auctionReserve, first.amount),
  };
}

function decideBid(
  player: SimPlayerState,
  config: TunableConfig,
  letter: string,
  context: {
    auctionType: AuctionType;
    tilesLeftAfterOpen: number;
    auctionableTiles: number;
    isFinalAuction: boolean;
  },
): number {
  const currentBest = bestSingleScore(player.rack);
  const withTileBest = bestSingleScore([...player.rack, letter]);
  let gain = Math.max(CONFIG.count.none, withTileBest - currentBest);
  if (letter === "Q" && !player.rack.includes("U")) gain *= config.qPenalty;
  if (player.rack.includes("Q") && letter === "U") gain *= config.synergyMultiplier;
  if (letter === "S" && player.rack.length >= CONFIG.neat.scoring.fiveLetterLength) {
    gain *= config.synergyMultiplier;
  }
  const progress =
    context.auctionableTiles <= CONFIG.count.none
      ? CONFIG.count.increment
      : CONFIG.count.increment - context.tilesLeftAfterOpen / context.auctionableTiles;
  const endgameBoost =
    CONFIG.count.increment +
    Math.max(CONFIG.count.none, progress) *
      Math.max(CONFIG.count.none, config.endgameMultiplier - CONFIG.count.increment);
  const finalScale = context.isFinalAuction
    ? config.finalAuctionMultiplier
    : CONFIG.count.increment;
  let rawBid = gain * config.bidMultiplier * endgameBoost * finalScale;
  if (context.auctionType === "FirstPrice") rawBid *= config.firstPriceShade;
  if (rawBid <= CONFIG.bidding.noBidAmount) return CONFIG.bidding.noBidAmount;
  const reserveLimited = Math.max(CONFIG.count.none, player.balance - config.reserveBalance);
  const fractionLimited = Math.floor(player.balance * config.maxBidBalanceFraction);
  const maxAffordable = Math.min(player.balance, reserveLimited, fractionLimited);
  if (maxAffordable <= CONFIG.count.none) return CONFIG.bidding.noBidAmount;
  return Math.min(maxAffordable, Math.max(config.minBid, Math.floor(rawBid)));
}

function decidePlayerBid(
  state: SimPlayerState,
  player: SimPlayer,
  letter: string,
  context: {
    auctionType: AuctionType;
    tilesLeftAfterOpen: number;
    auctionableTiles: number;
    isFinalAuction: boolean;
    round: number;
  },
): number {
  if (player.kind === "config") {
    return decideBid(state, player.config, letter, context);
  }
  return decideRepoBid({
    letter,
    myBalance: state.balance,
    myRack: rackMap(state.rack),
    round: context.round,
    dictionary: loadDictionaryWords(),
  });
}

function generateBag(rng: Rng): string[] {
  const bag: string[] = [];
  for (const [letter, count] of Object.entries(CONFIG.neat.game.startingBag)) {
    for (let i = CONFIG.count.none; i < count; i += CONFIG.count.increment) {
      bag.push(letter);
    }
  }
  shuffle(bag, rng);
  return bag;
}

function shuffle<T>(items: T[], rng: Rng): void {
  for (let i = items.length - CONFIG.count.increment; i > CONFIG.count.none; i -= CONFIG.count.increment) {
    const j = Math.floor(rng() * (i + CONFIG.count.increment));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

function createPlayer(config: TunableConfig, name?: string): ConfigPlayer {
  return { kind: "config", name, config };
}

function createLivePlayer(): LivePlayer {
  return {
    kind: "live",
    name: CONFIG.neat.profiles.liveStrategyName,
  };
}

function generatedProfilePlayers(): ConfigPlayer[] {
  return CONFIG.neat.profiles.generated.map((profile) =>
    createPlayer({ ...profile.config }, profile.name),
  );
}

function opponentPlayers(
  playerCount: number,
  profile: string,
): ConfigPlayer[] {
  const soft = [
    createPlayer({ ...CONFIG.neat.tunable, bidMultiplier: CONFIG.neat.grid.bidMultipliers[CONFIG.count.none] }),
    createPlayer({ ...CONFIG.neat.tunable, maxBidBalanceFraction: CONFIG.neat.grid.maxBidBalanceFractions[CONFIG.count.none] }),
  ];
  const hard = [
    createPlayer({ ...CONFIG.neat.tunable, bidMultiplier: CONFIG.neat.grid.bidMultipliers[CONFIG.neat.grid.bidMultipliers.length - CONFIG.count.increment] }),
    createPlayer({ ...CONFIG.neat.tunable, maxBidBalanceFraction: CONFIG.neat.grid.maxBidBalanceFractions[CONFIG.neat.grid.maxBidBalanceFractions.length - CONFIG.count.increment] }),
  ];
  const mixed = [...soft, ...hard];
  const pool = profile === "soft" ? soft : profile === "hard" ? hard : mixed;
  const opponents: ConfigPlayer[] = [];
  for (let i = CONFIG.count.increment; i < playerCount; i += CONFIG.count.increment) {
    opponents.push(pool[(i - CONFIG.count.increment) % pool.length]);
  }
  return opponents;
}

function fixedOpponentPool(profile: string): SimPlayer[] {
  if (profile === "soft" || profile === "hard") {
    return [
      createLivePlayer(),
      ...opponentPlayers(CONFIG.neat.game.defaultPlayerCount, profile),
    ];
  }
  return [
    createLivePlayer(),
    createPlayer({ ...CONFIG.neat.tunable }, CONFIG.neat.profiles.defaultStrategyName),
    ...generatedProfilePlayers(),
    ...opponentPlayers(CONFIG.neat.game.defaultPlayerCount, "mixed"),
  ];
}

function peerOpponentRoster(
  candidateIndex: number,
  population: TunableConfig[],
  sampleSize: number,
  rng: Rng,
): ConfigPlayer[] {
  const peers = population
    .map((config, index) => ({ config, index }))
    .filter((peer) => peer.index !== candidateIndex);
  shuffle(peers, rng);
  return peers
    .slice(CONFIG.count.none, sampleSize)
    .map((peer) => createPlayer(peer.config, `peer-${peer.index}`));
}

export function fixedOpponentRosterForTest(profile: string): SimPlayer[] {
  return fixedOpponentPool(profile);
}

export function peerOpponentRosterForTest(
  candidateIndex: number,
  population: TunableConfig[],
  sampleSize: number,
  rng: Rng,
): ConfigPlayer[] {
  return peerOpponentRoster(candidateIndex, population, sampleSize, rng);
}

function selectOpponentRoster(
  opponentPool: SimPlayer[],
  playerCount: number,
  matchIndex: number,
): SimPlayer[] {
  const needed = Math.max(CONFIG.count.none, playerCount - CONFIG.count.increment);
  const selected: SimPlayer[] = [];
  if (opponentPool.length <= CONFIG.collection.emptyLength) return selected;
  for (let i = CONFIG.count.none; i < needed; i += CONFIG.count.increment) {
    selected.push(opponentPool[(matchIndex + i) % opponentPool.length]);
  }
  return selected;
}

function evaluateConfig(
  id: string,
  config: TunableConfig,
  bags: string[][],
  options: EvaluationOptions,
  opponentPool: SimPlayer[],
): EvaluationResult {
  let totalScore = CONFIG.count.none;
  let totalRank = CONFIG.count.none;
  let wins = CONFIG.count.none;
  for (const [matchIndex, bag] of bags.entries()) {
    const opponents = selectOpponentRoster(
      opponentPool,
      options.playerCount,
      matchIndex,
    );
    const result = runSimulationMatch({
      bag,
      auctionType: options.auctionType,
      players: [
        createPlayer(config, CONFIG.neat.profiles.candidateStrategyName),
        ...opponents,
      ],
    });
    totalScore += result.ourScore;
    totalRank += result.ourRank;
    if (result.ourRank === CONFIG.count.increment) wins += CONFIG.count.increment;
  }
  const avgScore = totalScore / bags.length;
  const avgRank = totalRank / bags.length;
  const winRate = wins / bags.length;
  const fitness =
    avgScore * CONFIG.neat.evolution.fitnessScoreWeight +
    winRate * CONFIG.neat.evolution.fitnessWinRateWeight -
    (avgRank - CONFIG.count.increment) * CONFIG.neat.evolution.fitnessRankPenalty;
  return { id, config, avgScore, avgRank, winRate, fitness };
}

async function evaluateParallel(
  jobs: EvaluationJob[],
  workers: number,
): Promise<EvaluationResult[]> {
  const workerCount = Math.max(
    CONFIG.neat.machine.minimumWorkers,
    Math.min(workers, jobs.length),
  );
  if (workerCount <= CONFIG.count.increment) {
    return jobs.map((job) =>
      evaluateConfig(job.id, job.config, job.bags, job.options, job.opponentPool),
    );
  }
  const chunks = Array.from({ length: workerCount }, () => [] as EvaluationJob[]);
  for (const [index, job] of jobs.entries()) {
    chunks[index % workerCount].push(job);
  }
  const results = await Promise.all(chunks.map(runEvaluationWorker));
  return results.flat();
}

function runEvaluationWorker(jobs: EvaluationJob[]): Promise<EvaluationResult[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { kind: CONFIG.neat.worker.kindEvaluate, jobs },
      execArgv: process.execArgv,
    });
    worker.on("message", (message) => resolve(message as EvaluationResult[]));
    worker.on("error", reject);
    worker.on("exit", (code) => {
      if (code !== CONFIG.count.none) reject(new Error(`Worker exited with code ${code}`));
    });
  });
}

function runWorker(): void {
  if (workerData?.kind !== CONFIG.neat.worker.kindEvaluate) return;
  const jobs = workerData.jobs as EvaluationJob[];
  parentPort?.postMessage(
    jobs.map((job) =>
      evaluateConfig(job.id, job.config, job.bags, job.options, job.opponentPool),
    ),
  );
}

function randomRange(rng: Rng, min: number, max: number): number {
  return min + (max - min) * rng();
}

function randomConfig(rng: Rng): TunableConfig {
  const config = { ...CONFIG.neat.tunable };
  for (const key of Object.keys(CONFIG.neat.ranges) as Array<keyof TunableConfig>) {
    if (key === "finalDump") continue;
    const range = CONFIG.neat.ranges[key as string];
    const value = randomRange(rng, range[CONFIG.count.none], range[CONFIG.count.increment]);
    (config[key] as number) = Number.isInteger(CONFIG.neat.tunable[key] as number)
      ? Math.round(value)
      : value;
  }
  return config;
}

function mutateConfig(config: TunableConfig, rng: Rng): TunableConfig {
  const mutated = { ...config };
  for (const key of Object.keys(CONFIG.neat.ranges) as Array<keyof TunableConfig>) {
    if (key === "finalDump") continue;
    const range = CONFIG.neat.ranges[key as string];
    const scale = CONFIG.neat.evolution.mutationScales[key as string];
    const next = Math.max(
      range[CONFIG.count.none],
      Math.min(
        range[CONFIG.count.increment],
        (mutated[key] as number) + randomRange(rng, -scale, scale),
      ),
    );
    (mutated[key] as number) = Number.isInteger(CONFIG.neat.tunable[key] as number)
      ? Math.round(next)
      : next;
  }
  return mutated;
}

function crossoverConfig(a: TunableConfig, b: TunableConfig, rng: Rng): TunableConfig {
  const child = { ...a };
  for (const key of Object.keys(a) as Array<keyof TunableConfig>) {
    child[key] = (rng() < CONFIG.neat.evolution.eliteFraction ? a[key] : b[key]) as never;
  }
  child.finalDump = true;
  return child;
}

function gridConfigs(): TunableConfig[] {
  const configs: TunableConfig[] = [];
  for (const bidMultiplier of CONFIG.neat.grid.bidMultipliers) {
    for (const maxBidBalanceFraction of CONFIG.neat.grid.maxBidBalanceFractions) {
      for (const reserveBalance of CONFIG.neat.grid.reserveBalances) {
        for (const endgameMultiplier of CONFIG.neat.grid.endgameMultipliers) {
          for (const finalAuctionMultiplier of CONFIG.neat.grid.finalAuctionMultipliers) {
            configs.push({
              ...CONFIG.neat.tunable,
              bidMultiplier,
              maxBidBalanceFraction,
              reserveBalance,
              endgameMultiplier,
              finalAuctionMultiplier,
            });
          }
        }
      }
    }
  }
  return configs;
}

function parseArgs(argv = process.argv.slice(CONFIG.neat.cli.nextArgOffset + CONFIG.neat.cli.nextArgOffset)) {
  const options: CliOptions = { ...CONFIG.neat.defaults };
  for (let i = CONFIG.count.none; i < argv.length; i += CONFIG.count.increment) {
    const arg = argv[i];
    const next = argv[i + CONFIG.neat.cli.nextArgOffset];
    if (!next) continue;
    if (arg === CONFIG.neat.cli.modeFlag) options.mode = next;
    else if (arg === CONFIG.neat.cli.matchesFlag) options.matches = parseInt(next, CONFIG.neat.cli.base);
    else if (arg === CONFIG.neat.cli.generationsFlag) options.generations = parseInt(next, CONFIG.neat.cli.base);
    else if (arg === CONFIG.neat.cli.populationFlag) options.population = parseInt(next, CONFIG.neat.cli.base);
    else if (arg === CONFIG.neat.cli.workersFlag) options.workers = parseInt(next, CONFIG.neat.cli.base);
    else if (arg === CONFIG.neat.cli.seedFlag) options.seed = parseInt(next, CONFIG.neat.cli.base);
    else if (arg === CONFIG.neat.cli.outFlag) options.outFile = next;
    else if (arg === CONFIG.neat.cli.generationDirFlag) options.generationDir = next;
    else if (arg === CONFIG.neat.cli.playersFlag) options.playerCount = parseInt(next, CONFIG.neat.cli.base);
    else if (arg === CONFIG.neat.cli.auctionFlag) options.auctionType = next;
    else if (arg === CONFIG.neat.cli.opponentsFlag) options.opponentProfile = next;
    else if (arg === CONFIG.neat.cli.compareAFlag) options.compareA = next;
    else if (arg === CONFIG.neat.cli.compareBFlag) options.compareB = next;
  }
  return {
    ...options,
    workers: Math.max(
      CONFIG.neat.machine.minimumWorkers,
      Math.min(options.workers, os.cpus().length - CONFIG.neat.machine.cpuReserve),
    ),
  };
}

function makeBags(matches: number, seed: number): string[][] {
  const rng = createSeededRng(seed);
  return Array.from({ length: matches }, () => generateBag(rng));
}

function generationFilePath(dir: string, generation: number): string {
  return path.join(
    dir,
    `${CONFIG.neat.output.generationFilePrefix}${String(generation).padStart(
      CONFIG.neat.output.generationFilePad,
      "0",
    )}${CONFIG.neat.output.generationFileExtension}`,
  );
}

function saveGenerationSnapshot(
  file: string,
  generation: number,
  cli: CliOptions,
  result: EvaluationResult,
  results: EvaluationResult[],
  fixedOpponentCount: number,
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        generation,
        generations: cli.generations,
        mode: cli.mode,
        matches: cli.matches,
        seed: cli.seed,
        playerCount: cli.playerCount,
        auctionType: cli.auctionType,
        opponentProfile: cli.opponentProfile,
        workers: cli.workers,
        stats: {
          fixedOpponentCount,
          peerOpponentCount: CONFIG.neat.evolution.peerOpponentCount,
          population: cli.population,
        },
        result,
        config: result.config,
        top: results.slice(CONFIG.count.none, CONFIG.neat.output.generationTopCount),
      },
      null,
      CONFIG.neat.output.jsonIndent,
    ),
  );
}

function printGenerationSummary(
  logger: Logger,
  generation: number,
  cli: CliOptions,
  results: EvaluationResult[],
  jobCount: number,
  fixedOpponentCount: number,
  snapshotFile: string,
): void {
  const best = results[CONFIG.count.none];
  const last = results[results.length - CONFIG.count.increment];
  logger(`=== Generation ${generation}/${cli.generations} ===`);
  logger(
    `jobs=${jobCount} workers=${cli.workers} matches=${cli.matches} players=${cli.playerCount}`,
  );
  logger(
    `opponents=fixed:${fixedOpponentCount} peers:${CONFIG.neat.evolution.peerOpponentCount} profile:${cli.opponentProfile}`,
  );
  logger(
    `best=${best.id} fitness=${best.fitness.toFixed(CONFIG.neat.output.jsonIndent)} rank=${best.avgRank.toFixed(CONFIG.neat.output.jsonIndent)} win=${best.winRate.toFixed(CONFIG.neat.output.jsonIndent)} score=${best.avgScore.toFixed(CONFIG.neat.output.jsonIndent)}`,
  );
  logger(
    `floor=${last.id} fitness=${last.fitness.toFixed(CONFIG.neat.output.jsonIndent)} rank=${last.avgRank.toFixed(CONFIG.neat.output.jsonIndent)} win=${last.winRate.toFixed(CONFIG.neat.output.jsonIndent)} score=${last.avgScore.toFixed(CONFIG.neat.output.jsonIndent)}`,
  );
  for (const [index, result] of results
    .slice(CONFIG.count.none, CONFIG.neat.output.generationTopCount)
    .entries()) {
    logger(
      `top${index + CONFIG.count.increment}=${result.id} fitness=${result.fitness.toFixed(CONFIG.neat.output.jsonIndent)} rank=${result.avgRank.toFixed(CONFIG.neat.output.jsonIndent)} win=${result.winRate.toFixed(CONFIG.neat.output.jsonIndent)} score=${result.avgScore.toFixed(CONFIG.neat.output.jsonIndent)}`,
    );
  }
  logger(`config=${JSON.stringify(best.config)}`);
  logger(`saved=${snapshotFile}`);
}

async function runGrid(cli: ReturnType<typeof parseArgs>): Promise<EvaluationResult> {
  const options = {
    auctionType: cli.auctionType as AuctionType,
    playerCount: cli.playerCount,
    opponentProfile: cli.opponentProfile,
  };
  const bags = makeBags(cli.matches, cli.seed);
  const opponentPool = fixedOpponentPool(cli.opponentProfile);
  const jobs = gridConfigs().map((config, index) => ({
    id: `grid-${index}`,
    config,
    bags,
    options,
    opponentPool,
  }));
  const results = (await evaluateParallel(jobs, cli.workers)).sort((a, b) => b.fitness - a.fitness);
  printTop(results, CONFIG.neat.output.topCount);
  saveBest(cli.outFile, results[CONFIG.count.none], cli);
  return results[CONFIG.count.none];
}

async function runEvolution(
  cli: ReturnType<typeof parseArgs>,
  logger: Logger = console.log,
): Promise<EvaluationResult> {
  const rng = createSeededRng(cli.seed);
  let population = Array.from({ length: cli.population }, () => randomConfig(rng));
  let best: EvaluationResult | null = null;
  const options = {
    auctionType: cli.auctionType as AuctionType,
    playerCount: cli.playerCount,
    opponentProfile: cli.opponentProfile,
  };
  const fixedOpponents = fixedOpponentPool(cli.opponentProfile);
  for (let generation = CONFIG.count.increment; generation <= cli.generations; generation += CONFIG.count.increment) {
    const bags = makeBags(cli.matches, cli.seed + generation);
    const jobs = population.map((config, index) => ({
      id: `gen-${generation}-${index}`,
      config,
      bags,
      options,
      opponentPool: [
        ...fixedOpponents,
        ...peerOpponentRoster(
          index,
          population,
          CONFIG.neat.evolution.peerOpponentCount,
          createSeededRng(cli.seed + generation + index),
        ),
      ],
    }));
    const results = (await evaluateParallel(jobs, cli.workers)).sort((a, b) => b.fitness - a.fitness);
    best = !best || results[CONFIG.count.none].fitness > best.fitness ? results[CONFIG.count.none] : best;
    const snapshotFile = generationFilePath(cli.generationDir, generation);
    saveGenerationSnapshot(
      snapshotFile,
      generation,
      cli,
      results[CONFIG.count.none],
      results,
      fixedOpponents.length,
    );
    printGenerationSummary(
      logger,
      generation,
      cli,
      results,
      jobs.length,
      fixedOpponents.length,
      snapshotFile,
    );
    const eliteCount = Math.max(
      CONFIG.neat.evolution.minimumElites,
      Math.floor(cli.population * CONFIG.neat.evolution.eliteFraction),
    );
    const elites = results
      .slice(CONFIG.count.none, eliteCount)
      .map((result) => result.config);
    const nextPopulation = [...elites];
    while (nextPopulation.length < cli.population) {
      const a = elites[Math.floor(rng() * elites.length)];
      const b = elites[Math.floor(rng() * elites.length)];
      nextPopulation.push(mutateConfig(crossoverConfig(a, b, rng), rng));
    }
    population = nextPopulation;
  }
  if (!best) throw new Error("Evolution produced no result");
  saveBest(cli.outFile, best, cli);
  return best;
}

export async function runEvolutionForTest(
  cli: CliOptions,
  logger: Logger,
): Promise<EvaluationResult> {
  return runEvolution(cli, logger);
}

async function runCompare(cli: ReturnType<typeof parseArgs>): Promise<void> {
  if (!cli.compareA || !cli.compareB) {
    throw new Error("compare mode requires --a and --b");
  }
  const bags = makeBags(cli.matches, cli.seed);
  const options = {
    auctionType: cli.auctionType as AuctionType,
    playerCount: cli.playerCount,
    opponentProfile: cli.opponentProfile,
  };
  const opponentPool = fixedOpponentPool(cli.opponentProfile);
  const results = await evaluateParallel(
    [
      {
        id: path.basename(cli.compareA),
        config: loadConfig(cli.compareA),
        bags,
        options,
        opponentPool,
      },
      {
        id: path.basename(cli.compareB),
        config: loadConfig(cli.compareB),
        bags,
        options,
        opponentPool,
      },
    ],
    cli.workers,
  );
  printTop(results.sort((a, b) => b.fitness - a.fitness), CONFIG.neat.output.compareCount);
}

function loadConfig(file: string): TunableConfig {
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  return (parsed.config ?? parsed) as TunableConfig;
}

function saveBest(file: string, result: EvaluationResult, cli: ReturnType<typeof parseArgs>): void {
  const dir = path.dirname(file);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        mode: cli.mode,
        matches: cli.matches,
        playerCount: cli.playerCount,
        auctionType: cli.auctionType,
        opponentProfile: cli.opponentProfile,
        result,
        config: result.config,
      },
      null,
      CONFIG.neat.output.jsonIndent,
    ),
  );
  console.log(`saved ${file}`);
}

function printTop(results: EvaluationResult[], count: number): void {
  console.log("rank id fitness avgRank winRate avgScore config");
  for (const [index, result] of results.slice(CONFIG.count.none, count).entries()) {
    console.log(
      `${index + CONFIG.count.increment} ${result.id} ${result.fitness.toFixed(CONFIG.neat.output.jsonIndent)} ${result.avgRank.toFixed(CONFIG.neat.output.jsonIndent)} ${result.winRate.toFixed(CONFIG.neat.output.jsonIndent)} ${result.avgScore.toFixed(CONFIG.neat.output.jsonIndent)} ${JSON.stringify(result.config)}`,
    );
  }
}

async function main(): Promise<void> {
  const cli = parseArgs();
  if (cli.mode === CONFIG.neat.modes.grid) await runGrid(cli);
  else if (cli.mode === CONFIG.neat.modes.evolve) await runEvolution(cli);
  else if (cli.mode === CONFIG.neat.modes.compare) await runCompare(cli);
  else throw new Error(`Unknown mode: ${cli.mode}`);
}

const entryPath = process.argv[CONFIG.count.increment]
  ? path.resolve(process.argv[CONFIG.count.increment])
  : "";
const modulePath = fileURLToPath(import.meta.url);

if (!isMainThread) {
  runWorker();
} else if (entryPath === modulePath) {
  void main().catch((error) => {
    console.error(error);
    process.exit(CONFIG.process.failureExitCode);
  });
}

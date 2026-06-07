import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CONFIG } from "./config.js";
import {
  auctionableTileCount,
  createSeededRng,
  fixedOpponentRosterForTest,
  peerOpponentRosterForTest,
  playWordForTest,
  resolveAuctionForTest,
  runEvolutionForTest,
  runSimulationMatch,
  scoreWordForTest,
  type Bid,
  type SimPlayerState,
  type TunableConfig,
} from "./neat.js";

test("neat module is import-safe for parallel workers and tests", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "-e", "import('./src/neat.ts').then(() => console.log('ok'))"],
    { encoding: "utf8", timeout: CONFIG.neat.test.importTimeoutMs },
  );

  assert.equal(result.status, CONFIG.count.none, result.stderr);
  assert.equal(result.stdout.trim(), "ok");
});

test("simulation avoids loading oversized precomputed best-word tables", () => {
  const script = `
    import { CONFIG } from './src/config.ts';
    import { runSimulationMatch } from './src/neat.ts';

    const player = {
      kind: 'config',
      config: {
        ...CONFIG.neat.tunable,
        bidMultiplier: CONFIG.neat.test.forceBidMultiplier,
        maxBidBalanceFraction: CONFIG.neat.game.maxWholeBalanceFraction,
        reserveBalance: CONFIG.count.none,
        cashInMinScore: CONFIG.neat.test.unreachableCashInScore,
        finalDump: true,
        finalAuctionMultiplier: CONFIG.neat.game.maxWholeBalanceFraction,
      },
    };
    const result = runSimulationMatch({
      bag: ['A', 'T', 'E', 'Q', 'U', 'I', 'Z', 'S', 'R', 'N', 'O', 'L', 'D'],
      players: [player],
      auctionType: 'Vickrey',
    });

    console.log(JSON.stringify({ final: result.finalAuctionLetter }));
  `;
  const result = spawnSync(
    process.execPath,
    ["--max-old-space-size=128", "--import", "tsx", "-e", script],
    { encoding: "utf8", timeout: CONFIG.neat.test.importTimeoutMs },
  );

  assert.equal(result.status, CONFIG.count.none, result.stderr);
  assert.equal(result.stdout.trim(), '{"final":"D"}');
});

test("neat config owns tunable defaults and run limits", () => {
  assert.equal(CONFIG.neat.defaults.playerCount, CONFIG.neat.game.defaultPlayerCount);
  assert.equal(CONFIG.neat.defaults.workers, CONFIG.neat.machine.defaultWorkers);
  assert.equal(CONFIG.neat.tunable.finalDump, true);
  assert.equal(CONFIG.neat.tunable.finalAuctionMultiplier, CONFIG.neat.game.noFinalAuctionValue);
});

test("word play adds reward to both score and balance", () => {
  const player: SimPlayerState = {
    id: CONFIG.count.none,
    balance: CONFIG.neat.game.startingBalance,
    score: CONFIG.count.none,
    rack: ["Q", "U", "I", "Z"],
  };

  const reward = playWordForTest(player, "QUIZ");

  assert.equal(reward, CONFIG.neat.test.quizScore);
  assert.equal(player.score, CONFIG.neat.test.quizScore);
  assert.equal(
    player.balance,
    CONFIG.neat.game.startingBalance + CONFIG.neat.test.quizScore,
  );
  assert.deepEqual(player.rack, []);
});

test("Vickrey auction ties resolve by earliest bid sequence", () => {
  const bids: Bid[] = [
    {
      playerId: CONFIG.neat.test.playerOne,
      amount: CONFIG.neat.test.tieBid,
      sequence: CONFIG.neat.test.secondSequence,
    },
    {
      playerId: CONFIG.neat.test.playerTwo,
      amount: CONFIG.neat.test.tieBid,
      sequence: CONFIG.neat.test.firstSequence,
    },
    {
      playerId: CONFIG.neat.test.playerThree,
      amount: CONFIG.neat.test.lowerBid,
      sequence: CONFIG.neat.test.thirdSequence,
    },
  ];

  const result = resolveAuctionForTest(bids, "Vickrey");

  assert.equal(result.winnerId, CONFIG.neat.test.playerTwo);
  assert.equal(result.topBid, CONFIG.neat.test.tieBid);
  assert.equal(result.paid, CONFIG.neat.test.tieBid);
});

test("auctionable tile count scales with player count", () => {
  assert.equal(
    auctionableTileCount(CONFIG.neat.test.twoPlayers),
    CONFIG.neat.test.twoPlayerAuctionableTiles,
  );
  assert.equal(
    auctionableTileCount(CONFIG.neat.test.sixPlayers),
    CONFIG.neat.test.sixPlayerAuctionableTiles,
  );
  assert.equal(
    auctionableTileCount(CONFIG.neat.test.eightPlayers),
    CONFIG.neat.test.eightPlayerAuctionableTiles,
  );
});

test("last auction tile cannot be scored before match end", () => {
  const player = {
    kind: "config" as const,
    config: {
      ...CONFIG.neat.tunable,
      bidMultiplier: CONFIG.neat.test.forceBidMultiplier,
      maxBidBalanceFraction: CONFIG.neat.game.maxWholeBalanceFraction,
      reserveBalance: CONFIG.count.none,
      cashInMinScore: CONFIG.neat.test.unreachableCashInScore,
      finalAuctionMultiplier: CONFIG.neat.game.maxWholeBalanceFraction,
      finalDump: false,
    },
  };
  const opponent = {
    kind: "config" as const,
    config: {
      ...CONFIG.neat.tunable,
      bidMultiplier: CONFIG.count.none,
      finalDump: false,
    },
  };

  const result = runSimulationMatch({
    bag: [...CONFIG.neat.test.finalTileBag],
    players: [player, opponent],
    auctionType: "Vickrey",
    rng: createSeededRng(CONFIG.neat.test.seed),
  });

  assert.equal(scoreWordForTest("QUIZ"), CONFIG.neat.test.quizScore);
  assert.notEqual(result.players[CONFIG.count.none].score, CONFIG.neat.test.quizScore);
  assert.equal(result.finalAuctionWinnerId, CONFIG.count.none);
  assert.equal(result.finalAuctionLetter, "Z");
});

test("offline opponent pool includes repo live strategy and generated profiles", () => {
  const roster = fixedOpponentRosterForTest(CONFIG.neat.defaults.opponentProfile);
  const names = roster.map((player) => player.name);

  assert.ok(names.includes(CONFIG.neat.profiles.liveStrategyName));
  assert.ok(
    CONFIG.neat.profiles.generated.every((profile) => names.includes(profile.name)),
  );
  assert.ok(CONFIG.neat.profiles.generated.length > 5);
});

test("peer opponent sampling uses other genetic candidates only", () => {
  const population: TunableConfig[] = [
    { ...CONFIG.neat.tunable, bidMultiplier: 0.7 },
    { ...CONFIG.neat.tunable, bidMultiplier: 1.1 },
    { ...CONFIG.neat.tunable, bidMultiplier: 1.5 },
    { ...CONFIG.neat.tunable, bidMultiplier: 2.1 },
  ];

  const peers = peerOpponentRosterForTest(
    1,
    population,
    CONFIG.neat.evolution.peerOpponentCount,
    createSeededRng(CONFIG.neat.test.seed),
  );

  assert.ok(peers.length > 0);
  assert.ok(peers.every((peer) => peer.kind === "config"));
  assert.ok(
    peers.every(
      (peer) =>
        peer.kind !== "config" ||
        peer.config.bidMultiplier !== population[1].bidMultiplier,
    ),
  );
});

test("evolution writes each generation config and prints one verbose block", async () => {
  const generationDir = await mkdtemp(join(tmpdir(), "neat-generation-"));
  const logs: string[] = [];

  await runEvolutionForTest(
    {
      ...CONFIG.neat.defaults,
      generations: 1,
      population: 4,
      matches: 2,
      workers: 1,
      seed: 1234,
      playerCount: 4,
      outFile: join(generationDir, "final.json"),
      generationDir,
    },
    (line) => logs.push(line),
  );

  const snapshotPath = join(generationDir, "generation-0001.json");
  assert.equal(existsSync(snapshotPath), true);

  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.equal(snapshot.generation, 1);
  assert.equal(snapshot.config !== undefined, true);
  assert.equal(snapshot.result.fitness > 0, true);
  assert.equal(snapshot.stats.fixedOpponentCount > 5, true);

  assert.equal(
    logs.filter((line) => line === "=== Generation 1/1 ===").length,
    1,
  );
});

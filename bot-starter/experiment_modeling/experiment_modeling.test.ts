import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { predictOpponentBid } from "./bidPrediction.js";
import { classifyOpponent } from "./classification.js";
import { computeDenialValue } from "./letterValue.js";
import { shouldTrainResiduals } from "./learningPolicy.js";
import { createOpponentModel, OpponentModelStore, updateModelForAuctionResult, updateModelForWordPlay } from "./opponentModel.js";
import { selectTournamentPhase } from "./phase.js";
import { loadPersistentState, savePersistentState } from "./persistentState.js";
import { addWonLetter, createInferredRack, probabilityOpponentNeeds, removePlayedWord } from "./rackInference.js";
import { createResidualLearner, deserializeResidualLearner, letterGroupFor, serializeResidualLearner } from "./residualLearner.js";
import { decideBid } from "./strategy.js";
import { explainPhaseBid } from "../src/phase_strategy.js";

test("selects tournament phase from remaining player count", () => {
  assert.equal(selectTournamentPhase(6), "learn");
  assert.equal(selectTournamentPhase(4), "exploit");
  assert.equal(selectTournamentPhase(3), "exploit");
  assert.equal(selectTournamentPhase(2), "duel");
});

test("tracks inferred rack from public auction wins and word plays", () => {
  const rack = createInferredRack();
  addWonLetter(rack, "S");
  addWonLetter(rack, "E");
  addWonLetter(rack, "E");
  removePlayedWord(rack, "SEE");

  assert.equal(rack.letters.get("S") ?? 0, 0);
  assert.equal(rack.letters.get("E") ?? 0, 0);
});

test("estimates opponent need from inferred rack shape", () => {
  const rack = createInferredRack();
  for (const letter of ["T", "R", "A", "I", "N"]) addWonLetter(rack, letter);

  assert.ok(probabilityOpponentNeeds(rack, "S") > probabilityOpponentNeeds(rack, "Q"));
});

test("classifies explainable opponent behavior", () => {
  const aggressive = createOpponentModel("botA");
  aggressive.auctionsSeen = 5;
  aggressive.auctionsWon = 4;
  aggressive.averageBidEstimate = 18;
  assert.equal(classifyOpponent(aggressive), "aggressive");

  const hoarder = createOpponentModel("botB");
  hoarder.auctionsSeen = 12;
  hoarder.auctionsWon = 8;
  hoarder.playFrequency = 0.05;
  hoarder.hoardingScore = 9;
  assert.equal(classifyOpponent(hoarder), "hoarder");
});

test("updates model from public auction and word events", () => {
  const model = createOpponentModel("botA");
  updateModelForAuctionResult(model, { letter: "S", won: true, paid: 12 });
  updateModelForAuctionResult(model, { letter: "E", won: false, paid: 0 });
  updateModelForWordPlay(model, { word: "AS", reward: 2 });

  assert.equal(model.auctionsSeen, 2);
  assert.equal(model.auctionsWon, 1);
  assert.ok(model.sPreference > 0);
  assert.equal(model.averageWordLength, 2);
  assert.ok(model.playFrequency > 0);
});

test("predicts higher bids for preferred high-leverage letters", () => {
  const model = createOpponentModel("botA");
  model.averageBidEstimate = 10;
  model.vowelAggression = 0.8;
  model.sPreference = 0.9;
  model.classification = "aggressive";

  assert.ok(predictOpponentBid(model, "S") > predictOpponentBid(model, "B"));
  assert.ok(predictOpponentBid(model, "E") > predictOpponentBid(model, "B"));
});

test("denial value rises when strong modeled opponents likely need the letter", () => {
  const model = createOpponentModel("botA");
  model.averageBidEstimate = 14;
  model.classification = "hoarder";
  model.inferredRack.letters.set("T", 1);
  model.inferredRack.letters.set("R", 1);
  model.inferredRack.letters.set("A", 1);
  model.inferredRack.letters.set("I", 1);
  model.inferredRack.letters.set("N", 1);

  assert.ok(computeDenialValue("S", [model]) > computeDenialValue("Q", [model]));
});

test("modeling strategy uses lisan baseline and clamps bankroll-aware bids", () => {
  const opponent = createOpponentModel("botA");
  opponent.averageBidEstimate = 8;
  opponent.classification = "frugal";
  opponent.inferredRack.letters.set("A", 1);
  opponent.inferredRack.letters.set("T", 1);

  const bid = decideBid({
    letter: "E",
    myBalance: 20,
    myRack: new Map([["T", 1], ["R", 1]]),
    round: 10,
    dictionary: ["TREE", "TEE", "TE"],
    useNoBidFloor: true,
    auctionType: "Vickrey",
    playersRemaining: 3,
    opponents: [opponent],
  });

  assert.ok(bid >= 0);
  assert.ok(bid <= 20);
});

test("residual learner starts at lisan with zero residual", () => {
  const learner = createResidualLearner();

  const decision = learner.choose({
    phase: "duel",
    letter: "Q",
    rackBucket: "balanced",
    balanceBucket: "healthy",
    opponentPressureBucket: "unknown",
    auctionType: "Vickrey",
  } as const);

  assert.equal(decision.residual, 0);
});

test("modeling bid with zero residual equals lisan bid exactly", () => {
  const ctx = {
    letter: "Q",
    myBalance: 100,
    myRack: new Map([
      ["T", 1],
      ["R", 1],
      ["A", 1],
      ["I", 1],
      ["N", 1],
    ]),
    round: 8,
    bagTotal: 70,
    dictionary: ["QUIZZES", "QUIZ", "ZITS", "SIT", "TRAIN", "STRAIN", "RAIN", "AIR"],
    useNoBidFloor: true,
    auctionType: "Vickrey" as const,
  };
  const learner = createResidualLearner();

  assert.equal(
    decideBid({
      ...ctx,
      playersRemaining: 6,
      opponents: [],
      learner,
    }),
    explainPhaseBid(ctx).bid,
  );
});

test("residual learner stays at lisan during warmup updates", () => {
  const learner = createResidualLearner({ warmupUpdates: 2 });
  const bucket = {
    phase: "duel",
    letter: "S",
    rackBucket: "balanced",
    balanceBucket: "healthy",
    opponentPressureBucket: "high",
    auctionType: "Vickrey",
  } as const;
  const key = learner.keyFor(bucket);

  learner.update([{ key, residual: 8 }], 1);

  assert.equal(learner.choose(bucket).residual, 0);
});

test("residual learner generalizes letters into shared groups", () => {
  const learner = createResidualLearner({ warmupUpdates: 0 });
  const eBucket = {
    phase: "duel",
    letter: "E",
    rackBucket: "balanced",
    balanceBucket: "healthy",
    opponentPressureBucket: "high",
    auctionType: "Vickrey",
  } as const;
  const aBucket = { ...eBucket, letter: "A" };

  assert.equal(letterGroupFor("E"), "vowel");
  assert.equal(learner.keyFor(eBucket), learner.keyFor(aBucket));
});

test("residual learner shifts toward rewarded bounded actions", () => {
  const learner = createResidualLearner({ warmupUpdates: 0, explorationRate: 0 });
  const bucket = {
    phase: "duel" as const,
    letter: "S",
    rackBucket: "balanced",
    balanceBucket: "healthy",
    opponentPressureBucket: "high",
    auctionType: "Vickrey" as const,
  } as const;

  for (let i = 0; i < 12; i += 1) {
    learner.update([{ key: learner.keyFor(bucket), residual: 5 }], 1);
  }

  assert.equal(learner.choose(bucket).residual, 5);
});

test("residual learner keeps zero when nonzero actions are unproven", () => {
  const learner = createResidualLearner({ warmupUpdates: 0, explorationRate: 0 });
  const bucket = {
    phase: "duel" as const,
    letter: "Z",
    rackBucket: "balanced",
    balanceBucket: "healthy",
    opponentPressureBucket: "high",
    auctionType: "Vickrey" as const,
  } as const;

  assert.equal(learner.choose(bucket).residual, 0);
});

test("residual learner persists learned matrix state", () => {
  const learner = createResidualLearner();
  const key = learner.keyFor({
    phase: "exploit",
    letter: "E",
    rackBucket: "vowel-starved",
    balanceBucket: "thin",
    opponentPressureBucket: "low",
    auctionType: "FirstPrice",
  });
  learner.update([{ key, residual: 2 }], 0.75);

  const restored = deserializeResidualLearner(serializeResidualLearner(learner));
  const stats = restored.statsFor(key, 2);

  assert.equal(stats.count, 1);
  assert.equal(stats.value, 0.75);
});

test("opponent model store serializes public learned state", () => {
  const store = new OpponentModelStore();
  store.observeAuction(["botA"], "botA", "S", 9);
  store.observeWord("botA", "AS", 2);

  const restored = OpponentModelStore.fromJSON(store.toJSON());
  const model = restored.get("botA");

  assert.equal(model.auctionsSeen, 1);
  assert.equal(model.auctionsWon, 1);
  assert.equal(model.averageWordLength, 2);
});

test("persistent state saves learner and opponent models to disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "thinker-state-"));
  const file = path.join(dir, "state.json");
  const learner = createResidualLearner();
  const models = new OpponentModelStore();
  const key = learner.keyFor({
    phase: "duel",
    letter: "S",
    rackBucket: "large-rack",
    balanceBucket: "healthy",
    opponentPressureBucket: "high",
    auctionType: "Vickrey",
  });
  learner.update([{ key, residual: 8 }], 1);
  models.observeAuction(["lisan"], "lisan", "E", 6);

  savePersistentState(file, { learner, models });
  const restored = loadPersistentState(file);

  assert.equal(restored.learner.statsFor(key, 8).count, 1);
  assert.equal(restored.models.get("lisan").auctionsWon, 1);
});

test("live residual training skips partial matches", () => {
  assert.equal(shouldTrainResiduals(1), false);
  assert.equal(shouldTrainResiduals(39), false);
  assert.equal(shouldTrainResiduals(40), true);
});

import assert from "node:assert/strict";
import test from "node:test";

import { CONFIG } from "./config.js";
import {
  decidePhaseBid,
  explainPhaseBid,
  selectLivePhase,
} from "./phase_strategy.js";

const rackWithA = new Map<string, number>([["A", CONFIG.count.increment]]);
const completionDictionary = ["AT"];
const rackWithAbc = new Map<string, number>([
  ["A", CONFIG.count.increment],
  ["B", CONFIG.count.increment],
  ["C", CONFIG.count.increment],
]);
const rackWithAbcde = new Map<string, number>([
  ["A", CONFIG.count.increment],
  ["B", CONFIG.count.increment],
  ["C", CONFIG.count.increment],
  ["D", CONFIG.count.increment],
  ["E", CONFIG.count.increment],
]);
const rackWithAbcdef = new Map<string, number>([
  ["A", CONFIG.count.increment],
  ["B", CONFIG.count.increment],
  ["C", CONFIG.count.increment],
  ["D", CONFIG.count.increment],
  ["E", CONFIG.count.increment],
  ["F", CONFIG.count.increment],
]);

test("live phase selection follows configured round boundaries", () => {
  assert.equal(
    selectLivePhase(CONFIG.live.phases.beginning.maxRound),
    CONFIG.live.phaseNames.beginning,
  );
  assert.equal(
    selectLivePhase(CONFIG.live.phases.beginning.maxRound + CONFIG.count.increment),
    CONFIG.live.phaseNames.middle,
  );
  assert.equal(
    selectLivePhase(CONFIG.live.phases.middle.maxRound + CONFIG.count.increment),
    CONFIG.live.phaseNames.end,
  );
});

test("beginning bids by usual letter strength, not rack completion", () => {
  const strongUsualLetterBid = decidePhaseBid({
    letter: "Z",
    myBalance: CONFIG.live.testBalance,
    myRack: rackWithA,
    round: CONFIG.live.phases.beginning.maxRound,
    dictionary: completionDictionary,
  });
  const completingLetterBid = decidePhaseBid({
    letter: "T",
    myBalance: CONFIG.live.testBalance,
    myRack: rackWithA,
    round: CONFIG.live.phases.beginning.maxRound,
    dictionary: completionDictionary,
  });

  assert.ok(strongUsualLetterBid > completingLetterBid);
});

test("middle blends usual letter strength with our rack fit", () => {
  const beginningCompletionBid = decidePhaseBid({
    letter: "T",
    myBalance: CONFIG.live.testBalance,
    myRack: rackWithA,
    round: CONFIG.live.phases.beginning.maxRound,
    dictionary: completionDictionary,
  });
  const middleCompletionBid = decidePhaseBid({
    letter: "T",
    myBalance: CONFIG.live.testBalance,
    myRack: rackWithA,
    round: CONFIG.live.phases.middle.maxRound,
    dictionary: completionDictionary,
  });

  assert.ok(middleCompletionBid > beginningCompletionBid);
});

test("low-cost floor bids apply to non-excluded no-bid letters", () => {
  const floorBid = decidePhaseBid({
    letter: "A",
    myBalance: CONFIG.live.phases.beginning.minBid,
    myRack: rackWithA,
    round: CONFIG.live.phases.beginning.maxRound,
    dictionary: completionDictionary,
    useNoBidFloor: true,
  });
  const skippedBid = decidePhaseBid({
    letter: "Q",
    myBalance: CONFIG.live.phases.beginning.minBid,
    myRack: rackWithA,
    round: CONFIG.live.phases.beginning.maxRound,
    dictionary: completionDictionary,
    useNoBidFloor: true,
  });

  assert.equal(floorBid, CONFIG.live.phases.beginning.minBid);
  assert.equal(skippedBid, CONFIG.bidding.noBidAmount);
});

test("beginning empty-rack bids use precomputed letter priors", () => {
  const vowelBid = decidePhaseBid({
    letter: "A",
    myBalance: CONFIG.live.testBalance,
    myRack: new Map(),
    round: CONFIG.live.phases.beginning.maxRound,
    dictionary: completionDictionary,
    useNoBidFloor: true,
  });
  const lowPriorBid = decidePhaseBid({
    letter: "V",
    myBalance: CONFIG.live.testBalance,
    myRack: new Map(),
    round: CONFIG.live.phases.beginning.maxRound,
    dictionary: completionDictionary,
    useNoBidFloor: true,
  });

  assert.ok(vowelBid >= CONFIG.scoring.fourLetterLength);
  assert.ok(vowelBid > lowPriorBid);
});

test("beginning bids include a modest rack-fit signal", () => {
  const emptyRackBid = decidePhaseBid({
    letter: "T",
    myBalance: CONFIG.live.testBalance,
    myRack: new Map(),
    round: CONFIG.count.increment,
    dictionary: completionDictionary,
    useNoBidFloor: true,
  });
  const fittingRackBid = decidePhaseBid({
    letter: "T",
    myBalance: CONFIG.live.testBalance,
    myRack: rackWithA,
    round: CONFIG.count.increment,
    dictionary: completionDictionary,
    useNoBidFloor: true,
  });

  assert.ok(fittingRackBid > emptyRackBid);
});

test("small racks shift some phase rack-fit weight into usual letter value", () => {
  const explanation = explainPhaseBid({
    letter: "Z",
    myBalance: CONFIG.live.testBalance,
    myRack: rackWithAbc,
    round: CONFIG.live.phases.middle.maxRound,
    dictionary: ["ABC", "ABCZ"],
  });
  const phaseConfig = CONFIG.live.phases.middle;
  const expectedUsualWeight =
    phaseConfig.usualLetterWeight + phaseConfig.rackFitWeight * 0.2;
  const expectedRackFitWeight = phaseConfig.rackFitWeight * 0.8;

  assert.equal(
    explanation.value,
    explanation.usualLetterValue * expectedUsualWeight +
      explanation.rackFitValue * expectedRackFitWeight,
  );
});

test("large racks shift some phase usual-letter weight into rack fit", () => {
  const explanation = explainPhaseBid({
    letter: "T",
    myBalance: CONFIG.live.testBalance,
    myRack: rackWithAbcdef,
    round: CONFIG.count.increment,
    dictionary: ["ABCDEF", "ABCDEFT"],
  });
  const phaseConfig = CONFIG.live.phases.beginning;
  const expectedUsualWeight = phaseConfig.usualLetterWeight * 0.8;
  const expectedRackFitWeight =
    phaseConfig.rackFitWeight + phaseConfig.usualLetterWeight * 0.2;

  assert.equal(
    explanation.value,
    explanation.usualLetterValue * expectedUsualWeight +
      explanation.rackFitValue * expectedRackFitWeight,
  );
});

test("small end racks still value generally strong letters", () => {
  const explanation = explainPhaseBid({
    letter: "Z",
    myBalance: CONFIG.live.testBalance,
    myRack: new Map(),
    round: CONFIG.live.phases.middle.maxRound + CONFIG.count.increment,
    dictionary: completionDictionary,
  });

  assert.equal(explanation.evDiff, CONFIG.live.noRackGain);
  assert.ok(explanation.value > CONFIG.bidding.noBidAmount);
});

test("live Vickrey bids apply enough pressure to avoid dead bankroll", () => {
  const earlyVowelBid = decidePhaseBid({
    letter: "A",
    myBalance: CONFIG.live.testBalance,
    myRack: new Map(),
    round: CONFIG.count.increment,
    dictionary: completionDictionary,
    useNoBidFloor: true,
    auctionType: "Vickrey",
  });
  const earlyCommonConsonantBid = decidePhaseBid({
    letter: "R",
    myBalance: CONFIG.live.testBalance,
    myRack: new Map<string, number>([
      ["B", CONFIG.count.increment],
      ["E", CONFIG.count.increment],
      ["N", CONFIG.count.increment],
      ["O", CONFIG.count.increment],
      ["U", CONFIG.count.increment],
    ]),
    round: CONFIG.count.increment,
    dictionary: completionDictionary,
    useNoBidFloor: true,
    auctionType: "Vickrey",
  });

  assert.ok(earlyVowelBid >= 8);
  assert.ok(earlyCommonConsonantBid >= CONFIG.scoring.fiveLetterLength);
});

test("Vickrey bids at least immediate best-word EV diff", () => {
  const explanation = explainPhaseBid({
    letter: "X",
    myBalance: CONFIG.live.testBalance,
    myRack: rackWithA,
    round: CONFIG.count.increment,
    dictionary: completionDictionary,
    useNoBidFloor: true,
    auctionType: "Vickrey",
  });

  assert.equal(explanation.evDiff, 9);
  assert.ok(explanation.bid >= explanation.evDiff);
  assert.match(explanation.reason, /ev-floor|baseline-floor|bid/);
});

test("Vickrey uses ten as the baseline bet for non-Q letters", () => {
  const explanation = explainPhaseBid({
    letter: "V",
    myBalance: CONFIG.live.testBalance,
    myRack: new Map(),
    round: CONFIG.count.increment,
    dictionary: completionDictionary,
    useNoBidFloor: true,
    auctionType: "Vickrey",
  });

  assert.equal(explanation.bid, CONFIG.live.valuation.vickreyBaselineBid);
  assert.equal(explanation.baselineBid, CONFIG.live.valuation.vickreyBaselineBid);
  assert.equal(explanation.reason, "baseline-floor");
});

test("Vickrey baseline nudges optional bids slightly with bankroll surplus or deficit", () => {
  const context = {
    letter: "V",
    myRack: new Map<string, number>(),
    round: CONFIG.live.phases.middle.maxRound + CONFIG.count.increment,
    dictionary: completionDictionary,
    useNoBidFloor: true,
    auctionType: "Vickrey" as const,
  };
  const expectedBalance = explainPhaseBid({
    ...context,
    myBalance: CONFIG.live.testBalance,
  }).expectedBalance;
  const onCurve = explainPhaseBid({
    ...context,
    myBalance: expectedBalance,
  });
  const ahead = explainPhaseBid({
    ...context,
    myBalance:
      expectedBalance + CONFIG.live.bankrollPressure.fullPressureBalanceDelta,
  });
  const behind = explainPhaseBid({
    ...context,
    myBalance: expectedBalance - 20,
  });

  assert.equal(onCurve.baselineBid, CONFIG.live.valuation.vickreyBaselineBid);
  assert.ok(ahead.baselineBid > onCurve.baselineBid);
  assert.ok(
    ahead.baselineBid <= CONFIG.live.valuation.vickreyBaselineBid + 2,
  );
  assert.ok(behind.baselineBid < onCurve.baselineBid);
  assert.ok(
    behind.baselineBid >= CONFIG.live.valuation.vickreyBaselineBid - 2,
  );
  assert.equal(ahead.reason, "baseline-floor");
  assert.equal(behind.reason, "baseline-floor");
});

test("Vickrey EV floor is not discounted by an understated baseline deficit", () => {
  const rack = new Map<string, number>([
    ["A", CONFIG.count.increment],
    ["E", CONFIG.count.increment],
    ["O", CONFIG.scoring.fiveLetterMultiplier],
    ["Y", CONFIG.count.increment],
  ]);
  const expectedBalance = explainPhaseBid({
    letter: "G",
    myBalance: CONFIG.live.testBalance,
    myRack: rack,
    round: CONFIG.live.phases.beginning.maxRound,
    dictionary: completionDictionary,
    useNoBidFloor: true,
    auctionType: "Vickrey",
  }).expectedBalance;
  const explanation = explainPhaseBid({
    letter: "G",
    myBalance: expectedBalance - 20,
    myRack: rack,
    round: CONFIG.live.phases.beginning.maxRound,
    dictionary: completionDictionary,
    useNoBidFloor: true,
    auctionType: "Vickrey",
  });

  assert.ok(explanation.baselineBid < CONFIG.live.valuation.vickreyBaselineBid);
  assert.ok(explanation.evDiff > explanation.baselineBid);
  assert.equal(explanation.bid, Math.min(explanation.cap, explanation.evDiff));
  assert.equal(explanation.reason, "ev-floor");
});

test("Vickrey bankroll pressure increases non-EV spend when balance is ahead", () => {
  const baseContext = {
    letter: "A",
    myRack: new Map<string, number>([["E", CONFIG.count.increment]]),
    round: CONFIG.live.phases.middle.maxRound,
    dictionary: completionDictionary,
    useNoBidFloor: true,
    auctionType: "Vickrey" as const,
  };
  const expectedBalance = explainPhaseBid({
    ...baseContext,
    myBalance: CONFIG.live.testBalance,
  }).expectedBalance;
  const onCurve = explainPhaseBid({
    ...baseContext,
    myBalance: expectedBalance,
  });
  const ahead = explainPhaseBid({
    ...baseContext,
    myBalance: CONFIG.live.testBalance,
  });

  assert.ok(ahead.balanceDelta > CONFIG.count.none);
  assert.ok(ahead.pressureMultiplier > onCurve.pressureMultiplier);
  assert.ok(ahead.bid > onCurve.bid);
});

test("Vickrey bankroll pressure preserves EV floor when balance is behind", () => {
  const explanation = explainPhaseBid({
    letter: "X",
    myBalance:
      CONFIG.live.phases.beginning.maxRound + CONFIG.scoring.fiveLetterLength,
    myRack: rackWithA,
    round: CONFIG.live.phases.beginning.maxRound + CONFIG.count.increment,
    dictionary: completionDictionary,
    useNoBidFloor: true,
    auctionType: "Vickrey",
  });

  assert.ok(explanation.balanceDelta < CONFIG.count.none);
  assert.ok(explanation.pressureMultiplier < CONFIG.count.increment);
  assert.ok(explanation.evDiff > CONFIG.bidding.noBidAmount);
  assert.ok(explanation.bid >= explanation.evDiff);
});

test("rack fit falls back to exact dictionary gain through rack size twelve", () => {
  const rack = new Map<string, number>(
    "ABCDEFGHIJKL".split("").map((letter) => [letter, CONFIG.count.increment]),
  );
  const explanation = explainPhaseBid({
    letter: "M",
    myBalance: CONFIG.live.testBalance,
    myRack: rack,
    round: CONFIG.live.phases.middle.maxRound + CONFIG.count.increment,
    dictionary: ["ABCDEFGHIJKLM"],
    useNoBidFloor: true,
    auctionType: "FirstPrice",
  });

  assert.equal(explanation.rackSize, CONFIG.live.valuation.runtimeRackFitMaxRackSize);
  assert.ok(explanation.evDiff > CONFIG.count.none);
  assert.ok(explanation.bid > CONFIG.live.phases.end.minBid);
});

test("last three auctions force all-in bids except bare Q", () => {
  const balance = 37;
  const finalNonQ = explainPhaseBid({
    letter: "N",
    myBalance: balance,
    myRack: new Map(),
    round: CONFIG.live.phases.middle.maxRound + CONFIG.count.increment,
    dictionary: completionDictionary,
    useNoBidFloor: true,
    auctionType: "Vickrey",
    bagTotal: CONFIG.live.finalThreeBagTotal,
  });
  const bareQ = explainPhaseBid({
    letter: "Q",
    myBalance: balance,
    myRack: new Map(),
    round: CONFIG.live.phases.middle.maxRound + CONFIG.count.increment,
    dictionary: completionDictionary,
    useNoBidFloor: true,
    auctionType: "Vickrey",
    bagTotal: CONFIG.live.finalThreeBagTotal,
  });
  const qWithU = explainPhaseBid({
    letter: "Q",
    myBalance: balance,
    myRack: new Map<string, number>([["U", CONFIG.count.increment]]),
    round: CONFIG.live.phases.middle.maxRound + CONFIG.count.increment,
    dictionary: completionDictionary,
    useNoBidFloor: true,
    auctionType: "Vickrey",
    bagTotal: CONFIG.live.finalThreeBagTotal,
  });

  assert.equal(finalNonQ.bid, balance);
  assert.equal(finalNonQ.reason, "final-three-all-in");
  assert.equal(bareQ.bid, CONFIG.bidding.noBidAmount);
  assert.equal(bareQ.reason, "skip-bare-q");
  assert.equal(qWithU.bid, balance);
  assert.equal(qWithU.reason, "final-three-all-in");
});

test("bare Q is avoided unless rack value justifies it", () => {
  const qBid = decidePhaseBid({
    letter: "Q",
    myBalance: CONFIG.live.testBalance,
    myRack: new Map(),
    round: CONFIG.live.phases.beginning.maxRound,
    dictionary: completionDictionary,
    useNoBidFloor: true,
  });

  assert.equal(qBid, CONFIG.bidding.noBidAmount);
});

test("U receives synergy value when Q is already on our rack", () => {
  const qRack = new Map<string, number>([["Q", CONFIG.count.increment]]);
  const emptyRackBid = decidePhaseBid({
    letter: "U",
    myBalance: CONFIG.live.testBalance,
    myRack: new Map(),
    round: CONFIG.live.phases.middle.maxRound,
    dictionary: completionDictionary,
    useNoBidFloor: true,
  });
  const qRackBid = decidePhaseBid({
    letter: "U",
    myBalance: CONFIG.live.testBalance,
    myRack: qRack,
    round: CONFIG.live.phases.middle.maxRound,
    dictionary: completionDictionary,
    useNoBidFloor: true,
  });

  assert.ok(qRackBid > emptyRackBid);
});

test("S no longer gets a separate long-rack multiplier", () => {
  const explanation = explainPhaseBid({
    letter: "S",
    myBalance: CONFIG.live.testBalance,
    myRack: rackWithAbcde,
    round: CONFIG.live.phases.middle.maxRound,
    dictionary: ["ABCDE", "ABCDES"],
  });

  assert.equal(explanation.rackFitValue, explanation.evDiff);
});

test("large end racks remain rack-fit driven", () => {
  const explanation = explainPhaseBid({
    letter: "Z",
    myBalance: CONFIG.live.testBalance,
    myRack: rackWithAbcdef,
    round: CONFIG.live.phases.middle.maxRound + CONFIG.count.increment,
    dictionary: ["ABCDEF", "ABCDEFT"],
  });

  assert.equal(explanation.value, explanation.rackFitValue);
});

test("bid explanation exposes decision inputs without changing bid", () => {
  const context = {
    letter: "A",
    myBalance: CONFIG.live.testBalance,
    myRack: new Map<string, number>([["E", CONFIG.count.increment]]),
    round: CONFIG.live.phases.middle.maxRound,
    dictionary: completionDictionary,
    useNoBidFloor: true,
    auctionType: "Vickrey" as const,
  };

  const explanation = explainPhaseBid(context);

  assert.equal(explanation.bid, decidePhaseBid(context));
  assert.equal(explanation.letter, context.letter);
  assert.equal(explanation.phase, CONFIG.live.phaseNames.middle);
  assert.equal(explanation.balance, context.myBalance);
  assert.ok(explanation.usualLetterValue > CONFIG.count.none);
  assert.ok(explanation.evDiff >= CONFIG.count.none);
  assert.ok(explanation.expectedBalance >= CONFIG.count.none);
  assert.ok(Number.isFinite(explanation.balanceDelta));
  assert.ok(explanation.pressureMultiplier > CONFIG.count.none);
  assert.ok(explanation.baselineBid >= CONFIG.bidding.noBidAmount);
  assert.ok(explanation.cap > CONFIG.count.none);
  assert.match(explanation.reason, /bid|floor|skip/);
});

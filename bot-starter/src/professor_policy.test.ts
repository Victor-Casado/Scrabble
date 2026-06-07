import assert from "node:assert/strict";
import test from "node:test";

import { CONFIG } from "./config.js";
import { explainProfessorBid } from "./professor_policy.js";

test("professor policy applies a gated six-player table override", () => {
  const explanation = explainProfessorBid({
    letter: "A",
    myBalance: 60,
    myRack: new Map<string, number>([
      ["Q", CONFIG.count.increment],
      ["U", CONFIG.count.increment],
      ["I", CONFIG.count.increment],
      ["Z", CONFIG.count.increment],
      ["B", CONFIG.count.increment],
      ["C", CONFIG.count.increment],
      ["D", CONFIG.count.increment],
    ]),
    round: CONFIG.live.phases.beginning.maxRound + CONFIG.count.increment,
    bagTotal: 40,
    dictionary: ["QUIZ"],
    useNoBidFloor: true,
    auctionType: "Vickrey",
    playerCount: 6,
  });

  assert.equal(explanation.table, "six");
  assert.equal(explanation.key, "A|p1|rs1|vw1|br2|b3");
  assert.equal(explanation.reason, "override");
  assert.equal(explanation.bid, explanation.baselineBid + CONFIG.professor.sixMaxBidDelta);
});

test("professor policy rejects low-confidence table entries", () => {
  const explanation = explainProfessorBid({
    letter: "A",
    myBalance: 100,
    myRack: new Map<string, number>(),
    round: CONFIG.count.increment,
    bagTotal: 80,
    dictionary: [],
    useNoBidFloor: true,
    auctionType: "Vickrey",
    playerCount: 6,
  });

  assert.equal(explanation.table, "six");
  assert.equal(explanation.key, "A|p0|rs0|vw0|br0|b4");
  assert.equal(explanation.reason, "override-rejected");
  assert.equal(explanation.bid, explanation.baselineBid);
});

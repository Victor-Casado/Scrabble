import assert from "node:assert/strict";
import test from "node:test";
import {
  canSubmitWordNow,
  cashInThresholdFor,
  isFinalWordWindow,
  shouldSubmitWordNow,
  shouldBidOnAuction,
  type AuctionWindowState,
  type MatchWindowState,
} from "./word_policy.js";

const openAuction: AuctionWindowState = {
  id: 42n,
  matchId: 7n,
  status: { tag: "Open" },
  closesAt: { microsSinceUnixEpoch: 2_000_000n },
};

function runningMatch(overrides: Partial<MatchWindowState> = {}): MatchWindowState {
  return {
    status: { tag: "Running" },
    currentAuctionId: 42n,
    bagTotal: 10,
    ...overrides,
  };
}

test("word submission is allowed throughout a running match", () => {
  assert.equal(canSubmitWordNow(runningMatch({ bagTotal: 1 }), openAuction), true);
  assert.equal(canSubmitWordNow(runningMatch({ bagTotal: 10 }), openAuction), true);
});

test("final visible auction is still detected for rack cleanup", () => {
  assert.equal(canSubmitWordNow(runningMatch({ bagTotal: 2 }), openAuction), true);
  assert.equal(isFinalWordWindow(runningMatch({ bagTotal: 2 }), openAuction), true);
  assert.equal(canSubmitWordNow(runningMatch({ bagTotal: 1 }), openAuction), true);
  assert.equal(isFinalWordWindow(runningMatch({ bagTotal: 1 }), openAuction), true);
  assert.equal(canSubmitWordNow(runningMatch({ bagTotal: 0 }), openAuction), true);
  assert.equal(isFinalWordWindow(runningMatch({ bagTotal: 0 }), openAuction), true);
});

test("strong words are submitted before the final window", () => {
  assert.equal(
    shouldSubmitWordNow(runningMatch({ bagTotal: 60 }), openAuction, 24, 100),
    false,
  );
  assert.equal(
    shouldSubmitWordNow(runningMatch({ bagTotal: 60 }), openAuction, 32, 100),
    true,
  );
  assert.equal(
    shouldSubmitWordNow(runningMatch({ bagTotal: 60 }), openAuction, 12, 100),
    false,
  );
  assert.equal(
    shouldSubmitWordNow(runningMatch({ bagTotal: 2 }), openAuction, 2, 100),
    true,
  );
});

test("score target lowers cash-in thresholds without allowing tiny words", () => {
  assert.equal(
    cashInThresholdFor(runningMatch({ bagTotal: 60 }), 100, 80),
    32,
  );
  assert.equal(
    cashInThresholdFor(runningMatch({ bagTotal: 45 }), 100, 80),
    32,
  );
  assert.equal(
    cashInThresholdFor(runningMatch({ bagTotal: 20 }), 100, 80),
    28,
  );
  assert.equal(
    shouldSubmitWordNow(runningMatch({ bagTotal: 45 }), openAuction, 24, 100, 80),
    false,
  );
  assert.equal(
    shouldSubmitWordNow(runningMatch({ bagTotal: 45 }), openAuction, 32, 100, 80),
    true,
  );
  assert.equal(
    shouldSubmitWordNow(runningMatch({ bagTotal: 45 }), openAuction, 8, 100, 100),
    false,
  );
});

test("emergency cash-in still requires a meaningful word", () => {
  assert.equal(
    shouldSubmitWordNow(runningMatch({ bagTotal: 30 }), openAuction, 20, 9),
    false,
  );
  assert.equal(
    shouldSubmitWordNow(runningMatch({ bagTotal: 30 }), openAuction, 24, 9),
    true,
  );
  assert.equal(
    shouldSubmitWordNow(runningMatch({ bagTotal: 30 }), openAuction, 24, 40),
    false,
  );
});

test("final visible auction is a no-bid auction and stale auctions are skipped", () => {
  assert.equal(
    shouldBidOnAuction(runningMatch({ bagTotal: 0 }), openAuction, 1_000_000n),
    false,
  );
  assert.equal(
    shouldBidOnAuction(runningMatch({ bagTotal: 1 }), openAuction, 1_000_000n),
    false,
  );
  assert.equal(
    shouldBidOnAuction(runningMatch({ bagTotal: 2 }), openAuction, 1_000_000n),
    false,
  );
  assert.equal(
    shouldBidOnAuction(runningMatch({ bagTotal: 3 }), openAuction, 1_000_000n),
    true,
  );
  assert.equal(
    shouldBidOnAuction(
      runningMatch({ bagTotal: 3, currentAuctionId: 43n }),
      openAuction,
      1_000_000n,
    ),
    false,
  );
  assert.equal(
    shouldBidOnAuction(
      runningMatch({ bagTotal: 3 }),
      { ...openAuction, closesAt: { microsSinceUnixEpoch: 1_050_000n } },
      1_000_000n,
    ),
    false,
  );
});

test("closed or stale auctions are not final word windows", () => {
  assert.equal(
    isFinalWordWindow(runningMatch({ bagTotal: 0 }), {
      ...openAuction,
      status: { tag: "Closed" },
    }),
    false,
  );
  assert.equal(
    isFinalWordWindow(runningMatch({ bagTotal: 0, currentAuctionId: 43n }), openAuction),
    false,
  );
});

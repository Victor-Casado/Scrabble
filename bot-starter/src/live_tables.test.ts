import assert from "node:assert/strict";
import test from "node:test";

import { CONFIG } from "./config.js";
import {
  letterPriorForTile,
  tileGainForRackTile,
} from "./live_tables.js";

test("live table loader reads existing letter priors", () => {
  assert.equal(letterPriorForTile("A"), 8.2);
  assert.equal(letterPriorForTile("Q"), 0.7);
  assert.equal(letterPriorForTile("?"), CONFIG.count.none);
});

test("live table loader decodes tile gain for the current rack size", () => {
  const rack = new Map<string, number>([["A", CONFIG.count.increment]]);

  assert.equal(tileGainForRackTile(rack, "Y"), 5);
  assert.equal(tileGainForRackTile(rack, "Q"), CONFIG.count.none);
});

test("live table loader falls back cleanly for racks beyond generated tables", () => {
  const rack = new Map<string, number>(
    CONFIG.precompute.letters
      .slice(CONFIG.count.none, CONFIG.precompute.maxRackLetters)
      .map((letter) => [letter, CONFIG.count.increment]),
  );

  assert.equal(tileGainForRackTile(rack, "Z"), CONFIG.count.none);
});

import assert from "node:assert/strict";
import test from "node:test";

import { CONFIG } from "./config.js";
import {
  buildPrecomputeTables,
  countsForWord,
  serializePrecomputedRack,
} from "./precompute_tables.js";

const tinyDictionary = ["AT", "AX", "TAX", "TEA", "EAT"];
const tinyBag = {
  A: 1,
  E: 1,
  Q: 1,
  T: 1,
  V: 1,
  X: 1,
};
const tinyLetters = ["A", "E", "Q", "T", "V", "X"];

test("precompute tables rank letters, best words, and tile gains from dictionary scores", () => {
  const tables = buildPrecomputeTables(tinyDictionary, {
    verbose: false,
    logger: () => undefined,
    maxRackLetters: 3,
    bagLimits: tinyBag,
    letters: tinyLetters,
  });

  assert.equal(tables.letterPrior.T > CONFIG.count.none, true);

  const atRack = serializePrecomputedRack(countsForWord("AT"));
  assert.deepEqual(tables.bestWord[atRack], {
    word: "AT",
    score: CONFIG.bidding.letterValues.A + CONFIG.bidding.letterValues.T,
  });

  const aRack = serializePrecomputedRack(countsForWord("A"));
  assert.equal(tables.tileGain[aRack].T, tables.bestWord[atRack].score);

  const axRack = serializePrecomputedRack(countsForWord("AX"));
  assert.equal(tables.bestWord[axRack].word, "AX");
});

test("precompute tables include ugly legal racks that are not dictionary-derived", () => {
  const tables = buildPrecomputeTables(["AT"], {
    verbose: false,
    logger: () => undefined,
    maxRackLetters: 2,
    bagLimits: tinyBag,
    letters: tinyLetters,
  });

  const uglyLegalRack = serializePrecomputedRack(countsForWord("QV"));

  assert.equal(tables.bestWord[uglyLegalRack], undefined);
  assert.deepEqual(tables.tileGain[uglyLegalRack], {
    A: 0,
    E: 0,
    Q: 0,
    T: 0,
    V: 0,
    X: 0,
  });
});

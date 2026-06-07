import assert from "node:assert/strict";
import test from "node:test";

import { chooseWord } from "./strategy.js";

test("word chooser prefers highest score over longest spelling", () => {
  const rack = new Map<string, number>([
    ["A", 7],
    ["I", 1],
    ["Q", 1],
    ["U", 1],
    ["Z", 1],
  ]);

  assert.equal(
    chooseWord({
      myRack: rack,
      dictionary: ["AAAAAAA", "QUIZ"],
    }),
    "QUIZ",
  );
});

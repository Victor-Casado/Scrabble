// Edit this file to implement your bidding and word-forming strategy.

import { CONFIG } from "./config.js";
import { decidePhaseBid } from "./phase_strategy.js";
import { scoreWord } from "./word_scoring.js";

// Standard Scrabble letter values — useful for valuation.
export const LETTER_VALUE: Record<string, number> = CONFIG.bidding.letterValues;

export interface BidContext {
  letter: string;        // Letter being auctioned, e.g. "Q"
  myBalance: number;     // Current balance
  myRack: Map<string, number>; // Letters you currently own, letter -> count
  round: number;
  dictionary: readonly string[];
  useNoBidFloor?: boolean;
  auctionType?: "FirstPrice" | "Vickrey";
}

/**
 * Decide how much to bid for `letter`. Return 0 to skip.
 * Default: bid the letter's face value plus a small premium if you don't have one yet.
 */
export function decideBid(ctx: BidContext): number {
  return decidePhaseBid(ctx);
}

export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[]; // Sorted uppercase list, shared at startup
}

/**
 * Try to form a word using letters from `myRack`.
 * Return the word (uppercase) to play, or null to skip.
 *
 * Default strategy: find the highest-scoring playable word in the dictionary.
 */
export function chooseWord(ctx: WordContext): string | null {
  // Tally rack.
  const have: Record<string, number> = {};
  for (const [letter, count] of ctx.myRack.entries()) have[letter] = count;

  // Find the most valuable word we can spell.
  let best: string | null = null;
  let bestScore: number = CONFIG.count.none;
  for (const word of ctx.dictionary) {
    const score = scoreWord(word);
    if (best !== null && score < bestScore) continue;
    if (best !== null && score === bestScore && word.length <= best.length) continue;
    const need: Record<string, number> = {};
    for (const c of word) {
      need[c] = (need[c] ?? CONFIG.count.none) + CONFIG.count.increment;
    }
    let ok = true;
    for (const [c, n] of Object.entries(need)) {
      if ((have[c] ?? CONFIG.count.none) < n) {
        ok = false;
        break;
      }
    }
    if (ok) {
      best = word;
      bestScore = score;
    }
  }
  return best;
}

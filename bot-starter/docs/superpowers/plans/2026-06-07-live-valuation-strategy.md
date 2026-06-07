# Live Valuation Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the live bot toward 10 consecutive >=100-point wins by connecting the existing precomputed/tunable model to live bidding and reducing auction timing misses.

**Architecture:** Keep `strategy.ts` as the public bot strategy API. Add a focused precomputed table loader used by `phase_strategy.ts`, and trigger `tryBid` from both auction inserts and match-state current-auction changes. The model remains valuation-based: rack marginal gain, letter priors, phase pressure, bankroll, and auction type shading.

**Tech Stack:** TypeScript, Node test runner, SpacetimeDB TypeScript SDK, precomputed JSON tables.

---

### Task 1: Precomputed Live Tables

**Files:**
- Create: `src/live_tables.ts`
- Test: `src/live_tables.test.ts`
- Modify: `package.json`

- [ ] Write tests for loading `letter_prior.json` and reading tile gains by serialized rack key.
- [ ] Run `npx tsx --test src/live_tables.test.ts` and verify it fails because `src/live_tables.ts` does not exist.
- [ ] Implement `letterPriorForTile(letter)` and `tileGainForRackTile(rack, letter)` with lazy size-based JSON loading.
- [ ] Run `npx tsx --test src/live_tables.test.ts` and verify it passes.
- [ ] Add `src/live_tables.test.ts` to `npm test`.

### Task 2: Valuation-Based Phase Strategy

**Files:**
- Modify: `src/config.ts`
- Modify: `src/phase_strategy.ts`
- Modify: `src/phase_strategy.test.ts`

- [ ] Add failing tests that empty-rack early bids use precomputed priors, Q remains avoided without synergy, and U is valued when Q is already on rack.
- [ ] Run `npx tsx --test src/phase_strategy.test.ts` and verify the new tests fail on the existing dictionary-scan strategy.
- [ ] Implement live valuation using precomputed rack gain plus letter prior fallback, phase weights, Q/U/S synergy, Vickrey/private-value bidding, first-price shading config, and bankroll caps.
- [ ] Run `npx tsx --test src/phase_strategy.test.ts` and verify it passes.

### Task 3: Current-Auction Bid Trigger

**Files:**
- Modify: `src/index.ts`
- Modify: `src/index_policy.test.ts`

- [ ] Add failing policy tests that `match_state.onInsert` and `match_state.onUpdate` call a shared current-auction bidding helper.
- [ ] Run `npx tsx --test src/index_policy.test.ts` and verify the new tests fail.
- [ ] Implement `tryBidCurrentAuction(conn, matchId, reason)` and call it from bootstrap, auction insert, match insert, and match update paths.
- [ ] Run `npx tsx --test src/index_policy.test.ts` and verify it passes.

### Task 4: Verification And Live Run

**Files:**
- Modify only if tests reveal a bug.

- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Confirm no local bot is running.
- [ ] Start exactly one bot with the current token/name and capture logs in a new `.codex-tmp/maincloud-*` folder.
- [ ] Query `match_participant`, `auction_result`, and logs for the match, then report whether bid expiry, bid strength, or word cash-in is the next blocker.

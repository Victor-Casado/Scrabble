# Baseline Tournament Strategy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the no-opponent-specific tournament baseline: keep the current phase strategy as the default, add a generic early vowel punishment, and wire stage/player-count context cleanly without name-based overrides.

**Architecture:** The base policy remains `decidePhaseBid`; no Thinker learner, Professor policy switch, or opponent-name configuration is added. The only behavior change is inside `phase_strategy.ts`: early beginning-phase vowel bids are discounted when the rack is already vowel-heavy and the candidate vowel has low immediate rack EV, including the Vickrey baseline floor. `playerCount` is passed through as explicit stage context for later generic stage logic, but this plan does not add opponent-specific behavior.

**Tech Stack:** TypeScript, Node test runner, existing `CONFIG` object, existing live precomputed tables and word scoring helpers.

---

## File Structure

- Modify: `bot-starter/src/config.ts`
  - Add vowel penalty knobs under `CONFIG.live.valuation`.
- Modify: `bot-starter/src/phase_strategy.ts`
  - Add `playerCount` to `PhaseBidContext`.
  - Add early vowel penalty helpers.
  - Apply penalty to computed value and Vickrey baseline only in beginning phase.
  - Expose penalty fields in `PhaseBidExplanation` for testability.
- Modify: `bot-starter/src/strategy.ts`
  - Ensure `BidContext.playerCount` is passed structurally into `decidePhaseBid`.
  - No opponent-name config, no Thinker/Professor default change.
- Modify: `bot-starter/src/index.ts`
  - Keep existing player-count collection and pass it into `BidContext` if not already present in the local checkout.
- Modify: `bot-starter/src/phase_strategy.test.ts`
  - Add tests for early vowel punishment and non-regression cases.

---

### Task 1: Add Config Knobs

**Files:**
- Modify: `bot-starter/src/config.ts`

- [ ] **Step 1: Add valuation fields**

In `CONFIG.live.valuation`, after `firstPriceShade: 0.7,`, add:

```ts
      earlyVowelPenaltyMaxRound: 25,
      earlyVowelPenaltyMinRackVowels: 2,
      earlyVowelPenaltyLowGainThreshold: 8,
      earlyVowelPenaltyPerExtraVowel: 0.25,
      earlyVowelPenaltyMax: 0.5,
```

Meaning:
- `earlyVowelPenaltyMaxRound`: only beginning phase should be affected.
- `earlyVowelPenaltyMinRackVowels`: if we already hold 2 AEIOU tiles, the next low-EV vowel is suspect.
- `earlyVowelPenaltyLowGainThreshold`: do not punish a vowel that materially improves best word EV.
- `earlyVowelPenaltyPerExtraVowel`: discount grows with excess vowel count after taking the tile.
- `earlyVowelPenaltyMax`: cap the discount so we still bid for genuinely useful vowels via EV floor.

- [ ] **Step 2: Do not add opponent config**

Verify no new block like this is introduced:

```ts
opponents: {
  vincebot: {},
  wordbeater: {},
}
```

The baseline should stay generic until opponent analysis is supplied.

---

### Task 2: Write Failing Tests

**Files:**
- Modify: `bot-starter/src/phase_strategy.test.ts`

- [ ] **Step 1: Add a vowel-heavy rack fixture**

Near the existing rack constants, add:

```ts
const vowelHeavyRack = new Map<string, number>([
  ["A", CONFIG.count.increment],
  ["E", CONFIG.count.increment],
  ["I", CONFIG.count.increment],
]);
```

- [ ] **Step 2: Add test for low-EV early vowel discount**

Add this test after `live Vickrey bids apply enough pressure to avoid dead bankroll`:

```ts
test("beginning Vickrey low-EV vowels are punished on vowel-heavy racks", () => {
  const neutralRack = new Map<string, number>([
    ["B", CONFIG.count.increment],
    ["C", CONFIG.count.increment],
    ["D", CONFIG.count.increment],
  ]);
  const neutral = explainPhaseBid({
    letter: "O",
    myBalance: CONFIG.live.testBalance,
    myRack: neutralRack,
    round: CONFIG.count.increment,
    dictionary: ["BCD"],
    useNoBidFloor: true,
    auctionType: "Vickrey",
  });
  const vowelHeavy = explainPhaseBid({
    letter: "O",
    myBalance: CONFIG.live.testBalance,
    myRack: vowelHeavyRack,
    round: CONFIG.count.increment,
    dictionary: ["AEI"],
    useNoBidFloor: true,
    auctionType: "Vickrey",
  });

  assert.equal(neutral.earlyVowelPenalty, CONFIG.count.none);
  assert.ok(vowelHeavy.earlyVowelPenalty > CONFIG.count.none);
  assert.ok(vowelHeavy.baselineBid < neutral.baselineBid);
  assert.ok(vowelHeavy.bid < neutral.bid);
});
```

- [ ] **Step 3: Add test that useful vowels are not punished**

Add this test immediately after the previous one:

```ts
test("beginning vowels that improve best-word EV are not punished", () => {
  const explanation = explainPhaseBid({
    letter: "U",
    myBalance: CONFIG.live.testBalance,
    myRack: new Map<string, number>([
      ["Q", CONFIG.count.increment],
      ["A", CONFIG.count.increment],
      ["E", CONFIG.count.increment],
    ]),
    round: CONFIG.count.increment,
    dictionary: ["QU"],
    useNoBidFloor: true,
    auctionType: "Vickrey",
  });

  assert.equal(explanation.earlyVowelPenalty, CONFIG.count.none);
  assert.ok(explanation.rackFitValue >= CONFIG.live.valuation.qUSynergyValue);
  assert.ok(explanation.bid >= CONFIG.live.valuation.qUSynergyValue);
});
```

- [ ] **Step 4: Add test that middle phase is unchanged**

Add this test immediately after the useful-vowel test:

```ts
test("middle phase does not apply early vowel punishment", () => {
  const explanation = explainPhaseBid({
    letter: "O",
    myBalance: CONFIG.live.testBalance,
    myRack: vowelHeavyRack,
    round: CONFIG.live.phases.beginning.maxRound + CONFIG.count.increment,
    dictionary: ["AEI"],
    useNoBidFloor: true,
    auctionType: "Vickrey",
  });

  assert.equal(explanation.earlyVowelPenalty, CONFIG.count.none);
  assert.equal(explanation.valueMultiplier, CONFIG.count.increment);
});
```

- [ ] **Step 5: Run tests and confirm failure**

Run:

```powershell
npm --prefix bot-starter test -- phase_strategy
```

Expected: TypeScript/test failure because `earlyVowelPenalty` and `valueMultiplier` are not on `PhaseBidExplanation` yet.

---

### Task 3: Implement Early Vowel Punishment

**Files:**
- Modify: `bot-starter/src/phase_strategy.ts`

- [ ] **Step 1: Extend context and explanation types**

Update `PhaseBidContext`:

```ts
export interface PhaseBidContext {
  letter: string;
  myBalance: number;
  myRack: Map<string, number>;
  round: number;
  bagTotal?: number;
  dictionary: readonly string[];
  useNoBidFloor?: boolean;
  auctionType?: "FirstPrice" | "Vickrey";
  playerCount?: number;
}
```

Update `PhaseBidExplanation` by adding these fields after `rackFitValue: number;`:

```ts
  earlyVowelPenalty: number;
  valueMultiplier: number;
```

- [ ] **Step 2: Add helper functions**

After `rackSize`, add:

```ts
function isStrictVowel(letter: string): boolean {
  return "AEIOU".includes(letter);
}

function vowelCount(rack: Map<string, number>): number {
  let total = CONFIG.count.none;
  for (const vowel of ["A", "E", "I", "O", "U"]) {
    total += rack.get(vowel) ?? CONFIG.count.none;
  }
  return total;
}
```

Add this helper after `adjustedRackGain`:

```ts
function earlyVowelPenalty(
  ctx: PhaseBidContext,
  phase: LivePhase,
  rackFitValue: number,
): number {
  const config = CONFIG.live.valuation;
  if (phase !== CONFIG.live.phaseNames.beginning) return CONFIG.count.none;
  if (ctx.round > config.earlyVowelPenaltyMaxRound) return CONFIG.count.none;
  if (!isStrictVowel(ctx.letter)) return CONFIG.count.none;
  if (rackFitValue >= config.earlyVowelPenaltyLowGainThreshold) {
    return CONFIG.count.none;
  }

  const nextVowels = vowelCount(ctx.myRack) + CONFIG.count.increment;
  const extraVowels = Math.max(
    CONFIG.count.none,
    nextVowels - config.earlyVowelPenaltyMinRackVowels,
  );
  if (extraVowels <= CONFIG.count.none) return CONFIG.count.none;

  return Math.min(
    config.earlyVowelPenaltyMax,
    extraVowels * config.earlyVowelPenaltyPerExtraVowel,
  );
}
```

- [ ] **Step 3: Apply multiplier to value**

In `explainPhaseBid`, after `const rackFitValue = adjustedRackGain(ctx, evDiff);`, add:

```ts
  const earlyPenalty = earlyVowelPenalty(ctx, phase, rackFitValue);
  const valueMultiplier = CONFIG.count.increment - earlyPenalty;
```

Then change:

```ts
  let value =
    usualLetterValue * weights.usualLetterWeight +
    rackFitValue * weights.rackFitWeight;
```

to:

```ts
  let value =
    (usualLetterValue * weights.usualLetterWeight +
      rackFitValue * weights.rackFitWeight) *
    valueMultiplier;
```

- [ ] **Step 4: Discount Vickrey baseline floor**

Change the signature of `vickreyBaselineBid`:

```ts
function vickreyBaselineBid(
  ctx: PhaseBidContext,
  cap: number,
  bareQAvoided: boolean,
  pressureMultiplier: number,
  valueMultiplier: number,
): number {
```

Change the pressured baseline calculation:

```ts
  const pressuredBaseline = Math.max(
    CONFIG.count.increment,
    Math.round(
      CONFIG.live.valuation.vickreyBaselineBid *
        pressureMultiplier *
        valueMultiplier,
    ),
  );
```

Update the call site:

```ts
  const baselineBid = vickreyBaselineBid(
    ctx,
    cap,
    bareQAvoided,
    pressureMultiplier,
    valueMultiplier,
  );
```

- [ ] **Step 5: Return explanation fields in every return path**

In all three `return { ... }` blocks inside `explainPhaseBid`, add:

```ts
        earlyVowelPenalty: earlyPenalty,
        valueMultiplier,
```

or, for the final normal return:

```ts
    earlyVowelPenalty: earlyPenalty,
    valueMultiplier,
```

These fields should appear after `rackFitValue`.

- [ ] **Step 6: Run focused tests**

Run:

```powershell
npm --prefix bot-starter test -- phase_strategy
```

Expected: all `phase_strategy` tests pass. If the existing test `Vickrey uses ten as the baseline bet for non-Q letters` fails for `V`, the penalty leaked to consonants; fix `isStrictVowel`.

---

### Task 4: Keep Strategy Generic

**Files:**
- Modify: `bot-starter/src/strategy.ts`
- Modify: `bot-starter/src/index.ts`

- [ ] **Step 1: Keep default policy unchanged**

Ensure `decideBid` still reads:

```ts
export function decideBid(ctx: BidContext): number {
  if (CONFIG.bot.name === CONFIG.professor.enabledBotName) {
    return decideProfessorBid(ctx);
  }
  return decidePhaseBid(ctx);
}
```

Do not add name checks such as:

```ts
if (ctx.opponentNames?.includes("VinceBot")) {
  return decideVinceBotCounterBid(ctx);
}
```

- [ ] **Step 2: Preserve player-count pass-through**

Ensure `BidContext` contains:

```ts
  playerCount?: number;
```

Ensure the bid creation site in `bot-starter/src/index.ts` passes `playerCount` into `bidContext`:

```ts
      const bidContext: BidContext = {
        letter,
        myBalance: balance,
        myRack: rack,
        round,
        bagTotal,
        dictionary,
        useNoBidFloor,
        auctionType,
        playerCount: participantCountForMatch(conn, matchId),
      };
```

If the exact local variable names differ, keep the same effect: `playerCount` must be the count of active `match_participant` rows for the current match.

---

### Task 5: Verify Full Bot Tests

**Files:**
- No code edits.

- [ ] **Step 1: Run full test suite**

Run:

```powershell
npm --prefix bot-starter test
```

Expected: all bot-starter tests pass.

- [ ] **Step 2: Build TypeScript**

Run:

```powershell
npm --prefix bot-starter run build
```

Expected: TypeScript build succeeds with no type errors.

- [ ] **Step 3: Inspect diff**

Run:

```powershell
git diff -- bot-starter/src/config.ts bot-starter/src/phase_strategy.ts bot-starter/src/strategy.ts bot-starter/src/index.ts bot-starter/src/phase_strategy.test.ts
```

Expected:
- Config adds only generic early-vowel knobs.
- Strategy still defaults to `decidePhaseBid`.
- No opponent-name-specific policy.
- Tests cover vowel punishment and non-regressions.

---

## Self-Review

- Spec coverage: The plan implements a no-opponent-specific base, adds beginning-phase vowel punishment, keeps Professor/Thinker out of the default path, and preserves stage context through `playerCount`.
- Placeholder scan: No `TBD`, `TODO`, or undefined behavior remains.
- Type consistency: `earlyVowelPenalty` and `valueMultiplier` are introduced in `PhaseBidExplanation`, set before returns, and asserted from `explainPhaseBid`.

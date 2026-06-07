# Experiment Modeling Bot

This folder contains an experimental ScrabbleBot variant built on top of the
current `lisan` starter architecture. It does not modify `bot-starter/src`.

Run it with:

```bash
npx tsx experiment_modeling/index.ts
```

Provision the default live credential first with:

```bash
npx tsx experiment_modeling/provision.ts
```

The default experiment bot name is `the-thinker`. Use `BOT_TOKEN`, an existing
`.token-the-thinker` file, or `BOT_NONCE` exactly as the starter runner does. The
bot connects to `STDB_HOST` and `STDB_DB`, defaulting to the live SpacetimeDB
deployment used by the Vercel app.

## Architecture

- `index.ts` is the online runner. It mirrors the lisan flow: connect, subscribe,
  join lobbies, bid on open auctions, submit words, and rejoin after matches.
- `strategy.ts` wraps lisan's `explainPhaseBid`. When the residual learner is
  enabled, the final bid is `lisanBid + learnedResidual`, clamped to balance.
  Learned residuals are bounded to `-4, -2, 0, +2, +5, +8`, and the initial
  residual is always `0`, so a fresh model starts by playing like lisan.
- `residualLearner.ts` is a tabular online learner. It buckets each bid by phase,
  letter, rack shape, balance, opponent pressure, and auction type, then learns
  which bounded residual worked best from match-end rewards.
- `opponentModel.ts` owns public observations and keeps one model per bot.
- `rackInference.ts` tracks inferred opponent racks from public auction wins and
  word plays.
- `classification.ts`, `bidPrediction.ts`, and `letterValue.ts` are deterministic
  heuristics. There is no ML and no external dependency.
- `persistentState.ts` saves opponent models and the residual matrix to disk under
  `.codex-tmp/<BOT_NAME>/modeling-state.json`.
- `telemetry.ts` emits structured `[MODEL]`, `[PHASE]`, `[PREDICTION]`, and
  `[BID]` lines.

## Assumptions

The model uses only public information:

- auction winners
- revealed letters
- paid auction prices
- played words
- score and balance changes visible through public tables

It never reads hidden opponent racks. Inferred racks are approximations assembled
from public auction result and word play events.

Tournament phase is inferred from the current match participant count:

- more than 4 players: `learn`
- 3 or 4 players: `exploit`
- 2 players: `duel`

## Limitations

Bid estimates are rough because sealed bids are not fully visible. In Vickrey
auctions, the observed payment is only a proxy for opponent willingness to pay.
The inferred rack can drift if events are missed or if a player acquired letters
before this process started. The phase detector uses match size as the available
runtime signal for tournament narrowing.

The residual learner has delayed, noisy rewards: it updates bid residuals after a
match ends, using final score differential as the reward signal. This keeps the
bot safe and close to lisan, but learning requires many matches.

## Future Improvements

- Use `visible_auction_top_bids` when available to improve price estimates.
- Persist opponent models between process restarts.
- Add better credit assignment for individual tiles and bid decisions.
- Add separate first-price and Vickrey exploitation profiles.
- Feed model summaries into offline simulations before using them live.

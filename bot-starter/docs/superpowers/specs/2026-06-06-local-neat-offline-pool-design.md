# Local NEAT Offline Pool Design

## Goal

Update the local NEAT tuner so it trains and evaluates fully offline against a broad pool of strategy profiles, including the repo's live strategy and peer genetic candidates from the same generation.

## Scope

- Keep the tuner fully local. It must not connect to SpacetimeDB or any remote host.
- Keep evaluation deterministic from the configured seed.
- Keep worker-based evaluation parallelizable.
- Make the CLI much more verbose, with one detailed status block per generation.
- Save the best config and stats from every generation into a configured output directory.
- Continue supporting `grid`, `evolve`, and `compare` modes.

## Architecture

`src/neat.ts` will move from a config-only player model to a small offline player strategy union. Each simulated player will expose bidding behavior through the existing auction simulation while sharing the same rack, cash-in, and final-dump mechanics. The candidate under test remains player zero.

The offline opponent pool will contain:

- the current tunable default config strategy
- an adapter for the repo's live phase strategy from `strategy.ts`
- at least six fixed generated profile strategies with different bidding styles
- sampled peer candidates from the current generation during evolution

`CONFIG.neat` will own all constants, profile values, pool sizing, verbosity labels, and generation-output paths so the existing numeric-literal policy still passes.

## Data Flow

For each generation:

1. Build deterministic bags from `seed + generation`.
2. Build an opponent roster pool from fixed profiles, the repo live strategy, and sampled peer configs.
3. Create one evaluation job per candidate.
4. Split jobs across worker threads.
5. Score candidates by average score, rank, and win rate.
6. Print one detailed generation block with worker/job counts, best stats, top candidates, and best config.
7. Save the generation winner to `<generationDir>/generation-XXXX.json`.
8. Create the next population from elites plus crossover/mutation.

## Generation Files

Each generation file will contain:

- timestamp
- generation number and generation count
- seed, matches, player count, auction type, opponent profile, worker count
- fixed opponent count and peer opponent count
- best result with fitness, average score, average rank, win rate, id, and config
- top results for that generation

`saveBest` remains for the final winning config, while generation snapshots are additive.

## Error Handling

- Invalid compare inputs still throw a clear error.
- Worker failures reject the run.
- Empty result sets throw.
- Generation snapshot directories are created recursively.

## Testing

Add focused tests for:

- offline opponent pool includes repo live strategy plus at least six generated fixed profiles
- self-play opponent sampling includes peer genetic configs without including the candidate itself
- evolution writes generation snapshot JSON with stats and config
- verbose generation output emits one generation header/block per generation
- existing import-safety, config-policy, auction, and final-auction tests still pass

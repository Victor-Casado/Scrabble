# Local NEAT Offline Pool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local NEAT tuner evaluate candidates against fixed offline profiles, the repo live strategy, and peer genetic candidates, while printing and saving detailed per-generation stats.

**Architecture:** Extend the simulator player type from config-only to an offline strategy union. Keep constants and profile data in `CONFIG.neat`, keep workers deterministic, and write one generation snapshot JSON per generation.

**Tech Stack:** TypeScript, Node worker_threads, node:test, existing local simulator in `src/neat.ts`.

---

### Task 1: Offline Opponent Pool Tests

**Files:**
- Modify: `src/neat_policy.test.ts`
- Modify: `src/neat.ts`
- Modify: `src/config.ts`

- [ ] **Step 1: Write failing tests**

Add tests that import `fixedOpponentRosterForTest`, `peerOpponentRosterForTest`, and `runEvolutionForTest`.

- [ ] **Step 2: Run tests to verify red**

Run: `npm test`

Expected: FAIL because exported test helpers do not exist.

- [ ] **Step 3: Implement minimal strategy union and opponent roster helpers**

Add config, profile, and live strategy players. Add fixed roster and peer roster helpers.

- [ ] **Step 4: Run tests to verify green**

Run: `npm test`

Expected: PASS for roster tests and existing tests.

### Task 2: Generation Snapshot and Verbose Output

**Files:**
- Modify: `src/neat_policy.test.ts`
- Modify: `src/neat.ts`
- Modify: `src/config.ts`

- [ ] **Step 1: Write failing tests**

Assert that a one-generation test evolution writes `generation-0001.json` with stats and emits one `Generation 1/1` block.

- [ ] **Step 2: Run tests to verify red**

Run: `npm test`

Expected: FAIL because snapshots and verbose generation blocks are absent.

- [ ] **Step 3: Implement generation snapshot writing and verbose block logging**

Add configured generation directory default, JSON payload builder, and a generation logger.

- [ ] **Step 4: Run tests to verify green**

Run: `npm test`

Expected: PASS.

### Task 3: Full Verification

**Files:**
- All touched files.

- [ ] **Step 1: Run full tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Run TypeScript build**

Run: `npm run build`

Expected: build succeeds.

- [ ] **Step 3: Run a tiny local tune smoke test**

Run: `npm run neat -- --generations 1 --population 4 --matches 2 --workers 2 --generation-dir .codex-tmp/neat-generations --out .codex-tmp/tuned-config.json`

Expected: one verbose generation block, a final config, and one generation snapshot.

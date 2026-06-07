from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import random
import time
from collections import Counter
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from experiments.exploit_lisan import (
    DEFAULT_BAG,
    Policy,
    PlayerState,
    best_play_for_key,
    build_bag,
    maybe_play,
    play_game,
    rack_key,
    remove_word,
    run_series,
)
from experiments.live_lisan import LiveLisan, live_rack_key


TableEntry = dict[str, float | int]
McmcTable = dict[str, TableEntry]


def bucket(value: int, cuts: tuple[int, ...]) -> int:
    for index, cut in enumerate(cuts):
        if value <= cut:
            return index
    return len(cuts)


def turn_bucket(round_index: int) -> str:
    return f"t{bucket(round_index, (10, 20, 35, 50, 65, 80))}"


def balance_bucket(balance: int) -> str:
    return f"b{bucket(balance, (10, 25, 45, 70, 100))}"


def opponent_balance_bucket(balance: int) -> str:
    return f"ob{bucket(balance, (10, 25, 45, 70, 100))}"


def score_gap_bucket(own_score: int, opponent_score: int) -> str:
    gap = own_score - opponent_score
    if gap <= -50:
        return "sg-3"
    if gap <= -20:
        return "sg-2"
    if gap <= -6:
        return "sg-1"
    if gap < 6:
        return "sg0"
    if gap < 20:
        return "sg1"
    if gap < 50:
        return "sg2"
    return "sg3"


def state_key(
    letter: str,
    round_index: int,
    auctions_left: int,
    own: PlayerState,
    opponent: PlayerState,
    mode: str = "exact",
) -> str:
    if mode == "abstract":
        return abstract_state_key(letter, round_index, auctions_left, own, opponent)
    if mode == "coarse":
        return coarse_state_key(letter, round_index, auctions_left, own, opponent)
    if mode == "livecommon":
        return live_common_state_key(letter, round_index, auctions_left, own, opponent)
    return "|".join(
        (
            live_rack_key(own.rack),
            letter,
            turn_bucket(round_index),
            balance_bucket(own.balance),
            opponent_balance_bucket(opponent.balance),
            score_gap_bucket(own.score, opponent.score),
        )
    )


def abstract_state_key(
    letter: str,
    round_index: int,
    auctions_left: int,
    own: PlayerState,
    opponent: PlayerState,
) -> str:
    rack_size = sum(own.rack.values())
    vowels = sum(own.rack.get(letter, 0) for letter in "AEIOU")
    power = sum(own.rack.get(letter, 0) for letter in "JKQXZ")
    best_reward = best_play_for_key(rack_key(own.rack))[1]
    return "|".join(
        (
            f"rs{bucket(rack_size, (5, 7, 9, 12, 16))}",
            f"vw{bucket(vowels, (1, 2, 3, 5))}",
            f"pw{bucket(power, (0, 1, 2))}",
            f"br{bucket(best_reward, (0, 12, 24, 32, 45))}",
            f"q{int(own.rack.get('Q', 0) > 0)}u{int(own.rack.get('U', 0) > 0)}",
            letter,
            turn_bucket(round_index),
            balance_bucket(own.balance),
            opponent_balance_bucket(opponent.balance),
            score_gap_bucket(own.score, opponent.score),
        )
    )


def coarse_state_key(
    letter: str,
    round_index: int,
    auctions_left: int,
    own: PlayerState,
    opponent: PlayerState,
) -> str:
    rack_size = sum(own.rack.values())
    vowels = sum(own.rack.get(letter, 0) for letter in "AEIOU")
    best_reward = best_play_for_key(rack_key(own.rack))[1]
    return "|".join(
        (
            f"rs{bucket(rack_size, (6, 9, 13))}",
            f"vw{bucket(vowels, (1, 3))}",
            f"br{bucket(best_reward, (0, 24, 36))}",
            letter,
            turn_bucket(round_index),
            balance_bucket(own.balance),
            score_gap_bucket(own.score, opponent.score),
        )
    )


def live_common_state_key(
    letter: str,
    round_index: int,
    auctions_left: int,
    own: PlayerState,
    opponent: PlayerState,
) -> str:
    rack_size = sum(own.rack.values())
    vowels = sum(own.rack.get(letter, 0) for letter in "AEIOU")
    best_reward = best_play_for_key(rack_key(own.rack))[1]
    phase = "p0" if round_index <= 25 else "p1" if round_index <= 60 else "p2"
    return "|".join(
        (
            letter,
            phase,
            f"rs{bucket(rack_size, (6, 10, 15))}",
            f"vw{bucket(vowels, (1, 3))}",
            f"br{bucket(best_reward, (0, 24, 36))}",
            balance_bucket(own.balance),
        )
    )


@dataclass
class Snapshot:
    letter: str
    round_index: int
    bag: tuple[str, ...]
    live: PlayerState
    opponent: PlayerState


def clone_player(player: PlayerState) -> PlayerState:
    return PlayerState(
        name=player.name,
        balance=player.balance,
        score=player.score,
        rack=Counter(player.rack),
    )


def candidate_bids(live_bid: int, balance: int) -> list[int]:
    raw = {
        0,
        1,
        live_bid,
        live_bid - 5,
        live_bid - 1,
        live_bid + 1,
        live_bid + 5,
        int(balance * 0.2),
        int(balance * 0.35),
        int(balance * 0.55),
        balance,
    }
    return sorted({max(0, min(balance, bid)) for bid in raw})


def resolve_vickrey(
    letter: str,
    live_bid: int,
    opponent_bid: int,
    live: PlayerState,
    opponent: PlayerState,
    rng: random.Random,
) -> None:
    if live_bid <= 0 and opponent_bid <= 0:
        return
    live_wins = live_bid > opponent_bid or (
        live_bid == opponent_bid and rng.random() < 0.5
    )
    if live_wins:
        paid = opponent_bid if opponent_bid > 0 else min(1, live_bid)
        if live.balance >= paid:
            live.balance -= paid
            live.rack[letter] += 1
    else:
        paid = live_bid if live_bid > 0 else min(1, opponent_bid)
        if opponent.balance >= paid:
            opponent.balance -= paid
            opponent.rack[letter] += 1


def finish_rollout(
    snapshot: Snapshot,
    forced_live_bid: int,
    live_policy: Policy,
    opponent_policy: Policy,
    seed: int,
) -> float:
    rng = random.Random(seed)
    bag = list(snapshot.bag)
    rng.shuffle(bag)
    live = clone_player(snapshot.live)
    opponent = clone_player(snapshot.opponent)
    auctions_left = len(bag)
    opponent_bid = opponent_policy.decide_bid(
        snapshot.letter,
        snapshot.round_index,
        auctions_left,
        opponent,
        live,
    )
    resolve_vickrey(
        snapshot.letter,
        max(0, min(live.balance, forced_live_bid)),
        max(0, min(opponent.balance, opponent_bid)),
        live,
        opponent,
        rng,
    )
    maybe_play(live_policy, live, opponent, snapshot.round_index, auctions_left)
    maybe_play(opponent_policy, opponent, live, snapshot.round_index, auctions_left)

    round_index = snapshot.round_index
    no_bid_requeues = 0
    while bag and round_index < 220:
        round_index += 1
        letter = bag.pop()
        auctions_left = len(bag)
        live_bid = live_policy.decide_bid(letter, round_index, auctions_left, live, opponent)
        opponent_bid = opponent_policy.decide_bid(
            letter, round_index, auctions_left, opponent, live
        )
        if live_bid <= 0 and opponent_bid <= 0:
            no_bid_requeues += 1
            if no_bid_requeues <= 26:
                bag.insert(0, letter)
                continue
        resolve_vickrey(
            letter,
            max(0, min(live.balance, live_bid)),
            max(0, min(opponent.balance, opponent_bid)),
            live,
            opponent,
            rng,
        )
        maybe_play(live_policy, live, opponent, round_index, auctions_left)
        maybe_play(opponent_policy, opponent, live, round_index, auctions_left)

    maybe_play(live_policy, live, opponent, round_index, 0)
    maybe_play(opponent_policy, opponent, live, round_index, 0)
    if live.score > opponent.score:
        return 1.0
    if live.score < opponent.score:
        return 0.0
    return 0.5


def collect_common_snapshots(
    target_states: int,
    seed: int,
    live_factory: Callable[[], Policy],
    opponent_factory: Callable[[], Policy],
    key_mode: str,
) -> list[Snapshot]:
    rng = random.Random(seed)
    snapshots: list[Snapshot] = []
    seen: set[str] = set()
    game_index = 0
    while len(snapshots) < target_states and game_index < target_states * 20:
        game_index += 1
        live_policy = live_factory()
        opponent_policy = opponent_factory()
        bag = build_bag(random.Random(seed + game_index * 97))
        live = PlayerState(live_policy.name)
        opponent = PlayerState(opponent_policy.name)
        for _ in range(5):
            live.rack[bag.pop()] += 1
            opponent.rack[bag.pop()] += 1
        maybe_play(live_policy, live, opponent, 0, len(bag))
        maybe_play(opponent_policy, opponent, live, 0, len(bag))
        round_index = 0
        while bag and len(snapshots) < target_states:
            round_index += 1
            letter = bag.pop()
            key = state_key(letter, round_index, len(bag), live, opponent, key_mode)
            if key not in seen and rng.random() < 0.7:
                seen.add(key)
                snapshots.append(
                    Snapshot(
                        letter=letter,
                        round_index=round_index,
                        bag=tuple(bag),
                        live=clone_player(live),
                        opponent=clone_player(opponent),
                    )
                )
            live_bid = live_policy.decide_bid(letter, round_index, len(bag), live, opponent)
            opponent_bid = opponent_policy.decide_bid(
                letter, round_index, len(bag), opponent, live
            )
            resolve_vickrey(letter, live_bid, opponent_bid, live, opponent, rng)
            maybe_play(live_policy, live, opponent, round_index, len(bag))
            maybe_play(opponent_policy, opponent, live, round_index, len(bag))
    return snapshots


def profile_opponent(profile: str, seed: int) -> Policy:
    from experiments.exploit_lisan import ExploitLisan, LisanSurrogate

    if profile == "live":
        return LiveLisan()
    if profile == "exploit":
        return ExploitLisan()
    choices = [LiveLisan, LisanSurrogate, ExploitLisan, LiveLisan]
    return choices[seed % len(choices)]()


def evaluate_snapshot(
    task: tuple[int, Snapshot, int, int, str, str],
) -> TableEntry:
    index, snapshot, rollouts, seed, key_mode, opponent_profile = task
    live_policy = LiveLisan()
    opponent_policy = profile_opponent(opponent_profile, seed + index)
    live_bid = live_policy.decide_bid(
        snapshot.letter,
        snapshot.round_index,
        len(snapshot.bag),
        snapshot.live,
        snapshot.opponent,
    )
    candidate_results: dict[int, list[float]] = {}
    for bid in candidate_bids(live_bid, snapshot.live.balance):
        samples: list[float] = []
        for rollout in range(rollouts):
            rollout_seed = seed + index * 7919 + rollout * 104729 + bid * 1009
            samples.append(
                finish_rollout(
                    snapshot,
                    bid,
                    LiveLisan(),
                    profile_opponent(opponent_profile, rollout_seed),
                    rollout_seed,
                )
            )
        candidate_results[bid] = samples

    def mean(samples: list[float]) -> float:
        return sum(samples) / len(samples)

    def variance(samples: list[float]) -> float:
        avg = mean(samples)
        return sum((sample - avg) ** 2 for sample in samples) / len(samples)

    best_bid = live_bid
    best_ev = -1.0
    for bid, samples in candidate_results.items():
        ev = mean(samples)
        if ev > best_ev or (ev == best_ev and abs(bid - live_bid) < abs(best_bid - live_bid)):
            best_ev = ev
            best_bid = bid
    live_samples = candidate_results.get(live_bid, [0.0])
    live_ev = mean(live_samples)
    return {
        "bid": int(best_bid),
        "live_bid": int(live_bid),
        "best_ev": round(best_ev, 4),
        "live_ev": round(live_ev, 4),
        "improvement": round(best_ev - live_ev, 4),
        "variance": round(variance(candidate_results[best_bid]), 4),
        "visits": int(rollouts),
    }


def build_mcmc_table(
    states: int,
    rollouts: int,
    seed: int,
    live_factory: Callable[[], Policy] = LiveLisan,
    opponent_factory: Callable[[], Policy] | None = None,
    key_mode: str = "abstract",
    workers: int = 1,
    opponent_profile: str = "mixed",
) -> McmcTable:
    if opponent_factory is None:
        opponent_factory = LiveLisan
    snapshots = collect_common_snapshots(
        states, seed, live_factory, opponent_factory, key_mode
    )
    tasks = [
        (index, snapshot, rollouts, seed, key_mode, opponent_profile)
        for index, snapshot in enumerate(snapshots)
    ]
    if workers <= 1:
        entries = [evaluate_snapshot(task) for task in tasks]
    else:
        with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as pool:
            entries = list(pool.map(evaluate_snapshot, tasks))

    table: McmcTable = {}
    for snapshot, entry in zip(snapshots, entries):
        key = state_key(
            snapshot.letter,
            snapshot.round_index,
            len(snapshot.bag),
            snapshot.live,
            snapshot.opponent,
            key_mode,
        )
        table[key] = entry
    return table


def write_table(table: McmcTable, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(table, indent=2, sort_keys=True), encoding="utf-8")


def load_table(path: Path) -> McmcTable:
    return json.loads(path.read_text(encoding="utf-8"))


class McmcTablePolicy(LiveLisan):
    name = "mcmc-table-lisan"

    def __init__(self, table: McmcTable, key_mode: str = "abstract"):
        super().__init__()
        self.table = table
        self.key_mode = key_mode
        self.hits = 0
        self.misses = 0

    def decide_bid(
        self,
        letter: str,
        round_index: int,
        auctions_left: int,
        own: PlayerState,
        opponent: PlayerState,
    ) -> int:
        key = state_key(letter, round_index, auctions_left, own, opponent, self.key_mode)
        entry = self.table.get(key)
        if entry is None:
            self.misses += 1
            return super().decide_bid(letter, round_index, auctions_left, own, opponent)
        self.hits += 1
        return max(0, min(own.balance, int(entry["bid"])))


def main() -> None:
    parser = argparse.ArgumentParser(description="Sparse precomputed MCMC table for live Lisan states.")
    parser.add_argument("--states", type=int, default=50)
    parser.add_argument("--rollouts", type=int, default=8)
    parser.add_argument("--seed", type=int, default=20260607)
    parser.add_argument("--out", type=Path, default=Path("experiments/precomputed/mcmc_lisan.json"))
    parser.add_argument("--benchmark-games", type=int, default=100)
    parser.add_argument(
        "--key-mode",
        choices=["abstract", "coarse", "livecommon", "exact"],
        default="abstract",
    )
    parser.add_argument("--workers", type=int, default=max(1, min(8, (os.cpu_count() or 2) - 1)))
    parser.add_argument("--opponent-profile", choices=["mixed", "live", "exploit"], default="mixed")
    args = parser.parse_args()

    started = time.perf_counter()
    table = build_mcmc_table(
        args.states,
        args.rollouts,
        args.seed,
        key_mode=args.key_mode,
        workers=args.workers,
        opponent_profile=args.opponent_profile,
    )
    elapsed = time.perf_counter() - started
    write_table(table, args.out)
    print(f"states: {len(table)}")
    print(f"rollouts_per_state: {args.rollouts}")
    print(f"workers: {args.workers}")
    print(f"opponent_profile: {args.opponent_profile}")
    print(f"seconds: {elapsed:.3f}")
    print(f"seconds_per_state: {elapsed / max(1, len(table)):.3f}")
    print(f"output: {args.out}")

    from experiments.exploit_lisan import ExploitLisan

    policies: list[McmcTablePolicy] = []

    def table_policy_factory() -> McmcTablePolicy:
        policy = McmcTablePolicy(table, key_mode=args.key_mode)
        policies.append(policy)
        return policy

    result = run_series(
        args.benchmark_games,
        args.seed + 1,
        table_policy_factory,
        ExploitLisan,
    )
    hits = sum(policy.hits for policy in policies)
    misses = sum(policy.misses for policy in policies)
    print("benchmark_vs_exploiter:")
    for key, value in result.items():
        print(f"  {key}: {value}")
    print(f"  table_hits: {hits}")
    print(f"  table_misses: {misses}")
    print(f"  table_hit_rate: {hits / max(1, hits + misses):.4f}")


if __name__ == "__main__":
    main()

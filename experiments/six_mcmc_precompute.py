from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import random
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

from experiments.exploit_lisan import ExploitLisan, Policy, PlayerState, build_bag, maybe_play
from experiments.live_lisan import LiveLisan
from experiments.mcmc_precompute import (
    McmcTable,
    candidate_bids,
    state_key,
)
from experiments.professor_model import (
    TheProfessor,
    representative_opponent,
    resolve_multiplayer_vickrey,
    run_multiplayer_series,
)


@dataclass
class SixSnapshot:
    letter: str
    round_index: int
    bag: tuple[str, ...]
    players: tuple[PlayerState, ...]


def placement_utility(rank: int, utility: str = "rank") -> float:
    if utility == "win":
        return 1.0 if rank == 1 else 0.0
    if utility == "top3":
        if rank == 1:
            return 1.0
        if rank <= 3:
            return 0.45
        return 0.0
    if utility == "rank":
        return {1: 1.0, 2: 0.78, 3: 0.58, 4: 0.28, 5: 0.12, 6: 0.0}.get(rank, 0.0)
    raise ValueError(f"unknown utility: {utility}")


def clone_player(player: PlayerState) -> PlayerState:
    return PlayerState(player.name, player.balance, player.score, Counter(player.rack))


def default_field() -> list[Policy]:
    return [LiveLisan(), LiveLisan(), ExploitLisan(), LiveLisan(), ExploitLisan()]


def collect_six_snapshots(states: int, seed: int, key_mode: str) -> list[SixSnapshot]:
    rng = random.Random(seed)
    snapshots: list[SixSnapshot] = []
    seen: set[str] = set()
    game = 0
    while len(snapshots) < states and game < states * 20:
        game += 1
        professor = LiveLisan()
        policies = [professor, *default_field()]
        players = [PlayerState(policy.name) for policy in policies]
        bag = build_bag(random.Random(seed + game * 1543))
        for _ in range(5):
            for player in players:
                player.rack[bag.pop()] += 1
        for index, policy in enumerate(policies):
            maybe_play(policy, players[index], representative_opponent(players, index), 0, len(bag))

        round_index = 0
        while bag and len(snapshots) < states:
            round_index += 1
            letter = bag.pop()
            opp = representative_opponent(players, 0)
            key = state_key(letter, round_index, len(bag), players[0], opp, key_mode)
            if key not in seen and rng.random() < 0.8:
                seen.add(key)
                snapshots.append(
                    SixSnapshot(
                        letter=letter,
                        round_index=round_index,
                        bag=tuple(bag),
                        players=tuple(clone_player(player) for player in players),
                    )
                )

            bids = []
            for index, policy in enumerate(policies):
                bid = policy.decide_bid(
                    letter,
                    round_index,
                    len(bag),
                    players[index],
                    representative_opponent(players, index),
                )
                bids.append(max(0, min(players[index].balance, bid)))
            resolve_multiplayer_vickrey(letter, bids, players, rng)
            for index, policy in enumerate(policies):
                maybe_play(
                    policy,
                    players[index],
                    representative_opponent(players, index),
                    round_index,
                    len(bag),
                )
    return snapshots


def finish_six_rollout(snapshot: SixSnapshot, forced_bid: int, seed: int, utility: str) -> float:
    rng = random.Random(seed)
    policies: list[Policy] = [LiveLisan(), *default_field()]
    players = [clone_player(player) for player in snapshot.players]
    bag = list(snapshot.bag)
    rng.shuffle(bag)

    first_bids = [max(0, min(players[0].balance, forced_bid))]
    for index, policy in enumerate(policies[1:], start=1):
        bid = policy.decide_bid(
            snapshot.letter,
            snapshot.round_index,
            len(bag),
            players[index],
            representative_opponent(players, index),
        )
        first_bids.append(max(0, min(players[index].balance, bid)))
    resolve_multiplayer_vickrey(snapshot.letter, first_bids, players, rng)
    for index, policy in enumerate(policies):
        maybe_play(
            policy,
            players[index],
            representative_opponent(players, index),
            snapshot.round_index,
            len(bag),
        )

    round_index = snapshot.round_index
    no_bid_requeues = 0
    while bag and round_index < 220:
        round_index += 1
        letter = bag.pop()
        bids = []
        for index, policy in enumerate(policies):
            bid = policy.decide_bid(
                letter,
                round_index,
                len(bag),
                players[index],
                representative_opponent(players, index),
            )
            bids.append(max(0, min(players[index].balance, bid)))
        if all(bid <= 0 for bid in bids):
            no_bid_requeues += 1
            if no_bid_requeues <= 26:
                bag.insert(0, letter)
                continue
        resolve_multiplayer_vickrey(letter, bids, players, rng)
        for index, policy in enumerate(policies):
            maybe_play(
                policy,
                players[index],
                representative_opponent(players, index),
                round_index,
                len(bag),
            )

    ranked = sorted(
        range(len(players)),
        key=lambda index: (players[index].score, players[index].balance),
        reverse=True,
    )
    rank = ranked.index(0) + 1
    return placement_utility(rank, utility)


def evaluate_snapshot(task: tuple[int, SixSnapshot, int, int, str, str]) -> tuple[str, dict[str, float | int]]:
    index, snapshot, rollouts, seed, key_mode, utility = task
    professor = LiveLisan()
    opp = representative_opponent(list(snapshot.players), 0)
    live_bid = professor.decide_bid(
        snapshot.letter,
        snapshot.round_index,
        len(snapshot.bag),
        snapshot.players[0],
        opp,
    )
    results: dict[int, list[float]] = {}
    for bid in candidate_bids(live_bid, snapshot.players[0].balance):
        samples = [
            finish_six_rollout(
                snapshot,
                bid,
                seed + index * 10007 + rollout * 1009 + bid * 37,
                utility,
            )
            for rollout in range(rollouts)
        ]
        results[bid] = samples

    def mean(samples: list[float]) -> float:
        return sum(samples) / len(samples)

    def variance(samples: list[float]) -> float:
        avg = mean(samples)
        return sum((sample - avg) ** 2 for sample in samples) / len(samples)

    best_bid = live_bid
    best_ev = -1.0
    for bid, samples in results.items():
        ev = mean(samples)
        if ev > best_ev or (ev == best_ev and abs(bid - live_bid) < abs(best_bid - live_bid)):
            best_ev = ev
            best_bid = bid
    live_ev = mean(results.get(live_bid, [0.0]))
    key = state_key(
        snapshot.letter,
        snapshot.round_index,
        len(snapshot.bag),
        snapshot.players[0],
        opp,
        key_mode,
    )
    return key, {
        "bid": int(best_bid),
        "live_bid": int(live_bid),
        "best_ev": round(best_ev, 4),
        "live_ev": round(live_ev, 4),
        "improvement": round(best_ev - live_ev, 4),
        "variance": round(variance(results[best_bid]), 4),
        "visits": int(rollouts),
    }


def build_six_mcmc_table(
    states: int,
    rollouts: int,
    seed: int,
    key_mode: str = "livecommon",
    workers: int = 1,
    utility: str = "rank",
) -> McmcTable:
    snapshots = collect_six_snapshots(states, seed, key_mode)
    tasks = [
        (index, snapshot, rollouts, seed, key_mode, utility)
        for index, snapshot in enumerate(snapshots)
    ]
    if workers <= 1:
        rows = [evaluate_snapshot(task) for task in tasks]
    else:
        with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as pool:
            rows = list(pool.map(evaluate_snapshot, tasks))
    return dict(rows)


def write_table(table: McmcTable, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(table, indent=2, sort_keys=True), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Six-player MCMC table for the-professor.")
    parser.add_argument("--states", type=int, default=800)
    parser.add_argument("--rollouts", type=int, default=20)
    parser.add_argument("--seed", type=int, default=20260607)
    parser.add_argument("--workers", type=int, default=max(1, min(16, (os.cpu_count() or 2) - 1)))
    parser.add_argument("--key-mode", choices=["livecommon", "coarse", "abstract", "exact"], default="livecommon")
    parser.add_argument("--utility", choices=["rank", "top3", "win"], default="rank")
    parser.add_argument("--out", type=Path, default=Path("experiments/precomputed/the_professor_six.json"))
    parser.add_argument("--benchmark-games", type=int, default=100)
    args = parser.parse_args()

    started = time.perf_counter()
    table = build_six_mcmc_table(
        args.states,
        args.rollouts,
        args.seed,
        args.key_mode,
        args.workers,
        args.utility,
    )
    elapsed = time.perf_counter() - started
    write_table(table, args.out)
    print(f"states: {len(table)}")
    print(f"rollouts_per_state: {args.rollouts}")
    print(f"workers: {args.workers}")
    print(f"utility: {args.utility}")
    print(f"seconds: {elapsed:.3f}")
    print(f"seconds_per_state: {elapsed / max(1, len(table)):.3f}")
    print(f"output: {args.out}")

    result = run_multiplayer_series(
        args.benchmark_games,
        args.seed + 1,
        lambda: TheProfessor(table, key_mode=args.key_mode),
        [LiveLisan, LiveLisan, ExploitLisan, LiveLisan, ExploitLisan],
    )
    print("benchmark_six_player:")
    for key, value in result.items():
        print(f"  {key}: {value}")


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
import json
import random
from collections import Counter
from pathlib import Path
from typing import Callable

from core import _maybe_play, _record_words, visible_opponent_state
from experiments.exploit_lisan import STARTING_RACK_SIZE, PlayerState, Policy, build_bag
from lisan import BaseLisan, LisanCappedVisibleEvFloor
from opponents import opponent_factories


class CandidateBase(BaseLisan):
    name = "candidate"


class CandidateCap(LisanCappedVisibleEvFloor):
    name = "candidate"


def representative_visible_opponent(
    players: list[PlayerState],
    visible_racks: list[Counter[str]],
    own_index: int,
) -> PlayerState:
    candidates = [
        (index, player)
        for index, player in enumerate(players)
        if index != own_index
    ]
    target_index, target = max(candidates, key=lambda item: (item[1].score, item[1].balance))
    return visible_opponent_state(target, visible_racks[target_index])


def resolve_vickrey(
    letter: str,
    bids: list[int],
    players: list[PlayerState],
    visible_racks: list[Counter[str]],
    rng: random.Random,
) -> None:
    positive = [(bid, index) for index, bid in enumerate(bids) if bid > 0]
    if not positive:
        return
    rng.shuffle(positive)
    positive.sort(key=lambda item: item[0], reverse=True)
    top_bid, winner_index = positive[0]
    paid = positive[1][0] if len(positive) > 1 else min(1, top_bid)
    winner = players[winner_index]
    if winner.balance >= paid:
        winner.balance -= paid
        winner.rack[letter] += 1
        visible_racks[winner_index][letter] += 1


def play_visible_game(
    seed: int,
    candidate_factory: Callable[[], Policy],
    opponent_factories_for_stage: list[Callable[[], Policy]],
) -> dict[str, int | float]:
    rng = random.Random(seed)
    policies = [candidate_factory(), *[factory() for factory in opponent_factories_for_stage]]
    players = [PlayerState(policy.name) for policy in policies]
    visible_racks = [Counter() for _ in players]
    bag = build_bag(rng)

    for _ in range(STARTING_RACK_SIZE):
        for player in players:
            player.rack[bag.pop()] += 1

    for index, policy in enumerate(policies):
        played = _maybe_play(
            policy,
            players[index],
            representative_visible_opponent(players, visible_racks, index),
            0,
            len(bag),
        )
        _record_words(visible_racks[index], played)

    round_index = 0
    no_bid_requeues = 0
    while bag and round_index < 220:
        round_index += 1
        letter = bag.pop()
        auctions_left = len(bag)
        bids: list[int] = []
        for index, policy in enumerate(policies):
            bid = policy.decide_bid(
                letter,
                round_index,
                auctions_left,
                players[index],
                representative_visible_opponent(players, visible_racks, index),
            )
            bids.append(max(0, min(players[index].balance, bid)))
        if all(bid <= 0 for bid in bids):
            no_bid_requeues += 1
            if no_bid_requeues <= 26:
                bag.insert(0, letter)
                continue
            richest = max(range(len(players)), key=lambda index: players[index].balance)
            bids[richest] = min(1, players[richest].balance)
        resolve_vickrey(letter, bids, players, visible_racks, rng)
        for index, policy in enumerate(policies):
            played = _maybe_play(
                policy,
                players[index],
                representative_visible_opponent(players, visible_racks, index),
                round_index,
                auctions_left,
            )
            _record_words(visible_racks[index], played)

    for index, policy in enumerate(policies):
        played = _maybe_play(
            policy,
            players[index],
            representative_visible_opponent(players, visible_racks, index),
            round_index,
            0,
        )
        _record_words(visible_racks[index], played)

    ranked = sorted(
        enumerate(players),
        key=lambda item: (item[1].score, item[1].balance),
        reverse=True,
    )
    candidate_rank = next(rank + 1 for rank, (index, _) in enumerate(ranked) if index == 0)
    candidate = players[0]
    best_opponent_score = max(player.score for player in players[1:])
    return {
        "rank": candidate_rank,
        "score": candidate.score,
        "score_delta": candidate.score - best_opponent_score,
        "balance": candidate.balance,
    }


def base_strategy(players: int) -> Callable[[], Policy]:
    return CandidateBase


def proposed_strategy(players: int) -> Callable[[], Policy]:
    if players == 2:
        return lambda: CandidateCap(8)
    if players == 3:
        return lambda: CandidateCap(5)
    return CandidateBase


def cap_strategy(cap: int) -> Callable[[int], Callable[[], Policy]]:
    return lambda _players: (lambda: CandidateCap(cap))


def field_catalog() -> dict[str, list[str]]:
    return {
        "hoarder_mixed": [
            "hoarder",
            "low-bankroll-saver",
            "exploit-lisan",
            "q-averse",
            "aggressive",
        ],
        "strong_mixed": [
            "hoarder",
            "word-ev-max",
            "exploit-lisan",
            "low-bankroll-saver",
            "q-averse",
        ],
        "lisan_like": [
            "base-lisan",
            "exploit-lisan",
            "q-averse",
            "low-bankroll-saver",
            "random-noisy",
        ],
    }


def summarize_stage(
    games: int,
    seed: int,
    players: int,
    candidate_for_players: Callable[[int], Callable[[], Policy]],
    opponent_names: list[str],
) -> dict[str, float | int]:
    factories = opponent_factories()
    ranks: list[int] = []
    scores: list[int] = []
    deltas: list[int] = []
    balances: list[int] = []
    stage_opponents = [factories[name] for name in opponent_names[: players - 1]]
    for game in range(games):
        result = play_visible_game(
            seed + game,
            candidate_for_players(players),
            stage_opponents,
        )
        ranks.append(int(result["rank"]))
        scores.append(int(result["score"]))
        deltas.append(int(result["score_delta"]))
        balances.append(int(result["balance"]))
    return {
        "games": games,
        "players": players,
        "top1": sum(rank == 1 for rank in ranks) / games,
        "survive_not_last": sum(rank < players for rank in ranks) / games,
        "last": sum(rank == players for rank in ranks) / games,
        "avg_rank": sum(ranks) / games,
        "avg_score": sum(scores) / games,
        "avg_score_delta": sum(deltas) / games,
        "avg_balance": sum(balances) / games,
    }


def run_stage_strategy(
    games: int,
    seed: int,
    fields: list[str],
    stages: list[int],
) -> dict[str, object]:
    catalog = field_catalog()
    strategies: dict[str, Callable[[int], Callable[[], Policy]]] = {
        "base": base_strategy,
        "proposed_4base_3cap5_2cap8": proposed_strategy,
        "always_cap5": cap_strategy(5),
        "always_cap8": cap_strategy(8),
    }
    results: dict[str, object] = {}
    for field_index, field_name in enumerate(fields):
        results[field_name] = {}
        for strategy_index, (strategy_name, strategy) in enumerate(strategies.items()):
            results[field_name][strategy_name] = {}
            for players in stages:
                results[field_name][strategy_name][str(players)] = summarize_stage(
                    games,
                    seed + field_index * 100_000 + strategy_index * 10_000 + players * 1_000,
                    players,
                    strategy,
                    catalog[field_name],
                )
    return {
        "games_per_stage": games,
        "seed": seed,
        "fields": {name: catalog[name] for name in fields},
        "stages": stages,
        "results": results,
    }


def parse_stages(raw: str) -> list[int]:
    return [int(part.strip()) for part in raw.split(",") if part.strip()]


def main() -> None:
    catalog = field_catalog()
    parser = argparse.ArgumentParser(description="Evaluate staged tournament cap strategy.")
    parser.add_argument("--games", type=int, default=30)
    parser.add_argument("--seed", type=int, default=20260607)
    parser.add_argument("--fields", nargs="*", choices=sorted(catalog), default=sorted(catalog))
    parser.add_argument("--stages", default="6,5,4,3,2")
    parser.add_argument("--out", type=Path, default=Path("experiments-1v1s/stage-strategy-results.json"))
    args = parser.parse_args()

    result = run_stage_strategy(args.games, args.seed, args.fields, parse_stages(args.stages))
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result["results"], indent=2))


if __name__ == "__main__":
    main()

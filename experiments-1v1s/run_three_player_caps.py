from __future__ import annotations

import argparse
import json
import random
from collections import Counter
from pathlib import Path
from typing import Callable

from core import _maybe_play, _record_words, visible_opponent_state
from experiments.exploit_lisan import STARTING_RACK_SIZE, PlayerState, Policy, build_bag
from lisan import BaseLisan, LisanCappedVisibleEvFloor, LisanVisibleEvFloor
from opponents import opponent_factories


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


def play_three_player_game(
    seed: int,
    candidate_policy: Policy,
    opponent_policies: list[Policy],
) -> dict[str, int | float]:
    rng = random.Random(seed)
    policies = [candidate_policy, *opponent_policies]
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


def capped_factory(cap: int) -> Callable[[], Policy]:
    return lambda: LisanCappedVisibleEvFloor(cap)


def policy_factories(caps: list[int]) -> dict[str, Callable[[], Policy]]:
    factories: dict[str, Callable[[], Policy]] = {
        "base": BaseLisan,
        "uncapped": LisanVisibleEvFloor,
    }
    for cap in caps:
        factories[f"cap-{cap}"] = capped_factory(cap)
    return factories


def run_three_player_caps(
    games: int,
    seed: int,
    caps: list[int],
    opponent_names: list[str],
) -> dict[str, object]:
    opponents = opponent_factories()
    policies = policy_factories(caps)
    results: dict[str, object] = {}
    for policy_index, (policy_name, policy_factory) in enumerate(policies.items()):
        ranks: list[int] = []
        scores: list[int] = []
        deltas: list[int] = []
        balances: list[int] = []
        for game in range(games):
            result = play_three_player_game(
                seed + policy_index * 10_000 + game,
                policy_factory(),
                [opponents[name]() for name in opponent_names],
            )
            ranks.append(int(result["rank"]))
            scores.append(int(result["score"]))
            deltas.append(int(result["score_delta"]))
            balances.append(int(result["balance"]))
        results[policy_name] = {
            "games": games,
            "top1": sum(rank == 1 for rank in ranks) / games,
            "top2_survive": sum(rank <= 2 for rank in ranks) / games,
            "last": sum(rank == 3 for rank in ranks) / games,
            "avg_rank": sum(ranks) / games,
            "avg_score": sum(scores) / games,
            "avg_score_delta": sum(deltas) / games,
            "avg_balance": sum(balances) / games,
        }
    return {
        "games": games,
        "seed": seed,
        "caps": caps,
        "opponents": opponent_names,
        "results": results,
    }


def parse_caps(raw: str) -> list[int]:
    return [int(part.strip()) for part in raw.split(",") if part.strip()]


def main() -> None:
    opponents = opponent_factories()
    parser = argparse.ArgumentParser(description="Run 3-player capped visible-EV sweep.")
    parser.add_argument("--games", type=int, default=100)
    parser.add_argument("--seed", type=int, default=20260607)
    parser.add_argument("--caps", default="1,2,4,8,12")
    parser.add_argument("--opponents", nargs=2, choices=sorted(opponents), default=["hoarder", "exploit-lisan"])
    parser.add_argument("--out", type=Path, default=Path("experiments-1v1s/three-player-cap-results.json"))
    args = parser.parse_args()

    result = run_three_player_caps(args.games, args.seed, parse_caps(args.caps), args.opponents)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result["results"], indent=2))


if __name__ == "__main__":
    main()

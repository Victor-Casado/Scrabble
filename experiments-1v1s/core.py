from __future__ import annotations

import csv
import json
import pathlib
import random
import sys
from collections import Counter
from pathlib import Path
from typing import Callable, Iterable

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from experiments.exploit_lisan import (
    STARTING_RACK_SIZE,
    PlayerState,
    Policy,
    build_bag,
    remove_word,
    score_word,
)


def visible_opponent_state(opponent: PlayerState, visible_rack: Counter[str]) -> PlayerState:
    return PlayerState(
        opponent.name,
        balance=opponent.balance,
        score=opponent.score,
        rack=Counter({letter: count for letter, count in visible_rack.items() if count > 0}),
    )


def _subtract_visible_word(visible_rack: Counter[str], word: str) -> None:
    for letter in word:
        if visible_rack.get(letter, 0) <= 1:
            visible_rack.pop(letter, None)
        else:
            visible_rack[letter] -= 1


def _maybe_play(
    policy: Policy,
    state: PlayerState,
    opponent_public: PlayerState,
    round_index: int,
    auctions_left: int,
) -> list[str]:
    played: list[str] = []
    for _ in range(4):
        word = policy.choose_word(round_index, auctions_left, state, opponent_public)
        if not word:
            return played
        reward = score_word(word)
        remove_word(state.rack, word)
        state.balance += reward
        state.score += reward
        played.append(word)
    return played


def _record_words(visible_rack: Counter[str], words: Iterable[str]) -> None:
    for word in words:
        _subtract_visible_word(visible_rack, word)


def _bid_stats(policy: Policy, bid: int) -> tuple[int, int, int, int]:
    activated = int(bool(getattr(policy, "last_floor_activated", False)))
    over_cap = int(bool(getattr(policy, "last_floor_over_cap", False)))
    ev = int(getattr(policy, "last_opponent_visible_ev", 0))
    base = int(getattr(policy, "last_base_bid", bid))
    return activated, over_cap, ev, base


def play_game(
    seed: int,
    left_policy: Policy,
    right_policy: Policy,
) -> dict[str, int | float | str]:
    rng = random.Random(seed)
    bag = build_bag(rng)
    left = PlayerState(left_policy.name)
    right = PlayerState(right_policy.name)
    left_visible = Counter()
    right_visible = Counter()

    for _ in range(STARTING_RACK_SIZE):
        left.rack[bag.pop()] += 1
        right.rack[bag.pop()] += 1

    _record_words(
        left_visible,
        _maybe_play(left_policy, left, visible_opponent_state(right, right_visible), 0, len(bag)),
    )
    _record_words(
        right_visible,
        _maybe_play(right_policy, right, visible_opponent_state(left, left_visible), 0, len(bag)),
    )

    round_index = 0
    no_bid_requeues = 0
    left_floor_activations = 0
    right_floor_activations = 0
    left_floor_over_cap = 0
    right_floor_over_cap = 0
    left_ev_samples: list[int] = []
    right_ev_samples: list[int] = []
    left_bid_delta = 0
    right_bid_delta = 0
    left_bid_decisions = 0
    right_bid_decisions = 0

    while bag and round_index < 220:
        round_index += 1
        letter = bag.pop()
        auctions_left = len(bag)
        left_bid = left_policy.decide_bid(
            letter,
            round_index,
            auctions_left,
            left,
            visible_opponent_state(right, right_visible),
        )
        left_active, left_over, left_ev, left_base = _bid_stats(left_policy, left_bid)
        right_bid = right_policy.decide_bid(
            letter,
            round_index,
            auctions_left,
            right,
            visible_opponent_state(left, left_visible),
        )
        right_active, right_over, right_ev, right_base = _bid_stats(right_policy, right_bid)
        left_bid = max(0, min(left.balance, left_bid))
        right_bid = max(0, min(right.balance, right_bid))
        left_bid_decisions += 1
        right_bid_decisions += 1
        left_floor_activations += left_active
        right_floor_activations += right_active
        left_floor_over_cap += left_over
        right_floor_over_cap += right_over
        left_ev_samples.append(left_ev)
        right_ev_samples.append(right_ev)
        left_bid_delta += left_bid - left_base
        right_bid_delta += right_bid - right_base

        if left_bid <= 0 and right_bid <= 0:
            no_bid_requeues += 1
            if no_bid_requeues > 26:
                if left.balance >= right.balance and left.balance > 0:
                    left_bid = 1
                elif right.balance > 0:
                    right_bid = 1
                else:
                    continue
            else:
                bag.insert(0, letter)
                continue

        if left_bid > right_bid or (left_bid == right_bid and rng.random() < 0.5):
            paid = right_bid if right_bid > 0 else min(1, left_bid)
            if left.balance >= paid:
                left.balance -= paid
                left.rack[letter] += 1
                left_visible[letter] += 1
        else:
            paid = left_bid if left_bid > 0 else min(1, right_bid)
            if right.balance >= paid:
                right.balance -= paid
                right.rack[letter] += 1
                right_visible[letter] += 1

        _record_words(
            left_visible,
            _maybe_play(
                left_policy,
                left,
                visible_opponent_state(right, right_visible),
                round_index,
                auctions_left,
            ),
        )
        _record_words(
            right_visible,
            _maybe_play(
                right_policy,
                right,
                visible_opponent_state(left, left_visible),
                round_index,
                auctions_left,
            ),
        )

    _record_words(
        left_visible,
        _maybe_play(left_policy, left, visible_opponent_state(right, right_visible), round_index, 0),
    )
    _record_words(
        right_visible,
        _maybe_play(right_policy, right, visible_opponent_state(left, left_visible), round_index, 0),
    )

    if left.score > right.score:
        winner = "left"
    elif right.score > left.score:
        winner = "right"
    else:
        winner = "tie"
    return {
        "winner": winner,
        "left_score": left.score,
        "right_score": right.score,
        "left_balance": left.balance,
        "right_balance": right.balance,
        "rounds": round_index,
        "left_floor_activations": left_floor_activations,
        "right_floor_activations": right_floor_activations,
        "left_floor_over_cap": left_floor_over_cap,
        "right_floor_over_cap": right_floor_over_cap,
        "left_bid_decisions": left_bid_decisions,
        "right_bid_decisions": right_bid_decisions,
        "left_avg_opponent_visible_ev": sum(left_ev_samples) / max(1, len(left_ev_samples)),
        "right_avg_opponent_visible_ev": sum(right_ev_samples) / max(1, len(right_ev_samples)),
        "left_avg_bid_delta": left_bid_delta / max(1, len(left_ev_samples)),
        "right_avg_bid_delta": right_bid_delta / max(1, len(right_ev_samples)),
    }


def _empty_summary(games: int) -> dict[str, float | int]:
    return {
        "games": games,
        "wins": 0,
        "losses": 0,
        "ties": 0,
        "win_rate": 0.0,
        "avg_score": 0.0,
        "avg_score_delta": 0.0,
        "avg_balance_delta": 0.0,
        "bid_decisions": 0,
        "floor_activation_rate": 0.0,
        "floor_over_cap_rate": 0.0,
        "avg_opponent_visible_ev": 0.0,
        "avg_bid_delta": 0.0,
    }


def evaluate_policy(
    games: int,
    seed: int,
    policy_factory: Callable[[], Policy],
    opponent_factory: Callable[[], Policy],
) -> dict[str, float | int]:
    summary = _empty_summary(games * 2)
    floor_activations = 0
    floor_over_cap = 0
    bid_decisions = 0
    ev_total = 0.0
    bid_delta_total = 0.0
    for index in range(games):
        left_result = play_game(seed + index, policy_factory(), opponent_factory())
        right_result = play_game(seed + 100_000 + index, opponent_factory(), policy_factory())
        for side, result in (("left", left_result), ("right", right_result)):
            own_score = int(result[f"{side}_score"])
            other_side = "right" if side == "left" else "left"
            other_score = int(result[f"{other_side}_score"])
            own_balance = int(result[f"{side}_balance"])
            other_balance = int(result[f"{other_side}_balance"])
            winner = result["winner"]
            if winner == side:
                summary["wins"] += 1
            elif winner == "tie":
                summary["ties"] += 1
            else:
                summary["losses"] += 1
            summary["avg_score"] += own_score
            summary["avg_score_delta"] += own_score - other_score
            summary["avg_balance_delta"] += own_balance - other_balance
            floor_activations += int(result[f"{side}_floor_activations"])
            floor_over_cap += int(result[f"{side}_floor_over_cap"])
            side_bid_decisions = int(result[f"{side}_bid_decisions"])
            bid_decisions += side_bid_decisions
            ev_total += float(result[f"{side}_avg_opponent_visible_ev"]) * side_bid_decisions
            bid_delta_total += float(result[f"{side}_avg_bid_delta"]) * side_bid_decisions

    total_games = int(summary["games"])
    summary["bid_decisions"] = bid_decisions
    summary["win_rate"] = (int(summary["wins"]) + int(summary["ties"]) * 0.5) / total_games
    summary["avg_score"] = float(summary["avg_score"]) / total_games
    summary["avg_score_delta"] = float(summary["avg_score_delta"]) / total_games
    summary["avg_balance_delta"] = float(summary["avg_balance_delta"]) / total_games
    summary["floor_activation_rate"] = floor_activations / max(1, bid_decisions)
    summary["floor_over_cap_rate"] = floor_over_cap / max(1, bid_decisions)
    summary["avg_opponent_visible_ev"] = ev_total / max(1, bid_decisions)
    summary["avg_bid_delta"] = bid_delta_total / max(1, bid_decisions)
    return summary


def run_matrix(
    games: int,
    seed: int,
    opponent_names: list[str] | None = None,
) -> dict[str, object]:
    from lisan import BaseLisan, LisanVisibleEvFloor
    from opponents import opponent_factories

    factories = opponent_factories()
    names = opponent_names if opponent_names is not None else sorted(factories)
    matchups: dict[str, object] = {}
    candidate_totals = _empty_summary(0)
    baseline_totals = _empty_summary(0)
    aggregate_games = 0

    for offset, name in enumerate(names):
        opponent_factory = factories[name]
        candidate = evaluate_policy(games, seed + offset * 10_000, LisanVisibleEvFloor, opponent_factory)
        baseline = evaluate_policy(games, seed + offset * 20_000, BaseLisan, opponent_factory)
        matchups[name] = {"candidate": candidate, "baseline": baseline}
        aggregate_games += int(candidate["games"])
        for target, source in ((candidate_totals, candidate), (baseline_totals, baseline)):
            target["wins"] += int(source["wins"])
            target["losses"] += int(source["losses"])
            target["ties"] += int(source["ties"])
            target["bid_decisions"] += int(source["bid_decisions"])
            for key in (
                "avg_score",
                "avg_score_delta",
                "avg_balance_delta",
            ):
                target[key] += float(source[key]) * int(source["games"])
            for key in (
                "floor_activation_rate",
                "floor_over_cap_rate",
                "avg_opponent_visible_ev",
                "avg_bid_delta",
            ):
                target[key] += float(source[key]) * int(source["bid_decisions"])

    def finalize(summary: dict[str, float | int]) -> dict[str, float | int]:
        summary["games"] = aggregate_games
        if aggregate_games <= 0:
            return summary
        summary["win_rate"] = (int(summary["wins"]) + int(summary["ties"]) * 0.5) / aggregate_games
        for key in (
            "avg_score",
            "avg_score_delta",
            "avg_balance_delta",
        ):
            summary[key] = float(summary[key]) / aggregate_games
        bid_decisions = int(summary["bid_decisions"])
        for key in (
            "floor_activation_rate",
            "floor_over_cap_rate",
            "avg_opponent_visible_ev",
            "avg_bid_delta",
        ):
            summary[key] = float(summary[key]) / max(1, bid_decisions)
        return summary

    return {
        "games_per_matchup": games,
        "seed": seed,
        "opponents": names,
        "matchups": matchups,
        "aggregate": {
            "candidate": finalize(candidate_totals),
            "baseline": finalize(baseline_totals),
        },
    }


def write_outputs(result: dict[str, object], json_path: Path | None, csv_path: Path | None) -> None:
    if json_path is not None:
        json_path.parent.mkdir(parents=True, exist_ok=True)
        json_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    if csv_path is None:
        return
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, object]] = []
    for opponent, values in dict(result["matchups"]).items():
        matchup = dict(values)
        for policy_name in ("candidate", "baseline"):
            row = {"opponent": opponent, "policy": policy_name}
            row.update(dict(matchup[policy_name]))
            rows.append(row)
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()) if rows else ["opponent", "policy"])
        writer.writeheader()
        writer.writerows(rows)

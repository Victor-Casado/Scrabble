from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Callable

from core import evaluate_policy
from lisan import BaseLisan, LisanCappedVisibleEvFloor, LisanVisibleEvFloor
from opponents import opponent_factories


def capped_factory(cap: int) -> Callable[[], LisanCappedVisibleEvFloor]:
    return lambda: LisanCappedVisibleEvFloor(cap)


def policy_factories(caps: list[int]) -> dict[str, Callable[[], BaseLisan]]:
    factories: dict[str, Callable[[], BaseLisan]] = {
        "base": BaseLisan,
        "uncapped": LisanVisibleEvFloor,
    }
    for cap in caps:
        factories[f"cap-{cap}"] = capped_factory(cap)
    return factories


def run_cap_matrix(
    games: int,
    seed: int,
    caps: list[int],
    opponent_names: list[str],
) -> dict[str, object]:
    opponents = opponent_factories()
    policies = policy_factories(caps)
    matchups: dict[str, dict[str, object]] = {}
    aggregate: dict[str, dict[str, float | int]] = {}

    for policy_name in policies:
        aggregate[policy_name] = {
            "games": 0,
            "wins": 0,
            "losses": 0,
            "ties": 0,
            "avg_score": 0.0,
            "avg_score_delta": 0.0,
            "avg_balance_delta": 0.0,
            "bid_decisions": 0,
            "floor_activation_rate": 0.0,
            "avg_bid_delta": 0.0,
        }

    for opponent_index, opponent_name in enumerate(opponent_names):
        matchups[opponent_name] = {}
        for policy_index, (policy_name, policy_factory) in enumerate(policies.items()):
            summary = evaluate_policy(
                games,
                seed + opponent_index * 10_000 + policy_index * 1_000,
                policy_factory,
                opponents[opponent_name],
            )
            matchups[opponent_name][policy_name] = summary
            target = aggregate[policy_name]
            target["games"] += int(summary["games"])
            target["wins"] += int(summary["wins"])
            target["losses"] += int(summary["losses"])
            target["ties"] += int(summary["ties"])
            target["bid_decisions"] += int(summary["bid_decisions"])
            for key in ("avg_score", "avg_score_delta", "avg_balance_delta"):
                target[key] += float(summary[key]) * int(summary["games"])
            for key in ("floor_activation_rate", "avg_bid_delta"):
                target[key] += float(summary[key]) * int(summary["bid_decisions"])

    for summary in aggregate.values():
        total_games = int(summary["games"])
        bid_decisions = int(summary["bid_decisions"])
        summary["win_rate"] = (
            int(summary["wins"]) + int(summary["ties"]) * 0.5
        ) / max(1, total_games)
        for key in ("avg_score", "avg_score_delta", "avg_balance_delta"):
            summary[key] = float(summary[key]) / max(1, total_games)
        for key in ("floor_activation_rate", "avg_bid_delta"):
            summary[key] = float(summary[key]) / max(1, bid_decisions)

    return {
        "games_per_matchup": games,
        "seed": seed,
        "caps": caps,
        "opponents": opponent_names,
        "matchups": matchups,
        "aggregate": aggregate,
    }


def write_csv(result: dict[str, object], csv_path: Path) -> None:
    rows: list[dict[str, object]] = []
    for opponent, values in dict(result["matchups"]).items():
        for policy, summary in dict(values).items():
            row = {"opponent": opponent, "policy": policy}
            row.update(dict(summary))
            rows.append(row)
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def parse_caps(raw: str) -> list[int]:
    return [int(part.strip()) for part in raw.split(",") if part.strip()]


def main() -> None:
    opponents = opponent_factories()
    parser = argparse.ArgumentParser(description="Run capped visible-EV 1v1 sweep.")
    parser.add_argument("--games", type=int, default=100)
    parser.add_argument("--seed", type=int, default=20260607)
    parser.add_argument("--caps", default="1,2,4,8,12")
    parser.add_argument("--opponents", nargs="*", choices=sorted(opponents))
    parser.add_argument("--out", type=Path, default=Path("experiments-1v1s/cap-results.json"))
    parser.add_argument("--csv", type=Path, default=Path("experiments-1v1s/cap-results.csv"))
    args = parser.parse_args()

    opponent_names = args.opponents or [
        "base-lisan",
        "exploit-lisan",
        "hoarder",
        "low-bankroll-saver",
        "q-averse",
        "aggressive",
        "word-ev-max",
    ]
    result = run_cap_matrix(args.games, args.seed, parse_caps(args.caps), opponent_names)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    write_csv(result, args.csv)
    print(json.dumps(result["aggregate"], indent=2))


if __name__ == "__main__":
    main()

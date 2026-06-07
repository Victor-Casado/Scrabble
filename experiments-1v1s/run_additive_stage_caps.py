from __future__ import annotations

import argparse
import json
import pathlib
import sys
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from experiments.exploit_lisan import Policy
from lisan import BaseLisan, LisanAdditiveVisibleEvCap
from opponents import opponent_factories
from run_stage_strategy import field_catalog, play_visible_game


class CandidateBase(BaseLisan):
    name = "candidate"


class CandidateAdditiveCap(LisanAdditiveVisibleEvCap):
    name = "candidate"


def add_cap_factory(cap: int) -> Callable[[], Policy]:
    return lambda: CandidateAdditiveCap(cap)


def summarize(
    games: int,
    seed: int,
    players: int,
    candidate_factory: Callable[[], Policy],
    opponent_names: list[str],
) -> dict[str, float | int]:
    factories = opponent_factories()
    stage_opponents = [factories[name] for name in opponent_names[: players - 1]]
    ranks: list[int] = []
    scores: list[int] = []
    deltas: list[int] = []
    balances: list[int] = []
    for game in range(games):
        result = play_visible_game(seed + game, candidate_factory, stage_opponents)
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


def parse_caps(raw: str) -> list[int]:
    return [int(part.strip()) for part in raw.split(",") if part.strip()]


def run_additive_stage_caps(
    games: int,
    seed: int,
    players: int,
    caps: list[int],
    fields: list[str],
) -> dict[str, object]:
    catalog = field_catalog()
    results: dict[str, object] = {}
    for field_index, field_name in enumerate(fields):
        results[field_name] = {
            "base": summarize(
                games,
                seed + field_index * 100_000,
                players,
                CandidateBase,
                catalog[field_name],
            )
        }
        for cap_index, cap in enumerate(caps):
            results[field_name][f"add-cap-{cap}"] = summarize(
                games,
                seed + field_index * 100_000 + (cap_index + 1) * 10_000,
                players,
                add_cap_factory(cap),
                catalog[field_name],
            )
    return {
        "games": games,
        "seed": seed,
        "players": players,
        "caps": caps,
        "fields": {name: catalog[name] for name in fields},
        "results": results,
    }


def main() -> None:
    catalog = field_catalog()
    parser = argparse.ArgumentParser(description="Evaluate additive visible-EV caps by stage.")
    parser.add_argument("--games", type=int, default=40)
    parser.add_argument("--seed", type=int, default=20260607)
    parser.add_argument("--players", type=int, choices=[2, 3, 4, 5, 6], required=True)
    parser.add_argument("--caps", required=True)
    parser.add_argument("--fields", nargs="*", choices=sorted(catalog), default=sorted(catalog))
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    result = run_additive_stage_caps(
        args.games,
        args.seed,
        args.players,
        parse_caps(args.caps),
        args.fields,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result["results"], indent=2))


if __name__ == "__main__":
    main()

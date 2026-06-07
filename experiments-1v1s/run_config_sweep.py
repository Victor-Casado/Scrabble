from __future__ import annotations

import argparse
import json
import pathlib
import sys
from collections import Counter
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from experiments.exploit_lisan import PlayerState, Policy
from experiments.evaluate_professor import DEFAULT_ONE_TABLE, DEFAULT_SIX_TABLE
from experiments.mcmc_precompute import load_table
from experiments.professor_model import (
    TheProfessor,
    tuned_professor_config,
    tuned_six_player_config,
)
from lisan import BaseLisan
from run_stage_strategy import field_catalog, play_visible_game
from opponents import opponent_factories


class CandidateBase(BaseLisan):
    name = "candidate"


class ConfigPolicy(BaseLisan):
    name = "candidate"

    def __init__(
        self,
        mode: str,
        opponent_cap: int = 0,
        weight_num: int = 1,
        weight_den: int = 1,
        base_delta_cap: int | None = None,
    ) -> None:
        super().__init__()
        self.mode = mode
        self.opponent_cap = opponent_cap
        self.weight_num = weight_num
        self.weight_den = weight_den
        self.base_delta_cap = base_delta_cap

    def _weighted_denial(self, opponent_ev: int) -> int:
        capped = min(max(0, opponent_ev), self.opponent_cap)
        return round(capped * self.weight_num / self.weight_den)

    def _cap_above_base(self, base_bid: int, bid: int) -> int:
        if self.base_delta_cap is None:
            return bid
        return min(bid, base_bid + self.base_delta_cap)

    def decide_bid(
        self,
        letter: str,
        round_index: int,
        auctions_left: int,
        own: PlayerState,
        opponent: PlayerState,
    ) -> int:
        base_bid = super().decide_bid(letter, round_index, auctions_left, own, opponent)
        own_ev = self.marginal_reward(Counter(own.rack), letter)
        opponent_ev = self.marginal_reward(Counter(opponent.rack), letter)
        denial = self._weighted_denial(opponent_ev)

        if self.mode == "floor":
            bid = max(base_bid, opponent_ev)
        elif self.mode == "floor-capped":
            bid = min(max(base_bid, opponent_ev), base_bid + self.opponent_cap)
        elif self.mode == "add":
            bid = base_bid + denial
        elif self.mode == "sum-target":
            bid = max(base_bid, own_ev + denial)
        elif self.mode == "sum-only":
            bid = max(0, own_ev + denial)
        elif self.mode == "sum-target-capped":
            bid = self._cap_above_base(base_bid, max(base_bid, own_ev + denial))
        else:
            raise ValueError(f"unknown mode {self.mode}")

        return max(0, min(own.balance, int(bid)))


def policy_catalog() -> dict[str, Callable[[], Policy]]:
    one_table = load_table(DEFAULT_ONE_TABLE)
    six_table = load_table(DEFAULT_SIX_TABLE)
    catalog: dict[str, Callable[[], Policy]] = {
        "base": CandidateBase,
        "professor-1v1": lambda: TheProfessor(
            one_table,
            key_mode="livecommon",
            config=tuned_professor_config(),
        ),
        "professor-six": lambda: TheProfessor(
            six_table,
            key_mode="livecommon",
            config=tuned_six_player_config(),
        ),
    }
    for cap in (1, 2, 4, 5, 8, 12):
        catalog[f"floor-cap-{cap}"] = lambda cap=cap: ConfigPolicy("floor-capped", cap)
    for cap in (1, 2, 4, 5, 8, 12):
        catalog[f"add-cap-{cap}"] = lambda cap=cap: ConfigPolicy("add", cap)
    for cap in (4, 5, 8, 12):
        catalog[f"add-half-cap-{cap}"] = lambda cap=cap: ConfigPolicy("add", cap, 1, 2)
    for cap in (1, 2, 4, 5, 8, 12):
        catalog[f"sum-target-cap-{cap}"] = lambda cap=cap: ConfigPolicy("sum-target", cap)
    for cap in (1, 2, 4, 5, 8, 12):
        catalog[f"sum-only-cap-{cap}"] = lambda cap=cap: ConfigPolicy("sum-only", cap)
    for deny_cap in (4, 8, 12):
        for delta_cap in (2, 4, 8):
            catalog[f"sum-target-deny{deny_cap}-delta{delta_cap}"] = (
                lambda deny_cap=deny_cap, delta_cap=delta_cap: ConfigPolicy(
                    "sum-target-capped",
                    deny_cap,
                    base_delta_cap=delta_cap,
                )
            )
    return catalog


def summarize(
    games: int,
    seed: int,
    players: int,
    policy_factory: Callable[[], Policy],
    opponent_names: list[str],
) -> dict[str, float | int]:
    factories = opponent_factories()
    stage_opponents = [factories[name] for name in opponent_names[: players - 1]]
    ranks: list[int] = []
    scores: list[int] = []
    deltas: list[int] = []
    balances: list[int] = []
    for game in range(games):
        result = play_visible_game(seed + game, policy_factory, stage_opponents)
        ranks.append(int(result["rank"]))
        scores.append(int(result["score"]))
        deltas.append(int(result["score_delta"]))
        balances.append(int(result["balance"]))
    return {
        "games": games,
        "top1": sum(rank == 1 for rank in ranks) / games,
        "survive_not_last": sum(rank < players for rank in ranks) / games,
        "last": sum(rank == players for rank in ranks) / games,
        "avg_rank": sum(ranks) / games,
        "avg_score": sum(scores) / games,
        "avg_score_delta": sum(deltas) / games,
        "avg_balance": sum(balances) / games,
    }


def score_summary(players: int, summary: dict[str, float | int]) -> float:
    top1 = float(summary["top1"])
    survive = float(summary["survive_not_last"])
    avg_rank = float(summary["avg_rank"])
    if players == 2:
        return top1
    if players == 3:
        return survive * 0.75 + top1 * 0.25 - avg_rank * 0.01
    return survive * 0.6 + top1 * 0.2 - avg_rank * 0.01


def run_config_sweep(
    games: int,
    seed: int,
    players: int,
    fields: list[str],
    policies: list[str] | None,
) -> dict[str, object]:
    field_defs = field_catalog()
    policy_defs = policy_catalog()
    policy_names = policies if policies is not None else list(policy_defs)
    results: dict[str, object] = {}
    rankings: dict[str, object] = {}
    for field_index, field_name in enumerate(fields):
        rows: list[dict[str, object]] = []
        results[field_name] = {}
        for policy_index, policy_name in enumerate(policy_names):
            summary = summarize(
                games,
                seed + field_index * 100_000 + policy_index * 2_000,
                players,
                policy_defs[policy_name],
                field_defs[field_name],
            )
            results[field_name][policy_name] = summary
            row = {"policy": policy_name, "score": score_summary(players, summary)}
            row.update(summary)
            rows.append(row)
        rankings[field_name] = sorted(rows, key=lambda row: float(row["score"]), reverse=True)
    return {
        "games": games,
        "seed": seed,
        "players": players,
        "fields": {name: field_defs[name] for name in fields},
        "results": results,
        "rankings": rankings,
    }


def main() -> None:
    fields = field_catalog()
    policies = policy_catalog()
    parser = argparse.ArgumentParser(description="Sweep visible-EV config formulas.")
    parser.add_argument("--games", type=int, default=20)
    parser.add_argument("--seed", type=int, default=20260607)
    parser.add_argument("--players", type=int, choices=[2, 3, 4, 5, 6], required=True)
    parser.add_argument("--fields", nargs="*", choices=sorted(fields), default=sorted(fields))
    parser.add_argument("--policies", nargs="*", choices=sorted(policies))
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--top", type=int, default=12)
    args = parser.parse_args()

    result = run_config_sweep(args.games, args.seed, args.players, args.fields, args.policies)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    printable = {
        field: rows[: args.top]
        for field, rows in dict(result["rankings"]).items()
    }
    print(json.dumps(printable, indent=2))


if __name__ == "__main__":
    main()

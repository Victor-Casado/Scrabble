from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from experiments.exploit_lisan import ExploitLisan, run_series
from experiments.live_lisan import LiveLisan
from experiments.mcmc_precompute import load_table
from experiments.professor_model import (
    TheProfessor,
    run_multiplayer_series,
    tuned_professor_config,
    tuned_six_player_config,
)


DEFAULT_SEEDS = (20260607, 60607, 8675309, 424242)
DEFAULT_ONE_TABLE = Path("experiments/precomputed/the_professor_livecommon_1000_r24.json")
DEFAULT_SIX_TABLE = Path("experiments/precomputed/the_professor_six_rank_800_r20.json")


def _field_factories() -> list[type]:
    return [LiveLisan, LiveLisan, ExploitLisan, LiveLisan, ExploitLisan]


def _aggregate(rows: list[dict[str, Any]]) -> dict[str, float | int]:
    games = sum(int(row["games"]) for row in rows)
    if games <= 0:
        return {"games": 0}
    return {
        "games": games,
        "one_v_one_baseline": sum(row["one_v_one_baseline_wins"] for row in rows) / games,
        "one_v_one_candidate": sum(row["one_v_one_candidate_wins"] for row in rows) / games,
        "six_baseline_top1": sum(row["six_baseline_top1"] for row in rows) / games,
        "six_candidate_top1": sum(row["six_candidate_top1"] for row in rows) / games,
        "six_baseline_top3": sum(row["six_baseline_top3"] for row in rows) / games,
        "six_candidate_top3": sum(row["six_candidate_top3"] for row in rows) / games,
        "six_baseline_avg_rank": sum(row["six_baseline_rank"] for row in rows) / games,
        "six_candidate_avg_rank": sum(row["six_candidate_rank"] for row in rows) / games,
    }


def run_professor_eval(
    games: int,
    seeds: tuple[int, ...] = DEFAULT_SEEDS,
    one_table_path: Path = DEFAULT_ONE_TABLE,
    six_table_path: Path = DEFAULT_SIX_TABLE,
) -> dict[str, Any]:
    one_table = load_table(one_table_path)
    six_table = load_table(six_table_path)
    one_config = tuned_professor_config()
    six_config = tuned_six_player_config()
    rows: list[dict[str, Any]] = []
    for seed in seeds:
        one_base = run_series(games, seed, LiveLisan, LiveLisan)
        one_candidate = run_series(
            games,
            seed,
            lambda: TheProfessor(one_table, key_mode="livecommon", config=one_config),
            LiveLisan,
        )
        six_base = run_multiplayer_series(
            games,
            seed,
            lambda: TheProfessor({}, key_mode="livecommon"),
            _field_factories(),
        )
        six_candidate = run_multiplayer_series(
            games,
            seed,
            lambda: TheProfessor(six_table, key_mode="livecommon", config=six_config),
            _field_factories(),
        )
        rows.append(
            {
                "seed": seed,
                "games": games,
                "one_v_one_baseline_wins": one_base["left_wins"] + 0.5 * one_base["ties"],
                "one_v_one_candidate_wins": one_candidate["left_wins"]
                + 0.5 * one_candidate["ties"],
                "one_v_one_baseline_rate": one_base["left_win_rate"],
                "one_v_one_candidate_rate": one_candidate["left_win_rate"],
                "six_baseline_top1": six_base["professor_top1_rate"] * games,
                "six_candidate_top1": six_candidate["professor_top1_rate"] * games,
                "six_baseline_top3": six_base["professor_top3_rate"] * games,
                "six_candidate_top3": six_candidate["professor_top3_rate"] * games,
                "six_baseline_rank": six_base["professor_avg_rank"] * games,
                "six_candidate_rank": six_candidate["professor_avg_rank"] * games,
                "six_baseline": six_base,
                "six_candidate": six_candidate,
            }
        )
    return {"rows": rows, "aggregate": _aggregate(rows)}


def parse_seeds(raw: str) -> tuple[int, ...]:
    return tuple(int(seed.strip()) for seed in raw.split(",") if seed.strip())


def main() -> None:
    parser = argparse.ArgumentParser(description="Experiments-only eval for the-professor.")
    parser.add_argument("--games", type=int, default=200)
    parser.add_argument("--seeds", default=",".join(str(seed) for seed in DEFAULT_SEEDS))
    parser.add_argument("--one-table", type=Path, default=DEFAULT_ONE_TABLE)
    parser.add_argument("--six-table", type=Path, default=DEFAULT_SIX_TABLE)
    args = parser.parse_args()

    result = run_professor_eval(
        games=args.games,
        seeds=parse_seeds(args.seeds),
        one_table_path=args.one_table,
        six_table_path=args.six_table,
    )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

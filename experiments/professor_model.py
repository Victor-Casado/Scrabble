from __future__ import annotations

import argparse
import json
import random
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from experiments.exploit_lisan import (
    Policy,
    PlayerState,
    build_bag,
    maybe_play,
)
from experiments.live_lisan import LiveLisan
from experiments.mcmc_precompute import McmcTable, load_table, state_key


@dataclass(frozen=True)
class ProfessorConfig:
    min_visits: int = 20
    min_improvement: float = 0.12
    max_variance: float = 0.08
    max_bid_delta: int = 3
    max_override_balance_fraction: float = 0.35
    low_balance_fraction: float = 0.55
    allow_bid_raises: bool = False


def tuned_professor_config() -> ProfessorConfig:
    return ProfessorConfig(
        min_visits=20,
        min_improvement=0.18,
        max_variance=0.06,
        max_bid_delta=2,
        max_override_balance_fraction=0.35,
        low_balance_fraction=0.55,
        allow_bid_raises=True,
    )


def tuned_six_player_config() -> ProfessorConfig:
    return ProfessorConfig(
        min_visits=20,
        min_improvement=0.24,
        max_variance=0.04,
        max_bid_delta=1,
        max_override_balance_fraction=0.35,
        low_balance_fraction=0.55,
        allow_bid_raises=True,
    )


class TheProfessor(LiveLisan):
    name = "the-professor"

    def __init__(
        self,
        table: McmcTable,
        key_mode: str = "coarse",
        config: ProfessorConfig | None = None,
    ):
        super().__init__()
        self.table = table
        self.key_mode = key_mode
        self.config = config or ProfessorConfig()
        self.hits = 0
        self.misses = 0
        self.rejected = 0

    def _key(
        self,
        letter: str,
        round_index: int,
        auctions_left: int,
        own: PlayerState,
        opponent: PlayerState,
    ) -> str:
        if self.key_mode == "unit":
            return f"rs1|{letter}|t1|b4|sg0"
        return state_key(letter, round_index, auctions_left, own, opponent, self.key_mode)

    def safe_override_bid(
        self,
        baseline: int,
        entry: dict[str, float | int],
        balance: int,
        auctions_left: int,
    ) -> int | None:
        visits = int(entry.get("visits", 0))
        improvement = float(entry.get("improvement", 0.0))
        variance = float(entry.get("variance", 0.0))
        if visits < self.config.min_visits:
            return None
        if improvement < self.config.min_improvement:
            return None
        if variance > self.config.max_variance:
            return None

        proposed = max(0, min(balance, int(entry["bid"])))
        if not self.config.allow_bid_raises and proposed > baseline:
            return None
        delta = max(
            -self.config.max_bid_delta,
            min(self.config.max_bid_delta, proposed - baseline),
        )
        bid = max(0, min(balance, baseline + delta))

        if auctions_left > 2:
            if balance <= 25:
                cap = max(1, int(balance * self.config.low_balance_fraction))
            else:
                cap = max(baseline, int(balance * self.config.max_override_balance_fraction))
            if bid > cap:
                return None
        return bid

    def decide_bid(
        self,
        letter: str,
        round_index: int,
        auctions_left: int,
        own: PlayerState,
        opponent: PlayerState,
    ) -> int:
        baseline = super().decide_bid(letter, round_index, auctions_left, own, opponent)
        entry = self.table.get(self._key(letter, round_index, auctions_left, own, opponent))
        if entry is None:
            self.misses += 1
            return baseline
        override = self.safe_override_bid(baseline, entry, own.balance, auctions_left)
        if override is None:
            self.rejected += 1
            return baseline
        self.hits += 1
        return override


def representative_opponent(players: list[PlayerState], own_index: int) -> PlayerState:
    others = [p for index, p in enumerate(players) if index != own_index]
    return max(others, key=lambda p: (p.score, p.balance))


def resolve_multiplayer_vickrey(
    letter: str,
    bids: list[int],
    players: list[PlayerState],
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


def play_multiplayer_game(
    seed: int,
    policy_factories: list[Callable[[], Policy]],
) -> dict[str, object]:
    rng = random.Random(seed)
    policies = [factory() for factory in policy_factories]
    players = [PlayerState(policy.name) for policy in policies]
    bag = build_bag(rng)

    for _ in range(5):
        for player in players:
            player.rack[bag.pop()] += 1

    for index, policy in enumerate(policies):
        maybe_play(policy, players[index], representative_opponent(players, index), 0, len(bag))

    round_index = 0
    no_bid_requeues = 0
    while bag and round_index < 220:
        round_index += 1
        letter = bag.pop()
        auctions_left = len(bag)
        bids: list[int] = []
        for index, policy in enumerate(policies):
            own = players[index]
            opponent = representative_opponent(players, index)
            bid = policy.decide_bid(letter, round_index, auctions_left, own, opponent)
            bids.append(max(0, min(own.balance, bid)))
        if all(bid <= 0 for bid in bids):
            no_bid_requeues += 1
            if no_bid_requeues <= 26:
                bag.insert(0, letter)
                continue
            richest_index = max(range(len(players)), key=lambda index: players[index].balance)
            bids[richest_index] = min(1, players[richest_index].balance)
        resolve_multiplayer_vickrey(letter, bids, players, rng)
        for index, policy in enumerate(policies):
            maybe_play(
                policy,
                players[index],
                representative_opponent(players, index),
                round_index,
                auctions_left,
            )

    for index, policy in enumerate(policies):
        maybe_play(policy, players[index], representative_opponent(players, index), round_index, 0)

    ranked = sorted(
        [
            {
                "name": player.name,
                "score": player.score,
                "balance": player.balance,
                "rack": dict(player.rack),
            }
            for player in players
        ],
        key=lambda row: (int(row["score"]), int(row["balance"])),
        reverse=True,
    )
    professor_rank = next(
        index + 1 for index, row in enumerate(ranked) if row["name"] == "the-professor"
    )
    return {"players": ranked, "professor_rank": professor_rank}


def run_multiplayer_series(
    games: int,
    seed: int,
    professor_factory: Callable[[], Policy],
    field_factories: list[Callable[[], Policy]],
) -> dict[str, float | int]:
    ranks: list[int] = []
    scores: list[int] = []
    balances: list[int] = []
    for game in range(games):
        result = play_multiplayer_game(
            seed + game,
            [professor_factory, *field_factories],
        )
        ranks.append(int(result["professor_rank"]))
        professor = next(
            row for row in result["players"] if row["name"] == "the-professor"
        )
        scores.append(int(professor["score"]))
        balances.append(int(professor["balance"]))
    return {
        "games": games,
        "professor_top1_rate": sum(rank == 1 for rank in ranks) / games,
        "professor_top3_rate": sum(rank <= 3 for rank in ranks) / games,
        "professor_avg_rank": sum(ranks) / games,
        "professor_avg_score": sum(scores) / games,
        "professor_avg_balance": sum(balances) / games,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate the-professor in 1v1 and 6-player experiments.")
    parser.add_argument("--table", type=Path, required=True, help="1v1/preferred table path.")
    parser.add_argument("--six-table", type=Path, help="Optional six-player-specific table path.")
    parser.add_argument(
        "--key-mode",
        choices=["coarse", "abstract", "livecommon", "exact"],
        default="coarse",
    )
    parser.add_argument(
        "--six-key-mode",
        choices=["coarse", "abstract", "livecommon", "exact"],
        help="Optional six-player-specific key mode. Defaults to --key-mode.",
    )
    parser.add_argument("--tuned", action="store_true", help="Use the current tuned safety gate.")
    parser.add_argument("--games", type=int, default=200)
    parser.add_argument("--seed", type=int, default=20260607)
    args = parser.parse_args()

    table = load_table(args.table)
    six_table = load_table(args.six_table) if args.six_table else table
    six_key_mode = args.six_key_mode or args.key_mode
    one_config = tuned_professor_config() if args.tuned else ProfessorConfig()
    six_config = tuned_six_player_config() if args.tuned else ProfessorConfig()
    from experiments.exploit_lisan import ExploitLisan, run_series

    one_policies: list[TheProfessor] = []

    def one_factory() -> TheProfessor:
        policy = TheProfessor(table, key_mode=args.key_mode, config=one_config)
        one_policies.append(policy)
        return policy

    one_v_one = run_series(
        args.games,
        args.seed,
        one_factory,
        LiveLisan,
    )
    one_v_one["table_hits"] = sum(policy.hits for policy in one_policies)
    one_v_one["table_misses"] = sum(policy.misses for policy in one_policies)
    one_v_one["table_rejected"] = sum(policy.rejected for policy in one_policies)

    six_policies: list[TheProfessor] = []

    def six_factory() -> TheProfessor:
        policy = TheProfessor(six_table, key_mode=six_key_mode, config=six_config)
        six_policies.append(policy)
        return policy

    sixes = run_multiplayer_series(
        args.games,
        args.seed,
        six_factory,
        [LiveLisan, LiveLisan, ExploitLisan, LiveLisan, ExploitLisan],
    )
    sixes["table_hits"] = sum(policy.hits for policy in six_policies)
    sixes["table_misses"] = sum(policy.misses for policy in six_policies)
    sixes["table_rejected"] = sum(policy.rejected for policy in six_policies)
    print(json.dumps({"1v1_vs_live_lisan": one_v_one, "six_player": sixes}, indent=2))


if __name__ == "__main__":
    main()

from __future__ import annotations

import functools
import json
from collections import Counter
from pathlib import Path

from experiments.exploit_lisan import (
    LETTER_VALUES,
    Policy,
    PlayerState,
    WordEvMixin,
    rack_key,
    score_word,
)


PRECOMPUTED_ROOT = (
    Path(__file__).resolve().parents[1] / "bot-starter" / "src" / "precomputed"
)
LETTERS = list("ABCDEFGHIJKLMNOPQRSTUVWXYZ")

LETTER_PRIORS = json.loads((PRECOMPUTED_ROOT / "letter_prior.json").read_text())

PHASES = {
    "beginning": {
        "max_round": 25,
        "usual_letter_weight": 1.0,
        "rack_fit_weight": 0.25,
        "bid_multiplier": 1.65,
        "max_bid_balance_fraction": 0.3,
        "reserve_balance": 45,
        "min_bid": 1,
    },
    "middle": {
        "max_round": 60,
        "usual_letter_weight": 0.35,
        "rack_fit_weight": 1.2,
        "bid_multiplier": 2.0,
        "max_bid_balance_fraction": 0.45,
        "reserve_balance": 12,
        "min_bid": 1,
    },
    "end": {
        "max_round": 98,
        "usual_letter_weight": 0.0,
        "rack_fit_weight": 1.0,
        "bid_multiplier": 2.2,
        "max_bid_balance_fraction": 1.0,
        "reserve_balance": 0,
        "min_bid": 1,
    },
}


def live_rack_key(rack: Counter[str]) -> str:
    return "".join(f"{letter}{count}" for letter, count in sorted(rack.items()) if count > 0)


@functools.cache
def tile_gain_table(size: int) -> dict[str, str] | None:
    path = PRECOMPUTED_ROOT / "tile_gain" / f"size-{size}.json"
    if not path.exists():
        return None
    # The size-7 table is huge. The live TS bot can load it, but the offline
    # experiment uses exact rack-gain fallback for that size to keep series
    # runs tractable.
    if path.stat().st_size > 80_000_000:
        return None
    return json.loads(path.read_text())


def decode_tile_gain(vector: str, letter: str) -> int:
    try:
        index = LETTERS.index(letter)
    except ValueError:
        return 0
    encoded = vector[index * 2 : index * 2 + 2]
    if len(encoded) != 2:
        return 0
    return int(encoded, 36)


def select_phase(round_index: int) -> str:
    if round_index <= PHASES["beginning"]["max_round"]:
        return "beginning"
    if round_index <= PHASES["middle"]["max_round"]:
        return "middle"
    return "end"


def spend_cap(balance: int, phase_config: dict[str, float]) -> int:
    reserve_limited = max(0, balance - int(phase_config["reserve_balance"]))
    fraction_limited = int(balance * phase_config["max_bid_balance_fraction"])
    return max(0, min(balance, reserve_limited, fraction_limited))


def expected_balance_for_round(round_index: int) -> int:
    start_round = 1
    end_round = 98
    progress = min(1.0, max(0.0, (round_index - start_round) / (end_round - start_round)))
    return round(100 + (0 - 100) * progress)


def bankroll_pressure_multiplier(balance_delta: int) -> float:
    normalized = min(1.0, max(-1.0, balance_delta / 50))
    if normalized >= 0:
        return 1.0 + normalized * (1.2 - 1.0)
    return 1.0 + normalized * (1.0 - 0.8)


class LiveLisan(Policy, WordEvMixin):
    """Offline port of bot-starter's current live repo phase strategy."""

    name = "live-lisan"

    def tile_gain(self, rack: Counter[str], letter: str) -> int:
        size = sum(rack.values())
        if size <= 12:
            table = tile_gain_table(size)
            if table is not None:
                vector = table.get(live_rack_key(rack))
                if vector:
                    return decode_tile_gain(vector, letter)
            return self.marginal_reward(rack, letter)
        return 0

    def adjusted_gain(self, rack: Counter[str], letter: str, base_gain: int) -> float:
        has_q = rack.get("Q", 0) > 0
        has_u = rack.get("U", 0) > 0
        if letter == "Q" and not has_u:
            return base_gain if base_gain >= 8 else 0
        if letter == "U" and has_q:
            base_gain += 12
        if letter == "S" and sum(rack.values()) >= 5:
            return base_gain * 1.25
        return float(base_gain)

    def usual_tile_value(self, letter: str) -> float:
        return LETTER_PRIORS.get(letter, 0) + LETTER_VALUES.get(letter, 1) * 0.25

    def decide_bid(
        self,
        letter: str,
        round_index: int,
        auctions_left: int,
        own: PlayerState,
        opponent: PlayerState,
    ) -> int:
        phase = select_phase(round_index)
        config = PHASES[phase]
        ev_diff = self.tile_gain(own.rack, letter)
        bare_q_avoided = letter == "Q" and own.rack.get("U", 0) <= 0 and ev_diff < 8
        if auctions_left <= 2:
            if bare_q_avoided:
                return 0
            return max(0, own.balance)

        rack_fit_value = self.adjusted_gain(own.rack, letter, ev_diff)
        pressure = bankroll_pressure_multiplier(own.balance - expected_balance_for_round(round_index))
        value = (
            self.usual_tile_value(letter) * config["usual_letter_weight"]
            + rack_fit_value * config["rack_fit_weight"]
        )
        cap = spend_cap(own.balance, config)

        bid = 0
        if not bare_q_avoided and value > 0 and cap > 0:
            raw_bid = round(value * config["bid_multiplier"] * pressure)
            if raw_bid > 0:
                bid = min(cap, max(int(config["min_bid"]), raw_bid))

        if not bare_q_avoided and cap > 0 and letter != "Q":
            baseline = min(cap, max(1, round(10 * pressure)))
            bid = max(bid, baseline)
        if not bare_q_avoided and ev_diff > 0 and cap > 0:
            bid = max(bid, min(cap, ev_diff))
        return max(0, min(own.balance, int(bid)))

    def cash_in_threshold(self, auctions_left: int, balance: int, score: int) -> int:
        if balance <= 15:
            return 24
        if score < 100:
            if auctions_left <= 20:
                return 28
            if auctions_left <= 45:
                return 32
        return 32

    def choose_word(
        self,
        round_index: int,
        auctions_left: int,
        own: PlayerState,
        opponent: PlayerState,
    ) -> str | None:
        if auctions_left <= 2:
            words: list[str] = []
            rack = Counter(own.rack)
            while True:
                word, _reward = self.best_word_above(rack, 1, 2), 0
                if not word:
                    break
                words.append(word)
                for letter in word:
                    rack[letter] -= 1
                    if rack[letter] <= 0:
                        del rack[letter]
            return words[0] if words else None

        word = self.best_word_above(own.rack, 1, 2)
        if not word:
            return None
        reward = score_word(word)
        if reward <= 0:
            return None
        if reward >= self.cash_in_threshold(auctions_left, own.balance, own.score):
            return word
        return None

from __future__ import annotations

import pathlib
import random
import sys
from collections import Counter
from typing import Callable

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from experiments.exploit_lisan import (
    ExploitLisan,
    LETTER_VALUES,
    LisanSurrogate,
    PlayerState,
    Policy,
    WordEvMixin,
)

from lisan import BaseLisan


class AggressivePolicy(BaseLisan):
    name = "aggressive"

    def decide_bid(self, letter: str, round_index: int, auctions_left: int, own: PlayerState, opponent: PlayerState) -> int:
        base = super().decide_bid(letter, round_index, auctions_left, own, opponent)
        boost = 7 + LETTER_VALUES.get(letter, 1)
        if auctions_left <= 12:
            boost += 6
        return max(0, min(own.balance, max(base + 4, boost)))


class FrugalPolicy(BaseLisan):
    name = "frugal"

    def decide_bid(self, letter: str, round_index: int, auctions_left: int, own: PlayerState, opponent: PlayerState) -> int:
        base = super().decide_bid(letter, round_index, auctions_left, own, opponent)
        cap = max(1, int(own.balance * (0.18 if auctions_left > 12 else 0.35)))
        return max(0, min(own.balance, cap, int(base * 0.55)))


class HoarderPolicy(BaseLisan):
    name = "hoarder"

    def choose_word(self, round_index: int, auctions_left: int, own: PlayerState, opponent: PlayerState) -> str | None:
        if auctions_left <= 8 or own.balance <= 12:
            return self.best_word_above(own.rack, 1, 2)
        return self.best_word_above(own.rack, 42, 6)


class VowelHeavyPolicy(BaseLisan):
    name = "vowel-heavy"

    def decide_bid(self, letter: str, round_index: int, auctions_left: int, own: PlayerState, opponent: PlayerState) -> int:
        base = super().decide_bid(letter, round_index, auctions_left, own, opponent)
        if letter in "AEIOUY":
            base += 7
        return max(0, min(own.balance, base))


class ConsonantHeavyPolicy(BaseLisan):
    name = "consonant-heavy"

    def decide_bid(self, letter: str, round_index: int, auctions_left: int, own: PlayerState, opponent: PlayerState) -> int:
        base = super().decide_bid(letter, round_index, auctions_left, own, opponent)
        if letter not in "AEIOU":
            base += 6
        return max(0, min(own.balance, base))


class QAversePolicy(BaseLisan):
    name = "q-averse"

    def decide_bid(self, letter: str, round_index: int, auctions_left: int, own: PlayerState, opponent: PlayerState) -> int:
        if letter == "Q" and own.rack.get("U", 0) <= 0:
            return 0
        return super().decide_bid(letter, round_index, auctions_left, own, opponent)


class EndgameAllInPolicy(BaseLisan):
    name = "endgame-all-in"

    def decide_bid(self, letter: str, round_index: int, auctions_left: int, own: PlayerState, opponent: PlayerState) -> int:
        if auctions_left <= 10 and letter != "Q":
            return own.balance
        return super().decide_bid(letter, round_index, auctions_left, own, opponent)


class LowBankrollSaverPolicy(BaseLisan):
    name = "low-bankroll-saver"

    def decide_bid(self, letter: str, round_index: int, auctions_left: int, own: PlayerState, opponent: PlayerState) -> int:
        base = super().decide_bid(letter, round_index, auctions_left, own, opponent)
        if own.balance <= 35 and auctions_left > 8:
            base = min(base, max(1, int(own.balance * 0.22)))
        return max(0, min(own.balance, base))


class RandomNoisyPolicy(BaseLisan):
    name = "random-noisy"

    def __init__(self, seed: int = 991) -> None:
        super().__init__()
        self.rng = random.Random(seed)

    def decide_bid(self, letter: str, round_index: int, auctions_left: int, own: PlayerState, opponent: PlayerState) -> int:
        base = super().decide_bid(letter, round_index, auctions_left, own, opponent)
        noisy = base + self.rng.randint(-5, 8)
        return max(0, min(own.balance, noisy))


class WordEvMaxPolicy(Policy, WordEvMixin):
    name = "word-ev-max"

    def decide_bid(self, letter: str, round_index: int, auctions_left: int, own: PlayerState, opponent: PlayerState) -> int:
        ev = self.marginal_reward(Counter(own.rack), letter)
        bid = max(ev, LETTER_VALUES.get(letter, 1) + 4)
        if auctions_left > 16:
            bid = min(bid, int(own.balance * 0.42))
        return max(0, min(own.balance, bid))

    def choose_word(self, round_index: int, auctions_left: int, own: PlayerState, opponent: PlayerState) -> str | None:
        threshold = 10 if auctions_left <= 12 else 24
        return self.best_word_above(own.rack, threshold, 2)


def opponent_factories() -> dict[str, Callable[[], Policy]]:
    return {
        "base-lisan": BaseLisan,
        "lisan-surrogate": LisanSurrogate,
        "exploit-lisan": ExploitLisan,
        "aggressive": AggressivePolicy,
        "frugal": FrugalPolicy,
        "hoarder": HoarderPolicy,
        "vowel-heavy": VowelHeavyPolicy,
        "consonant-heavy": ConsonantHeavyPolicy,
        "q-averse": QAversePolicy,
        "endgame-all-in": EndgameAllInPolicy,
        "low-bankroll-saver": LowBankrollSaverPolicy,
        "random-noisy": RandomNoisyPolicy,
        "word-ev-max": WordEvMaxPolicy,
    }

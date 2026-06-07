from __future__ import annotations

import pathlib
import sys
from collections import Counter

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from experiments.exploit_lisan import PlayerState
from experiments.live_lisan import LiveLisan


class BaseLisan(LiveLisan):
    name = "base-lisan"


class LisanVisibleEvFloor(BaseLisan):
    name = "lisan-visible-ev-floor"

    def __init__(self) -> None:
        super().__init__()
        self.last_base_bid = 0
        self.last_opponent_visible_ev = 0
        self.last_floor_activated = False
        self.last_floor_over_cap = False

    def decide_bid(
        self,
        letter: str,
        round_index: int,
        auctions_left: int,
        own: PlayerState,
        opponent: PlayerState,
    ) -> int:
        base_bid = super().decide_bid(letter, round_index, auctions_left, own, opponent)
        visible_rack = Counter(opponent.rack)
        opponent_ev = self.marginal_reward(visible_rack, letter)
        bid = max(base_bid, opponent_ev)
        final_bid = max(0, min(own.balance, int(bid)))

        self.last_base_bid = base_bid
        self.last_opponent_visible_ev = opponent_ev
        self.last_floor_activated = final_bid > base_bid
        self.last_floor_over_cap = opponent_ev > base_bid and final_bid > base_bid
        return final_bid


class LisanCappedVisibleEvFloor(BaseLisan):
    name = "lisan-capped-visible-ev-floor"

    def __init__(self, cap: int) -> None:
        super().__init__()
        self.cap = cap
        self.last_base_bid = 0
        self.last_opponent_visible_ev = 0
        self.last_floor_activated = False
        self.last_floor_over_cap = False

    def decide_bid(
        self,
        letter: str,
        round_index: int,
        auctions_left: int,
        own: PlayerState,
        opponent: PlayerState,
    ) -> int:
        base_bid = super().decide_bid(letter, round_index, auctions_left, own, opponent)
        visible_rack = Counter(opponent.rack)
        opponent_ev = self.marginal_reward(visible_rack, letter)
        floored_bid = max(base_bid, opponent_ev)
        capped_bid = min(floored_bid, base_bid + self.cap)
        final_bid = max(0, min(own.balance, int(capped_bid)))

        self.last_base_bid = base_bid
        self.last_opponent_visible_ev = opponent_ev
        self.last_floor_activated = final_bid > base_bid
        self.last_floor_over_cap = opponent_ev > base_bid and final_bid > base_bid
        return final_bid


class LisanAdditiveVisibleEvCap(BaseLisan):
    name = "lisan-additive-visible-ev-cap"

    def __init__(self, cap: int) -> None:
        super().__init__()
        self.cap = cap
        self.last_base_bid = 0
        self.last_opponent_visible_ev = 0
        self.last_floor_activated = False
        self.last_floor_over_cap = False

    def decide_bid(
        self,
        letter: str,
        round_index: int,
        auctions_left: int,
        own: PlayerState,
        opponent: PlayerState,
    ) -> int:
        base_bid = super().decide_bid(letter, round_index, auctions_left, own, opponent)
        visible_rack = Counter(opponent.rack)
        opponent_ev = self.marginal_reward(visible_rack, letter)
        denial_bid = min(max(0, opponent_ev), self.cap)
        final_bid = max(0, min(own.balance, int(base_bid + denial_bid)))

        self.last_base_bid = base_bid
        self.last_opponent_visible_ev = opponent_ev
        self.last_floor_activated = final_bid > base_bid
        self.last_floor_over_cap = opponent_ev > 0 and final_bid > base_bid
        return final_bid

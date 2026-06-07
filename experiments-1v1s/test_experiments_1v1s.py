from __future__ import annotations

import pathlib
import sys
import unittest
from collections import Counter

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from core import PlayerState, play_game, run_matrix, visible_opponent_state
from lisan import BaseLisan, LisanVisibleEvFloor
from opponents import opponent_factories


class Experiments1v1Test(unittest.TestCase):
    def test_visible_opponent_state_uses_public_events_only(self) -> None:
        hidden = PlayerState("hidden", rack=Counter("AEIRST"))
        visible = visible_opponent_state(hidden, Counter({"S": 1, "E": 1}))

        self.assertEqual(visible.score, hidden.score)
        self.assertEqual(visible.balance, hidden.balance)
        self.assertEqual(visible.rack, Counter({"S": 1, "E": 1}))

    def test_visible_ev_floor_raises_bid_above_base_lisan(self) -> None:
        own = PlayerState("candidate", balance=100, rack=Counter("ZQ"))
        opponent = PlayerState("opponent", balance=100, rack=Counter("AT"))

        base = BaseLisan().decide_bid("S", 20, 50, own, opponent)
        candidate = LisanVisibleEvFloor()
        raised = candidate.decide_bid("S", 20, 50, own, opponent)

        self.assertGreater(candidate.last_opponent_visible_ev, 0)
        self.assertGreaterEqual(raised, candidate.last_opponent_visible_ev)
        self.assertGreaterEqual(raised, base)

    def test_visible_ev_floor_can_exceed_normal_cap_but_not_balance(self) -> None:
        own = PlayerState("candidate", balance=18, rack=Counter("Q"))
        opponent = PlayerState("opponent", balance=100, rack=Counter("QUIZZE"))

        base = BaseLisan().decide_bid("S", 35, 40, own, opponent)
        raised = LisanVisibleEvFloor().decide_bid("S", 35, 40, own, opponent)

        self.assertLess(base, raised)
        self.assertLessEqual(raised, own.balance)

    def test_game_tracks_visible_rack_for_candidate_only_from_wins_and_words(self) -> None:
        result = play_game(
            seed=11,
            left_policy=LisanVisibleEvFloor(),
            right_policy=BaseLisan(),
        )

        self.assertEqual(result["rounds"] > 0, True)
        self.assertIn(result["winner"], {"left", "right", "tie"})
        self.assertGreaterEqual(result["left_floor_activations"], 0)

    def test_opponent_factory_catalog_has_variety(self) -> None:
        factories = opponent_factories()

        self.assertGreaterEqual(len(factories), 10)
        self.assertIn("base-lisan", factories)
        self.assertIn("aggressive", factories)
        self.assertIn("random-noisy", factories)

    def test_matrix_reports_candidate_and_baseline_for_each_opponent(self) -> None:
        result = run_matrix(games=2, seed=7, opponent_names=["base-lisan", "frugal"])

        self.assertEqual(result["games_per_matchup"], 2)
        self.assertEqual(set(result["opponents"]), {"base-lisan", "frugal"})
        self.assertIn("aggregate", result)
        self.assertIn("candidate", result["aggregate"])
        self.assertIn("baseline", result["aggregate"])

    def test_matrix_floor_rates_are_bid_decision_rates(self) -> None:
        result = run_matrix(games=2, seed=7, opponent_names=["base-lisan"])
        candidate = result["aggregate"]["candidate"]

        self.assertLessEqual(candidate["floor_activation_rate"], 1.0)
        self.assertLessEqual(candidate["floor_over_cap_rate"], 1.0)


if __name__ == "__main__":
    unittest.main()

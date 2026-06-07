import unittest
from collections import Counter

from experiments.exploit_lisan import ExploitLisan, PlayerState
from experiments.live_lisan import LiveLisan
from experiments.professor_model import (
    ProfessorConfig,
    TheProfessor,
    play_multiplayer_game,
    run_multiplayer_series,
    tuned_professor_config,
    tuned_six_player_config,
)


class ProfessorModelTest(unittest.TestCase):
    def test_professor_is_named_for_live_play(self):
        self.assertEqual(TheProfessor({}).name, "the-professor")

    def test_tuned_config_is_conservative_but_can_raise(self):
        config = tuned_professor_config()

        self.assertTrue(config.allow_bid_raises)
        self.assertLessEqual(config.max_bid_delta, 2)
        self.assertGreaterEqual(config.min_improvement, 0.18)

    def test_six_player_tuned_config_is_stricter(self):
        one_config = tuned_professor_config()
        six_config = tuned_six_player_config()

        self.assertTrue(six_config.allow_bid_raises)
        self.assertLess(six_config.max_bid_delta, one_config.max_bid_delta)
        self.assertGreater(six_config.min_improvement, one_config.min_improvement)
        self.assertLess(six_config.max_variance, one_config.max_variance)

    def test_professor_ignores_low_confidence_override(self):
        own = PlayerState("the-professor", balance=80, score=0, rack=Counter("AEIRST"))
        opp = PlayerState("live", balance=80, score=0, rack=Counter("AEIOU"))
        baseline = LiveLisan().decide_bid("E", 20, 50, own, opp)
        professor = TheProfessor(
            {
                "rs1|E|t1|b4|sg0": {
                    "bid": 80,
                    "live_bid": baseline,
                    "best_ev": 0.55,
                    "live_ev": 0.54,
                    "improvement": 0.01,
                    "visits": 100,
                    "variance": 0.02,
                }
            },
            key_mode="unit",
            config=ProfessorConfig(
                min_improvement=0.05,
                min_visits=20,
                allow_bid_raises=True,
                max_bid_delta=10,
            ),
        )

        self.assertEqual(professor.decide_bid("E", 20, 50, own, opp), baseline)

    def test_professor_applies_confident_safe_override(self):
        own = PlayerState("the-professor", balance=80, score=0, rack=Counter("AEIRST"))
        opp = PlayerState("live", balance=80, score=0, rack=Counter("AEIOU"))
        professor = TheProfessor(
            {
                "rs1|E|t1|b4|sg0": {
                    "bid": 18,
                    "live_bid": 11,
                    "best_ev": 0.68,
                    "live_ev": 0.52,
                    "improvement": 0.16,
                    "visits": 100,
                    "variance": 0.01,
                }
            },
            key_mode="unit",
            config=ProfessorConfig(
                min_improvement=0.05,
                min_visits=20,
                allow_bid_raises=True,
                max_bid_delta=10,
            ),
        )

        self.assertEqual(professor.decide_bid("E", 20, 50, own, opp), 18)

    def test_six_player_harness_scores_all_players(self):
        result = play_multiplayer_game(
            seed=7,
            policy_factories=[
                lambda: TheProfessor({}),
                LiveLisan,
                LiveLisan,
                ExploitLisan,
                LiveLisan,
                ExploitLisan,
            ],
        )

        self.assertEqual(len(result["players"]), 6)
        self.assertIn("the-professor", [p["name"] for p in result["players"]])
        self.assertGreaterEqual(result["professor_rank"], 1)
        self.assertLessEqual(result["professor_rank"], 6)

    def test_multiplayer_series_reports_professor_top_rate(self):
        result = run_multiplayer_series(
            games=4,
            seed=11,
            professor_factory=lambda: TheProfessor({}),
            field_factories=[LiveLisan, LiveLisan, ExploitLisan, LiveLisan, ExploitLisan],
        )

        self.assertEqual(result["games"], 4)
        self.assertIn("professor_top1_rate", result)
        self.assertIn("professor_avg_rank", result)


if __name__ == "__main__":
    unittest.main()

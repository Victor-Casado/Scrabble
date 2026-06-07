import tempfile
import unittest
from pathlib import Path

from experiments.mcmc_precompute import load_table
from experiments.six_mcmc_precompute import (
    build_six_mcmc_table,
    placement_utility,
    write_table,
)


class SixMcmcPrecomputeTest(unittest.TestCase):
    def test_rank_utility_rewards_solid_six_player_placement(self):
        self.assertGreater(placement_utility(1, "rank"), placement_utility(2, "rank"))
        self.assertGreater(placement_utility(3, "rank"), placement_utility(4, "rank"))
        self.assertGreater(placement_utility(4, "rank"), placement_utility(6, "rank"))
        self.assertEqual(placement_utility(4, "top3"), 0.0)
        self.assertEqual(placement_utility(2, "win"), 0.0)

    def test_builds_six_player_mcmc_table(self):
        table = build_six_mcmc_table(
            states=2,
            rollouts=2,
            seed=123,
            key_mode="livecommon",
            workers=1,
            utility="rank",
        )

        self.assertGreaterEqual(len(table), 1)
        for entry in table.values():
            self.assertIn("bid", entry)
            self.assertIn("live_bid", entry)
            self.assertIn("improvement", entry)
            self.assertEqual(entry["visits"], 2)

    def test_write_table_is_loadable_by_shared_loader(self):
        table = build_six_mcmc_table(
            states=1,
            rollouts=1,
            seed=456,
            key_mode="livecommon",
            workers=1,
            utility="rank",
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "six.json"
            write_table(table, path)
            self.assertEqual(load_table(path), table)


if __name__ == "__main__":
    unittest.main()

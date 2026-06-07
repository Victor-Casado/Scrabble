import tempfile
import unittest
from collections import Counter
from pathlib import Path

from experiments.exploit_lisan import ExploitLisan, PlayerState
from experiments.live_lisan import LiveLisan
from experiments.mcmc_precompute import (
    McmcTablePolicy,
    build_mcmc_table,
    load_table,
    state_key,
    write_table,
)


class McmcPrecomputeTest(unittest.TestCase):
    def test_state_key_buckets_live_decision_state(self):
        own = PlayerState("live", balance=63, score=80, rack=Counter("AEIRST"))
        opp = PlayerState("opp", balance=19, score=101, rack=Counter("QZ"))

        key = state_key("E", 31, 42, own, opp)

        self.assertEqual(key, "A1E1I1R1S1T1|E|t2|b3|ob1|sg-2")

    def test_build_write_and_load_sparse_mcmc_table(self):
        table = build_mcmc_table(
            states=3,
            rollouts=3,
            seed=99,
            live_factory=LiveLisan,
            opponent_factory=ExploitLisan,
        )

        self.assertGreaterEqual(len(table), 1)
        for entry in table.values():
            self.assertIn("bid", entry)
            self.assertIn("visits", entry)
            self.assertGreater(entry["visits"], 0)

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "table.json"
            write_table(table, path)
            self.assertEqual(load_table(path), table)

    def test_table_policy_overrides_bid_and_falls_back(self):
        own = PlayerState("live", balance=63, score=80, rack=Counter("AEIRST"))
        opp = PlayerState("opp", balance=19, score=101, rack=Counter("QZ"))
        key = state_key("E", 31, 42, own, opp)
        policy = McmcTablePolicy(
            {key: {"bid": 17, "visits": 4, "ev": 0.8}},
            key_mode="exact",
        )

        self.assertEqual(policy.decide_bid("E", 31, 42, own, opp), 17)
        self.assertEqual(
            policy.decide_bid("Q", 31, 42, own, opp),
            LiveLisan().decide_bid("Q", 31, 42, own, opp),
        )


if __name__ == "__main__":
    unittest.main()

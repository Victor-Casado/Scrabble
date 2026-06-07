import unittest

from experiments.evaluate_professor import parse_seeds, run_professor_eval


class EvaluateProfessorTest(unittest.TestCase):
    def test_parse_seeds_ignores_empty_parts(self):
        self.assertEqual(parse_seeds("1, 2,,3"), (1, 2, 3))

    def test_run_professor_eval_reports_aggregate(self):
        result = run_professor_eval(games=1, seeds=(101,))

        self.assertIn("rows", result)
        self.assertIn("aggregate", result)
        self.assertEqual(result["aggregate"]["games"], 1)
        self.assertIn("one_v_one_candidate", result["aggregate"])
        self.assertIn("six_candidate_avg_rank", result["aggregate"])


if __name__ == "__main__":
    unittest.main()

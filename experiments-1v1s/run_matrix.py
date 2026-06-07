from __future__ import annotations

import argparse
import json
from pathlib import Path

from core import run_matrix, write_outputs
from opponents import opponent_factories


def main() -> None:
    parser = argparse.ArgumentParser(description="Run 1v1 Lisan visible-EV-floor experiment matrix.")
    parser.add_argument("--games", type=int, default=500)
    parser.add_argument("--seed", type=int, default=20260607)
    parser.add_argument("--opponents", nargs="*", choices=sorted(opponent_factories()))
    parser.add_argument("--out", type=Path, default=Path("experiments-1v1s/results.json"))
    parser.add_argument("--csv", type=Path)
    args = parser.parse_args()

    result = run_matrix(args.games, args.seed, args.opponents)
    write_outputs(result, args.out, args.csv)
    print(json.dumps(result["aggregate"], indent=2))


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Iterable

import numpy as np

from backend.training.evaluation import _bootstrap_difference


def refresh(path: Path, repetitions: int) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    seed = int(payload["evaluation"]["seed"])
    baseline = np.asarray(
        payload["methods"]["mean_centered_userknn"][
            "per_user_ndcg@10"
        ]
    )
    comparisons = (
        (
            "surprise_weighted_userknn",
            "surprise_vs_mean_centered_ndcg@10",
        ),
        (
            "biased_matrix_factorization",
            "biased_mf_vs_mean_centered_ndcg@10",
        ),
    )
    for method, key in comparisons:
        if method not in payload["methods"]:
            continue
        challenger = np.asarray(
            payload["methods"][method]["per_user_ndcg@10"]
        )
        result = _bootstrap_difference(
            challenger,
            baseline,
            seed=seed,
            repetitions=repetitions,
        )
        baseline_mean = payload["methods"]["mean_centered_userknn"][
            "aggregate"
        ]["ndcg@10"]
        result["relative_change"] = (
            result["mean"] / baseline_mean if baseline_mean else None
        )
        payload[key] = result
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return payload


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Recompute paired bootstrap intervals in an evaluation."
    )
    result.add_argument("evaluation", type=Path)
    result.add_argument("--repetitions", type=int, default=10_000)
    return result


def main(arguments: Iterable[str] | None = None) -> None:
    args = parser().parse_args(arguments)
    payload = refresh(args.evaluation, args.repetitions)
    print(
        json.dumps(
            {
                key: value
                for key, value in payload.items()
                if key.endswith("ndcg@10")
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

import numpy as np

from backend.production_recommender import DiskBackedUserKNN
from backend.training.evaluation import _build_cases


def calibrate(
    artifact_directory: Path,
    users: int,
    seed: int,
    candidates_per_user: int,
    overlap_min: int,
    shrinkage: float,
    neighbor_count: int,
    uncertainty_penalty: float,
    min_support: int,
    similarity_mode: str,
    surprise_mix: float,
) -> dict:
    model = DiskBackedUserKNN(
        artifact_directory,
        similarity_mode=similarity_mode,
        overlap_min=overlap_min,
        shrinkage=shrinkage,
        neighbor_count=neighbor_count,
        uncertainty_penalty=uncertainty_penalty,
        surprise_mix=surprise_mix,
        ranking_mode="residual",
    )
    cases = _build_cases(
        model,
        requested_users=users,
        seed=seed,
        minimum_profile_ratings=50,
        holdout_fraction=0.2,
        maximum_holdout=20,
    )
    scores = []
    for position, case in enumerate(cases, start=1):
        recommendations = model.recommend(
            case.profile,
            limit=candidates_per_user,
            excluded_user_indices={case.user_idx},
            min_support=min_support,
        )
        scores.extend(
            float(record["rank_score"]) for record in recommendations
        )
        if position % 25 == 0 or position == len(cases):
            print(f"[{position}/{len(cases)}]", flush=True)
    if len(scores) < users * 20:
        raise RuntimeError("校准候选数量不足。")

    percentiles = np.arange(1, 100, dtype=np.float32)
    score_knots = np.quantile(
        np.asarray(scores, dtype=np.float64),
        percentiles / 100,
    ).astype(np.float32)
    output = artifact_directory / "affinity_calibration.npz"
    temporary_output = output.with_suffix(".npz.tmp")
    np.savez(
        temporary_output,
        score_knots=score_knots,
        affinity_knots=percentiles,
    )
    generated_temporary_output = temporary_output.with_suffix(".tmp.npz")
    if generated_temporary_output.exists():
        temporary_output = generated_temporary_output
    temporary_output.replace(output)
    report = {
        "created_at": datetime.now(UTC).isoformat(),
        "method": "empirical percentile of held-out query rank scores",
        "users": users,
        "seed": seed,
        "candidates_per_user": candidates_per_user,
        "parameters": {
            "overlap_min": overlap_min,
            "shrinkage": shrinkage,
            "neighbor_count": neighbor_count,
            "uncertainty_penalty": uncertainty_penalty,
            "min_support": min_support,
            "similarity_mode": similarity_mode,
            "surprise_mix": surprise_mix,
            "ranking_mode": "residual",
        },
        "observations": len(scores),
        "minimum_score": min(scores),
        "median_score": float(np.median(scores)),
        "maximum_score": max(scores),
        "output": str(output.resolve()),
    }
    report_output = artifact_directory / "affinity_calibration.json"
    temporary_report = report_output.with_suffix(".json.tmp")
    temporary_report.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary_report.replace(report_output)
    return report


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Calibrate affinity as a held-out score percentile."
    )
    result.add_argument("artifact_directory", type=Path)
    result.add_argument("--users", type=int, default=500)
    result.add_argument("--seed", type=int, default=20260727)
    result.add_argument("--candidates-per-user", type=int, default=100)
    result.add_argument("--overlap-min", type=int, default=10)
    result.add_argument("--shrinkage", type=float, default=25.0)
    result.add_argument("--neighbor-count", type=int, default=100)
    result.add_argument("--uncertainty-penalty", type=float, default=0.25)
    result.add_argument("--min-support", type=int, default=5)
    result.add_argument(
        "--similarity-mode",
        choices=("mean_centered", "surprise"),
        default="mean_centered",
    )
    result.add_argument("--surprise-mix", type=float, default=0.5)
    return result


def main(arguments: Iterable[str] | None = None) -> None:
    args = parser().parse_args(arguments)
    report = calibrate(
        args.artifact_directory,
        users=args.users,
        seed=args.seed,
        candidates_per_user=args.candidates_per_user,
        overlap_min=args.overlap_min,
        shrinkage=args.shrinkage,
        neighbor_count=args.neighbor_count,
        uncertainty_penalty=args.uncertainty_penalty,
        min_support=args.min_support,
        similarity_mode=args.similarity_mode,
        surprise_mix=args.surprise_mix,
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

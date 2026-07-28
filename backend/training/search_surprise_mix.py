from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

import numpy as np

from backend.production_recommender import DiskBackedUserKNN
from backend.training.evaluation import _build_cases, _metrics


def search(
    artifact_directory: Path,
    output: Path,
    users: int,
    seed: int,
    overlap_min: int,
    shrinkage: float,
    neighbor_count: int,
    uncertainty_penalty: float,
    min_support: int,
) -> dict:
    mixes = (0.0, 0.25, 0.5, 0.75, 1.0)
    models = {
        mix: DiskBackedUserKNN(
            artifact_directory,
            similarity_mode="surprise",
            surprise_mix=mix,
            overlap_min=overlap_min,
            shrinkage=shrinkage,
            neighbor_count=neighbor_count,
            uncertainty_penalty=uncertainty_penalty,
            ranking_mode="residual",
        )
        for mix in mixes
    }
    case_model = models[0.5]
    cases = _build_cases(
        case_model,
        requested_users=users,
        seed=seed,
        minimum_profile_ratings=50,
        holdout_fraction=0.2,
        maximum_holdout=20,
    )
    rows: dict[float, list[dict[str, float]]] = {
        mix: [] for mix in mixes
    }
    for position, case in enumerate(cases, start=1):
        for mix, model in models.items():
            records = model.recommend(
                case.profile,
                limit=20,
                min_support=min_support,
                excluded_user_indices={case.user_idx},
            )
            recommended = [
                model._mal_to_item[int(record["anime"]["mal_id"])]
                for record in records
            ]
            rows[mix].append(
                _metrics(
                    recommended,
                    case.relevant_item_indices,
                    case.profile_item_indices,
                )
            )
        print(f"[{position}/{len(cases)}]", flush=True)

    results = []
    for mix, metric_rows in rows.items():
        results.append(
            {
                "surprise_mix": mix,
                "ndcg@10": float(
                    np.mean([row["ndcg@10"] for row in metric_rows])
                ),
                "recall@20": float(
                    np.mean([row["recall@20"] for row in metric_rows])
                ),
                "hitrate@10": float(
                    np.mean([row["hitrate@10"] for row in metric_rows])
                ),
            }
        )
    results.sort(
        key=lambda row: (
            row["ndcg@10"],
            row["recall@20"],
            row["hitrate@10"],
        ),
        reverse=True,
    )
    report = {
        "created_at": datetime.now(UTC).isoformat(),
        "artifact": str(artifact_directory.resolve()),
        "validation_users": users,
        "seed": seed,
        "parameters": {
            "overlap_min": overlap_min,
            "shrinkage": shrinkage,
            "neighbor_count": neighbor_count,
            "uncertainty_penalty": uncertainty_penalty,
            "min_support": min_support,
            "ranking_mode": "residual",
        },
        "selected": results[0],
        "results": results,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_suffix(output.suffix + ".tmp")
    temporary_output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary_output.replace(output)
    return report


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Search the IUF/event-surprise blending coefficient."
    )
    result.add_argument("artifact_directory", type=Path)
    result.add_argument("--output", required=True, type=Path)
    result.add_argument("--users", type=int, default=100)
    result.add_argument("--seed", type=int, default=20260727)
    result.add_argument("--overlap-min", type=int, default=20)
    result.add_argument("--shrinkage", type=float, default=10.0)
    result.add_argument("--neighbor-count", type=int, default=50)
    result.add_argument("--uncertainty-penalty", type=float, default=0.5)
    result.add_argument("--min-support", type=int, default=15)
    return result


def main(arguments: Iterable[str] | None = None) -> None:
    args = parser().parse_args(arguments)
    report = search(
        artifact_directory=args.artifact_directory,
        output=args.output,
        users=args.users,
        seed=args.seed,
        overlap_min=args.overlap_min,
        shrinkage=args.shrinkage,
        neighbor_count=args.neighbor_count,
        uncertainty_penalty=args.uncertainty_penalty,
        min_support=args.min_support,
    )
    print(json.dumps(report["selected"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

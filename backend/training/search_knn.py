from __future__ import annotations

import argparse
import itertools
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

import numpy as np

from backend.production_recommender import DiskBackedUserKNN
from backend.training.evaluation import _build_cases, _metrics


def _neighbor_statistics(
    model: DiskBackedUserKNN,
    profile: dict[int, float],
    excluded_user_idx: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    target_items, _ = model._target(profile)
    target_ratings = np.fromiter(
        (profile[int(model.mal_ids[item])] for item in target_items),
        dtype=np.float32,
    )
    target_values = target_ratings - target_ratings.mean()
    user_count = len(model.user_ids)
    overlap = np.zeros(user_count, dtype=np.uint16)
    numerator = np.zeros(user_count, dtype=np.float32)
    left = np.zeros(user_count, dtype=np.float32)
    right = np.zeros(user_count, dtype=np.float32)
    for item, target in zip(target_items, target_values, strict=True):
        start = int(model.csc_indptr[item])
        stop = int(model.csc_indptr[item + 1])
        users = model.csc_indices[start:stop]
        values = (
            model.csc_ratings[start:stop] - model.user_rating_mean[users]
        )
        overlap[users] += 1
        numerator[users] += target * values
        left[users] += target * target
        right[users] += values * values
    eligible = (overlap >= 5) & (left > 0) & (right > 0)
    eligible[excluded_user_idx] = False
    users = np.flatnonzero(eligible)
    cosine = numerator[users] / np.sqrt(left[users] * right[users])
    positive = cosine > 0
    return users[positive], cosine[positive], overlap[users[positive]]


def _recommend(
    model: DiskBackedUserKNN,
    profile_items: set[int],
    neighbor_users: np.ndarray,
    similarities: np.ndarray,
    neighbor_count: int,
    kappa: float,
    min_support: int,
) -> list[int]:
    count = min(neighbor_count, len(neighbor_users))
    if not count:
        return []
    if count < len(neighbor_users):
        selected = np.argpartition(similarities, -count)[-count:]
        users = neighbor_users[selected]
        weights = similarities[selected]
    else:
        users = neighbor_users
        weights = similarities
    order = np.argsort(weights)[::-1]
    users = users[order]
    weights = weights[order]

    item_count = len(model.mal_ids)
    weighted_sum = np.zeros(item_count, dtype=np.float64)
    weight_sum = np.zeros(item_count, dtype=np.float64)
    square_sum = np.zeros(item_count, dtype=np.float64)
    weight_square_sum = np.zeros(item_count, dtype=np.float64)
    support = np.zeros(item_count, dtype=np.int16)
    for user, weight in zip(users, weights, strict=True):
        start = int(model.csr_indptr[user])
        stop = int(model.csr_indptr[user + 1])
        items = model.csr_indices[start:stop]
        values = model.csr_residuals[start:stop]
        weighted_sum[items] += weight * values
        weight_sum[items] += weight
        square_sum[items] += weight * values * values
        weight_square_sum[items] += weight * weight
        support[items] += 1

    eligible = (
        (support >= min_support)
        & (weight_sum > 0)
        & (model.item_counts >= 20)
        & ~model.catalog_sequels
    )
    if profile_items:
        eligible[np.fromiter(profile_items, dtype=np.int32)] = False
    estimate = np.zeros(item_count, dtype=np.float64)
    estimate[eligible] = weighted_sum[eligible] / weight_sum[eligible]
    variance = np.zeros(item_count, dtype=np.float64)
    variance[eligible] = np.maximum(
        square_sum[eligible] / weight_sum[eligible]
        - estimate[eligible] ** 2,
        0,
    )
    effective = np.zeros(item_count, dtype=np.float64)
    effective[eligible] = (
        weight_sum[eligible] ** 2
        / np.maximum(weight_square_sum[eligible], 1e-12)
    )
    eligible &= effective >= 3
    score = np.full(item_count, -np.inf, dtype=np.float64)
    score[eligible] = estimate[eligible] - kappa * np.sqrt(
        variance[eligible] / effective[eligible]
    )
    candidates = np.flatnonzero(eligible)
    count = min(20, len(candidates))
    if not count:
        return []
    selected = np.argpartition(score[candidates], -count)[-count:]
    items = candidates[selected]
    return list(map(int, items[np.argsort(score[items])[::-1]]))


def search(
    artifact_directory: Path,
    output: Path,
    users: int,
    seed: int,
) -> dict:
    model = DiskBackedUserKNN(
        artifact_directory, similarity_mode="mean_centered"
    )
    cases = _build_cases(
        model,
        requested_users=users,
        seed=seed,
        minimum_profile_ratings=50,
        holdout_fraction=0.2,
        maximum_holdout=20,
    )
    configurations = list(
        itertools.product(
            (5, 10, 20),
            (10.0, 25.0, 50.0),
            (50, 100, 200),
            (0.0, 0.25, 0.5),
            (5, 10, 15),
        )
    )
    rows = {configuration: [] for configuration in configurations}
    for position, case in enumerate(cases, start=1):
        candidate_users, cosine, overlap = _neighbor_statistics(
            model, case.profile, case.user_idx
        )
        for (
            overlap_min,
            shrinkage,
            neighbor_count,
            kappa,
            min_support,
        ) in configurations:
            eligible = overlap >= overlap_min
            users_for_config = candidate_users[eligible]
            similarity = cosine[eligible] * (
                overlap[eligible] / (overlap[eligible] + shrinkage)
            )
            recommended = _recommend(
                model,
                case.profile_item_indices,
                users_for_config,
                similarity,
                neighbor_count,
                kappa,
                min_support,
            )
            rows[
                (
                    overlap_min,
                    shrinkage,
                    neighbor_count,
                    kappa,
                    min_support,
                )
            ].append(
                _metrics(
                    recommended,
                    case.relevant_item_indices,
                    case.profile_item_indices,
                )
            )
        print(f"[{position}/{len(cases)}]", flush=True)

    results = []
    for configuration, metric_rows in rows.items():
        (
            overlap_min,
            shrinkage,
            neighbor_count,
            kappa,
            min_support,
        ) = configuration
        results.append(
            {
                "overlap_min": overlap_min,
                "shrinkage": shrinkage,
                "neighbor_count": neighbor_count,
                "uncertainty_penalty": kappa,
                "min_support": min_support,
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
        "configuration_count": len(results),
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
        description="Search mean-centered UserKNN parameters."
    )
    result.add_argument("artifact_directory", type=Path)
    result.add_argument("--output", required=True, type=Path)
    result.add_argument("--users", type=int, default=100)
    result.add_argument("--seed", type=int, default=20260726)
    return result


def main(arguments: Iterable[str] | None = None) -> None:
    args = parser().parse_args(arguments)
    report = search(
        args.artifact_directory,
        args.output,
        users=args.users,
        seed=args.seed,
    )
    print(json.dumps(report["selected"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

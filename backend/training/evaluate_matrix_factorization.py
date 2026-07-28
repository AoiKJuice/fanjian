from __future__ import annotations

import argparse
import json
import time
from pathlib import Path
from typing import Iterable

import numpy as np
import torch

from backend.production_recommender import DiskBackedUserKNN
from backend.training.evaluation import (
    _aggregate,
    _bootstrap_difference,
    _build_cases,
    _metrics,
)


def _recommend(
    item_factors: np.ndarray,
    item_bias: np.ndarray,
    global_mean: float,
    item_counts: np.ndarray,
    profile_items: np.ndarray,
    profile_ratings: np.ndarray,
    limit: int = 20,
) -> list[int]:
    factors = item_factors[profile_items].astype(np.float64)
    target = (
        profile_ratings.astype(np.float64)
        - global_mean
        - item_bias[profile_items]
    )
    design = np.column_stack(
        [np.ones(len(profile_items), dtype=np.float64), factors]
    )
    regularization = np.eye(design.shape[1], dtype=np.float64)
    regularization[0, 0] = 10.0
    regularization[1:, 1:] *= 0.1
    coefficients = np.linalg.solve(
        design.T @ design + regularization,
        design.T @ target,
    )
    scores = (
        global_mean
        + coefficients[0]
        + item_bias
        + item_factors @ coefficients[1:]
    )
    eligible = item_counts >= 20
    eligible[profile_items] = False
    candidates = np.flatnonzero(eligible)
    count = min(limit, len(candidates))
    selected = np.argpartition(scores[candidates], -count)[-count:]
    selected_items = candidates[selected]
    return list(
        map(int, selected_items[np.argsort(scores[selected_items])[::-1]])
    )


def evaluate_matrix_factorization(
    artifact_directory: Path,
    checkpoint_path: Path,
    base_evaluation_path: Path,
    output: Path,
) -> dict:
    base = json.loads(
        base_evaluation_path.read_text(encoding="utf-8")
    )
    checkpoint = torch.load(
        checkpoint_path, map_location="cpu", weights_only=False
    )
    metadata = checkpoint["metadata"]
    state = checkpoint["state_dict"]
    item_factors = state["item_factors.weight"].numpy()
    item_bias = state["item_bias.weight"].numpy().reshape(-1)
    global_mean = float(metadata["global_mean"])

    model = DiskBackedUserKNN(
        artifact_directory, similarity_mode="mean_centered"
    )
    if len(item_factors) < len(model.mal_ids):
        missing = len(model.mal_ids) - len(item_factors)
        item_factors = np.pad(
            item_factors, ((0, missing), (0, 0)), constant_values=0
        )
        item_bias = np.pad(
            item_bias, (0, missing), constant_values=0
        )
    if len(item_factors) != len(model.mal_ids):
        raise ValueError("MF 作品参数数量与目录不一致。")
    evaluation = base["evaluation"]
    cases = _build_cases(
        model,
        requested_users=int(evaluation["users"]),
        seed=int(evaluation["seed"]),
        minimum_profile_ratings=int(
            evaluation["minimum_profile_ratings_before_split"]
        ),
        holdout_fraction=0.2,
        maximum_holdout=20,
    )
    case_indices = [case.user_idx for case in cases]
    if case_indices != metadata["excluded_evaluation_users"]:
        raise ValueError(
            "MF 训练排除用户与评测用户不一致，拒绝生成有泄漏的指标。"
        )

    rows = []
    recommendations = []
    timings = []
    for position, case in enumerate(cases, start=1):
        profile_mal_ids = np.fromiter(
            case.profile.keys(), dtype=np.int64
        )
        profile_items = np.fromiter(
            (model._mal_to_item[int(mal_id)] for mal_id in profile_mal_ids),
            dtype=np.int32,
        )
        profile_ratings = np.fromiter(
            case.profile.values(), dtype=np.float32
        )
        started = time.perf_counter()
        recommended = _recommend(
            item_factors,
            item_bias,
            global_mean,
            np.asarray(model.item_counts),
            profile_items,
            profile_ratings,
        )
        timings.append(time.perf_counter() - started)
        recommendations.append(recommended)
        rows.append(
            _metrics(
                recommended,
                case.relevant_item_indices,
                case.profile_item_indices,
            )
        )
        if position % 25 == 0 or position == len(cases):
            print(f"[{position}/{len(cases)}]", flush=True)

    method = _aggregate(
        rows,
        recommendations,
        [case.popularity_segment for case in cases],
        model,
    )
    timing_values = np.asarray(timings)
    method["timing_seconds"] = {
        "median": float(np.median(timing_values)),
        "p95": float(np.quantile(timing_values, 0.95)),
    }
    method["training"] = {
        "epochs": metadata["epochs"],
        "rank": metadata["rank"],
        "training_rmse": metadata["epoch_reports"][-1]["training_rmse"],
        "training_seconds": metadata["total_seconds"],
        "training_ratings": metadata["training_ratings"],
        "gpu": metadata["gpu"],
    }
    base["methods"]["biased_matrix_factorization"] = method
    baseline_values = np.asarray(
        base["methods"]["mean_centered_userknn"]["per_user_ndcg@10"]
    )
    mf_values = np.asarray(method["per_user_ndcg@10"])
    difference = _bootstrap_difference(
        mf_values,
        baseline_values,
        seed=int(evaluation["seed"]),
    )
    baseline_ndcg = base["methods"]["mean_centered_userknn"][
        "aggregate"
    ]["ndcg@10"]
    difference["relative_change"] = (
        difference["mean"] / baseline_ndcg if baseline_ndcg else None
    )
    base["biased_mf_vs_mean_centered_ndcg@10"] = difference
    output.write_text(
        json.dumps(base, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return base


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Evaluate a trained biased MF on the shared held-out users."
    )
    result.add_argument("artifact_directory", type=Path)
    result.add_argument("checkpoint", type=Path)
    result.add_argument("base_evaluation", type=Path)
    result.add_argument("--output", required=True, type=Path)
    return result


def main(arguments: Iterable[str] | None = None) -> None:
    args = parser().parse_args(arguments)
    result = evaluate_matrix_factorization(
        artifact_directory=args.artifact_directory,
        checkpoint_path=args.checkpoint,
        base_evaluation_path=args.base_evaluation,
        output=args.output,
    )
    print(
        json.dumps(
            {
                "output": str(args.output.resolve()),
                "biased_matrix_factorization": result["methods"][
                    "biased_matrix_factorization"
                ],
                "comparison": result[
                    "biased_mf_vs_mean_centered_ndcg@10"
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()

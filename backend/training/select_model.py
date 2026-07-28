from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable


def _relative_change(challenger: float, baseline: float) -> float | None:
    return (challenger - baseline) / baseline if baseline else None


def select_model(evaluation_path: Path, output: Path) -> dict:
    evaluation = json.loads(evaluation_path.read_text(encoding="utf-8"))
    methods = evaluation["methods"]
    baseline = methods["mean_centered_userknn"]
    challenger = methods["surprise_weighted_userknn"]
    comparison = evaluation["surprise_vs_mean_centered_ndcg@10"]

    baseline_ndcg = baseline["aggregate"]["ndcg@10"]
    challenger_ndcg = challenger["aggregate"]["ndcg@10"]
    ndcg_relative = _relative_change(challenger_ndcg, baseline_ndcg)
    baseline_long_tail = baseline["aggregate"]["long_tail_coverage"]
    challenger_long_tail = challenger["aggregate"]["long_tail_coverage"]
    long_tail_relative = _relative_change(
        challenger_long_tail, baseline_long_tail
    )
    baseline_low_pop = baseline["segments"]["LowPop"]["ndcg@10"]
    challenger_low_pop = challenger["segments"]["LowPop"]["ndcg@10"]
    low_pop_relative = _relative_change(
        challenger_low_pop, baseline_low_pop
    )

    accuracy_win = bool(
        ndcg_relative is not None
        and ndcg_relative >= 0.02
        and comparison["ci95_lower"] > 0
    )
    long_tail_tradeoff = bool(
        ndcg_relative is not None
        and ndcg_relative >= -0.01
        and long_tail_relative is not None
        and long_tail_relative >= 0.15
    )
    low_pop_guard = bool(
        low_pop_relative is not None and low_pop_relative >= -0.02
    )
    select_surprise = (accuracy_win or long_tail_tradeoff) and low_pop_guard
    selected = (
        "surprise_weighted_userknn"
        if select_surprise
        else "mean_centered_userknn"
    )
    result = {
        "created_at": datetime.now(UTC).isoformat(),
        "evaluation_file": str(evaluation_path.resolve()),
        "evaluation_users": evaluation["evaluation"]["users"],
        "selected_algorithm": selected,
        "production_similarity_mode": (
            "surprise" if select_surprise else "mean_centered"
        ),
        "parameters": evaluation["parameters"],
        "criteria": {
            "accuracy_win": accuracy_win,
            "long_tail_tradeoff": long_tail_tradeoff,
            "low_pop_guard": low_pop_guard,
        },
        "observed": {
            "ndcg@10_relative_change": ndcg_relative,
            "ndcg@10_difference_ci95": [
                comparison["ci95_lower"],
                comparison["ci95_upper"],
            ],
            "long_tail_coverage_relative_change": long_tail_relative,
            "low_pop_ndcg@10_relative_change": low_pop_relative,
        },
    }
    result["parameters"]["ranking_mode"] = "residual"
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_suffix(output.suffix + ".tmp")
    temporary_output.write_text(
        json.dumps(result, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    temporary_output.replace(output)
    return result


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Select the production KNN using acceptance criteria."
    )
    result.add_argument("evaluation", type=Path)
    result.add_argument("--output", required=True, type=Path)
    return result


def main(arguments: Iterable[str] | None = None) -> None:
    args = parser().parse_args(arguments)
    result = select_model(args.evaluation, args.output)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

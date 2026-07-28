from __future__ import annotations

import argparse
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Iterable

import numpy as np


def _group_means(
    values: np.ndarray, indptr: np.ndarray
) -> np.ndarray:
    counts = np.diff(indptr).astype(np.int64, copy=False)
    means = np.zeros(len(counts), dtype=np.float32)
    nonempty = np.flatnonzero(counts)
    if len(nonempty):
        starts = np.asarray(indptr[nonempty], dtype=np.int64)
        sums = np.add.reduceat(values, starts)
        means[nonempty] = sums / counts[nonempty]
    return means


def _atomic_save(path: Path, values: np.ndarray) -> None:
    temporary = path.with_name(f".{path.name}.tmp.npy")
    np.save(temporary, values)
    temporary.replace(path)


def add_rating_means(artifact_directory: Path) -> dict:
    manifest_path = artifact_directory / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected_users = int(manifest["ratings"]["users"])
    expected_items = int(manifest["ratings"]["catalog_items"])

    user_output = artifact_directory / "user_rating_mean.npy"
    if not user_output.exists():
        user_ratings = np.load(
            artifact_directory / "csr_ratings.npy", mmap_mode="r"
        )
        user_indptr = np.load(
            artifact_directory / "csr_indptr.npy", mmap_mode="r"
        )
        user_means = _group_means(user_ratings, user_indptr)
        if len(user_means) != expected_users:
            raise ValueError("用户均分数组长度与 manifest 不一致。")
        _atomic_save(user_output, user_means)

    item_output = artifact_directory / "item_rating_mean.npy"
    if not item_output.exists():
        item_ratings = np.load(
            artifact_directory / "csc_ratings.npy", mmap_mode="r"
        )
        item_indptr = np.load(
            artifact_directory / "csc_indptr.npy", mmap_mode="r"
        )
        item_means = _group_means(item_ratings, item_indptr)
        if len(item_means) != expected_items:
            raise ValueError("作品均分数组长度与 manifest 不一致。")
        _atomic_save(item_output, item_means)

    manifest["supplemental_arrays"] = {
        "created_at": datetime.now(UTC).isoformat(),
        "user_rating_mean": user_output.name,
        "item_rating_mean": item_output.name,
    }
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return manifest["supplemental_arrays"]


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Add evaluation arrays to an existing model artifact."
    )
    result.add_argument("artifact_directory", type=Path)
    return result


def main(arguments: Iterable[str] | None = None) -> None:
    args = parser().parse_args(arguments)
    result = add_rating_means(args.artifact_directory)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

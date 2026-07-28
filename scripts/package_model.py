from __future__ import annotations

import argparse
import hashlib
import json
import tarfile
from datetime import UTC, datetime
from pathlib import Path

import zstandard as zstd


RUNTIME_FILES = (
    "affinity_calibration.npz",
    "bangumi-mapping.parquet",
    "catalog.parquet",
    "csc_indices.npy",
    "csc_indptr.npy",
    "csc_ratings.npy",
    "csc_residuals.npy",
    "csr_indices.npy",
    "csr_indptr.npy",
    "csr_ratings.npy",
    "csr_residuals.npy",
    "global_mean.txt",
    "item_bias.npy",
    "item_counts.npy",
    "item_iuf.npy",
    "item_surprise.npy",
    "mal_ids.npy",
    "manifest.json",
    "model-selection.json",
    "user_ids.npy",
    "user_rating_mean.npy",
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def package_model(
    model_directory: Path,
    attribution: Path,
    output_directory: Path,
    repository: str,
    tag: str,
    part_size: int,
    manifest_copy: Path | None = None,
) -> dict:
    missing = [
        name
        for name in RUNTIME_FILES
        if not (model_directory / name).is_file()
    ]
    if missing:
        raise FileNotFoundError(
            "运行模型缺少文件: " + ", ".join(missing)
        )
    if not attribution.is_file():
        raise FileNotFoundError(f"数据说明不存在: {attribution}")
    output_directory.mkdir(parents=True, exist_ok=True)
    archive = output_directory / f"fanjian-{tag}.tar.zst"
    model_name = "anime-model-open-2026-27"

    expected_files: list[dict] = []
    for name in RUNTIME_FILES:
        source = model_directory / name
        expected_files.append(
            {
                "path": name,
                "bytes": source.stat().st_size,
                "sha256": sha256(source),
            }
        )

    with archive.open("wb") as raw_output:
        compressor = zstd.ZstdCompressor(
            level=7,
            threads=-1,
            write_checksum=True,
        )
        with compressor.stream_writer(
            raw_output, closefd=False
        ) as compressed:
            with tarfile.open(fileobj=compressed, mode="w|") as tar:
                for name in RUNTIME_FILES:
                    tar.add(
                        model_directory / name,
                        arcname=f"{model_name}/{name}",
                        recursive=False,
                    )
                tar.add(
                    attribution,
                    arcname=f"{model_name}/ATTRIBUTION.md",
                    recursive=False,
                )

    parts: list[Path] = []
    with archive.open("rb") as source:
        index = 1
        while True:
            block = source.read(part_size)
            if not block:
                break
            part = output_directory / (
                f"{archive.name}.part{index:02d}"
            )
            with part.open("wb") as target:
                target.write(block)
            parts.append(part)
            index += 1
    archive.unlink()

    manifest = {
        "schema_version": 1,
        "created_at": datetime.now(UTC).isoformat(),
        "repository": repository,
        "release_tag": tag,
        "model_directory": model_name,
        "compression": "tar+zstd",
        "uncompressed_runtime_bytes": sum(
            record["bytes"] for record in expected_files
        ),
        "expected_files": expected_files,
        "parts": [
            {
                "name": part.name,
                "bytes": part.stat().st_size,
                "sha256": sha256(part),
                "url": (
                    f"https://github.com/{repository}/releases/download/"
                    f"{tag}/{part.name}"
                ),
            }
            for part in parts
        ],
    }
    manifest_path = output_directory / "model-release.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    if manifest_copy is not None:
        manifest_copy.parent.mkdir(parents=True, exist_ok=True)
        manifest_copy.write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    return manifest


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("model_directory", type=Path)
    result.add_argument(
        "--attribution",
        type=Path,
        default=Path("docs/MODEL_ATTRIBUTION.md"),
    )
    result.add_argument("--output", required=True, type=Path)
    result.add_argument(
        "--repository", default="AoiKJuice/fanjian"
    )
    result.add_argument(
        "--tag", default="model-2026-07-28"
    )
    result.add_argument(
        "--part-size",
        type=int,
        default=1_800_000_000,
    )
    result.add_argument("--manifest-copy", type=Path)
    return result


def main() -> None:
    args = parser().parse_args()
    manifest = package_model(
        args.model_directory,
        args.attribution,
        args.output,
        args.repository,
        args.tag,
        args.part_size,
        args.manifest_copy,
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

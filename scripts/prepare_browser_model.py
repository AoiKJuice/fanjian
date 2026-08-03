from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import polars as pl

from package_model import RUNTIME_FILES


MODEL_VERSION = (
    "surprise_weighted_userknn"
    "-series-balanced-rank-v3-implicit-negative-v1"
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def json_list(value: Any) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        parsed = [part.strip() for part in str(value).split(",")]
    return [str(item) for item in parsed if str(item).strip()]


def title_overrides(path: Path) -> dict[int, dict[str, Any]]:
    schema = pl.read_parquet_schema(path)
    columns = ["mal_id", "title_zh", "title_native"]
    if "score" in schema:
        columns.append("score")
    frame = (
        pl.read_parquet(path, columns=columns)
        .filter(pl.col("mal_id").is_not_null())
        .unique("mal_id", keep="first")
    )
    return {int(row["mal_id"]): row for row in frame.iter_rows(named=True)}


def browser_catalog(model_directory: Path) -> list[dict[str, Any]]:
    frame = pl.read_parquet(model_directory / "catalog.parquet").sort("anime_id")
    overrides = title_overrides(model_directory / "bangumi-mapping.parquet")
    output = []
    for index, row in enumerate(frame.iter_rows(named=True)):
        mal_id = int(row["mal_id"])
        override = overrides.get(mal_id, {})
        score = override.get("score")
        output.append(
            {
                "anime_id": int(row["anime_id"]),
                "mal_id": mal_id,
                "title_zh": override.get("title_zh") or row["title"],
                "title_native": (
                    override.get("title_native")
                    or row.get("alternative_title")
                    or row["title"]
                ),
                "title_en": row["title"],
                "format": row.get("format") or "未知",
                "episodes": int(row.get("episodes") or 0),
                "year": int(row.get("year") or 0),
                "release_status": row.get("release_status") or "未知",
                "synopsis": row.get("synopsis") or "",
                "cover_index": index % 8,
                "cover_url": row.get("image_url"),
                "platform_mean": row.get("source_score"),
                "bangumi_score": (
                    float(score) if score is not None and float(score) > 0 else None
                ),
                "genres": json_list(row.get("genres")),
                "sequel": bool(row.get("sequel")),
            }
        )
    return output


def prepare(
    model_directory: Path,
    release_manifest_path: Path,
    base_url: str,
    catalog_url_path: str = "browser/catalog.json",
) -> dict[str, Any]:
    release = json.loads(release_manifest_path.read_text(encoding="utf-8"))
    release_files = {record["path"]: record for record in release["expected_files"]}
    records = []
    for name in RUNTIME_FILES:
        path = model_directory / name
        if not path.is_file():
            raise FileNotFoundError(f"模型文件不存在: {path}")
        expected = release_files.get(name)
        if not expected or path.stat().st_size != expected["bytes"]:
            raise ValueError(f"模型文件大小与发布清单不一致: {name}")
        records.append(
            {
                "path": name,
                "bytes": expected["bytes"],
                "sha256": expected["sha256"],
                "url": f"{base_url.rstrip('/')}/{name}",
            }
        )

    catalog_path = model_directory / "browser" / "catalog.json"
    catalog_path.parent.mkdir(parents=True, exist_ok=True)
    catalog_path.write_text(
        json.dumps(browser_catalog(model_directory), ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    catalog_record = {
        "path": "browser/catalog.json",
        "bytes": catalog_path.stat().st_size,
        "sha256": sha256(catalog_path),
        "url": f"{base_url.rstrip('/')}/{catalog_url_path.lstrip('/')}",
    }
    model_manifest = json.loads(
        (model_directory / "manifest.json").read_text(encoding="utf-8")
    )
    output = {
        "schema_version": 1,
        "model_version": MODEL_VERSION,
        "data_version": model_manifest["data_version"],
        "total_bytes": sum(record["bytes"] for record in records) + catalog_record["bytes"],
        "catalog_items": model_manifest["ratings"]["catalog_items"],
        "training_users": model_manifest["ratings"]["users"],
        "training_ratings": model_manifest["ratings"]["cleaned_rows"],
        "files": records,
        "browser_catalog": catalog_record,
    }
    (model_directory / "browser-model-manifest.json").write_text(
        json.dumps(output, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return output


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("model_directory", type=Path)
    result.add_argument(
        "--release-manifest",
        type=Path,
        default=Path("scripts/model-release.json"),
    )
    result.add_argument(
        "--base-url",
        default="/tools/anime-affinity/model",
    )
    result.add_argument(
        "--catalog-url-path",
        default="browser/catalog.json",
    )
    return result


def main() -> None:
    args = parser().parse_args()
    result = prepare(
        args.model_directory,
        args.release_manifest,
        args.base_url,
        args.catalog_url_path,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

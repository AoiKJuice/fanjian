from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import tarfile
from pathlib import Path

import zstandard as zstd


class PartReader(io.RawIOBase):
    def __init__(self, parts: list[Path]) -> None:
        self._parts = iter(parts)
        self._current = None

    def readable(self) -> bool:
        return True

    def readinto(self, buffer: bytearray) -> int:
        view = memoryview(buffer)
        total = 0
        while total < len(view):
            if self._current is None:
                try:
                    self._current = next(self._parts).open("rb")
                except StopIteration:
                    break
            count = self._current.readinto(view[total:])
            if count:
                total += count
            else:
                self._current.close()
                self._current = None
        return total

    def close(self) -> None:
        if self._current is not None:
            self._current.close()
        super().close()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_extract(tar: tarfile.TarFile, destination: Path) -> None:
    destination_resolved = destination.resolve()
    for member in tar:
        target = (destination / member.name).resolve()
        if (
            target != destination_resolved
            and destination_resolved not in target.parents
        ):
            raise ValueError(f"压缩包包含非法路径: {member.name}")
        tar.extract(member, destination, filter="data")


def install_model(
    manifest_path: Path,
    parts_directory: Path,
    data_directory: Path,
) -> Path:
    manifest = json.loads(
        manifest_path.read_text(encoding="utf-8")
    )
    parts = [
        parts_directory / record["name"]
        for record in manifest["parts"]
    ]
    for path, record in zip(parts, manifest["parts"], strict=True):
        if not path.is_file():
            raise FileNotFoundError(f"模型分卷不存在: {path}")
        if path.stat().st_size != int(record["bytes"]):
            raise ValueError(f"模型分卷大小不符: {path.name}")
        if sha256(path) != record["sha256"]:
            raise ValueError(f"模型分卷 SHA-256 不符: {path.name}")

    target = data_directory / manifest["model_directory"]
    temporary = data_directory / (
        manifest["model_directory"] + ".installing"
    )
    if target.exists():
        raise FileExistsError(f"模型目录已经存在: {target}")
    if temporary.exists():
        shutil.rmtree(temporary)
    data_directory.mkdir(parents=True, exist_ok=True)

    try:
        reader = PartReader(parts)
        with reader:
            with zstd.ZstdDecompressor().stream_reader(reader) as stream:
                with tarfile.open(fileobj=stream, mode="r|") as tar:
                    safe_extract(tar, data_directory)
        if not target.is_dir():
            raise ValueError("压缩包没有生成预期的模型目录。")
        for record in manifest["expected_files"]:
            path = target / record["path"]
            if not path.is_file():
                raise FileNotFoundError(f"模型文件不存在: {path}")
            if path.stat().st_size != int(record["bytes"]):
                raise ValueError(f"模型文件大小不符: {path.name}")
            if sha256(path) != record["sha256"]:
                raise ValueError(f"模型文件 SHA-256 不符: {path.name}")
        return target
    except Exception:
        if target.exists():
            shutil.rmtree(target)
        if temporary.exists():
            shutil.rmtree(temporary)
        raise


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("manifest", type=Path)
    result.add_argument("parts_directory", type=Path)
    result.add_argument("data_directory", type=Path)
    return result


def main() -> None:
    args = parser().parse_args()
    print(
        install_model(
            args.manifest,
            args.parts_directory,
            args.data_directory,
        )
    )


if __name__ == "__main__":
    main()

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path

import zstandard as zstd


MAL_PATTERN = re.compile(r"myanimelist\.net/anime/(\d+)")
ANCILLARY_FORMATS = {"OVA", "SPECIAL", "TV_SPECIAL", "MUSIC", "PV", "CM"}
FORMAT_PRIORITY = {"TV": 0, "MOVIE": 1, "ONA": 2}
TITLE_STOPWORDS = {
    "the", "a", "an", "no", "ni", "wa", "ga", "to", "of", "and",
    "season", "part", "cour", "movie", "film", "ova", "ona", "special",
    "second", "third", "fourth", "2nd", "3rd", "4th", "ii", "iii", "iv",
}


class DisjointSet:
    def __init__(self) -> None:
        self.parent: dict[int, int] = {}

    def find(self, item: int) -> int:
        self.parent.setdefault(item, item)
        if self.parent[item] != item:
            self.parent[item] = self.find(self.parent[item])
        return self.parent[item]

    def union(self, left: int, right: int) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root != right_root:
            self.parent[right_root] = left_root


def mal_id(url: str) -> int | None:
    match = MAL_PATTERN.search(url)
    return int(match.group(1)) if match else None


def normalize_source(url: str) -> str:
    return url.strip().rstrip("/")


def title_tokens(value: str) -> list[str]:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return [
        token
        for token in re.findall(r"[a-z0-9]+", normalized)
        if token not in TITLE_STOPWORDS and not token.isdigit()
    ]


def is_same_series(left: str, right: str) -> bool:
    left_tokens = title_tokens(left)
    right_tokens = title_tokens(right)
    if not left_tokens or not right_tokens:
        return False
    return left_tokens[0] == right_tokens[0]


def is_non_primary(
    item: int,
    related_items: set[int],
    metadata: dict[int, tuple[int, str, str]],
) -> bool:
    year, format_name, title = metadata.get(item, (9999, "", ""))
    if format_name in ANCILLARY_FORMATS:
        return bool(related_items)
    current_key = (year, FORMAT_PRIORITY.get(format_name, 3), item)
    for related in related_items:
        related_year, related_format, related_title = metadata.get(
            related, (9999, "", "")
        )
        if related_format in ANCILLARY_FORMATS:
            continue
        related_key = (
            related_year,
            FORMAT_PRIORITY.get(related_format, 3),
            related,
        )
        if related_key >= current_key:
            continue
        if format_name == "TV":
            if related_format == "TV" and is_same_series(title, related_title):
                return True
            continue
        if related_format == "TV" or is_same_series(title, related_title):
            return True
    return False


def build_flags(source: Path) -> dict:
    with source.open("rb") as compressed:
        with zstd.ZstdDecompressor().stream_reader(compressed) as reader:
            payload = json.load(reader)

    entries = payload["data"]
    source_owner: dict[str, int] = {}
    metadata: dict[int, tuple[int, str, str]] = {}
    for entry in entries:
        entry_ids = [
            item
            for url in entry.get("sources", [])
            if (item := mal_id(url)) is not None
        ]
        if not entry_ids:
            continue
        current = entry_ids[0]
        metadata[current] = (
            int(entry.get("animeSeason", {}).get("year") or 9999),
            str(entry.get("type") or "").upper(),
            str(entry.get("title") or ""),
        )
        for url in entry.get("sources", []):
            source_owner[normalize_source(url)] = current

    graph = DisjointSet()
    relations: dict[int, set[int]] = {}
    relation_count = 0
    for entry in entries:
        entry_ids = [
            item
            for url in entry.get("sources", [])
            if (item := mal_id(url)) is not None
        ]
        if not entry_ids:
            continue
        current = entry_ids[0]
        graph.find(current)
        for url in entry.get("relatedAnime", []):
            related = source_owner.get(normalize_source(url)) or mal_id(url)
            if related is None:
                continue
            graph.union(current, related)
            relations.setdefault(current, set()).add(related)
            relations.setdefault(related, set()).add(current)
            relation_count += 1

    components: dict[int, list[int]] = {}
    for item in graph.parent:
        components.setdefault(graph.find(item), []).append(item)

    non_primary = {
        item
        for item, related_items in relations.items()
        if is_non_primary(item, related_items, metadata)
    }
    related_components = sum(
        len(component) > 1 for component in components.values()
    )

    return {
        "schema_version": 1,
        "source_last_update": payload.get("lastUpdate"),
        "source_repository": payload.get("repository"),
        "relation_edges": relation_count,
        "relation_components": related_components,
        "non_primary_mal_ids": sorted(non_primary),
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build sequel and derivative flags from relatedAnime edges."
    )
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    result = build_flags(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(result, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(
        f"wrote {len(result['non_primary_mal_ids'])} relation flags "
        f"to {args.output}"
    )


if __name__ == "__main__":
    main()

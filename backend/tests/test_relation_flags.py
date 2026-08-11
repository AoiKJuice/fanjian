import json
from pathlib import Path

from backend.training.build_relation_flags import is_non_primary, is_same_series


def test_primary_selection_ignores_earlier_bonus_entries():
    metadata = {
        10: (2005, "OVA", "Example OVA"),
        20: (2007, "TV", "Example"),
        30: (2009, "ONA", "Example Web Extra"),
    }
    assert is_non_primary(10, {20}, metadata) is True
    assert is_non_primary(20, {10, 30}, metadata) is False
    assert is_non_primary(30, {20}, metadata) is True


def test_tv_series_is_not_demoted_by_an_earlier_web_extra():
    metadata = {
        10: (2012, "ONA", "Example Web Extra"),
        20: (2013, "TV", "Example"),
    }
    assert is_non_primary(20, {10}, metadata) is False


def test_crossover_does_not_demote_an_unrelated_tv_series():
    metadata = {
        10: (1989, "TV", "Dragon Ball Z"),
        20: (1999, "TV", "One Piece"),
        30: (2019, "TV", "Example 2nd Season"),
    }
    assert is_non_primary(20, {10}, metadata) is False
    assert is_same_series("Example", "Example 2nd Season") is True
    assert is_same_series("One Piece", "Dragon Ball Z") is False


def test_packaged_relations_cover_sequels_movies_and_spinoffs():
    path = (
        Path(__file__).parents[1]
        / "resources"
        / "non_primary_anime.json"
    )
    flags = set(json.loads(path.read_text(encoding="utf-8"))["non_primary_mal_ids"])
    assert {17637, 23623, 41471, 7311, 56175, 6213}.issubset(flags)
    assert {1887, 17549, 2167, 4654, 6547, 15379}.isdisjoint(flags)

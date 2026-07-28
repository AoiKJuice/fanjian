from collections import Counter

import polars as pl

from backend.production_recommender import DiskBackedUserKNN
from backend.recommender import SurpriseUserKNN


def test_recommendations_exclude_seen_and_are_ranked():
    model = SurpriseUserKNN()
    ratings = {1101: 9, 1102: 9, 1103: 6, 1104: 6, 1106: 8, 1108: 9}
    items = model.recommend(ratings, min_support=3)
    assert items
    assert not set(ratings).intersection(item["anime"]["mal_id"] for item in items)
    scores = [item["rank_score"] for item in items]
    assert scores == sorted(scores, reverse=True)


def test_similarity_uses_only_positive_neighbors():
    model = SurpriseUserKNN()
    ratings = {1101: 9, 1102: 9, 1103: 6, 1104: 6, 1106: 8, 1108: 9}
    neighbors = model.neighbors(ratings)
    assert neighbors
    assert all(neighbor.similarity > 0 for neighbor in neighbors)
    assert all(neighbor.overlap >= model.overlap_min for neighbor in neighbors)


def test_hidden_feedback_changes_neighbor_matching_and_candidate_scores():
    model = SurpriseUserKNN()
    ratings = {1101: 9, 1102: 9, 1103: 6, 1104: 6, 1106: 8, 1108: 9}
    original = model.recommend(ratings, min_support=3)
    hidden_id = original[0]["anime"]["mal_id"]
    original_neighbors = model.neighbors(ratings)

    updated = model.recommend(
        ratings,
        negative_items={hidden_id},
        min_support=3,
    )
    updated_neighbors = model.neighbors(
        ratings,
        negative_items={hidden_id},
    )

    assert hidden_id not in {
        item["anime"]["mal_id"] for item in updated
    }
    assert [
        (item.user_id, item.similarity) for item in original_neighbors
    ] != [
        (item.user_id, item.similarity) for item in updated_neighbors
    ]
    original_scores = {
        item["anime"]["mal_id"]: item["rank_score"] for item in original
    }
    updated_scores = {
        item["anime"]["mal_id"]: item["rank_score"] for item in updated
    }
    shared = set(original_scores).intersection(updated_scores)
    assert any(
        original_scores[mal_id] != updated_scores[mal_id]
        for mal_id in shared
    )


def test_series_filter_is_optional():
    model = SurpriseUserKNN()
    ratings = {1101: 9, 1102: 9, 1103: 6, 1104: 6, 1106: 8, 1108: 9}
    blocked = model.recommend(ratings, min_support=3, allow_sequels=False)
    assert 1112 not in [item["anime"]["mal_id"] for item in blocked]
    allowed = model.recommend(ratings, min_support=3, allow_sequels=True)
    assert 1112 in [item["anime"]["mal_id"] for item in allowed]


def test_display_tags_are_curated_deduplicated_and_chinese():
    model = DiskBackedUserKNN.__new__(DiskBackedUserKNN)
    model.catalog = pl.DataFrame(
        {
            "genres": [
                (
                    '["japanese production", "place", "comedy", '
                    '"Comedy", "school life", "girls love", '
                    '"primarily female cast"]'
                )
            ]
        }
    )

    assert model._genres_for_item(0) == [
        "comedy",
        "school",
        "girls love",
        "female ensemble",
    ]
    assert model._matched_tags(
        0,
        Counter(
            {
                "comedy": 8,
                "school": 6,
                "girls love": 5,
                "female ensemble": 4,
            }
        ),
    ) == ["百合", "女性群像", "校园"]


def test_display_tags_merge_common_aliases():
    model = DiskBackedUserKNN.__new__(DiskBackedUserKNN)
    model.catalog = pl.DataFrame(
        {
            "genres": [
                (
                    '["science fiction", "sci fi", "daily life", '
                    '"shoujo ai", "cgdct", "japanese production"]'
                )
            ]
        }
    )

    assert model._genres_for_item(0) == [
        "sci-fi",
        "slice of life",
        "girls love",
        "cute girls doing cute things",
    ]

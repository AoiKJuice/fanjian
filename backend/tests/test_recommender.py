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


def test_series_filter_is_optional():
    model = SurpriseUserKNN()
    ratings = {1101: 9, 1102: 9, 1103: 6, 1104: 6, 1106: 8, 1108: 9}
    blocked = model.recommend(ratings, min_support=3, allow_sequels=False)
    assert 1112 not in [item["anime"]["mal_id"] for item in blocked]
    allowed = model.recommend(ratings, min_support=3, allow_sequels=True)
    assert 1112 in [item["anime"]["mal_id"] for item in allowed]

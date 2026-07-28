from pathlib import Path

import numpy as np
import polars as pl

from backend.database import Database
from backend.production_recommender import DiskBackedUserKNN
from backend.training.build_artifacts import build_artifacts
from backend.training.expand_catalog import expand_catalog


def test_build_artifacts_preserves_full_catalog(tmp_path: Path):
    anime = tmp_path / "animes.csv"
    ratings = tmp_path / "ratings.csv"
    anime.write_text(
        "\n".join(
            [
                "animeID,title,alternative_title,type,year,score,episodes,mal_url,sequel,image_url,genres,genres_detailed",
                "1,Alpha,,TV,2020,7.2,12,https://myanimelist.net/anime/101,False,https://example.com/a.jpg,[],[]",
                "2,Beta,,MOVIE,2021,8.1,1,https://myanimelist.net/anime/102,False,https://example.com/b.jpg,[],[]",
                "3,Gamma,,OVA,UNKNOWN,UNKNOWN,2,https://myanimelist.net/anime/103,True,https://example.com/c.jpg,[],[]",
            ]
        ),
        encoding="utf-8",
    )
    ratings.write_text(
        "\n".join(
            [
                "userID,animeID,rating",
                "1,1,10",
                "1,2,5",
                "2,1,9",
                "2,2,4",
                "3,1,2",
                "3,2,8",
                "4,1,1",
                "4,2,9",
            ]
        ),
        encoding="utf-8",
    )
    output = tmp_path / "model"

    manifest = build_artifacts(
        ratings_source=ratings,
        anime_source=anime,
        output=output,
        min_user_ratings=2,
        min_user_stddev=0,
        min_score_bins=2,
        min_item_ratings=1,
        batch_size=3,
        source_url="fixture://training",
        license_note="test fixture",
    )

    assert manifest["catalog"]["rows"] == 3
    assert manifest["ratings"]["unknown_item_rows"] == 0
    assert manifest["ratings"]["cleaned_rows"] == 8
    assert pl.read_parquet(output / "catalog.parquet").height == 3
    assert np.load(output / "mal_ids.npy").tolist() == [101, 102, 103]
    assert np.load(output / "csr_indptr.npy").tolist() == [0, 2, 4, 6, 8]
    assert np.load(output / "csc_indptr.npy").tolist() == [0, 4, 8, 8]

    model = DiskBackedUserKNN(
        output,
        overlap_min=2,
        shrinkage=1,
        neighbor_count=4,
    )
    assert model.manifest["catalog"]["rows"] == 3
    assert model._mal_to_item == {101: 0, 102: 1, 103: 2}
    assert model.neighbors({101: 10, 102: 5})
    assert not model.neighbors({101: 10})
    assert model.neighbors({101: 10}, negative_items={102})

    current_catalog = tmp_path / "current.csv"
    pl.DataFrame(
        [
            {
                "mal_id": 101,
                "title": "Alpha updated",
                "title_japanese": "アルファ",
                "type": "TV",
                "status": "Finished Airing",
                "score": 7.4,
                "year": 2020,
                "episodes": 12,
                "url": "https://myanimelist.net/anime/101",
                "image_url": "https://example.com/a2.jpg",
                "genres": "[]",
                "themes": "[]",
                "demographics": "[]",
                "explicit_genres": "[]",
                "rating": "PG-13",
                "synopsis": "Updated",
            },
            {
                "mal_id": 102,
                "title": "Beta",
                "title_japanese": "ベータ",
                "type": "Movie",
                "status": "Finished Airing",
                "score": 8.1,
                "year": 2021,
                "episodes": 1,
                "url": "https://myanimelist.net/anime/102",
                "image_url": "https://example.com/b.jpg",
                "genres": "[]",
                "themes": "[]",
                "demographics": "[]",
                "explicit_genres": "[]",
                "rating": "PG",
                "synopsis": "Beta",
            },
            {
                "mal_id": 104,
                "title": "Delta",
                "title_japanese": "デルタ",
                "type": "ONA",
                "status": "Currently Airing",
                "score": 0.0,
                "year": 2026,
                "episodes": None,
                "url": "https://myanimelist.net/anime/104",
                "image_url": "https://example.com/d.jpg",
                "genres": "[]",
                "themes": "[]",
                "demographics": "[]",
                "explicit_genres": "[]",
                "rating": "PG-13",
                "synopsis": "Delta",
            },
        ]
    ).write_csv(current_catalog)
    expanded = tmp_path / "expanded"
    expanded_manifest = expand_catalog(
        output, current_catalog, expanded
    )
    assert expanded_manifest["catalog"]["rows"] == 4
    assert (
        expanded_manifest["catalog"][
            "preserved_training_rows_absent_from_snapshot"
        ]
        == 1
    )
    assert np.load(expanded / "mal_ids.npy").tolist() == [
        101,
        102,
        103,
        104,
    ]
    assert np.load(expanded / "csc_indptr.npy").tolist() == [
        0,
        4,
        8,
        8,
        8,
    ]
    expanded_model = DiskBackedUserKNN(
        expanded,
        overlap_min=2,
        shrinkage=1,
        neighbor_count=4,
    )
    assert len(expanded_model.catalog) == 4

    title_mapping = tmp_path / "title-mapping.parquet"
    pl.DataFrame(
        [
            {
                "mal_id": 101,
                "title_zh": "阿尔法",
                "title_native": "アルファ",
                "score": 8.3,
            }
        ]
    ).write_parquet(title_mapping)
    localized_model = DiskBackedUserKNN(
        expanded,
        overlap_min=2,
        shrinkage=1,
        neighbor_count=4,
        title_mapping_path=title_mapping,
    )
    assert localized_model._catalog_item(0)["title_zh"] == "阿尔法"
    assert localized_model._catalog_item(0)["bangumi_score"] == 8.3
    localized_database = Database(
        tmp_path / "localized.db",
        catalog_path=expanded / "catalog.parquet",
        expected_catalog_items=4,
        title_mapping_path=title_mapping,
    )
    assert localized_database.anime_detail(101)["title_zh"] == "阿尔法"
    assert localized_database.anime_detail(101)["bangumi_score"] == 8.3


def test_series_keys_group_obvious_seasons_and_bonus_entries():
    key = DiskBackedUserKNN._series_key
    assert key("Kono Subarashii Sekai ni Shukufuku wo!") == key(
        "Kono Subarashii Sekai ni Shukufuku wo! 2"
    )
    assert key("Kono Subarashii Sekai ni Shukufuku wo!") == key(
        "Kono Subarashii Sekai ni Shukufuku wo!: Bonus Stage"
    )
    assert key("Minami-ke") == key("Minami-ke Okaeri")
    assert key("To LOVE-Ru") == key("To LOVE-Ru Darkness 2nd")
    assert key("Kono Oto Tomare!") != key(
        "Kono Subarashii Sekai ni Shukufuku wo!"
    )


def test_continuation_and_ancillary_detection():
    continuation = DiskBackedUserKNN._looks_like_continuation
    ancillary = DiskBackedUserKNN._is_ancillary
    assert continuation("Kizumonogatari II: Nekketsu-hen")
    assert continuation("Example Season 2")
    assert continuation("Hidamari Sketch x 365")
    assert not continuation("One Punch Man")
    assert ancillary("OVA", "Example")
    assert ancillary("TV", "Example Recap")
    assert not ancillary("TV", "Example")
    context = DiskBackedUserKNN._requires_series_context
    assert context("MOVIE", "No Game No Life: Zero")
    assert not context("MOVIE", "Koe no Katachi")

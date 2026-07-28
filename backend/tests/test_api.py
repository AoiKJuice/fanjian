from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import app


def test_core_api_flow(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("ANIME_DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("ANIME_USE_DEMO", "1")
    with TestClient(app) as client:
        profiles = client.get("/api/v1/profiles")
        assert profiles.status_code == 200
        profile_id = profiles.json()[0]["id"]

        library = client.get(f"/api/v1/profiles/{profile_id}/library")
        assert library.status_code == 200
        assert len(library.json()["items"]) == 6

        run = client.post(
            "/api/v1/recommendations",
            json={"profile_id": profile_id, "min_support": 3},
        )
        assert run.status_code == 200
        payload = run.json()
        assert payload["status"] == "ready"
        assert payload["items"]
        assert 1 <= payload["items"][0]["affinity"] <= 99
        recommended_id = payload["items"][0]["anime"]["mal_id"]

        favorite = client.post(
            f"/api/v1/recommendations/{payload['id']}/feedback",
            json={"mal_id": recommended_id, "action": "favorite"},
        )
        assert favorite.status_code == 200
        collections = client.get(
            f"/api/v1/profiles/{profile_id}/collections"
        )
        assert collections.status_code == 200
        assert [
            item["mal_id"] for item in collections.json()["favorites"]
        ] == [recommended_id]
        assert collections.json()["hidden"] == []

        hidden = client.post(
            f"/api/v1/recommendations/{payload['id']}/feedback",
            json={"mal_id": recommended_id, "action": "hide"},
        )
        assert hidden.status_code == 200
        collections = client.get(
            f"/api/v1/profiles/{profile_id}/collections"
        ).json()
        assert collections["favorites"] == []
        assert [item["mal_id"] for item in collections["hidden"]] == [
            recommended_id
        ]
        removed = client.delete(
            f"/api/v1/profiles/{profile_id}/collections/hidden/{recommended_id}"
        )
        assert removed.status_code == 204
        assert client.get(
            f"/api/v1/profiles/{profile_id}/collections"
        ).json()["hidden"] == []

        history = client.get(
            "/api/v1/recommendations/history",
            params={"profile_id": profile_id},
        )
        assert history.status_code == 200
        assert history.json()["items"][0]["id"] == payload["id"]

        insights = client.get(f"/api/v1/profiles/{profile_id}/insights")
        assert insights.status_code == 200
        assert 0 <= insights.json()["mainstream_index"] <= 100
        assert 0 <= insights.json()["long_tail_ratio"] <= 100

        deleted = client.delete(
            f"/api/v1/recommendations/{payload['id']}"
        )
        assert deleted.status_code == 204
        assert (
            client.get(
                f"/api/v1/recommendations/{payload['id']}"
            ).status_code
            == 404
        )


def test_missing_profile_returns_404(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("ANIME_DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("ANIME_USE_DEMO", "1")
    with TestClient(app) as client:
        response = client.get("/api/v1/profiles/999/library")
        assert response.status_code == 404


def test_profile_delete_removes_the_profile(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("ANIME_DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("ANIME_USE_DEMO", "1")
    with TestClient(app) as client:
        created = client.post(
            "/api/v1/profiles",
            json={"name": "临时资料", "title_language": "zh"},
        )
        profile_id = created.json()["id"]
        assert client.delete(f"/api/v1/profiles/{profile_id}").status_code == 204
        assert (
            client.get(f"/api/v1/profiles/{profile_id}/library").status_code
            == 404
        )


def test_plan_to_watch_clears_rating_and_is_not_model_input(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("ANIME_DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("ANIME_USE_DEMO", "1")
    with TestClient(app) as client:
        created = client.post(
            "/api/v1/profiles",
            json={"name": "计划观看测试", "title_language": "zh"},
        )
        profile_id = created.json()["id"]
        response = client.put(
            f"/api/v1/profiles/{profile_id}/ratings",
            json={
                "items": [
                    {
                        "mal_id": 1101,
                        "rating": 9,
                        "status": "plan_to_watch",
                    }
                ]
            },
        )
        assert response.status_code == 200
        library = client.get(
            f"/api/v1/profiles/{profile_id}/library"
        ).json()["items"]
        assert library[0]["rating"] is None
        profile = next(
            item
            for item in client.get("/api/v1/profiles").json()
            if item["id"] == profile_id
        )
        assert profile["rating_count"] == 0


def test_external_rating_can_be_associated_to_catalog(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("ANIME_DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("ANIME_USE_DEMO", "1")
    with TestClient(app) as client:
        profile_id = client.get("/api/v1/profiles").json()[0]["id"]
        run = client.post(
            "/api/v1/recommendations",
            json={"profile_id": profile_id, "min_support": 3},
        ).json()
        target_id = run["items"][0]["anime"]["mal_id"]
        app.state.db.upsert_external_ratings(
            profile_id,
            [
                {
                    "source": "bangumi",
                    "external_id": "manual-link-test",
                    "title": "待关联测试",
                    "title_native": None,
                    "rating": 9,
                    "status": "completed",
                    "cover_url": None,
                }
            ],
        )

        response = client.post(
            f"/api/v1/profiles/{profile_id}/library/associate",
            json={
                "source": "bangumi",
                "external_id": "manual-link-test",
                "mal_id": target_id,
            },
        )
        assert response.status_code == 200
        library = client.get(
            f"/api/v1/profiles/{profile_id}/library"
        ).json()
        assert library["unmapped_items"] == []
        associated = next(
            item for item in library["items"] if item["mal_id"] == target_id
        )
        assert associated["rating"] == 9
        assert associated["status"] == "completed"

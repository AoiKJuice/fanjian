from pathlib import Path

import httpx
from fastapi.testclient import TestClient

from backend.bangumi import BangumiClient
from backend.database import Database
from backend.main import app


def test_bangumi_client_paginates_and_preserves_unrated_entries():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        offset = int(request.url.params["offset"])
        if offset == 0:
            return httpx.Response(
                200,
                json={
                    "total": 3,
                    "limit": 100,
                    "offset": 0,
                    "data": [
                        {
                            "subject_id": 8,
                            "subject_type": 2,
                            "rate": 0,
                            "type": 3,
                            "updated_at": "2026-01-02T00:00:00+08:00",
                            "subject": {
                                "name": "Cowboy Bebop",
                                "name_cn": "星际牛仔",
                                "date": "1998-04-03",
                            },
                        },
                        {
                            "subject_id": 12,
                            "subject_type": 2,
                            "rate": 9,
                            "type": 2,
                            "updated_at": "2026-01-03T00:00:00+08:00",
                            "subject": {"name": "Test Two"},
                        },
                    ],
                },
            )
        return httpx.Response(
            200,
            json={
                "total": 3,
                "limit": 100,
                "offset": 2,
                "data": [
                    {
                        "subject_id": 999,
                        "subject_type": 2,
                        "rate": 4,
                        "type": 5,
                        "updated_at": "2026-01-04T00:00:00+08:00",
                        "subject": {
                            "name": "Exact Native Title",
                            "date": "2024-01-01",
                        },
                    }
                ],
            },
        )

    client = BangumiClient(
        mapping={8: 1, 12: 2},
        transport=httpx.MockTransport(handler),
    )
    client._title_index = {"exactnativetitle": [(3, 2024)]}

    import asyncio

    entries = asyncio.run(client.import_user("viewer", "secret-token"))

    assert len(entries) == 3
    assert entries[0]["rating"] is None
    assert entries[0]["status"] == "watching"
    assert entries[1]["rating"] == 9
    assert entries[1]["status"] == "completed"
    assert entries[2]["mal_id"] == 3
    assert entries[2]["mapping_method"] == "exact_title_and_year"
    assert entries[2]["status"] == "dropped"
    assert [request.url.params["offset"] for request in requests] == ["0", "2"]
    assert all(
        request.headers["authorization"] == "Bearer secret-token"
        for request in requests
    )
    assert all(
        request.headers["user-agent"]
        == "AnimeAffinityLab/0.1 local-research"
        for request in requests
    )


def test_bangumi_subject_metadata_uses_direct_mapping():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v0/subjects/100444"
        return httpx.Response(
            200,
            json={
                "id": 100444,
                "name": "四月は君の嘘",
                "name_cn": "四月是你的谎言",
                "summary": "中文简介",
                "rating": {"score": 8.0, "total": 100},
                "images": {"large": "https://example.test/cover.jpg"},
            },
        )

    client = BangumiClient(
        mapping={100444: 23273},
        transport=httpx.MockTransport(handler),
    )

    import asyncio

    metadata = asyncio.run(client.subject_metadata([23273, 999999]))

    assert list(metadata) == [23273]
    assert metadata[23273]["bangumi_subject_id"] == 100444
    assert metadata[23273]["bangumi_score"] == 8.0
    assert metadata[23273]["title_zh"] == "四月是你的谎言"
    assert metadata[23273]["synopsis"] == "中文简介"


def test_bangumi_metadata_is_saved_locally(tmp_path: Path):
    database = Database(tmp_path / "cache.db")
    record = {
        "bangumi_subject_id": 100444,
        "bangumi_score": 8.0,
        "title_zh": "四月是你的谎言",
        "synopsis": "中文简介",
    }

    database.save_bangumi_metadata({23273: record})

    assert database.bangumi_metadata([23273]) == {23273: record}


def test_bangumi_import_can_be_saved_and_rated_later(
    tmp_path: Path, monkeypatch
):
    class FakeBangumi:
        async def import_user(
            self, username: str, access_token: str | None = None
        ) -> list[dict]:
            assert username == "viewer"
            return [
                {
                    "mal_id": 1101,
                    "rating": None,
                    "status": "watching",
                    "updated_at": "2026-01-02T00:00:00+08:00",
                    "mapping_method": "mapping",
                },
                {
                    "mal_id": 1102,
                    "rating": 9,
                    "status": "completed",
                    "updated_at": "2026-01-03T00:00:00+08:00",
                    "mapping_method": "mapping",
                },
                {
                    "bangumi_subject_id": 999,
                    "mal_id": None,
                    "rating": None,
                    "status": "plan_to_watch",
                    "updated_at": "2026-01-04T00:00:00+08:00",
                    "mapping_method": "unmapped",
                    "title": "未关联作品",
                    "title_native": "Unmapped",
                    "cover_url": None,
                },
            ]

    monkeypatch.setenv("ANIME_DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("ANIME_USE_DEMO", "1")
    with TestClient(app) as api:
        app.state.bangumi = FakeBangumi()
        created = api.post(
            "/api/v1/profiles",
            json={"name": "Bangumi 导入", "title_language": "zh"},
        )
        profile_id = created.json()["id"]
        preview = api.post(
            "/api/v1/profiles/import/bangumi",
            json={"profile_id": profile_id, "username": "viewer"},
        )
        assert preview.status_code == 200
        payload = preview.json()
        assert payload["imported"] == 3
        assert payload["unmapped"] == 1
        assert payload["unrated"] == 2
        assert payload["items"][0]["rating"] is None
        assert payload["unmapped_items"][0]["title"] == "未关联作品"

        saved = api.put(
            f"/api/v1/profiles/{profile_id}/ratings",
            json={
                "items": payload["items"],
                "external_items": payload["unmapped_items"],
            },
        )
        assert saved.status_code == 200
        library = api.get(
            f"/api/v1/profiles/{profile_id}/library"
        ).json()["items"]
        assert len(library) == 2
        assert next(
            item for item in library if item["mal_id"] == 1101
        )["rating"] is None
        unmapped = api.get(
            f"/api/v1/profiles/{profile_id}/library"
        ).json()["unmapped_items"]
        assert unmapped[0]["external_id"] == "999"
        assert unmapped[0]["rating"] is None

        updated = api.put(
            f"/api/v1/profiles/{profile_id}/ratings",
            json={
                "items": [
                    {
                        "mal_id": 1101,
                        "rating": 8,
                        "status": "completed",
                    }
                ],
                "external_items": [
                        {
                            **payload["unmapped_items"][0],
                            "rating": 7,
                            "status": "completed",
                        }
                ],
            },
        )
        assert updated.status_code == 200
        profiles = api.get("/api/v1/profiles").json()
        profile = next(item for item in profiles if item["id"] == profile_id)
        assert profile["rating_count"] == 2
        unmapped = api.get(
            f"/api/v1/profiles/{profile_id}/library"
        ).json()["unmapped_items"]
        assert unmapped[0]["rating"] == 7

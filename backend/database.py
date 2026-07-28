from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

import polars as pl

from .demo_data import ANIME, DEMO_PROFILE_RATINGS, RELATIONS


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class Database:
    def __init__(
        self,
        path: str | Path | None = None,
        catalog_path: str | Path | None = None,
        expected_catalog_items: int | None = None,
        title_mapping_path: str | Path | None = None,
    ) -> None:
        configured = path or os.getenv("ANIME_DB_PATH", "runtime/anime.db")
        self.multi_tenant = os.getenv("ANIME_MULTI_TENANT") == "1"
        self.path = Path(configured)
        self.catalog_path = Path(catalog_path) if catalog_path else None
        self.expected_catalog_items = expected_catalog_items
        self.title_mapping_path = (
            Path(title_mapping_path) if title_mapping_path else None
        )
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    @contextmanager
    def connection(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def initialize(self) -> None:
        with self.connection() as db:
            db.executescript(
                """
                CREATE TABLE IF NOT EXISTS anime (
                    mal_id INTEGER PRIMARY KEY,
                    payload TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS relations (
                    source_mal_id INTEGER NOT NULL,
                    target_mal_id INTEGER NOT NULL,
                    relation_type TEXT NOT NULL,
                    PRIMARY KEY(source_mal_id, target_mal_id, relation_type)
                );
                CREATE TABLE IF NOT EXISTS profiles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    title_language TEXT NOT NULL DEFAULT 'zh',
                    workspace_id TEXT NOT NULL DEFAULT 'local',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS ratings (
                    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                    mal_id INTEGER NOT NULL,
                    rating REAL,
                    status TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(profile_id, mal_id)
                );
                CREATE TABLE IF NOT EXISTS external_ratings (
                    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                    source TEXT NOT NULL,
                    external_id TEXT NOT NULL,
                    rating REAL,
                    status TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY(profile_id, source, external_id)
                );
                CREATE TABLE IF NOT EXISTS favorites (
                    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                    mal_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(profile_id, mal_id)
                );
                CREATE TABLE IF NOT EXISTS hidden (
                    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                    mal_id INTEGER NOT NULL,
                    created_at TEXT NOT NULL,
                    PRIMARY KEY(profile_id, mal_id)
                );
                CREATE TABLE IF NOT EXISTS recommendation_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL,
                    model_version TEXT NOT NULL,
                    data_version TEXT NOT NULL,
                    filters TEXT NOT NULL,
                    status TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS recommendation_items (
                    run_id INTEGER NOT NULL REFERENCES recommendation_runs(id) ON DELETE CASCADE,
                    mal_id INTEGER NOT NULL,
                    position INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    PRIMARY KEY(run_id, mal_id)
                );
                CREATE TABLE IF NOT EXISTS feedback (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    run_id INTEGER NOT NULL REFERENCES recommendation_runs(id) ON DELETE CASCADE,
                    profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
                    mal_id INTEGER NOT NULL,
                    action TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS system_metadata (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS bangumi_metadata (
                    mal_id INTEGER PRIMARY KEY,
                    subject_id INTEGER NOT NULL,
                    payload TEXT NOT NULL,
                    fetched_at TEXT NOT NULL
                );
                """
            )
            profile_columns = {
                row["name"]
                for row in db.execute("PRAGMA table_info(profiles)").fetchall()
            }
            if "workspace_id" not in profile_columns:
                db.execute(
                    """
                    ALTER TABLE profiles
                    ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'local'
                    """
                )
            db.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_profiles_workspace
                ON profiles(workspace_id)
                """
            )
            db.execute(
                """
                UPDATE ratings SET rating = NULL
                WHERE status = 'plan_to_watch' AND rating IS NOT NULL
                """
            )
            db.execute(
                """
                UPDATE external_ratings SET rating = NULL
                WHERE status = 'plan_to_watch' AND rating IS NOT NULL
                """
            )
            switching_from_demo = bool(
                self.catalog_path
                and db.execute(
                    """
                    SELECT 1 FROM system_metadata
                    WHERE key = 'catalog_signature'
                    """
                ).fetchone()
                is None
            )
            if self.catalog_path:
                self._load_complete_catalog(db)
            else:
                self._load_demo_catalog(db)
            if switching_from_demo:
                self._remove_untouched_demo_profile(db)
            count = db.execute("SELECT COUNT(*) FROM profiles").fetchone()[0]
            if count == 0 and not self.multi_tenant:
                now = utcnow()
                cursor = db.execute(
                    """
                    INSERT INTO profiles(
                        name, title_language, workspace_id, created_at, updated_at
                    )
                    VALUES (?, ?, 'local', ?, ?)
                    """,
                    (
                        "本地资料" if self.catalog_path else "林澈",
                        "zh",
                        now,
                        now,
                    ),
                )
                profile_id = cursor.lastrowid
                if not self.catalog_path:
                    db.executemany(
                        """
                        INSERT INTO ratings(
                            profile_id, mal_id, rating, status, updated_at
                        )
                        VALUES (?, ?, ?, ?, ?)
                        """,
                        [
                            (
                                profile_id,
                                item["mal_id"],
                                item["rating"],
                                item["status"],
                                now,
                            )
                            for item in DEMO_PROFILE_RATINGS
                        ],
                    )

    def _remove_untouched_demo_profile(
        self, db: sqlite3.Connection
    ) -> None:
        expected = {
            (
                int(item["mal_id"]),
                float(item["rating"]),
                item["status"],
            )
            for item in DEMO_PROFILE_RATINGS
        }
        candidates = db.execute(
            "SELECT id FROM profiles WHERE name = '林澈'"
        ).fetchall()
        for candidate in candidates:
            profile_id = int(candidate["id"])
            rows = db.execute(
                """
                SELECT mal_id, rating, status
                FROM ratings
                WHERE profile_id = ?
                """,
                (profile_id,),
            ).fetchall()
            observed = {
                (
                    int(row["mal_id"]),
                    float(row["rating"]),
                    row["status"],
                )
                for row in rows
            }
            if observed == expected:
                db.execute(
                    "DELETE FROM profiles WHERE id = ?", (profile_id,)
                )

    def _load_demo_catalog(self, db: sqlite3.Connection) -> None:
        for anime in ANIME:
            db.execute(
                "INSERT OR REPLACE INTO anime(mal_id, payload) VALUES (?, ?)",
                (anime["mal_id"], json.dumps(anime, ensure_ascii=False)),
            )
        for relation in RELATIONS:
            db.execute(
                """
                INSERT OR IGNORE INTO relations
                (source_mal_id, target_mal_id, relation_type) VALUES (?, ?, ?)
                """,
                (
                    relation["source_mal_id"],
                    relation["target_mal_id"],
                    relation["relation_type"],
                ),
            )

    def _load_complete_catalog(self, db: sqlite3.Connection) -> None:
        if not self.catalog_path or not self.catalog_path.exists():
            raise FileNotFoundError(
                f"完整作品表不存在: {self.catalog_path}"
            )
        signature = (
            f"{self.catalog_path.resolve()}|"
            f"{self.catalog_path.stat().st_size}|"
            f"{self.catalog_path.stat().st_mtime_ns}|"
            f"{self._title_mapping_signature()}|catalog-payload-v2"
        )
        current = db.execute(
            "SELECT value FROM system_metadata WHERE key = 'catalog_signature'"
        ).fetchone()
        if current and current["value"] == signature:
            return

        frame = pl.read_parquet(self.catalog_path).sort("anime_id")
        if (
            (
                self.expected_catalog_items is not None
                and frame.height != self.expected_catalog_items
            )
            or frame["mal_id"].n_unique() != frame.height
            or frame["mal_id"].null_count()
        ):
            raise ValueError(
                "完整作品表未通过行数、MAL ID 唯一且非空检查。"
            )
        title_overrides = self._load_title_overrides()
        payloads = []
        for index, row in enumerate(frame.iter_rows(named=True)):
            override = title_overrides.get(int(row["mal_id"]), {})
            payload = {
                "mal_id": int(row["mal_id"]),
                "title_zh": override.get("title_zh") or row["title"],
                "title_native": (
                    override.get("title_native")
                    or row["alternative_title"]
                    or row["title"]
                ),
                "title_en": row["title"],
                "format": row["format"],
                "episodes": row["episodes"],
                "year": row["year"],
                "release_status": row.get("release_status") or "未知",
                "synopsis": row.get("synopsis") or "",
                "cover_index": index % 8,
                "cover_url": row["image_url"],
                "is_adult": bool(
                    row.get("is_adult")
                    or "Hentai" in (row["genres"] or "")
                ),
                "platform_mean": row["source_score"],
                "bangumi_score": override.get("bangumi_score"),
                "matched_tags": [],
            }
            payloads.append(
                (
                    payload["mal_id"],
                    json.dumps(payload, ensure_ascii=False),
                )
            )
        db.execute("DELETE FROM anime")
        db.execute("DELETE FROM relations")
        db.executemany(
            "INSERT INTO anime(mal_id, payload) VALUES (?, ?)", payloads
        )
        db.execute(
            """
            INSERT INTO system_metadata(key, value)
            VALUES ('catalog_signature', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            """,
            (signature,),
        )

    def _title_mapping_signature(self) -> str:
        path = self.title_mapping_path
        if not path or not path.exists():
            return "no-title-mapping"
        return (
            f"{path.resolve()}|{path.stat().st_size}|"
            f"{path.stat().st_mtime_ns}"
        )

    def _load_title_overrides(
        self,
    ) -> dict[int, dict[str, str | float | None]]:
        path = self.title_mapping_path
        if not path or not path.exists():
            return {}
        schema = pl.read_parquet_schema(path)
        columns = ["mal_id", "title_zh", "title_native"]
        if "score" in schema:
            columns.append("score")
        frame = (
            pl.read_parquet(
                path,
                columns=columns,
            )
            .filter(pl.col("mal_id").is_not_null())
            .unique("mal_id", keep="first")
        )
        return {
            int(row["mal_id"]): {
                "title_zh": row["title_zh"],
                "title_native": row["title_native"],
                "bangumi_score": (
                    float(row["score"])
                    if row.get("score") is not None
                    and float(row["score"]) > 0
                    else None
                ),
            }
            for row in frame.iter_rows(named=True)
        }

    def anime_count(self) -> int:
        with self.connection() as db:
            return int(db.execute("SELECT count(*) FROM anime").fetchone()[0])

    def bangumi_metadata(
        self, mal_ids: list[int]
    ) -> dict[int, dict]:
        if not mal_ids:
            return {}
        placeholders = ",".join("?" for _ in mal_ids)
        with self.connection() as db:
            rows = db.execute(
                f"""
                SELECT mal_id, payload
                FROM bangumi_metadata
                WHERE mal_id IN ({placeholders})
                """,
                tuple(mal_ids),
            ).fetchall()
        return {
            int(row["mal_id"]): json.loads(row["payload"])
            for row in rows
        }

    def save_bangumi_metadata(
        self, records: dict[int, dict]
    ) -> None:
        if not records:
            return
        now = utcnow()
        with self.connection() as db:
            db.executemany(
                """
                INSERT INTO bangumi_metadata(
                    mal_id, subject_id, payload, fetched_at
                )
                VALUES (?, ?, ?, ?)
                ON CONFLICT(mal_id) DO UPDATE SET
                    subject_id = excluded.subject_id,
                    payload = excluded.payload,
                    fetched_at = excluded.fetched_at
                """,
                [
                    (
                        int(mal_id),
                        int(metadata["bangumi_subject_id"]),
                        json.dumps(metadata, ensure_ascii=False),
                        now,
                    )
                    for mal_id, metadata in records.items()
                ],
            )

    def profile_exists(
        self, profile_id: int, workspace_id: str = "local"
    ) -> bool:
        with self.connection() as db:
            return (
                db.execute(
                    """
                    SELECT 1 FROM profiles
                    WHERE id = ? AND workspace_id = ?
                    """,
                    (profile_id, workspace_id),
                ).fetchone()
                is not None
            )

    def list_profiles(self, workspace_id: str = "local") -> list[dict]:
        with self.connection() as db:
            rows = db.execute(
                """
                SELECT p.*, COUNT(r.mal_id) AS rating_count
                FROM profiles p LEFT JOIN ratings r
                ON p.id = r.profile_id AND r.rating IS NOT NULL
                WHERE p.workspace_id = ?
                GROUP BY p.id ORDER BY p.id
                """,
                (workspace_id,),
            ).fetchall()
            return [dict(row) for row in rows]

    def create_profile(
        self,
        name: str,
        title_language: str,
        workspace_id: str = "local",
    ) -> dict:
        now = utcnow()
        with self.connection() as db:
            cursor = db.execute(
                """
                INSERT INTO profiles(
                    name, title_language, workspace_id, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?)
                """,
                (name, title_language, workspace_id, now, now),
            )
            return {
                "id": cursor.lastrowid,
                "name": name,
                "title_language": title_language,
                "created_at": now,
                "updated_at": now,
                "rating_count": 0,
            }

    def delete_profile(
        self, profile_id: int, workspace_id: str = "local"
    ) -> bool:
        with self.connection() as db:
            cursor = db.execute(
                """
                DELETE FROM profiles
                WHERE id = ? AND workspace_id = ?
                """,
                (profile_id, workspace_id),
            )
            return cursor.rowcount > 0

    def upsert_ratings(self, profile_id: int, items: list[dict]) -> None:
        now = utcnow()
        with self.connection() as db:
            db.executemany(
                """
                INSERT INTO ratings(profile_id, mal_id, rating, status, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(profile_id, mal_id) DO UPDATE SET
                    rating = excluded.rating,
                    status = excluded.status,
                    updated_at = excluded.updated_at
                """,
                [
                    (
                        profile_id,
                        item["mal_id"],
                        item.get("rating"),
                        item["status"],
                        now,
                    )
                    for item in items
                ],
            )
            db.execute(
                "UPDATE profiles SET updated_at = ? WHERE id = ?",
                (now, profile_id),
            )

    def upsert_external_ratings(
        self, profile_id: int, items: list[dict]
    ) -> None:
        if not items:
            return
        now = utcnow()
        with self.connection() as db:
            db.executemany(
                """
                INSERT INTO external_ratings(
                    profile_id, source, external_id, rating, status,
                    payload, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(profile_id, source, external_id) DO UPDATE SET
                    rating = excluded.rating,
                    status = excluded.status,
                    payload = excluded.payload,
                    updated_at = excluded.updated_at
                """,
                [
                    (
                        profile_id,
                        item["source"],
                        str(item["external_id"]),
                        item.get("rating"),
                        item["status"],
                        json.dumps(
                            {
                                "title": item["title"],
                                "title_native": item.get("title_native"),
                                "cover_url": item.get("cover_url"),
                            },
                            ensure_ascii=False,
                        ),
                        now,
                    )
                    for item in items
                ],
            )
            db.execute(
                "UPDATE profiles SET updated_at = ? WHERE id = ?",
                (now, profile_id),
            )

    def external_library(self, profile_id: int) -> list[dict]:
        with self.connection() as db:
            rows = db.execute(
                """
                SELECT source, external_id, rating, status, payload, updated_at
                FROM external_ratings
                WHERE profile_id = ?
                ORDER BY updated_at DESC
                """,
                (profile_id,),
            ).fetchall()
            output = []
            for row in rows:
                record = dict(row)
                record.update(json.loads(record.pop("payload")))
                output.append(record)
            return output

    def associate_external_rating(
        self,
        profile_id: int,
        source: str,
        external_id: str,
        mal_id: int,
    ) -> bool:
        now = utcnow()
        with self.connection() as db:
            external = db.execute(
                """
                SELECT rating, status
                FROM external_ratings
                WHERE profile_id = ? AND source = ? AND external_id = ?
                """,
                (profile_id, source, external_id),
            ).fetchone()
            anime_exists = db.execute(
                "SELECT 1 FROM anime WHERE mal_id = ?",
                (mal_id,),
            ).fetchone()
            if not external or not anime_exists:
                return False
            db.execute(
                """
                INSERT INTO ratings(profile_id, mal_id, rating, status, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(profile_id, mal_id) DO UPDATE SET
                    rating = excluded.rating,
                    status = excluded.status,
                    updated_at = excluded.updated_at
                """,
                (
                    profile_id,
                    mal_id,
                    external["rating"],
                    external["status"],
                    now,
                ),
            )
            db.execute(
                """
                DELETE FROM external_ratings
                WHERE profile_id = ? AND source = ? AND external_id = ?
                """,
                (profile_id, source, external_id),
            )
            db.execute(
                "UPDATE profiles SET updated_at = ? WHERE id = ?",
                (now, profile_id),
            )
            return True

    def library(self, profile_id: int) -> list[dict]:
        with self.connection() as db:
            rows = db.execute(
                """
                SELECT r.*, a.payload, f.mal_id IS NOT NULL AS favorite,
                       h.mal_id IS NOT NULL AS hidden
                FROM ratings r
                LEFT JOIN anime a ON a.mal_id = r.mal_id
                LEFT JOIN favorites f ON f.profile_id = r.profile_id
                    AND f.mal_id = r.mal_id
                LEFT JOIN hidden h ON h.profile_id = r.profile_id
                    AND h.mal_id = r.mal_id
                WHERE r.profile_id = ?
                ORDER BY r.updated_at DESC
                """,
                (profile_id,),
            ).fetchall()
            output = []
            for row in rows:
                record = dict(row)
                payload = json.loads(record.pop("payload")) if record["payload"] else None
                record["anime"] = payload
                output.append(record)
            return output

    def collections(self, profile_id: int) -> dict[str, list[dict]]:
        collection_tables = {
            "favorites": "favorites",
            "hidden": "hidden",
        }
        output: dict[str, list[dict]] = {}
        with self.connection() as db:
            for key, table in collection_tables.items():
                rows = db.execute(
                    f"""
                    SELECT collection.mal_id, collection.created_at, anime.payload
                    FROM {table} AS collection
                    LEFT JOIN anime ON anime.mal_id = collection.mal_id
                    WHERE collection.profile_id = ?
                    ORDER BY collection.created_at DESC
                    """,
                    (profile_id,),
                ).fetchall()
                items = []
                for row in rows:
                    record = dict(row)
                    payload = record.pop("payload")
                    record["anime"] = json.loads(payload) if payload else None
                    items.append(record)
                output[key] = items
        return output

    def remove_collection_item(
        self,
        profile_id: int,
        collection: str,
        mal_id: int,
    ) -> bool:
        table = {
            "favorites": "favorites",
            "hidden": "hidden",
        }.get(collection)
        if table is None:
            return False
        with self.connection() as db:
            cursor = db.execute(
                f"DELETE FROM {table} WHERE profile_id = ? AND mal_id = ?",
                (profile_id, mal_id),
            )
            return cursor.rowcount > 0

    def profile_ratings(self, profile_id: int) -> dict[int, float]:
        with self.connection() as db:
            rows = db.execute(
                """
                SELECT mal_id, rating FROM ratings
                WHERE profile_id = ? AND rating BETWEEN 1 AND 10
                AND status != 'plan_to_watch'
                """,
                (profile_id,),
            ).fetchall()
            return {row["mal_id"]: row["rating"] for row in rows}

    def excluded(self, profile_id: int) -> set[int]:
        with self.connection() as db:
            rows = db.execute(
                """
                SELECT mal_id FROM ratings WHERE profile_id = ?
                UNION SELECT mal_id FROM hidden WHERE profile_id = ?
                """,
                (profile_id, profile_id),
            ).fetchall()
            return {row["mal_id"] for row in rows}

    def save_run(
        self,
        profile_id: int,
        model_version: str,
        data_version: str,
        filters: dict,
        status: str,
        items: list[dict],
    ) -> int:
        with self.connection() as db:
            cursor = db.execute(
                """
                INSERT INTO recommendation_runs(
                    profile_id, created_at, model_version, data_version, filters, status
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    profile_id,
                    utcnow(),
                    model_version,
                    data_version,
                    json.dumps(filters, ensure_ascii=False),
                    status,
                ),
            )
            run_id = int(cursor.lastrowid)
            db.executemany(
                """
                INSERT INTO recommendation_items(run_id, mal_id, position, payload)
                VALUES (?, ?, ?, ?)
                """,
                [
                    (
                        run_id,
                        item["anime"]["mal_id"],
                        position,
                        json.dumps(item, ensure_ascii=False),
                    )
                    for position, item in enumerate(items, start=1)
                ],
            )
            return run_id

    def get_run(
        self, run_id: int, workspace_id: str = "local"
    ) -> dict | None:
        with self.connection() as db:
            row = db.execute(
                """
                SELECT r.*
                FROM recommendation_runs r
                JOIN profiles p ON p.id = r.profile_id
                WHERE r.id = ? AND p.workspace_id = ?
                """,
                (run_id, workspace_id),
            ).fetchone()
            if not row:
                return None
            items = db.execute(
                """
                SELECT payload FROM recommendation_items
                WHERE run_id = ? ORDER BY position
                """,
                (run_id,),
            ).fetchall()
            result = dict(row)
            result["items"] = [json.loads(item["payload"]) for item in items]
            return result

    def history(
        self,
        profile_id: int | None = None,
        workspace_id: str = "local",
    ) -> list[dict]:
        query = """
            SELECT r.*, COUNT(i.mal_id) AS item_count
            FROM recommendation_runs r
            JOIN profiles p ON p.id = r.profile_id
            LEFT JOIN recommendation_items i ON i.run_id = r.id
        """
        clauses = ["p.workspace_id = ?"]
        params: tuple = (workspace_id,)
        if profile_id is not None:
            clauses.append("r.profile_id = ?")
            params += (profile_id,)
        query += " WHERE " + " AND ".join(clauses)
        query += " GROUP BY r.id ORDER BY r.id DESC"
        with self.connection() as db:
            rows = db.execute(query, params).fetchall()
            return [dict(row) for row in rows]

    def delete_run(
        self, run_id: int, workspace_id: str = "local"
    ) -> bool:
        with self.connection() as db:
            cursor = db.execute(
                """
                DELETE FROM recommendation_runs
                WHERE id = ? AND profile_id IN (
                    SELECT id FROM profiles WHERE workspace_id = ?
                )
                """,
                (run_id, workspace_id),
            )
            return cursor.rowcount > 0

    def anime_search(
        self,
        query: str,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[dict], int]:
        query = query.strip().lower()
        with self.connection() as db:
            if query:
                pattern = f"%{query}%"
                where = """
                    WHERE lower(
                        coalesce(json_extract(payload, '$.title_zh'), '')
                        || ' ' ||
                        coalesce(json_extract(payload, '$.title_native'), '')
                        || ' ' ||
                        coalesce(json_extract(payload, '$.title_en'), '')
                    ) LIKE ?
                """
                total = int(
                    db.execute(
                        f"SELECT count(*) FROM anime {where}",
                        (pattern,),
                    ).fetchone()[0]
                )
                rows = db.execute(
                    f"""
                    SELECT payload FROM anime
                    {where}
                    ORDER BY mal_id
                    LIMIT ? OFFSET ?
                    """,
                    (pattern, limit, offset),
                ).fetchall()
            else:
                total = int(
                    db.execute("SELECT count(*) FROM anime").fetchone()[0]
                )
                rows = db.execute(
                    """
                    SELECT payload FROM anime
                    ORDER BY mal_id
                    LIMIT ? OFFSET ?
                    """,
                    (limit, offset),
                ).fetchall()
        return [json.loads(row["payload"]) for row in rows], total

    def anime_detail(self, mal_id: int) -> dict | None:
        with self.connection() as db:
            row = db.execute(
                "SELECT payload FROM anime WHERE mal_id = ?", (mal_id,)
            ).fetchone()
            if not row:
                return None
            anime = json.loads(row["payload"])
            anime["relations"] = [
                dict(relation)
                for relation in db.execute(
                    "SELECT * FROM relations WHERE source_mal_id = ?", (mal_id,)
                ).fetchall()
            ]
            return anime

    def feedback(
        self,
        run_id: int,
        profile_id: int,
        mal_id: int,
        action: str,
    ) -> None:
        now = utcnow()
        with self.connection() as db:
            db.execute(
                """
                INSERT INTO feedback(run_id, profile_id, mal_id, action, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (run_id, profile_id, mal_id, action, now),
            )
            if action == "favorite":
                db.execute(
                    """
                    INSERT OR REPLACE INTO favorites(profile_id, mal_id, created_at)
                    VALUES (?, ?, ?)
                    """,
                    (profile_id, mal_id, now),
                )
                db.execute(
                    "DELETE FROM hidden WHERE profile_id = ? AND mal_id = ?",
                    (profile_id, mal_id),
                )
            if action == "hide":
                db.execute(
                    """
                    INSERT OR REPLACE INTO hidden(profile_id, mal_id, created_at)
                    VALUES (?, ?, ?)
                    """,
                    (profile_id, mal_id, now),
                )
                db.execute(
                    "DELETE FROM favorites WHERE profile_id = ? AND mal_id = ?",
                    (profile_id, mal_id),
                )

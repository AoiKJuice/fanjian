from __future__ import annotations

import io
import json
import os
import statistics
import xml.etree.ElementTree as ET
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from .anilist import AniListClient, AniListError
from .bangumi import (
    BangumiClient,
    BangumiError,
    BangumiMappingUnavailable,
)
from .database import Database
from .models import (
    ExternalAssociationInput,
    FeedbackInput,
    ImportAniListRequest,
    ImportBangumiRequest,
    ImportPreview,
    Profile,
    ProfileCreate,
    RatingInput,
    RatingUpdate,
    RecommendationRequest,
    RecommendationRun,
)
from .production_recommender import DiskBackedUserKNN
from .recommender import DATA_VERSION, MODEL_VERSION, SurpriseUserKNN


@asynccontextmanager
async def lifespan(app: FastAPI):
    use_demo = os.getenv("ANIME_USE_DEMO") == "1"
    configured_mapping_path = os.getenv("BANGUMI_MAPPING_PATH")
    model_root: Path | None = None
    if use_demo:
        title_mapping_path = (
            Path(configured_mapping_path)
            if configured_mapping_path
            else Path(
                "data/processed/anime-model-open-2026-27/"
                "bangumi-mapping.parquet"
            )
        )
        app.state.recommender = SurpriseUserKNN()
        app.state.model_version = MODEL_VERSION
        app.state.data_version = DATA_VERSION
        app.state.db = Database(os.getenv("ANIME_DB_PATH"))
        app.state.model_mode = "demo"
    else:
        model_root = Path(
            os.getenv(
                "ANIME_MODEL_PATH",
                "data/processed/anime-model-open-2026-27",
            )
        )
        bundled_mapping_path = model_root / "bangumi-mapping.parquet"
        title_mapping_path = (
            Path(configured_mapping_path)
            if configured_mapping_path
            else bundled_mapping_path
            if bundled_mapping_path.exists()
            else model_root / "bangumi-mapping.parquet"
        )
        manifest_path = model_root / "manifest.json"
        if not manifest_path.exists():
            raise RuntimeError(
                "没有找到真实模型。请先生成完整数据模型，或仅在测试时设置 "
                "ANIME_USE_DEMO=1。"
            )
        selection_path = model_root / "model-selection.json"
        selection = (
            json.loads(selection_path.read_text(encoding="utf-8"))
            if selection_path.exists()
            else {
                "selected_algorithm": "mean_centered_userknn",
                "production_similarity_mode": "mean_centered",
                "parameters": {
                    "overlap_min": 10,
                    "shrinkage": 25,
                    "neighbor_count": 100,
                    "surprise_mix": 0.5,
                    "uncertainty_penalty": 0.25,
                    "min_support": 10,
                    "ranking_mode": "residual",
                },
            }
        )
        parameters = selection["parameters"]
        serving_parameters = {
            "overlap_min": int(
                os.getenv("ANIME_OVERLAP_MIN", "10")
            ),
            "shrinkage": float(
                os.getenv("ANIME_SIMILARITY_SHRINKAGE", "25")
            ),
            "neighbor_count": int(
                os.getenv("ANIME_NEIGHBOR_COUNT", "50")
            ),
            "surprise_mix": float(
                os.getenv("ANIME_SURPRISE_MIX", "0.25")
            ),
            "uncertainty_penalty": float(
                os.getenv("ANIME_UNCERTAINTY_PENALTY", "0.5")
            ),
            "positive_signal_weight": float(
                os.getenv("ANIME_POSITIVE_SIGNAL_WEIGHT", "2.0")
            ),
            "negative_signal_weight": float(
                os.getenv("ANIME_NEGATIVE_SIGNAL_WEIGHT", "0.25")
            ),
            "neutral_signal_weight": float(
                os.getenv("ANIME_NEUTRAL_SIGNAL_WEIGHT", "0.5")
            ),
            "absolute_preference_weight": float(
                os.getenv("ANIME_ABSOLUTE_PREFERENCE_WEIGHT", "0.75")
            ),
            "anchor_neighbor_quota": int(
                os.getenv("ANIME_ANCHOR_NEIGHBOR_QUOTA", "4")
            ),
        }
        app.state.production_min_support = int(
            os.getenv("ANIME_MIN_SUPPORT", "5")
        )
        app.state.serving_parameters = serving_parameters
        app.state.recommender = DiskBackedUserKNN(
            model_root,
            **serving_parameters,
            similarity_mode=selection["production_similarity_mode"],
            ranking_mode=parameters.get("ranking_mode", "residual"),
            title_mapping_path=title_mapping_path,
        )
        app.state.model_version = (
            f"{selection['selected_algorithm']}-series-balanced-rank-v3"
        )
        app.state.data_version = (
            app.state.recommender.manifest.get("data_version")
            or (
                "user-animelist-v1+catalog-"
                f"{app.state.recommender.manifest['ratings']['catalog_items']}"
            )
        )
        app.state.db = Database(
            os.getenv("ANIME_DB_PATH"),
            catalog_path=model_root / "catalog.parquet",
            expected_catalog_items=app.state.recommender.manifest[
                "ratings"
            ]["catalog_items"],
            title_mapping_path=title_mapping_path,
        )
        app.state.model_mode = "full"
    app.state.anilist = AniListClient()
    app.state.bangumi = BangumiClient(
        mapping_path=title_mapping_path,
        catalog_path=(
            model_root / "catalog.parquet"
            if model_root is not None
            else None
        ),
    )
    yield


app = FastAPI(
    title="番剧亲和度研究室 API",
    version="0.1.0",
    description="本地优先的用户评分协同过滤研究服务。",
    lifespan=lifespan,
)
browser_origins = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "https://aoikjuice.com",
    "https://www.aoikjuice.com",
]
browser_origins.extend(
    origin.strip()
    for origin in os.getenv("ANIME_CORS_ORIGINS", "").split(",")
    if origin.strip()
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=browser_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_private_network=True,
)


def db() -> Database:
    return app.state.db


async def enrich_bangumi_metadata(anime_items: list[dict]) -> None:
    mal_ids = [
        int(anime["mal_id"])
        for anime in anime_items
        if anime.get("mal_id") is not None
    ]
    cached = db().bangumi_metadata(mal_ids)
    missing = [mal_id for mal_id in mal_ids if mal_id not in cached]
    fetched = await app.state.bangumi.subject_metadata(missing)
    if fetched:
        db().save_bangumi_metadata(fetched)
    metadata_by_mal = {**cached, **fetched}
    for anime in anime_items:
        metadata = metadata_by_mal.get(int(anime["mal_id"]))
        if not metadata:
            continue
        for field in (
            "bangumi_score",
            "title_zh",
            "title_native",
            "synopsis",
            "cover_url",
        ):
            value = metadata.get(field)
            if value not in (None, ""):
                anime[field] = value


def require_profile(profile_id: int) -> None:
    if not db().profile_exists(profile_id):
        raise HTTPException(status_code=404, detail="本地资料不存在")


@app.get("/api/v1/health")
def health() -> dict:
    return {
        "status": "ok",
        "model_version": app.state.model_version,
        "data_version": app.state.data_version,
        "model_mode": app.state.model_mode,
        "catalog_items": db().anime_count(),
        "training_users": (
            app.state.recommender.manifest["ratings"]["users"]
            if app.state.model_mode == "full"
            else len(app.state.recommender.residuals)
        ),
        "training_ratings": (
            app.state.recommender.manifest["ratings"]["cleaned_rows"]
            if app.state.model_mode == "full"
            else len(app.state.recommender.ratings)
        ),
    }


@app.get("/api/v1/profiles", response_model=list[Profile])
def list_profiles() -> list[dict]:
    return db().list_profiles()


@app.post("/api/v1/profiles", response_model=Profile, status_code=201)
def create_profile(payload: ProfileCreate) -> dict:
    return db().create_profile(payload.name, payload.title_language)


@app.delete("/api/v1/profiles/{profile_id}", status_code=204)
def delete_profile(profile_id: int) -> None:
    if not db().delete_profile(profile_id):
        raise HTTPException(status_code=404, detail="本地资料不存在")


@app.get("/api/v1/profiles/{profile_id}/library")
def library(profile_id: int) -> dict:
    require_profile(profile_id)
    return {
        "items": db().library(profile_id),
        "unmapped_items": db().external_library(profile_id),
    }


@app.get("/api/v1/profiles/{profile_id}/collections")
def collections(profile_id: int) -> dict:
    require_profile(profile_id)
    return db().collections(profile_id)


@app.post("/api/v1/profiles/{profile_id}/library/associate")
def associate_external_library_item(
    profile_id: int,
    payload: ExternalAssociationInput,
) -> dict:
    require_profile(profile_id)
    if not db().associate_external_rating(
        profile_id,
        payload.source,
        payload.external_id,
        payload.mal_id,
    ):
        raise HTTPException(
            status_code=404,
            detail="待关联记录或目标作品不存在",
        )
    return {
        "associated": True,
        "mal_id": payload.mal_id,
        "recommendations_stale": True,
    }


@app.delete(
    "/api/v1/profiles/{profile_id}/collections/{collection}/{mal_id}",
    status_code=204,
)
def remove_collection_item(
    profile_id: int,
    collection: str,
    mal_id: int,
) -> None:
    require_profile(profile_id)
    if collection not in {"favorites", "hidden"}:
        raise HTTPException(status_code=422, detail="未知的收藏类型")
    if not db().remove_collection_item(profile_id, collection, mal_id):
        raise HTTPException(status_code=404, detail="记录不存在")


@app.put("/api/v1/profiles/{profile_id}/ratings")
def update_ratings(profile_id: int, payload: RatingUpdate) -> dict:
    require_profile(profile_id)
    db().upsert_ratings(
        profile_id, [item.model_dump() for item in payload.items]
    )
    db().upsert_external_ratings(
        profile_id,
        [item.model_dump() for item in payload.external_items],
    )
    return {
        "updated": len(payload.items),
        "external_updated": len(payload.external_items),
        "recommendations_stale": bool(payload.items),
    }


@app.post(
    "/api/v1/profiles/import/anilist",
    response_model=ImportPreview,
)
async def import_anilist(payload: ImportAniListRequest) -> dict:
    require_profile(payload.profile_id)
    try:
        entries = await app.state.anilist.import_user(payload.username)
    except AniListError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    mapped: dict[int, dict] = {}
    unmapped = 0
    unrated = 0
    duplicates = 0
    for entry in sorted(
        entries, key=lambda item: item.get("updated_at") or 0
    ):
        mal_id = entry.get("mal_id")
        if not mal_id:
            unmapped += 1
            continue
        if mal_id in mapped:
            duplicates += 1
        if not entry.get("rating"):
            unrated += 1
        mapped[mal_id] = {
            "mal_id": mal_id,
            "rating": entry.get("rating"),
            "status": entry["status"],
        }
    items = [RatingInput(**entry).model_dump() for entry in mapped.values()]
    warnings = []
    if unmapped:
        warnings.append(f"{unmapped} 条记录没有 MAL ID，需要人工关联。")
    return {
        "imported": len(items),
        "unmapped": unmapped,
        "duplicates": duplicates,
        "unrated": unrated,
        "items": items,
        "warnings": warnings,
    }


@app.post(
    "/api/v1/profiles/import/bangumi",
    response_model=ImportPreview,
)
async def import_bangumi(payload: ImportBangumiRequest) -> dict:
    require_profile(payload.profile_id)
    try:
        entries = await app.state.bangumi.import_user(
            payload.username,
            payload.access_token,
        )
    except BangumiMappingUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except BangumiError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    mapped: dict[int, dict] = {}
    unmapped = 0
    unrated = 0
    duplicates = 0
    title_resolved = 0
    unmapped_items = []
    for entry in sorted(
        entries, key=lambda item: item.get("updated_at") or ""
    ):
        if entry.get("rating") is None:
            unrated += 1
        mal_id = entry.get("mal_id")
        if not mal_id:
            unmapped += 1
            unmapped_items.append(
                {
                    "source": "bangumi",
                    "external_id": str(entry["bangumi_subject_id"]),
                    "title": entry["title"],
                    "title_native": entry.get("title_native"),
                    "rating": entry.get("rating"),
                    "status": entry["status"],
                    "cover_url": entry.get("cover_url"),
                }
            )
            continue
        if mal_id in mapped:
            duplicates += 1
        if entry.get("mapping_method") in {
            "exact_title_and_year",
            "unique_exact_title",
        }:
            title_resolved += 1
        mapped[mal_id] = {
            "mal_id": mal_id,
            "rating": entry.get("rating"),
            "status": entry["status"],
        }
    items = [RatingInput(**entry).model_dump() for entry in mapped.values()]
    warnings = []
    if unrated:
        warnings.append(
            f"{unrated} 条未评分收藏会保留，可在片库中之后评分。"
        )
    if unmapped:
        warnings.append(
            f"{unmapped} 条收藏无法可靠关联 MAL ID，将保存在待关联项目中。"
        )
    if title_resolved:
        warnings.append(
            f"{title_resolved} 条收藏通过本地完整番剧目录的精确标题关联。"
        )
    return {
        "imported": len(items) + len(unmapped_items),
        "unmapped": unmapped,
        "duplicates": duplicates,
        "unrated": unrated,
        "items": items,
        "unmapped_items": unmapped_items,
        "warnings": warnings,
    }


@app.post("/api/v1/profiles/import/mal", response_model=ImportPreview)
async def import_mal(
    profile_id: int = Form(...),
    file: UploadFile = File(...),
) -> dict:
    require_profile(profile_id)
    content = await file.read()
    try:
        root = ET.parse(io.BytesIO(content)).getroot()
    except ET.ParseError as exc:
        raise HTTPException(status_code=422, detail="MAL XML 文件无法解析") from exc
    status_map = {
        "Completed": "completed",
        "Watching": "watching",
        "Dropped": "dropped",
        "On-Hold": "on_hold",
        "Plan to Watch": "plan_to_watch",
    }
    items = []
    unrated = 0
    for node in root.findall("anime"):
        mal_id_text = node.findtext("series_animedb_id")
        if not mal_id_text:
            continue
        score = float(node.findtext("my_score") or 0)
        if score <= 0:
            score = None
            unrated += 1
        items.append(
            {
                "mal_id": int(mal_id_text),
                "rating": score,
                "status": status_map.get(
                    node.findtext("my_status") or "", "plan_to_watch"
                ),
            }
        )
    return {
        "imported": len(items),
        "unmapped": 0,
        "duplicates": 0,
        "unrated": unrated,
        "items": items,
        "warnings": [],
    }


@app.post("/api/v1/recommendations", response_model=RecommendationRun)
async def create_recommendations(payload: RecommendationRequest) -> dict:
    require_profile(payload.profile_id)
    ratings = db().profile_ratings(payload.profile_id)
    status = (
        "ready"
        if len(ratings) >= app.state.recommender.overlap_min
        else "insufficient"
    )
    items = (
        app.state.recommender.recommend(
            ratings,
            excluded=db().excluded(payload.profile_id),
            limit=payload.limit,
            min_support=max(
                payload.min_support,
                getattr(app.state, "production_min_support", 1),
            ),
            allow_sequels=payload.allow_sequels,
            formats=payload.formats,
        )
        if status == "ready"
        else []
    )
    await enrich_bangumi_metadata(
        [item["anime"] for item in items]
    )
    run_id = db().save_run(
        payload.profile_id,
        app.state.model_version,
        app.state.data_version,
        payload.model_dump(exclude={"profile_id"}),
        status,
        items,
    )
    return db().get_run(run_id)


@app.get("/api/v1/recommendations/history")
def recommendation_history(profile_id: int | None = None) -> dict:
    if profile_id is not None:
        require_profile(profile_id)
    return {"items": db().history(profile_id)}


@app.get("/api/v1/recommendations/{run_id}", response_model=RecommendationRun)
async def recommendation_run(run_id: int) -> dict:
    run = db().get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="推荐记录不存在")
    await enrich_bangumi_metadata(
        [item["anime"] for item in run["items"]]
    )
    return run


@app.delete("/api/v1/recommendations/{run_id}", status_code=204)
def delete_recommendation_run(run_id: int) -> None:
    if not db().delete_run(run_id):
        raise HTTPException(status_code=404, detail="推荐记录不存在")


@app.post("/api/v1/recommendations/{run_id}/feedback")
def recommendation_feedback(run_id: int, payload: FeedbackInput) -> dict:
    run = db().get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="推荐记录不存在")
    if payload.action == "watched":
        if payload.rating is None or payload.status is None:
            raise HTTPException(
                status_code=422,
                detail="标记已经看过时必须选择状态和评分",
            )
        db().upsert_ratings(
            run["profile_id"],
            [
                {
                    "mal_id": payload.mal_id,
                    "rating": payload.rating,
                    "status": payload.status,
                }
            ],
        )
    db().feedback(
        run_id,
        run["profile_id"],
        payload.mal_id,
        payload.action,
    )
    return {"saved": True, "action": payload.action}


@app.get("/api/v1/anime/search")
def anime_search(
    q: str = Query(default="", max_length=100),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
) -> dict:
    items, total = db().anime_search(q, limit=limit, offset=offset)
    return {
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@app.get("/api/v1/anime/{mal_id}")
async def anime_detail(mal_id: int) -> dict:
    anime = db().anime_detail(mal_id)
    if not anime:
        raise HTTPException(status_code=404, detail="未找到这部番剧")
    await enrich_bangumi_metadata([anime])
    return anime


@app.get("/api/v1/profiles/{profile_id}/insights")
def insights(profile_id: int) -> dict:
    require_profile(profile_id)
    profile_ratings = db().profile_ratings(profile_id)
    ratings = list(profile_ratings.values())
    count = len(ratings)
    mean = statistics.fmean(ratings) if ratings else 0
    deviation = statistics.pstdev(ratings) if len(ratings) > 1 else 0
    neighbors = app.state.recommender.neighbors(
        db().profile_ratings(profile_id)
    )
    histogram = {str(score): 0 for score in range(1, 11)}
    for rating in ratings:
        histogram[str(round(rating))] += 1
    quality = (
        "高"
        if count >= 30 and deviation >= 0.75
        else "中"
        if count >= 5 and deviation >= 0.5
        else "低"
    )
    catalog_counts = sorted(
        app.state.recommender.item_rating_counts.values()
    )
    long_tail_limit = (
        catalog_counts[int((len(catalog_counts) - 1) * 0.33)]
        if catalog_counts
        else 0
    )
    watched_counts = [
        app.state.recommender.item_rating_counts[mal_id]
        for mal_id in profile_ratings
        if mal_id in app.state.recommender.item_rating_counts
    ]
    popularity_percentiles = [
        sum(value <= count for value in catalog_counts) / len(catalog_counts)
        for count in watched_counts
    ]
    return {
        "rating_count": count,
        "mean_rating": round(mean, 2),
        "rating_stddev": round(deviation, 2),
        "distinct_integer_scores": len({round(score) for score in ratings}),
        "quality": quality,
        "neighbor_count": len(neighbors),
        "mean_overlap": (
            round(statistics.fmean([n.overlap for n in neighbors]), 2)
            if neighbors
            else 0
        ),
        "histogram": histogram,
        "mainstream_index": (
            round(statistics.fmean(popularity_percentiles) * 100, 1)
            if popularity_percentiles
            else 0
        ),
        "long_tail_ratio": (
            round(
                100
                * sum(count <= long_tail_limit for count in watched_counts)
                / len(watched_counts),
                1,
            )
            if watched_counts
            else 0
        ),
    }


@app.get("/api/v1/system/model-card")
def model_card() -> dict:
    return {
        "model_version": app.state.model_version,
        "data_version": app.state.data_version,
        "algorithm": (
            app.state.model_version.removesuffix(
                "-series-balanced-rank-v3"
            )
            .replace("_", " ")
        ),
        "model_mode": app.state.model_mode,
        "catalog_items": db().anime_count(),
        "training_users": (
            app.state.recommender.manifest["ratings"]["users"]
            if app.state.model_mode == "full"
            else len(app.state.recommender.residuals)
        ),
        "training_ratings": (
            app.state.recommender.manifest["ratings"]["cleaned_rows"]
            if app.state.model_mode == "full"
            else len(app.state.recommender.ratings)
        ),
        "core_signals": [
            "共同评分标准化残差",
            "共同评分数收缩",
            "IUF 与评分事件稀有度",
            "正相似邻居",
            "邻居加权校准残差",
            "候选评分样本数与有效样本量",
            "同系列评分信号降权",
            "相似用户绝对评分共识",
            "正向偏好优先、负向偏好辅助",
        ],
        "ranking_mode": getattr(
            app.state.recommender, "ranking_mode", "demo"
        ),
        "minimum_neighbor_support": getattr(
            app.state, "production_min_support", None
        ),
        "serving_parameters": getattr(
            app.state, "serving_parameters", None
        ),
        "excluded_signals": ["标签", "简介", "平台平均分", "评论文本"],
        "known_limits": [
            "冷启动用户需要至少达到共同评分门槛",
            "作品关系数据尚未达到完整关系图标准",
            "新增目录作品没有评分证据时不进入协同过滤候选",
        ],
    }

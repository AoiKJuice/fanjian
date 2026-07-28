from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator


WatchStatus = Literal[
    "completed", "watching", "dropped", "on_hold", "plan_to_watch"
]


class ProfileCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    title_language: Literal["zh", "native", "en"] = "zh"


class Profile(BaseModel):
    id: int
    name: str
    title_language: str
    created_at: str
    updated_at: str
    rating_count: int = 0


class RatingInput(BaseModel):
    mal_id: int
    rating: float | None = Field(default=None, ge=1, le=10)
    status: WatchStatus

    @model_validator(mode="after")
    def clear_plan_to_watch_rating(self) -> "RatingInput":
        if self.status == "plan_to_watch":
            self.rating = None
        return self


class ExternalRatingInput(BaseModel):
    source: Literal["bangumi"]
    external_id: str = Field(min_length=1, max_length=100)
    title: str = Field(min_length=1, max_length=300)
    title_native: str | None = Field(default=None, max_length=300)
    rating: float | None = Field(default=None, ge=1, le=10)
    status: WatchStatus
    cover_url: str | None = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def clear_plan_to_watch_rating(self) -> "ExternalRatingInput":
        if self.status == "plan_to_watch":
            self.rating = None
        return self


class RatingUpdate(BaseModel):
    items: list[RatingInput]
    external_items: list[ExternalRatingInput] = Field(default_factory=list)


class ExternalAssociationInput(BaseModel):
    source: Literal["bangumi"]
    external_id: str = Field(min_length=1, max_length=100)
    mal_id: int


class RecommendationRequest(BaseModel):
    profile_id: int
    limit: int = Field(default=20, ge=1, le=100)
    min_support: int = Field(default=5, ge=1, le=100)
    allow_sequels: bool = True
    formats: list[str] = []


class FeedbackInput(BaseModel):
    mal_id: int
    action: Literal["favorite", "hide", "watched", "useful", "not_useful"]
    rating: float | None = Field(default=None, ge=1, le=10)
    status: WatchStatus | None = None


class ImportAniListRequest(BaseModel):
    profile_id: int
    username: str = Field(min_length=1, max_length=80)


class ImportBangumiRequest(BaseModel):
    profile_id: int
    username: str = Field(min_length=1, max_length=80)
    access_token: str | None = Field(default=None, max_length=200)


class AnimeSummary(BaseModel):
    mal_id: int
    title_zh: str | None
    title_native: str
    title_en: str | None
    format: str
    episodes: int | None
    year: int | None
    release_status: str
    synopsis: str
    cover_index: int
    cover_url: str | None = None
    is_adult: bool = False
    platform_mean: float | None = None
    bangumi_score: float | None = None
    matched_tags: list[str] = Field(default_factory=list)


class RecommendationItem(BaseModel):
    anime: AnimeSummary
    rank_score: float
    affinity: int
    confidence: Literal["高", "中", "低"]
    support: int
    effective_sample_size: float
    reason: str
    evidence: list[dict]
    neighbor_distribution: dict[str, int]
    risk: str
    relation_notice: str | None = None


class RecommendationRun(BaseModel):
    id: int
    profile_id: int
    created_at: str
    model_version: str
    data_version: str
    status: Literal["ready", "insufficient"]
    items: list[RecommendationItem]


class ImportPreview(BaseModel):
    imported: int
    unmapped: int
    duplicates: int
    unrated: int
    items: list[RatingInput]
    unmapped_items: list[ExternalRatingInput] = Field(default_factory=list)
    warnings: list[str]


class ApiError(BaseModel):
    detail: str
    code: str
    at: datetime = Field(default_factory=datetime.utcnow)

from pydantic import BaseModel
from datetime import datetime
from typing import Optional

class AccountCreate(BaseModel):
    id: str
    name: str
    avatar: str = ""
    platform: str = "X"
    group: str = "未分组"
    priority: str = "normal"
    muted: bool = False
    rsshub_path: str  # e.g. "/twitter/user/karpathy"

class AccountOut(BaseModel):
    id: str
    name: str
    avatar: str
    platform: str
    group: str
    priority: str
    muted: bool
    rsshub_path: str

    model_config = {"from_attributes": True}

class AccountUpdate(BaseModel):
    priority: Optional[str] = None
    muted: Optional[bool] = None
    group: Optional[str] = None

class PostOut(BaseModel):
    id: str
    account_id: str
    title: str
    content: str
    url: str
    published_at: datetime
    metrics: dict
    is_abnormally_popular: bool

    model_config = {"from_attributes": True}

    @classmethod
    def from_orm_with_metrics(cls, obj):
        return cls(
            id=obj.id,
            account_id=obj.account_id,
            title=obj.title,
            content=obj.content,
            url=obj.url,
            published_at=obj.published_at,
            metrics={"likes": obj.likes, "reposts": obj.reposts, "comments": obj.comments},
            is_abnormally_popular=obj.is_abnormally_popular,
        )

class TopicOut(BaseModel):
    id: str
    title: str
    summary: str
    score: float
    urgency: str
    tags: list
    category: str
    sources: list
    competitor_count: int
    status: str
    recommend_reason: str
    trend_data: list
    direction_id: Optional[int] = None
    direction_name: str = ""
    strategy_id: Optional[int] = None
    strategy_name: str = ""
    cluster_id: str = ""
    cluster_title: str = ""
    cluster_source_count: int = 0
    created_at: datetime

    model_config = {"from_attributes": True}


class DirectionCreate(BaseModel):
    name: str
    description: str = ""


class DirectionUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None


class DirectionOut(BaseModel):
    id: int
    name: str
    description: str
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class StrategyCreate(BaseModel):
    name: str
    filter_hours: int = 48
    filter_min_views: int = 0
    filter_viral_only: bool = False
    filter_keywords: list = []
    filter_exclude_keywords: list = []
    llm_prompt: str = ""
    output_count: int = 5


class StrategyUpdate(BaseModel):
    name: Optional[str] = None
    filter_hours: Optional[int] = None
    filter_min_views: Optional[int] = None
    filter_viral_only: Optional[bool] = None
    filter_keywords: Optional[list] = None
    filter_exclude_keywords: Optional[list] = None
    llm_prompt: Optional[str] = None
    output_count: Optional[int] = None
    is_active: Optional[bool] = None


class StrategyOut(BaseModel):
    id: int
    direction_id: int
    name: str
    filter_hours: int
    filter_min_views: int
    filter_viral_only: bool
    filter_keywords: list
    filter_exclude_keywords: list
    llm_prompt: str
    output_count: int
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}

class TopicStatusUpdate(BaseModel):
    status: str

class TopicCreate(BaseModel):
    id: str
    title: str
    summary: str = ""
    score: float = 3.0
    urgency: str = "this_week"
    tags: list = []
    category: str = "人工智能"
    sources: list = []
    competitor_count: int = 0
    recommend_reason: str = ""
    trend_data: list = []

class HotspotOut(BaseModel):
    id: str
    title: str
    trend: str
    platforms: list
    heat: int
    trend_data: list
    category: str
    first_seen_at: datetime

    model_config = {"from_attributes": True}

class HotspotCreate(BaseModel):
    id: str
    title: str
    trend: str = "rising"
    platforms: list = []
    heat: int = 0
    trend_data: list = []
    category: str = "人工智能"

class CollectResult(BaseModel):
    account_id: str
    new_posts: int
    error: Optional[str] = None


class EconomicItemOut(BaseModel):
    id: str
    title: str
    summary: str
    category: str
    impact: str
    impact_level: str
    published_at: datetime

    model_config = {"from_attributes": True}


class GenerateResult(BaseModel):
    new_topics: int = 0
    new_hotspots: int = 0
    new_economic: int = 0
    message: str = ""


class WriterPersonaCreate(BaseModel):
    name: str
    description: str = ""
    prompt: str
    is_default: bool = False


class WriterPersonaUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    prompt: Optional[str] = None
    is_default: Optional[bool] = None


class WriterPersonaOut(BaseModel):
    id: int
    name: str
    description: str
    prompt: str
    is_default: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class ArticleDraftRequest(BaseModel):
    topic_id: str
    persona_id: Optional[int] = None


class ArticleDraftOut(BaseModel):
    id: Optional[int] = None
    topic_id: str
    title: str = ""
    draft: str
    content: str = ""
    status: str = "drafting"
    persona_id: Optional[int] = None
    version: int = 1
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class ArticleDraftCreate(BaseModel):
    topic_id: str
    title: str = ""
    content: str = ""
    status: str = "drafting"
    persona_id: Optional[int] = None


class ArticleDraftUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    status: Optional[str] = None
    persona_id: Optional[int] = None


class ArticleDraftRecordOut(BaseModel):
    id: int
    topic_id: str
    title: str
    content: str
    status: str
    persona_id: Optional[int] = None
    version: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class GithubRepoCreate(BaseModel):
    owner: str
    repo: str
    group: str = "未分组"
    collect_interval_minutes: int = 10


class GithubRepoUpdate(BaseModel):
    group: Optional[str] = None
    muted: Optional[bool] = None
    collect_interval_minutes: Optional[int] = None


class GithubRepoOut(BaseModel):
    id: str
    owner: str
    repo: str
    description: str
    stars: int
    language: str
    group: str
    muted: bool
    collect_interval_minutes: int
    last_collected_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class GithubIssueOut(BaseModel):
    id: str
    repo_id: str
    number: int
    title: str
    body: str
    labels: list
    state: str
    comments: int
    reactions: int
    html_url: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class IssuePainPointOut(BaseModel):
    id: str
    repo_id: str
    title: str
    description: str
    issue_count: int
    example_issues: list
    category: str
    severity: str
    created_at: datetime

    model_config = {"from_attributes": True}


class GithubReleaseOut(BaseModel):
    id: str
    repo_id: str
    tag_name: str
    name: str
    body: str
    is_prerelease: bool
    is_draft: bool
    html_url: str
    published_at: datetime

    model_config = {"from_attributes": True}


class GithubTrendingRepoOut(BaseModel):
    id: str
    owner: str
    repo: str
    description: str
    language: str
    stars: int
    stars_gained: int
    period: str
    trending_date: str
    url: str

    model_config = {"from_attributes": True}

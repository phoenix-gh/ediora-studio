from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional


class PublishAccountCreate(BaseModel):
    id: str
    name: str
    platform: str = "wechat"
    positioning: str = ""
    audience: str = ""
    tone: str = ""
    topic_focus: list[str] = Field(default_factory=list)
    taboo: list[str] = Field(default_factory=list)
    word_range: dict = Field(default_factory=dict)
    image_style: str = ""
    cover_style: dict = Field(default_factory=dict)
    voice_samples: list[str] = Field(default_factory=list)
    style_rules: list[str] = Field(default_factory=list)
    app_id: str = ""
    app_secret: str = ""
    is_active: bool = True


class PublishAccountOut(BaseModel):
    id: str
    name: str
    platform: str
    positioning: str
    audience: str
    tone: str
    topic_focus: list[str]
    taboo: list[str]
    word_range: dict
    image_style: str
    cover_style: dict
    voice_samples: list[str]
    style_rules: list[str]
    app_id: str
    app_secret: str
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class PublishAccountUpdate(BaseModel):
    name: Optional[str] = None
    platform: Optional[str] = None
    positioning: Optional[str] = None
    audience: Optional[str] = None
    tone: Optional[str] = None
    topic_focus: Optional[list[str]] = None
    taboo: Optional[list[str]] = None
    word_range: Optional[dict] = None
    image_style: Optional[str] = None
    cover_style: Optional[dict] = None
    voice_samples: Optional[list[str]] = None
    style_rules: Optional[list[str]] = None
    app_id: Optional[str] = None
    app_secret: Optional[str] = None
    is_active: Optional[bool] = None


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


# ── WritingPlan ───────────────────────────────────────────────────────────────

class PlanTagCreate(BaseModel):
    name: str


class PlanTagOut(BaseModel):
    id: int
    name: str
    color: str

    model_config = {"from_attributes": True}


class WritingPlanCreate(BaseModel):
    title: str
    strategy: str = ""
    tags: list[str] = []
    priority: int = 3
    cover_style: dict = {}
    image_style: str = ""
    genre: str = "commentary"


class WritingPlanUpdate(BaseModel):
    title: Optional[str] = None
    strategy: Optional[str] = None
    tags: Optional[list[str]] = None
    priority: Optional[int] = None
    status: Optional[str] = None
    cover_style: Optional[dict] = None
    image_style: Optional[str] = None
    genre: Optional[str] = None


class PlanSourceCreate(BaseModel):
    plan_id: int
    url: str = ""
    title: str = ""
    content: str = ""
    note: str = ""
    platform: str = "manual"
    draft_id: Optional[int] = None


class PlanSourceOut(BaseModel):
    id: int
    plan_id: int
    url: str
    title: str
    content: str = ""
    note: str
    platform: str
    draft_id: Optional[int] = None
    created_at: datetime

    model_config = {"from_attributes": True}


class WritingPlanOut(BaseModel):
    id: int
    title: str
    strategy: str
    description: str  # legacy field, kept for backwards compat
    priority: int
    status: str
    created_at: datetime
    updated_at: datetime
    cover_style: dict = {}
    image_style: str = ""
    genre: str = "commentary"
    tags: list[PlanTagOut] = []
    sources: list[PlanSourceOut] = []
    source_count: int = 0
    draft_count: int = 0

    model_config = {"from_attributes": True}


class ArticleDraftSummary(BaseModel):
    id: int
    title: str
    status: str
    draft_type: str
    created_at: datetime

    model_config = {"from_attributes": True}


class DispatchPlanRequest(BaseModel):
    account_id: Optional[str] = None
    angle: Optional[str] = None
    draft_type: str = "article"
    cover_style: Optional[dict] = None
    image_style: Optional[str] = None


class DispatchResponse(BaseModel):
    task_id: str
    kanban_url: str


class PlanUpdateOut(BaseModel):
    id: int
    plan_id: int
    source_url: str
    description: str
    created_at: datetime

    model_config = {"from_attributes": True}


class AnalyzeRequest(BaseModel):
    url: Optional[str] = None
    content: Optional[str] = None


class ReanalyzeRequest(BaseModel):
    suggestions: str = ""


class AnalyzePromptUpdate(BaseModel):
    instructions: str
    override: bool = False


class AnalyzeResponse(BaseModel):
    task_id: str
    kanban_url: str


# ── ArticleDraft ───────────────────────────────────────────────────────────────

class ArticleDraftRequest(BaseModel):
    topic_id: str


class ArticleDraftOut(BaseModel):
    id: Optional[int] = None
    topic_id: str
    title: str = ""
    draft: str = ""
    content: str = ""
    status: str = "drafting"
    draft_type: str = "article"
    series_id: Optional[int] = None
    series_order: int = 0
    writing_plan_id: Optional[int] = None
    sources: list = []
    version: int = 1
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class ArticleDraftPageOut(BaseModel):
    items: list[ArticleDraftOut]
    next_cursor: Optional[str] = None


class ArticleDraftCreate(BaseModel):
    topic_id: str = "manual"
    title: str = ""
    content: str = ""
    status: str = "drafting"
    draft_type: str = "article"
    writing_plan_id: Optional[int] = None
    sources: list = []


class DraftSourceItem(BaseModel):
    url: str
    title: str = ""
    note: str = ""


class ArticleDraftUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    status: Optional[str] = None
    draft_type: Optional[str] = None
    series_id: Optional[int] = None
    series_order: Optional[int] = None
    writing_plan_id: Optional[int] = None
    sources: Optional[list[DraftSourceItem]] = None


class ArticleDraftRecordOut(BaseModel):
    id: int
    topic_id: str
    title: str
    content: str
    status: str
    series_id: Optional[int] = None
    series_order: int = 0
    version: int
    sources: list = []
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ArticleSeriesOut(BaseModel):
    id: int
    name: str
    description: str
    sort_order: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ArticleSeriesCreate(BaseModel):
    name: str
    description: str = ""
    sort_order: int = 0


class ArticleSeriesUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    sort_order: Optional[int] = None


class DispatchReleaseWriteRequest(BaseModel):
    account_id: str
    plan_id: int
    with_cover: bool = True


class DispatchRepoIntroRequest(BaseModel):
    account_id: str
    plan_id: int
    with_cover: bool = True


class GithubRepoCreate(BaseModel):
    owner: str
    repo: str
    group: str = "未分组"
    collect_interval_minutes: int = 60


class GithubRepoUpdate(BaseModel):
    group: Optional[str] = None
    muted: Optional[bool] = None
    collect_interval_minutes: Optional[int] = None
    release_draft_enabled: Optional[bool] = None
    release_draft_types: Optional[list[str]] = None


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
    release_draft_enabled: bool = True
    release_draft_types: list = []

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
    draft_generated_at: Optional[datetime] = None

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


# ── Quote ──────────────────────────────────────────────────────────────────────

class QuoteCreate(BaseModel):
    text: str
    author: str = ""
    source: str = ""
    source_url: str = ""
    scene_tags: list[str] = []
    writing_plan_id: Optional[int] = None
    platform: str = "manual"


class QuoteUpdate(BaseModel):
    text: Optional[str] = None
    author: Optional[str] = None
    source: Optional[str] = None
    source_url: Optional[str] = None
    scene_tags: Optional[list[str]] = None
    writing_plan_id: Optional[int] = None


class QuoteOut(BaseModel):
    id: int
    text: str
    author: str
    source: str
    source_url: str
    scene_tags: list[str]
    writing_plan_id: Optional[int] = None
    platform: str
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}

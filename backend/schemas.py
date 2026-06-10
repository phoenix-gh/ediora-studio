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
    is_active: Optional[bool] = None


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

class CollectResult(BaseModel):
    account_id: str
    new_posts: int
    error: Optional[str] = None


class GenerateResult(BaseModel):
    new_topics: int = 0
    message: str = ""


class WriterPersonaCreate(BaseModel):
    name: str
    description: str = ""
    prompt: str
    model: str = ""
    is_default: bool = False


class WriterPersonaUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    prompt: Optional[str] = None
    model: Optional[str] = None
    is_default: Optional[bool] = None


class WriterPersonaOut(BaseModel):
    id: int
    name: str
    description: str
    prompt: str
    model: str
    is_default: bool
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


class AnalyzeResponse(BaseModel):
    task_id: str
    kanban_url: str


# ── ArticleDraft ───────────────────────────────────────────────────────────────

class ArticleDraftRequest(BaseModel):
    topic_id: str
    persona_id: Optional[int] = None


class ArticleDraftOut(BaseModel):
    id: Optional[int] = None
    topic_id: str
    title: str = ""
    draft: str = ""
    content: str = ""
    status: str = "drafting"
    draft_type: str = "article"
    linked_draft_id: Optional[int] = None
    persona_id: Optional[int] = None
    series_id: Optional[int] = None
    series_order: int = 0
    writing_plan_id: Optional[int] = None
    sources: list = []
    version: int = 1
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None

    model_config = {"from_attributes": True}


class ArticleDraftCreate(BaseModel):
    topic_id: str = "manual"
    title: str = ""
    content: str = ""
    status: str = "drafting"
    draft_type: str = "article"
    linked_draft_id: Optional[int] = None
    persona_id: Optional[int] = None
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
    linked_draft_id: Optional[int] = None
    persona_id: Optional[int] = None
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
    persona_id: Optional[int] = None
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
    collect_interval_minutes: int = 10


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

from sqlalchemy import String, Integer, Float, Boolean, Text, DateTime, JSON, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime, timezone
from database import Base

def now_utc():
    return datetime.now(timezone.utc)

class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    avatar: Mapped[str] = mapped_column(String, default="")
    platform: Mapped[str] = mapped_column(String, default="X")
    group: Mapped[str] = mapped_column(String, default="未分组")
    priority: Mapped[str] = mapped_column(String, default="normal")
    muted: Mapped[bool] = mapped_column(Boolean, default=False)
    rsshub_path: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class PublishAccount(Base):
    """运营的对外发布账号（公众号 / X / 视频号等）。承载账号定位画像，供 agent 在策划-写作-审核全链路读取。"""
    __tablename__ = "publish_accounts"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    platform: Mapped[str] = mapped_column(String, default="wechat")
    positioning: Mapped[str] = mapped_column(Text, default="")
    audience: Mapped[str] = mapped_column(Text, default="")
    tone: Mapped[str] = mapped_column(String, default="")
    topic_focus: Mapped[list] = mapped_column(JSON, default=list)
    taboo: Mapped[list] = mapped_column(JSON, default=list)
    word_range: Mapped[dict] = mapped_column(JSON, default=dict)
    image_style: Mapped[str] = mapped_column(Text, default="")
    cover_style: Mapped[dict] = mapped_column(JSON, default=dict)
    voice_samples: Mapped[list] = mapped_column(JSON, default=list)
    style_rules: Mapped[list] = mapped_column(JSON, default=list)
    app_id: Mapped[str] = mapped_column(String, default="")       # 公众号开发者 AppID
    app_secret: Mapped[str] = mapped_column(String, default="")   # 仅用于发布到草稿箱
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

class Post(Base):
    __tablename__ = "posts"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    account_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    title: Mapped[str] = mapped_column(String, default="")
    content: Mapped[str] = mapped_column(Text, default="")
    url: Mapped[str] = mapped_column(String, default="")
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    likes: Mapped[int] = mapped_column(Integer, default=0)
    reposts: Mapped[int] = mapped_column(Integer, default=0)
    comments: Mapped[int] = mapped_column(Integer, default=0)
    is_abnormally_popular: Mapped[bool] = mapped_column(Boolean, default=False)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

class ContentDirection(Base):
    __tablename__ = "content_directions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class TopicStrategy(Base):
    __tablename__ = "topic_strategies"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    direction_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    filter_hours: Mapped[int] = mapped_column(Integer, default=48)
    filter_min_views: Mapped[int] = mapped_column(Integer, default=0)
    filter_viral_only: Mapped[bool] = mapped_column(Boolean, default=False)
    filter_keywords: Mapped[list] = mapped_column(JSON, default=list)
    filter_exclude_keywords: Mapped[list] = mapped_column(JSON, default=list)
    llm_prompt: Mapped[str] = mapped_column(Text, default="")
    output_count: Mapped[int] = mapped_column(Integer, default=5)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class Topic(Base):
    __tablename__ = "topics"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="")
    score: Mapped[float] = mapped_column(Float, default=3.0)
    urgency: Mapped[str] = mapped_column(String, default="this_week")
    tags: Mapped[list] = mapped_column(JSON, default=list)
    category: Mapped[str] = mapped_column(String, default="人工智能")
    sources: Mapped[list] = mapped_column(JSON, default=list)
    competitor_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String, default="pending", index=True)
    recommend_reason: Mapped[str] = mapped_column(Text, default="")
    trend_data: Mapped[list] = mapped_column(JSON, default=list)
    direction_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    direction_name: Mapped[str] = mapped_column(String, default="")
    strategy_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    strategy_name: Mapped[str] = mapped_column(String, default="")
    cluster_id: Mapped[str] = mapped_column(String, default="", index=True)
    cluster_title: Mapped[str] = mapped_column(String, default="")
    cluster_source_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class TopicCluster(Base):
    __tablename__ = "topic_clusters"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    canonical_title: Mapped[str] = mapped_column(String, nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="")
    sources: Mapped[list] = mapped_column(JSON, default=list)
    embedding: Mapped[list] = mapped_column(JSON, default=list)
    embedding_model: Mapped[str] = mapped_column(String, default="")
    source_count: Mapped[int] = mapped_column(Integer, default=0)
    heat_score: Mapped[int] = mapped_column(Integer, default=0)
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class GithubRepo(Base):
    __tablename__ = "github_repos"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # "owner/repo"
    owner: Mapped[str] = mapped_column(String, nullable=False)
    repo: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    stars: Mapped[int] = mapped_column(Integer, default=0)
    language: Mapped[str] = mapped_column(String, default="")
    group: Mapped[str] = mapped_column(String, default="未分组")
    muted: Mapped[bool] = mapped_column(Boolean, default=False)
    collect_interval_minutes: Mapped[int] = mapped_column(Integer, default=60)
    last_collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    release_draft_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    release_draft_types: Mapped[list] = mapped_column(JSON, default=lambda: ["tech", "product"])


class GithubIssue(Base):
    __tablename__ = "github_issues"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # "owner/repo:number"
    repo_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String, default="")
    body: Mapped[str] = mapped_column(Text, default="")
    labels: Mapped[list] = mapped_column(JSON, default=list)
    state: Mapped[str] = mapped_column(String, default="open")
    comments: Mapped[int] = mapped_column(Integer, default=0)
    reactions: Mapped[int] = mapped_column(Integer, default=0)
    html_url: Mapped[str] = mapped_column(String, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class IssuePainPoint(Base):
    __tablename__ = "issue_pain_points"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    repo_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    issue_count: Mapped[int] = mapped_column(Integer, default=0)
    example_issues: Mapped[list] = mapped_column(JSON, default=list)
    category: Mapped[str] = mapped_column(String, default="bug")   # bug/feature/performance/ux/docs
    severity: Mapped[str] = mapped_column(String, default="medium")  # high/medium/low
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class GithubTrendingRepo(Base):
    __tablename__ = "github_trending"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    owner: Mapped[str] = mapped_column(String, nullable=False)
    repo: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    language: Mapped[str] = mapped_column(String, default="")
    stars: Mapped[int] = mapped_column(Integer, default=0)
    stars_gained: Mapped[int] = mapped_column(Integer, default=0)
    forks: Mapped[int] = mapped_column(Integer, default=0)
    period: Mapped[str] = mapped_column(String, default="daily")  # daily/weekly
    position: Mapped[int] = mapped_column(Integer, default=0)  # 1-indexed rank on trending page
    trending_date: Mapped[str] = mapped_column(String, nullable=False, index=True)
    url: Mapped[str] = mapped_column(String, default="")


class GithubRelease(Base):
    __tablename__ = "github_releases"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # "owner/repo:tag"
    repo_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    tag_name: Mapped[str] = mapped_column(String, nullable=False)
    name: Mapped[str] = mapped_column(String, default="")
    body: Mapped[str] = mapped_column(Text, default="")
    is_prerelease: Mapped[bool] = mapped_column(Boolean, default=False)
    is_draft: Mapped[bool] = mapped_column(Boolean, default=False)
    html_url: Mapped[str] = mapped_column(String, default="")
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    draft_generated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)


class AppSetting(Base):
    """Key-value store for application configuration."""
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)



class XSubscription(Base):
    """User-curated X subscription source. URL points to an X profile or list."""
    __tablename__ = "x_subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    url: Mapped[str | None] = mapped_column(String, unique=True, nullable=True, index=True)
    label: Mapped[str] = mapped_column(String, default="")
    kind: Mapped[str] = mapped_column(String, default="timeline")  # timeline | search
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # search-only params (kind == "search")
    raw_query: Mapped[str] = mapped_column(String, default="")
    min_faves: Mapped[int] = mapped_column(Integer, default=0)
    min_retweets: Mapped[int] = mapped_column(Integer, default=0)
    lang: Mapped[str] = mapped_column(String, default="")
    days: Mapped[int] = mapped_column(Integer, default=1)
    extra_terms: Mapped[str] = mapped_column(String, default="")
    sort: Mapped[str] = mapped_column(String, default="top")
    max_results: Mapped[int] = mapped_column(Integer, default=100)
    # 动态通知：勾选后该订阅的新帖经 LLM 评估并推送 Telegram；
    # notify_enabled_at 记录开启时刻，只推送之后采集到的帖子
    notify_new_posts: Mapped[bool] = mapped_column(Boolean, default=False)
    notify_enabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str] = mapped_column(String, default="")
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)


class XPost(Base):
    """Posts collected from subscribed X URLs via feedgrab."""
    __tablename__ = "x_posts"

    tweet_id: Mapped[str] = mapped_column(String, primary_key=True)
    subscription_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    username: Mapped[str] = mapped_column(String, nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String, default="")
    content: Mapped[str] = mapped_column(Text, default="")
    url: Mapped[str] = mapped_column(String, default="")
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    replies: Mapped[int] = mapped_column(Integer, default=0)
    reposts: Mapped[int] = mapped_column(Integer, default=0)
    likes: Mapped[int] = mapped_column(Integer, default=0)
    views: Mapped[int] = mapped_column(Integer, default=0)
    author_avatar: Mapped[str] = mapped_column(String, default="")
    cover_image: Mapped[str] = mapped_column(String, default="")
    possibly_sensitive: Mapped[bool] = mapped_column(Boolean, default=False)
    is_reply: Mapped[bool] = mapped_column(Boolean, default=False)
    raw_markdown: Mapped[str] = mapped_column(Text, default="")
    x_reply_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    x_reply_draft: Mapped[str | None] = mapped_column(Text, nullable=True)
    x_reply_notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class Paper(Base):
    __tablename__ = "papers"

    arxiv_id: Mapped[str] = mapped_column(String, primary_key=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    abstract: Mapped[str] = mapped_column(Text, default="")
    title_cn: Mapped[str] = mapped_column(String, default="")
    abstract_cn: Mapped[str] = mapped_column(Text, default="")
    authors: Mapped[list] = mapped_column(JSON, default=list)
    categories: Mapped[list] = mapped_column(JSON, default=list)
    primary_category: Mapped[str] = mapped_column(String, default="", index=True)
    arxiv_url: Mapped[str] = mapped_column(String, default="")
    pdf_url: Mapped[str] = mapped_column(String, default="")
    submitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class WriterPersona(Base):
    __tablename__ = "writer_personas"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(String, default="")
    prompt: Mapped[str] = mapped_column(Text, nullable=False)
    model: Mapped[str] = mapped_column(String, default="")
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ArticleSeries(Base):
    __tablename__ = "article_series"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class WritingPlan(Base):
    """User-managed writing plans (flat, multi-tag)."""
    __tablename__ = "writing_plans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")  # kept for migration rollback
    strategy: Mapped[str] = mapped_column(Text, default="")
    parent_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)  # kept, unused after migration
    priority: Mapped[int] = mapped_column(Integer, default=3)   # 1=highest 5=lowest
    status: Mapped[str] = mapped_column(String, default="active", index=True)  # active/archived
    cover_style: Mapped[dict] = mapped_column(JSON, default=dict)  # 覆盖账号默认封面风格(空=继承)
    image_style: Mapped[str] = mapped_column(Text, default="")     # 覆盖账号默认插图风格(空=继承)
    genre: Mapped[str] = mapped_column(String, default="commentary")  # tutorial/commentary/story/review
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class PlanSource(Base):
    """Reference links / clues attached to a WritingPlan."""
    __tablename__ = "plan_sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plan_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    url: Mapped[str] = mapped_column(String, default="")
    title: Mapped[str] = mapped_column(String, default="")
    content: Mapped[str] = mapped_column(Text, default="")   # body text of the source
    note: Mapped[str] = mapped_column(Text, default="")
    platform: Mapped[str] = mapped_column(String, default="manual")  # x/github/wechat/manual/self
    draft_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # set when source = own published draft
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class PlanTag(Base):
    """Tags for grouping writing plans (replaces tree hierarchy)."""
    __tablename__ = "plan_tags"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    color: Mapped[str] = mapped_column(String, default="#6366f1")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class WritingPlanTag(Base):
    """Many-to-many join between WritingPlan and PlanTag."""
    __tablename__ = "writing_plan_tags"

    plan_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    tag_id: Mapped[int] = mapped_column(Integer, primary_key=True)


class PlanUpdate(Base):
    """Changelog entry written by scout agent when processing a content-to-writing-plan task."""
    __tablename__ = "plan_updates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plan_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    source_url: Mapped[str] = mapped_column(Text, default="")
    description: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ArticleDraft(Base):
    __tablename__ = "article_drafts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    topic_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    writing_plan_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    title: Mapped[str] = mapped_column(String, default="")
    content: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String, default="drafting", index=True)
    draft_type: Mapped[str] = mapped_column(String, default="article")  # article | script
    linked_draft_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # sibling draft of different type
    persona_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    series_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    series_order: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=1)
    sources: Mapped[list] = mapped_column(JSON, default=list)  # [{url, title, note}]
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class PipelineTask(Base):
    """Links a studio pipeline run to its kanban task IDs and eventual draft."""
    __tablename__ = "pipeline_tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    account_id: Mapped[str] = mapped_column(String, nullable=False)
    title: Mapped[str] = mapped_column(String, default="")
    source_url: Mapped[str] = mapped_column(String, default="")
    writing_plan_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    draft_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    task_ids: Mapped[dict] = mapped_column(JSON, default=dict)  # {"scout": "t_xxx", "editor": "t_xxx", ...}
    goal: Mapped[dict] = mapped_column(JSON, default=dict)      # {angle, draft_type} — dispatch 时拍板的本次目标
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class DraftImage(Base):
    """Images attached to a draft group, keyed by the root (article) draft ID."""
    __tablename__ = "draft_images"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    root_draft_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    filename: Mapped[str] = mapped_column(String, nullable=False)        # stored filename in uploads/
    original_name: Mapped[str] = mapped_column(String, default="")
    url: Mapped[str] = mapped_column(String, nullable=False)             # /api/uploads/{filename}
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    mime_type: Mapped[str] = mapped_column(String, default="image/jpeg")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)


class DraftChatLog(Base):
    """Per-session chat history for draft editing."""
    __tablename__ = "draft_chat_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    draft_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    session_name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    role: Mapped[str] = mapped_column(String, nullable=False)   # user | assistant
    content: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)


class CollectLog(Base):
    __tablename__ = "collect_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job: Mapped[str] = mapped_column(String, nullable=False, index=True)  # collect/github/analyze
    status: Mapped[str] = mapped_column(String, nullable=False)           # ok/error/warn
    message: Mapped[str] = mapped_column(Text, default="")
    detail: Mapped[str] = mapped_column(Text, default="")                 # extra context (errors etc)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)


class Quote(Base):
    """金句库 — cross-topic reusable quotes."""
    __tablename__ = "quotes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    author: Mapped[str] = mapped_column(String, default="")
    source: Mapped[str] = mapped_column(String, default="")
    source_url: Mapped[str] = mapped_column(String, default="")
    scene_tags: Mapped[list] = mapped_column(JSON, default=list)   # opener/closer/argument/twist/resonance/warning
    writing_plan_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    platform: Mapped[str] = mapped_column(String, default="manual")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class ProductHuntPost(Base):
    __tablename__ = "producthunt_posts"

    id: Mapped[str] = mapped_column(String, primary_key=True)       # MD5 of URL
    title: Mapped[str] = mapped_column(String, default="")           # product name
    tagline: Mapped[str] = mapped_column(String, default="")         # short tagline
    url: Mapped[str] = mapped_column(String, default="")
    thumbnail_url: Mapped[str] = mapped_column(String, default="")
    images: Mapped[list] = mapped_column(JSON, default=list)  # all product screenshots
    description: Mapped[str] = mapped_column(Text, default="")
    topics: Mapped[list] = mapped_column(JSON, default=list)
    votes: Mapped[int] = mapped_column(Integer, default=0)
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class V2exSubscription(Base):
    __tablename__ = "v2ex_subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    kind: Mapped[str] = mapped_column(String, nullable=False, index=True)  # node | user | tab | all
    key: Mapped[str] = mapped_column(String, default="")                   # node slug / username / tab id
    label: Mapped[str] = mapped_column(String, nullable=False)             # display label
    group: Mapped[str] = mapped_column(String, default="未分组")
    muted: Mapped[bool] = mapped_column(Boolean, default=False)
    last_collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class V2exTopic(Base):
    __tablename__ = "v2ex_topics"

    id: Mapped[str] = mapped_column(String, primary_key=True)              # f"{subscription_id}:{topic_id}"
    subscription_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    topic_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    title: Mapped[str] = mapped_column(String, default="")
    content: Mapped[str] = mapped_column(Text, default="")
    url: Mapped[str] = mapped_column(String, default="")
    author: Mapped[str] = mapped_column(String, default="")
    author_url: Mapped[str] = mapped_column(String, default="")
    replies: Mapped[int] = mapped_column(Integer, default=0)
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class KrArticle(Base):
    __tablename__ = "kr_articles"

    id: Mapped[str] = mapped_column(String, primary_key=True)              # itemId for hot, MD5 of url for RSS
    feed_type: Mapped[str] = mapped_column(String, nullable=False, index=True)  # hot | article | newsflash
    title: Mapped[str] = mapped_column(String, default="")
    url: Mapped[str] = mapped_column(String, default="")
    image_url: Mapped[str] = mapped_column(String, default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    content: Mapped[str] = mapped_column(Text, default="")                 # full HTML body
    author: Mapped[str] = mapped_column(String, default="")
    stat_text: Mapped[str] = mapped_column(String, default="")             # e.g. "203点赞"
    stat_read: Mapped[int] = mapped_column(Integer, default=0)
    stat_like: Mapped[int] = mapped_column(Integer, default=0)
    stat_comment: Mapped[int] = mapped_column(Integer, default=0)
    rank: Mapped[int] = mapped_column(Integer, default=0)                  # 0 = no longer in hot list
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class JuejinArticle(Base):
    __tablename__ = "juejin_articles"

    id: Mapped[str] = mapped_column(String, primary_key=True)              # article_id from Juejin
    category: Mapped[str] = mapped_column(String, nullable=False, index=True)  # hot | backend | frontend | ai | android | ios | tool | life | read
    title: Mapped[str] = mapped_column(String, default="")
    url: Mapped[str] = mapped_column(String, default="")
    cover_url: Mapped[str] = mapped_column(String, default="")
    brief: Mapped[str] = mapped_column(Text, default="")                   # brief_content
    content: Mapped[str] = mapped_column(Text, default="")                 # full HTML body (lazy-fetched)
    author: Mapped[str] = mapped_column(String, default="")
    author_avatar: Mapped[str] = mapped_column(String, default="")
    tags: Mapped[str] = mapped_column(String, default="")                  # comma-joined tag names
    view_count: Mapped[int] = mapped_column(Integer, default=0)
    digg_count: Mapped[int] = mapped_column(Integer, default=0)            # 点赞
    comment_count: Mapped[int] = mapped_column(Integer, default=0)
    collect_count: Mapped[int] = mapped_column(Integer, default=0)         # 收藏
    hot_rank: Mapped[int] = mapped_column(Integer, default=0)              # ordering within latest fetch; 0 = stale
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class WechatAccount(Base):
    __tablename__ = "wechat_accounts"

    # biz here equals the mp.weixin.qq.com backend `fakeid` (same base64 token as the
    # `__biz` URL parameter of public article pages — they're interchangeable).
    biz: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    avatar_url: Mapped[str] = mapped_column(String, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    note: Mapped[str] = mapped_column(Text, default="")
    group: Mapped[str] = mapped_column(String, default="未分组")
    muted: Mapped[bool] = mapped_column(Boolean, default=False)
    last_collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class WechatCredential(Base):
    """Single-row login credential for mp.weixin.qq.com backend (token + cookies).
    Obtained via QR-code scan login; required for searchbiz / appmsgpublish APIs.
    """
    __tablename__ = "wechat_credentials"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    token: Mapped[str] = mapped_column(String, default="")
    cookie: Mapped[str] = mapped_column(Text, default="")           # full Cookie header
    nickname: Mapped[str] = mapped_column(String, default="")       # logged-in account nick
    avatar: Mapped[str] = mapped_column(String, default="")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class WechatArticle(Base):
    __tablename__ = "wechat_articles"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # MD5 of URL
    biz: Mapped[str] = mapped_column(String, nullable=False, index=True)
    account_name: Mapped[str] = mapped_column(String, default="")
    title: Mapped[str] = mapped_column(String, default="")
    url: Mapped[str] = mapped_column(String, default="")
    cover_url: Mapped[str] = mapped_column(String, default="")
    digest: Mapped[str] = mapped_column(Text, default="")
    content: Mapped[str] = mapped_column(Text, default="")     # rich_media_content HTML (lazy)
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class YoutubeChannel(Base):
    __tablename__ = "youtube_channels"

    id: Mapped[str] = mapped_column(String, primary_key=True)   # channel_id
    name: Mapped[str] = mapped_column(String, nullable=False)
    avatar_url: Mapped[str] = mapped_column(String, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    description_cn: Mapped[str] = mapped_column(Text, default="")
    note: Mapped[str] = mapped_column(Text, default="")
    group: Mapped[str] = mapped_column(String, default="未分组")
    muted: Mapped[bool] = mapped_column(Boolean, default=False)
    last_collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class YoutubeVideo(Base):
    __tablename__ = "youtube_videos"

    id: Mapped[str] = mapped_column(String, primary_key=True)   # video_id
    channel_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    channel_name: Mapped[str] = mapped_column(String, default="")
    title: Mapped[str] = mapped_column(String, default="")
    url: Mapped[str] = mapped_column(String, default="")
    thumbnail_url: Mapped[str] = mapped_column(String, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    views: Mapped[int] = mapped_column(Integer, default=0)
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class AgentProfile(Base):
    """Hermes profile metadata + SOUL backup.

    `id` mirrors the hermes profile folder name (e.g. `wms_writer`) and is the
    stable agent identifier referenced by kanban / hooks / cron. Filesystem
    state stays in `~/.hermes/profiles/<id>/`; this table stores presentation
    metadata (display_name, avatar) and a durable copy of SOUL.md so a corrupt
    config dir doesn't lose persona text.
    """
    __tablename__ = "agent_profiles"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    display_name: Mapped[str] = mapped_column(String, default="")
    avatar_url: Mapped[str] = mapped_column(String, default="")
    description: Mapped[str] = mapped_column(Text, default="")
    soul: Mapped[str] = mapped_column(Text, default="")
    soul_updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class ProfileSoulBackup(Base):
    """Append-only history of SOUL.md edits keyed by profile_id."""
    __tablename__ = "profile_soul_backups"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    profile_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    content: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)


class RedditSubscription(Base):
    __tablename__ = "reddit_subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    subreddit: Mapped[str] = mapped_column(String, nullable=False, unique=True)  # lower-cased
    label: Mapped[str] = mapped_column(String, nullable=False)
    group: Mapped[str] = mapped_column(String, default="未分组")
    muted: Mapped[bool] = mapped_column(Boolean, default=False)
    last_collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class TopicGeneratorCache(Base):
    """Cached output of the last /topic-generator/generate call, keyed by account_id (NULL = no account)."""
    __tablename__ = "topic_generator_cache"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    account_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True, unique=True)
    topics: Mapped[list] = mapped_column(JSON, default=list)
    generated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class RedditPost(Base):
    __tablename__ = "reddit_posts"

    id: Mapped[str] = mapped_column(String, primary_key=True)          # f"{subscription_id}:{post_id}"
    post_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    subscription_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    title: Mapped[str] = mapped_column(String, default="")
    content: Mapped[str] = mapped_column(Text, default="")             # Markdown: body + top comments
    body: Mapped[str] = mapped_column(Text, default="")                # post body without rendered comments/header
    comments: Mapped[list] = mapped_column(JSON, default=list)         # structured top comments
    fetch_status: Mapped[str] = mapped_column(String, default="ok")
    url: Mapped[str] = mapped_column(String, default="")               # reddit permalink
    linked_url: Mapped[str] = mapped_column(String, default="")        # external URL for link posts
    author: Mapped[str] = mapped_column(String, default="")
    subreddit: Mapped[str] = mapped_column(String, default="")
    flair: Mapped[str] = mapped_column(String, default="")
    score: Mapped[int] = mapped_column(Integer, default=0)
    upvote_ratio: Mapped[float] = mapped_column(Float, default=0.0)
    comment_count: Mapped[int] = mapped_column(Integer, default=0)
    is_self: Mapped[bool] = mapped_column(Boolean, default=True)
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class RefMaterial(Base):
    """统一参考文案条目：手工金句(platform=manual/agent) + 采集段子(platform=x)。"""
    __tablename__ = "ref_materials"
    __table_args__ = (
        UniqueConstraint("platform", "source_id", name="uq_ref_materials_platform_source"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    platform: Mapped[str] = mapped_column(String, default="manual", index=True)
    source_id: Mapped[str | None] = mapped_column(String, nullable=True)
    text: Mapped[str] = mapped_column(Text, nullable=False)
    text_clean: Mapped[str] = mapped_column(Text, default="")
    author: Mapped[str] = mapped_column(String, default="")
    handle: Mapped[str] = mapped_column(String, default="")
    source: Mapped[str] = mapped_column(String, default="")
    source_url: Mapped[str] = mapped_column(String, default="")
    cover_image: Mapped[str] = mapped_column(String, default="")
    likes: Mapped[int] = mapped_column(Integer, default=0)
    reposts: Mapped[int] = mapped_column(Integer, default=0)
    replies: Mapped[int] = mapped_column(Integer, default=0)
    views: Mapped[int] = mapped_column(Integer, default=0)
    score: Mapped[int] = mapped_column(Integer, default=0, index=True)
    category: Mapped[str] = mapped_column(String, default="", index=True)
    scene_tags: Mapped[list] = mapped_column(JSON, default=list)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    writing_plan_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    rule_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    parent_source_id: Mapped[str | None] = mapped_column(String, nullable=True)  # 神回复的父帖 source_id
    status: Mapped[str] = mapped_column(String, default="active", index=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class RefCollectRule(Base):
    """采集规则 —— 一条 X Top 搜索 saved query。"""
    __tablename__ = "ref_collect_rules"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    label: Mapped[str] = mapped_column(String, default="")
    platform: Mapped[str] = mapped_column(String, default="x")
    source_subscription_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    min_faves: Mapped[int] = mapped_column(Integer, default=1500)
    min_retweets: Mapped[int] = mapped_column(Integer, default=0)
    lang: Mapped[str] = mapped_column(String, default="zh")
    days: Mapped[int] = mapped_column(Integer, default=2)
    exclude_sensitive: Mapped[bool] = mapped_column(Boolean, default=True)
    extra_terms: Mapped[str] = mapped_column(String, default="")
    raw_query: Mapped[str] = mapped_column(String, default="")
    sort: Mapped[str] = mapped_column(String, default="top")
    max_results: Mapped[int] = mapped_column(Integer, default=100)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str] = mapped_column(String, default="")
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)


class RefSeen(Base):
    """去重账本：已评估的 source_id，避免重复爆款二次过 LLM。"""
    __tablename__ = "ref_seen"
    __table_args__ = (
        UniqueConstraint("platform", "source_id", name="uq_ref_seen_platform_source"),
    )
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    platform: Mapped[str] = mapped_column(String, default="x")
    source_id: Mapped[str] = mapped_column(String, nullable=False)
    verdict: Mapped[str] = mapped_column(String, default="rejected")
    seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

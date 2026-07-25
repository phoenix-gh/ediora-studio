from sqlalchemy import String, Integer, Float, Boolean, Text, DateTime, JSON, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime, timezone
from database import Base

def now_utc():
    return datetime.now(timezone.utc)

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
    daily_quota: Mapped[dict] = mapped_column(JSON, default=dict)  # {"long":1,"short":2}；空=不参与每日计划
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

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


class ChatSession(Base):
    """A persisted global research-chat conversation."""
    __tablename__ = "chat_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String, default="新对话")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class ChatMessage(Base):
    """A chat message with AI SDK-compatible structured parts."""
    __tablename__ = "chat_messages"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    role: Mapped[str] = mapped_column(String, nullable=False)
    parts: Mapped[list] = mapped_column(JSON, default=list)
    text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)



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


class XResponseDecision(Base):
    """One durable realtime-response decision for one collected X post."""
    __tablename__ = "x_response_decisions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tweet_id: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)
    subscription_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    action: Mapped[str] = mapped_column(String, nullable=False, index=True)
    score: Mapped[int] = mapped_column(Integer, default=0, index=True)
    confidence: Mapped[float] = mapped_column(Float, default=0.0)
    reason: Mapped[str] = mapped_column(Text, default="")
    summary_cn: Mapped[str] = mapped_column(Text, default="")
    comment_draft: Mapped[str | None] = mapped_column(Text, nullable=True)
    quote_draft: Mapped[str | None] = mapped_column(Text, nullable=True)
    claims: Mapped[list] = mapped_column(JSON, default=list)
    verification_status: Mapped[str] = mapped_column(String, default="not_required", index=True)
    verified_urls: Mapped[list] = mapped_column(JSON, default=list)
    notification_tier: Mapped[str] = mapped_column(String, default="silent", index=True)
    workflow_status: Mapped[str] = mapped_column(String, default="ready", index=True)
    model_provider: Mapped[str] = mapped_column(String, default="")
    model_name: Mapped[str] = mapped_column(String, default="")
    prompt_version: Mapped[str] = mapped_column(String, default="")
    decision_policy_version: Mapped[str] = mapped_column(String, default="x-response-v1")
    telegram_status: Mapped[str] = mapped_column(String, default="not_required", index=True)
    telegram_message_ids: Mapped[list] = mapped_column(JSON, default=list)
    telegram_attempts: Mapped[int] = mapped_column(Integer, default=0)
    telegram_last_error: Mapped[str] = mapped_column(Text, default="")
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    event_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


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
    series_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    series_order: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=1)
    sources: Mapped[list] = mapped_column(JSON, default=list)  # [{url, title, note}]
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class Publication(Base):
    """一次「草稿→平台」的发布记录；效果回流（阅读/点赞）的锚点。"""
    __tablename__ = "publications"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    draft_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    account_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    platform: Mapped[str] = mapped_column(String, default="wechat")
    title: Mapped[str] = mapped_column(String, default="")
    external_id: Mapped[str] = mapped_column(String, default="")  # 微信 media_id
    url: Mapped[str] = mapped_column(String, default="")          # 公开文章 URL（群发后回填）
    status: Mapped[str] = mapped_column(String, default="draft_box", index=True)  # draft_box | published
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    read_count: Mapped[int] = mapped_column(Integer, default=0)
    like_count: Mapped[int] = mapped_column(Integer, default=0)
    look_count: Mapped[int] = mapped_column(Integer, default=0)
    share_count: Mapped[int] = mapped_column(Integer, default=0)
    stats_as_of: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class PipelineTask(Base):
    """Links a legacy creation entry point to its durable job and eventual draft."""
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


class ContentJob(Base):
    """Durable, Hermes-free execution record for one content flow."""
    __tablename__ = "content_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    flow: Mapped[str] = mapped_column(String, nullable=False, index=True)
    title: Mapped[str] = mapped_column(String, default="")
    status: Mapped[str] = mapped_column(String, default="queued", index=True)
    input_data: Mapped[dict] = mapped_column(JSON, default=dict)
    idempotency_key: Mapped[str] = mapped_column(String, default="", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ContentJobStep(Base):
    __tablename__ = "content_job_steps"
    __table_args__ = (UniqueConstraint("job_id", "step_key", "attempt", name="uq_content_job_step_attempt"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    step_key: Mapped[str] = mapped_column(String, nullable=False, index=True)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String, default="queued", index=True)
    input_data: Mapped[dict] = mapped_column(JSON, default=dict)
    output_data: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str] = mapped_column(Text, default="")
    retryable: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ContentJobEvent(Base):
    __tablename__ = "content_job_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    step_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    kind: Mapped[str] = mapped_column(String, nullable=False, index=True)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


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


class _RetiredRefMaterial(Base):
    __abstract__ = True
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


class _RetiredRefCollectRule(Base):
    __abstract__ = True
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


class _RetiredRefSeen(Base):
    __abstract__ = True
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


class CreativeAsset(Base):
    __tablename__ = "creative_assets"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    asset_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    media_kind: Mapped[str] = mapped_column(String, default="")
    title: Mapped[str] = mapped_column(String, default="")
    content: Mapped[str] = mapped_column(Text, default="")
    url: Mapped[str] = mapped_column(String, default="")
    media_type: Mapped[str] = mapped_column(String, default="")
    filename: Mapped[str] = mapped_column(String, default="")
    directory: Mapped[str] = mapped_column(String, default="", index=True)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    source: Mapped[str] = mapped_column(String, default="manual")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)

class CreativeAssetDirectory(Base):
    __tablename__ = "creative_asset_directories"
    __table_args__ = (UniqueConstraint("asset_type", "name", name="uq_creative_asset_directories_asset_type_name"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    asset_type: Mapped[str] = mapped_column(String, nullable=False, default="article", index=True)
    parent_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class DailyPlan(Base):
    """每日内容计划：8 点总编策划任务的载体，items 确认后入队创作链。"""
    __tablename__ = "daily_plans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plan_date: Mapped[str] = mapped_column(String, nullable=False, unique=True, index=True)  # 本地日期 "YYYY-MM-DD"
    status: Mapped[str] = mapped_column(String, default="planning", index=True)  # planning|ready|failed
    kanban_task_id: Mapped[str] = mapped_column(String, default="")
    planner_note: Mapped[str] = mapped_column(Text, default="")  # 总编留言
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class DailyPlanItem(Base):
    """计划里的一条选题。后续发布排期/效果回流都挂在这个锚点上。"""
    __tablename__ = "daily_plan_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    plan_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    account_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    angle: Mapped[str] = mapped_column(Text, default="")
    reason: Mapped[str] = mapped_column(Text, default="")
    content_type: Mapped[str] = mapped_column(String, default="long")  # long|short|story|share
    sources: Mapped[list] = mapped_column(JSON, default=list)  # [{platform,title,url}]
    group_key: Mapped[str] = mapped_column(String, default="", index=True)  # 非空=撞题组，共享一稿
    is_primary: Mapped[bool] = mapped_column(Boolean, default=True)  # 组内主笔（用谁的画像写）
    status: Mapped[str] = mapped_column(String, default="suggested", index=True)  # suggested|skipped|enqueued
    pipeline_task_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    draft_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

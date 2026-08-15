from sqlalchemy import (
    String,
    Integer,
    Float,
    Boolean,
    Text,
    DateTime,
    JSON,
    Index,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column
from datetime import datetime, timezone
from database import Base

def now_utc():
    return datetime.now(timezone.utc)


class XCredentialAccount(Base):
    __tablename__ = "x_credential_accounts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    credential_slot: Mapped[int] = mapped_column(Integer, nullable=False, unique=True)
    auth_token_preview: Mapped[str] = mapped_column(String, default="")
    ct0_preview: Mapped[str] = mapped_column(String, default="")
    session_ciphertext: Mapped[str] = mapped_column(Text, default="")
    test_status: Mapped[str] = mapped_column(String, default="untested", index=True)
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_test_error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, onupdate=now_utc
    )

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
    skill_run: Mapped[dict | None] = mapped_column(JSON, nullable=True, default=None)
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
    collect_interval_minutes: Mapped[int] = mapped_column(Integer, nullable=False, default=15)
    # 情报分析：只分析开启时刻之后采集到的新帖。
    intelligence_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    intelligence_enabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
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
    media: Mapped[list] = mapped_column(JSON, default=list)
    possibly_sensitive: Mapped[bool] = mapped_column(Boolean, default=False)
    is_reply: Mapped[bool] = mapped_column(Boolean, default=False)
    raw_markdown: Mapped[str] = mapped_column(Text, default="")
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
    telegram_claim_token: Mapped[str | None] = mapped_column(
        String, nullable=True, index=True
    )
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
    __table_args__ = (
        Index("ix_article_drafts_updated_at_id", "updated_at", "id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    topic_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    writing_plan_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    title: Mapped[str] = mapped_column(String, default="")
    content: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String, default="drafting", index=True)
    draft_type: Mapped[str] = mapped_column(String, default="article")  # article | script
    series_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    series_order: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=1)
    sources: Mapped[list] = mapped_column(JSON, default=list)  # [{url, title, note}]
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
    __table_args__ = (
        Index(
            "uq_content_jobs_idempotency_nonempty",
            "idempotency_key",
            unique=True,
            postgresql_where=text("idempotency_key <> ''"),
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    flow: Mapped[str] = mapped_column(String, nullable=False, index=True)
    title: Mapped[str] = mapped_column(String, default="")
    status: Mapped[str] = mapped_column(String, default="queued", index=True)
    input_data: Mapped[dict] = mapped_column(JSON, default=dict)
    idempotency_key: Mapped[str] = mapped_column(String, default="", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AgentExecution(Base):
    """Durable checkpoint for one AI-owned content job."""
    __tablename__ = "agent_executions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job_id: Mapped[int] = mapped_column(Integer, nullable=False, unique=True, index=True)
    status: Mapped[str] = mapped_column(String, nullable=False, default="running", index=True)
    objective: Mapped[str] = mapped_column(Text, nullable=False)
    skill_mode: Mapped[str] = mapped_column(String, nullable=False, default="auto")
    skill_name: Mapped[str | None] = mapped_column(String, nullable=True)
    skill_activation: Mapped[str] = mapped_column(String, nullable=False, default="")
    phase: Mapped[str] = mapped_column(String, nullable=False, default="prepare")
    checkpoint_data: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    audit_data: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    completion_evidence: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    final_summary: Mapped[str] = mapped_column(Text, nullable=False, default="")
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    error: Mapped[str] = mapped_column(Text, nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, onupdate=now_utc
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AgentToolCall(Base):
    """Idempotency and audit record for one Agent tool invocation."""
    __tablename__ = "agent_tool_calls"
    __table_args__ = (
        UniqueConstraint(
            "execution_id", "tool_call_id", name="uq_agent_tool_call_execution"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    execution_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    tool_call_id: Mapped[str] = mapped_column(String, nullable=False)
    tool_name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String, nullable=False, default="running", index=True)
    auto_approved: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    side_effecting: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    input_summary: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    output_data: Mapped[dict | list | str | int | float | bool | None] = mapped_column(JSON, nullable=True)
    error: Mapped[str] = mapped_column(Text, nullable=False, default="")
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, onupdate=now_utc
    )


class AgentMessageLog(Base):
    """One persisted model request/response in an AI execution timeline."""
    __tablename__ = "agent_message_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    execution_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    phase: Mapped[str] = mapped_column(String, nullable=False, index=True)
    direction: Mapped[str] = mapped_column(String, nullable=False, index=True)
    payload_data: Mapped[dict | list | str | int | float | bool | None] = mapped_column(
        JSON, nullable=False, default=dict
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)


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


class ContentResponseItem(Base):
    """Stable, source-neutral identity for one item in the response inbox."""
    __tablename__ = "content_response_items"
    __table_args__ = (
        UniqueConstraint("source_type", "source_id", name="uq_content_response_source"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    source_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    source_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    source_url: Mapped[str] = mapped_column(String, default="")
    source_title: Mapped[str] = mapped_column(String, default="")
    source_author: Mapped[str] = mapped_column(String, default="")
    source_published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, index=True)
    subscription_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    workflow_status: Mapped[str] = mapped_column(String, default="queued", index=True)
    decision_status: Mapped[str] = mapped_column(String, default="pending", index=True)
    content_types: Mapped[list] = mapped_column(JSON, default=list)
    destination_type: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    destination_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    current_analysis_run_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    selected_publish_account_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    selected_output_types: Mapped[list] = mapped_column(JSON, default=list)
    feedback_reason: Mapped[str] = mapped_column(Text, default="")
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class ContentAnalysisRun(Base):
    """Immutable versioned AI analysis of a response item."""
    __tablename__ = "content_analysis_runs"
    __table_args__ = (
        UniqueConstraint("response_item_id", "version", name="uq_content_analysis_version"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    response_item_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String, default="queued", index=True)
    job_id: Mapped[int | None] = mapped_column(Integer, nullable=True, unique=True, index=True)
    source_content_hash: Mapped[str] = mapped_column(String, default="")
    source_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    content_value_score: Mapped[int] = mapped_column(Integer, default=0, index=True)
    value_dimensions: Mapped[dict] = mapped_column(JSON, default=dict)
    summary_cn: Mapped[str] = mapped_column(Text, default="")
    core_thesis: Mapped[str] = mapped_column(Text, default="")
    suggested_title: Mapped[str] = mapped_column(Text, default="")
    suggested_angle: Mapped[str] = mapped_column(Text, default="")
    target_reader: Mapped[str] = mapped_column(Text, default="")
    suggested_structure: Mapped[list] = mapped_column(JSON, default=list)
    key_points: Mapped[list] = mapped_column(JSON, default=list)
    evidence: Mapped[list] = mapped_column(JSON, default=list)
    value_points: Mapped[list] = mapped_column(JSON, default=list)
    risks: Mapped[list] = mapped_column(JSON, default=list)
    verification_items: Mapped[list] = mapped_column(JSON, default=list)
    personal_angles: Mapped[list] = mapped_column(JSON, default=list)
    article_outlines: Mapped[list] = mapped_column(JSON, default=list)
    comment_angles: Mapped[list] = mapped_column(JSON, default=list)
    recommended_output_types: Mapped[list] = mapped_column(JSON, default=list)
    recommended_content_types: Mapped[list] = mapped_column(JSON, default=list)
    recommended_disposition: Mapped[str] = mapped_column(String, default="pending", index=True)
    recommended_action: Mapped[str] = mapped_column(String, default="")
    recommendation_reason: Mapped[str] = mapped_column(Text, default="")
    recommended_publish_account_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    model_provider: Mapped[str] = mapped_column(String, default="")
    model_name: Mapped[str] = mapped_column(String, default="")
    prompt_version: Mapped[str] = mapped_column(String, default="")
    policy_version: Mapped[str] = mapped_column(String, default="")
    error_code: Mapped[str] = mapped_column(String, default="")
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ContentAccountScore(Base):
    __tablename__ = "content_account_scores"
    __table_args__ = (
        UniqueConstraint("analysis_run_id", "publish_account_id", name="uq_content_account_score"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    analysis_run_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    publish_account_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    account_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    score: Mapped[int] = mapped_column(Integer, default=0, index=True)
    rank: Mapped[int] = mapped_column(Integer, default=0)
    fit_reasons: Mapped[list] = mapped_column(JSON, default=list)
    audience_value: Mapped[str] = mapped_column(Text, default="")
    recommended_tone: Mapped[str] = mapped_column(String, default="")
    recommended_output_types: Mapped[list] = mapped_column(JSON, default=list)
    taboo_risks: Mapped[list] = mapped_column(JSON, default=list)
    has_hard_conflict: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ContentResponseOutput(Base):
    __tablename__ = "content_response_outputs"
    __table_args__ = (
        UniqueConstraint(
            "analysis_run_id",
            "publish_account_id",
            "output_type",
            name="uq_content_response_output",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    response_item_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    analysis_run_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    publish_account_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    output_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String, default="queued", index=True)
    job_id: Mapped[int | None] = mapped_column(Integer, nullable=True, unique=True, index=True)
    article_draft_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    content: Mapped[str] = mapped_column(Text, default="")
    source_attribution: Mapped[dict] = mapped_column(JSON, default=dict)
    error_code: Mapped[str] = mapped_column(String, default="")
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class ContentResponseNotification(Base):
    __tablename__ = "content_response_notifications"
    __table_args__ = (
        UniqueConstraint(
            "analysis_run_id",
            "channel",
            "notification_tier",
            name="uq_content_response_notification",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    response_item_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    analysis_run_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    channel: Mapped[str] = mapped_column(String, default="telegram", index=True)
    notification_tier: Mapped[str] = mapped_column(String, default="silent", index=True)
    status: Mapped[str] = mapped_column(String, default="not_required", index=True)
    message_ids: Mapped[list] = mapped_column(JSON, default=list)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    claim_token: Mapped[str | None] = mapped_column(String, nullable=True, unique=True, index=True)
    last_error: Mapped[str] = mapped_column(Text, default="")
    notified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class ContentResponseEvent(Base):
    __tablename__ = "content_response_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    response_item_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    analysis_run_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    event_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    actor: Mapped[str] = mapped_column(String, default="system")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)


class DraftImage(Base):
    """Images attached to one independent draft."""
    __tablename__ = "draft_images"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    draft_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
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
    auto_analyze_new_videos: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    analysis_enabled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
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
    transcript_status: Mapped[str] = mapped_column(String, default="not_requested", index=True)
    transcript_source: Mapped[str] = mapped_column(String, default="")
    transcript_language: Mapped[str] = mapped_column(String, default="")
    transcript_text: Mapped[str] = mapped_column(Text, default="")
    transcript_segments: Mapped[list] = mapped_column(JSON, default=list)
    transcript_content_hash: Mapped[str] = mapped_column(String, default="", index=True)
    transcript_zh_source: Mapped[str] = mapped_column(String, default="")
    transcript_zh_language: Mapped[str] = mapped_column(String, default="")
    transcript_zh_text: Mapped[str] = mapped_column(Text, default="")
    transcript_zh_segments: Mapped[list] = mapped_column(JSON, default=list)
    transcript_zh_content_hash: Mapped[str] = mapped_column(String, default="")
    transcript_fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    transcript_error_code: Mapped[str] = mapped_column(String, default="")
    transcript_error: Mapped[str] = mapped_column(Text, default="")


class RedditSubscription(Base):
    __tablename__ = "reddit_subscriptions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    subreddit: Mapped[str] = mapped_column(String, nullable=False, unique=True)  # lower-cased
    label: Mapped[str] = mapped_column(String, nullable=False)
    group: Mapped[str] = mapped_column(String, default="未分组")
    muted: Mapped[bool] = mapped_column(Boolean, default=False)
    last_collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


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


class CreativeAsset(Base):
    __tablename__ = "creative_assets"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    asset_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    prompt_kind: Mapped[str] = mapped_column(String, default="")
    media_kind: Mapped[str] = mapped_column(String, default="")
    title: Mapped[str] = mapped_column(String, default="")
    content: Mapped[str] = mapped_column(Text, default="")
    url: Mapped[str] = mapped_column(String, default="")
    media_type: Mapped[str] = mapped_column(String, default="")
    filename: Mapped[str] = mapped_column(String, default="")
    directory: Mapped[str] = mapped_column(String, default="", index=True)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    source: Mapped[str] = mapped_column(String, default="manual")
    last_selected_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class PromptGeneration(Base):
    __tablename__ = "prompt_generations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    prompt_asset_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    media_asset_id: Mapped[int | None] = mapped_column(
        Integer, nullable=True, index=True
    )
    provider: Mapped[str] = mapped_column(String, default="")
    model: Mapped[str] = mapped_column(String, default="")
    status: Mapped[str] = mapped_column(String, default="queued", index=True)
    job_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    error: Mapped[str] = mapped_column(Text, default="")
    generated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, index=True
    )


class DigitalHuman(Base):
    __tablename__ = "digital_humans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="processing", index=True)
    provider: Mapped[str] = mapped_column(String(20), default="heygen", index=True)
    portrait_asset_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    voice_sample_asset_id: Mapped[int | None] = mapped_column(
        Integer, nullable=True, index=True
    )
    default_environment_asset_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    look_asset_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    look_prompt: Mapped[str] = mapped_column(Text, default="")
    heygen_avatar_group_id: Mapped[str] = mapped_column(String, default="")
    heygen_avatar_id: Mapped[str] = mapped_column(String, default="")
    heygen_voice_id: Mapped[str] = mapped_column(String, default="")
    provider_state: Mapped[dict] = mapped_column(JSON, default=dict)
    setup_job_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    error: Mapped[str] = mapped_column(Text, default="")
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, onupdate=now_utc
    )


class TalkingVideoProject(Base):
    __tablename__ = "talking_video_projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(300), default="")
    digital_human_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    script: Mapped[str] = mapped_column(Text, default="")
    script_source: Mapped[str] = mapped_column(String(20), default="manual")
    source_draft_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    environment_asset_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    look_asset_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    shots: Mapped[list] = mapped_column(JSON, default=list)
    current_render_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, onupdate=now_utc
    )


class TextVideoProject(Base):
    __tablename__ = "text_video_projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False, default="未命名文字视频")
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft", index=True)
    stage: Mapped[str] = mapped_column(String(20), nullable=False, default="script")
    script: Mapped[str] = mapped_column(Text, nullable=False, default="")
    voice_settings: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    paragraphs: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    speech_split_mode: Mapped[str] = mapped_column(
        String(20), nullable=False, default="single"
    )
    master_audio: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    scene_plan: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    render_input: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    render_state: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    cover_asset_url: Mapped[str] = mapped_column(String, nullable=False, default="")
    output_asset_url: Mapped[str] = mapped_column(String, nullable=False, default="")
    output_stale: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        default=False,
    )
    revision: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, onupdate=now_utc
    )


class TextVideoSpeechAsset(Base):
    __tablename__ = "text_video_speech_assets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    creative_asset_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    source_hash: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    duration: Mapped[float] = mapped_column(Float, nullable=False)
    sample_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    sample_rate: Mapped[int] = mapped_column(Integer, nullable=False, default=44100)
    word_timings: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    provider_request_id: Mapped[str] = mapped_column(
        String, nullable=False, default=""
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc
    )


class TalkingVideoRender(Base):
    __tablename__ = "talking_video_renders"
    __table_args__ = (
        UniqueConstraint(
            "project_id", "version", name="uq_talking_video_render_version"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    job_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    script_snapshot: Mapped[str] = mapped_column(Text, nullable=False)
    digital_human_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    shots_snapshot: Mapped[list] = mapped_column(JSON, default=list)
    environment_asset_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    provider_state: Mapped[dict] = mapped_column(JSON, default=dict)
    heygen_environment_asset_id: Mapped[str] = mapped_column(String, default="")
    heygen_video_id: Mapped[str] = mapped_column(String, default="")
    video_asset_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    completed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class CreativeAssetDirectory(Base):
    __tablename__ = "creative_asset_directories"
    __table_args__ = (UniqueConstraint("asset_type", "name", name="uq_creative_asset_directories_asset_type_name"),)
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    asset_type: Mapped[str] = mapped_column(String, nullable=False, default="article", index=True)
    parent_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    system_key: Mapped[str | None] = mapped_column(
        String, nullable=True, unique=True, index=True
    )
    ai_ingestion_enabled: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    ai_ingestion_keywords: Mapped[list] = mapped_column(JSON, default=list)
    ai_ingestion_prompt: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class TopicSourceRule(Base):
    """One X subscription's material-selection rule for an article asset directory."""
    __tablename__ = "topic_source_rules"
    __table_args__ = (
        UniqueConstraint("subscription_id", "directory", name="uq_topic_source_rule_subscription_directory"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    subscription_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    directory: Mapped[str] = mapped_column(String, nullable=False, index=True)
    keywords: Mapped[list] = mapped_column(JSON, default=list)
    screening_prompt: Mapped[str] = mapped_column(Text, default="")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, onupdate=now_utc
    )


class TopicSourceDecision(Base):
    """The durable AI verdict for a single post under one topic rule."""
    __tablename__ = "topic_source_decisions"
    __table_args__ = (
        UniqueConstraint("rule_id", "tweet_id", name="uq_topic_source_decision_rule_tweet"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    rule_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    tweet_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    accepted: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class XSubscriptionIngestionDirectory(Base):
    """An X subscription's selected article or prompt directories for AI ingestion."""
    __tablename__ = "x_subscription_ingestion_directories"
    __table_args__ = (
        UniqueConstraint(
            "subscription_id",
            "directory_id",
            name="uq_x_subscription_ingestion_directory",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    subscription_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    directory_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class AssetIngestionDecision(Base):
    """The final one-directory AI verdict for one X post under one subscription."""
    __tablename__ = "asset_ingestion_decisions"
    __table_args__ = (
        UniqueConstraint(
            "subscription_id",
            "tweet_id",
            name="uq_asset_ingestion_decision_subscription_tweet",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    subscription_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    tweet_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    directory_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class DailyCreationRule(Base):
    """User-configured one-time or daily content creation rule."""
    __tablename__ = "daily_creation_rules"
    __table_args__ = (
        Index(
            "ix_daily_creation_rules_dispatch",
            "enabled",
            "execution_mode",
            "deleted_at",
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    asset_type: Mapped[str] = mapped_column(String, nullable=False, default="article")
    directory: Mapped[str] = mapped_column(String, nullable=False, index=True)
    directories: Mapped[list[str]] = mapped_column(JSON, default=list)
    output_type: Mapped[str] = mapped_column(String, nullable=False, default="x_short_post")
    target_count: Mapped[int] = mapped_column(Integer, nullable=False)
    execution_mode: Mapped[str] = mapped_column(String, nullable=False)
    scheduled_date: Mapped[str | None] = mapped_column(String, nullable=True)
    scheduled_time: Mapped[str] = mapped_column(String, nullable=False)
    timezone: Mapped[str] = mapped_column(String, nullable=False, default="Asia/Shanghai")
    lookback_days: Mapped[int] = mapped_column(Integer, nullable=False)
    delivery_mode: Mapped[str] = mapped_column(String, nullable=False)
    account_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    instructions: Mapped[str] = mapped_column(Text, default="")
    prompt: Mapped[str] = mapped_column(Text, nullable=False, default="")
    skill_mode: Mapped[str] = mapped_column(String, nullable=False, default="auto")
    skill_name: Mapped[str | None] = mapped_column(String, nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=now_utc, onupdate=now_utc
    )


class DailyCreationRun(Base):
    """Durable execution record carrying an immutable rule snapshot."""
    __tablename__ = "daily_creation_runs"
    __table_args__ = (
        UniqueConstraint(
            "rule_id",
            "scheduled_for",
            "trigger_kind",
            name="uq_daily_creation_run_schedule",
        ),
        Index("ix_daily_creation_runs_status_created", "status", "created_at"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    rule_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    content_job_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    scheduled_for: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    trigger_kind: Mapped[str] = mapped_column(String, nullable=False)
    status: Mapped[str] = mapped_column(String, default="queued", index=True)
    requested_count: Mapped[int] = mapped_column(Integer, nullable=False)
    created_count: Mapped[int] = mapped_column(Integer, default=0)
    rule_snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class DailyCreationOutputBatch(Base):
    """One atomic, idempotent final-output commit from a daily Agent run."""
    __tablename__ = "daily_creation_output_batches"
    __table_args__ = (
        UniqueConstraint(
            "run_id", "idempotency_key", name="uq_daily_creation_output_batch_key"
        ),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    execution_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    idempotency_key: Mapped[str] = mapped_column(String, nullable=False)
    input_hash: Mapped[str] = mapped_column(String, nullable=False)
    posts_data: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    self_validation: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    output_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    draft_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    usage_ids: Mapped[list] = mapped_column(JSON, nullable=False, default=list)
    created_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ContentUsageLedger(Base):
    """Global semantic-deduplication evidence for persisted creation outputs."""
    __tablename__ = "content_usage_ledger"
    __table_args__ = (
        UniqueConstraint(
            "run_id",
            "output_kind",
            "output_id",
            name="uq_content_usage_run_output",
        ),
        Index("ix_content_usage_created_at", "created_at"),
        Index("ix_content_usage_asset_created", "creative_asset_id", "created_at"),
        Index("ix_content_usage_output", "output_kind", "output_id"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    rule_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    creative_asset_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    output_type: Mapped[str] = mapped_column(String, nullable=False, index=True)
    output_kind: Mapped[str] = mapped_column(String, nullable=False)
    output_id: Mapped[int] = mapped_column(Integer, nullable=False)
    draft_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    account_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    rule_name: Mapped[str] = mapped_column(String, default="")
    topic: Mapped[str] = mapped_column(String, default="")
    angle: Mapped[str] = mapped_column(Text, default="")
    excerpt: Mapped[str] = mapped_column(Text, default="")
    reuse_decision: Mapped[str] = mapped_column(String, default="fresh")
    reuse_explanation: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)

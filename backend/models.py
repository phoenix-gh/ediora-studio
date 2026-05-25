from sqlalchemy import String, Integer, Float, Boolean, Text, DateTime, JSON
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
    collect_interval_minutes: Mapped[int] = mapped_column(Integer, default=10)
    last_collected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


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


class AppSetting(Base):
    """Key-value store for application configuration."""
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)



class XBloggerCandidate(Base):
    __tablename__ = "x_blogger_candidates"

    username: Mapped[str] = mapped_column(String, primary_key=True)   # without @
    display_name: Mapped[str] = mapped_column(String, default="")
    avatar_url: Mapped[str] = mapped_column(String, default="")
    followers: Mapped[int] = mapped_column(Integer, default=0)
    following_count: Mapped[int] = mapped_column(Integer, default=0)
    tweet_count: Mapped[int] = mapped_column(Integer, default=0)
    favourites_count: Mapped[int] = mapped_column(Integer, default=0)
    location: Mapped[str] = mapped_column(String, default="")
    join_date: Mapped[str] = mapped_column(String, default="")
    bio: Mapped[str] = mapped_column(Text, default="")
    profile_url: Mapped[str] = mapped_column(String, default="")
    status: Mapped[str] = mapped_column(String, default="candidate", index=True)  # candidate/following/rejected
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class XPost(Base):
    __tablename__ = "x_posts"

    tweet_id: Mapped[str] = mapped_column(String, primary_key=True)
    username: Mapped[str] = mapped_column(String, nullable=False, index=True)
    content: Mapped[str] = mapped_column(Text, default="")
    url: Mapped[str] = mapped_column(String, default="")
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    author_followers: Mapped[int] = mapped_column(Integer, default=0)
    source: Mapped[str] = mapped_column(String, default="twitterapi")
    category: Mapped[str] = mapped_column(String, default="")


class XPostMetrics(Base):
    """One row per collection run per post — append-only trend history."""
    __tablename__ = "x_post_metrics"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    tweet_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    replies: Mapped[int] = mapped_column(Integer, default=0)
    reposts: Mapped[int] = mapped_column(Integer, default=0)
    likes: Mapped[int] = mapped_column(Integer, default=0)
    views: Mapped[int] = mapped_column(Integer, default=0)
    collected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)


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


class ContentTopic(Base):
    """User-managed content topics (tree, max 3 levels)."""
    __tablename__ = "content_topics"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(Text, default="")
    parent_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    priority: Mapped[int] = mapped_column(Integer, default=3)   # 1=highest 5=lowest
    status: Mapped[str] = mapped_column(String, default="active", index=True)  # active/archived
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class TopicSource(Base):
    """Reference links / clues attached to a ContentTopic."""
    __tablename__ = "topic_sources"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    topic_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    url: Mapped[str] = mapped_column(String, default="")
    title: Mapped[str] = mapped_column(String, default="")
    content: Mapped[str] = mapped_column(Text, default="")   # body text of the source
    note: Mapped[str] = mapped_column(Text, default="")
    platform: Mapped[str] = mapped_column(String, default="manual")  # x/github/wechat/manual/self
    draft_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # set when source = own published draft
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ArticleDraft(Base):
    __tablename__ = "article_drafts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    topic_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    content_topic_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
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
    draft_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    task_ids: Mapped[dict] = mapped_column(JSON, default=dict)  # {"scout": "t_xxx", "editor": "t_xxx", ...}
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
    content_topic_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
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

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


class Hotspot(Base):
    __tablename__ = "hotspots"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    trend: Mapped[str] = mapped_column(String, default="rising")
    platforms: Mapped[list] = mapped_column(JSON, default=list)
    heat: Mapped[int] = mapped_column(Integer, default=0)
    trend_data: Mapped[list] = mapped_column(JSON, default=list)
    category: Mapped[str] = mapped_column(String, default="人工智能")
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
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


class EconomicItem(Base):
    __tablename__ = "economic_items"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    title: Mapped[str] = mapped_column(String, nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="")
    category: Mapped[str] = mapped_column(String, default="宏观经济", index=True)
    impact: Mapped[str] = mapped_column(String, default="neutral")   # positive/negative/neutral
    impact_level: Mapped[str] = mapped_column(String, default="medium")  # high/medium/low
    published_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


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
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class ArticleDraft(Base):
    __tablename__ = "article_drafts"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    topic_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    title: Mapped[str] = mapped_column(String, default="")
    content: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String, default="drafting", index=True)
    persona_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, onupdate=now_utc)


class CollectLog(Base):
    __tablename__ = "collect_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    job: Mapped[str] = mapped_column(String, nullable=False, index=True)  # collect/github/analyze
    status: Mapped[str] = mapped_column(String, nullable=False)           # ok/error/warn
    message: Mapped[str] = mapped_column(Text, default="")
    detail: Mapped[str] = mapped_column(Text, default="")                 # extra context (errors etc)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)


class Keyword(Base):
    __tablename__ = "keywords"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    term: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    category: Mapped[str] = mapped_column(String, default="")
    source: Mapped[str] = mapped_column(String, default="auto")  # auto/manual/llm
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    blocked: Mapped[bool] = mapped_column(Boolean, default=False)  # user-deleted → never re-add
    heat: Mapped[int] = mapped_column(Integer, default=0)
    mention_count_24h: Mapped[int] = mapped_column(Integer, default=0)
    platforms: Mapped[list] = mapped_column(JSON, default=list)
    trend: Mapped[str] = mapped_column(String, default="stable")  # rising/stable/declining
    last_computed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc)


class KeywordSnapshot(Base):
    __tablename__ = "keyword_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    keyword_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    heat: Mapped[int] = mapped_column(Integer, default=0)
    mention_count: Mapped[int] = mapped_column(Integer, default=0)
    engagement_score: Mapped[float] = mapped_column(Float, default=0.0)
    recorded_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=now_utc, index=True)

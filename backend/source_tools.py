"""Read-only access to the information sources collected by Ediora.

The MCP server deliberately exposes this module as a query-only surface.  It
does not call collectors, enqueue jobs, or mutate any source row.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional

from sqlalchemy import desc, func, or_, select

from database import SessionLocal


def _fmt_dt(value: Optional[datetime]) -> str:
    if value is None:
        return ""
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _text(value: Any) -> str:
    return str(value or "")


def _compact(value: str, limit: int = 1000) -> str:
    return " ".join(value.split())[:limit]


@dataclass(frozen=True)
class _SourceSpec:
    source_type: str
    subscription_model: type
    item_model: type
    subscription_id_field: str
    item_id_field: str
    item_subscription_field: str
    subscription_label_field: str
    subscription_key: Callable[[Any], str]
    subscription_url: Callable[[Any], str]
    subscription_group_field: Optional[str]
    subscription_enabled_field: Optional[str]
    subscription_muted_field: Optional[str]
    subscription_last_collected_field: Optional[str]
    subscription_order_field: str
    item_title_field: str
    item_content_field: str
    item_search_fields: tuple[str, ...]
    item_url_field: str
    item_author: Callable[[Any], str]
    item_published_field: str
    item_collected_field: str
    item_metadata: Callable[[Any], dict[str, Any]]


def _source_specs() -> dict[str, _SourceSpec]:
    """Build the supported source registry lazily after the models are loaded."""
    from models import (
        RedditPost,
        RedditSubscription,
        V2exSubscription,
        V2exTopic,
        WechatAccount,
        WechatArticle,
        XPost,
        XSubscription,
        YoutubeChannel,
        YoutubeVideo,
    )

    return {
        "x": _SourceSpec(
            source_type="x",
            subscription_model=XSubscription,
            item_model=XPost,
            subscription_id_field="id",
            item_id_field="tweet_id",
            item_subscription_field="subscription_id",
            subscription_label_field="label",
            subscription_key=lambda sub: _text(sub.url or sub.raw_query),
            subscription_url=lambda sub: _text(sub.url),
            subscription_group_field=None,
            subscription_enabled_field="enabled",
            subscription_muted_field=None,
            subscription_last_collected_field="last_collected_at",
            subscription_order_field="added_at",
            item_title_field="",
            item_content_field="content",
            item_search_fields=("content", "username", "display_name", "raw_markdown"),
            item_url_field="url",
            item_author=lambda item: (
                f"@{item.username}" if _text(item.username) else ""
            ),
            item_published_field="published_at",
            item_collected_field="collected_at",
            item_metadata=lambda item: {
                "display_name": _text(item.display_name),
                "replies": int(item.replies or 0),
                "reposts": int(item.reposts or 0),
                "likes": int(item.likes or 0),
                "views": int(item.views or 0),
            },
        ),
        "wechat": _SourceSpec(
            source_type="wechat",
            subscription_model=WechatAccount,
            item_model=WechatArticle,
            subscription_id_field="biz",
            item_id_field="id",
            item_subscription_field="biz",
            subscription_label_field="name",
            subscription_key=lambda account: _text(account.biz),
            subscription_url=lambda _account: "",
            subscription_group_field="group",
            subscription_enabled_field=None,
            subscription_muted_field="muted",
            subscription_last_collected_field="last_collected_at",
            subscription_order_field="created_at",
            item_title_field="title",
            item_content_field="content",
            item_search_fields=("title", "digest", "content", "account_name"),
            item_url_field="url",
            item_author=lambda item: _text(item.account_name),
            item_published_field="published_at",
            item_collected_field="collected_at",
            item_metadata=lambda item: {
                "biz": _text(item.biz),
                "digest": _text(item.digest),
                "cover_url": _text(item.cover_url),
            },
        ),
        "reddit": _SourceSpec(
            source_type="reddit",
            subscription_model=RedditSubscription,
            item_model=RedditPost,
            subscription_id_field="id",
            item_id_field="id",
            item_subscription_field="subscription_id",
            subscription_label_field="label",
            subscription_key=lambda sub: _text(sub.subreddit),
            subscription_url=lambda sub: f"https://www.reddit.com/r/{_text(sub.subreddit)}",
            subscription_group_field="group",
            subscription_enabled_field=None,
            subscription_muted_field="muted",
            subscription_last_collected_field="last_collected_at",
            subscription_order_field="created_at",
            item_title_field="title",
            item_content_field="content",
            item_search_fields=("title", "content", "body", "author", "subreddit"),
            item_url_field="url",
            item_author=lambda item: _text(item.author),
            item_published_field="published_at",
            item_collected_field="collected_at",
            item_metadata=lambda item: {
                "post_id": _text(item.post_id),
                "subreddit": _text(item.subreddit),
                "score": int(item.score or 0),
                "upvote_ratio": float(item.upvote_ratio or 0),
                "comment_count": int(item.comment_count or 0),
                "linked_url": _text(item.linked_url),
            },
        ),
        "youtube": _SourceSpec(
            source_type="youtube",
            subscription_model=YoutubeChannel,
            item_model=YoutubeVideo,
            subscription_id_field="id",
            item_id_field="id",
            item_subscription_field="channel_id",
            subscription_label_field="name",
            subscription_key=lambda channel: _text(channel.id),
            subscription_url=lambda channel: f"https://www.youtube.com/channel/{_text(channel.id)}",
            subscription_group_field="group",
            subscription_enabled_field=None,
            subscription_muted_field="muted",
            subscription_last_collected_field="last_collected_at",
            subscription_order_field="created_at",
            item_title_field="title",
            item_content_field="description",
            item_search_fields=("title", "description", "channel_name", "transcript_text"),
            item_url_field="url",
            item_author=lambda item: _text(item.channel_name),
            item_published_field="published_at",
            item_collected_field="collected_at",
            item_metadata=lambda item: {
                "channel_id": _text(item.channel_id),
                "channel_name": _text(item.channel_name),
                "views": int(item.views or 0),
                "transcript_status": _text(item.transcript_status),
                "transcript_language": _text(item.transcript_language),
            },
        ),
        "v2ex": _SourceSpec(
            source_type="v2ex",
            subscription_model=V2exSubscription,
            item_model=V2exTopic,
            subscription_id_field="id",
            item_id_field="id",
            item_subscription_field="subscription_id",
            subscription_label_field="label",
            subscription_key=lambda sub: ":".join(
                value for value in (_text(sub.kind), _text(sub.key)) if value
            ),
            subscription_url=lambda _sub: "",
            subscription_group_field="group",
            subscription_enabled_field=None,
            subscription_muted_field="muted",
            subscription_last_collected_field="last_collected_at",
            subscription_order_field="created_at",
            item_title_field="title",
            item_content_field="content",
            item_search_fields=("title", "content", "author"),
            item_url_field="url",
            item_author=lambda item: _text(item.author),
            item_published_field="published_at",
            item_collected_field="collected_at",
            item_metadata=lambda item: {
                "topic_id": int(item.topic_id or 0),
                "replies": int(item.replies or 0),
                "author_url": _text(item.author_url),
            },
        ),
    }


_SOURCE_ALIASES = {
    "twitter": "x",
    "weixin": "wechat",
    "公众号": "wechat",
}


def _resolve_source_types(source_type: str, specs: dict[str, _SourceSpec]) -> list[str]:
    normalized = _text(source_type).strip().lower()
    normalized = _SOURCE_ALIASES.get(normalized, normalized)
    if not normalized or normalized == "all":
        return list(specs)
    if normalized not in specs:
        supported = ", ".join(specs)
        raise ValueError(f"Unsupported source_type '{source_type}'. Supported: {supported}")
    return [normalized]


def _coerce_id(spec: _SourceSpec, value: Any) -> Any:
    if value is None:
        return None
    if spec.source_type in {"x", "reddit", "v2ex"}:
        try:
            return int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(
                f"subscription_id must be an integer for source_type '{spec.source_type}'"
            ) from exc
    return _text(value)


def _subscription_payload(
    spec: _SourceSpec,
    subscription: Any,
    item_count: int,
) -> dict[str, Any]:
    enabled = (
        bool(getattr(subscription, spec.subscription_enabled_field))
        if spec.subscription_enabled_field
        else True
    )
    muted = (
        bool(getattr(subscription, spec.subscription_muted_field))
        if spec.subscription_muted_field
        else False
    )
    return {
        "source_type": spec.source_type,
        "id": getattr(subscription, spec.subscription_id_field),
        "label": _text(getattr(subscription, spec.subscription_label_field)),
        "key": spec.subscription_key(subscription),
        "url": spec.subscription_url(subscription),
        "group": (
            _text(getattr(subscription, spec.subscription_group_field))
            if spec.subscription_group_field else ""
        ),
        "enabled": enabled,
        "muted": muted,
        "last_collected_at": _fmt_dt(
            getattr(subscription, spec.subscription_last_collected_field)
            if spec.subscription_last_collected_field else None
        ),
        "item_count": item_count,
    }


def _item_search_text(spec: _SourceSpec, item: Any, subscription_label: str) -> str:
    values = [subscription_label]
    values.extend(_text(getattr(item, field)) for field in spec.item_search_fields)
    return " ".join(values).casefold()


def _item_payload(
    spec: _SourceSpec,
    item: Any,
    subscription_label: str,
    *,
    full_content: bool,
) -> dict[str, Any]:
    content = _text(getattr(item, spec.item_content_field))
    visible_content = content if full_content else content[:2000]
    return {
        "source_type": spec.source_type,
        "id": getattr(item, spec.item_id_field),
        "subscription_id": getattr(item, spec.item_subscription_field),
        "subscription_label": subscription_label,
        "title": (
            _text(getattr(item, spec.item_title_field))
            if spec.item_title_field else ""
        ),
        "content": visible_content,
        "excerpt": _compact(content),
        "url": _text(getattr(item, spec.item_url_field)),
        "author": spec.item_author(item),
        "published_at": _fmt_dt(getattr(item, spec.item_published_field)),
        "collected_at": _fmt_dt(getattr(item, spec.item_collected_field)),
        "metadata": spec.item_metadata(item),
    }


async def list_source_subscriptions(
    source_type: str = "",
    include_muted: bool = True,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """List configured source subscriptions without triggering collection."""
    specs = _source_specs()
    selected_types = _resolve_source_types(source_type, specs)
    take = max(1, min(int(limit), 100))
    result: list[dict[str, Any]] = []

    async with SessionLocal() as db:
        for selected_type in selected_types:
            spec = specs[selected_type]
            subscription_model = spec.subscription_model
            statement = select(subscription_model)
            if not include_muted and spec.subscription_muted_field:
                statement = statement.where(
                    getattr(subscription_model, spec.subscription_muted_field).is_(False)
                )
            statement = statement.order_by(
                desc(getattr(subscription_model, spec.subscription_order_field))
            ).limit(take)
            subscriptions = (await db.execute(statement)).scalars().all()
            if not subscriptions:
                continue

            subscription_ids = [
                getattr(subscription, spec.subscription_id_field)
                for subscription in subscriptions
            ]
            counts = (await db.execute(
                select(
                    getattr(spec.item_model, spec.item_subscription_field),
                    func.count(),
                )
                .where(getattr(spec.item_model, spec.item_subscription_field).in_(subscription_ids))
                .group_by(getattr(spec.item_model, spec.item_subscription_field))
            )).all()
            count_by_subscription = {row[0]: int(row[1]) for row in counts}
            result.extend([
                _subscription_payload(
                    spec,
                    subscription,
                    count_by_subscription.get(
                        getattr(subscription, spec.subscription_id_field), 0
                    ),
                )
                for subscription in subscriptions
            ])

    return result


async def search_source_items(
    source_type: str = "",
    query: str = "",
    subscription_id: Optional[str] = None,
    days: int = 30,
    limit: int = 20,
) -> list[dict[str, Any]]:
    """Search already-collected source items; never starts a collector."""
    specs = _source_specs()
    selected_types = _resolve_source_types(source_type, specs)
    if subscription_id is not None and len(selected_types) != 1:
        raise ValueError("source_type is required when filtering by subscription_id")
    take = max(1, min(int(limit), 50))
    lookback_days = max(1, min(int(days), 365))
    since = datetime.now(timezone.utc) - timedelta(days=lookback_days)
    terms = [term.casefold() for term in _text(query).split() if term.strip()]
    results: list[tuple[int, datetime, dict[str, Any]]] = []

    async with SessionLocal() as db:
        for selected_type in selected_types:
            spec = specs[selected_type]
            item_model = spec.item_model
            statement = select(item_model).where(
                getattr(item_model, spec.item_published_field) >= since
            )
            if subscription_id is not None:
                statement = statement.where(
                    getattr(item_model, spec.item_subscription_field)
                    == _coerce_id(spec, subscription_id)
                )
            if terms:
                statement = statement.where(or_(*[
                    func.lower(getattr(item_model, field)).contains(term)
                    for field in spec.item_search_fields
                    for term in terms
                ]))
            statement = statement.order_by(
                desc(getattr(item_model, spec.item_published_field))
            ).limit(500)
            items = (await db.execute(statement)).scalars().all()
            if not items:
                continue

            subscription_ids = {
                getattr(item, spec.item_subscription_field) for item in items
            }
            subscriptions = (await db.execute(
                select(spec.subscription_model).where(
                    getattr(spec.subscription_model, spec.subscription_id_field).in_(subscription_ids)
                )
            )).scalars().all()
            labels = {
                getattr(subscription, spec.subscription_id_field): _text(
                    getattr(subscription, spec.subscription_label_field)
                )
                for subscription in subscriptions
            }
            for item in items:
                label = labels.get(
                    getattr(item, spec.item_subscription_field),
                    _text(getattr(item, "account_name", "")),
                )
                haystack = _item_search_text(spec, item, label)
                score = sum(1 for term in terms if term in haystack)
                if terms and score == 0:
                    continue
                published_at = getattr(item, spec.item_published_field)
                results.append((
                    score,
                    published_at,
                    _item_payload(spec, item, label, full_content=False),
                ))

    results.sort(key=lambda value: (value[0], value[1]), reverse=True)
    return [payload for _score, _published_at, payload in results[:take]]


async def get_source_item(source_type: str, item_id: str) -> dict[str, Any]:
    """Read one already-collected item, including its complete stored content."""
    specs = _source_specs()
    selected_types = _resolve_source_types(source_type, specs)
    if len(selected_types) != 1:
        raise ValueError("source_type is required when reading one source item")
    spec = specs[selected_types[0]]
    item_key = _text(item_id)
    async with SessionLocal() as db:
        item = await db.get(spec.item_model, item_key)
        if item is None:
            raise ValueError(f"{spec.source_type} item '{item_id}' not found")
        subscription = await db.get(
            spec.subscription_model,
            getattr(item, spec.item_subscription_field),
        )
        label = (
            _text(getattr(subscription, spec.subscription_label_field))
            if subscription is not None else _text(getattr(item, "account_name", ""))
        )
        return _item_payload(spec, item, label, full_content=True)

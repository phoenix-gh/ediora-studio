"""Deterministic Intelligence Station handoff into existing content records."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import (
    ContentAnalysisRun,
    ContentResponseEvent,
    ContentResponseItem,
    CreativeAsset,
    CreativeAssetDirectory,
    XPost,
    YoutubeVideo,
)


class HandoffError(ValueError):
    pass


class DestinationConflictError(HandoffError):
    pass


class StaleAnalysisError(HandoffError):
    pass


class SourceUnavailableError(HandoffError):
    pass


async def get_response_source(
    db: AsyncSession,
    item: ContentResponseItem,
) -> dict[str, Any]:
    """Return normalized source metadata and the complete available body."""
    base: dict[str, Any] = {
        "type": item.source_type,
        "id": item.source_id,
        "url": item.source_url,
        "title": item.source_title,
        "author": item.source_author,
        "published_at": item.source_published_at,
        "available": False,
        "unavailable_reason": "原文暂不可用",
    }
    if item.source_type == "x_post":
        post = await db.get(XPost, item.source_id)
        if post is None:
            return base
        body = post.raw_markdown or post.content or ""
        return {
            **base,
            "url": post.url or item.source_url,
            "title": post.content[:500] or item.source_title,
            "author": post.username or item.source_author,
            "published_at": post.published_at or item.source_published_at,
            "content": post.content,
            "raw_markdown": post.raw_markdown,
            "body": body,
            "available": bool(body.strip()),
            "unavailable_reason": "X 原文正文为空" if not body.strip() else "",
        }
    if item.source_type == "youtube_video":
        video = await db.get(YoutubeVideo, item.source_id)
        if video is None:
            return base
        body = video.transcript_text or ""
        return {
            **base,
            "url": video.url or item.source_url,
            "title": video.title or item.source_title,
            "author": video.channel_name or item.source_author,
            "published_at": video.published_at or item.source_published_at,
            "description": video.description,
            "transcript_status": video.transcript_status,
            "transcript_source": video.transcript_source,
            "transcript_language": video.transcript_language,
            "transcript_text": video.transcript_text,
            "transcript_segments": video.transcript_segments,
            "transcript_content_hash": video.transcript_content_hash,
            "transcript_fetched_at": video.transcript_fetched_at,
            "transcript_error_code": video.transcript_error_code,
            "transcript_error": video.transcript_error,
            "body": body,
            "available": bool(body.strip()),
            "unavailable_reason": "YouTube 字幕正文为空" if not body.strip() else "",
        }
    return base


def _bullet_list(values: list[str]) -> str:
    return "\n".join(f"- {value}" for value in values) or "- 暂无"


def _evaluation_snapshot(run: ContentAnalysisRun) -> str:
    dimensions = "\n".join(
        f"- {name}: {value.get('score', 0)} — {value.get('reason', '')}"
        for name, value in run.value_dimensions.items()
    ) or "- 暂无"
    return "\n".join([
        "## AI评价快照",
        f"内容价值评分：{run.content_value_score}/100",
        f"推荐去向：{run.recommended_disposition}",
        f"推荐内容类型：{', '.join(run.recommended_content_types)}",
        f"核心判断：{run.core_thesis}",
        f"建议角度：{run.suggested_angle}",
        f"推荐理由：{run.recommendation_reason}",
        "",
        "### 价值维度",
        dimensions,
        "",
        "### 证据",
        _bullet_list([entry.get("text", "") for entry in run.evidence]),
        "",
        "### 风险与待核验",
        _bullet_list([*run.risks, *run.verification_items]),
    ])


def _asset_content(source: dict[str, Any], run: ContentAnalysisRun) -> str:
    source_lines = [
        "## 原文快照",
        f"来源：{source.get('url', '')}",
        f"标题：{source.get('title', '')}",
        f"作者：{source.get('author', '')}",
        "",
        source.get("body", ""),
        "",
    ]
    return "\n".join([*source_lines, _evaluation_snapshot(run), ""])


def _destination_payload(destination: str, destination_id: int) -> dict[str, Any]:
    return {
        "type": destination,
        "id": destination_id,
        "url": (
            f"/drafts?draft={destination_id}"
            if destination == "draft"
            else f"/assets?selected={destination_id}"
        ),
    }


async def create_or_get_destination(
    db: AsyncSession,
    *,
    item: ContentResponseItem,
    run: ContentAnalysisRun,
    destination: str,
    directory: str | None,
) -> dict[str, Any]:
    """Create one destination record, or return the identical existing one."""
    if destination != "creative_asset":
        raise HandoffError("值得写必须通过 expanded_article 写作任务")

    locked_item = await db.scalar(
        select(ContentResponseItem)
        .where(ContentResponseItem.id == item.id)
        .with_for_update()
    )
    if locked_item is None:
        raise KeyError("response item not found")
    current_run = (
        await db.get(ContentAnalysisRun, locked_item.current_analysis_run_id)
        if locked_item.current_analysis_run_id else None
    )
    if current_run is None or current_run.id != run.id or current_run.status != "succeeded":
        raise StaleAnalysisError("analysis run is stale or not successful")
    if locked_item.destination_type:
        if locked_item.destination_type != destination:
            raise DestinationConflictError("response item already has another destination")
        return _destination_payload(destination, locked_item.destination_id)

    source = await get_response_source(db, locked_item)
    if not source.get("available"):
        raise SourceUnavailableError(source.get("unavailable_reason") or "source body unavailable")

    selected_directory = (directory or "").strip()
    if selected_directory:
        directory_row = await db.scalar(select(CreativeAssetDirectory).where(
            CreativeAssetDirectory.asset_type == "article",
            CreativeAssetDirectory.name == selected_directory,
        ))
        if directory_row is None:
            raise HandoffError("article asset directory not found")
    record = CreativeAsset(
        asset_type="article",
        media_kind="text",
        title=current_run.suggested_title or source.get("title", ""),
        content=_asset_content(source, current_run),
        url=source.get("url", ""),
        media_type="text/markdown",
        directory=selected_directory,
        tags=["intelligence_station", *current_run.recommended_content_types],
        source="response",
    )

    db.add(record)
    await db.flush()
    locked_item.destination_type = destination
    locked_item.destination_id = record.id
    locked_item.decision_status = "creative_asset"
    locked_item.decided_at = datetime.now(timezone.utc)
    db.add(ContentResponseEvent(
        response_item_id=locked_item.id,
        analysis_run_id=current_run.id,
        event_type="destination_created",
        actor="user",
        payload={"destination": destination, "destination_id": record.id},
    ))
    await db.commit()
    return _destination_payload(destination, record.id)

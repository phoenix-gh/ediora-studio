"""
Ediora MCP Server
Exposes key data as tools for AI agents via Streamable HTTP transport.
Mount at /mcp in main.py: app.mount("/mcp", mcp.streamable_http_app())
"""

import mimetypes
import os
import uuid
from dataclasses import asdict
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Annotated, Literal, Optional
from urllib.parse import unquote, urlparse
from mcp.server.fastmcp import Context, FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import Field
from sqlalchemy import select, desc, delete as sa_delete, func
from database import SessionLocal
from web_search import WebSearchProviderError, search_web as run_web_search
from web_fetch import WebFetchProviderError, fetch_web_url as run_web_fetch
from tool_contracts import ediora_tool

_UPLOADS_DIR = Path(__file__).parent / "uploads"
_UPLOADS_DIR.mkdir(exist_ok=True)

# Base URL for constructing publicly accessible image URLs.
# Override with BASE_URL env var when running behind a reverse proxy.
_BASE_URL = os.getenv("BASE_URL", "http://localhost:8000")


def mcp_allowed_hosts() -> list[str]:
    """Hosts Codex may use when it calls this deployment's MCP endpoint."""
    hosts = ["api:8000", "localhost:8000", "127.0.0.1:8000"]
    for raw in (
        os.getenv("BASE_URL", ""),
        os.getenv("API_URL", ""),
        os.getenv("NEXT_PUBLIC_API_URL", ""),
    ):
        value = raw.strip()
        if not value:
            continue
        parsed = urlparse(value if "://" in value else f"http://{value}")
        if not parsed.hostname:
            continue
        hosts.append(parsed.hostname)
        if parsed.port:
            hosts.append(f"{parsed.hostname}:{parsed.port}")
    unique: list[str] = []
    for host in hosts:
        if host not in unique:
            unique.append(host)
    return unique


mcp = FastMCP(
    "Ediora",
    transport_security=TransportSecuritySettings(
        # DNS-rebinding protection stays on. The allowlist follows this
        # process's configured API address, plus the local and Compose hosts.
        allowed_hosts=mcp_allowed_hosts(),
    ),
)

SourceType = Literal["x", "wechat", "reddit", "youtube", "v2ex"]
OptionalSourceType = Literal["", "x", "wechat", "reddit", "youtube", "v2ex"]
SourceSearchDays = Annotated[int, Field(ge=1, le=365)]
NoveltyWindowDays = Annotated[int, Field(ge=1, le=90)]
NoveltyKeyFacts = Annotated[list[str], Field(max_length=20)]
NoveltySourceItemIds = Annotated[list[int], Field(max_length=100)]
AdoptedAssetIds = Annotated[list[int], Field(max_length=50)]
ExcludeAdoptedWithinDays = Annotated[int, Field(ge=0, le=90)]

# ── helpers ───────────────────────────────────────────────────────────────────

def _request_headers(ctx: Context | None) -> dict:
    if ctx is None:
        return {}
    request = getattr(getattr(ctx, "request_context", None), "request", None)
    headers = getattr(request, "headers", None)
    return headers or {}


async def _scheduled_lookback_days(ctx: Context | None) -> int:
    """Use the scheduled run window. Other callers do not exclude assets."""
    raw = _request_headers(ctx).get("x-daily-creation-run-id")
    try:
        run_id = int(raw)
    except (TypeError, ValueError):
        return 0
    if run_id <= 0:
        return 0
    from models import DailyCreationRun

    async with SessionLocal() as db:
        creation_run = await db.get(DailyCreationRun, run_id)
    if creation_run is None:
        return 0
    try:
        days = int((creation_run.rule_snapshot or {}).get("lookback_days") or 0)
    except (TypeError, ValueError):
        return 0
    return max(0, min(days, 90))


def _fmt_dt(dt: Optional[datetime]) -> str:
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


async def _register_draft_image(
    draft_id: int,
    filename: str,
    original_name: str,
    url: str,
    size_bytes: int,
    mime_type: str,
) -> int:
    """Attach an uploaded file to a draft's image library. Returns the DraftImage ID."""
    from models import ArticleDraft, DraftImage

    async with SessionLocal() as db:
        draft = await db.get(ArticleDraft, draft_id)
        if draft is None:
            raise ValueError(f"Draft {draft_id} not found")
        img = DraftImage(
            draft_id=draft_id,
            filename=filename,
            original_name=original_name,
            url=url,
            size_bytes=size_bytes,
            mime_type=mime_type,
        )
        db.add(img)
        await db.commit()
        await db.refresh(img)
        return img.id


_MAX_GENERATED_IMAGE_BYTES = 100 * 1024 * 1024
_DEFAULT_GENERATED_IMAGE_TITLE = "Chat 生图"


def _image_http_client(**kwargs):
    import httpx

    return httpx.AsyncClient(**kwargs)


def _clean_generate_prompt(prompt: str) -> str:
    cleaned = prompt.strip()
    if not cleaned:
        raise ValueError("generateImage requires a prompt")
    if len(cleaned) > 4000:
        raise ValueError("prompt is too long")
    return cleaned


def _clean_generate_title(title: str | None) -> str:
    if title is None:
        return _DEFAULT_GENERATED_IMAGE_TITLE
    cleaned = title.strip()
    if not cleaned or len(cleaned) > 200:
        raise ValueError("title is invalid")
    return cleaned


def _clean_generate_directory(directory: str | None) -> str:
    if directory is None:
        return ""
    cleaned = directory.strip()
    if not cleaned or len(cleaned) > 80:
        raise ValueError("directory is invalid")
    return cleaned


def _sniff_image_media_type(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(data) >= 12 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    raise ValueError("Image provider returned an unsupported image")


def _decode_image_b64(value: str) -> bytes:
    import base64

    raw = value.strip()
    if raw.startswith("data:"):
        raw = raw.split(",", 1)[-1]
    raw = "".join(raw.split())
    raw += "=" * (-len(raw) % 4)
    try:
        data = base64.b64decode(raw, validate=False)
    except Exception as exc:
        raise ValueError("Image provider returned invalid image data") from exc
    if not data:
        raise ValueError("Image provider returned an empty image")
    return data


def _provider_error(response) -> ValueError:
    detail = " ".join((response.text or "").split())[:240]
    suffix = f": {detail}" if detail else ""
    return ValueError(f"Image provider request failed ({response.status_code}){suffix}")


async def _configured_image_adapter():
    from config import get_config
    from llm_adapters import AdapterResolutionError, resolve_adapter

    try:
        return resolve_adapter(await get_config(), capability="image")
    except AdapterResolutionError as exc:
        raise ValueError(str(exc)) from exc


async def _image_output_directory(requested: str | None) -> str:
    from models import CreativeAssetDirectory
    from temporary_asset_directory import ensure_temporary_asset_directory

    cleaned = _clean_generate_directory(requested)
    async with SessionLocal() as db:
        if not cleaned:
            directory = await ensure_temporary_asset_directory(db)
            await db.commit()
            return directory.name
        found = await db.scalar(
            select(CreativeAssetDirectory).where(
                CreativeAssetDirectory.asset_type == "media",
                CreativeAssetDirectory.name == cleaned,
            )
        )
        if found is None:
            raise ValueError(f"多媒体目录不存在：{cleaned}")
        return found.name


async def _post_image_generation(adapter, prompt: str) -> dict:
    import httpx

    base = (adapter.base_url or "").strip().rstrip("/") or "https://api.openai.com/v1"
    headers = {
        "Authorization": f"Bearer {adapter.api_key}",
        **dict(adapter.headers or {}),
        "Content-Type": "application/json",
    }
    body = {"model": adapter.model, "prompt": prompt, "n": 1}
    # gpt-image rejects response_format and returns b64_json. Other models use the configured format.
    if not adapter.model.lower().startswith("gpt-image"):
        body["response_format"] = "url" if adapter.image_response_format == "url" else "b64_json"
    timeout = httpx.Timeout(180.0, connect=10.0)
    try:
        async with _image_http_client(
            timeout=timeout,
            follow_redirects=False,
            trust_env=True,
        ) as client:
            response = await client.post(f"{base}/images/generations", headers=headers, json=body)
            if (
                response.status_code == 400
                and "response_format" in body
                and "response_format" in response.text
            ):
                body = {key: value for key, value in body.items() if key != "response_format"}
                response = await client.post(
                    f"{base}/images/generations",
                    headers=headers,
                    json=body,
                )
    except httpx.TimeoutException as exc:
        raise ValueError("Image provider request timed out") from exc
    except httpx.HTTPError as exc:
        raise ValueError("Image provider request failed") from exc
    if response.status_code != 200:
        raise _provider_error(response)
    try:
        payload = response.json()
    except Exception as exc:
        raise ValueError("Image provider returned invalid JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("Image provider returned invalid JSON")
    return payload


async def _download_provider_image(url: str) -> tuple[bytes, str]:
    import httpx
    from remote_image_import import RemoteImageImportError, _download_image

    try:
        return await _download_image(url, _image_http_client)
    except RemoteImageImportError as exc:
        raise ValueError(exc.message) from exc
    except httpx.TimeoutException as exc:
        raise ValueError("图片下载超时") from exc
    except httpx.HTTPError as exc:
        raise ValueError("图片地址不可访问") from exc


async def _image_from_provider_payload(payload: dict, *, prefer_url: bool) -> tuple[bytes, str]:
    data = payload.get("data")
    item = data[0] if isinstance(data, list) and data and isinstance(data[0], dict) else None
    if item is None:
        raise ValueError("Image provider response did not include an image")
    url = item.get("url") if isinstance(item.get("url"), str) else ""
    b64 = item.get("b64_json") if isinstance(item.get("b64_json"), str) else ""
    url = url.strip()
    b64 = b64.strip()
    if prefer_url and url:
        return await _download_provider_image(url)
    if b64:
        raw = _decode_image_b64(b64)
        return raw, _sniff_image_media_type(raw)
    if url:
        return await _download_provider_image(url)
    raise ValueError("Image provider response did not include an image")


def _verified_image_extension(data: bytes, media_type: str) -> str:
    from remote_image_import import RemoteImageImportError, _verified_extension

    try:
        return _verified_extension(data, media_type)
    except RemoteImageImportError as exc:
        raise ValueError(exc.message) from exc


async def _persist_generated_image(
    data: bytes,
    media_type: str,
    title: str,
    directory: str,
) -> dict:
    from models import CreativeAsset

    if not data:
        raise ValueError("Image provider returned an empty image")
    if len(data) > _MAX_GENERATED_IMAGE_BYTES:
        raise ValueError("图片超过100MB限制")
    extension = _verified_image_extension(data, media_type)
    _UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex}{extension}"
    destination = _UPLOADS_DIR / filename
    destination.write_bytes(data)
    try:
        async with SessionLocal() as db:
            asset = CreativeAsset(
                asset_type="media",
                media_kind="image",
                title=title,
                url=f"/api/uploads/{filename}",
                media_type=media_type,
                filename=filename,
                directory=directory,
                source="upload",
            )
            db.add(asset)
            await db.commit()
            await db.refresh(asset)
            return {
                "asset_id": asset.id,
                "asset_url": asset.url,
                "title": asset.title,
                "directory": directory,
            }
    except Exception:
        destination.unlink(missing_ok=True)
        raise


# ── tools ─────────────────────────────────────────────────────────────────────

@ediora_tool(
    mcp,
    namespace="web_research",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=True,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def web_search(query: str, max_results: int = 5, language: str = "zh-CN") -> dict:
    """Search the public web, not stored Ediora information sources.

    Use when the user needs public-web discovery rather than already-collected
    subscription content. Cite returned URLs and do not claim results beyond
    this output.
    """
    try:
        results, provider = await run_web_search(
            query.strip(), max(1, min(max_results, 10)), language.strip() or "zh-CN",
        )
    except WebSearchProviderError as exc:
        return {
            "error": f"Web search is unavailable: {exc.reason}. Configure it in Settings → Web 搜索.",
            "results": [],
        }
    return {"provider": provider, "results": [asdict(result) for result in results]}


@ediora_tool(
    mcp,
    namespace="web_research",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=True,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def fetch_url(url: str, max_chars: int = 12_000) -> dict:
    """Fetch readable text from one known public URL; this is not web search.

    Use after a URL is known. Cite the returned URL when using its content.
    """
    try:
        result, provider = await run_web_fetch(url.strip(), max(1, min(max_chars, 12_000)))
    except WebFetchProviderError as exc:
        return {
            "error": f"URL fetch is unavailable: {exc.reason}. Configure it in Settings → 网页抓取.",
            "url": url,
            "content": "",
        }
    return {"provider": provider, "url": result.url, "title": result.title, "content": result.content, "content_type": result.content_type}

@ediora_tool(
    mcp,
    namespace="writing_plans",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def get_content_directions() -> list[dict]:
    """
    Return Ediora editorial directions and their child topic strategies.

    These are system-configured editorial directions, not user-managed writing plans.

    A direction is a broad content domain (e.g. "AI 工具评测").
    A strategy defines how to mine topics within that direction (filters,
    LLM prompt, output count, etc.).

    Returns a list of directions, each with a nested "strategies" list.
    """
    from models import ContentDirection, TopicStrategy

    async with SessionLocal() as db:
        directions = (await db.execute(
            select(ContentDirection).order_by(ContentDirection.created_at)
        )).scalars().all()

        result = []
        for d in directions:
            strategies = (await db.execute(
                select(TopicStrategy)
                .where(TopicStrategy.direction_id == d.id)
                .order_by(TopicStrategy.created_at)
            )).scalars().all()

            result.append({
                "id": d.id,
                "name": d.name,
                "description": d.description or "",
                "is_active": d.is_active,
                "strategies": [
                    {
                        "id": s.id,
                        "name": s.name,
                        "filter_hours": s.filter_hours,
                        "filter_min_views": s.filter_min_views,
                        "filter_viral_only": s.filter_viral_only,
                        "filter_keywords": s.filter_keywords or [],
                        "filter_exclude_keywords": s.filter_exclude_keywords or [],
                        "output_count": s.output_count,
                        "llm_prompt": s.llm_prompt or "",
                    }
                    for s in strategies
                ],
            })

    return result


@ediora_tool(
    mcp,
    namespace="information_sources",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def get_github_daily_trending() -> dict:
    """Return the latest GitHub daily Trending snapshot and rank changes.

    This tool is intentionally argument-free: the Agent must use the daily
    snapshot already collected by Ediora and cannot switch to weekly
    data or invent a different source. This is not X subscription content.
    """
    from models import GithubTrendingRepo

    empty = {
        "period": "daily",
        "trending_date": "",
        "previous_trending_date": "",
        "source_url": "https://github.com/trending?since=daily",
        "items": [],
        "summary": {
            "count": 0,
            "new_count": None,
            "top_languages": [],
        },
    }

    async with SessionLocal() as db:
        latest = await db.scalar(
            select(func.max(GithubTrendingRepo.trending_date)).where(
                GithubTrendingRepo.period == "daily"
            )
        )
        if not latest:
            return empty

        previous = await db.scalar(
            select(func.max(GithubTrendingRepo.trending_date)).where(
                GithubTrendingRepo.period == "daily",
                GithubTrendingRepo.trending_date < latest,
            )
        )
        rows = (
            await db.execute(
                select(GithubTrendingRepo)
                .where(
                    GithubTrendingRepo.period == "daily",
                    GithubTrendingRepo.trending_date == latest,
                )
                .order_by(GithubTrendingRepo.position)
            )
        ).scalars().all()
        previous_rows = []
        if previous:
            previous_rows = (
                await db.execute(
                    select(GithubTrendingRepo).where(
                        GithubTrendingRepo.period == "daily",
                        GithubTrendingRepo.trending_date == previous,
                    )
                )
            ).scalars().all()

    previous_positions = {
        f"{row.owner}/{row.repo}": row.position for row in previous_rows
    }
    language_counts: dict[str, int] = {}
    items: list[dict] = []
    for row in rows:
        full_name = f"{row.owner}/{row.repo}"
        previous_rank = previous_positions.get(full_name)
        language = row.language or ""
        if language:
            language_counts[language] = language_counts.get(language, 0) + 1
        items.append({
            "rank": row.position,
            "full_name": full_name,
            "owner": row.owner,
            "repo": row.repo,
            "description": row.description or "",
            "language": language,
            "stars": row.stars,
            "stars_gained": row.stars_gained,
            "forks": row.forks,
            "url": row.url or f"https://github.com/{full_name}",
            "previous_rank": previous_rank,
            "rank_delta": (
                previous_rank - row.position
                if previous_rank is not None else None
            ),
            "is_new": (previous_rank is None if previous else None),
        })

    top_languages = sorted(
        language_counts.items(), key=lambda item: (-item[1], item[0])
    )[:5]
    return {
        "period": "daily",
        "trending_date": latest,
        "previous_trending_date": previous or "",
        "source_url": "https://github.com/trending?since=daily",
        "items": items,
        "summary": {
            "count": len(items),
            "new_count": sum(1 for item in items if item["is_new"] is True) if previous else None,
            "top_languages": [
                {"language": language, "count": count}
                for language, count in top_languages
            ],
        },
    }


@ediora_tool(
    mcp,
    namespace="drafts",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def list_drafts(
    limit: int = 20,
    status: Optional[str] = None,
) -> list[dict]:
    """
    List compact metadata for article drafts stored in Ediora.

    Use for draft discovery and filtering; full content is not included.

    Args:
        limit: Maximum number of drafts to return (max 50).
        status: Filter by status: "drafting", "review", "published".
                Leave empty for all statuses.

    Returns drafts sorted by updated_at descending.
    Each item includes: id, title, status, topic_id, version, created_at, updated_at.
    Note: content/body is not included — use get_draft(id) to fetch the full text.
    """
    from models import ArticleDraft

    limit = max(1, min(limit, 50))

    async with SessionLocal() as db:
        q = (
            select(ArticleDraft)
            .order_by(desc(ArticleDraft.updated_at))
            .limit(limit)
        )
        if status:
            q = q.where(ArticleDraft.status == status)
        rows = (await db.execute(q)).scalars().all()

    return [
        {
            "id": d.id,
            "title": d.title or "",
            "status": d.status,
            "topic_id": d.topic_id,
            "version": d.version,
            "created_at": _fmt_dt(d.created_at),
            "updated_at": _fmt_dt(d.updated_at),
        }
        for d in rows
    ]


@ediora_tool(
    mcp,
    namespace="drafts",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def get_draft(draft_id: int) -> dict:
    """
    Fetch the full content of a specific draft by known ID; this is not search.

    Args:
        draft_id: The integer ID of the draft (obtained from list_drafts).

    Returns: id, title, content (full Markdown body), status, topic_id,
             version, created_at, updated_at.
    Raises an error if the draft is not found.
    """
    from models import ArticleDraft

    async with SessionLocal() as db:
        obj = await db.get(ArticleDraft, draft_id)

    if obj is None:
        raise ValueError(f"Draft {draft_id} not found")

    return {
        "id": obj.id,
        "title": obj.title or "",
        "content": obj.content or "",
        "status": obj.status,
        "topic_id": obj.topic_id,
        "version": obj.version,
        "created_at": _fmt_dt(obj.created_at),
        "updated_at": _fmt_dt(obj.updated_at),
    }


def _search_asset_payload(asset) -> dict:
    """Prompt rows keep their original text. Other rows stay as a short summary."""
    content = asset.content or ""
    payload = {
        "id": asset.id,
        "asset_type": asset.asset_type,
        "prompt_kind": asset.prompt_kind or "",
        "media_kind": asset.media_kind or "",
        "title": asset.title or "",
        "summary": " ".join(content.split())[:500],
        "url": asset.url or "",
        "directory": asset.directory or "",
        "tags": asset.tags or [],
        "source": asset.source or "",
    }
    if asset.asset_type == "prompt":
        payload["content"] = content
    return payload


@ediora_tool(
    mcp,
    namespace="creative_assets",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def search_creative_assets(
    query: str = "",
    directory: str = "",
    asset_type: str = "",
    limit: int = 10,
    exclude_adopted_within_days: ExcludeAdoptedWithinDays = 0,
    ctx: Context | None = None,
) -> list[dict]:
    """
    Search the user's Creative Assets / 素材库. This tool is read-only.

    Use it to find raw article material, images, video, or audio stored under
    创作资产. Query is a space-separated list of alternative keywords; an
    asset matching more terms ranks first. It matches the asset's directory,
    title, body text, and tags. Directory optionally narrows the result to one
    material folder, such as "搞钱副业". This is general asset search, not
    scheduled-directory candidate selection.

    exclude_adopted_within_days omits assets whose last adopted time is inside
    that many days. Assets that have never been adopted stay in the results.
    0 uses a scheduled run's lookback when that call belongs to one, and
    otherwise returns every match. get_creative_asset still reads one asset by id.

    Prompt assets include their full text in content, with the original line
    breaks. Article and media rows still return a short summary.

    Args:
        query: Optional keywords to search for.
        directory: Optional exact material-folder name.
        asset_type: Optional "article", "media", or "prompt" filter.
        limit: Maximum assets to return (default 10, max 30).
        exclude_adopted_within_days: Days of recent adoption to omit (0–90).

    Returns compact metadata. Prompt rows also include content. Call
    get_creative_asset(id) to read a complete article body.
    """
    from models import CreativeAsset
    from daily_creation_service import (
        creative_asset_search_score,
        not_recently_adopted,
    )

    normalized_type = asset_type.strip().lower()
    if normalized_type and normalized_type not in {"article", "media", "prompt"}:
        raise ValueError("asset_type must be 'article', 'media', 'prompt', or empty")
    normalized_directory = directory.strip()
    take = max(1, min(int(limit), 30))
    lookback_days = int(exclude_adopted_within_days or 0)
    if lookback_days <= 0:
        lookback_days = await _scheduled_lookback_days(ctx)

    async with SessionLocal() as db:
        statement = select(CreativeAsset)
        if normalized_type:
            statement = statement.where(CreativeAsset.asset_type == normalized_type)
        if normalized_directory:
            statement = statement.where(CreativeAsset.directory == normalized_directory)
        available = not_recently_adopted(lookback_days, asset=CreativeAsset)
        if available is not None:
            statement = statement.where(available)
        rows = (
            await db.execute(
                statement.order_by(
                    desc(CreativeAsset.updated_at), desc(CreativeAsset.id)
                ).limit(500)
            )
        ).scalars().all()

    scored_assets = [
        (asset, creative_asset_search_score(asset, query))
        for asset in rows
    ]
    if query.strip():
        scored_assets = [item for item in scored_assets if item[1] > 0]
        scored_assets.sort(key=lambda item: item[1], reverse=True)

    return [_search_asset_payload(asset) for asset, _score in scored_assets][:take]


@ediora_tool(
    mcp,
    namespace="creative_assets",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def get_creative_asset(asset_id: int) -> dict:
    """
    Read one complete Creative Asset / 素材库 item by ID. This tool is read-only.

    Use search_creative_assets first to locate a known ID, then call this tool to
    retrieve the full raw content before analyzing or repurposing it.
    """
    from models import CreativeAsset

    async with SessionLocal() as db:
        asset = await db.get(CreativeAsset, asset_id)
    if asset is None:
        raise ValueError(f"Creative asset {asset_id} not found")
    return {
        "id": asset.id,
        "asset_type": asset.asset_type,
        "prompt_kind": asset.prompt_kind or "",
        "media_kind": asset.media_kind or "",
        "title": asset.title or "",
        "content": asset.content or "",
        "url": asset.url or "",
        "media_type": asset.media_type or "",
        "filename": asset.filename or "",
        "directory": asset.directory or "",
        "tags": asset.tags or [],
        "source": asset.source or "",
    }


@ediora_tool(
    mcp,
    namespace="information_sources",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def list_source_subscriptions(
    source_type: OptionalSourceType = "",
    include_muted: bool = True,
    limit: int = 50,
) -> list[dict]:
    """List configured X/公众号 and other source subscriptions (read-only).

    ``source_type`` may be ``x``, ``wechat``, ``reddit``, ``youtube``, or
    ``v2ex``. Leave it empty to list all supported source types. This tool
    resolves subscription IDs and names and reads stored item counts; it never
    retrieves items or starts a collection job.
    """
    from source_tools import list_source_subscriptions as _list_source_subscriptions

    return await _list_source_subscriptions(
        source_type=source_type,
        include_muted=include_muted,
        limit=limit,
    )


@ediora_tool(
    mcp,
    namespace="information_sources",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def search_source_items(
    source_type: OptionalSourceType = "",
    query: str = "",
    subscription_id: Optional[str] = None,
    days: SourceSearchDays = 30,
    limit: int = 20,
) -> list[dict]:
    """Search already-collected source items by relevance and filters.

    Search covers X posts, 公众号 articles, Reddit posts, YouTube videos,
    and V2EX topics. ``source_type`` can be left empty for a cross-source
    search. This is not random sampling and does not access the public web.
    The result contains compact content; call ``get_source_item`` with its
    source type and ID to read the complete stored body. No collector or
    background job is triggered.
    """
    from source_tools import search_source_items as _search_source_items

    return await _search_source_items(
        source_type=source_type,
        query=query,
        subscription_id=subscription_id,
        days=days,
        limit=limit,
    )


@ediora_tool(
    mcp,
    namespace="information_sources",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def get_source_item(source_type: SourceType, item_id: str) -> dict:
    """Read one complete stored source item by source type and known ID.

    This is direct retrieval, not search, random sampling, or collection.
    """
    from source_tools import get_source_item as _get_source_item

    return await _get_source_item(source_type=source_type, item_id=item_id)


@ediora_tool(
    mcp,
    namespace="creative_assets",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def list_creative_asset_candidates(
    asset_type: str,
    directories: list[str],
    query: str = "",
    limit: int = 50,
    ctx: Context | None = None,
) -> list[dict]:
    """List compact scheduled-creation candidates from explicit asset directories.

    Space-separated query terms are alternatives and candidates are ranked by
    how many terms match their directory, title, body, or tags. Use general
    search_creative_assets when no task-specific directory set is required.
    A scheduled creation run omits assets adopted inside that task's lookback
    window. Calls without a scheduled run return every match.
    """
    from daily_creation_service import (
        list_creative_asset_candidates as list_candidates,
    )

    lookback_days = await _scheduled_lookback_days(ctx)
    async with SessionLocal() as db:
        return await list_candidates(
            db,
            asset_type=asset_type,
            directories=directories,
            query=query,
            limit=limit,
            lookback_days=lookback_days,
        )


@ediora_tool(
    mcp,
    namespace="drafts",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def check_content_novelty(
    topic: str,
    core_claim: str,
    key_facts: NoveltyKeyFacts | None = None,
    event_time: datetime | None = None,
    source_item_ids: NoveltySourceItemIds | None = None,
    window_days: NoveltyWindowDays = 14,
) -> dict:
    """Check whether an Agent topic and core claim repeat recent Agent drafts.

    Use before writing to avoid spending work on a recent global duplicate.
    This is advisory only: save_draft performs the authoritative check again
    when novelty checking is enabled.
    A different title, structure, or tone does not make the same claim novel.
    """
    from agent_topic_novelty import (
        NoveltyCandidate,
        check_content_novelty as check_novelty,
        disabled_novelty_decision,
        agent_topic_novelty_enabled,
        judge_novelty_with_model,
    )

    if not agent_topic_novelty_enabled():
        return asdict(disabled_novelty_decision())

    candidate = NoveltyCandidate(
        topic=topic,
        core_claim=core_claim,
        key_facts=tuple(key_facts or ()),
        event_time=event_time,
        source_item_ids=tuple(source_item_ids or ()),
    )
    async with SessionLocal() as db:
        decision = await check_novelty(
            db,
            candidate=candidate,
            window_days=window_days,
            judge=judge_novelty_with_model,
        )
    return asdict(decision)


@ediora_tool(
    mcp,
    namespace="drafts",
    read_only=False,
    destructive=True,
    idempotent=False,
    open_world=False,
    approval="writes",
    concurrency="serialized",
    retry="claim-backed",
)
async def update_draft(
    draft_id: int,
    title: Optional[str] = None,
    content: Optional[str] = None,
    status: Optional[str] = None,
) -> dict:
    """
    Overwrite selected fields of an existing draft identified by known ID.

    Title, full Markdown content, and status can be replaced. Omitted fields
    remain unchanged; callers should not assume replay is harmless.

    Args:
        draft_id: The integer ID of the draft to update (from list_drafts).
        title: New title, or omit to leave unchanged.
        content: New full Markdown body, or omit to leave unchanged.
        status: New status — "drafting", "editing", "ready", "published", "archived".
                Omit to leave unchanged.

    Returns: id, title, status, version, updated_at of the updated draft.
    Raises an error if the draft is not found.
    """
    from models import ArticleDraft

    async with SessionLocal() as db:
        obj = await db.get(ArticleDraft, draft_id)
        if obj is None:
            raise ValueError(f"Draft {draft_id} not found")
        if title is not None:
            obj.title = title
        if content is not None:
            obj.content = content
        if status is not None:
            obj.status = status
        await db.commit()
        await db.refresh(obj)

    return {
        "id": obj.id,
        "title": obj.title or "",
        "status": obj.status,
        "version": obj.version,
        "updated_at": _fmt_dt(obj.updated_at),
    }


@ediora_tool(
    mcp,
    namespace="writing_plans",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def list_writing_plans(
    include_archived: bool = False,
) -> list[dict]:
    """
    List compact user-managed writing plans (写作方案) for discovery.

    Plans are sorted by priority then created_at.

    Args:
        include_archived: Include archived plans (default False).

    Returns a flat list. Each item includes: id, title, strategy,
    tags (list of {id, name, color}), priority (1=highest), status,
    source_count, draft_count, created_at.
    """
    from models import WritingPlan, PlanSource, ArticleDraft, PlanTag, WritingPlanTag
    from sqlalchemy import func

    async with SessionLocal() as db:
        q = select(WritingPlan).order_by(WritingPlan.priority, WritingPlan.created_at)
        if not include_archived:
            q = q.where(WritingPlan.status == "active")
        plans = (await db.execute(q)).scalars().all()

        ids = [p.id for p in plans]

        source_counts = dict((await db.execute(
            select(PlanSource.plan_id, func.count())
            .where(PlanSource.plan_id.in_(ids))
            .group_by(PlanSource.plan_id)
        )).all()) if ids else {}

        draft_counts = dict((await db.execute(
            select(ArticleDraft.writing_plan_id, func.count())
            .where(ArticleDraft.writing_plan_id.in_(ids))
            .group_by(ArticleDraft.writing_plan_id)
        )).all()) if ids else {}

        tag_rows = (await db.execute(
            select(WritingPlanTag.plan_id, PlanTag.id, PlanTag.name, PlanTag.color)
            .join(PlanTag, PlanTag.id == WritingPlanTag.tag_id)
            .where(WritingPlanTag.plan_id.in_(ids))
        )).all() if ids else []
        tags_by_plan: dict[int, list[dict]] = {}
        for row in tag_rows:
            tags_by_plan.setdefault(row.plan_id, []).append(
                {"id": row.id, "name": row.name, "color": row.color}
            )

    return [
        {
            "id": p.id,
            "title": p.title,
            "strategy": p.strategy or "",
            "tags": tags_by_plan.get(p.id, []),
            "priority": p.priority,
            "status": p.status,
            "source_count": source_counts.get(p.id, 0),
            "draft_count": draft_counts.get(p.id, 0),
            "created_at": _fmt_dt(p.created_at),
        }
        for p in plans
    ]


@ediora_tool(
    mcp,
    namespace="writing_plans",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def get_writing_plan(plan_id: int) -> dict:
    """
    Get a full writing plan by known ID with sources, tags, and update history.

    Args:
        plan_id: Integer ID of the plan (from list_writing_plans or search_writing_plans).

    Returns: id, title, strategy, tags, priority, status, created_at,
             sources list, and updates list (most recent first).
    Raises an error if the plan is not found.
    """
    from models import WritingPlan, PlanSource, PlanTag, WritingPlanTag, PlanUpdate

    async with SessionLocal() as db:
        plan = await db.get(WritingPlan, plan_id)
        if plan is None:
            raise ValueError(f"Writing plan {plan_id} not found")

        sources = (await db.execute(
            select(PlanSource)
            .where(PlanSource.plan_id == plan_id)
            .order_by(desc(PlanSource.created_at))
        )).scalars().all()

        tag_rows = (await db.execute(
            select(PlanTag)
            .join(WritingPlanTag, WritingPlanTag.tag_id == PlanTag.id)
            .where(WritingPlanTag.plan_id == plan_id)
        )).scalars().all()

        updates = (await db.execute(
            select(PlanUpdate)
            .where(PlanUpdate.plan_id == plan_id)
            .order_by(desc(PlanUpdate.created_at))
            .limit(20)
        )).scalars().all()

    return {
        "id": plan.id,
        "title": plan.title,
        "strategy": plan.strategy or "",
        "tags": [{"id": t.id, "name": t.name, "color": t.color} for t in tag_rows],
        "priority": plan.priority,
        "status": plan.status,
        "created_at": _fmt_dt(plan.created_at),
        "sources": [
            {
                "id": s.id,
                "url": s.url or "",
                "title": s.title or "",
                "note": s.note or "",
                "platform": s.platform,
                "created_at": _fmt_dt(s.created_at),
            }
            for s in sources
        ],
        "updates": [
            {
                "id": u.id,
                "description": u.description,
                "source_url": u.source_url or "",
                "created_at": _fmt_dt(u.created_at),
            }
            for u in updates
        ],
    }


@ediora_tool(
    mcp,
    namespace="writing_plans",
    read_only=False,
    destructive=False,
    idempotent=False,
    open_world=False,
    approval="writes",
    concurrency="serialized",
    retry="claim-backed",
)
async def create_writing_plan(
    title: str,
    strategy: str = "",
    tags: Optional[list[str]] = None,
    priority: int = 3,
) -> dict:
    """
    Create one new persistent writing plan (写作方案) in the plan library.

    Repeating this call may create another plan. Returns the created plan ID,
    normalized priority, resolved tags, status, and creation timestamp.

    Args:
        title: Plan name — describes the *type* of content / repeatable writing
               pattern, NOT a specific article title.
               ✅ Good: "非程序员AI工具创业故事"、"普通人副业收入数字拆解"、"工具对比实测横评"
               ❌ Bad:  "AI压缩产品周期：非程序员用ChatGPT做付费APP案例拆解"（这是文章标题）
               Rule: remove all specific names/numbers — if the title still makes
               sense as a category name, it's correct.
        strategy: Markdown strategy describing the writing pattern, title formula,
               material sourcing method, and forbidden zones (optional).
        tags: List of tag names to attach (will be created if they don't exist).
        priority: 1 (highest) to 5 (lowest). Default 3.

    Returns: id, title, strategy, tags, priority, status, created_at.
    """
    from models import WritingPlan, PlanTag, WritingPlanTag
    from sqlalchemy import func

    _TAG_COLORS = ["#6366f1","#8b5cf6","#ec4899","#f59e0b","#10b981","#3b82f6","#ef4444","#14b8a6"]

    async def _get_or_create_tag(db, name: str) -> PlanTag:
        normalized = name.strip().lower()
        existing = (await db.execute(
            select(PlanTag).where(func.lower(PlanTag.name) == normalized)
        )).scalar_one_or_none()
        if existing:
            return existing
        color = _TAG_COLORS[sum(ord(c) for c in name) % len(_TAG_COLORS)]
        tag = PlanTag(name=name.strip(), color=color)
        db.add(tag)
        await db.flush()
        return tag

    async with SessionLocal() as db:
        obj = WritingPlan(
            title=title,
            strategy=strategy,
            priority=max(1, min(5, priority)),
        )
        db.add(obj)
        await db.flush()

        for name in (tags or []):
            if name.strip():
                tag = await _get_or_create_tag(db, name)
                db.add(WritingPlanTag(plan_id=obj.id, tag_id=tag.id))

        await db.commit()
        await db.refresh(obj)

        tag_rows = (await db.execute(
            select(PlanTag)
            .join(WritingPlanTag, WritingPlanTag.tag_id == PlanTag.id)
            .where(WritingPlanTag.plan_id == obj.id)
        )).scalars().all()

    return {
        "id": obj.id,
        "title": obj.title,
        "strategy": obj.strategy or "",
        "tags": [{"id": t.id, "name": t.name, "color": t.color} for t in tag_rows],
        "priority": obj.priority,
        "status": obj.status,
        "created_at": _fmt_dt(obj.created_at),
    }


@ediora_tool(
    mcp,
    namespace="writing_plans",
    read_only=False,
    destructive=False,
    idempotent=False,
    open_world=False,
    approval="writes",
    concurrency="serialized",
    retry="claim-backed",
)
async def add_plan_source(
    plan_id: int,
    url: str = "",
    title: str = "",
    note: str = "",
    content: str = "",
    platform: str = "manual",
) -> dict:
    """
    Add one persistent reference source (线索) to a known writing-plan ID.

    Use this to attach a useful link, article, or X post to a plan
    as research material. At least one of url or note must be provided.
    Repeating the call may create another source row; the returned source ID
    is the completion evidence.

    Args:
        plan_id: ID of the target plan (from list_writing_plans).
        url: Source URL (optional).
        title: Source title or headline (optional).
        note: Your annotation — e.g. "方法有效，2026-05 验证" (optional).
        content: Full body text or key excerpts from the source (optional but
                 recommended — users can read it in the preview panel without
                 opening the URL).
        platform: Source platform: "x", "github", "wechat", "manual", "self".

    Returns: id, plan_id, url, title, note, content, platform, created_at.
    """
    from models import WritingPlan, PlanSource

    if not url and not note:
        raise ValueError("At least one of url or note must be provided")

    async with SessionLocal() as db:
        plan = await db.get(WritingPlan, plan_id)
        if plan is None:
            raise ValueError(f"Writing plan {plan_id} not found")

        obj = PlanSource(
            plan_id=plan_id,
            url=url,
            title=title,
            note=note,
            content=content,
            platform=platform,
        )
        db.add(obj)
        await db.commit()
        await db.refresh(obj)

    return {
        "id": obj.id,
        "plan_id": obj.plan_id,
        "url": obj.url or "",
        "title": obj.title or "",
        "note": obj.note or "",
        "content": obj.content or "",
        "platform": obj.platform,
        "created_at": _fmt_dt(obj.created_at),
    }


@ediora_tool(
    mcp,
    namespace="writing_plans",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def search_writing_plans(keywords: list[str]) -> list[dict]:
    """
    Search writing plans by keyword; this is not information-source item search.

    Use this as the first step in content-to-writing-plan analysis to find candidate
    plans before asking the LLM to judge similarity.

    Args:
        keywords: List of keywords extracted from the source article,
                  e.g. ["AI", "创业", "一人公司"].

    Returns up to 10 matching plans, each with: id, title, strategy (first 200 chars), tags.
    Returns empty list if no matches or keywords is empty.
    """
    from models import WritingPlan, PlanTag, WritingPlanTag

    if not keywords:
        return []

    async with SessionLocal() as db:
        plans = (await db.execute(
            select(WritingPlan).where(WritingPlan.status == "active")
        )).scalars().all()

        matched = []
        for p in plans:
            haystack = (p.title + " " + (p.strategy or "")).lower()
            if any(kw.lower() in haystack for kw in keywords if kw.strip()):
                matched.append(p)
        matched = matched[:10]

        if not matched:
            return []

        ids = [p.id for p in matched]
        tag_rows = (await db.execute(
            select(WritingPlanTag.plan_id, PlanTag.id, PlanTag.name, PlanTag.color)
            .join(PlanTag, PlanTag.id == WritingPlanTag.tag_id)
            .where(WritingPlanTag.plan_id.in_(ids))
        )).all()
        tags_by_plan: dict[int, list[dict]] = {}
        for row in tag_rows:
            tags_by_plan.setdefault(row.plan_id, []).append(
                {"id": row.id, "name": row.name, "color": row.color}
            )

    return [
        {
            "id": p.id,
            "title": p.title,
            "strategy": (p.strategy or "")[:200],
            "tags": tags_by_plan.get(p.id, []),
        }
        for p in matched
    ]


@ediora_tool(
    mcp,
    namespace="writing_plans",
    read_only=False,
    destructive=True,
    idempotent=False,
    open_world=False,
    approval="writes",
    concurrency="serialized",
    retry="claim-backed",
)
async def update_writing_plan(
    plan_id: int,
    title: Optional[str] = None,
    strategy: Optional[str] = None,
    tags: Optional[list[str]] = None,
    priority: Optional[int] = None,
) -> dict:
    """
    Overwrite selected fields of a known writing plan: strategy, title, tags, or priority.

    ⚠️  SCOUT-ONLY — Only call this during a content-to-writing-plan analysis task
    (task body contains "## 任务类型\\ncontent-to-writing-plan").  The editor, writer,
    and illustrator must NEVER call this tool.  The writing plan library stores
    *research guidance* (how to find material, what angle to write), not article
    content.  It may only be refined through the scout's extraction pipeline.

    Args:
        plan_id: ID of the plan to update (from list_writing_plans or search_writing_plans).
        title: New title — must describe the *type* of content, not a specific
               article.  Same naming rule as create_writing_plan (category name,
               no specific persons/numbers).  Omit to leave unchanged.
        strategy: New full markdown strategy, or omit to leave unchanged.
        tags: New tag list (full replacement), or omit to leave unchanged.
        priority: New priority 1-5, or omit to leave unchanged.

    Returns: updated plan with id, title, strategy, tags, priority, status, updated_at.
    Raises an error if the plan is not found.
    """
    from models import WritingPlan, PlanTag, WritingPlanTag
    from sqlalchemy import func, delete

    _TAG_COLORS = ["#6366f1","#8b5cf6","#ec4899","#f59e0b","#10b981","#3b82f6","#ef4444","#14b8a6"]

    async def _get_or_create_tag(db, name: str) -> PlanTag:
        normalized = name.strip().lower()
        existing = (await db.execute(
            select(PlanTag).where(func.lower(PlanTag.name) == normalized)
        )).scalar_one_or_none()
        if existing:
            return existing
        color = _TAG_COLORS[sum(ord(c) for c in name) % len(_TAG_COLORS)]
        tag = PlanTag(name=name.strip(), color=color)
        db.add(tag)
        await db.flush()
        return tag

    async with SessionLocal() as db:
        obj = await db.get(WritingPlan, plan_id)
        if obj is None:
            raise ValueError(f"Writing plan {plan_id} not found")

        if title is not None:
            obj.title = title
        if strategy is not None:
            obj.strategy = strategy
        if priority is not None:
            obj.priority = max(1, min(5, priority))

        if tags is not None:
            await db.execute(delete(WritingPlanTag).where(WritingPlanTag.plan_id == plan_id))
            for name in tags:
                if name.strip():
                    tag = await _get_or_create_tag(db, name)
                    db.add(WritingPlanTag(plan_id=plan_id, tag_id=tag.id))

        await db.commit()
        await db.refresh(obj)

        tag_rows = (await db.execute(
            select(PlanTag)
            .join(WritingPlanTag, WritingPlanTag.tag_id == PlanTag.id)
            .where(WritingPlanTag.plan_id == obj.id)
        )).scalars().all()

    return {
        "id": obj.id,
        "title": obj.title,
        "strategy": obj.strategy or "",
        "tags": [{"id": t.id, "name": t.name, "color": t.color} for t in tag_rows],
        "priority": obj.priority,
        "status": obj.status,
        "updated_at": _fmt_dt(obj.updated_at),
    }


@ediora_tool(
    mcp,
    namespace="writing_plans",
    read_only=False,
    destructive=False,
    idempotent=False,
    open_world=False,
    approval="writes",
    concurrency="serialized",
    retry="claim-backed",
)
async def add_plan_update(
    plan_id: int,
    description: str,
    source_url: str = "",
) -> dict:
    """
    Create one persistent changelog entry for a known writing-plan ID.

    ⚠️  SCOUT-ONLY — Only call this during a content-to-writing-plan analysis task
    (task body contains "## 任务类型\\ncontent-to-writing-plan").  The editor, writer,
    and illustrator must NEVER call this tool.

    Call this after every content-to-writing-plan action — whether you updated,
    created, or skipped. The description should explain what changed or why
    you skipped, so the user can review the decision.

    Args:
        plan_id: ID of the affected writing plan.
        description: Human-readable summary of what happened, e.g.
                     "新增角度：产品化路径，补充了 2025 Q1 数据" or
                     "无新增角度，已有方案覆盖相同切入点，跳过".
        source_url: URL of the source article (optional).

    Repeating the call may create another entry. Returns its ID, plan ID,
    description, source URL, and creation timestamp.
    """
    from models import WritingPlan, PlanUpdate

    async with SessionLocal() as db:
        plan = await db.get(WritingPlan, plan_id)
        if plan is None:
            raise ValueError(f"Writing plan {plan_id} not found")

        obj = PlanUpdate(
            plan_id=plan_id,
            description=description.strip(),
            source_url=source_url.strip(),
        )
        db.add(obj)
        await db.commit()
        await db.refresh(obj)

    return {
        "id": obj.id,
        "plan_id": obj.plan_id,
        "description": obj.description,
        "source_url": obj.source_url or "",
        "created_at": _fmt_dt(obj.created_at),
    }


@ediora_tool(
    mcp,
    namespace="image_generation",
    read_only=False,
    destructive=False,
    idempotent=False,
    open_world=True,
    approval="writes",
    concurrency="serialized",
    retry="unsafe",
)
async def generateImage(
    prompt: Annotated[str, Field(min_length=1, max_length=4000)],
    title: Annotated[Optional[str], Field(min_length=1, max_length=200)] = None,
    directory: Annotated[Optional[str], Field(min_length=1, max_length=80)] = None,
) -> dict:
    """Synchronously generate one image and save it as a CreativeAsset before returning asset_id and asset_url. The returned image is already stored locally; never upload it again with upload_image_from_url or upload_image_from_path. The directory parameter is optional: only provide it when the user explicitly requests an existing media directory; otherwise omit it and save the image in the default media directory 临时文件. Do not reuse a prompt or source directory as a media directory.

    Each successful call creates a new image file, so do not retry blindly.

    Args:
        prompt: Image prompt, from 1 to 4000 characters.
        title: Optional asset title, from 1 to 200 characters. Defaults to "Chat 生图".
        directory: Optional existing media directory name. Omit it unless the user named one.

    Returns:
        asset_id, asset_url, title, directory, and model.
        asset_url is a local path such as "/api/uploads/abc.png".
    """
    cleaned_prompt = _clean_generate_prompt(prompt)
    cleaned_title = _clean_generate_title(title)
    output_directory = await _image_output_directory(directory)
    adapter = await _configured_image_adapter()
    payload = await _post_image_generation(adapter, cleaned_prompt)
    data, media_type = await _image_from_provider_payload(
        payload,
        prefer_url=adapter.image_response_format == "url",
    )
    saved = await _persist_generated_image(
        data,
        media_type,
        cleaned_title,
        output_directory,
    )
    return {**saved, "model": adapter.model}


@ediora_tool(
    mcp,
    namespace="creative_assets",
    read_only=False,
    destructive=False,
    idempotent=False,
    open_world=True,
    approval="writes",
    concurrency="serialized",
    retry="unsafe",
)
async def upload_image_from_url(
    url: str,
    filename_hint: str = "",
    draft_id: Optional[int] = None,
) -> dict:
    """
    Fetch an image from a remote URL and create a locally hosted Ediora file.

    Use this when you want to embed an externally hosted image in an article
    but need a stable, locally served URL (e.g. the original host may block
    hotlinking, or you want to ensure the image persists long-term).

    Args:
        url: The full URL of the image to fetch (http/https).
        filename_hint: Optional original filename or slug used as the extension
                       source when the Content-Type header is ambiguous.
        draft_id: Optional draft ID. When provided, the image is registered in
                  that draft's image library and will appear in the editor's
                  image panel. All variants in the same group (X, 公众号, etc.)
                  share the library — any member ID works.

    Each successful call can create a new file, so do not retry blindly.

    Returns:
        hosted_url: Absolute URL to serve the image from Ediora,
                    e.g. "http://localhost:8000/api/uploads/abc123.jpg".
                    Embed this directly in Markdown: ![alt](hosted_url)
        filename: The stored filename (e.g. "abc123.jpg").
        size_bytes: Size of the stored file in bytes.
        content_type: Detected MIME type.
        draft_image_id: ID of the DraftImage record (only present when draft_id was given).
    """
    _ALLOWED = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/avif"}
    _MAX = 10 * 1024 * 1024

    parsed = urlparse(url)
    base = urlparse(_BASE_URL)
    local_path: Path | None = None
    if parsed.path.startswith("/api/uploads/") and (
        not parsed.netloc or parsed.netloc.lower() == base.netloc.lower()
    ):
        filename = unquote(parsed.path.removeprefix("/api/uploads/"))
        candidate = (_UPLOADS_DIR / filename).resolve()
        try:
            candidate.relative_to(_UPLOADS_DIR.resolve())
        except ValueError:
            candidate = None
        if candidate is not None and candidate.is_file():
            local_path = candidate

    if local_path is not None:
        data = local_path.read_bytes()
        ct = mimetypes.guess_type(local_path.name)[0] or "image/jpeg"
    else:
        import httpx

        async with httpx.AsyncClient(follow_redirects=True, timeout=20) as client:
            try:
                response = await client.get(url, headers={"User-Agent": "Ediora/1.0"})
            except Exception as exc:
                raise ValueError(f"Failed to fetch image: {exc}")

        if response.status_code != 200:
            raise ValueError(f"Remote server returned HTTP {response.status_code}")
        ct = response.headers.get("content-type", "").split(";")[0].strip() or "image/jpeg"
        data = response.content

    if ct not in _ALLOWED:
        raise ValueError(f"Unsupported content type: {ct} — allowed: {', '.join(_ALLOWED)}")

    if len(data) > _MAX:
        raise ValueError(f"Image too large ({len(data)} bytes, max 10 MB)")
    if len(data) < 64:
        raise ValueError("Response too small to be a valid image")

    ext = mimetypes.guess_extension(ct) or ".jpg"
    if ext in (".jpe", ".jpeg"):
        ext = ".jpg"
    # Prefer extension from hint if available
    if filename_hint and "." in filename_hint:
        hint_ext = "." + filename_hint.rsplit(".", 1)[-1].lower()
        if hint_ext in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".avif"):
            ext = ".jpg" if hint_ext == ".jpeg" else hint_ext

    name = f"{uuid.uuid4().hex}{ext}"
    dest = _UPLOADS_DIR / name
    dest.write_bytes(data)

    api_url = f"/api/uploads/{name}"
    result: dict = {
        "hosted_url": f"{_BASE_URL}{api_url}",
        "filename": name,
        "size_bytes": len(data),
        "content_type": ct,
    }
    if draft_id is not None:
        original = filename_hint or url.rsplit("/", 1)[-1] or name
        img_id = await _register_draft_image(draft_id, name, original, api_url, len(data), ct)
        result["draft_image_id"] = img_id

    return result


@ediora_tool(
    mcp,
    namespace="creative_assets",
    read_only=False,
    destructive=False,
    idempotent=False,
    open_world=False,
    approval="writes",
    concurrency="serialized",
    retry="unsafe",
)
async def upload_image_from_path(
    path: str,
    filename_hint: str = "",
    draft_id: Optional[int] = None,
) -> dict:
    """
    Read a local image path and create a hosted file on Ediora's server.

    Use this (NOT upload_image_from_base64) when you have a locally generated
    image file — for example after running the codex_imagegen skill. Reading
    from disk avoids base64 encoding, which is error-prone for large files.

    Args:
        path: Absolute path to the image file on the local filesystem.
        filename_hint: Optional filename to record as the original name
                       (e.g. "cover.png"). Defaults to the basename of path.
        draft_id: Optional draft ID. When provided, the image is registered in
                  that draft's image library and will appear in the editor's
                  image panel.

    Each successful call can create a new file, so do not retry blindly.

    Returns:
        hosted_url: Absolute URL to serve the image from Ediora.
        filename: The stored filename.
        size_bytes: Size of the stored file in bytes.
        content_type: Detected MIME type.
        draft_image_id: ID of the DraftImage record (only present when draft_id was given).
    """
    import shutil as _shutil

    _ALLOWED = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml", "image/avif"}
    _MAX = 10 * 1024 * 1024

    src = Path(path)
    if not src.exists():
        raise ValueError(f"File not found: {path}")
    if not src.is_file():
        raise ValueError(f"Not a regular file: {path}")

    size = src.stat().st_size
    if size > _MAX:
        raise ValueError(f"Image too large ({size} bytes, max 10 MB)")
    if size < 64:
        raise ValueError(f"File too small to be a valid image ({size} bytes): {path}")

    ct, _ = mimetypes.guess_type(str(src))
    if not ct:
        ct = "image/png"
    ct = ct.split(";")[0].strip()
    if ct not in _ALLOWED:
        raise ValueError(f"Unsupported file type: {ct} — allowed: {', '.join(_ALLOWED)}")

    ext = src.suffix.lower() or mimetypes.guess_extension(ct) or ".png"
    if ext in (".jpe", ".jpeg"):
        ext = ".jpg"

    name = f"{uuid.uuid4().hex}{ext}"
    dest = _UPLOADS_DIR / name
    _shutil.copy2(src, dest)

    api_url = f"/api/uploads/{name}"
    original = filename_hint or src.name
    result: dict = {
        "hosted_url": f"{_BASE_URL}{api_url}",
        "filename": name,
        "size_bytes": size,
        "content_type": ct,
    }
    if draft_id is not None:
        img_id = await _register_draft_image(draft_id, name, original, api_url, size, ct)
        result["draft_image_id"] = img_id

    return result


@ediora_tool(
    mcp,
    namespace="creative_assets",
    read_only=False,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="writes",
    concurrency="serialized",
    retry="claim-backed",
)
async def attach_creative_asset_to_draft(
    draft_id: int,
    asset_id: int,
) -> dict:
    """Attach an already stored local image asset to a draft without copying it.

    Use only after both the draft ID and asset ID are known. Repeating the same
    pair returns the existing DraftImage, so no duplicate is created. This does
    not download, generate, or copy an image. Returns persistent attachment and
    file evidence.
    """
    from models import ArticleDraft, CreativeAsset, DraftImage

    async with SessionLocal() as db:
        draft = await db.get(ArticleDraft, draft_id)
        if draft is None:
            raise ValueError(f"Draft {draft_id} not found")
        asset = await db.get(CreativeAsset, asset_id)
        if asset is None:
            raise ValueError(f"Creative asset {asset_id} not found")
        if asset.asset_type != "media" or asset.media_kind != "image":
            raise ValueError(f"Creative asset {asset_id} is not an image asset")

        parsed = urlparse(asset.url or "")
        if not parsed.path.startswith("/api/uploads/"):
            raise ValueError(f"Creative asset {asset_id} is not a local uploaded image")
        filename = unquote(parsed.path.removeprefix("/api/uploads/"))
        candidate = (_UPLOADS_DIR / filename).resolve()
        try:
            candidate.relative_to(Path(_UPLOADS_DIR).resolve())
        except ValueError:
            raise ValueError("Creative asset image path is invalid") from None
        if not candidate.is_file():
            raise ValueError(f"Creative asset image file is missing: {filename}")

        existing = await db.scalar(
            select(DraftImage).where(
                DraftImage.draft_id == draft_id,
                DraftImage.url == asset.url,
            )
        )
        if existing is not None:
            return {
                "draft_image_id": existing.id,
                "draft_id": draft_id,
                "asset_id": asset_id,
                "url": existing.url,
                "filename": existing.filename,
                "size_bytes": existing.size_bytes,
                "mime_type": existing.mime_type,
            }

        image = DraftImage(
            draft_id=draft_id,
            filename=filename,
            original_name=asset.filename or filename,
            url=asset.url,
            size_bytes=candidate.stat().st_size,
            mime_type=asset.media_type or mimetypes.guess_type(filename)[0] or "image/jpeg",
        )
        db.add(image)
        await db.commit()
        await db.refresh(image)

        return {
            "draft_image_id": image.id,
            "draft_id": draft_id,
            "asset_id": asset_id,
            "url": image.url,
            "filename": image.filename,
            "size_bytes": image.size_bytes,
            "mime_type": image.mime_type,
        }


@ediora_tool(
    mcp,
    namespace="drafts",
    read_only=False,
    destructive=False,
    idempotent=False,
    open_world=False,
    approval="writes",
    concurrency="serialized",
    retry="claim-backed",
)
async def save_draft(
    ctx: Context,
    title: str,
    content: str,
    topic_id: str = "agent",
    status: str = "drafting",
    pipeline_task_id: Optional[int] = None,
    draft_type: Literal["article", "script", "x", "x_article", "mp"] = "article",
    novelty_override_token: str | None = None,
    asset_ids: AdoptedAssetIds | None = None,
) -> dict:
    """
    Create a new Agent draft after a global, time-bounded topic novelty check
    when AGENT_TOPIC_NOVELTY_ENABLED is enabled. The check is disabled by
    default while its failure modes are being repaired; in that mode the
    draft is saved and the novelty evidence is marked as disabled.

    Use only for Agent-created drafts. Manual and backend draft routes do not
    use this policy. A changed title or structure does not make the same topic
    and core claim novel. When novelty checking is enabled, a conflict returns
    saved=false and no draft ID.

    Pass asset_ids for the creative assets this draft actually adopted. A
    successful save stamps their last adopted time. A missing id rolls the
    draft back. Assets are not stamped when saved is false.

    Args:
        title: Article title.
        content: Full article body in Markdown.
        topic_id: Source identifier. Use "agent" for AI-agent-generated articles,
                  or a tweet_id / topic UUID when derived from a specific source.
        status: Initial status — "drafting" (default) or "review".
        pipeline_task_id: Optional pipeline_task_id from the task body (links this
                          draft to its pipeline run record for timeline tracking).
        draft_type: "article"（默认）、"script"、"x"、"x_article" 或 "mp"。
        novelty_override_token: One-time token returned after a Chat conflict;
                                scheduled/background Agents must not use it.
        asset_ids: Creative asset ids this draft adopted. Omit when none.

    Returns saved, novelty evidence, and only on success id/title/status/type/created_at.
    """
    from agent_topic_novelty import (
        AgentIdentity,
        extract_candidate_with_model,
        judge_novelty_with_model,
        save_agent_draft_with_novelty_check,
    )
    from models import DailyCreationRun

    request = getattr(ctx.request_context, "request", None)
    headers = getattr(request, "headers", {})
    mode = str(headers.get("x-agent-mode") or "").strip().lower()
    session_id: int | None = None
    daily_run_id: int | None = None
    window_days = 14
    if mode == "chat":
        try:
            session_id = int(headers.get("x-agent-session-id"))
        except (TypeError, ValueError) as error:
            raise ValueError("Chat Agent session identity is missing") from error
        if session_id <= 0:
            raise ValueError("Chat Agent session identity is invalid")
    elif mode == "scheduled":
        try:
            daily_run_id = int(headers.get("x-daily-creation-run-id"))
        except (TypeError, ValueError) as error:
            raise ValueError("scheduled Agent run identity is missing") from error
        if daily_run_id <= 0:
            raise ValueError("scheduled Agent run identity is invalid")
    elif mode != "job":
        raise ValueError("trusted Agent execution identity is missing")

    async with SessionLocal() as db:
        if daily_run_id is not None:
            creation_run = await db.get(DailyCreationRun, daily_run_id)
            if creation_run is None:
                raise ValueError(f"Daily creation run {daily_run_id} not found")
            window_days = int(
                (creation_run.rule_snapshot or {}).get("lookback_days") or 14
            )
            # End the snapshot read transaction so the dedicated save service
            # owns the complete check + draft + claim commit boundary.
            await db.commit()
        return await save_agent_draft_with_novelty_check(
            db,
            title=title,
            content=content,
            topic_id=topic_id,
            status=status,
            pipeline_task_id=pipeline_task_id,
            draft_type=draft_type,
            identity=AgentIdentity(
                mode=mode,
                session_id=session_id,
                daily_creation_run_id=daily_run_id,
            ),
            window_days=window_days,
            override_token=novelty_override_token,
            extract_candidate=extract_candidate_with_model,
            judge=judge_novelty_with_model,
            asset_ids=asset_ids,
        )


# ── publish account profile ───────────────────────────────────────────────────

@ediora_tool(
    mcp,
    namespace="accounts",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def list_publish_accounts() -> list[dict]:
    """
    Return compact publish-account metadata for account discovery.

    Use this to discover which account_id values are available. To inspect a
    specific account's full positioning profile, call get_account_profile(pub_id).
    """
    from models import PublishAccount

    async with SessionLocal() as db:
        rows = (await db.execute(
            select(PublishAccount).order_by(
                PublishAccount.is_active.desc(), PublishAccount.name
            )
        )).scalars().all()

        return [
            {
                "id": acc.id,
                "name": acc.name,
                "platform": acc.platform,
                "positioning": acc.positioning,
                "is_active": acc.is_active,
            }
            for acc in rows
        ]


@ediora_tool(
    mcp,
    namespace="accounts",
    read_only=True,
    destructive=False,
    idempotent=True,
    open_world=False,
    approval="never",
    concurrency="parallel-safe",
    retry="safe",
)
async def get_account_profile(pub_id: str) -> dict:
    """
    Return the full positioning profile of a known publish-account ID.

    Every agent in the scout → editor → writer → illustrator pipeline MUST
    call this as its first step, using the `account_id` carried in the kanban
    task body/metadata. All downstream output (angle, brief, draft, cover)
    must align with the returned profile — tone, audience, topic_focus,
    taboo, word_range, image_style.

    Returns an empty dict with `error: "..."` if pub_id is unknown.
    """
    from models import PublishAccount

    async with SessionLocal() as db:
        acc = await db.get(PublishAccount, pub_id)
        if acc is None:
            return {"error": f"publish account '{pub_id}' not found"}

        return {
            "id": acc.id,
            "name": acc.name,
            "platform": acc.platform,
            "positioning": acc.positioning,
            "audience": acc.audience,
            "tone": acc.tone,
            "topic_focus": acc.topic_focus or [],
            "taboo": acc.taboo or [],
            "word_range": acc.word_range or {},
            "image_style": acc.image_style,
            "cover_style": acc.cover_style or {},
            "voice_samples": acc.voice_samples or [],
            "style_rules": acc.style_rules or [],
            "is_active": acc.is_active,
        }

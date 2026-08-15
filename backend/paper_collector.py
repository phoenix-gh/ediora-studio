import re
import httpx
import feedparser
import calendar
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from collection_proxy import collection_client_kwargs
from models import Paper

# arXiv API supports any day (RSS only updates Mon-Fri)
_ARXIV_API = "https://export.arxiv.org/api/query"
_DEFAULT_CATEGORIES = ["cs.AI", "cs.CL", "cs.CV", "cs.LG"]
_MAX_PER_CATEGORY = 50


def _parse_arxiv_id(url: str) -> str:
    m = re.search(r"arxiv\.org/abs/([^\s?#v]+)", url)
    return m.group(1) if m else ""


def _parse_authors(entry) -> list[str]:
    if hasattr(entry, "authors") and entry.authors:
        return [a.get("name", "").strip() for a in entry.authors if a.get("name", "").strip()]
    if hasattr(entry, "author") and entry.author:
        return [p.strip() for p in entry.author.split(",") if p.strip()]
    return []


def _parse_date(entry) -> datetime:
    for attr in ("published_parsed", "updated_parsed"):
        t = getattr(entry, attr, None)
        if t:
            return datetime.fromtimestamp(calendar.timegm(t), tz=timezone.utc)
    return datetime.now(timezone.utc)


def _strip_html(text: str) -> str:
    return re.sub(r"<[^>]+>", "", text or "").strip()


def _normalize_whitespace(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


async def collect_papers(db: AsyncSession, categories: list[str] | None = None) -> dict:
    if categories is None:
        try:
            from config import get_config
            cfg = await get_config()
            raw = cfg.get("arxiv_categories", "")
            categories = [c.strip() for c in raw.split(",") if c.strip()] or _DEFAULT_CATEGORIES
        except Exception:
            categories = _DEFAULT_CATEGORIES

    new_count = 0
    errors: list[str] = []

    for category in categories:
        try:
            params = {
                "search_query": f"cat:{category}",
                "start": 0,
                "max_results": _MAX_PER_CATEGORY,
                "sortBy": "submittedDate",
                "sortOrder": "descending",
            }
            async with httpx.AsyncClient(**await collection_client_kwargs(
                timeout=30,
                follow_redirects=True,
            )) as client:
                resp = await client.get(_ARXIV_API, params=params,
                                        headers={"User-Agent": "Ediora/1.0"})
                resp.raise_for_status()
                content = resp.text

            feed = feedparser.parse(content)
            for entry in feed.entries:
                # arXiv API link is like https://arxiv.org/abs/2501.12345v1
                link = getattr(entry, "id", "") or getattr(entry, "link", "") or ""
                arxiv_id = _parse_arxiv_id(link)
                if not arxiv_id:
                    continue

                existing = await db.get(Paper, arxiv_id)
                if existing:
                    continue

                title = _normalize_whitespace(_strip_html(getattr(entry, "title", "") or ""))
                abstract = _normalize_whitespace(_strip_html(getattr(entry, "summary", "") or ""))
                authors = _parse_authors(entry)

                # categories from tags (arXiv API uses term like "cs.AI")
                entry_categories: list[str] = []
                if hasattr(entry, "tags") and entry.tags:
                    entry_categories = [t.get("term", "") for t in entry.tags if t.get("term")]
                if not entry_categories:
                    entry_categories = [category]

                submitted_at = _parse_date(entry)
                # Clean link: strip version suffix
                clean_link = re.sub(r"v\d+$", "", link.replace("/abs/", "/abs/"))
                pdf_url = clean_link.replace("/abs/", "/pdf/") if "/abs/" in clean_link else ""

                paper = Paper(
                    arxiv_id=arxiv_id,
                    title=title,
                    abstract=abstract,
                    authors=authors,
                    categories=entry_categories,
                    primary_category=category,
                    arxiv_url=clean_link,
                    pdf_url=pdf_url,
                    submitted_at=submitted_at,
                    collected_at=datetime.now(timezone.utc),
                )
                db.add(paper)
                new_count += 1

            await db.commit()
        except Exception as e:
            errors.append(f"{category}: {e}")
            try:
                await db.rollback()
            except Exception:
                pass

    translated = 0

    # Translate untranslated papers
    if new_count > 0:
        translated = await _translate_untagged(db)

    return {"new_papers": new_count, "translated": translated, "errors": errors}


async def _translate_untagged(db: AsyncSession, batch_size: int = 5) -> int:
    """Translate untranslated papers (empty title_cn) using LLM, in batches."""
    from sqlalchemy import select, or_

    total = 0
    consecutive_failures = 0
    while True:
        rows = (
            await db.execute(
                select(Paper)
                .where(or_(Paper.title_cn == "", Paper.title_cn.is_(None)))
                .order_by(Paper.collected_at.desc())
                .limit(batch_size)
            )
        ).scalars().all()

        if not rows:
            break

        papers_in = [
            {"arxiv_id": p.arxiv_id, "title": p.title, "abstract": p.abstract}
            for p in rows
        ]

        import llm
        translated = await llm.translate_papers(papers_in)
        if not translated:
            consecutive_failures += 1
            if consecutive_failures >= 3:
                break
            import asyncio
            await asyncio.sleep(3)
            continue
        consecutive_failures = 0

        by_id = {t["arxiv_id"]: t for t in translated if t.get("arxiv_id")}
        count = 0
        for p in rows:
            t = by_id.get(p.arxiv_id)
            if t and t.get("title_cn"):
                p.title_cn = t["title_cn"]
                p.abstract_cn = t.get("abstract_cn", "")
                count += 1

        try:
            await db.commit()
        except Exception:
            import asyncio
            await asyncio.sleep(2)
            try:
                await db.commit()
            except Exception:
                pass  # skip this batch on persistent failure
        total += count

    return total


async def translate_all_papers(db: AsyncSession) -> dict:
    """Translate all untranslated papers. Called from API."""
    count = await _translate_untagged(db)
    return {"translated": count}

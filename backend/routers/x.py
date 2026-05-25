from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, func, desc, delete
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import XSubscription, XPost

router = APIRouter(prefix="/x", tags=["x"])


# ─── Schemas ─────────────────────────────────────────────────────────────────

class SubscriptionOut(BaseModel):
    id: int
    url: str
    label: str
    enabled: bool
    last_collected_at: Optional[datetime]
    last_error: str
    added_at: datetime
    post_count: int = 0
    model_config = {"from_attributes": True}


class SubscriptionCreate(BaseModel):
    url: str
    label: Optional[str] = None


class SubscriptionPatch(BaseModel):
    enabled: Optional[bool] = None
    label: Optional[str] = None


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _default_label(url: str) -> str:
    url = url.strip().rstrip("/")
    if "/i/lists/" in url:
        return "list-" + url.rsplit("/", 1)[-1]
    return "@" + url.rsplit("/", 1)[-1]


async def _to_out(db: AsyncSession, sub: XSubscription) -> SubscriptionOut:
    cnt = (await db.execute(
        select(func.count(XPost.tweet_id))
        .where(XPost.subscription_id == sub.id)
    )).scalar() or 0
    return SubscriptionOut(
        id=sub.id, url=sub.url, label=sub.label, enabled=sub.enabled,
        last_collected_at=sub.last_collected_at, last_error=sub.last_error,
        added_at=sub.added_at, post_count=int(cnt),
    )


# ─── Endpoints ──────────────────────────────────────────────────────────────

@router.get("/subscriptions", response_model=list[SubscriptionOut])
async def list_subscriptions(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(XSubscription).order_by(desc(XSubscription.added_at))
    )).scalars().all()
    return [await _to_out(db, r) for r in rows]


@router.post("/subscriptions", response_model=SubscriptionOut)
async def create_subscription(
    body: SubscriptionCreate, db: AsyncSession = Depends(get_db),
):
    url = body.url.strip()
    if not url.startswith(("http://", "https://")):
        raise HTTPException(400, "URL 必须以 http(s):// 开头")
    existing = (await db.execute(
        select(XSubscription).where(XSubscription.url == url)
    )).scalars().first()
    if existing:
        raise HTTPException(400, "该 URL 已订阅")
    sub = XSubscription(
        url=url, label=(body.label or _default_label(url)),
        enabled=True, added_at=datetime.now(timezone.utc),
    )
    db.add(sub)
    await db.commit()
    await db.refresh(sub)
    return await _to_out(db, sub)


@router.patch("/subscriptions/{sub_id}", response_model=SubscriptionOut)
async def patch_subscription(
    sub_id: int, body: SubscriptionPatch,
    db: AsyncSession = Depends(get_db),
):
    sub = await db.get(XSubscription, sub_id)
    if not sub:
        raise HTTPException(404, "订阅不存在")
    if body.enabled is not None:
        sub.enabled = body.enabled
    if body.label is not None:
        sub.label = body.label
    await db.commit()
    await db.refresh(sub)
    return await _to_out(db, sub)


@router.delete("/subscriptions/{sub_id}")
async def delete_subscription(
    sub_id: int, db: AsyncSession = Depends(get_db),
):
    sub = await db.get(XSubscription, sub_id)
    if not sub:
        raise HTTPException(404, "订阅不存在")
    await db.execute(delete(XPost).where(XPost.subscription_id == sub_id))
    await db.delete(sub)
    await db.commit()
    return {"ok": True}

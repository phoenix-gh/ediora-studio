from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import Publication, PublishAccount
from schemas import PublicationCreate, PublicationUpdate, PublicationOut

router = APIRouter(prefix="/published-articles", tags=["published"])

_STAT_FIELDS = {"read_count", "like_count", "look_count", "share_count"}


def _out(pub: Publication, account_name: str = "") -> PublicationOut:
    out = PublicationOut.model_validate(pub)
    out.account_name = account_name or ""
    return out


@router.get("", response_model=list[PublicationOut])
async def list_publications(
    status: str | None = None,
    account_id: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    q = select(Publication, PublishAccount.name).join(
        PublishAccount, Publication.account_id == PublishAccount.id, isouter=True
    )
    if status:
        q = q.where(Publication.status == status)
    if account_id:
        q = q.where(Publication.account_id == account_id)
    q = q.order_by(desc(Publication.read_count), desc(Publication.created_at))
    rows = (await db.execute(q)).all()
    return [_out(pub, name) for pub, name in rows]


@router.post("", response_model=PublicationOut, status_code=201)
async def create_publication(body: PublicationCreate, db: AsyncSession = Depends(get_db)):
    pub = Publication(**body.model_dump())
    db.add(pub)
    await db.commit()
    await db.refresh(pub)
    acc = await db.get(PublishAccount, pub.account_id)
    return _out(pub, acc.name if acc else "")


@router.patch("/{pub_id}", response_model=PublicationOut)
async def update_publication(pub_id: int, body: PublicationUpdate, db: AsyncSession = Depends(get_db)):
    pub = await db.get(Publication, pub_id)
    if not pub:
        raise HTTPException(404, "发布记录不存在")
    data = body.model_dump(exclude_unset=True)
    for k in _STAT_FIELDS & set(data):
        if data[k] is not None and data[k] < 0:
            raise HTTPException(400, f"{k} 不能为负")
    if _STAT_FIELDS & {k for k, v in data.items() if v is not None}:
        pub.stats_as_of = datetime.now(timezone.utc)
    for k, v in data.items():
        setattr(pub, k, v)
    if data.get("status") == "published" and pub.published_at is None:
        pub.published_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(pub)
    acc = await db.get(PublishAccount, pub.account_id)
    return _out(pub, acc.name if acc else "")


@router.delete("/{pub_id}", status_code=204)
async def delete_publication(pub_id: int, db: AsyncSession = Depends(get_db)):
    pub = await db.get(Publication, pub_id)
    if not pub:
        raise HTTPException(404, "发布记录不存在")
    await db.delete(pub)
    await db.commit()

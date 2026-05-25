from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database import get_db
from models import PublishAccount
from schemas import PublishAccountCreate, PublishAccountOut, PublishAccountUpdate

router = APIRouter(prefix="/publish-accounts", tags=["publish-accounts"])


@router.get("", response_model=list[PublishAccountOut])
async def list_publish_accounts(db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(
            select(PublishAccount).order_by(PublishAccount.is_active.desc(), PublishAccount.name)
        )
    ).scalars().all()
    return rows


@router.get("/{pub_id}", response_model=PublishAccountOut)
async def get_publish_account(pub_id: str, db: AsyncSession = Depends(get_db)):
    acc = await db.get(PublishAccount, pub_id)
    if not acc:
        raise HTTPException(404, "not found")
    return acc


@router.post("", response_model=PublishAccountOut, status_code=201)
async def create_publish_account(body: PublishAccountCreate, db: AsyncSession = Depends(get_db)):
    if await db.get(PublishAccount, body.id):
        raise HTTPException(400, "publish account already exists")
    acc = PublishAccount(**body.model_dump())
    db.add(acc)
    await db.commit()
    await db.refresh(acc)
    return acc


@router.patch("/{pub_id}", response_model=PublishAccountOut)
async def update_publish_account(
    pub_id: str, body: PublishAccountUpdate, db: AsyncSession = Depends(get_db)
):
    acc = await db.get(PublishAccount, pub_id)
    if not acc:
        raise HTTPException(404, "not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(acc, k, v)
    await db.commit()
    await db.refresh(acc)
    return acc


@router.delete("/{pub_id}", status_code=204)
async def delete_publish_account(pub_id: str, db: AsyncSession = Depends(get_db)):
    acc = await db.get(PublishAccount, pub_id)
    if not acc:
        raise HTTPException(404, "not found")
    await db.delete(acc)
    await db.commit()

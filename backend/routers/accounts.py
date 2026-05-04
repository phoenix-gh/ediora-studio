from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from database import get_db
from models import Account
from schemas import AccountCreate, AccountOut, AccountUpdate

router = APIRouter(prefix="/accounts", tags=["accounts"])

@router.get("", response_model=list[AccountOut])
async def list_accounts(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(Account).order_by(Account.priority.desc(), Account.name))).scalars().all()
    return rows

@router.post("", response_model=AccountOut, status_code=201)
async def create_account(body: AccountCreate, db: AsyncSession = Depends(get_db)):
    existing = await db.get(Account, body.id)
    if existing:
        raise HTTPException(400, "account already exists")
    acc = Account(**body.model_dump())
    db.add(acc)
    await db.commit()
    await db.refresh(acc)
    return acc

@router.patch("/{account_id}", response_model=AccountOut)
async def update_account(account_id: str, body: AccountUpdate, db: AsyncSession = Depends(get_db)):
    acc = await db.get(Account, account_id)
    if not acc:
        raise HTTPException(404, "not found")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(acc, k, v)
    await db.commit()
    await db.refresh(acc)
    return acc

@router.delete("/{account_id}", status_code=204)
async def delete_account(account_id: str, db: AsyncSession = Depends(get_db)):
    acc = await db.get(Account, account_id)
    if not acc:
        raise HTTPException(404, "not found")
    await db.delete(acc)
    await db.commit()

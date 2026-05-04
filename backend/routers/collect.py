from fastapi import APIRouter, Depends, BackgroundTasks, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from database import get_db
from models import Account
from collector import collect_account, collect_all
from schemas import CollectResult

router = APIRouter(prefix="/collect", tags=["collect"])

@router.post("/all", response_model=list[CollectResult])
async def trigger_collect_all(db: AsyncSession = Depends(get_db)):
    results = await collect_all(db)
    return results

@router.post("/account/{account_id}", response_model=CollectResult)
async def trigger_collect_one(account_id: str, db: AsyncSession = Depends(get_db)):
    acc = await db.get(Account, account_id)
    if not acc:
        raise HTTPException(404, "account not found")
    try:
        n = await collect_account(acc, db)
        return CollectResult(account_id=account_id, new_posts=n)
    except Exception as e:
        return CollectResult(account_id=account_id, new_posts=0, error=str(e))

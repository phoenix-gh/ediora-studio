"""Structured collect-job logger — writes to collect_logs table."""
from datetime import datetime, timezone
from database import SessionLocal
from models import CollectLog

_MAX_LOGS = 500


async def log(job: str, status: str, message: str, detail: str = "") -> None:
    """Write one log entry and prune old entries beyond _MAX_LOGS."""
    print(f"[{job}] {status}: {message}" + (f" | {detail}" if detail else ""))
    try:
        async with SessionLocal() as db:
            db.add(CollectLog(job=job, status=status, message=message, detail=detail))
            await db.commit()

            # Prune: keep only the latest _MAX_LOGS rows
            from sqlalchemy import select, delete, func
            count = (await db.execute(select(func.count()).select_from(CollectLog))).scalar_one()
            if count > _MAX_LOGS:
                cutoff_id = (
                    await db.execute(
                        select(CollectLog.id)
                        .order_by(CollectLog.id.desc())
                        .offset(_MAX_LOGS - 1)
                        .limit(1)
                    )
                ).scalar_one_or_none()
                if cutoff_id is not None:
                    await db.execute(delete(CollectLog).where(CollectLog.id < cutoff_id))
                    await db.commit()
    except Exception as e:
        print(f"[logger] failed to write log: {e}")

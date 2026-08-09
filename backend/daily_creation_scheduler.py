"""Scheduled dispatch for reusable creation rules."""

from datetime import datetime, time as datetime_time, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import select

from database import SessionLocal


async def dispatch_due_creation_rules(*, now: datetime | None = None, enqueue=None) -> dict:
    """Create and enqueue every due one-time or daily creation rule once."""
    from daily_creation_service import create_daily_creation_run
    from models import DailyCreationRule, DailyCreationRun

    if enqueue is None:
        from job_queue import enqueue_job
        enqueue = enqueue_job
    reference = now or datetime.now(timezone.utc)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    created_ids: list[int] = []
    job_ids: list[int] = []
    async with SessionLocal() as db:
        rules = (await db.execute(
            select(DailyCreationRule).where(
                DailyCreationRule.enabled.is_(True),
                DailyCreationRule.deleted_at.is_(None),
            ).order_by(DailyCreationRule.id)
        )).scalars().all()
        for rule in rules:
            zone = ZoneInfo(rule.timezone)
            local_now = reference.astimezone(zone)
            hour, minute = (int(part) for part in rule.scheduled_time.split(":")[:2])
            if rule.execution_mode == "once":
                if not rule.scheduled_date:
                    continue
                local_date = datetime.strptime(rule.scheduled_date, "%Y-%m-%d").date()
            else:
                local_date = local_now.date()
            scheduled_local = datetime.combine(
                local_date,
                datetime_time(hour=hour, minute=minute),
                tzinfo=zone,
            )
            if rule.execution_mode != "once" and scheduled_local > local_now:
                scheduled_local = datetime.combine(
                    local_date - timedelta(days=1),
                    datetime_time(hour=hour, minute=minute),
                    tzinfo=zone,
                )
            if scheduled_local > local_now:
                continue
            scheduled_for = scheduled_local.astimezone(timezone.utc)
            existing = await db.scalar(select(DailyCreationRun.id).where(
                DailyCreationRun.rule_id == rule.id,
                DailyCreationRun.scheduled_for == scheduled_for,
                DailyCreationRun.trigger_kind == "scheduled",
            ))
            if existing is not None:
                continue
            creation_run, _ = await create_daily_creation_run(
                db, rule=rule, scheduled_for=scheduled_for,
                trigger_kind="scheduled",
            )
            if rule.execution_mode == "once":
                rule.enabled = False
            await db.commit()
            await db.refresh(creation_run)
            created_ids.append(creation_run.id)
            job_ids.append(creation_run.content_job_id)
    for job_id in job_ids:
        await enqueue(job_id)
    return {"created": len(created_ids), "run_ids": created_ids, "job_ids": job_ids}

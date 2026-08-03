"""Daily-plan job creation without an external agent runtime."""
from __future__ import annotations

import json
from datetime import datetime, time as datetime_time, timedelta, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import delete as sa_delete, select

from database import SessionLocal
from models import ArticleDraft, DailyPlan, DailyPlanItem, PublishAccount


def today_str() -> str:
    """本地日期（cron 按本地 8 点跑，计划也按本地日界）。"""
    return datetime.now().strftime("%Y-%m-%d")


def _build_accounts_md(accounts: list[PublishAccount]) -> str:
    blocks = []
    for acc in accounts:
        blocks.append(
            f"### {acc.name}（account_id: {acc.id} / {acc.platform}）\n"
            f"- 定位：{acc.positioning or '（未填）'}\n"
            f"- 受众：{acc.audience or '（未填）'}\n"
            f"- 调性：{acc.tone or '（未填）'}\n"
            f"- 选题重点：{'、'.join(acc.topic_focus) if acc.topic_focus else '不限'}\n"
            f"- 禁区：{'、'.join(acc.taboo) if acc.taboo else '无'}\n"
            f"- 今日配额 daily_quota：{json.dumps(acc.daily_quota or {}, ensure_ascii=False)}"
        )
    return "## 账号与配额\n\n" + "\n\n".join(blocks)


async def _recent_titles_md(db, days: int = 7) -> str:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    item_titles = (await db.execute(
        select(DailyPlanItem.title).where(DailyPlanItem.created_at >= cutoff)
    )).scalars().all()
    draft_titles = (await db.execute(
        select(ArticleDraft.title).where(ArticleDraft.created_at >= cutoff)
    )).scalars().all()
    titles = [t for t in dict.fromkeys([*item_titles, *draft_titles]) if t and t.strip()]
    if not titles:
        return "（近 7 天无产出）"
    return "\n".join(f"- {t}" for t in titles[:100])


async def create_today_plan(*, force: bool = False) -> DailyPlan | None:
    """生成今天的 DailyPlan + 总编策划任务。

    - 当天已有计划且非 force：直接返回现有计划（幂等，cron 重跑安全）
    - force：删除当天计划（连带 items）重建
    - 无 active 账号或配额全空：记日志返回 None
    - creates a durable content job for the planner instead of a Kanban task
    """
    from logger import log
    from content_jobs import create_job
    from job_queue import enqueue_job

    date_str = today_str()

    async with SessionLocal() as db:
        existing = (await db.execute(
            select(DailyPlan).where(DailyPlan.plan_date == date_str)
        )).scalar_one_or_none()
        if existing is not None:
            if not force:
                return existing
            await db.execute(sa_delete(DailyPlanItem).where(
                DailyPlanItem.plan_id == existing.id,
                DailyPlanItem.origin == "planner",
            ))
            await db.delete(existing)
            await db.commit()

        accounts = [
            a for a in (await db.execute(
                select(PublishAccount)
                .where(PublishAccount.is_active == True)  # noqa: E712
                .order_by(PublishAccount.name)
            )).scalars().all()
            if a.daily_quota
        ]
        if not accounts:
            await log("daily_plan", "skip", "无 active 账号或所有 daily_quota 为空，跳过今日计划")
            return None

        recent_md = await _recent_titles_md(db)

        plan = DailyPlan(plan_date=date_str, status="planning")
        db.add(plan)
        await db.commit()
        await db.refresh(plan)
        plan_id = plan.id

    ctx = {
        "date_str": date_str,
        "plan_id": plan_id,
        "accounts_md": _build_accounts_md(accounts),
        "recent_titles_md": recent_md,
    }
    try:
        async with SessionLocal() as db:
            job = await create_job(db, flow="daily_plan", title=f"今日计划 {date_str}", input_data=ctx)
        await enqueue_job(job.id)
    except Exception as e:
        async with SessionLocal() as db:
            p = await db.get(DailyPlan, plan_id)
            if p is not None:
                p.status = "failed"
                await db.commit()
        await log("daily_plan", "error", "今日计划策划任务创建失败", str(e)[:500])
        raise

    async with SessionLocal() as db:
        p = await db.get(DailyPlan, plan_id)
        if p is not None:
            p.kanban_task_id = str(job.id)
            await db.commit()
    await log("daily_plan", "ok", f"今日计划任务已创建（{date_str}）")
    async with SessionLocal() as db:
        return await db.get(DailyPlan, plan_id)


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

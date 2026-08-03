# Daily Creation Startup Catch-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the immediate daily-creation scheduler pass create the latest missed occurrence for each enabled rule after an API restart, without replaying every missed day.

**Architecture:** Keep `dispatch_due_creation_rules` as the single startup and steady-state dispatch path. Change recurring occurrence selection from “today or nothing” to “the latest local scheduled date not later than now,” while retaining the existing UTC persistence key and scheduled-run uniqueness constraint.

**Tech Stack:** Python 3, FastAPI lifespan, APScheduler, SQLAlchemy async ORM, `zoneinfo.ZoneInfo`, pytest

## Global Constraints

- Each dispatch pass considers at most one scheduled occurrence per rule: the latest occurrence that is not later than the current time.
- Recurring rules use today's occurrence after today's local scheduled time and yesterday's occurrence before today's local scheduled time.
- One-time rules remain due from their configured local date and time onward.
- Existing `(rule_id, scheduled_for, trigger_kind)` uniqueness remains the idempotency boundary.
- Manual runs do not suppress scheduled runs.
- `WMS_DISABLE_SCHEDULER=1` continues to disable both automatic dispatch and catch-up.
- Do not add a last-shutdown timestamp, a separate startup dispatcher, distributed scheduler locking, or multi-day replay.
- Preserve unrelated changes in the existing dirty worktree and stage only files named by each task.

---

### Task 1: Select and dispatch the latest due occurrence

**Files:**
- Modify: `backend/daily_planner.py:120-180`
- Test: `backend/tests/test_daily_creation_scheduler.py`

**Interfaces:**
- Consumes: `dispatch_due_creation_rules(*, now: datetime | None = None, enqueue=None) -> dict`, `DailyCreationRule.execution_mode`, `scheduled_date`, `scheduled_time`, and `timezone`.
- Produces: unchanged dispatcher result shape `{"created": int, "run_ids": list[int], "job_ids": list[int]}`; recurring rules now persist the latest due `scheduled_for` instant.

- [ ] **Step 1: Write failing catch-up tests**

Add focused tests using the existing `env` fixture and enqueue recorder. The previous-day test must demonstrate the current bug, and the multi-day test must demonstrate that no backlog is replayed:

```python
def test_recurring_rule_catches_up_previous_local_day_before_today_schedule(env):
    from daily_planner import dispatch_due_creation_rules
    from database import SessionLocal
    from models import DailyCreationRule, DailyCreationRun

    async def run():
        async with SessionLocal() as session:
            session.add(DailyCreationRule(
                name="夜间创作", asset_type="article", directory="搞钱副业",
                directories=["搞钱副业"], output_type="x_short_post",
                target_count=10, execution_mode="recurring",
                scheduled_time="22:00", timezone="Asia/Shanghai",
                lookback_days=7, delivery_mode="drafts",
            ))
            await session.commit()

        enqueued = []

        async def enqueue(job_id):
            enqueued.append(job_id)

        result = await dispatch_due_creation_rules(
            now=datetime(2026, 8, 3, 0, 0, tzinfo=timezone.utc),
            enqueue=enqueue,
        )

        assert result["created"] == 1
        assert len(enqueued) == 1
        async with SessionLocal() as session:
            creation_run = await session.scalar(select(DailyCreationRun))
            scheduled_for = creation_run.scheduled_for
            if scheduled_for.tzinfo is None:  # SQLite drops timezone metadata.
                scheduled_for = scheduled_for.replace(tzinfo=timezone.utc)
            assert scheduled_for == datetime(
                2026, 8, 2, 14, 0, tzinfo=timezone.utc,
            )

    asyncio.run(run())
```

Add a second test with a recurring 22:00 Asia/Shanghai rule and `now=datetime(2026, 8, 6, 0, 0, tzinfo=timezone.utc)`. Call the dispatcher twice and assert exactly one run exists, its `scheduled_for` is `2026-08-05 14:00 UTC`, and only one job ID was enqueued. This verifies both “latest occurrence only” and restart idempotency without synthesizing runs for August 2–4.

Extend the existing mixed-mode test, or add a focused test, to assert that:

```python
# At 23:00 Asia/Shanghai, today's 22:00 occurrence is selected.
now = datetime(2026, 8, 3, 15, 0, tzinfo=timezone.utc)
expected = datetime(2026, 8, 3, 14, 0, tzinfo=timezone.utc)
```

Keep the existing overdue one-time, disabled, future, timezone, and immediate scheduler-registration assertions intact.

- [ ] **Step 2: Run the focused tests and verify the bug**

Run:

```bash
cd backend
pytest -q tests/test_daily_creation_scheduler.py
```

Expected: the previous-local-day test fails because the current dispatcher compares only today's future occurrence and creates zero runs. Existing tests continue to pass.

- [ ] **Step 3: Implement latest-due recurring occurrence selection**

In `dispatch_due_creation_rules`, keep one-time handling unchanged. For recurring rules, build today's scheduled local datetime first; if it is later than `local_now`, rebuild it using yesterday's local calendar date:

```python
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
```

Use local calendar subtraction before recombining so `ZoneInfo` determines the correct UTC offset on daylight-saving transitions. Do not introduce a loop over previous dates.

- [ ] **Step 4: Run focused and adjacent scheduler tests**

Run:

```bash
cd backend
pytest -q tests/test_daily_creation_scheduler.py tests/test_daily_creation_rules_router.py tests/test_daily_creation_service.py
```

Expected: all scheduler, router, and execution-service tests pass.

- [ ] **Step 5: Run backend regression tests for the touched scheduling domain**

Run:

```bash
cd backend
pytest -q tests/test_daily_creation_*.py
```

Expected: all daily-creation tests pass with no warnings or errors caused by this change.

- [ ] **Step 6: Commit the implementation**

Stage only the dispatcher and scheduler test files:

```bash
git add backend/daily_planner.py backend/tests/test_daily_creation_scheduler.py
git diff --cached --check
git commit -m "fix: catch up missed daily creation runs"
```

Verify `git status --short` still shows all unrelated pre-existing worktree changes unstaged.

---

## Final Verification

- [ ] Confirm the implementation diff contains only the latest-due date calculation and focused tests.
- [ ] Confirm a recurring rule checked before today's local scheduled time creates yesterday's occurrence.
- [ ] Confirm a recurring rule checked after today's local scheduled time creates today's occurrence.
- [ ] Confirm repeated calls do not create duplicate runs or enqueue duplicate jobs.
- [ ] Confirm an overdue one-time rule still runs once and becomes disabled.
- [ ] Confirm scheduler registration still uses `next_run_time=datetime.now()` and a one-minute interval.
- [ ] Confirm no unrelated dirty-worktree files are staged.

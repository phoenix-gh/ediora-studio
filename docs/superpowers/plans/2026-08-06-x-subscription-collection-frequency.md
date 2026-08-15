# X 订阅独立采集频率 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Give every X subscription an independently persisted automatic collection interval while preserving the existing global setting as the default for new and migrated subscriptions.

**Architecture:** Add `collect_interval_minutes` to `XSubscription`, expose it through the X API, and add a dialog action in the existing subscription management UI. Change the scheduler from one global throttle to a one-minute polling loop that checks each enabled subscription against `last_collected_at`.

**Tech Stack:** FastAPI/Pydantic, SQLAlchemy async migrations, APScheduler, Next.js/React, Vitest, pytest.

## Global Constraints

- Interval values are limited to 5–1440 minutes.
- Existing global `x_collect_interval_minutes` remains the default for new subscriptions and first-time migration only.
- Manual collection ignores the automatic schedule.
- Topic-source and intelligence dispatch remain downstream of new-post collection.
- Preserve unrelated dirty worktree changes.

### Task 1: Persist and expose per-subscription interval

**Files:**
- Modify: `backend/models.py` XSubscription
- Modify: `backend/database.py` migration chain
- Modify: `backend/routers/x.py` subscription schemas and handlers
- Test: `backend/tests/test_models_schema.py`
- Test: `backend/tests/test_x_router.py`
- Test: `backend/tests/test_database_init_sqlite.py`

- [x] **Step 1: Write failing model/API tests**

Assert a new `XSubscription` defaults to 15 minutes, the create response returns the interval, patching to 60 returns 60, and values 4 and 1441 are rejected.

- [x] **Step 2: Run the focused tests and observe the missing-field failures**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_models_schema.py backend/tests/test_x_router.py -k 'interval or subscription' -q
```

- [x] **Step 3: Implement the model, API, and migration**

Add `collect_interval_minutes` with `Integer` default 15. Add Pydantic bounds, include it in `SubscriptionOut`, assign it in create/patch, and add an idempotent migration that reads the current global setting only when the new column is first added.

- [x] **Step 4: Run the focused model/API tests**

Run the command from Step 2 and the SQLite initialization test. Expected: the new interval assertions pass; any existing async fixture timeout must be reported separately.

### Task 2: Make scheduler decisions per subscription

**Files:**
- Modify: `backend/scheduler.py`
- Test: `backend/tests/test_x_subscription_scheduler.py`

- [x] **Step 1: Write failing pure due-check tests**

Test that a subscription with no previous collection is due, one collected 10 minutes ago with a 15-minute interval is not due, and one collected 20 minutes ago is due. Test naive timestamps are treated as UTC.

- [x] **Step 2: Run the focused scheduler test and observe the missing helper failure**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_x_subscription_scheduler.py -q
```

- [x] **Step 3: Implement per-subscription polling**

Add a tested `_is_x_subscription_due` helper, run `scheduled_x_collect` no more often than once per minute, skip enabled subscriptions that are not due, and keep existing per-source error isolation and downstream dispatch behavior.

- [x] **Step 4: Run the scheduler tests**

Run the command from Step 2 and the existing scheduler registration tests. Expected: only due subscriptions reach `_collect_one`.

### Task 3: Add the per-subscription settings dialog

**Files:**
- Modify: `web/lib/api/x.ts`
- Modify: `web/app/x/XSubscriptionRow.tsx`
- Modify: `web/app/x/XClient.tsx`
- Modify: `web/app/x/XSubscriptionRow.test.tsx`
- Modify: `web/app/x/XClient.test.tsx`

- [x] **Step 1: Write failing UI tests**

Assert the row exposes “设置采集频率”, invokes its callback, and the dialog loads the current interval and sends a trimmed/valid `collect_interval_minutes` patch.

- [x] **Step 2: Run the X UI tests and observe the missing action/field failures**

```bash
cd web && pnpm exec vitest run app/x/XSubscriptionRow.test.tsx app/x/XClient.test.tsx
```

- [x] **Step 3: Implement the API type, row action, display, and dialog**

Use the existing dialog components and fixed options `[5, 10, 15, 30, 60, 180, 360, 720, 1440]`. After saving, call the existing subscription reload callback so the row displays the new interval.

- [x] **Step 4: Run the X UI tests**

Run the command from Step 2. Expected: all selected tests pass.

### Task 4: Clarify the global default setting and run regression checks

**Files:**
- Modify: `web/app/settings/sections/XSection.tsx`
- Modify: `web/app/settings/sections/XSection.test.tsx`
- Modify: `backend/routers/settings.py`

- [x] **Step 1: Update the setting copy and validation**

Rename the field to “新订阅默认采集间隔”, keep the API key for compatibility, and enforce the same 5–1440 bounds.

- [x] **Step 2: Run focused frontend and backend checks**

```bash
cd web && pnpm exec vitest run app/x app/settings/sections/XSection.test.tsx
/home/violet/miniconda3/envs/wems/bin/python -m py_compile backend/models.py backend/database.py backend/routers/x.py backend/scheduler.py backend/routers/settings.py
git diff --check
```

- [x] **Step 3: Inspect the final diff**

Confirm only the X interval model/API/scheduler/UI/settings files and their tests are part of this change; do not stage unrelated worktree changes.

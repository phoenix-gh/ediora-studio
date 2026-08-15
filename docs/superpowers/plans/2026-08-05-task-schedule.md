# Task Schedule Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `/creation-rules` into a task-arrangement page that lists scheduled rules and their last/next execution times, while preserving `/jobs` as the task panel.

**Architecture:** Enrich the creation-rule list response with server-calculated execution timestamps based on durable run records and schedule configuration. Render those values in the existing rule list, remove the run-log panel from this route, and rename only the corresponding sidebar label.

**Tech Stack:** FastAPI, SQLAlchemy async, Pydantic, Next.js, React, Vitest, pytest.

## Global Constraints

- Keep `/jobs` and all task log/audit API behavior unchanged.
- Use UTC ISO timestamps from the API and localized client display.
- Do not change unrelated dirty-worktree files or create a mixed commit.

---

### Task 1: Return rule execution timestamps

**Files:**
- Modify: `backend/routers/creation_rules.py`
- Test: `backend/tests/test_daily_creation_rules_router.py`

**Interfaces:**
- Produces: `GET /api/creation-rules` rule objects with `last_run_at: str | null` and `next_run_at: str | null`.
- Consumes: `DailyCreationRun.scheduled_for` and rule schedule fields.

- [ ] **Step 1: Write the failing route test**

```python
rules = client.get("/api/creation-rules").json()
assert rules[0]["last_run_at"] is not None
assert rules[0]["next_run_at"] is not None
assert disabled_rule["next_run_at"] is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_daily_creation_rules_router.py -q`

Expected: failure because list responses do not yet contain execution timestamps.

- [ ] **Step 3: Write minimal implementation**

```python
async def _rule_out_with_schedule(db: AsyncSession, rule: DailyCreationRule) -> dict:
    last_run_at = await db.scalar(
        select(func.max(DailyCreationRun.scheduled_for)).where(DailyCreationRun.rule_id == rule.id)
    )
    return {**_rule_out(rule), "last_run_at": iso(last_run_at), "next_run_at": next_run_at(rule)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_daily_creation_rules_router.py -q`

Expected: PASS.

### Task 2: Render task-arrangement list only

**Files:**
- Modify: `web/lib/api/creation-rules.ts`
- Modify: `web/app/creation-rules/CreationRulesClient.tsx`
- Modify: `web/app/creation-rules/CreationRulesPanel.tsx`
- Modify: `web/components/features/Sidebar.tsx`
- Test: `web/app/creation-rules/CreationRulesClient.test.tsx`

**Interfaces:**
- Consumes: `DailyCreationRule.last_run_at` and `DailyCreationRule.next_run_at` from Task 1.
- Produces: a `/creation-rules` page without `CreationRunsPanel`, with `任务安排` navigation and visible time states per rule.

- [ ] **Step 1: Write failing component tests**

```tsx
expect(await screen.findByRole('heading', { name: '任务安排' })).toBeInTheDocument()
expect(screen.queryByText('任务日志')).not.toBeInTheDocument()
expect(screen.getByText('上次执行')).toBeInTheDocument()
expect(screen.getByText('下次执行')).toBeInTheDocument()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run app/creation-rules/CreationRulesClient.test.tsx --reporter=dot`

Expected: failure because the old run panel remains and rule rows lack timestamp fields.

- [ ] **Step 3: Write minimal implementation**

```tsx
<p>上次执行：{rule.last_run_at ? formatDateTime(rule.last_run_at) : '尚未执行'}</p>
<p>下次执行：{rule.enabled ? rule.next_run_at ? formatDateTime(rule.next_run_at) : '无后续执行' : '已停用'}</p>
```

- [ ] **Step 4: Run focused frontend checks**

Run: `pnpm exec vitest run app/creation-rules/CreationRulesClient.test.tsx --reporter=dot`

Expected: PASS.

### Task 3: Verify scoped quality

**Files:** No production changes.

- [ ] **Step 1: Run scoped lint and type checks**

Run: `pnpm exec eslint app/creation-rules/CreationRulesClient.tsx app/creation-rules/CreationRulesPanel.tsx components/features/Sidebar.tsx lib/api/creation-rules.ts`

Run: `pnpm exec tsc --noEmit`

- [ ] **Step 2: Record unrelated existing failures separately**

Do not attribute pre-existing text-video type errors or the known async-SQLite pytest-fixture hang to this change.

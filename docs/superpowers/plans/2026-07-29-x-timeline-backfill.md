# X Timeline Backfill Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual 1–90 day collection operation for one individual-account X timeline subscription without affecting its incremental collection schedule.

**Architecture:** The X router will accept a bounded `days` value on a new per-subscription endpoint and call the existing timeline collector with an explicit UTC cutoff. It reuses the normal upsert, global tweet-ID deduplication, and downstream dispatch path. The X subscription dialog will open a standard Dialog to collect the day count and call that endpoint only for timeline subscriptions.

**Tech Stack:** FastAPI, SQLAlchemy async, pytest, Next.js/React, TypeScript, Vitest, Base UI Dialog.

## Global Constraints

- Default to 7 days and accept only integer values from 1 through 90.
- Show the operation only for `timeline` subscriptions; existing search time-window settings remain unchanged.
- Reuse `tweet_id` deduplication and dispatch only newly stored posts to response and topic-source flows.
- Do not create automatic backfill or persistent per-subscription backfill settings.
- Use project Dialog components; do not use browser prompts.
- Keep files under `docs/superpowers/` uncommitted.

---

### Task 1: Parameterize timeline collection in the X router

**Files:**
- Modify: `backend/routers/x.py:299-367`
- Test: `backend/tests/test_x_router.py`

**Interfaces:**
- Consumes: `grab_timeline(url: str, since: datetime)` and `_collect_one(db, sub)`.
- Produces: `_collect_one(db, sub, cutoff: datetime | None = None) -> int` and `POST /x/subscriptions/{sub_id}/backfill` accepting `{"days": 7}`.

- [ ] **Step 1: Write failing router tests**

```python
def test_backfill_passes_requested_day_cutoff_to_grab(client):
    response = client.post(f"/api/x/subscriptions/{timeline_id}/backfill", json={"days": 7})
    assert response.status_code == 200
    _, kwargs = mock_grab_timeline.await_args
    delta = datetime.now(timezone.utc) - kwargs["since"]
    assert 6 * 86400 < delta.total_seconds() < 8 * 86400

def test_backfill_rejects_search_subscription(client):
    response = client.post(f"/api/x/subscriptions/{search_id}/backfill", json={"days": 7})
    assert response.status_code == 422

@pytest.mark.parametrize("days", [0, 91])
def test_backfill_rejects_out_of_range_days(client, days):
    response = client.post(f"/api/x/subscriptions/{timeline_id}/backfill", json={"days": days})
    assert response.status_code == 422
```

- [ ] **Step 2: Run the new tests and verify they fail because the route does not exist**

Run: `pytest -q backend/tests/test_x_router.py -k backfill`

Expected: failing route assertions (404) before implementation.

- [ ] **Step 3: Add the request model and explicit-cutoff collector path**

```python
class TimelineBackfillRequest(BaseModel):
    days: int = Field(default=7, ge=1, le=90)

async def _collect_one(db: AsyncSession, sub: XSubscription, cutoff: datetime | None = None) -> int:
    if sub.kind == "search":
        posts = await search_top(
            raw_query=sub.raw_query, min_faves=sub.min_faves,
            min_retweets=sub.min_retweets, lang=sub.lang, days=sub.days,
            extra_terms=sub.extra_terms, sort=sub.sort, limit=sub.max_results,
        )
    else:
        effective_cutoff = cutoff or await _compute_collect_cutoff(db, sub.id)
        posts = await grab_timeline(sub.url, since=effective_cutoff)

@router.post("/subscriptions/{sub_id}/backfill")
async def backfill_timeline_subscription(sub_id: int, body: TimelineBackfillRequest, db: AsyncSession = Depends(get_db)):
    sub = await db.get(XSubscription, sub_id)
    if not sub:
        raise HTTPException(404, "订阅不存在")
    if sub.kind != "timeline":
        raise HTTPException(422, "仅个人账号订阅支持回溯采集")
    cutoff = datetime.now(timezone.utc) - timedelta(days=body.days)
    return {"ok": True, "new_posts": await _collect_one(db, sub, cutoff=cutoff)}
```

- [ ] **Step 4: Run focused router tests and the existing X router suite**

Run: `pytest -q backend/tests/test_x_router.py`

Expected: all X router tests pass; existing incremental-cutoff tests retain their original behavior.

### Task 2: Add the backfill request to the frontend API client

**Files:**
- Modify: `web/lib/api/x.ts:126-133`
- Test: `web/lib/api/x.test.ts`

**Interfaces:**
- Consumes: `apiFetch` and the new router endpoint from Task 1.
- Produces: `backfillXSubscription(id: number, days: number): Promise<XCollectResult>`.

- [ ] **Step 1: Write a failing API-client test**

```ts
it('posts the requested day count to a subscription backfill endpoint', async () => {
  await backfillXSubscription(12, 14)
  expect(fetchMock).toHaveBeenCalledWith(
    'http://localhost:8000/api/x/subscriptions/12/backfill',
    expect.objectContaining({ method: 'POST', body: JSON.stringify({ days: 14 }) }),
  )
})
```

- [ ] **Step 2: Run the test and verify it fails because the client function is missing**

Run: `pnpm test -- lib/api/x.test.ts`

Expected: import or undefined-function failure.

- [ ] **Step 3: Add the minimal API wrapper**

```ts
export const backfillXSubscription = (id: number, days: number) =>
  apiFetch<XCollectResult>(`/x/subscriptions/${id}/backfill`, {
    method: 'POST',
    body: JSON.stringify({ days }),
  })
```

- [ ] **Step 4: Run the API-client test**

Run: `pnpm test -- lib/api/x.test.ts`

Expected: pass.

### Task 3: Add the subscription-management backfill dialog

**Files:**
- Modify: `web/app/x/XClient.tsx:20-24, 43-124, 493-920`
- Test: `web/app/x/XClient.test.tsx`

**Interfaces:**
- Consumes: `backfillXSubscription(id, days)` from Task 2 and current Dialog/Input/Button/toast conventions.
- Produces: a timeline-only **回溯采集** action, a day-count dialog, and reload of subscriptions/posts after success.

- [ ] **Step 1: Write failing component tests**

```tsx
it('opens a seven-day backfill dialog for a timeline subscription', async () => {
  render(<XClient initialSubs={[timelineSubscription]} initialPosts={[]} />)
  await user.click(screen.getByRole('button', { name: '订阅管理' }))
  await user.click(screen.getByRole('button', { name: '回溯采集' }))
  expect(screen.getByRole('dialog')).toHaveTextContent('回溯采集')
  expect(screen.getByLabelText('最近天数')).toHaveValue(7)
})

it('submits the selected day count and refreshes the list', async () => {
  await user.clear(screen.getByLabelText('最近天数'))
  await user.type(screen.getByLabelText('最近天数'), '14')
  await user.click(screen.getByRole('button', { name: '开始采集' }))
  expect(mocks.backfillXSubscription).toHaveBeenCalledWith(timelineSubscription.id, 14)
})

it('does not show backfill collection for a search subscription', async () => {
  render(<XClient initialSubs={[searchSubscription]} initialPosts={[]} />)
  await user.click(screen.getByRole('button', { name: '订阅管理' }))
  expect(screen.queryByRole('button', { name: '回溯采集' })).toBeNull()
})
```

- [ ] **Step 2: Run the new tests and verify they fail because no UI exists**

Run: `pnpm test -- app/x/XClient.test.tsx`

Expected: the backfill action/control cannot be found.

- [ ] **Step 3: Implement dialog state and the timeline-only action**

```tsx
const [backfillDialog, setBackfillDialog] = useState<{ subscription: XSubscription; days: string; busy: boolean; error: string } | null>(null)

async function submitBackfill() {
  const days = Number(backfillDialog?.days)
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    setBackfillDialog(value => value ? { ...value, error: '请输入 1–90 的整数天数。' } : value)
    return
  }
  await onBackfill(backfillDialog.subscription, days)
}

{subscription.kind === 'timeline' ? <Button onClick={() => setBackfillDialog({ subscription, days: '7', busy: false, error: '' })}>回溯采集</Button> : null}
```

Pass `onBackfill` from `XClient`; it calls `backfillXSubscription`, uses the existing toast text pattern, and reloads subscriptions and posts. Use Dialog inputs and buttons disabled while a request is in flight.

- [ ] **Step 4: Run X client tests and production build**

Run: `pnpm test -- app/x/XClient.test.tsx && pnpm build`

Expected: tests and Next.js TypeScript build pass.

### Task 4: Verify backend, rendered UI, and deployment

**Files:**
- No committed application files beyond Tasks 1–3.

**Interfaces:**
- Consumes: the tested router and dialog.
- Produces: rebuilt API/web containers that expose the manual backfill flow at `/x`.

- [ ] **Step 1: Run full relevant automated tests**

Run: `pytest -q backend/tests/test_x_router.py && pnpm --dir web test -- app/x/XClient.test.tsx`

Expected: both suites pass with no test failures.

- [ ] **Step 2: Rebuild the API and web services with the existing runtime environment file**

Run: `docker compose -p main-runtime --env-file /workspace/projects/WeMediaStudio/.worktrees/main-runtime/.env -f docker-compose.yml build api web && docker compose -p main-runtime --env-file /workspace/projects/WeMediaStudio/.worktrees/main-runtime/.env -f docker-compose.yml up -d --force-recreate api web`

Expected: both containers are running; API and worker retain `WORKER_TOKEN` through the runtime environment file.

- [ ] **Step 3: Validate the rendered subscription flow**

Run a local Playwright check against `http://localhost:3000/x`:

```ts
await page.getByRole('button', { name: '订阅管理' }).click()
await page.getByRole('button', { name: '回溯采集' }).click()
await expect(page.getByRole('dialog')).toContainText('最近天数')
await expect(page.getByLabel('最近天数')).toHaveValue('7')
```

Expected: dialog opens for a timeline subscription, defaults to 7, no relevant console errors, and no framework error overlay.

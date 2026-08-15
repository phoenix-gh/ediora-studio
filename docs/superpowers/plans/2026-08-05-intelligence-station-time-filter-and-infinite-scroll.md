# Intelligence Station Time Filter and Infinite Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a default three-day content-time filter and reliable infinite scrolling to the Intelligence Station.

**Architecture:** The `/api/responses` list endpoint will apply the time window in SQL using `source_published_at`, falling back to `created_at` when the source publish time is unavailable. The client will request page 1 for the active filter set and append later pages through an `IntersectionObserver` sentinel, resetting the list and selected item when filters change.

**Tech Stack:** FastAPI, SQLAlchemy, Next.js/React, TypeScript, Vitest, Testing Library, Playwright.

## Global Constraints

- The default time window is 3 days.
- The time filter must participate in server-side pagination and count calculations.
- The infinite-scroll sentinel must not issue duplicate requests or append duplicate items.
- Existing status, source, content-type, search, sort, detail, and decision behavior must remain intact.
- Do not add dependencies.

---

### Task 1: Add the server-side time-window contract

**Files:**
- Modify: `backend/routers/responses.py`
- Test: `backend/tests/test_responses_router.py`

**Interfaces:**
- `GET /api/responses?days=3` returns only items whose `coalesce(source_published_at, created_at)` is newer than the UTC cutoff.
- `days=0` means no time limit; omitted `days` defaults to 3.

- [ ] **Step 1: Write the failing test**

Add recent and old response items to the router fixture and assert the default list excludes the old item, `days=7` includes it, and `days=0` includes all seeded items.

- [ ] **Step 2: Run the focused backend test to verify it fails**

Run: `python -m pytest backend/tests/test_responses_router.py -q`

Expected: the new time-filter test fails because `days` is not currently accepted or applied.

- [ ] **Step 3: Implement the minimal route filter**

Import `datetime`, `timedelta`, and `timezone`; add `days: int = Query(default=3, ge=0, le=3650)`; and apply:

```python
if days:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    query = query.where(
        func.coalesce(
            ContentResponseItem.source_published_at,
            ContentResponseItem.created_at,
        ) >= cutoff
    )
```

- [ ] **Step 4: Run the focused backend test to verify it passes**

Run: `python -m pytest backend/tests/test_responses_router.py -q`

Expected: all tests pass.

### Task 2: Add the client API and time-filter controls

**Files:**
- Modify: `web/lib/api/responses.ts`
- Modify: `web/app/responses/page.tsx`
- Modify: `web/app/responses/ResponsesClient.tsx`
- Test: `web/app/responses/ResponsesClient.test.tsx`

**Interfaces:**
- `getResponses` accepts `days?: number` and `page?: number`.
- `ResponsesClient` keeps `days` at 3 initially and sends it with every list request.

- [ ] **Step 1: Write the failing UI/API test**

Assert that the default list request contains `{ days: 3, page: 1 }`, and clicking the `7天内` filter requests `{ days: 7, page: 1 }`.

- [ ] **Step 2: Run the focused client test to verify it fails**

Run: `pnpm exec vitest run app/responses/ResponsesClient.test.tsx`

Expected: the new assertions fail because the client does not yet send `days`.

- [ ] **Step 3: Implement the minimal client changes**

Add the API parameter, keep `days` state at `3`, include it in the list query, and render a `时间` filter group with `1天内`, `3天内`, `7天内`, `30天内`, `90天内`, and `不限` (`0`). The first page fetch should explicitly request `page: 1`.

- [ ] **Step 4: Run the focused client test to verify it passes**

Run: `pnpm exec vitest run app/responses/ResponsesClient.test.tsx`

Expected: all tests pass.

### Task 3: Append paginated results with infinite scrolling

**Files:**
- Modify: `web/app/responses/ResponsesClient.tsx`
- Test: `web/app/responses/ResponsesClient.test.tsx`
- Modify: `web/e2e/intelligence-station.spec.ts`

**Interfaces:**
- The list sentinel triggers `GET /api/responses?page=2` when more results exist.
- A filter change replaces the list with page 1 and resets the page cursor.

- [ ] **Step 1: Write the failing UI test**

Stub `IntersectionObserver`, return page 2 from `getResponses`, trigger the sentinel callback, and assert page 2 is appended and requested with the active `days` filter. Add a second assertion that selecting a new time window requests page 1 and replaces the old list.

- [ ] **Step 2: Run the focused client test to verify it fails**

Run: `pnpm exec vitest run app/responses/ResponsesClient.test.tsx`

Expected: the sentinel is absent or no page-2 request is made.

- [ ] **Step 3: Implement the minimal incremental loader**

Track the current page, request generation, and loading-more guard in refs/state. Observe a bottom sentinel inside the existing scroll container with `rootMargin: '160px'`; append only unseen IDs; stop when `items.length >= total`; and ignore stale responses after a filter reset.

- [ ] **Step 4: Run the focused client test to verify it passes**

Run: `pnpm exec vitest run app/responses/ResponsesClient.test.tsx`

Expected: all tests pass, including the duplicate-request guard.

- [ ] **Step 5: Extend the browser flow**

Make the Playwright mock return a second page, scroll the list sentinel into view, and assert that the next item renders while the time filter remains active.

### Task 4: Full verification

**Files:**
- No additional files.

- [ ] **Step 1: Run focused frontend and backend tests**

Run: `pnpm exec vitest run app/responses` and `python -m pytest backend/tests/test_responses_router.py -q`.

- [ ] **Step 2: Run lint and whitespace checks**

Run: `pnpm exec eslint app/responses/ResponsesClient.tsx app/responses/ResponsesClient.test.tsx app/responses/page.tsx lib/api/responses.ts e2e/intelligence-station.spec.ts` and `git diff --check` for changed files.

- [ ] **Step 3: Run the rendered browser flow**

Run: `pnpm exec playwright test e2e/intelligence-station.spec.ts` against the already-running local app, verifying the page loads, the time filter changes the request, and scrolling appends results.

# Draft inbox incremental loading implementation plan

> **Goal:** Make the draft inbox load a small first page and automatically load
> further pages as the user reaches the end of the list.

**Architecture:** Preserve the existing full-list API for other clients and add
an opaque cursor endpoint for the inbox. The server applies status/topic
filters, while the client owns its loaded page sequence and resets it when the
active query changes.

## Task 1: Paginated API

**Files:** `backend/schemas.py`, `backend/routers/drafts.py`,
`backend/tests/test_drafts_router.py`

1. Add a failing route test covering page size, next cursor, cursor continuation,
   and status/topic filtering.
2. Add a typed page response and a cursor endpoint ordered by `updated_at, id`.
3. Run the focused backend test.

## Task 2: Frontend page client

**Files:** `web/lib/api/drafts.ts`,
`web/app/drafts/page.tsx`,
`web/app/drafts/DraftsClient.tsx`,
`web/app/drafts/DraftsClient.test.tsx`

1. Add a failing component test that reaching the list sentinel fetches and
   renders the next page.
2. Add the typed frontend page API and pass only the first page from the server
   component.
3. Load subsequent pages with an IntersectionObserver sentinel, deduplicating
   IDs. Reset pagination and selection when a server-side filter changes.
4. Run the focused frontend test and static checks.

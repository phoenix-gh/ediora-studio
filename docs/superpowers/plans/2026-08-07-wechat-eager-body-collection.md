# WeChat Eager Body Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all WeChat read-side traffic bypass collection proxies, persist article bodies during collection, and backfill every existing empty body on the next sync.

**Architecture:** WeChat read-side modules construct `httpx.AsyncClient` with `trust_env=False`. Account sync persists metadata, queries every empty body for that account, fetches bodies in batches of three, and returns body success/failure statistics; article detail becomes database-only.

**Tech Stack:** FastAPI, SQLAlchemy async ORM, httpx, asyncio, Pydantic, pytest, React/TypeScript API types.

## Global Constraints

- WeChat QR login, account search, article listing, article body, and image collection must ignore `HTTP_PROXY`, `HTTPS_PROXY`, and system proxy settings.
- Do not change WeChat official publishing API or SSH publishing tunnel behavior.
- Process at most 3 article bodies concurrently per account.
- Preserve metadata when one body fetch fails and continue the remaining bodies.
- Keep at most the first 20 body failure details and include the omitted count.
- Article detail reads database state only and never performs an outbound request.

---

### Task 1: Enforce direct networking for WeChat read-side clients

**Files:**
- Modify: `backend/wechat_mp_client.py`
- Modify: `backend/wechat_collector.py`
- Modify: `backend/wechat_img_cache.py`
- Create: `backend/tests/test_wechat_direct_network.py`

**Interfaces:**
- Produces: every WeChat read-side `httpx.AsyncClient(...)` call includes `trust_env=False`.
- Consumes: existing request headers, timeout, redirects, and response parsing remain unchanged.

- [ ] **Step 1: Write failing direct-network tests**

Monkeypatch each module's `httpx.AsyncClient` constructor, invoke one representative request path, and assert constructor kwargs include `trust_env=False`:

```python
assert captured_kwargs["trust_env"] is False
```

Cover `wechat_mp_client.list_articles`, `wechat_collector.fetch_article_body`, and `wechat_img_cache.fetch_and_cache`.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_wechat_direct_network.py -q
```

Expected: all three assertions fail because current constructors omit `trust_env`.

- [ ] **Step 3: Add explicit direct-network configuration**

Add `trust_env=False` to all `httpx.AsyncClient` constructors in the three read-side modules, including login, QR polling, account search, article listing, body fetching, and image caching.

- [ ] **Step 4: Run tests and verify GREEN**

Run the Task 1 pytest command and expect all tests to pass.

---

### Task 2: Fetch and backfill bodies during account sync

**Files:**
- Modify: `backend/routers/wechat.py`
- Modify: `backend/scheduler.py`
- Modify: `backend/tests/test_wechat_collect_all.py`
- Create: `backend/tests/test_wechat_eager_body_collection.py`

**Interfaces:**
- Produces: `SyncResult.body_fetched: int`, `SyncResult.body_failed: int`, and `SyncResult.body_errors: list[str]`.
- Produces: `CollectStatus.body_fetched: int` and `CollectStatus.body_failed: int`.
- Consumes: `fetch_article_body(url, client=shared_direct_client)` and existing `WechatArticle` rows.

- [ ] **Step 1: Write failing eager-collection tests**

Using a real temporary SQLite database and mocked WeChat network functions, verify:

```python
assert saved_new_article.content == "<p>new body</p>"
assert saved_existing_empty.content == "<p>backfilled body</p>"
assert result.body_fetched == 2
```

Add a failure case with four empty articles where one raises; assert three bodies persist, `body_failed == 1`, and the other rows continue processing. Track simultaneous fake fetches and assert the maximum is at most 3.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_wechat_eager_body_collection.py -q
```

Expected: FAIL because sync currently saves metadata only and `SyncResult` lacks body counters.

- [ ] **Step 3: Implement batched body backfill**

After metadata upsert, flush pending rows, query every `WechatArticle` for the account whose content is empty, and process chunks of three with `asyncio.gather`. Each task returns `(article, body, error)`; assign successful bodies on the ORM rows, append failure text as `标题: 异常`, and commit once at the end.

Truncate returned failure details to 20 entries and append `另有 N 篇失败` when needed.

- [ ] **Step 4: Aggregate status and logs**

Reset and aggregate body counters in `_run_collect_all`. A nonzero `body_failed` produces a warning message containing `正文成功 X 篇，正文失败 Y 篇`; scheduled collection applies the same aggregation and warning rule.

- [ ] **Step 5: Run eager and collect-all tests**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_wechat_eager_body_collection.py backend/tests/test_wechat_collect_all.py -q
```

Expected: all tests pass.

---

### Task 3: Remove lazy detail fetching and update client messaging

**Files:**
- Modify: `backend/routers/wechat.py`
- Create: `backend/tests/test_wechat_article_detail.py`
- Modify: `wemedia-studio/lib/api/wechat.ts`
- Modify: `wemedia-studio/components/features/ArticleReader.tsx`
- Modify: `wemedia-studio/app/wechat/WechatClient.tsx`
- Modify: `wemedia-studio/components/features/ArticleReader.test.tsx`

**Interfaces:**
- Produces: `GET /api/wechat/articles/{id}` returns stored `ArticleOut` without calling `fetch_article_body`.
- Produces: `emptyContentMessage?: string` on shared article reader props; WeChat passes `正文尚未采集成功`.
- Consumes: new body counters in `WechatSyncResult` and `WechatCollectStatus` TypeScript interfaces.

- [ ] **Step 1: Write failing database-only detail test**

Insert an empty `WechatArticle`, monkeypatch `wechat_collector.fetch_article_body` to raise if called, request the detail endpoint, and assert HTTP 200 with empty content.

- [ ] **Step 2: Write failing reader empty-state test**

Render the reader with empty content and `emptyContentMessage="正文尚未采集成功"`, then assert that exact message is visible.

- [ ] **Step 3: Run tests and verify RED**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_wechat_article_detail.py -q
pnpm test components/features/ArticleReader.test.tsx
```

Expected: backend fails by calling the fetcher; frontend fails because the custom empty-state prop does not exist.

- [ ] **Step 4: Remove lazy fetch and add scoped empty-state copy**

Delete outbound fetch logic from `get_article`. Thread `emptyContentMessage` through responsive/modal/panel reader props with default `暂无正文内容`; WeChat passes `正文尚未采集成功`.

Add body counter fields to the TypeScript WeChat sync/status interfaces without changing unrelated API clients.

- [ ] **Step 5: Run all scoped verification**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_wechat_direct_network.py backend/tests/test_wechat_eager_body_collection.py backend/tests/test_wechat_article_detail.py backend/tests/test_wechat_collector.py backend/tests/test_wechat_collect_all.py -q
pnpm test components/features/ArticleReader.test.tsx app/wechat/WechatClient.test.tsx
pnpm exec eslint components/features/ArticleReader.tsx components/features/ArticleReader.test.tsx app/wechat/WechatClient.tsx lib/api/wechat.ts
git diff --check
```

Expected: scoped tests pass, ESLint has no errors, and diff check is clean.

- [ ] **Step 6: Runtime verification**

Restart managed services, trigger one WeChat collection, and verify current logs contain body success/failure counters and no `socksio` error for WeChat. Open an empty-body detail endpoint during collection and verify it returns immediately without creating a body-fetch log entry.

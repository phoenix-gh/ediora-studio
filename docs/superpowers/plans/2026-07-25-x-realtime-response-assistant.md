# X Realtime Response Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn selected X timeline subscriptions into a Chinese realtime response assistant that classifies new posts, creates safe copyable comment or quote-translation drafts, persists every decision, and pushes only high-value decisions through Telegram.

**Architecture:** Start from `current-version-20260725-ai-workspace-baseline`. Python remains responsible for X collection, Postgres models, safe link fetching, Telegram delivery, response APIs, and job dispatch. The existing Redis-backed Next.js worker executes a new `x_response` AI SDK flow with resumable `qualify`, `verify_links`, `decide`, `persist`, and `notify` steps.

**Tech Stack:** Python 3.11, FastAPI, SQLAlchemy async, PostgreSQL/SQLite tests, Redis, APScheduler, httpx, BeautifulSoup, Next.js 16, React 19, Vercel AI SDK 7, Zod 4, Vitest.

## Global Constraints

- Any timeline X subscription may enable realtime response; search subscriptions may not.
- The switch defaults off and only considers posts collected after `notify_enabled_at`.
- All user-facing drafts are Chinese; product names, model names, API names, and necessary technical terms remain English.
- The primary action is exactly one of `comment`, `translate_quote`, `watch`, or `ignore`.
- Publishing remains manual. No code in this feature may call an X publish, reply, repost, or quote endpoint.
- `score >= 75` and `confidence >= 0.70` sends an immediate Telegram message; `50 <= score < 75` enters the 18:00 Asia/Shanghai digest; lower scores remain Web-only.
- Any unverified linked announcement is forced to `watch` and may not produce a publishable translation draft.
- Telegram uses HTML `<pre>` blocks for copyable drafts and must be idempotent per decision.
- The normal runtime must not depend on Hermes.
- Existing `XPost.x_reply_*` columns remain for rollback but receive no new writes.

## Execution Baseline

Create `feat/x-realtime-response-assistant` from tag `current-version-20260725-ai-workspace-baseline`. Cherry-pick the approved design commit and this plan commit into that worktree. Do not execute inside the dirty historical root checkout or inside `.worktrees/main-runtime`.

## File Map

- `backend/models.py`: add the durable `XResponseDecision` record.
- `backend/x_response_service.py`: eligibility, job dispatch, policy normalization, persistence, feedback, and reconciliation.
- `backend/x_response_links.py`: URL extraction and SSRF-safe bounded page verification.
- `backend/telegram_notifier.py`: HTML rendering, splitting, Bot API send, and notification idempotency.
- `backend/routers/x_responses.py`: public response inbox APIs plus worker-only context, verify, persist, and notify APIs.
- `backend/routers/x.py`: identify genuinely new posts and dispatch eligible response jobs after commit.
- `backend/scheduler.py`: replace legacy reply scout with reconciliation and 18:00 digest scheduling.
- `backend/config.py`, `backend/routers/settings.py`: Telegram credentials and target X account settings.
- `wemedia-studio/lib/ai/job-client.ts`: shared durable job API helpers.
- `wemedia-studio/lib/ai/x-response-job.ts`: Zod decision contract and resumable AI flow.
- `wemedia-studio/lib/ai/content-job.ts`, `wemedia-studio/scripts/content-worker.ts`: route `x_response` and `x_response_digest` jobs.
- `wemedia-studio/lib/api/x-responses.ts`: typed inbox API.
- `wemedia-studio/app/x-responses/`: server page, client inbox, and UI tests.
- `wemedia-studio/app/x/XClient.tsx`: rename the subscription toggle to “即时响应”.
- `wemedia-studio/app/settings/sections/XSection.tsx`: configure Telegram and target X account.
- `wemedia-studio/components/features/Sidebar.tsx`: add “待响应”.

---

### Task 1: Durable response model and policy service

**Files:**
- Modify: `backend/models.py`
- Create: `backend/x_response_service.py`
- Create: `backend/tests/test_x_response_service.py`

**Interfaces:**
- Produces: `XResponseDecision`
- Produces: `normalize_decision(raw: dict, verification_status: str) -> dict`
- Produces: `notification_tier(score: int, confidence: float, verification_status: str) -> str`
- Produces: `persist_decision(db, tweet_id: str, raw: dict, metadata: dict) -> XResponseDecision`

- [ ] **Step 1: Write failing model and policy tests**

```python
def test_unverified_translation_is_downgraded():
    from x_response_service import normalize_decision
    result = normalize_decision({
        "action": "translate_quote",
        "score": 91,
        "confidence": 0.92,
        "reason": "重大更新",
        "summary_cn": "官方发布新 API",
        "comment_draft": None,
        "quote_draft": "官方发布了新 API",
        "claims": [],
    }, "unverified")
    assert result["action"] == "watch"
    assert result["quote_draft"] is None
    assert result["notification_tier"] == "digest"


def test_one_decision_per_tweet(session_factory):
    from models import XPost, XResponseDecision
    assert XResponseDecision.__table__.c.tweet_id.unique is True
```

- [ ] **Step 2: Run the tests and confirm the missing model/service failure**

Run:

```bash
conda run -n wems pytest backend/tests/test_x_response_service.py -q
```

Expected: FAIL because `XResponseDecision` and `x_response_service` do not exist.

- [ ] **Step 3: Add `XResponseDecision` and fixed policy constants**

Add a SQLAlchemy model with a unique `tweet_id`, indexed `subscription_id`, action, score, confidence, reason, summary, both drafts, claims JSON, verification fields, notification/workflow states, model/prompt/policy versions, Telegram attempts/result fields, optional `event_id`, and timestamps.

Implement these exact constants:

```python
IMMEDIATE_SCORE = 75
DIGEST_SCORE = 50
MIN_IMMEDIATE_CONFIDENCE = 0.70
POLICY_VERSION = "x-response-v1"
VALID_ACTIONS = {"comment", "translate_quote", "watch", "ignore"}
```

`normalize_decision` must clamp score/confidence, reject mismatched action/draft combinations, remove drafts for `watch`/`ignore`, downgrade unverified linked claims to `watch`, and calculate `notification_tier`.

- [ ] **Step 4: Implement idempotent persistence**

`persist_decision` must first select by `tweet_id`; return the existing row unchanged when present. For a new row, store provider/model/prompt/policy versions and initialize Telegram status to `pending` only for immediate decisions.

- [ ] **Step 5: Run focused tests**

Run:

```bash
conda run -n wems pytest backend/tests/test_x_response_service.py -q
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/models.py backend/x_response_service.py backend/tests/test_x_response_service.py
git commit -m "feat(x): persist realtime response decisions"
```

---

### Task 2: Safe linked-announcement verification

**Files:**
- Create: `backend/x_response_links.py`
- Create: `backend/tests/test_x_response_links.py`

**Interfaces:**
- Produces: `extract_external_urls(content: str, raw_markdown: str, post_url: str) -> list[str]`
- Produces: `async verify_urls(urls: list[str], client: httpx.AsyncClient | None = None) -> dict`

- [ ] **Step 1: Write failing extraction and SSRF tests**

Cover public HTTPS links, removal of the original X status URL, rejection of `localhost`, loopback/private/link-local IPs, DNS resolution to private IPs, redirect-to-private targets, unsupported MIME types, response bodies over 1 MiB, and a two-redirect maximum.

```python
def test_extracts_unique_non_x_links():
    from x_response_links import extract_external_urls
    assert extract_external_urls(
        "Docs https://docs.example.com/api",
        "More https://docs.example.com/api",
        "https://x.com/openai/status/1",
    ) == ["https://docs.example.com/api"]
```

- [ ] **Step 2: Run tests and confirm failure**

```bash
conda run -n wems pytest backend/tests/test_x_response_links.py -q
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement bounded manual redirects**

Use `urlsplit`, `ipaddress`, `socket.getaddrinfo`, `httpx.AsyncClient(follow_redirects=False)`, and BeautifulSoup. Validate the hostname before every request and every redirect. Accept only `text/html`, `text/plain`, and `application/xhtml+xml`; cap the downloaded body at 1 MiB and extracted text at 12,000 characters.

Return:

```python
{
    "verification_status": "verified",
    "links": [{
        "url": "https://docs.example.com/api",
        "canonical_url": "https://docs.example.com/api",
        "title": "API announcement",
        "text": "bounded extracted text",
    }],
    "errors": [],
}
```

Return `not_required` for no URLs and `unverified` when every candidate fails.

- [ ] **Step 4: Run focused tests**

```bash
conda run -n wems pytest backend/tests/test_x_response_links.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/x_response_links.py backend/tests/test_x_response_links.py
git commit -m "feat(x): verify announcement links safely"
```

---

### Task 3: Telegram Bot adapter and protected settings

**Files:**
- Modify: `backend/config.py`
- Modify: `backend/routers/settings.py`
- Create: `backend/telegram_notifier.py`
- Create: `backend/tests/test_telegram_notifier.py`
- Modify: `backend/tests/test_web_search_settings.py`

**Interfaces:**
- Produces: `render_immediate_messages(decision, post, subscription, web_url: str) -> list[str]`
- Produces: `async send_html_messages(token: str, chat_id: str, messages: list[str], client=None) -> list[int]`
- Settings: `telegram_bot_token`, `telegram_chat_id`, `x_response_account_id`

- [ ] **Step 1: Write failing formatting and settings tests**

Assert that dynamic text is HTML-escaped, publishable drafts are wrapped in `<pre>`, the original link stays outside the draft, messages remain under 4096 characters, and a long payload becomes two messages without splitting the draft.

Assert settings output exposes only `telegram_bot_token_set` and a preview, never the full token.

- [ ] **Step 2: Run tests and confirm failure**

```bash
conda run -n wems pytest backend/tests/test_telegram_notifier.py backend/tests/test_web_search_settings.py -q
```

- [ ] **Step 3: Add settings fields**

Add empty defaults for the three keys. Extend `SettingsOut`/`SettingsUpdate`; preserve the current token when an update omits it. Validate that `x_response_account_id`, when non-empty, references an active `PublishAccount` whose platform is `x`.

- [ ] **Step 4: Implement deterministic HTML rendering**

Use `html.escape`. Immediate messages contain action, score, confidence, source, reason, Chinese summary, one or two labeled `<pre>` blocks, original URL, and Web inbox URL. `watch` and `ignore` never render publishable `<pre>` blocks.

- [ ] **Step 5: Implement Bot API sending**

POST to `https://api.telegram.org/bot{token}/sendMessage` with `parse_mode=HTML`, `chat_id`, and `link_preview_options={"is_disabled": True}`. Treat 429/5xx as retryable and permanent 4xx as configuration errors. Return Telegram message IDs.

- [ ] **Step 6: Run tests**

```bash
conda run -n wems pytest backend/tests/test_telegram_notifier.py backend/tests/test_web_search_settings.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/config.py backend/routers/settings.py backend/telegram_notifier.py backend/tests/test_telegram_notifier.py backend/tests/test_web_search_settings.py
git commit -m "feat(x): add direct Telegram response notifications"
```

---

### Task 4: Response APIs and worker contracts

**Files:**
- Create: `backend/routers/x_responses.py`
- Modify: `backend/main.py`
- Create: `backend/tests/test_x_responses_router.py`

**Interfaces:**
- Public: `GET /api/x/responses`
- Public: `GET /api/x/responses/{id}`
- Public: `POST /api/x/responses/{id}/feedback`
- Public: `POST /api/x/responses/{id}/convert-to-topic`
- Worker: `GET /api/x/responses/internal/{tweet_id}/context`
- Worker: `POST /api/x/responses/internal/{tweet_id}/verify-links`
- Worker: `POST /api/x/responses/internal/{tweet_id}/decision`
- Worker: `POST /api/x/responses/{id}/notify`

- [ ] **Step 1: Write failing router tests**

Seed one subscription, post, account profile, and response. Test action/status/tier filters, detail payload, idempotent `used`/`ignored`, context fallback to the neutral Chinese tech profile, link verification output, decision normalization, and notification idempotency.

`convert-to-topic` must mark `workflow_status=converted` and return the response payload. It does not publish or start a draft.

- [ ] **Step 2: Run tests and confirm 404 failures**

```bash
conda run -n wems pytest backend/tests/test_x_responses_router.py -q
```

- [ ] **Step 3: Implement worker schemas**

Use strict Pydantic models matching the approved decision contract. Reject out-of-range score/confidence, missing primary drafts, extra publishable drafts on `watch`/`ignore`, and non-Chinese drafts that contain no CJK characters.

- [ ] **Step 4: Implement public inbox APIs**

Default list order is unresolved first, then score descending, then post publication descending. Limit is clamped to 1–100. Feedback transitions are idempotent and do not delete rows.

- [ ] **Step 5: Implement notification endpoint**

Return immediately when `telegram_status=sent`. On success, store message IDs, increment attempts, and set `notified_at`. On failure, store a safe 500-character error and return 503 so the durable job step can retry.

- [ ] **Step 6: Register the router and run tests**

```bash
conda run -n wems pytest backend/tests/test_x_responses_router.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/routers/x_responses.py backend/main.py backend/tests/test_x_responses_router.py
git commit -m "feat(x): expose realtime response APIs"
```

---

### Task 5: Resumable AI SDK response flow

**Files:**
- Create: `wemedia-studio/lib/ai/job-client.ts`
- Create: `wemedia-studio/lib/ai/x-response-job.ts`
- Create: `wemedia-studio/lib/ai/x-response-job.test.ts`
- Modify: `wemedia-studio/lib/ai/content-job.ts`
- Modify: `wemedia-studio/scripts/content-worker.ts`

**Interfaces:**
- Produces: `xResponseDecisionSchema`
- Produces: `parseXResponseDecisionText(text: string)`
- Produces: `runXResponseJob(jobId: number)`
- Produces: `runXResponseDigestJob(jobId: number)`

- [ ] **Step 1: Write failing Zod and resume tests**

Test all four actions, Chinese draft enforcement, unverified downgrade delegated to Python, one repair attempt for invalid JSON, and skipping previously succeeded steps after retry.

```typescript
it('accepts a Chinese quote translation', () => {
  expect(parseXResponseDecisionText(JSON.stringify({
    action: 'translate_quote',
    score: 88,
    confidence: 0.91,
    reason: '官方发布重要 API',
    summary_cn: '官方发布了新的 API',
    comment_draft: null,
    quote_draft: 'OpenAI 发布了新的 Responses API。',
    claims: [],
  })).action).toBe('translate_quote')
})
```

- [ ] **Step 2: Run tests and confirm failure**

```bash
cd wemedia-studio
pnpm test -- lib/ai/x-response-job.test.ts
```

- [ ] **Step 3: Extract shared durable job HTTP helpers**

Move `getJob`, `startStep`, `completeStep`, `failStep`, `completeJob`, and `recordJobEvent` from `content-job.ts` into `job-client.ts` without changing existing draft/image/daily-plan behavior.

- [ ] **Step 4: Implement the five response steps**

For each step, inspect the latest attempt from the job payload. Reuse a succeeded step output; start only a queued/missing step. Execute:

1. `qualify`: load internal context and stop successfully when ineligible.
2. `verify_links`: call the bounded Python verifier.
3. `decide`: call the configured text model with a Chinese-only, no-publish instruction and strict JSON contract.
4. `persist`: POST the parsed decision and model/prompt metadata.
5. `notify`: call the notify endpoint only when the persisted tier is immediate.

On invalid model JSON, make exactly one repair call containing the schema error and raw response. Do not add model tools.

- [ ] **Step 5: Route worker jobs**

The worker loads the job once and dispatches `x_response` to `runXResponseJob`, `x_response_digest` to `runXResponseDigestJob`, and all existing flows to `runContentJob`.

- [ ] **Step 6: Run AI and regression tests**

```bash
cd wemedia-studio
pnpm test -- lib/ai/x-response-job.test.ts lib/ai/content-job.test.ts
pnpm exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add wemedia-studio/lib/ai/job-client.ts wemedia-studio/lib/ai/x-response-job.ts wemedia-studio/lib/ai/x-response-job.test.ts wemedia-studio/lib/ai/content-job.ts wemedia-studio/scripts/content-worker.ts
git commit -m "feat(x): run realtime response AI jobs"
```

---

### Task 6: Collection dispatch, reconciliation, and digest

**Files:**
- Modify: `backend/routers/x.py`
- Modify: `backend/scheduler.py`
- Modify: `backend/x_response_service.py`
- Modify: `backend/tests/test_x_router.py`
- Replace: `backend/tests/test_x_notify_scout.py`

**Interfaces:**
- Produces: `ensure_response_job(db, tweet_id: str) -> tuple[ContentJob, bool]`
- Produces: `dispatch_response_posts(db, subscription, tweet_ids: list[str]) -> dict`
- Produces: `reconcile_response_jobs() -> dict`
- Produces: `create_response_digest_job(date_key: str) -> ContentJob`

- [ ] **Step 1: Write failing dispatch tests**

Test that only genuinely inserted posts from enabled timeline subscriptions create jobs, opening the switch excludes historical posts, search subscriptions are rejected, reply posts are skipped, repeated collection returns zero new posts, and the content-job idempotency key is `x-response:{tweet_id}`.

- [ ] **Step 2: Run tests and confirm failure**

```bash
conda run -n wems pytest backend/tests/test_x_router.py backend/tests/test_x_notify_scout.py -q
```

- [ ] **Step 3: Make `_collect_one` identify real inserts**

Select existing IDs before upsert, commit post rows, then dispatch only `fresh_ids`. A Redis enqueue failure must log a warning without rolling back collected posts; the reconciliation scheduler repairs missing queue work.

- [ ] **Step 4: Implement reconciliation**

Every five minutes, find eligible posts from the previous 48 hours with neither a decision nor an existing `x-response:{tweet_id}` job. Create/enqueue missing jobs. Existing failed jobs remain visible for explicit retry and are not silently duplicated.

- [ ] **Step 5: Replace legacy scout scheduling**

Remove `scheduled_x_reply_scout` and its `assess_x_reply`/legacy field writes from the registered jobs. Add `scheduled_x_response_reconcile` at five minutes and `scheduled_x_response_digest` at 18:00 Asia/Shanghai. The digest job idempotency key is `x-response-digest:{YYYY-MM-DD}`.

- [ ] **Step 6: Run dispatch/scheduler tests**

```bash
conda run -n wems pytest backend/tests/test_x_router.py backend/tests/test_x_notify_scout.py -q
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add backend/routers/x.py backend/scheduler.py backend/x_response_service.py backend/tests/test_x_router.py backend/tests/test_x_notify_scout.py
git commit -m "feat(x): dispatch realtime response jobs after collection"
```

---

### Task 7: Settings and response inbox UI

**Files:**
- Modify: `wemedia-studio/lib/api/settings.ts`
- Modify: `wemedia-studio/app/settings/sections/XSection.tsx`
- Modify: `wemedia-studio/app/x/XClient.tsx`
- Create: `wemedia-studio/lib/api/x-responses.ts`
- Create: `wemedia-studio/lib/api/x-responses.test.ts`
- Create: `wemedia-studio/app/x-responses/page.tsx`
- Create: `wemedia-studio/app/x-responses/XResponsesClient.tsx`
- Create: `wemedia-studio/app/x-responses/x-responses-layout.test.tsx`
- Modify: `wemedia-studio/app/trend-topics/page.tsx`
- Modify: `wemedia-studio/components/features/Sidebar.tsx`

**Interfaces:**
- Produces: `XResponseDecision` TypeScript type.
- Produces: `listXResponses`, `setXResponseFeedback`, `convertXResponseToTopic`.

- [ ] **Step 1: Write failing API and layout tests**

Assert that the X subscription copy says “即时响应”, search subscriptions do not show the bell action, Telegram token is write-only, the inbox contains action/score/confidence/evidence/push status, and copy/open/used/ignore/convert controls exist.

- [ ] **Step 2: Run tests and confirm failure**

```bash
cd wemedia-studio
pnpm test -- lib/api/x-responses.test.ts app/x-responses/x-responses-layout.test.tsx
```

- [ ] **Step 3: Implement settings controls**

Add Telegram Bot Token, Chat ID, and “建议基于账号” selector filtered to active X `PublishAccount` rows. Show configured/unconfigured state without returning the token.

- [ ] **Step 4: Update subscription UI**

Rename all “动态通知/回复建议” text to “即时响应”. Disable the action for `kind=search`. Keep the existing backend field name `notify_new_posts` for compatibility.

- [ ] **Step 5: Build the inbox**

Default filters are unresolved decisions sorted by score. Use colored action/tier badges, show verified link state, render drafts as selectable preformatted text, and implement clipboard copy with a success toast. Mutations refresh only the affected response.

- [ ] **Step 6: Surface converted decisions in hotspot topics**

Fetch `workflow_status=converted`, map each response to a `TopicSuggestion` with type `share`, and merge by original URL ahead of cached generated topics. This makes “转为选题” visible without introducing a second topic table.

- [ ] **Step 7: Add sidebar navigation and run tests**

```bash
cd wemedia-studio
pnpm test
pnpm exec tsc --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add wemedia-studio/lib/api/settings.ts wemedia-studio/app/settings/sections/XSection.tsx wemedia-studio/app/x/XClient.tsx wemedia-studio/lib/api/x-responses.ts wemedia-studio/lib/api/x-responses.test.ts wemedia-studio/app/x-responses wemedia-studio/app/trend-topics/page.tsx wemedia-studio/components/features/Sidebar.tsx
git commit -m "feat(x): add realtime response inbox"
```

---

### Task 8: Migration cleanup, runtime docs, and end-to-end verification

**Files:**
- Modify: `README.md`
- Modify: `docker-compose.yml` only if the final configuration uses environment fallback values.
- Modify: `backend/llm.py`
- Modify: `backend/database.py`
- Modify: affected backend/frontend tests.

**Interfaces:**
- No new interface; this task proves the complete approved behavior.

- [ ] **Step 1: Add migration and no-Hermes assertions**

Ensure `Base.metadata.create_all` creates the response table. Keep legacy `x_reply_*` columns but remove runtime writes and remove `assess_x_reply` only after repository search proves no callers remain.

Run:

```bash
rg -n "hermes send|assess_x_reply|x_reply_score\\s*=|x_reply_draft\\s*=|x_reply_notified_at\\s*=" backend wemedia-studio
```

Expected: no runtime caller or write path; legacy model declarations may remain.

- [ ] **Step 2: Document configuration and manual publishing**

Document Telegram bot creation/configuration, Chat ID, target X account profile, 5-minute polling latency, fixed thresholds, and the explicit statement that the feature never auto-publishes.

- [ ] **Step 3: Run full automated verification**

```bash
conda run -n wems pytest backend/tests -q
cd wemedia-studio
pnpm test
pnpm exec tsc --noEmit
pnpm build
cd ..
docker compose config -q
```

Expected: every command exits 0. If the baseline’s removed-material legacy tests still fail, either update/delete only tests whose production feature was intentionally removed, or restore the required production behavior; do not hide unrelated failures with exclusions.

- [ ] **Step 4: Run a real queue-to-Telegram verification**

With a test bot/chat configured, seed one opted-in timeline subscription and one recent original `XPost`, run reconciliation, run the worker, and verify:

- one `x_response` job exists;
- steps finish in order;
- one decision row exists;
- a high-value mocked or controlled model result produces one Telegram message with a copyable Chinese `<pre>` draft;
- retrying the notify step does not send a second message;
- marking the response used persists;
- converting it makes it appear in `/trend-topics`.

Record the publication, collection, enqueue, decision, and notification timestamps and confirm collection-to-notification is under 60 seconds.

- [ ] **Step 5: Review the complete diff and commit**

```bash
git diff --check
git status --short
git add README.md docker-compose.yml backend wemedia-studio
git commit -m "feat(x): complete realtime response assistant"
```

- [ ] **Step 6: Create the feature checkpoint tag**

```bash
git tag -a current-version-20260725-x-realtime-response -m "X realtime response assistant verified"
```


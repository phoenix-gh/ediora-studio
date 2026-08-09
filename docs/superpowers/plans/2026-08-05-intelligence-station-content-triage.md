# Intelligence Station Content Triage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current response-oriented inbox with an Intelligence Station that analyzes X and YouTube content, keeps the complete original visible, and routes each item to a structured article draft, a creative asset, or no further processing.

**Architecture:** Keep `ContentResponseItem` as the source-neutral identity and `ContentAnalysisRun` as the immutable analysis snapshot. Add explicit content classification and durable destination links, then make the existing `/responses` page a source-first 60/40 workbench. Destination creation is a deterministic backend handoff into the existing `ArticleDraft` or `CreativeAsset` tables; it does not enqueue an AI output job or publish externally.

**Tech Stack:** FastAPI, SQLAlchemy async sessions, SQLite/PostgreSQL-compatible idempotent migrations, Next.js App Router, React 19, TypeScript, Zod, shadcn `Dialog`, Vitest, Testing Library, Playwright, pytest.

## Global Constraints

- The user-facing product name is `情报站`; `/responses` remains the primary route.
- The three destinations are exactly `值得写`, `创作资产`, and `暂不处理`; do not add `资料收藏` or `值得跟踪`.
- Content types are independent tags: `tool`, `industry_update`, `case`, `tutorial`, and `research`.
- Analysis state and user disposition are separate: `queued -> processing -> ready/failed` and `pending | worth_writing | creative_asset | not_processed`.
- The original X post, article body, or YouTube transcript must remain visible and independently scrollable; AI evaluation never replaces it.
- Use a standard centered `Dialog` for both destination confirmations; do not introduce a drawer.
- `值得写` creates a structured draft seed only. It never generates a full article and never publishes.
- `创作资产` stores an original snapshot and an AI-evaluation snapshot in the existing article asset system.
- New analysis contracts and UI contain no comment, reply, quote-reply, or social-response generation.
- Historical comment-related rows may remain read-only and hidden from new controls; the first migration must not destructively delete them.
- Existing selected-item and creation-session identity guards remain in place across list refreshes and async responses.
- New destination requests must verify the current successful `analysis_run_id` and be idempotent for the same item and destination.
- Backend tests run from `backend/` with `/home/violet/miniconda3/envs/wems/bin/python -m pytest`; frontend commands run from `wemedia-studio/` with `pnpm`.

---

## File Map

### Modify

- `backend/models.py` — add content-type and destination fields while retaining legacy analysis/output columns for historical rows.
- `backend/database.py` — add the idempotent Intelligence Station migration and update legacy decision mappings.
- `backend/content_response_service.py` — validate the new AI contract, persist new analysis fields, preserve user classifications, and dispatch unified X analysis jobs.
- `backend/routers/responses.py` — return normalized source detail, expose filters/counts, accept classification/disposition changes, and add idempotent destination handoff.
- `backend/routers/x.py` — enqueue `content_response_analysis` for new eligible X posts instead of the old comment-response flow.
- `backend/scheduler.py` — stop scheduling new X comment-response reconciliation/digest work.
- `backend/tests/test_content_response_models.py` — assert new model defaults and destination fields.
- `backend/tests/test_content_response_service.py` — test the new analysis contract and classification preservation.
- `backend/tests/test_database_content_response_migration.py` — test old-to-new disposition mapping and idempotent migration.
- `backend/tests/test_responses_router_contract.py` — assert the destination/classification route contract.
- `backend/tests/test_responses_worker_context.py` — assert source payloads remain complete for X and YouTube.
- `backend/tests/test_x_router.py` — assert new X collection dispatches the unified analysis flow.
- `backend/tests/test_x_notify_scout.py` — remove assertions for new comment-response scheduling and cover unified reconciliation behavior.
- `wemedia-studio/lib/api/responses.ts` — replace old decision/output types with Intelligence Station types and destination methods.
- `wemedia-studio/lib/ai/content-response-job.ts` — replace `discussion_value` and comment-oriented output fields with editorial value fields.
- `wemedia-studio/lib/ai/content-response-job.test.ts` — test the revised Zod contract and prompt example.
- `wemedia-studio/app/responses/page.tsx` — pass status, type, sort, and selected query state into the client.
- `wemedia-studio/app/responses/ResponsesClient.tsx` — orchestrate filters, selected-item identity, source/evaluation panes, direct not-processed/reset actions, and dialogs.
- `wemedia-studio/app/responses/ResponsesClient.test.tsx` — replace old creation-task tests with source pane, filter, dialog, handoff, and race-condition tests.
- `wemedia-studio/components/features/Sidebar.tsx` — rename the navigation item to `情报站`.
- `wemedia-studio/app/x-responses/x-responses-layout.test.tsx` — assert the compatibility route and new navigation wording.
- `wemedia-studio/app/assets/page.tsx` — accept an optional selected asset query parameter.
- `wemedia-studio/app/assets/AssetsClient.tsx` — honor the selected article asset when opened from an Intelligence Station handoff.
- `wemedia-studio/app/drafts/page.tsx` — retain and verify the existing `draft` query handoff.

### Create

- `backend/content_response_handoff.py` — deterministic draft/asset seed builders and locked idempotent destination creation.
- `backend/tests/test_content_response_handoff.py` — test draft seed, creative-asset snapshot, duplicate submission, stale analysis, and failed-source behavior.
- `backend/tests/test_responses_router.py` — API integration tests for list/detail/filter/classification/destination behavior.
- `wemedia-studio/app/responses/ResponseSourcePane.tsx` — complete original source reader with its own scroll container.
- `wemedia-studio/app/responses/ResponseEvaluationPane.tsx` — first-screen editorial evaluation and expandable dimensions/history.
- `wemedia-studio/app/responses/ResponseDestinationDialog.tsx` — centered draft/creative-asset confirmation dialog with retry-safe submission.
- `wemedia-studio/e2e/intelligence-station.spec.ts` — browser acceptance coverage for X/YouTube triage and destination handoff.

### Leave as compatibility-only

- `backend/x_response_service.py`, `backend/routers/x_responses.py`, `wemedia-studio/lib/api/x-responses.ts`, and `wemedia-studio/app/x-responses/XResponsesClient.tsx` remain available only for historical/legacy compatibility during this rollout. They are no longer an entry point for new collection jobs, and the unified Intelligence Station must not render their comment controls or create their output rows.

---

## Task 1: Add the Intelligence Station persistence contract and migration

**Files:**
- Modify: `backend/models.py:491-575`
- Modify: `backend/database.py:576-888, 1020-1030`
- Modify: `backend/tests/test_content_response_models.py`
- Modify: `backend/tests/test_database_content_response_migration.py`

**Interfaces:**
- `ContentResponseItem.decision_status` keeps its existing column name but accepts only `pending`, `worth_writing`, `creative_asset`, and `not_processed` in the unified flow.
- `ContentResponseItem.content_types: list[str]` stores user-confirmed tags.
- `ContentResponseItem.destination_type: str | None` is `draft` or `creative_asset`.
- `ContentResponseItem.destination_id: int | None` points to `ArticleDraft.id` or `CreativeAsset.id`.
- `ContentAnalysisRun` adds `suggested_title`, `suggested_angle`, `target_reader`, `suggested_structure`, `recommended_content_types`, and `recommended_disposition`.
- Existing `comment_angles`, `recommended_output_types`, and historical `ContentResponseOutput` rows remain readable by legacy code but are not part of the new payload.

- [ ] **Step 1: Write model tests for the new defaults.**

```python
def test_intelligence_station_defaults_are_empty_and_pending(tmp_path):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    import models
    from database import Base

    engine = create_engine(f"sqlite:///{tmp_path / 'responses.db'}")
    Base.metadata.create_all(engine)
    with Session(engine) as db_session:
        item = models.ContentResponseItem(source_type="x_post", source_id="post-1")
        db_session.add(item)
        db_session.flush()
        run = models.ContentAnalysisRun(response_item_id=item.id, version=1)
        db_session.add(run)
        db_session.flush()

        assert item.decision_status == "pending"
        assert item.content_types == []
        assert item.destination_type is None
        assert item.destination_id is None
        assert run.recommended_content_types == []
        assert run.recommended_disposition == "pending"
```

- [ ] **Step 2: Run the focused model test and verify it fails before the columns exist.**

Run: `cd backend && /home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_content_response_models.py -q`

Expected: FAIL with an attribute/default assertion for the new fields.

- [ ] **Step 3: Add the SQLAlchemy fields.**

Use JSON defaults for lists and nullable indexed scalar fields for the destination link. Keep the existing `decision_status` name to avoid breaking old source collectors, but make the new values the only values written by `content_response_service.py`.

- [ ] **Step 4: Add an idempotent migration function and call it from `init_db()`.**

Add `migrate_intelligence_station_schema(conn)` after `Base.metadata.create_all()` and before the existing response-table retirement call. Use `_add_columns()` for old databases, then execute a single guarded update with this mapping:

```python
legacy_to_intelligence = {
    "pending": "pending",
    "adopted": "worth_writing",
    "rejected": "not_processed",
    "later": "pending",
}
```

The migration must leave `destination_type`, `destination_id`, historical analysis versions, and historical comment output rows unchanged. Update the legacy X copy and parity-check mappings in the same file so `used -> worth_writing` and `ignored -> not_processed` are consistent.

- [ ] **Step 5: Test fresh schema, old schema, repeated migration, and legacy mapping.**

Add assertions that a database containing one row in each old status becomes `pending`, `worth_writing`, `not_processed`, `pending`; running the migration twice does not alter timestamps or duplicate rows; and an old `x_response_decisions` row still passes the parity check without exposing comment outputs as new destinations.

Run: `cd backend && /home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_content_response_models.py tests/test_database_content_response_migration.py -q`

- [ ] **Step 6: Commit the persistence contract.**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_content_response_models.py tests/test_database_content_response_migration.py -q
cd ..
git add backend/models.py backend/database.py backend/tests/test_content_response_models.py backend/tests/test_database_content_response_migration.py
git commit -m "feat: add intelligence station persistence contract"
```

---

## Task 2: Replace the AI analysis contract and worker prompt

**Files:**
- Modify: `backend/content_response_service.py:25-86, 203-290`
- Modify: `wemedia-studio/lib/ai/content-response-job.ts:19-139, 182-240`
- Modify: `wemedia-studio/lib/ai/content-response-job.test.ts`
- Modify: `backend/tests/test_content_response_service.py`

**Interfaces:**
- `CONTENT_TYPES = {"tool", "industry_update", "case", "tutorial", "research"}`.
- `DISPOSITIONS = {"worth_writing", "creative_asset", "not_processed"}` for AI recommendations.
- `VALUE_DIMENSIONS = {"novelty", "practicality", "credibility", "writing_space", "evergreen_value"}`.
- `contentResponseAnalysisSchema` returns the exact editorial fields below and no comment/output fields.

```ts
{
  content_value_score: number,
  value_dimensions: Record<'novelty' | 'practicality' | 'credibility' | 'writing_space' | 'evergreen_value', { score: number; reason: string }>,
  summary_cn: string,
  core_thesis: string,
  value_points: string[],
  evidence: { text: string; type: 'fact' | 'source_claim' | 'model_inference'; source?: string }[],
  risks: string[],
  verification_items: string[],
  recommended_content_types: ('tool' | 'industry_update' | 'case' | 'tutorial' | 'research')[],
  recommended_disposition: 'worth_writing' | 'creative_asset' | 'not_processed',
  recommendation_reason: string,
  suggested_title: string,
  suggested_angle: string,
  target_reader: string,
  suggested_structure: string[]
}
```

- [ ] **Step 1: Replace the TypeScript contract fixture with a valid new payload.**

The fixture must use `writing_space`, include all five content types only when recommended, and contain no `comment_angles`, `recommended_output_types`, `x_reply`, or `x_quote` property.

- [ ] **Step 2: Add failing tests for the new contract and comment rejection.**

```ts
it('requires writing_space and editorial destination fields', () => {
  const value = validAnalysis()
  expect(value.value_dimensions.writing_space.score).toBe(70)
  expect(value.recommended_disposition).toBe('worth_writing')
  expect(value.suggested_structure).toEqual(['开篇', '论证', '结论'])
})

it('does not accept the removed discussion dimension', () => {
  const value = validAnalysis() as Record<string, unknown>
  const dimensions = value.value_dimensions as Record<string, unknown>
  delete dimensions.writing_space
  dimensions.discussion_value = { score: 70, reason: '旧字段' }
  expect(() => contentResponseAnalysisSchema.parse(value)).toThrow()
})
```

Run: `cd wemedia-studio && pnpm exec vitest run lib/ai/content-response-job.test.ts`

Expected: FAIL until the schema is changed.

- [ ] **Step 3: Update the strict Zod schema, example, and prompt.**

Change the instructions to say that the model is a Chinese content researcher/editor deciding whether material belongs in the content system. Replace the old five-dimension sentence with the exact `writing_space` set, remove account scoring and all comment/output fields, and require the model to distinguish fact, source claim, and inference. Remove the `score_accounts` entry from `stepOrder`, its `succeededOutput()` branch, and the account coverage check; the worker should proceed directly from `analyze_value` to `persist_response`.

Use `.strict()` on the top-level analysis object and the `value_dimensions` object so a payload containing removed `comment_angles`, `recommended_output_types`, `x_reply`, or `x_quote` fields cannot be silently accepted.

- [ ] **Step 4: Update Python validation and persistence.**

`validate_analysis_payload()` must reject an old dimension set, reject unknown content types/dispositions, validate the title/angle/reader/structure/evidence shapes, and never require active publish accounts. `persist_analysis()` must store the new fields, set `item.content_types` from `recommended_content_types` only when the item has no user-confirmed tags, set `item.workflow_status = "ready"`, and preserve an existing user destination/disposition during re-analysis.

- [ ] **Step 5: Add Python tests for the same contract.**

Cover missing `writing_space`, an invalid content type, an invalid recommended disposition, low-value content remaining valid, and a re-analysis preserving `item.content_types` and `item.decision_status`.

Run: `cd backend && /home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_content_response_service.py -q`

- [ ] **Step 6: Run both focused suites and commit.**

```bash
cd wemedia-studio
pnpm exec vitest run lib/ai/content-response-job.test.ts
cd ../backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_content_response_service.py -q
cd ..
git add backend/content_response_service.py backend/tests/test_content_response_service.py wemedia-studio/lib/ai/content-response-job.ts wemedia-studio/lib/ai/content-response-job.test.ts
git commit -m "feat: replace response analysis with editorial value contract"
```

---

## Task 3: Cut new X collection over to the unified analysis flow

**Files:**
- Modify: `backend/content_response_service.py`
- Modify: `backend/routers/x.py:324-355`
- Modify: `backend/scheduler.py:302-381, 427-429`
- Modify: `backend/tests/test_x_router.py`
- Modify: `backend/tests/test_x_notify_scout.py`

**Interfaces:**
- Add `dispatch_intelligence_posts(db, subscription, source_ids, enqueue=None) -> dict[str, Any]` to `content_response_service.py`.
- For each eligible fresh X post, call `ensure_response_item(db, "x_post", tweet_id)`, call `create_analysis_run(db, item)`, and enqueue the returned `ContentJob` exactly once.
- A newly collected X post creates `ContentJob.flow == "content_response_analysis"`; it never creates `x_response` or `x_response_digest` for the new flow.

- [ ] **Step 1: Add a failing X collection test.**

Given one fresh eligible X post, assert the dispatch result creates one pending unified item and one queued `content_response_analysis` job. Assert that no Telegram notification, comment output, reply output, or quote output row is created.

- [ ] **Step 2: Run the focused X tests to capture the old behavior.**

Run: `cd backend && /home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_x_router.py tests/test_x_notify_scout.py -q`

Expected: the new assertion fails because `backend/routers/x.py` still calls `dispatch_response_posts()`.

- [ ] **Step 3: Implement idempotent unified dispatch.**

Use the existing `ensure_response_item()` and `create_analysis_run()` primitives. Count `created` and `enqueued`, record dispatch errors per source ID, and use the existing queue-dispatch guard so a repeated collector run does not enqueue a second job.

- [ ] **Step 4: Replace the X router dispatch call.**

At the current fresh-post branch, call `dispatch_intelligence_posts()` after the X post transaction is committed. Keep the unrelated topic-source dispatch unchanged.

- [ ] **Step 5: Stop scheduling new comment work.**

Remove the `x_response_reconcile` and `x_response_digest` scheduler registrations and their new-job log path. Keep the legacy modules importable for historical rows and old job inspection, but the new collector path must not invoke them.

- [ ] **Step 6: Test the cutover and commit.**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_x_router.py tests/test_x_notify_scout.py tests/test_responses_worker_context.py -q
cd ..
git add backend/content_response_service.py backend/routers/x.py backend/scheduler.py backend/tests/test_x_router.py backend/tests/test_x_notify_scout.py
git commit -m "feat: route new X items to intelligence analysis"
```

---

## Task 4: Add full-source detail, classification filters, and deterministic destination handoff

**Files:**
- Create: `backend/content_response_handoff.py`
- Create: `backend/tests/test_content_response_handoff.py`
- Create: `backend/tests/test_responses_router.py`
- Modify: `backend/routers/responses.py:38-128, 168-229, 312-418`
- Modify: `backend/tests/test_responses_router_contract.py`
- Modify: `backend/tests/test_responses_worker_context.py`

**Interfaces:**
- `GET /api/responses` accepts `source_type`, `decision_status`, `workflow_status`, `content_type`, `search`, `sort=score|newest`, `page`, and `page_size`; default sort is `score`.
- List response shape is `{ items, counts, page, page_size, total }`; list items never contain full source bodies.
- `GET /api/responses/{item_id}` includes `source` with normalized full source data and `destination` with `{ type, id, url } | null`.
- `POST /api/responses/{item_id}/classification` accepts `{ "content_types": ["tool", "tutorial"] }`.
- `POST /api/responses/{item_id}/decision` accepts `{ "action": "not_processed" | "reset", "reason": string }`.
- `POST /api/responses/{item_id}/destination` accepts:

```json
{
  "destination": "draft" | "creative_asset",
  "analysis_run_id": 123,
  "directory": "工具"
}
```

- `create_or_get_destination(db, *, item, run, destination, directory) -> dict` locks the item, verifies the selected successful run, returns the existing destination on a repeated identical request, and otherwise creates exactly one existing-system record.

- [ ] **Step 1: Add router contract tests for the new routes.**

```python
def test_intelligence_station_routes_are_exposed():
    paths = {route.path for route in router.routes}
    assert "/responses/{item_id}/classification" in paths
    assert "/responses/{item_id}/destination" in paths
    assert "/responses/{item_id}/decision" in paths
```

Run: `cd backend && /home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_responses_router_contract.py -q`

Expected: FAIL until the new routes are registered.

- [ ] **Step 2: Add source normalization tests.**

For an X item, detail must return the complete `XPost.content` and `raw_markdown`. For a YouTube item, detail must return title, description, transcript status/language/text/segments/error, and URL. A missing source body returns metadata and URL with an explicit unavailable state; it never fabricates text. The list response must not include `content`, `raw_markdown`, or `transcript_text`.

- [ ] **Step 3: Implement normalized detail payloads and filtered counts.**

Create `_source_payload()` in `responses.py` or a small private helper that loads `XPost`/`YoutubeVideo` only for detail. Use the same normalized source shape for the worker context, but omit publish-account data from the new worker context. Add `content_type` filtering against `ContentResponseItem.content_types`, use score descending as the default ordering, and calculate disposition counts using the active source/search/content-type filters without adding full source data to list rows.

- [ ] **Step 4: Implement the deterministic handoff builders.**

`backend/content_response_handoff.py` must create these exact seeds:

```markdown
# {suggested_title}

## 核心判断
{core_thesis}

## 主要价值点
- {value_point}

## 建议结构
1. {suggested_structure_item}

## 目标读者
{target_reader}

## 风险与待核验
- {risk_or_verification_item}
```

The draft uses `topic_id = f"response:{item.id}"`, `draft_type = "article"`, `status = "drafting"`, and source entries `{url, title, note}`. The asset uses `asset_type = "article"`, `source = "response"`, the selected article directory or `""`, the original URL, Intelligence Station/type tags, and a Markdown body with separate `## 原文快照` and `## AI评价快照` sections. Preserve the full available source text in the snapshot.

- [ ] **Step 5: Implement destination validation and idempotency.**

Reject a missing item, missing current run, stale `analysis_run_id`, non-successful analysis, unavailable source body, invalid destination, or a second destination type while the item already has a destination with HTTP 409. On the first successful handoff, set `decision_status` to `worth_writing` or `creative_asset`, set the typed link, write `destination_created`, and commit the source/evaluation snapshot atomically. Do not call `create_outputs()`, create `ContentResponseOutput`, enqueue a `ContentJob`, or invoke a publish API.

- [ ] **Step 6: Add API integration tests for all handoff paths.**

Cover draft creation, creative asset directory selection, repeated identical POST returning the same ID, stale run rejection, failed-analysis rejection, missing-source behavior, not-processed/reset history events, and no new `ContentResponseOutput`/`content_response_output` job.

- [ ] **Step 7: Run backend integration tests and commit.**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_content_response_handoff.py tests/test_responses_router.py tests/test_responses_router_contract.py tests/test_responses_worker_context.py -q
cd ..
git add backend/content_response_handoff.py backend/routers/responses.py backend/tests/test_content_response_handoff.py backend/tests/test_responses_router.py backend/tests/test_responses_router_contract.py backend/tests/test_responses_worker_context.py
git commit -m "feat: add intelligence station source and destination APIs"
```

---

## Task 5: Replace frontend response types and build the source-first workbench

**Files:**
- Create: `wemedia-studio/app/responses/ResponseSourcePane.tsx`
- Create: `wemedia-studio/app/responses/ResponseEvaluationPane.tsx`
- Create: `wemedia-studio/app/responses/ResponseDestinationDialog.tsx`
- Modify: `wemedia-studio/lib/api/responses.ts`
- Modify: `wemedia-studio/app/responses/page.tsx`
- Modify: `wemedia-studio/app/responses/ResponsesClient.tsx`
- Modify: `wemedia-studio/app/responses/ResponsesClient.test.tsx`
- Modify: `wemedia-studio/components/features/Sidebar.tsx`
- Modify: `wemedia-studio/app/x-responses/x-responses-layout.test.tsx`

**Interfaces:**
- `ResponseDisposition = 'pending' | 'worth_writing' | 'creative_asset' | 'not_processed'`.
- `ContentType = 'tool' | 'industry_update' | 'case' | 'tutorial' | 'research'`.
- `ResponseSource` exposes `content`, `raw_markdown`, `description`, and transcript metadata as optional source-specific fields.
- `ResponseDetail` exposes `source`, `content_types`, `destination`, and the new analysis fields.
- `createResponseDestination(id, body)` calls `/responses/{id}/destination`.
- `updateResponseClassification(id, contentTypes)` calls `/responses/{id}/classification`.
- `decideResponse(id, 'not_processed' | 'reset', reason)` calls the existing decision route with the new actions.

- [ ] **Step 1: Replace API types and add fetch helpers.**

Remove the new-client dependency on `ResponseOutput`, `recommended_output_types`, `comment_angles`, `personal_angles`, and account-score tabs. Keep legacy types only in the compatibility client, not in `ResponsesClient.tsx`.

- [ ] **Step 2: Add failing component tests for the workbench contract.**

```tsx
it('renders the original source and AI evaluation together', async () => {
  render(<ResponsesClient initialItems={[item]} initialTotal={1} accounts={[]} initialSelectedId={item.id} initialSource="" />)
  expect(await screen.findByRole('heading', { name: item.source_title })).toBeInTheDocument()
  expect(screen.getByText('原文')).toBeInTheDocument()
  expect(screen.getByText('AI 评价')).toBeInTheDocument()
  expect(screen.queryByText('评论')).not.toBeInTheDocument()
  expect(screen.queryByText('回复')).not.toBeInTheDocument()
})
```

Add test fixtures containing both a complete X body and a complete YouTube transcript. Assert that the source pane has an independent overflow container and the evaluation pane renders score, recommendation, content types, reasons, evidence, risks, and suggested angle.

- [ ] **Step 3: Implement `ResponseSourcePane`.**

Render source metadata and an `打开原文` link, then render the complete available X content/Markdown or YouTube transcript. Use `max-h`/`overflow-y-auto` on the source reading region and do not use tabs to hide the evaluation pane. Show an explicit unavailable message with the original link when the body is missing.

- [ ] **Step 4: Implement `ResponseEvaluationPane`.**

The first screen must show the 0–100 content value score, recommended destination, editable content-type tags, why it matters, evidence, risks/verification, and suggested angle. Put dimensions and analysis history behind expandable sections. Do not render comment/reply/quote labels, output badges, publish-account selection, or account-fit controls.

- [ ] **Step 5: Refactor `ResponsesClient` around stable selection identity.**

Keep `selectedIdRef`, detail request generation, and destination-session identity checks. Add status-first filters (`待判断`, `值得写`, `创作资产`, `暂不处理`), source filters (`全部`, `X`, `YouTube`), content-type filter, search, and score/newest sort. The list cards show score, disposition, title, source/time, type tags, and one-line editorial judgment. Preserve the selected item after list refresh when it still exists; otherwise select the first visible item.

- [ ] **Step 6: Rename navigation and compatibility wording.**

Change the sidebar label to `情报站`, use the existing `/responses` route, and keep `/x-responses` redirecting to `/responses?source_type=x_post`. Update the static layout test to assert `情报站` and the absence of `待响应` in the main navigation.

- [ ] **Step 7: Run focused frontend tests and commit the workbench.**

```bash
cd wemedia-studio
pnpm exec vitest run app/responses/ResponsesClient.test.tsx app/x-responses/x-responses-layout.test.tsx
pnpm exec eslint app/responses lib/api/responses.ts components/features/Sidebar.tsx
cd ..
git add app/responses/ResponseSourcePane.tsx app/responses/ResponseEvaluationPane.tsx app/responses/ResponseDestinationDialog.tsx app/responses/ResponsesClient.tsx app/responses/ResponsesClient.test.tsx app/responses/page.tsx lib/api/responses.ts components/features/Sidebar.tsx app/x-responses/x-responses-layout.test.tsx
git commit -m "feat: build intelligence station source-first workbench"
```

---

## Task 6: Add centered destination dialogs and open the existing workspaces

**Files:**
- Modify: `wemedia-studio/app/responses/ResponseDestinationDialog.tsx`
- Modify: `wemedia-studio/app/responses/ResponsesClient.tsx`
- Modify: `wemedia-studio/app/responses/ResponsesClient.test.tsx`
- Modify: `wemedia-studio/app/assets/page.tsx`
- Modify: `wemedia-studio/app/assets/AssetsClient.tsx`
- Modify: `wemedia-studio/app/drafts/page.tsx`

**Interfaces:**
- `ResponseDestinationDialogProps` receives `open`, `destination`, `detail`, `directories`, `busy`, `error`, `onOpenChange`, and `onConfirm`.
- `onConfirm` receives `{ destination: 'draft' | 'creative_asset'; analysis_run_id: number; directory: string | null }`.
- Draft destination URL is `/drafts?draft={draft_id}`.
- Creative asset destination URL is `/assets?selected={asset_id}`.

- [ ] **Step 1: Add dialog behavior tests before implementation.**

Cover these exact interactions:

```tsx
it('shows draft seed confirmation without a publish action', async () => {
  await user.click(screen.getByRole('button', { name: '值得写' }))
  expect(screen.getByRole('dialog')).toHaveTextContent('不会自动发布')
  expect(screen.getByRole('dialog')).toHaveTextContent('结构化草稿种子')
  expect(screen.queryByRole('button', { name: /发布/ })).not.toBeInTheDocument()
})

it('keeps the asset dialog open and retryable after a destination failure', async () => {
  api.createResponseDestination.mockRejectedValueOnce(new Error('保存失败'))
  await user.click(screen.getByRole('button', { name: '创作资产' }))
  await user.click(screen.getByRole('dialog').querySelector('button[type="submit"]')!)
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败')
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})
```

- [ ] **Step 2: Implement the standard centered `Dialog`.**

For `值得写`, show suggested title, destination, carried fields, and the explicit no-publish statement. For `创作资产`, load `listCreativeAssetDirectories('article')`, show an optional directory selector, and explain that original and AI-evaluation snapshots will be saved. Disable the submit button while the request is in flight and keep the dialog open on failure.

- [ ] **Step 3: Implement destination submission with the existing race guards.**

Capture the selected response ID, detail object identity, and current analysis run before submitting. Ignore a response that belongs to a different selection/session. On success, refresh the detail, update the list, show the destination link, and close the dialog. On failure, leave the disposition pending and leave the dialog retryable. Repeated same-tick clicks must result in one API call.

- [ ] **Step 4: Add direct not-processed/reset controls.**

`暂不处理` must not open a dialog. It calls the new decision action and keeps the item in history. The reset icon returns it to `待判断`. Do not show a reason input as a generic comment-like field; if a reason is retained, label it as an optional editorial note and send it only for `not_processed`.

- [ ] **Step 5: Support opened draft/asset destinations.**

Pass `initialDraftId` from `app/drafts/page.tsx` into `DraftsClient` as already supported. Add `selected?: string` to `app/assets/page.tsx`, pass it to `AssetsClient`, initialize `selectedId` from it when the asset exists, and keep existing directory filtering behavior intact.

- [ ] **Step 6: Run frontend dialog and workspace tests and commit.**

```bash
cd wemedia-studio
pnpm exec vitest run app/responses/ResponsesClient.test.tsx app/assets/AssetsClient.test.tsx app/drafts/DraftsClient.test.tsx
pnpm exec eslint app/responses app/assets/page.tsx app/assets/AssetsClient.tsx app/drafts/page.tsx
cd ..
git add app/responses/ResponseDestinationDialog.tsx app/responses/ResponsesClient.tsx app/responses/ResponsesClient.test.tsx app/assets/page.tsx app/assets/AssetsClient.tsx app/drafts/page.tsx
git commit -m "feat: add intelligence station destination dialogs"
```

---

## Task 7: Add end-to-end acceptance coverage and remove reachable comment UI

**Files:**
- Create: `wemedia-studio/e2e/intelligence-station.spec.ts`
- Modify: `wemedia-studio/app/responses/ResponsesClient.test.tsx`
- Modify: `wemedia-studio/lib/ai/content-response-job.test.ts`
- Modify: `backend/tests/test_x_response_end_to_end.py` only where the old new-flow assumption conflicts with the unified X cutover
- Modify: `backend/tests/test_content_jobs.py` if old flow registration assertions require marking old jobs as compatibility-only

- [ ] **Step 1: Add browser acceptance fixtures and navigation.**

Use `page.route()` fixtures for `/api/responses`, `/api/responses/{id}`, `/api/assets/directories?asset_type=article`, `/api/responses/{id}/destination`, and `/api/responses/{id}/decision`; this keeps the browser test deterministic and records every request body. Visit `/responses`, assert the title `情报站`, assert the status-first rail, and assert the default score ordering.

- [ ] **Step 2: Exercise the X item through all three decisions.**

Verify the original X text and AI evaluation are visible simultaneously, edit content-type tags, create a draft seed through `值得写`, open `/drafts?draft={id}`, return to the station, reset if needed, and mark an item `暂不处理`. Assert that no publish request and no output-generation request occurred.

- [ ] **Step 3: Exercise the YouTube item as a creative asset.**

Verify the complete transcript remains visible while the evaluation is shown, choose an article asset directory in the centered dialog, create the asset, open `/assets?selected={id}`, and assert that the saved content contains both `原文快照` and `AI评价快照`.

- [ ] **Step 4: Add failure and concurrency acceptance cases.**

Assert that a failed destination leaves the item pending and the dialog open; two rapid confirmations create one destination; a stale analysis run returns 409; and a missing source body shows metadata/link without fabricated source text.

- [ ] **Step 5: Scan reachable source for removed product controls.**

Run a targeted search over `app/responses`, `lib/api/responses.ts`, and `lib/ai/content-response-job.ts` and assert the new flow has no `comment_angles`, `x_reply`, `x_quote`, `回复`, `评论`, or `转为选题` labels. Legacy compatibility files may contain historical names, but they must not be imported by the new Intelligence Station client.

- [ ] **Step 6: Run the complete verification set.**

```bash
cd backend && /home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_content_response_models.py tests/test_content_response_service.py tests/test_database_content_response_migration.py tests/test_content_response_handoff.py tests/test_responses_router.py tests/test_responses_router_contract.py tests/test_responses_worker_context.py tests/test_x_router.py tests/test_x_notify_scout.py -q
cd ../wemedia-studio && pnpm exec vitest run app/responses lib/ai/content-response-job.test.ts app/assets/AssetsClient.test.tsx app/drafts/DraftsClient.test.tsx
pnpm exec tsc --noEmit --incremental false
pnpm exec eslint app/responses lib/api/responses.ts lib/ai/content-response-job.ts app/assets/page.tsx app/assets/AssetsClient.tsx app/drafts/page.tsx components/features/Sidebar.tsx
pnpm exec playwright test e2e/intelligence-station.spec.ts --project=chromium
```

- [ ] **Step 7: Commit the acceptance and cleanup work.**

```bash
cd ..
git add backend/tests/test_x_response_end_to_end.py backend/tests/test_content_jobs.py wemedia-studio/e2e/intelligence-station.spec.ts wemedia-studio/app/responses/ResponsesClient.test.tsx wemedia-studio/lib/ai/content-response-job.test.ts
git commit -m "test: verify intelligence station triage flow"
```

---

## Final handoff checklist

- [ ] `情报站` is the only reachable unified inbox label; `/x-responses` redirects to it with the X filter.
- [ ] New X and YouTube items use `content_response_analysis` and arrive as `待判断`.
- [ ] The default list sort is score descending, with newest as an explicit alternative.
- [ ] Original source and AI evaluation are visible together; source content has its own scroll region.
- [ ] Content types can be filtered and manually corrected independently of destination.
- [ ] `值得写` creates one structured `ArticleDraft` seed and opens the draft workspace.
- [ ] `创作资产` creates one article `CreativeAsset` containing original/evaluation snapshots and opens the asset workspace.
- [ ] `暂不处理` and reset preserve history and never delete the source.
- [ ] No new comment/reply/quote output rows, output jobs, or publishing calls are created.
- [ ] Repeated destination submission is idempotent and stale analysis is rejected.
- [ ] Existing unrelated worktree changes remain unstaged and untouched.

# Intelligence Center Multi-Platform Writing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users multi-select X short post, X Article, and WeChat article targets from “值得写”, then create independent Agent jobs and independently tagged drafts for every selection, including intentional repeated generations.

**Architecture:** Extend the existing `content_response_output` pipeline rather than adding a second writing path. The response API creates one durable output/job per selected target, the Node Agent receives a target-to-draft mapping and persists through `save_draft`, and the existing draft list renders the resulting `draft_type` badge. Each output remains the source of truth for its own draft link; the legacy single `destination_id` remains compatibility-only.

**Tech Stack:** FastAPI, SQLAlchemy async, PostgreSQL/SQLite tests, Next.js App Router, React 19, TypeScript, Vercel AI SDK, shadcn/ui, Vitest, Testing Library, pytest.

## Global Constraints

- Initial targets are exactly `x_short_post`, `x_article`, and `wechat_article`.
- Target-specific writing rules belong to Agent Skills, not application prompts or UI code.
- Every selected target creates an independent output, job, and draft.
- A later request may intentionally create the same target again; only duplicates inside one request are collapsed.
- Draft markers are `x`, `x_article`, and `mp` respectively and never restrict publishing accounts.
- No writing flow publishes automatically.
- Historical response output types remain readable.

---

### Task 1: Durable output creation and independent draft linking

**Files:**
- Modify: `backend/content_response_service.py`
- Modify: `backend/routers/responses.py`
- Modify: `backend/tests/test_responses_router.py`

**Interfaces:**
- Consumes: `create_outputs(db, item, analysis_run_id, publish_account_id, output_types)` and existing `/responses/{id}/outputs`, `/outputs/{id}/worker-link` routes.
- Produces: `WRITING_TARGETS: dict[str, dict[str, str]]`; one new `ContentResponseOutput` per unique target per request; target-specific draft validation.

- [ ] **Step 1: Write failing router tests for three targets and intentional repeats**

Add a test that posts all three target literals and asserts three different output ids/job ids, then posts `x_short_post` again and asserts a fourth output and job are created. In the first payload include `x_short_post` twice and assert it appears only once.

```python
payload = {
    "analysis_run_id": run_id,
    "output_types": ["x_short_post", "x_article", "wechat_article", "x_short_post"],
}
first = client.post(f"/api/responses/{item_id}/outputs", json=payload)
assert [row["output_type"] for row in first.json()["outputs"]] == [
    "x_short_post", "x_article", "wechat_article",
]
second = client.post(
    f"/api/responses/{item_id}/outputs",
    json={"analysis_run_id": run_id, "output_types": ["x_short_post"]},
)
assert second.json()["outputs"][0]["created"] is True
assert second.json()["outputs"][0]["id"] not in {
    row["id"] for row in first.json()["outputs"]
}
```

- [ ] **Step 2: Run the router test and verify the old allowlist/deduplication fails**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_responses_router.py -k 'multi_platform or repeat_target' -q
```

Expected: FAIL because the new output types are rejected or the second request reuses an existing output.

- [ ] **Step 3: Implement target allowlisting and request-scoped deduplication**

Add the target metadata next to `OUTPUT_TYPES` and include its keys in the accepted set:

```python
WRITING_TARGETS = {
    "x_short_post": {"label": "X 短帖", "draft_type": "x"},
    "x_article": {"label": "X Article", "draft_type": "x_article"},
    "wechat_article": {"label": "公众号文章", "draft_type": "mp"},
}
OUTPUT_TYPES = LEGACY_OUTPUT_TYPES | WRITING_TARGETS.keys()
```

Keep `dict.fromkeys(output_types)` for a single request, but remove the historical-output lookup for the new targets so each request inserts a fresh output/job. New writing targets must persist `publish_account_id=None`; historical types retain their current compatibility behavior.

- [ ] **Step 4: Write failing worker-link tests for every draft marker and multiple destinations**

For each `(output_type, draft_type)` literal pair, create an output and a real draft, call `worker-link`, and assert the output links to that draft. Link a second output for the same item and assert it succeeds even though `ContentResponseItem.destination_id` already points to the first draft. Add one mismatch assertion returning 422.

- [ ] **Step 5: Run the new link tests and verify they fail on the article-only gate**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_responses_router.py -k 'platform_draft or multiple_output_drafts' -q
```

Expected: FAIL with `worker link requires an article output` or `article draft`.

- [ ] **Step 6: Generalize worker result/link handling**

Resolve the expected draft type from `WRITING_TARGETS`, while retaining `article` for legacy `expanded_article` and `commentary`. Validate the linked draft against that literal. Set the item’s legacy destination only when none exists; never reject a second output because another draft is already the compatibility destination. Ensure each output remains idempotent once `article_draft_id` is set.

- [ ] **Step 7: Run the complete focused backend suite**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_responses_router.py backend/tests/test_content_response_models.py -q
```

Expected: PASS.

### Task 2: Target-aware Agent objective and persistence contract

**Files:**
- Modify: `wemedia-studio/lib/ai/content-response-output-job.ts`
- Modify: `wemedia-studio/lib/ai/content-response-output-job.test.ts`

**Interfaces:**
- Consumes: `context.output.output_type`, Agent runtime Skill tools, and `save_draft`.
- Produces: `responseWritingTarget(outputType)` and a target-aware `buildResponseArticleAgentObjective` that requires the exact `draft_type` without embedding platform prose rules.

- [ ] **Step 1: Write failing table-driven objective tests**

Use literal expected values so changing the mapping breaks the test:

```ts
it.each([
  ['x_short_post', 'X 短帖', 'x'],
  ['x_article', 'X Article', 'x_article'],
  ['wechat_article', '公众号文章', 'mp'],
])('targets %s and saves draft type %s', (outputType, label, draftType) => {
  const objective = buildResponseArticleAgentObjective({
    ...context,
    output: { ...context.output, output_type: outputType },
  }, 41)
  expect(objective).toContain(`目标内容形态：${label}`)
  expect(objective).toContain(`draft_type="${draftType}"`)
  expect(objective).toContain('自主判断并加载相关 Skill')
})
```

Also assert the Objective does not contain platform-specific fixed limits such as `280 字符` or forced section counts.

- [ ] **Step 2: Run the Agent test and verify it fails on the fixed article objective**

Run:

```bash
pnpm exec vitest run lib/ai/content-response-output-job.test.ts
```

Expected: FAIL because every objective currently requires `draft_type="article"` and generic full-article prose.

- [ ] **Step 3: Implement the target metadata and generic writing objective**

Add a target resolver with historical fallbacks. Build the objective from target label and draft type, preserving the source, analysis, attribution, no-fabrication, no-publishing, one-`save_draft`, and automatic Skill-discovery contracts. Do not add target writing guidance beyond the target name.

- [ ] **Step 4: Verify Agent execution and recovery remain green**

Run:

```bash
pnpm exec vitest run lib/ai/content-response-output-job.test.ts
```

Expected: PASS, including prose-only failure, saved tool evidence, worker linking, and restart recovery tests.

### Task 3: Multi-select “值得写” interaction and per-output status

**Files:**
- Create: `wemedia-studio/app/responses/ResponseWritingDialog.tsx`
- Modify: `wemedia-studio/app/responses/ResponsesClient.tsx`
- Modify: `wemedia-studio/app/responses/ResponsesClient.test.tsx`
- Modify: `wemedia-studio/lib/api/responses.ts`

**Interfaces:**
- Consumes: `createResponseOutputs(id, { analysis_run_id, output_types })`.
- Produces: `WRITING_TARGET_OPTIONS`, a controlled dialog returning `ResponseOutputType[]`, and output labels for status cards.

- [ ] **Step 1: Write failing React tests for the dialog workflow**

Assert that clicking “值得写” opens a dialog, submit is disabled with no target selected, selecting X 短帖 and公众号文章 submits these literal output types, and reopening/submitting X 短帖 calls the API again. Assert shortcut `1` opens the same dialog rather than immediately calling the API.

- [ ] **Step 2: Run the focused React test and verify it fails**

Run:

```bash
pnpm exec vitest run app/responses/ResponsesClient.test.tsx
```

Expected: FAIL because “值得写” currently immediately submits `expanded_article`.

- [ ] **Step 3: Implement the focused client dialog**

Create a client component using the installed shadcn `Dialog`, `FieldSet`, `FieldLegend`, `FieldGroup`, `Field`, `Checkbox`, and `Button`. Keep the target option array at module scope. Reset selection whenever the dialog opens for a new submission; require at least one selection; pass a deduplicated target array to `onConfirm`.

Update `ResponsesClient` so button and shortcut open the dialog. Reuse its existing session identity/busy guards for submission, refresh detail/list after success, and leave the dialog open with an alert on failure. Do not fetch creative-asset directories for this dialog.

- [ ] **Step 4: Render every writing output with its own label and draft link**

Extend `ResponseOutputType` with the three new literals and add a literal label mapping. Render all writing-target outputs (and historical `expanded_article`) instead of filtering to one fixed type. `WritingJobStatus` must show the target label in pending, failed, and ready states and link `article_draft_id` directly.

- [ ] **Step 5: Run response UI tests**

Run:

```bash
pnpm exec vitest run app/responses/ResponsesClient.test.tsx app/responses/ResponsesWorkspace.test.tsx
```

Expected: PASS.

### Task 4: Draft platform badges and completion verification

**Files:**
- Modify: `wemedia-studio/lib/api/drafts.ts`
- Modify: `wemedia-studio/app/drafts/DraftsClient.test.tsx`
- Test: `wemedia-studio/app/drafts/DraftsClient.tsx`

**Interfaces:**
- Consumes: persisted `ArticleDraft.draft_type`.
- Produces: visible labels for `x`, `x_article`, and `mp` with no publishing restrictions.

- [ ] **Step 1: Write a failing badge rendering test**

Render independent drafts with `draft_type` values `x`, `x_article`, and `mp`; select each and assert the visible badge reads `X 短帖`, `X Article`, and `公众号文章` respectively. Do not assert or alter publishing-account options.

- [ ] **Step 2: Run the draft test and verify the missing/old label failure**

Run:

```bash
pnpm exec vitest run app/drafts/DraftsClient.test.tsx
```

Expected: FAIL because `x` currently renders `X` and `x_article` is unknown.

- [ ] **Step 3: Add the two exact draft type labels**

Change the existing `x` label to `X 短帖`, add `x_article` with a distinct semantic badge style, and change `mp` to the agreed `公众号文章`. Do not change publish panels or account filtering.

- [ ] **Step 4: Run all focused tests and static checks**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_responses_router.py backend/tests/test_content_response_models.py -q
pnpm exec vitest run lib/ai/content-response-output-job.test.ts app/responses/ResponsesClient.test.tsx app/responses/ResponsesWorkspace.test.tsx app/drafts/DraftsClient.test.tsx
pnpm exec eslint app/responses lib/api/responses.ts lib/ai/content-response-output-job.ts app/drafts/DraftsClient.tsx lib/api/drafts.ts
pnpm build
```

Expected: every focused test and lint target passes; the production build completes or any unrelated baseline blocker is reported with exact evidence.

- [ ] **Step 5: Verify the real local flow without publishing**

Using the running local API and worker, select an existing analyzed intelligence item and submit at least two new targets. Verify distinct output/job ids in `GET /api/responses/{id}`, wait for each terminal state, and verify every successful output links to a distinct draft whose `draft_type` matches the target. Do not invoke any publish endpoint.

- [ ] **Step 6: Review the final diff and commit implementation**

Run:

```bash
git diff --check
git status --short
git diff --stat
```

Then commit only the feature files with message:

```bash
git commit -m "feat: add multi-platform intelligence writing"
```

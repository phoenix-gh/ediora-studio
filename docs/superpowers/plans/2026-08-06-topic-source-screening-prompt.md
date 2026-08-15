# X 主题素材筛选补充要求 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Add a per-directory supplemental AI screening instruction to X topic-source rules and pass it through the existing asset-ingestion worker without changing the accept/reject output contract.

**Architecture:** Persist `screening_prompt` on `TopicSourceRule`, expose it through the existing asset-rule API, and edit it in the existing X “配置素材入库” dialog. The topic-source worker will include the saved text as a bounded supplemental instruction while retaining fixed system instructions and `accepted_tweet_ids` parsing.

**Tech Stack:** FastAPI/Pydantic, SQLAlchemy async SQLite/PostgreSQL migrations, Next.js/React, Vitest, pytest, AI SDK.

## Global Constraints

- The supplemental text only refines whether a post belongs in the configured directory; it cannot change directory routing, keyword candidate filtering, duplicate checks, or persistence semantics.
- The worker must continue to accept only `{ "accepted_tweet_ids": string[] }`.
- Existing rules default to an empty supplemental prompt and must behave as before.
- Do not reprocess posts that already have a `TopicSourceDecision`.
- Only modify files in the X topic-source ingestion chain; preserve all unrelated worktree changes.

### Task 1: Persist and expose the rule field

**Files:**
- Modify: `backend/models.py:1072-1090`
- Modify: `backend/routers/assets.py:70-105,246-300`
- Modify: `backend/database.py:990-1005`
- Test: `backend/tests/test_asset_directories_router.py`
- Test: `backend/tests/test_topic_source_rule_migration.py`

**Interfaces:**
- API input/output field: `screening_prompt: str`, default `""`, maximum 4000 characters.
- SQL column: `topic_source_rules.screening_prompt TEXT NOT NULL DEFAULT ''`.

- [ ] **Step 1: Write the failing API assertions**

Add a test that creates a topic rule with `screening_prompt`, asserts the response returns the trimmed value, patches the value, and asserts `GET /api/assets/topic-rules` returns the updated value. Add an assertion that a rule created without the field returns `""`.

- [ ] **Step 2: Run the focused backend test to verify it fails**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_asset_directories_router.py -k topic_rule -q
```

Expected: FAIL because the API schema and model do not expose `screening_prompt`.

- [ ] **Step 3: Add the model, API schemas, normalization, and migration**

Add:

```python
# backend/models.py
screening_prompt: Mapped[str] = mapped_column(Text, default="")
```

Extend the create, patch, and output Pydantic models with `Field(default="", max_length=4000)` / optional equivalent. In create and patch handlers, store `body.screening_prompt.strip()` when supplied. Add the idempotent migration:

```python
await _add_columns(conn, "topic_source_rules", {
    "screening_prompt": "TEXT NOT NULL DEFAULT ''",
})
```

Place it after `Base.metadata.create_all()` and before normal rule use so old databases receive the column on startup.

- [ ] **Step 4: Run the focused backend tests to verify they pass**

Run the command from Step 2 and:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_topic_source_rule_migration.py -q
```

Expected: all selected tests pass, including the existing single-directory migration behavior and the new default/round-trip field behavior.

### Task 2: Include the supplemental requirement in the AI request

**Files:**
- Modify: `web/lib/ai/topic-source-job.ts`
- Test: `web/lib/ai/topic-source-job.test.ts`

**Interfaces:**
- Candidate context rule shape: `{ directory: string; keywords: string[]; screening_prompt: string }`.
- New pure helper: `buildTopicSourceInstructions(screeningPrompt: string): string`.

- [ ] **Step 1: Write failing prompt-construction tests**

Add tests asserting the helper includes a configured supplemental requirement, clearly labels it as user configuration, and repeats the fixed JSON-only contract after the dynamic text. Add a blank-input assertion that the existing baseline wording remains present.

- [ ] **Step 2: Run the focused worker test to verify it fails**

Run:

```bash
cd web && pnpm exec vitest run lib/ai/topic-source-job.test.ts
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement the bounded instruction builder and context type**

Extend the API response type with `screening_prompt`. Build the fixed instructions with the supplemental text in a delimited section, then end with an immutable reminder to return only valid JSON containing `accepted_tweet_ids`. Keep the raw X post content in the JSON prompt as before. Do not interpolate the supplemental text into the output parser or allow it to select arbitrary tools.

- [ ] **Step 4: Run the focused worker test to verify it passes**

Run the command from Step 2. Expected: all topic-source worker tests pass.

### Task 3: Add the setting to the X configuration dialog

**Files:**
- Modify: `web/lib/api/assets.ts:16-19`
- Modify: `web/app/x/XClient.tsx:22,539-582,830-855`
- Test: `web/app/x/XClient.test.tsx`

**Interfaces:**
- `TopicSourceRule` includes `screening_prompt: string`.
- Create/update API payloads accept `screening_prompt`.
- Existing dialog remains the only configuration surface.

- [ ] **Step 1: Write the failing dialog assertions**

Add a test fixture with a rule containing `screening_prompt`, open the configuration dialog, assert the textarea labeled “AI 筛选要求” shows the saved value, edit it, and assert the create/update payload includes the trimmed value. Keep the existing behavior for no configured rule covered by an empty field.

- [ ] **Step 2: Run the focused frontend test to verify it fails**

Run:

```bash
cd web && pnpm exec vitest run app/x/XClient.test.tsx
```

Expected: FAIL because the API type, dialog state, and field are not present.

- [ ] **Step 3: Implement the API type and dialog field**

Add `screening_prompt` to the `TopicSourceRule` type and create/update payload types. Extend dialog state and load/save logic, trim the value before sending, and render a `Textarea` below the keyword input with the label “AI 筛选要求” and an example placeholder. Preserve the current dialog and toast behavior.

- [ ] **Step 4: Run the focused frontend test to verify it passes**

Run the command from Step 2. Expected: all X client tests pass.

### Task 4: Regression verification

**Files:**
- No new product files.

- [ ] **Step 1: Run the complete focused backend topic-source suite**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  backend/tests/test_asset_directories_router.py \
  backend/tests/test_topic_source_rule_migration.py \
  backend/tests/test_topic_source_service.py -q
```

- [ ] **Step 2: Run the complete focused frontend X suite**

```bash
cd web && pnpm exec vitest run app/x lib/ai/topic-source-job.test.ts
```

- [ ] **Step 3: Inspect the final diff**

```bash
git diff -- backend/models.py backend/routers/assets.py backend/database.py \
  web/lib/ai/topic-source-job.ts \
  web/lib/api/assets.ts web/app/x/XClient.tsx
```

Confirm that only the new rule field, migration, worker prompt boundary, dialog, and their tests are included; do not stage or alter unrelated worktree files.

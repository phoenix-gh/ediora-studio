# Daily Creation Multi-Directory Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow a daily creation rule to combine candidates from multiple same-type creative-asset directories while preserving existing single-directory rules and snapshots.

**Architecture:** Store the canonical selection in a JSON `directories` column and mirror its first value into the legacy `directory` column. Normalize both current and legacy shapes at API and service boundaries, query one combined candidate pool, and pass the normalized list through MCP, worker snapshots, persistence checks, and the frontend.

**Tech Stack:** FastAPI, Pydantic, SQLAlchemy async, PostgreSQL/SQLite migrations, FastMCP, Next.js, React, TypeScript, Vitest, Testing Library, pytest.

## Global Constraints

- A rule contains only `article` directories or only `media` directories.
- At least 1 and at most 50 unique non-blank directory names are allowed.
- Existing rows and snapshots containing only `directory` must remain executable.
- `directories` is authoritative when both `directories` and legacy `directory` are supplied.
- Candidate ordering and limit apply once across the combined pool; there is no per-directory quota.
- Selecting a directory does not recursively include descendants.
- Unknown AI or worker inputs fail closed rather than querying every asset.
- Preserve unrelated dirty-worktree changes and commit only task-owned files.

---

### Task 1: Persist and Normalize Directory Lists

**Files:**
- Modify: `backend/models.py`
- Modify: `backend/database.py`
- Modify: `backend/daily_creation_service.py`
- Test: `backend/tests/test_daily_creation_rule_schema.py`
- Test: `backend/tests/test_database_init_sqlite.py`

**Interfaces:**
- Produces: `DailyCreationRule.directories: list[str]` stored as JSON.
- Produces: `normalize_creation_directories(directories: object, directory: object = "") -> list[str]`.
- Preserves: `DailyCreationRule.directory: str`, mirrored from the first normalized entry.

- [ ] **Step 1: Write failing model and migration tests**

Add tests that create a legacy rule with only `directory="增长实验"`, initialize the schema twice, and assert the persisted/read representation normalizes to `["增长实验"]`. Add a test that `normalize_creation_directories([" A ", "B", "A"], "legacy")` returns `["A", "B"]` and rejects an empty result.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_daily_creation_rule_schema.py tests/test_database_init_sqlite.py -q
```

Expected: failures because the column and normalization helper do not exist.

- [ ] **Step 3: Implement the model, helper, and idempotent migration**

Add a mutable-safe JSON column:

```python
directories: Mapped[list[str]] = mapped_column(JSON, default=list)
```

Implement normalization that accepts a list/tuple or falls back to a non-empty legacy string, trims values, removes duplicates in order, enforces 1–50 values, and raises `ValueError("at least one directory is required")` otherwise. Extend both SQLite and PostgreSQL initialization paths to add `directories` idempotently and backfill legacy rows without overwriting non-empty arrays.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all selected tests pass.

- [ ] **Step 5: Commit Task 1**

```bash
git add backend/models.py backend/database.py backend/daily_creation_service.py backend/tests/test_daily_creation_rule_schema.py backend/tests/test_database_init_sqlite.py
git commit -m "feat: persist creation rule directory lists"
```

---

### Task 2: Validate Multi-Directory Rules and Snapshots

**Files:**
- Modify: `backend/routers/daily_plan.py`
- Modify: `backend/daily_creation_service.py`
- Test: `backend/tests/test_daily_creation_rules_router.py`
- Test: `backend/tests/test_daily_creation_service.py`

**Interfaces:**
- Consumes: `normalize_creation_directories` from Task 1.
- Produces: create/patch/response/run-context `directories: list[str]` plus legacy `directory: str`.
- Produces: candidate lookup and output validation against `directories`.

- [ ] **Step 1: Write failing router and service tests**

Cover:

```python
payload = {**recurring_payload(), "directories": ["目录甲", "目录乙"]}
assert response.json()["directories"] == ["目录甲", "目录乙"]
assert response.json()["directory"] == "目录甲"
```

Also assert cross-type or unknown names return HTTP 400 naming the offender; changing `asset_type` revalidates all directories; legacy `directory` payloads remain accepted; run snapshots contain both fields; combined candidates are globally ordered/limited; and persistence accepts an asset in either selected directory but rejects an outside asset.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_daily_creation_rules_router.py tests/test_daily_creation_service.py -q
```

Expected: multi-directory payload, merged query, and membership assertions fail.

- [ ] **Step 3: Implement API normalization and validation**

Add `directories: list[str] | None` to create/patch schemas while retaining legacy `directory`. Resolve the effective asset type and normalized directory list before mutation. Validate all names with one query constrained by `CreativeAssetDirectory.asset_type`; compare the returned set with the requested set and report the first missing name. Mirror `directories[0]` into `directory` and include both fields in `_rule_dict`, snapshots, and contexts.

- [ ] **Step 4: Implement combined candidate and persistence checks**

Change candidate loading to accept `directories: list[str]`, use:

```python
CreativeAsset.directory.in_(normalized_directories)
```

and retain one existing order/limit. Normalize historical snapshots before checking `asset.directory in allowed_directories`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the command from Step 2. Expected: all selected tests pass.

- [ ] **Step 6: Commit Task 2**

```bash
git add backend/routers/daily_plan.py backend/daily_creation_service.py backend/tests/test_daily_creation_rules_router.py backend/tests/test_daily_creation_service.py
git commit -m "feat: validate multi-directory creation rules"
```

---

### Task 3: Carry Directory Lists Through MCP and Worker Execution

**Files:**
- Modify: `backend/mcp_server.py`
- Modify: `backend/tests/test_mcp_daily_creation_tools.py`
- Modify: `wemedia-studio/lib/ai/daily-creation-job.ts`
- Modify: `wemedia-studio/lib/ai/content-job.test.ts`

**Interfaces:**
- MCP tool: `list_creative_asset_candidates(asset_type: str, directories: list[str] | None = None, directory: str = "", query: str = "", limit: int = 50)`.
- Worker run context: `rule.directories: string[]`, with `rule.directory` fallback.

- [ ] **Step 1: Write failing MCP and worker contract tests**

Assert the MCP tool merges candidates from two directories and still accepts the legacy `directory` argument. Add a worker-source contract test that verifies the tool call sends `directories: context.rule.directories` and does not silently send an empty list when only legacy `directory` exists.

- [ ] **Step 2: Run tests and verify RED**

```bash
/home/violet/miniconda3/envs/wems/bin/python -m pytest tests/test_mcp_daily_creation_tools.py -q
cd ../wemedia-studio && pnpm exec vitest run lib/ai/content-job.test.ts scripts/content-worker.test.ts
```

Expected: MCP signature and worker context assertions fail.

- [ ] **Step 3: Implement MCP and worker normalization**

Normalize `directories` with the legacy argument before calling the service. Extend `RunContext.rule`, calculate:

```ts
const directories = context.rule.directories?.length
  ? context.rule.directories
  : context.rule.directory ? [context.rule.directory] : []
```

Throw if the result is empty and pass it to the MCP tool. Include the list in AI prompts through the rule context.

- [ ] **Step 4: Run tests and verify GREEN**

Run the commands from Step 2. Expected: all selected tests pass.

- [ ] **Step 5: Commit Task 3**

```bash
git add backend/mcp_server.py backend/tests/test_mcp_daily_creation_tools.py wemedia-studio/lib/ai/daily-creation-job.ts wemedia-studio/lib/ai/content-job.test.ts
git commit -m "feat: execute creation rules across directories"
```

---

### Task 4: Add Accessible Multi-Select Rule UI

**Files:**
- Modify: `wemedia-studio/lib/api/daily-plan.ts`
- Modify: `wemedia-studio/app/daily-plan/CreationRuleDialog.tsx`
- Modify: `wemedia-studio/app/daily-plan/CreationRuleDialog.test.tsx`
- Create: `wemedia-studio/app/daily-plan/directory-summary.ts`
- Create: `wemedia-studio/app/daily-plan/directory-summary.test.ts`
- Modify: `wemedia-studio/app/daily-plan/CreationRulesPanel.tsx`
- Modify: `wemedia-studio/app/daily-plan/CreationRulesPanel.test.tsx`
- Modify: `wemedia-studio/app/daily-plan/CreationRunsPanel.tsx`
- Modify: `wemedia-studio/app/daily-plan/CreationRunsPanel.test.tsx`

**Interfaces:**
- `DailyCreationRule.directories: string[]` and legacy `directory: string`.
- `summarizeDirectories(directories: string[], legacyDirectory?: string): string`.

- [ ] **Step 1: Write failing dialog and summary tests**

Render three same-type directories and assert two checkboxes can be selected and submitted as `directories: ["目录甲", "目录乙"]`. Assert switching to `media` clears selections, submitting none reports `请选择至少一个素材目录`, and editing a legacy rule checks its single `directory`. Assert the summary returns `甲、乙、丙` for three names and `甲、乙、丙等 4 个目录` for four.

- [ ] **Step 2: Run frontend tests and verify RED**

```bash
pnpm exec vitest run app/daily-plan/CreationRuleDialog.test.tsx app/daily-plan/directory-summary.test.ts app/daily-plan/CreationRulesPanel.test.tsx app/daily-plan/CreationRunsPanel.test.tsx
```

Expected: missing array type, checkbox behavior, and summary helper failures.

- [ ] **Step 3: Implement API types and checkbox list**

Add `directories` to API types. Initialize state from a non-empty array or `[initial.directory]`. Render a bordered checkbox group filtered by `asset_type`, show `已选择 N 个目录`, toggle values in directory-list order, and clear the array when asset type changes. Keep `directory` mirrored to the first selection in submitted input for compatibility.

- [ ] **Step 4: Implement and use directory summaries**

Create a pure helper that normalizes the array with the legacy fallback, joins up to three names with `、`, and appends `等 N 个目录` when needed. Use it in rule cards and run records.

- [ ] **Step 5: Run frontend tests and verify GREEN**

Run the command from Step 2, then:

```bash
pnpm exec eslint app/daily-plan/CreationRuleDialog.tsx app/daily-plan/CreationRulesPanel.tsx app/daily-plan/CreationRunsPanel.tsx app/daily-plan/directory-summary.ts lib/api/daily-plan.ts
```

Expected: tests and lint pass.

- [ ] **Step 6: Commit Task 4**

```bash
git add wemedia-studio/lib/api/daily-plan.ts wemedia-studio/app/daily-plan/CreationRuleDialog.tsx wemedia-studio/app/daily-plan/CreationRuleDialog.test.tsx wemedia-studio/app/daily-plan/directory-summary.ts wemedia-studio/app/daily-plan/directory-summary.test.ts wemedia-studio/app/daily-plan/CreationRulesPanel.tsx wemedia-studio/app/daily-plan/CreationRulesPanel.test.tsx wemedia-studio/app/daily-plan/CreationRunsPanel.tsx wemedia-studio/app/daily-plan/CreationRunsPanel.test.tsx
git commit -m "feat: select multiple creation directories"
```

---

### Task 5: Cross-Layer Regression and Live Verification

**Files:**
- Modify only task-owned files if verification exposes a defect.

**Interfaces:**
- Verifies all interfaces from Tasks 1–4.

- [ ] **Step 1: Run the full relevant backend suite**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_daily_creation_rule_schema.py tests/test_database_init_sqlite.py \
  tests/test_daily_creation_service.py tests/test_mcp_daily_creation_tools.py \
  tests/test_daily_creation_rules_router.py tests/test_daily_creation_scheduler.py \
  tests/test_daily_plan_router.py tests/test_mcp_daily_plan_tools.py \
  tests/test_content_jobs.py -q
```

Expected: all selected backend tests pass.

- [ ] **Step 2: Run the full relevant frontend and worker suite**

```bash
cd wemedia-studio
pnpm exec vitest run \
  app/daily-plan/CreationRuleDialog.test.tsx \
  app/daily-plan/directory-summary.test.ts \
  app/daily-plan/CreationRulesPanel.test.tsx \
  app/daily-plan/CreationRunsPanel.test.tsx \
  app/daily-plan/DailyPlanClient.test.tsx \
  lib/ai/content-job.test.ts scripts/content-worker.test.ts
pnpm exec eslint app/daily-plan lib/api/daily-plan.ts lib/ai/daily-creation-job.ts
```

Expected: all selected frontend tests and lint pass.

- [ ] **Step 3: Verify migration and live combined execution**

Restart with `./dev.sh restart`. Create two uniquely prefixed article directories with distinct assets, create one temporary rule selecting both, run it, and inspect its `loadCandidates` job step. Assert candidates contain assets from both directories and the terminal run persists only selected assets. Delete the exact temporary rule, runs, ledger rows, drafts, assets, directories, and content jobs, then query each scoped set to confirm zero remains.

- [ ] **Step 4: Verify the rendered multi-select**

Because the Browser plugin is not available in this environment, use project Playwright to open `/daily-plan`, create or edit a temporary rule, select two directory checkboxes, and capture a screenshot after asynchronous data loads. Confirm selected count, wrapping, labels, and mobile-width usability. Remove the temporary data afterward.

- [ ] **Step 5: Check scope and commit any verification fix**

```bash
git diff --check
git status --short
```

Stage only task-owned paths. If verification required a code fix, commit it with `git commit -m "fix: harden multi-directory creation rules"`. Leave unrelated dirty-worktree files untouched.

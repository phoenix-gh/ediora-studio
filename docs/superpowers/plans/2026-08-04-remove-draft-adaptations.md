# Remove Draft Adaptations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove draft parent/adaptation relationships so every draft is independent while `draft_type` remains only a publishing-platform marker.

**Architecture:** An idempotent startup migration deletes legacy child adaptations, canonicalizes `x_post` to `x`, renames image ownership to `draft_id`, and drops `linked_draft_id`. Backend and frontend contracts then operate on flat draft collections; bounded bulk operations act directly on selected drafts.

**Tech Stack:** FastAPI, SQLAlchemy async, PostgreSQL, SQLite, pytest, Next.js 16, React 19, TypeScript, Vitest, Testing Library, Playwright.

## Global Constraints

- Delete every legacy child where `linked_draft_id IS NOT NULL`; preserve parents and independent drafts.
- Rename `draft_images.root_draft_id` to `draft_images.draft_id` without deleting surviving image rows.
- Normalize application-owned X draft markers from `x_post` to canonical `x`.
- Keep `draft_type` only as publishing-suitability metadata; it cannot gate cover or illustration generation.
- Remove “适配平台”, version tabs, main-version synchronization, and all root resolution.
- Preserve unrelated dirty-worktree changes and stage only files named by each task.
- Run backend tests with `/home/violet/miniconda3/envs/wems/bin/python -m pytest`.
- Use test-first red-green-refactor cycles for every behavior change.

---

### Task 1: Retire the adaptation schema safely

**Files:**
- Create: `backend/tests/test_database_draft_adaptation_removal.py`
- Modify: `backend/database.py`
- Modify: `backend/models.py`
- Modify: `backend/tests/test_database_init_sqlite.py`

**Interfaces:**
- Produces: `async def migrate_removed_draft_adaptation_schema(conn) -> None`.
- Produces: `DraftImage.draft_id: Mapped[int]` replacing `DraftImage.root_draft_id`.
- Consumed by: `init_db()` before `Base.metadata.create_all` and Task 2 image routes.

- [ ] **Step 1: Write the failing migration test**

Create a legacy SQLite schema, seed a parent, child, independent `x_post`, and image, then invoke the migration twice:

```python
def test_removes_adapted_children_and_legacy_columns_idempotently(tmp_path):
    from database import migrate_removed_draft_adaptation_schema

    engine = create_async_engine(
        f"sqlite+aiosqlite:///{tmp_path / 'draft-adaptation.db'}"
    )

    async def run():
        async with engine.begin() as connection:
            await connection.execute(text("""
                CREATE TABLE article_drafts (
                    id INTEGER PRIMARY KEY,
                    title VARCHAR NOT NULL,
                    draft_type VARCHAR NOT NULL,
                    linked_draft_id INTEGER
                )
            """))
            await connection.execute(text("""
                CREATE TABLE draft_images (
                    id INTEGER PRIMARY KEY,
                    root_draft_id INTEGER NOT NULL,
                    filename VARCHAR NOT NULL
                )
            """))
            await connection.execute(text("""
                INSERT INTO article_drafts VALUES
                    (10, 'parent', 'article', NULL),
                    (11, 'adapted', 'x', 10),
                    (12, 'daily X', 'x_post', NULL)
            """))
            await connection.execute(text("""
                INSERT INTO draft_images VALUES (1, 10, 'cover.png')
            """))

            await migrate_removed_draft_adaptation_schema(connection)
            await migrate_removed_draft_adaptation_schema(connection)

            drafts = (await connection.execute(text(
                "SELECT id, draft_type FROM article_drafts ORDER BY id"
            ))).all()
            article_columns = {
                column['name'] for column in await connection.run_sync(
                    lambda sync: inspect(sync).get_columns('article_drafts')
                )
            }
            image_columns = {
                column['name'] for column in await connection.run_sync(
                    lambda sync: inspect(sync).get_columns('draft_images')
                )
            }
            image = (await connection.execute(text(
                "SELECT id, draft_id FROM draft_images"
            ))).one()
        await engine.dispose()
        return drafts, article_columns, image_columns, image

    drafts, article_columns, image_columns, image = asyncio.run(run())
    assert drafts == [(10, 'article'), (12, 'x')]
    assert 'linked_draft_id' not in article_columns
    assert 'root_draft_id' not in image_columns
    assert 'draft_id' in image_columns
    assert image == (1, 10)
```

- [ ] **Step 2: Run the test and verify RED**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_database_draft_adaptation_removal.py -q
```

Expected: FAIL because the migration function does not exist.

- [ ] **Step 3: Implement the migration and register it before `create_all`**

```python
async def migrate_removed_draft_adaptation_schema(conn) -> None:
    """Delete retired child adaptations and flatten draft ownership."""
    from sqlalchemy import inspect, text

    tables = set(await conn.run_sync(
        lambda sync: inspect(sync).get_table_names()
    ))
    if "article_drafts" in tables:
        columns = {
            column["name"] for column in await conn.run_sync(
                lambda sync: inspect(sync).get_columns("article_drafts")
            )
        }
        if "linked_draft_id" in columns:
            if "draft_chat_logs" in tables:
                await conn.execute(text(
                    "DELETE FROM draft_chat_logs WHERE draft_id IN ("
                    "SELECT id FROM article_drafts "
                    "WHERE linked_draft_id IS NOT NULL)"
                ))
            if "content_usage_ledger" in tables:
                await conn.execute(text(
                    "DELETE FROM content_usage_ledger "
                    "WHERE output_kind = 'draft' AND draft_id IN ("
                    "SELECT id FROM article_drafts "
                    "WHERE linked_draft_id IS NOT NULL)"
                ))
            await conn.execute(text(
                "DELETE FROM article_drafts WHERE linked_draft_id IS NOT NULL"
            ))
        await conn.execute(text(
            "UPDATE article_drafts SET draft_type = 'x' "
            "WHERE draft_type = 'x_post'"
        ))
        if "linked_draft_id" in columns:
            suffix = " IF EXISTS" if conn.dialect.name == "postgresql" else ""
            await conn.execute(text(
                f"ALTER TABLE article_drafts DROP COLUMN{suffix} linked_draft_id"
            ))

    if "draft_images" in tables:
        image_columns = {
            column["name"] for column in await conn.run_sync(
                lambda sync: inspect(sync).get_columns("draft_images")
            )
        }
        if "root_draft_id" in image_columns and "draft_id" not in image_columns:
            await conn.execute(text(
                "ALTER TABLE draft_images "
                "RENAME COLUMN root_draft_id TO draft_id"
            ))
```

Call it after the other removed-schema migrations and before `Base.metadata.create_all`:

```python
await migrate_removed_hot_topic_schema(conn)
await migrate_removed_publication_schema(conn)
await migrate_removed_draft_adaptation_schema(conn)
```

- [ ] **Step 4: Remove legacy ORM fields**

Delete `ArticleDraft.linked_draft_id` and replace the image owner declaration:

```python
class DraftImage(Base):
    __tablename__ = "draft_images"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    draft_id: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
```

Extend the fresh-SQLite test to require `draft_id` and reject both retired columns.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_database_draft_adaptation_removal.py \
  tests/test_database_init_sqlite.py -q
```

Expected: all selected tests PASS and `init_db()` remains idempotent.

- [ ] **Step 6: Commit Task 1**

```bash
git add backend/database.py backend/models.py \
  backend/tests/test_database_draft_adaptation_removal.py \
  backend/tests/test_database_init_sqlite.py
git commit -m "refactor: retire draft adaptation schema"
```

---

### Task 2: Flatten backend draft and image contracts

**Files:**
- Modify: `backend/schemas.py`
- Modify: `backend/routers/drafts.py`
- Modify: `backend/mcp_server.py`
- Modify: `backend/daily_creation_service.py`
- Modify: `backend/tests/test_drafts_router.py`
- Modify: `backend/tests/test_daily_creation_service.py`
- Create: `backend/tests/test_mcp_draft_images.py`

**Interfaces:**
- Consumes: `DraftImage.draft_id` from Task 1.
- Produces: draft API payloads without `linked_draft_id`.
- Produces: image operations attached to the requested draft ID.
- Produces: daily creation persists `draft_type="x"`.

- [ ] **Step 1: Write failing backend contract tests**

Add direct image ownership and removed-field assertions:

```python
def test_draft_images_belong_to_requested_draft(client):
    first = client.post(
        "/api/write/drafts",
        json={"title": "first", "draft_type": "article"},
    ).json()
    second = client.post(
        "/api/write/drafts",
        json={"title": "second", "draft_type": "x"},
    ).json()
    assert "linked_draft_id" not in first

    uploaded = client.post(
        f"/api/write/drafts/{second['id']}/images",
        files={"file": ("card.png", b"\x89PNG\r\n\x1a\n", "image/png")},
    )

    assert uploaded.status_code == 201
    assert client.get(f"/api/write/drafts/{first['id']}/images").json() == []
    assert len(client.get(f"/api/write/drafts/{second['id']}/images").json()) == 1
```

Change the daily-creation assertion to `assert draft.draft_type == "x"`.

Create `backend/tests/test_mcp_draft_images.py` with an isolated SQLite fixture and assert `_register_draft_image(...)` persists `DraftImage.draft_id == requested_draft_id`:

```python
def test_register_draft_image_uses_requested_draft_id(env):
    import mcp_server
    from database import SessionLocal
    from models import ArticleDraft, DraftImage

    async def exercise():
        async with SessionLocal() as session:
            draft = ArticleDraft(topic_id="manual", title="X card", draft_type="x")
            session.add(draft)
            await session.commit()
            await session.refresh(draft)
            draft_id = draft.id

        image_id = await mcp_server._register_draft_image(
            draft_id,
            "generated.png",
            "generated.png",
            "/api/uploads/generated.png",
            8,
            "image/png",
        )
        async with SessionLocal() as session:
            image = await session.get(DraftImage, image_id)
            return draft_id, image.draft_id

    assert asyncio.run(exercise()) == (1, 1)
```

- [ ] **Step 2: Run contract tests and verify RED**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_drafts_router.py tests/test_daily_creation_service.py \
  tests/test_mcp_draft_images.py -q
```

Expected: FAIL on legacy image ownership, response fields, or `x_post`.

- [ ] **Step 3: Remove `linked_draft_id` from API schemas**

Delete the field from `ArticleDraftOut`, `ArticleDraftCreate`, and `ArticleDraftUpdate`. Preserve all unrelated fields and defaults already present.

- [ ] **Step 4: Make draft routes use direct IDs**

Replace root resolution with:

```python
async def _require_draft(draft_id: int, db: AsyncSession) -> ArticleDraft:
    draft = await db.get(ArticleDraft, draft_id)
    if draft is None:
        raise HTTPException(404, "Draft not found")
    return draft
```

For list, upload, delete, WeChat publish, Blog publish, and draft cleanup, use `DraftImage.draft_id == draft_id`. Create images with `draft_id=draft_id`; remove `_resolve_root_id` and every `root_id` branch.

- [ ] **Step 5: Flatten MCP ownership and canonicalize daily creation**

```python
draft = await db.get(ArticleDraft, draft_id)
if draft is None:
    raise ValueError(f"Draft {draft_id} not found")
img = DraftImage(
    draft_id=draft_id,
    filename=filename,
    original_name=original_name,
    url=url,
    size_bytes=size_bytes,
    mime_type=mime_type,
)
```

Change daily creation to `draft_type="x"`.

- [ ] **Step 6: Run focused tests and verify GREEN**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_drafts_router.py tests/test_daily_creation_service.py -q
rg -n "linked_draft_id|root_draft_id" . --glob '*.py'
```

Expected: tests PASS and the symbol audit returns no application-code matches.

- [ ] **Step 7: Commit Task 2**

```bash
git add backend/schemas.py backend/routers/drafts.py backend/mcp_server.py \
  backend/daily_creation_service.py backend/tests/test_drafts_router.py \
  backend/tests/test_daily_creation_service.py \
  backend/tests/test_mcp_draft_images.py
git commit -m "refactor: flatten draft backend contracts"
```

---

### Task 3: Convert frontend types and bulk runner to independent drafts

**Files:**
- Modify: `wemedia-studio/lib/api/drafts.ts`
- Create: `wemedia-studio/lib/api/drafts.test.ts`
- Modify: `wemedia-studio/app/drafts/draft-bulk-operations.ts`
- Modify: `wemedia-studio/app/drafts/draft-bulk-operations.test.ts`

**Interfaces:**
- Produces: `draftTypeInfo(value: string)` that never maps unknown values to `article`.
- Produces: `BulkOperationResult` keyed by `draftId`.
- Produces: `runBulkOperations(drafts, operation, onProgress, concurrency)` over `Draft[]`.

- [ ] **Step 1: Write failing type and runner tests**

```typescript
describe('draftTypeInfo', () => {
  it('shows X and never disguises an unknown marker as an article', () => {
    expect(draftTypeInfo('x').label).toBe('X')
    expect(draftTypeInfo('legacy-platform').label).toBe('legacy-platform')
    expect(draftTypeInfo('legacy-platform').value).toBe('legacy-platform')
  })
})
```

Replace group fixtures with independent drafts and assert:

```typescript
expect(results.map(result => result.draftId)).toEqual([1, 2, 3, 4, 5])
```

Delete tests for `articleDraftForGroup` and `deleteDraftGroup`.

- [ ] **Step 2: Run tests and verify RED**

```bash
cd wemedia-studio
pnpm vitest run lib/api/drafts.test.ts \
  app/drafts/draft-bulk-operations.test.ts
```

Expected: FAIL because the flat interfaces do not exist.

- [ ] **Step 3: Remove the frontend relationship field and add safe type lookup**

Delete `linked_draft_id` from `Draft`, `DraftUpdate`, and `DraftCreate`. Add:

```typescript
const UNKNOWN_DRAFT_BADGE =
  'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300'

export function draftTypeInfo(value: string) {
  return DRAFT_TYPES.find(type => type.value === value) ?? {
    value,
    label: value || '未知平台',
    badge: UNKNOWN_DRAFT_BADGE,
  }
}
```

- [ ] **Step 4: Simplify the bounded runner**

```typescript
export interface BulkOperationResult {
  draftId: number
  title: string
  status: 'fulfilled' | 'rejected'
  reason?: string
}

export async function runBulkOperations(
  drafts: Draft[],
  operation: (draft: Draft, index: number) => Promise<void>,
  onProgress: (completed: number, total: number) => void = () => {},
  concurrency = 3,
): Promise<BulkOperationResult[]> {
  if (drafts.length === 0) return []
  const results = new Array<BulkOperationResult>(drafts.length)
  let cursor = 0
  let completed = 0

  async function worker() {
    while (cursor < drafts.length) {
      const index = cursor++
      const draft = drafts[index]
      try {
        await operation(draft, index)
        results[index] = {
          draftId: draft.id,
          title: draft.title,
          status: 'fulfilled',
        }
      } catch (error) {
        results[index] = {
          draftId: draft.id,
          title: draft.title,
          status: 'rejected',
          reason: error instanceof Error ? error.message : '操作失败',
        }
      } finally {
        completed += 1
        onProgress(completed, drafts.length)
      }
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), drafts.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}
```

Store `draftId: draft.id` and remove `DraftGroup`, `articleDraftForGroup`, and `deleteDraftGroup`.

- [ ] **Step 5: Run tests and verify GREEN**

```bash
cd wemedia-studio
pnpm vitest run lib/api/drafts.test.ts \
  app/drafts/draft-bulk-operations.test.ts
```

Expected: all selected tests PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add wemedia-studio/lib/api/drafts.ts wemedia-studio/lib/api/drafts.test.ts \
  wemedia-studio/app/drafts/draft-bulk-operations.ts \
  wemedia-studio/app/drafts/draft-bulk-operations.test.ts
git commit -m "refactor: make draft bulk operations flat"
```

---

### Task 4: Flatten the drafts UI and remove adaptation controls

**Files:**
- Modify: `wemedia-studio/app/drafts/DraftsClient.tsx`
- Modify: `wemedia-studio/app/drafts/DraftsClient.test.tsx`
- Modify: `wemedia-studio/app/drafts/BulkImageActionDialog.tsx`
- Modify: `wemedia-studio/app/drafts/BulkImageActionDialog.test.tsx`

**Interfaces:**
- Consumes: `draftTypeInfo` and flat `runBulkOperations` from Task 3.
- Produces: one row, checkbox, editor, and image library per independent draft.
- Produces: image requests using each selected draft's own ID.

- [ ] **Step 1: Write failing flat-list tests**

```typescript
const xDraft = { ...makeDraft(2, 'X 草稿', 'X 正文', 1), draft_type: 'x' }
render(
  <DraftsClient
    initialDrafts={[draftA, xDraft]}
    initialTopics={[]}
    initialDraftId={draftA.id}
  />,
)

expect(screen.queryByText('适配平台')).not.toBeInTheDocument()
expect(screen.queryByText(/同步主版本内容/)).not.toBeInTheDocument()
expect(screen.getByRole('checkbox', { name: '选择草稿 A' })).toBeVisible()
expect(screen.getByRole('checkbox', { name: '选择X 草稿' })).toBeVisible()
```

Add bulk cover and illustration tests asserting direct calls for both IDs. Change deletion expectations so each selected draft is deleted exactly once.

- [ ] **Step 2: Run UI tests and verify RED**

```bash
cd wemedia-studio
pnpm vitest run app/drafts/DraftsClient.test.tsx \
  app/drafts/BulkImageActionDialog.test.tsx
```

Expected: FAIL because the current component groups drafts and requires an article version.

- [ ] **Step 3: Replace group state with flat draft state**

```typescript
const filteredDrafts = useMemo(
  () => drafts.filter(draft => draftMatchesFilters(
    draft,
    filterStatus,
    filterTopicId,
  )),
  [drafts, filterStatus, filterTopicId],
)
const visibleDraftIds = useMemo(
  () => new Set(filteredDrafts.map(draft => draft.id)),
  [filteredDrafts],
)
const [selectedDraftIds, setSelectedDraftIds] = useState<Set<number>>(
  () => new Set(),
)
```

Remove grouping, variant switching, `articleDraft`, `availableTypes`, variant creation state/handler, root-ID calculations, tabs, “适配平台”, and “同步主版本内容”. Render `filteredDrafts.map(draft => ...)` and use `draftTypeInfo` for badges.

- [ ] **Step 4: Make images and deletion direct**

Load and pass `selected.id` to every image operation and `DraftAssetsDialog`. Bulk delete uses:

```typescript
const selectedDrafts = filteredDrafts.filter(draft =>
  selectedDraftIds.has(draft.id)
)
const results = await runBulkOperations(
  selectedDrafts,
  draft => deleteDraft(draft.id),
  (completed, total) => setBulkProgress({ completed, total }),
  3,
)
```

Refresh once, retain rejected `draftId` values, and use `确定删除已选 ${count} 篇草稿？此操作不可恢复。`.

- [ ] **Step 5: Submit image jobs directly for every platform marker**

```typescript
const results = await runBulkOperations(
  selectedDrafts,
  async draft => {
    if (options.mode === 'cover') {
      await regenerateCover({
        draft_id: draft.id,
        account_id: options.accountId,
        note: options.note,
        cover_style: options.coverStyle,
      })
      return
    }
    await illustrateBody({
      draft_id: draft.id,
      account_id: options.accountId,
      note: options.note,
      max_images: options.maxImages,
    })
  },
  (completed, total) => setBulkProgress({ completed, total }),
  3,
)
```

Reconcile selections with `result.draftId`.

- [ ] **Step 6: Remove adaptation copy from the bulk dialog**

```tsx
<DialogDescription>
  为已选 {selectedCount} 篇草稿统一设置参数。
</DialogDescription>
```

Keep account selection, style overrides, image limits, progress, and failure details.

- [ ] **Step 7: Run focused tests and verify GREEN**

```bash
cd wemedia-studio
pnpm vitest run app/drafts/draft-bulk-operations.test.ts \
  app/drafts/BulkImageActionDialog.test.tsx \
  app/drafts/DraftsClient.test.tsx lib/api/drafts.test.ts
```

Expected: all selected tests PASS and the following audit returns no application-code matches:

```bash
rg -n "适配平台|linked_draft_id|articleDraftForGroup|DraftGroup|平台版本" \
  app/drafts lib/api/drafts.ts
```

- [ ] **Step 8: Commit Task 4**

```bash
git add wemedia-studio/app/drafts/DraftsClient.tsx \
  wemedia-studio/app/drafts/DraftsClient.test.tsx \
  wemedia-studio/app/drafts/BulkImageActionDialog.tsx \
  wemedia-studio/app/drafts/BulkImageActionDialog.test.tsx
git commit -m "refactor: remove draft adaptation UI"
```

---

### Task 5: Verify the cutover and apply the local migration

**Files:**
- No production files expected.
- Store temporary screenshots and database backup under `/tmp`.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: verified code, migrated local PostgreSQL data, and rendered UI evidence.

- [ ] **Step 1: Run backend verification**

```bash
cd backend
/home/violet/miniconda3/envs/wems/bin/python -m pytest \
  tests/test_database_draft_adaptation_removal.py \
  tests/test_database_init_sqlite.py \
  tests/test_drafts_router.py \
  tests/test_daily_creation_service.py -q
/home/violet/miniconda3/envs/wems/bin/python -m pytest -q
```

Expected: all tests PASS; never report an interrupted or blank run as green.

- [ ] **Step 2: Run frontend verification**

```bash
cd wemedia-studio
pnpm lint
pnpm test
pnpm build
```

Expected: lint exits zero, all Vitest files pass, and the production build completes.

- [ ] **Step 3: Audit removed symbols**

```bash
cd ..
rg -n "linked_draft_id|root_draft_id|适配平台|同步主版本内容" \
  backend wemedia-studio
```

Expected: no application-code matches; historical docs may retain explanatory references.

- [ ] **Step 4: Back up affected local tables**

```bash
docker exec wms-dev-postgres-copy pg_dump \
  -U wemedia -d wemedia -t article_drafts -t draft_images \
  -f /tmp/draft-adaptation-removal-backup.sql
docker cp wms-dev-postgres-copy:/tmp/draft-adaptation-removal-backup.sql \
  /tmp/draft-adaptation-removal-backup.sql
```

Expected: `/tmp/draft-adaptation-removal-backup.sql` is non-empty and can recover deleted rows 11 and 60.

- [ ] **Step 5: Apply and inspect the local PostgreSQL migration**

Start the repository runtime or invoke `init_db()` with the normal `.env`, then run:

```sql
SELECT id FROM article_drafts WHERE id IN (11, 60);
SELECT count(*) FROM article_drafts WHERE draft_type = 'x_post';
SELECT column_name FROM information_schema.columns
WHERE table_name = 'article_drafts' AND column_name = 'linked_draft_id';
SELECT column_name FROM information_schema.columns
WHERE table_name = 'draft_images'
  AND column_name IN ('root_draft_id', 'draft_id')
ORDER BY column_name;
```

Expected: IDs 11 and 60 are absent, `x_post` count is zero, `linked_draft_id` is absent, and only `draft_id` remains.

- [ ] **Step 6: Run rendered browser QA**

Use the Browser plugin if available; otherwise use regular Playwright and record the fallback. Test:

```text
/drafts
→ verify no “适配平台” or version tabs
→ select one article and one X draft
→ submit both through bulk cover
→ open bulk illustrations for both
→ confirm flat bulk-delete wording
```

Capture screenshots under `/tmp`, assert no console errors, and verify the X badge reads “X”, not “文章”.

- [ ] **Step 7: Check final scope**

```bash
git diff --check
git status --short
git log --oneline -8
```

Expected: no whitespace errors; only intentional feature commits plus the user's pre-existing unrelated changes remain.

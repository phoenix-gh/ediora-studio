# Digital Human Assets Folder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one immutable “数字人资产” multimedia folder and automatically archive all existing and future digital-human inputs and outputs into it.

**Architecture:** Add a stable nullable `system_key` to asset directories while retaining the existing name-based `CreativeAsset.directory` field. A focused backend domain module owns folder creation, idempotent classification, and backfill; digital-human and talking-video transaction boundaries call it. The asset API exposes `is_system`, enforces immutability, and the React asset tree renders the locked state without edit/delete controls.

**Tech Stack:** FastAPI, SQLAlchemy async ORM, PostgreSQL/SQLite tests, Next.js 16, React 19, TypeScript, Vitest, Testing Library, pytest, Docker Compose.

## Global Constraints

- Create exactly one top-level multimedia folder named `数字人资产`.
- Store the stable key as `digital_human_assets`; do not infer system permissions from the Chinese display name.
- Do not create per-role subfolders or a new asset page/type.
- Archive portrait, voice, default/override environments, render environments, and successful local MP4 assets.
- Backfill all existing digital-human associations at startup.
- The system folder cannot be renamed or deleted in either the UI or API.
- Do not change deletion rules for assets inside the folder.
- Preserve the compact multimedia grid and double-click preview dialog.
- Preserve the user-owned `.superpowers/brainstorm/` directory without staging or modifying it.

---

### Task 1: System directory model and idempotent backfill service

**Files:**
- Create: `backend/digital_human_assets.py`
- Create: `backend/tests/test_digital_human_assets.py`
- Modify: `backend/models.py:754-763`
- Modify: `backend/database.py:103-114`
- Modify: `backend/main.py:36-48`

**Interfaces:**
- Produces: `DIGITAL_HUMAN_ASSET_DIRECTORY_NAME = "数字人资产"`.
- Produces: `DIGITAL_HUMAN_ASSET_SYSTEM_KEY = "digital_human_assets"`.
- Produces: `ensure_digital_human_asset_directory(session: AsyncSession) -> CreativeAssetDirectory`.
- Produces: `archive_digital_human_asset_ids(session: AsyncSession, asset_ids: Iterable[int]) -> None`.
- Produces: `backfill_digital_human_assets(session: AsyncSession) -> None`.

- [ ] **Step 1: Write failing service tests**

Create an async SQLite fixture with `Base.metadata.create_all`, then add these behavior tests:

```python
async def test_ensure_directory_upgrades_same_name_and_is_idempotent(session):
    existing = CreativeAssetDirectory(
        name="数字人资产", asset_type="media", parent_id=None
    )
    session.add(existing)
    await session.commit()

    first = await ensure_digital_human_asset_directory(session)
    second = await ensure_digital_human_asset_directory(session)

    assert first.id == existing.id == second.id
    assert first.system_key == "digital_human_assets"
    assert len((await session.execute(
        select(CreativeAssetDirectory).where(
            CreativeAssetDirectory.system_key == "digital_human_assets"
        )
    )).scalars().all()) == 1
```

```python
async def test_backfill_archives_all_existing_digital_human_assets(session):
    def media(title, kind="image", media_type="image/png"):
        return CreativeAsset(
            asset_type="media",
            media_kind=kind,
            title=title,
            url=f"/api/uploads/{title}",
            media_type=media_type,
            filename=title,
        )

    portrait = media("portrait.png")
    voice = media("voice.wav", "audio", "audio/wav")
    default_environment = media("default.png")
    override_environment = media("override.png")
    render_environment = media("render.png")
    video = media("result.mp4", "video", "video/mp4")
    unrelated = media("unrelated.png")
    session.add_all([
        portrait,
        voice,
        default_environment,
        override_environment,
        render_environment,
        video,
        unrelated,
    ])
    await session.flush()
    role = DigitalHuman(
        name="林晓",
        status="ready",
        portrait_asset_id=portrait.id,
        voice_sample_asset_id=voice.id,
        default_environment_asset_id=default_environment.id,
    )
    session.add(role)
    await session.flush()
    project = TalkingVideoProject(
        title="测试作品",
        digital_human_id=role.id,
        environment_asset_id=override_environment.id,
    )
    session.add(project)
    await session.flush()
    session.add(TalkingVideoRender(
        project_id=project.id,
        version=1,
        status="succeeded",
        script_snapshot="测试脚本",
        environment_asset_id=render_environment.id,
        video_asset_id=video.id,
    ))
    await session.flush()

    await backfill_digital_human_assets(session)
    await session.commit()

    archived_ids = {
        portrait.id,
        voice.id,
        default_environment.id,
        override_environment.id,
        render_environment.id,
        video.id,
    }
    archived = (await session.execute(
        select(CreativeAsset).where(CreativeAsset.id.in_(archived_ids))
    )).scalars().all()
    untouched = await session.get(CreativeAsset, unrelated.id)
    assert {asset.directory for asset in archived} == {"数字人资产"}
    assert untouched is not None and untouched.directory == ""
```

- [ ] **Step 2: Run service tests and verify RED**

Run:

```bash
conda run -n wems pytest -q backend/tests/test_digital_human_assets.py
```

Expected: collection/import failure because `digital_human_assets` and `system_key` do not exist.

- [ ] **Step 3: Add the directory system key schema**

In `CreativeAssetDirectory`, add:

```python
system_key: Mapped[str | None] = mapped_column(
    String, nullable=True, unique=True, index=True
)
```

In `init_db()`, after the directory `parent_id` migration, add PostgreSQL-safe idempotent SQL:

```python
await conn.execute(text(
    "ALTER TABLE creative_asset_directories "
    "ADD COLUMN IF NOT EXISTS system_key VARCHAR"
))
if not DATABASE_URL.startswith("sqlite"):
    await conn.execute(text(
        "CREATE UNIQUE INDEX IF NOT EXISTS "
        "uq_creative_asset_directories_system_key "
        "ON creative_asset_directories (system_key) "
        "WHERE system_key IS NOT NULL"
    ))
```

- [ ] **Step 4: Implement the focused archive service**

Create `backend/digital_human_assets.py` with:

```python
DIGITAL_HUMAN_ASSET_DIRECTORY_NAME = "数字人资产"
DIGITAL_HUMAN_ASSET_SYSTEM_KEY = "digital_human_assets"


async def ensure_digital_human_asset_directory(session):
    directory = await session.scalar(select(CreativeAssetDirectory).where(
        CreativeAssetDirectory.system_key == DIGITAL_HUMAN_ASSET_SYSTEM_KEY
    ))
    if directory is None:
        directory = await session.scalar(select(CreativeAssetDirectory).where(
            CreativeAssetDirectory.asset_type == "media",
            CreativeAssetDirectory.name == DIGITAL_HUMAN_ASSET_DIRECTORY_NAME,
        ))
    if directory is None:
        directory = CreativeAssetDirectory(
            name=DIGITAL_HUMAN_ASSET_DIRECTORY_NAME,
            asset_type="media",
            parent_id=None,
        )
        session.add(directory)
    directory.system_key = DIGITAL_HUMAN_ASSET_SYSTEM_KEY
    await session.flush()
    return directory
```

`archive_digital_human_asset_ids` must normalize positive integer IDs, ensure the directory, and issue one SQLAlchemy `update(CreativeAsset)` restricted to `asset_type == "media"`. It flushes but never commits.

`backfill_digital_human_assets` must collect non-null asset IDs from:

```text
DigitalHuman.portrait_asset_id
DigitalHuman.voice_sample_asset_id
DigitalHuman.default_environment_asset_id
TalkingVideoProject.environment_asset_id
TalkingVideoRender.environment_asset_id
TalkingVideoRender.video_asset_id
```

Then call `archive_digital_human_asset_ids` once.

- [ ] **Step 5: Run backfill during API startup**

In `main.lifespan`, immediately after `init_db()`:

```python
async with SessionLocal() as db:
    await backfill_digital_human_assets(db)
    await db.commit()
```

Do not catch and suppress this migration: the service must not start with an incomplete system-folder invariant.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
conda run -n wems pytest -q backend/tests/test_digital_human_assets.py
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/digital_human_assets.py backend/tests/test_digital_human_assets.py backend/models.py backend/database.py backend/main.py
git commit -m "feat: add digital human asset archive"
```

---

### Task 2: Archive future assets at digital-human transaction boundaries

**Files:**
- Modify: `backend/digital_human_service.py`
- Modify: `backend/routers/digital_humans.py`
- Modify: `backend/routers/talking_videos.py`
- Modify: `backend/tests/test_digital_humans_router.py`
- Modify: `backend/tests/test_talking_videos_router.py`
- Modify: `backend/tests/test_digital_human_end_to_end.py`

**Interfaces:**
- Consumes: `archive_digital_human_asset_ids(session, asset_ids) -> None` from Task 1.
- Produces: every committed role/project/render association has `CreativeAsset.directory == "数字人资产"`.

- [ ] **Step 1: Add failing role archive assertions**

Extend the existing role router tests:

```python
assert await _asset_directories(
    session_factory, [portrait, voice, environment]
) == ["数字人资产", "数字人资产", "数字人资产"]
```

Add an update test which replaces the default environment and asserts the replacement is archived after `PATCH /api/digital-humans/{id}`.

- [ ] **Step 2: Run role tests and verify RED**

Run:

```bash
conda run -n wems pytest -q \
  backend/tests/test_digital_humans_router.py::test_create_role_enqueues_setup_job \
  backend/tests/test_digital_humans_router.py -k environment
```

Expected: assertions receive empty directory strings.

- [ ] **Step 3: Archive role assets before commit**

In `create_digital_human`, after media validation and before the job transaction commits:

```python
await archive_digital_human_asset_ids(session, {
    portrait_asset_id,
    voice_sample_asset_id,
    default_environment_asset_id,
})
```

In `patch_role`, after validating supplied assets and before either commit path:

```python
await archive_digital_human_asset_ids(
    db,
    value for _, value, _ in validations if value is not None
)
```

- [ ] **Step 4: Verify role tests GREEN**

Run:

```bash
conda run -n wems pytest -q backend/tests/test_digital_humans_router.py
```

Expected: all role router tests pass.

- [ ] **Step 5: Add failing project and render assertions**

Extend talking-video tests to prove:

```python
assert await _asset_directory(session_factory, override_environment_id) \
    == "数字人资产"
```

after project create/patch, and:

```python
assert await _asset_directory(session_factory, video_asset_id) \
    == "数字人资产"
```

after a successful worker-progress update.

- [ ] **Step 6: Run talking-video tests and verify RED**

Run:

```bash
conda run -n wems pytest -q backend/tests/test_talking_videos_router.py
```

Expected: new directory assertions receive empty strings.

- [ ] **Step 7: Archive project environments and successful videos**

Call `archive_digital_human_asset_ids`:

- in `create_talking_project` for a non-null project override;
- in `create_render` for the effective environment;
- in `patch_project` when a non-null environment is supplied;
- in `render_worker_progress` before committing a successful `video_asset_id`.

Each call stays inside the existing business transaction and does not commit independently.

- [ ] **Step 8: Verify the complete backend digital-human flow**

Run:

```bash
conda run -n wems pytest -q \
  backend/tests/test_digital_humans_router.py \
  backend/tests/test_talking_videos_router.py \
  backend/tests/test_digital_human_end_to_end.py
```

Expected: all tests pass.

- [ ] **Step 9: Commit**

```bash
git add backend/digital_human_service.py backend/routers/digital_humans.py backend/routers/talking_videos.py backend/tests/test_digital_humans_router.py backend/tests/test_talking_videos_router.py backend/tests/test_digital_human_end_to_end.py
git commit -m "feat: archive digital human workflow assets"
```

---

### Task 3: Lock the system folder in the API and asset tree

**Files:**
- Create: `backend/tests/test_asset_directories_router.py`
- Create: `wemedia-studio/app/assets/assets-system-directory.test.tsx`
- Modify: `backend/routers/assets.py`
- Modify: `wemedia-studio/lib/api/assets.ts`
- Modify: `wemedia-studio/app/assets/AssetsClient.tsx`

**Interfaces:**
- Consumes: `CreativeAssetDirectory.system_key` from Task 1.
- Produces: directory API field `is_system: boolean`.
- Produces: `CreativeAssetDirectory.is_system: boolean` in TypeScript.

- [ ] **Step 1: Add failing API immutability tests**

Seed one system directory and one ordinary media directory, then assert:

```python
assert client.get("/api/assets/directories?asset_type=media").json()[0][
    "is_system"
] is True
assert client.patch(
    f"/api/assets/directories/{system_id}",
    json={"name": "改名", "asset_type": "media"},
).status_code == 409
assert client.delete(
    f"/api/assets/directories/{system_id}"
).status_code == 409
assert client.patch(
    f"/api/assets/directories/{ordinary_id}",
    json={"name": "普通目录新名称", "asset_type": "media"},
).status_code == 200
```

- [ ] **Step 2: Run API directory tests and verify RED**

Run:

```bash
conda run -n wems pytest -q backend/tests/test_asset_directories_router.py
```

Expected: `is_system` is absent and system rename/delete return success.

- [ ] **Step 3: Implement API payload and guards**

Add `is_system: bool` to `DirectoryOut` and return explicit payload dictionaries:

```python
def _directory_payload(directory):
    return {
        "id": directory.id,
        "name": directory.name,
        "asset_type": directory.asset_type,
        "parent_id": directory.parent_id,
        "is_system": bool(directory.system_key),
        "created_at": directory.created_at,
    }
```

Before rename:

```python
if directory.system_key:
    raise HTTPException(409, "系统目录不能重命名")
```

Before recursive delete:

```python
if directory.system_key:
    raise HTTPException(409, "系统目录不能删除")
```

- [ ] **Step 4: Verify API tests GREEN**

Run:

```bash
conda run -n wems pytest -q backend/tests/test_asset_directories_router.py
```

Expected: all tests pass.

- [ ] **Step 5: Add failing React lock-state test**

Mock `listCreativeAssetDirectories` with:

```typescript
[
  {
    id: 1,
    name: '数字人资产',
    asset_type: 'media',
    parent_id: null,
    is_system: true,
    created_at: '',
  },
  {
    id: 2,
    name: '普通目录',
    asset_type: 'media',
    parent_id: null,
    is_system: false,
    created_at: '',
  },
]
```

Render `AssetsClient`, switch to “多媒体”, and assert:

```typescript
expect(await screen.findByLabelText('系统目录')).toBeInTheDocument()
expect(screen.queryByRole('button', {
  name: '重命名数字人资产',
})).not.toBeInTheDocument()
expect(screen.queryByRole('button', {
  name: '删除数字人资产',
})).not.toBeInTheDocument()
expect(screen.getByRole('button', {
  name: '重命名普通目录',
})).toBeInTheDocument()
expect(screen.getByRole('button', {
  name: '删除普通目录',
})).toBeInTheDocument()
```

- [ ] **Step 6: Run React test and verify RED**

Run:

```bash
cd wemedia-studio
pnpm exec vitest run app/assets/assets-system-directory.test.tsx
```

Expected: the type lacks `is_system`, no lock is rendered, and directory action buttons lack accessible labels.

- [ ] **Step 7: Implement the locked directory row**

Update the TypeScript type:

```typescript
export type CreativeAssetDirectory = {
  id: number
  name: string
  asset_type: 'article' | 'media'
  parent_id: number | null
  is_system: boolean
  created_at: string
}
```

Import `LockKeyhole` and render it with `aria-label="系统目录"` for system rows. Render the existing pencil/trash controls only when `!item.is_system`, and give ordinary controls labels `重命名${item.name}` and `删除${item.name}`.

- [ ] **Step 8: Verify asset UI tests GREEN**

Run:

```bash
cd wemedia-studio
pnpm exec vitest run \
  app/assets/assets-system-directory.test.tsx \
  app/assets/assets-layout.test.ts
pnpm exec tsc --noEmit
```

Expected: tests and TypeScript pass.

- [ ] **Step 9: Commit**

```bash
git add backend/routers/assets.py backend/tests/test_asset_directories_router.py wemedia-studio/lib/api/assets.ts wemedia-studio/app/assets/AssetsClient.tsx wemedia-studio/app/assets/assets-system-directory.test.tsx
git commit -m "feat: lock digital human asset folder"
```

---

### Task 4: Full verification and live backfill acceptance

**Files:**
- Modify only if verification exposes a tested defect in files already listed above.

**Interfaces:**
- Consumes: completed Tasks 1–3.
- Produces: running Docker services with the existing live digital-human assets classified into the immutable system folder.

- [ ] **Step 1: Run all automated tests**

Run:

```bash
conda run -n wems pytest -q backend
cd wemedia-studio
pnpm test
pnpm exec tsc --noEmit
```

Expected: all backend and frontend tests pass with no warnings treated as failures.

- [ ] **Step 2: Build and restart with one shared worker token**

Run:

```bash
docker compose build api web
shared_worker_token=$(openssl rand -hex 32)
WMS_WORKER_TOKEN="$shared_worker_token" \
  docker compose up -d --no-deps --force-recreate api worker web
docker compose ps
```

Expected: postgres and redis remain healthy; api, worker, and web are up.

- [ ] **Step 3: Verify the live backfill and API guards**

Use read-only queries to assert:

```text
GET /api/assets/directories?asset_type=media
  -> exactly one 数字人资产 with is_system=true

GET /api/assets?asset_type=media&directory=数字人资产
  -> current role portrait, voice, environment, and completed MP4 are present
```

Then call rename/delete against the system folder and verify both return `409` without changing the directory or assets.

- [ ] **Step 4: Browser acceptance**

Open `http://127.0.0.1:3000/assets`, switch to “多媒体”, select “数字人资产”, and assert:

- lock state visible;
- no rename/delete controls for the system folder;
- expected image, audio, and video cards present;
- media-kind filtering still works;
- double-click preview opens;
- browser console errors and page errors are empty.

- [ ] **Step 5: Inspect runtime evidence**

Run:

```bash
docker compose logs --since=10m api worker web \
  | rg -i 'error|exception|traceback|failed' || true
git diff --check
git status --short
```

Expected: no new runtime failures; only `.superpowers/brainstorm/` remains untracked.

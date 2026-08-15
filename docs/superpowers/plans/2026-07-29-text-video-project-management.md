# Text Video Project Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver persisted text-video project management and a structurally faithful editor with autosave.

**Architecture:** A dedicated SQLAlchemy `TextVideoProject` stores the editable project document and optimistic revision. FastAPI exposes CRUD endpoints; Next.js provides a management route and a project editor route backed by a small client API and debounced autosave hook. The existing canonical Remotion contract remains the preview boundary.

**Tech Stack:** FastAPI, SQLAlchemy async, PostgreSQL/SQLite tests, Next.js 16, React 19, Zod, Remotion 4.0.500, Vitest, Testing Library, Playwright.

## Global Constraints

- `/text-video` is project management; `/text-video/[projectId]` is the editor.
- Persist title, stage, status, script, voice settings, paragraphs, render input, asset URLs, revision, and timestamps.
- Autosave after 800ms and support Ctrl/Cmd+S with truthful save state.
- Reject stale revisions with HTTP 409.
- Restore the approved top bar, 28/52/20 workspace, player row, and bottom timeline.
- Use existing Ediora semantic tokens and UI primitives; do not copy the concept palette.
- Do not claim MiMo, cloned voice, waveform extraction, or MP4 rendering is available.

---

### Task 1: Persisted model and idempotent migration

**Files:**
- Modify: `backend/models.py`
- Modify: `backend/database.py`
- Create: `backend/tests/test_database_text_video_migration.py`

**Interfaces:**
- Produces: `TextVideoProject` with JSON document columns and integer `revision`.

- [ ] Write a migration test that initializes the database twice and asserts the `text_video_projects` columns exist.
- [ ] Run `pytest tests/test_database_text_video_migration.py -q` and verify it fails before the model exists.
- [ ] Add `TextVideoProject` and PostgreSQL `ADD COLUMN IF NOT EXISTS` compatibility migration statements.
- [ ] Run the migration test and existing database/model tests.
- [ ] Commit `feat: persist text video projects`.

### Task 2: CRUD API with revision and render validation

**Files:**
- Create: `backend/routers/text_videos.py`
- Modify: `backend/main.py`
- Create: `backend/tests/test_text_videos_router.py`

**Interfaces:**
- Produces: `GET/POST /api/text-videos`, `GET/PATCH/DELETE /api/text-videos/{id}`.
- PATCH consumes `{revision, ...changes}` and returns HTTP 409 when the revision is stale.

- [ ] Write router tests for empty list, create defaults, detail, patch, stale revision, video-stage gate, and delete.
- [ ] Run the new router tests and verify the missing-route failures.
- [ ] Implement Pydantic document validation, serializer, CRUD handlers, and `main.py` registration.
- [ ] Run router tests and the backend suite.
- [ ] Commit `feat: add text video project API`.

### Task 3: Frontend API and management route

**Files:**
- Create: `web/lib/api/text-videos.ts`
- Create: `web/lib/api/text-videos.test.ts`
- Replace: `web/app/text-video/page.tsx`
- Create: `web/app/text-video/TextVideoProjectsClient.tsx`
- Create: `web/app/text-video/TextVideoProjectsClient.test.tsx`

**Interfaces:**
- Produces typed list/create/get/update/delete client functions and the project-management UI.

- [ ] Write API serialization tests and management interaction tests using Dialog and AlertDialog.
- [ ] Run the focused tests and verify missing-module/component failures.
- [ ] Implement API functions, server data loading, cards, filters, empty state, create, rename, delete, and continue-editing navigation.
- [ ] Run focused tests and TypeScript.
- [ ] Commit `feat: add text video project management`.

### Task 4: Project editor route and autosave

**Files:**
- Create: `web/app/text-video/[projectId]/page.tsx`
- Create: `web/app/text-video/TextVideoEditorClient.tsx`
- Create: `web/app/text-video/useTextVideoAutosave.ts`
- Create: `web/app/text-video/useTextVideoAutosave.test.tsx`
- Modify: `web/app/text-video/TextVideoWorkbench.tsx`
- Modify: stage components as required.

**Interfaces:**
- Autosave exposes `{saveState, saveNow, retry, conflict}`.
- Editor consumes a persisted `TextVideoProject`, sends the current revision, and accepts normalized server responses.

- [ ] Write tests for hydration, dirty-to-saving-to-saved, 800ms debounce, keyboard save, error retry, and 409 conflict.
- [ ] Run focused tests and verify failures before implementation.
- [ ] Implement dynamic route, controlled project state, autosave hook, retry state, and conflict Dialog.
- [ ] Update editing controls so title, script, ratio, stage, and selected template/scene changes modify persisted state.
- [ ] Run focused tests and TypeScript.
- [ ] Commit `feat: autosave text video projects`.

### Task 5: Editor layout fidelity

**Files:**
- Modify: `web/app/text-video/TextVideoWorkbench.tsx`
- Modify: `web/app/text-video/ScriptStage.tsx`
- Modify: `web/app/text-video/AudioStage.tsx`
- Modify: `web/app/text-video/VideoStage.tsx`
- Create: `web/app/text-video/SceneTimeline.tsx`
- Modify: relevant component tests.

**Interfaces:**
- Produces a minimum-width three-column editing canvas, player-control row, and bottom scene timeline.

- [ ] Add layout contract tests for top bar, three-column workspace, player row, and timeline.
- [ ] Run focused tests and verify the timeline assertions fail.
- [ ] Restore the approved structure using semantic tokens, scene thumbnail treatments, completion state, timeline selection, and master audio lane placeholder.
- [ ] Run focused tests, TypeScript, and Remotion composition discovery.
- [ ] Commit `feat: restore text video editor layout`.

### Task 6: Full verification and deployment

**Files:**
- No product files unless verification finds a defect.

**Interfaces:**
- Verifies the persisted flow against the running API and Web containers.

- [ ] Run backend tests, frontend tests, changed-file ESLint, Next.js production build, and Remotion composition discovery.
- [ ] Build and recreate API and Web containers without replacing persistent volumes.
- [ ] Use Playwright for management → create/open → edit → autosave → return flow, plus video preview and compact-width horizontal workspace.
- [ ] Compare the editor screenshot with the approved concept structure using image inspection and fix material mismatches.
- [ ] Run final fresh verification, commit any fixes, and report the exact runtime URL and known excluded integrations.

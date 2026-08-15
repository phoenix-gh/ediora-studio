# 创作资产库 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the reference-material library with reusable article, image, and video creative assets.

**Architecture:** Remove the old RefMaterial collection feature end-to-end. Add a small `CreativeAsset` domain with a FastAPI CRUD/upload API and a Next.js browser page. Keep draft-owned images and upload storage intact, and add an asset picker to the draft editor.

**Tech Stack:** Next.js/TypeScript, FastAPI, SQLAlchemy, PostgreSQL, Vitest, pytest.

## Global Constraints

- Preserve draft-owned images and cover upload behavior.
- Do not migrate or delete files outside the retired reference-material tables.
- Do not retain public `/materials` UI or API routes.

---

### Task 1: Retire the reference-material library

**Files:** `backend/models.py`, `backend/database.py`, `backend/main.py`, `backend/config.py`, `backend/routers/materials.py`, `backend/routers/chat.py`, `backend/routers/dashboard.py`, `backend/mcp_server.py`, `backend/scheduler.py`, `web/app/materials/*`, `web/lib/api/materials.ts`, `web/components/features/Sidebar.tsx`, related tests.

- [ ] Add failing assertions that `/materials` is absent and Chat source search returns only writing plans.
- [ ] Remove material routes, models, collectors, scheduler/config/dashboard references, page/API/sidebar entry and Chat reference-material branches.
- [ ] Add idempotent database table drops for `ref_materials`, `ref_collect_rules`, and `ref_seen`.
- [ ] Run backend and frontend removal tests.

### Task 2: Add creative asset persistence and API

**Files:** `backend/models.py`, `backend/routers/assets.py`, `backend/main.py`, `backend/tests/test_assets_router.py`.

- [ ] Add failing CRUD/upload tests for article, image, and video assets.
- [ ] Add `CreativeAsset` model and `/api/assets` list/create/update/delete/upload endpoints.
- [ ] Run `pytest backend/tests/test_assets_router.py -q`.

### Task 3: Add the asset library UI and draft reuse

**Files:** `web/app/assets/*`, `web/lib/api/assets.ts`, `web/components/features/Sidebar.tsx`, `web/components/features/DraftAssetsDialog.tsx`, `web/app/drafts/DraftsClient.tsx`, tests.

- [ ] Add failing frontend tests for asset API serialization and asset insertion mapping.
- [ ] Build the asset list/upload/create UI and a draft-dialog asset picker that inserts article Markdown, image Markdown, or video link Markdown.
- [ ] Run Vitest, TypeScript, and `git diff --check`.

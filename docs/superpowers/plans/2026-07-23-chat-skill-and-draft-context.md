# Chat Skill and Draft Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select one auto-discovered local skill and one article draft for a Chat turn.

**Architecture:** A Next.js server helper scans local `SKILL.md` frontmatter. FastAPI exposes draft summaries/detail through bounded Chat context endpoints. The Chat API validates selected IDs/names server-side and appends loaded instructions to the one request; the client serializes only identifiers.

**Tech Stack:** Next.js, React, TypeScript, FastAPI, SQLAlchemy async, Vitest, pytest, existing `gray-matter`-free YAML parser implementation.

## Global Constraints

- Discover every `skills/*/SKILL.md`; no custom metadata or allowlist.
- One optional skill and one optional draft per message.
- Read draft content server-side; never trust client-provided content.
- Do not grant new model tools solely by skill selection.

---

### Task 1: Discover local skills and expose selectable draft context

**Files:**
- Create: `web/lib/ai/discover-skills.ts`
- Create: `web/lib/ai/discover-skills.test.ts`
- Modify: `backend/routers/chat.py`
- Modify: `backend/tests/test_chat_router.py`

**Interfaces:**
- Produces: `discoverSkills(): Promise<Array<{ name: string; description: string; version: string }>>`.
- Produces: `GET /api/chat/drafts` and `GET /api/chat/drafts/{id}`.

- [ ] **Step 1: Write failing tests** for frontmatter discovery and backend draft list/detail.
- [ ] **Step 2: Run focused tests** and verify missing helpers/routes fail.
- [ ] **Step 3: Implement a frontmatter parser** that extracts YAML scalar `name`, `description`, `version` from every sorted `SKILL.md`; skip files with no name.
- [ ] **Step 4: Implement bounded draft summary and full-content routes** using `ArticleDraft`, newest first, limit 100, with 404 for an unknown ID.
- [ ] **Step 5: Verify and commit**:

```bash
pnpm exec vitest run lib/ai/discover-skills.test.ts
conda run -n wems pytest tests/test_chat_router.py -q
git commit -m "feat(chat): discover skills and draft context"
```

### Task 2: Validate and load selected server-side context

**Files:**
- Modify: `web/app/api/chat/route.ts`
- Modify: `web/app/api/chat/route.test.ts`
- Modify: `web/lib/api/chat.ts`
- Modify: `web/lib/api/chat.test.ts`

**Interfaces:**
- Extends Chat request with optional `skillName?: string`, `draftId?: number`.
- Produces: `skillContext(skillName)` and server-loaded draft context in `streamText.instructions`.

- [ ] **Step 1: Write failing request validation tests** for selected skill name and draft ID.
- [ ] **Step 2: Verify tests fail** before route extension.
- [ ] **Step 3: Implement request schema and context loaders**; reject unknown skills, fetch selected draft only through `/chat/drafts/{id}`, and append labeled context to the static instruction.
- [ ] **Step 4: Extend `streamChatReply` types/body** to send only selection identifiers.
- [ ] **Step 5: Verify and commit**:

```bash
pnpm exec vitest run app/api/chat/route.test.ts lib/api/chat.test.ts
pnpm exec tsc --noEmit
git commit -m "feat(chat): load selected skill and draft context"
```

### Task 3: Add composer selectors

**Files:**
- Modify: `web/app/chat/ChatClient.tsx`
- Modify: `web/app/chat/chat-layout.test.ts`
- Modify: `web/lib/api/chat.ts`

**Interfaces:**
- Consumes: `GET /api/chat/skills`, `GET /api/chat/drafts`, and optional selection identifiers.
- Produces: one-skill and one-draft selector state passed to `streamChatReply`.

- [ ] **Step 1: Write failing UI source/behavior tests** for selectors and serialized `skillName`/`draftId`.
- [ ] **Step 2: Implement lightweight selects** above the textarea, including “不使用技能” and “不选择草稿” values; load options alongside session list.
- [ ] **Step 3: Clear selections on starting a new conversation**, retain them during the current draft-aware conversation, and disable selectors while sending.
- [ ] **Step 4: Verify and commit**:

```bash
pnpm exec vitest run app/chat/chat-layout.test.ts
pnpm test
pnpm build
git commit -m "feat(chat): select skill and draft context"
```

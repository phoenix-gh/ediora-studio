# Global Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a no-login, multi-session global research chat that streams AI replies and can read WeMedia Studio information sources through auditable read-only tools.

**Architecture:** Next.js owns the chat API, model loop, streaming response, and tool definitions. FastAPI owns persisted sessions/messages and source-search/read endpoints; every tool call is recorded with the assistant message. The first release has no mutating tools and no Redis dependency.

**Tech Stack:** Next.js 16, React 19, Vercel AI SDK 7, FastAPI, SQLAlchemy/Postgres, Zod, Vitest, pytest.

## Global Constraints

- No login or multi-user tenancy in this release.
- Use the configured OpenAI-compatible text model and `provider.chat()`.
- All source tools are read-only; content creation remains a durable job and is deferred.
- Persist messages and tool call/result summaries in Postgres; never persist API keys.
- Do not reintroduce embeddings; search uses existing source metadata and keyword matching.

---

### Task 1: Persisted chat sessions and messages

**Files:**
- Modify: `backend/models.py`
- Modify: `backend/database.py`
- Create: `backend/routers/chat.py`
- Modify: `backend/main.py`
- Test: `backend/tests/test_chat_router.py`

**Interfaces:**
- Produces `GET/POST /api/chat/sessions`, `GET /api/chat/sessions/{id}`, and `POST /api/chat/sessions/{id}/messages`.
- A message payload is `{role, parts, text}` where `role` is `user|assistant|tool`.

- [ ] Write a failing pytest that creates a session, appends a user message, and retrieves it in chronological order.
- [ ] Run `conda run -n wems pytest tests/test_chat_router.py -q` and confirm the route is absent.
- [ ] Add `ChatSession` and `ChatMessage` models, the router, and idempotent table creation via existing `Base.metadata.create_all`.
- [ ] Run `conda run -n wems pytest tests/test_chat_router.py -q` and confirm it passes.
- [ ] Commit with `feat(chat): persist sessions and messages`.

### Task 2: Read-only source tools

**Files:**
- Modify: `backend/routers/chat.py`
- Test: `backend/tests/test_chat_router.py`

**Interfaces:**
- Produces `GET /api/chat/sources/search?q=&limit=` and `GET /api/chat/sources/{source}/{id}`.
- Search results have `{source,id,title,summary,url,published_at}` and are capped at 20.

- [ ] Write failing pytest coverage for query validation and a source result from an existing writing plan or reference material.
- [ ] Run the selected pytest test and confirm it fails.
- [ ] Implement bounded keyword search over writing plans and reference materials first; return an explicit empty result for unknown source IDs.
- [ ] Run all chat-router tests and confirm they pass.
- [ ] Commit with `feat(chat): expose read-only source search tools`.

### Task 3: Streaming AI route with audited tools

**Files:**
- Create: `wemedia-studio/app/api/chat/route.ts`
- Create: `wemedia-studio/lib/ai/chat-tools.ts`
- Test: `wemedia-studio/lib/ai/chat-tools.test.ts`

**Interfaces:**
- `makeChatTools({apiBase, sessionId})` returns `searchInformationSources` and `readInformationSource` tools.
- The route accepts `{sessionId,messages}` and returns an AI SDK UI message stream.

- [ ] Write a failing Vitest test proving source-tool schemas cap `limit` and expose only the two read-only tool names.
- [ ] Run `pnpm test lib/ai/chat-tools.test.ts` and confirm it fails.
- [ ] Implement tools with Zod schemas, FastAPI calls, and bounded `streamText` tool steps; persist user and final assistant messages through the chat API.
- [ ] Run the targeted test, `pnpm exec tsc --noEmit`, and `pnpm test`.
- [ ] Commit with `feat(chat): add streaming research tools`.

### Task 4: Global Chat UI and navigation entry

**Files:**
- Create: `wemedia-studio/app/chat/page.tsx`
- Create: `wemedia-studio/app/chat/ChatClient.tsx`
- Create: `wemedia-studio/lib/api/chat.ts`
- Modify: `wemedia-studio/components/features/Sidebar.tsx`

**Interfaces:**
- `/chat` lists sessions, creates a session, loads its messages, streams replies, and renders tool-call/result parts.
- Sidebar links to `/chat` as `AI 助手`.

- [ ] Write a failing pure-unit test for the API client request payload used to create a session.
- [ ] Run its targeted Vitest test and confirm it fails.
- [ ] Implement the two-column page: session list on the left; messages, collapsible tool events, and composer on the right.
- [ ] Run `pnpm exec tsc --noEmit`, `pnpm test`, and `pnpm build`.
- [ ] Commit with `feat(chat): add global multi-session assistant`.

### Task 5: Runtime verification

**Files:**
- No source changes required unless a verified defect is found.

- [ ] Restart FastAPI and the Next.js dev server with the existing local configuration.
- [ ] Create a chat session, ask a source-search question, and verify persisted user/assistant messages plus visible tool activity.
- [ ] Record the session ID and verification outcome in the handoff.

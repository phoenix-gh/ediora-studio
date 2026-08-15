# Chat Global Tool Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Chat automatic access to every local MCP tool, plus a durable `generateImage` tool, with confirmation before sensitive actions.

**Architecture:** The Next.js Chat route obtains a request-scoped tool set from FastAPI's Streamable HTTP MCP endpoint and merges it with application-native image-job tools. A small tool-policy adapter classifies sensitive MCP names and adds AI SDK approval requirements. Persisted assistant tool parts are updated when the user approves/rejects, then the same route resumes the model loop from durable history.

**Tech Stack:** Next.js 16, AI SDK 7, `@ai-sdk/mcp`, FastAPI MCP, React 19, TypeScript, Zod, Vitest, pytest.

## Global Constraints

- Discover every current and future local MCP tool at request time; do not maintain a Chat tool allowlist.
- Keep image provider calls and asset writes in the existing Redis content worker.
- `generateImage` requires a selected draft and creates a durable `cover` or `illustrations` job.
- Full skill instructions are retained only for generic skills; Baoyu image skills use their runtime adapter.
- Tools named publish, delete, update, save, create, add, or upload require explicit approval.
- Preserve all tool calls and approval decisions in the existing Chat session.

---

### Task 1: Add an MCP-backed global Chat tool registry

**Files:**
- Modify: `web/package.json`
- Modify: `web/pnpm-lock.yaml`
- Create: `web/lib/ai/global-chat-tools.ts`
- Create: `web/lib/ai/global-chat-tools.test.ts`

**Interfaces:**
- Consumes: API base URL, Chat session ID, optional selected draft/skill context.
- Produces: `openGlobalChatTools(options): Promise<{ tools: ToolSet; close(): Promise<void> }>`.
- Produces: `requiresToolApproval(name: string): boolean`.

- [ ] **Step 1: Write failing tool-policy tests**

```ts
it('requires approval for MCP tools with a sensitive action verb', () => {
  expect(requiresToolApproval('update_draft')).toBe(true)
  expect(requiresToolApproval('upload_image_from_url')).toBe(true)
  expect(requiresToolApproval('search_ref_materials')).toBe(false)
})

it('converts every discovered MCP tool and keeps non-sensitive tools automatic', async () => {
  const registry = await openGlobalChatTools({ apiBase: 'http://localhost:8000/api', sessionId: 9 })
  expect(Object.keys(registry.tools)).toContain('list_drafts')
  expect(registry.tools.list_drafts.needsApproval).toBe(false)
  await registry.close()
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run lib/ai/global-chat-tools.test.ts`

Expected: FAIL because the registry does not exist.

- [ ] **Step 3: Add the MCP client dependency and registry**

Run: `pnpm add @ai-sdk/mcp`

Implement an HTTP MCP client using `mcpUrl(apiBase)`, where `http://host/api`
becomes `http://host/mcp`. Retrieve `await client.tools()`, wrap each returned
tool with its original schema/execute behavior plus
`needsApproval: requiresToolApproval(name)`, and return a `close` function.
The function must close the client on a caller's `finally`/stream completion.

- [ ] **Step 4: Run focused tests and live discovery smoke test**

Run: `pnpm exec vitest run lib/ai/global-chat-tools.test.ts && curl --fail --silent http://127.0.0.1:8000/mcp`

Expected: policy tests pass; MCP endpoint responds through its Streamable HTTP protocol.

- [ ] **Step 5: Commit**

Run: `git add web/package.json web/pnpm-lock.yaml web/lib/ai/global-chat-tools.ts web/lib/ai/global-chat-tools.test.ts && git commit -m "feat(chat): discover global MCP tools"`

### Task 2: Add durable image generation to the global registry

**Files:**
- Modify: `web/lib/ai/global-chat-tools.ts`
- Modify: `web/lib/ai/global-chat-tools.test.ts`
- Modify: `web/app/api/chat/route.ts`
- Modify: `web/app/api/chat/route.test.ts`

**Interfaces:**
- Produces: native `generateImage({ kind, note? })` tool.
- Consumes: selected `draftId` and selected skill name.
- Returns: `{ jobId, flow, draftId, status }` after `POST /jobs` creates the durable job.

- [ ] **Step 1: Write failing image-tool tests**

```ts
it('creates a cover job for the selected draft', async () => {
  const registry = await openGlobalChatTools({ apiBase, sessionId: 9, draftId: 12, skillName: 'baoyu-cover-image' })
  const result = await registry.tools.generateImage.execute({ kind: 'cover' })
  expect(fetch).toHaveBeenCalledWith(`${apiBase}/jobs`, expect.objectContaining({ method: 'POST' }))
  expect(result).toMatchObject({ flow: 'cover', draftId: 12 })
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm exec vitest run lib/ai/global-chat-tools.test.ts app/api/chat/route.test.ts`

Expected: FAIL because no native image tool exists.

- [ ] **Step 3: Implement the native tool and image-skill context**

Create the job with `flow: 'cover'` or `flow: 'illustrations'`, a deterministic
Chat idempotency key, `input: { draft_id, note }`, and a title derived from the
selected draft. Reject calls without a selected draft. In `selectedContext`,
replace the raw Baoyu `SKILL.md` body with `baoyuRuntimeInstructions('cover',
1)` or `baoyuRuntimeInstructions('illustrations', 1)` and explicitly require
`generateImage`; generic skills retain the discovered instruction text.

- [ ] **Step 4: Replace the read-only tool set in the route**

Open the registry after validating the request. Pass its `tools` to
`convertToModelMessages` and `streamText`, set a larger bounded loop, and close
the registry in `onFinish` and route error handling. Persist native/MCP tool
parts through the assistant response message.

- [ ] **Step 5: Verify and commit**

Run: `pnpm exec vitest run lib/ai/global-chat-tools.test.ts app/api/chat/route.test.ts && pnpm exec tsc --noEmit`

Run: `git add web/lib/ai/global-chat-tools.ts web/lib/ai/global-chat-tools.test.ts web/app/api/chat/route.ts web/app/api/chat/route.test.ts && git commit -m "feat(chat): add durable image tool"`

### Task 3: Persist and resume tool approvals

**Files:**
- Modify: `backend/routers/chat.py`
- Modify: `backend/tests/test_chat_router.py`
- Modify: `web/app/api/chat/route.ts`
- Modify: `web/app/api/chat/route.test.ts`
- Modify: `web/lib/api/chat.ts`
- Modify: `web/lib/api/chat.test.ts`

**Interfaces:**
- Produces: `PATCH /api/chat/sessions/{sessionId}/messages/{messageId}` to replace persisted assistant `parts` after an approval decision.
- Extends: Chat POST body with optional `{ approval: { messageId, toolCallId, approvalId, approved } }`.

- [ ] **Step 1: Write failing backend and route tests**

```py
def test_replaces_assistant_message_parts_for_tool_approval(client):
    session = client.post('/api/chat/sessions', json={}).json()
    message = client.post(f"/api/chat/sessions/{session['id']}/messages", json={"role": "assistant", "parts": [{"type": "tool-update_draft", "state": "approval-requested"}]}).json()
    response = client.patch(f"/api/chat/sessions/{session['id']}/messages/{message['id']}", json={"parts": [{"type": "tool-update_draft", "state": "approval-responded"}]})
    assert response.status_code == 200
```

- [ ] **Step 2: Run the backend test and verify it fails**

Run: `conda run -n wems pytest tests/test_chat_router.py -q`

Expected: FAIL with HTTP 405 because the replacement endpoint does not exist.

- [ ] **Step 3: Implement the replacement endpoint and approval continuation**

The route finds the persisted assistant message by `messageId`, updates exactly
the matching tool part to `state: 'approval-responded'` and
`approval: { id: approvalId, approved }`, then reloads model history. It must
not accept client-supplied tool input or execute a tool directly. Convert the
updated history with the registry tools and stream the resumed model response.

- [ ] **Step 4: Extend the client API**

Add a typed `ChatToolApproval` payload and allow `streamChatReply` to submit it.
The client sends no new user message when replying to an approval request.

- [ ] **Step 5: Verify and commit**

Run: `conda run -n wems pytest tests/test_chat_router.py -q && pnpm exec vitest run app/api/chat/route.test.ts lib/api/chat.test.ts && pnpm exec tsc --noEmit`

Run: `git add backend/routers/chat.py backend/tests/test_chat_router.py web/app/api/chat/route.ts web/app/api/chat/route.test.ts web/lib/api/chat.ts web/lib/api/chat.test.ts && git commit -m "feat(chat): approve sensitive tools"`

### Task 4: Render global tool state and approval controls

**Files:**
- Modify: `web/app/chat/ChatClient.tsx`
- Modify: `web/app/chat/chat-layout.test.ts`

**Interfaces:**
- Consumes: assistant `tool-*` parts with optional `approval` state.
- Produces: collapsed global tool activity plus Approve / Reject controls for pending calls.

- [ ] **Step 1: Write the failing UI source test**

```tsx
it('renders approval controls for pending tool calls and resumes the stream', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')
  expect(source).toContain('批准')
  expect(source).toContain('拒绝')
  expect(source).toContain('approval: { messageId')
})
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `pnpm exec vitest run app/chat/chat-layout.test.ts`

Expected: FAIL because no approval UI exists.

- [ ] **Step 3: Implement pending-approval UI**

Derive pending approvals from tool parts whose state is `approval-requested`.
Show the tool name and serialized arguments in the expanded tool activity group,
with `批准` and `拒绝` buttons. A decision calls `streamChatReply` with the
active session ID and approval payload; disable duplicate decisions while the
continuation is streaming. Refresh the persisted session after completion.

- [ ] **Step 4: Run complete verification and commit**

Run: `pnpm test && pnpm exec tsc --noEmit && pnpm build && conda run -n wems pytest tests/test_chat_router.py tests/test_content_jobs.py tests/test_jobs_router.py -q`

Expected: all suites pass and `/chat` plus `/api/chat/skills` build successfully.

Run: `git add web/app/chat/ChatClient.tsx web/app/chat/chat-layout.test.ts && git commit -m "feat(chat): confirm sensitive global tools"`

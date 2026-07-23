# Chat Tool Activity and Session Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse duplicate tool UI into concise activity groups, add permanent session deletion, and create sessions only when the first message is sent.

**Architecture:** Keep backend tool-audit rows unchanged as the durable ledger. The Chat client hides those audit-only rows and renders assistant tool parts once through a summary component. A small delete API spans FastAPI and the typed client; the existing submit flow becomes the only session-creation path.

**Tech Stack:** Next.js, React, TypeScript, FastAPI, SQLAlchemy async, Vitest, pytest.

## Global Constraints

- Preserve tool-audit persistence and exclude audit rows from model history.
- Never create a backend session for an unsent new conversation.
- Delete only an explicitly selected persisted session after browser confirmation.
- Do not add dependencies or alter chat model/tool APIs.

---

### Task 1: Add durable session deletion

**Files:**
- Modify: `backend/routers/chat.py:95-145`
- Modify: `backend/tests/test_chat_router.py`
- Modify: `wemedia-studio/lib/api/chat.ts`
- Modify: `wemedia-studio/lib/api/chat.test.ts`

**Interfaces:**
- Produces: `DELETE /api/chat/sessions/{session_id}` returning HTTP 204.
- Produces: `deleteChatSession(sessionId: number): Promise<void>`.
- Consumes: existing `ChatSession` and `ChatMessage` data model.

- [ ] **Step 1: Write failing backend deletion tests**

```python
async def test_delete_session_removes_its_messages(client, db_session):
    session = await create_chat_session(client)
    await append_chat_message(client, session["id"], role="user", text="hello")
    response = await client.delete(f"/api/chat/sessions/{session['id']}")
    assert response.status_code == 204
    assert (await client.get(f"/api/chat/sessions/{session['id']}")).status_code == 404

async def test_delete_missing_session_returns_404(client):
    assert (await client.delete('/api/chat/sessions/999999')).status_code == 404
```

- [ ] **Step 2: Run backend tests to verify they fail**

Run: `conda run -n wems pytest tests/test_chat_router.py -q`

Expected: FAIL because no `DELETE /chat/sessions/{id}` route exists.

- [ ] **Step 3: Implement backend deletion**

```python
from sqlalchemy import delete

@router.delete('/sessions/{session_id}', status_code=204)
async def delete_session(session_id: int, db: AsyncSession = Depends(get_db)):
    session = await db.get(ChatSession, session_id)
    if not session:
        raise HTTPException(404, '会话不存在')
    await db.execute(delete(ChatMessage).where(ChatMessage.session_id == session_id))
    await db.delete(session)
    await db.commit()
```

- [ ] **Step 4: Add the failing typed-client test and client function**

```ts
it('deletes a persisted session', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  await deleteChatSession(8)
  expect(fetchMock).toHaveBeenCalledWith('http://localhost:8000/api/chat/sessions/8', { method: 'DELETE' })
})
```

```ts
export async function deleteChatSession(sessionId: number) {
  await apiFetch<void>(`/chat/sessions/${sessionId}`, { method: 'DELETE' })
}
```

- [ ] **Step 5: Verify and commit**

Run: `conda run -n wems pytest tests/test_chat_router.py -q && pnpm exec vitest run lib/api/chat.test.ts`

```bash
git add backend/routers/chat.py backend/tests/test_chat_router.py wemedia-studio/lib/api/chat.ts wemedia-studio/lib/api/chat.test.ts
git commit -m "feat(chat): delete persisted sessions"
```

### Task 2: Collapse tool activity into one concise UI group

**Files:**
- Modify: `wemedia-studio/app/chat/ChatClient.tsx:20-140`
- Modify: `wemedia-studio/app/chat/chat-layout.test.ts`

**Interfaces:**
- Produces: `ToolActivityGroup({ parts }: { parts: ToolEventPart[] })`.
- Consumes: assistant `tool-*` parts and persisted `role: tool` audit messages.
- Renders: one collapsed group per assistant response; tool audit rows render `null`.

- [ ] **Step 1: Write failing summary and audit-hiding tests**

```ts
expect(source).toContain("return '已检索本地资料，并阅读 5 条相关内容'")
expect(source).toContain("if (message.role === 'tool') return null")
expect(source).toContain('<ToolActivityGroup parts={toolParts} />')
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm exec vitest run app/chat/chat-layout.test.ts`

Expected: FAIL because the client renders every audit and tool part separately.

- [ ] **Step 3: Implement concise grouped activity**

```tsx
function activitySummary(parts: ToolEventPart[]) {
  const searches = parts.filter(part => toolName(part) === 'searchInformationSources').length
  const reads = parts.filter(part => toolName(part) === 'readInformationSource').length
  if (searches && reads) return `已检索本地资料，并阅读 ${reads} 条相关内容`
  if (searches) return '已检索本地资料'
  if (reads) return `已阅读 ${reads} 条资料`
  return `已调用 ${parts.length} 项工具`
}
```

Render details collapsed by default. The details list shows each mapped tool label and its final status; omit raw input/output JSON. Replace the assistant’s per-part `ToolEvent` map with one `ToolActivityGroup`. Return `null` for `role: tool` messages because they are persisted audit-only records.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run app/chat/chat-layout.test.ts && pnpm test && pnpm exec tsc --noEmit`

```bash
git add wemedia-studio/app/chat/ChatClient.tsx wemedia-studio/app/chat/chat-layout.test.ts
git commit -m "feat(chat): collapse tool activity"
```

### Task 3: Add sidebar deletion and lazy new-conversation state

**Files:**
- Modify: `wemedia-studio/app/chat/ChatClient.tsx:145-340`
- Modify: `wemedia-studio/app/chat/chat-layout.test.ts`

**Interfaces:**
- Consumes: `deleteChatSession` from Task 1.
- Produces: client-only `startNewConversation()` and `removeSession(session: ChatSession)` handlers.

- [ ] **Step 1: Write failing behavior contract tests**

```ts
expect(source).toContain("function startNewConversation()")
expect(source).toContain('setActiveSessionId(null)')
expect(source).toContain('await deleteChatSession(session.id)')
expect(source).toContain('window.confirm(`删除会话“${session.title || \'新对话\'}”？此操作不可恢复。`)')
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm exec vitest run app/chat/chat-layout.test.ts`

Expected: FAIL because clicking the plus button posts an empty session and sidebar rows lack deletion.

- [ ] **Step 3: Implement the lifecycle UI**

```tsx
function startNewConversation() {
  setActiveSessionId(null)
  setMessages([])
  setInput('')
}
```

Make the plus button call this function. Retain the existing `submit` branch that
calls `createChatSession()` only when `activeSessionId` is null. Add a small
trash icon button to each sidebar row. It stops event propagation, confirms,
deletes, updates `sessions`, and clears active state if the removed row was
active.

- [ ] **Step 4: Verify and commit**

Run: `pnpm exec vitest run app/chat/chat-layout.test.ts && pnpm test && pnpm exec tsc --noEmit && pnpm build && conda run -n wems pytest tests/test_chat_router.py -q`

```bash
git add wemedia-studio/app/chat/ChatClient.tsx wemedia-studio/app/chat/chat-layout.test.ts
git commit -m "feat(chat): manage lazy sessions"
```

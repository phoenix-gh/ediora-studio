# Chat Draft Approval Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render persisted AI SDK `dynamic-tool` approval requests so users can approve or reject Chat draft updates.

**Architecture:** Extract the tool-part type predicate into a small pure module, cover its accepted and rejected message-part types with Vitest, and make `ChatClient` consume that predicate. Keep the existing approval callback and backend persistence flow unchanged.

**Tech Stack:** TypeScript, React 19, Next.js 16, AI SDK 7, Vitest.

## Global Constraints

- `update_draft` remains approval-required.
- Do not automatically approve historical tool calls.
- Do not directly modify draft 185.
- Preserve existing support for `tool-event`, `tool-result`, and `tool-*` parts.
- Modify and stage only the Chat tool-part helper, its test, `ChatClient.tsx`, and this plan.

---

### Task 1: Recognize AI SDK dynamic tool parts

**Files:**
- Create: `web/app/chat/chat-tool-parts.ts`
- Create: `web/app/chat/chat-tool-parts.test.ts`
- Modify: `web/app/chat/ChatClient.tsx:56-58`

**Interfaces:**
- Consumes: an object with a string `type` field.
- Produces: `isChatToolPart(part: { type: string }): boolean`.

- [ ] **Step 1: Write the failing unit test**

Create `chat-tool-parts.test.ts` with assertions that `dynamic-tool`, `tool-event`, `tool-result`, and `tool-fetch_url` return `true`, while `text` and `step-start` return `false`.

```ts
import { describe, expect, it } from 'vitest'
import { isChatToolPart } from './chat-tool-parts'

describe('isChatToolPart', () => {
  it('recognizes persisted AI SDK dynamic tool calls', () => {
    expect(isChatToolPart({ type: 'dynamic-tool' })).toBe(true)
  })

  it.each(['tool-event', 'tool-result', 'tool-fetch_url'])(
    'preserves support for %s',
    type => expect(isChatToolPart({ type })).toBe(true),
  )

  it.each(['text', 'step-start'])(
    'does not classify %s as tool activity',
    type => expect(isChatToolPart({ type })).toBe(false),
  )
})
```

- [ ] **Step 2: Run the unit test and verify RED**

```bash
cd web
pnpm test app/chat/chat-tool-parts.test.ts
```

Expected: FAIL because `./chat-tool-parts` does not exist.

- [ ] **Step 3: Add the minimal predicate and wire it into ChatClient**

Create the helper:

```ts
export function isChatToolPart(part: { type: string }) {
  return part.type === 'dynamic-tool'
    || part.type === 'tool-event'
    || part.type === 'tool-result'
    || part.type.startsWith('tool-')
}
```

Import `isChatToolPart` in `ChatClient.tsx`, remove its private `isToolPart`, and replace `message.parts.filter(isToolPart)` with `message.parts.filter(isChatToolPart)`.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
cd web
pnpm test app/chat/chat-tool-parts.test.ts app/chat/chat-layout.test.ts
```

Expected: both test files pass.

- [ ] **Step 5: Run frontend regression checks**

```bash
cd web
pnpm test
pnpm exec tsc --noEmit
```

Expected: all Vitest tests and TypeScript checks pass.

- [ ] **Step 6: Verify the rendered historical approval without mutating the draft**

Open `/chat`, select the latest session, and confirm the persisted `update_draft` activity is expanded with “批准” and “拒绝” controls. Do not click either control during verification.

- [ ] **Step 7: Commit only the fix files**

```bash
git add \
  web/app/chat/chat-tool-parts.ts \
  web/app/chat/chat-tool-parts.test.ts \
  web/app/chat/ChatClient.tsx \
  docs/superpowers/plans/2026-08-02-chat-draft-approval-rendering.md
git commit -m "fix: render chat draft approval controls"
```

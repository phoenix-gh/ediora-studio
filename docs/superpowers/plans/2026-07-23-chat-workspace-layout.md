# Chat Workspace Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align Chat conversation and composer as one responsive workspace.

**Architecture:** Define one exported shared-column class contract near the Chat UI and apply it to both the scrollable conversation wrapper and composer wrapper. Keep the pane-level separator while removing the composer’s competing full-width surface.

**Tech Stack:** Next.js, React, TypeScript, Tailwind CSS, Vitest.

## Global Constraints

- Keep Chat sessions, messages, streams, Markdown, and tool cards unchanged.
- Header remains pane-level; conversation and composer share one `max-w-4xl` inner column.
- Use `px-4 sm:px-6` for narrow-screen and desktop alignment.
- Do not add dependencies.

---

### Task 1: Define and test the shared Chat content column

**Files:**
- Create: `wemedia-studio/app/chat/chat-layout.ts`
- Create: `wemedia-studio/app/chat/chat-layout.test.ts`

**Interfaces:**
- Produces: `chatContentColumn: string` for the inner conversation and composer wrappers.
- Consumes: no runtime state or external data.

- [ ] **Step 1: Write the failing layout contract test**

```ts
import { expect, it } from 'vitest'
import { chatContentColumn } from './chat-layout'

it('uses one centered responsive column for chat content', () => {
  expect(chatContentColumn).toContain('mx-auto')
  expect(chatContentColumn).toContain('max-w-4xl')
  expect(chatContentColumn).toContain('px-4')
  expect(chatContentColumn).toContain('sm:px-6')
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run app/chat/chat-layout.test.ts`

Expected: FAIL because `chat-layout.ts` does not exist.

- [ ] **Step 3: Add the shared layout contract**

```ts
export const chatContentColumn = 'mx-auto w-full max-w-4xl px-4 sm:px-6'
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm exec vitest run app/chat/chat-layout.test.ts`

Expected: PASS with 1 test.

- [ ] **Step 5: Commit the contract and test**

```bash
git add wemedia-studio/app/chat/chat-layout.ts wemedia-studio/app/chat/chat-layout.test.ts
git commit -m "test(chat): define workspace column contract"
```

### Task 2: Apply the shared column to conversation and composer

**Files:**
- Modify: `wemedia-studio/app/chat/ChatClient.tsx:1-360`
- Test: `wemedia-studio/app/chat/chat-layout.test.ts`

**Interfaces:**
- Consumes: `chatContentColumn` from Task 1.
- Produces: conversation and composer wrappers aligned to the same responsive column.

- [ ] **Step 1: Extend the failing layout test with consumer evidence**

```ts
import { readFileSync } from 'node:fs'

it('uses the shared column in both conversation and composer regions', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')
  expect(source.match(/chatContentColumn/g)).toHaveLength(3) // import plus two render uses
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run app/chat/chat-layout.test.ts`

Expected: FAIL because `ChatClient.tsx` does not import and use the contract.

- [ ] **Step 3: Apply one layout source of truth**

```tsx
import { chatContentColumn } from './chat-layout'

<div className="min-h-0 flex-1 overflow-y-auto py-6">
  <div className={cn(chatContentColumn, 'flex flex-col gap-5')}>
    {/* conversation */}
  </div>
</div>

<form className="border-t border-zinc-200 bg-zinc-50/70 py-4 dark:border-zinc-800 dark:bg-zinc-950/70">
  <div className={chatContentColumn}>
    {/* existing rounded composer */}
  </div>
</form>
```

Keep the header pane-level. Remove duplicated `mx-auto`, `max-w-4xl`, and
independent `px-6` wrappers. Keep the existing rounded textarea control and
move its helper text inside the shared composer column.

- [ ] **Step 4: Run frontend verification**

Run: `pnpm exec vitest run app/chat/chat-layout.test.ts && pnpm test && pnpm exec tsc --noEmit && pnpm build`

Expected: focused layout test, full frontend suite, TypeScript, and production build pass.

- [ ] **Step 5: Commit the visual integration**

```bash
git add wemedia-studio/app/chat/ChatClient.tsx wemedia-studio/app/chat/chat-layout.test.ts
git commit -m "fix(chat): unify workspace layout"
```

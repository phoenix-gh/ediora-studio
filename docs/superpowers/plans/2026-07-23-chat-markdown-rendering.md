# Chat Markdown Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render assistant chat text as safe, readable Markdown without changing persistence, user bubbles, or tool activity cards.

**Architecture:** Add a focused client-safe `ChatMarkdown` presentational component that converts Markdown to a React-rendered tree rather than injecting parser HTML. `MessageBubble` will use it only for assistant text parts; the existing user and tool rendering paths remain unchanged.

**Tech Stack:** Next.js, React 19, TypeScript, Vitest, Testing Library, existing `marked` parser.

## Global Constraints

- Do not change chat API payloads, stored message data, sessions, or tools.
- Do not render raw HTML or use `dangerouslySetInnerHTML`.
- Keep user messages literal plain text and tool cards unchanged.
- Preserve incremental rendering of streaming assistant text parts.

---

### Task 1: Add a safe Markdown message component

**Files:**
- Create: `wemedia-studio/components/features/chat/ChatMarkdown.tsx`
- Create: `wemedia-studio/components/features/chat/ChatMarkdown.test.tsx`

**Interfaces:**
- Produces: `ChatMarkdown({ content }: { content: string }): JSX.Element`.
- Consumes: a Markdown string from an assistant message text part.

- [ ] **Step 1: Write the failing component tests**

```tsx
import { render, screen } from '@testing-library/react'
import { ChatMarkdown } from './ChatMarkdown'

it('renders common markdown structures', () => {
  render(<ChatMarkdown content={'## 标题\n\n- 第一项\n\n```ts\nconst ok = true\n```\n\n[文档](https://example.com)'} />)
  expect(screen.getByRole('heading', { name: '标题', level: 2 })).toBeInTheDocument()
  expect(screen.getByRole('list')).toHaveTextContent('第一项')
  expect(screen.getByText('const ok = true')).toBeInTheDocument()
  expect(screen.getByRole('link', { name: '文档' })).toHaveAttribute('href', 'https://example.com')
})

it('keeps raw HTML as text instead of creating elements', () => {
  const { container } = render(<ChatMarkdown content={'<img src=x onerror=alert(1)>'} />)
  expect(container.querySelector('img')).toBeNull()
  expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run components/features/chat/ChatMarkdown.test.tsx`

Expected: FAIL because `ChatMarkdown` does not exist.

- [ ] **Step 3: Implement the minimal safe renderer**

```tsx
import { Lexer, type Token } from 'marked'

export function ChatMarkdown({ content }: { content: string }) {
  const tokens = Lexer.lex(content, { gfm: true, breaks: true })
  return <div className="chat-markdown">{tokens.map(renderToken)}</div>
}
```

Implement `renderToken` using React elements for supported block and inline tokens; render `html` tokens as literal text. Give links `target="_blank"` and `rel="noreferrer"`, and apply local Tailwind classes for prose, code, tables, and dark mode.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm exec vitest run components/features/chat/ChatMarkdown.test.tsx`

Expected: PASS with 2 tests.

- [ ] **Step 5: Commit the component and tests**

```bash
git add wemedia-studio/components/features/chat/ChatMarkdown.tsx wemedia-studio/components/features/chat/ChatMarkdown.test.tsx
git commit -m "feat(chat): render assistant markdown safely"
```

### Task 2: Use Markdown rendering for assistant bubbles

**Files:**
- Modify: `wemedia-studio/app/chat/ChatClient.tsx:1-130`
- Test: `wemedia-studio/components/features/chat/ChatMarkdown.test.tsx`

**Interfaces:**
- Consumes: `ChatMarkdown` from Task 1.
- Produces: assistant text bubbles rendered as Markdown; user bubbles retain their current string rendering.

- [ ] **Step 1: Extend the failing test to express the assistant-only boundary**

```tsx
// The component remains generic; its caller passes assistant text only.
// Add this source-level assertion only if a ChatClient render harness is needed:
expect(readFileSync('app/chat/ChatClient.tsx', 'utf8')).toContain('<ChatMarkdown')
```

- [ ] **Step 2: Run the focused test to verify the integration assertion fails**

Run: `pnpm exec vitest run components/features/chat/ChatMarkdown.test.tsx`

Expected: FAIL because `ChatClient` has not imported the component.

- [ ] **Step 3: Replace only assistant text rendering**

```tsx
import { ChatMarkdown } from '@/components/features/chat/ChatMarkdown'

// In MessageBubble text content:
{isUser
  ? (textParts.length > 0 ? textParts.map(/* current text spans */) : fallbackText)
  : (textParts.length > 0
      ? textParts.map((part, index) => <ChatMarkdown key={`${message.id}-text-${index}`} content={String(part.text ?? '')} />)
      : <ChatMarkdown content={fallbackText} />)}
```

Retain the existing wrapper class, text-part ordering, timestamp, and tool-part mapping.

- [ ] **Step 4: Run frontend verification**

Run: `pnpm exec vitest run components/features/chat/ChatMarkdown.test.tsx && pnpm test && pnpm exec tsc --noEmit && pnpm build`

Expected: focused Markdown tests, all frontend tests, TypeScript, and Next production build pass.

- [ ] **Step 5: Commit the integration**

```bash
git add wemedia-studio/app/chat/ChatClient.tsx wemedia-studio/components/features/chat/ChatMarkdown.test.tsx
git commit -m "feat(chat): display markdown replies"
```

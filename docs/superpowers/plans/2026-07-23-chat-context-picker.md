# Chat Context Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Chat's permanent skill and draft selects with one Codex-style add-context picker and searchable draft dialog.

**Architecture:** Keep `ChatClient` as the owner of selection values and request serialization. Extract the popover, selected chips, and draft search dialog into a focused client component built on the existing Base UI wrappers. It receives summaries and returns IDs/names only, preserving server-side context loading.

**Tech Stack:** Next.js 16, React 19, TypeScript, Base UI, Tailwind CSS, lucide-react, Vitest.

## Global Constraints

- Keep one optional skill and one optional draft per Chat turn.
- Keep automatic discovery from every `skills/*/SKILL.md` unchanged.
- Never send draft body through the browser; keep `skillName` and `draftId` unchanged.
- Use one visible “添加上下文” trigger; do not retain native `<select>` controls.
- Disable add/remove/select controls while the response is streaming.
- A new conversation clears both selections; cancelling either picker does not.

---

### Task 1: Build the isolated context-picker component

**Files:**
- Create: `wemedia-studio/components/features/chat/ChatContextPicker.tsx`
- Create: `wemedia-studio/components/features/chat/ChatContextPicker.test.tsx`

**Interfaces:**
- Consumes: `ChatSkill`, `ChatDraft`, selected `skillName` / `draftId`, `disabled`, and selection callbacks.
- Produces: `ChatContextPicker` with a popover action menu, skill search, draft search dialog, and removable chips.

- [ ] **Step 1: Write the failing component test**

```tsx
it('uses one add-context trigger and opens the draft search dialog', () => {
  const source = readFileSync(new URL('./ChatContextPicker.tsx', import.meta.url), 'utf8')
  expect(source).toContain('添加上下文')
  expect(source).toContain('<Popover')
  expect(source).toContain('<Dialog')
  expect(source).toContain('搜索草稿')
  expect(source).not.toContain('<select')
})

it('renders removable chips and filters drafts by title', () => {
  const source = readFileSync(new URL('./ChatContextPicker.tsx', import.meta.url), 'utf8')
  expect(source).toContain('onSkillNameChange(undefined)')
  expect(source).toContain('onDraftIdChange(undefined)')
  expect(source).toContain("draft.title.toLocaleLowerCase().includes(draftQuery.toLocaleLowerCase())")
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm exec vitest run components/features/chat/ChatContextPicker.test.tsx`

Expected: FAIL because `ChatContextPicker.tsx` does not exist.

- [ ] **Step 3: Implement the component**

```tsx
export function ChatContextPicker({ skills, drafts, skillName, draftId, disabled, onSkillNameChange, onDraftIdChange }: Props) {
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [draftDialogOpen, setDraftDialogOpen] = useState(false)
  const [skillQuery, setSkillQuery] = useState('')
  const [draftQuery, setDraftQuery] = useState('')
  const visibleSkills = skills.filter(skill => skill.name.toLocaleLowerCase().includes(skillQuery.toLocaleLowerCase()))
  const visibleDrafts = drafts.filter(draft => draft.title.toLocaleLowerCase().includes(draftQuery.toLocaleLowerCase()))
}
```

Use the existing `Popover` and `Dialog` wrappers. Render removable chips, one popover trigger, an in-place searchable skill list, and a dialog draft search. Select a skill with `onSkillNameChange(skill.name)` then close the popover. Select a draft with `onDraftIdChange(draft.id)` then close the dialog without changing the skill. Use `X`, `Plus`, `Sparkles`, and `FileText` icons.

- [ ] **Step 4: Run the focused test and TypeScript check**

Run: `pnpm exec vitest run components/features/chat/ChatContextPicker.test.tsx && pnpm exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit the isolated picker**

Run: `git add wemedia-studio/components/features/chat/ChatContextPicker.tsx wemedia-studio/components/features/chat/ChatContextPicker.test.tsx && git commit -m "feat(chat): add context picker component"`

### Task 2: Wire the picker into the Chat composer

**Files:**
- Modify: `wemedia-studio/app/chat/ChatClient.tsx`
- Modify: `wemedia-studio/app/chat/chat-layout.test.ts`

**Interfaces:**
- Consumes: `ChatContextPicker` and existing `skills`, `drafts`, `skillName`, `draftId`, `sending` states.
- Produces: one unified control while preserving `streamChatReply({ skillName, draftId })`.

- [ ] **Step 1: Write the failing integration/source test**

```tsx
it('uses one context picker instead of permanent select controls', () => {
  const source = readFileSync(new URL('./ChatClient.tsx', import.meta.url), 'utf8')
  expect(source).toContain('<ChatContextPicker')
  expect(source).toContain("onSkillNameChange={skill => setSkillName(skill ?? '')}")
  expect(source).toContain("onDraftIdChange={draft => setDraftId(draft ? String(draft) : '')}")
  expect(source).not.toContain('<select value={skillName}')
  expect(source).not.toContain('<select value={draftId}')
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `pnpm exec vitest run app/chat/chat-layout.test.ts`

Expected: FAIL because the composer still contains native selects.

- [ ] **Step 3: Replace only the selection markup**

```tsx
<ChatContextPicker
  skills={skills}
  drafts={drafts}
  skillName={skillName || undefined}
  draftId={draftId ? Number(draftId) : undefined}
  disabled={sending}
  onSkillNameChange={skill => setSkillName(skill ?? '')}
  onDraftIdChange={draft => setDraftId(draft ? String(draft) : '')}
/>
```

Import the component. Move it inside the bordered composer surface, below the text-area/send row, and remove the native select container. Retain the data-loading effect, `startNewConversation` resets, and request serialization.

- [ ] **Step 4: Run frontend validation**

Run: `pnpm exec vitest run app/chat/chat-layout.test.ts components/features/chat/ChatContextPicker.test.tsx && pnpm test && pnpm exec tsc --noEmit && pnpm build`

Expected: all tests pass; production build lists `/chat` and `/api/chat/skills`.

- [ ] **Step 5: Perform rendered interaction validation**

Browser plugin is not available. Run `pnpm exec playwright --version`; if available, use a temporary screenshot outside the repository and exercise `/chat → 添加上下文 → 技能 → select one → 添加上下文 → 草稿 → 搜索草稿 → select one → remove each chip`. If unavailable, record the limitation; do not install dependencies.

- [ ] **Step 6: Commit the integration**

Run: `git add wemedia-studio/app/chat/ChatClient.tsx wemedia-studio/app/chat/chat-layout.test.ts && git commit -m "feat(chat): use unified context picker"`

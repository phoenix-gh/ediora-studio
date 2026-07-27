# Ediora · 述策 Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace user-facing WeMedia Studio branding with Ediora · 述策, then create and integrate a selected project-local logo.

**Architecture:** Keep all operational `wemedia` identifiers untouched. Centralize the user-visible product name in a small frontend branding module so the root layout and sidebar cannot drift; update the project README as the external documentation surface. Logo exploration is a separate approval gate and only the selected vector asset is wired into the sidebar.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Tailwind CSS, SVG.

## Global Constraints

- Primary user-facing product name: `Ediora · 述策`.
- Chinese descriptor: `AI 内容工作台`.
- English descriptor: `AI Content Operations` for English-only copy.
- Browser title: `Ediora · 述策 — AI 内容工作台`.
- Do not rename `wemedia-studio`, database names, API paths, environment variables, local URLs, or internal code symbols.
- Do not stage or alter the existing untracked `.superpowers/brainstorm/` directory.
- Do not create or integrate a logo until the user selects a presented direction.

---

### Task 1: Centralize the visible brand and verify it

**Files:**

- Create: `wemedia-studio/lib/branding.ts`
- Create: `wemedia-studio/lib/branding.test.ts`
- Modify: `wemedia-studio/app/layout.tsx:15-19`
- Modify: `wemedia-studio/components/features/Sidebar.tsx:9-10,65-71`

**Interfaces:**

- Produces: `PRODUCT_NAME`, `PRODUCT_DESCRIPTOR_ZH`, and `BROWSER_TITLE` constants exported by `lib/branding.ts`.
- Consumes: `BROWSER_TITLE` in Next.js metadata and `PRODUCT_NAME` in the sidebar header.

- [ ] **Step 1: Write the failing test**

```ts
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { BROWSER_TITLE, PRODUCT_DESCRIPTOR_ZH, PRODUCT_NAME } from './branding'
import { Sidebar } from '@/components/features/Sidebar'

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}))

describe('product branding', () => {
  it('shows the approved product name in the sidebar', () => {
    render(<Sidebar />)

    expect(screen.getByText('Ediora · 述策')).toBeInTheDocument()
  })

  it('defines the approved Chinese browser title', () => {
    expect(PRODUCT_NAME).toBe('Ediora · 述策')
    expect(PRODUCT_DESCRIPTOR_ZH).toBe('AI 内容工作台')
    expect(BROWSER_TITLE).toBe('Ediora · 述策 — AI 内容工作台')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test lib/branding.test.ts`

Expected: FAIL because `./branding` does not exist.

- [ ] **Step 3: Write the minimal implementation**

```ts
// wemedia-studio/lib/branding.ts
export const PRODUCT_NAME = 'Ediora · 述策'
export const PRODUCT_DESCRIPTOR_ZH = 'AI 内容工作台'
export const PRODUCT_DESCRIPTOR_EN = 'AI Content Operations'
export const BROWSER_TITLE = `${PRODUCT_NAME} — ${PRODUCT_DESCRIPTOR_ZH}`
```

Import `BROWSER_TITLE` into `app/layout.tsx` and assign it to `metadata.title`. Import `PRODUCT_NAME` into `components/features/Sidebar.tsx` and render it in the brand span.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test lib/branding.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add wemedia-studio/lib/branding.ts wemedia-studio/lib/branding.test.ts wemedia-studio/app/layout.tsx wemedia-studio/components/features/Sidebar.tsx
git commit -m "feat: rename visible product brand"
```

### Task 2: Update the external project name and validate the display scope

**Files:**

- Modify: `README.md:1-3,16`

**Interfaces:**

- Consumes: The canonical strings exported from `lib/branding.ts`.
- Produces: Documentation that identifies the product as `Ediora · 述策` while preserving code-path and package-directory instructions.

- [ ] **Step 1: Update README copy**

Change the README heading and product description to:

```md
# Ediora · 述策

AI 内容工作台：集信息采集、价值甄选、AI 创作与发布辅助于一体。
```

Keep the repository tree label `WeMediaStudio/` and `wemedia-studio/` command paths unchanged because they are technical identifiers.

- [ ] **Step 2: Run focused and full frontend verification**

Run: `pnpm test lib/branding.test.ts && pnpm test && pnpm build`

Expected: all Vitest tests pass and Next.js production build completes.

- [ ] **Step 3: Confirm the replacement boundary**

Run: `rg -n -i 'WeMedia Studio' README.md wemedia-studio/app wemedia-studio/components`

Expected: no output. Do not search or change technical folders, package metadata, backend user agents, database names, or local URLs as part of this requirement.

- [ ] **Step 4: Commit**

```bash
git add README.md wemedia-studio/lib/branding.test.ts
git commit -m "docs: present Ediora product name"
```

### Task 3: Present Logo directions and save the selected vector asset

**Files:**

- Create: `wemedia-studio/public/brand/ediora-mark.svg` after user selection
- Modify: `wemedia-studio/components/features/Sidebar.tsx:65-71` after user selection
- Test: `wemedia-studio/lib/branding.test.ts`

**Interfaces:**

- Consumes: The approved visual direction and the `PRODUCT_NAME` wordmark.
- Produces: A local SVG mark usable in the sidebar, with no bitmap dependency or generated text.

- [ ] **Step 1: Produce and present three logo directions**

Create three preview-only concepts with these distinct visual metaphors:

1. **Signal to story:** three source dots resolve into an editorial page/arrow.
2. **Editorial loop:** a compact open-loop monogram representing collect, shape, publish.
3. **Source prism:** a square prism with a single highlighted output beam.

Use a restrained indigo-to-violet palette compatible with the existing sidebar, no text inside the mark, and a square silhouette suitable for a favicon. Ask the user to select one before creating a project asset.

- [ ] **Step 2: Write the failing selected-asset test**

After selection, append an assertion that the sidebar contains the selected SVG path:

```ts
it('uses the local Ediora logo asset in the sidebar', () => {
  const sidebar = readFileSync(new URL('../../components/features/Sidebar.tsx', import.meta.url), 'utf8')
  expect(sidebar).toContain('/brand/ediora-mark.svg')
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm test lib/branding.test.ts`

Expected: FAIL because the sidebar does not yet reference the selected SVG.

- [ ] **Step 4: Create and integrate the selected SVG**

Save the selected vector mark at `public/brand/ediora-mark.svg`. Replace the temporary `TrendingUp` brand icon in `Sidebar.tsx` with a Next.js `Image` or native `img` element that loads `/brand/ediora-mark.svg`, uses an empty alt string because adjacent text supplies the name, and has `w-6 h-6` dimensions.

- [ ] **Step 5: Run focused and build verification**

Run: `pnpm test lib/branding.test.ts && pnpm build`

Expected: PASS and a successful production build.

- [ ] **Step 6: Commit**

```bash
git add wemedia-studio/public/brand/ediora-mark.svg wemedia-studio/components/features/Sidebar.tsx wemedia-studio/lib/branding.test.ts
git commit -m "feat: add Ediora brand mark"
```

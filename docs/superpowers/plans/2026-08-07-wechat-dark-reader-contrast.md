# WeChat Dark Reader Contrast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep WeChat article bodies readable in dark mode by rendering only the original rich-text body on a light paper canvas.

**Architecture:** Add an explicit `contentTheme` option to the shared article reader, defaulting to the current adaptive behavior. The WeChat page opts into `paper`; all other callers remain unchanged.

**Tech Stack:** React 19, TypeScript, Tailwind CSS 4, Vitest, Testing Library, Playwright.

## Global Constraints

- Keep the reader chrome and the rest of the page theme-aware.
- Preserve original WeChat inline formatting, colors, images, and tables.
- Do not rewrite stored HTML or change collection APIs.
- Do not change other content sources.

---

### Task 1: Add the paper content theme and enable it for WeChat

**Files:**
- Create: `wemedia-studio/components/features/ArticleReader.test.tsx`
- Modify: `wemedia-studio/components/features/ArticleReader.tsx`
- Modify: `wemedia-studio/app/wechat/WechatClient.tsx`

**Interfaces:**
- Produces: `contentTheme?: 'adaptive' | 'paper'` on article reader modal, panel, and responsive props.
- Consumes: WeChat passes `contentTheme="paper"`; all omitted values resolve to `adaptive`.

- [ ] **Step 1: Write failing component tests**

Render `ArticleReaderPanel` with inline dark text and assert that `contentTheme="paper"` adds a light canvas and omits `dark:prose-invert`. Render the default reader and assert it retains `dark:prose-invert`.

- [ ] **Step 2: Verify the tests fail for the missing interface/behavior**

Run: `pnpm test components/features/ArticleReader.test.tsx`

Expected: FAIL because the paper mode does not yet produce a light canvas.

- [ ] **Step 3: Implement the minimal reader option**

Thread `contentTheme` through `ResponsiveArticleReader`, `ArticleReaderPanel`, `ArticleReaderModal`, and `ReaderBody`. In paper mode, give the rich-text content wrapper a white background and zinc-900 foreground, and do not apply `dark:prose-invert`; keep the title and reader chrome adaptive.

- [ ] **Step 4: Enable paper mode only on the WeChat reader**

Pass `contentTheme="paper"` from `WechatClient` to `ResponsiveArticleReader`.

- [ ] **Step 5: Run focused and static verification**

Run:

```bash
pnpm test components/features/ArticleReader.test.tsx app/wechat/WechatClient.test.tsx
pnpm exec eslint components/features/ArticleReader.tsx components/features/ArticleReader.test.tsx app/wechat/WechatClient.tsx
git diff --check -- wemedia-studio/components/features/ArticleReader.tsx wemedia-studio/components/features/ArticleReader.test.tsx wemedia-studio/app/wechat/WechatClient.tsx
```

Expected: focused tests pass, ESLint exits zero, and `git diff --check` reports no errors.

- [ ] **Step 6: Verify the rendered dark-theme flow**

Use Playwright because the Browser plugin is unavailable. Open `http://127.0.0.1:3000/wechat`, switch to dark mode, open a WeChat article containing inline dark text, and verify:

- the page and reader chrome remain dark;
- the article rich-text canvas is light with readable body text;
- no framework overlay appears;
- no relevant console errors occur.

- [ ] **Step 7: Commit only the scoped implementation files**

```bash
git add -- wemedia-studio/components/features/ArticleReader.tsx wemedia-studio/components/features/ArticleReader.test.tsx wemedia-studio/app/wechat/WechatClient.tsx
git commit -m "fix: keep WeChat articles readable in dark mode"
```

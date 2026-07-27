# Chat Image Preview Dialog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open generated Chat images in an in-page dialog instead of navigating to the original asset URL.

**Architecture:** `ImageJobPreview` keeps the selected image URL as local React state. Each generated image thumbnail is a button that updates that state, and the existing shared Dialog primitives render the selected asset in an overlay without changing the route.

**Tech Stack:** Next.js client component, React state, existing Base UI Dialog wrappers, Vitest source-contract test.

## Global Constraints

- Reuse `@/components/ui/dialog`; do not add a dialog dependency.
- Keep image status polling and asset URL resolution unchanged.
- The preview must close through existing Dialog close controls and backdrop interaction.
- The thumbnail must not be an anchor or navigate to an asset URL.

---

### Task 1: Add the preview Dialog to the Chat generated-image result

**Files:**
- Modify: `wemedia-studio/app/chat/chat-layout.test.ts:59-61`
- Modify: `wemedia-studio/app/chat/ChatClient.tsx:69-105`

**Interfaces:**
- Consumes: `urls: string[]` resolved by `imageUrlsForJob(job)`.
- Produces: An `ImageJobPreview` that owns `selectedImage: string | null`, uses `Dialog`, and renders each preview as a `button`.

- [ ] **Step 1: Write the failing test**

```ts
expect(source).toContain("import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'")
expect(source).toContain("const [selectedImage, setSelectedImage] = useState<string | null>(null)")
expect(source).toContain('<button type="button" onClick={() => setSelectedImage(url)}')
expect(source).toContain('<Dialog open={selectedImage !== null} onOpenChange={open => !open && setSelectedImage(null)}>')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run app/chat/chat-layout.test.ts`

Expected: FAIL because the Chat source does not yet import or render the Dialog preview.

- [ ] **Step 3: Write minimal implementation**

```tsx
const [selectedImage, setSelectedImage] = useState<string | null>(null)

<button type="button" onClick={() => setSelectedImage(url)} className="block overflow-hidden rounded-lg ...">
  <img src={url} alt="AI 生成图片" className="aspect-video w-full object-cover" />
</button>
<Dialog open={selectedImage !== null} onOpenChange={open => !open && setSelectedImage(null)}>
  <DialogContent className="max-w-5xl p-3">
    <DialogHeader className="sr-only"><DialogTitle>AI 生成图片预览</DialogTitle><DialogDescription>点击遮罩或关闭按钮返回聊天。</DialogDescription></DialogHeader>
    {selectedImage && <img src={selectedImage} alt="AI 生成图片预览" className="max-h-[80vh] w-full object-contain" />}
  </DialogContent>
</Dialog>
```

- [ ] **Step 4: Run test and typecheck**

Run: `pnpm exec vitest run app/chat/chat-layout.test.ts && pnpm exec tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add wemedia-studio/app/chat/ChatClient.tsx wemedia-studio/app/chat/chat-layout.test.ts
git commit -m "feat(chat): preview generated images in dialog"
```

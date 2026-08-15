# 提示词资产左右布局与图片预览 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将提示词管理的生成历史改为提示词与媒体左右布局，并提供不裁切的图片展示和支持滚轮缩放、拖动的图片预览对话框。

**Architecture:** 保持现有 `PromptAssetWorkspace` 的数据流和生成历史 API 不变，在组件内把 `GenerationCard` 改成响应式左右布局，并新增一个仅负责图片预览交互的组件。预览状态只存在客户端，通过 React 状态、指针事件和对话框完成缩放/平移，不增加全局事件或持久化字段。

**Tech Stack:** React 19, Next.js 16, TypeScript, Tailwind CSS, `@base-ui/react/dialog`, Vitest, Testing Library.

## Global Constraints

- 不修改数据库、API 和 `PromptGeneration` 数据结构。
- 左侧提示词标记为“当前提示词”，使用当前提示词资产正文，不伪造历史快照。
- 图片和视频使用 `object-contain`，不使用固定裁切比例。
- 图片预览缩放范围为 1x 到 4x；缩放后支持指针拖动平移。
- 不改变生成、补录、删除、轮询和保存逻辑。
- 只运行提示词管理相关测试和必要的类型检查，不运行全量测试。

---

### Task 1: Add failing coverage for the prompt/media history layout and preview interaction

**Files:**
- Modify: `web/app/assets/PromptAssetWorkspace.test.tsx`

**Interfaces:**
- Consumes: existing `PromptAssetWorkspace` props and mocked `PromptGeneration` media result.
- Produces: assertions for visible current prompt, non-cropped media, preview dialog, wheel zoom, and reset behavior.

- [ ] **Step 1: Write the failing tests**

Add tests to the existing `PromptAssetWorkspace` suite:

```tsx
it('renders each generation with the current prompt beside an uncropped image', async () => {
  mocks.listPromptGenerations.mockResolvedValue([
    generation({ status: 'succeeded', media_asset_id: media.id, media }),
  ])
  renderPromptWorkspace()

  expect(await screen.findByText('当前提示词')).toBeVisible()
  expect(screen.getByText('一张未来城市海报')).toBeVisible()
  expect(await screen.findByRole('img', { name: '生成图片' })).toHaveClass('object-contain')
  expect(screen.getByRole('img', { name: '生成图片' })).not.toHaveClass('object-cover')
})

it('opens a complete image preview and changes zoom with the wheel', async () => {
  const user = userEvent.setup()
  mocks.listPromptGenerations.mockResolvedValue([
    generation({ status: 'succeeded', media_asset_id: media.id, media }),
  ])
  renderPromptWorkspace()

  await user.click(await screen.findByRole('button', { name: '预览图片 生成图片' }))
  const preview = await screen.findByRole('dialog')
  const viewport = within(preview).getByLabelText('图片预览区域')
  const previewImage = within(preview).getByRole('img', { name: '生成图片' })
  expect(previewImage).toHaveClass('object-contain')

  fireEvent.wheel(viewport, { deltaY: -100 })
  expect(previewImage).toHaveAttribute('data-scale', '1.2')

  await user.click(within(preview).getByRole('button', { name: '重置缩放' }))
  expect(previewImage).toHaveAttribute('data-scale', '1')
})
```

Add a `renderPromptWorkspace(selected = prompt())` helper that renders `PromptAssetWorkspace` with `assets={[selected]}`, `directories={[]}`, the selected asset, and `vi.fn()` callbacks for `onChange`, `onDelete`, `onSave`, and `onSelect`. Import `fireEvent` and `within` from Testing Library.

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
cd web && pnpm exec vitest run app/assets/PromptAssetWorkspace.test.tsx
```

Expected: FAIL because the current generation card has no “当前提示词” region, uses `object-cover`, and does not expose an image preview button/dialog.

### Task 2: Implement the responsive history layout and zoomable image preview

**Files:**
- Modify: `web/app/assets/PromptAssetWorkspace.tsx`

**Interfaces:**
- Consumes: `PromptGeneration`, `CreativeAsset`, `creativeAssetUrl`, existing `Dialog` primitives, and `selected.content`.
- Produces: `GenerationCard` with `promptContent` and `onPreview` props, plus a client-only image preview dialog with `data-scale` state for tests.

- [ ] **Step 1: Add preview state and wire it into the workspace**

Add `previewImage` state to `PromptAssetWorkspace`. Pass `selected.content` and an `onPreview` callback into each `GenerationCard`; render a controlled `Dialog` for the selected image and clear the state through `onOpenChange`.

- [ ] **Step 2: Convert `GenerationCard` into a responsive two-column card**

Render a `md:grid-cols-[minmax(0,1fr)_minmax(16rem,0.9fr)]` card. The left panel should contain a “当前提示词” label and a `whitespace-pre-wrap break-words` prompt body with bounded internal scrolling. The right panel should contain the media and existing model/time/delete metadata.

For images, use a keyboard-accessible button around the image and classes equivalent to:

```tsx
<button
  aria-label={`预览图片 ${generation.media.title}`}
  className="flex min-h-56 w-full items-center justify-center bg-muted/40 p-2"
  onClick={onPreview}
  type="button"
>
  <img
    alt={generation.media.title}
    className="max-h-[28rem] w-full object-contain"
    src={creativeAssetUrl(generation.media.url)}
  />
</button>
```

Use `object-contain` for videos as well, and keep queued/running/failed states in the right media panel.

- [ ] **Step 3: Implement `ZoomableImagePreview`**

Keep the preview component in `PromptAssetWorkspace.tsx` unless the file becomes difficult to test. It must:

1. Reset `scale` to `1` and offset to `{ x: 0, y: 0 }` when the image changes.
2. Clamp wheel zoom to `[1, 4]`, multiplying by `1.2` on negative `deltaY` and dividing by `1.2` on positive `deltaY`.
3. Render the image with `object-contain`, `data-scale={scale}`, and `transform: translate(${x}px, ${y}px) scale(${scale})`.
4. Allow pointer dragging only when `scale > 1`, using pointer capture on the preview viewport and no global listeners.
5. Expose “放大”, “缩小”, and “重置缩放” buttons; reset must also clear the translation.
6. Use `DialogContent` with a bounded viewport (`max-h-[min(78vh,720px)]`) and accessible `DialogTitle`/description.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run:

```bash
cd web && pnpm exec vitest run app/assets/PromptAssetWorkspace.test.tsx
```

Expected: all prompt workspace tests pass, including the new layout and wheel zoom assertions.

### Task 3: Run focused frontend verification

**Files:**
- Verify: `web/app/assets/PromptAssetWorkspace.tsx`
- Verify: `web/app/assets/PromptAssetWorkspace.test.tsx`

**Interfaces:**
- Consumes: the completed prompt asset workspace implementation.
- Produces: test output, type-check output, and whitespace validation for handoff.

- [ ] **Step 1: Run the focused test file again**

```bash
cd web && pnpm exec vitest run app/assets/PromptAssetWorkspace.test.tsx
```

- [ ] **Step 2: Run the project TypeScript check**

```bash
cd web && pnpm exec tsc --noEmit
```

Record any pre-existing unrelated errors separately; do not broaden the change to fix unrelated type failures.

- [ ] **Step 3: Check the diff for whitespace errors**

```bash
git diff --check
```

- [ ] **Step 4: Review the final diff**

```bash
git diff -- web/app/assets/PromptAssetWorkspace.tsx web/app/assets/PromptAssetWorkspace.test.tsx
```

Confirm that the diff does not modify API calls, generation polling, upload/attach behavior, or unrelated worktree files.

# 自动正文配图插入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自动正文配图成功后，将图片 Markdown 幂等地写入草稿正文。

**Architecture:** `illustrations` worker 要求模型给出二级标题锚点，上传图片后保存 URL 与锚点，重新读取草稿再 PATCH 正文。封面 flow 保持只保存资产；资产面板提供补插入操作。

**Tech Stack:** Next.js/TypeScript、AI SDK、FastAPI、PostgreSQL、Vitest、pytest。

## Global Constraints

- 仅处理 `illustrations`；封面永不写入正文。
- 匹配 `## ` 二级标题时紧跟标题插入，否则追加文末。
- 同 URL 已存在时不重复插入。
- 上传成功、正文写回失败时保留资产并允许重试。

---

### Task 1: Markdown 插入工具

**Files:**
- Modify: `wemedia-studio/lib/ai/content-job.ts`
- Test: `wemedia-studio/lib/ai/content-job.test.ts`

**Interfaces:** Produces `insertInlineImage(content, imageUrl, anchorHeading) => { content, placement }`。

- [ ] **Step 1: Write the failing test**

```ts
expect(insertInlineImage('## 安装\n\n正文', '/api/uploads/a.png', '安装')).toEqual({
  content: '## 安装\n\n![插图](/api/uploads/a.png)\n\n正文', placement: 'anchor',
})
expect(insertInlineImage('# 标题\n\n正文', '/api/uploads/a.png', '不存在').placement).toBe('append')
expect(insertInlineImage('![插图](/api/uploads/a.png)', '/api/uploads/a.png', '安装').placement).toBe('existing')
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/ai/content-job.test.ts`  
Expected: FAIL because `insertInlineImage` is not exported.

- [ ] **Step 3: Write minimal implementation**

Export `insertInlineImage`; first test `content.includes(\`](${imageUrl})\`)`, then locate exact `## ${anchorHeading.trim()}`. Insert `![插图](${imageUrl})` after that heading line or append it to `content.trimEnd()` when absent. Return placement `existing`, `anchor`, or `append`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/ai/content-job.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add wemedia-studio/lib/ai/content-job.ts wemedia-studio/lib/ai/content-job.test.ts && git commit -m "feat: add idempotent inline image insertion"`

### Task 2: 自动任务写回正文

**Files:**
- Modify: `wemedia-studio/lib/ai/content-job.ts`
- Test: `wemedia-studio/lib/ai/content-job.test.ts`

**Interfaces:** Consumes Task 1 and existing draft GET/PATCH; produces `placements: Array<{ asset_id; asset_url; anchor_heading; placement }>` in an `illustrations` step output.

- [ ] **Step 1: Write the failing test**

```ts
expect(illustrationImageInputSchema.safeParse({ prompt: 'x'.repeat(20) }).success).toBe(false)
expect(illustrationImageInputSchema.safeParse({ prompt: 'x'.repeat(20), anchor_heading: '安装 sing-box' }).success).toBe(true)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/ai/content-job.test.ts`  
Expected: FAIL because the illustration tool has no `anchor_heading` contract.

- [ ] **Step 3: Write minimal implementation**

Require `anchor_heading: z.string().min(1).max(160)` only for illustrations and tell the model to select an existing `##` heading. Store each uploaded asset with its anchor. After all generated images, refetch the draft, apply Task 1 sequentially, PATCH `{ content }` to `/write/drafts/{id}`, and emit an `inline_images_inserted` event. Do not change the cover tool schema or flow.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- lib/ai/content-job.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add wemedia-studio/lib/ai/content-job.ts wemedia-studio/lib/ai/content-job.test.ts && git commit -m "feat: insert generated illustrations into drafts"`

### Task 3: 补插入已有插图

**Files:**
- Modify: `backend/routers/drafts.py`
- Modify: `backend/tests/test_drafts_router.py`
- Modify: `wemedia-studio/lib/api/drafts.ts`
- Modify: `wemedia-studio/app/drafts/DraftAssetsDialog.tsx`
- Test: `wemedia-studio/app/drafts/DraftAssetsDialog.test.tsx`

**Interfaces:** Produces `POST /write/drafts/{draft_id}/images/insert` with `{ image_id, anchor_heading }` and `{ draft, placement }`.

- [ ] **Step 1: Write the failing backend test**

```py
response = client.post(f'/api/write/drafts/{draft.id}/images/insert', json={'image_id': image.id, 'anchor_heading': '安装'})
assert response.status_code == 200
assert response.json()['placement'] == 'anchor'
assert '![插图](/api/uploads/' in response.json()['draft']['content']
```

- [ ] **Step 2: Run backend test to verify it fails**

Run: `pytest backend/tests/test_drafts_router.py -k insert_existing_draft_image -q`  
Expected: FAIL with 404 because the endpoint does not exist.

- [ ] **Step 3: Implement endpoint and UI action**

Validate image ownership, match headings and deduplicate URL server-side, then update `ArticleDraft.content`. Add an API wrapper and a `补插入正文` action for non-cover asset images. The action offers document headings and refreshes editor content after success.

- [ ] **Step 4: Run focused verification**

Run: `pytest backend/tests/test_drafts_router.py -k insert_existing_draft_image -q && npm test -- app/drafts/DraftAssetsDialog.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add backend/routers/drafts.py backend/tests/test_drafts_router.py wemedia-studio/lib/api/drafts.ts wemedia-studio/app/drafts/DraftAssetsDialog.tsx wemedia-studio/app/drafts/DraftAssetsDialog.test.tsx && git commit -m "feat: support inserting existing draft illustrations"`

### Task 4: Full verification and deployment

**Files:** none.

- [ ] **Step 1: Run all frontend tests**

Run: `npm test`  
Expected: PASS.

- [ ] **Step 2: Run backend tests**

Run: `pytest backend/tests -q`  
Expected: PASS.

- [ ] **Step 3: Build and deploy**

Run: `npm run build && docker compose up --build -d web worker api`  
Expected: successful build and healthy services.

- [ ] **Step 4: Verify a generated illustration**

Run: `curl -fsS http://localhost:8000/api/write/drafts/<draft_id> | jq -r .content`  
Expected: illustration Markdown follows a `## ` heading and cover URL is absent.

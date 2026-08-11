# YouTube 中英对照逐字稿 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 YouTube 逐字稿弹窗增加按时间轴对齐的“中英”模式，原文在上、对应中文在下，并支持复制对照全文。

**Architecture:** 前端新增纯函数，将每条中文字幕按最大时间重叠或 1.5 秒最近距离唯一分配给原文分段，未匹配中文保留为独立组。弹窗继续消费现有 API，在原文、中文、中英三种展示模式间切换，不修改后端数据。

**Tech Stack:** React 19、TypeScript、Vitest、Testing Library、Tailwind CSS。

## Global Constraints

- 不修改数据库、API 或采集结果。
- 不引入新依赖，不调用 AI，不做语义翻译或文本相似度匹配。
- 中文字幕只能分配一次；一条原文可对应多条中文。
- 无法匹配的中文必须保留。
- 打开弹窗仍默认原文模式。

---

### Task 1: 时间轴对齐与复制文本

**Files:**
- Modify: `wemedia-studio/app/youtube/YoutubeTranscriptDialog.tsx`
- Test: `wemedia-studio/app/youtube/YoutubeTranscriptDialog.test.tsx`

**Interfaces:**
- Consumes: `YoutubeTranscriptSegment[]` 原文与中文字幕数组。
- Produces: `alignBilingualSegments(original, chinese, toleranceSeconds?): BilingualTranscriptGroup[]`。
- Produces: `formatBilingualTranscript(groups): string`。
- `BilingualTranscriptGroup` 包含 `original: YoutubeTranscriptSegment | null` 与 `chinese: YoutubeTranscriptSegment[]`。

- [ ] **Step 1: Write failing pure-function tests**

新增字面量测试数据，断言：中文选择最大重叠原文、一条原文接收多条中文、同一中文不重复、无重叠但距离不超过 1.5 秒时匹配、距离更远或时间非法时成为独立组，并断言复制文本为“原文行 + 中文行 + 组间空行”。

- [ ] **Step 2: Run tests and verify RED**

Run: `cd wemedia-studio && pnpm test -- app/youtube/YoutubeTranscriptDialog.test.tsx`

Expected: FAIL because `alignBilingualSegments` and `formatBilingualTranscript` are not exported.

- [ ] **Step 3: Implement pure functions**

实现有限时间范围校验、区间重叠、区间距离、稳定的最大值选择和按时间顺序合并独立中文组。默认容差固定为 `1.5` 秒；相同重叠或距离选择更早的原文索引。

- [ ] **Step 4: Run tests and verify GREEN**

Run: `cd wemedia-studio && pnpm test -- app/youtube/YoutubeTranscriptDialog.test.tsx`

Expected: pure-function tests pass.

### Task 2: 三模式展示与复制

**Files:**
- Modify: `wemedia-studio/app/youtube/YoutubeTranscriptDialog.tsx`
- Test: `wemedia-studio/app/youtube/YoutubeTranscriptDialog.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `alignBilingualSegments()` 和 `formatBilingualTranscript()`。
- Produces: `selectedVersion: 'original' | 'chinese' | 'bilingual'` 三态交互。

- [ ] **Step 1: Write failing component tests**

扩展双语 fixture，断言存在“中英”按钮；点击后按原文、中文顺序渲染；一对多中文均出现；独立中文显示“仅中文”；复制按钮写入 Task 1 生成的双语文本；无中文时不显示“中英”。

- [ ] **Step 2: Run tests and verify RED**

Run: `cd wemedia-studio && pnpm test -- app/youtube/YoutubeTranscriptDialog.test.tsx`

Expected: FAIL because the bilingual control and view do not exist.

- [ ] **Step 3: Implement the bilingual view**

增加第三个切换按钮。双语模式使用现有时间戳链接函数；配对组显示原文正文和次要样式中文行，独立组显示“仅中文”。描述区域显示“原文语言 / 中文”；复制与禁用状态改为使用当前模式生成的文本。

- [ ] **Step 4: Run focused tests and lint**

Run: `cd wemedia-studio && pnpm test -- app/youtube/YoutubeTranscriptDialog.test.tsx app/youtube/YoutubeClient.test.tsx`

Run: `cd wemedia-studio && pnpm exec eslint app/youtube/YoutubeTranscriptDialog.tsx app/youtube/YoutubeTranscriptDialog.test.tsx`

Expected: all tests pass and ESLint exits 0.

- [ ] **Step 5: Check patch hygiene**

Run: `git diff --check -- wemedia-studio/app/youtube/YoutubeTranscriptDialog.tsx wemedia-studio/app/youtube/YoutubeTranscriptDialog.test.tsx docs/superpowers/plans/2026-08-11-youtube-bilingual-transcript.md`


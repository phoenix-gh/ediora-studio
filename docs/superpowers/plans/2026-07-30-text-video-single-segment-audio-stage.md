# 文字视频单段配音界面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 单段文字视频只展示当前段音频，并将必要的成片时间轴状态与恢复操作内联到该卡片。

**Architecture:** 保留现有 `master_audio` 状态机和动作回调，将 `AudioStage` 的可见结构按一个或多个非空段落分支渲染。单段复用现有段落播放器，多段继续渲染独立的合成音频卡片；单段只内联展示时间轴状态与错误恢复。

**Tech Stack:** Next.js 16.2.4、React 19、TypeScript、Vitest、Testing Library、shadcn/ui。

## Global Constraints

- 不改变后端、数据库、API 或 `master_audio` 持久化结构。
- 不改变单段确认后自动触发现有主音频构建任务的行为。
- 单段模式不得重复渲染音频播放器。
- 单段可见文案使用“成片时间轴”，不使用“主音频”或“全局时间轴”。
- 多段模式保留音频汇总与播放能力，卡片名称为“合成音频与成片时间轴”。
- 当前主分支存在同文件的未提交文字视频改动；只修改本计划列出的相关片段，不回退或覆盖其他改动。

---

### Task 1: 单段时间轴状态内联

**Files:**
- Modify: `web/app/text-video/AudioStage.test.tsx`
- Modify: `web/app/text-video/AudioStage.tsx`

**Interfaces:**
- Consumes: `TextVideoProject.master_audio`、`onBuildMasterAudio()`、`onRealignMasterAudio(jobId)`
- Produces: 单段“当前段配音”卡片中的 `data-testid="single-segment-timeline-status"` 状态区；多段独立“合成音频与成片时间轴”卡片

- [x] **Step 1: 写下会被测试捕获的生产缺陷**

删除 `AudioStage` 的单段分支时，测试必须因再次出现独立主音频卡片或缺少内联时间轴状态而失败；删除多段分支时，测试必须因合成音频操作消失而失败。

- [x] **Step 2: 先写失败测试**

在 `AudioStage.test.tsx` 中调整单段断言：

```tsx
expect(screen.queryByText('主音频与全局时间轴')).not.toBeInTheDocument()
expect(screen.queryByTestId('master-audio')).not.toBeInTheDocument()
expect(screen.queryByRole('button', { name: '播放全部' })).not.toBeInTheDocument()
expect(screen.getByTestId('single-segment-timeline-status'))
  .toHaveTextContent('成片时间轴已就绪')
```

把单段对齐失败用例改为断言播放器仍只有 `segment-audio`，错误和`重新对齐`位于内联状态区。把单段构建失败用例的操作名称改为`重新准备时间轴`。新增多段断言，确认“合成音频与成片时间轴”、`master-audio` 和“播放全部”仍存在。

- [x] **Step 3: 运行目标测试并确认按预期失败**

Run:

```bash
cd web
npm test -- app/text-video/AudioStage.test.tsx
```

Expected: FAIL；当前单段仍渲染“主音频与全局时间轴”、`master-audio` 或缺少 `single-segment-timeline-status`。

- [x] **Step 4: 实现最小界面分支**

在 `AudioStage.tsx` 中：

```tsx
{singleSegment && selected.status === 'confirmed' ? (
  <div data-testid="single-segment-timeline-status">
    {/* 根据现有 master_audio 状态显示成片时间轴状态、错误与恢复操作 */}
  </div>
) : null}

{!singleSegment ? (
  <div>
    <p>合成音频与成片时间轴</p>
    {/* 保留现有主音频播放器与动作 */}
  </div>
) : null}
```

把状态文案映射为：

```ts
building -> '正在生成成片时间轴'
ready + timeline aligning -> '正在生成成片时间轴'
ready + timeline ready -> '成片时间轴已就绪'
ready + timeline failed -> '成片时间轴生成失败'
failed -> '成片时间轴准备失败'
```

单段 `master_audio.status === 'failed'` 调用 `onBuildMasterAudio`，按钮为`重新准备时间轴`；单段 `timeline_status === 'failed'` 且存在 `job_id` 时调用 `onRealignMasterAudio(job_id)`，按钮为`重新对齐`。

- [x] **Step 5: 运行目标测试并确认通过**

Run:

```bash
cd web
npm test -- app/text-video/AudioStage.test.tsx
```

Expected: PASS，所有 `AudioStage` 用例通过。

- [x] **Step 6: 检查目标差异**

Run:

```bash
git diff --check
git diff -- web/app/text-video/AudioStage.tsx web/app/text-video/AudioStage.test.tsx
```

Expected: `git diff --check` exit 0；差异仅包含单段内联状态、多段卡片命名及测试。

### Task 2: 工作台回归验证

**Files:**
- Verify: `web/app/text-video/TextVideoWorkbench.test.tsx`
- Verify: `web/app/text-video/TextVideoEditorClient.test.tsx`
- Verify: `web/app/text-video/TextVideoWorkbench.tsx`
- Verify: `web/app/text-video/TextVideoEditorClient.tsx`

**Interfaces:**
- Consumes: `AudioStage`、`canEnterVideoStage(project)`、单段确认后的自动构建动作
- Produces: 不变的单段自动复用、阶段提示和视频合成入口行为

- [x] **Step 1: 运行文字视频前端回归测试**

Run:

```bash
cd web
npm test -- app/text-video/AudioStage.test.tsx app/text-video/TextVideoWorkbench.test.tsx app/text-video/TextVideoEditorClient.test.tsx
```

Expected: PASS；单段确认后仍自动准备时间轴，多段仍需显式生成合成音频，时间轴就绪后仍可进入视频合成。

- [x] **Step 2: 运行目标 lint**

Run:

```bash
cd web
npx eslint app/text-video/AudioStage.tsx app/text-video/AudioStage.test.tsx app/text-video/TextVideoWorkbench.tsx app/text-video/TextVideoWorkbench.test.tsx
```

Expected: exit 0，无 ESLint error。

- [x] **Step 3: 运行前端完整测试**

Run:

```bash
cd web
npm test
```

Expected: PASS，0 个失败用例。

- [x] **Step 4: 最终核对设计约束**

逐项核对设计规格中的 7 条验收标准，并用目标测试输出、完整测试输出和 `git diff --check` 作为交付证据。当前工作树包含重叠的未提交改动，因此本计划不单独创建提交，避免把不相关工作混入提交。
